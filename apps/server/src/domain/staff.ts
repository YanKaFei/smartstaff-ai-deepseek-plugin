import { z } from 'zod';
import type { Db } from '../db/index.js';
import { all, get, parseJson, run, transaction } from '../lib/db.js';
import { id } from '../lib/ids.js';
import { AppError } from '../lib/errors.js';
import type { AvailabilityWindow, StaffProfileRow } from './types.js';

export const availabilitySchema = z
  .array(
    z.object({
      weekday: z.number().int().min(0).max(6),
      startMin: z.number().int().min(0).max(1439),
      endMin: z.number().int().min(0).max(1440),
    }),
  )
  .max(40);

export const profileSchema = z.object({
  nickname: z.string().trim().min(1).max(30),
  area: z.string().trim().min(1).max(60),
  distanceKm: z.number().min(0).max(50),
  expectedRate: z.number().min(10).max(200),
  experienceYears: z.number().min(0).max(40),
  skills: z.array(z.string().trim().min(1).max(20)).min(1).max(10),
  bio: z.string().max(200).optional(),
});

export function staffWindows(db: Db, staffId: string): AvailabilityWindow[] {
  return all<AvailabilityWindow>(
    db,
    'SELECT weekday, start_min AS startMin, end_min AS endMin FROM staff_availability WHERE staff_id = ? ORDER BY weekday, start_min',
    [staffId],
  );
}

export function serializeStaff(db: Db, row: StaffProfileRow) {
  const user = get<{ phone_verified: number; openid: string | null }>(
    db,
    'SELECT phone_verified, openid FROM users WHERE id = ?',
    [row.user_id],
  );
  return {
    id: row.id,
    userId: row.user_id,
    nickname: row.nickname,
    phone: row.phone,
    area: row.area,
    distanceKm: row.distance_km,
    expectedRate: row.expected_rate,
    experienceYears: row.experience_years,
    skills: parseJson<string[]>(row.skills_json, []),
    qualified: Boolean(row.qualified),
    trainingStatus: row.training_status,
    status: row.status,
    onTimeRate: row.on_time_rate,
    shiftsCompleted: row.shifts_completed,
    noShowCount: row.no_show_count,
    bio: row.bio,
    source: row.source,
    phoneVerified: Boolean(user?.phone_verified),
    openidBound: Boolean(user?.openid),
    availability: staffWindows(db, row.id),
  };
}

export function getStaffByUser(db: Db, userId: string): StaffProfileRow {
  const row = get<StaffProfileRow>(db, 'SELECT * FROM staff_profiles WHERE user_id = ?', [userId]);
  if (!row) throw new AppError(404, 'STAFF_PROFILE_NOT_FOUND', '兼职资料不存在，请先完成注册');
  return row;
}

export function getStaff(db: Db, staffId: string): StaffProfileRow {
  const row = get<StaffProfileRow>(db, 'SELECT * FROM staff_profiles WHERE id = ?', [staffId]);
  if (!row) throw new AppError(404, 'STAFF_NOT_FOUND', '兼职人员不存在');
  return row;
}

export function createStaff(
  db: Db,
  input: {
    userId: string;
    storeId: string;
    nickname: string;
    phone: string;
    area?: string;
    distanceKm?: number;
    expectedRate?: number;
    experienceYears?: number;
    skills?: string[];
    bio?: string;
    status?: StaffProfileRow['status'];
    onTimeRate?: number;
    source?: 'manual' | 'simulator';
  },
): StaffProfileRow {
  const now = Date.now();
  const profileId = id('staff');
  run(
    db,
    `INSERT INTO staff_profiles(id, user_id, store_id, nickname, phone, area, distance_km, expected_rate, experience_years, skills_json, qualified, training_status, status, on_time_rate, bio, source, created_at, updated_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      profileId,
      input.userId,
      input.storeId,
      input.nickname,
      input.phone,
      input.area ?? '',
      input.distanceKm ?? 2,
      input.expectedRate ?? 32,
      input.experienceYears ?? 0,
      JSON.stringify(input.skills ?? ['烤肉辅助']),
      0,
      'pending',
      input.status ?? 'pending',
      input.onTimeRate ?? 0.9,
      input.bio ?? '',
      input.source ?? 'manual',
      now,
      now,
    ],
  );
  return getStaff(db, profileId);
}

export function updateStaffProfile(
  db: Db,
  staffId: string,
  patch: z.infer<typeof profileSchema>,
): StaffProfileRow {
  const now = Date.now();
  run(
    db,
    `UPDATE staff_profiles SET nickname=?, area=?, distance_km=?, expected_rate=?, experience_years=?, skills_json=?, bio=?, updated_at=? WHERE id=?`,
    [
      patch.nickname,
      patch.area,
      patch.distanceKm,
      patch.expectedRate,
      patch.experienceYears,
      JSON.stringify(patch.skills),
      patch.bio ?? '',
      now,
      staffId,
    ],
  );
  return getStaff(db, staffId);
}

export function setAvailability(db: Db, staffId: string, windows: AvailabilityWindow[]): AvailabilityWindow[] {
  return transaction(db, () => {
    run(db, 'DELETE FROM staff_availability WHERE staff_id = ?', [staffId]);
    for (const w of windows) {
      if (w.startMin === w.endMin) throw new AppError(400, 'EMPTY_WINDOW', '可用时间的开始与结束不能相同');
      run(db, 'INSERT INTO staff_availability(id, staff_id, weekday, start_min, end_min) VALUES(?,?,?,?,?)', [
        id('av'),
        staffId,
        w.weekday,
        w.startMin,
        w.endMin,
      ]);
    }
    return staffWindows(db, staffId);
  });
}

export function reviewStaff(
  db: Db,
  storeId: string,
  staffId: string,
  input: { status?: 'approved' | 'rejected' | 'suspended' | 'pending'; qualified?: boolean; trainingStatus?: string },
  actorId: string,
): StaffProfileRow {
  const staff = getStaff(db, staffId);
  if (staff.store_id !== storeId) throw new AppError(403, 'FORBIDDEN', '不能审核其他门店的人员');
  const status = input.status ?? staff.status;
  const qualified = input.qualified ?? Boolean(staff.qualified);
  const training = input.trainingStatus ?? (qualified ? 'qualified' : staff.training_status);
  if (status === 'approved' && !qualified) {
    throw new AppError(409, 'NOT_TRAINED', '通过审核前必须完成岗位培训');
  }
  run(
    db,
    'UPDATE staff_profiles SET status=?, qualified=?, training_status=?, updated_at=? WHERE id=?',
    [status, qualified ? 1 : 0, training, Date.now(), staffId],
  );
  return getStaff(db, staffId);
}

export function listStaff(db: Db, storeId: string, status?: string) {
  const rows = status
    ? all<StaffProfileRow>(db, 'SELECT * FROM staff_profiles WHERE store_id = ? AND status = ? ORDER BY created_at DESC', [
        storeId,
        status,
      ])
    : all<StaffProfileRow>(db, 'SELECT * FROM staff_profiles WHERE store_id = ? ORDER BY created_at DESC', [storeId]);
  return rows.map((r) => serializeStaff(db, r));
}
