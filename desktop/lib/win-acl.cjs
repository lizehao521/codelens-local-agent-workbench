'use strict';

/**
 * 收紧 approval-secret.key 的 Windows icacls 参数（纯函数，便于对偶测试）。
 *
 * 安全契约（破坏夹具逐条打红）：
 *  1. `/inheritance:r`  移除继承来的 ACE —— 否则上层目录赋给 Users/Administrators 的
 *                       权限会残留到密钥文件上。
 *  2. `/grant:r`        替换式（非追加 `/grant`）授予 —— 追加式会保留既有越权主体。
 *  3. `<用户名>:F`      仅授给当前用户整权，绝不授 BUILTIN\Users / Everyone / SYSTEM。
 *
 * @param {string} filePath 密钥文件绝对路径
 * @param {string} username 当前登录用户名（Windows %USERNAME%）
 * @returns {string[]} icacls 参数数组（首元素为文件路径）
 */
function buildIcalcsArgs(filePath, username) {
  if (!filePath || String(filePath).trim() === '') {
    throw new Error('buildIcalcsArgs: filePath is required');
  }
  if (!username || String(username).trim() === '') {
    throw new Error('buildIcalcsArgs: username is required');
  }
  return [filePath, '/inheritance:r', '/grant:r', `${username}:F`];
}

module.exports = { buildIcalcsArgs };