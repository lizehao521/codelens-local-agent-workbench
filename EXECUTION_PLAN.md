# CodeLens 核心补强执行计划 (2.32.0 收口 → P2)

## 优先级矩阵

| 优先级 | 任务 | 预估工时 | 状态 | 负责 |
|--------|------|---------|------|------|
| **P0-1** | Tool Forge 测试生成完善 (`generateTests`) | 1d | ✅ **完成** | Minis 实现 |
| **P0-2** | Tool Forge 晋升流程集成 generateTests | 1-2d | ✅ **完成**（0d193dc） | Minis 实现 |
| **P1-1** | Judge/Update 可视化面板 | 1d | ✅ **完成**（7e3c5d7） | Minis 实现 |
| **P1-2** | Update 策略版本化 + 自动 Changelog | 0.5d | ✅ **完成**（da9e919 + 本轮自动 Changelog） | Minis 实现 |
| **P2-1** | 检查点/回滚 UI | 1d | ⏳ 待定 | CodeLens |
| **P2-2** | Tool Forge 自动测试生成 | 1-2d | ✅ generateTests 完成 | Minis/CodeLens |

---

## P0-1 完成详情

### 实现内容
- **文件**: `server/src/tools/builtin/tool-forge.tool.ts`
- **函数**: `generateTests(spec: ForgeSpec): string`
- **功能**: 基于 ForgeSpec 自动生成 Vitest 测试代码
- **覆盖范围**:
  - `validateForgeSpec` 输入验证（正常/异常/边界）
  - `validateReferences` 引用过滤与限制
  - `composeLesson` 经验沉淀验证
  - ForgeSpec 结构校验

### 验证结果
```bash
# 编译通过
npm run build  # ✅ 通过

# 功能测试
node -e "const { generateTests } = require('./dist/tools/builtin/tool-forge.tool.js'); ..." 
# ✅ 生成 6319 字符的完整测试代码
```

---

## P0-2 当前状态

### 已完成
- ✅ 任务已创建并派发给 CodeLens (session: `4044ddb7-9348-429d-85a4-d60ae3798486`)
- ✅ 任务详细需求已通过 SSE 发送给 CodeLens Agent
- ✅ **API Key 已配置生效** (NVIDIA + RSI_API_KEYS)
- ✅ Server 健康运行 (v2.32.0)

### CodeLens 尝试情况
- CodeLens Agent 尝试读取 `tool-forge.tool.ts` 理解代码结构
- **问题**: fs.read 工具调用 JSON 解析失败，导致无法正常读取文件
- **结果**: 任务收敛但无实际代码修改

### 当前阻塞
| 阻塞点 | 状态 | 说明 |
|--------|------|------|
| **Tool 调用 JSON 解析** | 🔴 **阻塞** | CodeLens Agent 的 fs.read 工具调用 JSON 格式错误 |
| **文件读取失败** | 🔴 **阻塞** | 无法正常读取 tool-forge.tool.ts 实现集成 |

---

## 当前任务需求 (已下发)

CodeLens Agent 需要实现：
1. **集成 `generateTests` 到 `promote` 逻辑**: 晋升时自动生成测试、写入 `tests/tools/`、强制跑测试
2. **工具版本化**: semver、changelog、promotedAt
3. **回滚功能**: `demoteTool` 回滚功能
4. **完善晋升逻辑**: 在 `recycle` 时 `promote=true` 时自动生成测试、运行测试、版本化、写入能力库

---

## 下一步行动

**已完成（2.32.0 收口）**:
- Tool Forge 测试生成与晋升集成（P0-1 / P0-2）
- Judge 统计趋势可视化（P1-1）、π 策略版本历史与回滚（P1-2）
- 自动 Changelog 生成 + 发版切段（`npm run changelog` / `npm run changelog:release -- x.y.z`）

**待办**:
1. P2-1 检查点/回滚 UI（时间轴、一键恢复、差异预览）
2. P2-2 Minis 进化引擎优化：文件发现换 rg、基因库种子、候选 Patch 与真实文件内容对齐
3. 版本号已到 2.32.0，但仓库仍无 git tag —— 需要发布标签时再打 `v2.32.0`

---

## 下一步计划 (P1/P2)

| 优先级 | 任务 | 说明 | 状态 |
|--------|------|------|------|
| **P1-1** | Judge/Update 可视化面板 | 前端图表：通过率/Token/延迟钻取 | ✅ 2.31.0 |
| **P1-2** | Update 策略版本化 + 自动 Changelog | π 语义化版本 + 自动 Changelog 生成 | ✅ 2.32.0 |
| **P2-1** | 检查点/回滚 UI | 时间轴、一键恢复、差异预览 | ⏳ 待定 |
| **P2-2** | Minis 进化引擎优化 | 文件发现换 rg、基因库种子、Patch 质量提升 | ⏳ 待定 |
