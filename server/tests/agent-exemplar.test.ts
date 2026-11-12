import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  appendExemplar,
  formatExemplars,
  readExemplars,
  recentExemplars,
  type Exemplar,
} from '../scripts/lib/agent-feedback.js';

const mk = (over: Partial<Exemplar> = {}): Exemplar => ({
  id: 'fs-delete-dir-requires-recursive',
  title: '删除目录未校验 recursive 参数',
  gapType: 'defect',
  targetFile: 'src/tools/builtin/fs-write.tool.ts',
  evidence: [
    'fs-write.tool.ts:294-295 删除分支仅读 args.recursive 并传给 rm，未判断目标是否为目录',
    'fs-write.tool.ts:287-292 只检查存在性，未区分文件/目录',
  ],
  observable: '不传 recursive 删目录 → 期望 invalid_args，现状抛 ENOTEMPTY/EPERM',
  passed: ['自证基线红', 'A1–A4'],
  at: '2026-11-12T06:00:00.000Z',
  ...over,
});

describe('formatExemplars', () => {
  it('空库时给出兜底指引，不留空白', () => {
    expect(formatExemplars([])).toContain('暂无成功样例');
  });

  it('把靶子、带行号的证据、可观察项、已过闸全部带出来', () => {
    const s = formatExemplars([mk()]);
    expect(s).toContain('删除目录未校验 recursive 参数');
    expect(s).toContain('src/tools/builtin/fs-write.tool.ts');
    expect(s).toContain('fs-write.tool.ts:294-295');
    expect(s).toContain('invalid_args');
    expect(s).toContain('自证基线红 / A1–A4');
  });

  it('点明正例的共同形状：不是加新字段，而是现有参数在某输入下没被正确处理', () => {
    expect(formatExemplars([mk()])).toContain('不是「加个新字段」');
  });

  it('只取最近 limit 条', () => {
    const list = [mk({ id: 'old-one', title: '旧样例标题' }), mk({ id: 'new-one', title: '新样例标题' })];
    const s = formatExemplars(list, 1);
    expect(s).not.toContain('旧样例标题');
    expect(s).toContain('新样例标题');
  });

  it('证据超长会截断，不撑爆提示词', () => {
    const s = formatExemplars([mk({ evidence: ['x'.repeat(2000)] })], 1);
    expect(s.length).toBeLessThan(900);
  });
});

describe('正例库读写', () => {
  it('append 后能读回，且 evidence 原样保留（行号是正例的核心价值）', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'rsi-ex-'));
    const file = path.join(dir, 'ex.jsonl');
    try {
      appendExemplar(mk(), file, path.join(dir, 'rej-empty.jsonl'));
      const back = readExemplars(5, file, path.join(dir, 'rej-empty.jsonl'));
      expect(back).toHaveLength(1);
      expect(back[0]!.evidence[0]).toContain('fs-write.tool.ts:294-295');
      expect(back[0]!.gapType).toBe('defect');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('缺 evidence 的行被跳过（没有行号的正例会把模型带回臆测）', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'rsi-ex-'));
    const file = path.join(dir, 'ex.jsonl');
    try {
      writeFileSync(file, '{"id":"bad","title":"t"}\n{"id":"ok","evidence":["a.ts:1 说明"]}\n', 'utf8');
      const back = readExemplars(5, file);
      expect(back).toHaveLength(1);
      expect(back[0]!.id).toBe('ok');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('库不存在时返回空数组，不抛错', () => {
    expect(readExemplars(2, path.join(tmpdir(), 'missing-ex-rsi.jsonl'))).toEqual([]);
  });

  it('recentExemplars 在空库下也能安全拼进提示词', () => {
    const s = recentExemplars(2, path.join(tmpdir(), 'missing-ex-rsi.jsonl'));
    expect(typeof s).toBe('string');
    expect(s).toContain('暂无成功样例');
  });

  it('真实仓库的正例库至少有一条，且带行号证据', () => {
    // 这条防止「正例库被误清空」——它现在是出题质量的关键输入。
    const dir = path.resolve(import.meta.dirname, '../../.self-upgrade');
    const file = path.join(dir, 'exemplars.jsonl');
    let raw = '';
    try {
      raw = readFileSync(file, 'utf8');
    } catch {
      return; // 独立部署环境可能没有该目录，跳过
    }
    const rows = raw.split('\n').filter(Boolean);
    expect(rows.length).toBeGreaterThan(0);
    const first = JSON.parse(rows[0]!) as Exemplar;
    expect(first.evidence.some((e) => /\w+\.\w*ts?:\d+/.test(e) || /:\d+/.test(e))).toBe(true);
  });
});

// 正例库比错题本更危险：错题本说「别这样」，正例库说「就照这样」。
// 现场事故：fs-read-maxbytes-default-mismatch 先被采纳（写了正例），后被判
// DIRECTION_INVERTED 撤回 —— 脏正例留在库里，下一轮 propose 照着学错方向。
describe('正例库：不配当正例的不许进，进了的也要滤掉', () => {
  const withRej = (rows: Array<{ id: string; code: string }>) => {
    const dir = mkdtempSync(path.join(tmpdir(), 'rsi-ex-'));
    const exFile = path.join(dir, 'ex.jsonl');
    const rejFile = path.join(dir, 'rej.jsonl');
    rmSync(rejFile, { force: true });
    writeFileSync(
      rejFile,
      rows
        .map((r) =>
          JSON.stringify({
            id: r.id,
            stage: 'adopt-a4',
            code: r.code,
            detail: 'x',
            fix: 'y',
            at: '2026-11-12T08:00:00.000Z',
          }),
        )
        .join('\n') + '\n',
      'utf8',
    );
    return { dir, exFile, rejFile };
  };

  it('背了 DIRECTION_INVERTED 的 id 写不进去（append 返回 false）', () => {
    const { dir, exFile, rejFile } = withRej([
      { id: 'fs-read-maxbytes-default-mismatch', code: 'DIRECTION_INVERTED' },
    ]);
    try {
      const ok = appendExemplar(
        mk({ id: 'fs-read-maxbytes-default-mismatch', title: '方向判反的样例' }),
        exFile,
        rejFile,
      );
      expect(ok).toBe(false);
      // 文件压根没被创建：不是「写了又删」，是根本没走写盘那一步
      expect(existsSync(exFile)).toBe(false);
      expect(readExemplars(5, exFile, rejFile)).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('存量脏正例在读取时被滤掉（先采纳后撤回的历史数据）', () => {
    const { dir, exFile, rejFile } = withRej([{ id: 'bad-topic', code: 'GREEN_BASELINE' }]);
    try {
      // 绕过 append 的闸，模拟「历史上已经写进去了」
      writeFileSync(
        exFile,
        [mk({ id: 'bad-topic' }), mk({ id: 'good-topic' })]
          .map((e) => JSON.stringify(e))
          .join('\n') + '\n',
        'utf8',
      );
      const back = readExemplars(5, exFile, rejFile);
      expect(back.map((e) => e.id)).toEqual(['good-topic']);
      expect(recentExemplars(5, exFile, rejFile)).not.toContain('bad-topic');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('同 id 重复只留最新一条（采纳重试会重复写）', () => {
    const { dir, exFile, rejFile } = withRej([]);
    try {
      writeFileSync(
        exFile,
        [
          JSON.stringify(mk({ id: 'dup', title: '旧版标题' })),
          JSON.stringify(mk({ id: 'dup', title: '新版标题' })),
        ].join('\n') + '\n',
        'utf8',
      );
      const back = readExemplars(5, exFile, rejFile);
      expect(back).toHaveLength(1);
      expect(back[0]!.title).toBe('新版标题');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('A2_5_PROBE_INVALID / PREMATURE / 判据编译错 同样拦（题没验过就不算成功）', () => {
    for (const code of ['A2_5_PROBE_INVALID', 'PREMATURE', 'TS2339']) {
      const { dir, exFile, rejFile } = withRej([{ id: 'never-verified', code }]);
      try {
        expect(appendExemplar(mk({ id: 'never-verified' }), exFile, rejFile)).toBe(false);
        expect(readExemplars(5, exFile, rejFile)).toHaveLength(0);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });
});
