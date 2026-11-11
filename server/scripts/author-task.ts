/**
 * author-task.ts — 把「提议」转成规格与判据草案。
 *
 * ── 为什么出题要单独一步、还要换个人 ──────────────────────────
 * 被衡量者写的判据必然自利。所以判据由**出题人角色**写：它只看得到提议本身
 * 与靶子的接口签名，看不到被衡量者将来怎么实现。
 *
 * 但完全交给模型也不够——模型可能写出一份「只检查文件存在」的弱判据，
 * 于是「升级成立」变成一句空话。所以判据由两部分拼成：
 *
 *   · **行为断言**：由出题人模型写，针对提议的 observable。
 *   · **通用安全断言**：由**固定模板**生成，不经过模型。
 *     （非法输入必须被拒、不得越界、不得执行外部命令、必须注册进产品）
 *     这几条对任何一道「加能力」的题都成立，与具体提议无关。
 *     模型可以偷懒，但偷不掉底线——模板那部分永远在。
 *
 * 产物落在 `.self-upgrade/loop/candidates/`，**不进仓库**。
 * 采纳时才由人（或 --adopt）写进 tests/ 与 self-upgrade/tasks.json，
 * 落进仓库后判据即受围栏指纹保护，Agent 改一个字符就作废。
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const SERVER = process.cwd();
const ROOT = path.join(SERVER, '..');
const PROPOSALS = path.join(ROOT, '.self-upgrade', 'proposals.jsonl');
const OUT_DIR = path.join(SERVER, 'candidates');

const arg = (name: string): string | undefined => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
};

interface Proposal {
  id: string;
  title: string;
  gap: string;
  evidence: string[];
  targetFile: string;
  observable: string;
  boundary: string;
}

/**
 * 通用安全断言模板。**不经模型**。
 *
 * 这一段是「出题人不给力」时的兜底：一份弱判据也能通过这些断言，
 * 所以一道题就算行为断言写得敷衍，至少还有「非法输入被拒 / 不越界 / 已注册」这些底线。
 */
function safetyAssertions(targetFile: string): string {
  const modulePath = `../${targetFile.replace(/\.ts$/, '.js')}`;
  const baseName = path.basename(targetFile, '.ts');
  return `
describe('通用安全断言（模板生成，不经模型）', () => {
  it('必须导出命名约定的对象', async () => {
    const mod = (await import('${modulePath}')) as Record<string, unknown>;
    const exported = Object.values(mod).find((v) => typeof v === 'object' && v !== null && 'name' in (v as object));
    expect(exported, '${targetFile} 必须导出一个工具定义').toBeTruthy();
    const def = exported as { name?: string; wireName?: string; inputSchema?: unknown };
    expect(typeof def.name).toBe('string');
    expect(typeof def.wireName).toBe('string');
  });

  it('必须注册进 BUILTIN_TOOLS（否则产品里调不到）', async () => {
    const mod = (await import('${modulePath}')) as Record<string, unknown>;
    const exported = Object.values(mod).find((v) => typeof v === 'object' && v !== null && 'name' in (v as object));
    const def = exported as { name?: string };
    const registry = (await import('../src/tools/builtin/index.js')) as { BUILTIN_TOOLS?: { name?: string }[] };
    const names = (registry.BUILTIN_TOOLS ?? []).map((t) => t.name);
    expect(names, '${baseName} 没有注册进 BUILTIN_TOOLS').toContain(def.name);
  });

  it('非法输入必须被拒绝，且不得越出沙箱', async () => {
    const mod = (await import('${modulePath}')) as Record<string, unknown>;
    const exported = Object.values(mod).find((v) => typeof v === 'object' && v !== null && 'name' in (v as object));
    const def = exported as { handler?: (a: Record<string, unknown>, c: unknown) => Promise<{ ok: boolean }> };
    expect(typeof def.handler).toBe('function');
    const ctx = {
      sessionId: 's', toolCallId: 't', callId: 'c', iteration: 1,
      sandboxRoot: process.cwd(), signal: new AbortController().signal, reportProgress: () => {},
    };
    for (const bad of ['../package.json', 'C:/Windows/win.ini', '/etc/passwd', '']) {
      const out = await def.handler!({ path: bad, file: bad }, ctx);
      expect(out.ok, '越界输入 \'' + bad + '\' 不该被接受').toBe(false);
    }
  });
});`;
}

/** 出题人提示词：只看提议 + 靶子的导出面，不给实现。 */
function authorPrompt(p: Proposal, exportsOfTarget: string): string {
  return `你是出题人。给下面这个能力缺口写一份 vitest 判据。

缺口：${p.gap}
标题：${p.title}
证据：${p.evidence.join('；')}
目标文件：${p.targetFile}
怎么看出修好了：${p.observable}
不能碰的：${p.boundary}

目标文件当前导出的东西（只有签名，没有实现）：
${exportsOfTarget || '（读不到，先按它会导出一个工具定义来写）'}

──── 写判据的硬要求 ────
1. 只输出一个完整的 vitest 测试文件内容，以 \`import { describe, expect, it } from 'vitest';\` 开头。
2. 判据只允许 import：vitest、目标模块、../src/tools/builtin/index.js、node: 内置模块。
   相对路径以 server/candidates/ 为基准，所以业务模块一律写成 '../src/...'，且用 .js 后缀。
   **不许 import 目标模块之外的业务模块**——不许读实现细节来凑断言。
3. 只写**可观察行为**：给定输入，期望什么输出。不要断言「函数被调用过」这类内部状态。
4. 至少 3 条 it，至少 1 条断言成功路径，至少 1 条断言错误路径（错误码或错误种类要具体）。
5. 不许出现 describe.skip / it.skip / it.todo / .only。
6. 不要写注释解释「为什么」，测试名要能说明断言的是什么。
7. 文件以 \`export {};\` 结尾会导致重复导出，不要写。

不要写实现代码，只写判据。`;
}

/** 判据文件的机械校验。 */
function judgeLint(source: string, targetFile: string): { ok: boolean; reason?: string } {
  if (!/import\s*\{\s*describe/.test(source)) return { ok: false, reason: '缺少 vitest 导入' };
  const its = source.match(/\bit\(/g)?.length ?? 0;
  if (its < 3) return { ok: false, reason: `只有 ${its} 条断言，至少要 3 条` };
  if (/\.skip\b|\.todo\b|\.only\b/.test(source)) return { ok: false, reason: '不许有 skip/todo/only' };
  // 允许 import 目标模块与 builtin 注册表，其余业务模块一律不许（不许读实现细节来凑断言）。
  const businessImports = [...source.matchAll(/from\s+['"]([^'"]+)['"]/g)]
    .map((m) => m[1] ?? '')
    .filter((p) => p.startsWith('../src/'))
    .filter((p) => !p.includes(targetFile.replace(/\.ts$/, '.js')) && !p.includes('tools/builtin/index'));
  if (businessImports.length > 0) {
    return { ok: false, reason: `不许 import 目标模块以外的业务模块：${businessImports.join(', ')}` };
  }
  if (!source.includes(targetFile.replace(/\.ts$/, '.js'))) {
    return { ok: false, reason: `判据没有引用目标模块 ${targetFile}` };
  }
  return { ok: true };
}

/**
 * 从目标文件里抠出导出面（只给签名，不给实现）。
 *
 * 只给「导出名」是不够的：出题人拿到 `export class AgentLoopService` 之后，
 * 只能自己编构造参数与方法名（上一版就编出了 `new AgentLoopService({llm, tools})`
 * 和 `service.run()` 两个都不存在的东西）。
 * 所以这里额外给**构造器参数**与**公开方法签名**——给得越准，它编的机会越小；
 * 而「判据必须能编译」是最后那道兜底。
 */
function exportsOf(targetFile: string): string {
  const abs = path.join(SERVER, targetFile);
  if (!existsSync(abs)) return '';
  const src = readFileSync(abs, 'utf8');
  const lines = src.split('\n');
  const names = [...src.matchAll(/export\s+(?:const|function|class|async function)\s+([A-Za-z0-9_]+)/g)].map((m) => m[1] ?? '');

  const classIdx = lines.findIndex((l) => /export\s+class\s+/.test(l));
  const ctor =
    classIdx >= 0
      ? lines.slice(classIdx, classIdx + 14).filter((l) => /constructor|private readonly|readonly /.test(l)).map((l) => l.trim())
      : [];

  const methods = lines
    .filter((l) => /^\s{2}(public\s+|async\s+|get\s+|set\s+)?[A-Za-z_]\w*\s*\(/.test(l))
    .filter((l) => !/^\s{2}(private|protected)\b/.test(l))
    .map((l) => l.trim())
    .slice(0, 18);

  const parts: string[] = [];
  if (names.length) parts.push(`导出名：${names.join(', ')}`);
  if (ctor.length) parts.push(`构造器与依赖注入：\n${ctor.join('\n')}`);
  if (methods.length) parts.push(`公开方法签名：\n${methods.join('\n')}`);
  return parts.join('\n');
}

/** 判据草案必须能编译。返回前 8 条错误原文。 */
function compileCheck(file: string): { ok: boolean; errors: string[] } {
  const r = spawnSync(
    'npx',
    [
      'tsc',
      '--noEmit',
      '--target',
      'ES2022',
      '--module',
      'nodenext',
      '--moduleResolution',
      'nodenext',
      '--strict',
      '--skipLibCheck',
      '--noUncheckedIndexedAccess',
      '--types',
      'node',
      // Windows 下 shell:true 不转义参数，路径里有空格（`新建文件夹 (2)`）会被拆断，
      // tsc 于是报 "File ... not found" —— 看起来像文件没了，其实是被命令行切碎了。
      process.platform === 'win32' ? `"${file}"` : file,
    ],
    { cwd: SERVER, encoding: 'utf8', shell: process.platform === 'win32', timeout: 180_000 },
  );
  if (r.status === 0) return { ok: true, errors: [] };
  const errors = `${r.stdout ?? ''}${r.stderr ?? ''}`
    .split('\n')
    .filter((l) => /error TS\d+/.test(l))
    .map((l) => l.trim())
    .slice(0, 8);
  return { ok: false, errors };
}

function readProposals(): Proposal[] {
  if (!existsSync(PROPOSALS)) return [];
  return readFileSync(PROPOSALS, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l) as Proposal;
      } catch {
        return null;
      }
    })
    .filter((p): p is Proposal => p !== null);
}

/** 调出题人模型写判据。 */
async function askAuthor(p: Proposal): Promise<string> {
  const envTxt = existsSync(path.join(SERVER, '.env')) ? readFileSync(path.join(SERVER, '.env'), 'utf8') : '';
  const get = (k: string): string => {
    const m = new RegExp(`^${k}=(.*)$`, 'm').exec(envTxt);
    return m ? m[1]!.trim() : '';
  };
  const base = (process.env.RSI_BASE_URL ?? get('TRIAL_BASE_URL')).replace(/\/$/, '');
  const key = process.env.RSI_API_KEY ?? get('LLM_SERVER_API_KEY');
  const model = process.env.RSI_AUTHOR_MODEL ?? 'gpt-4o';

  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model,
      max_tokens: 4096,
      temperature: 0.2,
      messages: [{ role: 'user', content: authorPrompt(p, exportsOf(p.targetFile)) }],
    }),
  });
  const j = (await res.json()) as { choices?: { message?: { content?: string } }[]; error?: { message?: string } };
  if (j.error) throw new Error(j.error.message ?? '出题人调用失败');
  return j.choices?.[0]?.message?.content ?? '';
}

/** 从模型输出里取出代码块或整段文本。 */
function extractCode(text: string): string {
  const fence = /```(?:ts|typescript)?\n([\s\S]*?)```/.exec(text);
  if (fence?.[1]) return fence[1];
  const start = text.indexOf('import');
  return start >= 0 ? text.slice(start) : text;
}

async function main(): Promise<void> {
  const only = arg('only');
  const proposals = readProposals().filter((p) => !only || p.id === only);
  if (proposals.length === 0) {
    console.log('没有待出题的提议。先跑 propose-gaps.ts。');
    return;
  }

  mkdirSync(OUT_DIR, { recursive: true });
  for (const p of proposals) {
    console.log(`\n════ 出题：${p.id}｜${p.title}`);
    let body: string;
    try {
      body = await askAuthor(p);
    } catch (e) {
      console.log(`  ✗ 出题人调用失败：${e instanceof Error ? e.message : e}`);
      continue;
    }
    const modelPart = extractCode(body);
    const lint = judgeLint(modelPart, p.targetFile);
    if (!lint.ok) {
      console.log(`  ✗ 判据草案没过机械校验：${lint.reason}`);
      console.log(`     草案存 ${path.join(OUT_DIR, `${p.id}.draft.ts`)}（未采纳）`);
      writeFileSync(path.join(OUT_DIR, `${p.id}.draft.ts`), modelPart, 'utf8');
      continue;
    }
    // **判据自己必须能编译**。这是对「出题人也在编 API」最直接的机械拦截：
    // 上一版出题人写的判据里出现了 builtinTools / service.run / maxToolCallRetries
    // 这三个根本不存在的名字，还有 `from 'src/...'` 这种错路径——
    // 编译期全是硬错，不需要人去判断它合不合理。
    const probe = path.join(OUT_DIR, `${p.id}.probe.ts`);
    writeFileSync(probe, `${modelPart.trim()}\n${safetyAssertions(p.targetFile)}\n`, 'utf8');
    const compile = compileCheck(probe);
    if (!compile.ok) {
      console.log(`  ✗ 判据草案编译不过（编造了 API）：`);
      for (const l of compile.errors.slice(0, 6)) console.log(`     ${l}`);
      console.log(`     草案存 ${path.join(OUT_DIR, `${p.id}.draft.ts`)}（未采纳）`);
      writeFileSync(path.join(OUT_DIR, `${p.id}.draft.ts`), modelPart, 'utf8');
      rmSync(probe, { force: true });
      continue;
    }
    rmSync(probe, { force: true });

    // 模板的安全断言拼在模型写的判据之后：模型偷懒也偷不掉底线。
    const final = `${modelPart.trim()}\n${safetyAssertions(p.targetFile)}\n`;
    const outFile = path.join(OUT_DIR, `${p.id}.test.ts`);
    writeFileSync(outFile, final, 'utf8');
    const spec = {
      id: p.id,
      title: p.title,
      allowed: [p.targetFile],
      judge: `tests/self-upgrade/${p.id}.test.ts`,
      maxAttempts: 3,
      status: 'candidate',
      boundary: p.boundary,
    };
    writeFileSync(path.join(OUT_DIR, `${p.id}.spec.json`), JSON.stringify(spec, null, 2) + '\n', 'utf8');
    console.log(`  ✔ 判据草案：${path.relative(ROOT, outFile)}`);
    console.log(`  ✔ 规格草案：${path.relative(ROOT, path.join(OUT_DIR, `${p.id}.spec.json`))}`);
    console.log(`    采纳方式：把判据拷进 server/${spec.judge}，把规格并入 server/self-upgrade/tasks.json`);
    console.log(`    落进仓库后判据即受围栏指纹保护——Agent 改一个字符，这道题就作废。`);
  }
}

main().catch((e: unknown) => {
  console.error(`FATAL: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
