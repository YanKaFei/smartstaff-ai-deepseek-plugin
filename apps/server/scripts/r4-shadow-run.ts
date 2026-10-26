import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { openDatabase } from '../src/db/index.js';
import { makeConfig, serverRoot } from '../src/config.js';
import { seedDemo } from '../src/seed.js';
import { importDataset } from '../src/domain/dataImport.js';
import { runReplay } from '../src/domain/replay.js';

const cfg = makeConfig({ nodeEnv: 'test' });
const handle = openDatabase(':memory:');
try {
  const seeded = seedDemo(handle.db, cfg);
  const csv = readFileSync(path.join(serverRoot, '..', '..', 'docs', 'R4-SIMULATED-IMPORT.csv'));
  const imported = importDataset(handle.db, seeded.storeId, {
    filename: 'R4-SIMULATED-IMPORT.csv',
    format: 'csv',
    content: csv,
    dataOrigin: 'SIMULATED',
    actorId: 'r4-internal-test',
  });
  const replay = runReplay(handle.db, seeded.storeId, imported.importId, 'r4-internal-test');
  const outDir = path.join(serverRoot, '..', '..', 'docs', 'r4-evidence');
  mkdirSync(outDir, { recursive: true });
  writeFileSync(path.join(outDir, 'simulated-import-quality.json'), JSON.stringify({ dataOrigin: 'SIMULATED', importId: imported.importId, quality: imported.quality }, null, 2));
  writeFileSync(path.join(outDir, 'simulated-replay-evaluation.json'), JSON.stringify({ dataOrigin: 'SIMULATED', importId: imported.importId, replay }, null, 2));
  console.log(JSON.stringify({ dataOrigin: 'SIMULATED', importId: imported.importId, quality: imported.quality, runs: replay.runs.map((r) => ({ model: r.model, mode: r.serviceMode, metrics: r.metrics })) }, null, 2));
} finally {
  handle.close();
}
