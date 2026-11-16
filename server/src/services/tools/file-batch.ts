/** 批次写前快照：只覆盖 fs.write 的文件目标，失败时逆序恢复。 */
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

interface WriteLike {
  definition: { name: string };
  verdict: { effect?: { items?: Array<{ path: string; kind: string }> } };
}

export interface FileSnapshot {
  absolutePath: string;
  content: Buffer | null;
}

export async function collectWriteSnapshots(items: WriteLike[], sandboxRoot: string): Promise<FileSnapshot[]> {
  const paths = new Set<string>();
  for (const item of items) {
    if (item.definition.name !== 'fs.write') continue;
    for (const effect of item.verdict.effect?.items ?? []) {
      if (effect.kind !== 'file') continue;
      paths.add(path.isAbsolute(effect.path) ? effect.path : path.resolve(sandboxRoot, effect.path));
    }
  }
  const snapshots: FileSnapshot[] = [];
  for (const absolutePath of paths) {
    try {
      const info = await stat(absolutePath);
      if (!info.isFile()) continue;
      snapshots.push({ absolutePath, content: await readFile(absolutePath) });
    } catch {
      snapshots.push({ absolutePath, content: null });
    }
  }
  return snapshots;
}

/** 恢复快照；返回实际恢复/删除的路径数。 */
export async function restoreWriteSnapshots(snapshots: FileSnapshot[]): Promise<number> {
  let restored = 0;
  for (const snapshot of [...snapshots].reverse()) {
    try {
      if (snapshot.content === null) {
        await rm(snapshot.absolutePath, { force: true });
      } else {
        await mkdir(path.dirname(snapshot.absolutePath), { recursive: true });
        await writeFile(snapshot.absolutePath, snapshot.content);
      }
      restored += 1;
    } catch {
      // 单文件恢复失败不阻断其它文件；调用方会看到 summary 中的回滚提示。
    }
  }
  return restored;
}
