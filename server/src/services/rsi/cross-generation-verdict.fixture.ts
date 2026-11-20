/**
 * cross-generation-verdict 测试共用夹具。
 * 从 cross-generation-verdict.test.ts 拆出（结构棘轮 ≤300 行）。
 */
import { CROSS_GENERATION_VERDICT_RULES_VERSION } from './cross-generation-verdict.js';
import type {
  CrossGenerationVerdictInput,
  GenerationIndicators,
  IndicatorValue,
} from './cross-generation-verdict.js';
import type {
  EvidenceLevel,
  GenerationEvidence,
  MetricDefinition,
} from './cross-generation-contract.js';

export const primaryDefinition: MetricDefinition = {
  id: 'test_pass_rate',
  definitionVersion: 'pass-rate.v1',
  direction: 'higher_is_better',
  unit: 'ratio',
};

export const guardDefinition: MetricDefinition = {
  id: 'suite_floor_ratio',
  definitionVersion: 'suite-floor.v1',
  direction: 'higher_is_better',
  unit: 'ratio',
};

export const diagnosticDefinition: MetricDefinition = {
  id: 'tool_success_rate',
  definitionVersion: 'tool-success.v1',
  direction: 'higher_is_better',
  unit: 'ratio',
};

export function indicator(
  definition: MetricDefinition,
  value: number,
): IndicatorValue {
  return { definition, value };
}

export function indicators(
  primary: number,
  guard = 1,
  diagnostic = 0.5,
): GenerationIndicators {
  return {
    primary: indicator(primaryDefinition, primary),
    guards: [indicator(guardDefinition, guard)],
    diagnostics: [indicator(diagnosticDefinition, diagnostic)],
  };
}

export function evidence(level: EvidenceLevel): GenerationEvidence {
  switch (level) {
    case 'designed':
      return { level };
    case 'landed':
      return { level, landedFilesHash: 'fixture-landed-files-hash' };
    case 'targeted_passed':
      return {
        level,
        landedFilesHash: 'fixture-landed-files-hash',
        targetedTestCommand: 'fixture-targeted-test-command',
      };
    case 'full_suite_passed':
      return {
        level,
        landedFilesHash: 'fixture-landed-files-hash',
        targetedTestCommand: 'fixture-targeted-test-command',
        fullSuiteCommand: 'fixture-full-suite-command',
      };
    case 'runtime_verified':
      return {
        level,
        landedFilesHash: 'fixture-landed-files-hash',
        targetedTestCommand: 'fixture-targeted-test-command',
        fullSuiteCommand: 'fixture-full-suite-command',
        runtimeEvidenceHash: 'fixture-runtime-evidence-hash',
      };
  }
}

export function input(options: {
  readonly previousPrimary?: number;
  readonly nextPrimary?: number;
  readonly previousGuard?: number;
  readonly nextGuard?: number;
  readonly previousDiagnostic?: number;
  readonly nextDiagnostic?: number;
  readonly previousLevel?: EvidenceLevel;
  readonly nextLevel?: EvidenceLevel;
  readonly previousIndicators?: GenerationIndicators;
  readonly nextIndicators?: GenerationIndicators;
} = {}): CrossGenerationVerdictInput {
  return {
    rulesVersion: CROSS_GENERATION_VERDICT_RULES_VERSION,
    previous: {
      indicators:
        options.previousIndicators ??
        indicators(
          options.previousPrimary ?? 0.9,
          options.previousGuard ?? 1,
          options.previousDiagnostic ?? 0.5,
        ),
      evidence: evidence(options.previousLevel ?? 'landed'),
    },
    next: {
      indicators:
        options.nextIndicators ??
        indicators(
          options.nextPrimary ?? 0.91,
          options.nextGuard ?? 1,
          options.nextDiagnostic ?? 0.5,
        ),
      evidence: evidence(options.nextLevel ?? 'targeted_passed'),
    },
  };
}

