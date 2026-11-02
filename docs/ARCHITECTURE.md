# 架构与宿主契约

## 模块图

```
宿主进程（node）                          浏览器（插件 bundle）
├─ lib/index.js        装配入口           └─ lib/client.js
│   ├─ config.js       三层配置合成            ├─ ✨ 按钮   conversation.input.right
│   ├─ routes.js       HTTP 路由 + 准入闸      ├─ 撤销条   conversation.input.dock
│   ├─ command.js      /enhance 命令           ├─ 预览浮层 conversation.input.overlay
│   ├─ orchestrate.js  并发调度与结果信封      └─ 配置面板 plugins.bundle.config
│   ├─ context.js      会话上下文接地
│   ├─ prompts.js      策略与六维清单
│   ├─ llm.js          零依赖 LLM 调用 + 流式累积
│   ├─ store.js        运行期配置覆盖（原子写）
│   ├─ validate.js     输入校验
│   ├─ protocol.js     端点与行 id 常量
│   └─ telemetry.js    events.jsonl 埋点
```

## 端点

| 方法 | 路径 | 用途 |
|---|---|---|
| POST | `/prompt-forge/enhance` | 一次性 JSON |
| POST | `/prompt-forge/enhance/stream` | SSE：`delta` / `result` / `error` 三种帧 |
| GET | `/prompt-forge/state` | 只读状态，供客户端决定按钮显示与否；**不消耗准入闸** |
| GET/POST | `/prompt-forge/config` | 读有效配置 / 改运行期覆盖 |

## 十条宿主契约（改代码前必读）

这些不是推测，是读 `app.asar` 里的宿主源码 + 实机验证得来的。

1. **零宿主包 import**。插件以 `link:` 安装，真实路径在 profile 之外，Node 从真实路径向上找不到 profile 的 `node_modules`，`import '@deepseek-ai/dsh-llm'` 会失败。所以 `createUserMessage` 与 `BlockAssembler` 是手写等价实现，形状取自 `dsh-llm/lib/index.js` 实读（message 就是 `{ role, content, source, id }`；chunk 七种类型、`finish.reason` 五种取值）。
2. **只有 `llm` 是硬依赖**。`webServer` / `commands` / `sessions` / `settings` / `agentDefaultModel` 一律按需 `ctx.get()`、缺失即降级。写进 `inject` 会让条目在缺该服务的组合里长期 pending，而 DSH 把 pending 当启动失败，会拖着整个 GUI 起不来。
3. **配置非法不抛**。抛会让整条 entry 不激活，表现是"装了但按钮没有"，比跑默认值难排查百倍。改为回退默认值 + 告警，请求路径仍走完整校验。
4. **`session.requestHeader` 是方法不是属性**。读成属性会拿到函数对象，其 `.config` 为 undefined，整层路由优先级静默失效。
5. **`ctx.settings.get()` 同步读已不存在**（0.1.5-rc.3 起换成 `SettingsForms`）。按旧形状调用会让每个请求 502。本项目因此自建配置 store。
6. **客户端 bundle 必须用 `window.__ModuleLoader__.load({ id, factory })` 包装**，`id` 必须等于包名，否则宿主报 `loaded without registering ...`。factory 里用 `require('react')` 取 React。
7. **槽组件 props 只有 `inputActions` 与 `useInput`**，没有 `props.input`。草稿要从 `useInput((s) => s.draft)` 读；读 `props.input` 只会静默拿到 undefined。会话 id 两种形状都要接：`props.sessionId`（input.right）与 `props.session.sessionId`（dock）。
8. **按钮与撤销条的会话键必须一致**。兜底键用模块级常量，不能用挂载自增——自增会让两者各拿一个号，撤销条永远读不到按钮写的状态。
9. **组件必须是模块级稳定引用**。在 `register` 回调里现造函数组件，React 每次重渲染都会当成新类型，按钮被反复卸载重建。
10. **`setDraft()` 是整体替换**（官方注释：替换整段草稿，光标落到末尾）。因此它不能用于结构保真的回填——那会把 chip 拍平。结构回填必须走 `scope.emit('slash/input-insert-text', { text, span })`，并用 `draftRev` 做 CAS 校验。

## 引用保真的坐标模型

同一个草稿有两套坐标，混用即错：

| 投影 | 来源 | chip 的宽度 | 谁在用 |
|---|---|---|---|
| clipboard | `snapshot.draft` + `occurrences[].offset/length` | 展开成完整文本（`@a.md` 5 字符） | 我们要读的原文、切分文本区段 |
| detect | `draft` 去掉 occurrence 覆盖区、chip 折叠为 1 字符（U+FFFC） | 1 字符 | `emit` 的 `span` 必须说这一套 |

所以 `detectSpans()` 先从 clipboard 投影算出各文本区段的 clipboard 坐标，再按"每跨过一个 chip 就减去 `length - 1`"换算成 detect 坐标。回填从**文末段开始往前写**，这样前面各段的 offset 不受影响，不必重算。

## 状态机（客户端）

```
idle ──点击──▶ loading ──成功──▶ preview ──Enter──▶ done ──8s/关闭──▶ idle
  ▲              │                  │                │
  └──取消/失败────┘                  └──Esc───────────┘（草稿从未被写）
```

`preview` 相位只在 `applyMode=preview` 时停留；`inplace` 下 `commit()` 会立即调 `applySelected()`，所以外部只看到 `loading → done`。

`done` 相位持有 `original`（增强前原文，撤销的锚点）与 `candidates`（多候选）。切换候选即改写，`original` 不变。

## 准入闸

- 并发上限（默认 2）
- 滑动窗口限流（10 次/分钟，**只计成功**——失败不该消耗配额，否则一次上游抖动会连带把自己锁死）
- 连续 3 次失败熔断 30 秒
- 回环栅栏：套接字 + `Host` + `Origin` 同端口，拒 `X-Forwarded-For`

## 为什么自己写 LLM 调用

不是偏好问题，是 `link:` 安装的解析边界决定的（见契约 1）。手写的代价是没有设置页那种框架能力，收益是宿主升级不会让配置层失效——本插件因此只依赖 `ctx.get('llm').stream()` 这一个最稳定的接口。
