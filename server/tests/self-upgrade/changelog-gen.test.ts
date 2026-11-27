/**
 * 判据 · CHANGELOG 生成（P1-2 收尾）
 *
 * 缺陷背景：「自动 Changelog」一直挂在 P1-2 里没人做，于是每轮发版都得手抄提交，
 * 抄漏了就永久丢失。补上脚本只是第一步，真正容易坏的是这些判断：
 *   1. 手写的中文提交（`修了个 bug`）没有 type 前缀 —— 直接丢弃会让日志缺一块；
 *   2. 合并提交与 `chore(release)` 只是噪音，进了日志反而看不出真实变更；
 *   3. 同一批提交跑两遍必须幂等，否则每跑一次日志就长一截；
 *   4. 切版（Unreleased → 2.32.0）不能把正文弄丢，也不能重复切同一个版本。
 *
 * 本文件把上面四条钉死；脚本本体（scripts/gen-changelog.mjs）只负责调 git，不在此验证。
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  freezeRelease,
  groupCommits,
  mergeUnreleased,
  parseCommitSubject,
  parseLatestVersion,
  renderEntry,
  renderGroups,
} from '../../../scripts/lib/changelog.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const REAL_CHANGELOG = readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8');

describe('解析提交标题', () => {
  it('type(scope): 描述 → 分组与作用域都对', () => {
    const parsed = parseCommitSubject('feat(P1-2): π 策略版本历史与回滚');
    expect(parsed).toMatchObject({ type: 'feat', group: '新增', scope: 'P1-2', breaking: false });
    expect(parsed.text).toBe('π 策略版本历史与回滚');
  });

  it('破坏性标记 `!` 保留下来', () => {
    const parsed = parseCommitSubject('fix(api)!: 移除 v1 别名');
    expect(parsed.breaking).toBe(true);
    expect(renderEntry(parsed)).toBe('- **破坏性变更** 移除 v1 别名（api）');
  });

  it('中文冒号也算分隔符', () => {
    expect(parseCommitSubject('fix：修了个空指针')?.group).toBe('修复');
  });

  it('无前缀的中文提交不丢，落进「杂项」', () => {
    const parsed = parseCommitSubject('修了个 bug');
    expect(parsed).toMatchObject({ type: 'other', group: '杂项', text: '修了个 bug' });
  });

  it('合并提交与发版提交不产生条目', () => {
    expect(parseCommitSubject('Merge branch \'main\' into feature')).toBeNull();
    expect(parseCommitSubject('chore(release): 2.32.0')).toBeNull();
  });

  it('未知 type 归入杂项而不是丢弃', () => {
    expect(parseCommitSubject('wip: 半成品')?.group).toBe('杂项');
  });
});

describe('分组与渲染', () => {
  it('分组顺序跟 GROUP_ORDER 走，不跟提交顺序走', () => {
    const { groups } = groupCommits([
      { hash: 'a', subject: 'chore: 收尾' },
      { hash: 'b', subject: 'fix: 修一个 bug' },
      { hash: 'c', subject: 'feat: 新功能' },
    ]);
    expect(groups.map((g) => g.title)).toEqual(['新增', '修复', '杂项']);
  });

  it('被跳过的提交单独汇报，不静默消失', () => {
    const { skipped, groups } = groupCommits([
      { hash: 'a', subject: 'Merge pull request #1 from x/y' },
      { hash: 'b', subject: 'chore(release): 2.32.0' },
      { hash: 'c', subject: 'feat: 保留的' },
    ]);
    expect(skipped.map((c) => c.hash)).toEqual(['a', 'b']);
    expect(groups).toHaveLength(1);
  });

  it('空分组不出标题', () => {
    expect(renderGroups([])).toBe('');
    expect(renderGroups([{ title: '新增', entries: [] }])).toBe('');
  });
});

describe('并入 Unreleased', () => {
  const doc = '# 变更日志\n\n说明段。\n\n## [2.31.0] - 2026-11-27\n\n### 新增\n\n- 旧的东西\n';

  it('没有 Unreleased 段时新建在首个版本段之前', () => {
    const merged = mergeUnreleased(doc, '### 修复\n\n- 新修的一个 bug');
    expect(merged.indexOf('## [Unreleased]')).toBeLessThan(merged.indexOf('## [2.31.0]'));
    expect(merged).toContain('- 新修的一个 bug');
    // 原有内容一个字都不能少
    expect(merged).toContain('- 旧的东西');
    expect(merged).toContain('说明段。');
  });

  it('已有 Unreleased 段时追加，不新建第二段', () => {
    const once = mergeUnreleased(doc, '### 新增\n\n- 甲');
    const twice = mergeUnreleased(once, '### 修复\n\n- 乙');
    expect(twice.match(/## \[Unreleased\]/g)).toHaveLength(1);
    expect(twice).toContain('- 甲');
    expect(twice).toContain('- 乙');
  });

  it('同一批提交跑两遍不重复（幂等）', () => {
    const body = '### 新增\n\n- 同样的条目';
    const once = mergeUnreleased(doc, body);
    const twice = mergeUnreleased(once, body);
    expect(twice.match(/^- 同样的条目$/gm)).toHaveLength(1);
  });
});

describe('发版切段', () => {
  const doc = '## [Unreleased]\n\n### 新增\n\n- 待发的功能\n\n## [2.31.0] - 2026-11-27\n\n### 新增\n\n- 老的\n';

  it('正文搬进新版本段，并新开一个空 Unreleased', () => {
    const next = freezeRelease(doc, '2.32.0', '2026-11-28');
    expect(next).toContain('## [2.32.0] - 2026-11-28\n\n### 新增\n\n- 待发的功能');
    expect(next.indexOf('## [Unreleased]')).toBeLessThan(next.indexOf('## [2.32.0]'));
    expect(next).toContain('## [2.31.0] - 2026-11-27');
    expect(next.match(/## \[Unreleased\]/g)).toHaveLength(1);
  });

  it('切版后新版本标题不能粘在上一行末尾', () => {
    const next = freezeRelease(doc, '2.32.0', '2026-11-28');
    // 曾经出过 `…（x）## [2.31.0]` 这种粘连：含标题的行必须整行就是标题本身。
    const lines = next.split('\n').filter((line) => line.includes('## ['));
    for (const line of lines) expect(line).toMatch(/^## \[[^\]]+\]/);
    expect(lines).toContain('## [2.31.0] - 2026-11-27');
  });

  it('同一版本切两次必须报错，而不是静默覆盖', () => {
    const once = freezeRelease(doc, '2.32.0', '2026-11-28');
    expect(() => freezeRelease(once, '2.32.0', '2026-11-29')).toThrow(/已经有 \[2\.32\.0\]/);
  });

  it('没有 Unreleased 段时拒绝切版', () => {
    expect(() => freezeRelease('## [2.31.0] - 2026-11-27\n', '2.32.0', '2026-11-28')).toThrow(
      /没有 \[Unreleased\]/,
    );
  });

  it('非法版本号直接拒绝', () => {
    expect(() => freezeRelease(doc, 'v2.32', '2026-11-28')).toThrow(/x\.y\.z/);
  });
});

describe('仓库现状', () => {
  it('CHANGELOG 能读出最新版本号，且 Unreleased 段存在', () => {
    expect(parseLatestVersion(REAL_CHANGELOG)).toMatch(/^\d+\.\d+\.\d+$/);
    expect(REAL_CHANGELOG).toContain('## [Unreleased]');
  });
});