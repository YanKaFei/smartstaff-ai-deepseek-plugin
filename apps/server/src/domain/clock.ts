import type { Db } from '../db/index.js';
import { get, run, transaction } from '../lib/db.js';

export interface StoreClock {
  storeId: string;
  offsetMs: number;
  running: boolean;
  speed: number;
  lastSimAt: number;
}

export function getClock(db: Db, storeId: string): StoreClock {
  const row = get<{ offset_ms: number; running: number; speed: number; last_sim_at: number }>(
    db,
    'SELECT offset_ms, running, speed, last_sim_at FROM store_clocks WHERE store_id = ?',
    [storeId],
  );
  return {
    storeId,
    offsetMs: row?.offset_ms ?? 0,
    running: Boolean(row?.running ?? 0),
    speed: row?.speed ?? 60,
    lastSimAt: row?.last_sim_at ?? 0,
  };
}

/** The authoritative business clock for a store. */
export function storeNow(db: Db, storeId: string): number {
  return Date.now() + getClock(db, storeId).offsetMs;
}

export function getBusinessDate(db: Db, storeId: string, now: number, hoursEnd: string): string {
  return businessDateKey(now, hoursEnd);
}

import { businessDateKey } from '../lib/time.js';

export function ensureClock(db: Db, storeId: string, at?: number): StoreClock {
  const existing = get<{ store_id: string }>(db, 'SELECT store_id FROM store_clocks WHERE store_id = ?', [storeId]);
  if (!existing) {
    const offset = at === undefined ? 0 : at - Date.now();
    run(db, 'INSERT INTO store_clocks(store_id, offset_ms, running, speed, last_sim_at, updated_at) VALUES(?,?,?,?,?,?)', [
      storeId,
      offset,
      0,
      60,
      at ?? 0,
      Date.now(),
    ]);
  }
  return getClock(db, storeId);
}

export function setClock(
  db: Db,
  storeId: string,
  patch: { at?: number; running?: boolean; speed?: number },
): StoreClock {
  return transaction(db, () => {
    ensureClock(db, storeId);
    const current = getClock(db, storeId);
    const offset = patch.at !== undefined ? patch.at - Date.now() : current.offsetMs;
    const running = patch.running !== undefined ? patch.running : current.running;
    const speed = patch.speed !== undefined ? patch.speed : current.speed;
    run(
      db,
      'UPDATE store_clocks SET offset_ms = ?, running = ?, speed = ?, updated_at = ? WHERE store_id = ?',
      [offset, running ? 1 : 0, speed, Date.now(), storeId],
    );
    return getClock(db, storeId);
  });
}

export function setLastSimAt(db: Db, storeId: string, at: number): void {
  run(db, 'UPDATE store_clocks SET last_sim_at = ? WHERE store_id = ?', [at, storeId]);
}

/** Advance simulated time by a fixed amount; returns the new store clock. */
export function advanceClock(db: Db, storeId: string, deltaMs: number): StoreClock {
  const clock = getClock(db, storeId);
  return setClock(db, storeId, { at: Date.now() + clock.offsetMs + deltaMs });
}
