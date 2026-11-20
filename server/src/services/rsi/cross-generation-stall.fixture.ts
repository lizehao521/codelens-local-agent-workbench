/**
 * cross-generation-stall 测试共用工厂。
 * 从 cross-generation-stall.test.ts 拆出（结构棘轮 ≤300 行）。
 */
import type {
  FailureInput,
  DiffInput,
  EvidenceSnapshot,
  GenerationRecord,
} from './cross-generation-stall.js';

export function makeFailure(overrides: Partial<FailureInput> = {}): FailureInput {
  return {
    rawText: 'Error: something went wrong',
    ...overrides,
  };
}

export function makeDiff(diffText: string): DiffInput {
  return { diffText };
}

export function makeEvidence(overrides: Partial<EvidenceSnapshot> = {}): EvidenceSnapshot {
  return {
    level: 'landed',
    artifactHash: 'abc123',
    ...overrides,
  };
}

export function makeRecord(overrides: Partial<GenerationRecord> = {}): GenerationRecord {
  return { ...overrides };
}
