/**
 * 工作区快照服务（tx/checkpoint）：捕获 → 列出 → 回滚。
 *
 * 定位：Agent 每轮文件修改**之前**自动捕获一次工作区快照；出问题时按快照 id
 * 一键回滚。这是「改了之后能退回去」的安全网，语义上只有一条：
 *
 *   - 快照**只**落工作区内的文件。目录、`.git`、`node_modules`、隐藏目录一律跳过；
 *     指向工作区外的符号链接一律**拒绝**（不算进快照），`..` 穿越直接报错。
 *   - 快照**正文不入库**。文件内容复制到 blobRoot/<id>/ 下，DB 只留清单
 *     （relPath / sha256 / size / blobPath），快照因此可审计、可比对。
 *   - 回滚**只写回快照里的文件**，不删除快照之外的新文件：回滚的语义是
 *     「把被我改坏的那些还原」，不是「把工作区恢复成某个绝对状态」。
 *
 * 闸门（回滚是唯一的写操作，必须双重确认）：
 *   1. 能力未启用 → 409 { enabled: false, error: 'CHECKPOINT_ENABLED 未开启' }
 *   2. 未携带显式确认头 `x-codelens-confirm: rollback` → 400
 *   3. 通过闸门后才执行回滚，返回 { enabled: true, report }
 * 服务层同时再挡一道：`enabled=false` 时 capture/restore 抛 CheckpointDisabledError，
 * 即便有人绕过 controller 直接调服务也写不进去。
 *
 * 「能力未启用时 capture 的行为」——**明确决策：抛 CheckpointDisabledError**
 * （code = 'CHECKPOINT_DISABLED'），而不是静默返回 undefined。
 * 理由：静默失败会让 Agent 那轮「以为有快照、其实没有」，出问题时无点可退；
 * 抛错是显式信号，调用方（运行时每轮自动捕获）可以据此跳过并继续。
 * list() 则相反：未启用时返回空数组（不抛异常），由 controller 表达成
 * `{ enabled: false, checkpoints: [] }`。
 *
 * ── 异步化（AUDIT-036 同源问题）────────────────────────────────────────
 * 文件 IO 全部走 node:fs/promises：不在事件循环上做同步 readdir/copyFile。
 * 代价是**引入了 TOCTOU 窗口**（realpath 判定与实际落盘之间，路径可能被换掉），
 * 因此这里的防护比同步版更严，**不为了异步而放松任何一条**：
 *
 *   1. 每个候选文件都做 realpath 解析（不只是末段是软链的那些），
 *      解析结果必须仍落在工作区 realpath 内，否则拒绝。
 *      —— 这一条同时堵住「祖先目录是软链」的越界读：
 *      `root/sub -> /etc` 时 `root/sub/passwd` 的 lstat 看着是普通文件，
 *      只有 realpath 才看得出它其实指向工作区外。
 *   2. 复制源用**已解析的 realpath**，不是原始路径：即使判定后软链被换掉，
 *      复制的仍是判定时那个已确认在区内的目标。
 *   3. sha256 对**入库的 blob 正文**计算，manifest 与正文必然自洽；
 *      分块读（64KB）流式喂 hash，不把整文件读进内存（大文件不该顶内存）。
 *   4. 回滚写回前，对目标父目录链重新做 realpath 校验，且写入落在**解析后的**
 *      父目录下，避免「判定后父目录被换成软链」。
 *
 * ══ 契约边界（运维读的就是这段，别让它漂移）════════════════════════════
 *
 * 【一】回滚能还原什么、不能还原什么
 *
 *   能还原：**内容**。快照里有的文件，写回它当时的内容（含「当时有、现在被删了」
 *   的文件会复活）。
 *   能撤销：**本 run 通过 `create` 新建的文件**。执行前的 capture 拍不到不存在的
 *   文件，执行后的 `captureAfter` 会补一条 `operation='create'` 的 diff（before 为空、
 *   after 为实际内容）；回滚时按记录的 after sha 判定，只删内容仍未变的。
 *   不能还原：**rename 的结构变更**。`rename` 的产物不是 `create` 操作，仍不会被删除。
 *
 *   具体到 `fs.write rename a.txt -> b.txt`：
 *     - `a.txt` 会被正确还原（它当时有内容，被拍进了快照）；
 *     - `b.txt`（rename 的产物）**不会被删除** —— 它不在 create 清单里。
 *   即：**回滚还原内容、删除本 run 的新建文件，但不撤销 rename**。
 *
 *   删除新建文件同样有「第二次破坏」风险，因此加了 sha 闸：
 *     - 磁盘内容仍等于 run 记录 after sha → 删除；
 *     - 用户后来改过 / 换成符号链接指向工作区外 → 保留（`kept`），绝不静默删。
 *   rename 产物因不在 create 清单里，维持原语义不删，属刻意边界。
 *
 * 【二】捕获的覆盖边界：白名单是**路径粒度**，只认 `path` / `newPath`
 *
 *   运行时每轮只把「本轮将被修改的路径」交给 capture。路径粒度决定了：
 *   **凡是不通过路径参数表达文件改动的副作用，都不在覆盖范围内**。具体：
 *
 *   - `fs.write`：6 个 operation 全部覆盖（create 因文件本来不存在而无内容可拍，
 *     属正常；purge 点名的是**目录**，capture 会递归展开该目录下的文件）。
 *   - `sys.exec`：**不在覆盖范围**。它用 `cwd` + 任意参数，经 `git` / `node`
 *     能改工作区内任意文件，而这两者不走 fs 工具的 `path` 参数 ——
 *     路径粒度原理上兜不住。**这是方案层面的原理性上限，不是实现缺陷**，
 *     也不打算用「exec 前再全量拍一次」来补（那等于白名单白做）。
 *     理由是分工清晰：exec 默认带审批闸、人在环；快照兜的是「工具直接改文件」。
 *   - **MCP 工具**：**不在覆盖范围**。MCP server 是运行时动态注册的，
 *     既不在内置工具的扫描范围内，也不走路径参数 —— 其副作用由 MCP server
 *     自己的实现负责，能力目录层管不了。
 *
 *   所以「自动捕获」准确的表述是「**仅 fs.write**」。
 *
 *   ⚠️ 这里**刻意不逐字复制**能力目录 `checkpoint` 条目的 detail 文案：
 *   那一侧管的是**捕获范围**（谁会被自动快照），本节管的是**回滚语义**
 *   （能还原什么、不能还原什么）。同一句话抄两遍，两处就会各自漂移 ——
 *   这正是本轮反复在消灭的那类问题。各管各的，边界事实一致但表述不共用。
 *   （能力目录那一侧的口径以它的 detail 为准；本节的机制说明以本文件为准。）
 *
 * 【三】为什么沙箱探针文件（`.health-probe-*.tmp`）可能被拍进快照，且不修
 *
 *   沙箱可写探针（`utils/sandbox-probe.ts`）会在**工作区根目录**写一个 2 字节的
 *   瞬态文件再删掉。它与 capture 遍历工作区撞上时会被拍进快照；回滚后会残留一个
 *   陈旧探针文件（2 字节，无害，不影响 sha256 校验与任何回滚语义）。
 *
 *   不修的理由（两条都成立）：
 *     - 认 `.health-probe-` 前缀 → 让 checkpoint 依赖**别的模块的私有文件命名约定**，
 *       跨模块耦合；
 *     - 「跳过所有隐藏文件」→ 会误伤 `.env` / `.gitignore` 这类**该被快照**的真实
 *       文件（Agent 改了它们就该能回滚）。
 *   若将来要解决，干净的落点确实是 checkpoint 侧的**通用语义规则**而非认文件名，
 *   但该规则必须同时满足两个约束（缺一不可）：
 *     (1) 能真正排除探针 —— 注意探针写的是 `'ok'`，**是 2 字节不是 0 字节**，
 *         「跳过 0 字节文件」这类规则**打不中**；
 *     (2) 不能牺牲空文件的还原能力 —— 空文件是合法状态（空配置、空 __init__.py、
 *         占位文件），若快照阶段跳过 0 字节文件，「agent 往空文件里写了内容」这种
 *         正常回滚需求将无法满足。
 */

import { createHash } from 'node:crypto';
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  unlink,
} from 'node:fs/promises';
// Dirent / Stats 是**类型**，它们由 node:fs 声明（node:fs/promises 只在运行时导出函数，
// 不重新导出这两个类型）；从 promises 里 import type 会直接编译失败。
import type { Dirent, Stats } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Db } from '../../repositories/db.js';
import { CheckpointRepository } from '../../repositories/checkpoint.repository.js';
import { AppError } from '../../utils/errors.js';
import { prefixedId } from '../../utils/hash.js';
import { lineDiff, renderUnified } from '../../tools/builtin/text-diff.tool.js';

/**
 * 一个待捕获文件：**清单里记什么** 与 **实际从哪复制** 是两件事。
 *
 *  - `relPath`：相对 root 的 POSIX 路径 —— 由**原始路径**算出（不是 realpath）。
 *    理由：realpath 会把 8.3 短路径（Windows 的 `C:\Users\ADMINI~1\...`）展开成
 *    长路径（`C:\Users\Administrator\...`），拿它做 relative 会算出 `..\..\`，
 *    反而把本来就在工作区内的文件判成越界。
 *  - `src`：realpath 解析后的**安全复制源** —— 复制用它，
 *    保证判定之后软链被换掉也复制不到区外。
 */
interface CaptureCandidate {
  relPath: string;
  src: string;
}

/**
 * 快照清单条目：DB 只存这些，不存正文。
 */
export interface CheckpointManifestEntry {
  /** 相对 root 的 POSIX 风格路径（始终用 `/` 分隔）。 */
  relPath: string;
  /** 内容摘要（sha256 hex）。 */
  sha256: string;
  /** 字节数。 */
  size: number;
  /** 快照正文相对路径（相对 blobRoot）。 */
  blobPath: string;
}

/**
 * 对外暴露的快照摘要（不含正文、不含清单）。
 *
 * `created` / `skipped` 是可选的附加信息（附加而非替换，调用方可忽略）：
 *   - created=false → 本次**没有**落任何快照记录（例如空白名单），id 为空串；
 *   - skipped      → 本次有多少文件被跳过、分别因为什么（不静默截断）。
 */
export interface CheckpointSummary {
  id: string;
  sessionId: string;
  label: string;
  fileCount: number;
  totalBytes: number;
  createdAt: number;
  /** 本次是否真的落了一条快照记录。 */
  created?: boolean;
  /** 跳过统计（仅当有跳过时出现）。 */
  skipped?: { count: number; reasons: Record<string, number> };
}

/**
 * 回滚结果：逐文件成败，不中断。
 *
 * 注意 `restored` 的含义是「**内容**已还原到快照时的状态」，
 * 不代表工作区被恢复成绝对状态。除本 run 通过 `create` 新建、且内容未被
 * 用户改过的文件会被删除（记入 `deleted`）外，快照之外的文件（包括
 * `rename` 的产物）不会被删除。详见 `CheckpointService.restore` 的边界说明。
 */
export interface RestoreReport {
  ok: boolean;
  restored: string[];
  failed: string[];
  /**
   * 本次撤销**删除**的「run 新建文件」（仅删内容仍等于 run 记录 after sha 的）。
   * 内容已被用户改过、或路径已不在工作区内的新建文件不会删，记入 `kept`。
   */
  deleted: string[];
  /** 本应删除但因内容已变 / 无法安全判定而保留下来的新建文件。 */
  kept: string[];
  /** 撤销留痕所需：本次撤销命中了哪些快照、是否按文件/按步过滤。 */
  restoreId?: string;
  runId?: string | null;
  step?: number | null;
  files?: string[] | null;
}

/** 按 run 查看证据链时的单文件改动。 */
export interface RunFileDiff {
  path: string;
  operation: string;
  beforeSha256: string | null;
  afterSha256: string | null;
  beforeBytes: number | null;
  afterBytes: number | null;
  added: number;
  removed: number;
  diff: string;
}

export interface RunEvidenceStep {
  checkpointId: string;
  step: number | null;
  toolCallIds: string[];
  createdAt: number;
  status: 'active' | 'pruned';
  restoredAt: number | null;
  files: RunFileDiff[];
}

/** C：续跑前的文件冲突（实际 sha 为 null 表示文件缺失或越界）。 */
export interface RunConflict {
  path: string;
  expectedSha256: string;
  actualSha256: string | null;
  step: number | null;
  checkpointId: string;
}

export interface RunEvidence {
  runId: string;
  sessions: string[];
  steps: RunEvidenceStep[];
  fileCount: number;
  totalBytes: number;
}

export interface CaptureOptions {
  label?: string;
  files?: string[];
  runId?: string | null;
  step?: number | null;
  toolCallIds?: string[];
}

const CREDENTIAL_BASENAMES = new Set([
  '.env',
  '.env.local',
  '.env.production',
  '.npmrc',
  '.netrc',
  'credentials',
  'id_rsa',
  'id_dsa',
  'id_ecdsa',
  'id_ed25519',
]);
const CREDENTIAL_EXT = /\.(pem|key|p12|pfx|jks|keystore)$/i;
const CREDENTIAL_DIRS = new Set(['.ssh', '.aws', '.gnupg', '.config']);

/** 凭证类文件不进快照（防泄漏）：正文可能包含密钥，且不需要被 Agent 回滚。 */
function isCredentialPath(relPath: string): boolean {
  const segments = relPath.split('/');
  const base = segments[segments.length - 1] ?? '';
  if (segments.some((s) => CREDENTIAL_DIRS.has(s))) return true;
  if (CREDENTIAL_BASENAMES.has(base)) return true;
  if (base.startsWith('.env.')) return true;
  return CREDENTIAL_EXT.test(base);
}

export interface CheckpointServiceOptions {
  db: Db;
  /** 工作区根（沙箱根）。快照只落这个目录内的文件。 */
  sandboxRoot: string;
  /** 能力开关。false 时 capture/restore 抛 CheckpointDisabledError。 */
  enabled: boolean;
  /** 单次快照最多文件数；0 = 不限。 */
  maxFiles: number;
  /** 单次快照最多总字节（单位 MB）；0 = 不限。 */
  maxBytes: number;
  /** 快照正文目录；缺省为 <db 同级>/checkpoints。 */
  blobRoot?: string;
}

/** 能力未启用。code 稳定，调用方据此决定「跳过」还是「报错」。 */
export class CheckpointDisabledError extends AppError {
  constructor(message = 'CHECKPOINT_ENABLED 未开启') {
    super('CHECKPOINT_DISABLED', message, 409);
    this.name = 'CheckpointDisabledError';
  }
}

/** 快照 id 不存在。 */
export class CheckpointNotFoundError extends AppError {
  constructor(id: string) {
    super('CHECKPOINT_NOT_FOUND', `快照不存在: ${id}`, 404);
    this.name = 'CheckpointNotFoundError';
  }
}

/** 路径逃逸（`..` 穿越 / 绝对路径 / 指向工作区外的符号链接）。 */
export class CheckpointPathError extends AppError {
  constructor(message: string) {
    super('CHECKPOINT_PATH_ESCAPE', message, 400);
    this.name = 'CheckpointPathError';
  }
}

/** 清单损坏（DB 里的 manifest_json 解析不出来）。 */
export class CheckpointManifestError extends AppError {
  constructor(message = '快照清单不是合法 JSON') {
    super('CHECKPOINT_MANIFEST_INVALID', message, 500);
    this.name = 'CheckpointManifestError';
  }
}

/** 一律跳过的目录名（任意层级）。 */
const SKIP_DIR_NAMES = new Set(['node_modules']);
const DEFAULT_LABEL = 'auto';
const MAX_LABEL_LEN = 200;
const MAX_NOTE_LEN = 160;
const HASH_CHUNK = 64 * 1024;

export class CheckpointService {
  private readonly repo: CheckpointRepository;
  private readonly sandboxRoot: string;
  private readonly enabledFlag: boolean;
  private readonly maxFiles: number;
  private readonly maxBytes: number;
  private readonly blobRoot: string;

  constructor(opts: CheckpointServiceOptions) {
    this.repo = new CheckpointRepository(opts.db);
    this.sandboxRoot = path.resolve(opts.sandboxRoot);
    this.enabledFlag = opts.enabled === true;
    this.maxFiles = Number.isFinite(opts.maxFiles) && opts.maxFiles > 0 ? Math.floor(opts.maxFiles) : 0;
    // maxBytes 单位是 MB；小数也接受（测试用），换算成字节后向下取整。
    this.maxBytes =
      Number.isFinite(opts.maxBytes) && opts.maxBytes > 0
        ? Math.floor(opts.maxBytes * 1024 * 1024)
        : 0;
    this.blobRoot = path.resolve(opts.blobRoot ?? defaultBlobRoot(opts.db));
  }

  /** 能力是否启用。controller 用它决定 409 / 200。 */
  get enabled(): boolean {
    return this.enabledFlag;
  }

  /** 快照正文目录（只读暴露，便于运维排查）。 */
  get blobDirectory(): string {
    return this.blobRoot;
  }

  /**
   * 捕获一次工作区快照。
   *
   * ── 白名单 vs 全量（重要，别混）────────────────────────────────────
   *  - `opts.files` **不传**（undefined）→ 遍历整个工作区；
   *  - `opts.files` **传了非空数组** → **只捕获这些相对路径**（白名单模式），
   *    绝不退化成全量遍历。这是运行时「每轮只拍本轮要改的文件」的用法；
   *  - `opts.files` **传空数组** → 本次无文件可拍，**不落任何快照记录**
   *    （不创建空快照、不建 blob 目录），返回 `created=false` 且 `id` 为空串。
   *    「空数组」与「不传」是两回事：不传 = 拍全量；空数组 = 明确表示「本轮没有」。
   *
   * `opts.files` 里出现 `..` 穿越或绝对路径 → **抛 CheckpointPathError**
   * （不是静默跳过：调用方明确点名要的文件抓不到，必须让它知道）。
   *
   * 超限（maxFiles / maxBytes）不是错误：超出的文件被跳过，但**不静默截断**——
   * 跳过的数量与原因会写进 label（形如 `[skipped 3: maxBytes:2, hidden-dir:1]`），
   * 同时通过返回值的 `skipped` 字段暴露，capture 与 list 都能看到。
   *
   * ── 覆盖边界：路径粒度，只认 `path` / `newPath` ──────────────────────
   * 运行时每轮只把「本轮将被修改的路径」交给 capture。白名单是**路径粒度**，
   * 因此**凡是不通过路径参数表达文件改动的副作用，都不在覆盖范围内**：
   * `sys.exec`（用 `cwd` + 任意参数，经 git/node 可改任意文件）与
   * **MCP 工具**（运行时动态注册，不走路径参数）的副作用都不被捕获。
   * 唯一的文件写入类内置工具 `fs.write` 的 6 个 operation 全部覆盖。
   * 详见类注释「契约边界」一节。
   */
  async capture(sessionId: string, opts: CaptureOptions = {}): Promise<CheckpointSummary> {
    if (!this.enabledFlag) throw new CheckpointDisabledError();
    const session = typeof sessionId === 'string' ? sessionId.trim() : '';
    if (!session) {
      throw new AppError('VALIDATION_ERROR', 'sessionId 不能为空', 400);
    }

    const rootAbs = path.resolve(this.sandboxRoot);
    await mkdir(rootAbs, { recursive: true });
    // 证据链目录只给当前用户读写（Windows 上是 no-op，POSIX 上收紧）。
    try {
      await mkdir(this.blobRoot, { recursive: true });
      await chmod(this.blobRoot, 0o700);
    } catch {
      /* 权限收紧失败不阻断快照；目录默认继承父级权限 */
    }
    const realRoot = await safeRealpath(rootAbs);

    // 空白名单 = 本轮无文件可拍。不落记录、不建 blob 目录。
    // 与「不传 files」（全量遍历）严格区分。
    if (opts.files !== undefined && opts.files.length === 0) {
      return {
        id: '',
        sessionId: session,
        label: (typeof opts.label === 'string' ? opts.label.trim() : '') || DEFAULT_LABEL,
        fileCount: 0,
        totalBytes: 0,
        createdAt: Date.now(),
        created: false,
      };
    }

    const id = prefixedId('cp');
    const blobDir = path.join(this.blobRoot, id);
    const manifest: CheckpointManifestEntry[] = [];
    const skipped = new Map<string, number>();
    let totalBytes = 0;

    const candidates = await this.collectCandidates(rootAbs, realRoot, opts.files, skipped);

    try {
      await mkdir(blobDir, { recursive: true });
      for (const candidate of candidates) {
        const relPath = candidate.relPath;
        const abs = candidate.src;

        // 防泄漏：凭证类文件不进快照（正文可能含密钥），也不进 diff。
        if (isCredentialPath(relPath)) {
          bump(skipped, 'credential');
          continue;
        }

        // realpath 已经解析过（collectCandidates 里做过），这里拿到的是安全源路径：
        // 复制源用解析后的路径，判定后软链被换掉也复制不到区外。
        let size: number;
        try {
          size = (await stat(abs)).size;
        } catch {
          bump(skipped, 'unreadable');
          continue;
        }

        // 限额：超出的文件跳过（不报错），并计入 skipped 原因。
        if (this.maxFiles > 0 && manifest.length >= this.maxFiles) {
          bump(skipped, 'maxFiles');
          continue;
        }
        if (this.maxBytes > 0 && totalBytes + size > this.maxBytes) {
          bump(skipped, 'maxBytes');
          continue;
        }

        const blobRel = `${id}/${relPath}`;
        const blobAbs = path.join(blobDir, ...relPath.split('/'));
        await mkdir(path.dirname(blobAbs), { recursive: true });
        try {
          await copyFile(abs, blobAbs);
        } catch {
          bump(skipped, 'unreadable');
          continue;
        }

        // 摘要对**入库的正文**计算：blob 与 manifest 必然自洽。
        // 分块读，不把整个文件读进内存。
        const digest = await sha256File(blobAbs);
        const blobSize = (await stat(blobAbs)).size;
        manifest.push({ relPath, sha256: digest, size: blobSize, blobPath: blobRel });
        totalBytes += blobSize;
      }

      // 白名单模式下若一个都没拍到，不落空记录（避免列表里堆空快照）。
      // 全量模式下拍到 0 个是合法快照（「空工作区也是一个快照」），照常落库。
      const whitelistMode = opts.files !== undefined;
      if (whitelistMode && manifest.length === 0) {
        await rm(blobDir, { recursive: true, force: true });
        return {
          id: '',
          sessionId: session,
          label: buildLabel(opts.label, skipped),
          fileCount: 0,
          totalBytes: 0,
          createdAt: Date.now(),
          created: false,
          ...(skipped.size > 0 ? { skipped: skippedReport(skipped) } : {}),
        };
      }

      const createdAt = Date.now();
      const label = buildLabel(opts.label, skipped);
      this.repo.insert({
        id,
        sessionId: session,
        label,
        root: rootAbs,
        fileCount: manifest.length,
        totalBytes,
        manifestJson: JSON.stringify(manifest),
        createdAt,
        runId: opts.runId ?? null,
        step: opts.step ?? null,
        toolCallIds: opts.toolCallIds ?? [],
      });

      return {
        id,
        sessionId: session,
        label,
        fileCount: manifest.length,
        totalBytes,
        createdAt,
        created: true,
        ...(skipped.size > 0 ? { skipped: skippedReport(skipped) } : {}),
      };
    } catch (err) {
      // 入库失败不留孤儿正文：快照正文与 DB 行必须同时成立或同时消失。
      try {
        await rm(blobDir, { recursive: true, force: true });
      } catch {
        /* 清理失败不掩盖原始错误 */
      }
      throw err;
    }
  }

  /** 列出快照（按时间倒序）。能力未启用时返回空数组，不抛异常。 */
  list(sessionId?: string): CheckpointSummary[] {
    if (!this.enabledFlag) return [];
    const rows = sessionId ? this.repo.list(sessionId) : this.repo.list();
    return rows.map((row) => ({
      id: row.id,
      sessionId: row.session_id,
      label: row.label,
      fileCount: row.file_count,
      totalBytes: row.total_bytes,
      createdAt: row.created_at,
      created: true,
    }));
  }

  /**
   * 按快照 id 回滚。
   *
   * 语义：把快照里的每个文件写回它当时的位置（含「当时有、现在被删了」的文件），
   * 并删除本快照记录为 `create` 的新建文件 —— **前提是磁盘内容仍等于记录里的
   * after sha**。用户后来改过（或换成符号链接指向工作区外）的新建文件一律保留，
   * 记入 `kept`，避免撤销造成二次数据丢失。写回后逐个校验 sha256；
   * 单个文件失败不中断，记入 failed；`ok = failed.length === 0`。
   *
   * ── 能还原什么、不能还原什么（边界，刻意为之）─────────────────────────
   * 能还原**内容**与**本 run 新建的文件**；仍不能还原 `rename` 的结构变更。
   * `fs.write rename a.txt -> b.txt` 后回滚：`a.txt` 被正确还原，
   * 但 `b.txt`（rename 的产物，不是 `create` 操作）**不会被删除**。
   *
   * 这是刻意语义而非遗漏：rename 产物不在 create 清单里，删除它同样是
   * 第二次破坏的风险点（用户在 rename 之后若已在 b.txt 上写了新内容）。
   * 要支持「删除 rename 产物」需给快照引入更细的操作记录，属契约变更，应独立评估。
   * 详见类注释「契约边界」一节。
   */
  async restore(id: string, opts: { files?: string[]; runId?: string | null; step?: number | null } = {}): Promise<RestoreReport> {
    if (!this.enabledFlag) throw new CheckpointDisabledError();
    const row = this.repo.get(id);
    if (!row) throw new CheckpointNotFoundError(id);
    if (row.status === 'pruned') {
      throw new AppError('CHECKPOINT_PRUNED', `快照已被保留策略淘汰，正文不可用: ${id}`, 409);
    }

    const rootAbs = path.resolve(row.root || this.sandboxRoot);
    const realRoot = await safeRealpath(rootAbs);
    const all = parseManifest(row.manifest_json);
    const filter = opts.files && opts.files.length > 0
      ? new Set(opts.files.map((f) => toPosix(f).replace(/\\/g, '/')))
      : null;
    const manifest = filter ? all.filter((entry) => filter.has(entry.relPath)) : all;

    const restored: string[] = [];
    const failed: string[] = [];
    const deleted: string[] = [];
    const kept: string[] = [];

    // 新建文件（operation='create'）：撤销语义是「删掉 run 建的东西」。
    // 只删内容仍等于 run 记录 after sha 的文件；用户后来改过的一律保留（kept），
    // 避免撤销对用户的新内容造成二次破坏。
    const diffs = parseDiffs(row.diff_json);
    for (const file of diffs) {
      if (file.operation !== 'create' || !file.afterSha256) continue;
      if (filter && !filter.has(file.path)) continue;
      const relPath = file.path;
      try {
        const target = await resolveExplicitPath(rootAbs, relPath);
        const real = await realpath(target);
        if (!isInside(realRoot, real)) throw new CheckpointPathError(`删除目标越出工作区: ${relPath}`);
        const lst = await lstat(target);
        if (!lst.isFile()) {
          kept.push(relPath);
          continue;
        }
        const digest = await sha256File(target);
        if (digest !== file.afterSha256) {
          kept.push(relPath);
          continue;
        }
        await unlink(target);
        deleted.push(relPath);
      } catch {
        // 文件已不存在 → 无需删除（也不记 kept：撤销目标状态已满足）。
        // 其余异常一律按「保留」处理，绝不静默删除。
        if (await pathExists(path.resolve(rootAbs, ...relPath.split('/')))) kept.push(relPath);
      }
    }

    for (const entry of manifest) {
      const relPath = entry.relPath;
      try {
        const target = await resolveWriteTarget(rootAbs, realRoot, relPath);
        const blobAbs = path.join(this.blobRoot, ...entry.blobPath.split('/'));
        if (!isInside(this.blobRoot, blobAbs)) {
          throw new CheckpointPathError(`快照正文路径越界: ${entry.blobPath}`);
        }
        await mkdir(path.dirname(target), { recursive: true });
        await copyFile(blobAbs, target);
        // 写回后校验：正文被篡改/拷贝出错都必须被看见，不能报「成功」。
        const digest = await sha256File(target);
        if (digest !== entry.sha256) {
          throw new Error(`写回后 sha256 校验失败: ${relPath}`);
        }
        restored.push(relPath);
      } catch {
        // 单文件失败不中断整批：其余文件照常回滚。
        failed.push(relPath);
      }
    }

    const at = Date.now();
    const report: RestoreReport = {
      ok: failed.length === 0,
      restored,
      failed,
      deleted,
      kept,
      restoreId: id,
      runId: opts.runId ?? row.run_id ?? null,
      step: opts.step ?? row.step ?? null,
      files: filter ? [...filter] : null,
    };
    this.repo.markRestored(id, JSON.stringify(report), at);
    return report;
  }

  /**
   * run 粒度撤销：默认还原该 run 的所有步骤；传 step 则只还原该步；
   * 传 files 则只还原这些文件。每次撤销都会在每条快照上写 restore_json 留痕。
   */
  async restoreRun(runId: string, opts: { step?: number | null; files?: string[] } = {}): Promise<RestoreReport & { snapshots: number }> {
    if (!this.enabledFlag) throw new CheckpointDisabledError();
    const rows = this.repo
      .listByRun(runId)
      .filter((row) => opts.step == null || row.step === opts.step);
    const restored: string[] = [];
    const failed: string[] = [];
    const deleted: string[] = [];
    const kept: string[] = [];
    for (const row of rows) {
      if (row.status === 'pruned') {
        failed.push(`[pruned] ${row.id}`);
        continue;
      }
      const report = await this.restore(row.id, { files: opts.files, runId, step: row.step });
      restored.push(...report.restored);
      failed.push(...report.failed);
      deleted.push(...report.deleted);
      kept.push(...report.kept);
    }
    // 同一新建文件可能在多步出现：以「实际删掉」为准，不再把它列进保留清单。
    const deletedUnique = [...new Set(deleted)];
    const keptUnique = [...new Set(kept)].filter((p) => !deletedUnique.includes(p));
    return {
      ok: failed.length === 0,
      restored,
      failed,
      deleted: deletedUnique,
      kept: keptUnique,
      runId,
      step: opts.step ?? null,
      files: opts.files ?? null,
      snapshots: rows.length,
    };
  }

  /**
   * 执行后回填：对同一条 before 快照记录读取当前文件，计算 sha256 + 行级 diff。
   *
   * 为什么 after 不新开一条记录：撤销时必须能「一步之内拿到 before 与 after」，
   * 两条独立记录要靠 runId+step 拼，容易在并发下错配。回填同一条最稳。
   */
  async captureAfter(
    runId: string,
    step: number,
    opts: {
      files?: string[];
      /**
       * 本轮 `fs.write` 的 `operation=create` 目标。新建文件在执行前不存在，
       * `capture` 拍不到任何内容（无 before 记录）；这里在执行后补一条「新增」记录。
       * 仅在执行后确实存在、且不在 before 清单里的路径记为 create。
       */
      createdFiles?: string[];
      /** 无 before 记录时需要新建一行（create-only 步骤），用于关联 run/step/调用。 */
      sessionId?: string;
      toolCallIds?: string[];
    } = {},
  ): Promise<{ checkpointId: string; files: RunFileDiff[] } | null> {
    if (!this.enabledFlag) throw new CheckpointDisabledError();
    const rows = this.repo.listByRun(runId).filter((row) => row.step === step && row.status === 'active');
    const row = rows[rows.length - 1];

    const rootAbs = path.resolve(row?.root || this.sandboxRoot);
    const before = row ? parseManifest(row.manifest_json) : [];
    const filter = opts.files && opts.files.length > 0
      ? new Set(opts.files.map((f) => toPosix(f).replace(/\\/g, '/')))
      : null;
    const afterManifest: CheckpointManifestEntry[] = [];
    const diffs: RunFileDiff[] = [];

    for (const entry of before) {
      if (filter && !filter.has(entry.relPath)) continue;
      const abs = path.join(rootAbs, ...entry.relPath.split('/'));
      if (!isInside(rootAbs, abs)) continue;

      const beforeAbs = path.join(this.blobRoot, ...entry.blobPath.split('/'));
      let beforeBuf: Buffer | null = null;
      try {
        beforeBuf = await readFile(beforeAbs);
      } catch {
        beforeBuf = null;
      }

      let afterStat: Stats | null = null;
      try {
        afterStat = await stat(abs);
      } catch {
        afterStat = null;
      }
      let afterBuf: Buffer | null = null;
      let afterSha: string | null = null;
      let afterBytes: number | null = null;
      if (afterStat?.isFile()) {
        try {
          afterBuf = await readFile(abs);
          afterSha = await sha256File(abs);
          afterBytes = afterStat.size;
          afterManifest.push({ relPath: entry.relPath, sha256: afterSha, size: afterBytes, blobPath: '' });
        } catch {
          afterBuf = null;
        }
      }

      const binary =
        (beforeBuf?.includes(0) ?? false) ||
        (afterBuf?.includes(0) ?? false) ||
        (beforeBuf?.length ?? 0) > 512 * 1024 ||
        (afterBuf?.length ?? 0) > 512 * 1024;

      let added = 0;
      let removed = 0;
      let diff = '';
      if (binary) {
        diff = '[二进制或大文件：未做行级 diff]';
      } else {
        const left = beforeBuf ? beforeBuf.toString('utf8').split('\n') : [];
        const right = afterBuf ? afterBuf.toString('utf8').split('\n') : [];
        const rendered = renderUnified(lineDiff(left, right), 3);
        added = rendered.additions;
        removed = rendered.deletions;
        diff = rendered.text.slice(0, 8000);
      }

      diffs.push({
        path: entry.relPath,
        operation: 'write',
        beforeSha256: entry.sha256,
        afterSha256: afterSha,
        beforeBytes: entry.size,
        afterBytes,
        added,
        removed,
        diff,
      });
    }

    // —— 新建文件（create）——
    // capture 阶段目标还不存在，白名单模式下会得到空 manifest、不落记录；
    // 执行后在这里补「新增」条目：before 为空、after 为实际落盘内容。
    const createdPaths = new Set(
      (opts.createdFiles ?? [])
        .map((p) => toPosix(String(p)).replace(/\\/g, '/'))
        .filter((p) => p.length > 0),
    );
    for (const relPath of createdPaths) {
      if (isCredentialPath(relPath)) continue;
      if (before.some((entry) => entry.relPath === relPath)) continue;
      if (diffs.some((d) => d.path === relPath)) continue;
      const abs = path.join(rootAbs, ...relPath.split('/'));
      if (!isInside(rootAbs, abs)) continue;

      let afterStat: Stats | null = null;
      try {
        afterStat = await stat(abs);
      } catch {
        afterStat = null;
      }
      if (!afterStat?.isFile()) continue;

      let afterBuf: Buffer | null = null;
      let afterSha: string;
      try {
        afterBuf = await readFile(abs);
        afterSha = await sha256File(abs);
      } catch {
        continue;
      }
      afterManifest.push({ relPath, sha256: afterSha, size: afterStat.size, blobPath: '' });

      const binary = afterBuf.includes(0) || afterBuf.length > 512 * 1024;
      let added = 0;
      let diff = '';
      if (binary) {
        diff = '[二进制或大文件：未做行级 diff]';
      } else {
        const rendered = renderUnified(lineDiff([], afterBuf.toString('utf8').split('\n')), 3);
        added = rendered.additions;
        diff = rendered.text.slice(0, 8000);
      }

      diffs.push({
        path: relPath,
        operation: 'create',
        beforeSha256: null,
        beforeBytes: null,
        afterSha256: afterSha,
        afterBytes: afterStat.size,
        added,
        removed: 0,
        diff,
      });
    }

    let checkpointId: string;
    if (row) {
      checkpointId = row.id;
    } else {
      if (diffs.length === 0) return null;
      const session = typeof opts.sessionId === 'string' ? opts.sessionId.trim() : '';
      if (!session) {
        throw new AppError('VALIDATION_ERROR', '补记新建文件需要 sessionId', 400);
      }
      checkpointId = prefixedId('cp');
      this.repo.insert({
        id: checkpointId,
        sessionId: session,
        label: 'create',
        root: rootAbs,
        fileCount: 0,
        totalBytes: 0,
        manifestJson: '[]',
        createdAt: Date.now(),
        runId,
        step,
        toolCallIds: opts.toolCallIds ?? [],
      });
    }

    this.repo.updateAfter(checkpointId, JSON.stringify(afterManifest), JSON.stringify(diffs));
    return { checkpointId, files: diffs };
  }

  /** 按 run 查「改了什么 + 来自哪一步」。 */
  getRun(runId: string): RunEvidence {
    const rows = this.repo.listByRun(runId);
    const steps: RunEvidenceStep[] = rows.map((row) => {
      const files = parseDiffs(row.diff_json);
      let toolCallIds: string[] = [];
      try {
        toolCallIds = JSON.parse(row.tool_call_ids_json) as string[];
      } catch {
        toolCallIds = [];
      }
      return {
        checkpointId: row.id,
        step: row.step,
        toolCallIds,
        createdAt: row.created_at,
        status: row.status,
        restoredAt: row.restored_at,
        files,
      };
    });
    return {
      runId,
      sessions: [...new Set(rows.map((row) => row.session_id))],
      steps,
      fileCount: new Set(steps.flatMap((s) => s.files.map((f) => f.path))).size,
      totalBytes: rows.reduce((sum, row) => sum + row.total_bytes, 0),
    };
  }

  /**
   * C：续跑前强校验 —— 对每个已改动文件比对磁盘当前 sha256 与 run 记录的 after 值。
   * 只读：不恢复、不写盘；任何不一致都返回冲突清单，由调用方拒绝续跑。
   * 同一文件被多步改动时，以最后一步的 after 为准（中间步的 after 本就应被覆盖）。
   */
  async verifyRun(runId: string): Promise<{ ok: boolean; conflicts: RunConflict[] }> {
    if (!this.enabledFlag) throw new CheckpointDisabledError();
    const rows = this.repo.listByRun(runId);
    const latest = new Map<string, { expected: string; step: number | null; checkpointId: string; root: string }>();

    for (const row of rows) {
      if (row.status === 'pruned') continue;
      const files = parseDiffs(row.diff_json);
      for (const file of files) {
        if (!file.afterSha256) continue;
        const prev = latest.get(file.path);
        // rows 按 run 内时间序返回；后出现的覆盖前者，等价于「最后一步」。
        if (!prev) {
          latest.set(file.path, {
            expected: file.afterSha256,
            step: row.step,
            checkpointId: row.id,
            root: path.resolve(row.root || this.sandboxRoot),
          });
        } else {
          prev.expected = file.afterSha256;
          prev.step = row.step;
          prev.checkpointId = row.id;
          prev.root = path.resolve(row.root || this.sandboxRoot);
        }
      }
    }

    const conflicts: RunConflict[] = [];
    for (const [relPath, record] of latest) {
      const abs = path.join(record.root, ...relPath.split('/'));
      let actualSha256: string | null = null;
      try {
        if (isInside(record.root, abs)) actualSha256 = await sha256File(abs);
      } catch {
        actualSha256 = null;
      }
      if (actualSha256 !== record.expected) {
        conflicts.push({
          path: relPath,
          expectedSha256: record.expected,
          actualSha256,
          step: record.step,
          checkpointId: record.checkpointId,
        });
      }
    }
    return { ok: conflicts.length === 0, conflicts };
  }

  pin(id: string, pinned: boolean): boolean {
    return this.repo.pin(id, pinned) > 0;
  }

  /**
   * 保留策略：默认最多 20 个 run 或 200 MB，先到先淘汰。
   * 淘汰只删正文（blob），保留行与 diff 摘要（status='pruned'）；
   * pinned 永不淘汰。legacy 会话快照（无 runId）不参与此策略。
   */
  async prune(opts: { maxRuns?: number; maxBytes?: number } = {}): Promise<{ evictedRuns: string[]; evictedCheckpoints: number }> {
    const maxRuns = opts.maxRuns ?? 20;
    const maxBytes = opts.maxBytes ?? 200 * 1024 * 1024;
    const runs = this.repo.listActiveRunsOldest();
    const evicted = new Set<string>();

    const overflow = Math.max(0, runs.length - maxRuns);
    for (let i = 0; i < overflow; i += 1) evicted.add(runs[i]!.run_id);

    let total = this.repo.totalActiveBytes();
    for (const run of runs) {
      if (total <= maxBytes) break;
      if (!evicted.has(run.run_id)) {
        evicted.add(run.run_id);
        total -= run.bytes;
      }
    }

    let evictedCheckpoints = 0;
    for (const runId of evicted) {
      const rows = this.repo.listByRun(runId).filter((row) => row.status === 'active' && row.pinned === 0);
      if (rows.length === 0) continue;
      this.repo.markPruned(rows.map((row) => row.id));
      evictedCheckpoints += rows.length;
      for (const row of rows) {
        try {
          await rm(path.join(this.blobRoot, row.id), { recursive: true, force: true });
        } catch {
          /* 正文清理失败不掩盖淘汰结果；行已标记 pruned */
        }
      }
    }
    return { evictedRuns: [...evicted], evictedCheckpoints };
  }

  /**
   * 收集待捕获文件（绝对路径，已按 root 归一）。
   *
   * 显式清单与全量遍历共用同一套安全判定：
   *  - `..` 穿越 / 绝对路径 → 抛 CheckpointPathError（调用方点名的文件抓不到必须让它知道）；
   *  - 指向工作区外的符号链接（含**祖先目录**是软链的情形）→ 拒绝：
   *    显式点名时抛错；全量遍历时记入 skipped，不进快照；
   *  - 目录 / 隐藏目录 / node_modules → 跳过。
   */
  private async collectCandidates(
    rootAbs: string,
    realRoot: string,
    explicitFiles: string[] | undefined,
    skipped: Map<string, number>,
  ): Promise<CaptureCandidate[]> {
    if (explicitFiles !== undefined) {
      const out: CaptureCandidate[] = [];
      for (const raw of explicitFiles) {
        const abs = resolveExplicitPath(rootAbs, raw);
        // 点名的是**目录** → 递归展开成目录下的文件。
        // 原因：`fs.write` 的 purge 操作会「删掉整个目录再重建空目录」，
        // 而调用方传给白名单的是**目录路径**。若这里把目录直接跳过，
        // purge 就会「拍不到任何文件」——安全网在最该兜底的批量破坏操作上失效。
        if (await this.isSafeDir(abs, realRoot, skipped)) {
          out.push(...(await this.walk(abs, rootAbs, realRoot, skipped)));
          continue;
        }
        const safe = await this.resolveSafeSource(abs, realRoot, skipped, true);
        if (safe) out.push({ relPath: toPosix(path.relative(rootAbs, abs)), src: safe });
      }
      return out;
    }
    return this.walk(rootAbs, rootAbs, realRoot, skipped);
  }

  /**
   * 该路径是否是一个**可安全遍历的目录**。
   *
   * 目录软链指向区外 → 拒绝并抛错（与文件同一把尺子）。
   *
   * 注意：这里返回的是布尔，不是 realpath —— 遍历要用**词法路径**，
   * 因为清单里的 relPath 必须相对 rootAbs 用词法路径算
   * （realpath 会把 Windows 的 8.3 短路径展开成长路径，relative 会算出 `..\..\`）。
   * 目录内每个文件的 realpath 判定由 `resolveSafeSource` 逐个做，不在这里省。
   */
  private async isSafeDir(
    abs: string,
    realRoot: string,
    skipped: Map<string, number>,
  ): Promise<boolean> {
    let lst: Stats;
    try {
      lst = await lstat(abs);
    } catch {
      return false; // 不存在：交给 resolveSafeSource 记 'missing'
    }
    if (!lst.isDirectory() && !lst.isSymbolicLink()) return false;

    let real: string;
    try {
      real = await realpath(abs);
    } catch {
      return false;
    }
    if (!isInside(realRoot, real)) {
      bump(skipped, 'symlink-escape');
      throw new CheckpointPathError(`路径指向工作区外，已拒绝: ${abs}`);
    }
    const target = await stat(abs).catch(() => null);
    return target?.isDirectory() === true;
  }

  /** 递归遍历工作区（显式栈，避免深目录爆栈）。 */
  private async walk(
    startDir: string,
    rootAbs: string,
    realRoot: string,
    skipped: Map<string, number>,
  ): Promise<CaptureCandidate[]> {
    const out: CaptureCandidate[] = [];
    const stack: string[] = [startDir];
    while (stack.length > 0) {
      const dir = stack.pop() as string;
      let entries: Dirent[];
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        bump(skipped, 'unreadable');
        continue;
      }
      // 稳定排序：快照内容必须可复现，不能依赖文件系统的返回顺序。
      const sorted = [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      for (const entry of sorted) {
        const abs = path.join(dir, entry.name);
        if (entry.isSymbolicLink()) {
          const safe = await this.resolveSafeSource(abs, realRoot, skipped, false);
          if (safe) out.push({ relPath: toPosix(path.relative(rootAbs, abs)), src: safe });
          continue;
        }
        if (entry.isDirectory()) {
          if (SKIP_DIR_NAMES.has(entry.name) || entry.name.startsWith('.')) {
            bump(skipped, entry.name.startsWith('.') ? 'hidden-dir' : 'skipped-dir');
            continue;
          }
          // 快照正文目录绝不进快照（否则快照会把自己的上一份快照再拍一遍）。
          if (path.resolve(abs) === this.blobRoot) {
            bump(skipped, 'blob-dir');
            continue;
          }
          stack.push(abs);
          continue;
        }
        if (!entry.isFile()) {
          bump(skipped, 'unsupported');
          continue;
        }
        // 普通文件同样要过 realpath 判定：祖先目录可能是软链。
        const safe = await this.resolveSafeSource(abs, realRoot, skipped, false);
        if (safe) out.push({ relPath: toPosix(path.relative(rootAbs, abs)), src: safe });
      }
    }
    return out;
  }

  /**
   * 把候选路径解析成**可安全复制**的源路径。
   *
   * 返回 realpath（已确认在工作区内）；不可用时返回 null。
   *
   * 为什么每个文件都要 realpath（不只是软链）：
   * `root/sub -> /etc` 时，`root/sub/passwd` 的 lstat 看着是**普通文件**
   * （lstat 只解析最后一段），只有 realpath 才看得出整条链其实指向区外。
   * 只对「末段是软链」做检查会漏掉这一类越界读。
   */
  private async resolveSafeSource(
    abs: string,
    realRoot: string,
    skipped: Map<string, number>,
    explicit: boolean,
  ): Promise<string | null> {
    let lst: Stats;
    try {
      lst = await lstat(abs);
    } catch {
      bump(skipped, 'missing');
      return null;
    }

    if (lst.isDirectory()) {
      // 目录（含目录软链）：不作为文件捕获。
      // 目录软链不递归（防环），区外的目录软链算越界。
      let real: string;
      try {
        real = await realpath(abs);
      } catch {
        bump(skipped, 'broken-symlink');
        return null;
      }
      if (!isInside(realRoot, real)) {
        bump(skipped, 'symlink-escape');
        if (explicit) {
          throw new CheckpointPathError(`符号链接指向工作区外，已拒绝: ${abs}`);
        }
        return null;
      }
      bump(skipped, lst.isSymbolicLink() ? 'symlink-dir' : 'skipped-dir');
      return null;
    }

    let real: string;
    try {
      real = await realpath(abs);
    } catch {
      bump(skipped, 'broken-symlink');
      if (explicit) {
        throw new CheckpointPathError(`符号链接无法解析: ${abs}`);
      }
      return null;
    }

    // 核心判定：解析后的整条链必须仍落在工作区内。
    if (!isInside(realRoot, real)) {
      bump(skipped, 'symlink-escape');
      if (explicit) {
        throw new CheckpointPathError(`路径指向工作区外，已拒绝: ${abs}`);
      }
      return null;
    }

    if (!lst.isFile() && !lst.isSymbolicLink()) {
      bump(skipped, 'unsupported');
      return null;
    }
    if (lst.isSymbolicLink()) {
      // 指向区内的软链：按其目标文件处理（复制内容，不复制链接本身）。
      const target = await stat(abs).catch(() => null);
      if (!target || !target.isFile()) {
        bump(skipped, 'unsupported');
        return null;
      }
    }

    // 返回 realpath：复制源用已确认安全的路径，
    // 即使判定之后软链被换成别的目标，复制到的仍是判定时那个区内文件。
    return real;
  }
}

/**
 * 解析调用方点名的相对路径。
 * 绝对路径 / `..` 穿越 / 空路径 → 抛 CheckpointPathError。
 */
function resolveExplicitPath(rootAbs: string, raw: string): string {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new CheckpointPathError('文件路径不能为空');
  }
  const rel = raw.trim();
  if (path.isAbsolute(rel) || /^[a-zA-Z]:[\\/]/.test(rel) || rel.startsWith('\\\\')) {
    throw new CheckpointPathError(`只接受相对路径: ${rel}`);
  }
  const parts = rel.split(/[\\/]+/).filter((p) => p !== '' && p !== '.');
  if (parts.some((p) => p === '..')) {
    throw new CheckpointPathError(`路径不允许包含 ".." 段: ${rel}`);
  }
  if (parts.length === 0) {
    throw new CheckpointPathError(`路径不能为空: ${rel}`);
  }
  const abs = path.resolve(rootAbs, ...parts);
  if (!isInside(path.resolve(rootAbs), abs)) {
    throw new CheckpointPathError(`路径越出工作区: ${rel}`);
  }
  return abs;
}

/**
 * 解析回滚的写入目标。
 *  - relPath 含 `..` → 拒绝；
 *  - 最近的**已存在**祖先目录 realpath 必须落在工作区内（防软链目录越界）；
 *  - 目标本身若是软链，先删掉再写（否则写穿软链会写到工作区外）。
 *
 * 返回的是**解析后**的父目录 + 文件名：写入落在已确认安全的父目录下，
 * 避免「判定之后父目录被换成软链」的 TOCTOU 窗口。
 */
async function resolveWriteTarget(rootAbs: string, realRoot: string, relPath: string): Promise<string> {
  if (typeof relPath !== 'string' || relPath.trim() === '') {
    throw new CheckpointPathError('清单条目路径为空');
  }
  const parts = relPath.split(/[\\/]+/).filter((p) => p !== '' && p !== '.');
  if (parts.some((p) => p === '..')) {
    throw new CheckpointPathError(`路径不允许包含 ".." 段: ${relPath}`);
  }
  if (parts.length === 0) {
    throw new CheckpointPathError(`路径不能为空: ${relPath}`);
  }
  const target = path.resolve(rootAbs, ...parts);
  if (!isInside(path.resolve(rootAbs), target)) {
    throw new CheckpointPathError(`路径越出工作区: ${relPath}`);
  }

  // 目标本身是软链 → 先删，否则写穿软链会写到工作区外。
  // 必须在任何提前 return 之前做，否则「写穿软链」这条防护会被绕过。
  const lst = await lstat(target).catch(() => null);
  if (lst?.isSymbolicLink()) {
    await unlink(target);
  }

  // 祖先目录 realpath 校验：防止 `工作区/link -> /etc` 这种「目录软链越界」。
  let ancestor = path.dirname(target);
  while (!(await pathExists(ancestor))) {
    const parent = path.dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }
  if (await pathExists(ancestor)) {
    const realAncestor = await safeRealpath(ancestor);
    // 祖先可能就是工作区根本身（目标直接位于根下），这种情况必须放行。
    if (realAncestor !== realRoot && !isInside(realRoot, realAncestor)) {
      throw new CheckpointPathError(`写入目标越出工作区: ${relPath}`);
    }
    // 写入落在**解析后**的父目录下：判定后父目录被换成软链也写不到区外。
    const suffix = path.relative(ancestor, target);
    return path.join(realAncestor, suffix);
  }

  return target;
}

/** 解析落库的 diff_json；损坏/缺失一律当空（不影响撤销主流程）。 */
function parseDiffs(raw: string | null): RunFileDiff[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as RunFileDiff[]) : [];
  } catch {
    return [];
  }
}

/** 解析 DB 里的清单；损坏即抛错（静默当成空清单会让回滚「假装成功」）。 */
function parseManifest(raw: string): CheckpointManifestEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new CheckpointManifestError('快照清单不是合法 JSON');
  }
  if (!Array.isArray(parsed)) {
    throw new CheckpointManifestError('快照清单格式错误：应为数组');
  }
  const out: CheckpointManifestEntry[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== 'object') continue;
    const e = item as Partial<CheckpointManifestEntry>;
    if (typeof e.relPath !== 'string' || typeof e.sha256 !== 'string') continue;
    if (typeof e.blobPath !== 'string' || typeof e.size !== 'number') continue;
    out.push({ relPath: e.relPath, sha256: e.sha256, size: e.size, blobPath: e.blobPath });
  }
  return out;
}

/**
 * 组合 label：`<用户 label> [skipped N: reason:count, ...]`。
 *
 * 超限/跳过**必须可见**——否则「快照只存了 3 个文件」会被误读成「工作区只有 3 个文件」。
 */
function buildLabel(userLabel: string | undefined, skipped: Map<string, number>): string {
  const base = (typeof userLabel === 'string' ? userLabel.trim() : '') || DEFAULT_LABEL;
  const clipped = base.length > MAX_LABEL_LEN ? `${base.slice(0, MAX_LABEL_LEN)}…` : base;
  if (skipped.size === 0) return clipped;
  const parts: string[] = [];
  for (const [reason, count] of [...skipped.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    parts.push(`${reason}:${count}`);
  }
  const note = `[skipped ${[...skipped.values()].reduce((a, b) => a + b, 0)}: ${parts.join(', ')}]`;
  return `${clipped} ${note.length > MAX_NOTE_LEN ? `${note.slice(0, MAX_NOTE_LEN)}…` : note}`;
}

/** 跳过统计（结构化，供调用方直接判断，不只是人读的 label 文本）。 */
function skippedReport(skipped: Map<string, number>): { count: number; reasons: Record<string, number> } {
  const reasons: Record<string, number> = {};
  for (const [reason, count] of [...skipped.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    reasons[reason] = count;
  }
  return {
    count: [...skipped.values()].reduce((a, b) => a + b, 0),
    reasons,
  };
}

/** 统计跳过原因。 */
function bump(map: Map<string, number>, reason: string): void {
  map.set(reason, (map.get(reason) ?? 0) + 1);
}

/** 路径是否位于 root 之内（严格：root 自身不算「在内」）。 */
function isInside(root: string, target: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(target));
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return false;
  return true;
}

/** realpath 失败时退回原路径（目标可能尚不存在）。 */
async function safeRealpath(p: string): Promise<string> {
  try {
    return await realpath(p);
  } catch {
    return path.resolve(p);
  }
}

/** 路径是否存在（异步版 exists）。 */
async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/** 统一成 POSIX 风格相对路径（manifest 里跨平台可读）。 */
function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}

/**
 * 计算文件 sha256。
 * 分块读（64KB）流式喂 hash —— 不把整个文件读进内存（大文件快照不该撑爆内存）。
 */
async function sha256File(absPath: string): Promise<string> {
  const hash = createHash('sha256');
  const handle = await open(absPath, 'r');
  try {
    const buf = Buffer.allocUnsafe(HASH_CHUNK);
    for (;;) {
      const { bytesRead } = await handle.read(buf, 0, buf.length, null);
      if (bytesRead <= 0) break;
      hash.update(buf.subarray(0, bytesRead));
    }
  } finally {
    await handle.close();
  }
  return hash.digest('hex');
}

/**
 * 默认快照正文目录：<db 同级>/checkpoints。
 * 内存库（:memory:）没有同级目录 → 落到系统临时目录（此时 DB 本身也是临时的）。
 */
function defaultBlobRoot(db: Db): string {
  let location: string | null = null;
  try {
    location = db.raw.location();
  } catch {
    location = null;
  }
  if (location && location !== ':memory:') {
    return path.join(path.dirname(path.resolve(location)), 'checkpoints');
  }
  return path.join(os.tmpdir(), 'codelens-checkpoints');
}
