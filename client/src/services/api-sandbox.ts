// 沙箱权限端点与类型（自 api.ts 拆出；公开导出面不变）
import { get, send } from './api-http';

/** 沙箱权限配置：沙箱外允许目录（白名单）+ 自动放行高危操作开关。 */
export interface SandboxPermissionConfig {
  allowDirs: string[];
  autoApprove: {
    fsDestructive: boolean;
    purge: boolean;
    httpWrite: boolean;
  };
}

/** 沙箱权限更新载荷（allowDirs 为完整替换；autoApprove 为部分覆盖）。 */
export interface SandboxPermissionUpdate {
  allowDirs?: string[];
  autoApprove?: {
    fsDestructive?: boolean;
    purge?: boolean;
    httpWrite?: boolean;
  };
}

/** 被拒目录（422）。 */
export interface SandboxPermissionRejected {
  dir: string;
  error: string;
}

/** GET /api/v1/sandbox-permissions —— 当前沙箱权限配置。 */
export async function getSandboxPermissions(): Promise<SandboxPermissionConfig> {
  return get('/sandbox-permissions');
}

/**
 * PUT /api/v1/sandbox-permissions —— 更新（服务端硬校验）。
 * 任一 allowDir 被拒则整体 422 拒绝（不部分写入），rejected 列出被拒目录与原因。
 */
export async function updateSandboxPermissions(input: SandboxPermissionUpdate): Promise<SandboxPermissionConfig> {
  return send('/sandbox-permissions', input, 'PUT');
}
