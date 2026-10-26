import { z } from 'zod';
import { route, type RequestContext } from '../lib/http.js';
import { AppError } from '../lib/errors.js';
import { rateLimit } from '../lib/rateLimit.js';
import { get } from '../lib/db.js';
import { findStoreByCode, requireRecentAuth } from '../lib/auth.js';
import {
  correctIngestEvent,
  ingestEvent,
  ingestStatus,
  listIngestEvents,
  normalizeEvent,
  rotateWebhookSecret,
  getWebhookSecret,
  verifyWebhookSignature,
} from '../domain/ingest.js';
import { getStore } from '../domain/stores.js';
import { getPosAdapter, listPosAdapters } from '../domain/adapters/pos.js';
import { managerContext } from './helpers.js';
import { id } from '../lib/ids.js';

function rateGuard(ctx: RequestContext, bucket: string, limit: number, windowMs: number) {
  const r = rateLimit(ctx.db, ctx.config.rateLimitBackend, `${bucket}:${ctx.clientIp}`, limit, windowMs);
  if (!r.allowed) throw new AppError(429, 'RATE_LIMITED', '事件接收过于频繁', { retryAfterSec: r.retryAfterSec });
}

function webhookPayloads(body: unknown): unknown[] {
  if (Array.isArray(body)) return body;
  if (body && typeof body === 'object' && Array.isArray((body as { events?: unknown[] }).events)) {
    return (body as { events: unknown[] }).events;
  }
  return [body];
}

export function registerIngestRoutes(): void {
  route('POST', '/api/ingest/webhook/:storeCode', {}, (ctx) => {
    rateGuard(ctx, 'webhook', 120, 60_000);
    const store = findStoreByCode(ctx.db, ctx.params.storeCode);
    if (!store) throw new AppError(404, 'STORE_NOT_FOUND', '门店编码不存在');
    const secret = getWebhookSecret(ctx.db, store.id, ctx.config);
    if (!secret) {
      throw new AppError(503, 'WEBHOOK_NOT_CONFIGURED', '该门店尚未配置 Webhook 密钥');
    }
    const signature = String(ctx.req.headers['x-signature'] ?? '');
    if (!verifyWebhookSignature(secret, ctx.rawBody, signature)) {
      throw new AppError(401, 'SIGNATURE_INVALID', 'Webhook 签名校验失败');
    }
    const now = Date.now();
    const adapter = getPosAdapter(String(ctx.req.headers['x-pos-adapter'] ?? 'generic'));
    const results = webhookPayloads(ctx.body).flatMap((raw) => {
      const events = adapter.parse(raw, { now });
      return events.map((event) => ingestEvent(ctx.db, store.id, 'webhook', event, { signatureValid: true }));
    });
    return { accepted: results.filter((r) => r.status === 'applied').length, results };
  });

  route('GET', '/api/ingest/adapters', {}, () => ({ adapters: listPosAdapters() }));

  route('GET', '/api/manager/ingest/status', { roles: ['manager'] }, (ctx) => {
    const { storeId } = managerContext(ctx);
    return ingestStatus(ctx.db, storeId);
  });

  route('GET', '/api/manager/ingest/events', { roles: ['manager'] }, (ctx) => {
    const { storeId } = managerContext(ctx);
    return listIngestEvents(ctx.db, storeId, ctx.query.get('status') ?? undefined);
  });

  route('POST', '/api/manager/ingest/:id/correct', { roles: ['manager'] }, (ctx) => {
    requireRecentAuth(ctx.auth!, ctx.config);
    const { storeId } = managerContext(ctx);
    const event = normalizeEvent(ctx.body, Date.now());
    return correctIngestEvent(ctx.db, storeId, ctx.params.id, event, ctx.auth!.userId);
  });

  route('GET', '/api/admin/ingest/events', { roles: ['admin'] }, (ctx) => {
    const storeId = ctx.query.get('storeId') ?? get<{ id: string }>(ctx.db, 'SELECT id FROM stores ORDER BY created_at LIMIT 1')?.id;
    if (!storeId) throw new AppError(404, 'NO_STORE', '尚无门店');
    return listIngestEvents(ctx.db, storeId, ctx.query.get('status') ?? undefined);
  });

  route('POST', '/api/admin/ingest/:id/replay', { roles: ['admin'] }, (ctx) => {
    requireRecentAuth(ctx.auth!, ctx.config);
    const row = get<{ id: string; store_id: string; payload_json: string; external_id: string }>(
      ctx.db,
      'SELECT id, store_id, payload_json, external_id FROM event_ingest WHERE id = ?',
      [ctx.params.id],
    );
    if (!row) throw new AppError(404, 'INGEST_NOT_FOUND', '事件不存在');
    const event = normalizeEvent(JSON.parse(row.payload_json), Date.now());
    const outcome = ingestEvent(ctx.db, row.store_id, 'correction', event, {
      signatureValid: true,
      actorId: ctx.auth!.userId,
      correctionOf: row.id,
      externalIdOverride: `replay-${row.external_id}-${id('x')}`,
      throwOnError: true,
    });
    return outcome;
  });

  route('POST', '/api/admin/stores/:id/webhook-secret', { roles: ['admin'] }, (ctx) => {
    requireRecentAuth(ctx.auth!, ctx.config);
    const store = getStore(ctx.db, ctx.params.id);
    return rotateWebhookSecret(ctx.db, store.id, ctx.config);
  });
}
