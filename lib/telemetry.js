/**
 * 结构埋点：一行一条 JSONL，**只记尺寸、模式、结果与耗时，绝不记正文**。
 *
 * 设计约束（与现役插件的日志口径一致，那条口径是对的）：
 *  - 不记草稿、不记输出、不记 provider/model 名——它们可能夹带内网网关或项目标识；
 *  - 任何失败都吞掉，埋点不能影响增强；
 *  - 单文件超限即清空，避免长期运行把磁盘写满；
 *  - 可在配置里一键关闭（`telemetry: false`）。
 *
 * 这是 §7.5 线上指标（apply rate / undo rate / p95）的数据来源之一，
 * 但客户端侧的应用与撤销由 M2 的浏览器半单独上报。
 * @module dsh-prompt-forge/telemetry
 */

import { appendFileSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** 单文件上限：超过即清空。 */
const LIMIT_BYTES = 4 << 20

/** 埋点目录（可用 DSH_PROMPT_FORGE_LOG_DIR 覆盖，测试用）。 */
export function logDir() {
  return process.env.DSH_PROMPT_FORGE_LOG_DIR ?? join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'logs', 'dsh-prompt-forge')
}

/** 埋点文件。 */
export function logFile() {
  return join(logDir(), 'events.jsonl')
}

/** 是否在 node:test 里跑（测试不往真实日志写噪声）。 */
function underTest() {
  return process.execArgv.some((arg) => arg === '--test' || arg.startsWith('--test-')) || process.env.NODE_TEST_CONTEXT !== undefined
}

/**
 * 追加一条结构事件。
 * @param {{ telemetry: boolean } | undefined} config - 归一化配置（读 telemetry 开关）。
 * @param {Record<string, unknown>} event - 事件体（只允许结构字段）。
 */
export function logEvent(config, event) {
  if (config !== undefined && config.telemetry === false) return
  if (underTest()) return
  try {
    mkdirSync(logDir(), { recursive: true })
    const file = logFile()
    try {
      if (statSync(file).size > LIMIT_BYTES) writeFileSync(file, '')
    } catch {
      // 文件还不存在。
    }
    appendFileSync(file, `${JSON.stringify({ ts: new Date().toISOString(), ...event })}\n`)
  } catch {
    // 埋点永远不能影响宿主。
  }
}
