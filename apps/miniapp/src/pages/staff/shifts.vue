<template>
  <view class="ss-page">
    <view v-if="loading" class="empty">正在读取班次…</view>
    <template v-else>
      <view class="stats-card">
        <view class="stat"><text class="stat-value">{{ stats.completed }}</text><text class="stat-label">已完成</text></view>
        <view class="stat"><text class="stat-value">{{ (stats.actualMinutes / 60).toFixed(1) }}</text><text class="stat-label">累计小时</text></view>
        <view class="stat"><text class="stat-value accent">¥{{ stats.payTotal }}</text><text class="stat-label">预计报酬</text></view>
      </view>

      <view v-if="notifications.length" class="ss-card notice-card">
        <view class="ss-spread"><text class="ss-title">消息通知</text><text class="mark-read" @tap="markRead">全部已读</text></view>
        <view v-for="n in notifications.slice(0, 4)" :key="n.id" class="notice-row">
          <text class="notice-dot" :class="{ unread: !n.read }" />
          <view class="notice-main">
            <text class="notice-title">{{ n.title }}</text>
            <text class="ss-sub">{{ n.body }}</text>
          </view>
        </view>
      </view>

      <view v-if="upcoming.length" class="section-label">待执行班次</view>
      <view v-for="shift in upcoming" :key="shift.id" class="ss-card shift-card">
        <view class="ss-spread">
          <view>
            <text class="store-name">{{ shift.storeName }}</text>
            <text class="ss-sub">{{ shift.storeAddress }}</text>
          </view>
          <text class="ss-pill" :class="statusClass(shift.status)">{{ SHIFT_STATUS[shift.status] || shift.status }}</text>
        </view>
        <view class="time-band">
          <text class="time-main">{{ fmtRange(shift.startAt, shift.endAt) }}</text>
          <text class="ss-sub">{{ fmtDate(shift.startAt) }} · {{ shift.role }} · ¥{{ shift.hourlyRate }}/h</text>
        </view>
        <view class="shift-info">
          <text v-if="shift.status === 'confirmed'">签到码 {{ shift.managerCode }} · 班次开始前 30 分钟可签到</text>
          <text v-if="shift.status === 'confirmed'" class="ss-warn">{{ nowLabel }} · 请提前到店</text>
          <text v-if="shift.status === 'checked_in'">已签到 {{ fmtTime(shift.checkedInAt) }}<text v-if="shift.lateMinutes > 10" class="ss-warn">（迟到 {{ shift.lateMinutes }} 分钟）</text></text>
          <text v-if="shift.status === 'checked_in'">服务结束后记得签退，店长确认后完成。</text>
        </view>

        <view v-if="activeCheckin === shift.id" class="checkin-panel">
          <text class="checkin-title">输入门店签到码</text>
          <view class="ss-row">
            <input v-model="checkinCode" class="code-input" placeholder="例如 K001" maxlength="10" />
            <button class="btn-ghost small" @tap="scanCode(shift)">扫码</button>
          </view>
          <view class="ss-row checkin-actions">
            <button class="btn-ghost small" @tap="activeCheckin = ''">取消</button>
            <button class="btn-primary small-primary" :disabled="acting" @tap="submitCheckin(shift)">{{ acting ? '签到中…' : '确认签到' }}</button>
          </view>
        </view>

        <view v-else class="shift-actions">
          <button v-if="shift.status === 'confirmed'" class="btn-ghost danger small cancel-btn" @tap="cancelShift(shift)">申请取消</button>
          <button v-if="shift.status === 'confirmed'" class="btn-primary compact-btn" @tap="startCheckin(shift)">到店签到</button>
          <button v-if="shift.status === 'checked_in'" class="btn-primary compact-btn" :disabled="acting" @tap="checkout(shift)">{{ acting ? '处理中…' : '签退并完工' }}</button>
        </view>
      </view>

      <view v-if="!upcoming.length" class="ss-card"><view class="empty">暂无待执行班次。接受工作邀约后会出现在这里。</view></view>

      <view v-if="finished.length" class="section-label">历史班次</view>
      <view v-for="shift in finished" :key="shift.id" class="ss-card history-card">
        <view class="ss-spread">
          <view>
            <text class="history-store">{{ shift.storeName }}</text>
            <text class="ss-sub">{{ fmtDate(shift.startAt) }} {{ fmtRange(shift.startAt, shift.endAt) }}</text>
          </view>
          <view class="right">
            <text class="ss-pill" :class="statusClass(shift.status)">{{ SHIFT_STATUS[shift.status] || shift.status }}</text>
            <text v-if="shift.payAmount" class="pay">¥{{ shift.payAmount }}</text>
          </view>
        </view>
        <text v-if="shift.status === 'completed'" class="ss-sub history-meta">实际 {{ minutesLabel(shift.actualMinutes || 0) }} · {{ shift.managerConfirmed ? '店长已确认' : '待店长确认' }}</text>
        <text v-if="shift.note" class="ss-sub history-meta">{{ shift.note }}</text>
        <text v-if="shift.cancelReason" class="ss-sub history-meta">取消原因：{{ shift.cancelReason }} · {{ shift.cancelKind === 'staff_cancelled' ? '本人取消' : '门店取消' }}</text>
      </view>
    </template>

    <BottomNav role="staff" current="shifts" />
  </view>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import { onPullDownRefresh, onShow } from '@dcloudio/uni-app';
import BottomNav from '../../components/BottomNav.vue';
import { requireRole, request, toast } from '../../api/client';
import type { Shift } from '../../api/types';
import { SHIFT_STATUS, fmtDate, fmtRange, fmtTime, minutesLabel } from '../../api/format';

const shifts = ref<Shift[]>([]);
const stats = ref({ completed: 0, actualMinutes: 0, payTotal: 0 });
const loading = ref(true);
const acting = ref(false);
const activeCheckin = ref('');
const checkinCode = ref('');
const nowOffset = ref(0);
const notifications = ref<Array<{ id: string; title: string; body: string; read: boolean }>>([]);
const nowLabel = ref(fmtTime(Date.now()));

const ACTIVE = ['confirmed', 'checked_in'];

const upcoming = computed(() =>
  shifts.value
    .filter((s) => ACTIVE.includes(s.status))
    .sort((a, b) => a.startAt - b.startAt),
);
const finished = computed(() =>
  shifts.value
    .filter((s) => !ACTIVE.includes(s.status))
    .sort((a, b) => b.startAt - a.startAt)
    .slice(0, 20),
);

onShow(() => {
  if (!requireRole('staff')) return;
  void load();
});
onPullDownRefresh(async () => { await load(); uni.stopPullDownRefresh(); });

function statusClass(status: string) {
  if (status === 'completed') return 'ok';
  if (status === 'checked_in') return 'accent';
  if (status === 'no_show' || status === 'cancelled') return 'bad';
  return '';
}

async function load() {
  loading.value = true;
  try {
    const [data, notes] = await Promise.all([
      request<{
        items: Shift[];
        stats: { completed: number; actualMinutes: number; payTotal: number };
        now: number;
      }>('/staff/shifts'),
      request<Array<{ id: string; title: string; body: string; read: boolean }>>('/staff/notifications').catch(() => []),
    ]);
    shifts.value = data.items;
    stats.value = data.stats;
    notifications.value = notes;
    nowOffset.value = data.now - Date.now();
    nowLabel.value = fmtTime(Date.now() + nowOffset.value);
  } catch (err) {
    toast(err instanceof Error ? err.message : '加载失败');
  } finally {
    loading.value = false;
  }
}

async function markRead() {
  try {
    await request('/staff/notifications/read', { method: 'POST', data: {} });
    notifications.value = notifications.value.map((n) => ({ ...n, read: true }));
    toast('已全部标记为已读');
  } catch (err) {
    toast(err instanceof Error ? err.message : '操作失败');
  }
}

function cancelShift(shift: Shift) {
  const reasons = ['时间冲突', '临时有事', '身体不适', '距离太远'];
  uni.showActionSheet({
    itemList: reasons,
    success: (picked) => {
      const reason = reasons[picked.tapIndex] ?? '临时取消';
      uni.showModal({
        title: '申请取消班次',
        content: `将取消 ${fmtDate(shift.startAt)} ${fmtRange(shift.startAt, shift.endAt)} 的班次，并通知门店自动寻找候补。临近班次取消会被记录。`,
        confirmText: '确认取消',
        success: async (res) => {
          if (!res.confirm) return;
          acting.value = true;
          try {
            await request(`/staff/shifts/${shift.id}/cancel`, { method: 'POST', data: { reason } });
            toast('已取消，门店将自动寻找候补');
            await load();
          } catch (err) {
            toast(err instanceof Error ? err.message : '取消失败');
          } finally {
            acting.value = false;
          }
        },
      });
    },
  });
}

function startCheckin(shift: Shift) {
  activeCheckin.value = shift.id;
  checkinCode.value = shift.managerCode;
}

function submitCheckin(shift: Shift) {
  if (!checkinCode.value.trim()) return toast('请输入门店签到码');
  void doCheckin(shift, checkinCode.value.trim());
}

async function doCheckin(shift: Shift, code: string) {
  if (acting.value) return;
  acting.value = true;
  try {
    await request(`/staff/shifts/${shift.id}/checkin`, { method: 'POST', data: { storeCode: code } });
    activeCheckin.value = '';
    toast('签到成功，开始服务', 'success');
    await load();
  } catch (err) {
    toast(err instanceof Error ? err.message : '签到失败');
  } finally {
    acting.value = false;
  }
}

function scanCode(shift: Shift) {
  if (typeof uni.scanCode !== 'function') {
    toast('当前环境不支持扫码，请手动输入签到码');
    return;
  }
  try {
    uni.scanCode({
      success: (res) => {
        const raw = (res.result || '').trim();
        const code = raw.includes('/') ? raw.split('/').filter(Boolean).pop() || raw : raw;
        checkinCode.value = code.toUpperCase();
        void doCheckin(shift, checkinCode.value);
      },
      fail: () => {
        toast('无法扫码，请手动输入签到码');
      },
    });
  } catch {
    toast('当前环境不支持扫码，请手动输入签到码');
  }
}

function checkout(shift: Shift) {
  uni.showModal({
    title: '签退并完工',
    content: '确认服务已结束？签退后将记录实际工时与预计报酬，等待店长确认。',
    confirmText: '签退',
    success: async (res) => {
      if (!res.confirm) return;
      acting.value = true;
      try {
        await request(`/staff/shifts/${shift.id}/checkout`, { method: 'POST', data: {} });
        toast('已签退，等待店长确认', 'success');
        await load();
      } catch (err) {
        toast(err instanceof Error ? err.message : '签退失败');
      } finally {
        acting.value = false;
      }
    },
  });
}
</script>

<style scoped>
.notice-card { padding: 20rpx 24rpx; }
.notice-card .ss-title { margin-bottom: 6rpx; }
.mark-read { color: var(--ss-accent); font-size: 22rpx; }
.notice-row { display: flex; gap: 12rpx; padding: 10rpx 0; align-items: flex-start; }
.notice-dot { width: 10rpx; height: 10rpx; border-radius: 50%; margin-top: 14rpx; background: var(--ss-line); flex-shrink: 0; }
.notice-dot.unread { background: var(--ss-accent); }
.notice-main { flex: 1; min-width: 0; }
.notice-title { display: block; font-size: 23rpx; font-weight: 700; margin-bottom: 2rpx; }
.stats-card { display: flex; background: var(--ss-panel); border: 1rpx solid var(--ss-line); border-radius: 26rpx; padding: 24rpx 10rpx; margin-bottom: 24rpx; }
.stat { flex: 1; text-align: center; display: flex; flex-direction: column; gap: 6rpx; }
.stat-value { font-size: 42rpx; font-weight: 900; font-variant-numeric: tabular-nums; }
.stat-value.accent { color: var(--ss-accent); }
.stat-label { font-size: 20rpx; color: var(--ss-muted); }
.section-label { font-size: 24rpx; color: var(--ss-muted); font-weight: 700; margin: 6rpx 0 14rpx; }
.shift-card { padding: 24rpx; }
.store-name { display: block; font-size: 29rpx; font-weight: 800; }
.time-band { margin-top: 18rpx; padding: 18rpx; border-radius: 16rpx; background: var(--ss-panel-2); }
.time-main { display: block; font-size: 40rpx; font-weight: 900; font-variant-numeric: tabular-nums; letter-spacing: 1rpx; margin-bottom: 6rpx; }
.shift-info { display: flex; flex-direction: column; gap: 6rpx; margin-top: 16rpx; font-size: 22rpx; color: var(--ss-muted); }
.shift-actions { margin-top: 18rpx; display: flex; gap: 12rpx; align-items: center; }
.cancel-btn { flex: 0 0 180rpx; min-height: 84rpx; font-size: 23rpx; }
.compact-btn { min-height: 84rpx; font-size: 28rpx; }
.checkin-panel { margin-top: 18rpx; padding: 18rpx; border-radius: 16rpx; background: var(--ss-panel-2); border: 1rpx solid var(--ss-line); }
.checkin-title { display: block; font-size: 23rpx; color: var(--ss-muted); margin-bottom: 12rpx; }
.code-input { flex: 1; background: var(--ss-bg); border: 1rpx solid var(--ss-line); border-radius: 14rpx; padding: 16rpx 20rpx; font-size: 30rpx; letter-spacing: 3rpx; }
.checkin-actions { margin-top: 14rpx; justify-content: flex-end; }
.small-primary { flex: 0 0 220rpx; min-height: 72rpx; font-size: 25rpx; border-radius: 16rpx; }
.history-card { padding: 22rpx; }
.history-store { display: block; font-size: 26rpx; font-weight: 700; }
.right { display: flex; flex-direction: column; align-items: flex-end; gap: 6rpx; }
.pay { color: var(--ss-accent); font-weight: 800; font-size: 28rpx; }
.history-meta { display: block; margin-top: 10rpx; }
</style>
