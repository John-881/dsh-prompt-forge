/**
 * 运行期配置覆盖层。
 *
 * 在此之前，改一个 `candidates` 都要编辑 patch 并重启宿主——因为 `readConfig` 是
 * apply 时闭包进来的常量。M3 把它变成三层：
 *
 *   DEFAULT_CONFIG（代码）  ←  patch 条目 config（部署期）  ←  store 覆盖（运行期）
 *
 * store 落在 `~/.dsh/storages/prompt-forge/config.json`，按 mtime 缓存解析结果，
 * 所以每次请求都能拿到最新值而不用反复读盘。写入走「临时文件 + rename」的原子替换，
 * 避免 settings 面板连点两下就写坏文件。
 *
 * 为什么不用宿主的 SettingsForms + schemastery：本插件是 `link:` 安装，真实路径在
 * D:/Documents 下，Node 解析不到 profile 的 node_modules，`import '@deepseek-ai/schemastery'`
 * 会失败。自建 store + 自建面板是不引入脆弱依赖的唯一稳定解。
 * @module dsh-prompt-forge/store
 */

import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** DSH 主目录。 */
function dshHome() {
  return process.env.DSH_HOME ?? join(homedir(), '.dsh')
}

/** 覆盖文件路径（可用 DSH_PROMPT_FORGE_STORE 覆盖，测试用）。 */
export function storeFile() {
  return process.env.DSH_PROMPT_FORGE_STORE ?? join(dshHome(), 'storages', 'prompt-forge', 'config.json')
}

/** mtime 缓存：路径 + 签名 → 解析结果。 */
let cache = { signature: '', value: {} }

/** 文件签名（不存在时为空串）。 */
function signatureOf(file) {
  try {
    const stat = statSync(file)
    return `${stat.mtimeMs}:${stat.size}`
  } catch {
    return ''
  }
}

/**
 * 读运行期覆盖层。任何异常（文件损坏、权限）都退化为空覆盖——
 * 配置读取不能成为请求失败的原因。
 * @returns {Record<string, unknown>} 覆盖对象（可能为空）。
 */
export function readOverrides() {
  const file = storeFile()
  const signature = signatureOf(file)
  if (signature === cache.signature) return cache.value
  if (signature === '') {
    cache = { signature, value: {} }
    return cache.value
  }
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    const value = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
    cache = { signature, value }
    return value
  } catch {
    cache = { signature, value: {} }
    return cache.value
  }
}

/**
 * 原子写入覆盖层。先写 `.tmp` 再 rename，读者永远看不到半截文件。
 * @param {Record<string, unknown>} overrides - 完整覆盖对象（不是增量）。
 * @throws 目录不可写时抛出，让调用方把失败回报给用户。
 */
export function writeOverrides(overrides) {
  const file = storeFile()
  const dir = dirname(file)
  mkdirSync(dir, { recursive: true })
  const tmp = `${file}.tmp-${process.pid}`
  writeFileSync(tmp, `${JSON.stringify(overrides, null, 2)}\n`)
  renameSync(tmp, file)
  // 主动失效缓存：同一毫秒内的写-读可能拿到相同 mtime，不能靠签名判活。
  cache = { signature: '', value: {} }
}

/**
 * 增量更新覆盖层：在现有覆盖上合并，删掉值为 `undefined` 的键。
 * @param {Record<string, unknown>} patch - 增量。
 * @returns {Record<string, unknown>} 合并后的完整覆盖。
 */
export function patchOverrides(patch) {
  const current = { ...readOverrides() }
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete current[key]
    else current[key] = value
  }
  writeOverrides(current)
  return current
}

/**
 * 是否存在运行期覆盖文件（面板用来提示"当前有覆盖生效"）。
 * @returns {boolean}
 */
export function hasOverrides() {
  return existsSync(storeFile())
}
