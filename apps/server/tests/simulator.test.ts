import test from 'node:test';
import assert from 'node:assert/strict';
import { freshApp, managerLogin, api } from './helpers.js';
import { advanceSimulationAndSummarize, simulationStatus } from '../src/domain/simulator.js';
import { storeNow } from '../src/domain/clock.js';
import { all, get } from '../src/lib/db.js';

test('seed: seven days of history exist before the demo day', async () => {
  const app = await freshApp();
  try {
    const days = all<{ business_date: string; status: string; latest_call_no: number }>(
      app.db,
      "SELECT business_date, status, latest_call_no FROM business_days WHERE status = 'closed' ORDER BY business_date",
    );
    assert.equal(days.length, 7);
    assert.ok(days.every((d) => d.latest_call_no > 0));
    const sessions = get<{ n: number }>(app.db, "SELECT COUNT(*) AS n FROM dining_sessions WHERE source = 'history'")!;
    assert.ok(sessions.n > 300);
    const calls = get<{ n: number }>(app.db, "SELECT COUNT(*) AS n FROM queue_entries WHERE source = 'history' AND status = 'seated'")!;
    assert.ok(calls.n > 300);
    const events = get<{ n: number }>(app.db, "SELECT COUNT(*) AS n FROM ops_events WHERE source = 'history'")!;
    assert.ok(events.n > 1000, 'history should include call/seat/checkout/leave/clean events');
  } finally {
    await app.close();
  }
});

test('simulator: advancing time writes ops events, moves tables and recomputes demand', async () => {
  const app = await freshApp();
  try {
    const before = get<{ n: number }>(app.db, 'SELECT COUNT(*) AS n FROM ops_events')!.n;
    const beforeSessions = get<{ n: number }>(app.db, 'SELECT COUNT(*) AS n FROM dining_sessions')!.n;
    const target = storeNow(app.db, app.storeId) + 60 * 60_000;
    const summary = await advanceSimulationAndSummarize(app.db, app.storeId, 60, app.cfg);
    assert.ok(summary.arrivals > 0);
    assert.ok(summary.seated > 0);
    assert.ok(summary.checkout > 0);
    assert.ok(summary.cleaned > 0);
    assert.ok(summary.calls > 0);
    assert.ok(summary.latestCallNo > 38);
    assert.equal(summary.forecastGenerated, true);

    const after = get<{ n: number }>(app.db, 'SELECT COUNT(*) AS n FROM ops_events')!.n;
    assert.ok(after > before + 10);
    const afterSessions = get<{ n: number }>(app.db, 'SELECT COUNT(*) AS n FROM dining_sessions')!.n;
    assert.ok(afterSessions > beforeSessions);

    const simEvents = get<{ n: number }>(app.db, "SELECT COUNT(*) AS n FROM ops_events WHERE source = 'sim'")!.n;
    assert.ok(simEvents > 10);
    const ingestEvents = get<{ n: number }>(app.db, "SELECT COUNT(*) AS n FROM event_ingest WHERE source = 'simulator'")!.n;
    assert.ok(ingestEvents > 10, 'simulator transitions should be mirrored into the ingestion ledger');

    const latestForecast = get<{ generated_at: number }>(
      app.db,
      'SELECT generated_at FROM forecasts WHERE store_id = ? ORDER BY generated_at DESC LIMIT 1',
      [app.storeId],
    )!;
    assert.ok(latestForecast.generated_at <= storeNow(app.db, app.storeId));
    // Forecasts never see events later than their generation time.
    const future = get<{ n: number }>(
      app.db,
      'SELECT COUNT(*) AS n FROM ops_events WHERE store_id = ? AND occurred_at > ?',
      [app.storeId, latestForecast.generated_at],
    )!;
    assert.equal(future.n, 0);

    const status = simulationStatus(app.db, app.storeId);
    assert.ok(status.now >= target - 1000);
  } finally {
    await app.close();
  }
});

test('simulator: API advance is validated and simulated clock is returned', async () => {
  const app = await freshApp();
  try {
    const token = await managerLogin(app);
    const bad = await api(app.base, 'POST', '/api/manager/sim/advance', { minutes: 0 }, token);
    assert.equal(bad.status, 400);
    const good = await api(app.base, 'POST', '/api/manager/sim/advance', { minutes: 15 }, token);
    assert.equal(good.status, 200);
    const today = (good.data as { today: { now: number; queue: { groups: number } } }).today;
    assert.ok(today.now > 0);
    assert.ok(today.queue.groups >= 0);
  } finally {
    await app.close();
  }
});
