#!/usr/bin/env node
/**
 * 将客户端构建产物复制进服务端静态托管目录（server/dist-client）。
 * 由根 package.json 的 build 脚本调用；Dockerfile 中由多阶段构建完成等价步骤。
 * 注意：不做删除清理——index.html 只引用当前哈希资产，旧文件残留无害；
 * 完整清理走 scripts/e2e.sh（构建前清空）。
 *
 * 实现说明：不用 fs.cpSync 整树复制——本机（Windows + 当前 Node 构建）下
 * cpSync 递归复制会触发段错误（SIGSEGV, exit 139）。改为手动遍历 +
 * copyFileSync 逐文件复制，语义完全一致。
 */
import { copyFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const clientDist = join(root, 'client', 'dist');
const serverDistClient = join(root, 'server', 'dist-client');

let copied = 0;

function copyTree(source, target) {
  mkdirSync(target, { recursive: true });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const from = join(source, entry.name);
    const to = join(target, entry.name);
    if (entry.isDirectory()) {
      copyTree(from, to);
    } else if (entry.isFile()) {
      mkdirSync(dirname(to), { recursive: true });
      copyFileSync(from, to);
      copied += 1;
    }
  }
}

if (!statSync(clientDist, { throwIfNoEntry: false })) {
  console.error(`[prepare-dist] 客户端产物不存在：${clientDist}（请先构建 client）`);
  process.exit(1);
}

copyTree(clientDist, serverDistClient);
console.log(`[prepare-dist] ${clientDist} -> ${serverDistClient}（${copied} 个文件）`);
