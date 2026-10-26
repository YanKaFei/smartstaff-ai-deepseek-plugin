import { openDatabase } from '../src/db/index.js';
import { makeConfig } from '../src/config.js';
import { seedDemo } from '../src/seed.js';
import { advanceSimulationAndSummarize } from '../src/domain/simulator.js';
import { all } from '../src/lib/db.js';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { serverRoot } from '../src/config.js';
const cfg = makeConfig({ nodeEnv: 'test' });
const h = openDatabase(':memory:');
const s = seedDemo(h.db, cfg);
const summary = await advanceSimulationAndSummarize(h.db, s.storeId, 180, cfg);
const events = all<{ type: string; n: number }>(h.db, "SELECT type, COUNT(*) n FROM ops_events WHERE source='sim' GROUP BY type ORDER BY n DESC");
const transitions = all<{ type: string; n: number }>(h.db, "SELECT type, COUNT(*) n FROM ops_events WHERE source='sim' AND type IN ('checkout','leave','clean_done','queue_call','seat','queue_join') GROUP BY type");
const evidence = {
  checkedAt: new Date().toISOString(),
  scene: 'seed 18:00 + 3 simulated hours',
  summary,
  events,
  manualEquivalentTransitions: transitions.reduce((a, b) => a + b.n, 0),
  uiActionEstimate: (() => {
    const count = (type: string) => transitions.find((t) => t.type === type)?.n ?? 0;
    // Table transitions: tap table + choose action. Queue seat/call/join: one action each.
    return (count('checkout') + count('leave') + count('clean_done')) * 2 + count('seat') + count('queue_call') + count('queue_join');
  })(),
  note:
    'If entered manually at one action per event, these 3 hours require the lower-bound number of manager actions shown. ' +
    'The UI action sheet adds a selection step for table transitions, so the uiActionEstimate is the more realistic count. ' +
    'The simulator sources all of them automatically.',
};
const out = path.join(serverRoot, '..', '..', 'docs', 'r1-evidence', 'operations-evidence.json');
writeFileSync(out, JSON.stringify(evidence, null, 2));
console.log(JSON.stringify(evidence, null, 2));
h.close();
