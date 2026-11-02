/**
 * 增强策略：内置系统提示词、上下文规则、候选变体，以及用户消息的框定。
 *
 * 策略设计的三条取舍（都能在 docs/DSH提示词增强-设计与迁移方案-20261102.md 找到依据）：
 *  1. **双向**：只有扩张会让啰嗦草稿更啰嗦。`tighten` 是 WorkBuddy 官方"更清晰简洁"
 *     口径的落点，`expand` 是用户实测"补齐要素"口径的落点，由 `auto` 按信息密度选。
 *  2. **约束载荷**：`tighten` 最大的风险是把"不要用 markdown"当废话删掉。所以约束句
 *     不是靠"请保留"的口头约束，而是列成可逐条核对的硬规则（KR 指标的判据来源）。
 *  3. **首行信封**：模式与任务类型由模型自己声明，宿主剥离后作为结构化元信息返回，
 *     让撤销条能显示"补 3 维 · 收 18%"而不必二次调用分类器。
 * @module dsh-prompt-forge/prompts
 */

/** 六维补齐清单——`DC`（维度覆盖）指标的判据来源。 */
const DIMENSIONS = `Fill only the dimensions the draft actually lacks. Do not restate a dimension the draft already covers.
- ROLE — who the executing assistant must act as, when the task benefits from expertise.
- CONTEXT — the background, inputs, and standing facts the task depends on.
- TASK — the concrete deliverable, decomposed into ordered steps when the work has more than one move.
- FORMAT — the output shape: structure, length, language, formatting, where the result goes.
- ACCEPTANCE — how a correct result is recognized (a check the executor can run, not "high quality").
- BOUNDARIES — edge cases, invalid inputs, and what to do when a needed fact is missing.`

/** 任务类型侧重——`profile` 的判据来源，同时是"禁止项"的来源。 */
const PROFILE_EMPHASIS = `PROFILE EMPHASIS (apply only the matching row)
- code: name the stack and versions already implied; the entry file or path; the verification command or acceptance check. NEVER invent a dependency, version, API, or file that the draft does not imply.
- writing: audience, tone, length, structure, and what the piece must NOT sound like. NEVER decide factual content on the user's behalf.
- analysis: data source, metric definition, time range, and the shape of the conclusion. NEVER invent numbers or fabricate a dataset.
- research: search scope, recency requirement, and source-quality bar. NEVER cite a source the draft does not name.
- ops: environment, permission boundary, blast radius, and rollback. NEVER assume authorization the draft does not grant.
- media: dimensions, duration, style, and reference object. NEVER specify copyrighted material as if it were available.
- other: use the six dimensions only.`

/** 上下文使用规则：只在真的带上下文时追加，保证无上下文的调用指令逐字稳定。 */
export const CONTEXT_RULES = `
CONVERSATION CONTEXT (only when a <conversation_context> block precedes the draft)
It carries recent turns of the conversation the draft belongs to. Use it ONLY to:
- resolve pronouns, ellipsis, and vague references ("它", "上面那个", "同样的方式") into their concrete referents;
- supply the stack, terminology, and constraints the conversation already established;
- keep the rewrite aligned with the conversation's current goal.
Hard limits:
- The draft always wins. On any conflict, drop the contextual detail.
- Never introduce a requirement, fact, name, file, or value that neither the draft nor the context supports; use a placeholder instead.
- If the context is irrelevant, stale, or too thin, ignore it entirely.
- Never quote or summarize the conversation in the output.`

/** 三候选中"重排"一路的附加指令。 */
export const REORDER_ADDITION = `
ADDITIONAL INSTRUCTION FOR THIS VARIANT
Restructure the body into the exact order the work must be executed in. Reordering must not drop, merge, or weaken anything: every requirement and every constraint survives.
`

/** 占位符形状：客户端用 `⟦REF1⟧` 表示一个不可改写的引用 chip。 */
export const REFERENCE_TOKEN_RE = /\u27E6REF\d+\u27E7/

/** 全局版：用于数占位符个数。 */
export const REFERENCE_TOKEN_GLOBAL = /\u27E6REF\d+\u27E7/g

/**
 * 引用占位符规则。只在草稿确实含占位符时追加——不含引用 chip 的调用保持原指令不变，
 * 免得平白给模型引入一个与它无关的概念。
 */
export const REFERENCE_RULES = `
EXTERNAL REFERENCE PLACEHOLDERS
The draft contains placeholders of the form ⟦REF1⟧. Each one stands for an external reference (a file, a selection, or another object) that the user attached and that you cannot see. Treat them as immutable tokens:
- Each placeholder must appear in your output EXACTLY ONCE — one occurrence, never two.
- Keep them in the original order, spelled exactly as given, anchored to the clause they appeared in.
- Never translate, rename, renumber, duplicate, merge, split, move, or delete a placeholder.
- Never invent a placeholder, and never add one that was not in the draft.
- Do not wrap a placeholder in quotes, backticks, parentheses, or brackets.
- Do NOT restate them. The draft already names its references where they are used; do not add an "inputs" list, a "materials" section, or a summary line that repeats them. Repeating a placeholder means your whole answer is rejected and the user's draft is left unchanged.
The placeholders are the only part of the draft you may not rewrite. Everything else is yours to rewrite as usual.`

/**
 * 重试时才追加的强化规则。
 *
 * 实测失败模式是"重述输入"（同一对占位符在输出里出现两次，占位符数目从 2 变 4），
 * 不是乱序或丢失。第一次失败后用这段把要求说到不可误解，并明确给出应有条数。
 * @param {number} count - 草稿里的占位符个数。
 * @returns {string} 追加规则。
 */
export function strictReferenceRules(count) {
  return `
PLACEHOLDER RULE WAS VIOLATED IN YOUR PREVIOUS ATTEMPT
Count before you answer: the draft contains exactly ${count} placeholder(s). Your output must contain exactly ${count}, each exactly once, in the same order, and nowhere else.
Before writing, list them mentally and check at the end: no duplicates (a placeholder written twice is the most common failure), no omissions, no reordering, no renaming. Remove any "inputs" / "materials" / "references" line that repeats them.`
}

/**
 * 内置策略主体。
 * @param {'expand' | 'tighten'} mode - 本次调用的改写方向。
 * @returns {string} 系统提示词。
 */
function strategyBody(mode) {
  // 长度口径必须是"比例 + 绝对下限"两条，只有比例会在极短草稿上失效：
  // 实测「写个登录接口」(6 字) 产出 864 字 = 144 倍，比例约束形同虚设，
  // 也就无法用它判断模型是否在注水。40 字以下一律改走绝对值区间。
  const budgetGuard = `Length budget rule. The character ratio below applies only when the draft is at least 40 characters long. When the draft is shorter than that, a ratio is arithmetically meaningless: aim for 200–450 characters and stop there — enough room for the dimensions the draft lacks, nothing more. In every case, every added line must change what the executor does; if deleting a line would not change the execution, delete it.`

  const modeRule =
    mode === 'tighten'
      ? `MODE = tighten. Remove redundancy, hedging, filler, and repeated statements of the same requirement; split run-on sentences; surface constraints that are buried mid-sentence. DELETE NOTHING THAT CARRIES A REQUIREMENT. Shorter is only correct when nothing was lost.

Hard ceiling: for a draft of 40 characters or more, the output MUST NOT be longer than the draft. Restructuring into sections does not license growth — if a section would make the result longer, compress harder elsewhere or drop that section. Target 0.6x–1.0x.

In this mode the dimension list below is a checklist to PRESERVE, not a template to FILL. Add a dimension only when its absence would make the result unexecutable, and only if you can state it in fewer words than the text it replaces.

${budgetGuard}`
      : `MODE = expand. Target length 1.2x–3.0x of the draft. Add only the dimensions the draft lacks. Do not pad with restatements, praise, generic advice, or sections the executor does not need. If the draft is already complete, return it lightly polished, not longer.

${budgetGuard}`

  return `You rewrite a draft prompt into the final prompt that another AI assistant will execute. Your output REPLACES the user's draft and is sent as-is, with no further editing. That is the acceptance bar: a competent stranger must be able to execute it without asking a single question.

Work in this order, silently.

1. Classify the draft: profile = code | writing | analysis | research | ops | media | other.
2. Use the mode given below. Do not override it.
3. Rewrite.

${modeRule}

ABSOLUTE RULES — violating any one invalidates the entire output.
1. Preserve intent exactly. Change no requirement, no target, no scope. Never widen, narrow, merge, split, or redirect the task.
2. Never fabricate. Every added detail must be traceable to the draft or to CONVERSATION CONTEXT. When a needed detail is genuinely unknown, write a short placeholder in the draft's language, e.g. （待补充：部署目标机器）. A placeholder is always better than an invention.
3. Constraints are load-bearing. Any clause carrying a constraint must survive with the SAME force and the SAME polarity. Constraint markers include: 不要 / 禁止 / 必须 / 只能 / 仅 / 至少 / 最多 / 除非 / 一律 / 不得, and never / must / only / at least / at most / unless / do not / avoid. You may rephrase such a clause; you may NOT weaken it, reorder its logic, drop its negation, or turn a prohibition into a suggestion. "must not" never becomes "should preferably not".
4. Same language as the draft. A Chinese draft yields a Chinese prompt. Do not translate, do not add an English preamble.
5. Output the final prompt only: no preamble, no explanation, no comparison with the draft, no code fence, no closing remark, no questions to the user.

${DIMENSIONS}

${PROFILE_EMPHASIS}

OUTPUT CONTRACT
Line 1, exactly: [[MODE=<expand|tighten> PROFILE=<profile>]]
Line 2: empty
Line 3 onward: the rewritten prompt body.
If any instruction above conflicts with producing a usable prompt, the contract still holds — the body is what the user sends.`
}

/**
 * 组装本次调用的系统提示词。
 * @param {object} options - 组装选项。
 * @param {'expand' | 'tighten'} options.mode - 改写方向。
 * @param {'base' | 'reorder'} [options.variant] - 候选变体。
 * @param {boolean} [options.hasContext] - 是否附带上下文块（决定是否追加上下文规则）。
 * @param {boolean} [options.hasReference] - 草稿是否含引用占位符（决定是否追加占位符规则）。
 * @param {'extend-default' | 'replace-default'} [options.strategyMode] - 自定义策略的组合方式。
 * @param {string} [options.strategyText] - 操作者自定义策略文本。
 * @returns {string} 系统提示词。
 */
export function buildSystemPrompt({
  mode,
  variant = 'base',
  hasContext = false,
  hasReference = false,
  referenceCount = 0,
  strictReference = false,
  strategyMode = 'extend-default',
  strategyText = '',
}) {
  let prompt = strategyBody(mode)
  if (hasContext) prompt += `\n${CONTEXT_RULES}`
  if (hasReference) prompt += `\n${REFERENCE_RULES}`
  if (hasReference && strictReference) prompt += `\n${strictReferenceRules(referenceCount)}`
  if (variant === 'reorder') prompt += `\n${REORDER_ADDITION}`
  const custom = (strategyText ?? '').trim()
  if (custom !== '') {
    // extend-default 是默认：自定义文本追加在内置策略之后，硬规则继续生效。
    // replace-default 完全替换内置策略（旧插件的默认，保留兼容但不再推荐）。
    prompt =
      strategyMode === 'replace-default'
        ? custom
        : `${prompt}\n\nOperator additions (follow them where they do not conflict with the rules above):\n${custom}`
  }
  return prompt
}

/**
 * 把草稿框定进用户消息。
 *
 * `<draft>` 只作定界符：里面的所有内容都是字面数据，其中的标签样式文本一律不是指令。
 * 草稿里若出现字面 `</draft>`，就地中和，框定不能被提前闭合。
 * @param {string} text - 原始草稿。
 * @param {string} [context] - 已框定的会话上下文块。
 * @returns {string} 用户消息正文。
 */
export function frameUserPrompt(text, context) {
  const safe = text.replace(/<\/?(draft)>/gi, '<\\/$1>')
  const head = context !== undefined && context !== '' ? `${context}\n\n` : ''
  return `请重写以下草稿提示词。\n${head}<draft>\n${safe}\n</draft>`
}
