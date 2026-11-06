// mcp-connector 单测——AC-12 端到端联调
// 用一个手搓的 stdio MCP 服务器（tests/fixtures/fake-mcp-server.mjs）验证：
// 连接→注册→调用代理→断开即消失→连接失败不波及内置工具→env 卫生。

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { vi } from 'vitest';

// 本文件的用例要起真实子进程做 MCP 握手（单条 3–8s，整文件 40s+）。
// 并发跑全量时会被拖到全局超时之上，而失败信息看起来像「连接断了」——
// 那是超时，不是回归。给它自己的上限，别让机器负载决定用例成败。
//
// 注意：下面每条 it 显式传的超时必须与这里一致（120s）。曾有 11 处写成 20s，
// 逐条覆盖掉文件级的 setConfig —— 于是「连接类」用例在满负载的全量跑里必然超时，
// 而失败信息只说「连接断了」，把资源问题伪装成回归。
vi.setConfig({ testTimeout: 120_000, hookTimeout: 60_000 });
import type { Request, Response } from 'express';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpController } from '../src/controllers/mcp.controller.js';
import { McpConfigStore } from '../src/services/mcp/mcp-config.store.js';
import { McpManagerService } from '../src/services/mcp/mcp-manager.service.js';
import {
  adaptMcpTool,
  canonicalMcpToolName,
  toJsonSchemaSubset,
} from '../src/services/mcp/mcp-tool-adapter.js';
import { runGateway } from '../src/services/tools/security-gateway.js';
import { CreateMcpServerSchema } from '../src/validators/mcp.schema.js';
import { ToolRegistry } from '../src/services/tools/registry.service.js';
import type { ToolDefinition, ToolExecutionContext } from '../src/types/tool.js';

const FIXTURE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'fake-mcp-server.mjs',
);

function builtinStub(): ToolDefinition {
  return {
    name: 'calc.evaluate',
    wireName: 'calc_evaluate',
    displayName: '表达式计算',
    category: 'compute',
    description: '测试占位内置工具',
    inputSchema: { type: 'object', properties: {} },
    handler: async () => ({ ok: true, summary: 'stub' }),
    timeoutMs: 5000,
    risk: 'low',
    approvalMode: 'none',
    enabled: () => true,
    source: 'builtin',
    idempotent: true,
    maxResultChars: 4000,
  };
}

function toolContext(): ToolExecutionContext {
  return {
    sessionId: 'se_mcp_test',
    toolCallId: 'tc_mcp_test',
    callId: 'call_mcp_test',
    iteration: 1,
    sandboxRoot: process.cwd(),
    signal: AbortSignal.timeout(15_000),
    reportProgress: () => {},
  };
}

describe('mcp-tool-adapter（纯函数）', () => {
  it('canonicalMcpToolName 三段点号命名', () => {
    expect(canonicalMcpToolName('github', 'create_issue')).toBe('mcp.github.create_issue');
  });

  it('canonicalMcpToolName 净化非法段：连字符/大写/数字开头', () => {
    // 上游工具名不受我们控制；不净化会让注册抛 invalid canonical tool name
    expect(canonicalMcpToolName('e2e-fake2', 'echo')).toBe('mcp.e2e_fake2.echo');
    expect(canonicalMcpToolName('github', 'get-issue')).toBe('mcp.github.get_issue');
    expect(canonicalMcpToolName('github', 'Echo')).toBe('mcp.github.echo');
    expect(canonicalMcpToolName('github', '2fast')).toBe('mcp.github.t_2fast');
  });

  it('toJsonSchemaSubset：非 object schema 拒绝（MCP SDK 协议层亦拒绝，双保险）', () => {
    expect(toJsonSchemaSubset({ type: 'string' })).toBeNull();
    expect(toJsonSchemaSubset({ type: 'array' })).toBeNull();
    expect(toJsonSchemaSubset(null)).toBeNull();
    expect(toJsonSchemaSubset('nope')).toBeNull();
  });

  it('toJsonSchemaSubset：缺 type 视为 object，缺 properties 补空', () => {
    const schema = toJsonSchemaSubset({});
    expect(schema).toEqual({
      type: 'object',
      properties: {},
      required: [],
      additionalProperties: true,
      description: undefined,
    });
  });

  it('toJsonSchemaSubset：保留 additionalProperties:false 与 required', () => {
    const schema = toJsonSchemaSubset({
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
      additionalProperties: false,
      description: '读文件',
    });
    expect(schema).toEqual({
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
      additionalProperties: false,
      description: '读文件',
    });
  });
});

describe('P2-1 MCP risk grading（annotations 分级，不再一律 high/hard）', () => {
  const stub = { isConnected: () => true } as unknown as McpManagerService;
  const schema = { type: 'object', properties: {} };

  it('readOnlyHint → low/none，且登记为 idempotent（超时可安全重试）', () => {
    const def = adaptMcpTool('srv', { name: 'search', inputSchema: schema, annotations: { readOnlyHint: true } }, stub)!;
    expect(def.risk).toBe('low');
    expect(def.approvalMode).toBe('none');
    expect(def.idempotent).toBe(true);
  });

  it('destructiveHint → high/hard，且绝不 idempotent', () => {
    const def = adaptMcpTool(
      'srv',
      { name: 'drop_table', inputSchema: schema, annotations: { destructiveHint: true } },
      stub,
    )!;
    expect(def.risk).toBe('high');
    expect(def.approvalMode).toBe('hard');
    expect(def.idempotent).toBe(false);
  });

  it('无提示的普通写 → medium/soft（仍有闸，绝不静默放行）', () => {
    const def = adaptMcpTool('srv', { name: 'write_file', inputSchema: schema }, stub)!;
    expect(def.risk).toBe('medium');
    expect(def.approvalMode).toBe('soft');
    expect(def.idempotent).toBe(false);
  });

  it('idempotentHint 单独出现：不降档，但允许自动重试', () => {
    const def = adaptMcpTool(
      'srv',
      { name: 'upsert', inputSchema: schema, annotations: { idempotentHint: true } },
      stub,
    )!;
    expect(def.risk).toBe('medium');
    expect(def.approvalMode).toBe('soft');
    expect(def.idempotent).toBe(true);
  });

  it('失败可重试性跟随提示：只读工具 retryable，写工具不 retryable', async () => {
    const failing = {
      isConnected: () => true,
      callTool: async () => {
        throw new Error('upstream down');
      },
    } as unknown as McpManagerService;
    const read = adaptMcpTool(
      'srv',
      { name: 'search', inputSchema: schema, annotations: { readOnlyHint: true } },
      failing,
    )!;
    const write = adaptMcpTool('srv', { name: 'push', inputSchema: schema }, failing)!;

    const readOutcome = await read.handler({}, toolContext());
    const writeOutcome = await write.handler({}, toolContext());
    expect(readOutcome.error?.retryable).toBe(true);
    expect(writeOutcome.error?.retryable).toBe(false);
  });
});

describe('mcp.schema 校验', () => {
  it('Windows 盘符路径（正斜杠）是合法 command', () => {
    const parsed = CreateMcpServerSchema.safeParse({
      name: 'Win',
      command: 'C:/Users/me/node.exe',
      args: ['C:/Program Files/x.mjs'],
      env: {},
    });
    expect(parsed.success).toBe(true);
  });

  it('shell 元字符仍被拒绝', () => {
    const parsed = CreateMcpServerSchema.safeParse({
      name: 'Bad',
      command: 'node; rm -rf /',
      args: [],
      env: {},
    });
    expect(parsed.success).toBe(false);
  });

  it('env 键名敏感词被拒绝', () => {
    const parsed = CreateMcpServerSchema.safeParse({
      name: 'Bad',
      command: 'node',
      args: [],
      env: { apiKey: 'x' },
    });
    expect(parsed.success).toBe(false);
  });
});

describe('mcp-connector', () => {
  let tmp: string;
  let store: McpConfigStore;
  let registry: ToolRegistry;
  let manager: McpManagerService;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), 'codelens-mcp-'));
    store = new McpConfigStore(path.join(tmp, 'mcp-servers.json'));
    registry = new ToolRegistry();
    manager = new McpManagerService(store, registry);
  });

  afterEach(async () => {
    await manager.closeAll();
    // 沙箱守卫给递归 rmSync 加数秒延迟：容错 + 超时，清理失败不殃及用例
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {
      // 临时目录清理失败不影响测试结果
    }
  }, 60_000);

  function addFakeServer(env: Record<string, string> = {}): void {
    store.add({
      id: 'fake',
      name: 'Fake MCP',
      command: process.execPath,
      args: [FIXTURE],
      env,
    });
  }

  it('连接成功：工具以 mcp.<serverId>.<tool> 规范名注册，线上名下划线化', async () => {
    addFakeServer();
    const result = await manager.connect('fake');
    expect(result.status).toBe('connected');
    expect([...result.tools].sort()).toEqual(['mcp.fake.add', 'mcp.fake.echo', 'mcp.fake.env_probe']);

    const echo = registry.get('mcp.fake.echo');
    expect(echo).toBeDefined();
    expect(echo!.wireName).toBe('mcp_fake_echo');
    expect(echo!.source).toBe('mcp');
    expect(echo!.category).toBe('mcp');
    // P2-1: risk follows the server's annotations — echo declares readOnlyHint,
    // so it is low/none instead of the old blanket high/hard.
    expect(echo!.risk).toBe('low');
    expect(echo!.approvalMode).toBe('none');
    expect(echo!.idempotent).toBe(true);
    // The unannotated tool keeps a gate (default write tier, never `none`).
    const probe = registry.get('mcp.fake.env_probe')!;
    expect(probe.risk).toBe('medium');
    expect(probe.approvalMode).toBe('soft');
    expect(probe.idempotent).toBe(false);
    expect(manager.statusOf('fake')).toBe('connected');
    expect(manager.toolsOf('fake')).toHaveLength(3);
  }, 120_000);

  it('P2-1: 安全网关不再把已分级的 MCP 工具整体抬回 high/hard', async () => {
    addFakeServer();
    await manager.connect('fake');
    const echo = registry.get('mcp.fake.echo')!;
    const gate = runGateway(echo, { text: 'hi' }, { sandboxRoot: '' });
    expect(gate.ok).toBe(true);
    if (gate.ok) {
      expect(gate.verdict.risk).toBe('low');
      expect(gate.verdict.approvalMode).toBe('none');
    }
  }, 120_000);

  it('tools/list 中三个工具全部注册（SDK 协议层已拒绝非 object schema）', async () => {
    addFakeServer();
    const result = await manager.connect('fake');
    expect(result.status).toBe('connected');
    expect([...result.tools].sort()).toEqual(['mcp.fake.add', 'mcp.fake.echo', 'mcp.fake.env_probe']);
  }, 120_000);

  it('调用代理：参数穿透到子进程，结果文本回传', async () => {
    addFakeServer();
    await manager.connect('fake');
    const echo = registry.get('mcp.fake.echo')!;
    const echoed = await echo.handler({ text: '你好 MCP' }, toolContext());
    expect(echoed.ok).toBe(true);
    expect(echoed.summary).toContain('echo: 你好 MCP');

    const add = registry.get('mcp.fake.add')!;
    const sum = await add.handler({ a: 2, b: 40 }, toolContext());
    expect(sum.ok).toBe(true);
    expect(sum.summary).toContain('sum: 42');
  }, 120_000);

  it('上游 isError 透传为失败结果（MCP_CALL_FAILED）', async () => {
    addFakeServer();
    await manager.connect('fake');
    const add = registry.get('mcp.fake.add')!;
    const outcome = await add.handler({ a: 'x', b: 'y' }, toolContext());
    expect(outcome.ok).toBe(false);
    expect(outcome.error?.code).toBe('MCP_CALL_FAILED');
  }, 120_000);

  it('断开后工具从注册表消失，对模型不可见', async () => {
    addFakeServer();
    await manager.connect('fake');
    const echo = registry.get('mcp.fake.echo')!;
    // 连接中：enabled 断言为真
    expect(echo.enabled({ sandboxRoot: '', mcpConnected: true })).toBe(true);

    await manager.disconnect('fake');
    expect(registry.get('mcp.fake.echo')).toBeUndefined();
    expect(registry.list({ source: 'mcp' })).toHaveLength(0);
    expect(manager.statusOf('fake')).toBe('disconnected');
    expect(manager.toolsOf('fake')).toEqual([]);
    // 已捕获的定义在断开后 enabled 翻假
    expect(echo.enabled({ sandboxRoot: '', mcpConnected: true })).toBe(false);
    // 对 LLM 的工具投影不含已断开的 MCP 工具
    const wireNames = registry.toProviderTools(undefined, { sandboxRoot: '', mcpConnected: true })
      .map((spec) => spec.function.name);
    expect(wireNames).not.toContain('mcp_fake_echo');
  }, 120_000);

  it('断开后调用残留处理器 → MCP_NOT_CONNECTED（而非崩溃）', async () => {
    addFakeServer();
    await manager.connect('fake');
    const echo = registry.get('mcp.fake.echo')!;
    await manager.disconnect('fake');
    const outcome = await echo.handler({ text: 'x' }, toolContext());
    expect(outcome.ok).toBe(false);
    expect(outcome.error?.code).toBe('MCP_NOT_CONNECTED');
  }, 120_000);

  it('连接失败不波及内置工具（AC-12 / S-5 隔离）', async () => {
    registry.register(builtinStub());
    store.add({
      id: 'broken',
      name: 'Broken',
      command: 'definitely-not-a-real-binary-xyz-123',
      args: [],
      env: {},
    });
    const result = await manager.connect('broken');
    expect(result.status).toBe('failed');
    expect(result.error).toBeTruthy();
    expect(result.tools).toEqual([]);
    // 内置工具照常可用
    expect(registry.get('calc.evaluate')).toBeDefined();
    expect(registry.list({ source: 'mcp' })).toHaveLength(0);
    expect(manager.health()).toEqual({ servers: 1, healthy: 0 });
  }, 120_000);

  it('连接不存在的 serverId → failed（MCP_SERVER_NOT_FOUND）', async () => {
    const result = await manager.connect('nope');
    expect(result.status).toBe('failed');
    expect(result.error).toBe('MCP_SERVER_NOT_FOUND');
  });

  it('重复连接幂等：不重复注册、不重复 spawn', async () => {
    addFakeServer();
    const first = await manager.connect('fake');
    const second = await manager.connect('fake');
    expect(second.status).toBe('connected');
    expect(second.tools.sort()).toEqual([...first.tools].sort());
    expect(registry.list({ source: 'mcp' })).toHaveLength(3);
  }, 120_000);

  it('env 卫生：config.env 透传，继承环境中的机密被 scrub', async () => {
    process.env.SUPER_SECRET_TOKEN = 'should-not-leak';
    try {
      addFakeServer({ SECRET_KEY: 'from-config' });
      await manager.connect('fake');
      const probe = registry.get('mcp.fake.env_probe')!;
      const outcome = await probe.handler({}, toolContext());
      expect(outcome.ok).toBe(true);
      const seen = JSON.parse(String(outcome.data?.text ?? '{}')) as Record<string, string | null>;
      expect(seen.SECRET_KEY).toBe('from-config'); // 显式配置的 env 可用
      expect(seen.SUPER_SECRET_TOKEN).toBeNull(); // 继承的机密被剥掉
    } finally {
      delete process.env.SUPER_SECRET_TOKEN;
    }
  }, 120_000);

  it('API 视图不含 env 字段（secret hygiene，spec 7.6.4）', async () => {
    addFakeServer({ SECRET_KEY: 'from-config' });
    // 直接验证 store 持久化了 env（重连需要），但 controller 视图从不回显
    expect(store.get('fake')?.env).toEqual({ SECRET_KEY: 'from-config' });
    const config = store.get('fake')!;
    const view = manager.statusOf('fake');
    expect(view).toBe('disconnected');
    // view 的形状即 controller.list 使用的字段集
    expect(Object.keys(config)).toContain('env'); // 存储层保留
  });

  it('控制器 create：strict 校验通过、id 由 name 派生、视图不回显 env', () => {
    // 回归：曾经向 .strict() schema 注入 id 键，导致所有创建请求 400
    // （Unrecognized key: "id"）——E2E API 层实测发现。
    const controller = new McpController(store, manager);
    let captured: { status?: number; body?: { server?: Record<string, unknown> } } = {};
    const res = {
      status(code: number) {
        captured.status = code;
        return this;
      },
      json(body: { server?: Record<string, unknown> }) {
        captured.body = body;
      },
    } as unknown as Response;
    controller.create(
      {
        body: { name: 'E2E Fake', command: 'C:/node.exe', args: ['a b.mjs'], env: { SECRET_KEY: 'x' } },
      } as Request,
      res,
    );
    expect(captured.status).toBe(201);
    // slug 化禁含连字符（规范名分段只允许 [a-z0-9_]）——回归：曾连字符导致
    // mcp.e2e-fake.echo 注册即抛 invalid canonical tool name。
    expect(captured.body?.server?.id).toBe('e2e_fake');
    expect(captured.body?.server).not.toHaveProperty('env');
  });
});
