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
 * 产物落在 `server/candidates/`，**不进仓库**。
 * 文件名用 `.candidate.ts` 而不是 `.test.ts`：vitest 默认收集所有 .test.ts 文件，
 * 而候选判据针对的是**还没实现**的缺口 —— 它一进全量回归就必红，
 * 会把「没采纳的题」变成「踩坏了既有行为」。改名是最省事的一道隔离。
 * 采纳时才由人（或 --adopt）写进 tests/ 与 self-upgrade/tasks.json，
 * 落进仓库后判据即受围栏指纹保护，Agent 改一个字符就作废。
 */

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { checkDomain } from '../src/services/rsi/change-domain.js';
import { acquireRateLimit } from '../src/providers/rate-limit.js';
import { baselineMustBeRed, type CandidateSpec } from './auto-adopt.js';
import {
  TOOL_CONTRACT,
  appendRejection,
  authorFailures,
  isExhausted,
  recentRejections,
} from './lib/agent-feedback.js';
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
  /** defect=现有行为缺陷（red-baseline）；capability=需新增能力（implement-first）。 */
  gapType?: 'defect' | 'capability';
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
    const registry = (await import('../src/tools/builtin/index.js')) as unknown as { BUILTIN_TOOLS?: { name?: string }[] };
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
      expect(out.ok, "越界输入 " + bad + " 不该被接受").toBe(false);
    }
  });
});`;
}

/** 出题人提示词：只看提议 + 靶子的导出面，不给实现。 */
export function authorPrompt(p: Proposal, exportsOfTarget: string, feedback?: string): string {
  // 按缺口类型切换出题口径：defect 严禁造新 API；capability 显式走 implement-first。
  const typeRule =
    p.gapType === 'capability'
      ? `缺口类型：capability（需要新增 API / 字段 / 导出才能满足）。
  → 本判据测试「新增之后应有的行为」。系统会**先由 agent 实现该能力**，再验证这份判据变绿，
    通过后才作为回归尺子固定下来。所以你可以放心测一个现在还不存在的能力。
  → 在 spec 里把 mode 写成 implement-first。`
      : `缺口类型：defect（现有能力在部分输入下行为错误 / 不安全 / 不符合预期）。
  → **判据只能使用靶子当前已实现的公开 API** 来复现并验证这个错误行为。
  → **严禁**要求新增字段、新增参数、新增导出、新增工具方法——如果你的判据需要某个
    现在还不存在的字段（例如你想加一个 nextAction），那是 capability 不是 defect，
    请改测一个真实现有的 bug（比如某个错误处理在某种输入下给了错误的 kind）。
  → 在 spec 里把 mode 写成 red-baseline（现状下判据必须红，采纳后才是回归尺）。
  → **自证要求**：交稿后系统会立刻拿这份判据在**当前代码**上跑一次。如果它**通过（绿）**，
    说明你测的是“现状就对”的行为，不是缺陷 —— 会被直接作废。所以你的断言必须是
    “修复后应有的行为，而当前实现没有做到”，在当前代码上**必然失败（红）**。
  → 只测当前已实现、能通过现有公开 API 复现的错误行为；不要断言一个现状就已经成立的期望。
  → 断言只能落在上面契约里**已列出的字段**：ok / summary / data 上现存的键 / error.code / error.kind /
    error.message / error.suggestion。写 error.matches 这类不存在的键会直接编译失败（TS2339）作废。`;
  return `你是出题人。给下面这个能力缺口写一份 vitest 判据。

缺口：${p.gap}
标题：${p.title}
证据：${p.evidence.join('；')}
目标文件：${p.targetFile}
怎么看出修好了：${p.observable}
不能碰的：${p.boundary}

目标文件当前导出的东西（只有签名，没有实现）：
${exportsOfTarget || '（读不到，先按它会导出一个工具定义来写）'}

──── 返回值契约（硬事实，不得发明字段）────
${TOOL_CONTRACT}

──── 合法入参（真实 inputSchema，判据与探针都必须照这个调用）────
${schemaOf(p.targetFile) || '（这个文件没有 inputSchema：按上面的导出签名调用）'}
→ 调用参数**只能**用上面 properties 里列出的键，且 required 里的必须给。
→ 不许自造 \`operations: [...]\` 这类数组包装（实测编过一次，探针直接被 invalid_args 拦住作废）。

──── 你最近被拒的记录（硬事实，同一错法再犯就是浪费一轮）────
${recentRejections(5)}

──── 出题口径（按缺口类型）────
${typeRule}

──── 写判据的硬要求 ────
1. 输出**两个**代码块，不要任何其它文字。
   第一个：完整的 vitest 判据文件，以 \`import { describe, expect, it } from 'vitest';\` 开头。
   第二个：探针文件（形状见最后一段），用来证明你确实知道怎么合法调用这个工具。
2. 判据只允许 import：vitest、目标模块、../src/tools/builtin/index.js、node: 内置模块。
   相对路径以 server/candidates/ 为基准，所以业务模块一律写成 '../src/...'，且用 .js 后缀。
   **不许 import 目标模块之外的业务模块**——不许读实现细节来凑断言。
3. 只写**可观察行为**：给定输入，期望什么输出。不要断言「函数被调用过」这类内部状态。
3a. 工具模块导出的是一个 ToolDefinition 对象，不是函数。调用方式：
    tool.handler!(args, ctx) —— handler 是可选字段，必须写非空断言（叹号），
    否则 tsc 报 "This expression is not callable"（上一版就卡在这里）。
3b. ctx 自己造一个最小对象，字段固定：
    { sessionId, toolCallId, callId, iteration, sandboxRoot: process.cwd(),
      signal: new AbortController().signal, reportProgress: () => {} }
3c. 工具返回值是 { ok, summary?, data?, error? }，error.kind 是那 10 个值之一。
4. 至少 3 条 it，至少 1 条断言成功路径，至少 1 条断言错误路径（错误码或错误种类要具体）。
5. 不许出现 describe.skip / it.skip / it.todo / .only。
6. 不要写注释解释「为什么」，测试名要能说明断言的是什么。
7. 文件以 \`export {};\` 结尾会导致重复导出，不要写。

}${feedback ? `\n──── 上一版编译报错，逐条修掉再交 ────\n${feedback}\n` : ''}

──── 第二个代码块：合法调用探针（必须写）────
吃过一次大亏：出题人把整条命令行塞进 command，工具前置策略直接拒成 invalid_args，
判据四条全红，看起来像「缺口没实现」，其实是**判据自己没走到被测行为**。
所以你要额外写一段探针，用一组合法参数真正调一次 handler，把结果报出来。形状固定：

import { 工具名 } from '../src/tools/builtin/xxx.tool.js';
export async function runProbe(): Promise<void> {
  const ctx = { sessionId: 's', toolCallId: 't', callId: 'c', iteration: 1,
    sandboxRoot: process.cwd(), signal: new AbortController().signal, reportProgress: () => {} };
  // 这里填一组合法参数：必须能过工具的前置校验，且不做破坏性操作、不写文件
  const r = await 工具名.handler!({ /* 合法参数 */ }, ctx);
  const kind = r.error?.kind ?? 'ok';
  const premature = ['invalid_args', 'security', 'not_found', 'internal'].includes(kind);
  console.log('PROBE_RESULT=' + JSON.stringify({
    reachedBehavior: !premature, kind, ok: r.ok,
    message: String(r.error?.message ?? '').slice(0, 160),   // 必须带上，采纳器靠它给出可照改的反馈
  }));
  if (premature) process.exit(2);
}
runProbe();   // 必须自己调一次，否则探针只导出不执行，采纳器收不到 PROBE_RESULT

要求：
- 必须真的调用 handler，并从 r.error.kind 计算 premature，不许写死 true。
- 参数要跟判据成功路径用的是同一套口径；判据里怎么调，探针就怎么调。
- **路径一律用沙箱相对路径**：\`path.relative(process.cwd(), 目标)\`。
  实测踩过：探针传了 \`path.join(process.cwd(), 'tmp.txt')\` 这种绝对路径，
  fs.* 的前置校验按「越界」拒成 kind=security —— 参数其实完全正确，只错在"绝对"。
  只有确实需要绝对路径的工具（很少）才传绝对路径。
- 探针只用最小、无副作用的调用，**必须能过工具的前置校验（否则会 premature 退出，判据被误判红）**：
  · 如果是写类工具，最小合法调用就是写一个极小的临时文件（如一个字节、随机名），这不算「破坏性」——不要为了「不写文件」去传空 operations / 空 args，那会被 invalid_args 拒掉。
  · 如果判据用的是 operations 数组，探针里的 operations 必须**非空且合法**（至少一条 create），禁止传空数组。
  · 不要跑长命令、不要写重要文件、不要越出沙箱。
- 探针文件不 import vitest，不写 describe/it。

不要写实现代码。两个代码块都要给，缺一个整份作废。`;
}

/** 判据文件的机械校验。 */
export function judgeLint(source: string, targetFile: string): { ok: boolean; reason?: string } {
  if (!/import\s*\{\s*describe/.test(source)) return { ok: false, reason: '缺少 vitest 导入' };
  const its = source.match(/\bit\(/g)?.length ?? 0;
  if (its < 3) return { ok: false, reason: `只有 ${its} 条断言，至少要 3 条` };
  if (/\.skip\b|\.todo\b|\.only\b/.test(source)) return { ok: false, reason: '不许有 skip/todo/only' };
  // 允许 import 目标模块与 builtin 注册表，其余业务模块一律不许（不许读实现细节来凑断言）。
  //
  // 注意路径前缀：判据草稿在 candidates/（用 '../src/...'），但最终落进
  // tests/self-upgrade/（变成 '../../src/...'）。原先只认 '../src/'，
  // 于是对真实形态的判据这道闸形同虚设 —— 写单测时才发现。
  const businessImports = [...source.matchAll(/from\s+['"]([^'"]+)['"]/g)]
    .map((m) => m[1] ?? '')
    .filter((p) => p.startsWith('.') && /(?:^|\/)src\//.test(p))
    .filter((p) => !p.includes(targetFile.replace(/\.ts$/, '.js')) && !p.includes('tools/builtin/index'));
  if (businessImports.length > 0) {
    return { ok: false, reason: `不许 import 目标模块以外的业务模块：${businessImports.join(', ')}` };
  }
  if (!source.includes(targetFile.replace(/\.ts$/, '.js'))) {
    return { ok: false, reason: `判据没有引用目标模块 ${targetFile}` };
  }

  // 机械闸：error.kind 的断言值必须落在锁定枚举内。
  //
  // 为什么必须在这一层拦：ToolErrorKind 是 10 值锁定枚举（src/types/error-kind.ts）。
  // 判据若断言 precondition_failed 这种"更贴切"的名字，基线那侧当然红（现状返回 invalid_args），
  // 自证红闸会判"真红"放行；接着 Agent 为了满足判据，把实现改成返回非法 kind → tsc TS2322，
  // 整次升级作废，还白烧三轮派单。实测就踩在这上面。
  // 机械闸在这里拦，比在采纳端拦便宜得多：出题当场重写，不用等派单。
  const kinds = ['invalid_args', 'not_found', 'security', 'timeout', 'rate_limit', 'network', 'upstream', 'mcp', 'circuit_open', 'internal'];
  const kindAssertions = [
    ...source.matchAll(/error\??\.kind\s*\)?\s*(?:\.toBe|\.toEqual|\.toStrictEqual|===|!==)\s*\(?\s*['"]([a-z_]+)['"]/g),
    ...source.matchAll(/kind\s*\)\s*\.toBe\(\s*['"]([a-z_]+)['"]/g),
  ].map((m) => m[1] ?? '');
  const illegalKinds = [...new Set(kindAssertions.filter((k) => k && !kinds.includes(k)))];
  if (illegalKinds.length > 0) {
    return {
      ok: false,
      reason: `判据断言了不存在的 error.kind：${illegalKinds.join(', ')}（合法值只有 ${kinds.join('/')}）`,
    };
  }

  // 机械闸：不许断言 summary 的文案。summary 是给人看的描述，中英文随实现变化，
  // 钉死它会把合法实现判成错，并把实现带偏（实测：判据要 'deleted'，中文摘要被改成英文）。
  const summaryAssertions = [
    ...source.matchAll(/\.summary\s*\)?\s*(?:\.toBe|\.toEqual|\.toContain|\.toMatch)\s*\(/g),
    ...source.matchAll(/summary\s*\)\s*\.(?:toBe|toEqual|toContain|toMatch)\(/g),
  ];
  if (summaryAssertions.length > 0) {
    return { ok: false, reason: '判据断言了 summary 文案 —— summary 是描述性文本，请断言行为（ok / 文件是否存在 / data 键）' };
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
export function exportsOf(targetFile: string): string {
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

/**
 * 抽取目标文件里真实的 inputSchema 块。
 *
 * 为什么必须给：出题人写探针时看不到 schema，就会自造调用形状——实测编出
 * `{ operations: [{ op: 'create', ... }] }`，而真实 API 是 `{ path, operation, content }`。
 * 探针一旦 invalid_args，A2.5 就判「没找到合法调用方式」，整份候选作废。
 * 把真实 schema 摆出来，它才能写出合法调用。
 */
export function schemaOf(targetFile: string): string {
  const abs = path.join(SERVER, targetFile);
  if (!existsSync(abs)) return '';
  const src = readFileSync(abs, 'utf8');
  const at = src.indexOf('inputSchema');
  if (at < 0) return '';
  const open = src.indexOf('{', at);
  if (open < 0) return '';
  let depth = 0;
  let end = -1;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end < 0) return '';
  const block = src.slice(open, end + 1);
  // 去掉描述性长串，只留字段与必填项——描述会把提示词撑爆。
  const slim = block
    .split('\n')
    .map((l) => l.replace(/description:\s*'(?:[^'\\]|\\.)*'/g, "description: '…'").replace(/description:\s*"(?:[^"\\]|\\.)*"/g, 'description: "…"'))
    .join('\n');
  return slim.length > 1800 ? slim.slice(0, 1800) + '\n…（截断）' : slim;
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

/**
 * 出题人模型解析（纯函数，可单测）。回退链：
 *   环境变量 RSI_AUTHOR_MODEL → .env 的 RSI_AUTHOR_MODEL → .env 的 TRIAL_MODEL → gpt-4o。
 * 关键：.env 不会被自动注入 process.env，所以必须也走 get() 读文件，
 * 否则回退到 gpt-4o（NVIDIA 上没有 → 404 page not found，整条作者链路静默失败）。
 * 这一条在 2026-11-12 实打实地坑过一次：作者步骤一直报「出题人调用失败」，
 * 根因是模型悄悄回退成 NVIDIA 不存在的 gpt-4o。
 */
export function resolveAuthorModel(envTxt: string, env: NodeJS.ProcessEnv = process.env): string {
  const get = (k: string): string => {
    const m = new RegExp(`^${k}=(.*)$`, 'm').exec(envTxt);
    return m ? m[1]!.trim() : '';
  };
  // 用 || 而非 ??：get() 对缺失键返回 ''，'' ?? x 不会触发回退，会卡在 ''。
  // 这一条被单测抓出过 —— 若 .env 没写 RSI_AUTHOR_MODEL，链本应落到 TRIAL_MODEL，
  // 却会停在 ''，导致 askAuthor 拿空模型名去打 NVIDIA → 404。
  const fromEnv = (env.RSI_AUTHOR_MODEL ?? '').trim();
  const fromFile = (get('RSI_AUTHOR_MODEL') || get('TRIAL_MODEL')).trim();
  return fromEnv || fromFile || 'gpt-4o';
}

/** 调出题人模型写判据。 */
export async function askAuthor(p: Proposal, feedback?: string): Promise<string> {
  const envTxt = existsSync(path.join(SERVER, '.env')) ? readFileSync(path.join(SERVER, '.env'), 'utf8') : '';
  const get = (k: string): string => {
    const m = new RegExp(`^${k}=(.*)$`, 'm').exec(envTxt);
    return m ? m[1]!.trim() : '';
  };
  const base = (process.env.RSI_BASE_URL || get('RSI_BASE_URL') || get('TRIAL_BASE_URL')).replace(/\/$/, '');
  const key = process.env.RSI_API_KEY || get('RSI_API_KEY') || get('LLM_SERVER_API_KEY');
  // 模型回退链见 resolveAuthorModel()。
  const model = resolveAuthorModel(envTxt);

  // 统一出网限速（与 agent-loop 共用同一 host 的 40/min 计数），避免触发上游 429。
  await acquireRateLimit(base);
  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model,
      // 4096 不够：这是推理模型，思考全在 reasoning_content 里。提示词变肥之后
      // （契约 + 错题 + 正例 + 真实 schema + 导出签名），推理常常吃掉 4k 以上，
      // 于是 content 返回 null、只有 reasoning_content —— 表现为「出题人返回空内容」，
      // 连试三次都一样，看起来像上游坏了，其实是预算被思考吃光。
      max_tokens: 8192,
      temperature: 0.2,
      messages: [{ role: 'user', content: authorPrompt(p, exportsOf(p.targetFile), feedback) }],
    }),
  });
  // 先读全文再解析：NVIDIA 偶尔回 SSE 流或拼接 JSON，res.json() 会整段失败。
  // 健壮起见两种形态都吃得下（流式增量 content + 标准 message）。
  const raw = await res.text();
  let content = '';
  let errMsg = '';
  let finish = '';
  try {
    const j = JSON.parse(raw) as {
      choices?: { message?: { content?: string; reasoning_content?: string }; finish_reason?: string }[];
      error?: { message?: string };
    };
    if (j.error) errMsg = j.error.message ?? '';
    content = j.choices?.[0]?.message?.content ?? '';
    finish = j.choices?.[0]?.finish_reason ?? '';
  } catch {
    // SSE 形态：逐行抽 data:，拼接 delta.content
    let buf = '';
    for (const line of raw.split('\n')) {
      const s = line.trim();
      if (!s.startsWith('data:')) continue;
      const payload = s.slice(5).trim();
      if (payload === '[DONE]' || !payload) continue;
      try {
        const j = JSON.parse(payload) as { error?: { message?: string }; choices?: { delta?: { content?: string }; message?: { content?: string } }[] };
        if (j.error) errMsg = j.error.message ?? errMsg;
        const d = j.choices?.[0]?.delta?.content;
        if (typeof d === 'string') buf += d;
        const m = j.choices?.[0]?.message?.content;
        if (typeof m === 'string' && !buf) buf = m;
      } catch { /* 跳过坏行 */ }
    }
    content = buf;
  }
  if (errMsg) throw new Error(errMsg);
  // 排障开关：空响应时把上游原始返回打出来。上游可能回 200 但 choices 为空、
  // 或回了非预期结构（安全过滤 / 截断 / 空 delta），不看到原文只能瞎猜。
  if (!content && process.env.RSI_DEBUG_RAW) {
    console.log(`[author] HTTP ${res.status} finish=${finish || '?'} raw(${raw.length}B): ${raw.slice(0, 1200)}`);
  }
  // 区分两种「空」：被 token 预算截断（可救：加预算/精简提示词）vs 上游真的没给内容。
  // 不区分的话，三次重试都是同一个必然失败，最后只剩一句"上游空响应"，看不出该改什么。
  if (!content && finish === 'length') {
    throw new Error('出题人被 token 预算截断（finish_reason=length）—— 推理占满 max_tokens，未留下正文');
  }
  if (!content) throw new Error('出题人返回空内容（既非标准 JSON 也非 SSE 流）');
  return content;
}

/** 取出全部代码块。出题人现在要交两份：判据 + 探针。 */
function extractBlocks(text: string): string[] {
  return [...text.matchAll(/```(?:ts|typescript)?\n([\s\S]*?)```/g)].map((m) => m[1] ?? '').filter((b) => b.trim().length > 0);
}

/** 从模型输出里取出代码块或整段文本。 */
function extractCode(text: string): string {
  const fence = /```(?:ts|typescript)?\n([\s\S]*?)```/.exec(text);
  if (fence?.[1]) return fence[1];
  const start = text.indexOf('import');
  return start >= 0 ? text.slice(start) : text;
}

/**
 * 出题前置机械筛（纯函数，便于自证）。
 *
 * 实测吃过亏：提议池 append-only，六条提议里有一条已完成、两条靶子落在
 * 需人批的域、一条靶子根本不存在。出题器不加筛就逐条调模型，
 * 每条几十秒，白烧一轮；产出的候选最后还会被 A4 域闸拒掉。
 * 这些判断全都不需要模型 —— 必须在 askAuthor 之前做完。
 */
export interface AuthorPrecheckInput {
  id: string;
  targetFile: string;
  doneIds: readonly string[];
  archived: boolean;
  targetExists: boolean;
}
/** 收集磁盘事实（主流程用），返回纯函数要吃的输入。 */
function collectPrecheck(p: { id: string; targetFile: string }): AuthorPrecheckInput {
  let doneIds: string[] = [];
  try {
    const j = JSON.parse(readFileSync(path.join(SERVER, 'self-upgrade', 'tasks.json'), 'utf8')) as {
      tasks?: Array<{ id?: string; status?: string }>;
    };
    doneIds = (j.tasks ?? []).filter((t) => t.status === 'done').map((t) => t.id ?? '');
  } catch {
    /* 读不到就不挡，交给后面的闸 */
  }
  return {
    id: p.id,
    targetFile: p.targetFile,
    doneIds,
    archived: existsSync(path.join(OUT_DIR, 'archive', `${p.id}.spec.json`)),
    targetExists: existsSync(path.join(SERVER, p.targetFile)),
  };
}

export function authorPrecheck(input: AuthorPrecheckInput): { ok: boolean; reason: string } {
  if (input.doneIds.includes(input.id)) {
    return { ok: false, reason: '已完成（tasks.json status=done），不重复出题' };
  }
  if (input.archived) {
    return { ok: false, reason: '候选已归档，不重复出题' };
  }
  if (!input.targetExists) {
    return { ok: false, reason: `靶子不存在：${input.targetFile}` };
  }
  const domain = checkDomain({ files: [input.targetFile], trigger: 'schedule', humanApproved: false });
  if (!domain.ok) {
    return { ok: false, reason: `域不允许自动出题（${domain.domain}）：${domain.reasons.join('；')}` };
  }
  return { ok: true, reason: `可自动出题（${domain.domain}）` };
}

/**
 * 落盘前自证「基线红」（仅 defect）：把候选当判据在**当前代码**上跑一次。
 *
 * 为什么必须加这一道：出题模型很容易把“缺陷题”写成“绿灯题”——断言的是
 * 现状就已经成立的行为（比如“工具造完后还能 use”，现状确实能，于是绿）。
 * 这种题进候选池后 A3 必然判“橡皮图章”拒掉，白烧一轮采纳。与其让采纳端拒，
 * 不如出题端先自证：绿了就地作废 / 回灌重写一次。
 *
 * capability 走 implement-first，基线本就跑不到新能力（premature 是预期），跳过此闸。
 */
async function finalizeCandidate(p: Proposal, modelPart: string, probePartIn: string): Promise<boolean> {
  let probePart = probePartIn;
  const outFile = path.join(OUT_DIR, `${p.id}.candidate.ts`);
  writeFileSync(outFile, `${modelPart.trim()}\n${safetyAssertions(p.targetFile)}\n`, 'utf8');

  if (p.gapType !== 'capability') {
    const spec: CandidateSpec = {
      id: p.id,
      title: p.title,
      allowed: [p.targetFile],
      judge: `tests/self-upgrade/${p.id}.test.ts`,
      package: 'server',
      mode: 'red-baseline',
    };
    let proof = baselineMustBeRed(spec, outFile);
    if (!proof.ok) {
      const why = proof.premature
        ? '假红（判据没走到被测行为：被前置校验 / 导入挡住）'
        : proof.snapshot
          ? '判据把现状写成了期望（其中一部分断言描述的是当前这个 bug）'
          : '绿灯（判据在现状上就通过，不是真缺陷）';
      console.log(`  ↻ 自证基线红未过：${why}。回灌要求重写「断言期望行为、当前代码违反」…`);
      if (proof.evidence) console.log(`     失败原文：${proof.evidence.slice(0, 200)}`);
      if (proof.reason) console.log(`     ${proof.reason.slice(0, 220)}`);
      try {
        const retry = await askAuthor(
          p,
          proof.snapshot
            ? `你上一版判据里有一批断言**描述的是现在这个 bug**（它们在当前代码上是绿的）：\n${proof.reason}\n` +
              '这是快照，不是验收标准：一旦把 bug 修好，这些断言必然变红，题目就永远无解。\n' +
              '删掉它们，只保留「修好之后应该怎样」的断言（例如「默认读满 256KB 且 truncated=false」）；' +
              '要保留回归保护，就断言修复不该破坏的**其它**行为（如非法路径仍被拒）。仍然给两个独立代码块（判据 + 探针）。'
            : `你上一版判据在【当前代码】上${
                proof.premature ? '根本没走到被测行为（被前置校验或导入问题挡住）' : '直接通过了（绿）'
              }。缺陷题必须【基线红】：断言“修复后应有的行为”，而当前实现没有做到，所以现在必须失败。` +
                (proof.evidence ? `\n这是当时的真实报错，照着它改：\n${proof.evidence}\n` : '') +
                '请只测当前已实现的公开 API 能复现的错误行为，不要断言“现状就对”的结果。仍然给两个独立代码块（判据 + 探针）。',
        );
        const rb = extractBlocks(retry);
        const rPart = rb[0] ?? extractCode(retry);
        if (rb[1]) probePart = rb[1];
        if (judgeLint(rPart, p.targetFile).ok) {
          writeFileSync(outFile, `${rPart.trim()}\n${safetyAssertions(p.targetFile)}\n`, 'utf8');
          proof = baselineMustBeRed(spec, outFile);
        }
      } catch {
        /* 回灌失败 → 落到下面的作废分支 */
      }
    }
    if (!proof.ok) {
      console.log(`  ✗ 自证基线红未过（${proof.reason}）—— 作废，存 draft 待人工`);
      writeFileSync(path.join(OUT_DIR, `${p.id}.draft.ts`), modelPart, 'utf8');
      rmSync(outFile, { force: true });
      // 记进错题本：区分「绿灯（写了现状就对的行为）」与「假红（没走到行为）」，
      // 下一轮原样回灌，它才知道自己上次错在哪一类，而不是泛泛地"再想想"。
      appendRejection({
        id: p.id,
        stage: 'author-baseline',
        code: proof.premature ? 'PREMATURE' : proof.snapshot ? 'SNAPSHOT_GREEN' : 'GREEN_BASELINE',
        detail: `${proof.reason}｜失败原文：${proof.evidence ?? '(无)'}`.slice(0, 300),
        fix: proof.premature
          ? '判据要么导入错、要么被前置校验挡住：改成用现有公开导出直接调用被测工具，别绕道'
          : proof.snapshot
            ? '删掉描述现状（当前 bug）的那几条断言——它们修好后必然红，整题无解；只留「修好后应该怎样」的断言，回归保护改断言其它不受影响的行为'
            : '你断言的是现状就成立的行为。改成断言「应有的行为而当前实现违反」，并先用真实实现确认它现在确实失败',
      });
      return false;
    }
    console.log(`  ✔ 自证基线红通过：${proof.reason}`);
  }

  if (!probePart.trim()) {
    console.log('  ✗ 探针为空 —— 作废');
    rmSync(outFile, { force: true });
    return false;
  }
  writeFileSync(path.join(OUT_DIR, `${p.id}.probe.ts`), probePart.trim() + '\n', 'utf8');
  writeFileSync(
    path.join(OUT_DIR, `${p.id}.spec.json`),
    JSON.stringify(
      {
        id: p.id,
        title: p.title,
        allowed: [p.targetFile],
        judge: `tests/self-upgrade/${p.id}.test.ts`,
        probe: `${p.id}.probe.ts`,
        mode: p.gapType === 'capability' ? 'implement-first' : 'red-baseline',
        maxAttempts: 3,
        status: 'candidate',
        boundary: p.boundary,
      },
      null,
      2,
    ) + '\n',
    'utf8',
  );
  console.log(`  ✔ 判据草案：${path.relative(ROOT, outFile)}`);
  console.log(`  ✔ 规格草案：${path.relative(ROOT, path.join(OUT_DIR, `${p.id}.spec.json`))}`);
  return true;
}

async function main(): Promise<void> {
  const only = arg('only');
  const proposals = readProposals().filter((p) => !only || p.id === only);
  if (proposals.length === 0) {
    console.log('没有待出题的提议。先跑 propose-gaps.ts。');
    return;
  }

  mkdirSync(OUT_DIR, { recursive: true });
  const forced = process.argv.includes('--force');
  for (const p of proposals) {
    // 兜底：单题异常不该杀整轮。出题人偶发空响应、上游抖动、解析失败都只影响这一题——
    // 实测一条提议在回灌时返回空，就把整轮 25 分钟连同后面排队的提议一起废掉。
    try {
    // 前置机械筛：不需要模型的判断一律先做完，别拿旧提议去烧 token。
    //
    // `--force` 只该放过「这题已经做过/已有候选」这类幂等拦截，
    // **不能放过域闸**。实测（2026-11-12 第四轮）：`--force` 重出题时把
    // D3 架构层提议也送进了模型，白烧一次调用 —— 而域闸存在的理由就是
    // 「自动管线无权改架构层」，它跟"想重试"无关。
    const pre = authorPrecheck(collectPrecheck(p));
    if (!pre.ok) {
      const idempotentOnly = /已完成|已归档/.test(pre.reason);
      if (!(forced && idempotentOnly)) {
        console.log(`\n════ 出题：${p.id}｜跳过：${pre.reason}`);
        continue;
      }
      console.log(`\n════ 出题：${p.id}｜--force 越过幂等拦截（${pre.reason}）`);
    }
    // 幂等：三件齐全才算「已有合格候选」。只判 candidate.ts 会把
    // 「判据写了、探针丢了」的半成品当成已完成，A2.5 又必然拒收。
    const triple = ['candidate.ts', 'probe.ts', 'spec.json'].every((suffix) =>
      existsSync(path.join(OUT_DIR, `${p.id}.${suffix}`)),
    );
    if (triple && !forced) {
      console.log(`\n════ 出题：${p.id}｜已有完整候选（判据/探针/规格），跳过（--force 可重出）`);
      continue;
    }
    // 死题淘汰：作废时会删掉候选、只留 draft，上面那条幂等检查就再也拦不住它，
    // 于是同一条题每轮重出、每轮作废（实测 orphan-tool-gate 连续两轮如此）。
    // 出题阶段已失败 2 次（编译不过 / 基线不红），说明模型对这个靶子没有可交付的写法，
    // 继续跑只是把同一笔 token 再烧一遍 —— 跳过，把预算留给新提议。
    if (!forced && isExhausted(p.id, 2)) {
      console.log(
        `\n════ 出题：${p.id}｜跳过：出题阶段已失败 ${authorFailures(p.id)} 次，判为死题（--force 可重试）`,
      );
      continue;
    }
    console.log(`\n════ 出题：${p.id}｜${p.title}`);
    let body = '';
    let lastErr = '';
    // 出题人模型偶发返回空响应（上游瞬时抖动），重试三次再放弃，避免一次抖动就废掉一条合规提议。
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        body = await askAuthor(p);
        lastErr = '';
        break;
      } catch (e) {
        lastErr = e instanceof Error ? e.message : String(e);
        console.log(`  ↻ 出题人调用失败（第 ${attempt}/3 次）：${lastErr}`);
      }
    }
    if (!body) {
      console.log(`  ✗ 出题人连续调用失败：${lastErr}`);
      continue;
    }
    const blocks = extractBlocks(body);
    let modelPart = blocks[0] ?? extractCode(body);
    let probePart = blocks[1] ?? '';
    if (!probePart.trim()) {
      // 出题人常把判据和探针塞进同一个代码块，或漏掉第二个块。回灌一次，
      // 明确要求「两个独立 ```typescript 块」，修不好再作废（防止采纳假红尺子）。
      console.log('  ↻ 没解析到独立探针块，回灌要求重出…');
      try {
        const retry = await askAuthor(
          p,
          '你上一版只给了一个代码块（或判据和探针在同一个块里）。必须输出【两个】完全独立的 Markdown 代码块，每个都以 ```typescript 开头、以 ``` 结尾：第一个是 vitest 判据，第二个是探针（含 runProbe）。不要把它们放进同一个代码块，也不要在判据块里写 runProbe。',
        );
        const retryBlocks = extractBlocks(retry);
        modelPart = retryBlocks[0] ?? extractCode(retry);
        probePart = retryBlocks[1] ?? '';
      } catch {
        /* 重试也失败就落到下面的作废分支 */
      }
      if (!probePart.trim()) {
        console.log('  ✗ 出题人只给了判据、没给合法调用探针 —— 整份作废（防止再采纳假红尺子）');
        writeFileSync(path.join(OUT_DIR, `${p.id}.draft.ts`), modelPart, 'utf8');
        continue;
      }
    }
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
    const compileTmp = path.join(OUT_DIR, `${p.id}.compile.tmp.ts`);
    writeFileSync(compileTmp, `${modelPart.trim()}\n${safetyAssertions(p.targetFile)}\n`, 'utf8');
    let compile = compileCheck(compileTmp);
    if (!compile.ok) {
      // 回灌一次：把编译器原文喂回去让它自己修。
      // 出题人编 API 是常态（实测编过 builtinTools / service.run / maxToolCallRetries），
      // 但编译器已经把话说得很准了——「这不是 callable」「找不到这个名字」——
      // 只给一次机会，修不好就存 draft 交人工，不再空转。
      console.log(`  ↻ 判据编译不过，回灌 ${compile.errors.length} 条错误重试一次…`);
      // 回灌本身也可能失败：上游偶发返回空（既不是 JSON 也不是 SSE）。
      // 不能让它冒到 main 的 FATAL 出口——那会把整轮 25 分钟废掉，
      // 后面排队的提议（包括新提出的高价值缺口）全没轮到。实测踩过。
      let retry = '';
      try {
        retry = await askAuthor(p, compile.errors.join('\n'));
      } catch (e) {
        console.log(`  ↻ 回灌调用失败：${e instanceof Error ? e.message : String(e)}（本题按作废处理）`);
      }
      const retryBlocks = extractBlocks(retry);
      const retryPart = retryBlocks[0] ?? extractCode(retry);
      if (retryBlocks[1]) probePart = retryBlocks[1];
      const retryLint = judgeLint(retryPart, p.targetFile);
      if (retryLint.ok) {
        writeFileSync(compileTmp, `${retryPart.trim()}\n${safetyAssertions(p.targetFile)}\n`, 'utf8');
        compile = compileCheck(compileTmp);
        if (compile.ok) {
          rmSync(compileTmp, { force: true });
          const ok = await finalizeCandidate(p, retryPart, probePart);
          if (ok) console.log('  ✔ 回灌后通过并自证基线红');
          continue;
        }
      }
      console.log(`  ✗ 判据草案编译不过（编造了 API）：`);
      for (const l of compile.errors.slice(0, 6)) console.log(`     ${l}`);
      console.log(`     草案存 ${path.join(OUT_DIR, `${p.id}.draft.ts`)}（未采纳）`);
      writeFileSync(path.join(OUT_DIR, `${p.id}.draft.ts`), modelPart, 'utf8');
      // 记进错题本：下一轮出题时原样回灌这几行 TS 错误，它才不会继续编 matches 之类的字段。
      appendRejection({
        id: p.id,
        stage: 'author-compile',
        code: (/(TS\d{4})/.exec(compile.errors.join(' '))?.[1] ?? 'COMPILE_FAIL'),
        detail: `判据引用了不存在的 API：${compile.errors.slice(0, 3).join(' ｜ ').slice(0, 260)}`,
        fix: '只用返回值契约里已列出的字段（ok/summary/data 现存键/error.code/kind/message/suggestion）；要新字段就改标 capability',
      });
      rmSync(compileTmp, { force: true });
      continue;
    }
    rmSync(compileTmp, { force: true });

    // 落盘 + 自证基线红（仅 defect）：绿 / 假红一律作废，回灌重写一次。
    // 模板的安全断言也一并拼进候选，模型偷懒也偷不掉底线。
    const ok = await finalizeCandidate(p, modelPart, probePart);
    if (ok) {
      console.log(`    采纳方式：把判据拷进 server/tests/self-upgrade/${p.id}.test.ts，把规格并入 server/self-upgrade/tasks.json`);
      console.log(`    落进仓库后判据即受围栏指纹保护——Agent 改一个字符，这道题就作废。`);
    }
    } catch (e) {
      // 单题兜底：只作废这一题，继续下一题。
      const msg = e instanceof Error ? e.message : String(e);
      console.log(`  ✗ ${p.id} 出题异常（不影响其它题）：${msg}`);
      appendRejection({
        id: p.id,
        stage: 'author-compile',
        code: 'AUTHOR_CRASH',
        detail: msg.slice(0, 260),
        fix: '这是上游/解析层异常，不是你写的内容有问题；下一轮会重新出题，注意输出完整的代码块',
      });
    }
  }
}

// 入口守卫：允许测试 import authorPrecheck() 做单元验证，不触发整轮出题（会真调模型）。
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e: unknown) => {
    console.error(`FATAL: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  });
}
