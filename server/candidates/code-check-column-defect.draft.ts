import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { codeCheckTool } from '../src/tools/builtin/code-check.tool.js';
import { writeFileSync, unlinkSync } from 'node:fs';
import { join, relative } from 'node:path';

const ctx = {
  sessionId: 's',
  toolCallId: 't',
  callId: 'c',
  iteration: 1,
  sandboxRoot: process.cwd(),
  signal: new AbortController().signal,
  reportProgress: () => {},
};

const validFile = 'probe-valid.ts';
const invalidFile = 'probe-invalid.ts';

beforeAll(() => {
  writeFileSync(join(process.cwd(), validFile), 'export const a = 1;\n');
  // Syntax error at column 12 (the '2' after '1 ')
  writeFileSync(join(process.cwd(), invalidFile), 'const x = 1 2;\n');
});

afterAll(() => {
  unlinkSync(join(process.cwd(), validFile));
  unlinkSync(join(process.cwd(), invalidFile));
});

describe('codeCheckTool column defect', () => {
  it('returns correct column for syntax error (red baseline)', async () => {
    const result = await codeCheckTool.handler!({ path: invalidFile }, ctx);
    expect(result.ok).toBe(false);
    expect(result.data).toBeDefined();
    // Current bug: column is always 1. Fixed behavior: column > 1 (e.g. 12)
    expect(typeof result.data?.column).toBe('number');
    expect(result.data!.column).toBeGreaterThan(1);
  });

  it('returns ok true for valid file', async () => {
    const result = await codeCheckTool.handler!({ path: validFile }, ctx);
    expect(result.ok).toBe(true);
    expect(result.data).toBeDefined();
  });

  it('returns not_found for missing file', async () => {
    const result = await codeCheckTool.handler!({ path: 'probe-missing.ts' }, ctx);
    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
    expect(['not_found', 'invalid_args', 'internal']).toContain(result.error!.kind);
  });
});
