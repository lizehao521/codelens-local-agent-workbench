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
 * 哈希口径按 anchor 行的 `hash_version` 分支：
 *   · v1（缺省 / 历史行）：`JSON.stringify` 固定键序，按原实现逐字复算；
 *   · v2（新行）：canonical JSON（键字典序、紧凑、数字最短往返）+ §6 证据原像，
 *     原像本体随行落盘（`evidence`），因此不依赖库也能复算。
 * 不认识版本的行只报 `unknown_hash_version`（无法判定），**不**与篡改混为一谈。
 */

import { createHash } from 'node:crypto';

export const ANCHOR_HASH_VERSION_LEGACY = 1;
export const ANCHOR_HASH_VERSION_CANONICAL = 2;

/** §6 证据原像：v2 anchor 行内随行落盘的那一份。 */
export interface AnchorEvidence {
  gen: number;
  producer: string;
  prev_manifest: unknown | null;
  next_manifest: unknown;
  verdict: string;
  exit_code: number | null;
  reasons: string[];
  metrics: unknown[];
  report_raw: string;
}

/** 与 `rsi-bridge.service.ts` 的 `appendAnchor` 落盘字段逐字段对应。 */
export interface AnchorLine {
  type: 'anchor';
  /** 缺省视为 1：历史账本没有这个字段，不能因此判坏。 */
  hash_version?: number;
  generation: number;
  anchor_hash: string;
  prev_anchor_hash: string | null;
  manifest_hash: string;
  /** v2：上一代 manifest 的 sha256（链头为 null）。 */
  prev_manifest_hash?: string | null;
  /** v2：§6 证据原像的 canonical JSON sha256。 */
  evidence_hash?: string;
  /** v2：§6 证据原像本体。 */
  evidence?: AnchorEvidence;
  verdict: string;
  exit_code: number | null;
  timestamp: number;
}

/** 行的哈希版本；缺字段按 v1 处理（历史行）。 */
export function hashVersionOf(line: AnchorLine): number {
  return typeof line.hash_version === 'number'
    ? line.hash_version
    : ANCHOR_HASH_VERSION_LEGACY;
}

/**
 * canonical JSON：跨机器同字节的规范化。
 *
 * 规则（与 `rsi-loop.md` §6 一致）：
 *  - 对象键按字典序升序；数组保持语义顺序；
 *  - 无多余空白（compact），UTF-8 编码；
 *  - 数字用 JSON 的最短往返表示，`-0` 归一为 `0`，非有限数直接报错；
 *  - `undefined` 的对象属性视为不存在，数组元素归一为 `null`（与 JSON 语义一致）。
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  const kind = typeof value;
  if (kind === 'number') {
    const n = value as number;
    if (!Number.isFinite(n)) throw new Error('canonicalJson: 非有限数不可规范化');
    if (Object.is(n, -0)) return '0';
    return JSON.stringify(n);
  }
  if (kind === 'string' || kind === 'boolean') return JSON.stringify(value);
  if (kind === 'undefined') return 'null';
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  if (kind === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj)
      .filter((key) => obj[key] !== undefined)
      .sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(obj[key])}`).join(',')}}`;
  }
  throw new Error(`canonicalJson: 不支持的 ${kind}`);
}

/**
 * v1 anchor_hash 的原像。
 *
 * 注意：键序与 bridge 里的写法**必须逐字一致**，否则历史账本会整条失效。
 * 这是历史口径，不随 canonical JSON 改动。
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

/** v2 anchor_hash 的原像：canonical JSON，并纳入 prev manifest 与 §6 证据原像哈希。 */
export function anchorInputV2Of(line: AnchorLine): string {
  return canonicalJson({
    prev_anchor: line.prev_anchor_hash,
    manifest_hash: line.manifest_hash,
    prev_manifest_hash: line.prev_manifest_hash ?? null,
    evidence_hash: line.evidence_hash ?? null,
    verdict: line.verdict,
    exit_code: line.exit_code,
    generation: line.generation,
    timestamp: line.timestamp,
  });
}

/** v1 复算。 */
export function anchorHashOf(line: AnchorLine): string {
  return sha256(anchorInputOf(line));
}

/** v2 复算。 */
export function anchorHashV2Of(line: AnchorLine): string {
  return sha256(anchorInputV2Of(line));
}

export function sha256(body: Buffer | string): string {
  return createHash('sha256').update(body).digest('hex');
}

/**
 * 问题分类：把「真篡改」「链断」「版本不认识」「环境缺数据」分开报。
 *
 * `ok=false` 只说明「不能确认全链一致」，具体是哪一类看这里。
 */
export type VerifyProblemKind = 'tamper' | 'chain' | 'version' | 'environment';

export interface VerifyProblem {
  generation: number | null;
  code: string;
  detail: string;
  kind: VerifyProblemKind;
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
  /** 每行实际使用的哈希版本，顺序与 anchors 一致。 */
  versions: number[];
  /** 版本 → 行数，例如 `{ '1': 3, '2': 2 }`。 */
  versionCounts: Record<string, number>;
  /** 只用未知版本、没有篡改/链断等硬问题时为 true —— 结论是「无法判定」。 */
  undecidableByVersion: boolean;
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
  const versions: number[] = [];
  const versionCounts: Record<string, number> = {};

  if (anchors.length === 0) {
    problems.push({
      generation: null,
      kind: 'environment',
      code: 'ledger_empty',
      detail: '账本里没有任何 anchor 行，无链可验',
    });
    return {
      ok: false,
      anchorCount: 0,
      generations: [],
      versions: [],
      versionCounts,
      undecidableByVersion: false,
      problems,
    };
  }

  let prev: AnchorLine | null = null;
  for (const line of anchors) {
    const gen = line.generation;
    const version = hashVersionOf(line);
    versions.push(version);
    versionCounts[String(version)] = (versionCounts[String(version)] ?? 0) + 1;

    // ⓪ 版本分支：只对认识的口径做复算，未知版本明确报「无法判定」
    if (version !== ANCHOR_HASH_VERSION_LEGACY && version !== ANCHOR_HASH_VERSION_CANONICAL) {
      problems.push({
        generation: gen,
        kind: 'version',
        code: 'unknown_hash_version',
        detail: `hash_version=${String(line.hash_version)} 不在支持范围 [1, 2]；该行无法复算，不等同于篡改`,
      });
    } else if (version === ANCHOR_HASH_VERSION_LEGACY) {
      // ① 本行自洽：字段重算必须等于落盘值（历史口径）
      const recomputed = anchorHashOf(line);
      if (recomputed !== line.anchor_hash) {
        problems.push({
          generation: gen,
          kind: 'tamper',
          code: 'anchor_hash_mismatch',
          detail: `重算 ${recomputed.slice(0, 12)}… ≠ 落盘 ${String(line.anchor_hash).slice(0, 12)}…`,
        });
      }
    } else {
      verifyAnchorV2(line, problems);
    }

    // ② 链式衔接：首行 prev 必须是 null，之后必须等于上一行 anchor_hash
    //    （未知版本的行也要求衔接：版本不认识不代表可以随手指向一个不存在的上一代）
    const expectedPrev = prev ? prev.anchor_hash : null;
    if ((line.prev_anchor_hash ?? null) !== expectedPrev) {
      problems.push({
        generation: gen,
        kind: 'chain',
        code: 'chain_break',
        detail: `prev_anchor_hash=${String(line.prev_anchor_hash).slice(0, 12)}… 应为 ${String(expectedPrev).slice(0, 12)}…`,
      });
    }

    // ③ 代数必须严格递增（允许历史账本从 g2 起，不强制从 1 开始）
    if (prev && gen <= prev.generation) {
      problems.push({
        generation: gen,
        kind: 'chain',
        code: 'generation_not_increasing',
        detail: `generation=${gen} 不大于上一行 ${prev.generation}`,
      });
    }

    // ④ manifest 原文 → manifest_hash，并复核证据产物（各版本共用同一口径）
    const manifestJson = manifests.get(gen);
    if (manifestJson === undefined) {
      problems.push({
        generation: gen,
        kind: 'environment',
        code: 'manifest_unavailable',
        detail: 'policy_rsi_runs 没有该代的 next_manifest_json，链条在这一环无法复算',
      });
    } else {
      if (sha256(manifestJson) !== line.manifest_hash) {
        problems.push({
          generation: gen,
          kind: 'tamper',
          code: 'manifest_hash_mismatch',
          detail: 'manifest 原文的 sha256 与 anchor 记录不一致（manifest 被改过或落库不完整）',
        });
      }
      for (const artifact of readArtifacts(manifestJson)) {
        const rel = artifact.path;
        if (!rel) {
          problems.push({
            generation: gen,
            kind: 'environment',
            code: 'artifact_path_missing',
            detail: 'manifest 里有产物缺少 path',
          });
          continue;
        }
        const body = readEvidence(rel);
        if (!body) {
          problems.push({
            generation: gen,
            kind: 'environment',
            code: 'evidence_missing',
            detail: `证据文件读不到：${rel}`,
          });
          continue;
        }
        if (artifact.sha256 && sha256(body) !== artifact.sha256) {
          problems.push({
            generation: gen,
            kind: 'tamper',
            code: 'evidence_hash_mismatch',
            detail: `证据内容与 manifest 记录不一致：${rel}`,
          });
        }
        if (typeof artifact.bytes === 'number' && body.byteLength !== artifact.bytes) {
          problems.push({
            generation: gen,
            kind: 'tamper',
            code: 'evidence_bytes_mismatch',
            detail: `${rel} 实际 ${body.byteLength} 字节，manifest 记 ${artifact.bytes}`,
          });
        }
      }
    }

    prev = line;
  }

  const ok = problems.length === 0;
  return {
    ok,
    anchorCount: anchors.length,
    generations: anchors.map((a) => a.generation),
    versions,
    versionCounts,
    undecidableByVersion: !ok && problems.every((p) => p.kind === 'version'),
    problems,
  };
}

/** v2 anchor 行：先验 §6 证据原像，再验外层 anchor_hash。 */
function verifyAnchorV2(line: AnchorLine, problems: VerifyProblem[]): void {
  const gen = line.generation;
  const evidence = line.evidence;

  if (!evidence || typeof evidence !== 'object') {
    problems.push({
      generation: gen,
      kind: 'tamper',
      code: 'evidence_preimage_missing',
      detail: 'hash_version=2 的行缺少 §6 证据原像（evidence），无法复算',
    });
  } else {
    const recomputedEvidence = sha256(canonicalJson(evidence));
    if (recomputedEvidence !== line.evidence_hash) {
      problems.push({
        generation: gen,
        kind: 'tamper',
        code: 'evidence_preimage_mismatch',
        detail: `证据原像重算 ${recomputedEvidence.slice(0, 12)}… ≠ 落盘 ${String(line.evidence_hash).slice(0, 12)}…`,
      });
    }

    // 原像内部字段必须与外层锚点一致：否则可以保留旧原像、只改外层 verdict
    const conflicts: string[] = [];
    if (evidence.gen !== gen) conflicts.push(`gen=${String(evidence.gen)}`);
    if (evidence.verdict !== line.verdict) conflicts.push(`verdict=${String(evidence.verdict)}`);
    if ((evidence.exit_code ?? null) !== (line.exit_code ?? null)) {
      conflicts.push(`exit_code=${String(evidence.exit_code)}`);
    }
    if (sha256(JSON.stringify(evidence.next_manifest)) !== line.manifest_hash) {
      conflicts.push('next_manifest 哈希不一致');
    }
    const prevManifestHash = evidence.prev_manifest == null
      ? null
      : sha256(JSON.stringify(evidence.prev_manifest));
    if (prevManifestHash !== (line.prev_manifest_hash ?? null)) {
      conflicts.push('prev_manifest 哈希不一致');
    }
    if (conflicts.length > 0) {
      problems.push({
        generation: gen,
        kind: 'tamper',
        code: 'evidence_preimage_mismatch',
        detail: `证据原像与外层锚点不一致：${conflicts.join('、')}`,
      });
    }
  }

  const recomputed = anchorHashV2Of(line);
  if (recomputed !== line.anchor_hash) {
    problems.push({
      generation: gen,
      kind: 'tamper',
      code: 'anchor_hash_mismatch',
      detail: `重算 ${recomputed.slice(0, 12)}… ≠ 落盘 ${String(line.anchor_hash).slice(0, 12)}…`,
    });
  }
}

function readArtifacts(manifestJson: string): ManifestArtifact[] {
  try {
    const parsed = JSON.parse(manifestJson) as { artifacts?: unknown };
    return Array.isArray(parsed.artifacts) ? (parsed.artifacts as ManifestArtifact[]) : [];
  } catch {
    return [];
  }
}
