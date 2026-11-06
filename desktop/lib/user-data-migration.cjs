'use strict';

/**
 * F-06 用户数据目录迁移（一次性）。
 *
 * 背景：2.0 早期安装包的 desktop/package.json 未声明 productName，Electron 退回用
 * name（codelens-desktop）作为 userData 目录名；补齐 productName: CodeLens 之后，
 * userData 变成 %APPDATA%\CodeLens。目录改名不会自动带走历史数据，若不迁移，
 * 老用户升级后会看到「会话/配置全空」——这是比崩溃更难排查的数据丢失。
 *
 * 迁移契约（破坏夹具逐条打红）：
 *  1. 目标目录已有 codelens.db（即已有数据）→ 一律不动，只返回 target-has-data。
 *  2. 旧目录没有 codelens.db → 不创建任何文件，返回 no-legacy-data。
 *  3. 两个目录指向同一路径 → 直接返回 same-dir，绝不自我复制。
 *  4. 只复制缺失文件，已存在的目标文件绝不覆盖（避免把新配置改回旧的）。
 *  5. 旧目录保留原样，不删除——迁移失败可人工回滚。
 *
 * 不用 fs.cpSync：本机 Node 构建下递归 cpSync 会 SIGSEGV（见 scripts/prepare-dist.mjs）。
 */

const fs = require('node:fs');
const path = require('node:path');

/** 早期版本 userData 目录名（对齐 desktop/package.json 的 name）。 */
const LEGACY_DIRNAME = 'codelens-desktop';

/** 必须搬走的单文件（库 + 库的 WAL/SHM + 审批主密钥 + 上次端口）。 */
const MIGRATION_FILES = [
  'codelens.db',
  'codelens.db-wal',
  'codelens.db-shm',
  'approval-secret.key',
  'server-port.json',
];

/** 必须搬走的目录（MCP 配置、工具沙箱工作区）。 */
const MIGRATION_DIRS = ['config', 'sandbox'];

function samePath(a, b) {
  return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
}

function copyTreeIfMissing(from, to, counter) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isDirectory()) {
      copyTreeIfMissing(src, dst, counter);
    } else if (entry.isFile() && !fs.existsSync(dst)) {
      fs.copyFileSync(src, dst);
      counter.copied += 1;
    }
  }
}

/**
 * 把 legacyDir 的历史数据搬到 targetDir。
 *
 * @param {object} opts
 * @param {string} opts.targetDir 新版 userData 目录（%APPDATA%\CodeLens）
 * @param {string} opts.legacyDir 旧版 userData 目录（%APPDATA%\codelens-desktop）
 * @param {string[]} [opts.files] 覆盖迁移文件清单（测试用）
 * @param {string[]} [opts.dirs] 覆盖迁移目录清单（测试用）
 * @returns {{migrated: boolean, reason: string, copied: number}}
 */
function migrateLegacyUserData(opts) {
  const options = opts || {};
  const { targetDir, legacyDir } = options;
  if (!targetDir || !legacyDir) {
    throw new TypeError('migrateLegacyUserData 需要 targetDir 与 legacyDir');
  }
  const files = options.files || MIGRATION_FILES;
  const dirs = options.dirs || MIGRATION_DIRS;

  if (samePath(targetDir, legacyDir)) {
    return { migrated: false, reason: 'same-dir', copied: 0 };
  }
  if (fs.existsSync(path.join(targetDir, 'codelens.db'))) {
    return { migrated: false, reason: 'target-has-data', copied: 0 };
  }
  if (!fs.existsSync(path.join(legacyDir, 'codelens.db'))) {
    return { migrated: false, reason: 'no-legacy-data', copied: 0 };
  }

  const counter = { copied: 0 };
  fs.mkdirSync(targetDir, { recursive: true });
  for (const name of files) {
    const src = path.join(legacyDir, name);
    const dst = path.join(targetDir, name);
    if (fs.existsSync(src) && !fs.existsSync(dst)) {
      fs.copyFileSync(src, dst);
      counter.copied += 1;
    }
  }
  for (const name of dirs) {
    const src = path.join(legacyDir, name);
    if (fs.existsSync(src)) copyTreeIfMissing(src, path.join(targetDir, name), counter);
  }
  return { migrated: true, reason: 'complete', copied: counter.copied };
}

module.exports = {
  LEGACY_DIRNAME,
  MIGRATION_FILES,
  MIGRATION_DIRS,
  migrateLegacyUserData,
};
