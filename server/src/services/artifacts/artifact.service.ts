/**
 * Artifact service — P1-6 artifacts 面板的服务层。
 *
 * 数据来源：tool_results 表里 artifact_path 非空的行（executor 在结果超长时把
 * 全量序列化写进沙箱内 `.artifacts/<toolCallId>.json`，见 executor.service.ts:618-625）。
 *
 * 职责：
 *  - list(sessionId)：按会话列出 artifact 元数据（不含正文）；
 *  - get(sessionId, resultId)：取单条 artifact 的元数据 + 正文（读盘，jail 在 sandboxRoot 内）。
 *
 * 安全不变量：artifact_path 只是 DB 里的一个字符串，读盘前必须解析成绝对路径并
 * 校验仍在 sandboxRoot 内（防路径逃逸，与 fs 工具的 jail 同一口径）；读取大小设硬上限，
 * 防止异常大的 artifact 把进程拖死。
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { ToolResultRepository, ToolResultRow } from '../memory/tool-result.repository.js';

/** 单个 artifact 正文读取硬上限（20MB）：超过视为不可读，返回错误而不是 OOM。 */
export const MAX_ARTIFACT_READ_BYTES = 20 * 1024 * 1024;

export interface ArtifactSummary {
  id: string;
  toolCallId: string;
  callId: string;
  toolName: string;
  path: string;
  bytes: number;
  truncated: boolean;
  sha256: string | null;
  createdAt: number;
}

export interface ArtifactDetail extends ArtifactSummary {
  /** 正文（UTF-8 文本）。二进制/超大 artifact 不在本接口返回正文。 */
  content: string;
  /** 正文实际读取的字节数（可能小于 bytes，若文件被外部修改）。 */
  contentBytes: number;
}

export class ArtifactNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ArtifactNotFoundError';
  }
}

export class ArtifactPathEscapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ArtifactPathEscapeError';
  }
}

export class ArtifactTooLargeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ArtifactTooLargeError';
  }
}

function toSummary(row: ToolResultRow & { tool_name: string; call_id: string }): ArtifactSummary {
  return {
    id: row.id,
    toolCallId: row.tool_call_id,
    callId: row.call_id,
    toolName: row.tool_name,
    path: row.artifact_path ?? '',
    bytes: row.bytes,
    truncated: row.truncated === 1,
    sha256: row.sha256,
    createdAt: row.created_at,
  };
}

export class ArtifactService {
  constructor(
    private readonly toolResults: ToolResultRepository,
    private readonly sandboxRoot: string,
  ) {}

  /** 列出会话下所有已落盘 artifact（只含元数据，不读盘）。 */
  list(sessionId: string): ArtifactSummary[] {
    return this.toolResults
      .listBySession(sessionId)
      .filter((row) => row.artifact_path !== null && row.artifact_path !== '')
      .map(toSummary);
  }

  /**
   * 取单条 artifact 正文。路径逃逸 / 不存在 / 超大分别抛对应错误，
   * 由 controller 映射成 400 / 404 / 413。
   */
  async get(sessionId: string, resultId: string): Promise<ArtifactDetail> {
    const row = this.toolResults.getByIdInSession(resultId, sessionId);
    if (!row || !row.artifact_path) {
      throw new ArtifactNotFoundError(`artifact ${resultId} 不存在或不属于该会话`);
    }
    const abs = this.resolveWithinSandbox(row.artifact_path);
    let content: string;
    let contentBytes: number;
    try {
      const buf = await readFile(abs);
      if (buf.byteLength > MAX_ARTIFACT_READ_BYTES) {
        throw new ArtifactTooLargeError(
          `artifact 超过读取上限 ${MAX_ARTIFACT_READ_BYTES} 字节（实际 ${buf.byteLength}）`,
        );
      }
      content = buf.toString('utf8');
      contentBytes = buf.byteLength;
    } catch (err) {
      if (err instanceof ArtifactTooLargeError) throw err;
      if (err instanceof ArtifactPathEscapeError) throw err;
      // ENOENT 等：DB 广告了 artifact 但文件不在 —— 与 executor 写盘失败口径一致，
      // 报 404 让前端知道「元数据在、文件不在」。
      throw new ArtifactNotFoundError(`artifact 文件不存在: ${row.artifact_path}`);
    }
    return { ...toSummary(row), content, contentBytes };
  }

  /** 把 DB 里的相对路径解析成沙箱内绝对路径；逃逸即抛 ArtifactPathEscapeError。 */
  private resolveWithinSandbox(relPath: string): string {
    const root = path.resolve(this.sandboxRoot);
    const abs = path.resolve(root, relPath);
    if (abs !== root && !abs.startsWith(root + path.sep)) {
      throw new ArtifactPathEscapeError(`artifact 路径逃逸沙箱: ${relPath}`);
    }
    return abs;
  }
}
