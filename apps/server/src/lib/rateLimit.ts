import type { Db } from '../db/index.js';
import { get, run, transaction } from './db.js';

/**
 * Shared sliding-window limiter backed by the database. Multiple API processes
 * that point at the same database see the same buckets. A memory backend is
 * retained for explicit single-node/dev use only.
 */
export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterSec: number;
}

interface Entry {
  hits: number[];
  blockedUntil: number;
}

const memoryBuckets = new Map<string, Entry>();

export function rateLimitMemory(key: string, limit: number, windowMs: number): RateLimitResult {
  const now = Date.now();
  const entry = memoryBuckets.get(key) ?? { hits: [], blockedUntil: 0 };
  entry.hits = entry.hits.filter((t) => now - t < windowMs);
  if (entry.blockedUntil > now) {
    memoryBuckets.set(key, entry);
    return { allowed: false, remaining: 0, retryAfterSec: Math.ceil((entry.blockedUntil - now) / 1000) };
  }
  if (entry.hits.length >= limit) {
    entry.blockedUntil = now + windowMs;
    memoryBuckets.set(key, entry);
    return { allowed: false, remaining: 0, retryAfterSec: Math.ceil(windowMs / 1000) };
  }
  entry.hits.push(now);
  memoryBuckets.set(key, entry);
  return { allowed: true, remaining: limit - entry.hits.length, retryAfterSec: 0 };
}

export function rateLimitDb(db: Db, key: string, limit: number, windowMs: number): RateLimitResult {
  const now = Date.now();
  return transaction(db, () => {
    const row = get<{ window_start: number; hits: number; blocked_until: number }>(
      db,
      'SELECT window_start, hits, blocked_until FROM rate_limit_buckets WHERE key = ?',
      [key],
    );
    let windowStart = row?.window_start ?? now;
    let hits = row?.hits ?? 0;
    let blockedUntil = row?.blocked_until ?? 0;
    if (now - windowStart >= windowMs) {
      windowStart = now;
      hits = 0;
      blockedUntil = 0;
    }
    if (blockedUntil > now) {
      return { allowed: false, remaining: 0, retryAfterSec: Math.ceil((blockedUntil - now) / 1000) };
    }
    if (hits >= limit) {
      blockedUntil = now + windowMs;
      run(
        db,
        `INSERT INTO rate_limit_buckets(key, window_start, hits, blocked_until, updated_at)
         VALUES(?,?,?,?,?)
         ON CONFLICT(key) DO UPDATE SET window_start=excluded.window_start, hits=excluded.hits,
           blocked_until=excluded.blocked_until, updated_at=excluded.updated_at`,
        [key, windowStart, hits, blockedUntil, now],
      );
      return { allowed: false, remaining: 0, retryAfterSec: Math.ceil(windowMs / 1000) };
    }
    hits += 1;
    run(
      db,
      `INSERT INTO rate_limit_buckets(key, window_start, hits, blocked_until, updated_at)
       VALUES(?,?,?,?,?)
       ON CONFLICT(key) DO UPDATE SET window_start=excluded.window_start, hits=excluded.hits,
         blocked_until=excluded.blocked_until, updated_at=excluded.updated_at`,
      [key, windowStart, hits, blockedUntil, now],
    );
    return { allowed: true, remaining: limit - hits, retryAfterSec: 0 };
  });
}

export function rateLimit(
  db: Db,
  backend: 'memory' | 'db',
  key: string,
  limit: number,
  windowMs: number,
): RateLimitResult {
  return backend === 'memory' ? rateLimitMemory(key, limit, windowMs) : rateLimitDb(db, key, limit, windowMs);
}

export function resetRateLimits(db?: Db): void {
  memoryBuckets.clear();
  if (db) run(db, 'DELETE FROM rate_limit_buckets');
}

export function clientIp(req: { socket?: { remoteAddress?: string | null } }, trustProxy: boolean, forwarded?: string): string {
  if (trustProxy && forwarded) return forwarded.split(',')[0].trim();
  return req.socket?.remoteAddress ?? 'unknown';
}
