import { z } from 'zod';
import { route } from '../lib/http.js';
import { all, get, parseJson, run } from '../lib/db.js';
import { staffContext } from './helpers.js';
import { getStore, serializeStore } from '../domain/stores.js';
import { profileSchema, setAvailability, serializeStaff, staffWindows, updateStaffProfile, availabilitySchema } from '../domain/staff.js';
import { acceptOffer, checkIn, checkOut, rejectOffer, shiftApi, staffCancelShift } from '../domain/dispatch.js';
import { applyToDemand, listMyApplications, listOpenOpportunities, withdrawApplication } from '../domain/marketplace.js';
import { storeNow } from '../domain/clock.js';
import type { OfferRow, ShiftRow } from '../domain/types.js';

function shiftRowsForStaff(db: Parameters<typeof staffContext>[0]['db'], staffId: string) {
  return all<ShiftRow>(db, 'SELECT * FROM shifts WHERE staff_id = ? ORDER BY start_at DESC LIMIT 100', [staffId]);
}

function offerView(db: Parameters<typeof staffContext>[0]['db'], offer: OfferRow) {
  const shift = get<ShiftRow>(db, 'SELECT * FROM shifts WHERE id = ?', [offer.shift_id]);
  if (!shift) return null;
  const store = getStore(db, offer.store_id);
  const shiftData = shiftApi(db, shift);
  return {
    id: offer.id,
    status: offer.status,
    expiresAt: offer.expires_at,
    attempt: offer.attempt,
    createdAt: offer.created_at,
    store: {
      id: store.id,
      name: store.name,
      address: store.address,
      managerCode: store.manager_code,
      lat: store.lat,
      lng: store.lng,
    },
    shift: shiftData,
    payEstimate: Math.round((Math.max(0.5, (shift.end_at - shift.start_at) / 3_600_000) * shift.hourly_rate) * 100) / 100,
  };
}

export function registerStaffRoutes(): void {
  route('GET', '/api/staff/me', { roles: ['staff'] }, (ctx) => {
    const { staff } = staffContext(ctx);
    const store = getStore(ctx.db, staff.store_id);
    const now = storeNow(ctx.db, staff.store_id);
    const pendingOffers = all<OfferRow>(
      ctx.db,
      "SELECT * FROM job_offers WHERE staff_id = ? AND status = 'pending' AND expires_at >= ?",
      [staff.id, now],
    );
    const upcoming = all<ShiftRow>(
      ctx.db,
      "SELECT * FROM shifts WHERE staff_id = ? AND status IN ('confirmed','checked_in') AND end_at >= ? ORDER BY start_at",
      [staff.id, now],
    );
    return {
      staff: serializeStaff(ctx.db, staff),
      store: serializeStore(store),
      windows: staffWindows(ctx.db, staff.id),
      pendingOffers: pendingOffers.length,
      upcomingShifts: upcoming.length,
      now,
    };
  });

  route('PATCH', '/api/staff/me', { roles: ['staff'] }, (ctx) => {
    const { staff } = staffContext(ctx);
    const body = profileSchema.parse(ctx.body ?? {});
    const updated = updateStaffProfile(ctx.db, staff.id, body);
    return { staff: serializeStaff(ctx.db, updated) };
  });

  route('PUT', '/api/staff/me/availability', { roles: ['staff'] }, (ctx) => {
    const { staff } = staffContext(ctx);
    const windows = availabilitySchema.parse((ctx.body as { windows?: unknown })?.windows ?? []);
    return { availability: setAvailability(ctx.db, staff.id, windows) };
  });

  route('GET', '/api/staff/opportunities', { roles: ['staff'] }, (ctx) => {
    const { staff } = staffContext(ctx);
    const now = storeNow(ctx.db, staff.store_id);
    return { items: listOpenOpportunities(ctx.db, staff.id, now), now };
  });

  route('POST', '/api/staff/opportunities/:id/apply', { roles: ['staff'] }, (ctx) => {
    const { staff } = staffContext(ctx);
    const body = z.object({ note: z.string().trim().max(200).optional() }).parse(ctx.body ?? {});
    const now = storeNow(ctx.db, staff.store_id);
    return { application: applyToDemand(ctx.db, staff.id, ctx.params.id, body.note ?? '', now) };
  });

  route('GET', '/api/staff/applications', { roles: ['staff'] }, (ctx) => {
    const { staff } = staffContext(ctx);
    return { items: listMyApplications(ctx.db, staff.id) };
  });

  route('POST', '/api/staff/applications/:id/withdraw', { roles: ['staff'] }, (ctx) => {
    const { staff } = staffContext(ctx);
    const now = storeNow(ctx.db, staff.store_id);
    return { application: withdrawApplication(ctx.db, staff.id, ctx.params.id, now) };
  });

  route('GET', '/api/staff/offers', { roles: ['staff'] }, (ctx) => {
    const { staff } = staffContext(ctx);
    const rows = all<OfferRow>(
      ctx.db,
      'SELECT * FROM job_offers WHERE staff_id = ? ORDER BY created_at DESC LIMIT 50',
      [staff.id],
    );
    const items = rows.map((row) => offerView(ctx.db, row)).filter(Boolean);
    const now = storeNow(ctx.db, staff.store_id);
    return {
      items,
      pending: rows.filter((r) => r.status === 'pending' && r.expires_at >= now).length,
      now,
    };
  });

  route('POST', '/api/staff/offers/:id/accept', { roles: ['staff'] }, (ctx) => {
    const { auth } = staffContext(ctx);
    const shift = acceptOffer(ctx.db, ctx.params.id, auth.userId);
    const updated = get<OfferRow>(ctx.db, 'SELECT * FROM job_offers WHERE id = ?', [ctx.params.id]);
    return { shift: shiftApi(ctx.db, shift), offer: updated ? offerView(ctx.db, updated) : null };
  });

  route('POST', '/api/staff/offers/:id/reject', { roles: ['staff'] }, (ctx) => {
    const { auth } = staffContext(ctx);
    const body = z.object({ reason: z.string().max(100).optional() }).parse(ctx.body ?? {});
    const result = rejectOffer(ctx.db, ctx.params.id, auth.userId, body.reason ?? '本人拒绝');
    return result;
  });

  route('GET', '/api/staff/shifts', { roles: ['staff'] }, (ctx) => {
    const { staff } = staffContext(ctx);
    const rows = shiftRowsForStaff(ctx.db, staff.id);
    const now = storeNow(ctx.db, staff.store_id);
    return {
      items: rows.map((row) => shiftApi(ctx.db, row)),
      now,
      stats: {
        total: rows.length,
        completed: rows.filter((r) => r.status === 'completed').length,
        confirmed: rows.filter((r) => r.status === 'confirmed').length,
        checkedIn: rows.filter((r) => r.status === 'checked_in').length,
        actualMinutes: rows.reduce((sum, r) => sum + (r.actual_minutes ?? 0), 0),
        payTotal: Math.round(rows.reduce((sum, r) => sum + (r.pay_amount ?? 0), 0) * 100) / 100,
      },
    };
  });

  route('POST', '/api/staff/shifts/:id/checkin', { roles: ['staff'] }, (ctx) => {
    const { auth } = staffContext(ctx);
    const body = z
      .object({
        storeCode: z.string().trim().min(3).max(12),
        lat: z.number().min(-90).max(90).optional(),
        lng: z.number().min(-180).max(180).optional(),
      })
      .parse(ctx.body ?? {});
    return shiftApi(ctx.db, checkIn(ctx.db, ctx.params.id, auth.userId, body));
  });

  route('POST', '/api/staff/shifts/:id/cancel', { roles: ['staff'] }, (ctx) => {
    const { auth } = staffContext(ctx);
    const body = z.object({ reason: z.string().trim().min(1).max(100) }).parse(ctx.body ?? {});
    return shiftApi(ctx.db, staffCancelShift(ctx.db, ctx.params.id, auth.userId, body.reason));
  });

  route('POST', '/api/staff/shifts/:id/checkout', { roles: ['staff'] }, (ctx) => {
    const { auth } = staffContext(ctx);
    return shiftApi(ctx.db, checkOut(ctx.db, ctx.params.id, auth.userId));
  });

  route('GET', '/api/staff/notifications', { roles: ['staff'] }, (ctx) => {
    const { auth } = staffContext(ctx);
    const rows = all<{
      id: string;
      type: string;
      title: string;
      body: string;
      read: number;
      related_json: string;
      created_at: number;
    }>(ctx.db, 'SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 50', [auth.userId]);
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

  route('POST', '/api/staff/notifications/read', { roles: ['staff'] }, (ctx) => {
    const { auth } = staffContext(ctx);
    run(ctx.db, 'UPDATE notifications SET read = 1 WHERE user_id = ?', [auth.userId]);
    return { ok: true };
  });
}
