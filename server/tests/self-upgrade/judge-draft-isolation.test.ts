/**
 * 判据 · 未派单的判据草稿必须待在 candidates/，且回归不扫这个目录（Judge / 尺子侧）
 *
 * 缺口现场（2026-11-14）：G2-b 的 code-search 判据先写进了 tests/self-upgrade/，
 * 而它的实现还没派单 —— 判据按设计红。围栏跑全量回归时把它算进失败项，
 * 于是「别的题还没做」被读成「这一题踩坏了既有行为」。落盘证据：
 * .self-upgrade/loop/full-regression-1794602217105.txt。
 *
 * 两半都要钉住：判据恰好一份（草稿与采纳件不并存），且 vitest 的 exclude 真的排除
 * candidates/。只放对位置不改 exclude 等于没做 —— 回归照样扫得到。
 *
 * 口径：exclude 读**解析后的配置对象**，不做源码文本扫描 —— 把 'candidates/**'
 * 注释掉时文本仍在，扫描会绿得理所当然（实测第一版判据就这样被变异体骗过）。
 * C3：摘掉 vitest.config.ts 里的 'candidates/**'，本判据必须转红。
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SERVER = fileURLToPath(new URL('../..', import.meta.url));
const read = (rel: string) => readFileSync(`${SERVER}${rel}`, 'utf8');

describe('草稿判据的落脚点', () => {
  it('vitest 的 exclude 必须含 candidates/**（否则草稿会进全量回归）', async () => {
    const cfg = (await import('../../vitest.config.ts')).default as { test?: { exclude?: string[] } };
    const exclude = cfg.test?.exclude ?? [];
    expect(exclude).toContain('candidates/**');
    expect(exclude).toContain('**/dist/**');
  });

  it('code-search 判据恰好一份：草稿与采纳件不得并存', () => {
    // 不钉「此刻在哪」——promote 之后、实现落地之前，判据在 tests/ 下按设计是红的，
    // 钉位置会让本判据在那段窗口里假红，正是它要防的污染。
    // 并存才是真缺陷：两份判据各跑一遍，用例数虚增、断言口径还可能分叉。
    const draft = existsSync(`${SERVER}candidates/code-search.candidate.ts`);
    const promoted = existsSync(`${SERVER}tests/self-upgrade/code-search.test.ts`);
    expect(draft || promoted).toBe(true);
    expect(draft && promoted).toBe(false);
  });

  it('tasks.json 里 code-search 的 judge 指向必须与落脚点一致', () => {
    const tasks = JSON.parse(read('self-upgrade/tasks.json')) as { tasks?: Array<{ id: string; judge?: string }> };
    const spec = (tasks.tasks ?? []).find((t) => t.id === 'code-search');
    expect(spec).toBeDefined();
    expect(spec?.judge).toBe('tests/self-upgrade/code-search.test.ts');
    const evidence = JSON.stringify(spec);
    expect(evidence.includes('candidates/code-search.candidate.ts')).toBe(true);
  });
});