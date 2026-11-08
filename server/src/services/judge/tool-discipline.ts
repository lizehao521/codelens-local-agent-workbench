/**
 * §6 工具纪律的运行时机器闸 —— 强化内核宣言第 6 节「沉淀三问」。
 *
 * 与 tests/tool-discipline.test.ts 的关系：
 *   - 测试文件闸 1–3 已经把这套纪律的**静态检查逻辑**钉死；
 *   - 本文件把它们升级为**每轮 Judge 都跑的运行时判据**（CriterionVerdict），
 *     让工具纪律真正进入 verdict 流、被 RsiBridge 对账、被归因器消费（C2 闭环）。
 *
 * 当前 CodeLens 的工具是静态内置（tools/builtin/），**没有动态创建路径**。
 * 所以三闸在静态时代的行为：
 *   - 闸 1 孤儿工具闸：静态检查 BUILTIN_TOOLS ↔ ToolRegistry 一致性（可判定）
 *                    + 动态检查 tmp/tools/<sessionId>/ 是否为空（常态 pass/unexec）
 *   - 闸 2 沉淀配对闸：tripwire —— tmp/tools 出现但无生命周期事件时 fail；常态 unexec
 *   - 闸 3 写闸复用：静态检查每个进主树的工具是否有测试覆盖（可判定）
 *
 * 设计原则（自证 C3）：
 *   - 每条闸都必须能被破坏夹具打红：改坏 BUILTIN_TOOLS 注册 / 加未覆盖工具 / 加
 *     tmp/tools 但不配对 lesson，都必须得到 fail，绝不能永真。
 *   - 静态时代闸 2 常态是 unexec（C4：UNEXEC ≠ PASS），不假装通过。
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BUILTIN_TOOLS } from '../../tools/builtin/index.js';
import { ToolRegistry } from '../tools/registry.service.js';
import type { CriterionVerdict, JudgeEvidence } from './types.js';

// ── 路径推导（从 test 文件平移过来，保持同口径）──────────────────────────────

const here = path.dirname(fileURLToPath(import.meta.url));
// src/services/judge → 上级是 src → 再上级是 server 根
const serverRoot = path.resolve(here, '..', '..', '..');
const srcDir = path.join(serverRoot, 'src');
const testsDir = path.join(serverRoot, 'tests');
const SCOPE_DIR = path.join(serverRoot, 'tmp', 'tools');

// ── 工具标识推导（同 tool-discipline.test.ts 口径）──────────────────────────

function identifiersOf(def: { name: string; wireName: string }): string[] {
  const exportGuess = def.name.replace(/\W+(\w)/g, (_m, c: string) => c.toUpperCase()) + 'Tool';
  return [def.name, def.wireName, exportGuess, def.name.replace(/\./g, '_'), def.name.replace(/\./g, '-')];
}

/** 递归收集 .ts 文件（跳过 node_modules / .git / dist）。 */
function collectTsFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist') continue;
      collectTsFiles(abs, acc);
    } else if (entry.name.endsWith('.ts')) {
      acc.push(abs);
    }
  }
  return acc;
}

/**
 * 读取 tests/ 下全部 .ts 内容。
 *
 * **刻意不做缓存**：这条闸的消费者是「Agent 自己补测试」的闭环 ——
 * 同一进程里 Agent 刚写完 tests/xxx.test.ts，下一轮判决必须立刻看见，
 * 否则覆盖率永远停在旧值，Agent 会误以为自己没改好。
 */
function getCoverageFiles(): Map<string, string> {
  const DISCIPLINE_SELF = 'tool-discipline.test.ts';
  const all = new Map<string, string>();
  for (const file of collectTsFiles(testsDir)) {
    // 排除闸自身——否则闸的注释里提到工具名就把自己喂饱了，变成永真闸（C3 警告）
    if (file.endsWith(DISCIPLINE_SELF)) continue;
    try {
      all.set(file, readFileSync(file, 'utf8'));
    } catch { /* 读不了就跳过，这条闸降级成 unexec */ }
  }
  return all;
}

// ── 三闸实现 ──────────────────────────────────────────────────────────────

/**
 * 闸 1 · 孤儿工具闸
 *   静态：目录定义 ↔ 注册表 ↔ wireName 反查 ↔ 无重名（跟 test 文件闸 1 同口径）
 *   动态：task-scoped 目录 tmp/tools/<sessionId>/ 必须为空或不存在（任务结束义肢必截掉）
 */
export function orphanToolsGate(evidence: JudgeEvidence): CriterionVerdict {
  const issues: string[] = [];
  const registry = new ToolRegistry();
  registry.registerAll(BUILTIN_TOOLS);

  // 静态检查 1：目录定义必须能被注册表取到
  const missing = BUILTIN_TOOLS.filter((d) => registry.get(d.name) === undefined).map((d) => d.name);
  if (missing.length) issues.push(`BUILTIN_TOOLS 声明但注册表取不到：${missing.join(', ')}`);

  // 静态检查 2：wireName 反查必须都通
  const missingWire = BUILTIN_TOOLS.filter((d) => registry.getByWireName(d.wireName) === undefined).map(
    (d) => d.wireName,
  );
  if (missingWire.length) issues.push(`wireName 反查失败：${missingWire.join(', ')}`);

  // 静态检查 3：注册表条目数 = 目录条目数
  if (registry.list().length !== BUILTIN_TOOLS.length) {
    issues.push(`注册表条目数 ${registry.list().length} ≠ 目录条目数 ${BUILTIN_TOOLS.length}`);
  }

  // 静态检查 4：name / wireName 不得重复
  const names = BUILTIN_TOOLS.map((d) => d.name);
  const wires = BUILTIN_TOOLS.map((d) => d.wireName);
  if (new Set(names).size !== names.length) issues.push(`name 有重复：${names.join(', ')}`);
  if (new Set(wires).size !== wires.length) issues.push(`wireName 有重复：${wires.join(', ')}`);

  // 动态检查：task-scoped 目录必须为空或不存在
  const scopeDir = path.join(SCOPE_DIR, evidence.sessionId);
  if (existsSync(scopeDir)) {
    try {
      const leftover = readdirSync(scopeDir);
      if (leftover.length > 0) {
        issues.push(`任务作用域 ${scopeDir} 非空，存在孤儿工具：${leftover.join(', ')}`);
      }
    } catch (err) {
      issues.push(`无法读取任务作用域 ${scopeDir}：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (issues.length > 0) {
    return {
      layer: 'L1',
      criterion: 'tool.discipline.orphan',
      status: 'fail',
      detail: `孤儿工具闸未通过：${issues.join('；')}`,
    };
  }
  return {
    layer: 'L1',
    criterion: 'tool.discipline.orphan',
    status: 'pass',
    detail: `注册表一致（${BUILTIN_TOOLS.length} 工具）+ wireName 可反查 + 任务作用域为空`,
  };
}

/**
 * 闸 2 · 沉淀配对闸
 *   tool_removed 必须与一条 lesson 成对出现；只删不记即失败。
 *
 *   当前系统没有动态工具生命周期事件表（tool_created / tool_removed），
 *   所以常态是 unexec——不是「配对了所以通过」，是「根本没创建/删除过工具」。
 *   一旦未来引入动态工具路径，tripwire 会在这里打红，逼沉淀纪律跟上。
 */
export function lessonPairingGate(evidence: JudgeEvidence): CriterionVerdict {
  // 检查是否有动态工具写入（tripwire：test 文件闸 3 同口径）
  const srcFiles = collectTsFiles(srcDir);
  const dynamicWrites = srcFiles.filter((f) => {
    try {
      return readFileSync(f, 'utf8').includes('tmp/tools');
    } catch { return false; }
  });

  if (dynamicWrites.length === 0) {
    // 静态时代：没触发动态工具路径，本闸无对象可检查 → unexec（不是 pass）
    return {
      layer: 'L1',
      criterion: 'tool.discipline.lesson_pairing',
      status: 'unexec',
      detail: `静态工具时代：源码未出现 tmp/tools，无动态工具生命周期事件可配对，按 C4 记 unexec`,
    };
  }

  // 动态工具已引入：检查是否带全套 §6 纪律
  let hasLifecycleEvents = false;
  let hasLessonPairing = false;
  for (const f of srcFiles) {
    try {
      const body = readFileSync(f, 'utf8');
      if (body.includes('tool_created') && body.includes('tool_removed')) hasLifecycleEvents = true;
      if (/tool_removed[\s\S]{0,400}lesson|lesson[\s\S]{0,400}tool_removed/.test(body)) hasLessonPairing = true;
    } catch { /* skip */ }
  }

  const missing: string[] = [];
  if (!hasLifecycleEvents) missing.push('tool_created / tool_removed 生命周期事件');
  if (!hasLessonPairing) missing.push('沉淀配对（tool_removed 必须配对一条 lesson）');

  if (missing.length > 0) {
    return {
      layer: 'L1',
      criterion: 'tool.discipline.lesson_pairing',
      status: 'fail',
      detail: `源码已引入动态工具（${dynamicWrites.map((f) => path.basename(f)).join(', ')}），但 §6 纪律缺失：${missing.join('、')}`,
    };
  }

  return {
    layer: 'L1',
    criterion: 'tool.discipline.lesson_pairing',
    status: 'pass',
    detail: `动态工具生命周期事件完整 + tool_removed ↔ lesson 配对存在`,
  };
}

/**
 * 闸 3 · 写闸复用
 *   每个进主树的工具必须被至少一个测试引用（未过自证不许进主树）。
 *   这条闸在静态时代**每次运行都能判定**，是三闸里最不会永真的一条。
 */
export function writeGateReuse(): CriterionVerdict {
  const coverage = getCoverageFiles();
  const uncovered: string[] = [];
  for (const def of BUILTIN_TOOLS) {
    const ids = identifiersOf(def);
    const hit = [...coverage.values()].some((body) => ids.some((id) => body.includes(id)));
    if (!hit) uncovered.push(`${def.name}（应有测试引用 ${ids.join(' / ')} 之一）`);
  }

  const total = BUILTIN_TOOLS.length;
  const covered = total - uncovered.length;
  // score 是**连续覆盖率**，不只是二值 pass/fail：
  // 这样 Agent 每补一个工具的测试，RSI 的读数就真的严格变好一格。
  // 只给二值的话，10 个工具补 9 个仍然是 fail，跨代看不出一丝进步。
  const score = total > 0 ? Math.round((covered / total) * 1000) / 1000 : 0;

  if (uncovered.length > 0) {
    return {
      layer: 'L1',
      criterion: 'tool.discipline.write_gate',
      status: 'fail',
      score,
      detail: `写闸复用：${covered}/${total} 个内置工具有测试引用（覆盖率 ${(score * 100).toFixed(0)}%）。以下工具进了主树却没有测试覆盖：\n  ${uncovered.join('\n  ')}`,
    };
  }

  return {
    layer: 'L1',
    criterion: 'tool.discipline.write_gate',
    status: 'pass',
    score: 1,
    detail: `全部 ${total} 个内置工具均有测试引用，写闸复用成立`,
  };
}

/** 一次性跑三闸，返回 verdicts 数组。任何一条抛异常都降级为 unexec，不拖垮主判决。 */
export function runToolDisciplineGates(evidence: JudgeEvidence): CriterionVerdict[] {
  const out: CriterionVerdict[] = [];
  const gates: Array<() => CriterionVerdict> = [
    () => orphanToolsGate(evidence),
    () => lessonPairingGate(evidence),
    () => writeGateReuse(),
  ];
  for (const gate of gates) {
    try {
      out.push(gate());
    } catch (err) {
      out.push({
        layer: 'L1',
        criterion: 'tool.discipline.runtime_error',
        status: 'unexec',
        detail: `工具纪律闸异常：${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }
  return out;
}
