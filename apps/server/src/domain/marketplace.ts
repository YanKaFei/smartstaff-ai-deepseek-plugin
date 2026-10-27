import type { Db } from '../db/index.js';
import { all, get, run, transaction } from '../lib/db.js';
import { id } from '../lib/ids.js';
import { AppError, conflict } from '../lib/errors.js';
import { formatDateTime } from '../lib/time.js';
import { audit, notifyStoreManagers, notifyUser } from './notify.js';
import { demandApi, reconcileDemand, staffAvailableForShift } from './dispatch.js';
import { getStore, parseConfig } from './stores.js';
import { getStaff } from './staff.js';
import type { ShiftRow as _ShiftRow } from './types.js';

type DemandRow = {
  id: string; store_id: string; plan_id: string | null; role: string; start_at: number; end_at: number;
  headcount: number; hourly_rate: number; status: 'open' | 'filled' | 'cancelled'; created_at: number; updated_at: number;
};

export interface ShiftApplicationRow {
  id: string;
  demand_id: string;
  store_id: string;
  staff_id: string;
  status: 'pending' | 'approved' | 'rejected' | 'withdrawn';
  note: string;
  decision_note: string | null;
  decided_by: string | null;
  decided_at: number | null;
  shift_id: string | null;
  created_at: number;
  updated_at: number;
}

function applicationView(db: Db, app: ShiftApplicationRow) {
  const demand = get<DemandRow>(db, 'SELECT * FROM staffing_demands WHERE id = ?', [app.demand_id]);
  const store = getStore(db, app.store_id);
  const staff = getStaff(db, app.staff_id);
  return {
    id: app.id,
    status: app.status,
    note: app.note,
    decisionNote: app.decision_note,
    decidedAt: app.decided_at,
    shiftId: app.shift_id,
    createdAt: app.created_at,
    store: { id: store.id, name: store.name, address: store.address, managerCode: store.manager_code },
    staff: {
      id: staff.id, nickname: staff.nickname, area: staff.area, distanceKm: staff.distance_km,
      status: staff.status, qualified: Boolean(staff.qualified), onTimeRate: staff.on_time_rate, shiftsCompleted: staff.shifts_completed,
    },
    demand: demand ? demandApi(db, demand) : null,
    role: demand?.role ?? '',
    startAt: demand?.start_at ?? 0,
    endAt: demand?.end_at ?? 0,
    hourlyRate: demand?.hourly_rate ?? 0,
  };
}

export function listOpenOpportunities(db: Db, staffId: string, now: number) {
  const staff = getStaff(db, staffId);
  const rows = all<DemandRow>(
    db,
    `SELECT * FROM staffing_demands WHERE status = 'open' AND end_at > ? ORDER BY start_at, store_id LIMIT 100`,
    [now],
  );
  return rows
    .map((demand) => {
      const store = getStore(db, demand.store_id);
      const view = demandApi(db, demand);
      const app = get<ShiftApplicationRow>(
        db,
        'SELECT * FROM shift_applications WHERE demand_id = ? AND staff_id = ?',
        [demand.id, staff.id],
      );
      const config = parseConfig(store);
      const check = staffAvailableForShift(db, staff, demand.start_at, demand.end_at, now, config);
      const full = view.unfilled <= 0;
      let reason = full ? '岗位已满' : check.ok ? null : check.reason ?? '不可申请';
      if (app && app.status === 'pending') reason = '已申请，等待门店处理';
      if (app && app.status === 'approved') reason = '已通过，班次已确认';
      return {
        id: demand.id,
        store: {
          id: store.id, name: store.name, address: store.address, managerCode: store.manager_code,
          lat: store.lat, lng: store.lng, isHomeStore: store.id === staff.store_id,
        },
        role: demand.role,
        startAt: demand.start_at,
        endAt: demand.end_at,
        hourlyRate: demand.hourly_rate,
        headcount: demand.headcount,
        unfilled: view.unfilled,
        payEstimate: Math.round((Math.max(0.5, (demand.end_at - demand.start_at) / 3_600_000) * demand.hourly_rate) * 100) / 100,
        canApply: !full && !app && check.ok,
        reason,
        application: app ? { id: app.id, status: app.status } : null,
      };
    })
    .filter((row) => row.unfilled > 0 || row.application);
}

export function listMyApplications(db: Db, staffId: string) {
  return all<ShiftApplicationRow>(db, 'SELECT * FROM shift_applications WHERE staff_id = ? ORDER BY created_at DESC LIMIT 100', [staffId])
    .map((row) => applicationView(db, row));
}

export function applyToDemand(db: Db, staffId: string, demandId: string, note: string, now: number) {
  const staff = getStaff(db, staffId);
  if (staff.status !== 'approved') throw conflict('兼职资料未通过审核，暂不能申请');
  const demand = get<DemandRow>(db, 'SELECT * FROM staffing_demands WHERE id = ?', [demandId]);
  if (!demand) throw new AppError(404, 'DEMAND_NOT_FOUND', '缺位信息不存在');
  if (demand.status !== 'open' || demand.end_at <= now) throw conflict('该缺位已关闭或已过期');
  const view = demandApi(db, demand);
  if (view.unfilled <= 0) throw conflict('该岗位已满，请选择其他门店');
  const store = getStore(db, demand.store_id);
  const check = staffAvailableForShift(db, staff, demand.start_at, demand.end_at, now, parseConfig(store));
  if (!check.ok) throw conflict(check.reason ?? '当前不可申请');
  const existing = get<ShiftApplicationRow>(db, 'SELECT * FROM shift_applications WHERE demand_id = ? AND staff_id = ?', [demandId, staffId]);
  if (existing && (existing.status === 'pending' || existing.status === 'approved')) {
    throw conflict(existing.status === 'approved' ? '已通过该岗位，无需重复申请' : '已申请，请等待门店处理');
  }
  const appId = existing?.id ?? id('app');
  transaction(db, () => {
    if (existing) {
      run(db, "UPDATE shift_applications SET status='pending', note=?, decision_note=NULL, decided_by=NULL, decided_at=NULL, updated_at=? WHERE id=?", [note, now, appId]);
    } else {
      run(db, `INSERT INTO shift_applications(id, demand_id, store_id, staff_id, status, note, created_at, updated_at)
        VALUES(?,?,?,?, 'pending', ?, ?, ?)`, [appId, demandId, demand.store_id, staffId, note, now, now]);
    }
  });
  notifyStoreManagers(db, demand.store_id, {
    type: 'shift_application',
    title: '新的兼职申请',
    body: `${staff.nickname} 申请 ${formatDateTime(demand.start_at)}-${formatDateTime(demand.end_at)} 的${demand.role}`,
    related: { applicationId: appId, demandId, staffId },
    at: now,
  });
  audit(db, { storeId: demand.store_id, action: 'shift_application.create', entity: 'shift_application', entityId: appId, detail: { demandId, staffId }, at: now });
  return applicationView(db, get<ShiftApplicationRow>(db, 'SELECT * FROM shift_applications WHERE id = ?', [appId])!);
}

export function withdrawApplication(db: Db, staffId: string, applicationId: string, now: number) {
  const app = get<ShiftApplicationRow>(db, 'SELECT * FROM shift_applications WHERE id = ? AND staff_id = ?', [applicationId, staffId]);
  if (!app) throw new AppError(404, 'APPLICATION_NOT_FOUND', '申请不存在');
  if (app.status !== 'pending') throw conflict('只有待处理申请可以撤回');
  run(db, "UPDATE shift_applications SET status='withdrawn', updated_at=? WHERE id=?", [now, app.id]);
  audit(db, { storeId: app.store_id, action: 'shift_application.withdraw', entity: 'shift_application', entityId: app.id, detail: { staffId }, at: now });
  return applicationView(db, get<ShiftApplicationRow>(db, 'SELECT * FROM shift_applications WHERE id = ?', [app.id])!);
}

export function listStoreApplications(db: Db, storeId: string) {
  return all<ShiftApplicationRow>(db, 'SELECT * FROM shift_applications WHERE store_id = ? ORDER BY created_at DESC LIMIT 200', [storeId])
    .map((row) => applicationView(db, row));
}

export function decideApplication(
  db: Db,
  storeId: string,
  applicationId: string,
  decision: 'approved' | 'rejected',
  actorId: string,
  decisionNote: string,
  now: number,
) {
  const app = get<ShiftApplicationRow>(db, 'SELECT * FROM shift_applications WHERE id = ? AND store_id = ?', [applicationId, storeId]);
  if (!app) throw new AppError(404, 'APPLICATION_NOT_FOUND', '申请不存在');
  if (app.status !== 'pending') throw conflict('该申请已处理');
  if (decision === 'rejected') {
    run(db, "UPDATE shift_applications SET status='rejected', decision_note=?, decided_by=?, decided_at=?, updated_at=? WHERE id=?", [decisionNote, actorId, now, now, app.id]);
    notifyUser(db, { userId: getStaff(db, app.staff_id).user_id, storeId, type: 'shift_application_rejected', title: '申请未通过', body: decisionNote || '门店已拒绝该申请', related: { applicationId: app.id }, at: now });
    audit(db, { storeId, action: 'shift_application.reject', entity: 'shift_application', entityId: app.id, detail: { actorId }, at: now });
    return { application: applicationView(db, get<ShiftApplicationRow>(db, 'SELECT * FROM shift_applications WHERE id = ?', [app.id])!), shift: null };
  }

  const demand = get<DemandRow>(db, 'SELECT * FROM staffing_demands WHERE id = ?', [app.demand_id]);
  if (!demand || demand.status !== 'open') throw conflict('缺位已关闭');
  const view = demandApi(db, demand);
  if (view.unfilled <= 0) throw conflict('岗位已满');
  const staff = getStaff(db, app.staff_id);
  const store = getStore(db, storeId);
  const check = staffAvailableForShift(db, staff, demand.start_at, demand.end_at, now, parseConfig(store));
  if (!check.ok) throw conflict(check.reason ?? '该兼职当前不可排班');
  let shiftId: string | null = null;
  transaction(db, () => {
    shiftId = id('shift');
    run(db, `INSERT INTO shifts(id, store_id, staff_id, plan_id, demand_id, is_backfill, role, start_at, end_at, hourly_rate, status, created_at, updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?, 'confirmed', ?, ?)`, [
      shiftId, storeId, staff.id, demand.plan_id, demand.id, 0, demand.role, demand.start_at, demand.end_at, demand.hourly_rate, now, now,
    ]);
    run(db, "UPDATE shift_applications SET status='approved', decision_note=?, decided_by=?, decided_at=?, shift_id=?, updated_at=? WHERE id=?", [decisionNote, actorId, now, shiftId, now, app.id]);
    reconcileDemand(db, demand.id);
    const current = get<DemandRow>(db, 'SELECT * FROM staffing_demands WHERE id = ?', [demand.id])!;
    if (current.status === 'filled') {
      for (const other of all<ShiftApplicationRow>(db, "SELECT * FROM shift_applications WHERE demand_id = ? AND status = 'pending'", [demand.id])) {
        run(db, "UPDATE shift_applications SET status='rejected', decision_note='岗位已满', decided_at=?, updated_at=? WHERE id=?", [now, now, other.id]);
        notifyUser(db, { userId: getStaff(db, other.staff_id).user_id, storeId, type: 'shift_application_rejected', title: '岗位已满', body: '该岗位已由其他兼职确认', related: { applicationId: other.id }, at: now });
      }
    }

    notifyUser(db, { userId: staff.user_id, storeId, type: 'shift_application_approved', title: '申请已通过', body: `${store.name} ${formatDateTime(demand.start_at)}-${formatDateTime(demand.end_at)} 的${demand.role}已确认`, related: { applicationId: app.id, shiftId }, at: now });
    audit(db, { storeId, action: 'shift_application.approve', entity: 'shift_application', entityId: app.id, detail: { actorId, shiftId }, at: now });
  });
  const shift = shiftId ? get<_ShiftRow>(db, 'SELECT * FROM shifts WHERE id = ?', [shiftId]) : null;
  return { application: applicationView(db, get<ShiftApplicationRow>(db, 'SELECT * FROM shift_applications WHERE id = ?', [app.id])!), shift: shift ? { id: shift.id, status: shift.status, startAt: shift.start_at, endAt: shift.end_at } : null };
}
