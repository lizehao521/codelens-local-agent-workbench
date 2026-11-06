/**
 * 审批令牌 HMAC 主密钥解析（C-04）。
 *
 * 桌面端 `desktop/main.cjs` 会在服务端加载前生成随机密钥、写入 `%APPDATA%/CodeLens/approval-secret.key`
 * （0600 + ACL 收紧）并注入 env；但 web / 自托管 / Docker 路径此前只有进程内临时密钥，
 * 重启即让所有挂起审批失效。这里补齐「无 env 时生成并落盘」，保证重启后密钥不变。
 *
 * 解析优先级：
 *   1. 显式 env `AGENT_APPROVAL_SECRET`（桌面端/运维注入）→ 直接用；
 *   2. `<dataDir>/approval-secret.key` 存在且长度达标 → 读文件；
 *   3. 都没有（或文件损坏）→ 生成 32 字节随机 hex，0600 落盘。
 */

import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export type ApprovalSecretSource = 'env' | 'file' | 'generated';

export interface ResolvedApprovalSecret {
  value: string;
  source: ApprovalSecretSource;
  /** 落盘路径；仅 file / generated 时有值。 */
  path: string | null;
  /** true 表示本次调用新生成并写盘（供启动日志提示）。 */
  created: boolean;
}

const MIN_LENGTH = 32;
const FILE_NAME = 'approval-secret.key';

export function resolveApprovalSecret(envSecret: string, dataDir: string): ResolvedApprovalSecret {
  const fromEnv = (envSecret ?? '').trim();
  if (fromEnv.length > 0) {
    return { value: fromEnv, source: 'env', path: null, created: false };
  }

  const file = path.join(dataDir, FILE_NAME);
  try {
    if (existsSync(file)) {
      const value = readFileSync(file, 'utf8').trim();
      if (value.length >= MIN_LENGTH) {
        return { value, source: 'file', path: file, created: false };
      }
      // 文件存在但过短/损坏：落到下面重建。
    }
  } catch {
    // 读取失败按缺失处理，重建。
  }

  const value = randomBytes(32).toString('hex');
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(file, value, { mode: 0o600 });
  return { value, source: 'generated', path: file, created: true };
}
