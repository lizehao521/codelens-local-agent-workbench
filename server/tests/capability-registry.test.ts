/**
 * 运行时能力开关目录（只读观测面）的验收。
 *
 * 这个端点唯一的价值是「让人相信它报的状态」—— 所以用例重点不是「返回了 200」，
 * 而是三件容易被做错的事：
 *  1. **口径不骗人**：能力没在跑必须 enabled=false。零统计（0 个工具 / 0 个 MCP 服务器）
 *     绝不能被报成"运行正常"。
 *  2. **顺序稳定**：条目顺序由定义表固定，前端与测试都能断言。
 *  3. **降级不抛错**：deps 缺字段 / 传入脏值时按安全默认回落 —— 一个只读面板
 *     因为配置不全而 500，比它少报一项严重得多。
 *
 * 纯函数级单测：不起真实 DB、不依赖 runtime 装配。
 */

import { describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import type { Response } from 'express';
import {
  CapabilityRegistryService,
  type CapabilityRegistryDeps,
} from '../src/services/capability/capability-registry.service.js';
import { CapabilitiesController } from '../src/controllers/capabilities.controller.js';
import { createCapabilitiesRoutes } from '../src/routes/capabilities.routes.js';
import { selectFilesToSnapshot } from '../src/services/agent/agent-loop.service.js';
import { BUILTIN_TOOLS } from '../src/tools/builtin/index.js';

/** 契约里的 12 条能力，顺序即期望输出顺序。 */
const EXPECTED_IDS = [
  'judge',
  'policy',
  'tools',
  'mcp',
  'sandbox',
  'trial',
  'observability',
  'checkpoint',
  'skills',
  'approval',
  'memory',
  'modelSync',
];

/** 全部能力都在跑：内核常开 + 三个开关打开 + 工具/MCP 都有可用实例。 */
function allOnDeps(): CapabilityRegistryDeps {
  return {
    judge: { enabled: true },
    policy: { enabled: true },
    tools: { count: 12, enabledCount: 9 },
    mcp: { servers: 3, healthy: 2 },
    sandbox: { writable: true },
    trial: { enabled: true, serverKeyConfigured: true },
    observabilityEnabled: true,
    checkpointEnabled: true,
    skillLibraryEnabled: true,
    approval: { enabled: true },
    memory: { enabled: true },
    modelSync: { enabled: true },
  };
}

/** 全部能力都没在跑（含内核能力被显式关掉，用于演练/故障场景）。 */
function allOffDeps(): CapabilityRegistryDeps {
  return {
    judge: { enabled: false },
    policy: { enabled: false },
    tools: { count: 12, enabledCount: 0 },
    mcp: { servers: 3, healthy: 0 },
    sandbox: { writable: false },
    trial: { enabled: false, serverKeyConfigured: false },
    observabilityEnabled: false,
    checkpointEnabled: false,
    skillLibraryEnabled: false,
    approval: { enabled: false },
    memory: { enabled: false },
    modelSync: { enabled: false },
  };
}

describe('运行时能力开关目录', () => {
  it('K1 全部开启：条目齐全、顺序稳定、字段完整', () => {
    const snapshot = new CapabilityRegistryService(allOnDeps()).list();

    expect(snapshot.total).toBe(12);
    expect(snapshot.capabilities.map((c) => c.id)).toEqual(EXPECTED_IDS);
    // 字段齐全：id / label / enabled / wired / envHint 一个都不能缺。
    for (const entry of snapshot.capabilities) {
      expect(typeof entry.id).toBe('string');
      expect(entry.label.length).toBeGreaterThan(0);
      expect(typeof entry.enabled).toBe('boolean');
      expect(typeof entry.wired).toBe('boolean');
      expect(entry.envHint.length).toBeGreaterThan(0);
      expect(typeof entry.detail).toBe('string');
    }
    // 技能库尚未接入 runtime：即使开关打开也不能报"在跑"。
    const skills = snapshot.capabilities.find((c) => c.id === 'skills')!;
    expect(skills.wired).toBe(false);
    expect(skills.enabled).toBe(false);
  });

  it('K2 enabledCount 只统计 enabled=true 的条目', () => {
    const snapshot = new CapabilityRegistryService(allOnDeps()).list();
    const manual = snapshot.capabilities.filter((c) => c.enabled === true).length;

    expect(snapshot.enabledCount).toBe(manual);
    // 内核四条（判据塔 / 策略更新 / 工具审批 / 记忆仓储）+ 工具 / MCP / 沙箱 /
    // 兜底试用 / 轨迹 / 快照 / 模型同步 = 11；技能库未接线不算。
    expect(snapshot.enabledCount).toBe(11);
    expect(snapshot.enabledCount).toBeLessThanOrEqual(snapshot.total);
  });

  it('K3 全部关闭：enabledCount=0，且没有一条 enabled=true', () => {
    const snapshot = new CapabilityRegistryService(allOffDeps()).list();

    expect(snapshot.total).toBe(12);
    expect(snapshot.enabledCount).toBe(0);
    expect(snapshot.capabilities.every((c) => c.enabled === false)).toBe(true);
    // 装了但没开 ≠ 没装：wired 与 enabled 是两个口径。
    expect(snapshot.capabilities.every((c) => typeof c.wired === 'boolean')).toBe(true);
  });

  it('K4 部分开启：只统计真正在跑的那几条', () => {
    const deps = allOffDeps();
    deps.checkpointEnabled = true;
    deps.tools = { count: 5, enabledCount: 2 };
    deps.mcp = { servers: 1, healthy: 1 };

    const snapshot = new CapabilityRegistryService(deps).list();
    const enabledIds = snapshot.capabilities.filter((c) => c.enabled).map((c) => c.id);

    expect(enabledIds).toEqual(['tools', 'mcp', 'checkpoint']);
    expect(snapshot.enabledCount).toBe(3);
  });

  it('K5 零统计不冒充运行正常：工具 / MCP 空数据时 enabled=false', () => {
    const deps = allOffDeps();
    deps.tools = { count: 0, enabledCount: 0 };
    deps.mcp = { servers: 0, healthy: 0 };

    const snapshot = new CapabilityRegistryService(deps).list();
    const tools = snapshot.capabilities.find((c) => c.id === 'tools')!;
    const mcp = snapshot.capabilities.find((c) => c.id === 'mcp')!;

    expect(tools.enabled).toBe(false);
    expect(mcp.enabled).toBe(false);
    // 工具注册表实例在（wired），但没工具可用 —— 这是"待命"不是"在跑"。
    expect(tools.wired).toBe(true);
    expect(mcp.wired).toBe(false);
  });

  it('K6 开关打开但服务未接线 ⇒ 不算在跑（技能库 / 可用 wired 覆盖表达）', () => {
    const deps = allOffDeps();
    deps.skillLibraryEnabled = true;
    deps.observabilityEnabled = true;
    deps.wired = { skills: false, observability: false };

    const snapshot = new CapabilityRegistryService(deps).list();
    expect(snapshot.capabilities.find((c) => c.id === 'skills')!.enabled).toBe(false);
    expect(snapshot.capabilities.find((c) => c.id === 'observability')!.enabled).toBe(false);
    expect(snapshot.capabilities.find((c) => c.id === 'skills')!.wired).toBe(false);

    // 接线状态一旦补上，开关打开就能真正"在跑"（wired 由装配层说了算）。
    deps.wired = { skills: true, observability: true };
    const wiredSnapshot = new CapabilityRegistryService(deps).list();
    expect(wiredSnapshot.capabilities.find((c) => c.id === 'skills')!.enabled).toBe(true);
    expect(wiredSnapshot.capabilities.find((c) => c.id === 'observability')!.enabled).toBe(true);
  });

  it('K7 兜底 Key 试用：开关开了但没服务端 Key ⇒ 仍然不可用', () => {
    const deps = allOffDeps();
    deps.trial = { enabled: true, serverKeyConfigured: false };

    const snapshot = new CapabilityRegistryService(deps).list();
    const trial = snapshot.capabilities.find((c) => c.id === 'trial')!;

    expect(trial.enabled).toBe(false);
    expect(trial.wired).toBe(true);
    expect(trial.detail).toContain('LLM_SERVER_API_KEY');
  });

  it('K8 deps 缺字段：不抛异常，降级为安全默认（默认不报"在跑"）', () => {
    // 模拟装配层只填了部分字段（甚至整组缺失）。
    const broken = {
      tools: { count: 3, enabledCount: 1 },
      mcp: { servers: 2, healthy: 1 },
    } as unknown as CapabilityRegistryDeps;

    const snapshot = new CapabilityRegistryService(broken).list();

    expect(snapshot.total).toBe(12);
    expect(snapshot.capabilities.map((c) => c.id)).toEqual(EXPECTED_IDS);
    // 工具 / MCP 有数就是有；内核能力在 deps 给了但没填时按"常开"算，
    // 而数据驱动的那几条（沙箱 / 试用 / 模型同步）缺数据就一律不报启用。
    expect(snapshot.capabilities.find((c) => c.id === 'tools')!.enabled).toBe(true);
    expect(snapshot.capabilities.find((c) => c.id === 'mcp')!.enabled).toBe(true);
    expect(snapshot.capabilities.find((c) => c.id === 'judge')!.enabled).toBe(true);
    expect(snapshot.capabilities.find((c) => c.id === 'sandbox')!.enabled).toBe(false);
    expect(snapshot.capabilities.find((c) => c.id === 'trial')!.enabled).toBe(false);
    expect(snapshot.capabilities.find((c) => c.id === 'modelSync')!.enabled).toBe(false);
  });

  it('K9 脏值兜底：负数 / NaN / undefined 都不抛异常，且不虚报可用', () => {
    const broken = {
      judge: { enabled: true },
      policy: { enabled: true },
      tools: { count: -5, enabledCount: undefined },
      mcp: { servers: Number.NaN, healthy: -1 },
      sandbox: { writable: 'yes' },
      trial: { enabled: 1, serverKeyConfigured: undefined },
      observabilityEnabled: 'true',
      checkpointEnabled: undefined,
      skillLibraryEnabled: null,
    } as unknown as CapabilityRegistryDeps;

    const snapshot = new CapabilityRegistryService(broken).list();

    expect(snapshot.total).toBe(12);
    const tools = snapshot.capabilities.find((c) => c.id === 'tools')!;
    const mcp = snapshot.capabilities.find((c) => c.id === 'mcp')!;
    expect(tools.enabled).toBe(false);
    expect(tools.detail).toContain('已注册 0 个工具');
    expect(mcp.enabled).toBe(false);
    expect(mcp.detail).toContain('已配置 0 个 MCP 服务器');
    expect(snapshot.capabilities.find((c) => c.id === 'sandbox')!.enabled).toBe(false);
    expect(snapshot.capabilities.find((c) => c.id === 'checkpoint')!.enabled).toBe(false);
  });

  it('K10 deps 整体为 undefined 也不炸（观测面不许因配置不全而 500）', () => {
    const snapshot = new CapabilityRegistryService(undefined as unknown as CapabilityRegistryDeps).list();

    expect(snapshot.total).toBe(12);
    expect(snapshot.enabledCount).toBe(0);
    expect(snapshot.capabilities.map((c) => c.id)).toEqual(EXPECTED_IDS);
  });

  it('K11 controller 只读透传：res.json 收到的就是 registry.list()', () => {
    const registry = new CapabilityRegistryService(allOnDeps());
    const controller = new CapabilitiesController(registry);

    let body: unknown = null;
    const res = { json: (b: unknown) => { body = b; } } as unknown as Response;
    controller.list({} as never, res);

    expect(body).toEqual(registry.list());
  });

  it('K12 路由：GET /capabilities 返回 200 + 目录，且不接受写方法', async () => {
    const controller = new CapabilitiesController(new CapabilityRegistryService(allOnDeps()));
    const app = express();
    app.use('/api/v1', createCapabilitiesRoutes({ capabilities: controller }));

    const res = await request(app).get('/api/v1/capabilities');
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(12);
    expect(res.body.capabilities.map((c: { id: string }) => c.id)).toEqual(EXPECTED_IDS);

    // 只读端点：写方法不得有任何副作用（404 / 405 都算"没接住"）。
    const post = await request(app).post('/api/v1/capabilities');
    expect([404, 405]).toContain(post.status);
  });

  it('K13 detail 不得落后于实现：checkpoint 文案已描述「自动捕获」', () => {
    // 自动捕获触发点已接进 agent loop（工具调用轮，executor.executeBatch 之前
    // 调 checkpoint.capture，失败被 catch 吞掉不阻断主流程）——
    // 所以文案必须描述"自动捕获"，也不许再出现"待接入 / 未接入"这种落后于实现的话。
    const deps = allOffDeps();
    deps.checkpointEnabled = true;
    deps.wired = { checkpoint: true };

    const snapshot = new CapabilityRegistryService(deps).list();
    const checkpoint = snapshot.capabilities.find((c) => c.id === 'checkpoint')!;

    expect(checkpoint.enabled).toBe(true);
    expect(checkpoint.wired).toBe(true);
    expect(checkpoint.detail).toContain('自动捕获');
    // 文案落后于实现（还写着"待接入"）时这条会红 —— 那是提醒，不是噪音。
    expect(checkpoint.detail).not.toContain('待接入');
    expect(checkpoint.detail).not.toContain('未接入');
    // 覆盖边界不许被悄悄删掉：白名单是路径粒度的，sys.exec（git/node）与 MCP 工具
    // 的副作用原理上兜不住。文案一旦把这些抹掉，"自动捕获"就会被读成
    // "所有写入都被捕获" —— 那是对运维的误导。
    expect(checkpoint.detail).toContain('sys.exec');
    expect(checkpoint.detail).toContain('MCP');
    // 回滚边界同理不许被抹掉：回滚只还原**内容**，不撤销结构变更
    // （rename 的产物不删 —— 删产物是第二次破坏的风险点，主控决策 (a)）。
    // 只写「可按 id 回滚」会被读成"能撤掉这次改动"。
    expect(checkpoint.detail).toContain('不撤销结构变更');
  });

  it('K14 detail 必须与 wired 一致：已接线说「在跑什么」，未接线说「为什么不算在跑」', () => {
    // 回归防护：detail 的三元分支曾写反 —— enabled=true（已接线）却显示
    // 「未确认接线…即使开关打开也不宣称在跑」，自相矛盾的用户文案比没有文案更糟。
    const onDeps = allOffDeps();
    onDeps.skillLibraryEnabled = true;
    onDeps.wired = { skills: true };
    const on = new CapabilityRegistryService(onDeps).list().capabilities.find((c) => c.id === 'skills')!;

    expect(on.wired).toBe(true);
    expect(on.enabled).toBe(true);
    expect(on.detail).toContain('技能列表与匹配');
    expect(on.detail).not.toContain('未确认接线');

    const offDeps = allOffDeps();
    offDeps.skillLibraryEnabled = true;
    offDeps.wired = { skills: false };
    const off = new CapabilityRegistryService(offDeps).list().capabilities.find((c) => c.id === 'skills')!;

    expect(off.wired).toBe(false);
    expect(off.enabled).toBe(false);
    expect(off.detail).toContain('未确认接线');
  });

  it('K15 覆盖面绊线：fs.write 的每个 operation 都进得了自动捕获白名单', () => {
    // 能力目录对外宣称 checkpoint「每轮文件修改前自动捕获（仅写入类操作）」。
    // 这句宣称要成立，光有 K13 的文案断言不够 —— 真正的暴露点是**覆盖面**：
    // 若 fs.write 新增了一个 operation（或改了参数键名）而白名单没跟着扩，
    // 目录就会变成"说在自动捕获、实际那一类没拍"。
    // 这里把 fs.write 的 operation 枚举（从工具的 inputSchema 取，是唯一事实源）
    // 逐个喂进白名单函数，缺一个就红。
    const fsWrite = BUILTIN_TOOLS.find((t) => t.name === 'fs.write');
    const properties = fsWrite?.inputSchema.properties ?? {};
    const operations = (properties.operation?.enum ?? []) as string[];

    expect(operations.length).toBeGreaterThan(0);

    for (const operation of operations) {
      // purge 的 path 指向的是**目录**（服务端会递归展开它），其余指向文件。
      const pathArg = operation === 'purge' ? 'important-dir' : 'target.txt';
      const args: Record<string, unknown> = { operation, path: pathArg };
      if (operation === 'rename') args.newPath = 'renamed.txt';

      const picked = selectFilesToSnapshot([
        { toolCall: { tool_name: 'fs.write' }, args },
      ]);
      expect(picked, `operation=${operation} 必须进入自动捕获白名单`).toContain(pathArg);
    }

    // rename 的目标路径也要拍：目标若已存在会被覆盖，必须一起回滚。
    expect(
      selectFilesToSnapshot([
        {
          toolCall: { tool_name: 'fs.write' },
          args: { operation: 'rename', path: 'a.txt', newPath: 'b.txt' },
        },
      ]).sort(),
    ).toEqual(['a.txt', 'b.txt']);

    // 「仅写入类操作」这半句：读操作不拍。
    expect(
      selectFilesToSnapshot([{ toolCall: { tool_name: 'fs.read' }, args: { path: 'target.txt' } }]),
    ).toEqual([]);
  });

  it('K16 新增带 path 参数的工具必须被自动捕获覆盖（或显式登记为不覆盖）', () => {
    // K15 兜的是「fs.write 内部新增 operation」；这条兜的是**新增另一个工具**：
    // 白名单是按 tool_name + 参数键取路径的，所以新写类工具若没被纳入取键逻辑，
    // 就会「说在自动捕获、实际没拍」。这里维护一份**显式的**不覆盖名单：
    // 带 path 参数的工具，要么被自动捕获，要么在名单里并写明理由；
    // 名单里的条目若已被覆盖（或工具已不存在），这条会红 —— 防止名单腐化。
    //
    // 已知边界（不在本条断言范围内，属设计取舍）：sys.exec 用的是 cwd + 任意参数，
    // 它能经 git/node 命令改任意文件，路径粒度的自动快照覆盖不了；
    // 它的参数键也不叫 path，按 path 参数筛选时天然不落在这条断言里。
    const NOT_AUTO_CAPTURED: Record<string, string> = {
      'fs.read': '只读，不改文件',
      'fs.list': '只读，不改文件',
      'fs.glob': '只读，不改文件',
      'code.search': '只读，不改文件',
      // code.check 只把源码喂给解析器，不写盘（判据 C5 专门锁了「不执行、不落盘」）。
      'code.check': '只读：只解析语法，不写文件',
      'json.format': 'path 是 JSON Pointer，不是文件系统路径',
    };

    const pathTools = BUILTIN_TOOLS.filter((t) => t.inputSchema.properties?.path !== undefined);
    expect(pathTools.length).toBeGreaterThan(0);

    for (const tool of pathTools) {
      const picked = selectFilesToSnapshot([
        { toolCall: { tool_name: tool.name }, args: { path: 'probe.txt', operation: 'overwrite' } },
      ]);
      if (picked.length > 0) continue; // 已被自动捕获 —— 符合预期
      expect(
        NOT_AUTO_CAPTURED[tool.name],
        `工具 ${tool.name} 带 path 参数却不在自动捕获范围内：要么把白名单取键逻辑扩上，`
          + `要么显式登记进不覆盖名单并写明理由`,
      ).toBeTruthy();
    }

    // 反向校验：名单不能有陈旧条目（工具已删 / 已被覆盖）。
    for (const [name] of Object.entries(NOT_AUTO_CAPTURED)) {
      const tool = BUILTIN_TOOLS.find((t) => t.name === name);
      expect(tool, `不覆盖名单里的 ${name} 已不存在，请清理`).toBeTruthy();
      const picked = selectFilesToSnapshot([
        { toolCall: { tool_name: name }, args: { path: 'probe.txt' } },
      ]);
      expect(picked.length, `不覆盖名单里的 ${name} 现在已被自动捕获，请从名单移除`).toBe(0);
    }
  });
});
