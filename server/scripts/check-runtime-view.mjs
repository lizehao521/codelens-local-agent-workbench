#!/usr/bin/env node
/**
 * check-runtime-view.mjs — 运行期源码视图与线上源码一致性门禁。
 * 逐文件 sha256 比对 src/ 与 .runtime_view/src，报 missing/extra/differ；
 * 任一非空 exit 1，全等 exit 0。默认只读；sync 覆盖视图侧并删 extra。
 */
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, readFileSync, statSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url)); // server/
const SRC = join(ROOT, 'src');                              // 线上源码
const VIEW = join(ROOT, 'workspace', '.runtime_view', 'src'); // 运行期视图

const args = process.argv.slice(2);
const quiet = args.includes('--quiet');
const sync = args.includes('sync');
const vi = args.indexOf('--view');
if (vi >= 0 && !args[vi + 1]) { console.error('runtime-view: --view 缺少路径参数'); process.exit(2); }
const view = vi >= 0 ? args[vi + 1] : VIEW;
const src = SRC; // 源码侧固定，--view 只覆盖视图侧

function sha(p) { return createHash('sha256').update(readFileSync(p)).digest('hex'); }

function walk(dir) {
  const out = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (lstatSync(p).isSymbolicLink()) continue;
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

if (!existsSync(view) || !statSync(view).isDirectory()) {
  if (vi >= 0) {
    console.error(`runtime-view: ${view} 不存在（未同步或未部署）`);
    process.exit(2);
  }
  console.error('runtime-view: skipped (视图未部署)');
  process.exit(0);
}
function scan() {
  const s = walk(src).map(p => relative(src, p)).sort();
  const v = walk(view).map(p => relative(view, p)).sort();
  return {
    missing: s.filter(f => !v.includes(f)),
    extra: v.filter(f => !s.includes(f)),
    differ: s.filter(f => v.includes(f) && sha(join(src, f)) !== sha(join(view, f))),
  };
}
let r = scan();
if (sync) {
  for (const f of [...r.missing, ...r.differ]) {
    const d = join(view, f);
    mkdirSync(join(d, '..'), { recursive: true });
    writeFileSync(d, readFileSync(join(src, f)));
  }
  for (const f of r.extra) rmSync(join(view, f), { recursive: true, force: true });
  r = scan();
}
const bad = r.missing.length + r.extra.length + r.differ.length;
if (!quiet) {
  for (const [k, fs] of [['missing', r.missing], ['extra', r.extra], ['differ', r.differ]]) for (const f of fs) console.log(`${k}  ${f}`);
  console.log(bad > 0 ? `runtime-view drift: ${r.missing.length} missing, ${r.extra.length} extra, ${r.differ.length} differ` : 'OK: runtime view matches src');
}
process.exit(bad > 0 ? 1 : 0);
