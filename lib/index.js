/**
 * dsh-prompt-forge —— 输入框提示词增强（宿主半）。
 *
 * 能力目标：对齐 WorkBuddy「增强提示词」的体验——一次点击、就地生效、零配置，
 * 同时补上现役 dsh-prompt-enhance 的三处硬缺口（含引用 chip 直接拒绝、回填拍平
 * chip、只有扩张方向）。
 *
 * 本文件只做装配，不写业务：
 *  - 配置：patch 条目 config → resolveConfig（无 schemastery 依赖）
 *  - 路由：POST /prompt-forge/enhance(+/stream)，webServer 缺失时自动缺席
 *  - 命令：/enhance，commands 服务缺失时静默跳过
 *
 * 硬依赖只有 `llm`：其余服务（webServer / sessions / commands / settings /
 * agentDefaultModel）全部按需读取、缺失即降级。把可选服务写进 inject 会让本条目
 * 在缺该服务的组合里长期 pending，而 DSH 把 pending 条目当启动失败处理——
 * 那会拖着整个 GUI 一起起不来。
 *
 * 零宿主包 import：本插件以 link: 安装，真实路径在 D:/Documents/... 下，
 * Node 解析不到 profile 的 node_modules（详见 config.js 顶部注释）。
 * @module dsh-prompt-forge
 */

import { DEFAULT_CONFIG, NAMESPACE, WRITABLE_KEYS, mergeOverrides, resolveConfig } from './config.js'
import { readOverrides, storeFile, writeOverrides } from './store.js'
import { registerRoute } from './routes.js'
import { registerCommand } from './command.js'
import { logEvent } from './telemetry.js'

export const name = NAMESPACE

/** 唯一硬依赖。 */
export const inject = ['llm']

export { DEFAULT_CONFIG, WRITABLE_KEYS, mergeOverrides, resolveConfig, planCalls } from './config.js'
export { readOverrides, writeOverrides, patchOverrides, storeFile, hasOverrides } from './store.js'
export { PROTOCOL, ROW_ID, ERROR_CODES } from './protocol.js'
export { buildSystemPrompt, frameUserPrompt } from './prompts.js'
export { enhanceText, formatEnhanceError, toEnhanceError, EnhanceFailure } from './llm.js'
export { resolveRoute, sessionRouteOf, defaultRouteOf, conversationContextOf, runForge } from './orchestrate.js'
export { checkInputText, countText, normalizeOutput, parseEnvelope } from './validate.js'
export { selectTurns, buildConversationContext, formatContextBlock } from './context.js'
export { parseCommandInput } from './command.js'

/**
 * 装载宿主半。
 *
 * 配置非法时**不抛**：抛会让整条 entry 不激活（GUI 里表现为"插件装了但按钮没有"），
 * 而配置错误是部署期问题，用默认值继续跑 + 一条告警日志，比整条消失更容易排查。
 * 请求路径仍会走 `resolveConfig`，所以真正的非法值不会被静默接受。
 * @param {any} ctx - 注册上下文。
 * @param {unknown} [rawConfig] - patch 条目 config（loader 未填 schema 默认值）。
 */
export function apply(ctx, rawConfig) {
  let baseConfig
  try {
    baseConfig = resolveConfig(rawConfig ?? DEFAULT_CONFIG)
  } catch (error) {
    baseConfig = { ...DEFAULT_CONFIG }
    try {
      console.warn(`[${NAMESPACE}] 配置无效，已回退默认值：${error instanceof Error ? error.message : String(error)}`)
    } catch {
      // 代理 console 抛错不能影响装载。
    }
    logEvent(baseConfig, { event: 'config-invalid', message: error instanceof Error ? error.message : String(error) })
  }

  // 三层配置：默认值 ← patch 条目 ← 运行期 store 覆盖。每次请求都重新合成，
  // store 按 mtime 缓存解析结果，所以改配置立即生效且不额外读盘。
  let overrideWarned = false
  const readConfig = () => {
    try {
      return mergeOverrides(baseConfig, readOverrides())
    } catch (error) {
      // 坏的覆盖层不能拖垮每个请求：退回部署期配置，只告警一次。
      if (!overrideWarned) {
        overrideWarned = true
        try {
          console.warn(`[${NAMESPACE}] 运行期配置无效，已忽略：${error instanceof Error ? error.message : String(error)}`)
        } catch {
          // console 不可用。
        }
        logEvent(baseConfig, { event: 'override-invalid', message: error instanceof Error ? error.message : String(error) })
      }
      return baseConfig
    }
  }

  const configApi = {
    read: () => ({
      effective: readConfig(),
      overrides: readOverrides(),
      storeFile: storeFile(),
      writable: WRITABLE_KEYS,
    }),
    /** 先验证再落盘：非法值绝不写进文件，否则之后每个请求都会读到坏配置。 */
    write: (patch) => {
      const next = { ...readOverrides() }
      for (const [key, value] of Object.entries(patch)) {
        if (value === undefined || value === null) delete next[key]
        else next[key] = value
      }
      mergeOverrides(baseConfig, next)
      writeOverrides(next)
      return readConfig()
    },
  }

  logEvent(readConfig(), {
    event: 'apply',
    candidates: readConfig().candidates,
    mode: readConfig().mode,
    ctx: readConfig().contextAware ? 1 : 0,
  })

  registerRoute(ctx, readConfig, configApi)
  registerCommand(ctx, readConfig)

  // 自检句柄：验证"插件到底有没有被装配"的唯一可靠手段是宿主侧可观测事实，
  // 而不是猜。注意它在**宿主进程**里，浏览器控制台读不到——运行时核验请看
  // ~/.dsh/logs/dsh-prompt-forge/events.jsonl。
  try {
    globalThis.__dshPromptForge = {
      version: '0.1.0',
      describe: () => configApi.read(),
      protocol: { prefix: '/prompt-forge', endpoint: '/prompt-forge/enhance', stream: '/prompt-forge/enhance/stream' },
    }
    ctx.effect(() => () => {
      try {
        if (globalThis.__dshPromptForge !== undefined) delete globalThis.__dshPromptForge
      } catch {
        // 已删除。
      }
    }, 'prompt-forge: self-check handle')
  } catch {
    // 自检句柄是可选装饰，失败不影响主功能。
  }
}
