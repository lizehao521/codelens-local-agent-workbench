/**
 * 判据 · 单文件行数棘轮闸（S5 / Judge / C3 自证 + C4 不外推）
 *
 * 缺陷背景：本机实测 server/src 有 34 个文件超 300 行、client/src 有 15 个，
 * 最大 1550 行（agent-loop.service.ts，其中 run() 一个方法就 851 行）。
 * 此前没有任何行数闸，于是「巨方法」只能靠人眼发现。
 *
 * 为什么是棘轮而不是一刀切：一刀切会让闸从诞生起就红 49 处，结局是被人关掉；
 * 不管等于没有闸。棘轮 = 存量按现状封顶只许缩、增量一律 ≤300。
 *
 * 本判据钉死四条口径 + 边界，并额外把清单与磁盘对账：
 * 豁免清单是尺子，尺子刻度若与真实文件不符（孤儿 / 上限低于实测），闸就是装饰。
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DEFAULT_LIMIT, evaluate, tighten } from '../../../scripts/lib/file-size-ratchet.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const readJson = (rel: string) => JSON.parse(readFileSync(join(ROOT, rel), 'utf8'));

const FX = readJson('scripts/fixtures/file-size-ratchet/cases.json');
const BASELINE = readJson('scripts/file-size-baseline.json');

const files = (...xs: Array<[string, number]>) => xs.map(([file, lines]) => ({ file, lines }));
const paths = (xs: Array<{ file: string }>) => xs.map((x) => x.file).sort();

describe('口径 1：扫到 0 个文件 = UNEXEC，不是通过', () => {
  it('空扫描必须 unexec，passed 为 0', () => {
    const r = evaluate([], FX.entries, FX.limit);
    expect(r.unexec).toBe(true);
    expect(r.passed).toBe(0);
    expect(r.scanned).toBe(0);
    expect(r.failures).toEqual([]);
  });

  it('非空扫描不得被误记为 unexec', () => {
    const r = evaluate(files(['src/a.ts', 10]), [], FX.limit);
    expect(r.unexec).toBe(false);
    expect(r.scanned).toBe(1);
  });

  it('空扫描 + 非空清单也不得凭空判红（什么都没量到，无可判）', () => {
    const r = evaluate([], FX.entries, FX.limit);
    expect(r.stale).toEqual([]);
    expect(r.unexec === false).toBe(false);
  });
});

describe('口径 2：清单孤儿必须红（否则删掉再同名重建可继承旧上限）', () => {
  it('清单里有、磁盘上没有 → 进 failures 与 stale', () => {
    const r = evaluate(files(['src/big.ts', 500]), FX.entries, FX.limit);
    expect(paths(r.stale)).toEqual(['src/at-limit.ts', 'src/shrunk.ts']);
    expect(r.failures.length).toBe(2);
    expect(r.passed).toBe(1);
  });

  it('孤儿不得被静默丢弃', () => {
    const r = evaluate(files(['src/big.ts', 500]), FX.entries, FX.limit);
    expect(r.stale.length === 0).toBe(false);
    expect(r.failures.length === 0).toBe(false);
  });

  it('清单为空时不产生孤儿', () => {
    const r = evaluate(files(['src/a.ts', 10]), [], FX.limit);
    expect(r.stale).toEqual([]);
  });
});

describe('口径 3：上限只能下调，不能上调', () => {
  it('实测低于上限 → 下调到实测', () => {
    const t = tighten(FX.entries, files(['src/big.ts', 400]));
    expect(t.find((e: { file: string }) => e.file === 'src/big.ts').ceiling).toBe(400);
  });

  it('实测高于上限 → 保持旧上限（绝不抬刻度）', () => {
    const t = tighten(FX.entries, files(['src/shrunk.ts', 500]));
    const e = t.find((x: { file: string }) => x.file === 'src/shrunk.ts');
    expect(e.ceiling).toBe(400);
    expect(e.ceiling === 500).toBe(false);
  });

  it('不在实测里的条目原样保留，交给 evaluate 判孤儿', () => {
    const t = tighten(FX.entries, files(['src/big.ts', 400]));
    expect(t.length).toBe(FX.entries.length);
    expect(t.find((e: { file: string }) => e.file === 'src/at-limit.ts').ceiling).toBe(300);
  });

  it('tighten 不得新增条目（清单只缩不胀）', () => {
    const t = tighten(FX.entries, files(['src/brand-new.ts', 900]));
    expect(t.some((e: { file: string }) => e.file === 'src/brand-new.ts')).toBe(false);
  });

  it('夹具整组期望逐条成立', () => {
    const t = tighten(FX.entries, FX.tighten.files);
    for (const [file, ceiling] of Object.entries(FX.tighten.expectCeilings)) {
      expect(t.find((x: { file: string }) => x.file === file).ceiling).toBe(ceiling);
    }
  });
});

describe('口径 4：缩到上限以内要报「可出清单」', () => {
  it('存量缩到 280 行 → 进 graduated', () => {
    const r = evaluate(
      files(['src/big.ts', 500], ['src/shrunk.ts', 280], ['src/at-limit.ts', 300]),
      FX.entries,
      FX.limit,
    );
    expect(paths(r.graduated)).toEqual(['src/at-limit.ts', 'src/shrunk.ts']);
    expect(r.failures).toEqual([]);
  });

  it('仍超 300 的存量不得进 graduated', () => {
    const r = evaluate(files(['src/big.ts', 500], ['src/shrunk.ts', 400], ['src/at-limit.ts', 300]), FX.entries, FX.limit);
    expect(paths(r.graduated)).toEqual(['src/at-limit.ts']);
    expect(r.graduated.some((g: { file: string }) => g.file === 'src/big.ts')).toBe(false);
  });
});

describe('增量一律 ≤300，存量按各自上限', () => {
  it('新文件 301 行必须红', () => {
    const r = evaluate(files(['src/new.ts', 301]), [], FX.limit);
    expect(paths(r.failures)).toEqual(['src/new.ts']);
    expect(r.passed).toBe(0);
  });

  it('恰好 300 行算达标（> 而不是 >=）', () => {
    const r = evaluate(files(['src/exact.ts', 300]), [], FX.limit);
    expect(r.failures).toEqual([]);
    expect(r.passed).toBe(1);
  });

  it('存量比自己的上限多 1 行也要红', () => {
    const r = evaluate(files(['src/big.ts', 501]), [{ file: 'src/big.ts', ceiling: 500 }], FX.limit);
    expect(paths(r.failures)).toEqual(['src/big.ts']);
    expect(r.results[0].reason).toContain('只许缩不许涨');
  });

  it('存量等于上限放行，缩到上限以下也放行', () => {
    for (const n of [500, 499, 301]) {
      const r = evaluate(files(['src/big.ts', n]), [{ file: 'src/big.ts', ceiling: 500 }], FX.limit);
      expect(r.failures).toEqual([]);
    }
  });

  it('豁免只对清单里那个路径生效，不得惠及同名新文件', () => {
    const r = evaluate(files(['src/other.ts', 900]), [{ file: 'src/big.ts', ceiling: 500 }], FX.limit);
    expect(paths(r.failures)).toEqual(['src/big.ts', 'src/other.ts']);
    expect(r.passed).toBe(0);
  });

  it('默认上限就是 300', () => {
    expect(DEFAULT_LIMIT).toBe(300);
    expect(evaluate(files(['src/a.ts', 301]), []).failures.length).toBe(1);
  });
});

describe('夹具六态逐条成立（闸必须能红也能绿）', () => {
  for (const [name, c] of Object.entries(FX.cases) as Array<[string, any]>) {
    it(`夹具 ${name}`, () => {
      const r = evaluate(c.files, FX.entries, FX.limit);
      expect(r.unexec).toBe(c.expect.unexec);
      expect(r.passed).toBe(c.expect.passed);
      expect(paths(r.failures)).toEqual([...c.expect.failures].sort());
      if (c.expect.stale) expect(paths(r.stale)).toEqual([...c.expect.stale].sort());
      if (c.expect.graduated) expect(paths(r.graduated)).toEqual([...c.expect.graduated].sort());
    });
  }
});

describe('真实豁免清单必须与磁盘对账（尺子刻度不得失真）', () => {
  it('清单非空、上限为 300、无重复路径', () => {
    expect(BASELINE.limit).toBe(300);
    expect(BASELINE.entries.length > 0).toBe(true);
    const seen = new Set(BASELINE.entries.map((e: { file: string }) => e.file));
    expect(seen.size).toBe(BASELINE.entries.length);
  });

  it('两个包都在清单里（闸不能只盯一边）', () => {
    for (const prefix of ['server/src/', 'client/src/']) {
      expect(BASELINE.entries.some((e: { file: string }) => e.file.startsWith(prefix))).toBe(true);
    }
  });

  it('每条豁免的文件都真实存在，且实测行数不超过上限', () => {
    for (const e of BASELINE.entries) {
      const abs = join(ROOT, e.file);
      expect(existsSync(abs), `豁免清单里的孤儿：${e.file}`).toBe(true);
      const lines = readFileSync(abs, 'utf8').split('\n').length;
      expect(lines <= e.ceiling, `${e.file} 实测 ${lines} 行 > 上限 ${e.ceiling}`).toBe(true);
      expect(e.ceiling >= BASELINE.limit, `${e.file} 上限 ${e.ceiling} 低于 ${BASELINE.limit}，豁免无意义`).toBe(true);
    }
  });

  it('清单里不得混进已达标文件（棘轮必须能收紧）', () => {
    for (const e of BASELINE.entries) {
      const lines = readFileSync(join(ROOT, e.file), 'utf8').split('\n').length;
      expect(lines > BASELINE.limit, `${e.file} 已缩到 ${lines} 行，应从豁免清单移除`).toBe(true);
    }
  });

  it('未被豁免的真实文件一律 ≤300（抽查两个包各一个已知小文件）', () => {
    for (const rel of ['server/src/tools/builtin/time-now.tool.ts', 'client/src/lib/approval-receipt.ts']) {
      const lines = readFileSync(join(ROOT, rel), 'utf8').split('\n').length;
      expect(BASELINE.entries.some((e: { file: string }) => e.file === rel)).toBe(false);
      expect(lines <= 300).toBe(true);
    }
  });
});

describe('闸必须真的被接进验收（纯静态扫描，没有理由只选跑）', () => {
  it('两个包都提供 check:file-size 入口，且指向同一把尺子', () => {
    for (const pkg of ['server', 'client']) {
      const cmd = readJson(`${pkg}/package.json`).scripts['check:file-size'];
      expect(cmd).toContain('scripts/check-file-size.mjs');
    }
  });

  it('两个包的 test:acceptance 都串上了这道闸', () => {
    for (const pkg of ['server', 'client']) {
      const acc = readJson(`${pkg}/package.json`).scripts['test:acceptance'];
      expect(acc).toContain('npm run check:file-size');
      expect(acc.includes('||')).toBe(false);
    }
  });

  it('与覆盖率闸的取舍相反：行数闸不得被排除在验收之外', () => {
    const server = readJson('server/package.json').scripts;
    expect(server['test:acceptance'].includes('check:file-size')).toBe(true);
    expect(server['test:acceptance'].includes('coverage')).toBe(false);
  });
});