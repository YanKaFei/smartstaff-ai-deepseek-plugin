import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openDatabase } from '../src/db/index.js';
import { makeConfig } from '../src/config.js';
import { seedDemo } from '../src/seed.js';
import { createBackup, restoreBackup, verifyBackupFile } from '../src/lib/backup.js';
import { get } from '../src/lib/db.js';

test('R3 backup: online snapshot verifies, restores, and preserves data', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'smartstaff-backup-'));
  const dbPath = path.join(dir, 'source.db');
  const backupPath = path.join(dir, 'backup.db');
  const restoredPath = path.join(dir, 'restored.db');
  const cfg = makeConfig({ nodeEnv: 'test' });
  const handle = openDatabase(dbPath);
  try {
    const seeded = seedDemo(handle.db, cfg);
    const manifest = createBackup(handle.db, dbPath, backupPath);
    assert.equal(manifest.integrity, 'ok');
    assert.ok(manifest.bytes > 0);
    assert.equal(manifest.sha256.length, 64);
    const verified = verifyBackupFile(backupPath);
    assert.equal(verified.ok, true);
    assert.equal(verified.sha256, manifest.sha256);

    handle.close();
    const restored = restoreBackup(backupPath, restoredPath);
    assert.equal(restored.integrity, 'ok');
    const reopened = openDatabase(restoredPath);
    try {
      const stores = get<{ n: number }>(reopened.db, 'SELECT COUNT(*) AS n FROM stores')!.n;
      assert.equal(stores, 1);
      const seededStore = get<{ id: string }>(reopened.db, 'SELECT id FROM stores LIMIT 1')!;
      assert.equal(seededStore.id, seeded.storeId);
    } finally {
      reopened.close();
    }
  } finally {
    try { handle.close(); } catch { /* already closed */ }
    rmSync(dir, { recursive: true, force: true });
  }
});
