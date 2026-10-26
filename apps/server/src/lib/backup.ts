import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import type { Db } from '../db/index.js';
import { get, run } from './db.js';

export interface BackupManifest {
  createdAt: string;
  source: string;
  backup: string;
  bytes: number;
  sha256: string;
  integrity: string;
  tables: number;
}

function checksum(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

export function createBackup(db: Db, sourcePath: string, destination: string): BackupManifest {
  mkdirSync(path.dirname(destination), { recursive: true });
  if (existsSync(destination)) throw new Error(`backup destination already exists: ${destination}`);
  // VACUUM INTO produces a consistent snapshot while the database is live.
  const escaped = destination.replace(/'/g, "''");
  db.exec(`VACUUM INTO '${escaped}'`);
  const integrity = String(get<{ integrity_check: string }>(db, 'PRAGMA integrity_check')?.integrity_check ?? 'unknown');
  const tableCount = get<{ n: number }>(db, "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table'")?.n ?? 0;
  const manifest: BackupManifest = {
    createdAt: new Date().toISOString(),
    source: sourcePath,
    backup: destination,
    bytes: statSync(destination).size,
    sha256: checksum(destination),
    integrity,
    tables: tableCount,
  };
  return manifest;
}

export function verifyBackupFile(file: string): { ok: boolean; integrity: string; sha256: string; bytes: number } {
  if (!existsSync(file)) throw new Error(`backup file not found: ${file}`);
  // Use a short-lived database connection to verify the snapshot.
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const integrity = String((db.prepare('PRAGMA integrity_check').get() as { integrity_check: string })?.integrity_check ?? 'unknown');
    return { ok: integrity === 'ok', integrity, sha256: checksum(file), bytes: statSync(file).size };
  } finally {
    db.close();
  }
}

export function restoreBackup(backupFile: string, dbPath: string): { restored: true; preRestoreBackup: string; integrity: string } {
  const verified = verifyBackupFile(backupFile);
  if (!verified.ok) throw new Error(`backup failed integrity_check: ${verified.integrity}`);
  mkdirSync(path.dirname(dbPath), { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const preRestore = `${dbPath}.pre-restore-${stamp}`;
  if (existsSync(dbPath)) copyFileSync(dbPath, preRestore);
  copyFileSync(backupFile, dbPath);
  return { restored: true, preRestoreBackup: preRestore, integrity: verified.integrity };
}
