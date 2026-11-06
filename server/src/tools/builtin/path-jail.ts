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