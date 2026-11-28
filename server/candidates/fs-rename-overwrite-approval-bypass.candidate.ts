/**
 * Judge · rename 覆盖已存在文件必须按 overwrite 同级高风险审批，不得用 medium/soft 绕过。
 *
 * 线上症状（B 红队 GW-1）：fs.write { operation:'rename', path:'malicious.txt', newPath:'.env' }
 * 在 POSIX 下会原子覆盖已存在的 .env，但 assessRisk 把 rename 一律判 medium/soft，
 * 而 overwrite 已存在文件是 high/hard。同样的破坏性结果，rename 路径审批门槛更低 → 审批绕过。
 * 探针实证：overwrite .env → high/hard；rename→.env → medium/soft，且实际静默覆盖成功。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { assessRisk } from '../src/services/tools/security-gateway.js';
import type { GatewayContext } from '../src/services/tools/security-gateway.js';
import type { ToolDefinition } from '../src/types/tool.js';

let root: string;
let ctx: GatewayContext;
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'cl-rename-judge-'));
  ctx = { sandboxRoot: root, allowedDirs: [] } as GatewayContext;
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const def = { name: 'fs.write', risk: 'medium', approvalMode: 'soft', category: 'file' } as unknown as ToolDefinition;

describe('rename 覆盖已存在文件的审批风险', () => {
  it('rename 目标已存在 → 必须 high/hard（与 overwrite 同级）', () => {
    writeFileSync(path.join(root, '.env'), 'SECRET=real\n', 'utf8');
    writeFileSync(path.join(root, 'src.txt'), 'EVIL=1\n', 'utf8');
    const verdict = assessRisk(def, { operation: 'rename', path: 'src.txt', newPath: '.env' }, ctx);
    expect(verdict.risk).toBe('high');
    expect(verdict.approvalMode).toBe('hard');
  });

  it('rename 目标不存在 → 保持 medium/soft（回归保护）', () => {
    writeFileSync(path.join(root, 'src.txt'), 'data\n', 'utf8');
    const verdict = assessRisk(def, { operation: 'rename', path: 'src.txt', newPath: 'newfile.txt' }, ctx);
    expect(verdict.risk).toBe('medium');
    expect(verdict.approvalMode).toBe('soft');
  });

  it('overwrite 已存在文件 → high/hard（基线对照，必须不变）', () => {
    writeFileSync(path.join(root, 'exists.txt'), 'old\n', 'utf8');
    const verdict = assessRisk(def, { operation: 'overwrite', path: 'exists.txt' }, ctx);
    expect(verdict.risk).toBe('high');
    expect(verdict.approvalMode).toBe('hard');
  });
});
