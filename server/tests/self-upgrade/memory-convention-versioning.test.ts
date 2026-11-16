/**
 * Memory · 仓库约定版本化判据。
 *
 * 缺口：AGENTS.md/CLAUDE.md 只把当前文本塞进提示词，模型无法回答
 * 「这条约定是什么版本、何时生效、改了什么」。
 *
 * 判据必须同时钉住三件事：
 *  1. 显式 convention-version / convention-change 进入注入头；
 *  2. 没写元数据时不伪造变更说明，给内容指纹、字节/行数/mtime 兜底；
 *  3. 版本块真的进入 buildRuntimeSections（生产合成器）与 ReAct 系统提示词。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { loadProjectInstructions } from '../../src/services/agent/project-instructions.js';
import { buildRuntimeSections, buildWorkspaceSection } from '../../src/services/agent/system-prompt.js';
import { buildReactSystemPrompt, renderToolCatalogue } from '../../src/services/agent/react-channel.js';

const RULE = '本仓库的 tests/ 目录是人所有，Agent 不得改动。';
const cleanups: Array<() => void> = [];
let root = '';

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'cl-convention-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
});
afterEach(() => {
  for (const fn of cleanups.splice(0)) {
    try {
      fn();
    } catch {
      // 临时目录清理失败不该改变判据结论。
    }
  }
});

const put = (name: string, content: string): void => writeFileSync(path.join(root, name), content, 'utf8');
const fingerprintOf = (text: string): string =>
  /约定版本：sha256:([0-9a-f]{12,})/.exec(text)?.[1] ?? '';

describe('AGENTS.md 约定版本号与变更证据', () => {
  it('显式版本与变更证据进入注入头，并附内容指纹', () => {
    put('AGENTS.md', `<!-- convention-version: 2026-11-15.1 -->\n<!-- convention-change: 增加 tests/ 只读约束 -->\n${RULE}`);
    const section = loadProjectInstructions(root);
    expect(section).toContain('约定版本：2026-11-15.1');
    expect(section).toMatch(/约定版本：2026-11-15\.1[^\n]*sha256:[0-9a-f]{12,}/);
    expect(section).toContain('变更证据：增加 tests/ 只读约束');
    expect(section).toContain(RULE);
  });

  it('无显式元数据时如实兜底：指纹/字节/行数/mtime，不伪造变更说明', () => {
    put('AGENTS.md', RULE);
    const section = loadProjectInstructions(root);
    expect(section).toMatch(/约定版本：sha256:[0-9a-f]{12,}/);
    expect(section).toContain('变更证据：未提供显式变更说明');
    expect(section).toContain('字节');
    expect(section).toContain('行');
    expect(section).toContain('mtime');
  });

  it('内容变化会改变 fallback 指纹，同内容两次加载稳定', () => {
    put('AGENTS.md', RULE);
    const first = loadProjectInstructions(root);
    expect(loadProjectInstructions(root)).toBe(first);
    put('AGENTS.md', `${RULE}\n新增一条约定。`);
    const changed = loadProjectInstructions(root);
    expect(fingerprintOf(first)).not.toBe('');
    expect(fingerprintOf(changed)).not.toBe(fingerprintOf(first));
  });

  it('AGENTS.md 优先，CLAUDE.md 的版本元数据不得泄漏', () => {
    put('AGENTS.md', '<!-- convention-version: agents-v1 -->\n甲规则');
    put('CLAUDE.md', '<!-- convention-version: claude-v9 -->\n乙规则');
    const section = loadProjectInstructions(root);
    expect(section).toContain('约定版本：agents-v1');
    expect(section.includes('claude-v9')).toBe(false);
  });

  it('版本块进入生产合成器与 ReAct 系统提示词；无指令时保持旧行为', () => {
    put('AGENTS.md', `<!-- convention-version: v2 -->\n<!-- convention-change: 新增版本化 -->\n${RULE}`);
    const composed = buildRuntimeSections(root);
    expect(composed.startsWith(buildWorkspaceSection(root))).toBe(true);
    expect(composed).toContain('约定版本：v2');
    expect(composed).toContain('变更证据：新增版本化');
    expect(buildReactSystemPrompt(renderToolCatalogue([]), composed)).toContain('约定版本：v2');

    const empty = mkdtempSync(path.join(tmpdir(), 'cl-convention-empty-'));
    cleanups.push(() => rmSync(empty, { recursive: true, force: true }));
    expect(buildRuntimeSections(empty)).toBe(buildWorkspaceSection(empty));
  });
});
