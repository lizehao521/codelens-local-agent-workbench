/**
 * change-domain.ts — 自我迭代的「权限范围与边界」。
 *
 * ── 它回答什么问题 ────────────────────────────────────────
 * 「系统可以改自己」，但**改到哪一层要谁点头**，必须机器可查，而不是靠一句「注意安全」。
 * 在这之前，边界只有一个维度：`allowed` 白名单（能不能改这几个文件）。
 * 那不足以支撑「调整核心内容与核心架构」——因为改 `src/tools/` 里一个工具，
 * 和改目录结构 / 改关键接口 / 改判据，风险差三个数量级，却用同一种白名单表达。
 *
 * 所以这里引入**变更域（domain）**：按「改的东西离判据有多近」分级。
 * 越靠近判据，审批越重，可自动化程度越低。
 *
 * ── 五个域 ───────────────────────────────────────────────
 *   D0 只读      —— 不改任何东西（用于纯评估轮）
 *   D1 工具层    —— src/tools/、src/utils/ 等叶子能力：判据 + 围栏过了就成立（可全自动）
 *   D2 服务层    —— src/services/ 非判据部分、src/controllers/、src/routes/：首次需人确认
 *   D3 架构层    —— 目录结构、关键接口、依赖清单、schema：**每次都要人确认**
 *   D4 判据层    —— tests/、krsi/、judge/、rsi/、eval/、scripts/：**禁止自动改**
 *
 * D4 不是「高风险」，是**不属于被衡量者**。允许它改判据，等于让它自己发通行证，
 * 外置判据的全部意义就没了（这也是 `rules-contract.ts` 的 outOfScope 一直守着的线）。
 *
 * ── 与既有机制的关系 ──────────────────────────────────────
 * 域不替代 `allowed` 白名单，而是**白名单的上位约束**：
 *   · `allowed` 说「这一轮打算改这几个文件」；
 *   · 域说「改这几个文件需要谁批准、最多改几个」。
 * 两者同时满足才放行。这样既保留了原有围栏的逐文件哈希校验，又能表达分级授权。
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export type ChangeDomainId = 'D0' | 'D1' | 'D2' | 'D3' | 'D4';

/** 触发方式。不同触发方式允许的最高域不同——无人值守时不该碰架构。 */
export type IterationTrigger =
  | 'manual' // 人点
  | 'schedule' // 定时
  | 'failure-accumulation' // 同一归因层连续失败累计
  | 'threshold-breach' // L0 指标跌破阈值
  | 'charter-drift'; // 宣言/判据契约版本变化

export interface ChangeDomain {
  id: ChangeDomainId;
  label: string;
  /** 命中即属于该域（相对仓库 server/ 的路径前缀或正则）。顺序即优先级：先命中先归。 */
  match: RegExp[];
  /** 是否必须人工批准。 */
  requiresHumanApproval: boolean;
  /** 单轮最多改动文件数。0 = 只读。 */
  maxFiles: number;
  /** 允许由哪些触发方式进入（不含 manual，manual 永远允许）。 */
  autoAllowedBy: IterationTrigger[];
  /** 一句话说明这条边界的理由。 */
  rationale: string;
}

/**
 * 域表。**顺序即优先级**：从最靠近判据（D4）往外排，先命中先归。
 * 放在最前面是因为「一个文件同时落在 tests/ 和 src/ 前缀下」时，必须按更严的判。
 */
export const CHANGE_DOMAINS: readonly ChangeDomain[] = [
  {
    id: 'D4',
    label: '判据层（禁止自动改）',
    match: [
      /^tests\//, /^krsi\//, /^src\/services\/judge\//, /^src\/services\/rsi\//, /^src\/services\/eval\//,
      /^scripts\//, /^self-upgrade\//, /^vitest\.config\./,
      // 前端判据同样是尺子：client/tests/** 与任何 *.test.ts(x)
      /^client\/tests\//, /^client\/\S*\.test\.tsx?$/,
    ],
    requiresHumanApproval: true,
    maxFiles: 0,
    autoAllowedBy: [],
    rationale: '改判据等于给自己发通行证。这一层只能由人提交，任何自动迭代都不得触碰。',
  },
  {
    id: 'D3',
    label: '架构层（每次需人批）',
    match: [
      /^package\.json$/,
      /^tsconfig\.json$/,
      /^src\/app\.ts$/,
      /^src\/config\//,
      /^src\/db\//,
      /^src\/types\//,
      /^src\/middlewares\//,
      /^src\/routes\/index\.ts$/,
      // 前端架构：入口、构建配置、依赖清单。改这些影响面超出单个组件。
      /^client\/src\/App\.tsx$/, /^client\/src\/main\.tsx$/, /^client\/package\.json$/,
      /^client\/vite\.config\.ts$/, /^client\/tsconfig[^/]*\.json$/, /^client\/index\.html$/,
      /^client\/src\/styles\//,
    ],
    requiresHumanApproval: true,
    maxFiles: 12,
    autoAllowedBy: [],
    rationale: '目录、依赖、类型契约、路由汇总一旦改动，影响面超出单个能力；无人值守不该碰。',
  },
  {
    id: 'D2',
    label: '服务层（首次需人批）',
    match: [
      /^src\/services\/(?!judge\/|rsi\/|eval\/)/, /^src\/controllers\//, /^src\/routes\/(?!index\.ts$)/, /^src\/providers\//,
      // 前端服务层：hooks / lib / services / stores —— 组件靠它们，改错牵连多个界面
      /^client\/src\/hooks\//, /^client\/src\/lib\//, /^client\/src\/services\//, /^client\/src\/stores\//,
    ],
    requiresHumanApproval: true,
    maxFiles: 8,
    autoAllowedBy: ['manual'],
    rationale: '服务层承载业务语义，改错会让多个工具同时失效；首次改动要人确认方向，之后同类改动可自动。',
  },
  {
    id: 'D1',
    label: '工具层（可全自动）',
    match: [
      /^src\/tools\//, /^src\/utils\//,
      // 前端叶子组件：影响面被组件自身的判据框住，可以全自动
      /^client\/src\/components\//,
    ],
    requiresHumanApproval: false,
    maxFiles: 6,
    autoAllowedBy: ['manual', 'schedule', 'failure-accumulation', 'threshold-breach', 'charter-drift'],
    rationale: '叶子能力：影响面被单个工具的判据框住，判据 + 围栏能兜住，可以全自动。',
  },
  {
    id: 'D0',
    label: '只读（不改任何文件）',
    match: [/^$/],
    requiresHumanApproval: false,
    maxFiles: 0,
    autoAllowedBy: ['manual', 'schedule', 'failure-accumulation', 'threshold-breach', 'charter-drift'],
    rationale: '纯评估轮：只跑判据、只落读数，不产生任何写操作。',
  },
];

/**
 * 路径规范化。
 *
 * 输入有两种口径：`allowed` 是相对 server/ 的（`src/tools/x.ts`），
 * 而前端靶子是相对仓库根的（`../client/src/components/X.tsx`）。
 * 域表用两套前缀（`src/...` 与 `client/...`）表达，所以这里先把 `../client/` 收敛成 `client/`，
 * 否则前端文件一条规则都匹配不到 —— 一个不报错、只是悄悄放行的洞。
 */
function normalizePath(raw: string): string {
  const f = raw.replace(/\\/g, '/').replace(/^\.\//, '');
  return f.startsWith('../client/') ? f.slice('../'.length) : f;
}

const byId = (id: ChangeDomainId): ChangeDomain => {
  const found = CHANGE_DOMAINS.find((d) => d.id === id);
  if (!found) throw new Error(`未知变更域：${id}`);
  return found;
};

/**
 * 把一组文件归到最严的域。
 *
 * 「最严」= 编号最大（D4 > D3 > D2 > D1）。空列表归 D0。
 */
export function resolveDomain(files: readonly string[]): ChangeDomainId {
  return resolveDomainDetail(files).domain;
}

/**
 * 同 `resolveDomain`，但额外返回**未登记在域表里的路径**。
 *
 * 这个返回值是 fail-closed 的关键：域表没覆盖到的路径（新目录、别人新建的包）
 * 如果安静地落到 D0（只读、无需审批），就等于给了一个"没人管"的放行通道。
 * 所以未登记路径一律按 D3 处理并要求人批，由 `checkDomain` 点名。
 */
export function resolveDomainDetail(files: readonly string[]): { domain: ChangeDomainId; unmatched: string[] } {
  if (files.length === 0) return { domain: 'D0', unmatched: [] };
  let worst: ChangeDomainId = 'D0';
  const unmatched: string[] = [];
  const rank: Record<ChangeDomainId, number> = { D0: 0, D1: 1, D2: 2, D3: 3, D4: 4 };
  for (const raw of files) {
    const f = normalizePath(raw);
    let hit = false;
    for (const d of CHANGE_DOMAINS) {
      if (d.match.some((re) => re.test(f))) {
        if (rank[d.id] > rank[worst]) worst = d.id;
        hit = true;
        break; // 先命中先归：D4 在前面，命中就不再降级
      }
    }
    if (!hit) {
      unmatched.push(f);
      // 未登记 ≠ 安全：按架构层处理（需人批），而不是按只读层放行
      if (rank.D3 > rank[worst]) worst = 'D3';
    }
  }
  return { domain: worst, unmatched };
}

export interface DomainCheckInput {
  files: readonly string[];
  trigger: IterationTrigger;
  /** 人是否已对这一轮明确批准（含批量预授权）。 */
  humanApproved: boolean;
}

export interface DomainCheckResult {
  ok: boolean;
  domain: ChangeDomainId;
  domainLabel: string;
  /** 拒绝理由（ok=false 时非空），按判据逐条列出，便于前端原样展示。 */
  reasons: string[];
  /** 需要人做什么才能放行。 */
  required?: 'human-approval';
  limits: { maxFiles: number; fileCount: number };
}

/**
 * 权限判定。**只做机械判定，不猜意图。**
 *
 * 五条规则，任一不满足即拒绝：
 *   1. 文件数不得超过该域上限（防止「在低域里夹带大量改动」）
 *   2. D4 一律拒绝（不管谁批、什么触发）
 *   3. 触发方式必须在该域的 autoAllowedBy 里（无人值守不能碰服务层以上）
 *   4. requiresHumanApproval 的域，必须 humanApproved
 *   5. 空文件列表只允许 D0
 */
export function checkDomain(input: DomainCheckInput): DomainCheckResult {
  const files = input.files.map((f) => f.replace(/\\/g, '/').replace(/^\.\//, ''));
  // 用 Detail 版拿到未登记路径：域表漏掉一个目录，就等于给它开一条无人管的通道。
  const detail = resolveDomainDetail(files);
  const domain = detail.domain;
  const def = byId(domain);
  const reasons: string[] = [];

  if (detail.unmatched.length > 0) {
    reasons.push(
      `未登记在变更域表中的路径（按 D3 架构层处理，需要人工批准）：${detail.unmatched.join('、')}`,
    );
  }

  if (domain === 'D4') {
    reasons.push(`${def.label}：${def.rationale}`);
  }
  if (files.length > def.maxFiles && def.maxFiles > 0) {
    reasons.push(`文件数 ${files.length} 超过 ${def.label} 上限 ${def.maxFiles}`);
  }
  if (domain !== 'D4' && def.autoAllowedBy.length === 0) {
    reasons.push(`${def.label} 不接受任何自动触发（只允许人工发起）`);
  }
  if (input.trigger !== 'manual' && domain !== 'D4' && !def.autoAllowedBy.includes(input.trigger)) {
    reasons.push(`触发方式 ${input.trigger} 不允许进入 ${def.label}（允许：${def.autoAllowedBy.join(', ') || '无'}）`);
  }
  if (def.requiresHumanApproval && !input.humanApproved) {
    reasons.push(`${def.label} 需要人工批准（当前未批准）`);
  }

  return {
    ok: reasons.length === 0,
    domain,
    domainLabel: def.label,
    reasons,
    required: def.requiresHumanApproval && !input.humanApproved ? 'human-approval' : undefined,
    limits: { maxFiles: def.maxFiles, fileCount: files.length },
  };
}

// ── 回滚点：每轮开始前留一个可精确恢复的快照 ────────────────────────────────

export interface RollbackPoint {
  id: string;
  createdAt: string;
  /** git commit sha（若仓库可用）。 */
  commit: string | null;
  /** 无 git 时的兜底：被改动文件的原文快照（相对路径 → 内容）。 */
  fileSnapshots: Record<string, string | null>;
}

/**
 * 打回滚点。
 *
 * 为什么同时存 git sha 和文件快照：git 是最省空间、最完整的恢复手段，
 * 但沙箱环境里不一定有 git（也可能是干净仓库没有权限提交）。
 * 两条腿都留着，回滚时优先用 git，不可用则按快照逐文件写回。
 *
 * **只快照这一轮允许改的文件**，不整仓快照——整仓快照在几万文件的仓库上不现实，
 * 而且回滚时也不该动这一轮没碰过的东西。
 */
export function createRollbackPoint(opts: {
  id: string;
  root: string;
  files: readonly string[];
  git?: boolean;
}): RollbackPoint {
  const { id, root, files } = opts;
  const useGit = opts.git !== false;

  let commit: string | null = null;
  if (useGit) {
    try {
      const out = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', timeout: 10_000 });
      commit = out.trim() || null;
    } catch {
      commit = null; // 无 git：退回纯快照模式，不是错误
    }
  }

  const fileSnapshots: Record<string, string | null> = {};
  for (const rel of files) {
    const abs = path.join(root, rel);
    try {
      fileSnapshots[rel] = existsSync(abs) ? readFileSync(abs, 'utf8') : null;
    } catch {
      fileSnapshots[rel] = null;
    }
  }

  return { id, createdAt: new Date().toISOString(), commit, fileSnapshots };
}

export interface RollbackResult {
  ok: boolean;
  restored: string[];
  failed: { file: string; reason: string }[];
  via: 'git' | 'snapshot';
}

/**
 * 回滚到某个回滚点。
 *
 * 只恢复快照里记录过的文件——**回滚不是"撤销一切"**，
 * 是把这一轮动过的靶子还原；这一轮之外的改动（比如别人同时提交的）不能被误伤。
 */
export function rollbackTo(point: RollbackPoint, root: string): RollbackResult {
  const restored: string[] = [];
  const failed: { file: string; reason: string }[] = [];

  // 优先 git：能一次性还原内容与权限位。
  if (point.commit) {
    const fileList = Object.keys(point.fileSnapshots);
    try {
      if (fileList.length > 0) {
        execFileSync('git', ['checkout', point.commit, '--', ...fileList], {
          cwd: root,
          encoding: 'utf8',
          timeout: 60_000,
        });
        return { ok: true, restored: fileList, failed: [], via: 'git' };
      }
      return { ok: true, restored: [], failed: [], via: 'git' };
    } catch {
      // git 失败就走快照，不直接报错——沙箱里 git 可能不可用
    }
  }

  for (const [rel, content] of Object.entries(point.fileSnapshots)) {
    const abs = path.join(root, rel);
    try {
      if (content === null) {
        // 这一轮新建的文件：回滚 = 删除（它原本不存在）
        rmSync(abs, { force: true });
      } else {
        mkdirSync(path.dirname(abs), { recursive: true });
        writeFileSync(abs, content, 'utf8');
      }
      restored.push(rel);
    } catch (e) {
      failed.push({ file: rel, reason: e instanceof Error ? e.message : String(e) });
    }
  }

  return { ok: failed.length === 0, restored, failed, via: 'snapshot' };
}
