/**
 * 共享类型定义 - 与 CodeLens 侧契约一致
 * 纯 TypeScript，无外部框架依赖
 */

// ========== 基础类型 ==========

export type ProposalKind = 'patch' | 'skill' | 'eval';
export type Severity = 'high' | 'medium' | 'low' | 'error' | 'warning' | 'info';

export type StrategyTag = 'substitute' | 'combine' | 'adapt' | 'modify' | 'put-to-other-use' | 'eliminate' | 'reverse';

export interface GeneratorOptions {
  maxCandidatesPerGap?: number;
  strategies?: StrategyTag[];
}

export interface Position {
  line: number;
  column: number;
}

export interface Range {
  start: Position;
  end: Position;
}

// ========== Gap 与候选 ==========

export type GapSource = 'rsi-reflection' | 'user-feedback' | 'failure-log' | 'mutation-survivor' | 'reflection' | 'failed-run' | 'gene-pool-failure' | 'gene-pool-success';

export interface Gap {
  id: string;
  source: GapSource;
  description: string;
  severity: Severity;
  evidence?: Array<{ type: string; data?: unknown }>;
  relatedFiles?: string[];
  collectedAt: string; // ISO 8601
}

export type EvidenceType = 'test-pass' | 'mutation-kill' | 'bug-reproduction' | 'static-analysis' | 'manual-review' | 'gene-pool' | 'strategy' | 'verdict';

export interface Evidence {
  type: EvidenceType;
  description: string;
  data?: Record<string, unknown>;
}

export interface CandidateProposal {
  id: string;
  kind: ProposalKind;
  targetPath: string;
  patch?: string;           // unified diff 格式
  code?: string;            // 完整文件内容（用于新建文件）
  meta: {
    score: number;          // 0-100
    evidence: Evidence[];
    mutationKillRate: number; // 0-1
    generatedAt: string;    // ISO 8601
    strategy: string;       // 生成策略标识
  };
}

// ========== 静态校验 ==========

export interface StaticIssue {
  file: string;
  line: number;
  column: number;
  code: string;             // 规则代码，如 TS2304, FILE_SIZE, NAMING_CONVENTION
  message: string;
  severity: Severity;
  ruleId?: string;          // 具体规则 ID
}

export interface StaticValidationResult {
  ok: boolean;
  issues: StaticIssue[];
  summary: {
    errors: number;
    warnings: number;
    infos: number;
  };
}

// ========== 评分 ==========

export interface ScoreBreakdown {
  referenceTests: number;    // 0-40
  mutationKill: number;      // 0-30
  bugReproduction: number;   // 0-20
  staticAnalysis: number;    // 0-10
  total: number;             // 0-100
}

export interface ScoredCandidate extends CandidateProposal {
  scoreBreakdown: ScoreBreakdown;
}



// ========== 进化引擎配置 ==========

export interface EvolutionEngineConfig {
  codeLensUrl: string;
  apiKey: string;
  concurrency: number;           // 并发生成候选数
  timeoutMs: number;             // 单次循环超时
  retryAttempts: number;         // 重试次数
  retryBaseDelayMs: number;      // 指数退避基础延迟
  topK: number;                  // 推送 Top-K 进入审批
  minScoreThreshold: number;     // 最低分数阈值
  staticValidation: {
    maxFileLines: number;
    strictMode: boolean;
    forbiddenPatterns: string[];
  };
  scoring: {
    referenceTestsWeight: number;
    mutationKillWeight: number;
    bugReproductionWeight: number;
    staticAnalysisWeight: number;
  };
  genePool: {
    enabled: boolean;
    path: string;
    maxEntries: number;
  };
}

// Runtime exports for module resolution
export const EvolutionEngineConfig = {} as EvolutionEngineConfig;
export const EvolutionCycleResult = {} as EvolutionCycleResult;

// ========== 进化引擎上下文 ==========

export interface GenerationContext {
  codeLensUrl: string;
  apiKey?: string;
  genePool: GenePool;
  projectRoot: string;
}

// ========== 基因库 ==========

export interface GenePool {
  // Forward reference for GenePool class
  getSuccesses(limit: number): GenePoolEntry[];
  getFailures(limit: number): GenePoolEntry[];
  findRelevantPatterns(targetPath: string, kind: ProposalKind, limit: number): GenePoolEntry[];
}

export interface GenePoolContext {
  targetPath?: string;
  strategy?: string;
  verificationPassed?: boolean;
  errorCode?: string;
  errorMessage?: string;
  cycle?: string;
  [key: string]: unknown;
}

export interface GenePoolEntry {
  id: string;
  pattern: string;              // 成功/失败模式描述
  kind: 'success' | 'failure';
  proposalId: string;
  proposalKind: ProposalKind;
  score: number;
  context: GenePoolContext;
  createdAt: string;
  usageCount: number;
  lastUsedAt?: string;
}

// ========== 进化循环结果 ==========

export interface EvolutionCycleResult {
  cycleId: string;
  startedAt: string;
  completedAt?: string;
  gapsCollected: number;
  candidatesGenerated: number;
  candidatesValidated: number;
  candidatesScored: number;
  proposalsPushed: number;
  proposalsAccepted: number;
  proposalsRejected: number;
  errors: string[];
  durationMs: number;
}

// ========== 统一错误格式 ==========

export interface UnifiedError {
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
}

export function isUnifiedError(obj: unknown): obj is UnifiedError {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    'error' in obj &&
    typeof (obj as Record<string, unknown>).error === 'object' &&
    'code' in ((obj as Record<string, unknown>).error as Record<string, unknown>) &&
    'message' in ((obj as Record<string, unknown>).error as Record<string, unknown>)
  );
}

export function createError(code: string, message: string, details?: Record<string, unknown>): UnifiedError {
  return { error: { code, message, details } };
}