/**
 * N1：变异 harness 的 --dirty 通道。
 *
 * 背景：C3 自证依赖「改坏实现 → 判据必须红」，但靶子一旦有未提交改动，
 * 自动探针整批 SKIP，只能人肉注入。--dirty 把人工注入器固化：仍按字节备份、
 * 跑完 finally 还原、sha256 对账，只是不再要求 git clean。
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(process.cwd(), '..');

describe('mutation-probe --dirty', () => {
  it('帮助文本声明 --dirty 的还原纪律', () => {
    const src = readFileSync(path.join(ROOT, 'scripts', 'mutation-probe.mjs'), 'utf8');
    expect(src).toContain('--dirty');
    expect(src).toContain('[DIRTY]');
    expect(src).toContain('sha256 对账');
  });

  it('--dry --dirty 在脏工作区也不 SKIP（只校验前置，不改盘）', () => {
    const r = spawnSync(
      process.execPath,
      ['../scripts/mutation-probe.mjs', '--dry', '--dirty', '--only=code-check-registry'],
      { cwd: process.cwd(), encoding: 'utf8', timeout: 60_000 },
    );
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('[OK]');
    expect(r.stdout).not.toContain('[SKIP]');
  });
});
