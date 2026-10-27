import { z } from 'zod';
import { route } from '../lib/http.js';
import { AppError } from '../lib/errors.js';
import { all, get, parseJson, run } from '../lib/db.js';
import { managerContext } from './helpers.js';
import { storeConfigSchema } from '../domain/stores.js';
import { serializeStore } from '../domain/stores.js';
import { finishOnboarding, updateStoreConfig } from '../domain/stores.js';
import { applyOps, confirmBusinessDay, listExceptions, resolveException, tableActionAllowed, todayView, ensureBusinessDay } from '../domain/ops.js';
import { generateForecast, getForecastRow, listForecasts, serializeForecast } from '../domain/forecast.js';
import { confirmPlan, generatePlans, getPlan, listPlans, replacePlanItem } from '../domain/plans.js';
import { listStaff } from '../domain/staff.js';
import { getStore, parseConfig } from '../domain/stores.js';
import { storeNow } from '../domain/clock.js';
import { approveBackfillTask, expireDueOffers, processStaleShifts, shiftApi, managerConfirmShift, managerCancelShift, markNoShow, listDemands } from '../domain/dispatch.js';
import { advanceSimulationAndSummarize, simulationStatus } from '../domain/simulator.js';
import { ingestManualCommand } from '../domain/ingest.js';
import { calibrationMatches } from '../domain/calibration.js';
import { getPilotControl, pausePilot, pilotSummary, recordPilotFeedback, recordPilotUxMetric, resumePilot } from '../domain/pilot.js';
import { decideApplication, listStoreApplications } from '../domain/marketplace.js';
import type { ShiftRow } from '../domain/types.js';

const configSchema = z.object({
  config: storeConfigSchema,
  step: z.number().int().min(0).max(4).optional(),
});

const confirmSchema = z
  .object({
    onDutyStaff: z.number().int().min(0).max(100).optional(),
    queueGroups: z.number().int().min(0).max(200).optional(),
    latestCallNo: z.number().int().min(0).max(9999).optional(),
  })
  .optional();

const opsSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('join_queue'), partySize: z.number().int().min(1).max(30).optional() }),
  z.object({ type: z.literal('abandon_queue'), queueId: z.string().optional() }),
  z.object({ type: z.literal('call_next'), callNo: z.number().int().min(1).max(9999).optional() }),
  z.object({ type: z.literal('seat'), queueId: z.string().min(1), tableId: z.string().optional() }),
  z.object({ type: z.literal('checkout'), tableId: z.string().min(1) }),
  z.object({ type: z.literal('leave'), tableId: z.string().min(1) }),
  z.object({ type: z.literal('clean'), tableId: z.string().min(1) }),
  z.object({ type: z.literal('set_on_duty'), onDutyStaff: z.number().int().min(0).max(100) }),
]);

function assignmentsView(db: Parameters<typeof shiftApi>[0], storeId: string, now: number) {
  const rows = all<ShiftRow>(
    db,
    'SELECT * FROM shifts WHERE store_id = ? AND end_at >= ? ORDER BY start_at ASC LIMIT 300',
    [storeId, now - 12 * 3_600_000],
  );
  const items = rows.map((row) => {
    const offer = row.offer_id
      ? get<{ id: string; status: string; expires_at: number; attempt: number }>(
          db,
          'SELECT id, status, expires_at, attempt FROM job_offers WHERE id = ?',
          [row.offer_id],
        )
      : undefined;
    return {
      ...shiftApi(db, row),
      offer: offer ? { id: offer.id, status: offer.status, expiresAt: offer.expires_at, attempt: offer.attempt } : null,
    };
  });
  const demands = listDemands(db, storeId);
  const groups = {
    pending: items.filter((i) => i.status === 'invited'),
    confirmed: items.filter((i) => i.status === 'confirmed'),
    checkedIn: items.filter((i) => i.status === 'checked_in'),
    completed: items.filter((i) => i.status === 'completed'),
    exceptions: items.filter((i) => i.status === 'no_show' || i.status === 'cancelled'),
  };
  return {
    items,
    demands,
    groups: {
      pending: groups.pending.length,
      confirmed: groups.confirmed.length,
      checkedIn: groups.checkedIn.length,
      completed: groups.completed.length,
      exceptions: groups.exceptions.length,
    },
  };
}

export function registerManagerRoutes(): void {
  route('GET', '/api/manager/store', { roles: ['manager'] }, (ctx) => {
    const { store } = managerContext(ctx);
    return { store: serializeStore(store), config: parseConfig(store) };
  });

  route('PATCH', '/api/manager/store/config', { roles: ['manager'] }, (ctx) => {
    const { storeId } = managerContext(ctx);
    const body = configSchema.parse(ctx.body ?? {});
    if (
      body.config.staffing.calibrationStatus === 'calibrated' &&
      (body.config.staffing.capacityModel !== 'service_minutes' ||
        !calibrationMatches(ctx.db, storeId, body.config.staffing))
    ) {
      throw new AppError(400, 'CALIBRATION_EVIDENCE_REQUIRED', '服务分钟模型标记为已校准前，必须由管理员提交真实样本校准；不能在前端直接改状态');
    }
    const row = updateStoreConfig(ctx.db, storeId, body.config, body.step);
    return { store: serializeStore(row), config: parseConfig(row) };
  });

  route('POST', '/api/manager/onboarding/finish', { roles: ['manager'] }, (ctx) => {
    const { storeId } = managerContext(ctx);
    const row = finishOnboarding(ctx.db, storeId);
    return { store: serializeStore(row) };
  });

  route('GET', '/api/manager/today', { roles: ['manager'] }, (ctx) => {
    const { storeId } = managerContext(ctx);
    expireDueOffers(ctx.db, storeId);
    processStaleShifts(ctx.db, storeId);
    return todayView(ctx.db, storeId);
  });

  route('POST', '/api/manager/today/confirm', { roles: ['manager'] }, (ctx) => {
    const { storeId, auth } = managerContext(ctx);
    const body = confirmSchema.parse(ctx.body ?? {});
    return confirmBusinessDay(ctx.db, storeId, { ...(body ?? {}), actorId: auth.userId });
  });

  route('POST', '/api/manager/ops', { roles: ['manager'] }, (ctx) => {
    const { storeId, auth } = managerContext(ctx);
    const command = opsSchema.parse(ctx.body ?? {});
    if (command.type === 'set_on_duty') {
      return applyOps(ctx.db, storeId, command, { actorId: auth.userId });
    }
    const outcome = ingestManualCommand(ctx.db, storeId, command, auth.userId);
    return { ...(outcome.result as Record<string, unknown>), ingestId: outcome.ingest.ingestId, ingestStatus: outcome.ingest.status };
  });

  route('GET', '/api/manager/forecast/latest', { roles: ['manager'] }, (ctx) => {
    const { storeId } = managerContext(ctx);
    const row = get<Parameters<typeof serializeForecast>[0]>(
      ctx.db,
      'SELECT * FROM forecasts WHERE store_id = ? ORDER BY generated_at DESC LIMIT 1',
      [storeId],
    );
    return row ? serializeForecast(row) : null;
  });

  route('GET', '/api/manager/forecast/history', { roles: ['manager'] }, (ctx) => {
    const { storeId } = managerContext(ctx);
    return listForecasts(ctx.db, storeId, 20);
  });

  route('POST', '/api/manager/forecast', { roles: ['manager'] }, async (ctx) => {
    const { storeId } = managerContext(ctx);
    const body = z.object({ useAi: z.boolean().optional() }).parse(ctx.body ?? {});
    const forecast = await generateForecast(ctx.db, storeId, ctx.config, { useAi: body.useAi ?? true });
    return { forecast };
  });

  route('POST', '/api/manager/plans', { roles: ['manager'] }, (ctx) => {
    const { storeId } = managerContext(ctx);
    const body = z.object({ forecastId: z.string().optional() }).parse(ctx.body ?? {});
    return generatePlans(ctx.db, storeId, body.forecastId);
  });

  route('GET', '/api/manager/plans', { roles: ['manager'] }, (ctx) => {
    const { storeId } = managerContext(ctx);
    return listPlans(ctx.db, storeId);
  });

  route('GET', '/api/manager/plans/:id', { roles: ['manager'] }, (ctx) => {
    const { storeId } = managerContext(ctx);
    return getPlan(ctx.db, storeId, ctx.params.id);
  });

  route('POST', '/api/manager/plans/:id/confirm', { roles: ['manager'] }, (ctx) => {
    const { storeId, auth } = managerContext(ctx);
    return confirmPlan(ctx.db, storeId, ctx.params.id, auth.userId);
  });

  route('POST', '/api/manager/plans/:id/replace', { roles: ['manager'] }, (ctx) => {
    const { storeId } = managerContext(ctx);
    const body = z
      .object({
        staffId: z.string().min(1),
        startAt: z.number().int(),
        replacementStaffId: z.string().min(1),
      })
      .parse(ctx.body ?? {});
    return replacePlanItem(ctx.db, storeId, ctx.params.id, body);
  });

  route('GET', '/api/manager/applications', { roles: ['manager'] }, (ctx) => {
    const { storeId } = managerContext(ctx);
    return { items: listStoreApplications(ctx.db, storeId) };
  });

  route('POST', '/api/manager/applications/:id/approve', { roles: ['manager'] }, (ctx) => {
    const { storeId } = managerContext(ctx);
    const body = z.object({ note: z.string().trim().max(200).optional() }).parse(ctx.body ?? {});
    return decideApplication(ctx.db, storeId, ctx.params.id, 'approved', ctx.auth!.userId, body.note ?? '门店已通过', storeNow(ctx.db, storeId));
  });

  route('POST', '/api/manager/applications/:id/reject', { roles: ['manager'] }, (ctx) => {
    const { storeId } = managerContext(ctx);
    const body = z.object({ note: z.string().trim().max(200).optional() }).parse(ctx.body ?? {});
    return decideApplication(ctx.db, storeId, ctx.params.id, 'rejected', ctx.auth!.userId, body.note ?? '岗位暂不匹配', storeNow(ctx.db, storeId));
  });

  route('GET', '/api/manager/assignments', { roles: ['manager'] }, (ctx) => {
    const { storeId } = managerContext(ctx);
    const now = storeNow(ctx.db, storeId);
    expireDueOffers(ctx.db, storeId, now);
    processStaleShifts(ctx.db, storeId, now);
    return { ...assignmentsView(ctx.db, storeId, now), now };
  });

  route('POST', '/api/manager/assignments/:id/confirm-completion', { roles: ['manager'] }, (ctx) => {
    const { storeId, auth } = managerContext(ctx);
    return shiftApi(ctx.db, managerConfirmShift(ctx.db, ctx.params.id, storeId, auth.userId));
  });

  route('POST', '/api/manager/assignments/:id/cancel', { roles: ['manager'] }, (ctx) => {
    const { storeId, auth } = managerContext(ctx);
    const body = z
      .object({ reason: z.string().max(100).optional(), scope: z.enum(['person', 'demand']).optional() })
      .parse(ctx.body ?? {});
    return shiftApi(
      ctx.db,
      managerCancelShift(
        ctx.db,
        ctx.params.id,
        storeId,
        auth.userId,
        body.reason ?? '店长取消',
        body.scope ?? 'person',
      ),
    );
  });

  route('POST', '/api/manager/assignments/:id/no-show', { roles: ['manager'] }, (ctx) => {
    const { storeId, auth } = managerContext(ctx);
    const body = z.object({ note: z.string().max(100).optional() }).parse(ctx.body ?? {});
    return shiftApi(ctx.db, markNoShow(ctx.db, ctx.params.id, storeId, auth.userId, body.note));
  });

  route('GET', '/api/manager/pilot/summary', { roles: ['manager'] }, (ctx) => {
    const { storeId } = managerContext(ctx);
    return pilotSummary(ctx.db, storeId);
  });

  route('POST', '/api/manager/pilot/pause', { roles: ['manager'] }, (ctx) => {
    const { storeId, auth } = managerContext(ctx);
    const body = z.object({ reason: z.string().trim().min(1).max(200).optional(), cancelPending: z.boolean().optional() }).parse(ctx.body ?? {});
    return pausePilot(ctx.db, storeId, auth.userId, body.reason ?? '店长紧急停止调配', body.cancelPending ?? true);
  });

  route('POST', '/api/manager/pilot/resume', { roles: ['manager'] }, (ctx) => {
    const { storeId, auth } = managerContext(ctx);
    return { control: resumePilot(ctx.db, storeId, auth.userId) };
  });

  route('POST', '/api/manager/pilot/feedback', { roles: ['manager'] }, (ctx) => {
    const { storeId, auth } = managerContext(ctx);
    const body = z
      .object({
        shadowRunId: z.string().optional(),
        recommended: z.number().int().min(0).max(1000),
        managerActual: z.number().int().min(0).max(1000),
        onDuty: z.number().int().min(0).max(1000),
        overloaded: z.boolean(),
        noShow: z.number().int().min(0).max(1000).optional(),
        decision: z.enum(['accepted', 'too_many', 'too_few', 'timing', 'no_candidates', 'other']).optional(),
        reasons: z.array(z.string().trim().min(1).max(200)).max(10).optional(),
        correction: z.string().max(1000).optional(),
        notes: z.string().max(1000).optional(),
      })
      .parse(ctx.body ?? {});
    return recordPilotFeedback(ctx.db, storeId, auth.userId, body);
  });

  route('POST', '/api/manager/pilot/ux-metric', { roles: ['manager'] }, (ctx) => {
    const { storeId, auth } = managerContext(ctx);
    const body = z
      .object({
        flow: z.string().trim().min(1).max(80),
        actionCount: z.number().int().min(0).max(100),
        elapsedMs: z.number().int().min(0).max(86_400_000),
        planId: z.string().optional(),
        shadow: z.boolean().optional(),
      })
      .parse(ctx.body ?? {});
    return { id: recordPilotUxMetric(ctx.db, storeId, auth.userId, body) };
  });

  route('POST', '/api/manager/backfill/:id/approve', { roles: ['manager'] }, (ctx) => {
    const { storeId, auth } = managerContext(ctx);
    return approveBackfillTask(ctx.db, ctx.params.id, storeId, auth.userId);
  });

  route('GET', '/api/manager/exceptions', { roles: ['manager'] }, (ctx) => {
    const { storeId } = managerContext(ctx);
    return listExceptions(ctx.db, storeId);
  });

  route('POST', '/api/manager/exceptions/:id/resolve', { roles: ['manager'] }, (ctx) => {
    const { storeId, auth } = managerContext(ctx);
    return resolveException(ctx.db, storeId, ctx.params.id, auth.userId, storeNow(ctx.db, storeId));
  });

  route('GET', '/api/manager/notifications', { roles: ['manager'] }, (ctx) => {
    const { storeId, auth } = managerContext(ctx);
    const rows = all<{
      id: string;
      type: string;
      title: string;
      body: string;
      read: number;
      related_json: string;
      created_at: number;
    }>(ctx.db, 'SELECT * FROM notifications WHERE user_id = ? AND (store_id = ? OR store_id IS NULL) ORDER BY created_at DESC LIMIT 50', [
      auth.userId,
      storeId,
    ]);
    return rows.map((r) => ({
      id: r.id,
      type: r.type,
      title: r.title,
      body: r.body,
      read: Boolean(r.read),
      related: parseJson(r.related_json, {}),
      createdAt: r.created_at,
    }));
  });

  route('POST', '/api/manager/notifications/read', { roles: ['manager'] }, (ctx) => {
    const { storeId, auth } = managerContext(ctx);
    const body = z.object({ ids: z.array(z.string()).optional() }).parse(ctx.body ?? {});
    if (body.ids?.length) {
      for (const notificationId of body.ids) {
        run(ctx.db, 'UPDATE notifications SET read = 1 WHERE id = ? AND user_id = ?', [notificationId, auth.userId]);
      }
    } else {
      run(ctx.db, 'UPDATE notifications SET read = 1 WHERE user_id = ? AND (store_id = ? OR store_id IS NULL)', [
        auth.userId,
        storeId,
      ]);
    }
    return { ok: true };
  });

  route('GET', '/api/manager/staff', { roles: ['manager'] }, (ctx) => {
    const { storeId } = managerContext(ctx);
    return listStaff(ctx.db, storeId);
  });

  route('GET', '/api/manager/sim/status', { roles: ['manager'] }, (ctx) => {
    const { storeId, store } = managerContext(ctx);
    if (parseConfig(store).dataSource !== 'simulator') throw new AppError(409, 'SIM_DISABLED', '该门店未启用模拟器');
    return simulationStatus(ctx.db, storeId);
  });

  route('POST', '/api/manager/sim/advance', { roles: ['manager'] }, async (ctx) => {
    const { storeId, store } = managerContext(ctx);
    if (parseConfig(store).dataSource !== 'simulator') throw new AppError(409, 'SIM_DISABLED', '该门店未启用模拟器');
    const body = z.object({ minutes: z.number().int().min(1).max(240) }).parse(ctx.body ?? {});
    const summary = await advanceSimulationAndSummarize(ctx.db, storeId, body.minutes, ctx.config);
    return { summary, status: simulationStatus(ctx.db, storeId), today: todayView(ctx.db, storeId) };
  });

  route('GET', '/api/manager/table-actions/:tableId', { roles: ['manager'] }, (ctx) => {
    const { storeId } = managerContext(ctx);
    const table = get<{ status: string }>(ctx.db, 'SELECT status FROM store_tables WHERE id = ? AND store_id = ?', [
      ctx.params.tableId,
      storeId,
    ]);
    if (!table) throw new AppError(404, 'TABLE_NOT_FOUND', '桌位不存在');
    void ensureBusinessDay;
    void getStore;
    return { allowed: tableActionAllowed(table.status as never) };
  });
}
