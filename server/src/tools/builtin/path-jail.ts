/**
 * Path jail (AC-07): every filesystem tool path funnels through here.
 * Order is fixed: reject absolute → reject `..` segments → resolve against the
 * sandbox root → realpath (existing) / realpath of the nearest existing ancestor
 * (writes) → the realpath result must stay inside the realpath of the root.
 * Symlink escapes die at the realpath step; Windows device names are rejected.
 *
 * AUDIT-036: the sync `realpathSync` blocked the event loop on every filesystem
 * call. The async variant (`resolveInSandboxAsync`) takes an injectable fs facade
 * so production uses node:fs/promises and tests can stub it to assert the async
 * path is actually taken.
 */

import { existsSync, realpathSync } from 'node:fs';
import { access, realpath } from 'node:fs/promises';
import path from 'node:path';

export type JailVerdict =
  | { ok: true; absolutePath: string; sandboxRelative: string }
  | { ok: false; code: 'PATH_ABSOLUTE' | 'PATH_TRAVERSAL' | 'PATH_OUTSIDE_SANDBOX' | 'PATH_RESERVED'; message: string };

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i;

/** 可注入的异步 fs 依赖（AUDIT-036）：便于用 stub 断言确实走了异步 realpath/exists。 */
export interface JailFs {
  realpath: (p: string) => Promise<string>;
  exists: (p: string) => Promise<boolean>;
}

const realFs: JailFs = {
  realpath: (p) => realpath(p),
  exists: async (p) => {
    try {
      await access(p);
      return true;
    } catch {
      return false;
    }
  },
};

type InputVerdict = { candidate: string } | JailVerdict;

/** 词法层校验（绝对路径/.. 段/保留名/尾空格点）——不触碰 fs，同步/异步共用。 */
function validateInput(rawRel: string): InputVerdict {
  if (typeof rawRel !== 'string' || rawRel.trim() === '') {
    return { ok: false, code: 'PATH_TRAVERSAL', message: '路径不能为空' };
  }

  // 绝对路径不再在词法层硬拒：是否拒绝取决于调用方是否传入 allowedDirs（见 resolveInSandbox/Async）。
  // 保留「..」段拒绝（防御性；allowedDirs 解析后仍由 computeVerdict 兜底越界）。

  // Traversal segments, split on both separators so `..\` and `../` both die.
  const segments = rawRel.split(/[/\\]/);
  if (segments.some((segment) => segment === '..')) {
    return { ok: false, code: 'PATH_TRAVERSAL', message: '路径不允许包含 ".." 段' };
  }

  // Windows reserved device names and trailing space/dot (Win32 name mangling).
  for (const segment of segments) {
    if (WINDOWS_RESERVED.test(segment)) {
      return { ok: false, code: 'PATH_RESERVED', message: `路径包含 Windows 保留设备名 "${segment}"` };
    }
    if (/[. ]$/.test(segment) && segment !== '.' && segment !== '..') {
      return { ok: false, code: 'PATH_RESERVED', message: '路径段不能以空格或点结尾' };
    }
  }

  return { candidate: rawRel.trim() };
}

/** 最终相对性校验：realTarget 必须仍在 root 内。 */
function computeVerdict(root: string, realTarget: string, forWrite: boolean): JailVerdict {
  const relative = path.relative(root, realTarget);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    return { ok: false, code: 'PATH_OUTSIDE_SANDBOX', message: '路径越出沙箱根目录' };
  }
  if (relative === '') {
    // The sandbox root itself: allowed for list, never for write targets.
    if (forWrite) {
      return { ok: false, code: 'PATH_OUTSIDE_SANDBOX', message: '不能把沙箱根本身作为写入目标' };
    }
    return { ok: true, absolutePath: root, sandboxRelative: '.' };
  }
  return { ok: true, absolutePath: realTarget, sandboxRelative: relative };
}

/** Realpath of the sandbox root, resolved once per call (root may be a symlink itself). */
function realSandboxRoot(sandboxRoot: string): string {
  const root = path.resolve(sandboxRoot);
  return existsSync(root) ? realpathSync(root) : root;
}

async function realSandboxRootAsync(sandboxRoot: string, fs: JailFs): Promise<string> {
  const root = path.resolve(sandboxRoot);
  return (await fs.exists(root)) ? fs.realpath(root) : root;
}

/** 同步解析（保留给同执行前的安全闸 security-gateway 与既有单测）。 */
export function resolveInSandbox(
  sandboxRoot: string,
  rel: string,
  forWrite = false,
  allowedDirs?: string[],
): JailVerdict {
  const input = validateInput(rel);
  if ('ok' in input) return input;
  const candidate = input.candidate;

  // 绝对路径：无 allowDirs 时仍按原行为硬拒（向后兼容，错误码不变）；有 allowDirs 时流入下方重试。
  const isAbsolute = /^[a-zA-Z]:[\\/]/.test(candidate) || candidate.startsWith('\\\\') || candidate.startsWith('/');
  if (isAbsolute && (!allowedDirs || allowedDirs.length === 0)) {
    return { ok: false, code: 'PATH_ABSOLUTE', message: '只允许沙箱内的相对路径（或已在白名单中的绝对路径），拒绝绝对路径' };
  }

  const root = realSandboxRoot(sandboxRoot);
  const resolved = path.resolve(root, candidate);

  let realTarget: string;
  if (existsSync(resolved)) {
    realTarget = realpathSync(resolved);
  } else if (forWrite) {
    // New leaf: validate the nearest existing ancestor, then re-attach the
    // remaining (possibly multi-segment) path below it.
    let ancestor = path.dirname(resolved);
    let rest = path.basename(resolved);
    for (;;) {
      if (existsSync(ancestor)) {
        realTarget = path.join(realpathSync(ancestor), rest);
        break;
      }
      const parent = path.dirname(ancestor);
      if (parent === ancestor) {
        realTarget = resolved;
        break;
      }
      rest = path.join(path.basename(ancestor), rest);
      ancestor = parent;
    }
  } else {
    // Missing leaf on a read path: no realpath needed, lexical check still applies.
    realTarget = resolved;
  }

  const verdict = computeVerdict(root, realTarget, forWrite);
  if (verdict.ok) return verdict;
  // 沙箱根内失败：尝试已白名单的 allowDirs（每个都是已校验 + realpath 的绝对目录）。
  if (allowedDirs && allowedDirs.length > 0) {
    const alt = tryAllowedDirsSync(candidate, forWrite, allowedDirs);
    if (alt) return alt;
  }
  return verdict;
}

/** 异步解析（AUDIT-036）：非阻塞；fs 可注入供测试 stub 断言。 */
export async function resolveInSandboxAsync(
  sandboxRoot: string,
  rel: string,
  forWrite = false,
  fs: JailFs = realFs,
  allowedDirs?: string[],
): Promise<JailVerdict> {
  const input = validateInput(rel);
  if ('ok' in input) return input;
  const candidate = input.candidate;

  const isAbsolute = /^[a-zA-Z]:[\\/]/.test(candidate) || candidate.startsWith('\\\\') || candidate.startsWith('/');
  if (isAbsolute && (!allowedDirs || allowedDirs.length === 0)) {
    return { ok: false, code: 'PATH_ABSOLUTE', message: '只允许沙箱内的相对路径（或已在白名单中的绝对路径），拒绝绝对路径' };
  }

  const root = await realSandboxRootAsync(sandboxRoot, fs);
  const resolved = path.resolve(root, candidate);

  let realTarget: string;
  if (await fs.exists(resolved)) {
    realTarget = await fs.realpath(resolved);
  } else if (forWrite) {
    let ancestor = path.dirname(resolved);
    let rest = path.basename(resolved);
    for (;;) {
      if (await fs.exists(ancestor)) {
        realTarget = path.join(await fs.realpath(ancestor), rest);
        break;
      }
      const parent = path.dirname(ancestor);
      if (parent === ancestor) {
        realTarget = resolved;
        break;
      }
      rest = path.join(path.basename(ancestor), rest);
      ancestor = parent;
    }
  } else {
    realTarget = resolved;
  }

  const verdict = computeVerdict(root, realTarget, forWrite);
  if (verdict.ok) return verdict;
  if (allowedDirs && allowedDirs.length > 0) {
    const alt = await tryAllowedDirsAsync(candidate, forWrite, allowedDirs, fs);
    if (alt) return alt;
  }
  return verdict;
}

/**
 * 解析「在哪个项目根里干活」——给 test.run 这类需要 cwd 的工具用。
 *
 * ── 为什么不能直接用 resolveInSandbox ─────────────────────
 * 沙箱根（`server/workspace`）是 Agent 的读写地盘，但**不是项目根**：
 * 仓库在它外面。于是 `test.run` 只能用沙箱里的 `node_modules`、以沙箱为 cwd，
 * 结果就是「永远在空目录里跑测试，永远绿/永远读不到报告」——被测对象根本不对。
 *
 * ── 判据（三条任一即可，其余一律拒）──────────────────────
 *   1. 落在沙箱内（原有行为，不破坏）；
 *   2. 落在某个 allowDir 内（授权目录本身可以是根）；
 *   3. 是某个 allowDir 的**上级**（例如 allowDirs 有 `server/src`，则 `server` 可作根）。
 *
 * 第 3 条是这次的关键：项目根必然包着 `src/`，但它自己不一定是授权目录。
 * 放宽到「上级」不会放大可写范围——**写盘仍走 resolveInSandbox + allowDirs**，
 * 这里只决定子进程的 cwd 与 vitest/tsc 二进制的来源。
 *
 * Windows 上大小写不敏感，前缀比较统一转小写，避免 `C:\Repo` 与 `c:\repo` 判不中。
 */
export type ProjectRootVerdict =
  | { ok: true; absolutePath: string }
  | { ok: false; code: 'PATH_ABSOLUTE' | 'PATH_TRAVERSAL' | 'PATH_OUTSIDE_SANDBOX' | 'PATH_RESERVED'; message: string };

function within(child: string, parent: string): boolean {
  const c = child.toLowerCase();
  const p = parent.toLowerCase();
  return c === p || c.startsWith(p.endsWith(path.sep) ? p : p + path.sep);
}

export async function resolveProjectRoot(
  sandboxRoot: string,
  raw: string,
  allowedDirs?: string[],
  fs: JailFs = realFs,
): Promise<ProjectRootVerdict> {
  const input = validateInput(raw);
  // validateInput 只会返回两种：`{candidate}`（通过）或 `{ok:false,code,message}`（拒绝）。
  // 这里按 candidate 判别，再用 ok===false 取错误字段——直接 `'ok' in input` 不够精确，
  // 因为 InputVerdict 里还并了 ok:true 的 JailVerdict 形态。
  if (!('candidate' in input)) {
    if (input.ok === false) {
      return { ok: false, code: input.code, message: input.message };
    }
    return { ok: false, code: 'PATH_OUTSIDE_SANDBOX', message: '路径校验失败' };
  }

  const root = await realSandboxRootAsync(sandboxRoot, fs);
  const resolved = path.resolve(root, input.candidate);

  let realTarget: string;
  try {
    realTarget = await fs.realpath(resolved);
  } catch {
    return {
      ok: false,
      code: 'PATH_OUTSIDE_SANDBOX',
      message: `项目根不存在或无法解析：${resolved}`,
    };
  }

  if (within(realTarget, root)) return { ok: true, absolutePath: realTarget };

  const dirs = allowedDirs ?? [];
  for (const dir of dirs) {
    let realDir: string;
    try {
      realDir = await fs.realpath(path.resolve(dir));
    } catch {
      continue;
    }
    // 授权目录本身，或它的上级 —— 前者是「就在这里跑」，后者是「把整包当项目」。
    if (within(realTarget, realDir) || within(realDir, realTarget)) {
      return { ok: true, absolutePath: realTarget };
    }
  }

  return {
    ok: false,
    code: 'PATH_OUTSIDE_SANDBOX',
    message: `项目根必须是沙箱内、某个授权目录内、或授权目录的上级：${realTarget}`,
  };
}

/** 同步：在 allowDirs 内逐个尝试解析 + 真实路径判定（防 symlink 逃逸）。返回首个落在某 allowDir 内的 verdict。 */
function tryAllowedDirsSync(candidate: string, forWrite: boolean, allowedDirs: string[]): JailVerdict | null {
  for (const dir of allowedDirs) {
    const dirResolved = path.resolve(dir, candidate); // 绝对 candidate 时 = candidate（path.resolve 忽略 base）
    let realTarget: string;
    if (existsSync(dirResolved)) {
      realTarget = realpathSync(dirResolved);
    } else if (forWrite) {
      let ancestor = path.dirname(dirResolved);
      let rest = path.basename(dirResolved);
      for (;;) {
        if (existsSync(ancestor)) {
          realTarget = path.join(realpathSync(ancestor), rest);
          break;
        }
        const parent = path.dirname(ancestor);
        if (parent === ancestor) {
          realTarget = dirResolved;
          break;
        }
        rest = path.join(path.basename(ancestor), rest);
        ancestor = parent;
      }
    } else {
      realTarget = dirResolved;
    }
    const v = computeVerdict(dir, realTarget, forWrite);
    if (v.ok) return v;
  }
  return null;
}

/** 异步版 tryAllowedDirs（fs 可注入，便于 AUDIT-036 stub 断言）。 */
async function tryAllowedDirsAsync(
  candidate: string,
  forWrite: boolean,
  allowedDirs: string[],
  fs: JailFs,
): Promise<JailVerdict | null> {
  for (const dir of allowedDirs) {
    const dirResolved = path.resolve(dir, candidate);
    let realTarget: string;
    if (await fs.exists(dirResolved)) {
      realTarget = await fs.realpath(dirResolved);
    } else if (forWrite) {
      let ancestor = path.dirname(dirResolved);
      let rest = path.basename(dirResolved);
      for (;;) {
        if (await fs.exists(ancestor)) {
          realTarget = path.join(await fs.realpath(ancestor), rest);
          break;
        }
        const parent = path.dirname(ancestor);
        if (parent === ancestor) {
          realTarget = dirResolved;
          break;
        }
        rest = path.join(path.basename(ancestor), rest);
        ancestor = parent;
      }
    } else {
      realTarget = dirResolved;
    }
    const v = computeVerdict(dir, realTarget, forWrite);
    if (v.ok) return v;
  }
  return null;
}