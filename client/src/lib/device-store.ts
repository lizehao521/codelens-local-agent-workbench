// 设备标识持久化 —— v2.0 服务端会话归属（localStorage 只存这两个小键）
// 会话本体在服务端 SQLite；本文件只存「哪台设备」与「上次看到哪条」。

const DEVICE_TOKEN_KEY = 'codelens.deviceToken.v2';
const ACTIVE_SESSION_KEY = 'codelens.activeSession.v2';

export function loadDeviceToken(): string | null {
  try {
    return localStorage.getItem(DEVICE_TOKEN_KEY);
  } catch {
    return null;
  }
}

export function saveDeviceToken(token: string): void {
  try {
    localStorage.setItem(DEVICE_TOKEN_KEY, token);
  } catch {
    /* 无痕模式等：内存态仍可用，恢复功能降级 */
  }
}

export function loadActiveSessionId(): string | null {
  try {
    return localStorage.getItem(ACTIVE_SESSION_KEY);
  } catch {
    return null;
  }
}

export function saveActiveSessionId(id: string | null): void {
  try {
    if (id) localStorage.setItem(ACTIVE_SESSION_KEY, id);
    else localStorage.removeItem(ACTIVE_SESSION_KEY);
  } catch {
    /* 忽略 */
  }
}
