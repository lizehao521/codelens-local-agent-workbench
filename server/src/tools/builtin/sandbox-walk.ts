/** Shared sandbox walker for code.search and fs.glob. */

import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';

/** Directories that must be skipped during traversal. */
export const SKIP_DIRS = ['node_modules', 'dist', 'coverage', '.git'] as const;

/** Maximum traversal depth. */
export const MAX_DEPTH = 8;

/** Maximum file size for code.search (1 MiB). */
export const MAX_FILE_SIZE = 1024 * 1024;

/**
 * Check if a directory name should be skipped.
 */
export function shouldSkipDir(name: string): boolean {
  return SKIP_DIRS.includes(name as (typeof SKIP_DIRS)[number]);
}

/**
 * Check if a file should be skipped (binary or too large).
 * Returns true if the file should be skipped.
 */
export async function shouldSkipFile(filePath: string): Promise<boolean> {
  try {
    const stats = await stat(filePath);
    if (stats.size > MAX_FILE_SIZE) {
      return true;
    }
    // Check for binary content (null byte)
    const { readFile } = await import('node:fs/promises');
    const buffer = await readFile(filePath, { encoding: null });
    return buffer.includes(0x00);
  } catch {
    return true; // Skip on any error
  }
}

/**
 * Walk a directory tree, yielding file paths relative to the sandbox root.
 * Does not follow symlinks.
 * 
 * @param rootDir - The directory to start walking from
 * @param sandboxRoot - The sandbox root for computing relative paths
 * @param options - Options for the walk
 * @param options.maxDepth - Maximum depth (default: MAX_DEPTH)
 * @param options.glob - Optional RegExp to filter files by basename (for code.search)
 * @param options.skipDirs - Directories to skip (default: SKIP_DIRS)
 */
export async function* walkFiles(
  rootDir: string,
  sandboxRoot: string,
  options: {
    maxDepth?: number;
    glob?: RegExp;
    skipDirs?: readonly string[];
  } = {}
): AsyncGenerator<string> {
  const { maxDepth = MAX_DEPTH, glob, skipDirs = SKIP_DIRS } = options;
  
  async function* walk(currentDir: string, depth: number): AsyncGenerator<string> {
    if (depth > maxDepth) return;
    
    let entries;
    try {
      entries = await readdir(currentDir, { withFileTypes: true });
    } catch {
      return; // Skip unreadable directories
    }
    
    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      
      // Skip symlinks entirely (don't follow them)
      if (entry.isSymbolicLink()) {
        continue;
      }
      
      if (entry.isDirectory()) {
        if (skipDirs.includes(entry.name)) {
          continue;
        }
        yield* walk(fullPath, depth + 1);
      } else if (entry.isFile()) {
        // Check glob pattern against basename (for code.search)
        if (glob && !glob.test(entry.name)) {
          continue;
        }
        // Return path relative to sandbox root
        const relativePath = path.relative(sandboxRoot, fullPath).replace(/\\/g, '/');
        yield relativePath;
      }
    }
  }
  
  yield* walk(rootDir, 0);
}