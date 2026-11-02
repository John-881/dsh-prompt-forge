/**
 * 上下文接地：把会话派生历史压成一段有界的、中和过的片段。
 *
 * 两条不变式：
 *  - **绝不编造**：片段是证据不是指令，放在 <conversation_context> 里，系统提示词
 *    明令不得据此引入草稿不支持的内容；冲突时草稿永远优先。
 *  - **失败即回落**：无会话、无历史、窗口为空、历史层抛错，一律返回 undefined，
 *    调用方退化为"纯草稿增强"——接地是优化，不能成为失败源。
 * @module dsh-prompt-forge/context
 */

import { countText } from './validate.js'

/** 被字符预算截断的轮次追加的标记。 */
const TRUNCATION_MARK = '…（已截断）'

/**
 * 按码点截断，避免切开代理对（emoji、CJK 扩展区）留下孤立半字符。
 * @param {string} text - 待截断文本。
 * @param {number} max - 码点预算；非正数返回空串。
 * @returns {string} 至多 max 个码点的前缀。
 */
function cutToCodePoints(text, max) {
  if (max <= 0) return ''
  if (text.length <= max) return text
  let out = ''
  let n = 0
  for (const ch of text) {
    if (n === max) break
    out += ch
    n++
  }
  return out
}

/**
 * 一条派生消息里的可见散文。只取 text 块：工具调用、工具结果与思考链不含
 * 用户可见措辞，计入窗口只会挤掉真正的证据。
 * @param {{ role?: unknown, content?: unknown }} message - 未受信任的派生消息。
 * @returns {string} 合并并 trim 后的文本；无文本时为空串。
 */
function turnTextOf(message) {
  const content = message.content
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    if (block.type !== 'text' || typeof block.text !== 'string') continue
    const text = block.text.trim()
    if (text !== '') parts.push(text)
  }
  return parts.join('\n')
}

/**
 * 挑选落进窗口的轮次，保持时间顺序。
 *
 * 预算从**最新一轮向前**花：草稿里的代词与省略几乎总指最近几轮，所以窗口不够时
 * 必须丢最旧的，不能丢最新的。
 * @param {readonly unknown[]} messages - 会话派生历史（未受信任）。
 * @param {{ maxMessages: number, maxChars: number }} options - 配置的窗口。
 * @param {string} [draft] - 正在增强的草稿；与之相等的末尾 user 轮会被剔除。
 * @returns {Array<{ role: 'user' | 'assistant', text: string }>} 入选轮次（时间正序）。
 */
export function selectTurns(messages, options, draft) {
  const maxMessages = Number.isInteger(options.maxMessages) ? Math.max(0, options.maxMessages) : 0
  const maxChars = Number.isInteger(options.maxChars) ? Math.max(0, options.maxChars) : 0
  if (maxMessages === 0 || maxChars === 0) return []

  const turns = []
  for (const message of messages) {
    if (message === null || typeof message !== 'object') continue
    if (message.role !== 'user' && message.role !== 'assistant') continue
    const text = turnTextOf(message)
    if (text === '') continue
    turns.push({ role: message.role, text })
  }

  // 有些宿主派生的历史已经含"光标处这段文字"；把草稿当成自己的上下文只是浪费预算。
  if (typeof draft === 'string') {
    const trimmed = draft.trim()
    if (trimmed !== '') {
      for (let index = turns.length - 1; index >= 0; index--) {
        const candidate = turns[index]
        if (candidate !== undefined && candidate.role === 'user' && candidate.text === trimmed) {
          turns.splice(index, 1)
          break
        }
      }
    }
  }

  const windowed = turns.slice(-maxMessages)
  const kept = []
  let used = 0
  for (let index = windowed.length - 1; index >= 0; index--) {
    const turn = windowed[index]
    const length = countText(turn.text)
    if (used + length > maxChars) {
      const room = maxChars - used
      // 一轮超长不能把整个窗口清空：留它的开头并标注截断——开头才是任务、
      // 技术栈与约束所在，也正是草稿在简写的对象。
      if (kept.length === 0 && room > TRUNCATION_MARK.length + 40) {
        kept.unshift({
          role: turn.role,
          text: `${cutToCodePoints(turn.text, room - TRUNCATION_MARK.length).trimEnd()}${TRUNCATION_MARK}`,
        })
      }
      break
    }
    used += length
    kept.unshift(turn)
  }
  return kept
}

/**
 * 中和历史文本里字面的 conversation_context 标签，使历史无法提前闭合或伪造框定。
 * @param {string} text - 一轮文本。
 * @returns {string} 中和后的文本。
 */
function neutralize(text) {
  return text.replace(/<\/?(conversation_context)>/gi, '<\\/$1>')
}

/**
 * 把入选轮次渲染成交给模型的块。
 * @param {Array<{ role: string, text: string }>} turns - 入选轮次（时间正序）。
 * @returns {string} 框定后的片段。
 */
export function formatContextBlock(turns) {
  const body = turns.map((turn) => `[${turn.role}] ${neutralize(turn.text)}`).join('\n')
  return `<conversation_context>\n${body}\n</conversation_context>`
}

/**
 * 构造本次增强的接地片段，或什么都不给。
 * @param {readonly unknown[] | undefined} messages - 会话派生历史（可能为 undefined）。
 * @param {{ maxMessages: number, maxChars: number }} options - 配置的窗口。
 * @param {string} [draft] - 正在增强的草稿。
 * @returns {string | undefined} 框定后的片段；无可用历史时 undefined。
 */
export function buildConversationContext(messages, options, draft) {
  if (messages === undefined) return undefined
  const turns = selectTurns(messages, options, draft)
  if (turns.length === 0) return undefined
  return formatContextBlock(turns)
}
