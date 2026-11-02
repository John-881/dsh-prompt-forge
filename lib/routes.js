/**
 * 宿主路由：`POST /prompt-forge/enhance`（一次性 JSON）与
 * `POST /prompt-forge/enhance/stream`（SSE 增量）。
 *
 * 守门顺序是有讲究的，每一道都为了省下后面的成本：回环栅栏 → 路径/方法/类型
 * → 配置可读 → 总开关 → 体积预检 → 读取并解析 → 并发闸 → 限流 → 熔断 → 真调用。
 * 任何一道失败都**不触碰草稿**（宿主侧本就没有草稿，这条约束由客户端保证）。
 * @module dsh-prompt-forge/routes
 */

import { checkInputText } from './validate.js'
import { formatEnhanceError, toEnhanceError } from './llm.js'
import { runForge, sessionRouteOf } from './orchestrate.js'
import { planCalls } from './config.js'
import { PROTOCOL } from './protocol.js'

/** 连续失败多少次触发熔断，以及熔断时长。 */
const FAILURE_STREAK_LIMIT = 3
const FAILURE_COOLDOWN_MS = 30_000

/** 回环允许的主机名。 */
const TRUSTED_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1'])

/** 是否来自回环套接字。 */
function isLoopbackRequest(req) {
  const address = req.socket.remoteAddress ?? ''
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

/** 从 Host 头里剥掉端口与 IPv6 方括号，取主机名。 */
function hostnameOf(hostHeader) {
  const trimmed = hostHeader.trim().toLowerCase()
  if (trimmed.startsWith('[')) {
    const end = trimmed.indexOf(']')
    return end === -1 ? trimmed : trimmed.slice(1, end)
  }
  const colon = trimmed.lastIndexOf(':')
  return colon === -1 ? trimmed : trimmed.slice(0, colon)
}

/** Host 头标明的端口；没有端口返回 null（= 走协议默认端口）。 */
function portOf(hostHeader) {
  const trimmed = hostHeader.trim().toLowerCase()
  if (trimmed.startsWith('[')) {
    const end = trimmed.indexOf(']')
    if (end === -1) return null
    const rest = trimmed.slice(end + 1)
    return rest.startsWith(':') ? rest.slice(1) || null : null
  }
  const colon = trimmed.lastIndexOf(':')
  return colon === -1 ? null : trimmed.slice(colon + 1) || null
}

/** `URL.hostname` 对 IPv6 字面量保留方括号，允许表里没有。 */
function bareHostname(url) {
  const host = url.hostname.toLowerCase()
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host
}

/** Origin 隐含的端口，缺省时按协议补默认值。 */
function effectivePort(url) {
  if (url.port !== '') return url.port
  return url.protocol === 'https:' ? '443' : '80'
}

/**
 * Origin 是否可信：协议 http(s)、主机名在回环允许表、端口等于本次请求被投递到的端口。
 * 端口这一条不能省——否则 `localhost:4000` 上的任意本地页面都能花掉用户的模型额度。
 */
function isTrustedOrigin(origin, expectedPort) {
  try {
    const url = new URL(origin)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
    if (!TRUSTED_HOSTNAMES.has(bareHostname(url))) return false
    return expectedPort === null || effectivePort(url) === expectedPort
  } catch {
    return false
  }
}

/**
 * 完整信任判定：套接字回环 + Host 头指向回环（防 DNS rebinding）+ 无代理转发头
 * + Origin 同端口。缺 Host 头（HTTP/1.0 风格）仍放行——套接字检查已经把它限制在本地进程。
 * @param {import('node:http').IncomingMessage} req - 请求。
 * @returns {boolean} 是否可信。
 */
export function isTrustedRequest(req) {
  if (req.headers['x-forwarded-for'] !== undefined || req.headers.forwarded !== undefined) return false
  if (!isLoopbackRequest(req)) return false
  const host = req.headers.host
  if (typeof host !== 'string' || host.trim() === '') return true
  if (!TRUSTED_HOSTNAMES.has(hostnameOf(host))) return false
  const origin = req.headers.origin
  if (typeof origin === 'string' && origin.trim() !== '' && !isTrustedOrigin(origin, portOf(host))) return false
  return true
}

/**
 * 有界读取并解析 JSON 请求体。超限抛 `body too large` 而不销毁套接字——
 * 路由仍欠客户端一个 413，未读部分由 Node 在响应结束后丢弃。
 * @param {import('node:http').IncomingMessage} req - 请求。
 * @param {number} maxBytes - 字节上限。
 * @returns {Promise<unknown>} 解析结果。
 */
async function readBoundedJson(req, maxBytes) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > maxBytes) throw new Error('body too large')
    chunks.push(chunk)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

/** 写一个不缓存的 JSON 响应。 */
function writeJson(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'referrer-policy': 'no-referrer',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(body))
}

/** 幂等、不抛错地结束响应（半关闭套接字上 end() 会抛）。 */
function endResponse(res) {
  if (res.writableEnded || res.destroyed) return
  try {
    res.end()
  } catch {
    // 客户端已消失。
  }
}

/** 每次挂载一份准入状态：滑动窗口时间戳、活动调用数、失败连击、熔断截止。 */
function createGate() {
  return { stamps: [], active: 0, failures: 0, cooldownUntil: 0 }
}

/**
 * 准入判定。窗口只计**成功**调用：一串超时不该烧掉用户的配额。
 * 但确定性失败（错 key、错 provider）会在毫秒内连败，只靠并发上限拦不住，
 * 所以连续三次失败触发 30 秒熔断。
 * @param {ReturnType<typeof createGate>} gate - 准入状态。
 * @param {import('./config.js').DEFAULT_CONFIG} config - 归一化配置。
 * @returns {{ code: string, params?: Record<string, unknown> } | undefined} 拒绝原因或 undefined。
 */
function admit(gate, config) {
  const now = Date.now()
  if (gate.cooldownUntil > now) {
    return { code: 'cooldown', params: { failures: gate.failures, retryAfterSeconds: Math.ceil((gate.cooldownUntil - now) / 1000) } }
  }
  if (gate.active >= config.maxConcurrent) {
    return { code: 'concurrency-limit', params: { max: config.maxConcurrent } }
  }
  const windowStart = now - 60_000
  gate.stamps = gate.stamps.filter((stamp) => stamp > windowStart)
  if (gate.stamps.length >= config.rateLimitPerMinute) {
    const oldest = gate.stamps[0] ?? now
    return { code: 'rate-limit', params: { limit: config.rateLimitPerMinute, retryAfterSeconds: Math.max(1, Math.ceil((oldest + 60_000 - now) / 1000)) } }
  }
  return undefined
}

/** 记一次成功：清失败连击、写入窗口时间戳。 */
function noteSuccess(gate) {
  gate.failures = 0
  gate.cooldownUntil = 0
  gate.stamps.push(Date.now())
}

/** 记一次失败：连击到阈值即熔断。 */
function noteFailure(gate) {
  gate.failures += 1
  if (gate.failures >= FAILURE_STREAK_LIMIT) {
    gate.cooldownUntil = Date.now() + FAILURE_COOLDOWN_MS
  }
}

/**
 * 组装一次请求的结果信封。
 * @param {{ candidates: any[], primary: any }} outcome - 编排结果。
 * @returns {Record<string, unknown>} 响应体。
 */
function envelopeOf(outcome) {
  return {
    ok: true,
    data: {
      text: outcome.primary.text,
      mode: outcome.primary.mode,
      profile: outcome.primary.profile,
      provider: outcome.primary.provider,
      model: outcome.primary.model,
      elapsedMs: outcome.primary.elapsedMs,
      candidates: outcome.candidates.map((candidate) => ({
        text: candidate.text,
        mode: candidate.mode,
        profile: candidate.profile,
        elapsedMs: candidate.elapsedMs,
      })),
    },
  }
}

/**
 * 服务一次增强请求。
 * @param {any} ctx - 注册上下文。
 * @param {() => import('./config.js').DEFAULT_CONFIG} readConfig - 逐请求配置读取。
 * @param {ReturnType<typeof createGate>} gate - 准入状态。
 * @param {string} pathname - 已解析路径。
 * @param {import('node:http').IncomingMessage} req - 请求。
 * @param {import('node:http').ServerResponse} res - 响应。
 * @param {boolean} stream - 是否用 SSE 增量作答。
 * @param {any} [_unused] - 保留位置（与旧签名对齐）。
 */
async function serve(ctx, readConfig, configApi, gate, pathname, req, res, stream, _unused) {
  if (!isTrustedRequest(req)) {
    writeJson(res, 403, { ok: false, error: { code: 'internal', message: 'forbidden: loopback-only' } })
    return
  }
  // 运行期配置：读/写 store 覆盖层。写之前必须先用 mergeOverrides 验证，
  // 否则一个非法值会被落盘、之后每次请求都读到一个必然抛错的配置。
  if (pathname === PROTOCOL.configEndpoint) {
    if (req.method === 'GET') {
      writeJson(res, 200, { ok: true, data: configApi.read() })
      return
    }
    if (req.method !== 'POST') {
      writeJson(res, 405, { ok: false, error: { code: 'internal', message: 'only GET/POST are allowed here' } })
      return
    }
    let body
    try {
      body = await readBoundedJson(req, 64 * 1024)
    } catch (error) {
      const tooLarge = error instanceof Error && error.message === 'body too large'
      writeJson(res, tooLarge ? 413 : 422, { ok: false, error: { code: 'rejected', message: tooLarge ? '请求体过大。' : '请求体不是有效的 JSON。' } })
      return
    }
    // 接受 `{ patch: {...} }` 或直接一个扁平对象；null 值表示清除该覆盖。
    const patch = body !== null && typeof body === 'object' && body.patch !== null && typeof body.patch === 'object' ? body.patch : body
    if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
      writeJson(res, 422, { ok: false, error: { code: 'rejected', message: '配置补丁必须是对象。' } })
      return
    }
    try {
      configApi.write(patch)
    } catch (error) {
      writeJson(res, 422, { ok: false, error: { code: 'rejected', message: `配置未保存：${error instanceof Error ? error.message : String(error)}` } })
      return
    }
    writeJson(res, 200, { ok: true, data: configApi.read() })
    return
  }
  // 只读状态端点：客户端据此决定按钮显示、候选数、快捷键与输入上限。
  // 它必须在 POST/内容类型检查之前处理，且不消耗准入闸——读状态不是增强。
  if (pathname === PROTOCOL.stateEndpoint) {
    if (req.method !== 'GET') {
      writeJson(res, 405, { ok: false, error: { code: 'internal', message: 'only GET is allowed here' } })
      return
    }
    let config
    try {
      config = readConfig()
    } catch (error) {
      writeJson(res, 500, { ok: false, error: { code: 'internal', message: `prompt-forge 配置无效：${error instanceof Error ? error.message : String(error)}` } })
      return
    }
    writeJson(res, 200, {
      ok: true,
      data: {
        enabled: config.enabled,
        candidates: config.candidates,
        maxInputChars: config.maxInputChars,
        shortcut: config.shortcut,
        mode: config.mode,
        version: PROTOCOL.version,
      },
    })
    return
  }
  if (pathname !== PROTOCOL.endpoint && pathname !== PROTOCOL.streamEndpoint) {
    writeJson(res, 404, { ok: false, error: { code: 'internal', message: 'not found' } })
    return
  }
  if (req.method !== 'POST') {
    writeJson(res, 405, { ok: false, error: { code: 'internal', message: 'only POST is allowed' } })
    return
  }
  const contentType = req.headers['content-type']
  if (contentType !== undefined && !String(contentType).toLowerCase().startsWith('application/json')) {
    writeJson(res, 415, { ok: false, error: { code: 'rejected', message: '仅支持 application/json 请求体。' } })
    return
  }

  let config
  try {
    config = readConfig()
  } catch (error) {
    writeJson(res, 500, { ok: false, error: { code: 'internal', message: `prompt-forge 配置无效：${error instanceof Error ? error.message : String(error)}` } })
    return
  }
  if (!config.enabled) {
    writeJson(res, 403, { ok: false, error: { code: 'rejected', message: '提示词增强已在设置中关闭。' } })
    return
  }

  const cap = config.maxInputChars * 6 + 4096
  const declaredLength = Number(req.headers['content-length'])
  if (Number.isFinite(declaredLength) && declaredLength > cap) {
    res.setHeader('connection', 'close')
    writeJson(res, 413, { ok: false, error: { code: 'rejected', message: '请求体超过大小上限。' } })
    return
  }

  let body
  try {
    body = await readBoundedJson(req, cap)
  } catch (error) {
    const tooLarge = error instanceof Error && error.message === 'body too large'
    writeJson(res, tooLarge ? 413 : 422, {
      ok: false,
      error: { code: 'rejected', message: tooLarge ? '请求体超过大小上限。' : '请求体不是有效的 JSON。' },
    })
    return
  }

  const text = typeof body?.text === 'string' ? body.text : ''
  const sessionId = typeof body?.sessionId === 'string' && body.sessionId !== '' ? body.sessionId : undefined
  const check = checkInputText(text, config.maxInputChars)
  if (!check.ok) {
    const params = check.code === 'too-long' ? { count: check.count, max: check.max } : {}
    writeJson(res, 422, { ok: false, error: { code: 'rejected', message: check.code === 'empty' ? '输入为空。' : '内容超过上限，未截断。', params } })
    return
  }
  // 客户端可请求预览模式（mode/candidates 覆盖），但只能收紧、不能放宽配额。
  const requestMode = body?.mode === 'expand' || body?.mode === 'tighten' ? body.mode : config.mode
  const effective = { ...config, mode: requestMode }
  // 客户端在占位符校验失败后会带 refStrict 重试一次：宿主据此强化占位符规则。
  const refStrict = body?.refStrict === true
  const plan = planCalls(effective, text)

  const refusal = admit(gate, config)
  if (refusal !== undefined) {
    const message = formatEnhanceError({ code: refusal.code, params: refusal.params })
    writeJson(res, 429, { ok: false, error: { code: refusal.code, params: refusal.params, message } })
    return
  }

  gate.active += 1
  const controller = new AbortController()
  const onClose = () => {
    if (!res.writableEnded) controller.abort()
  }
  res.on('close', onClose)

  let sse
  if (stream) {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })
    sse = (payload) => {
      if (res.writableEnded || res.destroyed) return
      try {
        res.write(`data: ${JSON.stringify(payload)}\n\n`)
      } catch {
        // 客户端断开。
      }
    }
  }

  try {
    const outcome = await runForge(ctx, effective, {
      text,
      sessionRoute: sessionRouteOf(ctx, sessionId),
      signal: controller.signal,
      sessionId,
      plan,
      strictReference: refStrict,
      ...(sse !== undefined
        ? {
            onDelta: (delta, index) => {
              sse({ type: 'delta', index, text: delta })
            },
          }
        : {}),
    })
    noteSuccess(gate)
    const payload = envelopeOf(outcome)
    if (sse !== undefined) {
      sse({ type: 'result', data: payload.data })
      endResponse(res)
    } else {
      writeJson(res, 200, payload)
    }
  } catch (error) {
    const wire = toEnhanceError(error)
    // 调用方取消不算上游失败，不该推高熔断计数。
    if (wire.code !== 'internal' || wire.message !== undefined) noteFailure(gate)
    const message = formatEnhanceError(wire)
    if (sse !== undefined) {
      sse({ type: 'error', error: { ...wire, message } })
      endResponse(res)
    } else {
      writeJson(res, 502, { ok: false, error: { ...wire, message } })
    }
  } finally {
    gate.active = Math.max(0, gate.active - 1)
    res.removeListener('close', onClose)
  }
}

/** 每次挂载的记录：用于服务被重建后自愈。 */
const mounts = new WeakMap()

/**
 * 在共享 webserver 上注册本插件的前缀路由。
 *
 * 两条生命周期规则，都是踩出来的：
 *  1. webserver 是**依赖**不是快照：`ctx.inject` 把子 fiber 绑到服务上，服务被重建后
 *     这段会重跑；否则插件会一直服务一个已经死掉的服务（旧版本症状：按钮还在、
 *     每次点击都 404）。
 *  2. 注册必须与 fiber 同寿：`register` 只返回一个"从表里删除"的函数，服务不会在卸载时
 *     回收它。交给模块级 map 的话，卸载后还会用旧配置继续应答，重载则抛
 *     `duplicate prefix route`。
 * @param {any} ctx - 注册上下文。
 * @param {() => import('./config.js').DEFAULT_CONFIG} readConfig - 逐请求配置读取。
 */
export function registerRoute(ctx, readConfig, configApi) {
  ctx.inject(['webServer'], (routeCtx) => {
    const webserver = routeCtx.get('webServer')
    if (webserver === undefined || webserver === null) return
    const existing = mounts.get(ctx)
    if (existing !== undefined && existing.webserver === webserver) return
    if (existing !== undefined) {
      try {
        existing.dispose()
      } catch {
        // 已随旧服务一起拆掉。
      }
      mounts.delete(ctx)
    }
    const gate = createGate()
    routeCtx.effect(() => {
      const dispose = webserver.register({
        kind: 'prefix',
        path: PROTOCOL.prefix,
        handler: (req, res) => {
          const pathname = new URL(req.url ?? '/', 'http://x').pathname
          return serve(ctx, readConfig, configApi, gate, pathname, req, res, pathname === PROTOCOL.streamEndpoint)
        },
      })
      const disposed = typeof dispose === 'function' ? dispose : () => {}
      mounts.set(ctx, { webserver, dispose: disposed })
      return () => {
        if (mounts.get(ctx)?.dispose === disposed) mounts.delete(ctx)
        try {
          disposed()
        } catch {
          // 已随旧服务一起拆掉。
        }
      }
    }, 'prompt-forge: enhance route')
  })
}
