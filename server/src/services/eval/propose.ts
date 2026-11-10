/**
 * 提案验证 —— 「Agent 自己扩任务空间」的准入闸。
 *
 * 流程：Agent 联网检索真实缺陷模式 → 提交提案（参考实现 + 带缺陷实现 + 用例）
 *       → 本文件做机械验证 → 通过才晋升进测量集。
 *
 * 为什么必须有这一层：被测者自己出题，就有动机出「自己必过」的题。
 * 所以准入不靠它自述，而靠四条可机械复核的事实：
 *   1. 参考实现必须 100% 通过它自己给的用例（题目自洽）；
 *   2. 缺陷实现必须真的红（有真实失败模式，不是摆设）；
 *   3. 隐藏用例必须与公开用例不同（防「公开=隐藏」的白送）；
 *   4. **变异验证**：把参考实现按算子改坏，用例必须能杀掉这些变异体。
 *      杀不掉的变异体说明用例没有判别力 —— 那是假题，不进测量集。
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { runSourceCases } from './runner.js';
import { deepEqual } from './runner.js';
import { EVAL_SUITES, suiteStoreDir, type EvalCase, type EvalSuite } from './suites.js';

export interface EvalProposal {
  id: string;
  title: string;
  exportName: string;
  /** 正确实现（CommonJS）。只用于验证，不落进沙箱。 */
  reference: string;
  /** 带真实缺陷的实现（CommonJS）。晋升后写进沙箱作为待修任务。 */
  buggy: string;
  publicCases: EvalCase[];
  hiddenCases: EvalCase[];
  /** 检索到的外部依据（web.search 结果链接）。 */
  sourceUrls: string[];
}

export interface ProposalCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface MutationReport {
  total: number;
  killed: number;
  score: number;
  survivors: string[];
}

export interface ProposalValidation {
  accepted: boolean;
  checks: ProposalCheck[];
  mutation: MutationReport;
}

const ID_RE = /^[a-z][a-z0-9_]{2,31}$/;
const NAME_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** 源级变异算子。只替换第一处，保证变异体尽量仍可加载。 */
const MUTATORS: Array<{ name: string; find: RegExp; repl: string }> = [
  { name: '<=→<', find: /<=/, repl: '<' },
  { name: '>=→>', find: />=/, repl: '>' },
  { name: '===→!==', find: /===/, repl: '!==' },
  { name: '!==→===', find: /!==/, repl: '===' },
  { name: '<→<=', find: /<(?!=)/, repl: '<=' },
  { name: '>→>=', find: />(?!=)/, repl: '>=' },
  { name: '&&→||', find: /&&/, repl: '||' },
  { name: '||→&&', find: /\|\|/, repl: '&&' },
  { name: '+=→-=', find: /\+=/, repl: '-=' },
  { name: '-=→+=', find: /-=/, repl: '+=' },
  { name: '+→-', find: / \+ /, repl: ' - ' },
  { name: 'Math.max→Math.min', find: /Math\.max/, repl: 'Math.min' },
  { name: 'Math.min→Math.max', find: /Math\.min/, repl: 'Math.max' },
  { name: 'return→return null', find: /return /, repl: 'return null; void ' },
];

/** 数字字面量 +1：单独处理，因为要保留匹配到的原值。 */
function numericMutant(source: string): string | null {
  const m = source.match(/\b\d+\b/);
  if (!m || m.index === undefined) return null;
  const next = String(Number(m[0]) + 1);
  return source.slice(0, m.index) + next + source.slice(m.index + m[0].length);
}

/** 生成变异体（源码级）。加载失败的在验证时被跳过，不计入分母。 */
export function buildMutants(reference: string): Array<{ name: string; source: string }> {
  const out: Array<{ name: string; source: string }> = [];
  for (const m of MUTATORS) {
    if (!m.find.test(reference)) continue;
    const mutated = reference.replace(m.find, m.repl);
    if (mutated !== reference) out.push({ name: m.name, source: mutated });
  }
  const numeric = numericMutant(reference);
  if (numeric && numeric !== reference) out.push({ name: 'number+1', source: numeric });
  return out;
}

function casesOf(p: EvalProposal): EvalCase[] {
  return [...p.publicCases, ...p.hiddenCases];
}

function validateShape(p: EvalProposal, existingIds: readonly string[] = []): ProposalCheck[] {
  const checks: ProposalCheck[] = [];
  // 已晋升的套件同样算「已占用」：否则 Agent 可以用同名提案覆盖既有套件，
  // 把一道难题换成一道自己更容易满分的题 —— 判据就回到了被测者手里。
  // existingIds 由调用方从 allSuites(sandboxRoot) 取（内置 + 已晋升）。
  const taken = new Set<string>([...EVAL_SUITES.map((s) => s.id), ...existingIds]);
  checks.push({
    name: 'id 合法且不冲突',
    ok: typeof p.id === 'string' && ID_RE.test(p.id) && !taken.has(p.id),
    detail: taken.has(p.id) ? `id=${String(p.id)} 已被占用` : `id=${String(p.id)}`,
  });
  checks.push({
    name: '导出名合法',
    ok: typeof p.exportName === 'string' && NAME_RE.test(p.exportName),
    detail: `exportName=${String(p.exportName)}`,
  });
  checks.push({
    name: '有外部检索依据',
    ok: Array.isArray(p.sourceUrls) && p.sourceUrls.length > 0 && p.sourceUrls.every((u) => /^https?:\/\//.test(u)),
    detail: `sourceUrls=${Array.isArray(p.sourceUrls) ? p.sourceUrls.length : 0} 条`,
  });
  checks.push({
    name: '用例数量足够',
    ok:
      Array.isArray(p.publicCases) && p.publicCases.length >= 2 &&
      Array.isArray(p.hiddenCases) && p.hiddenCases.length >= 3,
    detail: `public=${p.publicCases?.length ?? 0} hidden=${p.hiddenCases?.length ?? 0}`,
  });
  return checks;
}

/**
 * 变异验证：参考实现被改坏后，用例必须能发现。
 *
 * 分母只算「能成功加载」的变异体 —— 语法都坏掉的变异体测不出用例的判别力。
 * 门槛：至少 3 个有效变异体，且杀死率 ≥ 0.6。
 */
export function mutationScore(p: EvalProposal): MutationReport {
  const cases = casesOf(p);
  const mutants = buildMutants(p.reference);
  let valid = 0;
  let killed = 0;
  const survivors: string[] = [];
  for (const m of mutants) {
    const r = runSourceCases(m.source, p.exportName, cases, `<mutant:${m.name}>`);
    if (r.error) continue; // 加载失败：不算有效变异体
    valid += 1;
    if (r.failures.length > 0) killed += 1;
    else survivors.push(m.name);
  }
  return {
    total: valid,
    killed,
    score: valid === 0 ? 0 : Math.round((killed / valid) * 1000) / 1000,
    survivors,
  };
}

export function validateProposal(
  p: EvalProposal,
  existingIds: readonly string[] = [],
): ProposalValidation {
  const checks = validateShape(p, existingIds);
  const ref = runSourceCases(p.reference, p.exportName, casesOf(p), '<reference>');
  checks.push({
    name: '参考实现全通过',
    ok: ref.error === undefined && ref.passed === ref.total,
    detail: ref.error ? ref.error : `passed ${ref.passed}/${ref.total}`,
  });

  const buggyPublic = runSourceCases(p.buggy, p.exportName, p.publicCases, '<buggy:public>');
  const buggyHidden = runSourceCases(p.buggy, p.exportName, p.hiddenCases, '<buggy:hidden>');
  checks.push({
    name: '缺陷实现能被公开用例发现',
    ok: buggyPublic.error === undefined && buggyPublic.failures.length > 0,
    detail: buggyPublic.error ? buggyPublic.error : `红 ${buggyPublic.failures.length} 条`,
  });
  checks.push({
    name: '缺陷实现能被隐藏用例发现',
    ok: buggyHidden.error === undefined && buggyHidden.failures.length > 0,
    detail: buggyHidden.error ? buggyHidden.error : `红 ${buggyHidden.failures.length} 条`,
  });

  const dup = p.hiddenCases.filter((h) =>
    p.publicCases.some((pub) => deepEqual(h.args, pub.args)),
  );
  checks.push({
    name: '隐藏用例与公开用例不重复',
    ok: dup.length === 0,
    detail: dup.length ? `重复 ${dup.map((d) => d.name).join('、')}` : '无重复',
  });

  const mutation = mutationScore(p);
  checks.push({
    name: '变异验证（≥3 个有效变异体，杀死率 ≥0.6）',
    ok: mutation.total >= 3 && mutation.score >= 0.6,
    detail: `killed ${mutation.killed}/${mutation.total}（${(mutation.score * 100).toFixed(0)}%）${
      mutation.survivors.length ? `；存活：${mutation.survivors.join('、')}` : ''
    }`,
  });

  return { accepted: checks.every((c) => c.ok), checks, mutation };
}

/** 通过验证的提案晋升进测量集：写缺陷实现 + 套件定义。 */
export function promoteProposal(
  sandboxRoot: string,
  p: EvalProposal,
): { implPath: string; suitePath: string } {
  const implRel = `eval/${p.id}/impl.cjs`;
  const implAbs = path.join(sandboxRoot, implRel);
  mkdirSync(path.dirname(implAbs), { recursive: true });
  writeFileSync(implAbs, p.buggy, 'utf8');

  const suite: EvalSuite = {
    id: p.id,
    title: p.title,
    implPath: implRel,
    exportName: p.exportName,
    publicCases: p.publicCases,
    hiddenCases: p.hiddenCases,
  };
  const suiteAbs = path.join(suiteStoreDir(sandboxRoot), `${p.id}.json`);
  mkdirSync(path.dirname(suiteAbs), { recursive: true });
  writeFileSync(suiteAbs, `${JSON.stringify(suite, null, 2)}\n`, 'utf8');

  // 同时把缺陷实现留一份到版本库的 fixture 目录：沙箱被回收后，
  // 启动脚本会从这里把缺失的实现补回沙箱，保证实验可复现。
  const fixtureAbs = path.join(sandboxRoot, '..', 'eval-fixtures', p.id, 'impl.cjs');
  mkdirSync(path.dirname(fixtureAbs), { recursive: true });
  writeFileSync(fixtureAbs, p.buggy, 'utf8');

  return { implPath: implRel, suitePath: suiteAbs };
}
