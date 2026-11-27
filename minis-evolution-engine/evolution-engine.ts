/**
 * 进化引擎 - 编排入口
 * 单次进化循环：收集 Gap → 生成 N 个候选 → 静态校验 → 评分 → 推送 Top-K → 轮询审批 → 触发验收 → 记录基因库
 */

import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  EvolutionEngineConfig,
  Gap,
  CandidateProposal,
  ScoredCandidate,
  EvolutionCycleResult,
  StaticValidationResult,
  UnifiedError,
  createError,
  GenerationContext,
} from './types.js';
import { runGenerationPipeline, collectAllGaps, createGenerationContext } from './proposal-generator.js';
import { runStaticValidation, ValidationContext } from './static-validator.js';
import { runFullScoringPipeline, filterTopK, KnownBug } from './scorer.js';
import { CodeLensClient, createClientFromConfig, pushAndPollAll, createClientAndVerify, type PushAndPollResult } from './codelens-client.js';
import { GenePool, createGenePool, recordCycleResults } from './gene-pool.js';

// ========== 默认配置 ==========

function getDefaultConfig(): EvolutionEngineConfig {
  return {
    codeLensUrl: process.env.CODELENS_URL ?? 'http://localhost:8080',
    apiKey: process.env.CODELENS_API_KEY ?? '',
    concurrency: 3,
    timeoutMs: 180_000,
    retryAttempts: 3,
    retryBaseDelayMs: 1000,
    topK: 3,
    minScoreThreshold: 60,
    staticValidation: {
      maxFileLines: 300,
      strictMode: true,
      forbiddenPatterns: [
        'eval', 'Function', 'globalThis', 'process.env', 'child_process',
        'fs.write', 'fs.read', 'net.', 'http.', 'https.',
      ],
    },
    scoring: {
      referenceTestsWeight: 50,
      mutationKillWeight: 0,
      bugReproductionWeight: 30,
      staticAnalysisWeight: 20,
    },
    genePool: {
      enabled: true,
      path: '.self-upgrade/gene-pool.json',
      maxEntries: 1000,
    },
  };
}

function mergeConfig(userConfig: Partial<EvolutionEngineConfig>): EvolutionEngineConfig {
  const defaults = getDefaultConfig();
  return {
    ...defaults,
    ...userConfig,
    staticValidation: { ...defaults.staticValidation, ...userConfig.staticValidation },
    scoring: { ...defaults.scoring, ...userConfig.scoring },
    genePool: { ...defaults.genePool, ...userConfig.genePool },
  };
}

// ========== 进化引擎类 ==========

export interface EngineOptions {
  config?: Partial<EvolutionEngineConfig>;
  projectRoot?: string;
  sessionId?: string;
  knownBugs?: KnownBug[];
  onProgress?: (stage: string, progress: number, total: number) => void;
  onCycleComplete?: (result: EvolutionCycleResult) => void;
}



export class EvolutionEngine {
  private config: EvolutionEngineConfig;
  private projectRoot: string;
  private sessionId: string;
  private knownBugs: KnownBug[];
  private genePool: GenePool | null = null;
  private client: CodeLensClient | null = null;
  private onProgress?: (stage: string, progress: number, total: number) => void;
  private onCycleComplete?: (result: EvolutionCycleResult) => void;

  constructor(options: EngineOptions = {}) {
    this.config = mergeConfig(options.config ?? {});
    this.projectRoot = options.projectRoot ?? process.cwd();
    this.sessionId = options.sessionId ?? randomUUID();
    this.knownBugs = options.knownBugs ?? [];
    this.onProgress = options.onProgress;
    this.onCycleComplete = options.onCycleComplete;
  }

  // 初始化客户端和基因库
  async initialize(): Promise<void> {
    if (!this.client) {
      this.client = await createClientAndVerify(this.config);
    }
    if (!this.genePool) {
      this.genePool = new GenePool(this.config.genePool.path, this.config.genePool.maxEntries);
    }
  }

  // 单次进化循环
  async runCycle(): Promise<EvolutionCycleResult> {
    const cycleId = `cycle-${Date.now()}-${randomUUID().slice(0, 8)}`;
    const startedAt = new Date().toISOString();
    const errors: string[] = [];

    const result: EvolutionCycleResult = {
      cycleId,
      startedAt,
      gapsCollected: 0,
      candidatesGenerated: 0,
      candidatesValidated: 0,
      candidatesScored: 0,
      proposalsPushed: 0,
      proposalsAccepted: 0,
      proposalsRejected: 0,
      errors,
      durationMs: 0,
    };

    try {
      this.reportProgress('collecting-gaps', 0, 7);
      // 1. 收集 Gap
      const genContext = createGenerationContext(this.config.codeLensUrl, this.config.apiKey, this.projectRoot);
      const gaps = await collectAllGaps(genContext);
      result.gapsCollected = gaps.length;
      this.reportProgress('collecting-gaps', 1, 7);

      if (gaps.length === 0) {
        this.log('[engine] 没有收集到 Gap，跳过本轮');
        return this.finalizeResult(result);
      }

      this.reportProgress('generating', 1, 7);
      // 2. 生成候选
      const candidates = await runGenerationPipeline(genContext, {
        maxCandidatesPerGap: Math.ceil(this.config.concurrency * 2),
      });
      result.candidatesGenerated = candidates.length;
      this.reportProgress('generating', 2, 7);

      if (candidates.length === 0) {
        this.log('[engine] 没有生成候选，跳过本轮');
        return this.finalizeResult(result);
      }

      this.reportProgress('validating', 2, 7);
      // 3. 静态校验
      const validatedCandidates = await this.validateCandidates(candidates);
      result.candidatesValidated = validatedCandidates.length;
      this.reportProgress('validating', 3, 7);

      if (validatedCandidates.length === 0) {
        this.log('[engine] 静态校验全部失败，跳过本轮');
        return this.finalizeResult(result);
      }

      this.reportProgress('scoring', 3, 7);
      // 4. 评分
      const scored = await this.scoreCandidates(validatedCandidates);
      result.candidatesScored = scored.length;
      this.reportProgress('scoring', 4, 7);

      // 5. 筛选 Top-K
      const topCandidates = filterTopK(scored, this.config.topK, this.config.minScoreThreshold);
      this.log(`[engine] Top-${this.config.topK} 候选: ${topCandidates.map(c => `${c.id.slice(0,8)}(${c.scoreBreakdown.total})`).join(', ')}`);

      if (topCandidates.length === 0) {
        this.log('[engine] 无候选达到分数阈值，跳过推送');
        return this.finalizeResult(result);
      }

      this.reportProgress('pushing', 4, 7);
      // 6. 推送并轮询
      if (!this.client) await this.initialize();
      const pushResults = await pushAndPollAll(this.client!, topCandidates.map(c => ({
        proposalId: c.id,
        patch: c.patch ?? '',
        targetPath: c.targetPath,
        kind: c.kind,
      })), {
        verifySuite: 'unit',
        onProgress: (completed, total) => {
          this.reportProgress('pushing', 4 + completed / total, 7);
        },
      });
      result.proposalsPushed = topCandidates.length;
      result.proposalsAccepted = pushResults.filter(r => r.verdict === 'accepted').length;
      result.proposalsRejected = pushResults.filter(r => r.verdict === 'rejected').length;

      this.reportProgress('verification', 5, 7);
      // 7. 记录验收结果（CodeLens 侧会自动回传 /rsi/verification）
      // 这里只做基因库记录，实际验收由 CodeLens 侧异步完成
      const verificationMap = new Map<string, boolean>();
      for (const r of pushResults) {
        if (r.verdict === 'accepted') verificationMap.set(r.proposalId, true);
        if (r.verdict === 'rejected') verificationMap.set(r.proposalId, false);
      }

      this.reportProgress('gene-pool', 6, 7);
      // 8. 基因库记录
      if (this.config.genePool.enabled && this.genePool) {
        const { recordCycleResults } = await import('./gene-pool.js');
        await recordCycleResults(this.genePool, scored, verificationMap);
      }

    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      errors.push(`[${new Date().toISOString()}] ${error}`);
      this.log(`[engine] 错误: ${error}`);
    }

    return this.finalizeResult(result);
  }

  private async validateCandidates(candidates: CandidateProposal[]): Promise<CandidateProposal[]> {
    const { runStaticValidation } = await import('./static-validator.js');
    const validated: CandidateProposal[] = [];

    for (const candidate of candidates) {
      const targetFiles = candidate.patch
        ? extractFilesFromPatch(candidate.patch)
        : [candidate.targetPath];

      const validation = await runStaticValidation(targetFiles, {
        config: this.config.staticValidation,
        projectRoot: this.projectRoot,
      });

      if (validation.ok) {
        validated.push(candidate);
      } else {
        this.log(`[validator] ${candidate.targetPath} 校验失败: ${validation.summary.errors} errors`);
      }
    }

    return validated;
  }

  private async scoreCandidates(candidates: CandidateProposal[]) {
    const { runFullScoringPipeline } = await import('./scorer.js');
    return runFullScoringPipeline(candidates, this.config, this.projectRoot, this.knownBugs);
  }

  private reportProgress(stage: string, progress: number, total: number): void {
    if (this.onProgress) {
      this.onProgress(stage, progress, total);
    }
  }

  private finalizeResult(result: EvolutionCycleResult): EvolutionCycleResult {
    result.completedAt = new Date().toISOString();
    result.durationMs = Date.parse(result.completedAt) - Date.parse(result.startedAt);
    if (this.onCycleComplete) {
      this.onCycleComplete(result);
    }
    return result;
  }

  private log(message: string): void {
    console.log(`[${new Date().toISOString()}] ${message}`);
  }
}

// ========== 辅助函数 ==========

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

// ========== CLI 入口 ==========

export async function runFromCLI(args: string[]): Promise<void> {
  const config: Partial<EvolutionEngineConfig> = {};

  // 解析参数
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--url' && args[i + 1]) {
      getDefaultConfig().codeLensUrl = args[++i];
    } else if (arg === '--key' && args[i + 1]) {
      getDefaultConfig().apiKey = args[++i];
    } else if (arg === '--once') {
      // 单次运行模式
    } else if (arg === '--top-k' && args[i + 1]) {
      getDefaultConfig().topK = parseInt(args[++i], 10);
    } else if (arg === '--min-score' && args[i + 1]) {
      getDefaultConfig().minScoreThreshold = parseInt(args[++i], 10);
    }
  }

  const engine = new EvolutionEngine({ config: getDefaultConfig() });
  await engine.initialize();
  const result = await engine.runCycle();

  console.log('\n=== 进化循环完成 ===');
  console.log(`Cycle ID: ${result.cycleId}`);
  console.log(`耗时: ${result.durationMs}ms`);
  console.log(`Gap: ${result.gapsCollected}`);
  console.log(`候选: ${result.candidatesGenerated} -> 校验: ${result.candidatesValidated} -> 评分: ${result.candidatesScored}`);
  console.log(`推送: ${result.proposalsPushed} | 通过: ${result.proposalsAccepted} | 拒绝: ${result.proposalsRejected}`);
  if (result.errors.length > 0) {
    console.log('错误:');
    for (const e of result.errors) console.log(`  - ${e}`);
  }
}

// ========== 导出 ==========

export { EvolutionEngineConfig, EvolutionCycleResult } from './types.js';
export { createGenePool, GenePool } from './gene-pool.js';
export { CodeLensClient } from './codelens-client.js';
export { runStaticValidation } from './static-validator.js';
export { runFullScoringPipeline } from './scorer.js';
export { runGenerationPipeline } from './proposal-generator.js';