import { ConvergenceDetector, buildRoundSignature } from '../src/services/agent/convergence-detector.ts';

const threshold = 3;

function makeState(tools: Array<{ callId: string; name: string; status: 'success' | 'failed' | 'timeout' | 'rejected' | 'skipped'; resultSummary?: string | null; errorCode?: string | null }>, fileChanges: number = 0) {
  return {
    tools: tools.map(t => ({
      callId: t.callId,
      name: t.name,
      iteration: 1,
      status: t.status,
      startedAt: Date.now(),
      durationMs: 10,
      risk: 'low' as const,
      approvalMode: 'none' as const,
      effectReversible: null,
      resultSummary: t.resultSummary ?? null,
      errorCode: t.errorCode ?? null,
    })),
    fileChanges: Array.from({ length: fileChanges }, (_, i) => ({
      path: `file${i}.ts`,
      step: 1,
      checkpointId: null,
      beforeSha256: null,
      afterSha256: null,
      added: 10,
      removed: 5,
    })),
  };
}

console.log('=== 探针：修复后行为（预期绿基线）===');

const detector = new ConvergenceDetector(threshold);
const failedTools = [
  { callId: 'c1', name: 'fs_write', status: 'failed' as const, errorCode: 'invalid_args', resultSummary: '参数 JSON 不完整' },
  { callId: 'c2', name: 'fs_write', status: 'failed' as const, errorCode: 'invalid_args', resultSummary: '参数 JSON 不完整' },
];

console.log('\n--- 连续 4 轮相同失败 ---');
for (let i = 0; i < 4; i++) {
  const sig = buildRoundSignature(makeState(failedTools), i * 2, 0);
  const v = detector.record(sig);
  console.log(`第 ${i + 1} 轮: streak=${v.streak}, converged=${v.converged}, allFailed=${sig.allFailed}`);
}

console.log('\n--- 预期：所有轮 streak=0, converged=false（失败轮不累加）---');