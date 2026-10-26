<template>
  <view class="ss-page">
    <view class="code-card">
      <view>
        <text class="code-label">兼职到店签到码</text>
        <text class="code-value">{{ managerCode || '—' }}</text>
      </view>
      <button class="btn-ghost small" @tap="copyCode">复制</button>
    </view>

    <view v-if="demands.length" class="demand-summary">
      <view v-for="d in demands" :key="d.id" class="ss-card demand-card">
        <view class="ss-spread">
          <view>
            <text class="demand-title">{{ timeRange(d.startAt, d.endAt) }} · {{ d.role }}</text>
            <text class="ss-sub">目标 {{ d.headcount }} 人 · 已接受 {{ d.committed }} · 到岗 {{ d.checkedIn }} · 待回复 {{ d.pending }}</text>
          </view>
          <text class="ss-pill" :class="d.status === 'filled' ? 'ok' : d.status === 'cancelled' ? 'bad' : (d.unfilled > 0 ? 'warn' : '')">
            {{ d.status === 'cancelled' ? '需求已取消' : d.unfilled > 0 ? '未填补 ' + d.unfilled : '已满员' }}
          </text>
        </view>
        <view v-for="t in d.backfillTasks" :key="t.id" class="backfill-line">
          <text>候补：{{ backfillLabel(t.status) }}</text>
          <view class="ss-row">
            <text class="ss-sub">{{ timeRange(t.startAt, t.endAt) }}</text>
            <button v-if="t.status === 'needs_approval'" class="btn-ghost small accent" @tap="approveBackfill(t.id)">确认加价补员</button>
          </view>
        </view>
      </view>
    </view>

    <view v-if="notifications.length" class="ss-card notice-card">
      <view class="ss-spread">
        <text class="ss-title">站内消息</text>
        <text class="mark-read" @tap="markAllRead">全部已读</text>
      </view>
      <view v-for="n in notifications.slice(0, 4)" :key="n.id" class="notice-row">
        <text class="notice-dot" :class="{ unread: !n.read }" />
        <view class="notice-main">
          <text class="notice-title">{{ n.title }}</text>
          <text class="ss-sub">{{ n.body }}</text>
        </view>
        <text class="notice-time">{{ fmtTime(n.createdAt) }}</text>
      </view>
    </view>

    <view v-if="loading" class="empty">正在读取调配记录…</view>
    <template v-else>
      <view class="filter-tabs">
        <view
          v-for="tab in tabs"
          :key="tab.key"
          class="filter-tab"
          :class="{ active: filter === tab.key }"
          @tap="filter = tab.key"
        >
          <text>{{ tab.label }}</text>
          <text class="tab-count">{{ countOf(tab.key) }}</text>
        </view>
      </view>

      <view v-if="!filtered.length" class="ss-card">
        <view class="empty">{{ filter === 'exceptions' ? '没有异常，一切正常。' : '该状态下暂无班次。' }}</view>
      </view>

      <view v-for="shift in filtered" :key="shift.id" class="ss-card shift-card">
        <view class="ss-spread">
          <view class="ss-row">
            <view class="avatar">{{ shift.staffName.slice(0, 1) }}</view>
            <view>
              <view class="ss-row">
                <text class="staff-name">{{ shift.staffName }}</text>
                <text class="ss-pill" :class="statusClass(shift.status)">{{ SHIFT_STATUS[shift.status] || shift.status }}</text>
              </view>
              <text class="ss-sub">{{ shift.role }} · {{ fmtDate(shift.startAt) }} {{ fmtRange(shift.startAt, shift.endAt) }}</text>
            </view>
          </view>
          <text class="pay">¥{{ shift.hourlyRate }}/h</text>
        </view>

        <view class="shift-meta">
          <text>邀约：{{ offerLabel(shift) }}</text>
          <text v-if="shift.status === 'invited' && shift.offerExpiresAt">剩余 {{ countdownText(shift.offerExpiresAt) }}</text>
          <text v-if="shift.checkedInAt">签到 {{ fmtTime(shift.checkedInAt) }}<text v-if="shift.lateMinutes > 10" class="ss-warn">（迟到 {{ shift.lateMinutes }} 分钟）</text></text>
          <text v-if="shift.status === 'completed'">实际 {{ minutesLabel(shift.actualMinutes || 0) }} · 报酬 ¥{{ shift.payAmount || 0 }}</text>
          <text v-if="shift.managerConfirmed" class="ss-ok">店长已确认完工</text>
          <text v-if="shift.note" class="ss-muted">{{ shift.note }}</text>
        </view>

        <view class="shift-actions">
          <button v-if="shift.status === 'invited'" class="btn-ghost small danger" @tap="cancel(shift)">取消邀约</button>
          <button v-if="shift.status === 'confirmed'" class="btn-ghost small" @tap="noShow(shift)">标记缺席</button>
          <button v-if="shift.status === 'confirmed'" class="btn-ghost small danger" @tap="cancel(shift)">取消班次</button>
          <button v-if="shift.status === 'completed' && !shift.managerConfirmed" class="btn-ghost small ok" @tap="confirmCompletion(shift)">确认完工</button>
          <text v-if="shift.status === 'checked_in'" class="ss-sub">服务中，等待兼职签退</text>
        </view>
      </view>

      <view v-if="filter === 'exceptions'" class="ss-card">
        <view class="ss-title">异常处理</view>
        <view v-if="!exceptions.length" class="empty">暂无异常记录</view>
        <view v-for="exc in exceptions" :key="exc.id" class="exc-row">
          <view>
            <text class="exc-type">{{ exc.type }}</text>
            <text class="ss-sub">{{ exc.message }}</text>
            <text class="ss-sub">{{ fmtDateTime(exc.createdAt) }} · {{ exc.status === 'open' ? '待处理' : '已处理' }}</text>
          </view>
          <button v-if="exc.status === 'open'" class="btn-ghost small" @tap="resolve(exc.id)">标记处理</button>
        </view>
      </view>
    </template>

    <BottomNav role="manager" current="records" />
  </view>
</template>

<script setup lang="ts">
import { computed, onUnmounted, ref } from 'vue';
import { onPullDownRefresh, onShow } from '@dcloudio/uni-app';
import BottomNav from '../../components/BottomNav.vue';
import { requireRole, request, toast } from '../../api/client';
import type { AssignmentView, ExceptionItem, Shift } from '../../api/types';
import { SHIFT_STATUS, countdown, fmtDate, fmtDateTime, fmtRange, fmtTime, minutesLabel } from '../../api/format';

const assignments = ref<AssignmentView | null>(null);
const exceptions = ref<ExceptionItem[]>([]);
const managerCode = ref('');
const notifications = ref<Array<{ id: string; title: string; body: string; read: boolean; createdAt: number }>>([]);
const demands = ref<AssignmentView['demands']>([]);
const loading = ref(true);
const filter = ref<'pending' | 'upcoming' | 'confirmed' | 'checkedIn' | 'completed' | 'exceptions'>('pending');
const nowOffset = ref(0);
const tick = ref(0);

const tabs = [
  { key: 'pending' as const, label: '待接受' },
  { key: 'upcoming' as const, label: '即将到店' },
  { key: 'confirmed' as const, label: '已确认' },
  { key: 'checkedIn' as const, label: '服务中' },
  { key: 'completed' as const, label: '已完成' },
  { key: 'exceptions' as const, label: '异常' },
];

const items = computed(() => {
  const data = assignments.value;
  if (!data) return [];
  switch (filter.value) {
    case 'pending': return data.items.filter((s) => s.status === 'invited');
    case 'upcoming': {
      const now = Date.now() + nowOffset.value;
      return data.items.filter((s) => s.status === 'confirmed' && s.startAt - now <= 60 * 60_000 && s.endAt > now);
    }
    case 'confirmed': return data.items.filter((s) => s.status === 'confirmed');
    case 'checkedIn': return data.items.filter((s) => s.status === 'checked_in');
    case 'completed': return data.items.filter((s) => s.status === 'completed');
    default: return data.items.filter((s) => s.status === 'no_show' || s.status === 'cancelled');
  }
});
const filtered = computed(() => (filter.value === 'exceptions' ? [] : items.value));

let timer: ReturnType<typeof setInterval> | null = null;

onShow(() => {
  if (!requireRole('manager')) return;
  void load();
  if (!timer) timer = setInterval(() => { tick.value += 1; }, 15000);
});

onUnmounted(() => { if (timer) clearInterval(timer); });
onPullDownRefresh(async () => { await load(); uni.stopPullDownRefresh(); });

function countOf(key: string) {
  const g = assignments.value?.groups;
  if (!g) return 0;
  if (key === 'exceptions') return g.exceptions + exceptions.value.filter((e) => e.status === 'open').length;
  if (key === 'upcoming') {
    const now = Date.now() + nowOffset.value;
    const all = assignments.value?.items ?? [];
    return all.filter((s) => s.status === 'confirmed' && s.startAt - now <= 60 * 60_000 && s.endAt > now).length;
  }
  return (g as unknown as Record<string, number>)[key] ?? 0;
}

function statusClass(status: string) {
  if (status === 'completed') return 'ok';
  if (status === 'no_show' || status === 'cancelled') return 'bad';
  if (status === 'checked_in') return 'accent';
  return '';
}
function offerLabel(shift: Shift) {
  const map: Record<string, string> = { pending: '待回应', accepted: '已接受', rejected: '已拒绝', expired: '已超时', cancelled: '已撤销' };
  return shift.offer ? map[shift.offer.status] ?? shift.offer.status : '—';
}
function currentNow() {
  void tick.value;
  return Date.now() + nowOffset.value;
}
function countdownText(expiresAt: number) {
  return countdown(expiresAt, currentNow());
}

async function load() {
  loading.value = true;
  try {
    const [asg, exc, notes] = await Promise.all([
      request<AssignmentView>('/manager/assignments'),
      request<ExceptionItem[]>('/manager/exceptions'),
      request<Array<{ id: string; title: string; body: string; read: boolean; createdAt: number }>>('/manager/notifications'),
    ]);
    assignments.value = asg;
    demands.value = asg.demands ?? [];
    exceptions.value = exc;
    notifications.value = notes;
    nowOffset.value = asg.now - Date.now();
    try {
      const store = await request<{ store: { managerCode: string } }>('/manager/store');
      managerCode.value = store.store.managerCode;
    } catch { /* ignore */ }
  } catch (err) {
    toast(err instanceof Error ? err.message : '加载失败');
  } finally {
    loading.value = false;
  }
}

function copyCode() {
  uni.setClipboardData({ data: managerCode.value, success: () => toast('签到码已复制') });
}

async function approveBackfill(id: string) {
  uni.showModal({
    title: '确认超出预算的候补',
    content: '系统找到可用候补，但其期望报酬高于原方案预算。确认后将向其发出邀约，仍需本人接受才计入已确认。',
    confirmText: '确认邀约',
    success: async (res) => {
      if (!res.confirm) return;
      try {
        await request(`/manager/backfill/${id}/approve`, { method: 'POST', data: {} });
        toast('已向候补发出邀约');
        await load();
      } catch (err) { toast(err instanceof Error ? err.message : '操作失败'); }
    },
  });
}

function timeRange(start: number, end: number) {
  return `${fmtDate(start)} ${fmtRange(start, end)}`;
}
function backfillLabel(status: string) {
  const map: Record<string, string> = {
    pending: '匹配中',
    offered: '已发邀约，等待接受',
    filled: '已补齐',
    no_candidate: '无人可接，需人工',
    needs_approval: '超出预算，需店长确认',
    cancelled: '已取消',
  };
  return map[status] ?? status;
}

function cancel(shift: Shift) {
  const options = shift.demandId
    ? [
        { label: '取消该员工（自动候补）', scope: 'person' as const },
        { label: '取消整个用工需求（不补人）', scope: 'demand' as const },
      ]
    : [{ label: '取消该班次', scope: 'person' as const }];
  uni.showActionSheet({
    itemList: options.map((o) => o.label),
    success: (picked) => {
      const option = options[picked.tapIndex];
      if (!option) return;
      const isDemand = option.scope === 'demand';
      uni.showModal({
        title: isDemand ? '取消整个用工需求' : '取消班次',
        content: isDemand
          ? `将取消 ${fmtRange(shift.startAt, shift.endAt)} 的全部在途班次，并且不会自动补人。确认？`
          : `取消 ${shift.staffName} 的 ${fmtRange(shift.startAt, shift.endAt)} 班次，系统将按规则自动寻找候补。`,
        success: async (res) => {
          if (!res.confirm) return;
          try {
            await request(`/manager/assignments/${shift.id}/cancel`, {
              method: 'POST',
              data: { reason: isDemand ? '店长取消整个用工需求' : '店长取消该员工', scope: option.scope },
            });
            toast(isDemand ? '需求已取消' : '已取消，正在候补');
            await load();
          } catch (err) { toast(err instanceof Error ? err.message : '操作失败'); }
        },
      });
    },
  });
}

function noShow(shift: Shift) {
  uni.showModal({
    title: '标记缺席',
    content: `确认 ${shift.staffName} 未到店？将记录缺席并生成异常。`,
    success: async (res) => {
      if (!res.confirm) return;
      try {
        await request(`/manager/assignments/${shift.id}/no-show`, { method: 'POST', data: { note: '店长标记缺席' } });
        toast('已标记缺席');
        await load();
      } catch (err) { toast(err instanceof Error ? err.message : '操作失败'); }
    },
  });
}

async function confirmCompletion(shift: Shift) {
  try {
    await request(`/manager/assignments/${shift.id}/confirm-completion`, { method: 'POST', data: {} });
    toast('已确认完工', 'success');
    await load();
  } catch (err) { toast(err instanceof Error ? err.message : '操作失败'); }
}

async function markAllRead() {
  try {
    await request('/manager/notifications/read', { method: 'POST', data: {} });
    notifications.value = notifications.value.map((n) => ({ ...n, read: true }));
    toast('已全部标记为已读');
  } catch (err) {
    toast(err instanceof Error ? err.message : '操作失败');
  }
}

async function resolve(id: string) {
  try {
    await request(`/manager/exceptions/${id}/resolve`, { method: 'POST', data: {} });
    toast('已标记处理');
    await load();
  } catch (err) { toast(err instanceof Error ? err.message : '操作失败'); }
}
</script>

<style scoped>
.code-card { display: flex; justify-content: space-between; align-items: center; padding: 22rpx 26rpx; border-radius: 22rpx; background: rgba(216, 255, 79, 0.08); border: 1rpx solid rgba(216, 255, 79, 0.3); margin-bottom: 22rpx; }
.code-label { display: block; font-size: 21rpx; color: var(--ss-muted); margin-bottom: 4rpx; }
.code-value { font-size: 40rpx; font-weight: 900; letter-spacing: 4rpx; color: var(--ss-accent); }
.filter-tabs { display: flex; gap: 8rpx; overflow-x: auto; margin-bottom: 20rpx; padding-bottom: 4rpx; }
.filter-tab { flex-shrink: 0; display: flex; align-items: center; gap: 6rpx; padding: 14rpx 20rpx; border-radius: 999rpx; border: 1rpx solid var(--ss-line); color: var(--ss-muted); font-size: 23rpx; }
.filter-tab.active { background: var(--ss-accent); border-color: var(--ss-accent); color: var(--ss-accent-ink); font-weight: 700; }
.tab-count { font-size: 19rpx; opacity: 0.75; }
.demand-summary { display: flex; flex-direction: column; gap: 12rpx; margin-bottom: 18rpx; }
.demand-card { padding: 20rpx 24rpx; margin-bottom: 0; border-color: rgba(216, 255, 79, 0.25); }
.demand-title { display: block; font-size: 26rpx; font-weight: 800; }
.backfill-line { display: flex; justify-content: space-between; gap: 10rpx; margin-top: 10rpx; padding-top: 10rpx; border-top: 1rpx solid var(--ss-line); font-size: 21rpx; color: var(--ss-warn); }
.shift-card { padding: 24rpx; }
.staff-name { font-size: 28rpx; font-weight: 700; }
.pay { color: var(--ss-accent); font-size: 23rpx; font-weight: 700; }
.shift-meta { display: flex; flex-direction: column; gap: 8rpx; margin-top: 18rpx; padding: 16rpx; border-radius: 14rpx; background: var(--ss-panel-2); font-size: 22rpx; color: var(--ss-muted); }
.shift-actions { display: flex; gap: 12rpx; margin-top: 16rpx; justify-content: flex-end; flex-wrap: wrap; }
.exc-row { display: flex; justify-content: space-between; align-items: flex-start; gap: 16rpx; padding: 18rpx 0; border-bottom: 1rpx solid var(--ss-line); }
.exc-row:last-child { border-bottom: none; }
.notice-card { padding: 20rpx 24rpx; }
.mark-read { color: var(--ss-accent); font-size: 22rpx; }
.notice-row { display: flex; gap: 12rpx; padding: 12rpx 0; border-bottom: 1rpx solid var(--ss-line); align-items: flex-start; }
.notice-row:last-child { border-bottom: none; }
.notice-dot { width: 10rpx; height: 10rpx; border-radius: 50%; margin-top: 14rpx; background: var(--ss-line); flex-shrink: 0; }
.notice-dot.unread { background: var(--ss-accent); }
.notice-main { flex: 1; min-width: 0; }
.notice-title { display: block; font-size: 23rpx; font-weight: 700; margin-bottom: 2rpx; }
.notice-time { font-size: 19rpx; color: var(--ss-muted); }
.exc-type { display: block; font-size: 24rpx; font-weight: 700; color: var(--ss-warn); margin-bottom: 4rpx; }
</style>
