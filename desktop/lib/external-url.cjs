'use strict';

/**
 * D-03 同源协议白名单（纯函数，便于对偶测试）。
 *
 * Electron 的 shell.openExternal 会把 URL 交给系统默认处理器——若放行任意协议，
 * `file:`/`smb:`/`codelens:`/`javascript:` 等可能触发本地文件执行或注册表劫持。
 * 这里只放行 http/https（交给系统浏览器），其余一律拒绝且不外抛。
 *
 * @param {unknown} url 待校验的 URL 字符串
 * @returns {boolean} true = 可安全交给系统浏览器打开
 */
function isSafeExternalUrl(url) {
  if (typeof url !== 'string') return false;
  if (url.trim() === '') return false;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return parsed.protocol === 'http:' || parsed.protocol === 'https:';
}

module.exports = { isSafeExternalUrl };