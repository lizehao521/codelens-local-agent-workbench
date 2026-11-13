#!/usr/bin/env node
/**
 * UI 静态卫生门禁 —— **不是设计验收**。
 *
 * 上一轮对话里，CodeLens 提了三条“最小可行静态断言”，但其中两条照抄会误伤：
 *   - 它把 `Settings` / `MessageSquare` 当旧别名（其实这俩就是规范名）；
 *   - 它没给 Token 基线哈希的存放位置，等于断言永远真。
 * 这里只保留三条**能红**的机械检查，并明确边界：像素级/交互级回归它查不出来。
 *
 *   1. 除 design-tokens.css 外，src 里不得出现硬编码颜色（#hex / rgb() / hsl()）
 *   2. 不得使用 lucide 的废弃别名（AlertTriangle / XCircle / CheckCircle2 / Loader2 / MoreHorizontal）
 *   3. design-tokens.css 的 sha256（行尾归一后）必须与基线一致（改 Token 必须显式改基线）
 *
 * 用法：
 *   node scripts/check-ui-static.mjs                 # 跑仓库
 *   node scripts/check-ui-static.mjs --self-test     # 破坏夹具：三条必须各自变红
 *   node scripts/check-ui-static.mjs --update-baseline  # 有意改 Token 后重设基线
 */

import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLIENT_ROOT = join(HERE, '..');
const SRC = join(CLIENT_ROOT, 'src');
const TOKENS = join(SRC, 'styles', 'design-tokens.css');
const BASELINE = join(HERE, 'ui-static-baseline.json');

const COLOR_RE = /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/;
const DEPRECATED_ICONS = ['AlertTriangle', 'XCircle', 'CheckCircle2', 'Loader2', 'MoreHorizontal'];
const ICON_RE = new RegExp(`\\b(${DEPRECATED_ICONS.join('|')})\\b`);

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

function scanColors(root) {
  const hits = [];
  for (const file of walk(root)) {
    if (!/\.(tsx?|css)$/.test(file)) continue;
    if (file.endsWith('design-tokens.css')) continue;
    const lines = readFileSync(file, 'utf8').split(/\r?\n/);
    lines.forEach((line, i) => {
      if (COLOR_RE.test(line)) hits.push(`${relative(root, file)}:${i + 1}: ${line.trim().slice(0, 100)}`);
    });
  }
  return hits;
}

function scanIcons(root) {
  const hits = [];
  for (const file of walk(root)) {
    if (!/\.(tsx?)$/.test(file)) continue;
    const lines = readFileSync(file, 'utf8').split(/\r?\n/);
    lines.forEach((line, i) => {
      const m = ICON_RE.exec(line);
      if (m) hits.push(`${relative(root, file)}:${i + 1}: ${m[1]}`);
    });
  }
  return hits;
}

function tokensHash(root) {
  const path = join(root, 'src', 'styles', 'design-tokens.css');
  // 先归一行尾再哈希：这条判据量的是 Token 内容，不是宿主 checkout 出来的字节。
  // 旧口径按裸字节比，而基线是在 Windows CRLF 工作区上录的（3a732216…），
  // Linux 检出的同一份 blob 是 LF（a7c2e640…）→ 内容一字未改、CI 必红。
  // 红的是尺子的口径，不是产品；.gitattributes 同时补了 *.css eol=lf 收敛工作区。
  return createHash('sha256')
    .update(readFileSync(path, 'utf8').replace(/\r\n/g, '\n'))
    .digest('hex');
}

function loadBaseline() {
  try {
    return JSON.parse(readFileSync(BASELINE, 'utf8'));
  } catch {
    return null;
  }
}

function run(root) {
  const baseline = loadBaseline();
  const checks = [];

  const colors = scanColors(join(root, 'src'));
  checks.push({ name: '硬编码颜色', ok: colors.length === 0, detail: colors });

  const icons = scanIcons(join(root, 'src'));
  checks.push({ name: 'lucide 废弃别名', ok: icons.length === 0, detail: icons });

  if (!baseline?.designTokensSha256) {
    checks.push({ name: 'Token 基线', ok: false, detail: ['缺少 scripts/ui-static-baseline.json 或其中无 designTokensSha256'] });
  } else {
    const actual = tokensHash(root);
    checks.push({
      name: 'Token 基线',
      ok: actual === baseline.designTokensSha256,
      detail: actual === baseline.designTokensSha256 ? [] : [`design-tokens.css 哈希变了：${actual}`],
    });
  }

  let failed = 0;
  for (const c of checks) {
    if (c.ok) {
      console.log(`[PASS] ${c.name}`);
    } else {
      failed += 1;
      console.log(`[FAIL] ${c.name}（${c.detail.length} 处）`);
      for (const d of c.detail.slice(0, 8)) console.log(`       ${d}`);
      if (c.detail.length > 8) console.log(`       … 其余 ${c.detail.length - 8} 处省略`);
    }
  }
  return failed;
}

function selfTest() {
  const dir = mkdtempSync(join(tmpdir(), 'ui-static-'));
  try {
    mkdirSync(join(dir, 'src', 'styles'), { recursive: true });
    writeFileSync(join(dir, 'src', 'styles', 'design-tokens.css'), ':root { --color-bg: #0b0d10; }\n');
    writeFileSync(join(dir, 'src', 'Bad.tsx'), "export const X = () => <div style={{ color: '#ff0000' }} />;\n");
    writeFileSync(join(dir, 'src', 'BadIcon.tsx'), "import { AlertTriangle } from 'lucide-react';\n");
    // 基线故意写错，第三条必须红
    writeFileSync(BASELINE, JSON.stringify({ designTokensSha256: 'deadbeef' }, null, 2) + '\n');

    const failed = run(dir);
    const ok = failed === 3;
    console.log(`[${ok ? 'PASS' : 'FAIL'}] 破坏夹具：三条检查各自变红（实际失败 ${failed}/3）`);
    return ok ? 0 : 1;
  } finally {
    rmSync(dir, { recursive: true, force: true });
    // 恢复真实基线
    const actual = tokensHash(CLIENT_ROOT);
    writeFileSync(BASELINE, JSON.stringify({ designTokensSha256: actual, updatedAt: new Date().toISOString() }, null, 2) + '\n');
  }
}

if (process.argv.includes('--update-baseline')) {
  writeFileSync(BASELINE, JSON.stringify({ designTokensSha256: tokensHash(CLIENT_ROOT), updatedAt: new Date().toISOString() }, null, 2) + '\n');
  console.log(`基线已更新：${BASELINE}`);
  process.exit(0);
}

if (process.argv.includes('--self-test')) {
  process.exit(selfTest());
}

const failed = run(CLIENT_ROOT);
console.log(failed === 0 ? 'UI 静态卫生门禁：全部通过' : `UI 静态卫生门禁：${failed} 项未通过`);
process.exit(failed === 0 ? 0 : 1);
