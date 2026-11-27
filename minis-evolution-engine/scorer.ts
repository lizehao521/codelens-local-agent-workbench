/**
 * 评分器 - 参考测试、变异杀灭、缺陷复现、静态分析
 * 权重：参考测试 40% + 变异 30% + 缺陷 20% + 静态 10%
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import type {
  ScoredCandidate,
  CandidateProposal,
  ScoreBreakdown,
  EvolutionEngineConfig,
  StaticValidationResult,
} from './types.js';

// ========== 评分权重默认值 ==========

const DEFAULT_WEIGHTS = {
  referenceTests: 50,
  mutationKill: 0,
  bugReproduction: 30,
  staticAnalysis: 20,
} as const;

// ========== 参考测试评分 ==========

interface TestResult {
  passed: number;
  total: number;
  failed: number;
  skipped: number;
  durationMs: number;
}

async function runReferenceTests(
  targetFiles: string[],
  projectRoot: string,
  timeoutMs: number
): Promise<TestResult> {
  try {
    // 运行相关测试文件
    const testFiles = findRelatedTestFiles(targetFiles, projectRoot);
    if (testFiles.length === 0) {
      return { passed: 0, total: 0, failed: 0, skipped: 0, durationMs: 0 };
    }

    const start = Date.now();
    const { stdout } = execFileSyncSync('npx', ['vitest', 'run', ...testFiles], {
      cwd: projectRoot,
      encoding: 'utf-8',
      timeout: timeoutMs,
    });
    const durationMs = Date.now() - start;

    return parseVitestOutput(stdout);
  } catch (e) {
    const output = e instanceof Error ? e.message : String(e);
    const result = parseVitestOutput(output);
    result.durationMs = result.durationMs || 0;
    return result;
  }
}

function execFileSyncSync(cmd: string, args: string[], options: {
  cwd: string;
  encoding: BufferEncoding;
  timeout: number;
}): { stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(cmd, args, options);
    return { stdout: stdout as string, stderr: '' };
  } catch (e) {
    // 即使失败也返回 stdout
    const error = e as { stdout?: Buffer; stderr?: Buffer; message: string };
    return {
      stdout: error.stdout?.toString() ?? '',
      stderr: error.stderr?.toString() ?? error.message,
    };
  }
}

function findRelatedTestFiles(targetFiles: string[], projectRoot: string): string[] {
  const testFiles: string[] = [];
  for (const target of targetFiles) {
    const baseName = path.basename(target, path.extname(target));
    const testDir = path.join(projectRoot, 'tests');
    if (!existsSync(testDir)) continue;

    // 查找相关测试文件
    const candidates = [
      path.join(testDir, `${baseName}.test.ts`),
      path.join(testDir, `${baseName}.spec.ts`),
      path.join(testDir, baseName, 'index.test.ts'),
    ];
    for (const f of candidates) {
      if (existsSync(f)) testFiles.push(f);
    }
  }
  return [...new Set(testFiles)];
}

function parseVitestOutput(output: string): TestResult {
  const result: TestResult = { passed: 0, total: 0, failed: 0, skipped: 0, durationMs: 0 };
  const passMatch = output.match(/(\d+)\s+passed/);
  const failMatch = output.match(/(\d+)\s+failed/);
  const skipMatch = output.match(/(\d+)\s+skipped/);

  if (passMatch) result.passed = parseInt(passMatch[1], 10);
  if (failMatch) result.failed = parseInt(failMatch[1], 10);
  if (skipMatch) result.skipped = parseInt(skipMatch[1], 10);
  result.total = result.passed + result.failed + result.skipped;
  return result;
}

// ========== 变异杀灭率评分 ==========

interface MutationResult {
  totalMutants: number;
  killed: number;
  survived: number;
  killRate: number; // 0-1
}

async function runMutationTest(
  targetFiles: string[],
  projectRoot: string,
  timeoutMs: number
): Promise<MutationResult> {
  try {
    // 运行变异测试脚本
    const start = Date.now();
    const { stdout } = execFileSyncSync('node', ['../scripts/mutation-probe.mjs', ...targetFiles], {
      cwd: projectRoot,
      encoding: 'utf-8',
      timeout: timeoutMs,
    });
    return parseMutationOutput(stdout);
  } catch {
    // 变异测试失败返回默认值
    return { totalMutants: 0, killed: 0, survived: 0, killRate: 0 };
  }
}

function parseMutationOutput(output: string): MutationResult {
  // 解析 mutation-probe 输出
  // 示例输出: "Mutants: 10, Killed: 8, Survived: 2, Kill Rate: 80%"
  const totalMatch = output.match(/Mutants:\s*(\d+)/);
  const killedMatch = output.match(/Killed:\s*(\d+)/);
  const survivedMatch = output.match(/Survived:\s*(\d+)/);
  const rateMatch = output.match(/Kill Rate:\s*([\d.]+)%/);

  const total = totalMatch ? parseInt(totalMatch[1], 10) : 0;
  const killed = killedMatch ? parseInt(killedMatch[1], 10) : 0;
  const survived = survivedMatch ? parseInt(survivedMatch[1], 10) : total - killed;
  const killRate = rateMatch ? parseFloat(rateMatch[1]) / 100 : (total > 0 ? killed / total : 0);

  return { totalMutants: total, killed, survived, killRate };
}

// ========== 缺陷复现评分 ==========

export interface BugReproductionResult {
  reproduced: number;     // 成功复现的已知缺陷数
  total: number;          // 总共尝试的缺陷数
  newBugsFound: number;   // 新发现的缺陷数
}

export interface KnownBug {
  id: string;
  description: string;
  testCase: string;       // 复现测试用例路径
  expectedFailure: string; // 预期的失败模式
}

async function runBugReproduction(
  candidate: CandidateProposal,
  projectRoot: string,
  knownBugs: KnownBug[]
): Promise<BugReproductionResult> {
  let reproduced = 0;
  let total = knownBugs.length;
  let newBugsFound = 0;

  for (const bug of knownBugs) {
    try {
      // 运行特定测试用例验证缺陷是否被修复/复现
      const testPath = path.resolve(projectRoot, bug.testCase);
      const { stdout } = execFileSyncSync('npx', ['vitest', 'run', testPath], {
        cwd: path.dirname(projectRoot), // server 目录
        encoding: 'utf-8',
        timeout: 60_000,
      });

      // 检查输出是否包含预期的失败模式
      if (stdout.includes(bug.expectedFailure) || stdout.includes('FAIL')) {
        reproduced++;
      }
    } catch {
      // 测试运行出错，不计分
    }
  }

  return { reproduced, total, newBugsFound };
}

// ========== 静态分析评分 ==========

function scoreStaticAnalysis(validation: StaticValidationResult): number {
  const { summary } = validation;
  if (summary.errors > 0) return 0;
  if (summary.warnings > 10) return 3;
  if (summary.warnings > 5) return 5;
  if (summary.warnings > 0) return 8;
  return 10;
}

// ========== 主评分函数 ==========

interface ScoringContext {
  config: EvolutionEngineConfig;
  projectRoot: string;
  knownBugs: KnownBug[];
  staticValidationResults: Map<string, StaticValidationResult>;
}

export async function scoreCandidates(
  candidates: CandidateProposal[],
  context: ScoringContext
): Promise<ScoredCandidate[]> {
  const { config, projectRoot, knownBugs, staticValidationResults } = context;
  const weights = { ...DEFAULT_WEIGHTS, ...config.scoring };

  const scored: ScoredCandidate[] = [];

  for (const candidate of candidates) {
    const targetFiles = candidate.patch
      ? extractFilesFromPatch(candidate.patch)
      : [candidate.targetPath];

    // 1. 参考测试 (0-40)
    const testResult = await runReferenceTests(targetFiles, projectRoot, config.timeoutMs);
    const testScore = testResult.total > 0
      ? Math.round((testResult.passed / testResult.total) * weights.referenceTests)
      : 0;

    // 2. 变异杀灭 (0-30)
    const mutationResult = await runMutationTest(targetFiles, projectRoot, config.timeoutMs);
    const mutationScore = Math.round(mutationResult.killRate * weights.mutationKill);

    // 3. 缺陷复现 (0-20)
    const bugResult = await runBugReproduction(candidate as CandidateProposal, projectRoot, []);
    const bugScore = bugResult.total > 0
      ? Math.round((bugResult.reproduced / bugResult.total) * weights.bugReproduction)
      : 0;

    // 4. 静态分析 (0-10)
    const staticResult = staticValidationResults.get(candidate.targetPath) ?? { ok: true, issues: [], summary: { errors: 0, warnings: 0, infos: 0 } };
    const staticScore = scoreStaticAnalysis(staticResult);

    const breakdown: ScoreBreakdown = {
      referenceTests: testScore,
      mutationKill: mutationScore,
      bugReproduction: bugScore,
      staticAnalysis: staticScore,
      total: testScore + mutationScore + bugScore + staticScore,
    };

    scored.push({
      ...candidate,
      meta: {
        ...candidate.meta,
        score: breakdown.total,
      },
      scoreBreakdown: breakdown,
    });
  }

  // 按总分降序排序
  scored.sort((a, b) => b.scoreBreakdown.total - a.scoreBreakdown.total);
  return scored;
}

function extractFilesFromPatch(patch: string): string[] {
  const files: string[] = [];
  const lines = patch.split('\n');
  for (const line of lines) {
    const m = line.match(/^\+\+\+\s+(.+)$/);
    if (m && m[1]) {
      let f = m[1].trim();
      if (f.startsWith('b/')) f = f.slice(2);
      if (f !== '/dev/null') files.push(f);
    }
  }
  return [...new Set(files)];
}

// ========== 导出便捷函数 ==========

export async function runFullScoringPipeline(
  candidates: CandidateProposal[],
  config: EvolutionEngineConfig,
  projectRoot: string,
  knownBugs: KnownBug[] = []
): Promise<ScoredCandidate[]> {
  // 预运行静态校验（复用）
  const staticValidationResults = new Map<string, StaticValidationResult>();

  // 提取所有涉及的目标文件
  const allTargetFiles = new Set<string>();
  for (const c of candidates) {
    if (c.patch) {
      extractFilesFromPatch(c.patch).forEach(f => allTargetFiles.add(f));
    } else {
      allTargetFiles.add(c.targetPath);
    }
  }

  // 批量运行静态校验
  const { runStaticValidation } = await import('./static-validator.js');
  for (const file of allTargetFiles) {
    const result = await runStaticValidation([file], { config: config.staticValidation, projectRoot });
    staticValidationResults.set(file, result);
  }

  return scoreCandidates(candidates, {
    config,
    projectRoot,
    knownBugs,
    staticValidationResults,
  });
}

export function filterTopK(scored: ScoredCandidate[], topK: number, minScore: number): ScoredCandidate[] {
  return scored
    .filter(c => c.scoreBreakdown.total >= minScore)
    .slice(0, topK);
}