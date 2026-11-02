#!/usr/bin/env node
/**
 * dsh-prompt-forge 开关：把「安装 + 与旧增强插件互斥」做成一个幂等动作。
 *
 * 为什么需要脚本而不是两条命令：
 *  `dsh plugin --profile <p> add link:...` 会**同时**把包追加进
 *  `dsh.profile.bundles`（实测），也就是安装即启用。若只跑安装、忘了停用旧插件，
 *  下一次重启就会两个按钮、两个 ctrl+alt+e、两套路由同时存在。手工两步容易漏，
 *  所以这里把两步绑成一个事务，并给出精确回滚。
 *
 * 用法：
 *   node tools/switch.mjs --status
 *   node tools/switch.mjs --enable [--dry-run] [--keep-old]
 *   node tools/switch.mjs --revert [--dry-run]
 *
 * 环境变量：
 *   DSH_HOME     默认 ~/.dsh
 *   DSH_PROFILE  默认 desktop
 *   DSH_CLI      默认自动探测（LOCALAPPDATA / ProgramFiles 下的 dsh.cmd，最后回落 PATH 的 dsh）
 *
 * 约束：
 *  - 只改 profile 的 `cordis.patch.yml`（顶层 YAML 数组，末尾追加/按标记删除），
 *    不碰 `cordis.yml`，也不手改 `node_modules`。
 *  - 改 patch 前先备份为 `cordis.patch.yml.bak-forge-<时间戳>`。
 *  - 不重启宿主：graph 行变化必须重启才生效，脚本只打印提示。
 */

import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

const SELF_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PKG = JSON.parse(readFileSync(join(SELF_DIR, 'package.json'), 'utf8'))
const NAME = PKG.name
const OLD_NAME = process.env.DSH_OLD_PLUGIN ?? 'dsh-prompt-enhance'

const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const PROFILE = process.env.DSH_PROFILE ?? 'desktop'
const PROFILE_DIR = join(DSH_HOME, 'profiles', PROFILE)
const PATCH_FILE = join(PROFILE_DIR, 'cordis.patch.yml')
const PACKAGE_FILE = join(PROFILE_DIR, 'package.json')

/** 本目录的 link: 规格。用脚本自身位置推导，克隆到哪都能用。 */
const LINK_SPEC = `link:${SELF_DIR.replace(/\\/g, '/')}`

const args = new Set(process.argv.slice(2))
const DRY = args.has('--dry-run')
const KEEP_OLD = args.has('--keep-old')

/** 停用旧条目的 patch 块（按标记判定，避免重复追加）。 */
const DISABLE_OLD_MARKER = `# [prompt-forge] 互斥：停用 ${OLD_NAME}`
const DISABLE_OLD_BLOCK = `${DISABLE_OLD_MARKER}
- id: prompt-enhance
  disabled: true
`

/**
 * 定位 dsh 可执行文件。
 *
 * 不写死安装路径：桌面版可能装在 `%LOCALAPPDATA%\Programs\...`、也可能在自定义盘符下，
 * 写死换台机器就失效。env 优先，其次常见位置，最后回落 PATH。
 */
function resolveCli() {
  if (process.env.DSH_CLI !== undefined && process.env.DSH_CLI !== '') return process.env.DSH_CLI
  if (process.platform === 'win32') {
    const candidates = []
    for (const base of [process.env.LOCALAPPDATA, process.env.ProgramFiles, process.env.ProgramW6432]) {
      if (base === undefined || base === '') continue
      candidates.push(join(base, 'Programs', 'DeepSeek Harness', 'resources', 'runtime', 'cli', 'bin', 'dsh.cmd'))
      candidates.push(join(base, 'DeepSeek Harness', 'resources', 'runtime', 'cli', 'bin', 'dsh.cmd'))
    }
    for (const candidate of candidates) if (existsSync(candidate)) return candidate
    return 'dsh.cmd'
  }
  return 'dsh'
}

const CLI = resolveCli()

/** 读 profile 的 package.json。 */
function readPkg() {
  return JSON.parse(readFileSync(PACKAGE_FILE, 'utf8'))
}

/** 当前状态快照。 */
function status() {
  const pkg = readPkg()
  const bundles = pkg?.dsh?.profile?.bundles ?? []
  const patch = existsSync(PATCH_FILE) ? readFileSync(PATCH_FILE, 'utf8') : ''
  const spec = pkg?.dependencies?.[NAME]
  return {
    spec,
    // 依赖装了不等于装的是这一份：仓库搬过位置时旧链接还在，pnpm 不会自己发现。
    linkedHere: spec === LINK_SPEC,
    dependency: Boolean(spec),
    bundled: bundles.includes(NAME),
    oldDisabled: patch.includes(DISABLE_OLD_MARKER),
    oldPresent: bundles.includes(OLD_NAME),
    // 旧插件可能被 pnpm 剪枝或应用自己清掉：这时停用块就悬空了，每次启动都会告警。
    oldDangling: patch.includes(DISABLE_OLD_MARKER) && !bundles.includes(OLD_NAME),
  }
}

/** 打印状态并用一句话说清"现在是哪个插件在接管"。 */
function printStatus() {
  const s = status()
  const rows = [
    ['依赖已安装', s.dependency],
    ['依赖指向本仓库', s.linkedHere],
    ['已登记进 bundles（=已启用）', s.bundled],
    ['旧插件仍在 profile（需互斥）', s.oldPresent],
    ['停用块存在', s.oldDisabled],
  ]
  for (const [label, value] of rows) console.log(`${value ? '✔' : '✘'} ${label}`)
  if (!s.linkedHere) console.log(`  当前 spec：${s.spec ?? '(未安装)'}`)

  let verdict
  if (s.bundled && !s.linkedHere) verdict = '⚠ 指向的是别处的副本：先 --enable 重新链接，否则改这份代码不会生效'
  else if (s.oldDangling) verdict = '⚠ patch 里有悬空的停用块（旧插件已不在 profile）：每次启动都会告警，跑 --enable 自动清理'
  else if (s.bundled && s.oldDisabled) verdict = `生效：${NAME} 接管，${OLD_NAME} 停用（需已重启）`
  else if (s.bundled && !s.oldDisabled && s.oldPresent) verdict = '冲突：两个插件都启用，必须停用其一'
  else if (s.bundled) verdict = `生效：${NAME} 接管`
  else if (s.oldPresent) verdict = `现状：${OLD_NAME} 仍在接管`
  else verdict = '两者都不在，无增强功能'
  console.log(`\n判定：${verdict}`)
  return s
}

/**
 * 调 CLI 安装/卸载依赖（pnpm 会同步维护 bundles 列表）。
 *
 * 必须走 `spawnSync(整条命令行, { shell: true })` 而不是
 * `spawnSync(CLI, args, { shell: true })`：后者在 Windows 上会把含空格的
 * 可执行路径原样拼进命令行、不加引号，cmd.exe 于是在第一个空格处断义，
 * 报 `'X:/path with space' 不是内部或外部命令`。自己拼好带引号的命令行才对。
 */
function runCli(verb) {
  const line = `"${CLI}" plugin --profile ${PROFILE} ${verb} "${LINK_SPEC}"`
  if (DRY) {
    console.log(`[dry-run] ${line}`)
    return true
  }
  console.log(`$ ${line}`)
  const result = spawnSync(line, { stdio: 'inherit', shell: true })
  if (result.error !== undefined) console.error(`CLI 启动失败：${result.error.message}`)
  if (result.status !== 0) console.error(`CLI 失败（exit ${String(result.status)}）`)
  return result.status === 0
}

/** 把停用块追加进 patch（幂等）。 */
function writeDisableBlock() {
  const patch = readFileSync(PATCH_FILE, 'utf8')
  if (patch.includes(DISABLE_OLD_MARKER)) {
    console.log('· 停用块已存在，跳过')
    return
  }
  if (DRY) {
    console.log('[dry-run] 将追加：\n' + DISABLE_OLD_BLOCK)
    return
  }
  const backup = `${PATCH_FILE}.bak-forge-${Date.now()}`
  copyFileSync(PATCH_FILE, backup)
  console.log(`· 已备份 patch → ${backup}`)
  const separator = patch.endsWith('\n') ? '' : '\n'
  writeFileSync(PATCH_FILE, `${patch}${separator}\n${DISABLE_OLD_BLOCK}`)
  console.log('· 已追加停用块')
}

/** 从 patch 里删掉停用块（幂等），连带备份。 */
function removeDisableBlock() {
  const patch = readFileSync(PATCH_FILE, 'utf8')
  if (!patch.includes(DISABLE_OLD_MARKER)) {
    console.log('· 停用块不存在，跳过')
    return
  }
  if (DRY) {
    console.log('[dry-run] 将移除停用块')
    return
  }
  const backup = `${PATCH_FILE}.bak-forge-${Date.now()}`
  copyFileSync(PATCH_FILE, backup)
  console.log(`· 已备份 patch → ${backup}`)
  const next = patch.replace(`${DISABLE_OLD_MARKER}\n- id: prompt-enhance\n  disabled: true\n`, '')
  writeFileSync(PATCH_FILE, next)
  console.log('· 已移除停用块')
}

function main() {
  if (!existsSync(PACKAGE_FILE) || !existsSync(PATCH_FILE)) {
    console.error(`找不到 profile：${PROFILE_DIR}`)
    console.error('用 DSH_PROFILE / DSH_HOME 指定目标 profile。')
    process.exit(1)
  }

  if (args.has('--status') || args.size === 0) {
    console.log(`插件：${LINK_SPEC}`)
    console.log(`CLI：${CLI}\n`)
    printStatus()
    return
  }

  if (args.has('--enable')) {
    const before = status()
    const conflict = before.oldPresent && !before.oldDisabled && !KEEP_OLD
    if (before.bundled && before.linkedHere && !conflict && !before.oldDangling) {
      console.log('已经是启用状态，无需操作。')
      printStatus()
      return
    }
    if (!before.linkedHere) {
      if (!runCli('add')) {
        console.error('重新链接失败，未改动 patch。')
        process.exit(1)
      }
    }
    if (KEEP_OLD) console.log('· --keep-old：保留旧插件启用状态（两个插件会同时接管）')
    else if (before.oldPresent) writeDisableBlock()
    else if (before.oldDangling) {
      console.log(`· 未安装 ${OLD_NAME}，清理上次遗留的悬空停用块`)
      removeDisableBlock()
    } else console.log(`· 未安装 ${OLD_NAME}，无需互斥`)
    console.log('\n✓ 已完成。**必须重启宿主**（graph 行变化不热更新）。')
    console.log('  重启后核对：')
    console.log('   1) ~/.dsh/logs/dsh-prompt-forge/events.jsonl 应出现 {"event":"apply"}')
    console.log('   2) 输入框右侧出现 ✨，悬停显示快捷键')
    printStatus()
    return
  }

  if (args.has('--revert')) {
    removeDisableBlock()
    const s = status()
    if (s.dependency) runCli('remove')
    console.log(
      s.oldPresent
        ? `\n✓ 已回滚，${OLD_NAME} 恢复接管。重启宿主生效。`
        : `\n✓ 已卸载 ${NAME}。profile 里没有其他增强插件，增强功能会消失。重启宿主生效。`,
    )
    printStatus()
    return
  }

  console.error('用法：--status | --enable [--dry-run] [--keep-old] | --revert [--dry-run]')
  process.exit(1)
}

main()
