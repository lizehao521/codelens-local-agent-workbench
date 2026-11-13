#!/usr/bin/env node
/**
 * 安装 DSH 异结构 preset（16 工程工具 + 3 辅助 + 48 技能）到 CodeLens。
 *
 * 设计：
 *   1. **文件全量落地**：skills/dsh/skills/<name>/SKILL.md 与 tools/*.mjs 原样复制，
 *      不截断、不改写——方法论文档一旦截断就失去价值。
 *   2. **技能库只存索引**：CodeLens 的技能库是 DB 行（steps ≤12 条、每条 ≤512 字），
 *      装不下 12KB 的 SKILL.md。所以每条技能写入「何时用 + 指向文件的入口 + 前几条要点」，
 *      完整内容仍以文件为准。
 *   3. **走正式 API 写入**：POST /api/v1/skills 会做密钥扫描与长度校验；
 *      脚本不直连 SQLite，避免绕过这些约束。
 *   4. **可重入**：同名技能已存在则跳过（服务端没有 update 接口）。
 *
 * 用法：
 *   node scripts/install-dsh-preset.mjs --src="<解包目录>/DSH-16工具-48技能" \
 *        --dest="<repo>/skills/dsh" --api=http://127.0.0.1:18081 [--dry-run]
 */

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

const SRC = resolve(arg('src', ''));
const DEST = resolve(arg('dest', 'skills/dsh'));
const API = arg('api', 'http://127.0.0.1:8080');
const DRY = process.argv.includes('--dry-run');
const EMIT = arg('emit', '');

if (!SRC || !existsSync(join(SRC, 'skills'))) {
  console.error(`[ERR] --src 无效：${SRC}`);
  process.exit(2);
}

// 与 skill-library.service.ts 的 SECRET_PATTERNS 保持一致（拒写而非脱敏）。
const SECRETS = [
  /\bsk-[A-Za-z0-9_-]{16,}\b/,
  /\b[A-Za-z0-9_-]{32,}\b/,
  /\b(?:api[_-]?key|secret|token|password)\s*[:=]\s*\S+/i,
];
const hitsSecret = (s) => SECRETS.some((re) => re.test(s));

/** 解析 SKILL.md：frontmatter + 正文要点。 */
function parseSkill(mdRaw, dir) {
  const md = mdRaw.replace(/^\uFEFF/, '');
  const m = md.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  const fm = m ? m[1] : '';
  const body = m ? md.slice(m[0].length) : md;
  const fmLines = fm.split(/\r?\n/);
  const field = (key) => {
    const line = fmLines.find((l) => l.startsWith(`${key}:`));
    return line ? line.slice(key.length + 1).trim().replace(/^["']|["']$/g, '') : '';
  };
  const list = (key) => {
    const line = fmLines.find((l) => l.trim().startsWith(`${key}:`));
    if (!line) return [];
    const inner = line.slice(line.indexOf('[') + 1, line.lastIndexOf(']'));
    return inner.split(',').map((s) => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
  };

  const tags = [...new Set([...list('tags'), ...list('triggers')])].slice(0, 16);

  // 要点：优先「核心能力 / 流程 / 步骤」小节里的列表项，否则全文前若干条。
  const section = body.split(/\n##\s+/).find((sec) => /(核心能力|流程|步骤|怎么用|执行)/.test(sec.slice(0, 20)));
  const source = section ?? body;
  const bullets = source
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /^([-*]|\d+\.)\s+/.test(l))
    .map((l) => l.replace(/^([-*]|\d+\.)\s+/, '').replace(/\*\*/g, '').trim())
    .filter((l) => l.length > 0 && !l.startsWith('>'));

  const steps = [
    `读取 skills/dsh/skills/${dir}/SKILL.md 获取完整方法`,
    ...bullets,
  ]
    .filter((s) => s.length <= 512)
    .slice(0, 12);

  return {
    name: field('name'),
    description: field('description').slice(0, 512),
    tags,
    steps,
  };
}

// ── 1. 文件落地 ────────────────────────────────────────────────────────────
const destSkills = join(DEST, 'skills');
const destTools = join(DEST, 'tools');
if (!DRY && !process.argv.includes('--skip-copy')) {
  mkdirSync(destSkills, { recursive: true });
  cpSync(join(SRC, 'skills'), destSkills, { recursive: true });
  if (existsSync(join(SRC, 'tools'))) {
    mkdirSync(destTools, { recursive: true });
    cpSync(join(SRC, 'tools'), destTools, { recursive: true });
  }
  cpSync(join(SRC, '_README.md'), join(DEST, 'README.md'));
}

const skillDirs = readdirSync(join(SRC, 'skills'), { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name);
const toolFiles = existsSync(join(SRC, 'tools'))
  ? readdirSync(join(SRC, 'tools')).filter((f) => f.endsWith('.mjs'))
  : [];

const parsed = [];
for (const dir of skillDirs) {
  const mdPath = join(SRC, 'skills', dir, 'SKILL.md');
  if (!existsSync(mdPath)) continue;
  const skill = parseSkill(readFileSync(mdPath, 'utf8'), dir);
  if (!skill.name) skill.name = dir;
  parsed.push(skill);
}

// ── 2. 写入技能库（正式 API）─────────────────────────────────────────────
let created = 0;
let skipped = 0;
const rejected = [];

if (EMIT) {
  writeFileSync(resolve(EMIT), JSON.stringify(parsed, null, 2) + '\n', 'utf8');
  console.log(JSON.stringify({ emitted: parsed.length, path: resolve(EMIT) }, null, 2));
  process.exit(0);
}

if (!DRY) {
  const existing = new Set();
  try {
    const res = await fetch(`${API}/api/v1/skills?limit=200`);
    const body = await res.json();
    for (const s of body.skills ?? []) existing.add(s.name);
  } catch (err) {
    console.error(`[ERR] 读取技能库失败（服务未启动？）：${err.message}`);
    process.exit(2);
  }

  for (const skill of parsed) {
    if (existing.has(skill.name)) {
      skipped += 1;
      continue;
    }
    if (skill.steps.length === 0) {
      rejected.push({ name: skill.name, reason: '没有可用步骤' });
      continue;
    }
    if (hitsSecret([skill.name, skill.description, ...skill.tags, ...skill.steps].join('\n'))) {
      rejected.push({ name: skill.name, reason: '命中密钥模式（本地预检）' });
      continue;
    }
    const res = await fetch(`${API}/api/v1/skills`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(skill),
    });
    if (res.ok) {
      created += 1;
    } else {
      const text = await res.text();
      rejected.push({ name: skill.name, reason: `${res.status} ${text.slice(0, 160)}` });
    }
  }
}

// ── 3. 清单 ────────────────────────────────────────────────────────────────
const manifest = {
  source: basename(SRC),
  installedAt: new Date().toISOString(),
  skills: parsed.map((s) => ({ name: s.name, steps: s.steps.length, tags: s.tags.length })),
  tools: toolFiles,
  counts: { skills: parsed.length, tools: toolFiles.length },
};
if (!DRY) writeFileSync(join(DEST, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');

console.log(JSON.stringify({
  dryRun: DRY,
  dest: DEST,
  parsedSkills: parsed.length,
  tools: toolFiles.length,
  created,
  skipped,
  rejected,
}, null, 2));
