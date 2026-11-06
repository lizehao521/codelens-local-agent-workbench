'use strict';

/**
 * CodeLens 桌面外壳（Electron 主进程）。
 *
 * 架构：服务端（esbuild 打成单文件 server-bundle.cjs）在本进程内运行，
 * 窗口加载 http://127.0.0.1:<port>（同一来源，SPA + API，无 CORS）。
 *
 * 数据落点：
 *  - 打包态：%APPDATA%/CodeLens（codelens.db / sandbox / approval-secret.key / logs）
 *  - 开发态：<repo>/data/desktop-dev（不污染用户数据）
 *
 * 调试：
 *  - CODELENS_PORT 固定端口（烟测用）
 *  - CODELENS_DEVTOOLS=1 打开开发者工具
 */

const { app, BrowserWindow, Menu, shell, dialog } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const childProcess = require('node:child_process');
const { buildIcalcsArgs } = require('./lib/win-acl.cjs');
const { isSafeExternalUrl } = require('./lib/external-url.cjs');
const { buildErrorPageHtml } = require('./lib/error-page.cjs');
const {
  migrateLegacyUserData: migrateUserData,
  LEGACY_DIRNAME: LEGACY_USER_DATA_DIRNAME,
} = require('./lib/user-data-migration.cjs');

// ---------------------------------------------------------------------------
// 单实例锁
// ---------------------------------------------------------------------------
if (!app.requestSingleInstanceLock()) {
  app.quit();
  return;
}

const isPackaged = app.isPackaged;
const repoRoot = path.resolve(__dirname, '..');

// ---------------------------------------------------------------------------
// 数据目录与密钥持久化（必须在 require server-bundle 之前设置 env）
// ---------------------------------------------------------------------------
function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const dataDir = isPackaged
  ? ensureDir(app.getPath('userData'))
  : ensureDir(path.join(repoRoot, 'data', 'desktop-dev'));

// ---------------------------------------------------------------------------
// 数据目录迁移（一次性，必须在读取密钥/数据库之前执行）
//
// 早期安装包的 package.json 未声明 productName，Electron 退回用 name
// （codelens-desktop）作为 userData 目录名；补齐 productName: CodeLens 后
// userData 变为 %APPDATA%\CodeLens。目录改名不会自动带走历史数据，这里把旧目录
// 的数据库/密钥/配置/沙箱一次性搬到新目录（详见 lib/user-data-migration.cjs）。
// 迁移失败不阻断启动：新目录继续用，旧数据原样保留可人工恢复。
// ---------------------------------------------------------------------------
function migrateLegacyUserData(targetDir) {
  if (!isPackaged) return;
  try {
    const result = migrateUserData({
      targetDir,
      legacyDir: path.join(app.getPath('appData'), LEGACY_USER_DATA_DIRNAME),
    });
    if (result.migrated) {
      // console 的落盘钩子在下面才装好，这里直接追加到日志文件，
      // 保证「数据从哪来、搬了多少」在排障时有据可查。
      const line = `[${new Date().toISOString()}] [log] userData migrated into ${targetDir} `
        + `(${result.copied} files) from ${LEGACY_USER_DATA_DIRNAME}\n`;
      fs.appendFileSync(path.join(logDir, 'server.log'), line);
      console.log(`userData migrated into ${targetDir} (${result.copied} files)`);
    }
  } catch (err) {
    console.warn('userData 迁移失败（继续使用新目录）：', err && err.message);
  }
}

const sandboxRoot = ensureDir(path.join(dataDir, 'sandbox'));
const logDir = ensureDir(path.join(dataDir, 'logs'));

// 迁移必须在读取审批密钥/打开数据库之前完成；此处 logDir 已就绪，可直接落日志。
migrateLegacyUserData(dataDir);

const secretFile = path.join(dataDir, 'approval-secret.key');
let approvalSecret = '';
try {
  approvalSecret = fs.readFileSync(secretFile, 'utf8').trim();
} catch {
  /* 首次运行 */
}
if (approvalSecret.length < 32) {
  approvalSecret = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(secretFile, approvalSecret, { mode: 0o600 });
}

// D-04：approval-secret.key 是审批令牌的 HMAC 主密钥，必须仅当前用户可读。
// Windows 忽略 writeFileSync 的 mode 位、NTFS 继承上层目录 ACL，因此用 icacls 收紧；
// 该逻辑对「历史旧密钥」同样生效（覆盖此前以弱权限落盘的密钥文件）。非 Win 用 chmod 0o600。
function hardenSecretFileAcl() {
  if (process.platform === 'win32') {
    const username = process.env.USERNAME || process.env.USER;
    if (!username) {
      console.warn('approval-secret.key ACL 未收紧：无法取得当前用户名');
      return;
    }
    try {
      // execFileSync + argv 数组（非 shell），用户名含空格/特殊字符也安全。
      childProcess.execFileSync('icacls', buildIcalcsArgs(secretFile, username), { stdio: 'ignore' });
    } catch (err) {
      console.warn('approval-secret.key ACL 收紧失败（不影响启动，但请检查数据目录权限）：', err && err.message);
    }
  } else {
    try { fs.chmodSync(secretFile, 0o600); } catch { /* 权限纠正失败不影响启动 */ }
  }
}

// 仅当未显式指定时默认 production；允许外部（启动脚本 / 调试 / 测试）覆盖，
// 避免硬编码遮蔽 server/src/config/env.ts 的默认值与环境感知逻辑。
if (!process.env.NODE_ENV) process.env.NODE_ENV = 'production';
process.env.AGENT_DB_PATH = path.join(dataDir, 'codelens.db');
process.env.SANDBOX_ROOT = sandboxRoot;
process.env.AGENT_APPROVAL_SECRET = approvalSecret;
process.env.CLIENT_DIST_DIR = isPackaged
  ? path.join(process.resourcesPath, 'client')
  : path.join(repoRoot, 'server', 'dist-client');
// MCP 服务器配置必须可写：asar 内只读，统一落 userData/config
process.env.MCP_CONFIG_PATH = path.join(dataDir, 'config', 'mcp-servers.json');

// ── 能力开关（可观测面）──
// 桌面端默认**开启**这三项，但外部 env 优先（显式设为 '0' 或空串仍可关闭）：
//   · CHECKPOINT_ENABLED    工作区快照 / 按 id 回滚（N8）
//   · OBSERVABILITY_ENABLED 运行轨迹埋点，Act/Judge/Update 可回放（T11）
//   · SKILL_LIBRARY_ENABLED 程序化技能库，技能条目与匹配（N1）
//
// 必须在 require server-bundle 之前注入：server/src/config/env.ts 在模块顶层
// 读取这些变量（缺省全关），注入晚了能力就是关的。
//
// 用 `??` 而不是直接赋值：既保持"env 已设置则不覆盖"的既有约定（与上方
// modelsync 注入同一原则），也允许有人显式关掉某一项而不必改代码。
process.env.CHECKPOINT_ENABLED = process.env.CHECKPOINT_ENABLED ?? '1';
process.env.OBSERVABILITY_ENABLED = process.env.OBSERVABILITY_ENABLED ?? '1';
process.env.SKILL_LIBRARY_ENABLED = process.env.SKILL_LIBRARY_ENABLED ?? '1';

// ── 上游模型同步配置：config/modelsync.json（加入 .gitignore）→ process.env（env 优先） ──
// 在 require server-bundle 之前注入，使 server/src/config/env.ts 顶层读取到。
const MODELSYNC_ENV = {
  MODEL_SOURCE_URL: 'MODEL_SOURCE_URL',
  MODEL_REFRESH_INTERVAL_MS: 'MODEL_REFRESH_INTERVAL_MS',
  MODEL_SYNC_RETRY_MAX_ATTEMPTS: 'MODEL_SYNC_RETRY_MAX_ATTEMPTS',
  MODEL_SYNC_RETRY_BACKOFF_MS: 'MODEL_SYNC_RETRY_BACKOFF_MS',
  MODEL_SOURCE_ALLOW_INSECURE: 'MODEL_SOURCE_ALLOW_INSECURE',
  MODEL_SOURCE_ALLOW_PRIVATE: 'MODEL_SOURCE_ALLOW_PRIVATE',
  MODEL_SOURCE_FORMAT: 'MODEL_SOURCE_FORMAT',
};
function loadModelSyncConfig() {
  const file = isPackaged
    ? path.join(dataDir, 'config', 'modelsync.json')
    : path.join(repoRoot, 'config', 'modelsync.json');
  let cfg = {};
  try {
    if (fs.existsSync(file)) cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    cfg = {};
  }
  // 打包态：userData 内无配置时，回退到安装包内置默认配置（extraResources/modelsync.json）
  if (Object.keys(cfg).length === 0 && isPackaged) {
    const bundled = path.join(process.resourcesPath, 'modelsync.json');
    try {
      if (fs.existsSync(bundled)) {
        cfg = JSON.parse(fs.readFileSync(bundled, 'utf8'));
        // 写到 userData，便于用户查看与后续覆盖
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify(cfg, null, 2), 'utf8');
      }
    } catch {
      cfg = {};
    }
  }
  for (const [key, envName] of Object.entries(MODELSYNC_ENV)) {
    const val = cfg[key];
    if (val !== undefined && val !== null && String(val).trim() !== '' && process.env[envName] === undefined) {
      process.env[envName] = String(val); // env 已显式设置则优先于文件
    }
  }
}
loadModelSyncConfig();

// ---------------------------------------------------------------------------
// 服务端日志落盘（打包态没有 stdout，排障全靠它）
// ---------------------------------------------------------------------------
// 日志轮转：包模式没有 stdout，排障全靠这个文件；不限制体积会无界增长，
// 长期运行占满用户磁盘。超过 2MB 就滚动一次，保留 3 个历史。
const LOG_MAX_BYTES = 2 * 1024 * 1024;
const LOG_KEEP = 3;
const logFile = path.join(logDir, 'server.log');
function rotateLogIfNeeded() {
  try {
    const size = fs.existsSync(logFile) ? fs.statSync(logFile).size : 0;
    if (size < LOG_MAX_BYTES) return;
    for (let i = LOG_KEEP; i >= 1; i -= 1) {
      const src = i === 1 ? logFile : `${logFile}.${i - 1}`;
      const dst = `${logFile}.${i}`;
      if (fs.existsSync(src)) fs.renameSync(src, dst);
    }
  } catch {
    /* 轮转失败不能挡住启动 */
  }
}
rotateLogIfNeeded();

const logStream = fs.createWriteStream(logFile, { flags: 'a' });
function stringify(value) {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return value.stack || value.message;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
for (const level of ['log', 'info', 'warn', 'error']) {
  const original = console[level].bind(console);
  console[level] = (...args) => {
    logStream.write(`[${new Date().toISOString()}] [${level}] ${args.map(stringify).join(' ')}\n`);
    original(...args);
  };
}
process.on('uncaughtException', (err) => {
  console.error('uncaughtException:', err);
  logStream.write(`[${new Date().toISOString()}] [fatal] uncaughtException ${stringify(err)}\n`);
});
process.on('unhandledRejection', (reason) => {
  console.error('unhandledRejection:', reason);
});

// D-04：日志落盘通道就绪后再收紧密钥文件 ACL，任何收紧失败都能留痕到 server.log。
hardenSecretFileAcl();

// ---------------------------------------------------------------------------
// 启动内嵌服务端
// ---------------------------------------------------------------------------
let server = null;
let serverPort = 0;

const PORT_STATE_FILE = path.join(dataDir, 'server-port.json');
function readStoredPort() {
  try {
    const p = JSON.parse(fs.readFileSync(PORT_STATE_FILE, 'utf8')).port;
    if (Number.isInteger(p) && p > 0) return p;
  } catch { /* 首次运行或文件损坏 */ }
  return null;
}
function writeStoredPort(port) {
  try { fs.writeFileSync(PORT_STATE_FILE, JSON.stringify({ port })); } catch { /* 非致命 */ }
}

function startServer() {
  // CJS require：同步执行，保证在上面 env 设置之后（config/env.ts 模块顶层读 env）。
  // eslint-disable-next-line global-require
  const { createApp } = require('./server-bundle.cjs');
  const expressApp = createApp();
  // 固定端口：localStorage / IndexedDB 按 origin（含端口）分区，随机端口会让用户数据
  // （会话、设置、恢复码）每次启动都落入新 origin 而“被清空”。
  // 优先顺序：CODELENS_PORT 环境变量 > 上次成功端口（稳定优先）> 默认端口。
  const basePort = Number(process.env.CODELENS_PORT) || readStoredPort() || 18735;
  // AUDIT-029：绝不递增到随机端口。端口冲突时短暂重试同一端口（应对重启残留的
  // TIME_WAIT），仍被占用则干净失败——由启动链 catch 弹出错误框并退出，而不是
  // 静默换端口导致设备令牌/会话落入新 origin 而「被清空」。
  return new Promise((resolve, reject) => {
    const MAX_PORT_RETRIES = 3;
    let attempts = 0;
    const tryListen = () => {
      const srv = expressApp.listen(basePort, '127.0.0.1');
      srv.once('error', (err) => {
        if (err.code === 'EADDRINUSE' && attempts < MAX_PORT_RETRIES) {
          attempts += 1;
          srv.close();
          setTimeout(tryListen, 300);
        } else {
          reject(err);
        }
      });
      srv.once('listening', () => {
        server = srv;
        serverPort = srv.address().port; // 恒等于 basePort（不递增）
        writeStoredPort(serverPort);
        console.log(`codelens embedded server listening on 127.0.0.1:${serverPort}`);
        resolve();
      });
    };
    tryListen();
  });
}

// ---------------------------------------------------------------------------
// 窗口
// ---------------------------------------------------------------------------
/** @type {BrowserWindow | null} */
let mainWindow = null;

const LOADING_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head><meta charset="UTF-8" /><title>CodeLens</title>
<style>
  body { margin: 0; height: 100vh; display: flex; flex-direction: column;
         align-items: center; justify-content: center; background: #0E1526;
         font-family: "Segoe UI", "Microsoft YaHei", sans-serif; color: #9FB3D1; }
  .ring { width: 34px; height: 34px; border: 3px solid rgba(25,127,230,.25);
          border-top-color: #197FE6; border-radius: 50%;
          animation: spin 0.9s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  p { margin-top: 18px; font-size: 13px; letter-spacing: .08em; }
</style></head>
<body><div class="ring"></div><p>CODELENS 正在启动…</p></body></html>`;

function focusExistingWindow() {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function createMainWindow() {
  const iconPath = path.join(__dirname, 'build', 'icon.png');
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1080,
    minHeight: 720,
    show: false,
    backgroundColor: '#0E1526',
    title: 'CodeLens',
    icon: fs.existsSync(iconPath) ? iconPath : undefined,
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });

  Menu.setApplicationMenu(null);
  window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(LOADING_HTML)}`);

  const appOrigin = `http://127.0.0.1:${serverPort}`;

  // 安全：用 URL 解析后的 origin 严格比对，避免 userinfo 陷阱——
  // 例如 http://127.0.0.1:PORT@evil.com/ 经 startsWith 可绕过同域校验，
  // 而 new URL(...).origin 会得到 http://evil.com，与 appOrigin 不相等。
  const isSameOrigin = (url) => {
    try {
      return new URL(url).origin === appOrigin;
    } catch {
      return false;
    }
  };

  // D-08：加载失败 / 渲染进程崩溃 / preload 报错 / 首字节超时，都落到窗口内错误页
  //（含日志路径），而不是空白窗口或原生弹框——弹框没有重试路径。
  let appLoaded = false;
  let failed = false;
  const failPage = (title, detail) => {
    if (failed || window.isDestroyed()) return;
    failed = true;
    const html = buildErrorPageHtml({ title, detail, logPath: logFile });
    window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`).catch(() => undefined);
  };
  window.webContents.on('did-finish-load', () => {
    if (window.webContents.getURL().startsWith(appOrigin)) appLoaded = true;
  });
  window.webContents.on('did-fail-load', (_event, code, desc, _validatedURL, isMainFrame) => {
    if (isMainFrame && !appLoaded) failPage('CodeLens 加载失败', desc || `错误码 ${code}`);
  });
  window.webContents.on('render-process-gone', (_event, details) => {
    failPage('CodeLens 渲染进程异常', details.reason || 'render-process-gone');
  });
  window.webContents.on('preload-error', (_event, preloadPath, error) => {
    failPage('CodeLens 预加载失败', `${preloadPath}: ${error.message}`);
  });

  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isSameOrigin(url)) return { action: 'allow' };
    // D-03：非同源 URL 只放行 http/https 交给系统浏览器，其余协议（codelens:/file:/smb: 等）一律 deny。
    if (isSafeExternalUrl(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, url) => {
    if (!isSameOrigin(url)) {
      event.preventDefault();
      if (isSafeExternalUrl(url)) shell.openExternal(url);
    }
  });

  window.once('ready-to-show', () => window.show());
  // 兜底：加载页异常也要显示窗口
  setTimeout(() => {
    if (!window.isDestroyed() && !window.isVisible()) window.show();
  }, 10_000).unref();

  // 首字节超时：appOrigin 长时间无响应（服务已监听但未回包）时显示错误页。
  const appLoadTimer = setTimeout(() => {
    if (!appLoaded && !window.isDestroyed()) failPage('CodeLens 启动超时', '应用服务未在预期时间内响应');
  }, 20_000);
  appLoadTimer.unref();
  window.on('closed', () => clearTimeout(appLoadTimer));

  window.loadURL(appOrigin).catch((err) => {
    console.error('loadURL failed:', err);
    failPage('CodeLens 启动失败', err && err.message ? err.message : String(err));
  });

  if (process.env.CODELENS_DEVTOOLS === '1') {
    window.webContents.openDevTools({ mode: 'right' });
  }

  mainWindow = window;
  window.on('closed', () => {
    mainWindow = null;
  });
}

// ---------------------------------------------------------------------------
// 生命周期
// ---------------------------------------------------------------------------
app.on('second-instance', focusExistingWindow);

app
  .whenReady()
  .then(startServer)
  .then(createMainWindow)
  .catch((err) => {
    console.error('startup failed:', err);
    dialog.showErrorBox(
      'CodeLens 启动失败',
      `服务启动失败：${stringify(err)}\n\n请查看日志：${path.join(logDir, 'server.log')}`,
    );
    app.exit(1);
  });

app.on('window-all-closed', () => {
  app.quit();
});

app.on('quit', () => {
  if (server) {
    try {
      server.close();
    } catch {
      /* 已经关了 */
    }
  }
  logStream.end();
});
