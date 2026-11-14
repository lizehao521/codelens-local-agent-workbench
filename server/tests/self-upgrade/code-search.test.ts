/**
 * 判据 · code.search 内容检索（G2-b / Act）
 *
 * 拆题由来见 G2-a（fs-glob.test.ts）：合并题在 token 预算耗尽处被掐断，
 * 归因 budget/split_task。本题只做「按内容找」，依赖 G2-a 已落地的
 * sandbox-walk.ts 与 glob.ts —— 遍历安全规则只许有一套，不许在本题里另写一份。
 *
 * 本判据钉住的是**契约**，不是实现：
 *   1. 工具必须真的进 BUILTIN_TOOLS（只建模块不接线 = 假绿）；
 *   2. 沙箱边界一律走 path-jail，越界返回结构化 security 错误，不抛原生异常；
 *   3. 遍历必须有界：跳过 node_modules/dist/coverage/.git、跳过二进制、跳过超大文件、
 *      深度上限、结果上限，并且**不跟随符号链接**；
 *   4. 无命中是 ok:true + 空数组，不是 error；
 *   5. 字面量模式不得把用户输入当正则解释（否则 `function (a|b)` 会静默变成正则）。
 *
 * C3：本文件在实现落地前必须整体红（模块不存在）。红基线由人实跑取得，不靠推断。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { BUILTIN_TOOLS } from '../../src/tools/builtin/index.js';
import { codeSearchTool } from '../../src/tools/builtin/code-search.tool.js';

const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const sandboxRoot = path.join(os.tmpdir(), `g2b-sandbox-${stamp}`);
const outsideRoot = path.join(os.tmpdir(), `g2b-outside-${stamp}`);

const ctx = {
  sessionId: 's',
  toolCallId: 't',
  callId: 'c',
  iteration: 1,
  sandboxRoot,
  signal: new AbortController().signal,
  reportProgress: () => {},
};

const write = async (rel: string, content: string | Buffer) => {
  const abs = path.join(sandboxRoot, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content);
};

/** 命中项的 file 字段一律是沙箱相对路径、正斜杠；这里统一口径便于断言。 */
const hitFiles = (r: { data?: Record<string, unknown> }) =>
  ((r.data?.hits ?? []) as Array<{ file: string }>).map((h) => h.file);
const hitLines = (r: { data?: Record<string, unknown> }) =>
  ((r.data?.hits ?? []) as Array<{ file: string; line: number }>).map((h) => `${h.file}:${h.line}`);

beforeAll(async () => {
  await fs.mkdir(sandboxRoot, { recursive: true });
  await fs.mkdir(outsideRoot, { recursive: true });

  await write('alpha.ts', 'export function alpha() {\n  return 1;\n}\n');
  await write('nested/beta.ts', '// alpha helper\nexport const beta = 2;\n');
  await write('nested/deep/gamma.ts', "const gamma = 'ALPHA';\n");
  await write('notes.md', 'alpha appears here\n');
  await write('rootonly.txt', 'nothing to see\n');
  await write('node_modules/pkg/index.ts', 'alpha inside node_modules\n');
  await write('dist/out.ts', 'alpha inside dist\n');
  await write('coverage/lcov.ts', 'alpha inside coverage\n');
  await write('.git/config', 'alpha inside git\n');
  await write('blob.bin', Buffer.concat([Buffer.from([0x00, 0x01]), Buffer.from('alpha binary\n')]));
  // 超过单文件 1 MiB 上限：内容里有 alpha，但必须被跳过（读放大防护）。
  await write('big/huge.ts', Buffer.concat([Buffer.alloc(1048577, 0x78), Buffer.from('\nalpha tail\n')]));
  await fs.mkdir(path.join(sandboxRoot, 'empty'), { recursive: true });

  // 沙箱外的诱饵：软链指过去，跟随了就等于越权读。
  await fs.writeFile(path.join(outsideRoot, 'secret.ts'), 'alpha secret outside\n');
  await fs.mkdir(path.join(outsideRoot, 'adir'), { recursive: true });
  await fs.writeFile(path.join(outsideRoot, 'adir', 'leak.ts'), 'alpha dir outside\n');
  await fs.symlink(path.join(outsideRoot, 'secret.ts'), path.join(sandboxRoot, 'link-out.ts'));
  await fs.symlink(path.join(outsideRoot, 'adir'), path.join(sandboxRoot, 'linkdir'), 'dir');
});

afterAll(async () => {
  await fs.rm(sandboxRoot, { recursive: true, force: true });
  await fs.rm(outsideRoot, { recursive: true, force: true });
});

describe('接线：只建模块不注册等于没做（反向断言）', () => {
  it('code.search 必须在 BUILTIN_TOOLS 里', () => {
    expect(BUILTIN_TOOLS.map((t) => t.name).includes('code.search')).toBe(true);
  });

  it('注册表不得有重名或重复线上名', () => {
    const names = BUILTIN_TOOLS.map((t) => t.name);
    const wires = BUILTIN_TOOLS.map((t) => t.wireName);
    expect(new Set(names).size).toBe(names.length);
    expect(new Set(wires).size).toBe(wires.length);
  });

  it('线上名必须是规范名把点换成下划线（LLM 只见线上名）', () => {
    for (const t of BUILTIN_TOOLS) {
      expect(t.wireName).toBe(t.name.replace(/\./g, '_'));
    }
    expect(codeSearchTool.wireName).toBe('code_search');
  });

  it('code.search 是低风险、免审批、内建、幂等', () => {
    expect(codeSearchTool.category).toBe('file');
    expect(codeSearchTool.risk).toBe('low');
    expect(codeSearchTool.approvalMode).toBe('none');
    expect(codeSearchTool.source).toBe('builtin');
    expect(codeSearchTool.idempotent).toBe(true);
    expect(codeSearchTool.enabled({ sandboxRoot, mcpConnected: false })).toBe(true);
  });

  it('入参 schema 必须收口：pattern 必填、不许多余字段', () => {
    expect(codeSearchTool.inputSchema.type).toBe('object');
    expect(codeSearchTool.inputSchema.required).toEqual(['pattern']);
    expect(codeSearchTool.inputSchema.additionalProperties).toBe(false);
    expect(typeof codeSearchTool.inputSchema.properties?.pattern).toBe('object');
  });

  it('不得把既有工具挤掉：注册表至少 19 个且旧名全在（fs.glob 已由 G2-a 落地）', () => {
    expect(BUILTIN_TOOLS.length >= 19).toBe(true);
    for (const legacy of ['fs.read', 'fs.write', 'fs.list', 'fs.glob', 'code.check', 'test.run', 'type.check']) {
      expect(BUILTIN_TOOLS.some((t) => t.name === legacy)).toBe(true);
    }
  });
});

describe('code.search · 沙箱边界与入参（反向为主）', () => {
  it('path 含 .. → 结构化 security 拒绝，不抛异常', async () => {
    const r = await codeSearchTool.handler({ pattern: 'alpha', path: '../' }, ctx);
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe('TOOL_SECURITY_DENIED');
    expect(r.error?.kind).toBe('security');
    expect(r.error?.retryable).toBe(false);
  });

  it('path 是沙箱外绝对路径 → security 拒绝', async () => {
    const r = await codeSearchTool.handler({ pattern: 'alpha', path: outsideRoot }, ctx);
    expect(r.ok).toBe(false);
    expect(r.error?.kind).toBe('security');
  });

  it('缺 pattern → invalid_args', async () => {
    const r = await codeSearchTool.handler({ path: '.' }, ctx);
    expect(r.ok).toBe(false);
    expect(r.error?.kind).toBe('invalid_args');
  });

  it('pattern 为空串 → invalid_args（空模式会命中每一行）', async () => {
    const r = await codeSearchTool.handler({ pattern: '   ' }, ctx);
    expect(r.ok).toBe(false);
    expect(r.error?.kind).toBe('invalid_args');
  });

  it('maxResults 越界（0 / 501 / 非整数）→ invalid_args', async () => {
    for (const bad of [0, 501, 1.5]) {
      const r = await codeSearchTool.handler({ pattern: 'alpha', maxResults: bad }, ctx);
      expect(r.ok).toBe(false);
      expect(r.error?.kind).toBe('invalid_args');
    }
  });

  it('非法正则 → invalid_args，而不是把异常抛给执行器', async () => {
    const r = await codeSearchTool.handler({ pattern: '[', regex: true }, ctx);
    expect(r.ok).toBe(false);
    expect(r.error?.kind).toBe('invalid_args');
  });

  it('根目录不存在 → not_found', async () => {
    const r = await codeSearchTool.handler({ pattern: 'alpha', path: 'no-such-dir' }, ctx);
    expect(r.ok).toBe(false);
    expect(r.error?.kind).toBe('not_found');
  });

  it('根是文件不是目录 → invalid_args', async () => {
    const r = await codeSearchTool.handler({ pattern: 'alpha', path: 'alpha.ts' }, ctx);
    expect(r.ok).toBe(false);
    expect(r.error?.kind).toBe('invalid_args');
  });
});

describe('code.search · 真实检索行为', () => {
  it('默认大小写不敏感，命中四个文件，行号 1 起', async () => {
    const r = await codeSearchTool.handler({ pattern: 'alpha' }, ctx);
    expect(r.ok).toBe(true);
    expect(hitLines(r)).toEqual([
      'alpha.ts:1',
      'nested/beta.ts:1',
      'nested/deep/gamma.ts:1',
      'notes.md:1',
    ]);
    expect(r.data?.total).toBe(4);
    expect(r.data?.truncated).toBe(false);
  });

  it('命中项必须带整行原文，且路径是沙箱相对、正斜杠', async () => {
    const r = await codeSearchTool.handler({ pattern: 'alpha' }, ctx);
    const hits = (r.data?.hits ?? []) as Array<{ file: string; line: number; text: string }>;
    expect(hits[0].text).toBe('export function alpha() {');
    for (const h of hits) {
      expect(h.file.includes('\\')).toBe(false);
      expect(path.isAbsolute(h.file)).toBe(false);
      expect(typeof h.line).toBe('number');
    }
  });

  it('caseSensitive=true 时 ALPHA 不再命中 alpha', async () => {
    const r = await codeSearchTool.handler({ pattern: 'alpha', caseSensitive: true }, ctx);
    expect(r.ok).toBe(true);
    expect(hitFiles(r)).toEqual(['alpha.ts', 'nested/beta.ts', 'notes.md']);
  });

  it('caseSensitive=true + 大写模式只命中大写那处', async () => {
    const r = await codeSearchTool.handler({ pattern: 'ALPHA', caseSensitive: true }, ctx);
    expect(hitFiles(r)).toEqual(['nested/deep/gamma.ts']);
  });

  it('regex=true 走正则，字面量模式下同一串不得当正则解释', async () => {
    const re = await codeSearchTool.handler({ pattern: 'function (alpha|beta)', regex: true }, ctx);
    expect(re.ok).toBe(true);
    expect(hitFiles(re)).toEqual(['alpha.ts']);
    const lit = await codeSearchTool.handler({ pattern: 'function (alpha|beta)' }, ctx);
    expect(lit.ok).toBe(true);
    expect(hitFiles(lit)).toEqual([]);
  });

  it('glob 按文件名过滤，与 fs.read 的目录 glob 同口径', async () => {
    const r = await codeSearchTool.handler({ pattern: 'alpha', glob: '*.ts' }, ctx);
    expect(r.ok).toBe(true);
    expect(hitFiles(r)).toEqual(['alpha.ts', 'nested/beta.ts', 'nested/deep/gamma.ts']);
  });

  it('maxResults 截断时 total 仍是截断前的真值', async () => {
    const r = await codeSearchTool.handler({ pattern: 'alpha', maxResults: 2 }, ctx);
    expect(r.ok).toBe(true);
    expect(((r.data?.hits ?? []) as unknown[]).length).toBe(2);
    expect(r.data?.total).toBe(4);
    expect(r.data?.truncated).toBe(true);
  });

  it('无命中是 ok:true + 空数组，不是 error', async () => {
    const r = await codeSearchTool.handler({ pattern: 'zzz-not-present' }, ctx);
    expect(r.ok).toBe(true);
    expect(r.error).toBeUndefined();
    expect(hitFiles(r)).toEqual([]);
    expect(r.data?.total).toBe(0);
    expect(r.data?.truncated).toBe(false);
  });

  it('summary 必须报出命中数（模型只看 summary 决定下一步）', async () => {
    const r = await codeSearchTool.handler({ pattern: 'alpha' }, ctx);
    expect(r.summary).toContain('4');
  });

  it('指定子目录为根时，命中路径相对沙箱根而不是相对该子目录', async () => {
    const r = await codeSearchTool.handler({ pattern: 'alpha', path: 'nested' }, ctx);
    expect(r.ok).toBe(true);
    expect(hitFiles(r)).toEqual(['nested/beta.ts', 'nested/deep/gamma.ts']);
  });
});

describe('code.search · 遍历必须有界（反向为主）', () => {
  it('不得进 node_modules / dist / coverage / .git', async () => {
    const r = await codeSearchTool.handler({ pattern: 'alpha', maxResults: 500 }, ctx);
    const files = hitFiles(r);
    for (const bad of ['node_modules/', 'dist/', 'coverage/', '.git/']) {
      expect(files.some((f) => f.startsWith(bad))).toBe(false);
    }
  });

  it('不得读二进制文件（含 0x00 即跳过）', async () => {
    const r = await codeSearchTool.handler({ pattern: 'alpha', maxResults: 500 }, ctx);
    expect(hitFiles(r).includes('blob.bin')).toBe(false);
  });

  it('不得读超过 1 MiB 的单文件', async () => {
    const r = await codeSearchTool.handler({ pattern: 'alpha', maxResults: 500 }, ctx);
    expect(hitFiles(r).includes('big/huge.ts')).toBe(false);
  });

  it('不得跟随符号链接读出沙箱外的内容', async () => {
    const r = await codeSearchTool.handler({ pattern: 'alpha', maxResults: 500 }, ctx);
    const files = hitFiles(r);
    expect(files.includes('link-out.ts')).toBe(false);
    expect(files.some((f) => f.startsWith('linkdir/'))).toBe(false);
    expect(JSON.stringify(r.data)).not.toContain('outside');
  });

  it('扫描文件数必须上屏，且不超过夹具里的可读文本文件数', async () => {
    const r = await codeSearchTool.handler({ pattern: 'alpha' }, ctx);
    expect(typeof r.data?.filesScanned).toBe('number');
    expect((r.data?.filesScanned as number) >= 4).toBe(true);
    expect((r.data?.filesScanned as number) <= 8).toBe(true);
  });
});