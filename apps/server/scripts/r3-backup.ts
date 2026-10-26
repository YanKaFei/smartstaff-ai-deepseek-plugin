import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { getDatabase } from '../src/db/index.js';
import { config } from '../src/config.js';
import { createBackup, restoreBackup, verifyBackupFile } from '../src/lib/backup.js';

const mode = process.argv[2] ?? 'backup';
const handle = getDatabase();
try {
  if (mode === 'backup') {
    const dest = process.argv[3] ?? path.join(process.cwd(), 'backups', `smartstaff-${Date.now()}.db`);
    const manifest = createBackup(handle.db, config.databasePath, dest);
    const manifestPath = `${dest}.manifest.json`;
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    console.log(JSON.stringify({ ok: true, manifest, manifestPath }, null, 2));
  } else if (mode === 'verify') {
    const file = process.argv[3];
    if (!file) throw new Error('usage: r3-backup.ts verify <backup.db>');
    console.log(JSON.stringify(verifyBackupFile(file), null, 2));
  } else if (mode === 'restore') {
    const file = process.argv[3];
    if (!file) throw new Error('usage: r3-backup.ts restore <backup.db>');
    console.log(JSON.stringify(restoreBackup(file, config.databasePath), null, 2));
  } else {
    throw new Error('mode must be backup | verify | restore');
  }
} finally {
  handle.close();
}
