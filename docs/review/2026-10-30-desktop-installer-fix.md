# 桌面安装包异常排查与重建（2026-10-30）

## 一、现象（修复前）

| # | 现象 | 证据 |
|---|---|---|
| 1 | 装机残留半截安装 | `%LOCALAPPDATA%\Programs\CodeLens` 下只剩 `Uninstall CodeLens.exe`（10-30 04:08），无 `CodeLens.exe` 与 `resources/` |
| 2 | 数据目录与文档不符 | 文档承诺 `%APPDATA%\CodeLens`，实际落在 `%APPDATA%\codelens-desktop` |
| 3 | 卸载会删用户数据 | 实测静默卸载后 `%APPDATA%\codelens-desktop`（含 241 KB 会话库）整体消失 |
| 4 | 卸载后桌面快捷方式残留 | 卸载退出码 0、开始菜单项已删，桌面 `CodeLens.lnk` 仍在（指向已删除的 exe，死图标） |
| 5 | 包内混入历史前端产物 | `resources/client/assets` 同时存在 6 份 `index-*.js` / 5 份 `index-*.css`（10-24 至 10-27 多次构建的残留，约 4 MB 垃圾） |

## 二、排查过程中的一次误判（记录以免复现）

宿主环境注入了 `ELECTRON_RUN_AS_NODE=1`，直接执行 `CodeLens.exe` 会让 Electron 退化成纯 Node 运行：

```
TypeError: Cannot read properties of undefined (reading 'requestSingleInstanceLock')
```

一度被误读为「安装包损坏、启动即崩」。用 `env -u ELECTRON_RUN_AS_NODE` 复测后，应用可正常起窗口、
`/api/health` 返回 200。**结论：二进制与 asar 内容没坏，问题出在打包配置语义与卸载/数据路径约定。**

同时确认：`app.asar` 内 `main.cjs`、`server-bundle.cjs` 与源码逐字节一致；安装器静默安装可释放 677 个文件。
所以「文件损坏」不成立，真正的问题是下面四条根因。

## 三、根因

| # | 根因 | 影响 |
|---|---|---|
| R1 | `desktop/package.json` 缺 `productName`，Electron 的 `app.getName()` 回退到包名 `codelens-desktop`，`userData` 因此是 `%APPDATA%\codelens-desktop` | 与文档、`uninstall-cleanup.cjs`、NSIS 的 `deleteAppDataOnUninstall` 三处约定全部错位：用户按文档备份找不到数据，清理脚本删不到东西 |
| R2 | `nsis.deleteAppDataOnUninstall: true`（文档写的是 `false`） | 卸载直接抹掉会话库/沙箱/审批密钥；且 NSIS 升级会先静默调用旧版卸载器，等于「升级一次，历史会话全没」 |
| R3 | electron-builder 内置卸载逻辑按注册表 `ShortcutName` 推导快捷方式路径，覆盖安装/跨版本场景下推导失配 | 卸载后桌面留死图标 |
| R4 | `scripts/prepare-dist.mjs` 按设计不做清理（注释称「残留无害」），每次构建把旧哈希资源一并打进 `extraResources` | 安装包体积虚增、回滚/校验时难以判断「当前生效的是哪份前端」 |

## 四、修复

| 文件 | 改动 |
|---|---|
| `desktop/package.json` | 新增 `productName: "CodeLens"`（+ `author`），`userData` 归位 `%APPDATA%\CodeLens` |
| `desktop/electron-builder.yml` | `deleteAppDataOnUninstall: false`（附原因注释）；新增 `nsis.include: build/installer.nsh` |
| `desktop/build/installer.nsh`（新增） | `customUnInstall` 兜底删除桌面/开始菜单快捷方式（当前名 + 历史包名），并刷新 shell 图标缓存 |
| `desktop/lib/user-data-migration.cjs`（新增） | 一次性把 `%APPDATA%\codelens-desktop` 的库/密钥/配置/沙箱搬到新目录：目标已有库则不动、无旧库则不建目录、同路径直接返回、只补缺失文件不覆盖 |
| `desktop/main.cjs` | 启动早期调用迁移（在读取密钥/打开数据库之前），结果直接追加进 `logs/server.log`，排障有据可查 |
| `desktop/test/user-data-migration.test.cjs`（新增） | 6 条用例：正常搬迁 + 4 条破坏夹具（已存在不覆盖/无旧数据不建目录/同路径 no-op/缺参数抛错） |
| `desktop/scripts/uninstall-cleanup.cjs` | 注释与契约对齐 `deleteAppDataOnUninstall: false`；彻底清除时连带清理遗留的 `codelens-desktop` |
| `docs/桌面端安装说明.md` | 尺寸/SHA256 更新为本次实测值；卸载契约、迁移说明、彻底清除入口写准 |

## 五、验证证据（针对最终产物）

- **单元测试**：`node --test`（desktop）→ **23 passed / 0 failed**
- **构建**：`node scripts/build-desktop-offline.mjs --skip-app-build` → **exit 0**
- **产物**：`CodeLens-Setup-2.0.0.exe`，**129,136,484 字节**，SHA256 `b0a99a17e1d6f3373ebd57e6d8ad57d59d50b2b9130f72e6e9706e53e68b13a9`（与 `RELEASE-MANIFEST.json` 一致）
- **包结构**：`app.asar` 含 `main.cjs` / `lib/user-data-migration.cjs` / `server-bundle.cjs` / `package.json`（`productName` 已生效）；`resources/client/assets` 只剩 1 份 `index-*.js` + 1 份 `index-*.css`
- **安装**：静默安装 exit 0，**666 个文件 / 377 MB**，`CodeLens.exe`、`resources/app.asar`、`resources/client/index.html`、`modelsync.json`、卸载器齐备
- **运行**：`/api/health` → `{"status":"ok","db":{"ok":true,"tables":10,"expectedTables":10}}`，窗口标题 `CodeLens - 通用 Agent 工具调用平台`
- **数据迁移**（模拟老用户：旧目录放 159,744 字节库 + 密钥 + MCP 配置）：
  - `server.log` 记录 `userData migrated into ...CodeLens (3 files) from codelens-desktop`
  - 新目录密钥内容与旧值一致（未重新生成）、`config/mcp-servers.json` 保留、`db.sizeBytes=159744` 与旧库一致
  - 旧目录保留原样，可人工回滚
- **卸载**：exit 0；程序目录**完全删除**；`%APPDATA%\CodeLens` **保留 97 个文件**（数据不丢）；桌面与开始菜单快捷方式**均已清理**

## 六、遗留（均非阻断）

1. `desktop/release*` 五个历史目录（各只含 `app.asar`）留在仓库内未删——本机批量删除守卫把 `rm -rf` 重定向到回收站后失败，可手工清理。
2. 安装器仍无商业代码签名，首次运行会触发 SmartScreen「仍要运行」，与本次问题无关（见安装说明 Q1）。
3. 构建期 `webpack/vite` 提示单个 chunk > 500 kB（`index-*.js` 670 kB），属性能优化项，不影响安装/运行。

## 七、诊断过程中对数据的副作用（如实记录）

排查 R2 时必须实测卸载行为，该次卸载使用的正是**未修复**的安装包：它按 `deleteAppDataOnUninstall: true`
删除了 `%APPDATA%\codelens-desktop`（当时含 241,664 字节的 `codelens.db`，为 10-23 至 10-28 的开发期数据）。
该目录未做备份，无法恢复；仓库内 `server/data/codelens.db` 与 `data/*.db` 为独立样本库，可作为初始数据重新导入。
修复后的版本已实测「卸载保数据」，同类操作不会再发生。
