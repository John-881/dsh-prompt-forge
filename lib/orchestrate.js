/**
 * 两个宿主入口（HTTP 路由与 /enhance 命令）共用的编排：模型路由解析、上下文装配、
 * 一次或多次增强调用。共用同一条路径才能防止两个入口的行为漂移。
 * @module dsh-prompt-forge/orchestrate
 */

import { randomUUID } from 'node:crypto'
import { buildSystemPrompt, REFERENCE_TOKEN_GLOBAL } from './prompts.js'
import { buildConversationContext } from './context.js'
import { enhanceText, toEnhanceError, EnhanceFailure } from './llm.js'
import { countText } from './validate.js'
import { logEvent } from './telemetry.js'

/**
 * 读取一个 cordis 服务的条目，任何形状不符都降级为"没有答案"。
 *
 * 结构性类型可以承诺 `get`，只有运行时检查才让它诚实：dsh 0.1.5-rc.3 起 settings
 * 服务换成 SettingsForms（没有同步 `get`），旧形状调用会在每个增强请求上都抛。
 * @param {any} ctx - 注册上下文。
 * @param {string} service - 服务名。
 * @param {string} key - 条目键。
 * @returns {unknown} 条目或 undefined。
 */
function serviceEntry(ctx, service, key) {
  let holder
  try {
    holder = ctx.get(service)
  } catch {
    return undefined
  }
  if (holder === null || holder === undefined) return undefined
  if (typeof holder.get !== 'function') return undefined
  try {
    return holder.get.call(holder, key)
  } catch {
    return undefined
  }
}

/** 把不受信任的 provider/model 对收敛成路由（trim 后）。 */
function routeOf(config) {
  if (config === null || config === undefined) return undefined
  const provider = typeof config.provider === 'string' ? config.provider.trim() : ''
  const model = typeof config.model === 'string' ? config.model.trim() : ''
  if (provider === '' || model === '') return undefined
  return { provider, model }
}

/**
 * 解析调用路由，优先级：显式设置对 → 会话请求头 → 宿主默认模型。
 * @param {{ provider: string, model: string }} explicit - 插件配置里的显式对（可能为空）。
 * @param {{ provider: string, model: string } | undefined} sessionRoute - 会话日志路由。
 * @param {{ provider: string, model: string } | undefined} fallback - 宿主默认模型。
 * @returns {{ provider: string, model: string } | undefined} 路由或 undefined。
 */
export function resolveRoute(explicit, sessionRoute, fallback) {
  const provider = typeof explicit?.provider === 'string' ? explicit.provider.trim() : ''
  const model = typeof explicit?.model === 'string' ? explicit.model.trim() : ''
  if (provider !== '' && model !== '') return { provider, model }
  return sessionRoute ?? fallback
}

/**
 * 会话的请求路由（最后一次请求头里的 provider/model）。
 * `requestHeader` 在所见的所有 dsh 版本里都是**方法**；读成属性会拿到函数对象，
 * 其 `.config` 为 undefined，整层优先级会静默失效。
 * @param {any} ctx - 注册上下文。
 * @param {string | undefined} sessionId - 会话 id。
 * @returns {{ provider: string, model: string } | undefined} 路由或 undefined。
 */
export function sessionRouteOf(ctx, sessionId) {
  if (sessionId === undefined || sessionId === '') return undefined
  const session = serviceEntry(ctx, 'sessions', sessionId)
  if (session === undefined || session === null) return undefined
  let epoch
  try {
    const header = session.requestHeader
    epoch = typeof header === 'function' ? header.call(session) : header
  } catch {
    return undefined
  }
  return routeOf(epoch?.config)
}

/**
 * 宿主默认模型。三种取法对应三代宿主，任何一种失败都只意味着"试下一种"，
 * 绝不能变成"这次增强失败"。
 * @param {any} ctx - 注册上下文。
 * @returns {{ provider: string, model: string } | undefined} 路由或 undefined。
 */
export function defaultRouteOf(ctx) {
  const selectionOf = (candidate) => {
    if (candidate === null || candidate === undefined) return undefined
    if (typeof candidate.currentSelection !== 'function') return undefined
    try {
      return routeOf(candidate.currentSelection())
    } catch {
      return undefined
    }
  }

  // 1) dsh >= 0.1.5-rc.3：按名字取服务。先 ctx.get 再读属性，因为未声明 inject
  //    就读属性时 cordis 会抛；而声明 inject 又会让缺该服务的宿主永不激活本插件。
  let byGet
  try {
    byGet = ctx.get('agentDefaultModel')
  } catch {
    byGet = undefined
  }
  const fromService = selectionOf(byGet)
  if (fromService !== undefined) return fromService

  // 2) 同服务，但宿主已经替我们注入成属性。
  try {
    const byProp = selectionOf(ctx.agentDefaultModel)
    if (byProp !== undefined) return byProp
  } catch {
    // 该宿主没有这个服务，落到第三种。
  }

  // 3) 旧宿主（<= 0.1.2-rc.1）：settings 命名空间的同步读。
  return routeOf(serviceEntry(ctx, 'settings', 'agent-default-model'))
}

/**
 * 本次增强的上下文片段，或什么都不给。
 *
 * 每一种失败模式都退化为"纯草稿增强"：开关关闭、无会话 id、会话未知、历史缺失或
 * 抛错、窗口小到容不下一轮。接地是优化，不是需求。
 * @param {any} ctx - 注册上下文。
 * @param {string | undefined} sessionId - 草稿所属会话。
 * @param {import('./config.js').DEFAULT_CONFIG} config - 归一化配置。
 * @param {string} draft - 正在增强的草稿。
 * @returns {string | undefined} 框定片段或 undefined。
 */
export function conversationContextOf(ctx, sessionId, config, draft) {
  if (!config.contextAware) return undefined
  if (sessionId === undefined || sessionId === '') return undefined
  const session = serviceEntry(ctx, 'sessions', sessionId)
  if (session === undefined || session === null) return undefined
  let messages
  try {
    messages = session.deriveMessages?.()
  } catch {
    return undefined
  }
  if (messages === undefined || !Array.isArray(messages)) return undefined
  return buildConversationContext(
    messages,
    { maxMessages: config.contextMaxMessages, maxChars: config.contextMaxChars },
    draft,
  )
}

/**
 * 跑一次增强请求（1 或 3 个候选）。
 *
 * 三候选并发跑，任一路失败不影响其余：全部失败才抛错。这比"失败就整体失败"更符合
 * 候选的语义——用户要的是"给我几个选择"，不是"三个都要成功"。
 * @param {any} ctx - 注册上下文。
 * @param {import('./config.js').DEFAULT_CONFIG} config - 归一化配置。
 * @param {object} options - 请求选项。
 * @param {string} options.text - 已校验的草稿。
 * @param {{ provider: string, model: string } | undefined} [options.sessionRoute] - 会话路由。
 * @param {AbortSignal} [options.signal] - 调用方取消。
 * @param {string} [options.sessionId] - 会话标识。
 * @param {Array<{ mode: 'expand' | 'tighten', variant: 'base' | 'reorder' }>} options.plan - 调用计划。
 * @param {(delta: string, index: number) => void} [options.onDelta] - 增量回调。
 * @returns {Promise<{ candidates: Array<any>, primary: any }>} 结果。
 */
export async function runForge(ctx, config, options) {
  const requestId = randomUUID().slice(0, 8)
  const started = Date.now()
  try {
    const route = resolveRoute(config, options.sessionRoute, defaultRouteOf(ctx))
    if (route === undefined) throw new EnhanceFailure({ code: 'unconfigured' })

    const llm = ctx.get('llm')
    if (llm === undefined) throw new EnhanceFailure({ code: 'internal' })

    const context = conversationContextOf(ctx, options.sessionId, config, options.text)
    const hasContext = context !== undefined
    // 引用占位符规则按本次文本决定：含 ⟦REFn⟧ 才追加，不含的调用保持原指令字节不变。
    const referenceTokens = options.text.match(REFERENCE_TOKEN_GLOBAL) ?? []
    const hasReference = referenceTokens.length > 0
    const strictReference = options.strictReference === true

    const outcomes = await Promise.allSettled(
      options.plan.map((plan, index) =>
        enhanceText(llm, {
          route,
          system: buildSystemPrompt({
            mode: plan.mode,
            variant: plan.variant,
            hasContext,
            hasReference,
            referenceCount: referenceTokens.length,
            strictReference,
            strategyMode: config.strategyMode,
            strategyText: config.strategyText,
          }),
          text: options.text,
          mode: plan.mode,
          temperature: config.temperature,
          maxTokens: config.maxOutputTokens,
          timeoutMs: config.timeoutMs,
          signal: options.signal,
          ...(context !== undefined ? { context } : {}),
          ...(options.sessionId !== undefined ? { sessionId: options.sessionId } : {}),
          ...(options.onDelta !== undefined
            ? {
                onDelta: (delta) => {
                  try {
                    options.onDelta(delta, index)
                  } catch {
                    /* 展示路径断裂不影响调用 */
                  }
                },
              }
            : {}),
        }),
      ),
    )

    const candidates = []
    let firstError
    for (const outcome of outcomes) {
      if (outcome.status === 'fulfilled') candidates.push(outcome.value)
      else if (firstError === undefined) firstError = outcome.reason
    }
    if (candidates.length === 0) throw firstError ?? new EnhanceFailure({ code: 'internal' })

    const elapsedMs = Date.now() - started
    logEvent(config, {
      event: 'enhance',
      id: requestId,
      in: countText(options.text),
      out: candidates.map((candidate) => countText(candidate.text)),
      modes: candidates.map((candidate) => candidate.mode),
      profiles: candidates.map((candidate) => candidate.profile),
      ctx: hasContext ? 1 : 0,
      ms: elapsedMs,
      ok: candidates.length,
      fail: outcomes.length - candidates.length,
    })
    return { candidates, primary: candidates[0] }
  } catch (error) {
    const wire = toEnhanceError(error)
    logEvent(config, {
      event: 'enhance-error',
      id: requestId,
      in: countText(options.text),
      code: wire.code,
      ms: Date.now() - started,
    })
    throw error
  }
}
