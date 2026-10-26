import type { Db } from '../db/index.js';
import { get, run } from '../lib/db.js';
import { id } from '../lib/ids.js';
import { AppError } from '../lib/errors.js';
import { audit, notifyUser } from './notify.js';
import { getStore, parseConfig } from './stores.js';

export interface PilotControl {
  store_id: string;
  dispatch_paused: number;
  reason: string | null;
  updated_by: string | null;
  updated_at: number;
}

export function getPilotControl(db: Db, storeId: string): PilotControl {
  return (
    get<PilotControl>(db, 'SELECT * FROM pilot_controls WHERE store_id = ?', [storeId]) ?? {
      store_id: storeId,
      dispatch_paused: 0,
      reason: null,
      updated_by: null,
      updated_at: 0,
    }
  );
}

export function isDispatchPaused(db: Db, storeId: string): boolean {
  return getPilotControl(db, storeId).dispatch_paused === 1;
}

export function assertDispatchAllowed(db: Db, storeId: string): void {
  const control = getPilotControl(db, storeId);
  if (control.dispatch_paused) {
    throw new AppError(409, 'PILOT_DISPATCH_PAUSED', `试点调配已暂停：${control.reason ?? '店长紧急停止'}`);
  }
}

export function pausePilot(
  db: Db,
  storeId: string,
  actorId: string,
  reason: string,
  cancelPending = true,
): { control: PilotControl; cancelledOffers: number } {
  const now = Date.now();
  run(
    db,
    `INSERT INTO pilot_controls(store_id, dispatch_paused, reason, updated_by, updated_at)
     VALUES(?,?,?,?,?)
     ON CONFLICT(store_id) DO UPDATE SET dispatch_paused=1, reason=excluded.reason,
       updated_by=excluded.updated_by, updated_at=excluded.updated_at`,
    [storeId, 1, reason, actorId, now],
  );
  let cancelled = 0;
  if (cancelPending) {
    const offers = db
      .prepare("SELECT id, shift_id FROM job_offers WHERE store_id = ? AND status = 'pending'")
      .all(storeId) as Array<{ id: string; shift_id: string }>;
    for (const offer of offers) {
      const changed = run(
        db,
        "UPDATE job_offers SET status = 'cancelled', responded_at = ?, reason = 'pilot_paused' WHERE id = ? AND status = 'pending'",
        [now, offer.id],
      );
      if (Number(changed.changes) === 1) {
        const shift = get<{ staff_id: string; start_at: number }>(db, 'SELECT staff_id, start_at FROM shifts WHERE id = ?', [offer.shift_id]);
        run(
          db,
          "UPDATE shifts SET status = 'cancelled', cancelled_at = ?, cancelled_by = ?, cancel_reason = ?, cancel_kind = 'pilot_paused', updated_at = ? WHERE id = ? AND status = 'invited'",
          [now, actorId, reason, now, offer.shift_id],
        );
        if (shift) {
          const staff = get<{ user_id: string }>(db, 'SELECT user_id FROM staff_profiles WHERE id = ?', [shift.staff_id]);
          if (staff) {
            notifyUser(db, {
              userId: staff.user_id,
              storeId,
              type: 'shift_cancelled',
              title: '门店暂停试点调配',
              body: `门店紧急暂停调配，${new Date(shift.start_at).toISOString()} 的邀约已取消。`,
              related: { shiftId: offer.shift_id },
              at: now,
            });
          }
        }
        cancelled += 1;
      }
    }
  }
  run(
    db,
    "UPDATE backfill_tasks SET status = 'cancelled', updated_at = ? WHERE store_id = ? AND status IN ('pending','offered','needs_approval')",
    [now, storeId],
  );
  audit(db, {
    storeId,
    actorId,
    actorRole: 'manager',
    action: 'pilot.pause',
    entity: 'pilot_control',
    entityId: storeId,
    detail: { reason, cancelledOffers: cancelled },
    at: now,
  });
  return { control: getPilotControl(db, storeId), cancelledOffers: cancelled };
}

export function resumePilot(db: Db, storeId: string, actorId: string): PilotControl {
  run(
    db,
    `INSERT INTO pilot_controls(store_id, dispatch_paused, reason, updated_by, updated_at)
     VALUES(?,?,?,?,?)
     ON CONFLICT(store_id) DO UPDATE SET dispatch_paused=0, reason=NULL, updated_by=excluded.updated_by, updated_at=excluded.updated_at`,
    [storeId, 0, null, actorId, Date.now()],
  );
  audit(db, {
    storeId,
    actorId,
    actorRole: 'manager',
    action: 'pilot.resume',
    entity: 'pilot_control',
    entityId: storeId,
    at: Date.now(),
  });
  return getPilotControl(db, storeId);
}

export function recordShadowRun(
  db: Db,
  input: {
    storeId: string;
    planId: string;
    forecastId: string;
    recommendations: unknown;
    totalCost: number;
    note: string;
    actorId: string;
  },
): string {
  const shadowId = id('shadow');
  run(
    db,
    `INSERT INTO shadow_runs(id, store_id, plan_id, forecast_id, recommendations_json, total_cost, note, created_by, created_at)
     VALUES(?,?,?,?,?,?,?,?,?)`,
    [shadowId, input.storeId, input.planId, input.forecastId, JSON.stringify(input.recommendations), input.totalCost, input.note, input.actorId, Date.now()],
  );
  audit(db, {
    storeId: input.storeId,
    actorId: input.actorId,
    actorRole: 'manager',
    action: 'pilot.shadow_run',
    entity: 'shadow_run',
    entityId: shadowId,
    detail: { planId: input.planId, totalCost: input.totalCost },
    at: Date.now(),
  });
  return shadowId;
}

export function recordPilotFeedback(
  db: Db,
  storeId: string,
  actorId: string,
  input: { shadowRunId?: string; recommended: number; managerActual: number; onDuty: number; overloaded: boolean; noShow?: number; notes?: string },
): { id: string; error: number } {
  const feedbackId = id('pfb');
  const error = input.recommended - input.managerActual;
  run(
    db,
    `INSERT INTO pilot_feedback(id, store_id, shadow_run_id, recommended, manager_actual, on_duty, overloaded, no_show, notes, created_by, created_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
    [
      feedbackId,
      storeId,
      input.shadowRunId ?? null,
      input.recommended,
      input.managerActual,
      input.onDuty,
      input.overloaded ? 1 : 0,
      input.noShow ?? 0,
      input.notes ?? null,
      actorId,
      Date.now(),
    ],
  );
  return { id: feedbackId, error };
}

export function recordPilotUxMetric(
  db: Db,
  storeId: string,
  actorId: string,
  input: { flow: string; actionCount: number; elapsedMs: number; planId?: string; shadow?: boolean },
): string {
  const metricId = id('uxm');
  run(
    db,
    `INSERT INTO pilot_ux_metrics(id, store_id, flow, action_count, elapsed_ms, plan_id, shadow, created_at)
     VALUES(?,?,?,?,?,?,?,?)`,
    [metricId, storeId, input.flow, input.actionCount, input.elapsedMs, input.planId ?? null, input.shadow ? 1 : 0, Date.now()],
  );
  audit(db, {
    storeId,
    actorId,
    actorRole: 'manager',
    action: 'pilot.ux_metric',
    entity: 'pilot_ux_metric',
    entityId: metricId,
    detail: { flow: input.flow, actionCount: input.actionCount, elapsedMs: input.elapsedMs },
    at: Date.now(),
  });
  return metricId;
}

export function pilotSummary(db: Db, storeId: string) {
  const control = getPilotControl(db, storeId);
  const shadowRuns = db
    .prepare('SELECT id, plan_id, forecast_id, recommendations_json, total_cost, created_at FROM shadow_runs WHERE store_id = ? ORDER BY created_at DESC LIMIT 20')
    .all(storeId) as Array<Record<string, unknown>>;
  const feedback = db
    .prepare('SELECT recommended, manager_actual, on_duty, overloaded, no_show, created_at FROM pilot_feedback WHERE store_id = ? ORDER BY created_at DESC LIMIT 100')
    .all(storeId) as Array<{ recommended: number; manager_actual: number; on_duty: number; overloaded: number; no_show: number; created_at: number }>;
  const mae = feedback.length
    ? Math.round((feedback.reduce((sum, f) => sum + Math.abs(f.recommended - f.manager_actual), 0) / feedback.length) * 100) / 100
    : null;
  const bias = feedback.length
    ? Math.round((feedback.reduce((sum, f) => sum + (f.recommended - f.manager_actual), 0) / feedback.length) * 100) / 100
    : null;
  return {
    shadowMode: parseConfig(getStore(db, storeId)).pilot.shadowMode,
    control: { paused: control.dispatch_paused === 1, reason: control.reason, updatedBy: control.updated_by, updatedAt: control.updated_at },
    shadowRuns: shadowRuns.map((r) => ({
      id: r.id,
      planId: r.plan_id,
      forecastId: r.forecast_id,
      totalCost: r.total_cost,
      recommendations: JSON.parse(String(r.recommendations_json)),
      createdAt: r.created_at,
    })),
    feedback: { count: feedback.length, mae, bias, overloaded: feedback.filter((f) => f.overloaded).length, noShow: feedback.reduce((sum, f) => sum + f.no_show, 0) },
  };
}
