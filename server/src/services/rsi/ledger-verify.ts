/**
 * RSI 证据/锚链的离线复算（`rsi-loop.md` §5、§6 点名的「独立离线校验 CLI」缺口）。
 *
 * 这里只做**复算**，不写任何东西：给一份锚链账本、每代落库的 manifest 原文、
 * 以及一个能读到证据文件的函数，就能把三层链条全部重算一遍：
 *
 *   evidence 文件字节 ──sha256──► manifest.artifacts[].sha256
 *   manifest 原文     ──sha256──► anchor.manifest_hash
 *   anchor 行字段     ──sha256──► anchor.anchor_hash，且逐行 prev 衔接
 *
 * 任一层被改动都会在这一层对不上，而不是等 krsi 从下一代起整条拒收。
 * 全部是纯函数（除传入的 readEvidence 回调），因此不需要 DB 也能单测。
 */

import { createHash } from 'node:crypto';

/** 与 `rsi-bridge.service.ts` 的 `appendAnchor` 落盘字段逐字段对应。 */
export interface AnchorLine {
  type: 'anchor';
  generation: number;
  anchor_hash: string;
  prev_anchor_hash: string | null;
  manifest_hash: string;
  verdict: string;
  exit_code: number | null;
  timestamp: number;
}

/**
 * anchor_hash 的原像。
 *
 * 注意：键序与 bridge 里的写法**必须逐字一致**，否则复算永远对不上。
 * 这也是文档里记的已知限制（还没有 canonical JSON 规范化）——本函数刻意
 * 复制现状而不是「顺手改规范」，否则历史账本会整条失效。
 */
export function anchorInputOf(line: AnchorLine): string {
  return JSON.stringify({
    prev_anchor: line.prev_anchor_hash,
    manifest_hash: line.manifest_hash,
    verdict: line.verdict,
    exit_code: line.exit_code,
    generation: line.generation,
    timestamp: line.timestamp,
  });
}

export function anchorHashOf(line: AnchorLine): string {
  return sha256(anchorInputOf(line));
}

export function sha256(body: Buffer | string): string {
  return createHash('sha256').update(body).digest('hex');
}

export interface VerifyProblem {
  generation: number | null;
  code: string;
  detail: string;
}

export interface VerifyInput {
  /** 账本里 type='anchor' 的行，按文件顺序。 */
  anchors: AnchorLine[];
  /** generation → 落库的 manifest 原文（`policy_rsi_runs.next_manifest_json`）。 */
  manifests: Map<number, string>;
  /** 读证据文件；路径来自 manifest.artifacts[].path（相对进程 cwd）。读不到返回 null。 */
  readEvidence: (relPath: string) => Buffer | null;
}

export interface VerifyReport {
  ok: boolean;
  anchorCount: number;
  generations: number[];
  problems: VerifyProblem[];
}

interface ManifestArtifact {
  path?: string;
  sha256?: string;
  bytes?: number;
}

/**
 * 逐层复算并收集问题。刻意**不提前返回**：一次把所有坏点列全，
 * 比「修一个跑一次」更适合审计。
 */
export function verifyLedger(input: VerifyInput): VerifyReport {
  const problems: VerifyProblem[] = [];
  const { anchors, manifests, readEvidence } = input;

  if (anchors.length === 0) {
    problems.push({ generation: null, code: 'ledger_empty', detail: '账本里没有任何 anchor 行，无链可验' });
    return { ok: false, anchorCount: 0, generations: [], problems };
  }

  let prev: AnchorLine | null = null;
  for (const line of anchors) {
    const gen = line.generation;

    // ① 本行自洽：字段重算必须等于落盘值
    const recomputed = anchorHashOf(line);
    if (recomputed !== line.anchor_hash) {
      problems.push({
        generation: gen,
        code: 'anchor_hash_mismatch',
        detail: `重算 ${recomputed.slice(0, 12)}… ≠ 落盘 ${String(line.anchor_hash).slice(0, 12)}…`,
      });
    }

    // ② 链式衔接：首行 prev 必须是 null，之后必须等于上一行 anchor_hash
    const expectedPrev = prev ? prev.anchor_hash : null;
    if ((line.prev_anchor_hash ?? null) !== expectedPrev) {
      problems.push({
        generation: gen,
        code: 'chain_break',
        detail: `prev_anchor_hash=${String(line.prev_anchor_hash).slice(0, 12)}… 应为 ${String(expectedPrev).slice(0, 12)}…`,
      });
    }

    // ③ 代数必须严格递增（允许历史账本从 g2 起，不强制从 1 开始）
    if (prev && gen <= prev.generation) {
      problems.push({
        generation: gen,
        code: 'generation_not_increasing',
        detail: `generation=${gen} 不大于上一行 ${prev.generation}`,
      });
    }

    // ④ manifest 原文 → manifest_hash，并复核证据产物
    const manifestJson = manifests.get(gen);
    if (manifestJson === undefined) {
      problems.push({
        generation: gen,
        code: 'manifest_unavailable',
        detail: 'policy_rsi_runs 没有该代的 next_manifest_json，链条在这一环无法复算',
      });
    } else {
      if (sha256(manifestJson) !== line.manifest_hash) {
        problems.push({
          generation: gen,
          code: 'manifest_hash_mismatch',
          detail: 'manifest 原文的 sha256 与 anchor 记录不一致（manifest 被改过或落库不完整）',
        });
      }
      for (const artifact of readArtifacts(manifestJson)) {
        const rel = artifact.path;
        if (!rel) {
          problems.push({ generation: gen, code: 'artifact_path_missing', detail: 'manifest 里有产物缺少 path' });
          continue;
        }
        const body = readEvidence(rel);
        if (!body) {
          problems.push({ generation: gen, code: 'evidence_missing', detail: `证据文件读不到：${rel}` });
          continue;
        }
        if (artifact.sha256 && sha256(body) !== artifact.sha256) {
          problems.push({ generation: gen, code: 'evidence_hash_mismatch', detail: `证据内容与 manifest 记录不一致：${rel}` });
        }
        if (typeof artifact.bytes === 'number' && body.byteLength !== artifact.bytes) {
          problems.push({
            generation: gen,
            code: 'evidence_bytes_mismatch',
            detail: `${rel} 实际 ${body.byteLength} 字节，manifest 记 ${artifact.bytes}`,
          });
        }
      }
    }

    prev = line;
  }

  return {
    ok: problems.length === 0,
    anchorCount: anchors.length,
    generations: anchors.map((a) => a.generation),
    problems,
  };
}

function readArtifacts(manifestJson: string): ManifestArtifact[] {
  try {
    const parsed = JSON.parse(manifestJson) as { artifacts?: unknown };
    return Array.isArray(parsed.artifacts) ? (parsed.artifacts as ManifestArtifact[]) : [];
  } catch {
    return [];
  }
}
