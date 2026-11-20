/**
 * cross-generation-stall：停止判定与证据快照提取测试。
 * 从 cross-generation-stall.test.ts 拆出（结构棘轮 ≤300 行）。
 */
import { describe, it, expect } from 'vitest';
import {
  evaluateStall,
  evidenceSnapshotFromGenerationEvidence,
} from './cross-generation-stall.js';
import { makeDiff, makeEvidence, makeFailure, makeRecord } from './cross-generation-stall.fixture.js';
import type { GenerationEvidence } from './cross-generation-contract.js';
import type { GenerationRecord } from './cross-generation-stall.js';

// ---------------------------------------------------------------------------
// 轮2：停止判定 evaluateStall
// ---------------------------------------------------------------------------

describe('evaluateStall', () => {
  it('T0-1：首轮总是 continue，不误停', () => {
    const history: GenerationRecord[] = [
      makeRecord({
        failure: makeFailure({ rawText: '出错了' }),
        diff: makeDiff(''),
        evidence: makeEvidence(),
      }),
    ];
    const verdict = evaluateStall(history);
    expect(verdict.stopped).toBe(false);
    expect(verdict.reason).toBe('none');
    expect(verdict.evidenceChain).toEqual([]);
  });

  it('T0-2：连续两轮相同失败签名 → stop / signature_repeated', () => {
    const failure = makeFailure({ rawText: 'foo.ts:42 类型不匹配', errorType: 'TS2345' });
    const failureNoisy = makeFailure({ rawText: 'foo.ts:99 类型不匹配', errorType: 'TS2345' });
    const history: GenerationRecord[] = [
      makeRecord({ failure }),
      makeRecord({ failure: failureNoisy }),
    ];
    const verdict = evaluateStall(history);
    expect(verdict.stopped).toBe(true);
    expect(verdict.reason).toBe('signature_repeated');
    expect(verdict.crossGenerationVerdict).toBe('not_improved');
    expect(verdict.evidenceChain).toEqual([0, 1]);
  });

  it('两轮不同失败签名 → continue', () => {
    const history: GenerationRecord[] = [
      makeRecord({ failure: makeFailure({ rawText: '类型不匹配', errorType: 'TS2345' }) }),
      makeRecord({ failure: makeFailure({ rawText: '模块未找到', errorType: 'TS2307' }) }),
    ];
    const verdict = evaluateStall(history);
    expect(verdict.stopped).toBe(false);
    expect(verdict.reason).toBe('none');
  });

  it('T0-3：零有效 diff（仅注释变化）→ stop / zero_diff', () => {
    const history: GenerationRecord[] = [
      makeRecord({ failure: makeFailure({ rawText: '错误A', errorType: 'E1' }) }),
      makeRecord({
        failure: makeFailure({ rawText: '错误B', errorType: 'E2' }),
        diff: makeDiff('--- a/f.ts\n+++ b/f.ts\n-// 旧\n+// 新\n'),
      }),
    ];
    const verdict = evaluateStall(history);
    expect(verdict.stopped).toBe(true);
    expect(verdict.reason).toBe('zero_diff');
    expect(verdict.crossGenerationVerdict).toBe('not_improved');
  });

  it('T0-4：零新增证据 → stop / zero_evidence', () => {
    const ev = makeEvidence({ level: 'landed', artifactHash: 'same' });
    const history: GenerationRecord[] = [
      makeRecord({
        failure: makeFailure({ rawText: '错误A', errorType: 'E1' }),
        evidence: ev,
      }),
      makeRecord({
        failure: makeFailure({ rawText: '错误B', errorType: 'E2' }),
        evidence: ev,
      }),
    ];
    const verdict = evaluateStall(history);
    expect(verdict.stopped).toBe(true);
    expect(verdict.reason).toBe('zero_evidence');
    expect(verdict.crossGenerationVerdict).toBe('not_improved');
  });

  it('证据 level 升级 → continue（不触发零新增证据停止）', () => {
    const history: GenerationRecord[] = [
      makeRecord({
        failure: makeFailure({ rawText: '错误A', errorType: 'E1' }),
        evidence: makeEvidence({ level: 'landed', artifactHash: 'h1' }),
      }),
      makeRecord({
        failure: makeFailure({ rawText: '错误B', errorType: 'E2' }),
        evidence: makeEvidence({ level: 'targeted_passed', artifactHash: 'h1' }),
      }),
    ];
    const verdict = evaluateStall(history);
    expect(verdict.stopped).toBe(false);
  });

  it('三代：第2、3代同签名 → stop，evidenceChain 指向 [1,2]', () => {
    const f1 = makeFailure({ rawText: '错误A', errorType: 'E1' });
    const f2 = makeFailure({ rawText: 'foo.ts:10 类型不匹配', errorType: 'TS2345' });
    const f3 = makeFailure({ rawText: 'foo.ts:20 类型不匹配', errorType: 'TS2345' });
    const history: GenerationRecord[] = [
      makeRecord({ failure: f1 }),
      makeRecord({ failure: f2 }),
      makeRecord({ failure: f3 }),
    ];
    const verdict = evaluateStall(history);
    expect(verdict.stopped).toBe(true);
    expect(verdict.reason).toBe('signature_repeated');
    expect(verdict.evidenceChain).toEqual([1, 2]);
  });

  it('无 failure 字段时跳过签名比较，不误停', () => {
    const history: GenerationRecord[] = [
      makeRecord({}),
      makeRecord({}),
    ];
    const verdict = evaluateStall(history);
    expect(verdict.stopped).toBe(false);
    expect(verdict.reason).toBe('none');
  });

  it('T0-5：签名中不得含密钥明文（集成验证）', () => {
    const f = makeFailure({
      rawText: '请求失败 Authorization: Bearer sk-secret123 api_key=key456',
    });
    const history: GenerationRecord[] = [
      makeRecord({ failure: f }),
      makeRecord({ failure: f }),
    ];
    const verdict = evaluateStall(history);
    // 同签名应停止
    expect(verdict.stopped).toBe(true);
    // detail 中不得含原始密钥
    expect(verdict.detail).not.toContain('sk-secret123');
    expect(verdict.detail).not.toContain('key456');
  });
});

// ---------------------------------------------------------------------------
// 便捷工厂：evidenceSnapshotFromGenerationEvidence
// ---------------------------------------------------------------------------

describe('evidenceSnapshotFromGenerationEvidence', () => {
  it('从 GenerationEvidence 提取 level 与 landedFilesHash', () => {
    const ge: GenerationEvidence = {
      level: 'landed',
      landedFilesHash: 'filehash123',
    };
    const snap = evidenceSnapshotFromGenerationEvidence(ge);
    expect(snap.level).toBe('landed');
    expect(snap.artifactHash).toBe('filehash123');
  });

  it('landedFilesHash 缺失时取 runtimeEvidenceHash', () => {
    const ge: GenerationEvidence = {
      level: 'runtime_verified',
      runtimeEvidenceHash: 'runtimehash456',
    };
    const snap = evidenceSnapshotFromGenerationEvidence(ge);
    expect(snap.level).toBe('runtime_verified');
    expect(snap.artifactHash).toBe('runtimehash456');
  });

  it('两者均缺失时 artifactHash 为 undefined', () => {
    const ge: GenerationEvidence = { level: 'designed' };
    const snap = evidenceSnapshotFromGenerationEvidence(ge);
    expect(snap.level).toBe('designed');
    expect(snap.artifactHash).toBeUndefined();
  });
});

