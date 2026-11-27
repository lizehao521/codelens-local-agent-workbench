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
/**
 * 根据 Gap 描述和项目结构发现相关文件（fallback 机制）
 * 使用 rg (ripgrep) - 快、支持类型过滤、不受 BusyBox 限制
 */
async function discoverRelevantFiles(gap: Gap, projectRoot: string): Promise<string[]> {
  const { execFileSync } = await import('node:child_process');
  const files = new Set<string>();

  try {
    // 从 gap 描述中提取关键词（过滤常见停用词）
    const keywords = gap.description
      .toLowerCase()
      .split(/\s+/)
      .filter(w => w.length > 3)
      .filter(w => !['this', 'that', 'with', 'from', 'have', 'been', 'were', 'will', 'would', 'could', 'should'].includes(w))
      .slice(0, 5);

    if (keywords.length === 0) return [];

    // 使用 rg 搜索相关文件（--type ts/tsx，自动忽略 .gitignore、node_modules 等）
    for (const keyword of keywords) {
      try {
        const result = execFileSync('rg', [
          '--type', 'ts',
          '--type', 'tsx',
          '--no-ignore',
          '--hidden',
          '--glob', '!**/node_modules/**',
          '--glob', '!**/dist/**',
          '--glob', '!**/.git/**',
          '--glob', '!**/coverage/**',
          '-l',
          '-i',
          keyword,
          projectRoot,
        ], { encoding: 'utf8', timeout: 15_000, maxBuffer: 2 * 1024 * 1024 });

        const found = result.trim().split('\n').filter(f => f.length > 0);
        for (const f of found) {
          const rel = f.replace(projectRoot + '/', '');
          if (rel && !rel.startsWith('..')) {
            files.add(rel);
          }
        }
      } catch {
        // rg 无结果或超时，继续下一个关键词
      }
    }
  } catch {
    // 忽略错误
  }

  return [...files].slice(0, 10);
} // 限制返回文件数

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
    patch: generateCombinePatch(targetPath, otherPath, ctx.projectRoot),
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
    patch: (t.context.patch ?? generateAdaptPatch(targetPath, t.context.strategy!, ctx.projectRoot)) as string,
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
    patch: generateModifyPatch(gap.relatedFiles[0], ctx.projectRoot),
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
    code: generateSkillWrapper(gap.relatedFiles[0], ctx.projectRoot),
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
    patch: generateEliminatePatch(gap.relatedFiles[0], ctx.projectRoot),
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
    patch: generateReversePatch(gap.relatedFiles[0], ctx.projectRoot),
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
 * Patch 生成器 - 读取真实文件内容生成有意义的 unified diff
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

function readTargetFile(targetPath: string, projectRoot: string): string | null {
  const fullPath = join(projectRoot, targetPath);
  if (!existsSync(fullPath)) return null;
  return readFileSync(fullPath, 'utf8');
}

function makeDiffHeader(targetPath: string): string {
  return `diff --git a/${targetPath} b/${targetPath}
index xxx..yyy 100644
--- a/${targetPath}
+++ b/${targetPath}
`;
}

function makeHunkHeader(oldStart: number, oldCount: number, newStart: number, newCount: number): string {
  return `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`;
}

function linesToHunk(oldLines: string[], newLines: string[], contextLines = 3): string[] {
  let start = 0;
  while (start < oldLines.length && start < newLines.length && oldLines[start] === newLines[start]) {
    start++;
  }
  let endOld = oldLines.length;
  let endNew = newLines.length;
  while (endOld > start && endNew > start && oldLines[endOld - 1] === newLines[endNew - 1]) {
    endOld--;
    endNew--;
  }

  const contextStart = Math.max(0, start - contextLines);
  const contextEndOld = Math.min(oldLines.length, endOld + contextLines);
  const contextEndNew = Math.min(newLines.length, endNew + contextLines);

  const hunk: string[] = [];
  for (let i = contextStart; i < start; i++) {
    hunk.push(' ' + oldLines[i]);
  }
  for (let i = start; i < endOld; i++) {
    hunk.push('-' + oldLines[i]);
  }
  for (let i = start; i < endNew; i++) {
    hunk.push('+' + newLines[i]);
  }
  for (let i = endOld; i < contextEndOld; i++) {
    if (i < oldLines.length) hunk.push(' ' + oldLines[i]);
  }
  for (let i = Math.max(endOld, contextEndOld); i < contextEndNew; i++) {
    hunk.push('+' + newLines[i]);
  }

  return hunk;
}

function buildUnifiedDiff(targetPath: string, oldContent: string, newContent: string): string {
  const oldLines = oldContent.split('\n');
  const newLines = newContent.split('\n');
  const hunkLines = linesToHunk(oldLines, newLines);
  if (hunkLines.length === 0) return '';

  const oldCount = oldLines.length;
  const newCount = newLines.length;

  return makeDiffHeader(targetPath) + makeHunkHeader(1, oldCount, 1, newCount) + '\n' + hunkLines.join('\n') + '\n';
}

function generateSubstitutePatch(targetPath: string, strategy: string, projectRoot: string): string {
  const content = readTargetFile(targetPath, projectRoot);
  if (!content) {
    return makeDiffHeader(targetPath) + makeHunkHeader(1, 1, 1, 2) + '\n // TODO: apply substitute\n+// Substituted: ' + strategy + '\n';
  }

  const newContent = content.replace(/console\.log\(/g, 'logger.debug(');
  if (newContent === content) {
    return makeDiffHeader(targetPath) + makeHunkHeader(1, 1, 1, 2) + '\n // Substitute: ' + strategy + '\n+import { logger } from \'../utils/logger\';\n';
  }

  return buildUnifiedDiff(targetPath, content, newContent);
}

function generateCombinePatch(targetPath: string, otherPath: string, projectRoot: string): string {
  const content = readTargetFile(targetPath, projectRoot);
  if (!content) {
    return makeDiffHeader(targetPath) + makeHunkHeader(1, 1, 1, 2) + '\n // Combine with ' + otherPath + '\n+// Combined from ' + otherPath + '\n';
  }

  const newContent = content + '\n// Combined functionality from: ' + otherPath + '\n';
  return buildUnifiedDiff(targetPath, content, newContent);
}

function generateAdaptPatch(targetPath: string, strategy: string, projectRoot: string): string {
  const content = readTargetFile(targetPath, projectRoot);
  if (!content) {
    return makeDiffHeader(targetPath) + makeHunkHeader(1, 1, 1, 2) + '\n // Adapt: ' + strategy + '\n+// Adapted from gene-pool pattern\n';
  }

  const newContent = content + '\n// Adapted strategy: ' + strategy + '\n';
  return buildUnifiedDiff(targetPath, content, newContent);
}

function generateModifyPatch(targetPath: string, projectRoot: string): string {
  const content = readTargetFile(targetPath, projectRoot);
  if (!content) {
    return makeDiffHeader(targetPath) + makeHunkHeader(1, 1, 1, 3) + '\n // Modify: add guard\n+if (!input) throw new Error(\'Invalid input\');\n+// Guard clause added\n';
  }

  const lines = content.split('\n');
  let insertAt = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.startsWith('export function ') || line.match(/export const \w+ = (async )?function/)) {
      for (let j = i; j < lines.length; j++) {
        if (lines[j].includes('{')) {
          insertAt = j + 1;
          break;
        }
      }
      break;
    }
  }

  if (insertAt === -1 || insertAt >= lines.length) {
    const newContent = content + '\n// Added guard clause\nif (!input) throw new Error(\'Invalid input\');\n';
    return buildUnifiedDiff(targetPath, content, newContent);
  }

  const newLines = [...lines];
  newLines.splice(insertAt, 0, '  if (!input) throw new Error(\'Invalid input\');  // Guard clause');
  return buildUnifiedDiff(targetPath, content, newLines.join('\n'));
}

function generateSkillWrapper(targetPath: string, projectRoot: string): string {
  const baseName = targetPath.split('/').pop()?.replace(/\.(ts|tsx)$/, '') || 'unknown';
  
  return `// Auto-generated skill wrapper for ${targetPath}
import type { ToolDefinition } from '../types/tool.js';

export const ${baseName}Skill: ToolDefinition = {
  name: 'skill.${baseName.replace(/[^a-z0-9]/gi, '_')}',
  description: 'Auto-generated skill from ${targetPath}',
  inputSchema: { type: 'object', properties: {} },
  handler: async (input: unknown) => ({ ok: true, data: 'TODO: implement', input }),
};
`;
}

function generateEliminatePatch(targetPath: string, projectRoot: string): string {
  const content = readTargetFile(targetPath, projectRoot);
  if (!content) {
    return makeDiffHeader(targetPath) + makeHunkHeader(1, 3, 1, 1) + '\n-// Dead code\n-export function unused() { return 1; }\n-// Removed\n';
  }

  const lines = content.split('\n');
  const exportIndices: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim().startsWith('export ') && (lines[i].includes('function ') || lines[i].includes('const ') || lines[i].includes('interface ') || lines[i].includes('type '))) {
      exportIndices.push(i);
    }
  }

  if (exportIndices.length <= 1) {
    return makeDiffHeader(targetPath) + makeHunkHeader(1, 1, 1, 1) + '\n // No eliminatable exports found\n';
  }

  const removeAt = exportIndices[exportIndices.length - 2];
  let endAt = removeAt;
  while (endAt < lines.length && lines[endAt].trim() !== '' && !lines[endAt].trim().startsWith('export ')) {
    endAt++;
  }

  const newLines = [...lines];
  newLines.splice(removeAt, endAt - removeAt);
  return buildUnifiedDiff(targetPath, content, newLines.join('\n'));
}

function generateReversePatch(targetPath: string, projectRoot: string): string {
  const content = readTargetFile(targetPath, projectRoot);
  if (!content) {
    return makeDiffHeader(targetPath) + makeHunkHeader(1, 1, 1, 2) + '\n // Reverse dependency\n+// Dependency inverted\n';
  }

  const lines = content.split('\n');
  let insertAt = 0;
  while (insertAt < lines.length && (lines[insertAt].startsWith('//') || lines[insertAt].startsWith('/*') || lines[insertAt].trim() === '')) {
    insertAt++;
  }

  const newLines = [...lines];
  newLines.splice(insertAt, 0, '', '// Reverse dependency: extracted interface', 'export interface IReversed {', '  execute(input: unknown): Promise<unknown>;', '}', '');
  return buildUnifiedDiff(targetPath, content, newLines.join('\n'));
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