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
import { getImport, importDataset, listImports } from '../domain/dataImport.js';
import { listReplayRuns, runReplay } from '../domain/replay.js';
import { recordPilotFeedback } from '../domain/pilot.js';
import { assertPilotAuthorized, createPilot, getPilot, listPilots, updatePilot } from '../domain/pilots.js';
import { importPilotEvents, importPilotWorkload, pilotDataQuality, workloadAnalysis } from '../domain/pilotData.js';
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

  route('POST', '/api/admin/stores/:id/pilots', { roles: ['admin'] }, (ctx) => {
    const store = getStore(ctx.db, ctx.params.id);
    const body = z.object({
      anonymousCode: z.string().trim().min(2).max(40),
      serviceMode: z.enum(['full', 'partial', 'self']),
      hoursStart: z.string().regex(/^\d{2}:\d{2}$/),
      hoursEnd: z.string().regex(/^\d{2}:\d{2}$/),
      tableConfig: z.unknown().optional(),
      staffing: z.unknown().optional(),
      roles: z.array(z.string()).optional(),
      dataSources: z.array(z.string()).optional(),
      coverageStart: z.string().optional(),
      coverageEnd: z.string().optional(),
      owner: z.string().max(80).optional(),
      startDate: z.string().optional(),
      endDate: z.string().optional(),
    }).parse(ctx.body ?? {});
    return createPilot(ctx.db, store.id, body, ctx.auth!.userId);
  });

  route('GET', '/api/admin/stores/:id/pilots', { roles: ['admin'] }, (ctx) => {
    const store = getStore(ctx.db, ctx.params.id);
    return { pilots: listPilots(ctx.db, store.id) };
  });

  route('GET', '/api/admin/pilots/:id', { roles: ['admin'] }, (ctx) => getPilot(ctx.db, ctx.params.id));

  route('PATCH', '/api/admin/pilots/:id', { roles: ['admin'] }, (ctx) => {
    const body = z.object({
      owner: z.string().max(80).optional(),
      coverageStart: z.string().optional(),
      coverageEnd: z.string().optional(),
      startDate: z.string().optional(),
      endDate: z.string().optional(),
      authorizationStatus: z.enum(['pending', 'authorized', 'revoked']).optional(),
      dataSources: z.array(z.string()).optional(),
      roles: z.array(z.string()).optional(),
    }).parse(ctx.body ?? {});
    return updatePilot(ctx.db, ctx.params.id, body, ctx.auth!.userId);
  });

  route('POST', '/api/admin/pilots/:id/authorize', { roles: ['admin'] }, (ctx) => {
    requireRecentAuth(ctx.auth!, ctx.config);
    const body = z.object({ owner: z.string().max(80).optional(), coverageStart: z.string().optional(), coverageEnd: z.string().optional() }).parse(ctx.body ?? {});
    return updatePilot(ctx.db, ctx.params.id, { ...body, authorizationStatus: 'authorized' }, ctx.auth!.userId);
  });

  route('POST', '/api/admin/pilots/:id/events/import', { roles: ['admin'] }, (ctx) => {
    requireRecentAuth(ctx.auth!, ctx.config);
    const pilot = assertPilotAuthorized(ctx.db, ctx.params.id);
    const body = z.object({
      filename: z.string().min(1).max(200), format: z.enum(['csv', 'xlsx']),
      content: z.string().optional(), contentBase64: z.string().optional(),
      dataOrigin: z.enum(['REAL', 'SIMULATED']),
    }).parse(ctx.body ?? {});
    if (!body.content && !body.contentBase64) throw new AppError(400, 'IMPORT_CONTENT_REQUIRED', '缺少文件内容');
    const content = body.contentBase64 ? Buffer.from(body.contentBase64, 'base64') : body.content!;
    return importPilotEvents(ctx.db, pilot.id, { ...body, content, actorId: ctx.auth!.userId });
  });

  route('POST', '/api/admin/pilots/:id/workload/import', { roles: ['admin'] }, (ctx) => {
    requireRecentAuth(ctx.auth!, ctx.config);
    const pilot = assertPilotAuthorized(ctx.db, ctx.params.id);
    const body = z.object({
      filename: z.string().min(1).max(200), format: z.enum(['csv', 'xlsx']),
      content: z.string().optional(), contentBase64: z.string().optional(),
      dataOrigin: z.enum(['REAL', 'SIMULATED']),
    }).parse(ctx.body ?? {});
    if (!body.content && !body.contentBase64) throw new AppError(400, 'IMPORT_CONTENT_REQUIRED', '缺少文件内容');
    const content = body.contentBase64 ? Buffer.from(body.contentBase64, 'base64') : body.content!;
    return importPilotWorkload(ctx.db, pilot.id, { ...body, content, actorId: ctx.auth!.userId });
  });

  route('GET', '/api/admin/pilots/:id/data-quality', { roles: ['admin'] }, (ctx) => pilotDataQuality(ctx.db, ctx.params.id));
  route('GET', '/api/admin/pilots/:id/workload-analysis', { roles: ['admin'] }, (ctx) => workloadAnalysis(ctx.db, ctx.params.id));

  route('POST', '/api/admin/pilots/:id/replay', { roles: ['admin'] }, (ctx) => {
    requireRecentAuth(ctx.auth!, ctx.config);
    const pilot = assertPilotAuthorized(ctx.db, ctx.params.id);
    const body = z.object({ importId: z.string().optional() }).parse(ctx.body ?? {});
    const importId = body.importId
      ?? get<{ id: string }>(ctx.db, "SELECT id FROM data_imports WHERE pilot_id = ? AND dataset_type = 'events_sessions' ORDER BY created_at DESC LIMIT 1", [pilot.id])?.id;
    if (!importId) throw new AppError(409, 'NO_PILOT_SESSIONS', '没有可用的事件会话；请先导入事件数据');
    return runReplay(ctx.db, pilot.storeId, importId, ctx.auth!.userId);
  });

  route('GET', '/api/admin/pilots/:id/replays', { roles: ['admin'] }, (ctx) => {
    const pilot = getPilot(ctx.db, ctx.params.id);
    return { runs: listReplayRuns(ctx.db, pilot.storeId) };
  });

  route('GET', '/api/admin/pilots/:id/daily-report', { roles: ['admin'] }, (ctx) => {
    const pilot = getPilot(ctx.db, ctx.params.id);
    const date = ctx.query.get('date') ?? new Date().toISOString().slice(0, 10);
    const observations = all<{ on_duty_staff: number | null; manager_sufficiency: string | null; data_origin: string }>(
      ctx.db,
      "SELECT on_duty_staff, manager_sufficiency, data_origin FROM import_observations WHERE pilot_id = ? AND business_date = ? AND quality_status = 'valid'",
      [pilot.id, date],
    );
    const feedback = all<{ decision: string | null; reasons_json: string | null; notes: string | null; manager_actual: number; recommended: number }>(
      ctx.db,
      "SELECT decision, reasons_json, notes, manager_actual, recommended FROM pilot_feedback WHERE store_id = ? AND date(created_at / 1000, 'unixepoch') = ?",
      [pilot.storeId, date],
    );
    const actualOnDuty = observations.length ? Math.max(...observations.map((o) => o.on_duty_staff ?? 0)) : null;
    const shadowRows = all<{ recommendations_json: string }>(ctx.db, 'SELECT recommendations_json FROM shadow_runs WHERE store_id = ? ORDER BY created_at DESC LIMIT 30', [pilot.storeId]);
    const aiRecommendations = shadowRows
      .flatMap((r) => JSON.parse(r.recommendations_json) as Array<{ startAt: number; endAt: number; nickname: string; hourlyRate: number }>)
      .filter((r) => new Date(r.startAt + 8 * 3_600_000).toISOString().slice(0, 10) === date)
      .map((r) => ({ startAt: r.startAt, endAt: r.endAt, nickname: r.nickname, hourlyRate: r.hourlyRate }));
    const pressures = [...new Set(observations.map((o) => o.manager_sufficiency).filter(Boolean))];
    return {
      pilotId: pilot.id,
      date,
      dataOrigin: observations.length ? observations[0].data_origin : null,
      status: observations.length ? (observations[0].data_origin === 'REAL' ? 'REAL_DATA' : 'SIMULATED_ONLY') : 'REAL_DATA_PENDING',
      actualOnDuty,
      aiRecommendations,
      aiRecommendationCount: aiRecommendations.length,
      servicePressure: pressures,
      feedback,
      overstaffPossible: feedback.some((f) => f.decision === 'too_many') || (actualOnDuty !== null && actualOnDuty > 0 && feedback.some((f) => f.recommended > f.manager_actual)),
      note: 'Daily report is generated from imported observations and recorded manager feedback; no live staff invitation.',
    };
  });

  route('POST', '/api/admin/stores/:id/data/import', { roles: ['admin'] }, (ctx) => {
    requireRecentAuth(ctx.auth!, ctx.config);
    const store = getStore(ctx.db, ctx.params.id);
    const body = z
      .object({
        filename: z.string().trim().min(1).max(200),
        format: z.enum(['csv', 'xlsx']),
        content: z.string().optional(),
        contentBase64: z.string().optional(),
        dataOrigin: z.enum(['REAL', 'SIMULATED']),
      })
      .parse(ctx.body ?? {});
    if (!body.content && !body.contentBase64) throw new AppError(400, 'IMPORT_CONTENT_REQUIRED', '缺少文件内容');
    const content = body.contentBase64 ? Buffer.from(body.contentBase64, 'base64') : body.content!;
    return importDataset(ctx.db, store.id, {
      filename: body.filename,
      format: body.format,
      content,
      dataOrigin: body.dataOrigin,
      actorId: ctx.auth!.userId,
    });
  });

  route('GET', '/api/admin/stores/:id/data/imports', { roles: ['admin'] }, (ctx) => {
    const store = getStore(ctx.db, ctx.params.id);
    return { imports: listImports(ctx.db, store.id) };
  });

  route('POST', '/api/admin/stores/:id/pilot/feedback', { roles: ['admin'] }, (ctx) => {
    const store = getStore(ctx.db, ctx.params.id);
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
    return recordPilotFeedback(ctx.db, store.id, ctx.auth!.userId, body);
  });

  route('GET', '/api/admin/data/imports/:id/quality', { roles: ['admin'] }, (ctx) => {
    const row = get<{ store_id: string }>(ctx.db, 'SELECT store_id FROM data_imports WHERE id = ?', [ctx.params.id]);
    if (!row) throw new AppError(404, 'IMPORT_NOT_FOUND', '导入批次不存在');
    return getImport(ctx.db, row.store_id, ctx.params.id);
  });

  route('POST', '/api/admin/stores/:id/data/replay', { roles: ['admin'] }, (ctx) => {
    requireRecentAuth(ctx.auth!, ctx.config);
    const store = getStore(ctx.db, ctx.params.id);
    const body = z.object({ importId: z.string().trim().min(1) }).parse(ctx.body ?? {});
    return runReplay(ctx.db, store.id, body.importId, ctx.auth!.userId);
  });

  route('GET', '/api/admin/stores/:id/data/replays', { roles: ['admin'] }, (ctx) => {
    const store = getStore(ctx.db, ctx.params.id);
    return { runs: listReplayRuns(ctx.db, store.id, ctx.query.get('importId') ?? undefined) };
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
