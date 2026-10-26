import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { Db } from '../db/index.js';
import { get } from './db.js';
import { sha256 } from './ids.js';
import { AppError } from './errors.js';

/** One-time manager invite code. Store owner/admin issues it; the manager must also pass a real identity. */
export function issueManagerClaim(db: Db, storeId: string, ttlHours = 24): { code: string; expiresAt: number } {
  const store = get<{ id: string }>(db, 'SELECT id FROM stores WHERE id = ?', [storeId]);
  if (!store) throw new AppError(404, 'STORE_NOT_FOUND', '门店不存在');
  const code = randomBytes(5).toString('hex').toUpperCase(); // 10 chars
  const expiresAt = Date.now() + ttlHours * 3_600_000;
  db.prepare('UPDATE stores SET manager_claim_hash = ?, manager_claim_expires_at = ? WHERE id = ?').run(
    sha256(code),
    expiresAt,
    storeId,
  );
  return { code, expiresAt };
}

/** Consume a claim once. Call only after the caller's identity has been verified (wx code or demo). */
export function consumeManagerClaim(db: Db, storeId: string, claimCode: string): void {
  const store = get<{ manager_claim_hash: string | null; manager_claim_expires_at: number | null }>(
    db,
    'SELECT manager_claim_hash, manager_claim_expires_at FROM stores WHERE id = ?',
    [storeId],
  );
  if (!store?.manager_claim_hash || !store.manager_claim_expires_at) {
    throw new AppError(409, 'CLAIM_NOT_ISSUED', '该门店没有可用的店长授权码');
  }
  if (store.manager_claim_expires_at < Date.now()) {
    throw new AppError(409, 'CLAIM_EXPIRED', '店长授权码已过期');
  }
  const candidate = Buffer.from(sha256(claimCode.trim().toUpperCase()), 'hex');
  const expected = Buffer.from(store.manager_claim_hash, 'hex');
  if (candidate.length !== expected.length || !timingSafeEqual(candidate, expected)) {
    throw new AppError(403, 'CLAIM_INVALID', '店长授权码不正确');
  }
  db.prepare('UPDATE stores SET manager_claim_hash = NULL, manager_claim_expires_at = NULL WHERE id = ?').run(storeId);
}
