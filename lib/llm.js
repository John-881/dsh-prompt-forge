/**
 * 一次辅助 LLM 调用：路由已定，负责超时竞速、流式装配、输出归一化与错误分类。
 *
 * 本模块**不 import @deepseek-ai/dsh-llm**。原因见 config.js 顶部注释（link: 安装
 * 解析不到宿主包）。因此这里手写了等价的两件事：
 *  - `createUserMessage(input)` 的实质是 `deepFreeze(structuredClone({ ...input,
 *    id: randomUUID() }))`，字段就 role / content / source / id 四个；
 *  - `BlockAssembler` 对流 chunk 的语义：block-start / text-delta / reasoning-delta /
 *    tool-call-delta / block-end / usage / finish —— 我们只需要 text 累积、tool-call
 *    识别与 finish.reason。
 * 这两处形状取自宿主 `@deepseek-ai/dsh-llm/lib/index.js` 实读，不是猜的。
 * @module dsh-prompt-forge/llm
 */

import { randomUUID } from 'node:crypto'
import { normalizeOutput, parseEnvelope } from './validate.js'
import { frameUserPrompt } from './prompts.js'

/** 携带线协议错误的内部异常。 */
export class EnhanceFailure extends Error {
  /**
   * @param {{ code: string, params?: Record<string, unknown>, message?: string }} detail - 线协议错误。
   */
  constructor(detail) {
    super(detail.message ?? detail.code)
    this.name = 'EnhanceFailure'
    this.detail = detail
  }
}

/**
 * 装配一条流：按 index 累积 text 增量，记录 finish 原因与是否出现工具调用。
 * @param {AsyncIterator<{ type: string, [key: string]: any }>} iterator - chunk 迭代器。
 * @param {(delta: string) => void} [onDelta] - 增量回调（展示用，抛错不影响主流程）。
 * @param {AbortSignal} signal - 中止信号。
 * @returns {Promise<{ text: string, finish: any, toolCall: boolean, exhausted: boolean }>} 装配结果。
 */
async function assembleStream(iterator, onDelta, signal) {
  const texts = new Map()
  const order = []
  let finish
  let toolCall = false
  let exhausted = false

  // 与截止时间赛跑：适配器可能既不出 chunk 也不报错，只检查 chunk 之间会挂死。
  let onAbort
  const aborted = new Promise((_, reject) => {
    onAbort = () => {
      const error = new Error('prompt-forge: aborted')
      error.name = 'AbortError'
      reject(error)
    }
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
  })

  try {
    for (;;) {
      signal.throwIfAborted()
      const next = await Promise.race([iterator.next(), aborted])
      if (next.done) {
        exhausted = true
        break
      }
      const chunk = next.value
      if (chunk === null || typeof chunk !== 'object') continue
      switch (chunk.type) {
        case 'block-start':
          if (chunk.blockType === 'tool-call') toolCall = true
          break
        case 'text-delta': {
          if (!texts.has(chunk.index)) order.push(chunk.index)
          texts.set(chunk.index, (texts.get(chunk.index) ?? '') + (chunk.text ?? ''))
          if (typeof onDelta === 'function' && chunk.text) {
            try {
              onDelta(chunk.text)
            } catch {
              // 展示路径断裂绝不能导致增强失败。
            }
          }
          break
        }
        case 'tool-call-delta':
          toolCall = true
          break
        case 'block-end':
          if (chunk.block?.type === 'tool-call') toolCall = true
          break
        case 'finish':
          finish = chunk.reason
          break
        default:
          break
      }
    }
  } finally {
    if (onAbort !== undefined && !signal.aborted) signal.removeEventListener('abort', onAbort)
    // 超时/取消时挂起的 next() 永不 settle，循环不是正常退出 → 提示底层流收尾，
    // 而不是留给 GC 去关连接。
    if (!exhausted) {
      try {
        void Promise.resolve(iterator.return?.()).catch(() => {})
      } catch {
        // 底层流已死。
      }
    }
  }

  const joined = order
    .sort((a, b) => a - b)
    .map((index) => texts.get(index) ?? '')
    .join('\n')
  return { text: joined, finish, toolCall, exhausted }
}

/** 已知 provider 失败码 → 稳定的展示原因。 */
const REASON_CODES = {
  AUTH: 'auth',
  INVALID_CREDENTIAL: 'invalid-credential',
  RATE_LIMIT: 'rate-limit',
  QUOTA_EXCEEDED: 'quota',
  EMPTY_RESPONSE: 'empty',
  CONTEXT_WINDOW_EXCEEDED: 'context-window',
}

/**
 * 把 finish 原因翻译成线协议错误；正常结束返回 undefined。
 * @param {any} reason - finish.reason。
 * @returns {{ code: string, params?: Record<string, unknown>, message?: string } | undefined} 错误或 undefined。
 */
function finishToDetail(reason) {
  if (reason === undefined || reason === null) return undefined
  switch (reason.kind) {
    case 'stop':
      return undefined
    case 'max-tokens':
      return { code: 'upstream', params: { reason: 'max-tokens' } }
    case 'tool-calls':
      return { code: 'upstream', params: { reason: 'tool-call' } }
    case 'error':
    case 'aborted': {
      const failureCode = reason.failure?.code ?? 'UNKNOWN'
      const known = REASON_CODES[failureCode]
      return {
        code: failureCode === 'NO_ADAPTER' ? 'unconfigured' : 'upstream',
        ...(known === undefined ? {} : { params: { reason: known } }),
        ...(reason.failure?.message === undefined ? {} : { message: reason.failure.message }),
      }
    }
    default:
      return { code: 'internal', message: String(reason) }
  }
}

/**
 * 重写一份草稿并归一化输出。
 * @param {{ stream: (options: any) => AsyncIterable<any> }} llm - `ctx.llm` 服务（或结构等价替身）。
 * @param {object} options - 调用选项。
 * @param {{ provider: string, model: string }} options.route - 已解析路由。
 * @param {string} options.system - 系统提示词。
 * @param {string} options.text - 待重写草稿。
 * @param {'expand' | 'tighten'} options.mode - 请求模式（信封缺失时作为回落值）。
 * @param {number} options.temperature - 采样温度。
 * @param {number} options.maxTokens - 输出上限。
 * @param {number} options.timeoutMs - 端到端截止。
 * @param {AbortSignal} [options.signal] - 调用方取消。
 * @param {string} [options.sessionId] - 会话标识（适配器路由用）。
 * @param {string} [options.context] - 已框定的上下文片段。
 * @param {(delta: string) => void} [options.onDelta] - 增量回调（展示用）。
 * @returns {Promise<{ text: string, mode: string, profile: string, provider: string, model: string, elapsedMs: number }>} 结果。
 * @throws {EnhanceFailure} 带可展示信息的失败；本模块永不改动调用方草稿。
 */
export async function enhanceText(llm, options) {
  const started = Date.now()
  const controller = new AbortController()
  let timedOut = false
  let callerAborted = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, options.timeoutMs)
  const onCallerAbort = () => {
    if (!timedOut) callerAborted = true
    controller.abort()
  }
  options.signal?.addEventListener('abort', onCallerAbort, { once: true })
  if (options.signal?.aborted) {
    callerAborted = true
    controller.abort()
  }
  const signal = controller.signal

  try {
    signal.throwIfAborted()
    const message = {
      role: 'user',
      content: [{ type: 'text', text: frameUserPrompt(options.text, options.context) }],
      // 自定义 source kind：宿主对未知 kind 一律透传，用于把这段流量与用户输入区分开。
      source: { kind: 'prompt-forge' },
      id: randomUUID(),
    }
    /** @type {Record<string, unknown>} */
    const generate = {
      provider: options.route.provider,
      model: options.route.model,
      system: options.system,
      messages: [message],
      temperature: options.temperature,
      maxTokens: options.maxTokens,
      signal,
    }
    if (options.sessionId !== undefined) generate.sessionId = options.sessionId

    const iterator = llm.stream(generate)[Symbol.asyncIterator]()
    const assembled = await assembleStream(iterator, options.onDelta, signal)

    signal.throwIfAborted()

    const finishError = finishToDetail(assembled.finish)
    if (finishError !== undefined) throw new EnhanceFailure(finishError)
    if (assembled.toolCall) throw new EnhanceFailure({ code: 'upstream', params: { reason: 'tool-call' } })

    // 先剥整体围栏，再拆信封：模型偶尔会把整个输出（含信封首行）包进 ``` 里，
    // 顺序反过来会让信封检查恒假、mode 回落、profile 误报 other。
    const normalized = normalizeOutput(assembled.text)
    const envelope = parseEnvelope(normalized, options.mode)
    const body = normalizeOutput(envelope.text)
    if (body === '') throw new EnhanceFailure({ code: 'upstream', params: { reason: 'empty' } })

    return {
      text: body,
      mode: envelope.mode,
      profile: envelope.profile,
      provider: options.route.provider,
      model: options.route.model,
      elapsedMs: Date.now() - started,
    }
  } catch (error) {
    if (error instanceof EnhanceFailure) throw error
    if (timedOut) throw new EnhanceFailure({ code: 'timeout', params: { seconds: Math.ceil(options.timeoutMs / 1000) } })
    if (callerAborted || (error instanceof Error && error.name === 'AbortError')) {
      // 不附细节行：调用方自己知道它取消了。
      throw new EnhanceFailure({ code: 'internal' })
    }
    throw new EnhanceFailure({ code: 'internal', message: error instanceof Error ? error.message : String(error) })
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', onCallerAbort)
  }
}

/** 展示层的原因提示（宿主侧中文，/enhance 命令与日志共用）。 */
const REASON_HINTS = {
  auth: '鉴权失败：请检查该 provider 的 API Key 配置。',
  'invalid-credential': '鉴权失败：存储的 API Key 不可用，请修正后重试。',
  'rate-limit': '模型服务限流，请稍后重试。',
  quota: '模型服务配额/余额不足，请检查账户。',
  empty: '模型返回了空响应，请重试。',
  'context-window': '输入超出模型上下文窗口，请精简原文或更换模型。',
  'tool-call': '模型请求了工具调用，提示词增强只需要纯文本；请更换模型后重试。',
  'max-tokens': '重写结果达到输出上限（maxOutputTokens），请在设置中调大上限或精简原文后重试。',
}

/**
 * 把线协议错误渲染成可展示中文。
 * @param {{ code: string, params?: Record<string, any>, message?: string }} error - 线协议错误。
 * @returns {string} 文案。
 */
export function formatEnhanceError(error) {
  const params = error.params ?? {}
  let text
  switch (error.code) {
    case 'rejected':
      text = '增强请求被拒绝。'
      break
    case 'rate-limit':
      text = `请求过于频繁：每分钟最多 ${params.limit ?? '?'} 次增强，请 ${params.retryAfterSeconds ?? '稍候'} 秒后再试。`
      break
    case 'concurrency-limit':
      text = `已有 ${params.max ?? '?'} 个增强在进行中，请等待其中一个完成后再试。`
      break
    case 'cooldown':
      text = `连续 ${params.failures ?? '?'} 次增强失败，已暂停调用以避免持续冲击模型服务；请 ${params.retryAfterSeconds ?? '?'} 秒后重试，或先检查插件设置中的模型配置。`
      break
    case 'timeout':
      text = `增强超时（${params.seconds ?? '?'} 秒），可重试；原输入未改动。`
      break
    case 'unconfigured':
      text = '尚未确定增强用的模型：请在插件设置中成对填写 provider/model，或先在当前会话发送一条消息（将跟随会话模型）。'
      break
    case 'upstream':
      text = typeof params.reason === 'string' ? (REASON_HINTS[params.reason] ?? '模型服务返回错误，请重试；原输入未改动。') : '模型服务返回错误，请重试；原输入未改动。'
      break
    default:
      text = '增强失败，请重试；原输入未改动。'
  }
  const detail = error.message
  return detail !== undefined && detail !== '' ? `${text}\n${detail}` : text
}

/**
 * 把任意抛出物收敛成线协议错误。
 * @param {unknown} error - 抛出物。
 * @returns {{ code: string, params?: Record<string, unknown>, message?: string }} 线协议错误。
 */
export function toEnhanceError(error) {
  if (error instanceof EnhanceFailure) return error.detail
  if (error !== null && typeof error === 'object' && typeof error.detail?.code === 'string') return error.detail
  return { code: 'internal', message: error instanceof Error ? error.message : String(error) }
}
