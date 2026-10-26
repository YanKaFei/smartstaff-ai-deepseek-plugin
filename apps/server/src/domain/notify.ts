import type { Db } from '../db/index.js';
import { run } from '../lib/db.js';
import { id } from '../lib/ids.js';

export function notifyUser(
  db: Db,
  input: {
    userId: string;
    storeId?: string | null;
    type: string;
    title: string;
    body: string;
    related?: Record<string, unknown>;
    at: number;
  },
): string {
  const notificationId = id('ntf');
  run(
    db,
    'INSERT INTO notifications(id, user_id, store_id, type, title, body, read, related_json, created_at) VALUES(?,?,?,?,?,?,0,?,?)',
    [
      notificationId,
      input.userId,
      input.storeId ?? null,
      input.type,
      input.title,
      input.body,
      JSON.stringify(input.related ?? {}),
      input.at,
    ],
  );
  return notificationId;
}

export function notifyStoreManagers(
  db: Db,
  storeId: string,
  input: { type: string; title: string; body: string; related?: Record<string, unknown>; at: number },
): void {
  const managers = db
    .prepare("SELECT id FROM users WHERE role = 'manager' AND store_id = ? LIMIT 10")
    .all(storeId) as Array<{ id: string }>;
  for (const manager of managers) {
    notifyUser(db, { userId: manager.id, storeId, ...input });
  }
}

export function createException(
  db: Db,
  input: {
    storeId: string;
    type: string;
    message: string;
    severity?: 'info' | 'warning' | 'critical';
    shiftId?: string | null;
    offerId?: string | null;
    payload?: Record<string, unknown>;
    at: number;
  },
): string {
  const exceptionId = id('exc');
  run(
    db,
    `INSERT INTO exceptions(id, store_id, type, severity, status, shift_id, offer_id, message, payload_json, created_at)
     VALUES(?,?,?,?,?,?,?,?,?,?)`,
    [
      exceptionId,
      input.storeId,
      input.type,
      input.severity ?? 'warning',
      'open',
      input.shiftId ?? null,
      input.offerId ?? null,
      input.message,
      JSON.stringify(input.payload ?? {}),
      input.at,
    ],
  );
  return exceptionId;
}

export function audit(
  db: Db,
  input: {
    storeId?: string | null;
    actorId?: string | null;
    actorRole?: string | null;
    action: string;
    entity?: string;
    entityId?: string;
    detail?: Record<string, unknown>;
    at: number;
  },
): void {
  run(
    db,
    `INSERT INTO audit_logs(id, store_id, actor_id, actor_role, action, entity, entity_id, detail_json, created_at)
     VALUES(?,?,?,?,?,?,?,?,?)`,
    [
      id('log'),
      input.storeId ?? null,
      input.actorId ?? null,
      input.actorRole ?? null,
      input.action,
      input.entity ?? null,
      input.entityId ?? null,
      JSON.stringify(input.detail ?? {}),
      input.at,
    ],
  );
}
