import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { openDatabase } from '../src/db/index.js';
import { makeConfig, serverRoot } from '../src/config.js';
import { seedDemo } from '../src/seed.js';
import { generateForecast } from '../src/domain/forecast.js';
import { getStore, parseConfig, updateStoreConfig } from '../src/domain/stores.js';
import { setClock } from '../src/domain/clock.js';

const cfg = makeConfig({ nodeEnv: 'test' });
const handle = openDatabase(':memory:');
const seeded = seedDemo(handle.db, cfg);
setClock(handle.db, seeded.storeId, { at: seeded.simNow });
const base = parseConfig(getStore(handle.db, seeded.storeId));
const evidence: Record<string, unknown> = { checkedAt: new Date().toISOString(), scenario: 'R1 canonical 24 tables / 3 on-duty / 14 queue / 7-day history', modes: {} };
for (const [name, patch] of Object.entries({
  legacy_standard: { capacityModel: 'legacy', capacityBasis: 'standard_equivalent', serviceMode: 'partial' },
  legacy_physical: { capacityModel: 'legacy', capacityBasis: 'physical_tables', serviceMode: 'partial' },
  minutes_full: { capacityModel: 'service_minutes', serviceMode: 'full' },
  minutes_partial: { capacityModel: 'service_minutes', serviceMode: 'partial' },
  minutes_self: { capacityModel: 'service_minutes', serviceMode: 'self' },
}) as Array<[string, Record<string, unknown>]>) {
  updateStoreConfig(handle.db, seeded.storeId, {
    ...base,
    staffing: { ...base.staffing, calibrationStatus: 'unverified', ...patch },
  } as typeof base);
  const f = await generateForecast(handle.db, seeded.storeId, cfg, { useAi: false, now: seeded.simNow });
  (evidence.modes as Record<string, unknown>)[name] = {
    peakRequiredStaff: f.peakRequiredStaff,
    peakGap: f.peakGap,
    perSlotRequired: f.slots.map((s) => s.requiredStaff),
    perSlotWorkloadMinutes: f.slots.map((s) => s.workloadMinutes ?? null),
    reliability: f.reliability,
    modelWarning: f.modelWarning ?? null,
    model: f.model,
    capacityBasis: f.capacityBasis,
    serviceMode: f.serviceMode,
  };
}
const outDir = path.join(serverRoot, '..', '..', 'docs', 'r2-evidence');
mkdirSync(outDir, { recursive: true });
writeFileSync(path.join(outDir, 'service-model-comparison.json'), JSON.stringify(evidence, null, 2));
console.log(JSON.stringify(evidence, null, 2));
handle.close();
