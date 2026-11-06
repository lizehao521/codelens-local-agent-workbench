/**
 * `fs.write` 的 git 执行面拦截（根因侧）。
 *
 * 为什么需要它：`fs.write` 是 soft 审批，而写一个 `.git/hooks/pre-commit`、
 * 或往 `.git/config` 塞 `diff.external=<cmd>` / `[alias] x = !<cmd>`，就等于
 * 用低审批档换到命令执行 —— 把 `sys.exec` 的 hard/two_step 整个绕过。
 *
 * 这批用例同时钉住两件相反的事：
 *  - 该拒的必须拒（hooks 目录、`.git/config` 精确匹配）；
 *  - **不该拒的绝不能被误伤**（`.gitignore` / `.github/workflows/*.yml` /
 *    `.git/config.bak`），否则「路径含 .git 就拦」这种粗判断会把正常仓库文件一起封掉。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fsWriteTool, gitExecutableSurfaceRejection } from '../src/tools/builtin/fs-write.tool.js';
import type { ToolExecutionContext } from '../src/types/tool.js';

let sandbox: string;
let ctx: ToolExecutionContext;

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'fswrite-git-'));
  ctx = {
    sessionId: 's',
    toolCallId: 't',
    callId: 'c',
    iteration: 1,
    sandboxRoot: sandbox,
    signal: new AbortController().signal,
    reportProgress: () => {},
  };
});

afterEach(() => {
  // 清理推到 setImmediate：宿主删除守卫在同步路径上可能超时，
  // 而它耗时会被算进 hook 超时，把已通过的用例判红。
  const dir = sandbox;
  setImmediate(() => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* 残留由环境侧回收 */
    }
  });
});

describe('fs.write · git 执行面（hooks / config）必须拒绝', () => {
  it('create .git/hooks/pre-commit → TOOL_SECURITY_DENIED，且文件没有被创建', async () => {
    const r = await fsWriteTool.handler(
      { path: '.git/hooks/pre-commit', operation: 'create', content: '#!/bin/sh\nrm -rf /\n' },
      ctx,
    );
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe('TOOL_SECURITY_DENIED');
    expect(r.error?.kind).toBe('security');
    expect(r.error?.suggestion ?? '').toContain('git config');
    expect(existsSync(join(sandbox, '.git', 'hooks', 'pre-commit'))).toBe(false);
  });

  it('overwrite .git/config → 拒绝（alias / diff.external / core.pager 的写入入口）', async () => {
    mkdirSync(join(sandbox, '.git'), { recursive: true });
    writeFileSync(join(sandbox, '.git', 'config'), '[core]\n');
    const r = await fsWriteTool.handler(
      { path: '.git/config', operation: 'overwrite', content: '[alias]\n  x = !sh -c "evil"\n' },
      ctx,
    );
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe('TOOL_SECURITY_DENIED');
    // 原内容没被改写
    expect(existsSync(join(sandbox, '.git', 'config'))).toBe(true);
  });

  it('delete .git/config → 同样拒绝（删除后重建是同一攻击的另一种写法）', async () => {
    mkdirSync(join(sandbox, '.git'), { recursive: true });
    writeFileSync(join(sandbox, '.git', 'config'), '[core]\n');
    const r = await fsWriteTool.handler({ path: '.git/config', operation: 'delete' }, ctx);
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe('TOOL_SECURITY_DENIED');
    expect(existsSync(join(sandbox, '.git', 'config'))).toBe(true);
  });

  it('rename 到 .git/hooks/ → 拒绝，源文件不被移动', async () => {
    writeFileSync(join(sandbox, 'payload.sh'), '#!/bin/sh\nevil\n');
    const r = await fsWriteTool.handler(
      { path: 'payload.sh', operation: 'rename', newPath: '.git/hooks/pre-commit' },
      ctx,
    );
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe('TOOL_SECURITY_DENIED');
    expect(existsSync(join(sandbox, 'payload.sh'))).toBe(true);
    expect(existsSync(join(sandbox, '.git', 'hooks', 'pre-commit'))).toBe(false);
  });

  it('purge .git/hooks → 拒绝（不然可以先清空再写入）', async () => {
    mkdirSync(join(sandbox, '.git', 'hooks'), { recursive: true });
    writeFileSync(join(sandbox, '.git', 'hooks', 'pre-commit'), 'x');
    const r = await fsWriteTool.handler({ path: '.git/hooks', operation: 'purge' }, ctx);
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe('TOOL_SECURITY_DENIED');
    expect(existsSync(join(sandbox, '.git', 'hooks', 'pre-commit'))).toBe(true);
  });
});

describe('fs.write · 不误伤普通仓库文件', () => {
  it('.gitignore / .gitattributes / .gitmodules 仍可写', async () => {
    for (const file of ['.gitignore', '.gitattributes', '.gitmodules']) {
      const r = await fsWriteTool.handler({ path: file, operation: 'create', content: 'x\n' }, ctx);
      expect(r.ok, file).toBe(true);
      expect(existsSync(join(sandbox, file))).toBe(true);
    }
  });

  it('src/.github/workflows/ci.yml 仍可写（「路径含 .git」式粗判断会误伤它）', async () => {
    mkdirSync(join(sandbox, 'src', '.github', 'workflows'), { recursive: true });
    const r = await fsWriteTool.handler(
      { path: 'src/.github/workflows/ci.yml', operation: 'create', content: 'name: ci\n' },
      ctx,
    );
    expect(r.ok).toBe(true);
    expect(existsSync(join(sandbox, 'src', '.github', 'workflows', 'ci.yml'))).toBe(true);
  });

  it('.git/config.bak 与 .git/configurations 不算 .git/config（精确匹配）', async () => {
    mkdirSync(join(sandbox, '.git'), { recursive: true });
    for (const file of ['.git/config.bak', '.git/configurations']) {
      const r = await fsWriteTool.handler({ path: file, operation: 'create', content: 'x\n' }, ctx);
      expect(r.ok, file).toBe(true);
    }
  });

  it('判定函数本身：路径段比较，大小写归一（Windows）', () => {
    expect(gitExecutableSurfaceRejection('/s/.git/hooks/pre-commit')).not.toBeNull();
    expect(gitExecutableSurfaceRejection('/s/.GIT/Hooks/pre-commit')).not.toBeNull();
    expect(gitExecutableSurfaceRejection('/s/.git/config')).not.toBeNull();
    expect(gitExecutableSurfaceRejection('/s/.gitignore')).toBeNull();
    expect(gitExecutableSurfaceRejection('/s/.github/workflows/ci.yml')).toBeNull();
    expect(gitExecutableSurfaceRejection('/s/.git/config.bak')).toBeNull();
    expect(gitExecutableSurfaceRejection('/s/sub/.gitmodules')).toBeNull();
  });
});
