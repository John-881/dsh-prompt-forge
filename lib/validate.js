/**
 * 输入校验与输出归一化：宿主路由与（M2）浏览器半共用同一套纯函数，
 * 让客户端能在发起请求前用与宿主完全一致的判据本地拒绝。
 * @module dsh-prompt-forge/validate
 */

/** 零宽与双向控制码点：不参与"是否为空"判定，但计入长度上限。 */
function isInvisible(cp) {
  return (
    (cp >= 0x200b && cp <= 0x200d) ||
    cp === 0xfeff ||
    (cp >= 0x202a && cp <= 0x202e) ||
    (cp >= 0x2066 && cp <= 0x2069)
  )
}

/**
 * 按 Unicode 码点计数——用户感知的"字数"。emoji 与组合字算 1，不是 2 个 UTF-16 单元。
 * 校验、错误文案与埋点共用这一个口径，否则界面上显示的数字会和日志对不上。
 * @param {string} text - 待计数文本。
 * @returns {number} 码点数。
 */
export function countText(text) {
  let n = 0
  for (const _ of text) n++
  return n
}

/**
 * 一次遍历同时完成计数与"有无可见内容"判定。
 * @param {string} text - 待扫描文本。
 * @returns {{ count: number, visibleNonBlank: boolean }} 码点数与可见性。
 */
function scanText(text) {
  let count = 0
  let visibleNonBlank = false
  for (const ch of text) {
    count++
    if (!isInvisible(ch.codePointAt(0) ?? 0) && !/\s/.test(ch)) visibleNonBlank = true
  }
  return { count, visibleNonBlank }
}

/**
 * 判定一份草稿：去零宽、去首尾空白后非空，且在码点上限内。
 * 超限**拒绝而非截断**——截断会改变用户的意思。
 * @param {string} text - 草稿文本。
 * @param {number} maxChars - 码点上限。
 * @returns {{ ok: true } | { ok: false, code: 'empty' } | { ok: false, code: 'too-long', count: number, max: number }} 结构化判定。
 */
export function checkInputText(text, maxChars) {
  const { count, visibleNonBlank } = scanText(text)
  if (!visibleNonBlank) return { ok: false, code: 'empty' }
  if (count > maxChars) return { ok: false, code: 'too-long', count, max: maxChars }
  return { ok: true }
}

/**
 * 把判定渲染成可展示的中文（宿主侧文案；M2 客户端走自己的字典）。
 * @param {ReturnType<typeof checkInputText>} check - 判定结果。
 * @returns {string} 文案；通过时为空串。
 */
export function formatInputCheckZh(check) {
  if (check.ok) return ''
  if (check.code === 'empty') return '输入框为空，请先输入要增强的提示词。'
  return `内容共 ${check.count} 个字符，超过 ${check.max} 个字符上限（按 Unicode 字符数统计，不是 token 数）。为避免改变原意不会自动截断，请精简后再试。`
}

/** 三个以上连续换行压成一个空行。 */
const EXCESS_BLANK_LINES = /\n{3,}/g

/**
 * 输出契约首行：`[[MODE=expand PROFILE=code]]`。
 *
 * 允许模型在首行前有空白、允许大小写差异；不允许多余字段（宁可判失败走
 * 兜底，也不要含糊解析导致 mode 报错）。
 */
const ENVELOPE_RE = /^\s*\[\[\s*MODE\s*=\s*(expand|tighten)\s+PROFILE\s*=\s*([a-z]+)\s*\]\]\s*(?:\r?\n)?/i

/**
 * 拆掉模型输出的信封首行，返回正文与元信息。
 *
 * 缺信封不是错误：模型偶尔会漏，此时正文原样返回、mode 回落到请求模式、
 * profile 记为 `other`。增强功能不能因为"少了一行元信息"而失败。
 * @param {string} raw - 模型原始输出。
 * @param {'expand' | 'tighten'} fallbackMode - 请求时指定的模式。
 * @returns {{ text: string, mode: string, profile: string, envelope: boolean }} 拆封结果。
 */
export function parseEnvelope(raw, fallbackMode) {
  const match = ENVELOPE_RE.exec(raw)
  if (match === null) return { text: raw, mode: fallbackMode, profile: 'other', envelope: false }
  return {
    text: raw.slice(match[0].length),
    mode: match[1].toLowerCase(),
    profile: match[2].toLowerCase(),
    envelope: true,
  }
}

/**
 * 归一化模型输出为最终正文（第二道防线，第一道是系统提示词的硬规则）。
 *
 * 只有"整体被一层围栏包住"才剥（开场 ``` + 收尾 ``` 且全文恰好两个围栏标记）；
 * 正文中间的多个代码块是内容的一部分，必须原样保留。
 * @param {string} raw - 已拆信封的正文。
 * @returns {string} 归一化正文；无可用内容时为空串。
 */
export function normalizeOutput(raw) {
  let text = raw.trim()
  const fenceCount = (text.match(/```/g) ?? []).length
  if (text.startsWith('```') && /```[\s]*$/.test(text) && fenceCount === 2) {
    if (text.includes('\n')) {
      text = text.slice(text.indexOf('\n') + 1).replace(/```[\s]*$/, '').trim()
    } else {
      text = text.slice(3, -3).trim()
    }
  }
  return text.replace(EXCESS_BLANK_LINES, '\n\n').trim()
}
