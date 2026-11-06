/** fs.write — sandboxed create/overwrite/append/rename/delete. */

import { existsSync, statSync } from 'node:fs';
import { appendFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ToolDefinition, ToolOutcome } from '../../types/tool.js';
import { resolveInSandboxAsync } from './path-jail.js';

const MAX_CONTENT_CHARS = 2_000_000;
const OPERATIONS = ['create', 'overwrite', 'append', 'rename', 'delete', 'purge'] as const;

/** `fs.write` 碰到 git 执行面时的统一建议。 */
const GIT_SURFACE_SUGGESTION =
  '请用 sys.exec 的 git config（本地作用域）修改仓库配置；hooks 目录不允许直接写入';

/**
 * `.git` 内的「执行面」：hooks 目录与 config 文件。
 *
 * 为什么要拦：`fs.write` 只是 soft 审批，而写一个 `.git/hooks/pre-commit`、或往
 * `.git/config` 里塞 `diff.external=<cmd>` / `[alias] x = !<cmd>`，就等于用低审批档
 * 换到命令执行 —— 把 `sys.exec` 的 hard/two_step 整个绕过。这是安全模型的洞，
 * 所以**拒绝**而不是升审批档（升档也拦不住随手点确认的人）。
 *
 * 判定用**路径段**而不是 `includes('.git')`：
 *  - `.gitignore` / `.gitattributes` / `.gitmodules` 是普通仓库文件，必须继续可写；
 *  - `src/.github/workflows/ci.yml` 同理。
 * 只有「`.git` 段」且紧随 `hooks`（任意深度）或精确的 `config` 才算命中。
 */
export function gitExecutableSurfaceRejection(absolutePath: string): string | null {
  const segments = path
    .resolve(absolutePath)
    .split(/[\\/]+/)
    .filter((segment) => segment.length > 0)
    .map((segment) => segment.toLowerCase());
  for (let i = 0; i < segments.length; i += 1) {
    if (segments[i] !== '.git') continue;
    const next = segments[i + 1];
    if (next === 'hooks') return '禁止写入 git hooks 目录（可被任意 git 调用触发执行）';
    // 只精确匹配 `.git/config` 本身；`.git/config.bak`、`.git/configurations` 不算。
    if (next === 'config' && i + 2 === segments.length) {
      return '禁止直接改写 .git/config（其中的 alias / diff.external / core.pager 可被当作命令执行）';
    }
  }
  return null;
}

function gitSurfaceOutcome(message: string): ToolOutcome {
  return {
    ok: false,
    summary: message,
    error: {
      code: 'TOOL_SECURITY_DENIED',
      kind: 'security',
      message,
      suggestion: GIT_SURFACE_SUGGESTION,
      retryable: false,
    },
  };
}

export const fsWriteTool: ToolDefinition = {
  name: 'fs.write',
  wireName: 'fs_write',
  displayName: '写入文件',
  category: 'file',
  description:
    '在沙箱内写文件。operation：create（不存在才建）/overwrite（覆盖）/append（追加）/rename（移动到 newPath）/delete（删除）/purge（清空目录内容并保留空目录）。路径必须是沙箱相对路径；覆盖、删除、清空属于高危操作，执行前需要用户确认。',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '沙箱相对路径', maxLength: 512 },
      operation: { type: 'string', enum: [...OPERATIONS], description: '操作类型，必填' },
      content: { type: 'string', description: 'create/overwrite/append 的内容', maxLength: 2000000 },
      newPath: { type: 'string', description: 'rename 的目标相对路径', maxLength: 512 },
    },
    required: ['path', 'operation'],
    additionalProperties: false,
  },
  timeoutMs: 15000,
  risk: 'medium',
  approvalMode: 'soft',
  source: 'builtin',
  idempotent: false,
  maxResultChars: 2000,
  enabled: () => true,
  handler: async (args, ctx) => {
    const operation = String(args.operation ?? '');
    if (!OPERATIONS.includes(operation as (typeof OPERATIONS)[number])) {
      return {
        ok: false,
        summary: `operation 必须是 ${OPERATIONS.join('/')}`,
        error: {
          code: 'TOOL_INVALID_ARGS',
          kind: 'invalid_args',
          message: `operation 必须是 ${OPERATIONS.join('/')}`,
        },
      };
    }
    const jail = await resolveInSandboxAsync(ctx.sandboxRoot, String(args.path ?? ''), true, undefined, ctx.allowedDirs);
    if (!jail.ok) {
      return {
        ok: false,
        summary: jail.message,
        error: { code: 'TOOL_SECURITY_DENIED', kind: 'security', message: jail.message, retryable: false },
      };
    }
    const targetExists = existsSync(jail.absolutePath);

    // 根因侧拦截：`.git/hooks/*` 与 `.git/config` 是「配置即命令」的写入入口，
    // 任何 operation（写入/删除）都不允许碰它们。
    const gitSurface = gitExecutableSurfaceRejection(jail.absolutePath);
    if (gitSurface) return gitSurfaceOutcome(gitSurface);

    if (operation === 'create' && targetExists) {
      return {
        ok: false,
        summary: `目标已存在：${jail.sandboxRelative}（create 不覆盖，请用 overwrite）`,
        error: {
          code: 'TOOL_INVALID_ARGS',
          kind: 'invalid_args',
          message: `目标已存在：${jail.sandboxRelative}，create 不覆盖已有文件`,
        },
      };
    }

    if (operation === 'create' || operation === 'overwrite' || operation === 'append') {
      const content = String(args.content ?? '');
      if (content.length > MAX_CONTENT_CHARS) {
        return {
          ok: false,
          summary: `内容超过 ${MAX_CONTENT_CHARS} 字符上限`,
          error: {
            code: 'PAYLOAD_TOO_LARGE',
            kind: 'invalid_args',
            message: `内容超过 ${MAX_CONTENT_CHARS} 字符上限`,
          },
        };
      }
      ctx.reportProgress('writing', `写入 ${jail.sandboxRelative}`);
      await mkdir(path.dirname(jail.absolutePath), { recursive: true });
      if (operation === 'append') await appendFile(jail.absolutePath, content, 'utf8');
      else await writeFile(jail.absolutePath, content, 'utf8');
      const { stat } = await import('node:fs/promises');
      const size = (await stat(jail.absolutePath)).size;
      return {
        ok: true,
        summary: `已${operation === 'create' ? '创建' : operation === 'overwrite' ? '覆盖写入' : '追加'} ${jail.sandboxRelative}（${size} 字节）`,
        data: { path: jail.sandboxRelative, operation, sizeBytes: size },
      };
    }

    if (operation === 'rename') {
      if (args.newPath === undefined) {
        return {
          ok: false,
          summary: 'rename 需要 newPath',
          error: { code: 'TOOL_INVALID_ARGS', kind: 'invalid_args', message: 'rename 需要 newPath 参数' },
        };
      }
      const newJail = await resolveInSandboxAsync(ctx.sandboxRoot, String(args.newPath), true, undefined, ctx.allowedDirs);
      if (!newJail.ok) {
        return {
          ok: false,
          summary: newJail.message,
          error: { code: 'TOOL_SECURITY_DENIED', kind: 'security', message: newJail.message, retryable: false },
        };
      }
      // rename 的目标同样不能落在 git 执行面上（否则「挪进 .git/hooks」就是绕过）。
      const newGitSurface = gitExecutableSurfaceRejection(newJail.absolutePath);
      if (newGitSurface) return gitSurfaceOutcome(newGitSurface);
      if (!targetExists) {
        return {
          ok: false,
          summary: `源文件不存在：${jail.sandboxRelative}`,
          error: { code: 'TOOL_NOT_FOUND', kind: 'not_found', message: `源文件不存在：${jail.sandboxRelative}` },
        };
      }
      await mkdir(path.dirname(newJail.absolutePath), { recursive: true });
      await rename(jail.absolutePath, newJail.absolutePath);
      return {
        ok: true,
        summary: `已重命名 ${jail.sandboxRelative} → ${newJail.sandboxRelative}`,
        data: { from: jail.sandboxRelative, to: newJail.sandboxRelative, operation },
      };
    }

    if (operation === 'purge') {
      // 清空目录内容但保留空目录本身：批量销毁，属于高危操作。
      // 沙箱根会被 path-jail 拒绝（forWrite 时根的相对路径为空），故 purge 根不可达。
      if (!targetExists) {
        return {
          ok: false,
          summary: `目标不存在：${jail.sandboxRelative}`,
          error: { code: 'TOOL_NOT_FOUND', kind: 'not_found', message: `目标不存在：${jail.sandboxRelative}` },
        };
      }
      if (!statSync(jail.absolutePath).isDirectory()) {
        return {
          ok: false,
          summary: `purge 仅适用于目录：${jail.sandboxRelative}`,
          error: { code: 'TOOL_INVALID_ARGS', kind: 'invalid_args', message: 'purge 仅适用于目录' },
        };
      }
      ctx.reportProgress('writing', `清空 ${jail.sandboxRelative}`);
      // 删除目录本身（含全部内容）后重建空目录，达到「清空内容、保留目录」效果。
      await rm(jail.absolutePath, { recursive: true });
      await mkdir(jail.absolutePath, { recursive: true });
      return {
        ok: true,
        summary: `已清空 ${jail.sandboxRelative}`,
        data: { path: jail.sandboxRelative, operation },
      };
    }

    // delete
    if (!targetExists) {
      return {
        ok: false,
        summary: `目标不存在：${jail.sandboxRelative}`,
        error: { code: 'TOOL_NOT_FOUND', kind: 'not_found', message: `目标不存在：${jail.sandboxRelative}` },
      };
    }
    const recursive = args.recursive === true;
    await rm(jail.absolutePath, { recursive: recursive && existsSync(jail.absolutePath) });
    return {
      ok: true,
      summary: `已删除 ${jail.sandboxRelative}`,
      data: { path: jail.sandboxRelative, operation },
    };
  },
};

/** Exported for tests: read a file back inside the sandbox (used by executor recall). */
export async function readSandboxFile(sandboxRoot: string, rel: string, forWrite = false, allowedDirs?: string[]): Promise<Buffer> {
  const jail = await resolveInSandboxAsync(sandboxRoot, rel, forWrite, undefined, allowedDirs);
  if (!jail.ok) throw new Error(jail.message);
  return readFile(jail.absolutePath);
}
