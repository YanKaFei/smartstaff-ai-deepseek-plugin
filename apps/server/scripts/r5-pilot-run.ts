import { mkdirSync, writeFileSync } from 'node:fs';
import { get } from '../src/lib/db.js';
import path from 'node:path';
import { openDatabase } from '../src/db/index.js';
import { makeConfig, serverRoot } from '../src/config.js';
import { seedDemo } from '../src/seed.js';
import { createPilot, getPilot, updatePilot } from '../src/domain/pilots.js';
import { importPilotEvents, importPilotWorkload, pilotDataQuality, workloadAnalysis } from '../src/domain/pilotData.js';
import { runReplay } from '../src/domain/replay.js';

const cfg = makeConfig({ nodeEnv: 'test' });
const handle = openDatabase(':memory:');
function iso(date: string, time: string) { return `${date}T${time}:00+08:00`; }
function eventsCsv() {
  const lines = ['pilot_id,store_code,business_date,event_id,event_type,occurred_at,table_label,table_type,party_size,staff_role,staff_anonymous_id,call_no,service_mode,on_duty_staff,manager_sufficiency'];
  for (let d = 0; d < 14; d += 1) {
    const date = `2026-10-${String(1 + d).padStart(2, '0')}`;
    for (const [idx, table, type, party, leave, suff] of [
      [1, 'S1', 'small', 2, '22:20', 'short'],
      [2, 'M1', 'medium', 4, '22:20', 'adequate'],
    ] as Array<[number, string, string, number, string, string]>) {
      const p = `${date}-${idx}`;
      lines.push(`R5-PILOT-001,K001,${date},${p}-q,queue_join,${iso(date, '18:00')},${table},${type},${party},server,S01,1,partial,3,${suff}`);
      lines.push(`R5-PILOT-001,K001,${date},${p}-seat,seat,${iso(date, idx === 1 ? '18:10' : '18:20')},${table},${type},${party},server,S01,,partial,3,${suff}`);
      lines.push(`R5-PILOT-001,K001,${date},${p}-out,checkout,${iso(date, '21:50')},${table},${type},${party},server,S01,,partial,3,${suff}`);
      lines.push(`R5-PILOT-001,K001,${date},${p}-leave,leave,${iso(date, leave)},${table},${type},${party},server,S01,,partial,3,${suff}`);
      lines.push(`R5-PILOT-001,K001,${date},${p}-clean,clean,${iso(date, '22:30')},${table},${type},${party},server,S01,,partial,3,${suff}`);
    }
  }
  return lines.join('\n');
}
const workloadCsv = `pilot_id,store_code,observation_id,staff_role,service_mode,table_type,action,start_at,end_at,minutes,business_date
R5-PILOT-001,K001,w1,server,partial,small,greet,2026-10-01T18:10:00+08:00,2026-10-01T18:15:00+08:00,5,2026-10-01
R5-PILOT-001,K001,w2,server,partial,small,grill,2026-10-01T18:15:00+08:00,2026-10-01T18:35:00+08:00,20,2026-10-01
R5-PILOT-001,K001,w3,server,partial,medium,serve,2026-10-01T18:30:00+08:00,2026-10-01T18:40:00+08:00,10,2026-10-01
`;
try {
  const seeded = seedDemo(handle.db, cfg);
  const pilot = createPilot(handle.db, seeded.storeId, {
    anonymousCode: 'R5-PILOT-001', serviceMode: 'partial', hoursStart: '16:00', hoursEnd: '02:00',
    tableConfig: { small: 8, medium: 12, large: 4 }, staffing: { onDuty: 3 }, roles: ['server', 'grill'],
    dataSources: ['simulated_event_sheet'], coverageStart: '2026-10-01', coverageEnd: '2026-10-14',
    owner: 'pilot-owner', startDate: '2026-10-01', endDate: '2026-10-14',
  }, 'r5-sim');
  updatePilot(handle.db, pilot.id, { authorizationStatus: 'authorized' }, 'r5-sim');
  const events = importPilotEvents(handle.db, pilot.id, { filename: 'R5-EVENTS-SIMULATED.csv', format: 'csv', content: eventsCsv(), dataOrigin: 'SIMULATED', actorId: 'r5-sim' });
  const workloads = importPilotWorkload(handle.db, pilot.id, { filename: 'R5-WORKLOAD-SIMULATED.csv', format: 'csv', content: workloadCsv, dataOrigin: 'SIMULATED', actorId: 'r5-sim' });
  const replay = runReplay(handle.db, seeded.storeId, events.sessionImportId!, 'r5-sim');
  const quality = pilotDataQuality(handle.db, pilot.id);
  const workload = workloadAnalysis(handle.db, pilot.id);
  const out = path.join(serverRoot, '..', '..', 'docs', 'r5-evidence');
  mkdirSync(out, { recursive: true });
  writeFileSync(path.join(out, 'simulated-pilot-quality.json'), JSON.stringify({ dataOrigin: 'SIMULATED', pilot: getPilot(handle.db, pilot.id), eventQuality: events.quality, sessionCount: events.sessionCount, workloadQuality: workloads.quality, totals: quality.totals, workload }, null, 2));
  writeFileSync(path.join(out, 'simulated-replay-evaluation.json'), JSON.stringify({ dataOrigin: 'SIMULATED', pilotId: pilot.id, replay }, null, 2));
  const first = get<{ recommended: number; actual_json: string; input_snapshot_json: string }>(
    handle.db,
    'SELECT recommended, actual_json, input_snapshot_json FROM replay_predictions WHERE run_id = ? ORDER BY prediction_time LIMIT 1',
    [replay.runs[0].runId],
  )!;
  const actual = JSON.parse(first.actual_json);
  const snapshot = JSON.parse(first.input_snapshot_json);
  writeFileSync(path.join(out, 'detection-diagnostic.json'), JSON.stringify({
    dataOrigin: 'SIMULATED',
    status: 'SIMULATED_ONLY',
    note: 'This diagnostic explains the 0% detection rate; it does not relax the evaluation threshold.',
    firstPrediction: {
      onDutyStaff: snapshot.onDutyStaff,
      activeTableCounts: snapshot.activeTableCounts,
      predictedRequired: first.recommended,
      predictedGap: actual.predictedGap,
      actualRequired: actual.required,
      actualShortage: actual.actualShortage,
      managerSufficiency: actual.managerSufficiency,
      labelMethod: actual.method,
    },
    cause: {
      predictedShortageCount: replay.runs[0].metrics.predictedShortageCount,
      actualShortageCount: replay.runs[0].metrics.actualShortageCount,
      peakShortageDetectionRate: replay.runs[0].metrics.peakShortageDetectionRate,
      explanation: 'Every simulated point has only two concurrent tables but on-duty=3 and the label adds +1 for short. The model predicts no gap (required 2 <= on-duty 3), so no actual-shortage point can be detected. This is a scenario/label inconsistency and model underprediction, not a threshold that should be lowered.',
    },
  }, null, 2));
  console.log(JSON.stringify({ dataOrigin: 'SIMULATED', pilotId: pilot.id, sessions: events.sessionCount, workload: workload.sampleCount, runs: replay.runs.map((r) => ({ model: r.model, mode: r.serviceMode, metrics: r.metrics })) }, null, 2));
} finally {
  handle.close();
}
