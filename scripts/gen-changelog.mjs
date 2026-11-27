#!/usr/bin/env node
/**
 * CHANGELOG 自动生成 / 切版 CLI。
 *
 * 用法：
 *   node scripts/gen-changelog.mjs                     # 打印 Unreleased 草稿（不改文件）
 *   node scripts/gen-changelog.mjs --write             # 并进 CHANGELOG.md 的 [Unreleased]（幂等）
 *   node scripts/gen-changelog.mjs --since <ref>       # 指定起点；不写就取最近 tag，再没有就取最近 N 条
 *   node scripts/gen-changelog.mjs --limit 50          # 无 tag 时的回看条数（默认 30）
 *   node scripts/gen-changelog.mjs --release 2.32.0    # 把 [Unreleased] 冻结成正式版本段
 *
 * 设计取舍：只读 `git log` 的 %h/%s，不解析 diff —— 提交标题里的 type/scope 已经是
 * 团队约定，按 diff 猜类型只会制造噪声。解析与分组逻辑在 scripts/lib/changelog.mjs。
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  freezeRelease,
  groupCommits,
  mergeUnreleased,
  parseLatestVersion,
  renderGroups,
} from './lib/changelog.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CHANGELOG = join(ROOT, 'CHANGELOG.md');

const args = parseArgs(process.argv.slice(2));
const text = readFileSync(CHANGELOG, 'utf8');

if (args.release) {
  const date = args.date ?? new Date().toISOString().slice(0, 10);
  const next = freezeRelease(text, args.release, date);
  writeFileSync(CHANGELOG, next);
  console.log(`[changelog] 已冻结：## [${args.release}] - ${date}（新开 Unreleased）`);
  process.exit(0);
}

const { range, label } = resolveRange();
const commits = readCommits(range);
const { groups, skipped } = groupCommits(commits);
const body = renderGroups(groups);
const next = mergeUnreleased(text, body);

if (args.write) {
  writeFileSync(CHANGELOG, next);
  console.log(
    `[changelog] ${label} → ${commits.length} 条提交，${groups.length} 个分组` +
      `${skipped.length ? `，跳过 ${skipped.length}` : ''}；已写入 CHANGELOG.md`,
  );
} else {
  console.log(`[changelog] ${label} → ${commits.length} 条提交（草稿，未写入；加 --write 落盘）\n`);
  console.log(body || '（无可用提交）');
}

/** `--flag value` 解析；未知参数直接失败，避免拼错后静默跑成默认行为。 */
function parseArgs(argv) {
  const out = { write: false, release: null, since: null, limit: 30, date: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--write') out.write = true;
    else if (arg === '--release') out.release = argv[++i];
    else if (arg === '--since') out.since = argv[++i];
    else if (arg === '--date') out.date = argv[++i];
    else if (arg === '--limit') out.limit = Number(argv[++i]);
    else if (arg === '--help' || arg === '-h') {
      console.log('用法见 scripts/gen-changelog.mjs 文件头注释');
      process.exit(0);
    } else throw new Error(`未知参数：${arg}`);
  }
  if (!Number.isFinite(out.limit) || out.limit <= 0) throw new Error('--limit 必须是正整数');
  return out;
}

/** 起点优先级：--since > 与最新版本对应的 tag > 引入该版本段的提交 > 回看 --limit 条。 */
function resolveRange() {
  if (args.since) return { range: `${args.since}..HEAD`, label: `${args.since}..HEAD` };

  const latest = parseLatestVersion(text);
  const tag = latest ? findTag(latest) : null;
  if (tag) return { range: `${tag}..HEAD`, label: `${tag}..HEAD` };

  // 本仓库还没有发布标签，退一步找「谁把 `## [x.y.z]` 写进 CHANGELOG 的提交」——
  // 那就是上一次发版的落点。找不到再按条数回看，避免把已发布的提交又抄进 Unreleased。
  const anchor = latest ? findVersionAnchor(latest) : null;
  if (anchor) return { range: `${anchor}..HEAD`, label: `${anchor.slice(0, 7)}..HEAD（自 ${latest} 落点起）` };

  return { range: null, label: `最近 ${args.limit} 条提交` };
}

function findTag(version) {
  try {
    const tags = execFileSync('git', ['tag', '--list'], { cwd: ROOT, encoding: 'utf8' }).split('\n');
    return tags.map((t) => t.trim()).find((t) => t.replace(/^v/, '') === version) ?? null;
  } catch {
    return null;
  }
}

function findVersionAnchor(version) {
  try {
    // `-S` 找增删该字符串的提交；取最早一次，即该版本段落首次出现的落点。
    const out = execFileSync(
      'git',
      ['log', '--format=%H', '-S', `## [${version}]`, '--', 'CHANGELOG.md'],
      { cwd: ROOT, encoding: 'utf8' },
    )
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    return out.length > 0 ? out[out.length - 1] : null;
  } catch {
    return null;
  }
}

function readCommits(range) {
  const format = '--pretty=format:%h\t%s';
  const argv = range ? ['log', range, format] : ['log', `-n${args.limit}`, format];
  const raw = execFileSync('git', argv, { cwd: ROOT, encoding: 'utf8' });
  return raw
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [hash, ...rest] = line.split('\t');
      return { hash, subject: rest.join('\t') };
    });
}