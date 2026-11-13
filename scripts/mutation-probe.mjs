#!/usr/bin/env node
/**
 * 变异探针：把实现改坏，判据必须变红。
 *
 * 为什么需要它：`judge-audit.mjs` 只统计「反向断言占比」，证明不了判据有判别力；
 * 一条 `expect(...).toBe(true)` 配一条 `expect(...).toBe(false)` 也能刷到 50%。
 * 这里做的是最原始也最可信的检查：改坏源码 → 跑判据 → 期望非零退出。
 *
 * 约束：
 *   - 只接受「源串在文件里恰好出现一次」的变异，避免误改多处；
 *   - 目标文件必须 git clean，跑完在 finally 里按字节还原并校验 sha256；
 *   - 超时 180s；任何异常都先还原再退出，不把工作区留在改坏状态。
 *
 * 用法：node scripts/mutation-probe.mjs
 * 退出码：0 全部被杀 / 1 有存活变异体 / 2 环境或还原失败
 */

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = join(ROOT, 'server');
const sha = (buf) => createHash('sha256').update(buf).digest('hex');

const MUTATIONS = [
  {
    id: 'path-jail-traversal',
    file: 'src/tools/builtin/path-jail.ts',
    from: "if (relative.startsWith('..') || path.isAbsolute(relative)) {",
    to: "if (relative.startsWith('..__never__') || false) {",
    test: 'tests/sandbox-attack.test.ts',
    why: '越界检查失效后，沙箱逃逸判据必须红',
  },
  {
    id: 'checkpoint-confirm-header',
    file: 'src/controllers/checkpoints.controller.ts',
    from: 'if (typeof confirm !== \'string\' || confirm.trim() !== ROLLBACK_CONFIRM_VALUE) {',
    to: 'if (false) {',
    hits: 2,
    test: 'tests/checkpoint.service.test.ts',
    why: '确认头闸门短路后，缺头/错头的 400 判据必须红',
  },
];

function gitClean(rel) {
  const r = spawnSync('git', ['status', '--porcelain', '--', rel], {
    cwd: ROOT,
    encoding: 'utf8',
    shell: true,
  });
  return r.status === 0 && r.stdout.trim() === '';
}

let failed = 0;
let envError = false;

for (const m of MUTATIONS) {
  const abs = join(SERVER, m.file);
  if (!gitClean(join('server', m.file))) {
    console.error(`[SKIP] ${m.id}: 目标文件有未提交改动，拒绝在脏文件上做变异`);
    envError = true;
    continue;
  }

  const original = readFileSync(abs);
  const before = sha(original);
  const text = original.toString('utf8');
  const hits = text.split(m.from).length - 1;
  const expectedHits = m.hits ?? 1;
  if (hits !== expectedHits) {
    console.error(`[ERR] ${m.id}: 源串出现 ${hits} 次（要求恰好 ${expectedHits} 次），拒绝执行`);
    envError = true;
    continue;
  }

  const mutated = text.split(m.from).join(m.to);
  let result;
  try {
    writeFileSync(abs, mutated, 'utf8');
    result = spawnSync(`npx vitest run ${m.test} --reporter=dot`, {
      cwd: SERVER,
      encoding: 'utf8',
      timeout: 180_000,
      shell: true,
    });
  } finally {
    writeFileSync(abs, original);
    const after = sha(readFileSync(abs));
    if (after !== before) {
      console.error(`[ERR] ${m.id}: 还原校验失败（sha256 不一致），请立即 git checkout -- ${m.file}`);
      envError = true;
      continue;
    }
  }

  const killed = result.status !== 0;
  const timedOut = result.error?.code === 'ETIMEDOUT';
  if (killed) {
    console.log(`[KILLED] ${m.id} — ${m.why}`);
  } else {
    console.error(`[SURVIVED] ${m.id} — 判据仍绿：${m.test}（${m.why}）`);
    failed += 1;
  }
  if (timedOut) {
    console.error(`[ERR] ${m.id}: 判据超时，结果不可信`);
    envError = true;
  }
}

if (envError) process.exit(2);
if (failed > 0) {
  console.error(`变异探针：${failed}/${MUTATIONS.length} 个变异体存活`);
  process.exit(1);
}
console.log(`变异探针：${MUTATIONS.length}/${MUTATIONS.length} 个变异体全部被杀死`);
