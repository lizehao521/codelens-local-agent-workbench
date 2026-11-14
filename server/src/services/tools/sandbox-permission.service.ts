/**
 * 沙箱权限服务：内存缓存 + 持久化 + 安全校验。
 * 运行时 gateway / executor 通过 getConfig() 实时读取最新配置（PUT 后立即生效，无需重启）。
 */

import type { Db } from '../../repositories/db.js';
import {
  DEFAULT_PERMISSION_CONFIG,
  normalizeConfig,
  validateAllowDir,
  type AutoApproveConfig,
  type SandboxPermissionConfig,
} from './sandbox-permission.js';
import { SandboxPermissionRepository } from '../../repositories/sandbox-permission.repository.js';

export class SandboxPermissionService {
  /**
   * 惰性缓存：仅在首次访问时从库加载并规整，之后常驻内存。
   * 这样构造期绝不触碰 db（与项目其它 repo 约定一致），避免 createRuntime 在测试 fake db 上崩溃。
   */
  private _config: SandboxPermissionConfig | null = null;
  private readonly repo: SandboxPermissionRepository;

  constructor(
    private readonly db: Db,
    private readonly sandboxRoot: string,
  ) {
    this.repo = new SandboxPermissionRepository(db);
  }

  /** 首次访问时加载并规整；若规整剔除了失效目录则写回单一事实源。 */
  private load(): SandboxPermissionConfig {
    const raw = this.repo.get();
    const loaded = normalizeConfig(raw, this.sandboxRoot);
    if (JSON.stringify(loaded) !== JSON.stringify(normalizeConfig(raw, this.sandboxRoot))) {
      this.repo.set(loaded);
    }
    this._config = loaded;
    return loaded;
  }

  private get config(): SandboxPermissionConfig {
    return this._config ?? this.load();
  }

  private set config(value: SandboxPermissionConfig) {
    this._config = value;
  }

  getConfig(): SandboxPermissionConfig {
    return this.config;
  }

  get allowDirs(): string[] {
    return this.config.allowDirs;
  }

  get autoApprove(): AutoApproveConfig {
    return this.config.autoApprove;
  }

  /**
   * 合并更新。allowDirs 为用户提交的「完整替换列表」（原始绝对路径），逐条服务端硬校验；
   * autoApprove 为部分覆盖。若有任何目录被拒，整体拒绝（不部分写入）。
   */
  update(
    partial: { allowDirs?: string[]; autoApprove?: Partial<AutoApproveConfig> } | null,
  ): { ok: true } | { ok: false; rejected: Array<{ dir: string; error: string }> } {
    if (!partial) return { ok: true };
    const nextDirs = partial.allowDirs ?? this.config.allowDirs;
    const rejected: Array<{ dir: string; error: string }> = [];
    const validated: string[] = [];
    for (const d of nextDirs) {
      const r = validateAllowDir(d, this.sandboxRoot);
      if (r.ok) validated.push(r.realPath);
      else rejected.push({ dir: d, error: r.error });
    }
    if (rejected.length > 0) return { ok: false, rejected };

    const next: SandboxPermissionConfig = {
      allowDirs: validated,
      autoApprove: { ...this.config.autoApprove, ...(partial.autoApprove ?? {}) },
    };
    // 运行中的 CallResolver 持有的是这个对象的引用：必须原地更新，
    // 否则用户在本次 run 里打开“免审批”后，后续调用仍按旧配置弹审批。
    Object.assign(this.config.autoApprove, next.autoApprove);
    this.config = { allowDirs: validated, autoApprove: this.config.autoApprove };
    this.repo.set(next);
    return { ok: true };
  }
}
