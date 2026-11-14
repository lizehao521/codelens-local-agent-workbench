/**
 * agent.verify 的判据：把「改完必须验」从提示词变成可复核的读数。
 *
 * 三层断言：
 * 1. 声明式计划只认 package.json 的 verify 数组，非法/未声明的脚本名进不来；
 * 2. 真跑一个临时包：通过 → ok=true 且 exitCode=0；失败 → ok=false 且带失败脚本名；
 * 3. 工具已注册、wireName 可从规范名推导，三个包都真的声明了 verify。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { BUILTIN_TOOLS } from '../../src/tools/builtin/index.js';
import {
  agentVerifyTool,
  parseVerifyPlan,
  resolvePackageDir,
  summarizeResults,
} from '../../src/tools/builtin/agent-verify.tool.js';
import type { ToolExecutionContext } from '../../src/types/tool.js';

const roots: string[] = [];

function tempRoot(pkg: Record<string, unknown>): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'agent-verify-'));
  roots.push(dir);
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg, null, 2));
  return dir;
}

function ctxFor(sandboxRoot: string): ToolExecutionContext {
  return {
    sessionId: 's',
    toolCallId: 'tc',
    callId: 'c',
    iteration: 1,
    sandboxRoot,
    signal: new AbortController().signal,
    reportProgress: () => undefined,
  };
}

afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('parseVerifyPlan：只认声明过的脚本', () => {
  it('正常例：脚本名与 scripts 都存在 → 生成计划', () => {
    const r = parseVerifyPlan({ verify: ['typecheck', 'test'], scripts: { typecheck: 'tsc', test: 'vitest' } });
    expect(r.error).toBeUndefined();
    expect(r.entries.map((e) => e.name)).toEqual(['typecheck', 'test']);
  });

  it('破坏夹具：没写 verify → 拒（不允许工具自己猜命令）', () => {
    expect(parseVerifyPlan({ scripts: { test: 'vitest' } }).error).toContain('没有声明 verify');
  });

  it('破坏夹具：verify 里写了 scripts 不存在的名字 → 拒', () => {
    const r = parseVerifyPlan({ verify: ['unit'], scripts: { test: 'vitest' } });
    expect(r.error).toContain('scripts 里没有');
  });

  it('破坏夹具：脚本名带空格/管道 → 拒（防命令拼接）', () => {
    const r = parseVerifyPlan({ verify: ['test && rm -rf /'], scripts: { test: 'vitest' } });
    expect(r.error).toContain('非法脚本名');
  });
});

describe('resolvePackageDir：只认三个固定包名', () => {
  it('server = 沙箱根；client 取同级 client；root 取父目录', () => {
    const root = tempRoot({ name: 'repo' });
    mkdirSync(path.join(root, 'server'));
    mkdirSync(path.join(root, 'client'));
    writeFileSync(path.join(root, 'client', 'package.json'), '{}');
    writeFileSync(path.join(root, 'server', 'package.json'), '{}');
    expect(resolvePackageDir('server', path.join(root, 'server'))).toBe(path.join(root, 'server'));
    expect(resolvePackageDir('client', path.join(root, 'server'))).toBe(path.join(root, 'client'));
    expect(resolvePackageDir('root', path.join(root, 'server'))).toBe(root);
  });
});

describe('真实读数：退出码决定 ok，不看模型自述', () => {
  it('通过的脚本 → ok=true，exitCode=0', async () => {
    const dir = tempRoot({
      name: 'pass',
      verify: ['ok'],
      scripts: { ok: 'node -e "process.exit(0)"' },
    });
    const out = await agentVerifyTool.handler({}, ctxFor(dir));
    expect(out.ok).toBe(true);
    const data = out.data as { passed: number; checks: Array<{ exitCode: number; passed: boolean }> };
    expect(data.passed).toBe(1);
    expect(data.checks[0]!.exitCode).toBe(0);
    expect(data.checks[0]!.passed).toBe(true);
  });

  it('失败的脚本 → ok=false，点名失败的脚本', async () => {
    const dir = tempRoot({
      name: 'fail',
      verify: ['bad'],
      scripts: { bad: 'node -e "process.exit(3)"' },
    });
    const out = await agentVerifyTool.handler({}, ctxFor(dir));
    expect(out.ok).toBe(false);
    expect(out.error?.code).toBe('VERIFY_FAILED');
    expect(out.summary).toContain('bad');
    expect((out.data as { failed: number }).failed).toBe(1);
  });

  it('只跑 checks 指定的脚本；未声明的名字拒收', async () => {
    const dir = tempRoot({
      name: 'select',
      verify: ['ok'],
      scripts: { ok: 'node -e "process.exit(0)"' },
    });
    const only = await agentVerifyTool.handler({ checks: ['ok'] }, ctxFor(dir));
    expect(only.ok).toBe(true);
    const unknown = await agentVerifyTool.handler({ checks: ['nope'] }, ctxFor(dir));
    expect(unknown.ok).toBe(false);
    expect(unknown.error?.code).toBe('CHECK_NOT_DECLARED');
  });
});

describe('注册与声明', () => {
  it('agent.verify 已注册且 wireName 正确', () => {
    const found = BUILTIN_TOOLS.find((t) => t.name === 'agent.verify');
    expect(found?.wireName).toBe('agent_verify');
    expect(found?.inputSchema.properties?.checks).toBeTruthy();
  });

  it('server/client/root 三个 package.json 都声明了 verify，且脚本真实存在', () => {
    const repo = path.resolve(process.cwd(), '..');
    for (const file of [path.join(repo, 'package.json'), path.join(repo, 'server', 'package.json'), path.join(repo, 'client', 'package.json')]) {
      const pkg = JSON.parse(readFileSync(file, 'utf8'));
      const plan = parseVerifyPlan(pkg);
      expect(plan.error, `${file}: ${plan.error ?? ''}`).toBeUndefined();
      expect(plan.entries.length).toBeGreaterThan(0);
    }
  });
});

describe('summarizeResults：空结果不算通过', () => {
  it('没有跑任何 check 时 ok=false', () => {
    expect(summarizeResults([]).ok).toBe(false);
  });
});
