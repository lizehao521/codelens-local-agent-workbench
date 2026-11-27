/**
 * Proposal Generator —— 根据 Gap 生成候选提案（SCAMPER / 逆向思维 / 基因库复用）。
 *
 * 核心流程：
 *   1. 收集 Gap（RSI 反思 / 失败 Run / 变异存活体 / 用户反馈）
 *   2. 对每个 Gap 应用多种策略生成候选
 *   3. 去重、去噪、打标签
 */

import { randomUUID } from 'node:crypto';
import type {
  Gap,
  CandidateProposal,
  ProposalKind,
  StrategyTag,
  UnifiedError,
  EvolutionEngineConfig,
} from './types.js';
import { CodeLensClient, createClientFromConfig } from './codelens-client.js';
import { GenePool, createGenePool } from './gene-pool.js';

interface ReflectionResponse {
  reflections: Array<{ at: string; gaps?: unknown[]; evidence?: Array<{ type: string; data?: unknown }> }>;
  total: number;
}

interface FailedRunsResponse {
  failedRuns: Array<{ runId: string; verdicts: Array<{ reason: string }>; createdAt: number }>;
  total: number;
}

const STRATEGIES: StrategyTag[] = [
  'substitute',      // 替换：换工具/库/算法
  'combine',         // 组合：合并两个功能
  'adapt',           // 适配：借用其他领域方案
  'modify',          // 修改：改变参数/结构/流程
  'put-to-other-use',// 他用：挪作它用
  'eliminate',       // 删除：去冗余/简化
  'reverse',         // 逆向：倒序/反向依赖
];

export interface GenerationContext {
  codeLensUrl: string;
  apiKey?: string;
  genePool: GenePool;
  projectRoot: string;
}

export interface GeneratorOptions {
  maxCandidatesPerGap?: number;
  strategies?: StrategyTag[];
}

/**
 * 从 CodeLens 收集所有 Gap 来源
 */
export async function collectAllGaps(ctx: GenerationContext): Promise<Gap[]> {
  const client = createClientFromConfig({
    codeLensUrl: ctx.codeLensUrl,
    apiKey: ctx.apiKey,
    concurrency: 3,
    timeoutMs: 180_000,
    retryAttempts: 3,
    retryBaseDelayMs: 1000,
    topK: 3,
    minScoreThreshold: 60,
    staticValidation: {
      maxFileLines: 300,
      strictMode: true,
      forbiddenPatterns: [],
    },
    scoring: {
      referenceTestsWeight: 50,
      mutationKillWeight: 0,
      bugReproductionWeight: 30,
      staticAnalysisWeight: 20,
    },
    genePool: {
      enabled: true,
      path: `${ctx.projectRoot}/.self-upgrade/gene-pool.json`,
      maxEntries: 1000,
    },
  } as EvolutionEngineConfig);

  const gaps: Gap[] = [];

  // 1. RSI 反思报告
  try {
    const reflectionResponse = await client.getReflection(10);
    if (reflectionResponse.ok) {
      const reflection = reflectionResponse.data as ReflectionResponse;
      for (const r of reflection.reflections) {
        if (r.gaps && Array.isArray(r.gaps)) {
          for (const g of r.gaps) {
            if (typeof g === 'object' && g !== null && 'description' in g) {
              gaps.push({
                id: randomUUID(),
                source: 'reflection',
                description: String((g as Record<string, unknown>).description ?? ''),
                severity: (g as Record<string, unknown>).severity === 'high' ? 'high' : 'medium',
                evidence: (r.evidence ?? []) as Array<{ type: string; data?: unknown }>,
                relatedFiles: extractFilesFromEvidence(r.evidence),
                collectedAt: r.at,
              });
            }
          }
        }
      }
    } else {
      console.warn('[collectAllGaps] reflection fetch failed:', (reflectionResponse.data as UnifiedError).error?.message);
    }
  } catch (e) {
    console.warn('[collectAllGaps] reflection fetch failed:', e instanceof Error ? e.message : String(e));
  }

  // 2. 失败 Run 摘要
  try {
    const failedRunsResponse = await client.getFailedRuns(20);
    if (failedRunsResponse.ok) {
      const failedRuns = failedRunsResponse.data as FailedRunsResponse;
      for (const run of failedRuns.failedRuns) {
        for (const v of run.verdicts) {
          const files = extractFilesFromReason(v.reason);
          const baseGap = {
            id: randomUUID(),
            source: 'failed-run' as const,
            description: `Run ${run.runId} 失败: ${v.reason}`,
            severity: 'high' as const,
            evidence: [{ type: 'verdict', data: v }],
            relatedFiles: files,
            collectedAt: String(run.createdAt),
          };
          // 后续会在运行策略前调用 ensureRelatedFiles
          gaps.push(baseGap);
        }
      }
    } else {
      console.warn('[collectAllGaps] failed-runs fetch failed:', (failedRunsResponse.data as UnifiedError).error?.message);
    }
  } catch (e) {
    console.warn('[collectAllGaps] failed-runs fetch failed:', e instanceof Error ? e.message : String(e));
  }

  // 3. 基因库失败模式（反模式）
  try {
    const failures = ctx.genePool.getFailures(20);
    for (const f of failures) {
      gaps.push({
        id: randomUUID(),
        source: 'gene-pool-failure',
        description: `历史失败模式: ${f.pattern}`,
        severity: 'high',
        evidence: [{ type: 'gene-pool', data: f }],
        relatedFiles: f.context.targetPath ? [f.context.targetPath] : [],
        collectedAt: f.createdAt,
      });
    }
  } catch (e) {
    console.warn('[collectAllGaps] gene-pool failures fetch failed:', e instanceof Error ? e.message : String(e));
  }

  // 4. 基因库成功模式（正模式 → 复用机会）
  try {
    const successes = ctx.genePool.getSuccesses(10);
    for (const s of successes) {
      gaps.push({
        id: randomUUID(),
        source: 'gene-pool-success',
        description: `可复用模式: ${s.pattern}`,
        severity: 'low',
        evidence: [{ type: 'gene-pool', data: s }],
        relatedFiles: s.context.targetPath ? [s.context.targetPath] : [],
        collectedAt: s.createdAt,
      });
    }
  } catch (e) {
    console.warn('[collectAllGaps] gene-pool successes fetch failed:', e instanceof Error ? e.message : String(e));
  }

  // 去重：按 description + source 合并
  const seen = new Set<string>();
  return gaps.filter(g => {
    const key = `${g.source}:${g.description}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function extractFilesFromEvidence(evidence?: Array<{ type?: string; data?: unknown }>): string[] {
  if (!evidence) return [];
  const files = new Set<string>();
  for (const e of evidence) {
    if (e.data && typeof e.data === 'object') {
      const d = e.data as Record<string, unknown>;
      if (d.targetPath && typeof d.targetPath === 'string') files.add(d.targetPath);
      if (d.file && typeof d.file === 'string') files.add(d.file);
    }
  }
  return [...files];
}

/**
 * 从错误原因字符串中提取文件路径
 * 支持格式：src/tools/x.ts:10: error: ... 或 src/tools/x.ts(10): ...
 */
function extractFilesFromReason(reason?: string): string[] {
  if (!reason) return [];
  const files = new Set<string>();
  // 匹配常见格式：文件路径:行号: 或 文件路径(行号):
  const patterns = [
    /([a-zA-Z0-9_\-./]+\.[a-zA-Z0-9]+):\d+:/g,  // file.ts:10:
    /([a-zA-Z0-9_\-./]+\.[a-zA-Z0-9]+)\(\d+\)/g, // file.ts(10)
    /(src\/[a-zA-Z0-9_\-./]+\.[a-zA-Z0-9]+)/g,   // src/.../file.ts
  ];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(reason)) !== null) {
      files.add(match[1]);
    }
  }
  return [...files];
}

/**
 * 根据 Gap 描述和项目结构发现相关文件（fallback 机制）
 * 兼容 BusyBox grep（不支持 --include 选项）
 */
async function discoverRelevantFiles(gap: Gap, projectRoot: string): Promise<string[]> {
  const { execFileSync } = await import('node:child_process');
  const files = new Set<string>();
  
  try {
    // 从 gap 描述中提取关键词
    const keywords = gap.description
      .toLowerCase()
      .split(/\s+/)
      .filter(w => w.length > 3)
      .slice(0, 5);
    
    if (keywords.length === 0) return [];
    
    // 使用 grep 搜索相关文件（兼容 BusyBox）
    for (const keyword of keywords) {
      try {
        // BusyBox grep 不支持 --include，改用 find + grep 组合
        const result = execFileSync('sh', [
          '-c',
          `find "${projectRoot}" -type f \\( -name "*.ts" -o -name "*.tsx" \\) -exec grep -l -i "${keyword}" {} \\;`
        ], { encoding: 'utf8', timeout: 10_000, maxBuffer: 1024 * 1024 });
        
        const found = result.trim().split('\n').filter(f => f.length > 0);
        for (const f of found) {
          // 转换为相对路径
          const rel = f.replace(projectRoot + '/', '');
          if (rel && !rel.startsWith('..')) {
            files.add(rel);
          }
        }
      } catch {
        // grep 无结果或超时，继续下一个关键词
      }
    }
  } catch {
    // 忽略错误
  }
  
  return [...files].slice(0, 10); // 限制返回文件数
}

/**
 * 确保 Gap 有 relatedFiles（fallback 到文件发现）
 */
async function ensureRelatedFiles(gap: Gap, ctx: GenerationContext): Promise<Gap> {
  if (gap.relatedFiles && gap.relatedFiles.length > 0) return gap;
  
  const discovered = await discoverRelevantFiles(gap, ctx.projectRoot);
  if (discovered.length > 0) {
    return { ...gap, relatedFiles: discovered };
  }
  return gap;
}

/**
 * 对单个 Gap 应用 SCAMPER 策略生成候选
 */
export function applyStrategy(
  gap: Gap,
  strategy: StrategyTag,
  ctx: GenerationContext
): CandidateProposal[] {
  const proposals: CandidateProposal[] = [];

  switch (strategy) {
    case 'substitute':
      proposals.push(...genSubstitute(gap, ctx));
      break;
    case 'combine':
      proposals.push(...genCombine(gap, ctx));
      break;
    case 'adapt':
      proposals.push(...genAdapt(gap, ctx));
      break;
    case 'modify':
      proposals.push(...genModify(gap, ctx));
      break;
    case 'put-to-other-use':
      proposals.push(...genPutToOtherUse(gap, ctx));
      break;
    case 'eliminate':
      proposals.push(...genEliminate(gap, ctx));
      break;
    case 'reverse':
      proposals.push(...genReverse(gap, ctx));
      break;
  }

  return proposals.map(p => ({
    ...p,
    id: randomUUID(),
    meta: {
      ...p.meta,
      strategy,
      generatedAt: new Date().toISOString(),
    },
  }));
}

/**
 * 生成策略实现（各返回 1-2 个候选）
 */

function genSubstitute(gap: Gap, ctx: GenerationContext): CandidateProposal[] {
  // 替换：针对「工具/库/算法过时/失效」→ 推荐替代方案
  if (!gap.relatedFiles?.length) return [];
  const target = gap.relatedFiles[0];

  // 从基因库查找同类成功替换
  const patterns = ctx.genePool.findRelevantPatterns(target, 'patch', 3);
  const subs = patterns
    .filter(p => p.kind === 'success')
    .map(p => p.context.strategy)
    .filter(Boolean);

  if (subs.length === 0) return [];

  const targetPath = gap.relatedFiles[0];
  const strategy = subs[0];
  if (!strategy) return [];

  return [{
    id: randomUUID(),
    kind: 'patch',
    targetPath,
    patch: generateSubstitutePatch(targetPath, strategy, ctx.projectRoot),
    meta: {
      score: 70,
      evidence: [{ type: 'gene-pool', description: `替换策略: ${strategy}` }],
      mutationKillRate: 0,
      generatedAt: new Date().toISOString(),
      strategy: 'substitute',
    },
  }];
}

function genCombine(gap: Gap, ctx: GenerationContext): CandidateProposal[] {
  // 组合：将两个相关功能合并，或将工具与规则结合
  if (!gap.relatedFiles?.length || gap.relatedFiles.length < 2) return [];
  const targetPath = gap.relatedFiles[0];
  const otherPath = gap.relatedFiles[1];
  return [{
    id: randomUUID(),
    kind: 'patch',
    targetPath,
    patch: generateCombinePatch(targetPath, otherPath),
    meta: {
      score: 65,
      evidence: [{ type: 'strategy', description: '组合两个相关文件功能' }],
      mutationKillRate: 0,
      generatedAt: new Date().toISOString(),
      strategy: 'combine',
    },
  }];
}

function genAdapt(gap: Gap, ctx: GenerationContext): CandidateProposal[] {
  // 适配：从基因库成功模式中借用模板
  if (!gap.relatedFiles?.length) return [];
  const targetPath = gap.relatedFiles[0];
  const patterns = ctx.genePool.findRelevantPatterns(targetPath, 'patch', 5);
  const templates = patterns
    .filter(p => p.kind === 'success' && p.context.strategy)
    .slice(0, 2);

  return templates.map(t => ({
    id: randomUUID(),
    kind: 'patch' as const,
    targetPath,
    patch: (t.context.patch ?? generateAdaptPatch(targetPath, t.context.strategy!)) as string,
    meta: {
      score: 75,
      evidence: [{ type: 'gene-pool', description: `适配模式: ${t.pattern}` }],
      mutationKillRate: 0,
      generatedAt: new Date().toISOString(),
      strategy: 'adapt',
    },
  }));
}

function genModify(gap: Gap, ctx: GenerationContext): CandidateProposal[] {
  // 修改：调整参数/增加守卫/优化逻辑
  if (!gap.relatedFiles?.length) return [];
  return [{
    id: randomUUID(),
    kind: 'patch',
    targetPath: gap.relatedFiles[0],
    patch: generateModifyPatch(gap.relatedFiles[0]),
    meta: {
      score: 60,
      evidence: [{ type: 'strategy', description: '增加防御性检查/参数调优' }],
      mutationKillRate: 0,
      generatedAt: new Date().toISOString(),
      strategy: 'modify',
    },
  }];
}

function genPutToOtherUse(gap: Gap, ctx: GenerationContext): CandidateProposal[] {
  // 他用：将工具/技能挪作它用
  if (!gap.relatedFiles?.length) return [];
  return [{
    id: randomUUID(),
    kind: 'skill' as const,
    targetPath: gap.relatedFiles[0],
    code: generateSkillWrapper(gap.relatedFiles[0]),
    meta: {
      score: 55,
      evidence: [{ type: 'strategy', description: '将工具封装为可复用技能' }],
      mutationKillRate: 0,
      generatedAt: new Date().toISOString(),
      strategy: 'put-to-other-use',
    },
  }];
}

function genEliminate(gap: Gap, ctx: GenerationContext): CandidateProposal[] {
  // 删除：移除冗余/死代码/过时配置
  if (!gap.relatedFiles?.length) return [];
  return [{
    id: randomUUID(),
    kind: 'patch',
    targetPath: gap.relatedFiles[0],
    patch: generateEliminatePatch(gap.relatedFiles[0]),
    meta: {
      score: 50,
      evidence: [{ type: 'strategy', description: '移除冗余/死代码' }],
      mutationKillRate: 0,
      generatedAt: new Date().toISOString(),
      strategy: 'eliminate',
    },
  }];
}

function genReverse(gap: Gap, ctx: GenerationContext): CandidateProposal[] {
  // 逆向：倒序执行/反向依赖/正反向测试
  if (!gap.relatedFiles?.length) return [];
  return [{
    id: randomUUID(),
    kind: 'patch',
    targetPath: gap.relatedFiles[0],
    patch: generateReversePatch(gap.relatedFiles[0]),
    meta: {
      score: 45,
      evidence: [{ type: 'strategy', description: '逆向依赖/倒序执行' }],
      mutationKillRate: 0,
      generatedAt: new Date().toISOString(),
      strategy: 'reverse',
    },
  }];
}

/**
 * Patch 生成器（占位实现，后续可接入 LLM/AST）
 */

function generateSubstitutePatch(targetPath: string, strategy: string, projectRoot: string): string {
  const { readFileSync, existsSync } = require('node:fs');
  const { join } = require('node:path');
  
  const fullPath = join(projectRoot, targetPath);
  if (!existsSync(fullPath)) {
    return `diff --git a/${targetPath} b/${targetPath}
index xxx..yyy 100644
--- a/${targetPath}
+++ b/${targetPath}
@@ -1,3 +1,4 @@
 // TODO: 应用替换策略: ${strategy}
+// Substituted per gene-pool pattern
`;
  }
  
  try {
    const content = readFileSync(fullPath, 'utf8');
    
    // Add a comment at the end of the file
    const newContent = content + '\n// Substituted per gene-pool pattern: ' + strategy + '\n';
    
    // Generate proper unified diff manually
    const oldLines = content.split('\n');
    const newLines = newContent.split('\n');
    
    // We're adding 1 line at the end
    // Use the last 3 lines as context
    const contextLines = 3;
    const oldLineCount = oldLines.length;
    const contextStart = Math.max(0, oldLineCount - contextLines);
    
    // Build context lines (last 3 lines of original)
    const contextOld = oldLines.slice(contextStart);
    // New content has one extra line at the end
    const contextNew = newLines.slice(contextStart);
    
    const oldStart = contextStart + 1; // 1-indexed
    const oldLength = contextOld.length;
    const newStart = contextStart + 1;
    const newLength = contextNew.length;
    
    // Build hunk body: context lines (unchanged) + added line
    const hunkLines = [];
    for (const line of contextOld) {
      hunkLines.push(' ' + line);
    }
    // The added line is the last line in contextNew
    const addedLine = contextNew[contextNew.length - 1];
    hunkLines.push('+' + addedLine);
    
    const hunkBody = hunkLines.join('\n');
    const hunkHeader = `@@ -${contextStart + 1},${contextOld.length} +${contextStart + 1},${contextNew.length} @@`;
    
    return `diff --git a/${targetPath} b/${targetPath}
index xxx..yyy 100644
--- a/${targetPath}
+++ b/${targetPath}
${hunkHeader}
${hunkBody}
`;
  } catch {
    return `diff --git a/${targetPath} b/${targetPath}
index xxx..yyy 100644
--- a/${targetPath}
+++ b/${targetPath}
@@ -1,3 +1,4 @@
 // TODO: 应用替换策略: ${strategy}
+// Substituted per gene-pool pattern
`;
  }
}

function generateCombinePatch(file1: string, file2: string): string {
  return `diff --git a/${file1} b/${file1}
index xxx..yyy 100644
--- a/${file1}
+++ b/${file1}
@@ -1,3 +1,4 @@
 // TODO: 组合 ${file2} 功能
+// Combined from ${file2}
`;
}

function generateAdaptPatch(targetPath: string, strategy: string): string {
  return `diff --git a/${targetPath} b/${targetPath}
index xxx..yyy 100644
--- a/${targetPath}
+++ b/${targetPath}
@@ -1,3 +1,4 @@
 // TODO: 适配策略: ${strategy}
+// Adapted from gene-pool pattern
`;
}

function generateModifyPatch(targetPath: string): string {
  return `diff --git a/${targetPath} b/${targetPath}
index xxx..yyy 100644
--- a/${targetPath}
+++ b/${targetPath}
@@ -1,3 +1,5 @@
 // TODO: 修改优化
+// Added guard clause
+if (!input) throw new Error('Invalid input');
`;
}

function generateSkillWrapper(targetPath: string): string {
  return `// Auto-generated skill wrapper for ${targetPath}
import type { ToolDefinition } from '../types/tool.js';

export const autoSkill: ToolDefinition = {
  name: 'auto.${targetPath.replace(/[^a-z0-9]/gi, '_')}',
  description: 'Auto-generated skill from ${targetPath}',
  inputSchema: { type: 'object', properties: {} },
  handler: async () => ({ ok: true, data: 'TODO' }),
};
`;
}

function generateEliminatePatch(targetPath: string): string {
  return `diff --git a/${targetPath} b/${targetPath}
index xxx..yyy 100644
--- a/${targetPath}
+++ b/${targetPath}
@@ -1,4 +1,2 @@
-// TODO: Remove dead code
-export function unused() { return 1; }
-// Removed dead code
`;
}

function generateReversePatch(targetPath: string): string {
  return `diff --git a/${targetPath} b/${targetPath}
index xxx..yyy 100644
--- a/${targetPath}
+++ b/${targetPath}
@@ -1,3 +1,4 @@
 // TODO: 逆向依赖
+// Dependency inverted
`;
}

/**
 * 主流程：收集 Gap → 应用所有策略 → 去重 → 返回候选
 */
export async function runGenerationPipeline(
  ctx: GenerationContext,
  options: GeneratorOptions = {}
): Promise<CandidateProposal[]> {
  const { maxCandidatesPerGap = 2, strategies = STRATEGIES } = options;

  // 1. 收集 Gap
  const gaps = await collectAllGaps(ctx);
  console.log(`[generation] Collected ${gaps.length} gaps from ${new Set(gaps.map(g => g.source)).size} sources`);

  // 2. 确保每个 Gap 都有 relatedFiles（fallback 到文件发现）
  console.log('[generation] Ensuring relatedFiles for gaps...');
  const enrichedGaps: Gap[] = [];
  for (const gap of gaps) {
    const enriched = await ensureRelatedFiles(gap, ctx);
    if (enriched.relatedFiles && enriched.relatedFiles.length > 0) {
      enrichedGaps.push(enriched);
    }
  }
  console.log(`[generation] ${enrichedGaps.length}/${gaps.length} gaps have relatedFiles`);

  // 2. 对每个 Gap 应用所有策略
  const allCandidates: CandidateProposal[] = [];
  for (const gap of enrichedGaps) {
    for (const strategy of STRATEGIES) {
      const candidates = applyStrategy(gap, strategy, ctx);
      allCandidates.push(...candidates);
    }
  }

  // 3. 去重（按 targetPath + strategy）
  const seen = new Set<string>();
  const unique = allCandidates.filter(c => {
    const key = `${c.targetPath}:${c.meta.strategy}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // 4. 限制数量
  return unique.slice(0, maxCandidatesPerGap * (gaps.length || 1));
}

/**
 * 从配置创建生成上下文
 */
export function createGenerationContext(
  codeLensUrl: string,
  apiKey: string | undefined,
  projectRoot: string
): GenerationContext {
  const finalApiKey = apiKey ?? '';
  // Create a minimal EvolutionEngineConfig for gene pool creation
  const genePoolConfig = {
    codeLensUrl,
    apiKey: finalApiKey,
    concurrency: 3,
    timeoutMs: 180_000,
    retryAttempts: 3,
    retryBaseDelayMs: 1000,
    topK: 3,
    minScoreThreshold: 60,
    staticValidation: {
      maxFileLines: 300,
      strictMode: true,
      forbiddenPatterns: [],
    },
    scoring: {
      referenceTestsWeight: 50,
      mutationKillWeight: 0,
      bugReproductionWeight: 30,
      staticAnalysisWeight: 20,
    },
    genePool: {
      enabled: true,
      path: `${projectRoot}/.self-upgrade/gene-pool.json`,
      maxEntries: 1000,
    },
  } as EvolutionEngineConfig;

  const genePool = createGenePool(genePoolConfig);

  return {
    codeLensUrl,
    apiKey: finalApiKey,
    genePool,
    projectRoot,
  };
}