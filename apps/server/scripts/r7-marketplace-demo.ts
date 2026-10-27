import { openDatabase } from '../src/db/index.js';
import { makeConfig } from '../src/config.js';
import { createStore, finishOnboarding, getStore } from '../src/domain/stores.js';
import { createDemand } from '../src/domain/dispatch.js';
import { get, run } from '../src/lib/db.js';
import { id } from '../src/lib/ids.js';
import { setClock, storeNow } from '../src/domain/clock.js';

const cfg = makeConfig({ nodeEnv: 'test' });
const h = openDatabase('./data/smartstaff.db');
try {
  const home = get<{ id: string; name: string }>(h.db, "SELECT id, name FROM stores WHERE manager_code = 'K001'")!;
  const homeOrg = get<{ organization_id: string }>(h.db, 'SELECT organization_id FROM stores WHERE id = ?', [home.id])!;
  let second = get<{ id: string }>(h.db, "SELECT id FROM stores WHERE manager_code = 'K002'");
  if (!second) {
    const store = createStore(h.db, { name: '焰遇烤肉 · 南山店', managerCode: 'K002', address: '南山区测试路 2 号' });
    finishOnboarding(h.db, store.id);
    run(h.db, 'UPDATE stores SET organization_id = ? WHERE id = ?', [homeOrg.organization_id, store.id]);
    const managerId = id('usr');
    run(h.db, "INSERT INTO users(id, role, name, phone, password_hash, store_id, openid, phone_verified, created_at) VALUES(?,?,?,?,?,?,?,?,?)", [managerId, 'manager', '南山店长', null, null, store.id, null, 1, Date.now()]);
    second = { id: store.id };
  }
  const now = Math.floor(storeNow(h.db, home.id) / 60_000) * 60_000;
  for (const [storeId, headcount] of [[home.id, 1], [second.id, 2]] as Array<[string, number]>) {
    setClock(h.db, storeId, { at: now });
    const start = now + 2 * 3_600_000;
    const end = now + 4 * 3_600_000;
    const existing = get(h.db, 'SELECT id FROM staffing_demands WHERE store_id = ? AND start_at = ? AND end_at = ?', [storeId, start, end]);
    if (existing) continue;
    createDemand(h.db, { storeId, planId: null, role: '烤肉辅助', startAt: start, endAt: end, headcount, hourlyRate: 32 });
  }
  console.log(JSON.stringify({ ok: true, home: home.id, second: second.id, now }, null, 2));
} finally {
  h.close();
}
