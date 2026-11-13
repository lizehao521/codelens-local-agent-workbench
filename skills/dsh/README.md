# DSH 预设（技能层）

来源：`DSH-16工具-48技能_1793937233541310102.zip`（DeepSeek Harness 异结构 preset 实盘导出）。

## 已安装

- 48 个技能：`skills/<name>/SKILL.md`（原样保留，未截断）
- 清单：`manifest.json`

## 未安装

- 19 个 `.mjs` 工具：按用户决定移除。它们是 DSH 插件模块（`defineTool`），
  需要 DSH 宿主的 tool service 才能执行，不能作为独立 CLI 运行。

## 与技能库的关系

技能库（`POST /api/v1/skills`）只存索引：名称、描述、标签与最多 12 条要点，
完整方法以本目录的 `SKILL.md` 为准。47/48 已入库；
`hermes-translation-loss-reduction` 因名称长度触发技能库的“长 token”密钥规则被拒，
文件保留在此目录。
