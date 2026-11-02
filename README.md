# dsh-prompt-forge

给 DeepSeek Harness 的输入框加一个**提示词增强**按钮：点一下，草稿就地变成一条结构化、可执行的提示词；不满意就撤销。

对标 WorkBuddy 的「增强提示词」（一次点击、就地生效、零配置），并把力气放在"改写不能损伤原意"上：**引用不丢**、**能收也能放**、**效果可测量**。

## 能力

| 能力 | 说明 |
|---|---|
| **引用 chip 结构保真** | 草稿里有 `@文件` 引用也能增强，改写后引用**原地不动**。chip 区间从头到尾不被任何 span 触碰 |
| **双向改写** | 不只扩写。啰嗦的口语草稿会被**压短**（≤ 原文长度），紧凑的长规格保持不压。方向由一条可解释规则判定，不交给模型 |
| **自带评测尺子** | `tools/eval.mjs` 走用户点击的同一个公开端点，输出 FRR / KR / HR / DC 指标，并对每条失败打印可判读的上下文 |
| **两种落盘档位** | 默认就地改写 + 8 秒撤销；不放心时切"先预览再采纳"，草稿在接受前一个字节都不动 |
| **运行期配置** | 面板改完立即生效，不用改 YAML、不用重启 |

## 安装

插件是标准 DSH bundle（`cordis.patch.yml` 自带装载行），三种方式任选：

```bash
# 1) 从本地目录装（开发时改代码即时生效，pnpm 建 link: 依赖）
dsh plugin --profile desktop add /absolute/path/to/dsh-prompt-forge

# 2) 从 GitHub 装
dsh plugin --profile desktop add github:<owner>/dsh-prompt-forge

# 3) 从 npm 装（若已发布）
dsh plugin --profile desktop add dsh-prompt-forge
```

> **桌面版**：`dsh plugin --profile desktop ...` 在部分版本会被 CLI 拒绝（profile 由 Electron 应用独占）。此时走应用内「插件 → 安装插件」，包名或地址填 `github:<owner>/dsh-prompt-forge`。
> 装完**重启应用**：宿主半在启动时 import 并缓存，改 `lib/*.js`（除 `client.js`）不重启不生效。

### 与 `dsh-prompt-enhance` 互斥

两个插件都注册 `conversation.input.right`、都绑 `ctrl+alt+e`、都占宿主路由。**同时启用会出现两个按钮、两个快捷键**。

仓库带一个幂等开关脚本，把"安装 + 停用旧插件"做成一个事务：

```bash
node tools/switch.mjs --status     # 只读：现在谁在接管
node tools/switch.mjs --enable     # 安装本插件 +（若存在）停用旧插件，改 patch 前自动备份
node tools/switch.mjs --revert     # 一分钟回滚
```

`--enable` 只做两件事：`dsh plugin add link:<本目录>`，以及在 profile 的 `cordis.patch.yml` 末尾追加

```yaml
# [prompt-forge] 互斥：停用 dsh-prompt-enhance
- id: prompt-enhance
  disabled: true
```

旧插件**没装**时第二件事自动跳过。改 patch 前会备份成 `cordis.patch.yml.bak-forge-<时间戳>`。

环境变量：`DSH_HOME`（默认 `~/.dsh`）、`DSH_PROFILE`（默认 `desktop`）、`DSH_CLI`（默认 `dsh`，找不到会给出提示）。

## 用起来是什么样

输入框右侧出现 ✨（快捷键 `ctrl+alt+e`）。草稿为空、或回合正在提交/仲裁时按钮不可用。

| 场景 | 行为 |
|---|---|
| 点击 ✨ | 请求 → **直接改写草稿** → 底部出现撤销条 |
| 撤销条 | `✨ 已增强 · code/expand · +858 字 · [撤销] [×]`，8 秒自动收起；`Ctrl+Z` 等效 |
| 请求中再点 | 取消（比禁用按钮少一次解释） |
| 多候选 | 候选 >1 时显示 `‹ 1/3 ›`，切换即改写，撤销始终回到最初原文 |
| 草稿含 `@` 引用 | 支持，引用结构保真 |
| 失败 | 草稿**零改动**，显示可读原因 |

命令行入口（不进对话、不占上下文）：

```bash
/enhance 写个登录接口
/enhance tighten <一段啰嗦的需求>
```

> `/enhance` 提交后输入框会清空——这是宿主对"提交"的统一定义，斜杠命令改不了。想保留原文请用 ✨ 或快捷键。

## 两种落盘档位

| 档位 | 行为 | 适合 |
|---|---|---|
| `inplace`（默认） | 点击后直接改写草稿，8 秒可撤销 | 想要零摩擦 |
| `preview` | 弹浮层，左原文右预览，**草稿在接受前一个字节都不动** | 不放心让它直接改 |

预览档键盘：`Enter` 采纳 · `Esc` 放弃 · `Tab`/`Shift+Tab` 换候选。输入法组合态（`isComposing`）一律不拦截，否则中文选词的回车会被当成"采纳"。

两档共用同一条落盘路径：`commit()` 只负责校验与呈现，真正写草稿的是 `applySelected()`。占位符契约在呈现前就校验完，所以重试逻辑只有一处实现。

## 配置

三层合成，改运行期那一层**立即生效、不用重启**：

```
DEFAULT_CONFIG（代码）  ←  patch 条目 config（部署期）  ←  store 覆盖（运行期）
```

```yaml
- id: prompt-forge
  name: dsh-prompt-forge
  config:
    applyMode: inplace        # inplace | preview
    mode: auto                # auto | expand | tighten
    autoTightenMinChars: 80   # auto 下判定"值得压"的长度下限，0 = 关闭自动收紧
    candidates: 1             # 1 | 3
    contextAware: true
    shortcut: ctrl+alt+e
```

运行期覆盖存在 `~/.dsh/storages/prompt-forge/config.json`（临时文件 + rename 原子写，按 mtime 缓存）。面板在「插件 → dsh-prompt-forge」详情页；也可以直接打接口：

```bash
curl -s http://127.0.0.1:<port>/prompt-forge/config
curl -s -X POST http://127.0.0.1:<port>/prompt-forge/config \
  -H 'content-type: application/json' -d '{"patch":{"candidates":3}}'
```

写入前先验证，**非法值绝不落盘**（否则之后每个请求都会读到坏配置）；文件损坏或存了非法值时退回部署期配置并只告警一次，请求照常成功。可写键白名单见 `lib/config.js` 的 `WRITABLE_KEYS`。

## 引用保真：不让 chip 进入改写范围

原方案是"改写后用 span 把 chip 重铸回去"。这条路不可行：chip 的 `ref`（模型真正收到的序列化内容）**无法从草稿文本反推**——选择型 chip 的 `ref` 是一整段围栏文本。猜错会静默改变模型输入，比拍平更糟。

改成让 chip 从不出现在改写范围里：

```
草稿:  把 [@a.md] 和 [@b.md] 改成表格     （[] = chip）
送模型: 把 ⟦REF1⟧ 和 ⟦REF2⟧ 改成表格
回填:   只替换三段纯文本，chip 原地不动
```

四条约束（每条都有测试）：

1. **不重铸 chip** —— 不碰就没有猜的余地；
2. **从右往左逐段替换** —— span 坐标随左侧改动整体平移，改右侧不影响左侧既有 offset；
3. **分清两套坐标** —— `draft`/`occurrences` 是 clipboard 投影（chip 展开成完整文本），`emit` 的 span 必须说 detect 投影（chip 折叠成 1 字符）。混用会让**第二个 chip 之后**的编辑整体越界；
4. **宿主拒绝就认输** —— 宿主用 `draftRev` 做 span-CAS，改完修订号没变即被拒，不能假装成功。

任一前提不满足（无修订号、非 `plain` 相位、请求期间 chip 数变了、模型改动了占位符、任一次 `emit` 后修订号未变）一律放弃并**保持原文**。撤销同样走分段替换，所以撤销也不会拍平 chip。

### 已知抖动

模型偶尔会"重述"占位符（同一对在输出里出现两次，2 个变 4 个）——「两份文档」这类措辞会诱导它加一个"输入材料"清单。观测约 11%（9 次采样命中 1 次，样本小）。处理：规则**点名禁止重述**；且只对 `placeholder-mismatch` **自动重试一次**（重试带 `refStrict`，宿主追加"草稿恰好 N 个占位符，输出必须恰好 N 个"）。其余失败原因不重试——那些是结构或宿主问题，重试只会把等待时间翻倍。

## 评测

`tools/eval.mjs` 只调**公开的** `POST /prompt-forge/enhance`——评测路径就是用户点按钮的路径，没有测试旁路。脚本会自动发现宿主端口（端口每次重启都变），能在宿主重启后重新定位并重试一次。

```bash
node tools/eval.mjs                    # expand + tighten 全跑
node tools/eval.mjs --mode tighten --minIn 40   # 只跑 ≥40 字的草稿（比例指标在这一档才有意义）
node tools/eval.mjs --limit 4 --gap 0
```

| 指标 | 含义 | 判据 |
|---|---|---|
| `factsKept` FRR | 标注事实是否仍在结果里 | 子串命中；含数字的事实按**数值集合**比对（`2025-06` ≡ `2025 年 6 月`） |
| `krKept`/`krLost`/`krReview` KR | 约束是否保留 | 三档：原样或核心+极性一致 = 保留；核心在但否定消失 = **确定丢失**；核心未字面出现 = **转人工** |
| `fabricatedSpec` HR | 新出现、原文没有的具体规格数字 | 先剥列表序号，只计 ≥100／带 %／带小数 |
| `ratioMedian` LR | 输出/输入码点比 | 仅草稿 ≥40 字时计算 |
| `lenInRange` | 短草稿是否落在 200–450 字 | 短草稿比例无意义 |
| `coverageMean` DC | 角色/步骤/格式/验收/边界 五标记命中数 | 0–5 |

**为什么 KR 不能全自动**：中文语义等价无法用字符串判定。这条尺子被修过三次，每次都是假阴性：

| 报告值 | 实际 | 根因 |
|---|---|---|
| KR 0.375 | 约束几乎全在 | 中文单 token 约束（`不走全表扫描`）被"否定词整词过滤"剥空 |
| HR 27 个"捏造" | 几乎全是步骤序号 | 行首 `1. 2. 3.` 被当数字 |
| FRR 0.947 | 1.000 | `2025 年 6 月` vs `2025-06` |
| KR 一条"丢失" | 保留 | `动现有的表结构` vs `改动现有表结构`，差一个「的」 |

所以脚本的职责是：给出"**确定丢失 = 0**"这个必要条件，并把疑似项连上下文列出来。充分条件必须人工——把"看不出来"单列成 `review`、绝不伪装成失败，就是这个教训。

### 实测（6 条长草稿 × tighten）

| 项 | 结果 |
|---|---|
| 调用 | 6/6 成功 |
| FRR | 1.000 |
| KR | 自动确认 4 ／ 确定丢失 **0** ／ 转人工 9 → 人工逐条核对**全部保留** → 13/13 |
| 比例中位数 | **0.88**（0.76–1.16） |
| 具体规格数字 | 0 |

### `auto` 的方向判定

不是"让模型自己决定"，而是一条保守的可解释规则：

```
长度 ≥ autoTightenMinChars（默认 80 字） 且 口语填充词（吧/然后/就是/另外/哦对了…）命中 ≥2 次 → 收紧
否则 → 补齐
```

代价不对称：判错成"该压没压"只少省几个字；判错成"不该压却压了"会伤内容。所以紧凑的长规格（`需求：… 约束：… 验收：…`）永远走补齐。阈值设 0 即关闭自动收紧。

## 与同类插件的关系

写这个插件前扫过市面上的同类项目（至少 8 个），下面按各自的公开 README / 目录页描述对比，若对方已更新，以对方文档为准：

| 项目 | 它的做法 | 与本项目的差异 |
|---|---|---|
| `zzyyun/dsh-prompt-enhance` | 本项目最初替换掉的那个 | 含 `@` 引用时**直接拒绝**；回填 `setDraft()` 会把 chip 拍平；长度只有 1x–3x 扩写 |
| `DaYePython/dsh-input-optimize` | 用 `⟦REF⟧` 占位符替换 chip、只改纯文本，写回前校验"齐全且有序"再还原 chip | **引用保真的思路一致**，差别在实现路线：本项目不还原 chip，chip 区间从头到尾不被任何 span 触碰，因此不依赖"宿主能否插入 chip"；代价是改写**不能搬动 chip 的位置**。另有双向与评测 |
| `devilzyl/dsh-enhance-prompt` | 主张 `@` chips 不被修改，一键撤销 | 只扩写；未提供指标或评测 |
| `dsh-improve-prompt`（dshpluginhub 收录） | 运行时"保真闸"：机械提取硬事实（含 `@` 引用）逐条验证，缺失则点名修复；两档 ≤1.2x / ≤2.5x | 它做的是**运行时保证**，本项目做的是**离线可复算**的指标；且它的档位都在 1x 以上，不下压 |
| `ruiyukirin/dsh-prompt-optimization-master` | 工程化最完整（设置页、模型下拉、i18n、思考型模型的输出预算） | 明确"不读对话历史"；只扩写 |
| `Lstalu/dsh-prompt-polish` | 在已知限制里直接写明"`setDraft()` 会移除 `@` 引用 chip" | 诚实标注限制的做法值得学；本项目在编码上避免这个损失 |
| `feiwell/dsh-enhance-prompt`、`Fishsb/dsh-prompt-enhancer`、`MapleLeafWH/dsh-plugin-prompt-enhance` | 模式菜单 / 语音输入 + 记忆链 / 安装链路 | 方向仍是扩写，未提及引用参与改写 |

所以本项目的差异**不在"引用能不能保留"**——这件事已经有人做到。差异在三处：

1. **不还原 chip 的实现路线**：不依赖"能否把 chip 插回去"这个未文档化的能力，chip 结构从编码上就不可能被破坏；
2. **能收紧**：`tighten` 有硬上限（≥40 字不得长于原文），同类插件普遍只做扩写；
3. **效果可复算**：`tools/eval.mjs` 是离线评测而不是运行时兜底，能把"这版提示词策略到底好没好"量出来。

取舍是**窄而硬**：不做语音、不做多模式菜单、不做记忆链。

## 兼容与限制

- 实测于 **DSH 0.2.1-rc.5 / Node 22**；`engines` 声明 `dsh >= 0.2.0-rc.2 < 0.3.0`。
- 桌面版界面跑在 `dsh-app://` 协议上，Electron 会把非静态资源路径转发给宿主 HTTP 服务——所以相对路径 `fetch` 通，但宿主侧同源校验必须**显式接受** `dsh-app://app` 与 `Origin: null`（本插件已处理，测试覆盖三种 Origin）。
- 宿主半改动必须重启；只有 `lib/client.js` 走 HMR。
- 不做流式写入草稿：SSE 用于进度展示（已收字符数），结果一次性落盘，避免草稿被反复改写。
- 埋点只记尺寸/模式/结果，**不记正文**：`~/.dsh/logs/dsh-prompt-forge/events.jsonl`。

## 开发

```bash
npm test        # 127 项：55 单元 + 30 宿主集成 + 29 客户端
npm run check   # 语法检查
```

测试不启动 GUI：用假 ctx / 假 webServer / 假 llm 直接驱动 `apply()`，从 HTTP 处理器走到结果信封；客户端测试把 `lib/client.js` 当 ES 模块真载入，用假 `__ModuleLoader__` 截 factory、假 React 执行。

结构与"改代码前必读"的十条宿主契约见 [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)。发布记录见 [`CHANGELOG.md`](CHANGELOG.md)。

## 许可

MIT
