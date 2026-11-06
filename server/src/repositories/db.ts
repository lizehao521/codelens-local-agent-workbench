/**
 * node:sqlite wrapper: connection lifecycle, pragmas, prepared-statement helpers,
 * and nested transactions via SAVEPOINT (DatabaseSync has no BEGIN nesting).
 */

import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';

export interface Db {
  readonly raw: DatabaseSync;
  exec(sql: string): void;
  run(sql: string, params?: SqlParams): { changes: number; lastInsertRowid: number | bigint };
  get<T>(sql: string, params?: SqlParams): T | undefined;
  all<T>(sql: string, params?: SqlParams): T[];
  /** Runs `fn` inside a transaction; nested calls reuse the outer savepoint. */
  transaction<T>(fn: () => T): T;
  close(): void;
}

export type SqlParams = Array<string | number | null> | Record<string, string | number | null>;

const PRAGMAS = [
  'PRAGMA journal_mode = WAL',
  'PRAGMA foreign_keys = ON',
  'PRAGMA busy_timeout = 5000',
  'PRAGMA synchronous = NORMAL',
];

function openDatabase(filePath: string): DatabaseSync {
  if (filePath !== ':memory:') {
    const dir = path.dirname(filePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }
  const db = new DatabaseSync(filePath);
  for (const pragma of PRAGMAS) db.exec(pragma);
  return db;
}

export function createDb(filePath: string): Db {
  const raw = openDatabase(filePath);
  let depth = 0;

  function normalize(params?: SqlParams): Array<string | number | null> | undefined {
    if (!params) return undefined;
    if (Array.isArray(params)) return params;
    return Object.values(params);
  }

  return {
    raw,
    exec(sql: string): void {
      raw.exec(sql);
    },
    run(sql: string, params?: SqlParams) {
      const stmt = raw.prepare(sql);
      const result = normalize(params)
        ? stmt.run(...normalize(params)!)
        : stmt.run();
      return { changes: Number(result.changes), lastInsertRowid: result.lastInsertRowid };
    },
    get<T>(sql: string, params?: SqlParams): T | undefined {
      const stmt = raw.prepare(sql);
      const row = normalize(params) ? stmt.get(...normalize(params)!) : stmt.get();
      return row as T | undefined;
    },
    all<T>(sql: string, params?: SqlParams): T[] {
      const stmt = raw.prepare(sql);
      const rows = normalize(params) ? stmt.all(...normalize(params)!) : stmt.all();
      return rows as T[];
    },
    transaction<T>(fn: () => T): T {
      const savepoint = `sp_${depth}`;
      if (depth === 0) raw.exec('BEGIN');
      else raw.exec(`SAVEPOINT ${savepoint}`);
      depth += 1;
      try {
        const result = fn();
        if (depth === 1) raw.exec('COMMIT');
        else raw.exec(`RELEASE ${savepoint}`);
        return result;
      } catch (err) {
        if (depth === 1) raw.exec('ROLLBACK');
        else raw.exec(`ROLLBACK TO ${savepoint}`);
        throw err;
      } finally {
        depth -= 1;
      }
    },
    close(): void {
      raw.close();
    },
  };
}
