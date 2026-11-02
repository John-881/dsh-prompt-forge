/**
 * 客户端半测试。
 *
 * client.js 是给浏览器用的经典脚本（顶层就是 `window.__ModuleLoader__.load(...)`），
 * 但它没有任何 import/export 语句，所以可以直接当 ES 模块载入：先塞一个假的
 * `window.__ModuleLoader__` 把 factory 截下来，再用假 React 执行 factory。
 * 这样测的是**真实文件**的解析与导出形状，不是副本。
 */

import test from 'node:test'
import assert from 'node:assert/strict'

/** 极简 React 替身：工厂函数体只在运行时用 React，装载阶段不需要真实实现。 */
const reactStub = {
  createElement: () => null,
  useRef: (initial) => ({ current: initial }),
  useEffect: () => {},
  useSyncExternalStore: () => undefined,
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
}

/** 载入客户端包，返回它导出的模块对象。 */
async function loadBundle() {
  let captured = null
  globalThis.window = {
    __ModuleLoader__: {
      load(spec) {
        captured = spec
      },
    },
  }
  await import(`../lib/client.js?t=${Date.now()}`)
  assert.ok(captured !== null, '应当调用 __ModuleLoader__.load')
  const module = { exports: {} }
  const returned = captured.factory((name) => {
    if (name === 'react') return reactStub
    throw new Error(`unexpected require: ${name}`)
  })
  return { spec: captured, exports: returned ?? module.exports }
}

const { spec, exports: client } = await loadBundle()

test('bundle：id 必须等于 loader entry 名，否则宿主报 loaded without registering', () => {
  assert.equal(spec.id, 'dsh-prompt-forge')
})

test('bundle：导出 apply / inject，inject 为空（不用硬依赖拖垮 boot）', () => {
  assert.equal(typeof client.apply, 'function')
  assert.deepEqual(client.inject, [])
})

test('countText：按码点计数，emoji 算 1', () => {
  assert.equal(client.__test.countText('中a'), 2)
  assert.equal(client.__test.countText('😀'), 1)
})

test('countOf：字段缺失或类型不对时算 0（宿主不同代字段名不同）', () => {
  assert.equal(client.__test.countOf(undefined), 0)
  assert.equal(client.__test.countOf(null), 0)
  assert.equal(client.__test.countOf('abc'), 0)
  assert.equal(client.__test.countOf([1, 2]), 2)
})

test('parseShortcut：必须含 ctrl/alt/meta 之一', () => {
  assert.deepEqual(client.__test.parseShortcut('ctrl+alt+e'), { ctrl: true, alt: true, shift: false, meta: false, key: 'e' })
  assert.equal(client.__test.parseShortcut('shift+e'), null, '纯 shift 会抢正常输入，必须拒绝')
  assert.equal(client.__test.parseShortcut('e'), null)
  assert.equal(client.__test.parseShortcut(''), null)
  assert.equal(client.__test.parseShortcut(undefined), null)
  assert.deepEqual(client.__test.parseShortcut('Ctrl+Shift+E'), { ctrl: true, alt: false, shift: true, meta: false, key: 'e' })
})

test('matchesShortcut：多按一个修饰键也不算匹配', () => {
  const combo = client.__test.parseShortcut('ctrl+alt+e')
  assert.equal(client.__test.matchesShortcut({ ctrlKey: true, altKey: true, shiftKey: false, metaKey: false, key: 'e' }, combo), true)
  assert.equal(client.__test.matchesShortcut({ ctrlKey: true, altKey: true, shiftKey: true, metaKey: false, key: 'e' }, combo), false)
  assert.equal(client.__test.matchesShortcut({ ctrlKey: true, altKey: false, shiftKey: false, metaKey: false, key: 'e' }, combo), false)
  assert.equal(client.__test.matchesShortcut({ ctrlKey: true, altKey: true, shiftKey: false, metaKey: false, key: 'q' }, combo), false)
})

test('formatDelta：增、减、不变三种文案', () => {
  assert.equal(client.__test.formatDelta('写个登录接口', '写个登录接口'), '字数不变')
  assert.equal(client.__test.formatDelta('ab', 'abcdef'), '+4 字')
  assert.equal(client.__test.formatDelta('abcdef', 'ab'), '-4 字')
})

test('checkDraft：空白与零宽字符不算内容', () => {
  assert.equal(client.__test.checkDraft('   \u200b  ', 100).ok, false)
  assert.equal(client.__test.checkDraft('写点东西', 100).ok, true)
})

test('checkDraft：超限拒绝并给出实际码点数，不截断', () => {
  const verdict = client.__test.checkDraft('a'.repeat(101), 100)
  assert.equal(verdict.ok, false)
  assert.ok(verdict.message.includes('101'))
  assert.ok(verdict.message.includes('100'))
})

test('messageOf：优先用宿主信封里的 message，其次 Error.message，最后兜底', () => {
  assert.equal(client.__test.messageOf({ detail: { message: '上游限流' } }), '上游限流')
  assert.equal(client.__test.messageOf(new Error('boom')), 'boom')
  assert.equal(client.__test.messageOf(null), '增强失败，原文未改动。')
})

test('端点常量与宿主侧一致', () => {
  assert.equal(client.__test.STREAM_URL, '/prompt-forge/enhance/stream')
  assert.equal(client.__test.STATE_URL, '/prompt-forge/state')
  assert.equal(client.__test.UNDO_MS, 8000)
})

test('apply：缺 slots 服务时不抛（降级为没有按钮，不拖垮 web boot）', () => {
  const effects = []
  const ctx = {
    inject: (deps, callback) => {
      // 服务不存在时 cordis 不调用 callback；这里显式模拟"没装"。
      if (deps.includes('slots')) return undefined
      return callback(ctx)
    },
    effect: (fn) => {
      effects.push(fn())
      return () => {}
    },
  }
  const docDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'document')
  globalThis.document = { addEventListener: () => {}, removeEventListener: () => {}, querySelector: () => null, head: { appendChild: () => {} }, createElement: () => ({ dataset: {}, style: {}, remove: () => {} }) }
  try {
    assert.doesNotThrow(() => client.apply(ctx))
    assert.equal(effects.length, 1, '快捷键 effect 仍应注册')
  } finally {
    if (docDescriptor === undefined) delete globalThis.document
    else Object.defineProperty(globalThis, 'document', docDescriptor)
  }
})

test('apply：注册四个槽位（按钮 / 撤销条 / 预览浮层 / 配置面板），组件引用稳定', () => {
  const registrations = []
  const slots = {
    inject: (name, callback) => callback(),
    register: (spec, component) => {
      registrations.push({ spec, component })
      return () => {}
    },
  }
  const ctx = {
    inject: (deps, callback) => (deps.includes('slots') ? callback({ slots }) : undefined),
    effect: (fn) => {
      fn()
      return () => {}
    },
  }
  const docDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'document')
  globalThis.document = {
    addEventListener: () => {},
    removeEventListener: () => {},
    querySelector: () => null,
    head: { appendChild: () => {} },
    createElement: () => ({ dataset: {}, style: {}, remove: () => {} }),
  }
  try {
    client.apply(ctx)
    const names = registrations.map((item) => item.spec.name)
    assert.deepEqual(names, [
      'conversation.input.right',
      'conversation.input.dock',
      'conversation.input.overlay',
      'plugins.bundle.config',
    ])

    // 组件必须是函数引用（不是内联箭头包装），否则每次重渲染都会被当成新类型。
    for (const item of registrations) assert.equal(typeof item.component, 'function')

    // 按钮与撤销条必须挂在同一个 id 前缀下，且顺序稳定（按钮在右、撤销条在 dock）。
    const right = registrations.find((item) => item.spec.name === 'conversation.input.right')
    const dock = registrations.find((item) => item.spec.name === 'conversation.input.dock')
    assert.equal(right.spec.id, 'dsh-prompt-forge')
    assert.equal(dock.spec.id, 'dsh-prompt-forge-bar')
    assert.equal(right.spec.order, 60)
    assert.equal(dock.spec.order, 90)
  } finally {
    if (docDescriptor === undefined) delete globalThis.document
    else Object.defineProperty(globalThis, 'document', docDescriptor)
  }
})

/* ─────────────────── 引用 chip 结构保真（M4） ─────────────────── */

/**
 * 造一个模拟宿主输入面：内部维护 **detect 投影**（chip 折叠成 U+FFFC），
 * emit 就按 span 改写它并递增修订号——这样能验证"从右往左"是否真的不互相污染。
 */
function makeFacade(draft, occurrences, options = {}) {
  const detect = []
  let clipboardCursor = 0
  for (const occurrence of occurrences) {
    detect.push(draft.slice(clipboardCursor, occurrence.offset))
    detect.push('\uFFFC')
    clipboardCursor = occurrence.offset + occurrence.length
  }
  detect.push(draft.slice(clipboardCursor))
  const state = { text: detect.join(''), rev: 1, calls: [], accepts: options.accepts !== false }

  const input = {
    state: {
      getSnapshot() {
        return {
          draft,
          occurrences,
          draftRev: state.rev,
          phase: options.phase === undefined ? 'plain' : options.phase,
        }
      },
    },
  }
  const scope = {
    emit(name, payload) {
      state.calls.push({ name, payload })
      if (!state.accepts) return
      const { start, end } = payload.span
      state.text = state.text.slice(0, start) + payload.text + state.text.slice(end)
      state.rev += 1
    },
  }
  return { facade: { scope, input }, state }
}

const OCC = [
  { offset: 1, length: 5 },
  { offset: 7, length: 5 },
]
const DRAFT = '把@a.md和@b.md改成表格'

test('detectSpans：文本区段坐标落在 detect 投影上（chip 占 1 字符）', () => {
  const spans = client.__test.detectSpans(DRAFT, OCC)
  assert.deepEqual(spans, [
    { start: 0, end: 1 }, // 把
    { start: 2, end: 3 }, // 和
    { start: 4, end: 8 }, // 改成表格
  ])
})

test('detectSpans：无 chip 时退化为整段', () => {
  assert.deepEqual(client.__test.detectSpans('abc', []), [{ start: 0, end: 3 }])
})

test('composeForModel：chip 换成 ⟦REFn⟧，顺序编号', () => {
  assert.equal(client.__test.composeForModel(DRAFT, OCC), '把⟦REF1⟧和⟦REF2⟧改成表格')
})

test('splitByPlaceholders：正常切回三段', () => {
  assert.deepEqual(client.__test.splitByPlaceholders('新A⟦REF1⟧新B⟦REF2⟧新C', 2), ['新A', '新B', '新C'])
})

test('splitByPlaceholders：少一个占位符 → null（必须放弃，不许猜映射）', () => {
  assert.equal(client.__test.splitByPlaceholders('新A⟦REF1⟧新B新C', 2), null)
})

test('splitByPlaceholders：占位符顺序颠倒 → null', () => {
  assert.equal(client.__test.splitByPlaceholders('新A⟦REF2⟧新B⟦REF1⟧新C', 2), null)
})

test('splitByPlaceholders：末尾多出占位符 → null', () => {
  assert.equal(client.__test.splitByPlaceholders('新A⟦REF1⟧新B⟦REF2⟧新C⟦REF3⟧', 2), null)
})

test('segmentsOf / chipTextsOf / displayOf：切分与拼回互为逆运算', () => {
  const segments = client.__test.segmentsOf(DRAFT, OCC)
  const chips = client.__test.chipTextsOf(DRAFT, OCC)
  assert.deepEqual(segments, ['把', '和', '改成表格'])
  assert.deepEqual(chips, ['@a.md', '@b.md'])
  assert.equal(client.__test.displayOf(segments, chips), DRAFT)
})

test('applySegments：从右往左逐段改写，chip 原地不动', () => {
  const { facade, state } = makeFacade(DRAFT, OCC)
  const result = client.__test.applySegments(facade, ['新A', '新B', '新C'], 2)
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(state.text, '新A\uFFFC新B\uFFFC新C')
  assert.equal(state.calls.length, 3, '三段各一次 emit')
  // 每次 emit 的 span 都不覆盖 chip 占位符：chip 位置是 1 与 3。
  for (const call of state.calls) {
    assert.equal(call.name, 'slash/input-insert-text')
    assert.ok(!(call.payload.span.start <= 1 && call.payload.span.end > 1), '不得覆盖第 1 个 chip')
    assert.ok(!(call.payload.span.start <= 3 && call.payload.span.end > 3), '不得覆盖第 2 个 chip')
  }
})

test('applySegments：宿主拒绝（修订号不变）→ 立即报 rejected，不假装成功', () => {
  const { facade, state } = makeFacade(DRAFT, OCC, { accepts: false })
  const result = client.__test.applySegments(facade, ['新A', '新B', '新C'], 2)
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'rejected')
  assert.equal(state.text, '把\uFFFC和\uFFFC改成表格', '原文未被改动')
})

test('applySegments：chip 数量在请求期间变了 → 放弃', () => {
  const { facade } = makeFacade(DRAFT, OCC)
  const result = client.__test.applySegments(facade, ['新A', '新B', '新C'], 1)
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'chip-count-changed')
})

test('applySegments：非 plain 相位（提交中）→ 放弃', () => {
  const { facade } = makeFacade(DRAFT, OCC, { phase: 'submitting' })
  const result = client.__test.applySegments(facade, ['新A', '新B', '新C'], 2)
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'phase:submitting')
})

test('applySegments：没有修订号就没有 span 通道 → 放弃', () => {
  const { facade } = makeFacade(DRAFT, OCC)
  facade.input.state.getSnapshot = () => ({ draft: DRAFT, occurrences: OCC, phase: 'plain' })
  const result = client.__test.applySegments(facade, ['新A', '新B', '新C'], 2)
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'no-rev')
})

test('applySegments：段数与结构对不上 → 放弃', () => {
  const { facade } = makeFacade(DRAFT, OCC)
  const result = client.__test.applySegments(facade, ['只有一段'], 2)
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'segment-count')
})

test('失败文案：占位符被模型改动时明确说是"结果已丢弃"', () => {
  assert.ok(client.__test.applyFailureText('placeholder-mismatch').includes('丢弃'))
  assert.ok(client.__test.applyFailureText('rejected').includes('原文未改动'))
  assert.ok(client.__test.applyFailureText('no-emit').includes('span 通道'))
})

test('sessionIdOf：两种 props 形状都能取到会话 id', () => {
  assert.equal(client.__test.sessionIdOf({ sessionId: 'a' }), 'a')
  assert.equal(client.__test.sessionIdOf({ session: { sessionId: 'b' } }), 'b')
  assert.equal(client.__test.sessionIdOf({}), '')
  assert.equal(client.__test.sessionIdOf(undefined), '')
})

test('buildRequestBody：可选字段只在有值时出现', () => {
  assert.deepEqual(client.__test.buildRequestBody({ text: 'x' }), { text: 'x' })
  assert.deepEqual(client.__test.buildRequestBody({ text: 'x', sessionId: 's1', refStrict: true }), {
    text: 'x',
    sessionId: 's1',
    refStrict: true,
  })
  assert.deepEqual(client.__test.buildRequestBody({ text: 'x', sessionId: '', refStrict: false }), { text: 'x' })
})

/* ─────────────────── 预览档（M5） ─────────────────── */

/** 造一个只记录写入的 actions 面。 */
function makeActions() {
  const writes = []
  return { writes, actions: { setDraft: (text) => writes.push(text) } }
}

const CANDIDATES = {
  text: '第一版',
  mode: 'expand',
  profile: 'code',
  candidates: [
    { text: '第一版', mode: 'expand', profile: 'code' },
    { text: '第二版', mode: 'tighten', profile: 'code' },
  ],
}

test('preview 档：commit 只呈现、不写草稿', () => {
  const key = 'k-preview-1'
  const { writes, actions } = makeActions()
  client.__test.registerActions(key, actions)
  client.__test.setRemoteConfig({ applyMode: 'preview', enabled: true })

  const outcome = client.__test.commit(key, '原始草稿', CANDIDATES, null)
  assert.equal(outcome, 'preview')
  assert.deepEqual(writes, [], '预览相位绝不能碰草稿')
  assert.equal(client.__test.getSession(key).phase, 'preview')
  client.__test.clearTimer(key)
})

test('preview 档：accept 才落盘，并进入撤销窗口', () => {
  const key = 'k-preview-2'
  const { writes, actions } = makeActions()
  client.__test.registerActions(key, actions)
  client.__test.setRemoteConfig({ applyMode: 'preview', enabled: true })
  client.__test.commit(key, '原始草稿', CANDIDATES, null)

  client.__test.acceptPreview(key)
  assert.deepEqual(writes, ['第一版'])
  const state = client.__test.getSession(key)
  assert.equal(state.phase, 'done')
  assert.equal(state.original, '原始草稿')
  client.__test.clearTimer(key)
})

test('preview 档：dismiss 什么都不写，回到 idle', () => {
  const key = 'k-preview-3'
  const { writes, actions } = makeActions()
  client.__test.registerActions(key, actions)
  client.__test.setRemoteConfig({ applyMode: 'preview', enabled: true })
  client.__test.commit(key, '原始草稿', CANDIDATES, null)

  client.__test.dismissPreview(key)
  assert.deepEqual(writes, [])
  assert.equal(client.__test.getSession(key).phase, 'idle')
})

test('preview 档：Tab 换候选只换展示，不动草稿；采纳时落的是当前候选', () => {
  const key = 'k-preview-4'
  const { writes, actions } = makeActions()
  client.__test.registerActions(key, actions)
  client.__test.setRemoteConfig({ applyMode: 'preview', enabled: true })
  client.__test.commit(key, '原始草稿', CANDIDATES, null)

  client.__test.step(key, 1)
  assert.equal(client.__test.getSession(key).index, 1)
  assert.deepEqual(writes, [], '换候选不应写草稿')

  client.__test.acceptPreview(key)
  assert.deepEqual(writes, ['第二版'])
  client.__test.clearTimer(key)
})

test('inplace 档（默认）：commit 直接落盘，不进入 preview 相位', () => {
  const key = 'k-inplace-1'
  const { writes, actions } = makeActions()
  client.__test.registerActions(key, actions)
  client.__test.setRemoteConfig({ applyMode: 'inplace', enabled: true })

  const outcome = client.__test.commit(key, '原始草稿', CANDIDATES, null)
  assert.equal(outcome, 'ok')
  assert.deepEqual(writes, ['第一版'])
  assert.equal(client.__test.getSession(key).phase, 'done')
  client.__test.clearTimer(key)
})

test('applyMode 缺省值等于就地档（配置缺失不能让功能变哑）', () => {
  const key = 'k-inplace-2'
  const { writes, actions } = makeActions()
  client.__test.registerActions(key, actions)
  client.__test.setRemoteConfig({ applyMode: undefined, enabled: true })

  client.__test.commit(key, '原始草稿', CANDIDATES, null)
  assert.deepEqual(writes, ['第一版'])
  client.__test.clearTimer(key)
})
