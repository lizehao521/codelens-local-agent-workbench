/**
 * 给「自我迭代 Agent」的反馈基础设施。
 *
 * 背景：这个 Agent（提名缺口 + 写判据）此前反复犯同一类错——
 *   · 编造不存在的字段（error.matches），被 A2 编译闸以 TS2339 拒；
 *   · 把「现状就对」的行为写成缺陷题，被自证红闸拒；
 *   · 把「要新增字段」的需求标成 defect。
 * 每一次它都看不到「上次为什么被拒」——每轮从零开始，于是不断重复。
 *
 * 这里做两件事：
 *   1) 冻结事实锚点：工具返回值契约原文，防止它再发明字段；
 *   2) 拒绝账本：把每次被拒的**具体**证据（错误码 / 错误行 / 失败断言）落盘，
 *      下一轮原样回灌进提示词。反馈必须具体到能照着改，不能只说「再想想」。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const SERVER = path.resolve(HERE, '..', '..');

/** 拒绝账本默认位置：仓库根的 .self-upgrade（与 proposals.jsonl 同级，Agent 自己写不到）。 */
export const FEEDBACK_FILE =
  process.env.RSI_FEEDBACK_FILE ?? path.join(SERVER, '..', '.self-upgrade', 'rejections.jsonl');

/** 工具返回值契约——源文件 src/types/tool.ts 的 ToolOutcome，原样冻结，不随提示词漂移。 */
export const TOOL_CONTRACT = `工具调用的返回值是 ToolOutcome，字段**只有**这些（没有别的）：
{ ok: boolean; summary: string; data?: Record<string, unknown>;
  error?: { code: string; kind: ToolErrorKind; message: string; suggestion?: string; retryable?: boolean } }
→ error 上**没有** matches / line / col / details / reason / context 这类字段。
  判据里写 error.matches 会直接编译失败（TS2339），整份判据作废。
→ 想断言定位信息，只能用 error.message 的内容，或 data 上**当前已经存在**的键。
→ 如果你需要「新增一个字段」才测得出来，那它就是 capability，不是 defect。
→ error.kind 是**锁定枚举**，只能取这 10 个值（写成别的会 TS2322，整份判据陪葬）：
  invalid_args / not_found / security / timeout / rate_limit / network / upstream / mcp / circuit_open / internal
  不要发明 precondition_failed 这类"更贴切"的名字 —— 枚举锁死，改不了。
→ summary 是给人看的描述，**不要断言它的文案**。'deleted' 和「已删除」是同义的，
  钉死文案会逼实现改语言来迎合判据（实测发生过：中文摘要被改成英文）。
  要证明行为成立，断言 ok / 文件或目录真的变了 / data 上的键。
→ 同一种失败可能合理地对应多个 kind。拿不准时断言 ok=false + error 存在，
  或断言 kind 属于一个合法集合，不要钉死单个值。`;

export type RejectStage =
  | 'propose'
  | 'author-compile'
  | 'author-baseline'
  | 'adopt-a2'
  | 'adopt-a3'
  | 'adopt-a4';

export interface Rejection {
  /** 提议/候选 id */
  id: string;
  stage: RejectStage;
  /** 机器可判的短码：TS2339 / GREEN_BASELINE / PREMATURE / NO_LINE_EVIDENCE … */
  code: string;
  /** 具体证据：错误行、失败断言名、闸的原话。要能让下一轮照着改。 */
  detail: string;
  /** 下一步必须怎么改（祈使句，可执行）。 */
  fix: string;
  at?: string;
}

/** 追加一条拒绝记录。失败不影响主流程（反馈是增强，不是依赖）。 */
export function appendRejection(r: Rejection, file: string = FEEDBACK_FILE): void {
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    const row: Rejection = { ...r, at: r.at ?? new Date().toISOString() };
    appendFileSync(file, JSON.stringify(row) + '\n', 'utf8');
  } catch {
    /* 账本写不进去不该让整轮崩掉 */
  }
}

/** 读最近 limit 条拒绝记录（新的在后）。坏行跳过。 */
export function readRejections(limit = 5, file: string = FEEDBACK_FILE): Rejection[] {
  if (!existsSync(file)) return [];
  let raw = '';
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const out: Rejection[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const o = JSON.parse(line) as Rejection;
      if (o && typeof o.id === 'string' && typeof o.detail === 'string') out.push(o);
    } catch {
      /* 跳过坏行 */
    }
  }
  return out.slice(-limit);
}

/** 把拒绝记录格式化成提示词片段（纯函数，便于单测）。 */
export function formatRejections(list: Rejection[], limit = 5): string {
  const picked = list.slice(-limit);
  if (picked.length === 0) return '（暂无被拒记录——这是干净的第一轮，别自己制造新错法。）';
  const lines = picked.map((r, i) => {
    const detail = r.detail.replace(/\s+/g, ' ').slice(0, 220);
    const fix = r.fix.replace(/\s+/g, ' ').slice(0, 160);
    return `${i + 1}. [${r.stage}/${r.code}] ${r.id}：${detail}\n   必须这样改：${fix}`;
  });
  return `最近 ${picked.length} 次被拒（硬事实，同一错法再犯就是浪费一轮）：\n${lines.join('\n')}`;
}

/** 便捷入口：直接拿到可注入提示词的「最近错题」文本。 */
export function recentRejections(limit = 5, file: string = FEEDBACK_FILE): string {
  return formatRejections(readRejections(limit, file), limit);
}

/**
 * 某条提议在**出题阶段**累计失败次数（判据编译不过 / 自证基线红不过）。
 *
 * 为什么需要：出题失败时会把候选文件删掉、只留 draft，下一轮幂等检查
 * （「三件齐全才跳过」）就不再跳过它——于是同一条死题每轮都被重出一遍。
 * 实测 orphan-tool-gate 连续两轮重出、两次作废，纯烧 token。
 * 这个计数让「同一错法重复几次」变成可判定的淘汰条件。
 */
export function authorFailures(id: string, file: string = FEEDBACK_FILE): number {
  return readRejections(Number.MAX_SAFE_INTEGER, file).filter(
    (r) => r.id === id && (r.stage === 'author-compile' || r.stage === 'author-baseline'),
  ).length;
}

/** 是否已判定为「死题」：出题阶段已失败 max 次，再跑只是重复烧 token。 */
export function isExhausted(id: string, max = 2, file: string = FEEDBACK_FILE): boolean {
  return authorFailures(id, file) >= max;
}

// ─────────────────────────────────────────────────────────────────────────────
// 正例库：错题本只说明「别怎么做」，模型仍然不知道「该怎么做」。
// 实测：同一模型在没有任何成功样例时，写出的 defect 反复落在「要新字段」上；
// 而「删目录不校验 recursive」这条真正过闸的提议，恰好符合一种可复制的形状——
// 现有 API 已接受某参数，但某条分支忘了校验它。把这类成功案例冻结成样例回灌，
// 比再写十条禁令有效。
// ─────────────────────────────────────────────────────────────────────────────

/** 正例默认位置：与错题本同级。 */
export const EXEMPLAR_FILE =
  process.env.RSI_EXEMPLAR_FILE ?? path.join(SERVER, '..', '.self-upgrade', 'exemplars.jsonl');

export interface Exemplar {
  /** 提议 id */
  id: string;
  title: string;
  gapType: 'defect' | 'capability';
  targetFile: string;
  /** 带行号的具体证据，原样保留——这是正例最值钱的部分。 */
  evidence: string[];
  observable: string;
  /** 它过了哪几道闸（自证红 / A1–A4 / 采纳后判据绿），让模型知道「这条是真的」 */
  passed: string[];
  at?: string;
}

/**
 * 「不配当正例」的拒绝码：出现任一条，说明**题目本身站不住**，不是一次成功。
 *
 * 为什么要有这道闸：`fs-read-maxbytes-default-mismatch` 先被采纳、后判 `DIRECTION_INVERTED`
 * 撤回，但它的正例已经在采纳那一刻就写进了库——于是下一轮 propose 把一条**方向判反**的提议
 * 当成功样例回灌，等于教模型学错方向。正例库比错题本更危险：错题本说「别这样」，
 * 正例库说「就照这样」。所以写入要拦，读取也要滤（清存量脏数据）。
 */
export const FATAL_REJECTION_CODES = new Set([
  'DIRECTION_INVERTED', // 方向判反：结论与靶子里的动机注释/ADR 相反
  'GREEN_BASELINE', // 判据在现状上就是绿的，不是真缺陷
  'PREMATURE', // 判据没走到被测行为就被挡住
  'A2_5_PROBE_INVALID', // 探针调用不合法，题没验过
  'TS2339', // 判据编译不过（下面几个同理）
  'TS2322',
  'TS2345',
]);

/** 该提议是否还够格当正例（未背上致命拒绝）。 */
export function isExemplarEligible(id: string, rejFile: string = FEEDBACK_FILE): boolean {
  return !readRejections(Number.MAX_SAFE_INTEGER, rejFile).some(
    (r) => r.id === id && FATAL_REJECTION_CODES.has(r.code),
  );
}

/** 追加一条正例。不配当正例的直接拒写；失败静默（反馈是增强，不是依赖）。 */
export function appendExemplar(
  e: Exemplar,
  file: string = EXEMPLAR_FILE,
  rejFile: string = FEEDBACK_FILE,
): boolean {
  if (!isExemplarEligible(e.id, rejFile)) return false;
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    appendFileSync(file, JSON.stringify({ ...e, at: e.at ?? new Date().toISOString() }) + '\n', 'utf8');
    return true;
  } catch {
    /* 写不进去不影响主流程 */
    return false;
  }
}

/**
 * 读最近 limit 条正例（新的在后）。坏行跳过。
 * 两条净化：① 剔除已背致命拒绝的 id（含历史脏数据）；② 同 id 只留最新一条。
 */
export function readExemplars(
  limit = 2,
  file: string = EXEMPLAR_FILE,
  rejFile: string = FEEDBACK_FILE,
): Exemplar[] {
  if (!existsSync(file)) return [];
  let raw = '';
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const rows: Exemplar[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const o = JSON.parse(line) as Exemplar;
      if (o && typeof o.id === 'string' && Array.isArray(o.evidence)) rows.push(o);
    } catch {
      /* 跳过坏行 */
    }
  }
  // 从后往前取，同 id 只认最新一条；再反转回「新的在后」。
  const seen = new Set<string>();
  const deduped: Exemplar[] = [];
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i];
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    deduped.push(r);
  }
  deduped.reverse();
  const clean = deduped.filter((e) => isExemplarEligible(e.id, rejFile));
  return clean.slice(-limit);
}

/** 把正例格式化成提示词片段（纯函数，便于单测）。 */
export function formatExemplars(list: Exemplar[], limit = 2): string {
  const picked = list.slice(-limit);
  if (picked.length === 0) return '（暂无成功样例——那就严格照下面「defect 原型」的形状找。）';
  const blocks = picked.map((e, i) => {
    const ev = e.evidence
      .slice(0, 3)
      .map((x) => `     - ${x.replace(/\s+/g, ' ').slice(0, 180)}`)
      .join('\n');
    return `${i + 1}. ${e.title}（${e.gapType}，靶子 ${e.targetFile}）
   证据：
${ev}
   可观察项：${e.observable.replace(/\s+/g, ' ').slice(0, 160)}
   已通过：${e.passed.join(' / ')}`;
  });
  return `下面 ${picked.length} 条是**真正被采纳过**的提议。注意它们的共同形状：
不是「加个新字段」，而是「现有参数在某个输入下没被正确处理」。
${blocks.join('\n\n')}`;
}

/** 便捷入口：拿到可注入提示词的「成功样例」文本。 */
export function recentExemplars(
  limit = 2,
  file: string = EXEMPLAR_FILE,
  rejFile: string = FEEDBACK_FILE,
): string {
  return formatExemplars(readExemplars(limit, file, rejFile), limit);
}
