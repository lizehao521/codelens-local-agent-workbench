/**
 * 敏感路径黑名单（运行时，跨平台）。
 *
 * 用途：即使某个目录已被用户授权（allowDirs / sandbox_grants），
 * 其中的凭证与密钥类路径也必须继续被拒绝 —— 授权是「允许在这个目录里干活」，
 * 不是「把这个目录里的所有秘密都交出去」。
 *
 * 判定对象是**绝对路径**；工作区（沙箱根）内部的路径不走本黑名单：
 * 工作区里的 `.env` 是项目自己的配置，Agent 该能改（也受 checkpoint 兜底）。
 */

const SENSITIVE_SEGMENTS = new Set([
  '.ssh',
  '.aws',
  '.gnupg',
  '.kube',
  '.password-store',
  '.docker',
  'credentials',
  'keyrings',
  'user data',
  'login data',
  'local state',
]);

/** 目录级敏感组合：必须连续出现（避免误伤普通名为 config 的目录）。 */
const SENSITIVE_SEQUENCES: string[][] = [
  ['appdata', 'local', 'microsoft', 'credentials'],
  ['appdata', 'roaming', 'microsoft', 'credentials'],
  ['appdata', 'local', 'google', 'chrome', 'user data'],
  ['appdata', 'local', 'microsoft', 'edge', 'user data'],
  ['appdata', 'roaming', 'mozilla', 'firefox'],
  ['appdata', 'local', 'bravesoftware'],
  ['appdata', 'local', 'microsoft', 'windows', 'credentials'],
];

const SENSITIVE_BASENAMES = new Set([
  '.env',
  '.npmrc',
  '.netrc',
  '.pgpass',
  '.my.cnf',
  'credentials',
  'id_rsa',
  'id_dsa',
  'id_ecdsa',
  'id_ed25519',
  'authorized_keys',
  'known_hosts',
]);

const SENSITIVE_EXT = /\.(pem|key|p12|pfx|jks|keystore|kdbx)$/i;

/** 把路径切成小写段（同时兼容 `\` 与 `/`，不依赖运行平台）。 */
export function pathSegments(absPath: string): string[] {
  return absPath.toLowerCase().split(/[\\/]+/).filter(Boolean);
}

/** 路径是否命中敏感黑名单（凭证 / 密钥 / 浏览器配置 / 云厂商配置）。 */
export function isSensitivePath(absPath: string): boolean {
  if (typeof absPath !== 'string' || absPath.trim() === '') return false;
  const segs = pathSegments(absPath);
  const base = segs[segs.length - 1] ?? '';
  if (SENSITIVE_SEGMENTS.has(base)) return true;
  if (SENSITIVE_BASENAMES.has(base)) return true;
  if (base.startsWith('.env.')) return true;
  if (SENSITIVE_EXT.test(base)) return true;
  for (const seq of SENSITIVE_SEQUENCES) {
    for (let i = 0; i + seq.length <= segs.length; i += 1) {
      if (seq.every((part, k) => segs[i + k] === part)) return true;
    }
  }
  return false;
}
