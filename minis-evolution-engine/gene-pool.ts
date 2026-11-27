/**
 * 基因库 - 成功/失败模式的持久化存储与检索
 * 用于生成器复用成功模式、评分器惩罚失败模式
 */

import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import type {
  GenePoolEntry,
  CandidateProposal,
  ScoredCandidate,
  ProposalKind,
  EvolutionEngineConfig,
  UnifiedError,
} from './types.js';

// ========== 基因库存储 ==========

interface GenePoolStorage {
  entries: GenePoolEntry[];
  version: number;
  updatedAt: string;
}

function createEmptyStorage(): GenePoolStorage {
  return {
    entries: [],
    version: 1,
    updatedAt: new Date().toISOString(),
  };
}

function loadStorage(poolPath: string): GenePoolStorage {
  if (!existsSync(poolPath)) return createEmptyStorage();
  try {
    const content = readFileSync(poolPath, 'utf8');
    const parsed = JSON.parse(content) as GenePoolStorage;
    // 兼容旧版本
    if (!parsed.version) parsed.version = 1;
    if (!parsed.updatedAt) parsed.updatedAt = new Date().toISOString();
    if (!Array.isArray(parsed.entries)) parsed.entries = [];
    return parsed;
  } catch {
    return createEmptyStorage();
  }
}

function saveStorage(poolPath: string, storage: GenePoolStorage): void {
  try {
    const dir = path.dirname(poolPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    storage.updatedAt = new Date().toISOString();
    writeFileSync(poolPath, JSON.stringify(storage, null, 2), 'utf8');
  } catch (e) {
    console.error('[gene-pool] 保存失败:', e instanceof Error ? e.message : String(e));
  }
}

// ========== 基因库类 ==========

export class GenePool {
  private storage: GenePoolStorage;
  private poolPath: string;
  private maxEntries: number;

  constructor(poolPath: string, maxEntries: number = 1000) {
    this.poolPath = poolPath;
    this.maxEntries = maxEntries;
    this.storage = loadStorage(poolPath);
  }

  // 记录成功模式
  recordSuccess(
    proposal: CandidateProposal | ScoredCandidate,
    context: Record<string, unknown> = {},
    verificationPassed: boolean = true
  ): GenePoolEntry {
    const entry: GenePoolEntry = {
      id: randomUUID(),
      pattern: this.extractPattern(proposal),
      kind: verificationPassed ? 'success' : 'failure',
      proposalId: proposal.id,
      proposalKind: proposal.kind,
      score: 'scoreBreakdown' in proposal ? proposal.scoreBreakdown.total : proposal.meta.score,
      context: {
        ...context,
        targetPath: proposal.targetPath,
        strategy: proposal.meta.strategy,
        verificationPassed,
      },
      createdAt: new Date().toISOString(),
      usageCount: 0,
    };

    this.storage.entries.push(entry);
    this.prune();
    saveStorage(this.poolPath, this.storage);
    return entry;
  }

  // 记录失败模式
  recordFailure(
    proposal: CandidateProposal | ScoredCandidate,
    error: UnifiedError,
    context: Record<string, unknown> = {}
  ): GenePoolEntry {
    const entry: GenePoolEntry = {
      id: randomUUID(),
      pattern: this.extractPattern(proposal),
      kind: 'failure',
      proposalId: proposal.id,
      proposalKind: proposal.kind,
      score: 'scoreBreakdown' in proposal ? proposal.scoreBreakdown.total : proposal.meta.score,
      context: {
        ...context,
        targetPath: proposal.targetPath,
        strategy: proposal.meta.strategy,
        errorCode: error.error.code,
        errorMessage: error.error.message,
      },
      createdAt: new Date().toISOString(),
      usageCount: 0,
    };

    this.storage.entries.push(entry);
    this.prune();
    saveStorage(this.poolPath, this.storage);
    return entry;
  }

  // 提取可复用模式描述
  private extractPattern(proposal: CandidateProposal): string {
    const parts = [
      proposal.kind,
      proposal.meta.strategy,
      proposal.targetPath.split('/').pop()?.replace(/\.(ts|tsx)$/, '') ?? 'unknown',
    ];
    return parts.filter(Boolean).join(':');
  }

  // 获取指定类型的成功模式
  getSuccessPatterns(kind: ProposalKind, limit: number = 50): GenePoolEntry[] {
    return this.storage.entries
      .filter(e => e.kind === 'success' && e.proposalKind === kind)
      .sort((a, b) => b.usageCount - a.usageCount || b.score - a.score)
      .slice(0, limit);
  }

  // 获取指定类型的失败模式（用于惩罚）
  getFailurePatterns(kind: ProposalKind, limit: number = 50): GenePoolEntry[] {
    return this.storage.entries
      .filter(e => e.kind === 'failure' && e.proposalKind === kind)
      .sort((a, b) => b.usageCount - a.usageCount)
      .slice(0, limit);
  }

  // 根据目标路径查找相关成功模式
  findRelevantPatterns(targetPath: string, kind: ProposalKind, limit: number = 10): GenePoolEntry[] {
    const fileName = path.basename(targetPath, path.extname(targetPath));
    return this.storage.entries
      .filter(e => e.kind === 'success' && e.proposalKind === kind)
      .filter(e => e.context.targetPath?.includes(fileName) || e.pattern.includes(fileName))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  // 增加使用计数
  incrementUsage(entryId: string): boolean {
    const entry = this.storage.entries.find(e => e.id === entryId);
    if (entry) {
      entry.usageCount++;
      entry.lastUsedAt = new Date().toISOString();
      saveStorage(this.poolPath, this.storage);
      return true;
    }
    return false;
  }

  // 裁剪旧条目
  private prune(): void {
    if (this.storage.entries.length > this.maxEntries) {
      // 保留高分、高使用率、近期的条目
      this.storage.entries.sort((a, b) => {
        const scoreA = a.score + a.usageCount * 10 + (a.lastUsedAt ? Date.parse(a.lastUsedAt) : 0);
        const scoreB = b.score + b.usageCount * 10 + (b.lastUsedAt ? Date.parse(b.lastUsedAt) : 0);
        return scoreB - scoreA;
      });
      this.storage.entries = this.storage.entries.slice(0, this.maxEntries);
    }
  }

  // 别名方法（兼容 proposal-generator 调用）
  getFailures(limit: number = 20): GenePoolEntry[] {
    return this.storage.entries
      .filter(e => e.kind === 'failure')
      .sort((a, b) => b.usageCount - a.usageCount)
      .slice(0, limit);
  }

  getSuccesses(limit: number = 20): GenePoolEntry[] {
    return this.storage.entries
      .filter(e => e.kind === 'success')
      .sort((a, b) => b.usageCount - a.usageCount)
      .slice(0, limit);
  }

  // 获取统计信息
  getStats(): {
    total: number;
    success: number;
    failure: number;
    byKind: Record<string, { success: number; failure: number }>;
  } {
    const byKind: Record<string, { success: number; failure: number }> = {};
    for (const entry of this.storage.entries) {
      if (!byKind[entry.proposalKind]) byKind[entry.proposalKind] = { success: 0, failure: 0 };
      byKind[entry.proposalKind][entry.kind]++;
    }
    return {
      total: this.storage.entries.length,
      success: this.storage.entries.filter(e => e.kind === 'success').length,
      failure: this.storage.entries.filter(e => e.kind === 'failure').length,
      byKind,
    };
  }

  // 导出用于备份/迁移
  export(): GenePoolEntry[] {
    return [...this.storage.entries];
  }

  // 导入
  import(entries: GenePoolEntry[]): void {
    this.storage.entries = entries;
    this.prune();
    saveStorage(this.poolPath, this.storage);
  }
}

// ========== 工厂函数 ==========

export function createGenePool(config: EvolutionEngineConfig): GenePool {
  return new GenePool(config.genePool.path, config.genePool.maxEntries);
}

// ========== 导出便捷函数 ==========

export async function recordCycleResults(
  genePool: GenePool,
  scored: ScoredCandidate[],
  verificationResults: Map<string, boolean>
): Promise<void> {
  for (const candidate of scored) {
    const passed = verificationResults.get(candidate.id) ?? false;
    if (passed) {
      genePool.recordSuccess(candidate, { cycle: 'evolution' }, true);
    } else {
      genePool.recordFailure(candidate, { error: { code: 'VERIFICATION_FAILED', message: '验收未通过' } }, { cycle: 'evolution' });
    }
  }
}