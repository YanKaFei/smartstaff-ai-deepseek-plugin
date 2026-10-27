import type { RequestContext } from '../lib/http.js';
import { AppError } from '../lib/errors.js';
import { get } from '../lib/db.js';
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
  const membership = get<{ organization_id: string; status: string }>(ctx.db, "SELECT organization_id, status FROM memberships WHERE user_id = ? AND store_id = ? AND status = 'active' LIMIT 1", [auth.userId, store.id]);
  const meta = get<{ owner_user_id: string | null; organization_id: string | null }>(ctx.db, 'SELECT owner_user_id, organization_id FROM stores WHERE id = ?', [store.id])!;
  const isOwner = meta.owner_user_id === auth.userId;
  if (!membership && !isOwner) throw new AppError(403, 'TENANT_FORBIDDEN', '当前账号不属于该门店组织');
  if (membership && meta.organization_id && membership.organization_id !== meta.organization_id) throw new AppError(403, 'TENANT_FORBIDDEN', '门店与成员组织不匹配');
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
