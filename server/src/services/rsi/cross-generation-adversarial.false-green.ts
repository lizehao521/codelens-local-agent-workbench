/**
 * 防假绿检测：skip/todo/.only、测试集合异常缩减、断言弱化。
 * 从 cross-generation-adversarial.ts 拆出（结构棘轮 ≤300 行）。
 */

// ---------------------------------------------------------------------------
// 防假绿检测：skip/todo/.only
// ---------------------------------------------------------------------------

export interface SkipDetectionResult {
  readonly hasRisk: boolean;
  readonly patterns: readonly SkipPattern[];
  readonly riskLevel: 'critical' | 'high' | 'medium' | 'none';
}

export interface SkipPattern {
  readonly kind: 'skip' | 'todo' | 'only' | 'xit' | 'xdescribe' | 'xtest';
  readonly line: number;
  readonly snippet: string;
}

const SKIP_PATTERNS: readonly { kind: SkipPattern['kind']; regex: RegExp }[] = [
  { kind: 'skip', regex: /\b(?:it|test|describe)\.skip\s*\(/g },
  { kind: 'todo', regex: /\b(?:it|test)\.todo\s*\(/g },
  { kind: 'only', regex: /\b(?:it|test|describe)\.only\s*\(/g },
  { kind: 'xit', regex: /\bxit\s*\(/g },
  { kind: 'xdescribe', regex: /\bxdescribe\s*\(/g },
  { kind: 'xtest', regex: /\bxtest\s*\(/g },
] as const;

export function detectSkippedTests(testSource: string): SkipDetectionResult {
  const lines = testSource.split('\n');
  const patterns: SkipPattern[] = [];

  for (const { kind, regex } of SKIP_PATTERNS) {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line === undefined) continue;
      regex.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = regex.exec(line)) !== null) {
        patterns.push({
          kind,
          line: i + 1,
          snippet: line.trim().slice(0, 120),
        });
      }
    }
  }

  const hasRisk = patterns.length > 0;
  const riskLevel = hasRisk ? (patterns.some((p) => p.kind === 'only') ? 'critical' : 'high') : 'none';

  return { hasRisk, patterns, riskLevel };
}

// ---------------------------------------------------------------------------
// 防假绿检测：测试集合异常缩减
// ---------------------------------------------------------------------------

export interface ExclusionAnomalyResult {
  readonly hasRisk: boolean;
  readonly baselineCount: number;
  readonly actualCount: number;
  readonly reductionRatio: number;
  readonly threshold: number;
  readonly excludedPatterns: readonly string[];
  readonly reason: string;
}

export interface ExclusionConfig {
  readonly threshold?: number;
  readonly excludePatterns?: readonly string[];
  readonly testFiles?: readonly string[];
}

export function detectExclusionAnomaly(
  baselineCount: number,
  actualCount: number,
  config: ExclusionConfig = {},
): ExclusionAnomalyResult {
  const threshold = config.threshold ?? 0.1;
  const excludedPatterns = config.excludePatterns ?? [];
  const reduction = baselineCount - actualCount;
  const reductionRatio = baselineCount > 0 ? reduction / baselineCount : 0;

  const hasExclusionPatterns = excludedPatterns.length > 0;
  const hasSignificantReduction = reductionRatio > threshold;
  const hasRisk = hasSignificantReduction || (hasExclusionPatterns && reduction > 0);

  let reason = '';
  if (hasSignificantReduction) {
    reason = `测试集合缩减 ${(reductionRatio * 100).toFixed(1)}% 超过阈值 ${(threshold * 100).toFixed(1)}%`;
  } else if (hasExclusionPatterns && reduction > 0) {
    reason = `配置排除模式导致测试减少: ${excludedPatterns.join(', ')}`;
  } else if (reduction > 0) {
    reason = `测试集合缩减 ${(reductionRatio * 100).toFixed(1)}% 在阈值内`;
  } else {
    reason = '测试集合无缩减';
  }

  return {
    hasRisk,
    baselineCount,
    actualCount,
    reductionRatio,
    threshold,
    excludedPatterns,
    reason,
  };
}

// ---------------------------------------------------------------------------
// 防假绿检测：断言弱化
// ---------------------------------------------------------------------------

export interface AssertionWeakeningResult {
  readonly hasRisk: boolean;
  readonly patterns: readonly AssertionWeakeningPattern[];
  readonly riskLevel: 'critical' | 'high' | 'medium' | 'none';
}

export interface AssertionWeakeningPattern {
  readonly kind: 'toEqual_to_toContain' | 'strict_to_loose' | 'assertion_removed' | 'toBe_to_toBeTruthy' | 'toHaveLength_to_toBeGreaterThan';
  readonly line: number;
  readonly before: string;
  readonly after: string;
}

const ASSERTION_WEAKENING_RULES: readonly {
  kind: AssertionWeakeningPattern['kind'];
  before: RegExp;
  after: RegExp;
}[] = [
  {
    kind: 'toEqual_to_toContain',
    before: /\.toEqual\s*\(/,
    after: /\.toContain\s*\(/,
  },
  {
    kind: 'strict_to_loose',
    before: /\.toBe\s*\(/,
    after: /\.toEqual\s*\(/,
  },
  {
    kind: 'toBe_to_toBeTruthy',
    before: /\.toBe\s*\(/,
    after: /\.toBeTruthy\s*\(/,
  },
  {
    kind: 'toHaveLength_to_toBeGreaterThan',
    before: /\.toHaveLength\s*\(/,
    after: /\.toBeGreaterThan\s*\(/,
  },
] as const;

export function detectAssertionWeakening(diffOrSource: string): AssertionWeakeningResult {
  const lines = diffOrSource.split('\n');
  const patterns: AssertionWeakeningPattern[] = [];

  // 检测 diff 格式：- 旧行 / + 新行
  const removedLines: { line: number; content: string }[] = [];
  const addedLines: { line: number; content: string }[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) continue;
    if (line.startsWith('-') && !line.startsWith('---')) {
      removedLines.push({ line: i + 1, content: line.slice(1) });
    } else if (line.startsWith('+') && !line.startsWith('+++')) {
      addedLines.push({ line: i + 1, content: line.slice(1) });
    }
  }

  // 检测断言替换
  for (const rule of ASSERTION_WEAKENING_RULES) {
    for (const removed of removedLines) {
      if (rule.before.test(removed.content)) {
        for (const added of addedLines) {
          if (rule.after.test(added.content)) {
            patterns.push({
              kind: rule.kind,
              line: removed.line,
              before: removed.content.trim().slice(0, 120),
              after: added.content.trim().slice(0, 120),
            });
          }
        }
      }
    }
  }

  // 检测断言删除（有删除行但无对应添加行）
  const assertionRegex = /\b(?:expect|assert)\s*\(/;
  for (const removed of removedLines) {
    if (assertionRegex.test(removed.content)) {
      const hasCorrespondingAdd = addedLines.some(
        (added) => Math.abs(added.line - removed.line) <= 3 && assertionRegex.test(added.content),
      );
      if (!hasCorrespondingAdd) {
        patterns.push({
          kind: 'assertion_removed',
          line: removed.line,
          before: removed.content.trim().slice(0, 120),
          after: '',
        });
      }
    }
  }

  // 检测非 diff 源码中的弱化模式（直接比较）
  if (patterns.length === 0 && removedLines.length === 0 && addedLines.length === 0) {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line === undefined) continue;
      // 检测 toBeTruthy 替代严格比较
      if (/\.toBeTruthy\s*\(\s*\)/.test(line) && /(?:===|!==|toBe|toEqual)/.test(line)) {
        patterns.push({
          kind: 'toBe_to_toBeTruthy',
          line: i + 1,
          before: '',
          after: line.trim().slice(0, 120),
        });
      }
    }
  }

  const hasRisk = patterns.length > 0;
  const riskLevel = hasRisk
    ? patterns.some((p) => p.kind === 'assertion_removed')
      ? 'critical'
      : 'high'
    : 'none';

  return { hasRisk, patterns, riskLevel };
}
