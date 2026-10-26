import type { Db } from '../db/index.js';
import { all, get, parseJson, run, transaction } from '../lib/db.js';
import { id } from '../lib/ids.js';
import { assertDispatchAllowed, isDispatchPaused } from './pilot.js';
import { AppError, conflict } from '../lib/errors.js';
import { MINUTE_MS, formatDateTime, round2, windowCovers } from '../lib/time.js';
import { storeNow } from './clock.js';
import { getStore, parseConfig } from './stores.js';
import { getStaff, staffWindows } from './staff.js';
import { runMatching } from './matching.js';
import { createException, notifyStoreManagers, notifyUser, audit } from './notify.js';
import type { MatchCandidate, OfferRow, ShiftRow, StaffProfileRow } from './types.js';

export const ACTIVE_SHIFT_STATUSES = ['invited', 'confirmed', 'checked_in'] as const;

export function shiftConflict(
  db: Db,
  staffId: string,
  startAt: number,
  endAt: number,
  excludeShiftId?: string,
): ShiftRow | undefined {
  const rows = all<ShiftRow>(
    db,
    `SELECT * FROM shifts WHERE staff_id = ? AND status IN ('invited','confirmed','checked_in')
       AND start_at < ? AND end_at > ? ${excludeShiftId ? 'AND id != ?' : ''} LIMIT 1`,
    excludeShiftId ? [staffId, endAt, startAt, excludeShiftId] : [staffId, endAt, startAt],
  );
  return rows[0];
}

/** Every hard constraint is re-checked at offer creation, not only at matching. */
export function staffAvailableForShift(
  db: Db,
  staff: StaffProfileRow,
  startAt: number,
  endAt: number,
  now: number,
  config = parseConfig(getStore(db, staff.store_id)),
): { ok: boolean; reason?: string } {
  if (staff.status !== 'approved') return { ok: false, reason: '人员未通过审核' };
  if (config.staffing.requireQualified && !staff.qualified) return { ok: false, reason: '未完成岗位培训' };
  const windows = staffWindows(db, staff.id);
  if (!windows.length) return { ok: false, reason: '未填写可用时间' };
  if (!windowCovers(windows, startAt, endAt)) return { ok: false, reason: '可用时间不覆盖' };
  if (startAt - now < config.matching.minNoticeMin * MINUTE_MS) return { ok: false, reason: '通知时间不足' };
  const clash = shiftConflict(db, staff.id, startAt, endAt);
  if (clash) return { ok: false, reason: '与其他班次时间冲突' };
  return { ok: true };
}

export interface CreateOfferInput {
  storeId: string;
  staffId: string;
  startAt: number;
  endAt: number;
  hourlyRate: number;
  role: string;
  planId?: string | null;
  candidateIds?: string[];
  now: number;
  attempt?: number;
  demandId?: string | null;
  isBackfill?: boolean;
}

export function createOfferForShift(db: Db, input: CreateOfferInput): { shiftId: string; offerId: string } {
  const store = getStore(db, input.storeId);
  const config = parseConfig(store);
  const staff = getStaff(db, input.staffId);
  if (staff.store_id !== input.storeId) throw conflict('兼职人员不属于该门店');
  const check = staffAvailableForShift(db, staff, input.startAt, input.endAt, input.now, config);
  if (!check.ok) throw conflict(`无法邀约 ${staff.nickname}：${check.reason}`);

  const shiftId = id('shift');
  const offerId = id('off');
  const now = input.now;
  const expiresAt = now + config.matching.offerTtlMinutes * MINUTE_MS;

  run(
    db,
    `INSERT INTO shifts(id, store_id, staff_id, plan_id, demand_id, is_backfill, role, start_at, end_at, hourly_rate, status, offer_id, created_at, updated_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      shiftId,
      input.storeId,
      input.staffId,
      input.planId ?? null,
      input.demandId ?? null,
      input.isBackfill ? 1 : 0,
      input.role,
      input.startAt,
      input.endAt,
      input.hourlyRate,
      'invited',
      offerId,
      now,
      now,
    ],
  );
  run(
    db,
    `INSERT INTO job_offers(id, store_id, shift_id, staff_id, status, expires_at, attempt, candidates_json, created_at)
     VALUES(?,?,?,?,?,?,?,?,?)`,
    [
      offerId,
      input.storeId,
      shiftId,
      input.staffId,
      'pending',
      expiresAt,
      input.attempt ?? 1,
      JSON.stringify(input.candidateIds ?? []),
      now,
    ],
  );
  notifyUser(db, {
    userId: staff.user_id,
    storeId: input.storeId,
    type: 'offer',
    title: '新的工作邀约',
    body: `${store.name} 邀请你 ${formatDateTime(input.startAt)}-${formatDateTime(input.endAt)} 到店担任${input.role}`,
    related: { offerId, shiftId },
    at: now,
  });
  audit(db, {
    storeId: input.storeId,
    action: 'offer.create',
    entity: 'offer',
    entityId: offerId,
    detail: { staffId: input.staffId, shiftId },
    at: now,
  });
  return { shiftId, offerId };
}

function newCandidateId(db: Db, staff: StaffProfileRow): MatchCandidate {
  const windows = staffWindows(db, staff.id);
  const commitments = all<{ start_at: number; end_at: number; status: string; role: string }>(
    db,
    "SELECT start_at, end_at, status, role FROM shifts WHERE staff_id = ? AND status IN ('invited','confirmed','checked_in') ORDER BY start_at",
    [staff.id],
  ).map((s) => ({ startAt: s.start_at, endAt: s.end_at, label: `${s.role}/${s.status}` }));
  return {
    staffId: staff.id,
    nickname: staff.nickname,
    distanceKm: staff.distance_km,
    expectedRate: staff.expected_rate,
    experienceYears: staff.experience_years,
    onTimeRate: staff.on_time_rate,
    skills: parseJson<string[]>(staff.skills_json, []),
    qualified: Boolean(staff.qualified),
    status: staff.status,
    windows,
    commitments,
    shiftsCompleted: staff.shifts_completed,
    noShowCount: staff.no_show_count,
  };
}

/** Offer could not be accepted/rejected/answered: try the next candidate. */
export function escalateOffer(db: Db, offer: OfferRow, now: number, trigger: string): void {
  const store = getStore(db, offer.store_id);
  const config = parseConfig(store);
  const shift = get<ShiftRow>(db, 'SELECT * FROM shifts WHERE id = ?', [offer.shift_id]);
  if (!shift) return;
  if (shift.status === 'cancelled' || shift.status === 'completed') return;

  const attempted = new Set<string>([offer.staff_id]);
  const candidateIds = parseJson<string[]>(offer.candidates_json, []);
  for (const candidateId of candidateIds) {
    if (attempted.has(candidateId)) continue;
    attempted.add(candidateId);
    const staff = get<StaffProfileRow>(db, 'SELECT * FROM staff_profiles WHERE id = ?', [candidateId]);
    if (!staff) continue;
    const check = staffAvailableForShift(db, staff, shift.start_at, shift.end_at, now, config);
    if (!check.ok) continue;
    const offerId = id('off');
    const expiresAt = now + config.matching.offerTtlMinutes * MINUTE_MS;
    const remaining = candidateIds.filter((candidate) => !attempted.has(candidate));
    run(
      db,
      `INSERT INTO job_offers(id, store_id, shift_id, staff_id, status, expires_at, attempt, candidates_json, created_at)
       VALUES(?,?,?,?,?,?,?,?,?)`,
      [
        offerId,
        offer.store_id,
        shift.id,
        staff.id,
        'pending',
        expiresAt,
        offer.attempt + 1,
        JSON.stringify(remaining),
        now,
      ],
    );
    // Reassign the shift itself; otherwise the invitation and the shift owner drift apart.
    run(db, "UPDATE shifts SET staff_id = ?, offer_id = ?, updated_at = ? WHERE id = ? AND status = 'invited'", [
      staff.id,
      offerId,
      now,
      shift.id,
    ]);
    notifyUser(db, {
      userId: staff.user_id,
      storeId: offer.store_id,
      type: 'offer',
      title: '新的工作邀约',
      body: `${store.name} 邀请你 ${formatDateTime(shift.start_at)}-${formatDateTime(shift.end_at)} 到店担任${shift.role}`,
      related: { offerId, shiftId: shift.id },
      at: now,
    });
    audit(db, {
      storeId: offer.store_id,
      action: 'offer.escalate',
      entity: 'offer',
      entityId: offerId,
      detail: { previousOfferId: offer.id, trigger, attempt: offer.attempt + 1 },
      at: now,
    });
    return;
  }

  run(
    db,
    `UPDATE shifts SET status = 'cancelled', note = ?, cancelled_at = ?, cancelled_by = 'system',
       cancel_reason = ?, cancel_kind = 'offer_exhausted', updated_at = ?
     WHERE id = ? AND status = 'invited'`,
    [`无人接单：${trigger}`, now, `无人接单：${trigger}`, now, shift.id],
  );
  const backfill = get<BackfillTaskRow>(db, 'SELECT * FROM backfill_tasks WHERE shift_id = ?', [shift.id]);
  if (backfill) {
    run(db, "UPDATE backfill_tasks SET status = 'no_candidate', updated_at = ? WHERE id = ?", [now, backfill.id]);
  }
  if (shift.demand_id) reconcileDemand(db, shift.demand_id);
  createException(db, {
    storeId: offer.store_id,
    type: 'no_candidate',
    severity: 'critical',
    shiftId: shift.id,
    offerId: offer.id,
    message: `${formatDateTime(shift.start_at)} 的班次在 ${trigger} 后没有可用兼职者，请店长人工处理`,
    payload: { attempted: [...attempted] },
    at: now,
  });
  notifyStoreManagers(db, offer.store_id, {
    type: 'exception',
    title: '调配缺口需要人工处理',
    body: `${formatDateTime(shift.start_at)} 的班次无人接单，系统已自动寻找全部候选。`,
    related: { shiftId: shift.id, offerId: offer.id },
    at: now,
  });
}

export function acceptOffer(db: Db, offerId: string, staffUserId: string, now?: number): ShiftRow {
  return transaction(db, () => {
    const offer = get<OfferRow>(db, 'SELECT * FROM job_offers WHERE id = ?', [offerId]);
    if (!offer) throw new AppError(404, 'OFFER_NOT_FOUND', '邀约不存在');
    const staff = getStaff(db, offer.staff_id);
    if (staff.user_id !== staffUserId) throw new AppError(403, 'FORBIDDEN', '不能操作他人的邀约');
    if (staff.status !== 'approved') throw conflict('账号当前不可接单，请联系门店管理员');
    const effectiveNow = now ?? storeNow(db, offer.store_id);
    if (offer.status !== 'pending') throw conflict('该邀约已处理，请刷新');
    if (offer.expires_at < effectiveNow) {
      run(db, "UPDATE job_offers SET status = 'expired', responded_at = ? WHERE id = ? AND status = 'pending'", [
        effectiveNow,
        offer.id,
      ]);
      const refreshed = get<OfferRow>(db, 'SELECT * FROM job_offers WHERE id = ?', [offer.id])!;
      escalateOffer(db, refreshed, effectiveNow, '超时');
      throw conflict('邀约已超时，系统已为你寻找下一位候选');
    }
    const shift = get<ShiftRow>(db, 'SELECT * FROM shifts WHERE id = ?', [offer.shift_id]);
    if (!shift) throw new AppError(404, 'SHIFT_NOT_FOUND', '班次不存在');
    if (shift.status !== 'invited') throw conflict('该班次状态已变化');
    if (shift.staff_id !== staff.id) throw conflict('邀约与班次人员不一致，请刷新');
    const clash = shiftConflict(db, staff.id, shift.start_at, shift.end_at, shift.id);
    if (clash) throw conflict('该时段你已有其他班次，不能重复接单');

    // CAS: only one accept can win if two requests race.
    const claimed = run(
      db,
      "UPDATE job_offers SET status = 'accepted', responded_at = ? WHERE id = ? AND status = 'pending'",
      [effectiveNow, offer.id],
    );
    if (Number(claimed.changes) !== 1) throw conflict('该邀约已被处理');
    run(db, "UPDATE shifts SET status = 'confirmed', updated_at = ? WHERE id = ? AND status = 'invited'", [
      effectiveNow,
      shift.id,
    ]);

    // The same person must never be dispatched to two overlapping stores.
    const overlapping = all<OfferRow>(
      db,
      `SELECT o.* FROM job_offers o JOIN shifts s ON s.id = o.shift_id
        WHERE o.staff_id = ? AND o.status = 'pending' AND o.id != ?
          AND s.start_at < ? AND s.end_at > ?`,
      [staff.id, offer.id, shift.end_at, shift.start_at],
    );
    for (const other of overlapping) {
      run(db, "UPDATE job_offers SET status = 'cancelled', responded_at = ?, reason = ? WHERE id = ? AND status = 'pending'", [
        effectiveNow,
        'staff_booked_elsewhere',
        other.id,
      ]);
      run(db, "UPDATE shifts SET status = 'cancelled', note = '人员已接其他班次', updated_at = ? WHERE id = ? AND status = 'invited'", [
        effectiveNow,
        other.shift_id,
      ]);
      const otherShift = get<ShiftRow>(db, 'SELECT * FROM shifts WHERE id = ?', [other.shift_id]);
      if (otherShift) {
        createException(db, {
          storeId: other.store_id,
          type: 'duplicate_offer',
          severity: 'warning',
          shiftId: other.shift_id,
          offerId: other.id,
          message: '该兼职已接其他冲突班次，系统已自动撤销本邀约',
          at: effectiveNow,
        });
        escalateOffer(db, other, effectiveNow, '人员已接其他班次');
      }
    }

    notifyStoreManagers(db, offer.store_id, {
      type: 'offer_accepted',
      title: '兼职已接单',
      body: `${staff.nickname} 已接受 ${formatDateTime(shift.start_at)} 的班次`,
      related: { shiftId: shift.id, staffId: staff.id },
      at: effectiveNow,
    });
    if (shift.demand_id) {
      const task = get<BackfillTaskRow>(db, "SELECT * FROM backfill_tasks WHERE shift_id = ? AND status IN ('pending','offered')", [shift.id]);
      markBackfillFilled(db, shift.id);
      if (task) {
        notifyStoreManagers(db, offer.store_id, {
          type: 'backfill_accepted',
          title: '候补已接单',
          body: `${staff.nickname} 已接受候补邀约，${formatDateTime(shift.start_at)} 的缺口已补上。`,
          related: { shiftId: shift.id, demandId: shift.demand_id, taskId: task.id },
          at: effectiveNow,
        });
      }
      reconcileDemand(db, shift.demand_id);
    }
    audit(db, {
      storeId: offer.store_id,
      actorId: staffUserId,
      actorRole: 'staff',
      action: 'offer.accept',
      entity: 'offer',
      entityId: offer.id,
      detail: { shiftId: shift.id },
      at: effectiveNow,
    });
    return get<ShiftRow>(db, 'SELECT * FROM shifts WHERE id = ?', [shift.id])!;
  });
}

export function rejectOffer(
  db: Db,
  offerId: string,
  staffUserId: string,
  reason = '本人拒绝',
  now?: number,
): { shiftId: string; offerId: string } {
  return transaction(db, () => {
    const offer = get<OfferRow>(db, 'SELECT * FROM job_offers WHERE id = ?', [offerId]);
    if (!offer) throw new AppError(404, 'OFFER_NOT_FOUND', '邀约不存在');
    const staff = getStaff(db, offer.staff_id);
    if (staff.user_id !== staffUserId) throw new AppError(403, 'FORBIDDEN', '不能操作他人的邀约');
    if (staff.status !== 'approved') throw conflict('账号当前不可接单，请联系门店管理员');
    const effectiveNow = now ?? storeNow(db, offer.store_id);
    if (offer.status !== 'pending') throw conflict('该邀约已处理，请刷新');
    const claimed = run(db, "UPDATE job_offers SET status = 'rejected', responded_at = ?, reason = ? WHERE id = ? AND status = 'pending'", [
      effectiveNow,
      reason,
      offer.id,
    ]);
    if (Number(claimed.changes) !== 1) throw conflict('该邀约已被处理');
    const refreshed = get<OfferRow>(db, 'SELECT * FROM job_offers WHERE id = ?', [offer.id])!;
    escalateOffer(db, refreshed, effectiveNow, '拒绝');
    notifyStoreManagers(db, offer.store_id, {
      type: 'offer_rejected',
      title: '兼职拒绝了邀约',
      body: `${staff.nickname} 拒绝了 ${formatDateTime(get<ShiftRow>(db, 'SELECT * FROM shifts WHERE id = ?', [offer.shift_id])?.start_at ?? effectiveNow)} 的班次，系统正在寻找下一位候选`,
      related: { shiftId: offer.shift_id, offerId: offer.id },
      at: effectiveNow,
    });
    return { shiftId: offer.shift_id, offerId: offer.id };
  });
}

export function expireDueOffers(db: Db, storeId: string, now?: number): number {
  const effectiveNow = now ?? storeNow(db, storeId);
  const due = all<OfferRow>(
    db,
    "SELECT * FROM job_offers WHERE store_id = ? AND status = 'pending' AND expires_at <= ?",
    [storeId, effectiveNow],
  );
  let count = 0;
  for (const offer of due) {
    const result = run(
      db,
      "UPDATE job_offers SET status = 'expired', responded_at = ? WHERE id = ? AND status = 'pending'",
      [effectiveNow, offer.id],
    );
    if (Number(result.changes) !== 1) continue;
    count += 1;
    const refreshed = get<OfferRow>(db, 'SELECT * FROM job_offers WHERE id = ?', [offer.id])!;
    escalateOffer(db, refreshed, effectiveNow, '超时未响应');
  }
  return count;
}

export function processStaleShifts(db: Db, storeId: string, now?: number): { late: number; noShow: number } {
  const effectiveNow = now ?? storeNow(db, storeId);
  const store = getStore(db, storeId);
  const config = parseConfig(store);
  let late = 0;
  let noShow = 0;
  const upcoming = all<ShiftRow>(
    db,
    "SELECT * FROM shifts WHERE store_id = ? AND status = 'confirmed'",
    [storeId],
  );
  for (const shift of upcoming) {
    if (effectiveNow > shift.start_at + config.policy.noShowGraceMin * MINUTE_MS) {
      cancellationUpdate(db, shift.id, {
        at: effectiveNow,
        by: 'system',
        reason: '超过到岗截止时间未签到',
        kind: 'no_show',
        status: 'no_show',
      });
      run(db, "UPDATE shifts SET note = '超时未到店', updated_at = ? WHERE id = ?", [effectiveNow, shift.id]);
      run(db, "UPDATE staff_profiles SET no_show_count = no_show_count + 1, updated_at = ? WHERE id = ?", [
        effectiveNow,
        shift.staff_id,
      ]);
      const staff = getStaff(db, shift.staff_id);
      createException(db, {
        storeId,
        type: 'no_show',
        severity: 'critical',
        shiftId: shift.id,
        message: `${staff.nickname} 未按时到店（${formatDateTime(shift.start_at)}），已标记缺席`,
        at: effectiveNow,
      });
      notifyStoreManagers(db, storeId, {
        type: 'no_show',
        title: '人员缺席',
        body: `${staff.nickname} 未在 ${formatDateTime(shift.start_at)} 到店，系统正在按剩余时段寻找候补。`,
        related: { shiftId: shift.id },
        at: effectiveNow,
      });
      triggerBackfillForShift(db, { ...shift, status: 'no_show' }, 'no_show', effectiveNow);
      noShow += 1;
      continue;
    }
    if (effectiveNow > shift.start_at + 10 * MINUTE_MS) {
      const already = get<{ id: string }>(
        db,
        "SELECT id FROM exceptions WHERE shift_id = ? AND type = 'late' AND status = 'open'",
        [shift.id],
      );
      if (!already) {
        const staff = getStaff(db, shift.staff_id);
        createException(db, {
          storeId,
          type: 'late',
          severity: 'warning',
          shiftId: shift.id,
          message: `${staff.nickname} 尚未签到，已超过班次开始时间 10 分钟`,
          at: effectiveNow,
        });
        late += 1;
      }
    }
  }
  return { late, noShow };
}

export function checkIn(
  db: Db,
  shiftId: string,
  staffUserId: string,
  input: { storeCode?: string; lat?: number; lng?: number },
): ShiftRow {
  return transaction(db, () => {
    const shift = get<ShiftRow>(db, 'SELECT * FROM shifts WHERE id = ?', [shiftId]);
    if (!shift) throw new AppError(404, 'SHIFT_NOT_FOUND', '班次不存在');
    const staff = getStaff(db, shift.staff_id);
    if (staff.user_id !== staffUserId) throw new AppError(403, 'FORBIDDEN', '不能操作他人的班次');
    if (shift.status !== 'confirmed') throw conflict('只有已确认的班次可以签到');
    const store = getStore(db, shift.store_id);
    const now = storeNow(db, shift.store_id);
    if (input.storeCode && input.storeCode.trim().toUpperCase() !== store.manager_code) {
      throw conflict('门店签到码不正确');
    }
    if (now < shift.start_at - 30 * MINUTE_MS) throw conflict('签到时间过早，最早可在班次开始前 30 分钟签到');
    if (now > shift.end_at) throw conflict('班次已结束，无法签到');
    if (input.lat !== undefined && input.lng !== undefined) {
      const distance = haversineKm(input.lat, input.lng, store.lat, store.lng);
      if (distance > 1) throw conflict(`距离门店 ${distance.toFixed(1)}km，无法签到`);
    }
    const lateMinutes = Math.max(0, Math.round((now - shift.start_at) / MINUTE_MS));
    run(
      db,
      "UPDATE shifts SET status = 'checked_in', checked_in_at = ?, late_minutes = ?, updated_at = ? WHERE id = ? AND status = 'confirmed'",
      [now, lateMinutes, now, shift.id],
    );
    if (lateMinutes > 10) {
      createException(db, {
        storeId: shift.store_id,
        type: 'late',
        severity: 'warning',
        shiftId: shift.id,
        message: `${staff.nickname} 迟到 ${lateMinutes} 分钟到店`,
        at: now,
      });
    }
    notifyStoreManagers(db, shift.store_id, {
      type: 'checked_in',
      title: '兼职已到店',
      body: `${staff.nickname} 已签到，迟到 ${lateMinutes} 分钟。`,
      related: { shiftId: shift.id },
      at: now,
    });
    audit(db, {
      storeId: shift.store_id,
      actorId: staffUserId,
      actorRole: 'staff',
      action: 'shift.check_in',
      entity: 'shift',
      entityId: shift.id,
      detail: { lateMinutes },
      at: now,
    });
    return get<ShiftRow>(db, 'SELECT * FROM shifts WHERE id = ?', [shift.id])!;
  });
}

export function checkOut(db: Db, shiftId: string, staffUserId: string): ShiftRow {
  return transaction(db, () => {
    const shift = get<ShiftRow>(db, 'SELECT * FROM shifts WHERE id = ?', [shiftId]);
    if (!shift) throw new AppError(404, 'SHIFT_NOT_FOUND', '班次不存在');
    const staff = getStaff(db, shift.staff_id);
    if (staff.user_id !== staffUserId) throw new AppError(403, 'FORBIDDEN', '不能操作他人的班次');
    if (shift.status !== 'checked_in' || !shift.checked_in_at) throw conflict('只有已签到的班次可以签退');
    const now = storeNow(db, shift.store_id);
    const minutes = Math.max(1, Math.round((now - shift.checked_in_at) / MINUTE_MS));
    const pay = round2((minutes / 60) * shift.hourly_rate);
    run(
      db,
      "UPDATE shifts SET status = 'completed', checked_out_at = ?, actual_minutes = ?, pay_amount = ?, updated_at = ? WHERE id = ? AND status = 'checked_in'",
      [now, minutes, pay, now, shift.id],
    );
    // Rolling reliability: late arrivals degrade the on-time rate.
    const lateFactor = shift.late_minutes > 10 ? 0.85 : 1;
    run(
      db,
      `UPDATE staff_profiles SET shifts_completed = shifts_completed + 1,
         on_time_rate = ROUND((on_time_rate * shifts_completed + ?) / (shifts_completed + 1), 3), updated_at = ?
       WHERE id = ?`,
      [lateFactor, now, staff.id],
    );
    notifyStoreManagers(db, shift.store_id, {
      type: 'shift_completed',
      title: '服务已完成，待确认',
      body: `${staff.nickname} 已完成服务，实际 ${minutes} 分钟，预计报酬 ¥${pay}。`,
      related: { shiftId: shift.id },
      at: now,
    });
    audit(db, {
      storeId: shift.store_id,
      actorId: staffUserId,
      actorRole: 'staff',
      action: 'shift.check_out',
      entity: 'shift',
      entityId: shift.id,
      detail: { minutes, pay },
      at: now,
    });
    return get<ShiftRow>(db, 'SELECT * FROM shifts WHERE id = ?', [shift.id])!;
  });
}

export function managerConfirmShift(db: Db, shiftId: string, storeId: string, actorId: string): ShiftRow {
  const shift = get<ShiftRow>(db, 'SELECT * FROM shifts WHERE id = ? AND store_id = ?', [shiftId, storeId]);
  if (!shift) throw new AppError(404, 'SHIFT_NOT_FOUND', '班次不存在');
  if (shift.status !== 'completed') throw conflict('只有已完成的班次可确认');
  const now = storeNow(db, storeId);
  run(db, 'UPDATE shifts SET manager_confirmed = 1, updated_at = ? WHERE id = ?', [now, shift.id]);
  audit(db, {
    storeId,
    actorId,
    actorRole: 'manager',
    action: 'shift.confirm_completion',
    entity: 'shift',
    entityId: shift.id,
    at: now,
  });
  return get<ShiftRow>(db, 'SELECT * FROM shifts WHERE id = ?', [shift.id])!;
}

export function managerCancelShift(
  db: Db,
  shiftId: string,
  storeId: string,
  actorId: string,
  reason: string,
  scope: 'person' | 'demand' = 'person',
): ShiftRow {
  if (scope === 'demand') {
    const shift = get<ShiftRow>(db, 'SELECT * FROM shifts WHERE id = ? AND store_id = ?', [shiftId, storeId]);
    if (!shift) throw new AppError(404, 'SHIFT_NOT_FOUND', '班次不存在');
    const demand = demandForShift(db, shift);
    if (!demand) throw conflict('该班次没有关联用工需求，不能按需求取消');
    managerCancelDemand(db, demand.id, storeId, actorId, reason);
    return get<ShiftRow>(db, 'SELECT * FROM shifts WHERE id = ?', [shift.id])!;
  }
  return transaction(db, () => {
    const shift = get<ShiftRow>(db, 'SELECT * FROM shifts WHERE id = ? AND store_id = ?', [shiftId, storeId]);
    if (!shift) throw new AppError(404, 'SHIFT_NOT_FOUND', '班次不存在');
    if (!['invited', 'confirmed'].includes(shift.status)) throw conflict('当前班次状态不可取消');
    const now = storeNow(db, storeId);
    const wasConfirmed = shift.status === 'confirmed';
    cancellationUpdate(db, shift.id, { at: now, by: actorId, reason, kind: 'manager_cancelled', status: 'cancelled' });
    const staff = getStaff(db, shift.staff_id);
    notifyUser(db, {
      userId: staff.user_id,
      storeId,
      type: 'shift_cancelled',
      title: '班次已取消',
      body: `门店取消了 ${formatDateTime(shift.start_at)} 的班次：${reason}`,
      related: { shiftId: shift.id },
      at: now,
    });
    audit(db, {
      storeId,
      actorId,
      actorRole: 'manager',
      action: 'shift.cancel',
      entity: 'shift',
      entityId: shift.id,
      detail: { reason, scope },
      at: now,
    });
    if (wasConfirmed) triggerBackfillForShift(db, { ...shift, status: 'cancelled' }, 'manager_cancelled', now);
    if (shift.demand_id) reconcileDemand(db, shift.demand_id);
    return get<ShiftRow>(db, 'SELECT * FROM shifts WHERE id = ?', [shift.id])!;
  });
}

export function shiftApi(db: Db, shift: ShiftRow) {
  const staff = get<StaffProfileRow>(db, 'SELECT * FROM staff_profiles WHERE id = ?', [shift.staff_id]);
  const offer = get<OfferRow>(db, 'SELECT * FROM job_offers WHERE id = ?', [shift.offer_id]);
  const store = getStore(db, shift.store_id);
  return {
    id: shift.id,
    storeId: shift.store_id,
    storeName: store.name,
    storeAddress: store.address,
    managerCode: store.manager_code,
    staffId: shift.staff_id,
    staffName: staff?.nickname ?? '未知',
    staffPhone: staff?.phone ?? '',
    role: shift.role,
    startAt: shift.start_at,
    endAt: shift.end_at,
    hourlyRate: shift.hourly_rate,
    status: shift.status,
    demandId: shift.demand_id ?? null,
    isBackfill: Boolean(shift.is_backfill),
    cancelledAt: shift.cancelled_at ?? null,
    cancelledBy: shift.cancelled_by ?? null,
    cancelReason: shift.cancel_reason ?? null,
    cancelKind: shift.cancel_kind ?? null,
    offerStatus: offer?.status ?? null,
    offerExpiresAt: offer?.status === 'pending' ? offer.expires_at : null,
    checkedInAt: shift.checked_in_at,
    checkedOutAt: shift.checked_out_at,
    actualMinutes: shift.actual_minutes,
    payAmount: shift.pay_amount,
    lateMinutes: shift.late_minutes,
    managerConfirmed: Boolean(shift.manager_confirmed),
    note: shift.note,
    createdAt: shift.created_at,
  };
}

export function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export { newCandidateId };

export function markNoShow(db: Db, shiftId: string, storeId: string, actorId: string, note = '店长标记缺席'): ShiftRow {
  return transaction(db, () => {
    const shift = get<ShiftRow>(db, 'SELECT * FROM shifts WHERE id = ? AND store_id = ?', [shiftId, storeId]);
    if (!shift) throw new AppError(404, 'SHIFT_NOT_FOUND', '班次不存在');
    if (!['confirmed', 'checked_in'].includes(shift.status)) throw conflict('当前状态不能标记缺席');
    const now = storeNow(db, storeId);
    cancellationUpdate(db, shift.id, { at: now, by: actorId, reason: note, kind: 'no_show', status: 'no_show' });
    run(db, "UPDATE shifts SET note = ?, updated_at = ? WHERE id = ?", [note, now, shift.id]);
    run(db, "UPDATE staff_profiles SET no_show_count = no_show_count + 1, updated_at = ? WHERE id = ?", [
      now,
      shift.staff_id,
    ]);
    const staff = getStaff(db, shift.staff_id);
    createException(db, {
      storeId,
      type: 'no_show',
      severity: 'critical',
      shiftId: shift.id,
      message: `${staff.nickname} 被标记为缺席（${note}）`,
      at: now,
    });
    audit(db, {
      storeId,
      actorId,
      actorRole: 'manager',
      action: 'shift.mark_no_show',
      entity: 'shift',
      entityId: shift.id,
      at: now,
    });
    triggerBackfillForShift(db, { ...shift, status: 'no_show' }, 'no_show', now);
    return get<ShiftRow>(db, 'SELECT * FROM shifts WHERE id = ?', [shift.id])!;
  });
}

// ---------------------------------------------------------------------------
// R2.2 staffing demands + automatic backfill
// ---------------------------------------------------------------------------

export interface DemandRow {
  id: string;
  store_id: string;
  plan_id: string | null;
  role: string;
  start_at: number;
  end_at: number;
  headcount: number;
  hourly_rate: number;
  status: 'open' | 'filled' | 'cancelled';
  created_at: number;
  updated_at: number;
}

export interface BackfillTaskRow {
  id: string;
  store_id: string;
  demand_id: string;
  source_shift_id: string;
  shift_id: string | null;
  role: string;
  start_at: number;
  end_at: number;
  hourly_rate: number;
  status: 'pending' | 'offered' | 'filled' | 'no_candidate' | 'cancelled' | 'needs_approval';
  reason: string;
  attempts: number;
  created_at: number;
  updated_at: number;
}

export function createDemand(
  db: Db,
  input: { storeId: string; planId: string | null; role: string; startAt: number; endAt: number; headcount: number; hourlyRate: number },
): DemandRow {
  if (input.planId) {
    const existing = get<DemandRow>(
      db,
      'SELECT * FROM staffing_demands WHERE plan_id = ? AND start_at = ? AND end_at = ? AND role = ? LIMIT 1',
      [input.planId, input.startAt, input.endAt, input.role],
    );
    if (existing) return existing;
  }
  const now = Date.now();
  const demandId = id('dem');
  run(
    db,
    `INSERT INTO staffing_demands(id, store_id, plan_id, role, start_at, end_at, headcount, hourly_rate, status, created_at, updated_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
    [
      demandId,
      input.storeId,
      input.planId,
      input.role,
      input.startAt,
      input.endAt,
      Math.max(1, input.headcount),
      input.hourlyRate,
      'open',
      now,
      now,
    ],
  );
  return get<DemandRow>(db, 'SELECT * FROM staffing_demands WHERE id = ?', [demandId])!;
}

function shiftCountsForDemand(db: Db, demandId: string) {
  const rows = all<{ status: string; n: number }>(
    db,
    'SELECT status, COUNT(*) AS n FROM shifts WHERE demand_id = ? GROUP BY status',
    [demandId],
  );
  const count = (status: string) => rows.find((r) => r.status === status)?.n ?? 0;
  return {
    confirmed: count('confirmed'),
    checkedIn: count('checked_in'),
    completed: count('completed'),
    invited: count('invited'),
    cancelled: count('cancelled'),
    noShow: count('no_show'),
  };
}

export function demandApi(db: Db, demand: DemandRow) {
  const counts = shiftCountsForDemand(db, demand.id);
  const committed = counts.confirmed + counts.checkedIn + counts.completed;
  const pending = counts.invited;
  const tasks = all<BackfillTaskRow>(
    db,
    'SELECT * FROM backfill_tasks WHERE demand_id = ? ORDER BY created_at DESC',
    [demand.id],
  );
  return {
    id: demand.id,
    planId: demand.plan_id,
    role: demand.role,
    startAt: demand.start_at,
    endAt: demand.end_at,
    headcount: demand.headcount,
    hourlyRate: demand.hourly_rate,
    status: demand.status,
    confirmed: counts.confirmed,
    checkedIn: counts.checkedIn,
    completed: counts.completed,
    pending,
    cancelled: counts.cancelled,
    noShow: counts.noShow,
    committed,
    unfilled: Math.max(0, demand.headcount - committed),
    uncovered: Math.max(0, demand.headcount - committed - pending),
    backfillTasks: tasks.map((t) => ({
      id: t.id,
      status: t.status,
      reason: t.reason,
      attempts: t.attempts,
      startAt: t.start_at,
      endAt: t.end_at,
      sourceShiftId: t.source_shift_id,
      shiftId: t.shift_id,
    })),
  };
}

export function listDemands(db: Db, storeId: string) {
  return all<DemandRow>(db, 'SELECT * FROM staffing_demands WHERE store_id = ? ORDER BY start_at', [storeId]).map((d) =>
    demandApi(db, d),
  );
}

export function reconcileDemand(db: Db, demandId: string): void {
  const demand = get<DemandRow>(db, 'SELECT * FROM staffing_demands WHERE id = ?', [demandId]);
  if (!demand || demand.status === 'cancelled') return;
  const counts = shiftCountsForDemand(db, demandId);
  const committed = counts.confirmed + counts.checkedIn + counts.completed;
  const status = committed >= demand.headcount ? 'filled' : 'open';
  run(db, 'UPDATE staffing_demands SET status = ?, updated_at = ? WHERE id = ?', [status, Date.now(), demandId]);
}

function cancellationUpdate(
  db: Db,
  shiftId: string,
  input: { at: number; by: string; reason: string; kind: string; status: 'cancelled' | 'no_show' },
): void {
  run(
    db,
    `UPDATE shifts SET status = ?, cancelled_at = ?, cancelled_by = ?, cancel_reason = ?, cancel_kind = ?, updated_at = ?
      WHERE id = ?`,
    [input.status, input.at, input.by, input.reason, input.kind, input.at, shiftId],
  );
  run(
    db,
    "UPDATE job_offers SET status = 'cancelled', responded_at = ?, reason = ? WHERE shift_id = ? AND status IN ('pending','accepted')",
    [input.at, input.kind, shiftId],
  );
}

export function staffCancelShift(
  db: Db,
  shiftId: string,
  staffUserId: string,
  reason: string,
  now?: number,
): ShiftRow {
  return transaction(db, () => {
    const shift = get<ShiftRow>(db, 'SELECT * FROM shifts WHERE id = ?', [shiftId]);
    if (!shift) throw new AppError(404, 'SHIFT_NOT_FOUND', '班次不存在');
    const staff = getStaff(db, shift.staff_id);
    if (staff.user_id !== staffUserId) throw new AppError(403, 'FORBIDDEN', '不能操作他人的班次');
    if (shift.status !== 'confirmed') throw conflict('只有已确认且未开始的班次可以取消');
    const store = getStore(db, shift.store_id);
    const config = parseConfig(store);
    const effectiveNow = now ?? storeNow(db, shift.store_id);
    if (effectiveNow >= shift.start_at) throw conflict('班次已开始，请联系店长处理');
    cancellationUpdate(db, shift.id, {
      at: effectiveNow,
      by: staff.id,
      reason,
      kind: 'staff_cancelled',
      status: 'cancelled',
    });
    const minutesBefore = Math.round((shift.start_at - effectiveNow) / MINUTE_MS);
    if (minutesBefore < config.policy.staffCancelMinNoticeMin) {
      createException(db, {
        storeId: shift.store_id,
        type: 'late_cancellation',
        severity: 'warning',
        shiftId: shift.id,
        message: `${staff.nickname} 在班次开始前 ${minutesBefore} 分钟取消（规则要求 ${config.policy.staffCancelMinNoticeMin} 分钟）`,
        at: effectiveNow,
      });
    }
    notifyStoreManagers(db, shift.store_id, {
      type: 'staff_cancelled',
      title: '兼职取消了班次',
      body: `${staff.nickname} 取消了 ${formatDateTime(shift.start_at)} 的班次：${reason}`,
      related: { shiftId: shift.id },
      at: effectiveNow,
    });
    audit(db, {
      storeId: shift.store_id,
      actorId: staffUserId,
      actorRole: 'staff',
      action: 'shift.staff_cancel',
      entity: 'shift',
      entityId: shift.id,
      detail: { reason, minutesBefore },
      at: effectiveNow,
    });
    triggerBackfillForShift(db, { ...shift, status: 'cancelled' }, 'staff_cancelled', effectiveNow);
    if (shift.demand_id) reconcileDemand(db, shift.demand_id);
    return get<ShiftRow>(db, 'SELECT * FROM shifts WHERE id = ?', [shift.id])!;
  });
}

export function managerCancelDemand(
  db: Db,
  demandId: string,
  storeId: string,
  actorId: string,
  reason: string,
): void {
  transaction(db, () => {
    const demand = get<DemandRow>(db, 'SELECT * FROM staffing_demands WHERE id = ? AND store_id = ?', [demandId, storeId]);
    if (!demand) throw new AppError(404, 'DEMAND_NOT_FOUND', '用工需求不存在');
    if (demand.status === 'cancelled') return;
    const active = all<ShiftRow>(
      db,
      "SELECT * FROM shifts WHERE demand_id = ? AND status IN ('invited','confirmed','checked_in')",
      [demandId],
    );
    if (active.some((s) => s.status === 'checked_in')) {
      throw conflict('已有兼职在岗，不能取消整个需求；请先签退或按缺岗处理');
    }
    const now = storeNow(db, storeId);
    for (const shift of active) {
      cancellationUpdate(db, shift.id, { at: now, by: actorId, reason, kind: 'demand_cancelled', status: 'cancelled' });
      const staff = get<StaffProfileRow>(db, 'SELECT * FROM staff_profiles WHERE id = ?', [shift.staff_id]);
      if (staff) {
        notifyUser(db, {
          userId: staff.user_id,
          storeId,
          type: 'shift_cancelled',
          title: '用工需求已取消',
          body: `门店取消了 ${formatDateTime(shift.start_at)} 的用工需求：${reason}`,
          related: { shiftId: shift.id, demandId },
          at: now,
        });
      }
    }
    run(db, "UPDATE backfill_tasks SET status = 'cancelled', updated_at = ? WHERE demand_id = ? AND status IN ('pending','offered','needs_approval')", [now, demandId]);
    run(db, "UPDATE staffing_demands SET status = 'cancelled', updated_at = ? WHERE id = ?", [now, demandId]);
    audit(db, {
      storeId,
      actorId,
      actorRole: 'manager',
      action: 'demand.cancel',
      entity: 'demand',
      entityId: demandId,
      detail: { reason, cancelledShifts: active.length },
      at: now,
    });
  });
}

export function triggerBackfillForShift(
  db: Db,
  shift: ShiftRow,
  reason: string,
  now: number,
): BackfillTaskRow | null {
  if (!shift.demand_id) return null;
  const demand = get<DemandRow>(db, 'SELECT * FROM staffing_demands WHERE id = ?', [shift.demand_id]);
  if (!demand || demand.status === 'cancelled') return null;
  const store = getStore(db, shift.store_id);
  const config = parseConfig(store);
  if (isDispatchPaused(db, shift.store_id)) {
    createException(db, {
      storeId: shift.store_id,
      type: 'pilot_paused',
      severity: 'critical',
      shiftId: shift.id,
      message: '试点调配已暂停，未自动候补；请人工接管',
      at: now,
    });
    return null;
  }
  if (!config.policy.autoBackfill) {
    createException(db, {
      storeId: shift.store_id,
      type: 'manual_backfill_required',
      severity: 'warning',
      shiftId: shift.id,
      message: '自动候补已关闭，请店长人工补位',
      at: now,
    });
    return null;
  }
  const existing = get<BackfillTaskRow>(db, 'SELECT * FROM backfill_tasks WHERE source_shift_id = ?', [shift.id]);
  if (existing) return existing;
  const counts = shiftCountsForDemand(db, demand.id);
  const committed = counts.confirmed + counts.checkedIn + counts.completed;
  if (committed >= demand.headcount) return null;
  const inFlight = get<{ n: number }>(
    db,
    "SELECT COUNT(*) AS n FROM backfill_tasks WHERE demand_id = ? AND status IN ('pending','offered','needs_approval')",
    [demand.id],
  )!;
  const shortfall = Math.max(0, demand.headcount - committed);
  if (inFlight.n >= shortfall) return null;

  const step = 5 * MINUTE_MS;
  const earliest = Math.ceil((now + config.matching.minNoticeMin * MINUTE_MS) / step) * step;
  const startAt = Math.max(demand.start_at, earliest);
  if (demand.end_at - startAt < 20 * MINUTE_MS) {
    createException(db, {
      storeId: shift.store_id,
      type: 'too_late_to_backfill',
      severity: 'critical',
      shiftId: shift.id,
      message: '剩余可工作时段不足 20 分钟，无法自动候补，请店长人工处理',
      at: now,
    });
    return null;
  }

  const taskId = id('bf');
  run(
    db,
    `INSERT INTO backfill_tasks(id, store_id, demand_id, source_shift_id, role, start_at, end_at, hourly_rate, status, reason, created_at, updated_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
    [taskId, shift.store_id, demand.id, shift.id, demand.role, startAt, demand.end_at, demand.hourly_rate, 'pending', reason, now, now],
  );

  const excluded = new Set<string>([shift.staff_id]);
  for (const row of all<{ staff_id: string }>(db, "SELECT staff_id FROM shifts WHERE demand_id = ? AND status IN ('cancelled','no_show')", [demand.id])) {
    excluded.add(row.staff_id);
  }
  for (const row of all<{ staff_id: string }>(
    db,
    `SELECT o.staff_id FROM job_offers o JOIN shifts s ON s.id = o.shift_id
      WHERE s.demand_id = ? AND o.status IN ('rejected','expired','cancelled')`,
    [demand.id],
  )) {
    excluded.add(row.staff_id);
  }

  const profiles = all<StaffProfileRow>(db, "SELECT * FROM staff_profiles WHERE store_id = ? AND status = 'approved'", [shift.store_id]);
  const candidates = profiles
    .filter((p) => !excluded.has(p.id))
    .map((p) => newCandidateId(db, p))
    .filter((c) => c.qualified || !config.staffing.requireQualified);
  const inBudget = candidates.filter((c) => c.expectedRate <= demand.hourly_rate + 0.01);
  const range = { startAt, endAt: demand.end_at, headcount: 1 };
  const budgetMatch = runMatching({ now, config, ranges: [range], candidates: inBudget, planType: 'economic' });

  if (budgetMatch.draft.items.length) {
    const item = budgetMatch.draft.items[0];
    const chosen = profiles.find((p) => p.id === item.staffId);
    const candidateIds = [item.staffId, ...item.alternatives.map((a) => a.staffId)];
    if (chosen) {
      try {
        const offer = createOfferForShift(db, {
          storeId: shift.store_id,
          staffId: chosen.id,
          startAt,
          endAt: demand.end_at,
          hourlyRate: item.hourlyRate,
          role: demand.role,
          planId: demand.plan_id,
          demandId: demand.id,
          isBackfill: true,
          candidateIds,
          now,
        });
        run(
          db,
          "UPDATE backfill_tasks SET status = 'offered', shift_id = ?, attempts = attempts + 1, updated_at = ? WHERE id = ?",
          [offer.shiftId, now, taskId],
        );
        notifyStoreManagers(db, shift.store_id, {
          type: 'backfill_offered',
          title: '已自动发起候补邀约',
          body: `${chosen.nickname} 已收到 ${formatDateTime(startAt)}-${formatDateTime(demand.end_at)} 的候补邀约，等待接受。`,
          related: { demandId: demand.id, shiftId: offer.shiftId, taskId },
          at: now,
        });
        audit(db, {
          storeId: shift.store_id,
          action: 'backfill.offer',
          entity: 'backfill',
          entityId: taskId,
          detail: { demandId: demand.id, staffId: chosen.id, sourceShiftId: shift.id, reason },
          at: now,
        });
        reconcileDemand(db, demand.id);
        return get<BackfillTaskRow>(db, 'SELECT * FROM backfill_tasks WHERE id = ?', [taskId])!;
      } catch {
        // fall through
      }
    }
  }

  const outOfBudget = candidates.length > inBudget.length &&
    runMatching({ now, config, ranges: [range], candidates, planType: 'economic' }).draft.items.length > 0;
  const status = outOfBudget ? 'needs_approval' : 'no_candidate';
  run(db, 'UPDATE backfill_tasks SET status = ?, updated_at = ? WHERE id = ?', [status, now, taskId]);
  createException(db, {
    storeId: shift.store_id,
    type: outOfBudget ? 'backfill_budget_exceeded' : 'no_candidate',
    severity: 'critical',
    shiftId: shift.id,
    message: outOfBudget
      ? '存在可用候补，但其期望报酬超出原方案预算，需店长确认'
      : '没有符合条件的候补人员，请店长人工处理',
    payload: { demandId: demand.id, excluded: [...excluded] },
    at: now,
  });
  notifyStoreManagers(db, shift.store_id, {
    type: 'exception',
    title: outOfBudget ? '候补超出预算，需要确认' : '自动候补失败',
    body: outOfBudget
      ? '已找到可用人员，但报酬超出原方案，需店长确认后才能邀约。'
      : '当前没有符合条件的候补人员，请人工处理。',
    related: { demandId: demand.id, shiftId: shift.id, taskId },
    at: now,
  });
  reconcileDemand(db, demand.id);
  return get<BackfillTaskRow>(db, 'SELECT * FROM backfill_tasks WHERE id = ?', [taskId])!;
}

function markBackfillFilled(db: Db, shiftId: string): void {
  const task = get<BackfillTaskRow>(db, "SELECT * FROM backfill_tasks WHERE shift_id = ? AND status IN ('pending','offered')", [shiftId]);
  if (!task) return;
  run(db, "UPDATE backfill_tasks SET status = 'filled', updated_at = ? WHERE id = ?", [Date.now(), task.id]);
  reconcileDemand(db, task.demand_id);
}

export function demandForShift(db: Db, shift: ShiftRow): DemandRow | null {
  if (!shift.demand_id) return null;
  return get<DemandRow>(db, 'SELECT * FROM staffing_demands WHERE id = ?', [shift.demand_id]) ?? null;
}

/** Manager explicitly approves a backfill whose candidate rate exceeds the plan cap. */
export function approveBackfillTask(
  db: Db,
  taskId: string,
  storeId: string,
  actorId: string,
): BackfillTaskRow {
  return transaction(db, () => {
    const task = get<BackfillTaskRow>(db, 'SELECT * FROM backfill_tasks WHERE id = ? AND store_id = ?', [taskId, storeId]);
    if (!task) throw new AppError(404, 'BACKFILL_NOT_FOUND', '候补任务不存在');
    if (task.status !== 'needs_approval') throw conflict('该候补任务不需要加价确认');
    const demand = get<DemandRow>(db, 'SELECT * FROM staffing_demands WHERE id = ?', [task.demand_id]);
    if (!demand || demand.status === 'cancelled') throw conflict('用工需求已取消');
    const store = getStore(db, storeId);
    const config = parseConfig(store);
    const now = storeNow(db, storeId);
    const excluded = new Set<string>();
    for (const row of all<{ staff_id: string }>(db, "SELECT staff_id FROM shifts WHERE demand_id = ? AND status IN ('cancelled','no_show')", [demand.id])) {
      excluded.add(row.staff_id);
    }
    for (const row of all<{ staff_id: string }>(
      db,
      `SELECT o.staff_id FROM job_offers o JOIN shifts s ON s.id = o.shift_id
        WHERE s.demand_id = ? AND o.status IN ('rejected','expired','cancelled')`,
      [demand.id],
    )) {
      excluded.add(row.staff_id);
    }
    const profiles = all<StaffProfileRow>(db, "SELECT * FROM staff_profiles WHERE store_id = ? AND status = 'approved'", [storeId]);
    const candidates = profiles
      .filter((p) => !excluded.has(p.id))
      .map((p) => newCandidateId(db, p))
      .filter((c) => c.qualified || !config.staffing.requireQualified);
    const match = runMatching({
      now,
      config,
      ranges: [{ startAt: task.start_at, endAt: task.end_at, headcount: 1 }],
      candidates,
      planType: 'economic',
    });
    const item = match.draft.items[0];
    if (!item) {
      run(db, "UPDATE backfill_tasks SET status = 'no_candidate', updated_at = ? WHERE id = ?", [now, task.id]);
      createException(db, {
        storeId,
        type: 'no_candidate',
        severity: 'critical',
        message: '店长确认加价后仍无可用候补，请人工处理',
        payload: { taskId: task.id, demandId: demand.id },
        at: now,
      });
      return get<BackfillTaskRow>(db, 'SELECT * FROM backfill_tasks WHERE id = ?', [task.id])!;
    }
    const chosen = profiles.find((p) => p.id === item.staffId)!;
    const offer = createOfferForShift(db, {
      storeId,
      staffId: chosen.id,
      startAt: task.start_at,
      endAt: task.end_at,
      hourlyRate: item.hourlyRate,
      role: demand.role,
      planId: demand.plan_id,
      demandId: demand.id,
      isBackfill: true,
      candidateIds: [item.staffId, ...item.alternatives.map((a) => a.staffId)],
      now,
    });
    run(db, "UPDATE backfill_tasks SET status = 'offered', shift_id = ?, attempts = attempts + 1, updated_at = ? WHERE id = ?", [offer.shiftId, now, task.id]);
    notifyStoreManagers(db, storeId, {
      type: 'backfill_offered',
      title: '候补加价已确认',
      body: `${chosen.nickname} 已收到候补邀约，时薪 ¥${item.hourlyRate}，等待接受。`,
      related: { demandId: demand.id, shiftId: offer.shiftId, taskId: task.id },
      at: now,
    });
    audit(db, {
      storeId,
      actorId,
      actorRole: 'manager',
      action: 'backfill.approve_budget',
      entity: 'backfill',
      entityId: task.id,
      detail: { staffId: chosen.id, hourlyRate: item.hourlyRate },
      at: now,
    });
    reconcileDemand(db, demand.id);
    return get<BackfillTaskRow>(db, 'SELECT * FROM backfill_tasks WHERE id = ?', [task.id])!;
  });
}
