import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { openDatabase } from '../src/db/index.js';
import { makeConfig, serverRoot } from '../src/config.js';
import { seedDemo } from '../src/seed.js';
import { createPilot, updatePilot } from '../src/domain/pilots.js';
import { importPilotEvents, importPilotWorkload, pilotDataQuality } from '../src/domain/pilotData.js';
import { runReplay } from '../src/domain/replay.js';

const cfg = makeConfig({ nodeEnv: 'test' });
const h = openDatabase(':memory:');
const iso = (t: string) => `2026-10-01T${t}:00+08:00`;
const date = '2026-10-01';
const header = 'pilot_id,store_code,business_date,event_id,event_type,occurred_at,table_label,table_type,party_size,staff_role,staff_anonymous_id,call_no,service_mode,on_duty_staff,manager_required,manager_required_reason,manager_sufficiency';
const rows = [
  `R5-DRY,K001,${date},d1-q,queue_join,${iso('18:00')},S1,small,2,server,S01,1,partial,3,,,short`,
  `R5-DRY,K001,${date},d1-seat,seat,${iso('18:10')},S1,small,2,server,S01,,partial,3,4,晚市高峰需要,short`,
  `R5-DRY,K001,${date},d1-out,checkout,${iso('21:10')},S1,small,2,server,S01,,partial,3,4,晚市高峰需要,short`,
  `R5-DRY,K001,${date},d1-leave,leave,${iso('21:30')},S1,small,2,server,S01,,partial,3,4,晚市高峰需要,short`,
  `R5-DRY,K001,${date},d1-clean,clean,${iso('21:40')},S1,small,2,server,S01,,partial,3,4,晚市高峰需要,short`,
  `R5-DRY,K001,${date},d2-seat,seat,${iso('18:20')},M1,medium,4,server,S02,,partial,3,4,晚市高峰需要,short`,
  `R5-DRY,K001,${date},d2-leave,leave,${iso('21:30')},M1,medium,4,server,S02,,partial,3,4,晚市高峰需要,short`,
  `R5-DRY,K001,${date},d2-clean,clean,${iso('21:40')},M1,medium,4,server,S02,,partial,3,4,晚市高峰需要,short`,
  `R5-DRY,K001,${date},d1-seat,seat,${iso('18:10')},S1,small,2,server,S01,,partial,3,4,,short`,
  `R5-DRY,K001,${date},bad-time,seat,not-a-time,S1,small,2,server,S01,,partial,3,4,,short`,
];
const workload = `pilot_id,store_code,observation_id,staff_role,service_mode,table_type,action,start_at,end_at,minutes,business_date
R5-DRY,K001,w1,server,partial,small,greet,${iso('18:10')},${iso('18:15')},5,${date}
R5-DRY,K001,w2,server,partial,small,grill,${iso('18:15')},${iso('18:35')},20,${date}
R5-DRY,K001,w3,server,partial,medium,serve,${iso('18:30')},${iso('18:40')},10,${date}
R5-DRY,K001,w1,server,partial,small,greet,${iso('18:10')},${iso('18:15')},5,${date}
`;
try {
  const seeded = seedDemo(h.db, cfg);
  const pilot = createPilot(h.db, seeded.storeId, {
    anonymousCode: 'R5-DRY', serviceMode: 'partial', hoursStart: '16:00', hoursEnd: '02:00',
    tableConfig: { small: 8, medium: 12, large: 4 }, staffing: { onDuty: 3 }, roles: ['server'],
    dataSources: ['simulated dry run'], coverageStart: date, coverageEnd: date, owner: 'pilot-owner', startDate: date, endDate: date,
  }, 'r52-dry');
  updatePilot(h.db, pilot.id, { authorizationStatus: 'authorized' }, 'r52-dry');
  const events = importPilotEvents(h.db, pilot.id, { filename: 'dry-events.csv', format: 'csv', content: [header, ...rows].join('\n'), dataOrigin: 'SIMULATED', actorId: 'r52-dry' });
  const wl = importPilotWorkload(h.db, pilot.id, { filename: 'dry-workload.csv', format: 'csv', content: workload, dataOrigin: 'SIMULATED', actorId: 'r52-dry' });
  const replay = runReplay(h.db, seeded.storeId, events.sessionImportId!, 'r52-dry');
  const quality = pilotDataQuality(h.db, pilot.id);
  const sideEffects = {
    offers: Number((h.db.prepare('SELECT COUNT(*) AS n FROM job_offers').get() as { n: number }).n),
    shifts: Number((h.db.prepare('SELECT COUNT(*) AS n FROM shifts').get() as { n: number }).n),
    notifications: Number((h.db.prepare('SELECT COUNT(*) AS n FROM notifications').get() as { n: number }).n),
  };
  const out = path.join(serverRoot, '..', '..', 'docs', 'r5.2-evidence');
  mkdirSync(out, { recursive: true });
  writeFileSync(path.join(out, 'field-dry-run.json'), JSON.stringify({
    dataOrigin: 'SIMULATED', status: 'SIMULATED_ONLY', pilotId: pilot.id, sessionCount: events.sessionCount,
    eventQuality: events.quality, workloadQuality: wl.quality, totals: quality.totals, replay,
    sideEffects, note: '2–3 hour field dry run with intentionally injected duplicate and bad-time rows; no real invitations.',
  }, null, 2));
  console.log(JSON.stringify({ sessions: events.sessionCount, eventQuality: events.quality, workloadQuality: wl.quality, runs: replay.runs.length, sideEffects }, null, 2));
} finally { h.close(); }
