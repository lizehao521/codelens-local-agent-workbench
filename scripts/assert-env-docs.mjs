// 静态断言（Phase 12）：README 环境变量表必须与 server/src/config/env.ts 的
// 校验 schema 键一一对应，且 .gitignore 已忽略桌面 release 产物目录。
// 运行：node scripts/assert-env-docs.mjs
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const envSource = readFileSync(path.join(root, 'server/src/config/env.ts'), 'utf8');
// envSchema 对象内的键：`  NAME: z.`（含 z.coerce / z.enum / z.string）。
const schemaKeys = [...envSource.matchAll(/^\s{2}([A-Z][A-Z0-9_]+):\s*z\./gm)].map((m) => m[1]);

const readme = readFileSync(path.join(root, 'README.md'), 'utf8');
// 只取「## 环境变量」到下一个「## 」之间的表格。
const section = (readme.split('## 环境变量')[1] ?? '').split('\n## ')[0] ?? '';
const tableKeys = [...section.matchAll(/^\|\s*`([A-Z][A-Z0-9_]+)`\s*\|/gm)].map((m) => m[1]);

const gitignore = readFileSync(path.join(root, '.gitignore'), 'utf8');

const missing = schemaKeys.filter((k) => !tableKeys.includes(k));
const extra = tableKeys.filter((k) => !schemaKeys.includes(k));

let failed = false;
if (missing.length) { console.error('README 环境变量表缺失:', missing.join(', ')); failed = true; }
if (extra.length) { console.error('README 环境变量表多余:', extra.join(', ')); failed = true; }
if (!/desktop\/release/.test(gitignore)) { console.error('.gitignore 未忽略 desktop/release'); failed = true; }

console.log(`env.ts 键数=${schemaKeys.length}，README 表项数=${tableKeys.length}`);
if (failed) process.exit(1);
console.log('OK: README env 表与 env.ts 一致，且 .gitignore 已忽略 desktop/release');