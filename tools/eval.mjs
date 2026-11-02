#!/usr/bin/env node
/**
 * L1 确定性指标评测（设计文档 §7.2）。
 *
 * 它**不新增宿主代码**：只调用已经公开的 `POST /prompt-forge/enhance`，所以评测用的
 * 就是把用户点按钮时走的那条路径，不存在"测试专用旁路"这种会导致结论失真的东西。
 *
 * 指标都是可脚本复算的代理量，不是 LLM 评判：
 *   FRR 事实保留率 —— 标注事实是否仍出现在结果里（去空白、忽略大小写）
 *   KR  约束保留率 —— 约束片段是否保留，且否定极性没有翻转
 *   HR  捏造率     —— 结果里新出现、且原文没有的数字
 *   LR  长度比     —— 码点比
 *   DC  维度覆盖   —— 角色/步骤/格式/验收/边界 五个标记命中的个数
 *
 * KR 是最要紧的那个：决策 4 要求 `tighten` 在 KR ≥ 0.99 后才允许进 `auto`。
 * 这里的 KR 是粗判（关键词 + ±24 字符窗口内的否定词），报告会逐条打印判定依据，
 * 供人工抽检校准——设计文档要求"规则抽取 + 20 条人工校准"，本脚本只做前半段。
 *
 * 用法：
 *   node tools/eval.mjs --base http://127.0.0.1:12345 --mode expand,tighten
 *   node tools/eval.mjs --base ... --limit 4 --gap 6500
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')

/** 解析 `--key value` 形式的参数。 */
function parseArgs(argv) {
  const args = {}
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index]
    if (!token.startsWith('--')) continue
    const key = token.slice(2)
    const next = argv[index + 1]
    if (next === undefined || next.startsWith('--')) args[key] = true
    else {
      args[key] = next
      index++
    }
  }
  return args
}

const args = parseArgs(process.argv.slice(2))

/**
 * 自动找宿主端口。
 *
 * 宿主的 web 端口每次启动都会变（见 AGENTS.md 的「端口每次重启都变」），要求用户
 * 先手动查端口再填 `--base` 是把摩擦转嫁给使用者。这里扫一遍本机回环监听端口，
 * 用 `GET /prompt-forge/state` 识别：只有本插件会返回带 `candidates` 的 JSON。
 * @returns {Promise<string | null>} 命中的 base URL。
 */
async function discoverBase() {
  let ports = []
  try {
    const { execSync } = await import('node:child_process')
    const table = execSync('netstat -ano', { encoding: 'utf8' })
    const found = new Set()
    for (const line of table.split('\n')) {
      if (!/LISTENING/i.test(line)) continue
      const match = /(?:127\.0\.0\.1|0\.0\.0\.0|\[::1\]):(\d+)\s/i.exec(line)
      if (match !== null) found.add(Number(match[1]))
    }
    ports = [...found]
  } catch {
    return null
  }
  for (const port of ports) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/prompt-forge/state`, { signal: AbortSignal.timeout(400) })
      const text = await response.text()
      if (text.includes('"candidates"')) return `http://127.0.0.1:${port}`
    } catch {
      // 该端口不是宿主，继续。
    }
  }
  return null
}

// 每次评测都要能跟上宿主重启：DSH 的 web 端口重启即变（本机实测 12:53 那次重启
// 就把 12218 换掉了，原端口转由代理返回 502）。所以 BASE 可重解析。
let BASE = (typeof args.base === 'string' ? args.base.replace(/\/$/, '') : null) ?? (await discoverBase())
if (BASE === null) {
  console.error('没找到宿主端口。请确认 DSH 正在运行，或显式给 --base http://127.0.0.1:<port>')
  console.error('查看插件是否装配：~/.dsh/logs/dsh-prompt-forge/events.jsonl 里应有 {"event":"apply"}')
  process.exit(1)
}
console.log(`宿主：${BASE}`)
const MODES = (typeof args.mode === 'string' ? args.mode : 'expand,tighten').split(',').map((mode) => mode.trim()).filter(Boolean)
const LIMIT = typeof args.limit === 'string' ? Number(args.limit) : 0
// 默认 6.5s/次：宿主限流是 10 次/分钟，留一点余量，评测不该把自己判定为"被限流"。
const GAP = typeof args.gap === 'string' ? Number(args.gap) : 6500

/**
 * 否定/限定词表。按长度降序匹配，避免「只要」被「只」抢先剥掉。
 *
 * 这张表的第一版只用于"整词过滤"，于是中文里 `不走全表扫描` 这种单 token 约束
 * 会被整条剥空、直接判失败——实测把 KR 压到 0.375，而人工看输出时约束几乎全在。
 * 现在改为**剥前缀、留内容核心**。
 */
const NEGATORS = [
  '不要', '别用', '不再', '不得', '不可', '不能', '禁止', '避免', '无需', '不用',
  '不走', '不是', '除非', '只能', '只要', '只写', '仅', '别', '只', '不',
].sort((a, b) => b.length - a.length)

/** 文本里是否含否定/限定词。 */
function hasNegator(text) {
  return NEGATORS.some((word) => text.includes(word))
}

/**
 * 剥离开头的否定/限定词，留下被约束的内容核心。
 * `不走全表扫描` → `全表扫描`；`只写背景和目标` → `背景和目标`。
 * @returns {string} 内容核心；剥完为空时退回原片段。
 */
function coreOf(fragment) {
  const trimmed = fragment.trim()
  for (const word of NEGATORS) {
    if (trimmed.startsWith(word) && trimmed.length > word.length) return trimmed.slice(word.length)
  }
  return trimmed
}

/** 取 `needle` 首次出现位置之前的窗口，用于判断极性。 */
function windowBefore(text, needle, size) {
  const at = text.indexOf(needle)
  return at === -1 ? '' : text.slice(Math.max(0, at - size), at)
}

/**
 * 事实是否保留。
 *
 * 纯子串比对会把 `2025 年 6 月` 与 `2025-06` 判成"丢失"——两者语义相同，只是写法不同。
 * 含数字的事实改按**数值集合**比对；不含数字的仍用子串。
 * @returns {boolean}
 */
function factKept(output, fact) {
  if (normalize(output).includes(normalize(fact))) return true
  const numbers = fact.match(/\d+/g)
  if (numbers === null) return false
  const present = new Set((output.match(/\d+/g) ?? []).map(Number))
  return numbers.map(Number).every((value) => present.has(value))
}

/**
 * 去掉结构助词再比对。
 *
 * `动现有的表结构` 与 `改动现有表结构` 只差一个「的」，子串判定会判失败。
 * 助词不承载语义，去掉它只降低假阴性，不影响"极性翻转"这一类的检出。
 */
function stripParticles(text) {
  return text.replace(/[的地得了]/g, '')
}

/**
 * 判定一条约束。
 *
 * 三档，**不把"看不出来"伪装成"失败"**：
 *  - `kept`   字面保留，或内容核心在且否定极性一致；
 *  - `lost`   内容核心在但否定消失（把禁令改成了要求）——这才是确定丢失；
 *  - `review` 内容核心未按字面出现（可能被同义改写）。同义词无法用字符串判定，
 *             这一档交给人工，脚本只负责把它挑出来。
 * @returns {{ state: 'kept' | 'lost' | 'review', why: string }}
 */
function judgeConstraint(output, fragment) {
  const out = stripParticles(normalize(output))
  const src = stripParticles(normalize(fragment))
  if (out.includes(src)) return { state: 'kept', why: '原样保留' }

  const core = stripParticles(normalize(coreOf(fragment)))
  if (core !== '' && out.includes(core)) {
    const srcNegated = hasNegator(fragment)
    const outNegated = hasNegator(windowBefore(out, core, 30))
    if (srcNegated === outNegated) return { state: 'kept', why: '内容核心与否定极性均保留' }
    if (srcNegated) return { state: 'lost', why: '极性翻转：内容在，但否定消失' }
    return { state: 'kept', why: '原文无否定、结果更严格（仍算保留）' }
  }
  return { state: 'review', why: '内容核心未按字面出现（可能同义改写，需人工确认）' }
}

/**
 * 数字扫描：区分"编造的具体规格"与"步骤序号"。
 *
 * 第一版把 `1. 2. 3.` 这种序号也算成捏造数字，10 条草稿刷出 27 个"捏造"，
 * 指标完全失去分辨力。现在先剥行首/括号里的序号，再把剩余数字分两档：
 * `specLike`（≥100、带 % 或小数）才算捏造嫌疑，`smallInt` 只做记录。
 * @returns {{ specLike: string[], smallInt: string[] }}
 */
function fabricatedScan(input, output) {
  // 先去掉列表序号：行首 `1.` `2、` `3)` 与 `（1）` 形式。
  const cleaned = output
    .replace(/^[ \t]*\d+[.、)][ \t]?/gm, '')
    .replace(/[（(]\d+[）)]/g, '')

  const numberRe = /\d+(?:\.\d+)?%?/g
  const known = new Set((input.match(numberRe) ?? []).map((token) => token.replace('%', '')))
  const specLike = new Set()
  const smallInt = new Set()
  for (const token of cleaned.match(numberRe) ?? []) {
    const bare = token.replace('%', '')
    if (known.has(bare)) continue
    const value = Number.parseFloat(bare)
    const isSpec = token.includes('%') || token.includes('.') || value >= 100
    if (isSpec) specLike.add(token)
    else if (value > 20) smallInt.add(token)
  }
  return { specLike: [...specLike], smallInt: [...smallInt] }
}

/** 只用于比较的归一化：去空白、统一小写、全角括号转半角。 */
function normalize(text) {
  return text.replace(/\s+/g, '').replace(/（/g, '(').replace(/）/g, ')').toLowerCase()
}

/** 码点计数。 */
function countText(text) {
  let n = 0
  for (const _ of text) n++
  return n
}

/** 维度覆盖：五个标记的命中数（0–5）。 */
function dimensionCoverage(output) {
  const markers = [
    /你是|作为一?名?|角色[:：]/,
    /(^|\n)\s*1[.、)]|步骤|首先|第一步/,
    /输出格式|格式[:：]|以.{0,6}形式|表格|JSON|markdown/i,
    /验收|完成标准|判断标准|可运行|应当能|满足/,
    /边界|异常|如果.{0,12}(没有|缺少|为空)|无法|未知/,
  ]
  return markers.filter((pattern) => pattern.test(output)).length
}

/** 调一次增强（一次性 JSON 端点，不用 SSE——评测只要最终文本）。 */
let rediscovered = 0

/**
 * 调一次增强。网络层失败时重探端口并重试一次——宿主重启会把端口换掉，
 * 而一次评测要跑一两分钟，中途重启在这里是常态，不是异常。
 */
async function callEnhance(text, mode) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await fetch(`${BASE}/prompt-forge/enhance`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text, mode }),
      })
      const payload = await response.json().catch(() => null)
      if (!response.ok || !payload || payload.ok !== true) {
        const detail = payload && payload.error ? payload.error : { code: `HTTP${response.status}` }
        throw new Error(`${detail.code}${detail.message ? `: ${detail.message}` : ''}`)
      }
      return payload.data
    } catch (error) {
      const isNetwork = error instanceof TypeError || (error && error.name === 'AbortError') || /fetch failed|socket|ECONN/i.test(String(error && error.message))
      if (attempt === 0 && isNetwork && rediscovered < 3) {
        rediscovered += 1
        const fresh = await discoverBase()
        if (fresh !== null && fresh !== BASE) {
          console.log(`· 宿主端口变了（${BASE} → ${fresh}），已重新定位`)
          BASE = fresh
          continue
        }
      }
      throw error
    }
  }
  throw new Error('unreachable')
}

/** 等一会儿，避免打穿宿主限流。 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 中位数。 */
function median(values) {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

/** 平均值。 */
function mean(values) {
  if (values.length === 0) return 0
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

const fixturesAll = JSON.parse(readFileSync(join(ROOT, 'eval', 'fixtures.json'), 'utf8'))
// `--minIn 40` 只跑长草稿：比例指标只在这一档可测，改完 tighten 策略后要单独复测。
const minIn = typeof args.minIn === 'string' ? Number(args.minIn) : 0
const eligible = minIn > 0 ? fixturesAll.filter((item) => countText(item.draft) >= minIn) : fixturesAll
const fixtures = LIMIT > 0 ? eligible.slice(0, LIMIT) : eligible
if (fixtures.length === 0) {
  console.error(`没有满足 --minIn ${minIn} 的样本`)
  process.exit(1)
}

const rows = []
let first = true

for (const mode of MODES) {
  for (const fixture of fixtures) {
    if (!first) await sleep(GAP)
    first = false
    const started = Date.now()
    let record = { id: fixture.id, mode, ok: false }
    try {
      const data = await callEnhance(fixture.draft, mode)
      const output = data.text
      const inChars = countText(fixture.draft)
      const outChars = countText(output)
      const constraints = (fixture.constraints ?? []).map((fragment) => ({ fragment, ...judgeConstraint(output, fragment) }))
      const fabricated = fabricatedScan(fixture.draft, output)
      record = {
        ...record,
        ok: true,
        profile: data.profile,
        expectedProfile: fixture.profile,
        inChars,
        outChars,
        // 比例只在草稿 ≥40 字时有意义：策略对短草稿用的是 200–450 字的绝对区间，
        // 拿 10 字草稿去算 13x 只会得到一个看着像失败的假信号。
        ratio: inChars >= 40 ? outChars / inChars : null,
        lenInRange: inChars >= 40 ? null : outChars >= 200 && outChars <= 450,
        facts: (fixture.facts ?? []).map((fact) => ({ fact, kept: factKept(output, fact) })),
        constraints,
        fabricated: fabricated.specLike,
        fabricatedSmall: fabricated.smallInt,
        coverage: dimensionCoverage(output),
        ms: Date.now() - started,
        text: output,
      }
    } catch (error) {
      record = { ...record, error: error instanceof Error ? error.message : String(error), ms: Date.now() - started }
    }
    rows.push(record)
    const mark = record.ok ? '✓' : '✗'
    const judged = record.ok ? record.constraints : []
    const kept = judged.filter((c) => c.state === 'kept').length
    const lost = judged.filter((c) => c.state === 'lost').length
    const review = judged.filter((c) => c.state === 'review').length
    const ratioText = record.ok && record.ratio !== null ? `ratio=${record.ratio.toFixed(1)}` : `len=${record.outChars}`
    const summary = record.ok
      ? `${ratioText} cov=${record.coverage}/5 kr=${kept}/${judged.length}${lost ? ` LOST=${lost}` : ''}${review ? ` review=${review}` : ''}`
      : record.error
    console.log(`${mark} ${mode.padEnd(7)} ${fixture.id.padEnd(12)} ${String(record.outChars ?? '-').padStart(4)}字 ${summary}`)
  }
}

/** 按模式汇总。 */
function summarize(mode) {
  const subset = rows.filter((row) => row.mode === mode && row.ok)
  if (subset.length === 0) return null
  const facts = subset.flatMap((row) => row.facts)
  const constraints = subset.flatMap((row) => row.constraints)
  const long = subset.filter((row) => row.ratio !== null)
  const short = subset.filter((row) => row.lenInRange !== null)
  return {
    mode,
    runs: subset.length,
    failures: rows.filter((row) => row.mode === mode && !row.ok).length,
    ratioMedian: long.length === 0 ? 'n/a' : Number(median(long.map((row) => row.ratio)).toFixed(2)),
    lenInRange: short.length === 0 ? 'n/a' : `${short.filter((row) => row.lenInRange).length}/${short.length}`,
    factsKept: facts.length === 0 ? 1 : Number((facts.filter((item) => item.kept).length / facts.length).toFixed(3)),
    krKept: constraints.filter((item) => item.state === 'kept').length,
    krLost: constraints.filter((item) => item.state === 'lost').length,
    krReview: constraints.filter((item) => item.state === 'review').length,
    krAuto: constraints.length === 0 ? 1 : Number((constraints.filter((item) => item.state === 'kept').length / constraints.length).toFixed(3)),
    fabricatedSpec: subset.reduce((sum, row) => sum + row.fabricated.length, 0),
    coverageMean: Number(mean(subset.map((row) => row.coverage)).toFixed(2)),
    latencyMsMedian: median(subset.map((row) => row.ms)),
  }
}

const summaries = MODES.map(summarize).filter((item) => item !== null)

console.log('\n═══ 汇总 ═══')
console.table(summaries)

const tighten = summaries.find((item) => item.mode === 'tighten')
if (tighten !== undefined) {
  console.log('\n决策 4 闸门（tighten 进 auto 需 KR ≥ 0.99）')
  console.log(`  自动确认保留 ${tighten.krKept} · 确定丢失 ${tighten.krLost} · 需人工确认 ${tighten.krReview}`)
  if (tighten.krLost === 0 && tighten.krReview === 0) {
    console.log('  → 通过：全部约束自动确认保留')
  } else if (tighten.krLost === 0) {
    console.log(`  → 初筛通过：无确定丢失；${tighten.krReview} 条疑似同义改写需人工确认后再定`)
  } else {
    console.log('  → 未通过：存在极性翻转（把禁令写成要求）')
  }

  const suspicious = rows
    .filter((row) => row.mode === 'tighten' && row.ok)
    .flatMap((row) => row.constraints.filter((item) => item.state !== 'kept').map((item) => ({ ...item, id: row.id, text: row.text })))
  for (const item of suspicious) {
    const core = item.fragment.replace(/^(不要|别用|不再|不得|不可|不能|禁止|避免|无需|不用|不走|不是|除非|只能|只要|只写|仅|别|只|不)/, '')
    const at = item.text.indexOf(core)
    const context = at === -1 ? '（输出中未出现该内容核心）' : `…${item.text.slice(Math.max(0, at - 30), at + core.length + 30).replace(/\n/g, ' ')}…`
    console.log(`  ${item.state === 'lost' ? '✗' : '?'} ${item.id} 「${item.fragment}」— ${item.why}`)
    console.log(`      ${context}`)
  }
}

// 逐条保留全文，供人工抽检（设计文档要求 20 条人工校准）。
mkdirSync(join(ROOT, 'eval'), { recursive: true })
const reportPath = join(ROOT, 'eval', `report-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
writeFileSync(reportPath, `${JSON.stringify({ base: BASE, gap: GAP, summaries, rows }, null, 2)}\n`)
console.log(`\n报告：${reportPath}`)
