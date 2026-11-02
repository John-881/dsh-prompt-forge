/**
 * `/enhance` 斜杠命令：走与路由完全相同的宿主例程，结果在命令平面展示（可复制、
 * 不进对话历史）。
 *
 * 沿用旧插件同名命令，是为了迁移期肌肉记忆不断裂；新增的可选首词参数
 * （tighten / expand）用于在命令平面直接指定方向。
 * @module dsh-prompt-forge/command
 */

import { checkInputText, formatInputCheckZh } from './validate.js'
import { formatEnhanceError, toEnhanceError } from './llm.js'
import { runForge, sessionRouteOf } from './orchestrate.js'
import { planCalls } from './config.js'

/** 命令用法提示。 */
const USAGE = '用法：/enhance <文本>｜/enhance tighten <文本>（收紧）｜/enhance expand <文本>（补齐）。输入框草稿请用按钮或 ctrl+alt+e。'

/**
 * 解析命令输入：可选的首词方向 + 正文。
 * @param {string} raw - 命令原始输入（已 trim）。
 * @returns {{ mode: 'auto' | 'expand' | 'tighten', text: string }} 解析结果。
 */
export function parseCommandInput(raw) {
  const match = /^(tighten|expand)\s+([\s\S]+)$/i.exec(raw)
  if (match !== null) return { mode: /** @type {any} */ (match[1].toLowerCase()), text: match[2].trim() }
  return { mode: 'auto', text: raw.trim() }
}

/**
 * 把多个候选渲染成命令平面文本。
 * @param {Array<{ text: string, mode: string, profile: string }>} candidates - 候选。
 * @returns {string} 展示文本。
 */
function renderCandidates(candidates) {
  if (candidates.length === 1) return candidates[0].text
  return candidates
    .map((candidate, index) => `—— 候选 ${index + 1}（${candidate.mode} · ${candidate.profile}）——\n${candidate.text}`)
    .join('\n\n')
}

/**
 * 在（可选）commands 服务上注册 `/enhance`。服务缺失时静默跳过，保证无 UI 组合也能装载。
 * @param {any} ctx - 注册上下文。
 * @param {() => import('./config.js').DEFAULT_CONFIG} readConfig - 逐次配置读取。
 */
export function registerCommand(ctx, readConfig) {
  let commands
  try {
    commands = ctx.get('commands')
  } catch {
    return
  }
  if (commands === undefined || commands === null || typeof commands.register !== 'function') return

  const definition = {
    name: 'enhance',
    description: '提示词增强：/enhance <文本> —— 重写为可直接执行的提示词，结果在此展示可复制，不进入对话历史',
    input: { hint: '要增强的文本；可选前缀 tighten / expand 指定方向' },
    recordInput: false,
    async handler(invocation) {
      const raw = String(invocation.rawInput ?? '').trim()
      if (raw === '') return { kind: 'error', text: USAGE }
      // 配置读取放在 try 内：resolveConfig 会对 schema 表达不了的不变式抛错，
      // 抛在外面会让用户拿到裸异常而不是可读文案。
      try {
        const config = readConfig()
        if (!config.enabled) return { kind: 'error', text: '提示词增强已在插件设置中关闭。' }
        const parsed = parseCommandInput(raw)
        const check = checkInputText(parsed.text, config.maxInputChars)
        if (!check.ok) return { kind: 'error', text: formatInputCheckZh(check) }
        const effective = { ...config, mode: parsed.mode }
        const sessionId = invocation?.agent?.session?.id
        const outcome = await runForge(ctx, effective, {
          text: parsed.text,
          sessionRoute: sessionRouteOf(ctx, sessionId),
          signal: invocation?.signal,
          sessionId,
          plan: planCalls(effective, parsed.text),
        })
        return { kind: 'success', text: renderCandidates(outcome.candidates) }
      } catch (error) {
        return { kind: 'error', text: formatEnhanceError(toEnhanceError(error)) }
      }
    },
  }

  ctx.effect(() => {
    const dispose = commands.register(definition)
    return () => {
      try {
        if (typeof dispose === 'function') dispose()
      } catch {
        // 命令注册表已随服务重建。
      }
    }
  }, 'prompt-forge: /enhance command')
}
