import { z } from 'zod';
import { route } from '../lib/http.js';
import { AppError } from '../lib/errors.js';
import { all, get, run } from '../lib/db.js';
import { id } from '../lib/ids.js';
import { adminStoreQuery } from './helpers.js';
import { getStore, serializeStore } from '../domain/stores.js';
import { createStaff, getStaff, listStaff, reviewStaff, serializeStaff } from '../domain/staff.js';
import { listPlans } from '../domain/plans.js';
import { listForecasts, serializeForecast } from '../domain/forecast.js';
import { aiBudgetStatus, listAiUsage } from '../domain/aiUsage.js';
import { ingestStatus } from '../domain/ingest.js';
import { listServiceCalibrations, recordServiceCalibration } from '../domain/calibration.js';
import { analyzeCalibrationSamples, type CalibrationSample } from '../domain/calibrationAnalysis.js';
import { listExceptions, resolveException, todayView } from '../domain/ops.js';
import { shiftApi } from '../domain/dispatch.js';
import { advanceSimulationAndSummarize, setSimRunning, simulationStatus } from '../domain/simulator.js';
import { requireRecentAuth, revokeAllSessions } from '../lib/auth.js';
import { issueManagerClaim } from '../lib/managerClaim.js';
import { audit } from '../domain/notify.js';
import { storeNow } from '../domain/clock.js';
import type { ShiftRow, StaffProfileRow } from '../domain/types.js';

function requireStore(db: Parameters<typeof getStore>[0], storeId?: string) {
  if (!storeId) {
    const first = get<{ id: string }>(db, 'SELECT id FROM stores ORDER BY created_at LIMIT 1');
    if (!first) throw new AppError(404, 'NO_STORE', '尚无门店数据');
    return getStore(db, first.id);
  }
  return getStore(db, storeId);
}

export function registerAdminRoutes(): void {
  route('GET', '/api/admin/overview', { roles: ['admin'] }, (ctx) => {
    const store = requireStore(ctx.db, adminStoreQuery(ctx));
    const storeId = store.id;
    const now = storeNow(ctx.db, storeId);
    const counts = {
      staff: get<{ n: number }>(ctx.db, 'SELECT COUNT(*) as n FROM staff_profiles WHERE store_id = ?', [storeId])!.n,
      pendingStaff: get<{ n: number }>(
        ctx.db,
        "SELECT COUNT(*) as n FROM staff_profiles WHERE store_id = ? AND status = 'pending'",
        [storeId],
      )!.n,
      shifts: get<{ n: number }>(ctx.db, 'SELECT COUNT(*) as n FROM shifts WHERE store_id = ?', [storeId])!.n,
      openExceptions: get<{ n: number }>(
        ctx.db,
        "SELECT COUNT(*) as n FROM exceptions WHERE store_id = ? AND status = 'open'",
        [storeId],
      )!.n,
      pendingOffers: get<{ n: number }>(
        ctx.db,
        "SELECT COUNT(*) as n FROM job_offers WHERE store_id = ? AND status = 'pending'",
        [storeId],
      )!.n,
    };
    const stores = all<{ id: string; name: string; manager_code: string; config_json: string }>(
      ctx.db,
      'SELECT id, name, manager_code, config_json FROM stores ORDER BY created_at',
    ).map((s) => {
      const parsed = JSON.parse(s.config_json) as { dataSource?: string };
      return { id: s.id, name: s.name, managerCode: s.manager_code, dataSource: parsed.dataSource ?? 'manual' };
    });
    const shifts = all<ShiftRow>(
      ctx.db,
      'SELECT * FROM shifts WHERE store_id = ? ORDER BY created_at DESC LIMIT 30',
      [storeId],
    );
    const latestForecast = get<Parameters<typeof serializeForecast>[0]>(
      ctx.db,
      'SELECT * FROM forecasts WHERE store_id = ? ORDER BY generated_at DESC LIMIT 1',
      [storeId],
    );
    const logs = all<{
      id: string;
      action: string;
      actor_role: string | null;
      entity: string | null;
      entity_id: string | null;
      created_at: number;
    }>(ctx.db, 'SELECT id, action, actor_role, entity, entity_id, created_at FROM audit_logs WHERE store_id = ? ORDER BY created_at DESC LIMIT 20', [storeId]);
    return {
      store: serializeStore(store),
      today: todayView(ctx.db, storeId),
      sim: simulationStatus(ctx.db, storeId),
      counts,
      stores,
      openExceptions: listExceptions(ctx.db, storeId).filter((e) => e.status === 'open'),
      recentShifts: shifts.map((s) => shiftApi(ctx.db, s)),
      forecast: latestForecast ? serializeForecast(latestForecast) : null,
      logs: logs.map((l) => ({
        id: l.id,
        action: l.action,
        actorRole: l.actor_role,
        entity: l.entity,
        entityId: l.entity_id,
        createdAt: l.created_at,
      })),
      system: {
        aiConfigured: Boolean(ctx.config.deepseek.apiKey),
        model: ctx.config.deepseek.model,
        env: ctx.config.nodeEnv,
        aiBudget: aiBudgetStatus(ctx.db, storeId, ctx.config),
        aiUsage: listAiUsage(ctx.db, storeId, 10),
      },
      now,
    };
  });

  route('GET', '/api/admin/ingest/status', { roles: ['admin'] }, (ctx) => {
    const store = requireStore(ctx.db, adminStoreQuery(ctx));
    return ingestStatus(ctx.db, store.id);
  });

  route('GET', '/api/admin/stores/:id/service-calibrations', { roles: ['admin'] }, (ctx) => {
    const store = getStore(ctx.db, ctx.params.id);
    return { storeId: store.id, calibrations: listServiceCalibrations(ctx.db, store.id) };
  });

  route('POST', '/api/admin/stores/:id/service-calibration/analyze', { roles: ['admin'] }, (ctx) => {
    requireRecentAuth(ctx.auth!, ctx.config);
    const store = getStore(ctx.db, ctx.params.id);
    const body = z.object({ samples: z.array(z.any()).min(1).max(10000) }).parse(ctx.body ?? {});
    const analysis = analyzeCalibrationSamples(body.samples as CalibrationSample[]);
    return { storeId: store.id, analysis };
  });

  route('POST', '/api/admin/stores/:id/service-calibration', { roles: ['admin'] }, (ctx) => {
    requireRecentAuth(ctx.auth!, ctx.config);
    const store = getStore(ctx.db, ctx.params.id);
    const body = z
      .object({
        sampleSize: z.number().int().min(30).max(100000),
        evidenceNote: z.string().trim().min(10).max(1000),
        serviceMode: z.enum(['full', 'partial', 'self']).optional(),
        serviceMinutes: z
          .object({ small: z.number().min(1).max(120), medium: z.number().min(1).max(120), large: z.number().min(1).max(120) })
          .optional(),
        effectiveServiceMinutesPerSlot: z.number().min(5).max(30).optional(),
      })
      .parse(ctx.body ?? {});
    return recordServiceCalibration(ctx.db, store.id, body, ctx.auth!.userId);
  });

  route('POST', '/api/admin/users/:id/revoke-sessions', { roles: ['admin'] }, (ctx) => {
    requireRecentAuth(ctx.auth!, ctx.config);
    const user = get<{ id: string; role: string }>(ctx.db, 'SELECT id, role FROM users WHERE id = ?', [ctx.params.id]);
    if (!user) throw new AppError(404, 'USER_NOT_FOUND', '用户不存在');
    const count = revokeAllSessions(ctx.db, user.id);
    audit(ctx.db, {
      storeId: null,
      actorId: ctx.auth!.userId,
      actorRole: 'admin',
      action: 'admin.revoke_sessions',
      entity: 'user',
      entityId: user.id,
      detail: { revoked: count },
      at: Date.now(),
    });
    return { revoked: count };
  });

  route('GET', '/api/admin/ai-usage', { roles: ['admin'] }, (ctx) => {
    const store = requireStore(ctx.db, adminStoreQuery(ctx));
    return {
      storeId: store.id,
      budget: aiBudgetStatus(ctx.db, store.id, ctx.config),
      usage: listAiUsage(ctx.db, store.id, 100),
      model: ctx.config.deepseek.model,
      prices: {
        inputPerMTok: ctx.config.deepseek.inputPricePerMTok,
        outputPerMTok: ctx.config.deepseek.outputPricePerMTok,
      },
    };
  });

  route('GET', '/api/admin/stores', { roles: ['admin'] }, (ctx) => {
    return all<{ id: string; name: string; manager_code: string }>(
      ctx.db,
      'SELECT id, name, manager_code FROM stores ORDER BY created_at',
    );
  });

  route('GET', '/api/admin/staff', { roles: ['admin'] }, (ctx) => {
    const store = requireStore(ctx.db, adminStoreQuery(ctx));
    const rows = listStaff(ctx.db, store.id);
    return { storeId: store.id, items: rows, pending: rows.filter((s) => s.status === 'pending').length };
  });

  route('POST', '/api/admin/staff/:id/review', { roles: ['admin'] }, (ctx) => {
    requireRecentAuth(ctx.auth!, ctx.config);
    const body = z
      .object({
        status: z.enum(['approved', 'rejected', 'suspended', 'pending']).optional(),
        qualified: z.boolean().optional(),
      })
      .parse(ctx.body ?? {});
    const staff = getStaff(ctx.db, ctx.params.id);
    const updated = reviewStaff(ctx.db, staff.store_id, staff.id, body, ctx.auth!.userId);
    return { staff: serializeStaff(ctx.db, updated) };
  });

  route('GET', '/api/admin/shifts', { roles: ['admin'] }, (ctx) => {
    const store = requireStore(ctx.db, adminStoreQuery(ctx));
    const status = ctx.query.get('status');
    const rows = status
      ? all<ShiftRow>(ctx.db, 'SELECT * FROM shifts WHERE store_id = ? AND status = ? ORDER BY start_at DESC LIMIT 100', [store.id, status])
      : all<ShiftRow>(ctx.db, 'SELECT * FROM shifts WHERE store_id = ? ORDER BY start_at DESC LIMIT 100', [store.id]);
    return rows.map((row) => {
      const offer = row.offer_id
        ? get<{ status: string; expires_at: number; attempt: number }>(
            ctx.db,
            'SELECT status, expires_at, attempt FROM job_offers WHERE id = ?',
            [row.offer_id],
          )
        : null;
      return { ...shiftApi(ctx.db, row), offer };
    });
  });

  route('GET', '/api/admin/plans', { roles: ['admin'] }, (ctx) => {
    const store = requireStore(ctx.db, adminStoreQuery(ctx));
    return listPlans(ctx.db, store.id);
  });

  route('GET', '/api/admin/forecasts', { roles: ['admin'] }, (ctx) => {
    const store = requireStore(ctx.db, adminStoreQuery(ctx));
    return listForecasts(ctx.db, store.id, 20);
  });

  route('GET', '/api/admin/exceptions', { roles: ['admin'] }, (ctx) => {
    const store = requireStore(ctx.db, adminStoreQuery(ctx));
    return listExceptions(ctx.db, store.id);
  });

  route('POST', '/api/admin/exceptions/:id/resolve', { roles: ['admin'] }, (ctx) => {
    requireRecentAuth(ctx.auth!, ctx.config);
    const row = get<{ id: string; store_id: string }>(ctx.db, 'SELECT id, store_id FROM exceptions WHERE id = ?', [
      ctx.params.id,
    ]);
    if (!row) throw new AppError(404, 'EXCEPTION_NOT_FOUND', '异常记录不存在');
    return resolveException(ctx.db, row.store_id, row.id, ctx.auth!.userId, Date.now());
  });

  route('GET', '/api/admin/logs', { roles: ['admin'] }, (ctx) => {
    const limit = Math.min(200, Number(ctx.query.get('limit') ?? 50));
    return all<{
      id: string;
      store_id: string | null;
      actor_role: string | null;
      action: string;
      entity: string | null;
      entity_id: string | null;
      detail_json: string;
      created_at: number;
    }>(ctx.db, 'SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT ?', [limit]).map((l) => ({
      id: l.id,
      storeId: l.store_id,
      actorRole: l.actor_role,
      action: l.action,
      entity: l.entity,
      entityId: l.entity_id,
      detail: JSON.parse(l.detail_json) as Record<string, unknown>,
      createdAt: l.created_at,
    }));
  });

  route('POST', '/api/admin/staff-create', { roles: ['admin'] }, (ctx) => {
    requireRecentAuth(ctx.auth!, ctx.config);
    const store = requireStore(ctx.db, adminStoreQuery(ctx));
    const body = z
      .object({
        name: z.string().min(1).max(30),
        phone: z.string().min(5).max(20),
        distanceKm: z.number().min(0).max(50).default(2),
        rate: z.number().min(10).max(200).default(32),
      })
      .parse(ctx.body ?? {});
    const existing = get<{ id: string }>(ctx.db, 'SELECT id FROM users WHERE phone = ?', [body.phone]);
    if (existing) throw new AppError(409, 'PHONE_TAKEN', '手机号已存在');
    const userId = id('usr');
    run(
      ctx.db,
      'INSERT INTO users(id, role, name, phone, password_hash, store_id, created_at) VALUES(?,?,?,?,?,?,?)',
      [userId, 'staff', body.name, body.phone, null, store.id, Date.now()],
    );
    const profile = createStaff(ctx.db, {
      userId,
      storeId: store.id,
      nickname: body.name,
      phone: body.phone,
      distanceKm: body.distanceKm,
      expectedRate: body.rate,
      status: 'pending',
    });
    return { staff: serializeStaff(ctx.db, profile) };
  });

  route('GET', '/api/admin/sim/status', { roles: ['admin'] }, (ctx) => {
    const store = requireStore(ctx.db, adminStoreQuery(ctx));
    return simulationStatus(ctx.db, store.id);
  });

  route('POST', '/api/admin/sim/control', { roles: ['admin'] }, (ctx) => {
    requireRecentAuth(ctx.auth!, ctx.config);
    const body = z
      .object({
        storeId: z.string().optional(),
        running: z.boolean().optional(),
        speed: z.number().int().min(1).max(600).optional(),
      })
      .parse(ctx.body ?? {});
    const store = requireStore(ctx.db, body.storeId ?? adminStoreQuery(ctx));
    setSimRunning(ctx.db, store.id, body.running ?? false, body.speed);
    return simulationStatus(ctx.db, store.id);
  });

  route('POST', '/api/admin/sim/advance', { roles: ['admin'] }, async (ctx) => {
    requireRecentAuth(ctx.auth!, ctx.config);
    const body = z
      .object({
        storeId: z.string().optional(),
        minutes: z.number().int().min(1).max(240),
      })
      .parse(ctx.body ?? {});
    const store = requireStore(ctx.db, body.storeId ?? adminStoreQuery(ctx));
    const summary = await advanceSimulationAndSummarize(ctx.db, store.id, body.minutes, ctx.config);
    return {
      summary,
      status: simulationStatus(ctx.db, store.id),
      today: todayView(ctx.db, store.id),
    };
  });

  route('POST', '/api/admin/staff/:id/verify-phone', { roles: ['admin'] }, (ctx) => {
    requireRecentAuth(ctx.auth!, ctx.config);
    const staff = getStaff(ctx.db, ctx.params.id);
    run(ctx.db, 'UPDATE users SET phone_verified = 1 WHERE id = ?', [staff.user_id]);
    audit(ctx.db, {
      storeId: staff.store_id,
      actorId: ctx.auth!.userId,
      actorRole: 'admin',
      action: 'admin.verify_phone',
      entity: 'staff',
      entityId: staff.id,
      at: Date.now(),
    });
    return { staff: serializeStaff(ctx.db, staff) };
  });

  route('POST', '/api/admin/stores/:id/claim-code', { roles: ['admin'] }, (ctx) => {
    requireRecentAuth(ctx.auth!, ctx.config);
    const store = getStore(ctx.db, ctx.params.id);
    const claim = issueManagerClaim(ctx.db, store.id, 24);
    audit(ctx.db, {
      storeId: store.id,
      actorId: ctx.auth!.userId,
      actorRole: 'admin',
      action: 'admin.issue_manager_claim',
      entity: 'store',
      entityId: store.id,
      at: Date.now(),
    });
    return claim;
  });

  route('GET', '/api/admin/notifications', { roles: ['admin'] }, (ctx) => {
    return all<{ id: string; type: string; title: string; body: string; created_at: number }>(
      ctx.db,
      'SELECT id, type, title, body, created_at FROM notifications ORDER BY created_at DESC LIMIT 50',
    );
  });
}
