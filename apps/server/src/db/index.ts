import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from '../config.js';
import { DDL, SCHEMA_VERSION } from './schema.js';
import { logger } from '../lib/logger.js';

export type Db = DatabaseSync;

export interface DbHandle {
  db: Db;
  close: () => void;
}

function tableColumns(db: Db, table: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return new Set(rows.map((r) => r.name));
}

/**
 * Additive migrations for existing 1.0 databases. We never drop user data.
 * Fresh databases get the columns from DDL; old ones get ALTER TABLE.
 */
function migrate(db: Db): void {
  const add = (table: string, column: string, sql: string) => {
    const cols = tableColumns(db, table);
    if (!cols.has(column)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${sql}`);
      logger.info('migration_add_column', { table, column });
    }
  };
  add('users', 'openid', 'openid TEXT');
  add('users', 'phone_verified', 'phone_verified INTEGER NOT NULL DEFAULT 0');
  add('sessions', 'refresh_token_hash', 'refresh_token_hash TEXT');
  add('sessions', 'access_expires_at', 'access_expires_at INTEGER');
  add('sessions', 'refresh_expires_at', 'refresh_expires_at INTEGER');
  add('sessions', 'last_auth_at', 'last_auth_at INTEGER');
  add('stores', 'owner_user_id', 'owner_user_id TEXT');
  add('stores', 'manager_claim_hash', 'manager_claim_hash TEXT');
  add('stores', 'manager_claim_expires_at', 'manager_claim_expires_at INTEGER');
  add('stores', 'webhook_secret', 'webhook_secret TEXT');
  add('stores', 'webhook_secret_enc', 'webhook_secret_enc TEXT');
  add('stores', 'webhook_secret_rotated_at', 'webhook_secret_rotated_at INTEGER');
  add('assignment_plans', 'shadow', 'shadow INTEGER NOT NULL DEFAULT 0');
  add('pilot_feedback', 'no_show', 'no_show INTEGER NOT NULL DEFAULT 0');
  add('pilot_feedback', 'decision', 'decision TEXT');
  add('pilot_feedback', 'reasons_json', 'reasons_json TEXT');
  add('pilot_feedback', 'correction', 'correction TEXT');
  add('data_imports', 'pilot_id', 'pilot_id TEXT');
  add('data_imports', 'dataset_type', "dataset_type TEXT NOT NULL DEFAULT 'sessions'");
  add('import_observations', 'pilot_id', 'pilot_id TEXT');
  add('replay_predictions', 'phase', 'phase TEXT');
  add('shifts', 'demand_id', 'demand_id TEXT');
  add('shifts', 'is_backfill', 'is_backfill INTEGER NOT NULL DEFAULT 0');
  add('shifts', 'cancelled_at', 'cancelled_at INTEGER');
  add('shifts', 'cancelled_by', 'cancelled_by TEXT');
  add('shifts', 'cancel_reason', 'cancel_reason TEXT');
  add('shifts', 'cancel_kind', 'cancel_kind TEXT');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS ux_users_openid ON users(openid) WHERE openid IS NOT NULL');
  db.exec(
    'CREATE UNIQUE INDEX IF NOT EXISTS ux_sessions_refresh ON sessions(refresh_token_hash) WHERE refresh_token_hash IS NOT NULL',
  );
  db.prepare('INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(
    'schema_version',
    String(SCHEMA_VERSION),
  );
}

export function openDatabase(file: string = config.databasePath): DbHandle {
  if (file !== ':memory:') {
    mkdirSync(path.dirname(file), { recursive: true });
  }
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA busy_timeout = 5000;');
  db.exec(DDL);
  migrate(db);
  logger.info('database_ready', { file });
  return {
    db,
    close: () => db.close(),
  };
}

let singleton: DbHandle | null = null;

export function getDatabase(): DbHandle {
  if (!singleton) singleton = openDatabase();
  return singleton;
}

export function closeDatabase(): void {
  if (singleton) {
    singleton.close();
    singleton = null;
  }
}
