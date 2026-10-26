import type { Db } from '../db/index.js';

type Param = string | number | bigint | null | Uint8Array;

export function all<T = Record<string, unknown>>(db: Db, sql: string, params: Param[] = []): T[] {
  return db.prepare(sql).all(...params) as T[];
}

export function get<T = Record<string, unknown>>(db: Db, sql: string, params: Param[] = []): T | undefined {
  return db.prepare(sql).get(...params) as T | undefined;
}

export function run(db: Db, sql: string, params: Param[] = []) {
  return db.prepare(sql).run(...params);
}

/**
 * IMMEDIATE transaction gives write-lock isolation. Node's built-in SQLite is
 * synchronous and single-process, so combined with status CAS updates this is
 * sufficient for the single-node 1.0 deployment.
 */
export function transaction<T>(db: Db, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* ignore rollback failure */
    }
    throw err;
  }
}

export function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}
