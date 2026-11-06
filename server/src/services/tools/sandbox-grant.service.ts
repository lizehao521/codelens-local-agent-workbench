/**
 * 沙箱按目录授权（sandbox_grants）：工作区外首次访问 → 弹一次授权 → 记住后不再弹。
 *
 * 语义边界（刻意收窄，别放宽）：
 * - 只授权**目录**，且必须是绝对路径、真实存在的目录、通过 validateAllowDir；
 * - `..` 穿越永远不弹授权（攻击面，直接拒绝，不进本服务）；
 * - 敏感路径（.ssh/.aws/浏览器配置/密钥文件）永远不弹授权，直接拒绝；
 * - 授权是设备级持久化（DB 单表），撤销只写 revoked_at，历史可审计；
 * - 弹出后等待用户决定，超时按 deny（fail-closed），会话中止时全部 deny。
 */

import { existsSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import type { Db } from '../../repositories/db.js';
import { SandboxGrantRepository } from '../../repositories/sandbox-grant.repository.js';
import { prefixedId } from '../../utils/hash.js';
import { isSensitivePath } from './sensitive-path.js';
import { validateAllowDir } from './sandbox-permission.js';

export type GrantDecision = 'allow' | 'deny' | 'expired';

export interface GrantRequestPayload {
  grantId: string;
  sessionId: string;
  dir: string;
  realPath: string;
  sensitive: boolean;
  expiresAt: number;
}

interface Pending {
  payload: GrantRequestPayload;
  resolve: (decision: GrantDecision) => void;
  timer: NodeJS.Timeout;
}

export interface SandboxGrantServiceOptions {
  timeoutMs?: number;
}

export class SandboxGrantService {
  private readonly repo: SandboxGrantRepository;
  private readonly pending = new Map<string, Pending>();
  private readonly timeoutMs: number;

  constructor(
    db: Db,
    private readonly sandboxRoot: string,
    opts: SandboxGrantServiceOptions = {},
  ) {
    this.repo = new SandboxGrantRepository(db);
    this.timeoutMs = opts.timeoutMs ?? 120_000;
  }

  /** 已授权（且未撤销）的 realpath 列表；供 gateway 的 allowedDirs 合并。 */
  activeDirs(): string[] {
    return this.repo.listActive().map((row) => row.real_path);
  }

  list(): Array<{ id: string; dir: string; realPath: string; sensitive: boolean; createdAt: number; lastUsedAt: number | null }> {
    return this.repo.listActive().map((row) => ({
      id: row.id,
      dir: row.dir,
      realPath: row.real_path,
      sensitive: row.sensitive === 1,
      createdAt: row.created_at,
      lastUsedAt: row.last_used_at,
    }));
  }

  revoke(id: string): boolean {
    return this.repo.revoke(id) > 0;
  }

  /**
   * 某个绝对路径（文件或目录）是否已被授权覆盖。
   * 精确授权目录本身或其子路径都算覆盖（realpath 后判定）。
   */
  covers(absPath: string): boolean {
    const real = safeRealpath(absPath);
    for (const dir of this.activeDirs()) {
      const rel = path.relative(dir, real);
      if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) return true;
    }
    return false;
  }

  /**
   * 为一个「工作区外的绝对目录」申请授权。
   *
   * @param emit 把待决请求推给前端（SSE sandbox_grant_required）。
   * @returns allow / deny / expired；超时或会话中止均为 deny。
   */
  async requireGrant(
    sessionId: string,
    dir: string,
    emit: (payload: GrantRequestPayload) => void,
    signal?: AbortSignal,
  ): Promise<GrantDecision> {
    const checked = this.validateDir(dir);
    if (!checked.ok) return 'deny';

    // 已覆盖 → 直接放行（并刷新 last_used_at）。
    const existing = this.repo.findActiveByRealPath(checked.realPath);
    if (existing) {
      this.repo.touch(existing.id);
      return 'allow';
    }

    // 同一 dir 已有待决请求 → 复用同一个 id，不重复弹卡。
    for (const item of this.pending.values()) {
      if (item.payload.realPath === checked.realPath && item.payload.sessionId === sessionId) {
        return new Promise<GrantDecision>((resolve) => {
          const prev = item.resolve;
          item.resolve = (d) => {
            prev(d);
            resolve(d);
          };
        });
      }
    }

    const grantId = prefixedId('grant');
    const payload: GrantRequestPayload = {
      grantId,
      sessionId,
      dir: checked.dir,
      realPath: checked.realPath,
      sensitive: false,
      expiresAt: Date.now() + this.timeoutMs,
    };

    return new Promise<GrantDecision>((resolve) => {
      const timer = setTimeout(() => {
        const p = this.pending.get(grantId);
        if (!p) return;
        this.pending.delete(grantId);
        p.resolve('expired');
      }, this.timeoutMs);
      this.pending.set(grantId, { payload, resolve, timer });
      if (signal) {
        if (signal.aborted) {
          this.pending.delete(grantId);
          clearTimeout(timer);
          resolve('deny');
          return;
        }
        signal.addEventListener(
          'abort',
          () => {
            const p = this.pending.get(grantId);
            if (!p) return;
            this.pending.delete(grantId);
            clearTimeout(timer);
            p.resolve('deny');
          },
          { once: true },
        );
      }
      emit(payload);
    });
  }

  /** 用户决定（HTTP 端点调用）。allow 时落库，之后视为设备级长期授权。 */
  decide(grantId: string, allow: boolean): { ok: boolean; decision: GrantDecision } {
    const item = this.pending.get(grantId);
    if (!item) return { ok: false, decision: 'deny' };
    this.pending.delete(grantId);
    clearTimeout(item.timer);
    if (!allow) {
      item.resolve('deny');
      return { ok: true, decision: 'deny' };
    }
    const checked = this.validateDir(item.payload.realPath);
    if (!checked.ok) {
      item.resolve('deny');
      return { ok: true, decision: 'deny' };
    }
    this.repo.insert({
      id: grantId,
      dir: item.payload.dir,
      realPath: checked.realPath,
      sensitive: false,
    });
    item.resolve('allow');
    return { ok: true, decision: 'allow' };
  }

  /** 会话中止 / 任务结束：所有待决授权按 deny 结算，避免 executor 永久挂起。 */
  abortSession(sessionId: string): void {
    for (const [id, item] of this.pending) {
      if (item.payload.sessionId !== sessionId) continue;
      this.pending.delete(id);
      clearTimeout(item.timer);
      item.resolve('deny');
    }
  }

  /** 校验目录是否可作为授权目标（绝对 / 存在 / 目录 / 非敏感 / 非系统区）。 */
  private validateDir(rawDir: string): { ok: true; dir: string; realPath: string } | { ok: false } {
    const submitted = typeof rawDir === 'string' ? rawDir.trim() : '';
    if (!submitted) return { ok: false };
    if (!existsSync(submitted)) return { ok: false };
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(submitted);
    } catch {
      return { ok: false };
    }
    if (!st.isDirectory()) return { ok: false };
    if (isSensitivePath(submitted)) return { ok: false };
    const checked = validateAllowDir(submitted, this.sandboxRoot);
    if (!checked.ok) return { ok: false };
    return { ok: true, dir: submitted, realPath: checked.realPath };
  }
}

function safeRealpath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}
