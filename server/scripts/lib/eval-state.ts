/**
 * eval-state：`workspace/eval` 的跨沙箱快照。
 *
 * `workspace/` 是 gitignore 的运行时目录，沙箱回收后修好的实现会一起消失；
 * `eval-state/` 存最近一代的实现，下一代从这里续接而不是回到缺陷版本。
 *
 * 两条路径共用这一份逻辑：seed-agent-loop 的循环轮，以及 _drive-one 的单发代际。
 * 少写一侧就会让快照停在旧代际，下一次 restore 把新修好的实现盖回去（P0-2）。
 *
 * 一致性口径（三态，不塌成 bool）：
 *   consistent — meta.treeHash 与落盘树逐字节相符；
 *   legacy     — 旧记录没有 treeHash，属于「没量过」，不是「量过且不一致」；
 *   corrupt    — 量过且不符（或 meta 声称有树而树不在），拒绝 restore。
 *   absent     — 压根没有快照，首代正常路径。
 */

import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** server 包根：本模块在 server/scripts/lib/ 下。 */
export const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export interface EvalMeasurement {
  passed: number;
  total: number;
  score: number;
}

export interface EvalStateMeta extends EvalMeasurement {
  generation: number;
  savedAt: string;
  treeHash: string;
  fileCount: number;
}

export type EvalStateStatus = 'absent' | 'legacy' | 'consistent' | 'corrupt';

export interface EvalStateInspection {
  status: EvalStateStatus;
  /** absent 时为 null；legacy 时可能只有部分字段。 */
  meta: Partial<EvalStateMeta> | null;
  /** 落盘树的实测哈希；树不存在时为 null。 */
  actualTreeHash: string | null;
  actualFileCount: number;
  detail: string;
}

export interface RestoreResult extends EvalStateInspection {
  restored: boolean;
  copied: number;
}

function stateDirOf(serverRoot: string): string {
  return path.join(serverRoot, 'eval-state');
}

function treeDirOf(serverRoot: string): string {
  return path.join(stateDirOf(serverRoot), 'eval');
}

function metaPathOf(serverRoot: string): string {
  return path.join(stateDirOf(serverRoot), 'latest.json');
}

function workspaceEvalDirOf(serverRoot: string): string {
  return path.join(serverRoot, 'workspace', 'eval');
}

function listFiles(dir: string, base: string, out: { rel: string; abs: string }[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) listFiles(abs, base, out);
    else if (entry.isFile()) {
      // 正斜杠 + 码元排序：哈希必须跨平台、跨列举顺序稳定。
      // localeCompare 会随机器 locale 改变排序，等于把判据建在环境上。
      out.push({ rel: path.relative(base, abs).split(path.sep).join('/'), abs });
    }
  }
}

/**
 * 树的规范化哈希。长度前缀 framing 避免「内容里含分隔符」造成的边界歧义。
 * 目录不存在时返回空树哈希 + 0，由调用方区分「空树」与「没有树」。
 */
export function hashEvalTree(dir: string): { treeHash: string; fileCount: number } {
  const files: { rel: string; abs: string }[] = [];
  if (existsSync(dir)) listFiles(dir, dir, files);
  files.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  const h = createHash('sha256');
  for (const f of files) {
    const bytes = readFileSync(f.abs);
    h.update(`${f.rel}\0${bytes.length}\0`, 'utf8');
    h.update(bytes);
  }
  return { treeHash: h.digest('hex'), fileCount: files.length };
}

export function copyTreeOverwrite(fromDir: string, toDir: string): number {
  let copied = 0;
  for (const entry of readdirSync(fromDir, { withFileTypes: true })) {
    const from = path.join(fromDir, entry.name);
    const to = path.join(toDir, entry.name);
    if (entry.isDirectory()) {
      mkdirSync(to, { recursive: true });
      copied += copyTreeOverwrite(from, to);
    } else {
      mkdirSync(path.dirname(to), { recursive: true });
      copyFileSync(from, to);
      copied += 1;
    }
  }
  return copied;
}

export function readEvalStateMeta(serverRoot: string = SERVER_ROOT): Partial<EvalStateMeta> | null {
  const p = metaPathOf(serverRoot);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as Partial<EvalStateMeta>;
  } catch {
    return null;
  }
}

/** 只读体检：不碰工作区，供 restore 与验收脚本共用同一份口径。 */
export function inspectEvalState(serverRoot: string = SERVER_ROOT): EvalStateInspection {
  const treeDir = treeDirOf(serverRoot);
  const metaPath = metaPathOf(serverRoot);
  const treeExists = existsSync(treeDir);
  const metaExists = existsSync(metaPath);
  const actual = treeExists ? hashEvalTree(treeDir) : { treeHash: null, fileCount: 0 };
  const base = { actualTreeHash: actual.treeHash, actualFileCount: actual.fileCount };

  if (!treeExists && !metaExists) {
    return { status: 'absent', meta: null, ...base, detail: '没有快照（首代正常路径）' };
  }

  const meta = readEvalStateMeta(serverRoot);
  if (!meta) {
    // meta 文件在但读不出来，与「旧记录没量过」是两回事，不能塌成 legacy。
    return {
      status: 'corrupt',
      meta: null,
      ...base,
      detail: `latest.json 存在但无法解析：${metaPath}`,
    };
  }

  if (typeof meta.treeHash !== 'string') {
    return {
      status: 'legacy',
      meta,
      ...base,
      detail: treeExists
        ? '旧记录没有 treeHash（没量过，不是量过且不符）；本次 restore 后重新快照即可补上'
        : '旧记录没有 treeHash，且快照树不存在',
    };
  }

  if (!treeExists) {
    return { status: 'corrupt', meta, ...base, detail: 'latest.json 声称有快照树，但 eval-state/eval 不存在' };
  }
  if (meta.treeHash !== actual.treeHash) {
    return {
      status: 'corrupt',
      meta,
      ...base,
      detail: `树哈希不符：meta=${meta.treeHash} 实测=${actual.treeHash}`,
    };
  }
  if (meta.fileCount !== actual.fileCount) {
    return {
      status: 'corrupt',
      meta,
      ...base,
      detail: `文件数不符：meta=${meta.fileCount} 实测=${actual.fileCount}`,
    };
  }
  return { status: 'consistent', meta, ...base, detail: `树哈希相符（${actual.fileCount} 个文件）` };
}

/**
 * 续接上一代实现。corrupt 时**拒绝覆盖**：宁可不续接，也不把来历不明的树
 * 盖到工作区上（那会静默毁掉本代已修好的实现）。absent 是首代正常路径。
 */
export function restoreEvalState(serverRoot: string = SERVER_ROOT): RestoreResult {
  const inspection = inspectEvalState(serverRoot);
  if (inspection.status === 'absent' || inspection.status === 'corrupt') {
    return { ...inspection, restored: false, copied: 0 };
  }
  const copied = copyTreeOverwrite(treeDirOf(serverRoot), workspaceEvalDirOf(serverRoot));
  return { ...inspection, restored: true, copied };
}

/**
 * 落盘快照。哈希与文件数都从**落盘那一份**重算，不信源目录的读数；
 * copied 与 fileCount 互相对账，不等就说明列举口径漏了东西。
 * meta 走 .part + rename，避免中途被打断留下半截 latest.json。
 */
export function snapshotEvalState(
  generation: number,
  measured: EvalMeasurement,
  serverRoot: string = SERVER_ROOT,
): EvalStateMeta | null {
  const from = workspaceEvalDirOf(serverRoot);
  if (!existsSync(from)) return null;
  const to = treeDirOf(serverRoot);
  rmSync(to, { recursive: true, force: true });
  mkdirSync(to, { recursive: true });
  const copied = copyTreeOverwrite(from, to);
  const landed = hashEvalTree(to);
  const meta: EvalStateMeta = {
    generation,
    passed: measured.passed,
    total: measured.total,
    score: measured.score,
    savedAt: new Date().toISOString(),
    treeHash: landed.treeHash,
    fileCount: landed.fileCount,
  };
  const metaPath = metaPathOf(serverRoot);
  mkdirSync(path.dirname(metaPath), { recursive: true });
  const part = `${metaPath}.part`;
  writeFileSync(part, `${JSON.stringify(meta, null, 2)}\n`, 'utf8');
  renameSync(part, metaPath);
  if (copied !== landed.fileCount) {
    console.warn(
      `  ⚠ eval-state 对账不符：copyTreeOverwrite 报 ${copied}，落盘重数 ${landed.fileCount}` +
        '（两者口径应相等，不等说明列举漏了文件）',
    );
  }
  return meta;
}

/**
 * 从证据账本取该会话已记录的最大代际。快照的 generation 标签必须与账本一致，
 * 手写会漂（曾出现账本到 g3 而 latest.json 还写 g2）。取不到返回 null，不猜。
 */
export function latestLedgerGeneration(serverRoot: string, sessionId: string): number | null {
  const p = path.join(serverRoot, 'data', 'rsi', `${sessionId}.jsonl`);
  if (!existsSync(p)) return null;
  let max = 0;
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let row: { kind?: string; payload_b64?: string };
    try {
      row = JSON.parse(line) as { kind?: string; payload_b64?: string };
    } catch {
      continue;
    }
    if (row.kind !== 'rsi_generation' || typeof row.payload_b64 !== 'string') continue;
    let payload: { generation?: unknown };
    try {
      payload = JSON.parse(Buffer.from(row.payload_b64, 'base64').toString('utf8')) as { generation?: unknown };
    } catch {
      continue;
    }
    const g = payload.generation;
    if (typeof g === 'number' && Number.isInteger(g) && g > max) max = g;
  }
  return max > 0 ? max : null;
}