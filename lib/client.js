/**
 * dsh-prompt-forge —— 客户端半（浏览器）。
 *
 * 交互取舍（决策 1「前者」）：**就地改写，无确认弹窗**。点击 → 行内进度 → 直接改草稿
 * → 8 秒撤销条。去掉确认步骤的前提是撤销足够快、足够明显，所以撤销条同时给
 * Ctrl+Z 提示与一键按钮，8 秒后自动消失。
 *
 * 宿主契约（均按本机现有插件实读，非推测）：
 *  - 以 `window.__ModuleLoader__.load({ id, factory })` 加载，`id` 必须等于 loader
 *    entry 名（`dsh-prompt-forge`），否则报 "loaded without registering ..."。
 *  - 槽位组件 props 提供 `inputActions`（`setDraft` / `submit`）与 `useInput(selector)`。
 *    宿主输入栏本体就是 `useInput((s) => s)`，没有 `props.input`——读它只会静默拿到
 *    undefined。草稿、phase、引用 chip、附件都必须从 `useInput` 派生。
 *  - `ctx.inject(['slots'], ...)` 惰性注入：把 slots 写进 `inject` 会让缺该服务的
 *    profile 长期 pending，而 DSH 把 pending 当启动失败处理。
 *  - 组件必须是**模块级稳定引用**：在 register 回调里现造函数组件会让 React 每次
 *    重渲染都当成新类型，按钮被反复卸载重建。
 *
 * 引用 chip（C6）在 M2 阶段**明确拒绝**而不是静默拍平：`setDraft(string)` 会重建整个
 * 文档、把 `@` 引用降级为纯文本，而那正是现役插件被诟病的缺陷之一。拒绝 + 说明比
 * 悄悄破坏结构诚实。
 */
window.__ModuleLoader__.load({
  id: 'dsh-prompt-forge',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')

    const PLUGIN = 'dsh-prompt-forge'
    const STATE_URL = '/prompt-forge/state'
    const STREAM_URL = '/prompt-forge/enhance/stream'
    const UNDO_MS = 8000

    /* ────────────────────────── 纯函数（可测） ────────────────────────── */

    /** 按 Unicode 码点计数，与宿主 `countText` 同一口径。 */
    function countText(text) {
      let n = 0
      for (const _ of text) n++
      return n
    }

    /** 数组字段长度；字段缺失或类型不对时算 0（宿主不同代字段名不同）。 */
    function countOf(value) {
      return Array.isArray(value) ? value.length : 0
    }

    /**
     * 解析快捷键字符串，如 `ctrl+alt+e`。
     * 必须含 ctrl/alt/meta 之一；shift 只能作附加修饰（纯 shift+字母会抢走正常输入）。
     * @returns {null | { ctrl: boolean, alt: boolean, shift: boolean, meta: boolean, key: string }}
     */
    function parseShortcut(text) {
      if (typeof text !== 'string') return null
      const parts = text.toLowerCase().split('+').map((part) => part.trim()).filter((part) => part !== '')
      if (parts.length < 2) return null
      const combo = { ctrl: false, alt: false, shift: false, meta: false, key: '' }
      for (const part of parts) {
        if (part === 'ctrl' || part === 'control') combo.ctrl = true
        else if (part === 'alt' || part === 'option') combo.alt = true
        else if (part === 'shift') combo.shift = true
        else if (part === 'meta' || part === 'cmd' || part === 'win') combo.meta = true
        else combo.key = part
      }
      if (combo.key === '') return null
      if (!combo.ctrl && !combo.alt && !combo.meta) return null
      return combo
    }

    /** 键盘事件是否精确匹配组合键（多按一个修饰键也算不匹配）。 */
    function matchesShortcut(event, combo) {
      if (combo === null || event === null) return false
      if (event.ctrlKey !== combo.ctrl) return false
      if (event.altKey !== combo.alt) return false
      if (event.shiftKey !== combo.shift) return false
      if (event.metaKey !== combo.meta) return false
      const key = typeof event.key === 'string' ? event.key.toLowerCase() : ''
      return key === combo.key
    }

    /** 字数变化标签：`+858 字` / `-20 字` / `字数不变`。 */
    function formatDelta(before, after) {
      const delta = countText(after) - countText(before)
      if (delta === 0) return '字数不变'
      return `${delta > 0 ? '+' : ''}${delta} 字`
    }

    /**
     * 输入校验，与宿主 `checkInputText` 同口径（码点、零宽不算内容）。
     * @returns {{ ok: true } | { ok: false, message: string }}
     */
    function checkDraft(text, maxChars) {
      const visible = text.replace(/[\u200b-\u200d\ufeff\u202a-\u202e\u2066-\u2069]/g, '').trim()
      if (visible === '') return { ok: false, message: '先写点什么再增强。' }
      const count = countText(text)
      const cap = Number.isInteger(maxChars) && maxChars > 0 ? maxChars : 12000
      if (count > cap) return { ok: false, message: `共 ${count} 字，超过 ${cap} 字上限；不会自动截断，请精简后重试。` }
      return { ok: true }
    }

    /** 把任意错误收敛为可展示文案。 */
    function messageOf(error) {
      if (error && error.detail && typeof error.detail.message === 'string' && error.detail.message !== '') return error.detail.message
      if (error && typeof error.message === 'string' && error.message !== '') return error.message
      return '增强失败，原文未改动。'
    }

    /* ────────────────────────── 样式 ────────────────────────── */

    const CSS = [
      '.pf-btn{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;padding:0;border:none;border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary);font-size:15px;line-height:1;cursor:pointer;transition:background .12s ease,color .12s ease}',
      '.pf-btn:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-brand-primary)}',
      '.pf-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}',
      '.pf-btn[aria-disabled="true"]{opacity:.45;cursor:not-allowed}',
      '.pf-btn.pf-busy{color:var(--dsw-alias-brand-primary);animation:pf-pulse 1.1s ease-in-out infinite}',
      '@keyframes pf-pulse{0%,100%{opacity:.45}50%{opacity:1}}',
      '.pf-bar{display:flex;align-items:center;gap:8px;margin:4px auto 0;padding:4px 8px;max-width:fit-content;border:1px solid var(--dsw-alias-border-l1);border-radius:999px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.4;box-shadow:0 2px 8px rgba(0,0,0,.08)}',
      '.pf-bar.pf-error{border-color:var(--dsw-alias-border-error,var(--dsw-alias-border-l1));color:var(--dsw-alias-label-primary)}',
      '.pf-bar .pf-title{color:var(--dsw-alias-label-primary);font-weight:600}',
      '.pf-bar .pf-meta{opacity:.8}',
      '.pf-bar button{border:none;background:transparent;color:inherit;font:inherit;cursor:pointer;padding:2px 6px;border-radius:6px;line-height:1.2}',
      '.pf-bar button:hover{background:var(--dsw-alias-bg-layer-2)}',
      '.pf-bar button.pf-primary{color:var(--dsw-alias-brand-primary);font-weight:600}',
      '.pf-bar .pf-sep{opacity:.35}',
      '.pf-bar .pf-err-text{max-width:52ch;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.pf-panel{display:flex;flex-direction:column;gap:10px;padding:4px 0;font-size:13px;color:var(--dsw-alias-label-primary)}',
      '.pf-panel-title{font-size:13px;font-weight:600}',
      '.pf-panel-hint,.pf-panel-note{font-size:12px;color:var(--dsw-alias-label-secondary)}',
      '.pf-panel-path{font-size:11px;color:var(--dsw-alias-label-secondary);opacity:.72;word-break:break-all}',
      '.pf-panel-error{font-size:12px}',
      '.pf-row{display:flex;align-items:center;gap:10px;justify-content:space-between}',
      '.pf-row-label{flex:none;min-width:132px;color:var(--dsw-alias-label-secondary)}',
      '.pf-row input[type=text],.pf-row input[type=number],.pf-row select{flex:1;max-width:280px;padding:5px 8px;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;background:var(--dsw-alias-bg-layer-1);color:inherit;font:inherit}',
      '.pf-row input[type=checkbox]{width:16px;height:16px;flex:none;margin-left:auto}',
      '.pf-panel-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
      '.pf-panel-btn{padding:5px 12px;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;background:var(--dsw-alias-bg-layer-1);color:inherit;font:inherit;cursor:pointer}',
      '.pf-panel-btn:hover{background:var(--dsw-alias-bg-layer-2)}',
      '.pf-panel-btn.primary{color:var(--dsw-alias-brand-primary);font-weight:600}',
      '.pf-preview{position:fixed;left:50%;bottom:96px;transform:translateX(-50%);z-index:60;width:min(680px,calc(100vw - 32px));max-height:56vh;display:flex;flex-direction:column;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1);box-shadow:0 12px 32px rgba(0,0,0,.22);overflow:hidden;font-size:13px;color:var(--dsw-alias-label-primary)}',
      '.pf-preview-head{display:flex;align-items:center;gap:8px;padding:8px 12px;border-bottom:1px solid var(--dsw-alias-border-l1);font-weight:600}',
      '.pf-preview-cands{display:inline-flex;align-items:center;gap:2px;margin-left:auto}',
      '.pf-preview-body{display:grid;grid-template-columns:1fr 1fr;gap:1px;background:var(--dsw-alias-border-l1);min-height:0;flex:1;overflow:hidden}',
      '.pf-preview-col{display:flex;flex-direction:column;min-height:0;background:var(--dsw-alias-bg-layer-1)}',
      '.pf-preview-title{padding:6px 12px 4px;font-size:11px;color:var(--dsw-alias-label-secondary)}',
      '.pf-preview-text{margin:0;padding:0 12px 10px;overflow:auto;white-space:pre-wrap;word-break:break-word;font:inherit;line-height:1.55;min-height:0}',
      '.pf-preview-text.is-original{color:var(--dsw-alias-label-secondary)}',
      '.pf-preview-foot{display:flex;align-items:center;gap:8px;padding:8px 12px;border-top:1px solid var(--dsw-alias-border-l1)}',
      '.pf-hint{font-size:11px;color:var(--dsw-alias-label-secondary);margin-right:auto}',
    ].join('')

    /** 幂等注入样式表。 */
    function ensureStyle() {
      if (typeof document === 'undefined') return () => {}
      const tagId = PLUGIN + '/client.css'
      const selector = 'style[data-plugin-css=' + JSON.stringify(tagId) + ']'
      if (document.querySelector(selector) !== null) return () => {}
      const tag = document.createElement('style')
      tag.dataset.plugin = PLUGIN
      tag.dataset.pluginCss = tagId
      tag.textContent = CSS
      document.head.appendChild(tag)
      return () => tag.remove()
    }

    /* ────────────────────────── 配置（只读状态） ────────────────────────── */

    const DEFAULT_REMOTE = { enabled: true, candidates: 1, maxInputChars: 12000, shortcut: 'ctrl+alt+e', mode: 'auto' }

    let remoteConfig = DEFAULT_REMOTE
    let remotePromise = null
    const configListeners = new Set()

    /** 拉一次宿主状态；失败时保留默认值（按钮仍然能用，非法状态由宿主 403 兜底）。 */
    function loadRemoteConfig() {
      if (remotePromise !== null) return remotePromise
      remotePromise = fetch(STATE_URL, { headers: { accept: 'application/json' } })
        .then((response) => (response.ok ? response.json() : null))
        .then((payload) => {
          if (payload && payload.ok && payload.data) {
            remoteConfig = { ...DEFAULT_REMOTE, ...payload.data }
            for (const listener of configListeners) listener()
          }
          return remoteConfig
        })
        .catch(() => remoteConfig)
      return remotePromise
    }

    function subscribeConfig(listener) {
      configListeners.add(listener)
      return () => configListeners.delete(listener)
    }

    function getConfig() {
      return remoteConfig
    }

    /* ────────────────────────── 会话状态 ────────────────────────── */

    /**
     * 单会话状态。`applied` 只用于展示，真实文本在输入框里。
     *
     * `structural` 相关字段只在草稿含引用 chip 时有值：那时回填不是整体 setDraft，
     * 而是逐段替换 chip 之外的文本（见 applySegments），撤销因此也要存原始分段。
     */
    const EMPTY_STATE = {
      phase: 'idle',
      original: '',
      applied: '',
      candidates: [],
      index: 0,
      progress: 0,
      error: '',
      structural: false,
      originalSegments: null,
      chipTexts: null,
    }

    /** @type {Map<string, typeof EMPTY_STATE>} */
    const sessions = new Map()
    /** @type {Map<string, { setDraft?: (text: string) => void }>} */
    const actionsByKey = new Map()
    /** @type {Map<string, { root: HTMLElement | null, run: () => void }>} */
    const registry = new Map()
    /** @type {Map<string, any>} */
    const timers = new Map()

    const stateListeners = new Set()

    function emitState() {
      for (const listener of stateListeners) listener()
    }

    function getSession(key) {
      return sessions.get(key) ?? EMPTY_STATE
    }

    function setSession(key, patch) {
      const next = { ...getSession(key), ...patch }
      sessions.set(key, next)
      emitState()
      return next
    }

    function subscribeState(listener) {
      stateListeners.add(listener)
      return () => stateListeners.delete(listener)
    }

    /** 清掉某会话的撤销计时器。 */
    function clearTimer(key) {
      const timer = timers.get(key)
      if (timer !== undefined) {
        clearTimeout(timer)
        timers.delete(key)
      }
    }

    /** 8 秒后自动收起撤销条（期间用户仍可撤销）。 */
    function armTimer(key) {
      clearTimer(key)
      timers.set(
        key,
        setTimeout(() => {
          timers.delete(key)
          if (getSession(key).phase === 'done') setSession(key, { phase: 'idle' })
        }, UNDO_MS),
      )
    }

    /** 把文本写回输入框；宿主拒绝或抛错时只记录，不让交互崩掉。 */
    function writeDraft(key, text) {
      const actions = actionsByKey.get(key)
      try {
        if (actions && typeof actions.setDraft === 'function') {
          actions.setDraft(text)
          return true
        }
      } catch (error) {
        console.warn(`[${PLUGIN}] setDraft 失败`, error)
      }
      return false
    }

    /* ────────────────────────── 请求 ────────────────────────── */

    /**
     * 发一次增强请求，处理 SSE 与一次性 JSON 两种响应。
     * @returns {Promise<{ text: string, mode?: string, profile?: string, candidates?: Array<any> }>}
     */
    /** 组装请求体：可选字段只在有值时出现，便于单测直接断言。 */
    function buildRequestBody({ text, sessionId, refStrict }) {
      const body = { text }
      if (typeof sessionId === 'string' && sessionId !== '') body.sessionId = sessionId
      if (refStrict === true) body.refStrict = true
      return body
    }

    async function requestForge({ text, sessionId, signal, onDelta, refStrict }) {
      const payloadBody = buildRequestBody({ text, sessionId, refStrict })
      const response = await fetch(STREAM_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payloadBody),
        signal,
      })

      if (!response.ok) {
        let payload = null
        try {
          payload = await response.json()
        } catch {
          // 非 JSON 错误体。
        }
        const detail = payload && payload.error ? payload.error : { code: 'internal', message: `HTTP ${response.status}` }
        throw Object.assign(new Error(detail.message || detail.code || '增强失败'), { detail })
      }

      const contentType = response.headers.get('content-type') || ''
      // 宿主或代理不支持流时自动回退为一次性 JSON。
      if (!contentType.includes('text/event-stream') || response.body === null) {
        const payload = await response.json()
        if (!payload || payload.ok !== true) throw Object.assign(new Error('增强失败'), { detail: payload && payload.error })
        return payload.data
      }

      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let result = null
      let failure = null

      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let boundary = buffer.indexOf('\n\n')
        while (boundary !== -1) {
          const frameText = buffer.slice(0, boundary)
          buffer = buffer.slice(boundary + 2)
          const dataLine = frameText.split('\n').find((line) => line.startsWith('data: '))
          if (dataLine !== undefined) {
            let frame = null
            try {
              frame = JSON.parse(dataLine.slice(6))
            } catch {
              frame = null
            }
            if (frame !== null) {
              if (frame.type === 'delta') {
                try {
                  if (typeof onDelta === 'function') onDelta(frame.text || '')
                } catch {
                  // 展示路径断裂不影响主流程。
                }
              } else if (frame.type === 'result') {
                result = frame.data
              } else if (frame.type === 'error') {
                failure = frame.error
              }
            }
          }
          boundary = buffer.indexOf('\n\n')
        }
      }

      if (failure !== null) throw Object.assign(new Error(failure.message || failure.code || '增强失败'), { detail: failure })
      if (result === null) throw Object.assign(new Error('增强没有返回结果'), { detail: { code: 'internal', message: '空响应' } })
      return result
    }

    /* ────────────────── 引用 chip 的结构保真（M4） ────────────────── */

    const REF_PREFIX = '⟦REF'
    const REF_SUFFIX = '⟧'

    /** 第 index 个占位符（0 起）。 */
    function refToken(index) {
      return `${REF_PREFIX}${index + 1}${REF_SUFFIX}`
    }

    /** 取一条 occurrence 的 clipboard 投影区间，字段缺失时退化为"零长"。 */
    function rangeOf(occurrence, fallback) {
      const offset = occurrence !== null && typeof occurrence.offset === 'number' ? occurrence.offset : fallback
      const length = occurrence !== null && typeof occurrence.length === 'number' ? occurrence.length : 0
      return { offset, length }
    }

    /**
     * 文本区段在 **detect 投影** 里的坐标。
     *
     * 宿主有两套坐标：`draft`/`occurrences` 是 clipboard 投影（chip 展开成完整文本），
     * 而 `emit` 的 span 必须说 detect 投影（chip 折叠成 1 个字符）。两套混用会让第二
     * 个 chip 之后的编辑整体偏移、被宿主以越界拒绝。
     * @returns {Array<{ start: number, end: number }>} 长度 = chip 数 + 1。
     */
    function detectSpans(draft, occurrences) {
      const spans = []
      let clipboardCursor = 0
      let detectCursor = 0
      for (const occurrence of occurrences) {
        const { offset, length } = rangeOf(occurrence, clipboardCursor)
        const runLength = Math.max(0, offset - clipboardCursor)
        spans.push({ start: detectCursor, end: detectCursor + runLength })
        detectCursor += runLength + 1
        clipboardCursor = offset + length
      }
      spans.push({ start: detectCursor, end: detectCursor + Math.max(0, draft.length - clipboardCursor) })
      return spans
    }

    /** 送给模型的文本：chip 换成 ⟦REFn⟧（模型看不到真实引用内容，也就无从改写它）。 */
    function composeForModel(draft, occurrences) {
      let out = ''
      let cursor = 0
      occurrences.forEach((occurrence, index) => {
        const { offset, length } = rangeOf(occurrence, cursor)
        out += draft.slice(cursor, offset) + refToken(index)
        cursor = offset + length
      })
      return out + draft.slice(cursor)
    }

    /**
     * 模型输出按占位符切回文本区段。
     * 数量/顺序不符、或多出占位符，一律返回 null——调用方必须放弃本次结果，
     * 而不是猜一个映射。
     * @returns {string[] | null} 长度 = count + 1 的区段数组。
     */
    function splitByPlaceholders(text, count) {
      const parts = []
      let rest = String(text)
      for (let index = 0; index < count; index++) {
        const token = refToken(index)
        const at = rest.indexOf(token)
        if (at === -1) return null
        parts.push(rest.slice(0, at))
        rest = rest.slice(at + token.length)
      }
      if (rest.includes(REF_PREFIX)) return null
      parts.push(rest)
      return parts
    }

    /** 把 draft 按 chip 切成纯文本区段（与 detectSpans 同结构）。 */
    function segmentsOf(draft, occurrences) {
      const segments = []
      let cursor = 0
      for (const occurrence of occurrences) {
        const { offset, length } = rangeOf(occurrence, cursor)
        segments.push(draft.slice(cursor, offset))
        cursor = offset + length
      }
      segments.push(draft.slice(cursor))
      return segments
    }

    /** 每个 chip 在 draft 里的字面文本（展示与撤销时拼回去用）。 */
    function chipTextsOf(draft, occurrences) {
      return occurrences.map((occurrence) => {
        const { offset, length } = rangeOf(occurrence, 0)
        return draft.slice(offset, offset + length)
      })
    }

    /** 展示用文本：新分段 + 原 chip 文本交替拼接。 */
    function displayOf(segments, chipTexts) {
      let out = ''
      for (let index = 0; index < segments.length; index++) {
        out += segments[index]
        if (index < chipTexts.length) out += chipTexts[index]
      }
      return out
    }

    /** 插件 ctx（apply 时捕获），用来解析宿主输入面。 */
    let facadeCtx = null

    /**
     * 解析宿主输入面：`sessions.scope(id)` → `conversation.input.for(scope)`。
     *
     * 用 `ctx.get` 而不是 `ctx.conversation`：本插件 `inject` 为空，读未注入的服务属性
     * 会被 cordis 拒绝；`get` 是应用自身插件在用的免注入读法。
     */
    function resolveInputFacade(sessionId) {
      if (facadeCtx === null || typeof sessionId !== 'string' || sessionId === '') return null
      try {
        const sessions = facadeCtx.get('sessions')
        const conversation = facadeCtx.get('conversation')
        if (!sessions || !conversation || typeof sessions.scope !== 'function') return null
        if (!conversation.input || typeof conversation.input.for !== 'function') return null
        const scope = sessions.scope(sessionId)
        if (!scope) return null
        const input = conversation.input.for(scope)
        if (!input || !input.state || typeof input.state.getSnapshot !== 'function') return null
        return { scope, input }
      } catch (error) {
        console.warn(`[${PLUGIN}] 解析宿主输入面失败`, error)
        return null
      }
    }

    /**
     * 逐段替换 chip 之外的文本，chip 一个字节都不碰。
     *
     * 两个关键取舍：
     *  - **从右往左改**：span 坐标会随它左边的改动整体平移，而改右边不影响左边既有
     *    offset。所以先写最后一段，前面各段坐标仍然有效，不必重算。
     *  - **不重铸 chip**：chip 的 `ref`（模型真正收到的序列化内容）无法从草稿文本反推
     *    ——选择型 chip 的 ref 是一整段围栏文本。猜错会静默改变模型输入，比拍平更糟。
     *    这里所有 span 都只覆盖 chip 之间的纯文本，chip 天然存活。
     * @returns {{ ok: boolean, reason?: string, index?: number }}
     */
    function applySegments(facade, segments, expectedChips) {
      try {
        const snapshot = facade.input.state.getSnapshot()
        const occurrences = Array.isArray(snapshot.occurrences) ? snapshot.occurrences : []
        if (occurrences.length !== expectedChips) return { ok: false, reason: 'chip-count-changed' }
        if (snapshot.draftRev === undefined) return { ok: false, reason: 'no-rev' }
        if (snapshot.phase !== undefined && snapshot.phase !== 'plain') return { ok: false, reason: `phase:${snapshot.phase}` }
        if (typeof facade.scope.emit !== 'function') return { ok: false, reason: 'no-emit' }
        const spans = detectSpans(snapshot.draft, occurrences)
        if (spans.length !== segments.length) return { ok: false, reason: 'segment-count' }

        for (let index = spans.length - 1; index >= 0; index--) {
          const span = spans[index]
          const text = typeof segments[index] === 'string' ? segments[index] : ''
          const current = facade.input.state.getSnapshot()
          const rev = current.draftRev
          if (rev === undefined) return { ok: false, reason: 'no-rev' }
          if (text === '' && span.start === span.end) continue
          try {
            facade.scope.emit('slash/input-insert-text', { text, span: { draftRev: rev, start: span.start, end: span.end } })
          } catch (error) {
            return { ok: false, reason: `emit:${error instanceof Error ? error.message : String(error)}`, index }
          }
          // 宿主用修订号做 span-CAS：号没变就是被拒了，不能假装成功。
          if (facade.input.state.getSnapshot().draftRev === rev) return { ok: false, reason: 'rejected', index }
        }
        return { ok: true }
      } catch (error) {
        return { ok: false, reason: `throw:${error instanceof Error ? error.message : String(error)}` }
      }
    }

    /** 把一条候选落到草稿上；structural 时走分段替换，否则整体 setDraft。 */
    function applyCandidate(key, rawText, structural) {
      if (structural === null || structural === undefined) {
        return writeDraft(key, rawText) ? { ok: true, display: rawText } : { ok: false, reason: 'write-failed' }
      }
      const segments = splitByPlaceholders(rawText, structural.chipCount)
      if (segments === null) return { ok: false, reason: 'placeholder-mismatch' }
      const applied = applySegments(structural.facade, segments, structural.chipCount)
      if (!applied.ok) return { ok: false, reason: applied.reason }
      return { ok: true, display: displayOf(segments, structural.chipTexts) }
    }

    /** 错误原因 → 可读文案。 */
    function applyFailureText(reason) {
      switch (reason) {
        case 'placeholder-mismatch':
          return '模型改动了引用占位符，结果已丢弃（原文未改动）。'
        case 'chip-count-changed':
          return '草稿里的引用在请求期间变了，已放弃（原文未改动）。'
        case 'no-rev':
        case 'no-emit':
          return '宿主没有提供引用保真改写所需的 span 通道，已放弃（原文未改动）。'
        case 'segment-count':
          return '引用结构对不上，已放弃（原文未改动）。'
        case 'rejected':
          return '宿主拒绝了这次写入（可能正在提交），原文未改动。'
        case 'write-failed':
          return '写回输入框失败（宿主拒绝），原文未改动。'
        default:
          return `回填失败（${reason}），原文未改动。`
      }
    }

    /** 统一把一次成功结果落到草稿上，并进入 8 秒撤销窗口。 */
    /**
     * 收下一次成功结果：先校验、再决定"呈现"与"落盘"。
     *
     * 分两步是为了让两种档位共用同一条落盘路径（applySelected）：
     *  - `inplace`（默认）：呈现后立刻落盘；
     *  - `preview`：只进入 `preview` 相位，草稿一个字节都不动，等用户 Enter。
     * 占位符契约在**呈现之前**就校验完，这样重试逻辑只有一处，不必在两档各写一遍。
     * @returns {'ok' | 'preview' | 'retry-mismatch' | 'failed'} 结果码。
     */
    function commit(key, original, data, structural) {
      const list = Array.isArray(data.candidates) && data.candidates.length > 0
        ? data.candidates
        : [{ text: data.text, mode: data.mode, profile: data.profile }]
      const first = list[0]
      if (!first || typeof first.text !== 'string' || first.text === '') {
        setSession(key, { phase: 'error', error: '增强没有返回可用文本。' })
        return 'failed'
      }
      if (structural) {
        for (const candidate of list) {
          if (typeof candidate.text !== 'string' || splitByPlaceholders(candidate.text, structural.chipCount) === null) {
            setSession(key, { phase: 'error', error: applyFailureText('placeholder-mismatch'), original })
            return 'retry-mismatch'
          }
        }
      }
      setSession(key, {
        phase: 'preview',
        original,
        applied: '',
        candidates: list,
        index: 0,
        progress: 0,
        error: '',
        structural: structural ?? null,
      })
      if (getConfig().applyMode === 'preview') return 'preview'
      return applySelected(key, 0)
    }

    /** 把第 index 条候选真正落到草稿上，并进入撤销窗口。两种档位共用。 */
    function applySelected(key, index) {
      const state = getSession(key)
      const candidate = state.candidates[index]
      if (!candidate || typeof candidate.text !== 'string') {
        setSession(key, { phase: 'error', error: '增强没有返回可用文本。' })
        return 'failed'
      }
      const applied = applyCandidate(key, candidate.text, state.structural)
      if (!applied.ok) {
        setSession(key, { phase: 'error', error: applyFailureText(applied.reason), original: state.original })
        return applied.reason === 'placeholder-mismatch' ? 'retry-mismatch' : 'failed'
      }
      setSession(key, { phase: 'done', applied: applied.display, index, error: '' })
      armTimer(key)
      return 'ok'
    }

    /** 预览档：采纳当前候选。 */
    function acceptPreview(key) {
      const state = getSession(key)
      if (state.phase !== 'preview') return
      applySelected(key, state.index)
    }

    /** 预览档：放弃。草稿从未被改动，清状态即可。 */
    function dismissPreview(key) {
      if (getSession(key).phase !== 'preview') return
      setSession(key, { phase: 'idle', original: '', applied: '', candidates: [], index: 0, structural: null })
    }

    /**
     * 撤销：恢复增强前的状态。
     *
     * 含引用时不能简单 setDraft(original)——那会把还在原位的 chip 拍平。改走同一套
     * 分段替换，把原始分段写回去，chip 依旧原地不动。真回不去时才退回纯文本恢复，
     * 并且**明确告知**结构已丢，不静默降级。
     */
    function undo(key) {
      const state = getSession(key)
      if (state.phase !== 'done') return
      clearTimer(key)
      if (state.structural) {
        const reverted = applySegments(state.structural.facade, state.structural.originalSegments, state.structural.chipCount)
        if (!reverted.ok) {
          writeDraft(key, state.original)
          setSession(key, {
            phase: 'error',
            error: `撤销未能保留引用结构（${reverted.reason}），已按纯文本恢复；可用 Ctrl+Z 再试。`,
            structural: null,
          })
          return
        }
      } else {
        writeDraft(key, state.original)
      }
      setSession(key, { phase: 'idle', original: '', applied: '', candidates: [], index: 0, error: '', progress: 0, structural: null })
    }

    /** 多候选前后切换（决策 3：多候选进首发）。structural 时同样走分段替换。 */
    function step(key, direction) {
      const state = getSession(key)
      if ((state.phase !== 'done' && state.phase !== 'preview') || state.candidates.length < 2) return
      if (state.phase === 'preview') {
        // 预览相位切候选只是换展示，草稿仍未被动过。
        const nextIndex = (state.index + direction + state.candidates.length) % state.candidates.length
        setSession(key, { index: nextIndex })
        return
      }
      const count = state.candidates.length
      const next = (state.index + direction + count) % count
      const candidate = state.candidates[next]
      if (!candidate || typeof candidate.text !== 'string') return
      const applied = applyCandidate(key, candidate.text, state.structural)
      if (!applied.ok) {
        setSession(key, { phase: 'error', error: applyFailureText(applied.reason) })
        return
      }
      setSession(key, { index: next, applied: applied.display })
      armTimer(key)
    }

    /* ────────────────────────── 组件 ────────────────────────── */

    /**
     * 会话键。
     *
     * 按钮与撤销条是两个独立注册的槽位组件，**必须落到同一个键**上，否则撤销条永远
     * 读不到按钮写入的状态。所以兜底键是模块级常量而不是每次挂载自增——后者会让
     * 两个组件各拿一个号，状态永远对不上。代价：宿主不提供 sessionId 时多个输入栏
     * 共享同一份状态，这是可接受的降级（0.1.1 起的宿主都会给 sessionId）。
     */
    const ANON_KEY = 'anon'

    function useSessionKey(sessionId) {
      return typeof sessionId === 'string' && sessionId !== '' ? sessionId : ANON_KEY
    }

    /** 订阅某会话状态。 */
    function useSession(key) {
      return React.useSyncExternalStore(subscribeState, () => getSession(key), () => EMPTY_STATE)
    }

    /** 订阅只读配置。 */
    function useConfig() {
      return React.useSyncExternalStore(subscribeConfig, getConfig, getConfig)
    }

    /** 会话 id：input.right 槽给 props.sessionId，dock 槽给 props.session。 */
    function sessionIdOf(props) {
      if (props === null || props === undefined) return ''
      if (typeof props.sessionId === 'string' && props.sessionId !== '') return props.sessionId
      if (props.session && typeof props.session.sessionId === 'string') return props.session.sessionId
      return ''
    }

    /** 输入栏右侧的 ✨ 按钮。 */
    function ForgeButton(props) {
      const h = React.createElement
      const actions = props.inputActions
      const useInput = typeof props.useInput === 'function' ? props.useInput : null
      // 结构保真改写要拿会话 id 去解析 `sessions.scope(id)`，拿不到就只能降级。
      const sessionId = sessionIdOf(props)
      const key = useSessionKey(sessionId)
      const state = useSession(key)
      const config = useConfig()
      const rootRef = React.useRef(null)
      const abortRef = React.useRef(null)

      // 宿主输入栏本体就是 useInput((s) => s)；没有 props.input。
      // 读不到时一律降级为空草稿 / plain 相位，而不是崩掉。
      const draft = useInput ? useInput((snapshot) => (snapshot && typeof snapshot.draft === 'string' ? snapshot.draft : '')) : ''
      const phase = useInput ? useInput((snapshot) => (snapshot && typeof snapshot.phase === 'string' ? snapshot.phase : 'plain')) : 'plain'
      const occurrences = useInput ? useInput((snapshot) => (snapshot && Array.isArray(snapshot.occurrences) ? snapshot.occurrences.length : 0)) : 0
      const attachments = useInput
        ? useInput((snapshot) => countOf(snapshot && snapshot.attachmentIds) + countOf(snapshot && snapshot.imageIds))
        : 0

      const busy = state.phase === 'loading'

      const fail = (message) => setSession(key, { phase: 'error', error: message, original: draft })

      const run = () => {
        // 进行中再点 = 取消，比"禁用按钮"少一次解释。
        if (busy) {
          try {
            if (abortRef.current) abortRef.current.abort()
          } catch {
            // 已经结束。
          }
          return
        }
        if (config.enabled === false) {
          fail('提示词增强已在插件设置中关闭。')
          return
        }
        // 含引用 chip：走结构保真替换（M4）。缺 span 通道就明确拒绝，绝不拍平。
        let structural = null
        let outgoingText = draft
        if (occurrences > 0) {
          const facade = resolveInputFacade(sessionId)
          if (facade === null) {
            fail('草稿里有 @ 引用，但没能拿到宿主的输入面，无法保真改写。请先用 /enhance 命令。')
            return
          }
          const snapshot = facade.input.state.getSnapshot()
          const liveOccurrences = Array.isArray(snapshot.occurrences) ? snapshot.occurrences : []
          if (liveOccurrences.length === 0) {
            // React 派生的计数与实时快照不一致（chip 刚被删）：按纯文本处理。
            structural = null
          } else if (snapshot.draftRev === undefined) {
            fail('宿主没有提供 span 修订号，无法在不破坏引用的前提下改写。')
            return
          } else if (snapshot.phase !== undefined && snapshot.phase !== 'plain') {
            fail('当前回合还在进行，等它结束后再增强。')
            return
          } else {
            structural = {
              facade,
              chipCount: liveOccurrences.length,
              chipTexts: chipTextsOf(snapshot.draft, liveOccurrences),
              originalSegments: segmentsOf(snapshot.draft, liveOccurrences),
            }
            outgoingText = composeForModel(snapshot.draft, liveOccurrences)
          }
        }
        if (attachments > 0 && draft.trim() === '') {
          fail('只有附件时缺少可改写的内容，补一句话再增强。')
          return
        }
        const check = checkDraft(outgoingText, config.maxInputChars)
        if (!check.ok) {
          fail(check.message)
          return
        }
        if (phase !== 'plain') {
          fail('当前回合还在进行，等它结束后再增强。')
          return
        }

        const controller = new AbortController()
        abortRef.current = controller
        clearTimer(key)
        setSession(key, { phase: 'loading', original: draft, applied: '', candidates: [], index: 0, progress: 0, error: '', structural: null })

        const send = (strict) => {
          requestForge({
            text: outgoingText,
            sessionId: sessionId === '' ? undefined : sessionId,
            signal: controller.signal,
            refStrict: strict,
            onDelta: (delta) => {
              const current = getSession(key)
              if (current.phase !== 'loading') return
              setSession(key, { progress: current.progress + countText(delta) })
            },
          }).then(
            (data) => {
              const outcome = commit(key, draft, data, structural)
              // 占位符被改动是模型的偶发行为（实测约 1/3 会把引用重述一遍，
              // 同一对占位符在输出里出现两次）。用强化规则自动重试一次，
              // 让用户不必为一个已知的抖动多点一次；再失败才报错。
              if (outcome === 'retry-mismatch' && structural !== null && strict !== true) {
                setSession(key, { phase: 'loading', progress: 0, error: '' })
                send(true)
              }
            },
            (error) => {
              if (controller.signal.aborted) {
                setSession(key, { phase: 'idle', progress: 0 })
                return
              }
              setSession(key, { phase: 'error', error: messageOf(error) })
            },
          )
        }
        send(false)
      }

      const runRefStable = React.useRef(run)
      runRefStable.current = run

      React.useEffect(() => {
        const entry = { root: rootRef.current, run: () => runRefStable.current() }
        registry.set(key, entry)
        return () => {
          if (registry.get(key) === entry) registry.delete(key)
        }
      }, [key])

      React.useEffect(() => {
        actionsByKey.set(key, actions)
        return () => {
          if (actionsByKey.get(key) === actions) actionsByKey.delete(key)
          clearTimer(key)
          sessions.delete(key)
        }
      }, [key, actions])

      if (config.enabled === false) return null

      const title = busy
        ? `增强中…已 ${state.progress} 字（再点一次取消）`
        : `增强提示词（${config.shortcut || '未设快捷键'}）`

      return h(
        'button',
        {
          ref: rootRef,
          type: 'button',
          className: 'pf-btn' + (busy ? ' pf-busy' : ''),
          title,
          'aria-label': busy ? '取消增强' : '增强提示词',
          onClick: run,
        },
        h('span', { 'aria-hidden': true }, busy ? '◌' : '✨'),
      )
    }

    /** 输入栏下方的行内状态 / 撤销条。 */
    function ForgeBar(props) {
      const h = React.createElement
      const key = useSessionKey(sessionIdOf(props))
      const state = useSession(key)

      if (state.phase === 'idle' || state.phase === 'loading' || state.phase === 'preview') return null

      if (state.phase === 'error') {
        return h(
          'div',
          { className: 'pf-bar pf-error', role: 'status' },
          h('span', { 'aria-hidden': true }, '⚠'),
          h('span', { className: 'pf-err-text', title: state.error }, state.error),
          h('button', { type: 'button', onClick: () => setSession(key, { phase: 'idle', error: '' }) }, '知道了'),
        )
      }

      const count = state.candidates.length
      const candidate = state.candidates[state.index]
      const profile = (candidate && candidate.profile) || 'other'
      const mode = (candidate && candidate.mode) || 'expand'

      return h(
        'div',
        { className: 'pf-bar', role: 'status' },
        h('span', { 'aria-hidden': true }, '✨'),
        h('span', { className: 'pf-title' }, '已增强'),
        h('span', { className: 'pf-sep' }, '·'),
        h('span', { className: 'pf-meta' }, `${profile} / ${mode}`),
        h('span', { className: 'pf-sep' }, '·'),
        h('span', { className: 'pf-meta' }, formatDelta(state.original, state.applied)),
        count > 1
          ? h(
              'span',
              { style: { display: 'inline-flex', alignItems: 'center', gap: '2px' } },
              h('button', { type: 'button', title: '上一个候选', onClick: () => step(key, -1) }, '‹'),
              h('span', { className: 'pf-meta' }, `${state.index + 1}/${count}`),
              h('button', { type: 'button', title: '下一个候选', onClick: () => step(key, 1) }, '›'),
            )
          : null,
        h('button', { type: 'button', className: 'pf-primary', onClick: () => undo(key), title: '恢复增强前的草稿' }, '撤销'),
        h('button', { type: 'button', 'aria-label': '关闭', onClick: () => setSession(key, { phase: 'idle' }) }, '×'),
      )
    }

    /**
     * 预览档的浮层：原文与改写结果并排，Enter 采纳 / Esc 放弃 / Tab 换候选。
     *
     * 用 fixed 定位而不是让宿主 slot 定位：宿主把 overlay 子节点摆在哪里取决于它的
     * 布局上下文，而 DSH 的输入条带 container-type（见 dsh-composer-tooltip-fix 的
     * 记录），把 fixed 当 absolute 用的坑已经踩过一次。自己定位最稳。
     */
    function ForgePreview(props) {
      const h = React.createElement
      const key = useSessionKey(sessionIdOf(props))
      const state = useSession(key)
      const visible = state.phase === 'preview'

      React.useEffect(() => {
        if (!visible) return undefined
        const onKeyDown = (event) => {
          // 输入法组合态的 Enter/Esc 属于候选词操作，绝不能当成采纳或放弃。
          if (event.isComposing) return
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault()
            event.stopPropagation()
            acceptPreview(key)
            return
          }
          if (event.key === 'Escape') {
            event.preventDefault()
            event.stopPropagation()
            dismissPreview(key)
            return
          }
          if (event.key === 'Tab') {
            event.preventDefault()
            event.stopPropagation()
            step(key, event.shiftKey ? -1 : 1)
          }
        }
        document.addEventListener('keydown', onKeyDown, true)
        return () => document.removeEventListener('keydown', onKeyDown, true)
      }, [visible, key])

      if (!visible) return null
      const candidate = state.candidates[state.index]
      if (!candidate) return null
      const profile = candidate.profile || 'other'
      const mode = candidate.mode || 'expand'
      const count = state.candidates.length

      return h(
        'div',
        { className: 'pf-preview', role: 'dialog', 'aria-label': '增强结果预览' },
        h(
          'header',
          { className: 'pf-preview-head' },
          h('span', null, '✨ 预览'),
          h('span', { className: 'pf-sep' }, '·'),
          h('span', { className: 'pf-meta' }, `${profile} / ${mode}`),
          h('span', { className: 'pf-sep' }, '·'),
          h('span', { className: 'pf-meta' }, formatDelta(state.original, candidate.text)),
          count > 1
            ? h(
                'span',
                { className: 'pf-preview-cands' },
                h('button', { type: 'button', onClick: () => step(key, -1), title: '上一个候选' }, '‹'),
                h('span', { className: 'pf-meta' }, `${state.index + 1}/${count}`),
                h('button', { type: 'button', onClick: () => step(key, 1), title: '下一个候选' }, '›'),
              )
            : null,
        ),
        h(
          'div',
          { className: 'pf-preview-body' },
          h(
            'div',
            { className: 'pf-preview-col' },
            h('div', { className: 'pf-preview-title' }, '原文'),
            h('pre', { className: 'pf-preview-text is-original' }, state.original),
          ),
          h(
            'div',
            { className: 'pf-preview-col' },
            h('div', { className: 'pf-preview-title' }, '预览'),
            h('pre', { className: 'pf-preview-text' }, candidate.text),
          ),
        ),
        h(
          'footer',
          { className: 'pf-preview-foot' },
          h('span', { className: 'pf-hint' }, 'Enter 采纳 · Esc 放弃 · Tab 换候选'),
          h('button', { type: 'button', className: 'pf-panel-btn', onClick: () => dismissPreview(key) }, '放弃'),
          h('button', { type: 'button', className: 'pf-panel-btn primary', onClick: () => acceptPreview(key) }, '采纳'),
        ),
      )
    }

    /** 全局快捷键的作用目标：优先取焦点所在输入栏，其次最近注册的那个。 */
    function shortcutTarget() {
      const entries = []
      for (const entry of registry.values()) entries.push(entry)
      if (entries.length === 0) return null
      const active = typeof document !== 'undefined' ? document.activeElement : null
      if (active !== null && active !== undefined) {
        for (const entry of entries) {
          const root = entry.root
          if (root === null || root === undefined || typeof root.closest !== 'function') continue
          const seat = root.closest('[data-composer-seat]')
          if (seat !== null && seat.contains(active)) return entry
        }
      }
      return entries[entries.length - 1]
    }

    /* ────────────────────────── 设置面板（M3） ────────────────────────── */

    const CONFIG_URL = '/prompt-forge/config'

    /** 表单字段表。只有这些键会被面板写进覆盖层（宿主侧另有白名单二次把关）。 */
    const FORM_FIELDS = [
      { key: 'enabled', label: '启用增强', type: 'boolean' },
      {
        key: 'mode',
        label: '改写方向',
        type: 'select',
        options: [
          ['auto', '自动（未达标前按补齐）'],
          ['expand', '补齐'],
          ['tighten', '收紧'],
        ],
      },
      {
        key: 'autoTightenMinChars',
        label: '自动收紧阈值（字数，0=关）',
        type: 'number',
        min: 0,
        max: 100000,
        step: 10,
      },
      {
        key: 'applyMode',
        label: '落盘档位',
        type: 'select',
        options: [
          ['inplace', '就地改写（可撤销）'],
          ['preview', '先预览再采纳'],
        ],
      },
      {
        key: 'candidates',
        label: '候选数',
        type: 'select',
        number: true,
        options: [
          [1, '1 个'],
          [3, '3 个'],
        ],
      },
      { key: 'shortcut', label: '快捷键', type: 'text', placeholder: '如 ctrl+alt+e，留空禁用' },
      { key: 'maxInputChars', label: '输入字数上限', type: 'number', min: 200, max: 200000, step: 100 },
      { key: 'contextMaxMessages', label: '上下文条数', type: 'number', min: 0, max: 50, step: 1 },
      { key: 'temperature', label: '采样温度', type: 'number', min: 0, max: 1, step: 0.05 },
      { key: 'contextAware', label: '上下文接地', type: 'boolean' },
      { key: 'telemetry', label: '结构埋点（只记尺寸，不记正文）', type: 'boolean' },
    ]

    /** 读配置（有效值 + 覆盖层 + store 路径）。 */
    async function readConfigApi() {
      const response = await fetch(CONFIG_URL, { headers: { accept: 'application/json' } })
      const payload = await response.json().catch(() => null)
      if (!response.ok || !payload || payload.ok !== true) {
        const message = payload && payload.error && payload.error.message ? payload.error.message : `HTTP ${response.status}`
        throw new Error(message)
      }
      return payload.data
    }

    /** 写配置补丁；`null` 表示清除该键的运行期覆盖。 */
    async function writeConfigApi(patch) {
      const response = await fetch(CONFIG_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ patch }),
      })
      const payload = await response.json().catch(() => null)
      if (!response.ok || !payload || payload.ok !== true) {
        const message = payload && payload.error && payload.error.message ? payload.error.message : `HTTP ${response.status}`
        throw new Error(message)
      }
      return payload.data
    }

    /** 配置变更后强制刷新客户端只读状态（按钮显隐 / 快捷键立即跟随）。 */
    function refreshRemoteConfig() {
      remotePromise = null
      return loadRemoteConfig()
    }

    /** 插件详情页里的设置面板。 */
    function ForgePanel() {
      const h = React.createElement
      const [state, setState] = React.useState({ phase: 'loading', effective: null, overrides: {}, storeFile: '', error: '', note: '' })
      const [form, setForm] = React.useState({})

      const load = React.useCallback(() => {
        readConfigApi().then(
          (data) => {
            setState({ phase: 'ready', effective: data.effective, overrides: data.overrides, storeFile: data.storeFile, error: '', note: '' })
            setForm({ ...data.effective })
          },
          (error) => setState((previous) => ({ ...previous, phase: 'error', error: error.message })),
        )
      }, [])

      React.useEffect(() => {
        load()
      }, [load])

      if (state.phase === 'loading') {
        return h('div', { className: 'pf-panel' }, h('div', { className: 'pf-panel-note' }, '读取配置…'))
      }
      if (state.phase === 'error') {
        return h(
          'div',
          { className: 'pf-panel' },
          h('div', { className: 'pf-panel-error' }, `读取配置失败：${state.error}`),
          h('button', { type: 'button', className: 'pf-panel-btn', onClick: load }, '重试'),
        )
      }

      const setField = (key, value) => setForm((previous) => ({ ...previous, [key]: value }))

      const changedPatch = () => {
        const patch = {}
        for (const field of FORM_FIELDS) {
          const before = state.effective ? state.effective[field.key] : undefined
          const after = form[field.key]
          if (after !== before) patch[field.key] = after
        }
        return patch
      }

      const save = () => {
        const patch = changedPatch()
        if (Object.keys(patch).length === 0) {
          setState((previous) => ({ ...previous, note: '没有改动。' }))
          return
        }
        setState((previous) => ({ ...previous, note: '保存中…' }))
        writeConfigApi(patch).then(
          (data) => {
            setState({ phase: 'ready', effective: data.effective, overrides: data.overrides, storeFile: data.storeFile, error: '', note: '已保存，立即生效。' })
            setForm({ ...data.effective })
            refreshRemoteConfig()
          },
          (error) => setState((previous) => ({ ...previous, note: `保存失败：${error.message}` })),
        )
      }

      const clearAll = () => {
        const patch = {}
        for (const field of FORM_FIELDS) patch[field.key] = null
        setState((previous) => ({ ...previous, note: '清除中…' }))
        writeConfigApi(patch).then(
          (data) => {
            setState({ phase: 'ready', effective: data.effective, overrides: data.overrides, storeFile: data.storeFile, error: '', note: '已清除运行期覆盖。' })
            setForm({ ...data.effective })
            refreshRemoteConfig()
          },
          (error) => setState((previous) => ({ ...previous, note: `清除失败：${error.message}` })),
        )
      }

      const overriddenKeys = Object.keys(state.overrides || {})

      const renderControl = (field) => {
        const value = form[field.key]
        if (field.type === 'boolean') {
          return h('input', {
            type: 'checkbox',
            checked: value === true,
            onChange: (event) => setField(field.key, event.target.checked),
          })
        }
        if (field.type === 'select') {
          return h(
            'select',
            { value: String(value), onChange: (event) => setField(field.key, field.number ? Number(event.target.value) : event.target.value) },
            field.options.map(([optionValue, optionLabel]) => h('option', { key: String(optionValue), value: String(optionValue) }, optionLabel)),
          )
        }
        return h('input', {
          type: field.type === 'number' ? 'number' : 'text',
          value: value === undefined || value === null ? '' : String(value),
          placeholder: field.placeholder || '',
          min: field.min,
          max: field.max,
          step: field.step,
          onChange: (event) => setField(field.key, field.type === 'number' ? Number(event.target.value) : event.target.value),
        })
      }

      return h(
        'div',
        { className: 'pf-panel' },
        h('div', { className: 'pf-panel-title' }, '提示词增强'),
        h(
          'div',
          { className: 'pf-panel-hint' },
          overriddenKeys.length > 0
            ? `运行期覆盖生效中：${overriddenKeys.join('、')}`
            : '当前全部取部署期配置（无运行期覆盖）。',
        ),
        ...FORM_FIELDS.map((field) =>
          h('label', { className: 'pf-row', key: field.key }, h('span', { className: 'pf-row-label' }, field.label), renderControl(field)),
        ),
        h(
          'div',
          { className: 'pf-panel-actions' },
          h('button', { type: 'button', className: 'pf-panel-btn primary', onClick: save }, '保存'),
          h('button', { type: 'button', className: 'pf-panel-btn', onClick: clearAll }, '清除覆盖'),
          h('button', { type: 'button', className: 'pf-panel-btn', onClick: load }, '重新读取'),
          state.note !== '' ? h('span', { className: 'pf-panel-note' }, state.note) : null,
        ),
        h('div', { className: 'pf-panel-path', title: state.storeFile }, `覆盖文件：${state.storeFile}`),
      )
    }

    /* ────────────────────────── 装载 ────────────────────────── */

    /** 没有硬依赖：slots 通过 ctx.inject 惰性拿，缺了就是没有按钮，不会拖垮 boot。 */
    const inject = []

    function apply(ctx) {
      // 捕获插件 ctx：结构保真改写要经 `ctx.get('sessions')` / `ctx.get('conversation')`
      // 解析宿主输入面（免注入读法，未注入也不会抛）。
      facadeCtx = ctx
      try {
        ensureStyle()
      } catch (error) {
        console.warn(`[${PLUGIN}] 样式注入失败`, error)
      }

      // 配置只拉一次；失败保留默认值，真正的闸门在宿主侧。
      loadRemoteConfig()

      try {
        ctx.inject(['slots'], (slotsCtx) => {
          const slots = slotsCtx.slots
          if (slots === undefined || slots === null) return

          const registerRight = slots.inject('conversation.input.right', () => {
            try {
              return slots.register({ name: 'conversation.input.right', id: PLUGIN, order: 60 }, ForgeButton)
            } catch (error) {
              console.warn(`[${PLUGIN}] 输入框按钮槽注册失败`, error)
              return () => {}
            }
          })

          const registerDock = slots.inject('conversation.input.dock', () => {
            try {
              return slots.register({ name: 'conversation.input.dock', id: `${PLUGIN}-bar`, order: 90 }, ForgeBar)
            } catch (error) {
              console.warn(`[${PLUGIN}] 撤销条槽注册失败`, error)
              return () => {}
            }
          })

          // 预览档浮层：只有 applyMode=preview 时才会渲染出内容。
          const registerPreview = slots.inject('conversation.input.overlay', () => {
            try {
              return slots.register({ name: 'conversation.input.overlay', id: `${PLUGIN}-preview`, order: 40 }, ForgePreview)
            } catch (error) {
              console.warn(`[${PLUGIN}] 预览浮层槽注册失败`, error)
              return () => {}
            }
          })

          // 插件详情页的配置面板：注册失败只是没有面板，路由仍可用。
          const registerPanel = slots.inject('plugins.bundle.config', () => {
            try {
              return slots.register({ name: 'plugins.bundle.config', key: PLUGIN }, ForgePanel)
            } catch (error) {
              console.warn(`[${PLUGIN}] 配置面板槽注册失败`, error)
              return () => {}
            }
          })

          return () => {
            if (typeof registerRight === 'function') registerRight()
            if (typeof registerDock === 'function') registerDock()
            if (typeof registerPreview === 'function') registerPreview()
            if (typeof registerPanel === 'function') registerPanel()
          }
        })
      } catch (error) {
        console.warn(`[${PLUGIN}] slots 注入失败，按钮不出现`, error)
      }

      // 快捷键：只在精确匹配时拦截；IME 组合态与已阻止的事件一律放过。
      ctx.effect(() => {
        const onKeyDown = (event) => {
          if (event.defaultPrevented || event.isComposing) return
          const config = getConfig()
          if (config.enabled === false) return
          const combo = parseShortcut(config.shortcut)
          if (combo === null || !matchesShortcut(event, combo)) return
          const target = shortcutTarget()
          if (target === null) return
          event.preventDefault()
          event.stopPropagation()
          target.run()
        }
        document.addEventListener('keydown', onKeyDown, true)
        return () => document.removeEventListener('keydown', onKeyDown, true)
      }, `${PLUGIN}: shortcut`)
    }

    exports.apply = apply
    exports.inject = inject
    // 仅供 node --test 使用；宿主不消费。
    exports.__test = {
      countText,
      countOf,
      parseShortcut,
      matchesShortcut,
      formatDelta,
      checkDraft,
      messageOf,
      // 结构保真（M4）：这些是纯函数 + 一个显式传 facade 的应用函数，
      // 因此可以在没有浏览器、没有 React 的情况下直接验证。
      detectSpans,
      composeForModel,
      splitByPlaceholders,
      segmentsOf,
      chipTextsOf,
      displayOf,
      applySegments,
      applyFailureText,
      sessionIdOf,
      buildRequestBody,
      getSession,
      commit,
      applySelected,
      acceptPreview,
      dismissPreview,
      step,
      clearTimer,
      registerActions: (key, actions) => actionsByKey.set(key, actions),
      setRemoteConfig: (patch) => {
        remoteConfig = { ...remoteConfig, ...patch }
        for (const listener of configListeners) listener()
      },
      UNDO_MS,
      STREAM_URL,
      STATE_URL,
    }
    return module.exports
  },
})
