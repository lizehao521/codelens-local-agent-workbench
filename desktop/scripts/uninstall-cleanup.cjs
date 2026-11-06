'use strict';

/**
 * F-05 卸载数据清理——兜底脚本（手动/无人值守场景）。
 *
 * 常规卸载**不删**用户数据（electron-builder.yml 的 deleteAppDataOnUninstall: false），
 * 保证升级/重装不丢会话。本脚本是「彻底清除」的显式入口：删除
 * %APPDATA%/CodeLens（codelens.db / sandbox / approval-secret.key / logs / config），
 * 以及早期版本误用的 %APPDATA%/codelens-desktop。
 *
 * 安全契约（破坏夹具逐条打红）：
 *  1. 目标目录只能由 %APPDATA% + "CodeLens" 拼出；APPDATA 缺失拒绝推断。
 *  2. 最终目录名必须恰为 CodeLens（大小写不敏感），否则拒绝删除，防误删其它目录。
 */

const path = require('node:path');
const fs = require('node:fs');

/** 计算待清理目录：%APPDATA%/CodeLens；无 APPDATA 时抛错（fail-closed）。 */
function resolveAppDataDir(env) {
  const appData = env && env.APPDATA;
  if (!appData || String(appData).trim() === '') {
    throw new Error('APPDATA 未设置，拒绝推断目标目录');
  }
  return path.join(appData, 'CodeLens');
}

/**
 * 删除 CodeLens 应用数据目录；目录名校验失败即抛错，绝不越界删除。
 * 同时清理 2.0 早期版本遗留的 codelens-desktop 目录（当时 package.json 缺
 * productName，Electron 用 name 当 userData 目录名），避免「清了还占磁盘」。
 */
function cleanupAppData(env) {
  const target = resolveAppDataDir(env);
  if (path.basename(target).toLowerCase() !== 'codelens') {
    throw new Error(`拒绝删除非 CodeLens 目录：${target}`);
  }
  fs.rmSync(target, { recursive: true, force: true });

  const legacy = path.join(path.dirname(target), 'codelens-desktop');
  if (path.basename(legacy).toLowerCase() === 'codelens-desktop') {
    fs.rmSync(legacy, { recursive: true, force: true });
  }
  return target;
}

module.exports = { resolveAppDataDir, cleanupAppData };

if (require.main === module) {
  try {
    const removed = cleanupAppData(process.env);
    console.log(`已删除应用数据目录：${removed}`);
  } catch (err) {
    console.error(err && err.message);
    process.exit(1);
  }
}