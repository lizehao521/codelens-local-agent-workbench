import { defineConfig } from 'vitest/config';

/**
 * CI 判据通道 · 对抗反向断言：
 *   - 收敛判定 V1/V2/N1（M1/M2 自迭代）
 *   - D1-B-08 混合换行 replace、内核审批 deadline 死循环、rename 覆盖审批绕过（全库审计三真 BUG）
 *   - E1：MCP annotations 冲突信号 fail-closed（新一轮双开，含 REV-1 idempotent 一致性）
 *
 * 为什么单独一份配置，而不是并进 vitest.config.ts：
 *   - 主配置的 exclude 含 `candidates/**`，且有 tests/self-upgrade/judge-draft-isolation.test.ts
 *     把这个 exclude 钉成判据。草稿判据进主回归会破坏「未派单判据不得进全量回归」的约束。
 *   - 用户要求 tests/ 红线留着：判据不搬进 tests/self-upgrade/，就地留在 candidates/ 执行。
 *   - 于是开一条独立通道：只 include 本判据、exclude 里不放 candidates/**，
 *     由 package.json 的 test:ci-guards 调用，CI 里作为独立一步跑。
 *
 * 判据内容若有第二份（搬进 tests/），必须删掉本通道指向的这份，避免同一断言跑两遍、口径分叉。
 */
export default defineConfig({
  test: {
    include: [
      'candidates/convergence-blind-to-failure-loops.candidate.ts',
      'candidates/convergence-threshold-one.candidate.ts',
      'candidates/convergence-m2-lastchanged.candidate.ts',
      // 全库审计三真 BUG 的回归判据（A 修复后 B 红队复验通过）
      'candidates/fs-write-mixed-eol-replace.candidate.ts',
      'candidates/approval-deadline-expired-no-challenge.candidate.ts',
      'candidates/fs-rename-overwrite-approval-bypass.candidate.ts',
      // E1 新一轮：MCP annotations 冲突信号 fail-closed（含 REV-1 idempotent 一致性）
      'candidates/mcp-risk-conflicting-annotations.candidate.ts',
    ],
    // 刻意不含 'candidates/**' —— 本通道的目的就是执行 candidates 下的判据。
    exclude: ['**/node_modules/**', '**/.git/**', '**/dist/**', 'workspace/**'],
    maxWorkers: 1,
    testTimeout: 30_000,
  },
});
