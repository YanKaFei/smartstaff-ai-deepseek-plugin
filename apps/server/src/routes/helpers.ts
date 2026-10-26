import type { RequestContext } from '../lib/http.js';
import { AppError } from '../lib/errors.js';
import { getStore, serializeStore } from '../domain/stores.js';
import { getStaffByUser, serializeStaff } from '../domain/staff.js';

export function authOf(ctx: RequestContext) {
  if (!ctx.auth) throw new AppError(401, 'UNAUTHORIZED', '请先登录');
  return ctx.auth;
}

export function managerContext(ctx: RequestContext) {
  const auth = authOf(ctx);
  if (auth.role !== 'manager' || !auth.storeId) throw new AppError(403, 'NO_STORE', '当前账号未绑定门店');
  const store = getStore(ctx.db, auth.storeId);
  return { auth, store, storeId: store.id, config: serializeStore(store).config };
}

export function staffContext(ctx: RequestContext) {
  const auth = authOf(ctx);
  const profile = getStaffByUser(ctx.db, auth.userId);
  return { auth, staff: profile, staffId: profile.id, storeId: profile.store_id };
}

export function adminStoreQuery(ctx: RequestContext): string | undefined {
  const value = ctx.query.get('storeId');
  return value?.trim() || undefined;
}

export { serializeStore, serializeStaff };
