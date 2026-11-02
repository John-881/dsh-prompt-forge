/**
 * 宿主集成测试：不启动 GUI，直接用假 ctx / 假 webServer / 假 llm 驱动 apply()，
 * 从 HTTP 处理器一路走到结果信封。
 *
 * 为什么用这种方式而不是 headless 冒烟：本机启动器在含空格路径上会 spawn 失败
 * （`'E:\dev\DeepSeek' 不是内部或外部命令`，且 E: 未启用 8.3 短名），
 * 拿不到可信的"条目是否激活"日志。模块级驱动 proof 更直接：apply 抛错、路由没注册、
 * 信封解析错，这里都会红。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 配置覆盖层落在环境变量指向的文件上：测试绝不能碰真实的
// ~/.dsh/storages/prompt-forge/config.json。必须在 import 之前设好，
// 所以这里用动态 import。
const STORE_DIR = mkdtempSync(join(tmpdir(), 'forge-store-'))
const STORE_FILE = join(STORE_DIR, 'config.json')
process.env.DSH_PROMPT_FORGE_STORE = STORE_FILE
process.env.DSH_PROMPT_FORGE_LOG_DIR = join(STORE_DIR, 'logs')

const { apply } = await import('../lib/index.js')

/** 每个用例前把覆盖文件清掉，避免用例之间互相污染。 */
function resetStore() {
  try {
    writeFileSync(STORE_FILE, '')
  } catch {
    // 目录还在就行。
  }
}

/** 造一个最小 ctx：get/inject/effect 三个面。 */
function makeCtx({ llm, webServer, commands }) {
  // 真实宿主里 agentDefaultModel 由 @deepseek-ai/dsh-agent-default-model 提供，
  // 是路由优先级的最后一层。假 ctx 必须给出同样的面，否则每次请求都会 unconfigured。
  const agentDefaultModel = { currentSelection: () => ({ provider: 'fake-provider', model: 'fake-model' }) }
  const services = { llm, webServer, commands, agentDefaultModel }
  /** @type {Array<() => void>} */
  const disposers = []
  const ctx = {
    get: (name) => services[name],
    inject: (deps, callback) => {
      if (deps.every((dep) => services[dep] !== undefined)) return callback(ctx)
      return undefined
    },
    effect: (fn) => {
      const dispose = fn()
      if (typeof dispose === 'function') disposers.push(dispose)
      return dispose
    },
    disposeAll: () => {
      for (const dispose of disposers) dispose()
    },
  }
  return ctx
}

/** 假 webserver：只保留 register，抓取前缀处理器。 */
function makeWebServer() {
  const routes = []
  return {
    routes,
    register(route) {
      routes.push(route)
      return () => {
        const index = routes.indexOf(route)
        if (index !== -1) routes.splice(index, 1)
      }
    },
  }
}

/** 假 commands 服务。 */
function makeCommands() {
  const definitions = []
  return {
    definitions,
    register(definition) {
      definitions.push(definition)
      return () => {
        const index = definitions.indexOf(definition)
        if (index !== -1) definitions.splice(index, 1)
      }
    },
  }
}

/** 假 llm：依次吐出给定 chunk。 */
function makeLlm(chunks) {
  return {
    calls: [],
    stream(options) {
      this.calls.push(options)
      return (async function* () {
        for (const chunk of chunks) yield chunk
      })()
    },
  }
}

/** 造一个最小 IncomingMessage：headers + socket + 异步可迭代体。 */
function makeReq({ method = 'POST', url = '/prompt-forge/enhance', headers = {}, body } = {}) {
  const payload = body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body)
  const chunks = payload === '' ? [] : [Buffer.from(payload)]
  return {
    method,
    url,
    headers: { host: 'localhost:18080', 'content-type': 'application/json', ...headers },
    socket: { remoteAddress: '127.0.0.1' },
    [Symbol.asyncIterator]: async function* () {
      for (const chunk of chunks) yield chunk
    },
  }
}

/** 造一个最小 ServerResponse：记录 status / headers / body。 */
function makeRes() {
  const record = { status: 0, headers: {}, body: '' }
  const res = {
    record,
    writableEnded: false,
    destroyed: false,
    writeHead(status, headers) {
      record.status = status
      record.headers = headers ?? {}
    },
    setHeader() {},
    write(chunk) {
      record.body += chunk
    },
    end(chunk) {
      if (typeof chunk === 'string') record.body += chunk
      res.writableEnded = true
    },
    on() {},
    removeListener() {},
  }
  return res
}

/** 取唯一的前缀处理器。 */
function handlerOf(webServer) {
  assert.equal(webServer.routes.length, 1, '应当恰好注册一个前缀路由')
  assert.equal(webServer.routes[0].kind, 'prefix')
  assert.equal(webServer.routes[0].path, '/prompt-forge')
  return webServer.routes[0].handler
}

/** 发一次请求并返回解析后的响应。 */
async function call(handler, options) {
  const res = makeRes()
  await handler(makeReq(options), res)
  assert.ok(res.writableEnded, '响应必须被结束')
  const text = res.record.body
  const parsed = text.startsWith('data: ') ? null : JSON.parse(text)
  return { status: res.record.status, body: parsed, raw: text }
}

const okChunks = [
  { type: 'block-start', index: 0, blockType: 'text' },
  { type: 'text-delta', index: 0, text: '[[MODE=expand PROFILE=code]]\n\n你是一位后端工程师。\n\n任务：…' },
  { type: 'finish', reason: { kind: 'stop' } },
]

test('apply：注册前缀路由与 /enhance 命令，并暴露自检句柄', () => {
  const ctx = makeCtx({ llm: makeLlm(okChunks), webServer: makeWebServer(), commands: makeCommands() })
  apply(ctx, {})
  assert.ok(globalThis.__dshPromptForge !== undefined)
  assert.equal(globalThis.__dshPromptForge.describe().effective.enabled, true)
  ctx.disposeAll()
  assert.equal(globalThis.__dshPromptForge, undefined, '卸载后自检句柄应被移除')
})

test('apply：配置非法时不抛，回退默认值继续装载', () => {
  const ctx = makeCtx({ llm: makeLlm(okChunks), webServer: makeWebServer(), commands: makeCommands() })
  assert.doesNotThrow(() => apply(ctx, { candidates: 2 }))
  assert.equal(globalThis.__dshPromptForge.describe().effective.candidates, 1)
  ctx.disposeAll()
})

test('apply：缺 webServer 时路由缺席但不阻塞装载（命令仍在）', () => {
  const commands = makeCommands()
  const ctx = makeCtx({ llm: makeLlm(okChunks), commands })
  apply(ctx, {})
  assert.equal(commands.definitions.length, 1, '/enhance 仍应注册')
  ctx.disposeAll()
})

test('POST /prompt-forge/enhance：正常路径返回正文与元信息', async () => {
  const webServer = makeWebServer()
  const llm = makeLlm(okChunks)
  const ctx = makeCtx({ llm, webServer, commands: makeCommands() })
  apply(ctx, {})

  const { status, body } = await call(handlerOf(webServer), { body: { text: '写个登录接口' } })
  assert.equal(status, 200)
  assert.equal(body.ok, true)
  assert.equal(body.data.profile, 'code')
  assert.equal(body.data.mode, 'expand')
  assert.ok(body.data.text.startsWith('你是一位后端工程师'))
  assert.equal(body.data.candidates.length, 1)
  assert.equal(llm.calls.length, 1)
  ctx.disposeAll()
})

test('路由：请求体带出的 mode 覆盖配置，但只影响方向', async () => {
  const webServer = makeWebServer()
  const ctx = makeCtx({ llm: makeLlm(okChunks), webServer, commands: makeCommands() })
  apply(ctx, { mode: 'auto' })
  await call(handlerOf(webServer), { body: { text: '把这段话收一下', mode: 'tighten' } })
  const system = ctx.get('llm').calls[0].system
  assert.ok(system.includes('0.6x–1.0x'), '应当走收紧策略')
  ctx.disposeAll()
})

test('路由：candidates=3 时并发三次调用并返回三个候选', async () => {
  const webServer = makeWebServer()
  const llm = makeLlm(okChunks)
  const ctx = makeCtx({ llm, webServer, commands: makeCommands() })
  apply(ctx, { candidates: 3 })
  const { body } = await call(handlerOf(webServer), { body: { text: '写个登录接口' } })
  assert.equal(body.data.candidates.length, 3)
  assert.equal(llm.calls.length, 3)
  const systems = llm.calls.map((c) => c.system)
  assert.equal(systems.filter((s) => s.includes('Restructure the body')).length, 1, '其中一路应是重排变体')
  ctx.disposeAll()
})

test('GET /prompt-forge/state：返回客户端需要的开关/候选数/上限/快捷键', async () => {
  const webServer = makeWebServer()
  const ctx = makeCtx({ llm: makeLlm(okChunks), webServer, commands: makeCommands() })
  apply(ctx, { candidates: 3, maxInputChars: 5000 })
  const { status, body } = await call(handlerOf(webServer), { method: 'GET', url: '/prompt-forge/state' })
  assert.equal(status, 200)
  assert.equal(body.data.enabled, true)
  assert.equal(body.data.candidates, 3)
  assert.equal(body.data.maxInputChars, 5000)
  assert.equal(body.data.shortcut, 'ctrl+alt+e')
  assert.equal(body.data.version, 1)
  ctx.disposeAll()
})

test('GET /prompt-forge/state：不消耗准入闸（读状态不是增强）', async () => {
  const webServer = makeWebServer()
  const ctx = makeCtx({ llm: makeLlm(okChunks), webServer, commands: makeCommands() })
  apply(ctx, { rateLimitPerMinute: 1 })
  const handler = handlerOf(webServer)
  for (let index = 0; index < 5; index++) {
    assert.equal((await call(handler, { method: 'GET', url: '/prompt-forge/state' })).status, 200)
  }
  // 读状态没占配额，第一次增强仍然放行。
  assert.equal((await call(handler, { body: { text: '写个接口' } })).status, 200)
  ctx.disposeAll()
})

test('POST 到 state 路径被拒 405', async () => {
  const webServer = makeWebServer()
  const ctx = makeCtx({ llm: makeLlm(okChunks), webServer, commands: makeCommands() })
  apply(ctx, {})
  const { status } = await call(handlerOf(webServer), { url: '/prompt-forge/state', body: { text: 'x' } })
  assert.equal(status, 405)
  ctx.disposeAll()
})

test('路由：非回环 Origin 被 403 拒绝', async () => {
  const webServer = makeWebServer()
  const ctx = makeCtx({ llm: makeLlm(okChunks), webServer, commands: makeCommands() })
  apply(ctx, {})
  const { status } = await call(handlerOf(webServer), {
    body: { text: 'x' },
    headers: { origin: 'http://evil.example.com' },
  })
  assert.equal(status, 403)
  ctx.disposeAll()
})

test('路由：同主机不同端口的 Origin 也被 403（防本地其他服务盗用额度）', async () => {
  const webServer = makeWebServer()
  const ctx = makeCtx({ llm: makeLlm(okChunks), webServer, commands: makeCommands() })
  apply(ctx, {})
  const { status } = await call(handlerOf(webServer), {
    body: { text: 'x' },
    headers: { origin: 'http://localhost:4000' },
  })
  assert.equal(status, 403)
  ctx.disposeAll()
})

test('路由：同端口回环 Origin 放行', async () => {
  const webServer = makeWebServer()
  const ctx = makeCtx({ llm: makeLlm(okChunks), webServer, commands: makeCommands() })
  apply(ctx, {})
  const { status } = await call(handlerOf(webServer), {
    body: { text: '写个接口' },
    headers: { origin: 'http://localhost:18080' },
  })
  assert.equal(status, 200)
  ctx.disposeAll()
})

test('路由：带 X-Forwarded-For 的请求被拒（代理不在信任模型内）', async () => {
  const webServer = makeWebServer()
  const ctx = makeCtx({ llm: makeLlm(okChunks), webServer, commands: makeCommands() })
  apply(ctx, {})
  const { status } = await call(handlerOf(webServer), { body: { text: 'x' }, headers: { 'x-forwarded-for': '1.2.3.4' } })
  assert.equal(status, 403)
  ctx.disposeAll()
})

test('路由：空草稿 422，超长 422 且不改动任何东西', async () => {
  const webServer = makeWebServer()
  const ctx = makeCtx({ llm: makeLlm(okChunks), webServer, commands: makeCommands() })
  apply(ctx, { maxInputChars: 200 })

  const empty = await call(handlerOf(webServer), { body: { text: '   ' } })
  assert.equal(empty.status, 422)
  assert.equal(empty.body.error.code, 'rejected')

  const long = await call(handlerOf(webServer), { body: { text: 'a'.repeat(201) } })
  assert.equal(long.status, 422)
  assert.equal(long.body.error.params.max, 200)
  ctx.disposeAll()
})

test('路由：总开关关闭时 403，且一次模型调用都不发', async () => {
  const webServer = makeWebServer()
  const llm = makeLlm(okChunks)
  const ctx = makeCtx({ llm, webServer, commands: makeCommands() })
  apply(ctx, { enabled: false })
  const { status } = await call(handlerOf(webServer), { body: { text: '写点东西' } })
  assert.equal(status, 403)
  assert.equal(llm.calls.length, 0)
  ctx.disposeAll()
})

test('路由：GET 405、错误路径 404、非 JSON 类型 415', async () => {
  const webServer = makeWebServer()
  const ctx = makeCtx({ llm: makeLlm(okChunks), webServer, commands: makeCommands() })
  apply(ctx, {})
  const handler = handlerOf(webServer)
  assert.equal((await call(handler, { method: 'GET', body: { text: 'x' } })).status, 405)
  assert.equal((await call(handler, { url: '/prompt-forge/nope', body: { text: 'x' } })).status, 404)
  assert.equal(
    (await call(handler, { body: { text: 'x' }, headers: { 'content-type': 'text/plain' } })).status,
    415,
  )
  ctx.disposeAll()
})

test('路由：限流阈值 1 时第二次请求 429', async () => {
  const webServer = makeWebServer()
  const ctx = makeCtx({ llm: makeLlm(okChunks), webServer, commands: makeCommands() })
  apply(ctx, { rateLimitPerMinute: 1 })
  const handler = handlerOf(webServer)
  assert.equal((await call(handler, { body: { text: '第一次' } })).status, 200)
  const second = await call(handler, { body: { text: '第二次' } })
  assert.equal(second.status, 429)
  assert.equal(second.body.error.code, 'rate-limit')
  ctx.disposeAll()
})

test('路由：SSE 端点先推 delta 再推 result', async () => {
  const webServer = makeWebServer()
  const ctx = makeCtx({ llm: makeLlm(okChunks), webServer, commands: makeCommands() })
  apply(ctx, {})
  const { raw } = await call(handlerOf(webServer), { url: '/prompt-forge/enhance/stream', body: { text: '写个接口' } })
  const frames = raw
    .split('\n\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => JSON.parse(line.slice(6)))
  assert.ok(frames.some((frame) => frame.type === 'delta'), '应当有增量帧')
  const result = frames.find((frame) => frame.type === 'result')
  assert.ok(result !== undefined, '应当有结果帧')
  assert.equal(result.data.profile, 'code')
  ctx.disposeAll()
})

test('命令：/enhance 走同一条编排并返回正文', async () => {
  const commands = makeCommands()
  const ctx = makeCtx({ llm: makeLlm(okChunks), webServer: makeWebServer(), commands })
  apply(ctx, {})
  const definition = commands.definitions[0]
  assert.equal(definition.name, 'enhance')
  const outcome = await definition.handler({ rawInput: '写个登录接口', agent: { session: { id: 's1' } } })
  assert.equal(outcome.kind, 'success')
  assert.ok(outcome.text.startsWith('你是一位后端工程师'))
  ctx.disposeAll()
})

test('命令：空输入给用法提示，不发起调用', async () => {
  const commands = makeCommands()
  const llm = makeLlm(okChunks)
  const ctx = makeCtx({ llm, webServer: makeWebServer(), commands })
  apply(ctx, {})
  const outcome = await commands.definitions[0].handler({ rawInput: '   ', agent: { session: { id: 's1' } } })
  assert.equal(outcome.kind, 'error')
  assert.ok(outcome.text.includes('/enhance'))
  assert.equal(llm.calls.length, 0)
  ctx.disposeAll()
})

test('命令：上游失败时返回可读文案而不是抛异常', async () => {
  const commands = makeCommands()
  const ctx = makeCtx({
    llm: makeLlm([{ type: 'finish', reason: { kind: 'error', failure: { code: 'AUTH', message: 'bad key' } } }]),
    webServer: makeWebServer(),
    commands,
  })
  apply(ctx, {})
  const outcome = await commands.definitions[0].handler({ rawInput: '写点东西', agent: { session: { id: 's1' } } })
  assert.equal(outcome.kind, 'error')
  assert.ok(outcome.text.includes('鉴权失败'))
  ctx.disposeAll()
})

test('路由：同一 ctx 上重复 apply 不会注册重复前缀（重载防双份限流）', () => {
  const webServer = makeWebServer()
  const llm = makeLlm(okChunks)
  const ctx = makeCtx({ llm, webServer, commands: makeCommands() })
  apply(ctx, {})
  apply(ctx, {})
  assert.equal(webServer.routes.length, 1)
  ctx.disposeAll()
})

/* ─────────────────── 运行期配置（M3） ─────────────────── */

test('GET /prompt-forge/config：返回有效配置、覆盖层与 store 路径', async () => {
  resetStore()
  const webServer = makeWebServer()
  const ctx = makeCtx({ llm: makeLlm(okChunks), webServer, commands: makeCommands() })
  apply(ctx, { maxInputChars: 5000 })
  const { status, body } = await call(handlerOf(webServer), { method: 'GET', url: '/prompt-forge/config' })
  assert.equal(status, 200)
  assert.equal(body.data.effective.maxInputChars, 5000, '部署期配置应作为基线')
  assert.deepEqual(body.data.overrides, {})
  assert.equal(body.data.storeFile, STORE_FILE)
  assert.ok(Array.isArray(body.data.writable) && body.data.writable.includes('candidates'))
  ctx.disposeAll()
})

test('POST /prompt-forge/config：写入后立即生效，无需重启', async () => {
  resetStore()
  const webServer = makeWebServer()
  const ctx = makeCtx({ llm: makeLlm(okChunks), webServer, commands: makeCommands() })
  apply(ctx, { maxInputChars: 12000 })
  const handler = handlerOf(webServer)

  // 基线：400 字可以通过。
  assert.equal((await call(handler, { body: { text: 'a'.repeat(400) } })).status, 200)

  // 运行期把上限压到 300。
  const written = await call(handler, { url: '/prompt-forge/config', body: { maxInputChars: 300 } })
  assert.equal(written.status, 200)
  assert.equal(written.body.data.effective.maxInputChars, 300)

  // 同一个 ctx、同一个 handler，下一请求立刻按新上限拒绝。
  const rejected = await call(handler, { body: { text: 'a'.repeat(400) } })
  assert.equal(rejected.status, 422)
  assert.equal(rejected.body.error.params.max, 300)
  ctx.disposeAll()
})

test('POST /prompt-forge/config：非法值 422 且不落盘', async () => {
  resetStore()
  const webServer = makeWebServer()
  const ctx = makeCtx({ llm: makeLlm(okChunks), webServer, commands: makeCommands() })
  apply(ctx, {})
  const { status, body } = await call(handlerOf(webServer), {
    url: '/prompt-forge/config',
    body: { candidates: 2 },
  })
  assert.equal(status, 422)
  assert.ok(body.error.message.includes('candidates'))
  const onDisk = readFileSync(STORE_FILE, 'utf8')
  assert.equal(onDisk.includes('candidates'), false, '非法补丁绝不能写进 store')
  ctx.disposeAll()
})

test('POST /prompt-forge/config：null 清除某条覆盖，回落部署期值', async () => {
  resetStore()
  const webServer = makeWebServer()
  const ctx = makeCtx({ llm: makeLlm(okChunks), webServer, commands: makeCommands() })
  apply(ctx, { maxInputChars: 8000 })
  const handler = handlerOf(webServer)
  await call(handler, { url: '/prompt-forge/config', body: { maxInputChars: 300 } })
  const cleared = await call(handler, { url: '/prompt-forge/config', body: { maxInputChars: null } })
  assert.equal(cleared.status, 200)
  assert.equal(cleared.body.data.effective.maxInputChars, 8000)
  ctx.disposeAll()
})

test('store 文件损坏时退回部署期配置，请求不失败', async () => {
  writeFileSync(STORE_FILE, '{ this is not json')
  const webServer = makeWebServer()
  const ctx = makeCtx({ llm: makeLlm(okChunks), webServer, commands: makeCommands() })
  apply(ctx, { maxInputChars: 4000 })
  const { status, body } = await call(handlerOf(webServer), { body: { text: '写个接口' } })
  assert.equal(status, 200, '坏文件不能让增强挂掉')
  assert.equal(body.data.text.startsWith('你是一位后端工程师'), true)
  ctx.disposeAll()
  resetStore()
})

test('存了非法覆盖值时忽略覆盖层而不是每个请求都 500', async () => {
  writeFileSync(STORE_FILE, JSON.stringify({ temperature: 99 }))
  const webServer = makeWebServer()
  const ctx = makeCtx({ llm: makeLlm(okChunks), webServer, commands: makeCommands() })
  apply(ctx, {})
  const { status } = await call(handlerOf(webServer), { body: { text: '写个接口' } })
  assert.equal(status, 200)
  ctx.disposeAll()
  resetStore()
})

test('含引用占位符的草稿：系统提示词带上不可改写规则', async () => {
  resetStore()
  const webServer = makeWebServer()
  const llm = makeLlm(okChunks)
  const ctx = makeCtx({ llm, webServer, commands: makeCommands() })
  apply(ctx, {})
  await call(handlerOf(webServer), { body: { text: '把⟦REF1⟧改成表格' } })
  assert.ok(llm.calls[0].system.includes('EXTERNAL REFERENCE PLACEHOLDERS'))
  ctx.disposeAll()
})

test('不含占位符的草稿：系统提示词不出现占位符规则（保持字节稳定）', async () => {
  resetStore()
  const webServer = makeWebServer()
  const llm = makeLlm(okChunks)
  const ctx = makeCtx({ llm, webServer, commands: makeCommands() })
  apply(ctx, {})
  await call(handlerOf(webServer), { body: { text: '写个登录接口' } })
  assert.ok(!llm.calls[0].system.includes('EXTERNAL REFERENCE PLACEHOLDERS'))
  ctx.disposeAll()
})
