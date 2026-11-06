/**
 * 运行时能力开关目录 —— 运维视角的「单一事实来源」（只读观测面）。
 *
 * 背景：旧一代产品有一个 `/api/v1/insights/capabilities`，一次就能列出系统所有能力的
 * 启用状态（「某某能力到底开没开」不用再翻配置、翻源码、猜）。2.0.0 丢了这一层，
 * 这次把它补回来。
 *
 * 三条不可让步的性质：
 *  1. **口径不骗人**：能力没在跑就是 `enabled=false`。绝不用「空数据 / 零统计」
 *     冒充「运行正常」—— 0 个 MCP 服务器、0 个可用工具，都是"没在跑"，
 *     不是"跑得很好"。零统计必须同时把 enabled 压成 false。
 *  2. **顺序稳定**：条目顺序由 CAPABILITY_DEFS 固定，前端渲染与测试断言都能依赖它。
 *  3. **降级不抛错**：deps 缺字段 / 传入脏值时按安全默认回落，绝不把整个观测面拖挂。
 *     一个只读面板 500，比它少报一项严重得多。
 *
 * `wired` 与 `enabled` 的区别（别混为一谈）：
 *  - `wired`  = 对应服务实例是否真的被装配进 runtime（装了但开关关着 =
 *                wired=true / enabled=false；这是"待命"，不是"在跑"）。
 *  - `enabled` = 运行时是否真的在跑（必须同时满足「已接线」与「开关打开」）。
 *
 * 本模块是**纯聚合**：不查库、不写库、不改任何状态。所有事实由调用方（runtime 装配层）
 * 以 deps 的形式喂进来；服务自己不判断 runtime 里有没有装某个东西。
 */

/** 能力条目的稳定英文标识（前端按它做 key，不要用中文 label 做 key）。 */
export type CapabilityId =
  | 'judge'
  | 'policy'
  | 'tools'
  | 'mcp'
  | 'sandbox'
  | 'trial'
  | 'observability'
  | 'checkpoint'
  | 'skills'
  | 'approval'
  | 'memory'
  | 'modelSync';

/** 能力目录里的一条。 */
export interface CapabilityEntry {
  /** 稳定英文标识，如 'judge' / 'checkpoint'。 */
  id: string;
  /** 中文名，如 '判据塔（判决闭环）'。 */
  label: string;
  /** 运行时是否真的在跑。 */
  enabled: boolean;
  /** 是否已接线（对应服务实例存在）。 */
  wired: boolean;
  /** 启用方式说明（环境变量名，或"内置常开"）。 */
  envHint: string;
  /** 可选补充。 */
  detail?: string;
}

/**
 * 装配层喂进来的事实（服务自己不查库、不看 runtime）。
 *
 * 前 9 组是契约必需字段；后 4 组是为了覆盖清单里的「工具审批 / 记忆仓储 /
 * 上游模型同步 / 接线状态」而设的**可选**扩展 —— 缺省时按安全默认回落
 * （未接线 / 未启用），不会把整面观测面拖挂。
 */
export interface CapabilityRegistryDeps {
  /** 判据塔（判决闭环）：内核常开。 */
  judge: { enabled: boolean };
  /** 策略更新（π 自我修改）：内核常开。 */
  policy: { enabled: boolean };
  /** 工具注册表：count = 已注册工具数，enabledCount = 当前可用数。 */
  tools: { count: number; enabledCount: number };
  /** MCP 连接器：servers = 已配置服务器数，healthy = 当前健康数。 */
  mcp: { servers: number; healthy: number };
  /** 沙箱权限：writable = 沙箱根是否真的可写（真实写探针结果）。 */
  sandbox: { writable: boolean };
  /** 兜底 Key 试用：enabled = 开关，serverKeyConfigured = 服务端兜底 Key 是否已配置。 */
  trial: { enabled: boolean; serverKeyConfigured: boolean };
  /** 运行轨迹埋点开关（OBSERVABILITY_ENABLED）。 */
  observabilityEnabled: boolean;
  /** 工作区快照开关（CHECKPOINT_ENABLED）。 */
  checkpointEnabled: boolean;
  /** 技能库开关（SKILL_LIBRARY_ENABLED）。 */
  skillLibraryEnabled: boolean;
  // ── 可选扩展 ────────────────────────────────────────────────────────────
  /** 工具审批闸：内核常开。 */
  approval?: { enabled: boolean };
  /** 记忆仓储（会话 / 消息持久化）：内核常开。 */
  memory?: { enabled: boolean };
  /** 上游模型同步：需要 MODEL_SOURCE_URL 才有源可拉。 */
  modelSync?: { enabled: boolean };
  /** 接线状态覆盖：主控装配结果与内置默认不符时用它纠正（缺省项走各条默认口径）。 */
  wired?: Partial<Record<CapabilityId, boolean>>;
}

/** 能力目录快照。 */
export interface CapabilityRegistrySnapshot {
  capabilities: CapabilityEntry[];
  /** 只统计 enabled === true 的条目。 */
  enabledCount: number;
  /** 条目总数。 */
  total: number;
}

/**
 * 能力清单（顺序即输出顺序，固定不变）。
 *
 * `envHint` 是「怎么把它开起来」的提示：环境变量名，或"内置常开"。
 * 运维看这一列就知道该去改哪个变量。
 */
const CAPABILITY_DEFS: ReadonlyArray<{ id: CapabilityId; label: string; envHint: string }> = [
  { id: 'judge', label: '判据塔（判决闭环）', envHint: '内置常开' },
  { id: 'policy', label: '策略更新（π 自我修改）', envHint: '内置常开' },
  { id: 'tools', label: '工具注册表', envHint: '内置常开' },
  { id: 'mcp', label: 'MCP 连接器', envHint: 'MCP_CONFIG_PATH' },
  { id: 'sandbox', label: '沙箱权限', envHint: 'SANDBOX_ROOT' },
  { id: 'trial', label: '兜底 Key 试用', envHint: 'TRIAL_MODE_ENABLED + LLM_SERVER_API_KEY' },
  { id: 'observability', label: '运行轨迹', envHint: 'OBSERVABILITY_ENABLED' },
  { id: 'checkpoint', label: '工作区快照', envHint: 'CHECKPOINT_ENABLED' },
  { id: 'skills', label: '技能库', envHint: 'SKILL_LIBRARY_ENABLED' },
  { id: 'approval', label: '工具审批闸', envHint: '内置常开' },
  { id: 'memory', label: '记忆仓储（会话/消息）', envHint: '内置常开' },
  { id: 'modelSync', label: '上游模型同步', envHint: 'MODEL_SOURCE_URL' },
];

/** 布尔兜底：非布尔一律回落（默认偏保守 = false）。 */
function boolOf(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

/** 计数兜底：非有限数 / 负数 / 非数一律归零（绝不把脏值带进统计）。 */
function countOf(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return 0;
  return Math.floor(value);
}

/** 分组兜底：缺组 / 非对象一律当空组（不抛异常）。 */
function groupOf<T extends object>(value: unknown): Partial<T> {
  return value && typeof value === 'object' ? (value as Partial<T>) : {};
}

export class CapabilityRegistryService {
  private readonly deps: CapabilityRegistryDeps;
  /**
   * deps 是否真的被提供过。
   *
   * 整包缺失（装配层根本没喂进来）与「某一组没填」是两件事：
   *  - 整包缺失 ⇒ 什么都不宣称在跑（连内核也不报），因为没有任何事实依据；
   *  - 单组缺失 ⇒ 该组按自己的默认口径回落（内核常开的内核能力仍报常开）。
   */
  private readonly provided: boolean;

  constructor(deps: CapabilityRegistryDeps) {
    // deps 允许整体缺失：观测面不能因为配置不全而 500（见文件头性质 3）。
    this.provided = Boolean(deps) && typeof deps === 'object';
    this.deps = (deps ?? {}) as CapabilityRegistryDeps;
  }

  /**
   * 能力目录快照。
   *
   * `enabledCount` 只统计 `enabled === true` 的条目；`total` 是条目总数。
   * 两者分开返回，是为了让前端能直接显示「3 / 12 启用」，不必自己数。
   */
  list(): CapabilityRegistrySnapshot {
    const capabilities = this.buildEntries();
    return {
      capabilities,
      enabledCount: capabilities.filter((c) => c.enabled === true).length,
      total: capabilities.length,
    };
  }

  /**
   * 逐条能力算 enabled / wired / detail。
   *
   * 这里只产出「状态」，标题（label / envHint）与顺序统一由 CAPABILITY_DEFS 决定 ——
   * 两处各写一份标题，改一处忘另一处就会出现「同一个 id 两种名字」。
   */
  private buildEntries(): CapabilityEntry[] {
    const deps = this.deps;

    const judge = groupOf<{ enabled: boolean }>(deps.judge);
    const policy = groupOf<{ enabled: boolean }>(deps.policy);
    const tools = groupOf<{ count: number; enabledCount: number }>(deps.tools);
    const mcp = groupOf<{ servers: number; healthy: number }>(deps.mcp);
    const sandbox = groupOf<{ writable: boolean }>(deps.sandbox);
    const trial = groupOf<{ enabled: boolean; serverKeyConfigured: boolean }>(deps.trial);
    const approval = groupOf<{ enabled: boolean }>(deps.approval);
    const memory = groupOf<{ enabled: boolean }>(deps.memory);
    const modelSync = groupOf<{ enabled: boolean }>(deps.modelSync);
    const wiredOverride = groupOf<Partial<Record<CapabilityId, boolean>>>(deps.wired);

    /** 接线状态：主控显式覆盖优先，否则用各条自己的默认口径。 */
    const wiredOf = (id: CapabilityId, fallback: boolean): boolean => {
      const v = wiredOverride[id];
      return typeof v === 'boolean' ? v : fallback;
    };

    // 工具：注册数与启用数是两个口径，启用数被注册数夹住（不可能有"没注册却可用"的工具）。
    const toolCount = countOf(tools.count);
    const toolEnabledCount = Math.min(countOf(tools.enabledCount), toolCount);
    // MCP：同理，健康数不可能超过已配置数。
    const mcpServers = countOf(mcp.servers);
    const mcpHealthy = Math.min(countOf(mcp.healthy), mcpServers);

    const trialEnabled = boolOf(trial.enabled, false);
    const trialKeyReady = boolOf(trial.serverKeyConfigured, false);
    const sandboxWritable = boolOf(sandbox.writable, false);
    /** 内核类能力的默认口径：装配层喂了 deps 就按"内核常开"算，没喂则不宣称在跑。 */
    const kernelOn = this.provided;

    // 每条能力的状态（标题与顺序稍后由 CAPABILITY_DEFS 统一补上）。
    // 判定口径写在各自的分支里，不抽公共布尔表达式 —— 12 条规则各不相同，
    // 抽象只会把差异藏起来。
    const states: Record<CapabilityId, { enabled: boolean; wired: boolean; detail: string }> = {
      judge: {
        // 判据塔是内核：实例恒在，开关恒开（deps 仍可显式关掉，便于故障演练）。
        enabled: boolOf(judge.enabled, kernelOn) && wiredOf('judge', kernelOn),
        wired: wiredOf('judge', kernelOn),
        detail: 'L0–L3 四层判据，产出判决 r（强化内核常驻）',
      },
      policy: {
        enabled: boolOf(policy.enabled, kernelOn) && wiredOf('policy', kernelOn),
        wired: wiredOf('policy', kernelOn),
        detail: '按判决产出新版本 π，可回滚（强化内核常驻）',
      },
      tools: {
        // 铁律：0 个可用工具就是"没在跑"，不能因为注册表实例存在就报 enabled。
        enabled: toolEnabledCount > 0 && wiredOf('tools', kernelOn),
        wired: wiredOf('tools', kernelOn),
        detail: `已注册 ${toolCount} 个工具，其中 ${toolEnabledCount} 个当前可用`,
      },
      mcp: {
        // 铁律：0 个健康服务器就是"没在跑"。配置了但没连上同样不算启用。
        enabled: mcpHealthy > 0 && wiredOf('mcp', mcpServers > 0),
        wired: wiredOf('mcp', mcpServers > 0),
        detail: `已配置 ${mcpServers} 个 MCP 服务器，健康 ${mcpHealthy} 个`,
      },
      sandbox: {
        // 沙箱根由 runtime 创建，可写性来自真实写探针；不可写时写入类工具直接不能用。
        //
        // 探针的口径说明（别把这个端点说成"零副作用"）：`probeSandboxWritable`
        // 会在**工作区根目录**写一个 2 字节的瞬态文件（`.health-probe-*`）再立刻删掉。
        //
        // 探针结果按 TTL 缓存（见 utils/sandbox-probe.ts，默认 5 秒）：窗口内复用上次
        // 结论，不重复写盘。这条端点会被前端面板**频繁调用**（每次切换分区都拉一次），
        // 而探针是同步写盘、耗时完全取决于当下磁盘压力（实测空闲时 1–5ms，磁盘队列
        // 积压时可达数百毫秒）—— 若每次都真写一次，磁盘抖动会被直接放大成用户可感知
        // 的接口延迟（实测 IO 拥塞时本端点曾耗时 10s 以上）。
        //
        // 本服务自身零 IO，但**首次探测或 TTL 过期时**端点级仍会产生这一次临时写 ——
        // 另有极小概率被 checkpoint 快照捕获（回滚后残留一个陈旧探针文件，无害）。
        // 探针必须写在工作区内：写到别处就测不到"工作区挂载本身可写"这件事了。
        //
        // 别再为这个残留去加过滤规则（已实测否决）：按前缀认文件是跨模块耦合；
        // 按大小/内容过滤则既打不中（探针内容是 'ok'，2 字节，不是 0 字节），
        // 又会牺牲"空文件可被还原"这个核心能力（agent 往空文件里写内容后要退回）。
        // 维持现状 + 知情，是当前架构下代价最小的解。
        //
        // 归属说明：以上是**能力目录侧的一次决策留痕 + 代价核算**，
        // 不是 checkpoint 的语义定义，更不是"小文件该怎么处理"的既定规则 ——
        // 别把它读成规则去实现。
        enabled: sandboxWritable && wiredOf('sandbox', kernelOn),
        wired: wiredOf('sandbox', kernelOn),
        detail: sandboxWritable
          ? '沙箱根目录可写，fs.* 写入通道正常'
          : '沙箱根目录不可写（只读挂载 / 磁盘满），fs.* 写入类工具不可用',
      },
      trial: {
        // 试用要真的能用，既得开开关，也得有服务端兜底 Key —— 缺一即不可用。
        enabled: trialEnabled && trialKeyReady && wiredOf('trial', kernelOn),
        wired: wiredOf('trial', kernelOn),
        detail: !trialEnabled
          ? '试用模式未开启（TRIAL_MODE_ENABLED 未置 1）'
          : !trialKeyReady
            ? '试用模式已开启但未配置服务端兜底 Key（LLM_SERVER_API_KEY），无 BYOK Key 的用户仍无法使用'
            : '兜底 Key 可用，受试用量与三级预算闸（全局 / 每 IP / 单任务）限制',
      },
      observability: {
        enabled: boolOf(deps.observabilityEnabled, false) && wiredOf('observability', kernelOn),
        wired: wiredOf('observability', kernelOn),
        detail: 'Act / Judge / Update span 可回放（随会话删除级联清理）',
      },
      checkpoint: {
        enabled: boolOf(deps.checkpointEnabled, false) && wiredOf('checkpoint', kernelOn),
        wired: wiredOf('checkpoint', kernelOn),
        // 自动捕获已接线（agent loop 工具调用轮，在 executor.executeBatch 之前调用
        // checkpoint.capture，捕获失败被 catch 吞掉、不阻断主流程）。
        //
        // 覆盖边界必须写明，否则"自动捕获"会被读成"所有写入都被捕获"：
        // 白名单是**路径粒度**的，只认 fs.write 这类工具的 path/newPath 参数。
        // ① sys.exec（默认命令白名单含 git/node）能改工作区任意文件，但它不走
        //    fs 工具的 path 参数 —— 原理上兜不住；
        // ② MCP 工具同理，名字与参数都不在白名单口径内。
        // 这两者是路径粒度方案的**原理性上限**，不是实现缺陷（各自另有审批闸兜底）。
        //
        // 回滚语义（主控 2026-11-03 决策 (a)）：**还原被改坏的内容**，不把工作区
        // 恢复成绝对状态 —— rename 的产物不被删除（删产物是第二次破坏的风险点）。
        // 这半句必须写进来：只写「可按 id 回滚」会被读成"能撤掉这次改动"。
        detail: '每轮文件修改前自动捕获（仅 fs.write；sys.exec / MCP 工具的副作用不在覆盖范围），可按 id 回滚（还原内容，不撤销结构变更）',
      },
      skills: {
        // 默认 wired=false 是 fail-closed 的兜底口径：装配层没声明「服务已装配」时，
        // 就不宣称在跑（防"把开关当接线"）。当前 runtime 已显式传 wired.skills=true，
        // 所以运行时走的是覆盖值；这里保留 false 是为了将来有人把技能库从 runtime
        // 摘掉、却忘了传覆盖时不至于虚报"在跑"。
        enabled: boolOf(deps.skillLibraryEnabled, false) && wiredOf('skills', false),
        wired: wiredOf('skills', false),
        // 分支顺序跟着 wired 的语义走：已接线说「在跑什么」，未接线说「为什么不算在跑」。
        // 写反过一次 —— enabled=true 却显示「未确认接线」，自相矛盾。
        detail: wiredOf('skills', false)
          ? '技能列表与匹配（按描述 / 标签检索可复用解题步骤）'
          : '未确认接线（装配层未声明服务已装配）：即使开关打开也不宣称在跑',
      },
      approval: {
        enabled: boolOf(approval.enabled, kernelOn) && wiredOf('approval', kernelOn),
        wired: wiredOf('approval', kernelOn),
        detail: '高危工具按 risk / approvalMode 触发审批挑战，决策一次性写入不可篡改',
      },
      memory: {
        enabled: boolOf(memory.enabled, kernelOn) && wiredOf('memory', kernelOn),
        wired: wiredOf('memory', kernelOn),
        detail: '会话 / 消息 / 工具调用持久化（落盘位置由 AGENT_DB_PATH 决定）',
      },
      modelSync: {
        // 上游源没配时，同步服务虽在，自动拉取处于 disabled 状态（静态目录兜底）。
        enabled: boolOf(modelSync.enabled, false) && wiredOf('modelSync', kernelOn),
        wired: wiredOf('modelSync', kernelOn),
        detail: boolOf(modelSync.enabled, false)
          ? 'MODEL_SOURCE_URL 为空，自动拉取处于禁用状态（静态 provider 目录兜底）'
          : '按 MODEL_REFRESH_INTERVAL_MS 定时拉取上游模型清单并落库',
      },
    };

    // 兜底：定义表与实现必须一一对应，否则清单会静默少一项。
    // 以定义表为准组装，顺序永远是 CAPABILITY_DEFS 的顺序。
    return CAPABILITY_DEFS.map((def) => ({
      id: def.id,
      label: def.label,
      envHint: def.envHint,
      enabled: states[def.id].enabled,
      wired: states[def.id].wired,
      detail: states[def.id].detail,
    }));
  }
}
