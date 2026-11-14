/**
 * 判据 · fs.glob + 共用遍历件（G2-a / Act）
 *
 * 拆题由来：G2 原本一题六靶子（两个新工具 + 共用件 + 注册 + fs.read 抽取），
 * 派单第 3 轮在 iteration 14 / 20 次工具调用处 token 预算耗尽
 * （promptTokens 266827 / tokenBudget 256000），只落了 glob.ts 与 sandbox-walk.ts，
 * 归因给的是 budget/split_task。按尺子的结论拆成两题，本题只做「按路径模式找」
 * 与共用件抽取，code.search 留给 G2-b。
 *
 * 本判据钉住的是**契约**，不是实现：
 *   1. 工具必须真的进 BUILTIN_TOOLS（只建模块不接线 = 假绿，前端题踩过）；
 *   2. 沙箱边界一律走 path-jail，越界返回结构化 security 错误，不抛原生异常；
 *   3. 遍历必须有界：跳过 node_modules/dist/coverage/.git、深度上限、结果上限，
 *      并且**不跟随符号链接**（沙箱内的软链指向沙箱外 = 越权读）；
 *   4. 无命中是 ok:true + 空数组，不是 error（把「没找到」报成失败会让模型重试到超时）；
 *   5. glob matcher 必须与 fs.read 共用一份，不许各写一套 —— 两套安全相关的匹配器
 *      一定会漂移，而漂移的那一套没人守。
 *
 * C3：本文件在实现落地前必须整体红（模块不存在）。红基线由人实跑取得，不靠推断。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';
import { BUILTIN_TOOLS } from '../../src/tools/builtin/index.js';
import { fsGlobTool } from '../../src/tools/builtin/fs-glob.tool.js';
import { fsReadTool } from '../../src/tools/builtin/fs-read.tool.js';
import { globToRegExp } from '../../src/tools/builtin/glob.js';
import { SKIP_DIRS } from '../../src/tools/builtin/sandbox-walk.js';

const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const sandboxRoot = path.join(os.tmpdir(), `g2a-sandbox-${stamp}`);
const outsideRoot = path.join(os.tmpdir(), `g2a-outside-${stamp}`);

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

const matches = (r: { data?: Record<string, unknown> }) => (r.data?.matches ?? []) as string[];

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
  // fs.glob 只看路径不读内容，所以这个超大文件**必须**出现在匹配结果里；
  // 它同时是 G2-b 的「单文件 1 MiB 上限」诱饵，两题共用同一份夹具形状。
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
  it('fs.glob 必须在 BUILTIN_TOOLS 里', () => {
    expect(BUILTIN_TOOLS.map((t) => t.name).includes('fs.glob')).toBe(true);
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
    expect(fsGlobTool.wireName).toBe('fs_glob');
  });

  it('fs.glob 是低风险、免审批、内建、幂等', () => {
    expect(fsGlobTool.category).toBe('file');
    expect(fsGlobTool.risk).toBe('low');
    expect(fsGlobTool.approvalMode).toBe('none');
    expect(fsGlobTool.source).toBe('builtin');
    expect(fsGlobTool.idempotent).toBe(true);
    expect(fsGlobTool.enabled({ sandboxRoot, mcpConnected: false })).toBe(true);
  });

  it('入参 schema 必须收口：pattern 必填、不许多余字段', () => {
    expect(fsGlobTool.inputSchema.type).toBe('object');
    expect(fsGlobTool.inputSchema.required).toEqual(['pattern']);
    expect(fsGlobTool.inputSchema.additionalProperties).toBe(false);
    expect(typeof fsGlobTool.inputSchema.properties?.pattern).toBe('object');
  });

  it('不得把既有工具挤掉：注册表至少 18 个且旧名全在', () => {
    expect(BUILTIN_TOOLS.length >= 18).toBe(true);
    for (const legacy of ['fs.read', 'fs.write', 'fs.list', 'code.check', 'test.run', 'type.check']) {
      expect(BUILTIN_TOOLS.some((t) => t.name === legacy)).toBe(true);
    }
  });
});

describe('共用件：matcher 与遍历规则只许有一份', () => {
  it('glob.ts 导出 globToRegExp，且 * 不跨路径分隔符', () => {
    expect(globToRegExp('*.ts').test('a.ts')).toBe(true);
    expect(globToRegExp('*.ts').test('n/a.ts')).toBe(false);
    expect(globToRegExp('*.ts').test('a.tsx')).toBe(false);
  });

  it('** 跨任意深度，? 只吃一个字符', () => {
    expect(globToRegExp('**/*.ts').test('n/d/a.ts')).toBe(true);
    expect(globToRegExp('?.md').test('a.md')).toBe(true);
    expect(globToRegExp('?.md').test('ab.md')).toBe(false);
  });

  it('正则元字符必须被转义，不能把 . 当通配', () => {
    expect(globToRegExp('a.ts').test('aXts')).toBe(false);
    expect(globToRegExp('a+b.ts').test('a+b.ts')).toBe(true);
  });

  it('SKIP_DIRS 必须点名四个目录（少一个就是读放大）', () => {
    for (const d of ['node_modules', 'dist', 'coverage', '.git']) {
      expect(SKIP_DIRS.includes(d)).toBe(true);
    }
  });

  it('遍历件只许有一套实现：readdir 调用点恰好一个（两份 walk 必然漂移）', async () => {
    const src = await fs.readFile(
      fileURLToPath(new URL('../../src/tools/builtin/sandbox-walk.ts', import.meta.url)),
      'utf8',
    );
    expect([...src.matchAll(/\breaddir\(/g)].length).toBe(1);
  });

  it('fs.read 不得再自带一份 globToRegExp（两套匹配器必然漂移）', async () => {
    const src = await fs.readFile(
      fileURLToPath(new URL('../../src/tools/builtin/fs-read.tool.ts', import.meta.url)),
      'utf8',
    );
    expect(/function\s+globToRegExp/.test(src)).toBe(false);
    expect(src.includes('glob.js')).toBe(true);
  });
});

describe('fs.glob · 沙箱边界与入参（反向为主）', () => {
  it('path 含 .. → security 拒绝', async () => {
    const r = await fsGlobTool.handler({ pattern: '*.ts', path: '../' }, ctx);
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe('TOOL_SECURITY_DENIED');
    expect(r.error?.kind).toBe('security');
  });

  it('缺 pattern / 空 pattern → invalid_args', async () => {
    for (const args of [{ path: '.' }, { pattern: '' }]) {
      const r = await fsGlobTool.handler(args, ctx);
      expect(r.ok).toBe(false);
      expect(r.error?.kind).toBe('invalid_args');
    }
  });

  it('maxResults 越界（0 / 1001）→ invalid_args', async () => {
    for (const bad of [0, 1001]) {
      const r = await fsGlobTool.handler({ pattern: '*.ts', maxResults: bad }, ctx);
      expect(r.ok).toBe(false);
      expect(r.error?.kind).toBe('invalid_args');
    }
  });

  it('根不存在 → not_found；根是文件 → invalid_args', async () => {
    const missing = await fsGlobTool.handler({ pattern: '*.ts', path: 'no-such-dir' }, ctx);
    expect(missing.ok).toBe(false);
    expect(missing.error?.kind).toBe('not_found');
    const file = await fsGlobTool.handler({ pattern: '*.ts', path: 'alpha.ts' }, ctx);
    expect(file.ok).toBe(false);
    expect(file.error?.kind).toBe('invalid_args');
  });
});

describe('fs.glob · 匹配行为', () => {
  it('*.ts 只匹配根层，不跨分隔符', async () => {
    const r = await fsGlobTool.handler({ pattern: '*.ts' }, ctx);
    expect(r.ok).toBe(true);
    expect(matches(r)).toEqual(['alpha.ts']);
  });

  it('**/*.ts 匹配嵌套文件，结果按路径排序', async () => {
    const r = await fsGlobTool.handler({ pattern: '**/*.ts' }, ctx);
    expect(r.ok).toBe(true);
    expect(matches(r)).toEqual(['big/huge.ts', 'nested/beta.ts', 'nested/deep/gamma.ts']);
    expect(r.data?.total).toBe(3);
    expect(r.data?.truncated).toBe(false);
  });

  it('只返回文件，不返回目录', async () => {
    const r = await fsGlobTool.handler({ pattern: '*' }, ctx);
    expect(r.ok).toBe(true);
    expect(matches(r)).toEqual(['alpha.ts', 'blob.bin', 'notes.md', 'rootonly.txt']);
    for (const dir of ['nested', 'empty', 'big', 'node_modules', 'dist', 'coverage', '.git']) {
      expect(matches(r).includes(dir)).toBe(false);
    }
  });

  it('不跟随符号链接：link-out.ts 不得出现在结果里', async () => {
    const r = await fsGlobTool.handler({ pattern: '**/*' }, ctx);
    const m = matches(r);
    expect(m.includes('link-out.ts')).toBe(false);
    expect(m.some((x) => x.startsWith('linkdir/'))).toBe(false);
  });

  it('同样跳过 node_modules / dist / coverage / .git', async () => {
    const r = await fsGlobTool.handler({ pattern: '**/*', maxResults: 1000 }, ctx);
    for (const bad of ['node_modules/', 'dist/', 'coverage/', '.git/']) {
      expect(matches(r).some((f) => f.startsWith(bad))).toBe(false);
    }
  });

  it('maxResults 截断时 total 保留真值', async () => {
    const r = await fsGlobTool.handler({ pattern: '**/*.ts', maxResults: 1 }, ctx);
    expect(r.ok).toBe(true);
    expect(matches(r).length).toBe(1);
    expect(r.data?.total).toBe(3);
    expect(r.data?.truncated).toBe(true);
  });

  it('无命中是 ok:true + 空数组', async () => {
    const r = await fsGlobTool.handler({ pattern: 'zzz*' }, ctx);
    expect(r.ok).toBe(true);
    expect(r.error).toBeUndefined();
    expect(matches(r)).toEqual([]);
    expect(r.data?.total).toBe(0);
  });

  it('字面量模式也能用（精确找一个文件）', async () => {
    const r = await fsGlobTool.handler({ pattern: 'notes.md' }, ctx);
    expect(matches(r)).toEqual(['notes.md']);
  });

  it('指定子目录为根时，返回路径仍相对沙箱根', async () => {
    const r = await fsGlobTool.handler({ pattern: '*.ts', path: 'nested' }, ctx);
    expect(r.ok).toBe(true);
    expect(matches(r)).toEqual(['nested/beta.ts']);
  });
});

describe('回归：fs.read 的目录 glob 行为不得因抽取而改变', () => {
  it('fs.read 传目录 + glob 仍按文件名过滤', async () => {
    const r = await fsReadTool.handler({ path: '.', glob: '*.ts' }, ctx);
    expect(r.ok).toBe(true);
    expect(r.data?.kind).toBe('directory');
    const entries = (r.data?.entries ?? []) as string[];
    expect(entries.includes('alpha.ts')).toBe(true);
    expect(entries.includes('notes.md')).toBe(false);
  });

  it('fs.read 不传 glob 时仍返回全部条目', async () => {
    const r = await fsReadTool.handler({ path: '.' }, ctx);
    expect(r.ok).toBe(true);
    const entries = (r.data?.entries ?? []) as string[];
    expect(entries.includes('alpha.ts')).toBe(true);
    expect(entries.includes('notes.md')).toBe(true);
  });

  it('fs.read 读单文件的行窗口与关键字过滤未受影响', async () => {
    const r = await fsReadTool.handler({ path: 'alpha.ts', lineStart: 2, lineEnd: 2 }, ctx);
    expect(r.ok).toBe(true);
    expect(r.data?.content).toBe('  return 1;');
    const kw = await fsReadTool.handler({ path: 'nested/beta.ts', keyword: 'beta' }, ctx);
    expect(kw.ok).toBe(true);
    expect(String(kw.data?.content)).toContain('export const beta = 2;');
    expect(String(kw.data?.content).includes('alpha helper')).toBe(false);
  });
});