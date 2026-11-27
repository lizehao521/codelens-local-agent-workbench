# CodeLens 核心补强执行计划 (v2.31.0 → v2.32.0)

## 优先级矩阵

| 优先级 | 任务 | 预估工时 | 状态 | 负责 |
|--------|------|---------|------|------|
| **P0-1** | Tool Forge 测试生成完善 (`generateTests`) | 1d | ✅ **完成** | Minis 实现 |
| **P0-2** | Tool Forge 晋升流程集成 generateTests | 1-2d | 🔄 **CodeLens 尝试中，工具调用问题** | CodeLens |
| **P1-1** | Judge/Update 可视化面板 | 1d | ⏳ 待定 | CodeLens |
| **P1-2** | Update 策略版本化 + 自动 Changelog | 0.5d | ⏳ 待定 | CodeLens |
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
- ✅ Server 健康运行 (v2.31.0)

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

**Minis 侧 (我)**:
1. 继续优化进化引擎（文件发现加速、基因库种子、Patch 质量）
2. 考虑为 CodeLens 提供更好的文件读取接口

**CodeLens 侧**:
- 修复 fs.read 工具调用的 JSON 解析问题
- 继续实现 P0-2 集成逻辑

**用户可以做**:
- 观察进度，如需可手动协助 CodeLens 完成集成

---

## 下一步计划 (P1/P2)

| 优先级 | 任务 | 说明 |
|--------|------|------|
| **P1-1** | Judge/Update 可视化面板 | 前端图表：通过率/Token/延迟钻取 |
| **P1-2** | Update 策略版本化 + 自动 Changelog | π 语义化版本 + 自动 Changelog 生成 |
| **P2-1** | 检查点/回滚 UI | 时间轴、一键恢复、差异预览 |
| **P2-2** | Minis 进化引擎优化 | 文件发现换 rg、基因库种子、Patch 质量提升 |
