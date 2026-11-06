# Phase 2 UI 设计规格（可实现级）— CodeLens Agent 工具调用平台

> 版本：v2.2.0 | 设计师：颜好看 | 日期：2026-10-22
> 上游：`docs/agent/spec.md` v2.0（唯一契约）+ `docs/agent/phase1-uiux.md` v1.2.0（本文是它的**细化**，不是重做）
>
> **v2.2.0 变更（team-lead 2026-10-22 裁决，覆盖架构的 revise 方案）**：
> ① §3.5 改参数重试**改回独立端点** `POST /api/v1/approvals/:id/revise`（Spec §5 端点 21→22），body `{ token, arguments }`——**没有 `decision` 键**（架构曾提议用 `decision:'revise'` 走同一端点，该方案已作废）；
> ② §3.5 补**第三个返回态 `rejected`**（新参数没过服务端 schema/安全网关，HTTP 仍是 200，确认条要转成失败卡片而非报错）——这是三档里最容易写错的一档；
> ③ §3.4.1 两个端点的 body 键集合拆成两个 TS 类型；
> ④ §4.4 MCP 连接器维持 **P1**（team-lead 已改 Spec §2 措辞为「架构/API/UI 已设计完毕，Phase 3 在 P0 跑通后实现」），UI 规格保留不删，仅标注排期。
>
> **v2.1.0 变更（架构 2026-10-22 两项裁决已同步）**：
> ① §3.5 改参数重试改为 **`decision: 'revise'` 走同一端点**（不新增端点），补 `reapproval_required` / `executed_directly` 两个响应分支与三条边界（仅 pending 可改 / 最多 3 次 / 新参数重跑安全网关）；
> ② §2.6 错误区 `kind` 表替换为架构锁定的 **10 值**枚举（去 `payload_too_large`、`forbidden` 并入 `security`、补 `circuit_open` 且**用 neutral 色**）；
> ③ §3.4.1 补 `APPROVAL_NOT_REVISABLE` / `APPROVAL_REVISE_LIMIT` 两行 + body 键集合按 `decision` 分档；
> ④ §9 阻塞项 B-1/B-2 已闭环，改为「已闭环 + 待批准（W-1 单步重试/从某步重跑）」；
> ⑤ A-7 更正：架构 C-2 现已是下划线（我初稿引的是旧版残留），前端只需保证不写中划线。
> 样式来源：`client/src/styles/design-tokens.css`（**只读，零新增颜色 Token**）
> 图标：lucide-react 1.60.0，**规范名**，16/20/24px，stroke-width 2（本文 §8.2 全部图标已在 `node_modules/lucide-react/dist/lucide-react.d.ts` 逐项核验存在）
> 事件契约：架构 §8.1（下划线命名）/ §8.2 载荷示例
> 动效：仅 `duration-150` / `duration-250` + `var(--c-ease-standard)`；**禁 `cubic-bezier(0.68,-0.55,0.265,1.55)` 弹跳**
> 单文件 ≤300 行（§8.1 组件清单已按此拆分）

**本文与前作的关系**：`phase1-uiux.md` 定「为什么这样设计」，本文定「具体写成什么样」。冲突时以 **spec.md > 架构 §8 > 本文 > phase1-uiux.md** 为序。

---

## 1. 主工作台三栏（≥1024）

### 1.1 像素级尺寸表

| 区域 | 展开尺寸 | 折叠尺寸 | 背景 | 边框 | 内边距 |
|---|---|---|---|---|---|
| 顶栏 | `h-12`（48px） | — | `bg-bg-secondary` | `border-b border-border` | `px-3` |
| **左栏 会话列表** | `w-60`（240px） | `w-11`（44px） | `bg-bg-secondary` | `border-r border-border` | header `px-3`，列表 `px-2` |
| **中栏 Agent 对话流** | `flex-1 min-w-[520px]` | — | `bg-bg-primary` | 无 | 消息 `px-4 py-3` |
| **右栏 Inspector** | `w-[420px]` | `w-11`（44px） | `bg-bg-secondary` | `border-l border-border` | `px-3` |
| 状态栏 | `h-7`（28px） | — | `bg-bg-secondary` | `border-t border-border` | `px-3` |
| 移动 TabBar | `h-14`（56px）+ safe-area | — | `bg-bg-secondary` | `border-t border-border` | — |

- 每个栏位：`<aside|section class="flex min-h-0 flex-col">`，header 统一 `h-9`（36px，`shrink-0`，沿用既有 `ChatPanel` header 高度）。
- 硬分割一律 `1px border-border`（IDE 窗格语言），**不用阴影分组**。

### 1.2 折叠为 44px 图标轨的触发条件（可执行判定）

```ts
// layoutStore.ts —— 初始值，用户手动折叠后优先
function initialLayout(w: number) {
  return {
    leftCollapsed: false,               // 左栏默认不折叠（会话列表优先级高于 Inspector）
    rightCollapsed: w >= 1024 && w < 1280,  // ← 关键：1024–1279 时 Inspector 初始折叠
  };
}
// 理由：1024px 下 240 + 420 = 660，中栏只剩 364px < 520px 下限；
//       折叠右栏后 240 + 44 = 284，中栏得 740px，满足下限。
```

| 视口 | 左栏 | 右栏 | 说明 |
|---|---|---|---|
| `< 768` | 隐藏（走 TabBar） | 隐藏 | 单栏 |
| `768–1023` | 抽屉 `w-72` | 抽屉 `w-[420px] max-w-[90vw]` | 覆盖层，不挤压中栏 |
| `1024–1279` | 240 展开 | **44 Rail（初始）** | 中栏得 740px |
| `≥ 1280` | 240 展开 | 420 展开 | 中栏得 620px，仍 ≥520 |

- 手动折叠优先于视口规则；状态持久化 `localStorage['codelens.layout'] = { leftCollapsed, rightCollapsed }`。
- 折叠动画：`transition-[width] duration-250 ease-[var(--c-ease-standard)]`；`prefers-reduced-motion` 下由 Token 自动归零（`--c-motion-base: 0ms`）。
- **Rail 内容**（44px 宽，图标垂直排列，每项 `h-11 w-11 grid place-items-center`）：
  - 左 Rail：`Plus 20`（新建会话）+ 会话首字圆标列表（`h-8 w-8 rounded-full bg-bg-tertiary text-xs`）。
  - 右 Rail：`PanelRight 20`（展开）+ `Wrench 16`（工具详情）/ `Gauge 16`（上下文）/ `Bookmark 16`（记忆），选中项 `bg-accent-subtle text-accent`。

### 1.3 滚动容器（三个独立滚动区）

```tsx
// 中栏（唯一主滚动区）
<section className="flex min-w-0 flex-1 flex-col bg-bg-primary">
  <header className="flex h-9 shrink-0 items-center gap-2 border-b border-border px-3" />
  <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
    <ConversationStream />
  </div>
  <div className="shrink-0 border-t border-border bg-bg-primary px-3 py-2">
    <ContextUsageBar />        {/* §5.1 输入区上方那条 */}
    <PendingApprovalHint />    {/* §3.6「N 个操作待确认」 */}
    <ChatInput />
  </div>
</section>
```

- 三条纪律：① 三栏各自 `min-h-0` 否则 `overflow-y-auto` 失效；② 工具卡内 JSON 区 `overflow-x-auto` 且父级 `min-w-0`，**卡片永不横向滚动**；③ 工具卡就地展开时**强制锁定自动滚动并把该卡滚入视口**（不是滚到底）。

### 1.4 中栏：Segment 结构 → DOM

```ts
// types/index.ts（架构 C-6）
export type Segment =
  | { type: 'text';   text: string }
  | { type: 'tool';   callId: string }        // ← 只存 id，卡片数据在 toolCallStore.byId
  | { type: 'notice'; notice: ContextNotice };

export interface Message {
  // ...既有字段保留
  content: Segment[];                          // ← 由 string 扩展而来
}
```

> **为什么 tool segment 只存 `callId`**：SSE 事件（`tool_call`/`tool_progress`/`tool_result`）只更新 `toolCallStore.byId[callId]`，不重写 `segments` 数组——否则每帧都要做一次数组拷贝 + 全量 re-render。这是本次改造最关键的一条性能纪律。

**一条 assistant 消息的组织顺序**（自上而下固定四层）：

```tsx
<article data-role="assistant" className="flex flex-col gap-2 px-4 py-3">
  ① <ReasoningLine />        {/* 思考摘要一行；无 reasoning 事件则不渲染 */}
  ② {segments.map(render)}   {/* 文本段 ↔ 工具卡 ↔ notice 按时序交替 */}
  ③ {isStreaming && <StreamCaret />}   {/* 只在最后一个文本段末尾 */}
  ④ {status === 'done' && <TaskCostFooter />}   {/* §5.3 任务结束成本 */}
</article>
```

| 层 | 组件 | 渲染规则 |
|---|---|---|
| ① **思考摘要一行** | `ReasoningLine` | 折叠态：`[Brain 16 text-text-tertiary] 思考过程 · 1,284 字 [ChevronRight 16]`；展开态追加 `<pre className="whitespace-pre-wrap text-sm text-text-secondary">`。流式期间显示 `正在思考…` + `.dot-pulse`；收到首个 `delta` 或 `tool_call` 时自动折叠（`duration-150`）。整行是 `<button aria-expanded>` |
| ② **工具时间线** | `ToolCallCard` / `ToolCallGroup` | 卡片间 `gap-2`（8px）；`iteration` 变化时上方 `mt-4 border-t border-border-subtle pt-4`（**不用左侧竖线、不用 01/02 编号**）。工具执行期间该卡**上方**一行 `text-xs text-text-secondary` + `Loader2 16`：「正在调用 HTTP 请求…」 |
| ② **文本段** | `MarkdownContent` | `text-md leading-relaxed text-text-primary`；caret 只跟最后一段，**工具卡段不显示 caret** |
| ③ | `.stream-caret` | 既有类名，不加改动 |
| ④ | `TaskCostFooter` | 见 §5.3 |

用户消息：`max-w-[85%] self-end rounded-lg bg-bg-tertiary px-3 py-2 text-md`。

---

## 2. 工具调用卡片（核心）

### 2.1 卡片骨架与尺寸

```
┌─ 卡片 rounded-md border border-border bg-bg-secondary ──────────────────┐
│ ⑩ 第 3 轮                                    ← 组头行（仅该轮首卡，text-xs tertiary）│
│ ┌ HEADER h-8 px-2 ─────────────────────────────────────────────────┐  │
│ │ ①[Globe] ②http.request ③[内置] ④[高]  ml-auto ⑤[CircleCheck]成功 ⑥+1.2s ⑦1.2s ⑧[⌄] │
│ └──────────────────────────────────────────────────────────────────┘  │
│ ⑨ 200 · 2,031 字节                     ← 次行，仅折叠态（text-xs secondary）│
│ ┌ 参数区 border-t border-border-subtle px-2 py-2 ──────────────────┐  │
│ ┌ 结果区 border-t border-border-subtle px-2 py-2 ──────────────────┐  │
│ ┌ 错误区 border-t border-border-subtle bg-{sem}-subtle px-2 py-2 ──┐  │
└───────────────────────────────────────────────────────────────────────┘
```

整卡 `rounded-md`（8px，卡片圆角上限 12px）；**不整卡染语义色**（失败只在图标与错误区用语义色，主体保持 `bg-bg-secondary` + `border-border`）。

### 2.2 HEADER 十字段逐项规格

| # | 字段 | 图标（尺寸） | Token 类名 | 内容规则 |
|---|---|---|---|---|
| ① | **类别图标** | `Globe` / `FileText` / `FilePen` / `FolderOpen` / `Calculator` / `Clock` / `Fingerprint` / `Braces` / `TextQuote` / `Plug`（**16**） | `shrink-0 text-text-secondary` | 按 `tool_call.category`（`http`/`file`/`compute`/`mcp`）映射；`file` 按 name 细分（read→`FileText`、write→`FilePen`、list→`FolderOpen`）；`compute` 按 name 细分。未知类别兜底 `Wrench` |
| ② | **工具标识符** | — | `font-mono text-sm text-text-primary truncate max-w-[40%]` | **规范名（点号）**：`http.request` / `mcp.filesystem.read_file`。超长 `truncate` + `title` 全量。**绝不显示线上名**（下划线） |
| ③ | **来源徽标** | — | `shrink-0 rounded-sm px-1.5 py-0.5 text-xs`；内置 `bg-bg-tertiary text-text-secondary`，MCP `bg-accent-subtle text-accent` | 内置文案 `内置`；MCP 文案 = server 名（`filesystem`），`max-w-24 truncate` |
| ④ | **风险徽标** | — | `shrink-0 rounded-sm px-1.5 py-0.5 text-xs`；中 `bg-warning-subtle text-warning`，高 `bg-danger-subtle text-danger` | **`risk === 'low'` 时不渲染**（徽标的信号价值来自稀缺性）。文案 `中` / `高` |
| ⑤ | **状态** | 见 §2.3（**16**） | 图标语义色 + 同伴 `text-xs` | **图标 + 文字双通道**：`成功`/`执行中`/`待确认`/`失败`/`超时`/`已拒绝`/`已跳过`。不靠颜色单独传达 |
| ⑥ | **相对时间戳** | — | `font-mono text-xs text-text-tertiary tabular-nums` | `+1.2s` = `(call.startedAt - message.createdAt)/1000`，1 位小数；未开始 `—` |
| ⑦ | **耗时** | — | `font-mono text-xs text-text-secondary tabular-nums` | `<1000ms`→`38ms`；`<60s`→`1.2s`；`≥60s`→`1m 12s`；未结束 `—` |
| ⑧ | **折叠箭头** | `ChevronRight` / `ChevronDown`（**16**） | `shrink-0 text-text-tertiary` | 整行是 `<button aria-expanded>`；`Enter`/`Space` 等价 |
| ⑨ | **结果摘要**（次行，仅折叠态） | — | `text-xs text-text-secondary truncate`；有 error 时改 `text-danger` / `text-warning` | 服务端 `tool_result.summary`，**前端原样渲染不做二次拼装**；无 summary 时回落 `error.message` |
| ⑩ | **所属轮次**（组头行） | — | `text-xs text-text-tertiary` | `第 {iteration} 轮`；仅当 `iteration` 与前一张卡不同时出现，组内不重复 |

**布局**：①②③④ 左对齐 `gap-2`；⑤⑥⑦⑧ 用 `ml-auto` 推到右侧 `gap-2`。⑧ 是最右端。

### 2.3 七态状态机（逐态规格）

| status | 中文 | 图标（16） | 图标 Token | 参数区 | 结果区 | 错误区 | 整卡 | **计入「未成功数」** |
|---|---|---|---|---|---|---|---|---|
| `pending` | 待确认 | `Circle` | `text-text-tertiary` | **展开** | 空占位行 `等待执行…` | — | 默认 | 否 |
| `running` | 执行中 | `Loader2` + `animate-spin` | `text-accent` | **展开** | `tool_progress.message` 或 `等待响应…` | — | 默认 | 否 |
| `success` | 成功 | `CircleCheck` | `text-success` | **折叠** | 预览 + 展开 | — | 默认 | 否 |
| `failed` | 失败 | `CircleX` | `text-danger` | **展开** | 空 | **显示**（danger） | 默认 | **是** |
| `timeout` | 超时 | `Clock` | `text-warning` | **展开** | 空 | **显示**（warning） | 默认 | **是** |
| `rejected` | 已拒绝 | `Ban` | `text-text-secondary` | **展开** | 空 | 一行中性提示 `已由你拒绝，未执行` | 默认 | 否（用户主动决策，不是错误） |
| `skipped` | 已跳过 | `CircleSlash` | `text-text-tertiary` | **折叠** | 空 | 一行注脚 `此步已被跳过 · 原因：从第 2 步重跑` | **`opacity-60`** | **否（明确）** |

**「未成功数」口径**（唯一定义，前端/汇总行/Inspector 共用）：

```ts
const failures = calls.filter(c => c.status === 'failed' || c.status === 'timeout').length;
// 汇总行文案：本轮 14 次调用 · 3 次未成功 · 12.4s
```

> `timeout` 与 `failed` 视觉分色但**同计入未成功数**（都是「没拿到结果」，用户关心这个）；`rejected` 与 `skipped` 是人为决策，**不计入**（误计会让「我拒绝了 3 次」看起来像「Agent 错了 3 次」，是错误归因）。
> `running` 用 spinner 不用骨架屏（骨架屏承诺了错误的未来：工具结果形状未知）。`prefers-reduced-motion` 下 spinner 停转但**状态不丢**——改显示文字 `执行中…3.2s`（数字递增代替旋转）。

### 2.4 参数区

```tsx
<div className="border-t border-border-subtle px-2 py-2">
  <div className="mb-1 flex items-center gap-2">
    <span className="text-xs text-text-tertiary">参数</span>
    <CopyButton text={maskedJson} className="ml-auto" />
  </div>
  <JsonBlock lines={lines} collapsed={shouldCollapse} totalLines={M} />
</div>
```

| 规则 | 实现 |
|---|---|
| 序列化 | `JSON.stringify(args, null, 2)`（2 空格缩进） |
| 折叠阈值 | `lines.length > 12 \|\| raw.length > 800` → 折叠 |
| 折叠态 | 前 12 行 + 末行 `… 省略 {M-12} 行（共 {M} 行）`（`font-mono text-xs text-text-tertiary`）+ `[展开全部]` |
| 展开态 | 完整 JSON，`max-h-[60vh] overflow-auto`，不二次折叠 |
| 语法高亮 | 复用 `.hljs-*`（`--c-syntax-*`），`language-json` |
| **密钥脱敏** | key 正则 `/(key\|token\|secret\|password\|authorization\|apikey\|api_key\|access[_-]?token)/i`（大小写不敏感）；命中 → 值渲染为 `••••••` + 行尾 `EyeOff 12px`，`title="已脱敏，点击显示原始值"`；点击切换 `Eye` 显示原始值，再点复位。**每张卡片的显示状态不跨卡共享** |
| **复制行为** | 主 `CopyButton` 复制**脱敏后** JSON（默认安全）；字段被手动展开后，该字段旁出现独立的小 `[复制原始值]` 按钮。复制原始值属显式操作 |
| 空参数 | `{}` → `无参数`（`text-xs text-text-tertiary`），不留空行 |
| 非对象参数 | MCP 可能传纯字符串 → `<pre className="font-mono text-code whitespace-pre-wrap">`，不强制包 JSON |
| 超长单值 | 单个字符串 > 200 字符 → 该值截断为前 200 + `… [展开该值]`，不影响其余排版 |

**`CopyButton` 时序**：`idle <Copy 16>` → 点击 → `<Check 16 className="text-success">` → `setTimeout(1500)` → 复位。切换用 `transition-colors duration-150`，**不做 scale 弹跳**。命中区 `className="-m-3.5 grid h-11 w-11 place-items-center"`（44×44，视觉仍是 16px 图标）。桌面 hover 显现：`opacity-0 group-hover:opacity-100 focus-visible:opacity-100`；触屏常驻 `opacity-100`。

### 2.5 结果区

```
┌ 结果 ──────────────────── [Copy 16] [Download 16（仅落盘）] ┐
│ 响应体 · application/json · 2,031 字符        ← 语义标签 text-xs tertiary │
│ { "code": 0, "data": [ ...                    ← font-mono text-code      │
│ … 省略 1,284 字符（共 2,031）   [展开全部]                              │
└──────────────────────────────────────────────────────────────┘
```

**行边界回退（最容易写错的一段）**：

```ts
// lib/tool-preview.ts
export function inlinePreview(text: string, limit = 500): string {
  if (text.length <= limit) return text;
  const cut = text.slice(0, limit);
  const lastNl = cut.lastIndexOf('\n');
  // 回退下限 60%：单行 3000 字符的 minified JSON 若强制回退到行边界会得到空串
  return lastNl > limit * 0.6 ? cut.slice(0, lastNl) : cut;
}
```

| 规则 | 实现 |
|---|---|
| 内联预览 | 500 字符，**按行边界回退**（下限 60%） |
| 落盘阈值 | `bytes > 2048` → 服务端写 `tool_results.artifact_path`，前端不内联完整内容 |
| **落盘文案** | `已截断 · 完整结果已保存到 workspace/artifacts/result_7f3a.json（12.4 KB，可下载）` + `[下载为文件]`（`Download 16`）+ `[在检视器中打开]`（`ExternalLink 16`） |
| 省略提示行 | `… 省略 1,284 字符（共 2,031）`（`font-mono text-xs text-text-tertiary`）+ `[展开全部]` |
| >10,000 字符 | 展开区顶部一行 `[TriangleAlert 16 text-warning] 结果较大（约 12.4k tokens），已占用较多上下文` |
| 三种形态 | JSON → 复用 `JsonBlock`；纯文本 → `<pre className="font-mono text-code">`（**不智能折行**，代码类结果折行破坏可读性）；落盘 → 不内联 |

**语义标签表**（必须带，否则用户分不清这是响应体还是文件内容）：

| 结果来源 | 标签格式 |
|---|---|
| HTTP | `响应体 · {contentType} · {n} 字符` |
| 文件 | `文件内容 · {path} · {n} 行` |
| 计算 / 系统 | `计算结果` |
| MCP | `工具返回 · {content[0].type}` |
| 落盘 | `完整结果已保存 · {bytes}` |

### 2.6 错误区（五层）

```tsx
<div className="border-t border-border-subtle bg-{semantic}-subtle px-2 py-2">
  {/* 第 1 层：分类标签 + 错误码 */}
  <div className="flex items-center gap-2">
    <span className="rounded-sm bg-{semantic}-subtle px-1.5 py-0.5 text-xs text-{semantic}">{分类标签}</span>
    <code className="font-mono text-xs text-text-tertiary">{error.code}</code>
  </div>
  {/* 第 2 层：人话原因 */}
  <p className="mt-1 text-base text-text-primary">{error.message}</p>
  {/* 第 3 层：上下文 */}
  <p className="mt-1 text-sm text-text-secondary">{context}</p>
  {/* 第 4 层：下一步建议 */}
  <p className="mt-1 text-sm text-text-secondary">建议：{error.suggestion}</p>
  {/* 第 5 层：恢复动作 */}
  <div className="mt-2 flex flex-wrap gap-2">{actions}</div>
</div>
```

**主索引用 `error.kind`，不用 `error.code`** —— `code` 只是 mono 展示串，`kind` 才是分类键。这样架构新增错误码时前端不崩（走兜底分支）。

> **`kind` 已由架构锁定 10 值**（2026-10-22 裁决），下表是**实现口径**，不要自行增删。
> 相比本文初稿的三处修正：① 去掉 `payload_too_large`（结果超限走 `tool_result.truncated=true` 标志位，请求体过大是 HTTP 413 不产生 `tool_result`，放进枚举会是永不出现的分支）；② `forbidden` 并入 `security`（AC-07 原文即「被安全策略拒绝」）；③ 补 `circuit_open`。

| `kind` | 分类标签 | 语义色 / Token | 恢复动作 | 上下文行示例 |
|---|---|---|---|---|
| `invalid_args` | 参数不合法 | danger / `text-danger` | `[改参数重试]`（**不可重试**，不消耗重试预算） | `{field} 校验未通过：{reason}`（字段级） |
| `not_found` | 工具或目标不存在 | warning / `text-warning` | `[换工具]` / `[换路径]`（**不可重试**，不消耗预算） | `找不到 {target}`；工具名幻觉时后端已回喂可用工具列表 |
| `security` | 被安全策略拒绝 | danger / `text-danger` | **无**（不给绕行建议） | `{tool} 未获得执行授权` / `路径 {p} 超出允许的文件根目录` / `目标域名 {h} 不在 HTTP 白名单内`。**必须注明「同一目标本任务内不再重试」**（AC-07） |
| `timeout` | 执行超时 | warning / `text-warning` | `[重试]`（`RotateCcw 16`）/ `[换参数]` | `http.request 已连续失败 2 次` |
| `rate_limit` | 上游限流 | warning / `text-warning` | `[稍后重试]`（N 秒后启用 + 倒计时） | `已触发调用频率限制，{N}s 后可重试` |
| `network` | 网络不可达 | warning / `text-warning` | `[重试]`（**仅幂等方法可自动重试**） | `无法连接到 {host}` |
| `upstream` | 上游服务错误 | danger / `text-danger` | `[重试]`（5xx）/ `[检查 Key]`（401·403 **不可重试**） | `{provider} 返回 {status}` |
| `mcp` | MCP 服务异常 | warning / `text-warning` | `[重试]` / `[重连 Server]` | `MCP 服务器 {server} 未连接，重连后可用` |
| **`circuit_open`** | **工具已熔断** | **neutral / `text-text-secondary`** | `[换工具]`（**不触发 LLM 调用**） | `{tool} 已连续失败 3 次，本任务内已熔断` |
| `internal` | 内部错误 | danger / `text-danger` | **无**（`[查看堆栈]` 折叠在高级区） | `{tool} 内部异常` |
| **兜底（未知 kind）** | 执行失败 | danger / `text-danger` | `[重试]` | — |

**`circuit_open` 用 neutral 不用 danger（唯一例外，务必照做）**：熔断是保护机制不是故障，染红会让用户以为工具坏了。语义色 `text-text-secondary`，图标 `Ban 16`，**错误区不显示「建议」层**（没有可建议的，只有换工具）。

**重试预算口径**（与 §2.3「未成功数」区分：`invalid_args` / `not_found` / `circuit_open` / `internal` / `security` **不消耗任务级重试预算**，因为重试必然失败；`timeout` / `rate_limit` / `network` / `upstream`(5xx) / `mcp` 消耗预算）。UI 上不显示预算计数，但「重试」按钮的可用性由后端 `error.retryable` 决定，前端**不自行推断**。

**重试行为**：① 重试 = 同参重试，不重新让模型决策；② 成功后卡片底部追加 `重试 1 次后成功`（`text-xs text-success` + `CircleCheck 16`），**保留前一次失败记录**；③ 同卡上限 3 次，超出按钮 disabled + `已重试 3 次`。

### 2.7 多轮组织规则（可执行判定）

```ts
// lib/tool-grouping.ts —— 输入：本条 assistant 消息内按序的 tool 卡；输出：渲染块
export function buildToolBlocks(calls: ToolCallVM[]): ToolBlock[] {
  const blocks: ToolBlock[] = [];
  let i = 0;
  while (i < calls.length) {
    let j = i;
    while (j + 1 < calls.length && calls[j + 1].name === calls[i].name) j++;
    const run = calls.slice(i, j + 1);
    if (run.length >= 3) blocks.push({ kind: 'group', toolName: run[0].name, calls: run });
    else run.forEach((c) => blocks.push({ kind: 'single', call: c }));
    i = j + 1;
  }
  return blocks;
}
```

| 规则 | 判定 / 呈现 |
|---|---|
| **1 同工具连续合并** | 同名**连续** ≥3 次 → 组。中间插入任何不同名调用即断流。组头：`[Globe 16] http.request × 3 · +2.1s · 2.1s [ChevronRight]`；组内每行 `h-6`（24px）：`[状态点 6px rounded-full] GET /api/orders · 200 · 0.8s · +2.1s`。默认折叠 |
| **2 异工具不合并** | 不同名各自独立成卡（换工具 = 意图切换，合并会抹掉这个信号） |
| **3 轮次边界用间距表达** | `iteration` 变化时上方 `mt-4 border-t border-border-subtle pt-4`。**不用左侧竖线、不用编号标签** |
| **4 单轮折叠阈值** | 本轮调用总数 > 8 → 整轮折叠为一行：`本轮 14 次调用 · 3 次未成功 · 12.4s [展开]`（数字 `font-mono tabular-nums`） |
| **5 跨轮绝不合并** | 分组算法只在单条消息内跑，天然不跨轮 |
| **6 组内不就地展开** | 点击组行 → `openInspector(callId)`，**不在对话流内逐条展开 JSON**。**单卡（非组）仍可就地展开** |
| **7 显示间隔** | 相邻两 block 若 `next.startedAt - prev.endedAt > 1000ms` → 中间插一行 `间隔 3.4s`（`font-mono text-xs text-text-tertiary`） |

**组头状态图标**：全成功 → `CircleCheck`；含 failed → `CircleX`；含 timeout → `Clock`；含 rejected/skipped → `Ban`/`CircleSlash`。取最严重者。

---

## 3. inline 审批条（AC-04 / AC-06）

### 3.1 三档强度视觉分级

| 档 | `approvalMode` | 形态 | 容器 Token | 边框 | 图标 | 位置 |
|---|---|---|---|---|---|---|
| 无 | `none` | 直接执行 | — | — | — | — |
| **软** | `soft` | 执行后 **30 秒撤销横幅** | `bg-bg-tertiary` | `border-t border-border` | `Undo2 16 text-text-secondary` | 中栏底部、输入区之上（`shrink-0`） |
| **硬** | `hard` | **就地 inline 确认条** | `bg-warning-subtle` | `border border-warning` | `TriangleAlert 16 text-warning` | 对话流内、卡片上方（**内嵌于卡片容器，不是独立卡片**） |
| **两步** | `two_step` | 硬确认条 + **勾选框** | 同硬档 | 同硬档 | 同硬档 | 同硬档 |

**两步 vs 硬档的区分（不新增颜色、不做彩色顶边）**：① 头部追加徽标 `不可逆`（`bg-danger-subtle text-danger text-xs rounded-sm px-1.5 py-0.5`）；② 追加勾选框；③ 主按钮文案由 `允许一次` 变为 `我已审阅参数并接受风险，允许一次`。

**软确认撤销横幅（30s）**：

```tsx
<div className="flex h-11 shrink-0 items-center gap-2 border-t border-border bg-bg-tertiary px-3">
  <Undo2 size={16} className="shrink-0 text-text-secondary" />
  <span className="min-w-0 flex-1 truncate text-sm">已写入 workspace/report.md</span>
  <button className="shrink-0 text-sm font-medium text-accent">撤销 {remain}s</button>
</div>
{/* 2px 进度条：transform 不用 width（Spec §10 禁动画 width/height） */}
<div className="h-0.5 bg-bg-tertiary">
  <div className="h-full origin-left bg-accent transition-transform duration-[30000ms] ease-linear"
       style={{ transform: `scaleX(${expired ? 0 : 1})` }} />
</div>
```

- `useEffect` 里 `requestAnimationFrame(() => setExpired(true))` 触发动画；1s `setInterval` 更新倒计时数字。过期自动消失（**不弹提示**）。
- `prefers-reduced-motion` 下进度条不动画，只保留倒计时数字。

### 3.2 硬确认条内部布局（六行）

```
┌─ inline 确认条 rounded-md border border-warning bg-warning-subtle ────────┐
│ 行1 [TriangleAlert 16 text-warning] 高风险操作需要你的确认                  │
│     [不可逆]（仅 two_step）                        [剩余 4:32] mono text-xs│
│ 行2 HTTP 请求 将向 api.stripe.com 发起 POST 请求        ← 目标（displayName + 动作）│
│ 行3 目标域名不在 HTTP 白名单内 · 影响范围：创建真实订单  ← 影响范围 + 为何拦下   │
│ 行4 [查看完整参数（3 项）]  ← 就地展开，不跳 Inspector                      │
│     └ 展开后：参数 JSON（复用 JsonBlock，脱敏规则同 §2.4）                  │
│ 行5 [Checkbox] 我已审阅参数并接受风险        （仅 two_step，原生 input[type=checkbox]） │
│ 行6 [拒绝]  [允许一次]  [本次会话始终允许]                                  │
└──────────────────────────────────────────────────────────────────────────┘
```

- 文案三要素：**工具 + 动作 + 影响范围**。禁止「是否允许执行？」。参数来自 **服务端下发的 `tool_approval_required.arguments`**，不是前端缓存（服务端持有原则）。
- 每个动作按钮 `min-h-11 px-3 text-base rounded-md`，间距 `gap-2`（8px）。

| 动作 | 样式 | 请求 body | 行为 |
|---|---|---|---|
| **拒绝** | `rounded-md border border-border bg-bg-tertiary text-danger` | `{ token, decision: 'reject', reason? }` | 点击后原地替换为 `[输入原因…] [确认拒绝]`（原因可选，作 observation 回喂模型；模型不得对同一 (工具, 参数) 再次发起）。**不乐观更新** |
| **允许一次** | `rounded-md bg-accent text-text-on-accent` | `{ token, decision: 'allow_once' }` | 执行本次，该工具下次仍需审批。**不乐观更新** |
| **本次会话始终允许** | `rounded-md border border-border bg-bg-tertiary text-text-primary` | `{ token, decision: 'allow_session' }` | 执行 + 本会话免审批；会话列表该行显示 `ShieldCheck 16`（tooltip「本会话已记住 2 条授权」） |

- 请求一律 `POST /api/v1/approvals/:id`，**body 只含 `{ token, decision, reason? }`，绝不回传工具名与参数**（架构 C-4）。
- `approvalId` 取 `tool_approval_required.approvalId`。

### 3.3 令牌过期（5 分钟）

| 剩余 | 表现 |
|---|---|
| `> 60s` | `剩余 4:32`（`font-mono text-xs text-text-secondary`），1s `setInterval` 更新 |
| `≤ 60s` | 转 `text-warning` |
| `≤ 10s` | 转 `text-danger` |
| **已过期** | 三个按钮全部 `disabled`；行 1 文案替换为 `确认已过期，此调用已取消`（`text-sm text-text-secondary`）；**确认条本身保留在原地不清空** |

> **过期不可静默**：静默会让用户以为还在等批准。保留条 + 明确文案，用户回来看得到发生过什么。卡片转 `rejected` **由服务端在原 SSE 流上推 `tool_result{status:'rejected'}` 驱动**，前端不做乐观更新。

### 3.4 焦点与打断纪律

- **不抢焦点**：出现时不调用 `focus()`。
- **不弹窗**：独立 Modal 会破坏上下文（"The gate must live inside the prompt surface"）。
- **不滚动**：审批条出现不触发任何自动滚动。
- **输入框上方常驻提示行**：`[TriangleAlert 16 text-warning] 1 个操作待确认`（`text-xs`），多个显示 `N 个操作待确认`。**点击该行才滚动**到第一条待确认条（用户主动）。
- **键盘**：按钮在 DOM 中位于对话流内，`Tab` 自然可达；`Enter`/`Space` 触发。**`Esc` 不等于拒绝**（避免误触改变 Agent 走向）。
- **无障碍**：出现时 `aria-live="assertive"` 播报一次「有 1 个高风险操作需要确认」，不重复播报。

### 3.4.1 审批回执的错误处理（对齐架构 §3.3.12 校验链）

`POST /api/v1/approvals/:id`（提交决定）与 `POST /api/v1/approvals/:id/revise`（改参数）共用下面这张表——**两档失败都不能只弹一个通用 Toast**，每一档对应的用户动作不同：

| 响应 | 场景 | UI 呈现 | 用户动作 |
|---|---|---|---|
| `200` | 成功 | **什么都不做**——卡片终态由服务端在原 SSE 流上推 `tool_result` 驱动 | 等待 |
| `404 APPROVAL_NOT_FOUND` | 审批记录不存在（会话已删） | 确认条内 `此审批已失效` + 按钮全 disabled | 关闭 |
| `409 APPROVAL_ALREADY_DECIDED` | 重复提交（双击 / 多标签页） | 确认条内 `该操作已处理过` + 按钮全 disabled | 无（幂等保护，不是错误） |
| `410 APPROVAL_EXPIRED` | 令牌 5 分钟过期 | 确认条内 `确认已过期，此调用已取消`（`text-sm text-text-secondary`）+ 按钮全 disabled | 关闭 |
| `409 APPROVAL_TOKEN_MISMATCH` | 令牌不匹配 | **danger 区**：`[TriangleAlert 16] 校验未通过，本次操作已取消。已连续异常 {mismatch_count} 次` | 见下方熔断 |
| `409 APPROVAL_ARGS_MISMATCH` | 服务端持有的参数已被改写 | **danger 区**：`[TriangleAlert 16] 参数已变更，请重新确认后再执行` + `[重新加载参数]` | 刷新参数区 |
| `409 APPROVAL_NOT_REVISABLE` | 调用已开始执行/已完成，不能再改参数（**仅 revise 端点**） | 确认条内 `该操作已开始执行，无法再修改参数` + `[改参数]` 按钮置灰 | 关闭 |
| `409 APPROVAL_REVISE_LIMIT` | 本调用已改满 3 次（**仅 revise 端点**） | 确认条内 `本操作已修改 3 次，不能再改` + `[改参数]` 按钮置灰 | 只能拒绝或允许 |
| `400 VALIDATION_ERROR` | body 含非法键（如决定端点带了 `arguments`） | **不应发生**（前端绝不能传）；发生即 Toast `请求被拒绝：提交内容非法` + 控制台 error | 提 bug |

- **呈现位置**：404/409-already/410/409-not-revisable/409-revise-limit → 确认条内部（就地，保留上下文）；409-mismatch → 确认条内 `bg-danger-subtle` 区块。
- **熔断提示**：架构 §3.3.12 规定 `mismatch_count` 达 3 次 → 该挑战置 `status='aborted'`。UI 在 1、2 次时显示 `已连续异常 {n} 次（3 次后将锁定）`，第 3 次显示 `该操作已锁定，未执行`（按钮全 disabled）。
- **前端纪律：两个端点的 body 键集合不同，必须分成两个 TS 类型**（team-lead 2026-10-22 裁决：revise 走独立端点）：

| 端点 | body 键集合 | 说明 |
|---|---|---|
| `POST /api/v1/approvals/:id`（决定） | `{ token, decision }` + `reject` 时可选 `reason` | zod `.strict()` **拒收 `arguments`**；decision ∈ `allow_once` / `allow_session` / `reject` |
| `POST /api/v1/approvals/:id/revise`（改参数） | `{ token, arguments }` | **没有 `decision` 键**；`arguments` 是**完整参数对象，不是增量 patch** |

  空 `reason` 必须**整个键省略**（不要传 `reason: ''`）。共用一个 interface 会让决定端点带上 `arguments` → 400。

### 3.5 改参数 = 独立端点 `POST /api/v1/approvals/:id/revise`

**team-lead 2026-10-22 裁决**（架构曾提议改用 `decision: 'revise'` 走同一端点，已作废）：**新开端点**，Spec §5 端点数 21 → 22。形态与限制不变。

```json
{ "token": "t_...", "arguments": { "path": "report.md", "operation": "create" } }
```

**交互流程**：确认条行 4 展开参数 → 底部 `[改参数]`（Secondary）→ 参数区切换为 `<textarea className="font-mono text-code">`（预填 `JSON.stringify(args, null, 2)`）→ 前端 JSON 合法性校验（非法：字段级红框 + `JSON 格式有误`，不发请求）→ 提交 → 按**响应体的 `status` 字段**分支（**不是 HTTP 状态码，三档都是 200**）：

| 响应 `status` | 含义 | UI 动作 |
|---|---|---|
| `reapproval_required` | 新参数仍需确认 | **不要关闭确认条**。响应带 `nextApproval{approvalId, approvalToken, expiresAt, reviseDepth}` + `nextToolCall{toolCallId, callId, arguments, risk, approvalMode}`；服务端同时在原 SSE 流推一个新的 `tool_approval_required`。前端**原地替换 id/token/expiresAt 并重渲染参数区**（风险等级可能变了 → 徽标与确认档位跟着变） |
| `executed_directly` | 改参数后风险降级到 `approvalMode='none'`（典型：POST 改 GET、overwrite 改 create） | **不用再确认，已直接执行** → 确认条收起，原地变成一张**正常工具卡片**（走 `tool_result` 转终态）。**不是继续等** |
| **`rejected`** | **新参数没过服务端校验**（schema 或安全网关） | **这是 200，不是报错**。确认条收起，原地变成一张**失败卡片**，按 §2.6 渲染（`security` kind 用 danger 且**不给绕行建议**；schema 类用 `invalid_args` kind + `[改参数重试]`）。**不要弹「请求失败」Toast**——用户要看到的是「这个参数为什么不行」 |

> **`rejected` 是三档里最容易写错的一档**：它 HTTP 状态是 200，走的是成功回调。若前端按 `catch` 分支处理，用户会看到一个无内容的确认条一直挂着。

**三条边界（UI 必须体现）**：

1. **只能改还没开始执行的调用**（`tool_calls.status === 'pending'`）。卡片进入 `running` 及之后，`[改参数]` 按钮**立即置灰** + `title="该操作已开始执行，无法再修改参数"`。
2. **单个原始调用最多改 3 次**（`reviseDepth`）。确认条行 1 右侧显示 `已修改 {reviseDepth}/3 次`（`font-mono text-xs text-text-tertiary`）；达 3 次后 `[改参数]` 置灰 + `本操作已修改 3 次，不能再改`。
3. **新参数必须重跑 schema 校验 + 安全网关**（SSRF / 路径 jail）。前端的 JSON 校验只是第一道——服务端还会再拒一次，被拒即上面的 `rejected` 分支。

**审计副作用（时间线会看到两张卡片，这是刻意的）**：旧调用转 `status='skipped'`（`CircleSlash 16` + `text-text-tertiary` + 整卡 `opacity-60`，**不计入未成功数**，仍可展开查看），新调用另起一行等待确认。模型最初请求删 A、用户改成删 B——审计必须两者都留。

> `revised` 只在 DB 里出现（被改参数重提的作废行），**永不出现在 SSE 载荷**，前端查表不用管它。

---

## 4. 设置页五分区

### 4.1 容器（改造既有 `SettingsModal`）

```tsx
<Modal open title="设置" width={960}>       {/* 复用 focus trap / Esc / shadow-overlay */}
  <div className="flex h-[560px]">
    <nav className="w-50 shrink-0 space-y-0.5 border-r border-border pr-2">   {/* 200px */}
      {/* 5 个分组项：模型与密钥 / 工具 / MCP 连接器 / 安全边界 / 数据 */}
      {/* 每项 h-9 rounded-md px-2 text-base；选中 bg-accent-subtle text-accent */}
    </nav>
    <div className="min-w-0 flex-1 overflow-y-auto pl-4 pr-1">{/* 内容区独立滚动 */}</div>
  </div>
</Modal>
```

- 分组导航 5 项（≤5 符合认知负荷）。内容区 `max-h-[560px] overflow-y-auto`。
- **即时生效分组**（工具 / MCP / 安全边界 / 数据）**不显示底部保存按钮**；仅「模型与密钥」显示 `[取消] [保存]`。

### 4.2 分区 1 · 模型与密钥

| 控件 | 类型 | 说明 |
|---|---|---|
| LLM Provider | `Dropdown`（复用 `FormControls`） | `GET /api/v1/providers` |
| API Key | `input type={showKey?'text':'password'} font-mono` + `[显示/隐藏]`（`EyeOff`/`Eye`） | hint「仅存于本浏览器 localStorage，会话级有效」 |
| 模型 | `Dropdown`（provider 有 models 时）+ 手动输入兜底 | 带 `capabilities` 字段 |
| 主题 | 三选按钮组（沿用现有 `Monitor`/`Moon`/`Sun`） | |
| 能力探测结果行 | 状态行 | 成功后按 §4.2.1 渲染 |
| `[测试连接]` | Secondary | `Loader2 animate-spin` → 结果行 |

**4.2.1 AC-01 三态结果行**：

| 探测结果 | 呈现 |
|---|---|
| 支持原生 FC | `[CircleCheck 16 text-success] 该模型支持原生 function calling` |
| 不支持（降级） | `[TriangleAlert 16 text-warning] 不支持原生 function calling，将降级为 ReAct 模式解析工具调用` |
| **探测失败**（网络/鉴权） | `[CircleX 16 text-danger] {code}：{message}`（**区别于「不支持」**） |
| 测试中 | `[Loader2 16 animate-spin text-accent] 正在探测…` |

### 4.3 分区 2 · 工具管理

```
组标题 text-base font-medium text-text-primary（HTTP 请求 / 文件读写 / 计算与系统 / MCP 提供的工具）
组内每行 h-11 flex items-center gap-2 px-2 border-t border-border-subtle
  [类别图标 16 text-text-secondary]  [工具标签 text-base]      ← displayName
  [规范名 font-mono text-xs text-text-tertiary]                ← 同行右侧，小字弱化
  [风险徽标 低/中/高]        ← 设置页显示全部三级（卡片只显示中/高）
  [超时 5s]                  ← 可点编辑：inline number input，1–600，越界字段级红框
  ml-auto [Switch 开关] [ChevronRight 16]
```

- 分组顺序：HTTP 请求 / 文件读写 / 计算与系统 / MCP 提供的工具（聚合，只列**已连接** server 的工具）。
- 展开详情（点行）：描述（一句具体行为）/ 参数 schema（折叠 JSON）/ 超时配置 / 失败重试次数（0–3）/ 该工具是否需要审批（toggle）/ `本会话已记住` + 撤销。
- MCP 分组底部常驻：`未连接的 MCP 能力对模型完全不可见 — 不进入工具清单，也不占用提示词预算`（解释机制，不是免责声明）。
- **五态**：Loading = 4 行 `.skeleton h-11`；Empty = 全部禁用 → 说明 + `[全部启用]`；Error = inline 错误 + `[重试]`；Populated = 如上；Edge = 某工具 schema 非法 → 该行 `schema 无效` + 开关禁用（不影响其他行）。

### 4.4 分区 3 · MCP 连接器

> **排期说明（team-lead 2026-10-22）**：MCP 连接器维持 **P1**——Spec §2 措辞已改为「架构/API/UI 已设计完毕，Phase 3 在 P0 跑通后实现」。**本节 UI 规格保留不删**，Phase 3 按排期实现即可。架构侧 6 个 MCP 端点设计同样保留。

每张连接器卡 `rounded-md border border-border bg-bg-secondary p-3`：

```
行1 [Server 16] {server 名 text-base}                              [Trash2 16]
行2 {command} {args}      font-mono text-xs text-text-secondary truncate
行3 [状态点 6px] {已连接|连接中…|未连接} · stdio · 提供 {n} 个工具   [ChevronDown 16]
展开：工具清单（工具名 mono + 描述一行截断 + 建议风险档 + 每工具独立启用开关）
      风险告知：该 server 以你的用户权限运行，工具调用会被记录
      未连接时：stderr 首行（截断 120 字符，font-mono text-xs text-danger）
                + [重试] [查看日志] [编辑配置]
```

**连接状态三态**：

| 状态 | 状态点 | 文案 | 附加 |
|---|---|---|---|
| 连接中 | `bg-text-tertiary` + `Loader2 16 animate-spin` | `连接中…` | — |
| 已连接 | `bg-success` | `已连接` + 徽标 `提供 4 个工具`（`bg-bg-tertiary text-xs`） | 展开工具清单 |
| 未连接 | `bg-text-tertiary` | `未连接` / `连接失败`（失败时） | **stderr 首行**（MCP Inspector 的核心价值：看到 stderr 而不是猜）+ 3 个动作 |

- **「建议风险档」而非直接判定**：MCP server 自报的工具语义不足以精确判定风险，UI 给建议档，用户可逐个上/下调。**默认 `high`，可下调但不得自动调到 `low`**。
- 添加表单（展开式）：`名称*` / `传输方式 stdio（本机进程）`（**灰显不可选** + 说明「当前仅支持本机 stdio 进程」）/ `命令*`（`font-mono`）/ `参数`（每行一个 textarea `font-mono`）/ `环境变量`（每行一个，值默认掩码）/ `[添加并连接]`。
- 删除：`Trash2` → 按钮变 `border-danger bg-danger-subtle text-danger` 显示 `确认删除？` → **4s 无操作自动取消**（复用 `confirmClear` 模式）；提示 `该连接器提供的 N 个工具将一并移除`。
- **五态**：Loading = 连接中 spinner；Empty = `MCP 连接器让 Agent 接入你本机已有的工具` + `[+ 添加 MCP 连接器]`；Error = stderr 首行 + 3 动作；Populated = 如上；Edge = 提供 0 个工具 → `该连接器未提供工具`（保留连接状态）/ 工具 >50 → `展开全部 50 个`。

### 4.5 分区 4 · 安全边界

```
HTTP 允许域白名单
  ┌ 行 h-11: {域名 font-mono} {精确匹配|通配符 徽标}          [Trash2 16] ┐
  └ [+ 添加域名]
  未设置白名单时，所有 HTTP 请求调用都会被拒绝          ← 真实约束陈述，不是占位文案
  始终拒绝：内网与环回地址 · 169.254.169.254 · metadata.google.internal

文件系统根目录（path jail）
  ┌ [FolderLock 16] {path font-mono}                        [编辑] ┐
  Agent 只能读写此目录内的路径，越界的调用会被拒绝并记入运行日志
  符号链接会先解析真实路径再判断，无法用软链接逃逸

单工具超时与重试预算
  ┌ 单工具默认超时 [15] s · 任务级重试预算 [5] 次 · 最大轮次 [12] ┐
```

- 控件清单：域名行（mono + 匹配方式徽标 + `Trash2`）、添加域名输入（`font-mono`）、path 只读 + `[编辑]`、三个 number input（1–600 / 0–10 / 5–30，越界字段级红框）。
- **Empty**：白名单为空 → 上述真实约束陈述。
- **Error**：path 编辑越界 → 字段级红框 + `路径必须是绝对路径且已存在`。
- 每项边界在运行日志中留痕（被拒的越界调用会出现在日志里，用户能看到「Agent 试过越界」）。

### 4.6 分区 5 · 数据管理

```
[Download 16]  导出全部会话为 Markdown
[Database 16]  导出数据库文件
[RotateCcw 16] 用恢复码恢复会话   → 8 位输入（分 2 组：XXXX XXXX，font-mono text-lg tracking-caps，自动大写）+ [恢复]
                                    （单次使用；连错 5 次锁 15 分钟）
─────────────────────────────────────────────
[Trash2 16]    彻底清除（含数据库文件与工作区）   ← danger 区
```

- 彻底清除：`border-danger bg-danger-subtle text-danger` + 4s 二次确认（沿用既有 `confirmClear` 模式）。
- **Error**：`恢复码无效或已被使用`（danger）；`连续错误 5 次，请 15 分钟后重试`。
- 首次创建会话返回的 8 位恢复码**只此一次明文**展示 → 用 `rounded-md border border-border bg-bg-inset p-3 font-mono text-lg tracking-caps` 居中展示 + `[已复制]`（`CopyButton`）。

---

## 5. 上下文与成本显示（AC-11）

### 5.1 三个同源位置（一个 `pct` 驱动）

| 位置 | 形态 | 规格 |
|---|---|---|
| **顶栏右段（主，常驻）** | `[上下文] [2px 条 w-20] [12.4k / 128k]` | 条：`h-0.5 w-20 rounded-full bg-bg-tertiary`；数字 `font-mono text-xs tabular-nums` |
| **状态栏中段** | `上下文 34%` | `font-mono text-xs text-text-secondary` |
| **输入区上方** | `上下文 12.4k / 128k · 34%` + 全宽 2px 条 | 条 `h-0.5 w-full rounded-full bg-bg-tertiary`；`px-1 pb-1` |

**阈值变色**（`className` 切换，不写 inline color）：

```tsx
className={cn('h-full rounded-full transition-[width] duration-250',
  pct > 88 ? 'bg-danger' : pct > 75 ? 'bg-warning' : 'bg-accent')}
```

- `pct > 98` → 输入区上方追加一行 `[TriangleAlert 16 text-warning] 上下文已满，新消息会触发压缩`（`text-xs text-warning`）。
- 无障碍：`<div role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label="上下文占用">`。
- 数字格式：`(n/1000).toFixed(1) + 'k'`；**用 `tabular-nums` 防抖动**。

### 5.2 `context_notice` 内联提示条

```tsx
<div className="mx-4 my-2 rounded-md border border-border bg-bg-tertiary px-3 py-2">
  <div className="flex items-center gap-2">
    <Shrink size={16} className="shrink-0 text-text-secondary" />
    <span className="text-sm text-text-primary">{主文案}</span>
    <button className="ml-auto text-xs text-accent">查看详情</button>
  </div>
  <p className="mt-0.5 text-xs text-text-secondary">{副文案}</p>
</div>
```

**插入位置**：作为 `{ type: 'notice' }` segment **push 到当前 assistant 消息的 segments 末尾**。理由：前端在流式中收到事件时无法反查「第几轮被压缩」，而压缩必然发生在下一轮开始之前——push 到当前位置在视觉上就是「上一轮之后、下一轮之前」，与「在被截断位置插标记」等价。**用 `bg-bg-tertiary` 不用 `warning-subtle`**（压缩是正常机制不是警告）。

| `reason` | 主文案 | 副文案 |
|---|---|---|
| `compacted` | `上下文已压缩 · 18.2k → 9.6k tokens` | `保留了最近 {n} 轮对话与 {m} 条记忆` |
| `truncated` | `较早的 {removedMessages} 条消息已移出上下文` | `最近 {n} 轮对话完整保留` |
| `tool_result_compressed` | `第 {n} 轮的工具结果已压缩` | `完整结果仍可在检视器中查看` |
| `compaction_failed` | `上下文已满，本次未压缩`（`text-warning`） | `新消息可能无法包含较早的对话` |

`[查看详情]` → 打开 Inspector「上下文」分段。

### 5.3 任务结束 Token 成本

位置：**最后一条 assistant 消息底部**（`<TaskCostFooter />`，`mt-2 border-t border-border-subtle pt-2`）。

```tsx
<div className="flex items-center gap-1.5 font-mono text-xs text-text-tertiary tabular-nums">
  <Coins size={16} />
  本次任务 · {iteration} 轮 · {toolCallCount} 次调用 · {elapsed}s
  {usage && ` · ${fmtTokens(usage.promptTokens)} 输入 / ${fmtTokens(usage.completionTokens)} 输出 tokens`}
</div>
```

数据来源：`done.{iteration, toolCallCount, usage.{promptTokens, completionTokens}}` + 客户端计时。**无 `usage` 时省略 token 段**（provider 未返回，不要编造数字）。

---

## 6. 移动端与响应式

### 6.1 断点总表

| 档 | 布局 | 导航 | 审批形态 |
|---|---|---|---|
| `≥1280` | 三栏全展开 240 / flex / 420 | 左栏常驻 | inline 确认条 |
| `1024–1279` | 左 240 + 中 flex + **右 44 Rail** | 左栏常驻 | inline 确认条 |
| `768–1023` | 单内容列（中栏全宽）+ **双抽屉** | 顶栏 `PanelLeft 20` / `PanelRight 20` | inline 确认条 |
| `< 768` | 单栏 | 底部 TabBar 三标签 | **底部 ActionSheet** |

### 6.2 平板 768–1023：双抽屉

```tsx
{/* 遮罩：沿用既有 AppShell 写法 */}
<div className="fixed inset-0 z-[var(--c-z-drawer)] bg-black/40 lg:hidden" onClick={close} aria-hidden />
{/* 左抽屉 = 会话；右抽屉 = Inspector（覆盖层，不挤压中栏） */}
<aside className="fixed inset-y-0 right-0 z-[var(--c-z-drawer)] flex w-[420px] max-w-[90vw] flex-col
                 border-l border-border bg-bg-secondary shadow-drag md:flex lg:hidden">
```

- **Inspector 以覆盖层出现，不挤压中栏**——中栏是主轴，压缩它会破坏长回复的阅读连续性。
- `Esc` 关闭（现有 AppShell 已有左抽屉 Esc 逻辑，扩展到右抽屉，存 `uiStore.inspectorOpen`）。
- 工具卡参数区在平板**保持折叠**（宽度不足，展开进 Inspector）。

### 6.3 手机 <768：三 TabBar

```tsx
const TABS = [
  { id: 'chat',     label: '对话', icon: MessageSquare },
  { id: 'tools',    label: '工具', icon: Wrench },
  { id: 'sessions', label: '会话', icon: History },
];
// 容器：shrink-0 border-t border-border bg-bg-secondary pb-[env(safe-area-inset-bottom)] md:hidden
// 每项：flex flex-1 flex-col items-center justify-center gap-0.5（h-14 内，触摸区 56×44+）
// 图标 24px strokeWidth 2；文字text-[10px] leading-none（沿用既有 arbitrary 写法，不新增 Token）
```

- `uiStore.mobileTab` 由 `'code'|'result'|'history'` 改为 `'chat'|'tools'|'sessions'`。
- **「工具」Tab** = 本会话调用清单（工具名 / 状态点 / 耗时 / 时间），点任一条 → 全屏 sheet 展示参数与结果（移动端的 Inspector 等价物）。移动端不适合在对话流里读长 JSON。
- 「对话」Tab 有流式输出时，图标右上角 2px `bg-accent` 圆点（沿用既有写法）。

**审批改底部 ActionSheet**：

```tsx
<div className="fixed inset-x-0 bottom-0 z-[var(--c-z-modal)] rounded-t-lg border-t border-border
                bg-bg-secondary p-4 pb-[calc(1rem+env(safe-area-inset-bottom))] shadow-overlay">
  <div className="mx-auto h-1 w-9 rounded-full bg-border" />   {/* grabber */}
  {/* 与桌面同样的六行内容；按钮纵向排列，每个 h-11 w-full */}
</div>
```

- **按钮纵向顺序（危险程度递减排布）**：`[拒绝]` 在上 → `[允许一次]` 在中 → `[本次会话始终允许]` 在下。把最不容易误触的位置留给范围最大的授权。
- **下滑手势 = 收起但保留 pending，不等于拒绝**（与 v1.2.0 的差异：误滑拒绝不可逆，且拒绝会改变 Agent 走向）。收起后输入框上方显示 `1 个操作待确认`，用户可点回去。
- **触摸目标**：所有可点元素 `min-h-11`（44px）；工具卡内 16px 图标按钮用 `-m-3.5 grid h-11 w-11 place-items-center` 扩命中区。
- **安全区**：ActionSheet 与 TabBar 均 `pb-[calc(1rem+env(safe-area-inset-bottom))]` / `pb-[env(safe-area-inset-bottom)]`。

---

## 7. 空状态与五态覆盖

### 7.1 对话区空状态（禁空洞文案）

```
┌ 新会话（mx-auto max-w-[560px] px-4 py-12）──────────────────────┐
│       4 类工具待命中                        ← text-2xl text-text-primary │
│  HTTP 请求 · 文件读写 · 计算与系统 · MCP 生态接入  ← text-sm secondary   │
│                                                                │
│  试试这几件具体的事：                      ← text-sm text-text-secondary│
│  ┌ [Globe 16] 抓 https://example.com/api/docs 里的接口列表，    │ │
│  │             按方法分类成表格                                 │ │
│  ┌ [FileText 16] 读 workspace/data.csv，算每列均值与标准差，     │ │
│  │             把偏离超过 2σ 的行单独列出                       │ │
│  ┌ [Calculator 16] 用计算工具算 (1234.5*87)/13，                │ │
│  │             给出保留两位小数的结果                           │ │
│                                                                │
│  Enter 发送 · Shift+Enter 换行            ← text-xs text-text-tertiary │
└────────────────────────────────────────────────────────────────┘
```

- 示例卡：`rounded-md border border-border bg-bg-secondary px-3 py-2.5`，整卡 `<button className="min-h-11 w-full text-left">`，hover `border-accent`（`transition-colors duration-150`）。
- 点击 → `setQuestion(text)` 预填输入框，**不自动发送**。
- 标题「4 类工具待命中」是**能力清单**不是欢迎语；三条示例分别是 HTTP / 文件 / 计算三类工具，每条含**具体动作 + 具体目标 + 具体数值**（2σ、两位小数）。第一条刻意选低风险只读任务（抓公开文档），先建立信任。

### 7.2 五态覆盖表

| 区域 | Loading | Empty | Error | Populated | Edge |
|---|---|---|---|---|---|
| **对话区** | 排队等首 token：`.dot-pulse`；工具执行中：卡上方一行 `Loader2 16` + 「正在调用 HTTP 请求…」 | §7.1 空状态（三条真实示例） | 消息级错误卡 `rounded-lg border border-danger bg-danger-subtle p-3`：分类 + 一句原因 + 错误码 + `[重试]` | 文本段 ↔ 工具卡 ↔ notice 交替时序流 + 成本脚注 | 单条消息 >2000 字符 → `展开全文`；单轮 >8 次 → 汇总行；单次结果 >10k 字符 → 顶部 warning 行；`pct>98` → 压缩预告行 |
| **工具卡片** | `pending`/`running`：参数展开 + spinner + 结果区占位 | 无（工具卡不由用户创建，不存在空态） | `failed`/`timeout`：错误区五层，**默认展开**；`timeout` 用 warning，`failed` 用 danger | `success`：参数折叠 + 结果摘要一行 + 复制 | 参数 >12 行/800 字符折叠；结果 >500 字符截断 / >2KB 落盘；单值 >200 字符单独截断；重试 >3 次按钮禁用；`skipped` 整卡 `opacity-60` 但仍可展开 |
| **工具管理区** | 4 行 `.skeleton h-11` | 全部禁用 → 说明 + `[全部启用]` | inline 错误 + `[重试]` | 4 组共 N 个工具，每行图标/标签/规范名/风险/超时/开关 | 某工具 schema 非法 → 该行 `schema 无效` + 开关禁用（不影响其他行） |
| **MCP 区** | 连接中 spinner | `MCP 连接器让 Agent 接入你本机已有的工具` + `[+ 添加]` | stderr 首行 + `[重试][查看日志][编辑配置]` | N 个连接器，含三态/工具数/工具清单 | 提供 0 个工具 → `该连接器未提供工具`；工具 >50 → `展开全部 50 个` |
| **会话列表** | 6 行 `.skeleton` | 说明 + `[新建会话]` | inline 错误 + `[重试]`（不空白） | 列表 + 上下文占用徽标（`font-mono text-xs`，>75% `text-warning`，>88% `text-danger`）+ `ShieldCheck` 授权标记 | 达 20 条上限 → 底部提示「新建会话将淘汰最旧一条」；单会话 >100 条消息 → 提示 + 归档 |

---

## 8. 组件清单与图标总表

### 8.1 组件清单（Phase 3 需新建 / 改造，单文件 ≤300 行）

**新建 · `client/src/components/agent/`**

| 文件 | 职责（一句话） |
|---|---|
| `ConversationStream.tsx` | 一条 assistant 消息内 segments → DOM（思考行 + 文本/工具/notice 交替 + 成本脚注） |
| `ReasoningLine.tsx` | 思考摘要一行（默认折叠，`Brain 16`，收到首个 delta/tool_call 自动收起） |
| `ToolCallCard.tsx` | 工具卡外壳：HEADER 十字段 + BODY 三区调度（参数/结果/错误） |
| `ToolCardHeader.tsx` | HEADER 渲染（八字段主行 + 结果摘要次行 + 轮次组头行） |
| `ToolParamsBlock.tsx` | 参数区：JSON 前 12 行折叠 + 密钥脱敏 + 复制 |
| `ToolResultBlock.tsx` | 结果区：语义标签 + 行边界回退预览 + 落盘文案 |
| `ToolErrorBlock.tsx` | 错误区五层 + `kind` → 标签/语义色/恢复动作查表（含兜底分支） |
| `ToolCallGroup.tsx` | 调用组：同工具连续 ≥3 次合并，组内行点击 → Inspector |
| `RoundSummaryRow.tsx` | 单轮 >8 次的折叠汇总行 |
| `JsonBlock.tsx` | 共用 JSON 渲染器（语法高亮 + 折叠 + 复制），参数区与结果区**复用同一组件** |
| `CopyButton.tsx` | `Copy`→`Check` 150ms→1.5s 恢复，44px 命中区，禁 scale 弹跳 |
| `ApprovalBar.tsx` | inline 硬/两步确认条（六行 + 倒计时 + 参数就地展开 + 勾选框） |
| `ApprovalSheet.tsx` | 移动端底部 ActionSheet 版确认条 |
| `UndoBanner.tsx` | 软确认 30s 撤销横幅（`transform: scaleX` 进度条，不动画 width） |
| `ContextNotice.tsx` | 压缩/裁剪内联 notice（`reason` 四分支） |
| `TaskCostFooter.tsx` | 任务结束成本行 |
| `ContextUsageBar.tsx` | 上下文占用条（三处同源，`role="progressbar"`） |
| `PendingApprovalHint.tsx` | 输入框上方「N 个操作待确认」提示行 |

**新建 · `client/src/components/inspector/`**

| 文件 | 职责 |
|---|---|
| `InspectorPanel.tsx` | 右栏容器：三内容源切换 + 折叠 Rail 状态 |
| `InspectorToolDetail.tsx` | 工具详情：完整参数 / 完整返回 / 错误详情与原始响应 / 重试历史 / 调用时间线 |
| `InspectorContext.tsx` | 上下文：占用分段分解表 + 记忆条目（`Bookmark 16`） |
| `InspectorRail.tsx` | 44px 折叠图标轨 |

**新建 · `client/src/components/settings/`**

| 文件 | 职责 |
|---|---|
| `SettingsPanel.tsx` | 960px 双栏面板 + 五分组导航（改造既有 `SettingsModal`） |
| `SectionProvider.tsx` | 分区 1 模型与密钥（含 AC-01 三态探测结果行） |
| `SectionTools.tsx` | 分区 2 工具管理（按风险分组 + 启停 + 超时编辑） |
| `SectionMcp.tsx` | 分区 3 MCP 连接器（三态 + 工具清单 + 删除二次确认） |
| `SectionSecurity.tsx` | 分区 4 安全边界（域名白名单 + path jail + 超时/重试预算） |
| `SectionData.tsx` | 分区 5 数据管理（导出 / 恢复码 / 彻底清除） |

**新建 · store / lib**

| 文件 | 职责 |
|---|---|
| `stores/toolCallStore.ts` | toolCall 归一化存储（`byId` + `byMessage`），SSE 四事件只改这里 |
| `stores/approvalStore.ts` | 待确认审批（`byCallId`，含 `expiresAt` / 剩余毫秒计时） |
| `stores/inspectorStore.ts` | 右栏内容源 + 选中 `callId` + 折叠态持久化 |
| `stores/layoutStore.ts` | 三栏折叠态（`localStorage['codelens.layout']`） |
| `lib/tool-preview.ts` | `inlinePreview` 行边界回退（下限 60%）+ 落盘判定 |
| `lib/tool-format.ts` | `formatDuration` / `formatRelative` / `formatTokens` / `formatBytes` |
| `lib/tool-category.tsx` | `category` + `name` → Lucide 组件映射（含兜底 `Wrench`） |
| `lib/secret-mask.ts` | 密钥 key 正则 + 脱敏渲染数据 |
| `lib/tool-grouping.ts` | `buildToolBlocks` 分组算法（规则 1–7） |

**改造（既有文件）**

| 文件 | 改动 |
|---|---|
| `types/index.ts` | `Message.content: string` → `Segment[]`；新增 `ToolCallVM` / `ApprovalVM` / `ContextNotice` / SSE 事件联合类型（下划线） |
| `hooks/useSSEStream.ts` | 扩展事件 switch：加 `reasoning` / `tool_call` / `tool_progress` / `tool_result` / `tool_approval_required` / `context_notice`；`meta` 写入会话元信息 |
| `services/stream.ts` | 扩展事件名联合类型（**下划线**，不要照架构 C-2 正文的 kebab-case 写 `case 'tool-call'`） |
| `layout/AppShell.tsx` | 中栏 `CodeEditor` → `ConversationStream`；右栏 `ChatPanel` → `InspectorPanel`；抽屉扩展到右抽屉；**2 处 `AlertTriangle` 改为 `TriangleAlert`** |
| `layout/TopBar.tsx` | 加上下文占用条（右段）+ MCP 未连接提示条（`bg-warning-subtle` 通栏 24px + `[去修复]`） |
| `layout/StatusBar.tsx` | 新增三格：`上下文 34%` / `模式 FC\|ReAct` / `MCP 1/2`（有未连接时 `text-warning` + `TriangleAlert 16`） |
| `layout/MobileTabBar.tsx` | Tab 改为 对话 / 工具 / 会话（`mobileTab` 枚举同步改） |
| `empty/EmptyState.tsx` | 换「4 类工具待命中」+ 三条真实示例任务 |
| `chat/ChatPanel.tsx` / `MessageItem.tsx` | 支持 `Segment[]` 渲染；`ChatPanel` 演进为 Agent 对话编排（保留发送校验/重试逻辑） |
| `settings/SettingsModal.tsx` | 演进为 `SettingsPanel`（五分区）；保留 `confirmClear` 二次确认模式 |
| `stores/uiStore.ts` | `mobileTab` 枚举改；新增 `inspectorOpen` / `inspectorSource` / `requestInspector(callId)` |

### 8.2 Lucide 图标总表（全部已在 lucide-react 1.60.0 核验存在；16/20/24px，stroke-width 2）

| 图标 | 尺寸 | 位置 |
|---|---|---|
| `Globe` | 16 | `category=http` 工具卡① / 工具管理行 / 示例任务 1 |
| `FileText` | 16 | `fs.read` |
| `FilePen` | 16 | `fs.write` |
| `FolderOpen` | 16 | `fs.list` |
| `Calculator` | 16 | `calc.evaluate` / 示例任务 3 |
| `Clock` | 16 | `time.now`；状态 `timeout` |
| `Fingerprint` | 16 | `uuid.generate` |
| `Braces` | 16 | `json.format` |
| `TextQuote` | 16 | `text.diff` |
| `Plug` | 16 | `category=mcp` 工具卡① |
| `Server` | 16 | MCP 连接器卡 |
| `Wrench` | 16 / **24** | 类别兜底；Inspector Rail「工具详情」；**手机 TabBar「工具」** |
| `Circle` | 16 | 状态 `pending` |
| `Loader2` | 16 | 状态 `running`（`animate-spin`）/ 测试连接 / MCP 连接中 |
| `CircleCheck` | 16 | 状态 `success` / 复制完成 / 探测成功 |
| `CircleX` | 16 | 状态 `failed` / 探测失败 |
| `Ban` | 16 | 状态 `rejected` |
| `CircleSlash` | 16 | 状态 `skipped` |
| `TriangleAlert` | 16 | 确认条 / 错误区 / 兼容模式提示 / MCP 未连接 / 结果过大 / 待确认提示行 |
| `ShieldCheck` | 16 | 会话行「本会话已记住 N 条授权」 |
| `EyeOff` / `Eye` | 16 | 密钥脱敏切换 / API Key 显示切换 |
| `Shrink` | 16 | `context_notice` |
| `Bookmark` | 16 | Inspector「记忆」分段 / Rail |
| `Gauge` | 16 | Inspector「上下文」分段 / Rail |
| `PanelRight` | **20** | 右栏展开/折叠；平板唤起 Inspector |
| `PanelLeft` | **20** | 左栏折叠；平板唤起会话抽屉 |
| `ChevronRight` / `ChevronDown` | 16 | 折叠箭头 / 展开详情 |
| `Copy` / `Check` | 16 | 复制按钮两态 |
| `Undo2` | 16 | 软确认撤销横幅 |
| `RotateCcw` | 16 | 重试 / 用恢复码恢复会话 |
| `Download` | 16 | 下载为文件 / 导出 Markdown |
| `Database` | 16 | 导出数据库文件 |
| `FolderLock` | 16 | 安全边界 path jail |
| `Coins` | 16 | 任务成本脚注 |
| `Brain` | 16 | 思考摘要行 |
| `MessageSquare` | **24** | 手机 TabBar「对话」 |
| `History` | **24** | 手机 TabBar「会话」 |
| `Settings` | **20** | 顶栏设置入口 |
| `Plus` | 16 | 新建会话 / 添加域名 / 添加 MCP 连接器 |
| `Trash2` | 16 | 删除（会话 / 域名 / MCP 连接器 / 彻底清除） |
| `X` | 16 | 关闭抽屉 / 弹层 |
| `Play` / `Square` | 16 | 继续 / 中止（AC-10 打断） |
| `ArrowUp` | **20** | 发送 / 跳到最新 |
| `ExternalLink` | 16 | 「在检视器中打开」 |
| `HardDrive` | 16 | 结果落盘提示 |
| `List` | 16 | 移动端「工具」Tab 调用清单 |

**命名约定**：一律用 Lucide 1.x **规范名**（`CircleCheck` / `CircleX` / `TriangleAlert`），不用旧别名（`CheckCircle2` / `XCircle` / `AlertTriangle`）。lucide-react 1.60.0 的导出形式是 `新名 as 旧名`——新名是主定义，旧名是兼容别名。既有 `Toast.tsx` / `ResultPanel.tsx` / `SettingsModal.tsx` 已在用规范名；仅 `AppShell.tsx` 有 2 处 `AlertTriangle` 需顺手改。

---

## 9. 阻塞项与建议（回传 team-lead）

### 9.1 已闭环（架构 2026-10-22 裁决，本文已同步）

| # | 原问题 | 裁决结果 | 本文落点 |
|---|---|---|---|
| ~~B-1~~ | AC-10「改参数重试」无通道 | **team-lead 裁决：新开独立端点** `POST /api/v1/approvals/:id/revise`（Spec §5 端点 21→22），body `{ token, arguments }`（`arguments` 是**完整参数对象非增量 patch**，**无 `decision` 键**）。三返回态：`reapproval_required`（不关条，原地换 id/token/expiresAt 重渲染）/ `executed_directly`（风险降级已直接执行，条收起变正常卡片）/ **`rejected`（新参数没过 schema 或安全网关，HTTP 仍 200，条收起变失败卡片）**。边界：仅 pending 可改、最多 3 次 | §3.5 + §3.4.1（含 `APPROVAL_NOT_REVISABLE` / `APPROVAL_REVISE_LIMIT`） |
| ~~B-2~~ | `error.kind` 无完整枚举 | **锁定 10 值**（`invalid_args`/`not_found`/`security`/`timeout`/`rate_limit`/`network`/`upstream`/`mcp`/`circuit_open`/`internal`）。四处增删：去 `payload_too_large`、去 `forbidden`（并入 `security`）、加 `upstream`（5xx/401 与「网络不可达」重试语义相反，落 `internal` 会让用户以为是我们产品坏了）、加 `circuit_open`（AC-08 要求，**neutral 色不是 danger**）。权威表见 **架构 §8.2** 与 `phase2-architecture-detail.md` §4.2.6（两处内容一致） | §2.6 |

### 9.2 待 team-lead 批准后才出 UI 规格

| # | 议题 | 状态 |
|---|---|---|
| **W-1** | **「单步重试」与「从某步重跑」同样没有入口**（`skipped` 状态设计好了，但没有触发它的端点）。架构已给方案：给 `AgentRequest` 加 `resumeFromCallId` / `overrideArguments` 两个可选字段复用同一循环 | 等 team-lead 批准。**本文暂不出这两项的 UI 规格**；§2.6 错误区的 `[重试]` 按钮与 §2.3 的 `skipped` 态渲染规则已就位，端点落地后补交互即可 |

### 9.3 advisory

| # | 建议 | 理由 |
|---|---|---|
| A-1 | 移动端审批 ActionSheet 的**下滑手势 = 收起保留 pending，不等于拒绝**（与 v1.2.0 不同） | 误滑拒绝不可逆，且拒绝会作为 observation 改变 Agent 走向；收起后仍可从「N 个操作待确认」点回去 |
| A-2 | `tool` segment 只存 `callId`，卡片数据存 `toolCallStore.byId` | SSE 事件高频更新，若每次重写 segments 数组会全量 re-render（§1.4） |
| A-3 | 错误区主索引用 `error.kind` 而非 `error.code` | `code` 是展示串（`TOOL_TIMEOUT` 等会随架构演进），`kind` 才是分类键；用 kind 查表 + 兜底，架构新增错误码时前端不崩 |
| A-4 | 「未成功数」= `failed + timeout`，`rejected`/`skipped` 明确不计入 | 误计会让「我拒绝了 3 次」看起来像「Agent 错了 3 次」，是错误归因 |
| A-5 | 参数区复制默认复制**脱敏后** JSON，原始值需显式展开字段后才能单独复制 | 默认安全；用户排查找后端时仍有一条显式路径 |
| A-6 | `inlinePreview` 行边界回退设 60% 下限 | 单行 3000 字符的 minified JSON 若强制回退到行边界会得到空串（§2.5） |
| A-7 | SSE 事件名一律**下划线**，绝不要写 `case 'tool-call'` | 架构 §8.1 与 §16.1 裁决表 C-2 现均已统一为下划线（我初稿引的「C-2 正文是 kebab 笔误」是旧版残留，架构已修）。**前端只需保证不照任何旧稿写中划线** |
| A-8 | `AppShell.tsx` 2 处 `AlertTriangle` 顺手改 `TriangleAlert` | 全项目图标命名统一，视觉零差异（仅 2 行机械替换）。**已登记为 Phase 3 清理项**（架构 §12.3 + §16.3 D-4），本阶段禁止改 `client/` 代码 |
| A-9 | **MCP 连接器维持 P1**（team-lead 已把 Spec §2 措辞改为「架构/API/UI 已设计完毕，Phase 3 在 P0 跑通后实现」） | 原 Spec §2 把 MCP 列进 P1 Backlog，但 §5 有 6 个端点、§7 有分区、AC-12 有验收项——属 PRD 遗留冲突。现措辞已消歧：设计保留、排期后置。本文 §4.4 UI 规格**保留不删**，Phase 3 按排期实现 |
| A-10 | 审批回执的 404 / 409 / 410 不要统一弹 Toast | 每档失败的用户动作不同（关闭 / 无操作 / 重新加载参数），通用 Toast 会丢失动作。见 §3.4.1 |
| A-11 | **决定端点与 revise 端点拆成两个 TS 类型**，不要共用一个 interface | 决定端点 `.strict()` 拒收 `arguments`；revise 端点 `{token, arguments}` 且**没有 `decision` 键**。共用一个类型会让决定请求带上 `arguments` → 400。见 §3.4.1 分档表 |
| A-12 | `circuit_open` 是唯一用 **neutral** 语义色的错误态，别顺手染红 | 熔断是保护机制不是故障；且它**不显示「建议」层**（没有可建议的，只有换工具）。见 §2.6 |
| A-13 | 改参数后时间线会出现**两张卡片**（旧的 skipped 灰掉 + 新的待确认），这是刻意的不是 bug | 模型最初请求删 A、用户改成删 B，审计必须两者都留。前端不要把旧卡删掉或合并 |
| A-14 | revise 的 `rejected` 返回态走**成功回调**，别在 `catch` 里处理 | 它 HTTP 状态是 200。按 `catch` 分支处理会让用户看到一个无内容的确认条一直挂着（§3.5） |

---

## 10. 自检清单

- [x] **无 emoji 作功能图标**——全部为 Lucide 规范名（§8.2 共 46 个，均在 `lucide-react.d.ts` 核验存在），16/20/24px / stroke-width 2
- [x] **无紫粉渐变**——主色沿用 Signal Blue `--c-accent`，无任何渐变（撤销横幅进度条是纯色 `bg-accent`）
- [x] **无空洞占位文案**——空状态用「4 类工具待命中」+ 三条含具体数值的真实任务；安全边界空态是真实约束陈述
- [x] **无硬编码颜色**——全部引用既有 Token 类名；阈值变色用 `className` 切换而非 inline color
- [x] **无弹跳缓动**——`duration-150`（复制反馈/审批原因展开）/ `duration-250`（栏宽/进度条），`--c-ease-standard`（150ms 内为 API 级微反馈，非布局动效）
- [x] **单文件 ≤300 行**——§8.1 已按职责拆到 40+ 个文件，每个一句话职责
- [x] **五态覆盖**——§7.2 覆盖对话区/工具卡/工具管理/MCP/会话列表五个区域的 Loading/Empty/Error/Populated/Edge
- [x] **无障碍**——状态「图标 + 文字」双通道；`role="progressbar"` + `aria-valuenow`；`aria-expanded`；审批 `aria-live="assertive"` 播报一次；`Esc` 不等于拒绝
- [x] **触摸目标 ≥44px**——`min-h-11`；16px 图标按钮用 `-m-3.5 h-11 w-11` 扩命中区；`env(safe-area-inset-bottom)`
- [x] **reduced-motion**——spinner 停转但保留数字计时；进度条不动画只留倒计时；栏宽过渡由 Token 自动归零
- [x] **每屏 accent ≤2 处**——工具卡的 `accent-subtle`（MCP 徽标底）与焦点环不计入实心面；实心 `bg-accent` 同屏仅「允许一次」/「发送」二选一场景
- [x] **`error.kind` 与架构锁定枚举一致**——§2.6 采用 10 值（含 `circuit_open` 用 neutral 色），保留未知 kind 兜底分支
- [x] **审批 body 键集合按 `decision` 分档**——`reject` 档不带 `arguments`（`.strict()` 会 400）
- [x] **未修改任何既有文件**——仅新增 `docs/agent/phase2-ui-design.md`
