# 编程 Agent Web 应用 — Phase 1 UI/UX 设计文档

> **⚠️ 已被取代（2026-10-24）**：v1.0 设计已退役，现行唯一依据是 **docs/agent/phase1-uiux.md**
> 与 docs/agent/phase2-ui-design.md。本文仅作历史留存，不再维护。

> 版本：v1.0 | 设计师：颜好看 | 日期：2026-10-20 | 输入：PRD 三句话需求 + 架构 Spec（React + TypeScript + Node/Express，真实 LLM API，会话级免登录）
> 设计寄存器：**Product Register**（设计服务产品——工作台/工具 UI，标杆是赢得熟悉感，参照 Linear / Cursor / VS Code / Phind）
> 平台正交轴：**Web 响应式**（桌面 / 平板 / 手机三档，断点 768 / 1024）
> 三轴刻度：DESIGN_VARIANCE = 4（IDE 式固定骨架，内容区自由） / MOTION_INTENSITY = 3（功能动效为主，零装饰动画） / VISUAL_DENSITY = 6（开发者工具中高密度，1px 分隔线优先于卡片阴影）

---

## 1. 设计语言与对标品牌

### 1.1 设计语言一句话

**「深色 IDE 工作台」**：界面即一个轻量浏览器版 IDE——左边会话、中间代码、右边 Agent 输出；chrome（界面框架）退到几乎不可见，代码与分析结果是唯一主角。

### 1.2 对标品牌（1 主 + 1 辅）

**主对标：Cursor（AI 代码编辑器）**
- 布局范式：左侧可折叠导航 + 中央代码编辑区 + 右侧 AI 面板，三栏同屏，代码与对话互不遮挡——这正是「编程 Agent」用户的核心心智模型（他们每天在 IDE 里工作）。
- 交互范式：选中代码浮现行内快捷指令（解释 / 测试 / 优化）、Agent 产物用 diff 视图呈现、底部状态栏显示连接与模型状态。
- 适配理由：我们的产品是「粘贴代码 → Agent 分析 → 结构化结果」，与 Cursor 的「编辑器 + Agent 面板」同构。借鉴其三栏骨架、diff 呈现、行内操作，但去掉本地文件树 / Git 等 IDE 重功能，保持 Web 应用的轻量。

**辅对标：Phind（开发者 AI 搜索）**
- 布局范式：左侧代码 / 问题输入，右侧结构化回答 + 来源引用；深浅色跟随系统。
- 交互范式：答案分区呈现（结论先行 → 代码 → 解释 → 参考来源）、代码块悬停显示来源、粘贴即解析保留缩进与高亮。
- 适配理由：借鉴其「结构化结果输出区」的信息架构（分区卡片、行号定位、来源可溯），以及免登录即用的产品形态——与本项目「纯会话级免登录」完全一致。

**明确不参考的**：通用聊天产品（ChatGPT / Claude Web）的单栏居中对话流——那会让代码编辑区被挤压成窄条，浪费工作台的横向空间；编程 Agent 的用户要的是「代码和结果同时可见」。

### 1.3 氛围关键词

冷静、精准、工程感、可信、零干扰。

---

## 2. 主题策略

**深色优先 + 浅色可选，默认跟随系统（prefers-color-scheme），设置里可手动覆盖。**

理由（开发者工具惯例，调研佐证）：
1. Cursor / VS Code / v0.dev / Phind 全部支持深色且深色为默认推荐；开发者长时间盯代码，深色降低眼疲劳，且深色背景下语法高亮色彩的辨识度更高。
2. 深色 IDE 背景是 DevTools 美学的基础识别符号（`#0D1117` / `#161B22` 一类的深灰，而非纯黑）。
3. 浅色主题保留给白天强光环境与偏好明亮界面的用户，两套主题共用同一套语义 Token，仅值不同。

实现约定：
- 主题由 `<html data-theme="dark" | "light">` 切换，未设置时读取 `prefers-color-scheme`；用户手动选择写入 localStorage。
- 所有颜色一律走语义 Token（第 3 节），组件样式禁止出现裸色值（唯一例外 `#fff` / `#000` 仅允许出现在 Token 定义处）。
- 语法高亮由代码高亮库主题承担（建议 Shiki，`github-dark` / `github-light`），随整体主题同步切换；**语法高亮色属于内容渲染层，不属于 UI chrome Token**，但其色板需与第 3 节深色 IDE 背景同源，避免代码区与界面脱色。

---

## 3. 配色 Token 草案（语义化命名，浅色 + 深色两套值）

> 命名规则：按用途命名（`bg-primary` 不叫 `blue-900`）。Component 层样式只允许引用本表 Token。

### 3.1 深色主题（默认，`:root[data-theme="dark"]`）

```css
:root[data-theme="dark"] {
  /* ── 背景层（亮度递进表达层级，不用阴影） ── */
  --color-bg-primary: #0D1117;        /* 页面背景 = 代码编辑区背景（GitHub Dark 同款，开发者零学习成本） */
  --color-bg-secondary: #161B22;      /* 侧栏 / 右栏面板 / 代码块容器 */
  --color-bg-tertiary: #21262D;       /* 悬浮面板、下拉菜单、代码块行 hover */
  --color-bg-inset: #010409;          /* 更深的内嵌区：流式输出骨架底、终端式状态条 */

  /* ── 前景层 ── */
  --color-text-primary: #F0F6FC;      /* 主文本：对话正文、代码 */
  --color-text-secondary: #8B949E;    /* 次级文本：时间戳、说明文字 */
  --color-text-tertiary: #6E7681;     /* 三级文本：禁用、占位提示、行号 */
  --color-text-on-accent: #FFFFFF;    /* 强调色背景上的文字 */

  /* ── 边框层 ── */
  --color-border: #30363D;            /* 面板分隔线、输入框边框 */
  --color-border-subtle: rgba(255, 255, 255, 0.06);  /* 卡片内部分割线 */

  /* ── 强调色（每屏可见使用 ≤ 2 处） ── */
  --color-accent: #197FE6;            /* Signal Blue：主 CTA、选中态、焦点环 */
  --color-accent-hover: #3B96F5;      /* 悬停提亮 */
  --color-accent-active: #1268C4;     /* 按下压深 */
  --color-accent-subtle: rgba(25, 127, 230, 0.14);   /* 选中行底、AI 标识浅底 */

  /* ── 语义色 ── */
  --color-success: #3FB950;           /* 分析通过、修复成功、复制成功 */
  --color-warning: #D29922;           /* 潜在风险、性能警告 */
  --color-danger: #F85149;            /* 错误定位、请求失败 */
  --color-danger-subtle: rgba(248, 81, 73, 0.12);   /* 错误卡片底 */
  --color-warning-subtle: rgba(210, 153, 34, 0.12);
  --color-success-subtle: rgba(63, 185, 80, 0.12);

  /* ── diff 视图专用（内容层，源自 GitHub diff 色板） ── */
  --color-diff-add-bg: rgba(63, 185, 80, 0.12);
  --color-diff-add-text: #3FB950;
  --color-diff-del-bg: rgba(248, 81, 73, 0.12);
  --color-diff-del-text: #F85149;
}
```

### 3.2 浅色主题（`:root[data-theme="light"]`）

```css
:root[data-theme="light"] {
  --color-bg-primary: #F9FAFB;        /* 页面背景 */
  --color-bg-secondary: #F3F4F6;      /* 侧栏 / 右栏面板 */
  --color-bg-tertiary: #E5E7EB;       /* 悬浮面板、hover 态 */
  --color-bg-inset: #F3F4F6;          /* 内嵌区 */

  --color-text-primary: #111827;
  --color-text-secondary: #6B7280;
  --color-text-tertiary: #9CA3AF;
  --color-text-on-accent: #FFFFFF;

  --color-border: #E5E7EB;
  --color-border-subtle: #F3F4F6;

  --color-accent: #0B5CCB;            /* 浅色下加深，保证白底文字对比度 ≥ 4.5:1 */
  --color-accent-hover: #0A4FA8;
  --color-accent-active: #083F87;
  --color-accent-subtle: rgba(11, 92, 203, 0.08);

  --color-success: #16A34A;
  --color-warning: #D97706;
  --color-danger: #DC2626;
  --color-danger-subtle: rgba(220, 38, 38, 0.08);
  --color-warning-subtle: rgba(217, 119, 6, 0.10);
  --color-success-subtle: rgba(22, 163, 74, 0.08);

  --color-diff-add-bg: rgba(22, 163, 74, 0.10);
  --color-diff-add-text: #16A34A;
  --color-diff-del-bg: rgba(220, 38, 38, 0.08);
  --color-diff-del-text: #DC2626;
}
```

### 3.3 主色理由（为什么是 Signal Blue #197FE6）

1. **避开 AI 模板三件套**：不用 Indigo `#6366F1`（Tailwind 默认值 = 一眼 AI 的首罪），不用紫粉渐变，不用发光边框 + 毛玻璃。
2. **信号感与工程感**：`#197FE6` 是比 Tailwind 默认蓝（`#3B82F6`）更饱和、更亮的工程蓝，DevTools 美学中与「Terminal Green / Safety Orange」同级的信号色，用于 CTA 与选中态有明确的操作指引意味。
3. **不与语法高亮混淆**：代码高亮中蓝色系 token 偏青（`#79C0FF` / `#A5D6FF`），与 UI 强调蓝 `#197FE6` 有色相差，用户不会把按钮和代码变量看混。
4. **信任资产**：蓝是开发者工具最被信任的色系（GitHub / Vercel / Linear 均在蓝色域），新产品借熟悉感建立可信度。
5. **两套主题均可达到对比度标准**：深色底 `#197FE6` 配白字 4.6:1；浅色主题降至 `#0B5CCB` 配白字 5.9:1。

### 3.4 每屏强调色纪律

主 CTA（「分析代码」按钮）与当前选中会话高亮各算一处，同屏不超过 2 处 `--color-accent` 可见使用。标题、正文一律用中性色。语义色（success / warning / danger）只挂在真实状态上，不做装饰。

---

## 4. 字体系统

### 4.1 字体选型与栈

```css
/* UI 字体：标题与正文同一家族，靠字重与字号分层（开发者工具惯例） */
--font-ui: "Inter", "Noto Sans SC", -apple-system, "Segoe UI", sans-serif;

/* 代码等宽字体：JetBrains Mono */
--font-mono: "JetBrains Mono", "Fira Code", Menlo, Monaco, Consolas, "Liberation Mono", monospace;
```

- **等宽字体选 JetBrains Mono 的理由**：① 编程连字（`=>` `!==` `->`）提升扫读速度；② 行高与 x-height 为长时间读代码专门优化，比 Fira Code 的渲染毛刺问题少，比 IBM Plex Mono 在 Web 生态（Google Fonts 直接可用、Shiki 内置主题覆盖全）更主流；③ 免费商用。
- Google Fonts 引入（前端在 index.html 或全局 CSS）：
  ```css
  @import url("https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=Noto+Sans+SC:wght@400;500;600&family=JetBrains+Mono:wght@400;500;600&display=swap");
  ```
- 兜底：等宽栈尾部 Menlo（macOS）/ Consolas（Windows）保证系统级等宽可用；`font-synthesis` 关闭，禁止伪粗体。

### 4.2 字号阶梯（7 级，px + rem 双写）

| Token | 值 | 用途 | 字体 | 行高 |
|---|---|---|---|---|
| `--text-xs` | 12px / 0.75rem | 徽章、时间戳、行号、代码块语言标签 | mono | 1.4 |
| `--text-sm` | 13px / 0.8125rem | 辅助说明、图标按钮 tooltip、会话列表摘要 | UI | 1.5 |
| `--text-base` | 14px / 0.875rem | **UI 基准**：按钮、输入框、表格、导航 | UI | 1.5 |
| `--text-md` | 16px / 1rem | 对话正文、分析解释长文（阅读尺度） | UI | 1.6 |
| `--text-lg` | 20px / 1.25rem | 卡片标题、区块标题 | UI | 1.3 |
| `--text-xl` | 24px / 1.5rem | 页面主标题 | UI | 1.2 |
| `--text-2xl` | 32px / 2rem | 空状态主标题、Hero 示例区标题 | UI | 1.1 |
| `--text-code` | 14px / 0.875rem | 代码区与代码块（mono，行高 1.6） | mono | 1.6 |

> 正文不小于 14px；代码 14px 是「一屏 80 列可读」与密度的平衡点；手机端代码区允许降到 13px 换取横向完整性，但不得低于 12px。

### 4.3 字重与字距

| 字重 Token | 值 | 用途 |
|---|---|---|
| `--weight-regular` | 400 | 正文、代码、说明 |
| `--weight-medium` | 500 | 按钮文字、表头、小标题、选中文话 |
| `--weight-semibold` | 600 | 卡片标题、页面标题 |

| 场景 | 字距 |
|---|---|
| 正文 / 代码 | 0 |
| 小字（≤13px） | 0.01em |
| ALL CAPS（语言标签、状态徽章） | 0.08em |
| 标题（≥24px） | -0.01em |
| 大标题（≥32px） | -0.02em |

---

## 5. 图标系统建议

### 5.1 选型：Lucide（`lucide-react`）

| 维度 | Lucide | Heroicons | Tabler |
|---|---|---|---|
| 与 React+TS 集成 | 官方 `lucide-react`，按需 tree-shake | 官方 `@heroicons/react` | `@tabler/icons-react` |
| 风格 | 统一 2px 描边、24 网格、圆角线帽 | 3 种变体（outline/solid/mini）体系较重 | 描边略细，风格偏旧 |
| 语义覆盖 | 4000+，本项目清单全覆盖 | 覆盖较全 | 覆盖全 |
| 体积（按需后） | 单图标 ~0.5KB | 相近 | 相近 |
| 生态 | shadcn/ui 默认，DevTools 项目事实标准 | Tailwind 团队出品 | — |

**结论：推荐 Lucide**。理由：与 shadcn/ui 生态一致（前端若用 shadcn/ui 组件体系则图标零摩擦）、统一 2px 描边在 16/20/24px 三档尺寸下视觉重量一致、`lucide-react` 对 TypeScript 支持最好。最终依赖由架构师在 Spec 锁定，本建议为设计侧唯一推荐，全项目不得混用第二套。

### 5.2 尺寸规范（全项目一致，禁止其他尺寸）

| 尺寸 | 使用场景 |
|---|---|
| 16px | 行内图标：按钮内、徽章旁、输入框内、会话列表行内 |
| 20px | 按钮内主图标（发送、停止、设置入口） |
| 24px | 独立图标：空状态插图元素、底部 TabBar、移动端顶栏 |

图标一律 `stroke-width: 2`（16px 档可降至 1.75 防糊）；颜色默认 `currentColor` 继承文字色，交互态随文字色变化，**禁止图标单独配色**（语义状态图标除外，随对应语义 Token）。

### 5.3 本项目图标语义清单（Lucide 组件名 → 语义）

| 语义 | Lucide 图标 | 使用位置 |
|---|---|---|
| 发送 | `Send` | 输入区主 CTA（20px） |
| 停止生成 | `Square`（实心方块） | 流式期间替换发送按钮 |
| 复制 | `Copy` | 代码块右上角、消息操作 |
| 复制成功反馈 | `Check` | 复制后 1.5s 内替换 `Copy` |
| 清空当前输入 | `Eraser` | 输入区 |
| 新建会话 | `MessageSquarePlus` | 左栏顶部主按钮 |
| 历史会话 | `History` | 左栏标题、移动端 Tab |
| 设置 | `Settings` | 顶栏右侧（20px） |
| 代码 | `Code2` | 代码区标题、TabBar |
| 分析 | `ScanSearch` | 「分析代码」主 CTA 前置图标 |
| 解释 | `BookOpen` | 结果类型选择 |
| 调试 | `Bug` | 结果类型选择 |
| 优化 | `Gauge` | 结果类型选择 |
| 警告 | `AlertTriangle` | 警告状态（`--color-warning`） |
| 成功 | `CircleCheck` | 成功状态（`--color-success`） |
| 失败 | `CircleX` | 失败状态（`--color-danger`） |
| 加载中 | `Loader2`（旋转） | 行内加载指示 |
| 删除 | `Trash2` | 会话列表行内（hover 显现） |
| 编辑 | `Pencil` | 消息操作：编辑重问 |
| 重新生成 | `RefreshCw` | 消息操作 |
| 折叠 | `ChevronRight` | 折叠卡片、代码块折叠 |
| 展开 | `ChevronDown` | 展开卡片 |
| 应用到编辑器 | `CornerDownLeft` | diff 卡片操作 |
| AI 标识 | `Sparkles` | AI 消息头像位、AI 生成内容标识（唯一允许的「AI 感」图标，克制使用） |
| 用户 | `User`（或首字母头像） | 用户消息头像位 |
| 主题-深色 | `Moon` | 设置弹层 |
| 主题-浅色 | `Sun` | 设置弹层 |
| 主题-跟随 | `Monitor` | 设置弹层 |
| 更多操作 | `Ellipsis` | 消息操作溢出菜单 |
| 关闭 | `X` | 弹层关闭 |
| 链接/参考 | `Link2` | 相关知识点、参考来源 |
| 键盘快捷键 | `Keyboard` | 快捷键提示 |

---

## 6. 间距 / 圆角 / 阴影 / 动效 Token

### 6.1 间距（4px 基准网格，只允许下表值）

| Token | 值 | 典型用途 |
|---|---|---|
| `--space-1` | 4px | 图标与文字间距、徽章内距 |
| `--space-2` | 8px | 同组元素间距、按钮间距（≥8px 触摸间隔） |
| `--space-3` | 12px | 表单元素纵向间距、卡片内元素 |
| `--space-4` | 16px | 卡片内边距、面板内边距、手机屏水平边距 |
| `--space-6` | 24px | 区块间距、三栏之间 gutter、桌面面板内边距 |
| `--space-8` | 32px | 大区块间距、空状态区内距 |

### 6.2 圆角（3 级 + 全圆）

| Token | 值 | 典型用途 |
|---|---|---|
| `--radius-sm` | 4px | 徽章、代码块语言标签、输入框 |
| `--radius-md` | 8px | 按钮、下拉项、小卡片 |
| `--radius-lg` | 12px | 结果卡片、弹层（上限 12px，禁止更大——AI 式过度圆滑反模式） |
| `--radius-full` | 9999px | 头像、圆形图标按钮、流式 caret 外的圆点 |

### 6.3 阴影（两级；rest 状态一律用 1px 边框不用阴影）

| Token | 值 | 使用条件 |
|---|---|---|
| `--shadow-overlay` | `0 8px 24px rgba(0, 0, 0, 0.32)`（深色）/ `0 8px 24px rgba(0, 0, 0, 0.12)`（浅色） | 下拉菜单、弹层、Toast 等浮悬元素 |
| `--shadow-drag` | `0 16px 40px rgba(0, 0, 0, 0.40)`（深色）/ `0 16px 40px rgba(0, 0, 0, 0.16)`（浅色） | 拖拽中、移动端抽屉 |

禁令（对照反模式清单）：禁止「1px 边框 + blur ≥ 16px」同时出现在同一静止元素上（幽灵卡片）；卡片 rest = 边框，hover = 边框换 `--color-border` 加深或 `--color-bg-tertiary` 提亮，不弹阴影。

### 6.4 动效（两档收敛值 + 一处呼吸灯）

| Token | 值 | 场景 |
|---|---|---|
| `--motion-fast` | 150ms | hover 变色、选中态、复制反馈、tab 切换 |
| `--motion-base` | 250ms | 下拉展开、弹层淡入、抽屉滑入、结果卡片进入 |
| `--ease-standard` | `cubic-bezier(0.25, 0.1, 0.25, 1)` | 全部动效统一缓动（ease-out 家族） |
| `--caret-blink` | 1s `step-end` infinite | 流式输出 caret 闪烁（唯一循环动画，作为「还活着」的信号） |

禁令：禁止弹性回弹 `cubic-bezier(0.68, -0.55, 0.265, 1.55)`；禁止同时 >3 个元素动画；禁止动画 `width` / `height`（布局属性），只动 `opacity` / `transform`。
`prefers-reduced-motion: reduce` 时：`--motion-fast` / `--motion-base` 归零（瞬时切换）、caret 停止闪烁改为静态方块、骨架 shimmer 停止。

### 6.5 焦点环

```css
--focus-ring: 0 0 0 3px var(--color-accent-subtle);  /* 外圈柔光 */
/* 配 2px var(--color-accent) 实色内边（box-shadow 双值），仅 :focus-visible 时出现 */
```

全项目统一：`:focus-visible { outline: none; box-shadow: var(--focus-ring), 0 0 0 2px var(--color-accent); }`；鼠标点击不显示焦点环，键盘 Tab 必显示。

### 6.6 层级 z-index

| Token | 值 | 用途 |
|---|---|---|
| `--z-sticky` | 100 | 顶栏、流式期间输入区吸底 |
| `--z-dropdown` | 200 | 下拉菜单 |
| `--z-drawer` | 300 | 移动端历史抽屉 |
| `--z-modal` | 400 | 设置弹层 |
| `--z-toast` | 500 | Toast 通知 |

---

## 7. 核心页面布局（ASCII 线框）

### 7.1 主工作台 — 桌面（≥1024px）：三栏同屏

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ 顶栏 (48px, bg-secondary, border-bottom)                                      │
│ [Logo CodeLens]   会话标题: 闭包陷阱分析        [主题] [设置]                  │
├────────────┬───────────────────────────────────┬─────────────────────────────┤
│ 左栏 240px  │ 中栏: 代码编辑区 (flex-1, ≥380px) │ 右栏 420px: 对话 + 结构化结果 │
│ bg-secondary│ bg-primary(代码区与页面同色)      │ bg-secondary                │
│             │                                   │                             │
│ [+ 新建会话] │ ┌─ 代码区标题栏 ───────────────┐ │ ┌─ 消息流 (scroll) ────────┐ │
│             │ │ [语言: JavaScript ▾]  行 42   │ │ │                           │ │
│ ┌─────────┐ │ │ [格式化] [清空]      Ln 42    │ │ │  (用户消息, 右对齐气泡)    │ │
│ │当前会话  │ │ ├───────────────────────────────┤ │ │                           │ │
│ │● 闭包分析│ │ │ 1  function getLastItem(arr) │ │ │  (AI 消息, 左对齐)         │ │
│ └─────────┘ │ │ 2    return arr[arr.length]   │ │ │  ┌─ 问题定位卡 ──────────┐ │ │
│             │ │ 3  }                          │ │ │  │ [Bug] L2:10 Off-by-one│ │ │
│ 历史会话     │ │ ...                           │ │ │  │ 代码行高亮 + 描述     │ │ │
│ ○ React 优化│ │ │  ↑ 选中行 → 浮现行内指令条:  │ │ │  └──────────────────────┘ │ │
│ ○ 算法复杂度│ │ │  [解释][调试][优化]          │ │ │  ┌─ 根因分析卡 ──────────┐ │ │
│ ○ 空状态示例│ │ └───────────────────────────────┘ │ │  │ ...                   │ │ │
│             │ │ 底部操作条:                      │ │  └───────────────────────┘ │ │
│ (hover 显现 │ │ [ScanSearch 分析代码] [预设 ▾]   │ │  ┌─ 修复建议卡 (streaming)┐ │ │
│  [删除])    │ │ 问题输入框 (多行, 自适应高度)      │ │  │ 骨架 shimmer + caret ▍│ │ │
│             │ │ [Enter 发送 · Shift+Enter 换行]  │ │  └───────────────────────┘ │ │
│             │ │                                   │ │                           │ │
├────────────┴───────────────────────────────────┴─────────────────────────────┤
│ 状态栏 (28px, bg-secondary, border-top, text-xs, text-secondary)              │
│ ● 已连接 · gpt-4o-mini · 本会话 12 条消息 · 代码 42 行              [跳到最新 ↑]│
└──────────────────────────────────────────────────────────────────────────────┘
```

三栏关系说明：
- **左栏（会话）**：240px 固定，可折叠为 56px 图标栏（<1200px 时自动折叠）；当前会话 `--color-accent-subtle` 底 + 左侧 2px 强调条（列表项选中条允许，非卡片左边框）。
- **中栏（代码 + 输入）**：代码编辑区与「问题输入 + 发送」上下结构；行内指令条（解释/调试/优化）在选中代码时浮现于代码行上方，`--shadow-overlay` + `--radius-md`。
- **右栏（输出）**：420px 固定，内部消息流 + 结构化结果卡片；流式期间底部「停止生成」按钮替代发送。
- 分隔：三栏之间 1px `--color-border` 硬分割（IDE 窗格语言），不用卡片阴影区分。

### 7.2 主工作台 — 平板（768–1024px）：两栏 + 可唤出抽屉

```
┌────────────────────────────────────────────────┐
│ 顶栏: [≡ 历史]  会话标题          [主题][设置]   │  ← ≡ 为菜单图标按钮非文字
├──────────────────────┬─────────────────────────┤
│ 中栏: 代码区 (flex-1) │ 右栏 360px: 结果输出    │
│                      │  (窄档, 结果卡片单列)    │
│  + 底部输入区        │                         │
├──────────────────────┴─────────────────────────┤
│ 历史会话 = 左滑抽屉 (overlay, 遮罩 bg 黑色40%)    │
└────────────────────────────────────────────────┘
```

- 768–1024：左栏收纳为顶栏「历史」图标按钮 → 点击滑出抽屉；中栏代码区保持完整宽度，右栏收窄至 360px。
- <768 触屏：行内指令条常驻底部工具条，避免 hover 依赖。

### 7.3 主工作台 — 手机（<768px）：单栏 + 底部 TabBar

```
┌──────────────────────────┐
│ 顶栏 (48px): [历史] 标题 [设置] │
├──────────────────────────┤
│                          │
│   当前 Tab 内容 (全屏)    │
│   Tab1 代码: 编辑区+输入   │
│   Tab2 结果: 对话+卡片流   │
│   Tab3 历史: 会话列表      │
│                          │
├──────────────────────────┤
│ TabBar (56px + safe-area) │
│ [Code2 代码] [Sparkles 结果] [History 历史] │
└──────────────────────────┘
```

- 底部 TabBar 3 个标签（≤5 符合认知负荷规则），图标 24px + 文字 10px，触摸目标 44×44px 起。
- 底部预留 `env(safe-area-inset-bottom)`（iPhone 手势条）。
- 「结果」Tab 在有新流式输出时，图标旁显示 2px `--color-accent` 圆点（不计数号，避免噪音）。
- 代码 Tab 内「分析」按钮固定在输入区上方，拇指可达。

### 7.4 结构化结果输出区 — 信息架构（右栏内部）

AI 回复 = 一段简短对话式结论（1–3 句）+ 一组结构化卡片。卡片顺序固定，用户可折叠：

```
┌─ AI 回复 ────────────────────────────────────┐
│ 结论摘要 (对话式, text-md, 最多3句)            │
├─ 卡片1: 问题定位 [Bug] ──────────────────────┤
│  位置: L2:10 (等宽字体, mono)                  │
│  类型徽章: [Error]/[Warning]/[Info]            │
│  问题代码行 (mono, 左侧 danger 色 2px 行标)    │
│  描述文字 + 影响范围                            │
├─ 卡片2: 根因分析 ────────────────────────────┤
│  文字解释, 支持代码行内嵌 (inline mono)        │
├─ 卡片3: 修复建议 ────────────────────────────┤
│  编号步骤列表 (1. 2. 3.)                       │
│  [应用到编辑器] 次按钮 (每步可单独应用)         │
├─ 卡片4: 优化后代码 (diff 视图) ──────────────┤
│  ```javascript  [语言标签]      [Copy]         │
│  - return arr[arr.length];   (del 底+文字)     │
│  + return arr[arr.length - 1]; (add 底+文字)   │
│  修改统计: +1 -1                                │
├─ 卡片5: 相关知识点 (可折叠, 默认收起) ────────┤
│  [链接 chips] 闭包 · 数组越界 · 边界条件        │
└──────────────────────────────────────────────┘
```

卡片规范：
- rest = `--color-bg-secondary` 底 + 1px `--color-border` + `--radius-lg`；streaming 中 = 骨架行 + 右侧 caret；error = `--color-danger-subtle` 底 + 重试按钮。
- 每张卡可独立折叠（标题栏 `ChevronDown`/`ChevronRight`），折叠状态会话内记忆。
- 问题定位卡的行号可点击 → 中栏代码区滚动并高亮对应行（双向联动，两个面板的协同点）。

### 7.5 设置弹层（Modal，居中，宽 480px）

```
┌─ 设置 ────────────────────────────── [X] ─┐
│                                            │
│  LLM Provider                              │
│  [OpenAI        ▾]  (OpenAI / Anthropic /  │
│                    自定义 OpenAI 兼容端点)   │
│                                            │
│  API Key                                  │
│  [••••••••••••••••••] [显示]                │
│  仅存储于本浏览器 localStorage，会话级有效    │
│                                            │
│  模型                                      │
│  [gpt-4o-mini          ▾]                  │
│                                            │
│  主题                                      │
│  ( ) 跟随系统  (•) 深色  ( ) 浅色           │
│                                            │
│  数据                                      │
│  本机存有 12 条会话            [清空全部数据] │
│                                            │
│              [取消]  [保存]                 │
└────────────────────────────────────────────┘
```

- API Key 输入 `type="password"` + 显示切换；保存前做连通性测试（「测试连接」次按钮，loading 后给成功/失败 inline 反馈）。
- 「清空全部数据」为危险操作：二次确认（按钮变红色「确认清空？」）。
- Provider 切换时模型下拉联动刷新。

### 7.6 空状态（首次进入，禁空洞文案）

```
┌─ 中栏 ──────────────────────────────────────┐
│                                              │
│   把问题代码贴进来，剩下的交给分析            │  ← text-2xl
│                                              │
│   ┌─ 示例代码 (真实可点的 bug) ──────────┐   │
│   │ 1  function getLastItem(arr) {       │   │
│   │ 2    return arr[arr.length]          │   │  ← mono, 真实语法高亮
│   │ 3  }                                 │   │
│   │ [用这段代码试试]                      │   │  ← 一键填入编辑区
│   └──────────────────────────────────────┘   │
│                                              │
│   试试这样问:                                │
│   [这段代码有什么 bug？]                      │  ← 3 个具体提问 chips
│   [解释这段代码的时间复杂度]                  │
│   [优化这个函数并说明理由]                    │
│                                              │
│   快捷键: Enter 发送 · Shift+Enter 换行       │  ← text-xs, tertiary
└──────────────────────────────────────────────┘
```

- 空状态文案全部是具体动作描述，无「Welcome to」「Get started」类空话。
- 示例代码是一个真实 off-by-one bug（用户点「用这段代码试试」直接进入分析流程，10 秒内体验到产品核心价值）。
- 首次进入若检测到无 API Key：中栏上方出现 inline 引导条（`--color-warning-subtle` 底）：「还未配置 API Key，前往设置 →」，带「去配置」文字按钮——不弹阻断式 Modal。

### 7.7 加载态（流式输出）

```
┌─ 右栏 AI 消息 (streaming) ──────────────────┐
│ 结论摘要: 文字逐 token 涌出, 尾部 caret ▍     │  ← caret = --color-accent
│ ┌─ 问题定位卡 (骨架) ─────────────────────┐ │
│ │ ████████░░░░░░░░░░  shimmer 扫过         │ │  ← 骨架条 + shimmer
│ │ ██████░░░░░░░░░░░░░░                    │ │
│ └─────────────────────────────────────────┘ │
│ ...后续卡片按序从骨架填充为真实内容            │
└──────────────────────────────────────────────┘
```

- 排队等待首 token（0.2–2s）：消息位显示 3 个 `--radius-full` 圆点脉冲（opacity 交错，150ms 步进），**不显示假进度条**。
- 流式中：代码块未闭合时按纯文本等宽渲染（不闪烁），闭合后二次语法高亮。
- 用户停止：保留已输出部分 + 消息底部「已中断 · [继续生成] [重新生成]」。

### 7.8 错误态（四类，各有明确文案与恢复动作）

| 错误 | 呈现 | 恢复动作 |
|---|---|---|
| Key 未配置 | 中栏顶部 inline 引导条（warning-subtle 底） | [去设置] 按钮直达设置弹层 |
| 请求失败（网络/4xx/5xx） | 右栏错误卡（danger-subtle 底）：一句话原因 + 原始错误码 | [重试] 按钮（保留原输入） |
| 触发限流（429） | 错误卡：说明已达 provider 限额 | [切换模型] [重试] |
| 超时 | 错误卡：说明超过 N 秒未响应 | [重试]（带更大超时提示） |

规则：不出现「Something went wrong」式笼统文案；每条错误给「发生了什么 + 为什么 + 一步恢复动作」。

---

## 8. 交互细节

### 8.1 流式输出节奏

1. **首 token 目标 < 800ms**：用户点发送后，输入区立即禁用并显示停止按钮；请求发出，排队期显示三点脉冲。
2. **渲染节流**：前端按 30–60ms 批量合并 token 渲染（不逐 token 重排），代码块闭合后二次高亮。
3. **自动滚动纪律**：仅当视口距底部 ≤100px 时跟随滚动；用户上滚立即锁定位置，右下角浮现「跳到最新」浮动按钮（`--shadow-overlay` + `--radius-full`）。
4. **caret**：流式文本尾部 1s 闪烁竖条（`--color-accent`），停止后消失。
5. **卡片渐进填充**：结构化卡片按「问题定位 → 根因 → 修复 → diff → 知识点」顺序，先出卡架（标题+骨架）后填内容，用户始终知道还有什么要来。

### 8.2 代码块一键复制

- 每个代码块右上角悬浮 `Copy` 图标按钮（16px），hover 显现、触屏常驻。
- 点击 → 图标 150ms 内切换为 `Check`（`--color-success`）→ 1.5s 后恢复；同时 Toast「已复制」（`--z-toast`，250ms 淡入，2s 自动消失）。
- 复制内容 = 去掉行号的纯代码文本。

### 8.3 消息操作

- **桌面**：hover AI 消息时右侧浮现操作列 `Copy` / `RefreshCw`（重新生成）/ `Pencil`（编辑重问）/ `Ellipsis`（更多）。
- **移动端**：操作列常驻为消息下方一排小按钮（44px 触摸目标）。
- **重新生成**：采用变体轮播——旧回复收进「上一个版本」折叠区，新回复为主，底部「‹ 1/2 ›」切换，保留可对比（ChatGPT/Claude 模式）。
- **编辑重问**：用户消息变为可编辑文本框，确认后从该点分叉新会话线（旧线保留在历史中，标注「已从编辑处分叉」）。

### 8.4 会话切换

- 左栏点击切换，当前项高亮（`--color-accent-subtle` 底 + 2px 左标）；切换前若正在流式，先 abort 请求并Toast「已停止当前生成」。
- 会话数据存 localStorage（免登录 = 会话级），左栏按更新时间倒序，超过 50 条时旧会话折叠进「更早」分组。
- 「新建会话」立即创建空白会话并聚焦中栏代码区（不弹确认，空会话无数据损失）。

### 8.5 移动端 Tab 切换

- 底部 TabBar 三 Tab：代码 / 结果 / 历史；切换 150ms 交叉淡入，无滑动动画（reduced-motion 友好）。
- 「结果」Tab 在流式期间显示 accent 圆点；切到该 Tab 自动滚到最新。
- 历史 Tab 内顶部搜索框（按标题/代码片段过滤），左滑会话项显露 `Trash2` 删除。

### 8.6 快捷键（桌面）

| 键 | 动作 |
|---|---|
| Enter | 发送问题 |
| Shift+Enter | 输入框换行 |
| Ctrl/Cmd+Enter | 分析当前代码（中栏聚焦时） |
| Ctrl/Cmd+K | 新建会话 |
| Esc | 关闭弹层 / 退出代码选中态 |

---

## 附 A：组件 5 态覆盖检查表

| 组件 | Loading | Empty | Error | Populated | Edge |
|---|---|---|---|---|---|
| 代码编辑区 | 骨架编辑器 + 语言标签 | 空状态示例（§7.6） | 语法解析失败提示 | 完整编辑器 + 行号 | >2000 行提示建议分段分析 |
| 消息流 | 三点脉冲 + caret | 空状态 | 四类错误卡（§7.8） | 完整消息 + 操作列 | 超长消息折叠（>2000 字显示「展开全文」） |
| 结构化结果卡 | 骨架 shimmer | 「未发现问题」+ 成功态图标 | 重试按钮 | 完整卡片 | diff 过大分页（>100 行显示前 50 行 + 展开） |
| 会话列表 | 骨架行 | 「还没有会话」+ 新建按钮 | 读取失败 + 重试 | 会话列表 | >50 条折叠「更早」分组 |
| 设置弹层 | Key 测试中 spinner | 表单空值态 | 字段级错误（红框+文案） | 已保存态 | localStorage 写入失败降级为内存态 + Toast |

## 附 B：可访问性基线（实现期门禁）

- 对比度：正文 ≥4.5:1（两套 Token 色值均通过）、大字 ≥3:1；焦点环 `0 0 0 3px var(--color-accent-subtle)` + 2px accent 边（`--focus-ring` Token）。
- 键盘：全部功能可 Tab 到达；模态框焦点圈禁（focus trap）；Esc 关闭。
- `prefers-reduced-motion`：动效归零、caret 停闪、shimmer 停。
- 触摸目标 ≥44×44px，按钮间距 ≥8px。
- 语义色不同时作为唯一信息载体（错误同时带图标 + 文字）。

## 附 C：知识库引用

1. `references/design-systems/token-standard.md`（完整阅读）——四层 Token 架构、间距/圆角/阴影/动效收敛值、5 态覆盖标准、DESIGN.md 9 节模板、Master+Overrides 持久化模式。
2. `references/industries/ai-native.md`（Glob 选读，与「AI/开发者工具」最相关）——AI 原生产品配色方向（深蓝/靛蓝 + 翠绿强调、禁紫粉渐变）、对话式交互布局、流式响应组件模式、5 态覆盖、反模式警告（Lucide Sparkles/Brain/Wand2、禁 emoji、禁空洞占位、禁弹跳缓动）。

## 附 D：联网调研来源

1. Phind — 产品界面与前端实践分析（lbbai.com/sites/2619.html、CSDN 博客 164298500、LogRocket 10 AI tools）——左右分栏（代码/答案 + 来源）、深浅色跟随系统、粘贴即解析、虚拟滚动。
2. Cursor — cursor.com / cursor.com/cn/blog/cursor-3 / 百度智能云界面解析——三栏 IDE 布局、可折叠侧栏、agent 面板、diff 视图、选中代码行内指令、状态栏连接指示。
3. v0.dev — v0.app/docs/quickstart / design-mode / 百度百科——左侧对话 + 右侧 Preview/Code 双 Tab、版本 diff、暗色主题、Tailwind/shadcn 技术底座。
4. ChatGPT / Claude 聊天界面范式 — setproduct.com《AI chat interface UI design》（消息流九区解剖、流式子状态、Stop/Regenerate 放置、移动端单栏）、gummble.com《Best AI Chatbot App Designs 2026》——流式 typewriter、复制按钮、变体轮播、键盘快捷键。
5. DevTools 美学与代码排版 — uiprompt.dev（DevTools Aesthetic / Modern Technical：深色 IDE 背景 `#0D1117`/`#161B22`、1px 边框、mono 主导）、devignify.studio（dev tools 排版：mono 字体、14–16px 正文、行高 1.4–1.6）、deepwiki（代码块样式：pre 隐藏滚动条、行高 1.5、移动端 12px）。
