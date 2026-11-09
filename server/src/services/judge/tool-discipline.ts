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
import { config } from '../../config/env.js';
import type { CriterionVerdict, JudgeEvidence } from './types.js';

// ── 路径推导（从 test 文件平移过来，保持同口径）──────────────────────────────

const here = path.dirname(fileURLToPath(import.meta.url));
// src/services/judge → 上级是 src → 再上级是 server 根
const serverRoot = path.resolve(here, '..', '..', '..');
const srcDir = path.join(serverRoot, 'src');
const testsDir = path.join(serverRoot, 'tests');

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

  // 动态检查：**本会话**的任务作用域必须已回收干净（tool.forge 写在沙箱内）。
  // 只看 .json 定义：events.jsonl 是审计凭据，必须保留，否则生命周期闸无从复算。
  const scopeDir = path.join(config.sandboxRoot, 'tmp', 'tools', evidence.sessionId);
  if (existsSync(scopeDir)) {
    try {
      const leftover = readdirSync(scopeDir).filter((f) => f.endsWith('.json'));
      if (leftover.length > 0) {
        issues.push(`任务作用域 ${scopeDir} 仍有未回收工具：${leftover.join(', ')}`);
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

/** 动态工具生命周期事件（tool.forge 写入 tmp/tools/<sessionId>/events.jsonl）。 */
interface DynamicToolEvent {
  ts: number;
  event: 'tool_created' | 'tool_used' | 'tool_failed' | 'tool_removed' | 'lesson';
  name?: string;
  why?: string;
  steps?: number;
  text?: string;
  reason?: string;
}

/** 读当前会话的动态工具事件；目录不存在 = 这个任务没有造过工具。 */
function readDynamicToolEvents(sessionId: string): DynamicToolEvent[] | null {
  const file = path.join(config.sandboxRoot, 'tmp', 'tools', sessionId, 'events.jsonl');
  if (!existsSync(file)) return null;
  try {
    return readFileSync(file, 'utf8')
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as DynamicToolEvent);
  } catch {
    return null;
  }
}

/**
 * 闸 2 · 动态工具生命周期闸
 *
 * 升级自静态时代的「沉淀配对 tripwire」：那时系统根本没有造工具的路径，
 * 只能永远记 unexec。现在 tool.forge 提供了真实路径，这条闸改成**逐阶段打分**：
 *
 *   ① 创建时写了「现有工具为何不够」（why ≥ 8 字）
 *   ② 定义合法且含步骤（steps ≥ 1）
 *   ③ 被真实调用成功（tool_used）
 *   ④ 任务结束被回收（tool_removed）
 *   ⑤ 回收时回答了沉淀三问，且 lesson 与被删工具配对
 *
 * 分数 = 完成阶段数 / 5。这个分数就是「造能力」这件事在 RSI 里的读数：
 * 只造不收 = 0.6，造了不用 = 0.4，什么都不做 = unexec（不是 pass）。
 *
 * 没造过工具时仍记 unexec —— C4：没发生 ≠ 通过。
 */
export function dynamicToolLifecycleGate(evidence: JudgeEvidence): CriterionVerdict {
  const events = readDynamicToolEvents(evidence.sessionId);
  if (events === null) {
    return {
      layer: 'L1',
      criterion: 'tool.discipline.lesson_pairing',
      status: 'unexec',
      detail: '本任务未创建动态工具（无 tmp/tools/<session>/events.jsonl），生命周期不可测，按 C4 记 unexec',
    };
  }

  const created = events.filter((e) => e.event === 'tool_created');
  const used = new Set(events.filter((e) => e.event === 'tool_used').map((e) => e.name));
  const removed = new Set(events.filter((e) => e.event === 'tool_removed').map((e) => e.name));
  const lessons = new Set(events.filter((e) => e.event === 'lesson').map((e) => e.name));

  // 逐工具取最好成绩：一个工具走完 5 阶段即 1.0；多个工具取平均。
  const names = [...new Set(created.map((e) => e.name).filter((n): n is string => !!n))];
  if (names.length === 0) {
    return {
      layer: 'L1',
      criterion: 'tool.discipline.lesson_pairing',
      status: 'unexec',
      detail: '有事件文件但没有 tool_created，生命周期不可测',
    };
  }

  const perTool = names.map((name) => {
    const c = created.find((e) => e.name === name);
    const stages = [
      !!c && (c.why ?? '').trim().length >= 8,
      !!c && (c.steps ?? 0) >= 1,
      used.has(name),
      removed.has(name),
      lessons.has(name),
    ];
    return { name, hit: stages.filter(Boolean).length, missing: STAGE_LABELS.filter((_, i) => !stages[i]) };
  });

  const score = Math.round((perTool.reduce((s, t) => s + t.hit, 0) / (perTool.length * 5)) * 1000) / 1000;
  const detail = perTool
    .map((t) => `${t.name}: ${t.hit}/5${t.missing.length ? `（缺 ${t.missing.join('、')}）` : ''}`)
    .join('；');

  return {
    layer: 'L1',
    criterion: 'tool.discipline.lesson_pairing',
    status: score >= 1 ? 'pass' : 'fail',
    score,
    detail: `动态工具生命周期 ${detail}`,
  };
}

/** 五个阶段的名字，顺序与 dynamicToolLifecycleGate 的 stages 数组一致。 */
const STAGE_LABELS = [
  '创建理由(why_not_existing)',
  '定义合法(steps)',
  '真实使用(tool_used)',
  '回收(tool_removed)',
  '沉淀配对(lesson)',
];

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
    () => dynamicToolLifecycleGate(evidence),
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
