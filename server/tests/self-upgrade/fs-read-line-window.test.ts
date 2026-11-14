/**
 * 判据 · fs.read 的行窗口必须作用于真实文件（G2 前置 / Act / D1）
 *
 * 现场（2026-11-14，code-search-glob 首次真实派单）：判据文件 470 行 / 20693 字节，
 * 默认 maxBytes=16384 先把字节流截成 368 行，**然后**才在这 368 行上切行窗口。后果三连：
 *   - `lineStart:443`            → ok:false「lineStart/lineEnd 必须为正整数且 start ≤ end」
 *                                  （整数没问题，问题是 443 > 被截出来的 368）
 *   - `lineStart:443,lineEnd:470` → ok:true 但 returned:0，**静默返回空内容还报成功**
 *   - `lines.total`              → 谎报 368，模型无从知道真实文件有 470 行
 * 而工具自己的截断提示把「继续读取请用 lineStart/lineEnd 分段」摆在第一位（maxBytes 只在句末附带一提）
 * ——照做必然撞墙。Agent 照着提示重试 8 次以上，每次重灌 ~16KB，三轮 token 预算（256k）全烧在这里，
 * 一个工具文件都没写出来。这不是模型能力问题，是工具把模型引到了死路上。
 *
 * 本判据钉住的口径：
 *   1. 显式请求行窗口时，行号寻址的是**真实文件**；maxBytes 只裁返回内容，不裁行号空间。
 *   2. lines.total 永远是真实总行数，与 maxBytes 无关（事实字段不许说谎）。
 *   3. 越界行号要报 invalid_args，且消息里必须给出**真实**总行数，让人能自行纠正。
 *   4. 不许 ok:true + 0 行这种静默空读。
 *   5. 未请求行窗口时，既有字节上限行为保持不变（磁盘读放大 / 归档 / SSE 三条理由仍然成立）。
 *   6. 截断提示必须给出可行建议：字节上限是约束时，必须提到 maxBytes。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { fsReadTool } from '../../src/tools/builtin/fs-read.tool.js';

const TOTAL = 470;
const sandboxRoot = path.join(os.tmpdir(), `fsread-window-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
const REL = 'long.ts';
const MARKER_443 = 'MARKER-443 beyond the byte cap';
const MARKER_460 = 'KEYWORD-ONLY-AT-460';

const ctx = {
  sessionId: 's',
  toolCallId: 't',
  callId: 'c',
  iteration: 1,
  sandboxRoot,
  signal: new AbortController().signal,
  reportProgress: () => {},
};

const read = (args: Record<string, unknown>) => fsReadTool.handler({ path: REL, ...args }, ctx);
const linesOf = (r: { data?: Record<string, unknown> }) =>
  r.data?.lines as { returned: number; total: number | null };
const contentOf = (r: { data?: Record<string, unknown> }) => String(r.data?.content ?? '');

beforeAll(async () => {
  await fs.mkdir(sandboxRoot, { recursive: true });
  const body = Array.from({ length: TOTAL }, (_, i) => {
    const n = i + 1;
    if (n === 443) return MARKER_443;
    if (n === 460) return MARKER_460;
    return `L${n} ${'x'.repeat(40)}`;
  }).join('\n');
  await fs.writeFile(path.join(sandboxRoot, REL), body, 'utf8');
  // 前置事实：文件必须真的超过默认字节上限，否则这组用例测不到东西。
  const size = (await fs.stat(path.join(sandboxRoot, REL))).size;
  expect(size > 16384).toBe(true);
});

afterAll(async () => {
  await fs.rm(sandboxRoot, { recursive: true, force: true });
});

describe('行窗口寻址真实文件（核心）', () => {
  it('lineStart=443,lineEnd=445 在默认 maxBytes 下必须读到第 443 行', async () => {
    const r = await read({ lineStart: 443, lineEnd: 445 });
    expect(r.ok).toBe(true);
    expect(contentOf(r)).toContain(MARKER_443);
    expect(linesOf(r).returned).toBe(3);
  });

  it('只给 lineStart=443 必须读到文件末尾，而不是报「start ≤ end」', async () => {
    const r = await read({ lineStart: 443 });
    expect(r.ok).toBe(true);
    expect(linesOf(r).returned).toBe(TOTAL - 443 + 1);
    expect(contentOf(r)).toContain(MARKER_443);
    expect(contentOf(r)).toContain(MARKER_460);
  });

  it('lines.total 必须是真实 470 行，不是被字节截出来的行数', async () => {
    const r = await read({ lineStart: 1, lineEnd: 5 });
    expect(r.ok).toBe(true);
    expect(linesOf(r).total).toBe(TOTAL);
    expect(linesOf(r).returned).toBe(5);
  });

  it('同一文件在不同 maxBytes 下 total 必须一致（事实字段不随上限漂移）', async () => {
    const small = await read({ maxBytes: 16384 });
    const large = await read({ maxBytes: 10485760 });
    expect(small.ok).toBe(true);
    expect(large.ok).toBe(true);
    expect(linesOf(small).total).toBe(TOTAL);
    expect(linesOf(large).total).toBe(TOTAL);
    expect(linesOf(small).total).toBe(linesOf(large).total);
  });

  it('lineEnd 超过真实末尾时夹到末尾，不报错也不空读', async () => {
    const r = await read({ lineStart: 465, lineEnd: 9999 });
    expect(r.ok).toBe(true);
    expect(linesOf(r).returned).toBe(TOTAL - 465 + 1);
    expect(contentOf(r)).toContain(`L${TOTAL} `);
  });

  it('不得 ok:true 却返回 0 行（静默空读是最难发现的失效）', async () => {
    const r = await read({ lineStart: 443, lineEnd: 470 });
    expect(r.ok).toBe(true);
    expect(linesOf(r).returned > 0).toBe(true);
    expect(contentOf(r).length > 0).toBe(true);
    expect(linesOf(r).returned === 0).toBe(false);
  });
});

describe('越界与入参（反向为主）', () => {
  it('lineStart 超过真实总行数 → invalid_args，且消息里给出真实总行数', async () => {
    const r = await read({ lineStart: TOTAL + 1 });
    expect(r.ok).toBe(false);
    expect(r.error?.kind).toBe('invalid_args');
    expect(r.error?.message).toContain(String(TOTAL));
  });

  it('越界消息不得谎报被截断后的行数', async () => {
    const r = await read({ lineStart: TOTAL + 1 });
    expect(r.ok).toBe(false);
    const truncatedView = linesOf(await read({})).returned;
    expect(r.error?.message?.includes(String(truncatedView))).toBe(false);
  });

  it('lineStart > lineEnd 仍然报 invalid_args（既有校验不许放宽）', async () => {
    const r = await read({ lineStart: 20, lineEnd: 10 });
    expect(r.ok).toBe(false);
    expect(r.error?.kind).toBe('invalid_args');
  });

  it('lineStart=0 / 负数 / 非整数仍然报 invalid_args', async () => {
    for (const bad of [0, -1, 1.5]) {
      const r = await read({ lineStart: bad });
      expect(r.ok).toBe(false);
      expect(r.error?.kind).toBe('invalid_args');
    }
  });

  it('maxBytes 上下限校验未受影响', async () => {
    for (const bad of [0, 10485761]) {
      const r = await read({ maxBytes: bad });
      expect(r.ok).toBe(false);
      expect(r.error?.kind).toBe('invalid_args');
    }
  });
});

describe('keyword 也必须作用于真实文件', () => {
  it('只出现在第 460 行的关键字，默认 maxBytes 下必须命中', async () => {
    const r = await read({ keyword: MARKER_460 });
    expect(r.ok).toBe(true);
    expect(contentOf(r)).toContain(MARKER_460);
  });

  it('keyword 配行窗口时，窗口外的命中不得返回（反向）', async () => {
    const r = await read({ keyword: MARKER_460, lineStart: 1, lineEnd: 100 });
    expect(r.ok).toBe(true);
    expect(contentOf(r).includes(MARKER_460)).toBe(false);
  });

  it('keyword 无命中时不得把整份文件灌回来（反向）', async () => {
    const r = await read({ keyword: 'ZZZ-NOT-PRESENT' });
    expect(r.ok).toBe(true);
    expect(contentOf(r).includes('L1 ')).toBe(false);
  });
});

describe('截断提示必须给可行建议', () => {
  it('字节上限是约束时，提示必须提到 maxBytes', async () => {
    const r = await read({});
    expect(r.ok).toBe(true);
    expect(r.data?.truncated).toBe(true);
    expect(contentOf(r)).toContain('maxBytes');
  });

  it('提示同时保留行窗口这条路（修好之后它才真的可行）', async () => {
    const r = await read({});
    expect(contentOf(r)).toContain('lineStart');
  });

  it('显式窗口小于文件时 truncated 仍为 false（既有口径回归）', async () => {
    const r = await read({ lineStart: 1, lineEnd: 10 });
    expect(r.ok).toBe(true);
    expect(r.data?.truncated).toBe(false);
  });
});

describe('未请求行窗口时，既有字节上限行为保持不变（回归）', () => {
  it('默认读全文仍被字节上限截断，returned 小于 total', async () => {
    const r = await read({});
    expect(r.ok).toBe(true);
    expect(r.data?.truncated).toBe(true);
    expect(linesOf(r).returned < TOTAL).toBe(true);
  });

  it('调小 maxBytes 仍按比例少读（反向：不得因为修行窗口就变成无界读）', async () => {
    const r = await read({ maxBytes: 1000 });
    expect(r.ok).toBe(true);
    expect(linesOf(r).returned < 40).toBe(true);
    expect(r.data?.truncated).toBe(true);
  });

  it('显式请求整份文件时，返回内容仍受 maxBytes 裁', async () => {
    const r = await read({ lineStart: 1, lineEnd: TOTAL, maxBytes: 2000 });
    expect(r.ok).toBe(true);
    expect(Buffer.byteLength(contentOf(r), 'utf8') <= 2600).toBe(true);
    expect(r.data?.truncated).toBe(true);
  });

  it('沙箱越界仍被拒（安全口径不许因本次改动松动）', async () => {
    const r = await fsReadTool.handler({ path: '../outside.txt' }, ctx);
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe('TOOL_SECURITY_DENIED');
    expect(r.error?.kind).toBe('security');
  });
});