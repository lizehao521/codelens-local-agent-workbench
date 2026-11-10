/**
 * RSI 账本离线校验的复算规则（`rsi-loop.md` §5/§6 的「独立离线校验 CLI」）。
 *
 * 这里锁住的是「改任意一层都会在这一层报错」：
 *   evidence 内容 / manifest 原文 / anchor 行字段 / 链式衔接。
 * 不再依赖「下一代 krsi 拒收」这种滞后信号。
 */

import { describe, expect, it } from 'vitest';
import {
  anchorHashOf,
  anchorHashV2Of,
  canonicalJson,
  hashVersionOf,
  sha256,
  verifyLedger,
  type AnchorEvidence,
  type AnchorLine,
} from '../src/services/rsi/ledger-verify.js';
import { stampMissingHashVersion } from '../src/services/rsi/ledger-migrate.js';

interface Fixture {
  anchors: AnchorLine[];
  manifests: Map<number, string>;
  evidence: Map<string, Buffer>;
}

const EVIDENCE_TEXT = '{"sessionId":"s","generation":2,"verdicts":[]}';

function buildChain(generations: number[] = [2, 3]): Fixture {
  const anchors: AnchorLine[] = [];
  const manifests = new Map<number, string>();
  const evidence = new Map<string, Buffer>();
  let prev: string | null = null;

  for (const gen of generations) {
    const rel = `data/rsi/s-gen${gen}-evidence.json`;
    const body = Buffer.from(`${EVIDENCE_TEXT}${gen}`, 'utf8');
    evidence.set(rel, body);
    const manifestJson = JSON.stringify({
      producer: 'codelens-agentkernel',
      generation: gen,
      readings: [{ metric: 'test_pass_rate', value: 0.345, direction: 'up', basis: 1, role: 'objective' }],
      artifacts: [{ path: rel, sha256: sha256(body), bytes: body.byteLength }],
    });
    manifests.set(gen, manifestJson);
    const line: AnchorLine = {
      type: 'anchor',
      generation: gen,
      prev_anchor_hash: prev,
      manifest_hash: sha256(manifestJson),
      verdict: 'not_improved',
      exit_code: 1,
      timestamp: 1_700_000_000_000 + gen,
      anchor_hash: '',
    };
    line.anchor_hash = anchorHashOf(line);
    prev = line.anchor_hash;
    anchors.push(line);
  }
  return { anchors, manifests, evidence };
}

function verify(fixture: Fixture) {
  return verifyLedger({
    anchors: fixture.anchors,
    manifests: fixture.manifests,
    readEvidence: (rel) => fixture.evidence.get(rel) ?? null,
  });
}

/** 追一条 v2 锚点：canonical JSON + 随行落盘的 §6 证据原像。 */
function appendV2(
  fixture: Fixture,
  gen: number,
  prev: AnchorLine | null,
): AnchorLine {
  const rel = `data/rsi/s-gen${gen}-evidence.json`;
  const body = Buffer.from(`${EVIDENCE_TEXT}${gen}`, 'utf8');
  fixture.evidence.set(rel, body);
  const manifest = {
    producer: 'codelens-agentkernel',
    generation: gen,
    readings: [{ metric: 'test_pass_rate', value: 0.341, direction: 'up', basis: 1, role: 'objective' }],
    artifacts: [{ path: rel, sha256: sha256(body), bytes: body.byteLength }],
  };
  const manifestJson = JSON.stringify(manifest);
  fixture.manifests.set(gen, manifestJson);
  const prevManifest = prev
    ? (prev.evidence?.next_manifest ?? JSON.parse(fixture.manifests.get(prev.generation)!))
    : null;
  const evidence: AnchorEvidence = {
    gen,
    producer: 'codelens-agentkernel',
    prev_manifest: prevManifest,
    next_manifest: manifest,
    verdict: 'not_improved',
    exit_code: 1,
    reasons: ['R5：没有严格变好'],
    metrics: [],
    report_raw: `krsi 报告 ${gen}`,
  };
  const line: AnchorLine = {
    type: 'anchor',
    hash_version: 2,
    generation: gen,
    prev_anchor_hash: prev ? prev.anchor_hash : null,
    manifest_hash: sha256(manifestJson),
    prev_manifest_hash: prevManifest ? sha256(JSON.stringify(prevManifest)) : null,
    evidence_hash: sha256(canonicalJson(evidence)),
    evidence,
    verdict: 'not_improved',
    exit_code: 1,
    timestamp: 1_700_000_000_000 + gen,
    anchor_hash: '',
  };
  line.anchor_hash = anchorHashV2Of(line);
  // 模拟落盘再读回：JSON 往返后键序必须仍然支持复算，否则 v2 只是“写的时候能过”
  const parsed = JSON.parse(JSON.stringify(line)) as AnchorLine;
  fixture.anchors.push(parsed);
  return parsed;
}

function buildV2Chain(generations: number[] = [2, 3]): Fixture {
  const fixture: Fixture = { anchors: [], manifests: new Map(), evidence: new Map() };
  let prev: AnchorLine | null = null;
  for (const gen of generations) prev = appendV2(fixture, gen, prev);
  return fixture;
}

describe('verifyLedger', () => {
  it('完整链条全通过', () => {
    const report = verify(buildChain());
    expect(report.problems).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.generations).toEqual([2, 3]);
    // 历史行没有 hash_version → 按 v1 复算，并如实报告版本
    expect(report.versions).toEqual([1, 1]);
    expect(report.versionCounts).toEqual({ '1': 2 });
  });

  it('证据文件被改一个字节就红（evidence_hash_mismatch）', () => {
    const fixture = buildChain();
    const rel = 'data/rsi/s-gen2-evidence.json';
    fixture.evidence.set(rel, Buffer.from('{"sessionId":"s","generation":2,"verdicts":[1]}'));
    const report = verify(fixture);
    expect(report.ok).toBe(false);
    expect(report.problems.map((p) => p.code)).toContain('evidence_hash_mismatch');
    // 只该坏在这一代，不能连坐到下一代
    expect(report.problems.every((p) => p.generation === 2)).toBe(true);
  });

  it('改 anchor 行字段（verdict）会让本行哈希对不上', () => {
    const fixture = buildChain();
    fixture.anchors[1] = { ...fixture.anchors[1], verdict: 'improved' };
    const report = verify(fixture);
    expect(report.ok).toBe(false);
    expect(report.problems.map((p) => p.code)).toContain('anchor_hash_mismatch');
  });

  it('抽掉中间一代会报 chain_break', () => {
    const fixture = buildChain([2, 3, 4]);
    fixture.anchors.splice(1, 1); // 删 g3
    const report = verify(fixture);
    expect(report.ok).toBe(false);
    expect(report.problems.map((p) => p.code)).toContain('chain_break');
  });

  it('manifest 原文与落库不一致会报 manifest_hash_mismatch', () => {
    const fixture = buildChain();
    fixture.manifests.set(2, `${fixture.manifests.get(2)} `);
    const report = verify(fixture);
    expect(report.ok).toBe(false);
    expect(report.problems.map((p) => p.code)).toContain('manifest_hash_mismatch');
  });

  it('库里缺该代 manifest 时明确报 manifest_unavailable，而不是假装通过', () => {
    const fixture = buildChain();
    fixture.manifests.delete(3);
    const report = verify(fixture);
    expect(report.ok).toBe(false);
    expect(report.problems).toEqual([
      expect.objectContaining({ generation: 3, code: 'manifest_unavailable' }),
    ]);
  });

  it('空账本不算通过', () => {
    const report = verify({ anchors: [], manifests: new Map(), evidence: new Map() });
    expect(report.ok).toBe(false);
    expect(report.problems[0]?.code).toBe('ledger_empty');
  });
});

describe('verifyLedger v2（canonical JSON + §6 证据原像）', () => {
  it('v2 账本全通过，并报告用的是 v2', () => {
    const report = verify(buildV2Chain());
    expect(report.problems).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.versions).toEqual([2, 2]);
    expect(report.versionCounts).toEqual({ '2': 2 });
  });

  it('改证据原像里的 report_raw 会被抓（只改原像、不动外层也逃不掉）', () => {
    const fixture = buildV2Chain();
    fixture.anchors[0].evidence!.report_raw = '被改过的报告';
    const report = verify(fixture);
    expect(report.ok).toBe(false);
    expect(report.problems.map((p) => p.code)).toContain('evidence_preimage_mismatch');
    expect(report.problems.every((p) => p.kind === 'tamper')).toBe(true);
  });

  it('改外层 verdict 但保留旧原像会被抓（原像与外层不一致）', () => {
    const fixture = buildV2Chain();
    fixture.anchors[0] = { ...fixture.anchors[0], verdict: 'improved' };
    const report = verify(fixture);
    expect(report.ok).toBe(false);
    expect(report.problems.map((p) => p.code)).toContain('evidence_preimage_mismatch');
    expect(report.problems.map((p) => p.code)).toContain('anchor_hash_mismatch');
  });

  it('v2 行缺 §6 原像时明确报 evidence_preimage_missing', () => {
    const fixture = buildV2Chain();
    delete (fixture.anchors[0] as Partial<AnchorLine>).evidence;
    const report = verify(fixture);
    expect(report.ok).toBe(false);
    expect(report.problems.map((p) => p.code)).toContain('evidence_preimage_missing');
  });

  it('v1 与 v2 混排的账本仍能通过，并逐行报出版本', () => {
    const fixture = buildChain([2]);
    const tail = fixture.anchors[0];
    appendV2(fixture, 3, tail);
    const report = verify(fixture);
    expect(report.problems).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.versions).toEqual([1, 2]);
    expect(report.versionCounts).toEqual({ '1': 1, '2': 1 });
  });

  it('不认识的 hash_version 只报版本问题，不指控篡改', () => {
    const fixture = buildChain();
    fixture.anchors[0] = { ...fixture.anchors[0], hash_version: 3 };
    const report = verify(fixture);
    expect(report.ok).toBe(false);
    expect(report.problems.map((p) => p.code)).toEqual(['unknown_hash_version']);
    expect(report.problems[0].kind).toBe('version');
    expect(report.undecidableByVersion).toBe(true);
  });
});

describe('stampMissingHashVersion（历史行迁移）', () => {
  const textOf = (fixture: Fixture) => fixture.anchors.map((a) => JSON.stringify(a)).join('\n') + '\n';

  it('幂等：只给缺省行补 hash_version: 1，重复执行不再改', () => {
    const fixture = buildChain();
    const first = stampMissingHashVersion(textOf(fixture));
    expect(first.stamped).toBe(2);
    expect(first.alreadyVersioned).toBe(0);

    const second = stampMissingHashVersion(first.content);
    expect(second.stamped).toBe(0);
    expect(second.content).toBe(first.content);
  });

  it('迁移后的旧行仍按 v1 通过（补标记不改 anchor_hash）', () => {
    const fixture = buildChain();
    const migrated = stampMissingHashVersion(textOf(fixture));
    const anchors = migrated.content
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as AnchorLine);
    const report = verifyLedger({
      anchors,
      manifests: fixture.manifests,
      readEvidence: (rel) => fixture.evidence.get(rel) ?? null,
    });
    expect(report.ok).toBe(true);
    expect(report.versions).toEqual([1, 1]);
    expect(hashVersionOf(anchors[0])).toBe(1);
  });

  it('不动 v2 行与非 anchor 行', () => {
    const v2 = buildV2Chain([2]).anchors[0];
    const metric = JSON.stringify({ type: 'metric', seq: 1 });
    const legacy = buildChain([3]).anchors[0];
    const input = [JSON.stringify(v2), metric, JSON.stringify(legacy)].join('\n');
    const report = stampMissingHashVersion(input);
    expect(report.stamped).toBe(1);
    expect(report.alreadyVersioned).toBe(1);
    expect(report.nonAnchor).toBe(1);
    const lines = report.content.split('\n');
    expect(lines[0]).toBe(JSON.stringify(v2));
    expect(lines[1]).toBe(metric);
  });
});
