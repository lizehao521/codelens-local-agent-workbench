/**
 * 跨平台 krsi 构建 + 对抗一致性套件入口。
 *
 * 取代原先写在 package.json 里的：
 *   go build -C krsi -o /tmp/krsi . && node --import tsx scripts/krsi-conformance.ts
 * 两个 Windows 问题：/tmp/krsi 是 POSIX 路径；产物没有 .exe 后缀，spawn 会 ENOENT，
 * 于是四态判决一律落成 verdict=error。
 *
 * Go 解析顺序：GO_BIN 环境变量 → PATH 中的 go → 常见安装位置（含 ~/sdk/go）。
 * 产物写到 os.tmpdir()，不进仓库；通过 KRSI_BIN_PATH 注入给 conformance 与 bridge。
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const isWin = process.platform === 'win32';
const goExe = isWin ? 'go.exe' : 'go';

function resolveGo() {
  if (process.env.GO_BIN && existsSync(process.env.GO_BIN)) return process.env.GO_BIN;
  const fromPath = spawnSync('go', ['version'], { stdio: 'ignore' });
  if (!fromPath.error && fromPath.status === 0) return 'go';
  const home = os.homedir();
  const candidates = [
    path.join(home, 'sdk', 'go', 'bin', goExe),
    isWin ? 'C:\\Go\\bin\\go.exe' : '/usr/local/go/bin/go',
    isWin ? 'C:\\Program Files\\Go\\bin\\go.exe' : '/usr/lib/go/bin/go',
  ];
  return candidates.find((c) => existsSync(c)) ?? null;
}

const go = resolveGo();
if (!go) {
  console.error('[krsi] 找不到 Go：请把 <GOROOT>/bin 加入 PATH，或设置 GO_BIN=/path/to/go');
  process.exit(2);
}

const binary = path.join(os.tmpdir(), isWin ? 'krsi.exe' : 'krsi');
const build = spawnSync(go, ['build', '-C', 'krsi', '-o', binary, '.'], {
  cwd: serverRoot,
  stdio: 'inherit',
});
if (build.error) {
  console.error(`[krsi] 编译启动失败：${build.error.message}`);
  process.exit(2);
}
if (build.status !== 0) process.exit(build.status ?? 1);
console.log(`[krsi] 已编译：${binary}`);

const run = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/krsi-conformance.ts'], {
  cwd: serverRoot,
  stdio: 'inherit',
  env: { ...process.env, KRSI_BIN_PATH: binary },
});
if (run.error) {
  console.error(`[krsi] conformance 启动失败：${run.error.message}`);
  process.exit(2);
}
process.exit(run.status ?? 1);
