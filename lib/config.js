/**
 * 部署配置：默认值、归一化与校验。
 *
 * 本模块**不 import 任何宿主包**（包括 @deepseek-ai/schemastery），因为本插件
 * 以 `link:` 形式安装，真实路径在 D:/Documents/... 下，Node 解析不到 profile 的
 * node_modules。代价是没有"设置页自动渲染"；收益是装载面为零依赖，宿主升级不会
 * 让配置层失效。M1 由 patch 条目 config 提供，M3 再补设置页（届时用惰性
 * require 探测 schemastery，探测不到就降级为只读 patch 配置）。
 * @module dsh-prompt-forge/config
 */

/** 配置命名空间 / 日志与埋点前缀。 */
export const NAMESPACE = 'prompt-forge'

/** 改写模式。`auto` 由模型按草稿信息密度判定。 */
export const MODES = /** @type {const} */ (['auto', 'expand', 'tighten'])

/** 任务类型。`other` 是模型无法归入前六类时的落点。 */
export const PROFILES = /** @type {const} */ (['code', 'writing', 'analysis', 'research', 'ops', 'media', 'other'])

/** 候选策略：单候选时用配置 mode；三候选时固定这三路。 */
export const CANDIDATE_PLANS = /** @type {const} */ ([
  { mode: 'expand', variant: 'base' },
  { mode: 'tighten', variant: 'base' },
  { mode: 'expand', variant: 'reorder' },
])

/**
 * 全部默认值。这是唯一权威来源：`apply` 收到 patch 条目 config 后与之合并，
 * 未填项一律落到这里，保证"零配置可用"。
 */
export const DEFAULT_CONFIG = {
  /** 总开关；关掉后隐藏按钮、快捷键与路由一并拒绝。 */
  enabled: true,
  /** 改写模式。`auto` 由长度 + 冗余信号判定（见 pickAutoMode）。 */
  mode: 'auto',
  /**
   * `auto` 判为收紧所需的最小草稿长度（码点）。
   *
   * 决策 4 要求 `tighten` 先测后开。2026-11-02 实测：长草稿比例中位数 0.88、
   * 短草稿绝对区间合规、13 条约束人工核定全部保留，因此放开。但仍不无脑开：
   * 真正的判据是冗余信号（口语填充词），长度只是下限兜底：太短的草稿压缩收益为零，
   * 而策略对 <40 字本来就改用 200–450 字绝对区间。80 是"能装下两三条约束"的量级。
   * 设为 0 等于关闭自动收紧。
   */
  autoTightenMinChars: 80,
  /**
   * 落盘档位。
   *
   * `inplace`（默认，决策 1）：点击后直接改写草稿，8 秒内可撤销。
   * `preview`：先弹一张轻浮层展示原文与改写结果的对比，Enter 采纳 / Esc 放弃，
   * 草稿在接受前一个字节都不动。给"不放心让它直接改"的场景留一条退路。
   */
  applyMode: 'inplace',
  /** 候选数：1 或 3。3 走 CANDIDATE_PLANS 三路并发。 */
  candidates: 1,
  /** 显式模型覆盖，必须与 model 成对；留空跟随会话模型。 */
  provider: '',
  model: '',
  /** 采样温度；低温更忠实原意。 */
  temperature: 0.3,
  /** 单次调用的输出 token 上限。 */
  maxOutputTokens: 4096,
  /** 输入码点上限；超限拒绝而不截断。 */
  maxInputChars: 12000,
  /** 单次调用端到端超时。 */
  timeoutMs: 60000,
  /** 自定义策略文本与内置策略的组合方式。 */
  strategyMode: 'extend-default',
  /** 自定义策略文本（空 = 只用内置策略）。 */
  strategyText: '',
  /** 触发快捷键，须含 ctrl/alt/meta 之一；留空禁用。 */
  shortcut: 'ctrl+alt+e',
  /** 宿主侧并发上限。 */
  maxConcurrent: 2,
  /** 滑动窗口限流（每分钟）。 */
  rateLimitPerMinute: 10,
  /** 结构埋点开关（只记尺寸与结果，不记正文）。 */
  telemetry: true,
  /** 上下文感知：用会话历史消解指代。 */
  contextAware: true,
  /** 上下文窗口条数。 */
  contextMaxMessages: 8,
  /** 上下文窗口字符预算。 */
  contextMaxChars: 4000,
}

/** 抛出一条带命名空间的配置错误。 */
function fail(message) {
  throw new Error(`${NAMESPACE}: ${message}`)
}

/** 非负整数且在区间内，否则抛错。 */
function intIn(value, name, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) {
    fail(`${name} 必须是 ${min}–${max} 之间的整数（当前 ${String(value)}）`)
  }
  return value
}

/** 有限数字且在区间内，否则抛错。 */
function numIn(value, name, min, max) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    fail(`${name} 必须是 ${min}–${max} 之间的有限数字（当前 ${String(value)}）`)
  }
  return value
}

/** 空白串视为"未设置"，避免 `'  '` 被当成有效的 provider 覆盖。 */
function trimmedOrEmpty(value) {
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * 合并默认值并校验一份配置。未知键被丢弃（旧版本残留不会渗进请求路径）。
 * @param {unknown} input - patch 条目 config，或 M3 的设置页 section。
 * @returns {typeof DEFAULT_CONFIG} 归一化后的配置。
 * @throws 描述第一条被违反的不变式。
 */
export function resolveConfig(input) {
  const raw = input !== null && typeof input === 'object' ? /** @type {Record<string, unknown>} */ (input) : {}
  const merged = { ...DEFAULT_CONFIG, ...raw }

  if (typeof merged.enabled !== 'boolean') fail('enabled 必须是布尔值')
  if (!MODES.includes(/** @type {any} */ (merged.mode))) fail(`mode 必须是 ${MODES.join(' / ')} 之一`)
  if (merged.candidates !== 1 && merged.candidates !== 3) fail('candidates 只能是 1 或 3')

  const provider = trimmedOrEmpty(merged.provider)
  const model = trimmedOrEmpty(merged.model)
  if ((provider === '') !== (model === '')) {
    fail('provider 与 model 必须成对填写（要么都填，要么都留空以跟随当前会话模型）')
  }

  const strategyMode = merged.strategyMode === 'replace-default' ? 'replace-default' : 'extend-default'
  const strategyText = typeof merged.strategyText === 'string' ? merged.strategyText : ''

  return {
    enabled: merged.enabled,
    mode: /** @type {typeof DEFAULT_CONFIG.mode} */ (merged.mode),
    // 只认两个字面量，其余一律回落到默认的 inplace——写错的档位不能让功能凭空消失。
    applyMode: merged.applyMode === 'preview' ? 'preview' : 'inplace',
    autoTightenMinChars: intIn(merged.autoTightenMinChars, 'autoTightenMinChars', 0, 100000),
    candidates: merged.candidates,
    provider,
    model,
    temperature: numIn(merged.temperature, 'temperature', 0, 1),
    maxOutputTokens: intIn(merged.maxOutputTokens, 'maxOutputTokens', 256, 32768),
    maxInputChars: intIn(merged.maxInputChars, 'maxInputChars', 200, 200000),
    timeoutMs: intIn(merged.timeoutMs, 'timeoutMs', 5000, 600000),
    strategyMode,
    strategyText,
    shortcut: typeof merged.shortcut === 'string' ? merged.shortcut : DEFAULT_CONFIG.shortcut,
    maxConcurrent: intIn(merged.maxConcurrent, 'maxConcurrent', 1, 16),
    rateLimitPerMinute: intIn(merged.rateLimitPerMinute, 'rateLimitPerMinute', 1, 600),
    telemetry: typeof merged.telemetry === 'boolean' ? merged.telemetry : DEFAULT_CONFIG.telemetry,
    contextAware: typeof merged.contextAware === 'boolean' ? merged.contextAware : DEFAULT_CONFIG.contextAware,
    contextMaxMessages: intIn(merged.contextMaxMessages, 'contextMaxMessages', 0, 50),
    contextMaxChars: intIn(merged.contextMaxChars, 'contextMaxChars', 0, 100000),
  }
}

/**
 * 可在运行期被覆盖的键白名单。
 *
 * 面板只允许改这些——`resolveConfig` 本来也会丢掉未知键，但白名单让"哪些字段
 * 属于运行期可调"成为一条显式契约，而不是依赖 schema 的副作用。
 */
export const WRITABLE_KEYS = [
  'enabled',
  'mode',
  'applyMode',
  'autoTightenMinChars',
  'candidates',
  'provider',
  'model',
  'temperature',
  'maxOutputTokens',
  'maxInputChars',
  'timeoutMs',
  'shortcut',
  'strategyMode',
  'strategyText',
  'maxConcurrent',
  'rateLimitPerMinute',
  'telemetry',
  'contextAware',
  'contextMaxMessages',
  'contextMaxChars',
]

/**
 * 把运行期覆盖合并到部署期配置上并校验。
 *
 * 合并顺序：base（默认值 + patch）← overrides（store 文件）。未知键与非白名单键被丢弃。
 * @param {typeof DEFAULT_CONFIG} base - 部署期已归一化配置。
 * @param {Record<string, unknown>} overrides - 运行期覆盖。
 * @returns {typeof DEFAULT_CONFIG} 归一化后的有效配置。
 * @throws 覆盖值非法时抛出（调用方负责降级或回报用户）。
 */
export function mergeOverrides(base, overrides) {
  const picked = {}
  if (overrides !== null && typeof overrides === 'object') {
    for (const key of WRITABLE_KEYS) {
      if (Object.prototype.hasOwnProperty.call(overrides, key)) picked[key] = overrides[key]
    }
  }
  return resolveConfig({ ...base, ...picked })
}

/**
 * 规划本次请求要发的调用。
 *
 * 单候选 = 一次调用，模式取配置；三候选 = 三路并发，分别做扩张 / 收紧 /
 * 重排，让"不满意"有可选项而不是只能重试。
 * @param {typeof DEFAULT_CONFIG} config - 已归一化配置。
 * @returns {Array<{ mode: 'expand' | 'tighten', variant: 'base' | 'reorder' }>} 调用计划（长度 1 或 3）。
 */
export function planCalls(config, text = '') {
  if (config.candidates === 3) return CANDIDATE_PLANS.map((plan) => ({ ...plan }))
  return [{ mode: pickMode(config, text), variant: 'base' }]
}

/** 口语填充词：冗余信号。命中两个以上才认为"这段值得压"。 */
const FILLER_RE = /吧|然后呢|然后|就是|另外|哦对了|大概就是|那么|其实|就是说/g

/**
 * 判定本次改写方向。
 *
 * `auto` 的判据是**长度 + 冗余信号**，不是单纯长度：200 字的紧凑规格不该被压，
 * 而 150 字的口语草稿应该被压。两个条件都满足才收紧。
 * 这样即使判错，代价也只是"本来能压的没压"，而不是"本来不该压的被压坏"。
 * @param {typeof DEFAULT_CONFIG} config - 归一化配置。
 * @param {string} text - 已校验的草稿。
 * @returns {'expand' | 'tighten'} 方向。
 */
export function pickMode(config, text) {
  if (config.mode === 'tighten') return 'tighten'
  if (config.mode === 'expand') return 'expand'
  const minimum = Number.isInteger(config.autoTightenMinChars) ? config.autoTightenMinChars : 0
  if (minimum <= 0) return 'expand'
  let count = 0
  for (const _ of text) count += 1
  if (count < minimum) return 'expand'
  const fillers = (text.match(FILLER_RE) ?? []).length
  return fillers >= 2 ? 'tighten' : 'expand'
}
