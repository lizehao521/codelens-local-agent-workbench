/**
 * 沙箱权限配置（sandbox-permission）：允许目录（沙箱外白名单）+ 自动放行高危操作。
 *
 * 安全原则（强化内核 C2/C3 / 产品宪法）：放宽必须是用户显式、持久化的知情选择。
 * - allowDir 必须由服务端硬校验：绝对路径 / 真实目录 / 非沙箱根（及子孙或祖先）/
 *   非系统敏感目录 / 防 symlink 逃逸（realpath 后判定）。
 * - 豁免（autoApprove）只影响「是否弹审批条」，绝不绕过 jail（沙箱隔离）与 SSRF 的
 *   硬拒绝——越界与危险 URL 仍被 runGateway 的 SECURITY_DENIED 拦截。
 */

import { existsSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { isSensitivePath } from './sensitive-path.js';

export interface AutoApproveConfig {
  /** fs.write 的 delete / overwrite（已存在文件）—— 强制确认类操作 */
  fsDestructive: boolean;
  /** fs.write 的 purge（清空目录）—— 批量销毁 */
  purge: boolean;
  /** http.request 的 POST / PUT / PATCH / DELETE —— 改变外部状态 */
  httpWrite: boolean;
  // 硬约束：**禁止为 sys.exec（命令执行）新增豁免键**。
  // 上面三个键都对应「一类可枚举的、范围有限的」副作用；exec 的语义是
  // 「启动任意程序」，不存在可枚举范围，任何豁免键都等于一次点击换来永久 RCE。
  // 结构上也不可达：security-gateway.exemptCategory('sys.exec') 恒返回 null，
  // 且 runGateway 对 exec 落到 approvalMode==='none' 的判决直接按 SECURITY_DENIED 兜底。
}

export interface SandboxPermissionConfig {
  /** 已校验、绝对、realpath 后的允许目录（沙箱外白名单） */
  allowDirs: string[];
  autoApprove: AutoApproveConfig;
}

export const DEFAULT_PERMISSION_CONFIG: SandboxPermissionConfig = {
  allowDirs: [],
  autoApprove: { fsDestructive: false, purge: false, httpWrite: false },
};

/** 自动放行类别，与 AutoApproveConfig 的键一一对应。 */
export type ExemptCategory = keyof AutoApproveConfig;

/**
 * 系统敏感目录前缀（realpath 后）。命中即拒绝作为 allowDir，防止放开系统核心区域。
 * 在 POSIX 上 Windows 前缀不会触发，反之亦然；跨平台安全无影响。
 */
const RESTRICTED_DIR_PREFIXES: string[] = [
  // POSIX
  '/etc',
  '/usr',
  '/bin',
  '/sbin',
  '/System',
  '/Library',
  '/private',
  '/root',
  '/home',
  '/var',
  '/boot',
  '/dev',
  '/proc',
  '/sys',
  '/run',
  // Windows
  'C:\\Windows',
  'C:\\Windows\\System32',
  'C:\\Program Files',
  'C:\\Program Files (x86)',
  'C:\\ProgramData',
  // 注意：不再整段封禁 C:\Users。个人工具需要能把「文档/项目目录」这类
  // 用户目录按需授权；凭证类子路径由 sensitive-path 黑名单在运行时拒绝。
  'C:\\$Recycle.Bin',
  'C:\\Recovery',
];

/**
 * 校验单个候选目录是否可作为 allowDir。返回 realpath 后的真实路径（供存储），或拒绝原因。
 * 注意：symlink 经由 realpathSync 解析后再判定，逃逸路径（如指向 /etc 的软链）会被根/前缀规则拒绝。
 */
export function validateAllowDir(
  rawDir: string,
  sandboxRoot: string,
): { ok: true; realPath: string } | { ok: false; error: string } {
  if (typeof rawDir !== 'string' || rawDir.trim() === '') {
    return { ok: false, error: '目录不能为空' };
  }
  const dir = rawDir.trim();

  // 必须是绝对路径（跨平台识别 Windows 盘符 / UNC / POSIX 根）
  const isAbs = /^[a-zA-Z]:[\\/]/.test(dir) || dir.startsWith('\\\\') || dir.startsWith('/');
  if (!isAbs) {
    return { ok: false, error: '必须是绝对路径' };
  }

  if (!existsSync(dir)) {
    return { ok: false, error: '目录不存在' };
  }

  let realPath: string;
  try {
    realPath = realpathSync(dir);
  } catch {
    return { ok: false, error: '目录解析失败（可能是失效的符号链接）' };
  }

  let st: ReturnType<typeof statSync>;
  try {
    st = statSync(realPath);
  } catch {
    return { ok: false, error: '无法读取目录状态' };
  }
  if (!st.isDirectory()) {
    return { ok: false, error: '不是一个目录' };
  }

  // 不能把沙箱根自身、其子目录、或其上级目录作为 allowDir（无意义或绕过沙箱）
  const rootReal = realpathSync(path.resolve(sandboxRoot));
  if (realPath === rootReal || realPath.startsWith(rootReal + path.sep)) {
    return { ok: false, error: '不能把沙箱根或其子目录加入白名单（本就在沙箱内）' };
  }
  if (rootReal.startsWith(realPath + path.sep)) {
    return { ok: false, error: '不能把沙箱根的上级目录加入白名单（会放开整个沙箱体系）' };
  }

  // 凭证/密钥类目录（.ssh/.aws/浏览器配置等）永不授权：授权是「允许干活」，
  // 不是「把秘密交出去」。即使目录本身不是敏感目录，其内部子路径也由运行时拦截。
  if (isSensitivePath(realPath)) {
    return { ok: false, error: `敏感目录（凭证/密钥/浏览器配置），禁止加入白名单：${realPath}` };
  }

  // 系统敏感目录前缀（不区分大小写）。前缀后必须正好是分隔符或字符串结束，避免误伤相似名。
  const lower = realPath.toLowerCase();
  for (const prefix of RESTRICTED_DIR_PREFIXES) {
    const p = prefix.toLowerCase();
    if (lower === p || lower.startsWith(p + path.sep)) {
      return { ok: false, error: `系统敏感目录，禁止加入白名单：${realPath}` };
    }
  }

  return { ok: true, realPath };
}

/** 把任意 config 规整为合法结构（缺失字段回退默认值），并过滤掉无效的 allowDir。 */
export function normalizeConfig(raw: unknown, sandboxRoot: string): SandboxPermissionConfig {
  const obj = (raw ?? {}) as Record<string, unknown>;
  const autoRaw = (obj.autoApprove ?? {}) as Record<string, unknown>;
  const aa: AutoApproveConfig = {
    fsDestructive: autoRaw.fsDestructive === true,
    purge: autoRaw.purge === true,
    httpWrite: autoRaw.httpWrite === true,
  };
  const dirs: unknown = obj.allowDirs;
  const allowDirs: string[] = Array.isArray(dirs)
    ? dirs
        .filter((d): d is string => typeof d === 'string')
        .map((d) => validateAllowDir(d, sandboxRoot))
        .filter((r): r is { ok: true; realPath: string } => r.ok)
        .map((r) => r.realPath)
    : [];
  return { allowDirs, autoApprove: aa };
}
