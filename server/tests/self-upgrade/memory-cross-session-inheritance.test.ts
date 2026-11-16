/**
 * Memory · 跨会话约定继承判据。
 *
 * 缺口：仓库指令由每个新会话重新加载，但没有判据证明「新会话读到的是上一
 * 会话已生效的 AGENTS.md 版本」，也没有证明文件更新后新会话不会沿用旧版本。
 *
 * 本判据走真实 ContextManager + SQLite 会话：A/B 是同一版本下的两个会话，
 * C 是 AGENTS.md 升版后新建的会话；断言 system 消息而不是加载器中间值。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { buildRuntimeSections } from '../../src/services/agent/system-prompt.js';
import { ContextManager } from '../../src/services/agent/context-manager.service.js';
import { SUMMARY_SECTIONS } from '../../src/services/agent/fidelity-checker.js';
import { createDb, type Db } from '../../src/repositories/db.js';
import { SCHEMA_SQL } from '../../src/repositories/schema.js';
import { SessionRepository } from '../../src/services/memory/session.repository.js';
import { MessageRepository } from '../../src/services/memory/message.repository.js';
import type { SseWriter } from '../../src/services/agent/sse-writer.js';

const RULE = '本仓库的 tests/ 目录是人所有，Agent 不得改动。';
const cleanups: Array<() => void> = [];
let root = '';

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'cl-cross-session-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
});
afterEach(() => {
  for (const fn of cleanups.splice(0)) {
    try {
      fn();
    } catch {
      // 临时目录清理失败不改变判据结论。
    }
  }
});

const put = (version: string, change: string): void =>
  writeFileSync(
    path.join(root, 'AGENTS.md'),
    `<!-- convention-version: ${version} -->\n<!-- convention-change: ${change} -->\n${RULE}`,
    'utf8',
  );

function summary(): string {
  return `${SUMMARY_SECTIONS.map((s) => `【${s}】跨会话摘要`).join('\n')}\n【下一步计划】已处理 130 条消息，详见 src/agent/context.ts`;
}

interface Ctx {
  sessions: SessionRepository;
  manager: ContextManager;
  close: () => void;
}

function realContext(): Ctx {
  const dbDir = mkdtempSync(path.join(tmpdir(), 'cl-cross-session-db-'));
  cleanups.push(() => rmSync(dbDir, { recursive: true, force: true }));
  const db: Db = createDb(path.join(dbDir, 'ctx.db'));
  db.exec(SCHEMA_SQL);
  const sessions = new SessionRepository(db);
  const manager = new ContextManager({
    messages: new MessageRepository(db),
    resolveContextWindow: () => 128_000,
    sse: { emit: () => {} } as unknown as SseWriter,
    summarize: async () => summary(),
  });
  return {
    sessions,
    manager,
    close: () => {
      db.close();
      rmSync(dbDir, { recursive: true, force: true });
    },
  };
}

describe('跨会话继承 AGENTS.md 约定版本', () => {
  it('同版本下新会话继承上一会话的版本与生效时间', async () => {
    put('2026-11-15.1', '初始约定');
    const ctx = realContext();
    cleanups.push(ctx.close);
    const a = ctx.sessions.create({ provider: 'openai', model: 'gpt-4o-mini' });
    const b = ctx.sessions.create({ provider: 'openai', model: 'gpt-4o-mini' });

    const promptA = buildRuntimeSections(root);
    const promptB = buildRuntimeSections(root);
    expect(promptB === promptA).toBe(true);
    const viewA = await ctx.manager.buildView(a.id, 'openai', 'gpt-4o-mini', promptA);
    const viewB = await ctx.manager.buildView(b.id, 'openai', 'gpt-4o-mini', promptB);
    const systemA = viewA.messages.find((m) => m.role === 'system')!.content;
    const systemB = viewB.messages.find((m) => m.role === 'system')!.content;

    expect(systemA.includes('约定版本：2026-11-15.1')).toBe(true);
    expect(systemA.includes('约定版本：2026-11-15.2')).toBe(false);
    expect(systemB.includes('约定版本：2026-11-15.1')).toBe(true);
    expect(systemB.includes('约定版本：2026-11-15.2')).toBe(false);
    expect(systemB.includes('约定生效时间：')).toBe(true);
    expect(systemB.includes('变更证据：初始约定')).toBe(true);
    expect(systemB.includes('变更证据：新增跨会话判据')).toBe(false);
    expect(systemB.includes(RULE)).toBe(true);
  });

  it('AGENTS.md 升版后新会话读到新版本，不沿用旧会话缓存', async () => {
    put('2026-11-15.1', '初始约定');
    const ctx = realContext();
    cleanups.push(ctx.close);
    const a = ctx.sessions.create({ provider: 'openai', model: 'gpt-4o-mini' });
    const c = ctx.sessions.create({ provider: 'openai', model: 'gpt-4o-mini' });
    const oldPrompt = buildRuntimeSections(root);
    expect((await ctx.manager.buildView(a.id, 'openai', 'gpt-4o-mini', oldPrompt)).messages[0]!.content).toContain(
      '约定版本：2026-11-15.1',
    );

    put('2026-11-15.2', '新增跨会话判据');
    const newPrompt = buildRuntimeSections(root);
    expect(newPrompt !== oldPrompt).toBe(true);
    expect(newPrompt.includes('新增跨会话判据')).toBe(true);
    const systemC = (await ctx.manager.buildView(c.id, 'openai', 'gpt-4o-mini', newPrompt)).messages.find(
      (m) => m.role === 'system',
    )!.content;
    expect(systemC.includes('约定版本：2026-11-15.2')).toBe(true);
    expect(systemC.includes('变更证据：新增跨会话判据')).toBe(true);
    expect(systemC.includes('约定版本：2026-11-15.1')).toBe(false);
    expect(systemC.includes('变更证据：初始约定')).toBe(false);
  });
});
