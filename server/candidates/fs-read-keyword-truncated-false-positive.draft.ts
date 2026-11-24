import { describe, expect, it } from 'vitest';
import { fsReadTool } from '../src/tools/builtin/fs-read.tool.js';
import { writeFileSync, unlinkSync } from 'node:fs';

const ctx = {
  sessionId: 's',
  toolCallId: 't',
  callId: 'c',
  iteration: 1,
  sandboxRoot: process.cwd(),
  signal: new AbortController().signal,
  reportProgress: () => {},
};

const FILE = 'fs-read-keyword-truncated-probe.txt';

describe('fs.read keyword-only truncated flag', () => {
  beforeAll(() => {
    writeFileSync(FILE, 'alpha\nfoo\nbeta\nfoo\ngamma\n', 'utf8');
  });

  afterAll(() => {
    try {
      unlinkSync(FILE);
    } catch {}
  });

  it('keyword foo partial match returns truncated false', async () => {
    const r = await fsReadTool.handler!({ path: FILE, keyword: 'foo' }, ctx);
    expect(r.ok).toBe(true);
    expect(r.error).toBeUndefined();
    expect(r.data?.truncated).toBe(false);
  });

  it('keyword beta partial match returns truncated false', async () => {
    const r = await fsReadTool.handler!({ path: FILE, keyword: 'beta' }, ctx);
    expect(r.ok).toBe(true);
    expect(r.error).toBeUndefined();
    expect(r.data?.truncated).toBe(false);
  });

  it('keyword alpha partial match returns truncated false', async () => {
    const r = await fsReadTool.handler!({ path: FILE, keyword: 'alpha' }, ctx);
    expect(r.ok).toBe(true);
    expect(r.error).toBeUndefined();
    expect(r.data?.truncated).toBe(false);
  });
});
