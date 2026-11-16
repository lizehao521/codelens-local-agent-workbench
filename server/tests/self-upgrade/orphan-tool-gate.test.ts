import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { toolForgeTool } from '../../src/tools/builtin/tool-forge.tool.js';
import {
  cleanupForgedTools,
  listForgedTools,
} from '../../src/services/tools/forged-tool-lifecycle.js';

let root = '';
const ctx = (sessionId: string) => ({
  sandboxRoot: root, sessionId, toolCallId: 't', callId: 'c', iteration: 1,
  signal: new AbortController().signal, reportProgress: () => {},
}) as never;

const spec = (name: string) => ({
  operation: 'create', name, description: '读取固定行',
  why_not_existing: '现有工具无法一次调用固定行窗口',
  steps: [{ tool: 'fs_read', args: { path: 'notes/x.md', lineStart: 1, lineEnd: 1 } }],
  references: [{ title: 'ref', url: 'https://example.com' }],
});

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'orphan-gate-'));
  mkdirSync(path.join(root, 'notes'), { recursive: true });
  writeFileSync(path.join(root, 'notes', 'x.md'), '第一行\n第二行\n');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('orphan-tool-gate', () => {
  it('已 create/use/recycle 的工具保留晋升产物', async () => {
    const c = ctx('s1');
    await toolForgeTool.handler(spec('paired_tool'), c);
    await toolForgeTool.handler({ operation: 'use', name: 'paired_tool' }, c);
    await toolForgeTool.handler({
      operation: 'recycle', name: 'paired_tool',
      answers: { category: '固定行读取', to_pi: '写入经验', no_tool_next: '直接传行号', promote: true },
    }, c);
    const result = cleanupForgedTools('s1', root);
    expect(result.kept).toContain('paired_tool');
    expect(existsSync(path.join(root, '.codelens', 'tool-library', 's1', 'paired_tool.json'))).toBe(true);
    expect(existsSync(path.join(root, 'tmp', 'tools', 's1', 'paired_tool.json'))).toBe(false);
  });

  it('未配对工具在任务结束被清理，生命周期登记无悬挂引用', async () => {
    const c = ctx('s1');
    await toolForgeTool.handler(spec('orphan_tool'), c);
    expect(existsSync(path.join(root, 'tmp', 'tools', 's1', 'orphan_tool.json'))).toBe(true);
    const result = cleanupForgedTools('s1', root);
    expect(result.removed).toContain('orphan_tool');
    expect(listForgedTools('s1')).toEqual([]);
    expect(existsSync(path.join(root, 'tmp', 'tools', 's1', 'orphan_tool.json'))).toBe(false);
    const use = await toolForgeTool.handler({ operation: 'use', name: 'orphan_tool' }, c);
    expect(use.ok).toBe(false);
  });

  it('只清理本任务，不动其它 session 的工具', async () => {
    await toolForgeTool.handler(spec('other_tool'), ctx('s2'));
    cleanupForgedTools('s1', root);
    expect(existsSync(path.join(root, 'tmp', 'tools', 's2', 'other_tool.json'))).toBe(true);
  });

  it('任务收尾已接入清理：finish 前置 + finalize 兜底', () => {
    const src = readFileSync(path.resolve(process.cwd(), 'src/services/agent/agent-loop.service.ts'), 'utf8');
    expect(src).toContain('cleanupForgedTools(session.id');
    expect(src).toContain('cleanupForgedTools(p.session.id');
  });
});
