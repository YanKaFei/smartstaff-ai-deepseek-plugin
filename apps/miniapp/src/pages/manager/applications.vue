<template>
  <view class="ss-page">
    <view v-if="loading" class="empty">正在读取兼职申请…</view>
    <template v-else>
      <view class="page-head">
        <view>
          <text class="page-title">兼职申请</text>
          <text class="ss-sub">跨店缺位申请 · 门店审核后生成正式班次</text>
        </view>
        <text class="ss-pill warn">{{ pending.length }} 待处理</text>
      </view>

      <view v-if="!items.length" class="ss-card"><view class="empty">还没有兼职申请。发布缺位后会收到申请。</view></view>
      <view v-for="a in items" :key="a.id" class="ss-card">
        <view class="ss-spread">
          <view>
            <text class="store-name">{{ a.staff.nickname }}</text>
            <text class="ss-sub">{{ a.staff.area }} · 准时率 {{ Math.round(a.staff.onTimeRate * 100) }}% · 已完成 {{ a.staff.shiftsCompleted }} 班</text>
          </view>
          <text class="ss-pill" :class="a.status === 'approved' ? 'ok' : a.status === 'pending' ? 'warn' : ''">{{ STATUS[a.status] || a.status }}</text>
        </view>
        <view class="info-grid">
          <view><text class="label">岗位</text><text class="value">{{ a.role }}</text></view>
          <view><text class="label">日期</text><text class="value">{{ fmtDate(a.startAt) }}</text></view>
          <view><text class="label">时间</text><text class="value">{{ fmtRange(a.startAt, a.endAt) }}</text></view>
          <view><text class="label">时薪</text><text class="value">¥{{ a.hourlyRate }}/h</text></view>
          <view><text class="label">缺位</text><text class="value">{{ a.demand?.unfilled }}/{{ a.demand?.headcount }}</text></view>
          <view><text class="label">申请时间</text><text class="value">{{ fmtDate(a.createdAt) }}</text></view>
        </view>
        <text v-if="a.note" class="reason">申请备注：{{ a.note }}</text>
        <view v-if="a.status === 'pending'" class="actions">
          <button class="btn-ghost danger" :disabled="acting" @tap="decide(a, 'rejected')">拒绝</button>
          <button class="btn-primary" :disabled="acting" @tap="decide(a, 'approved')">{{ acting ? '处理中…' : '通过并生成班次' }}</button>
        </view>
      </view>
    </template>
    <BottomNav role="manager" current="applications" :badges="{ applications: pending.length }" />
  </view>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import { onPullDownRefresh, onShow } from '@dcloudio/uni-app';
import BottomNav from '../../components/BottomNav.vue';
import { requireRole, request, toast } from '../../api/client';
import { fmtDate, fmtRange } from '../../api/format';

interface Application {
  id: string; status: string; note: string; role: string; startAt: number; endAt: number; hourlyRate: number; createdAt: number;
  demand: { unfilled: number; headcount: number } | null;
  staff: { nickname: string; area: string; onTimeRate: number; shiftsCompleted: number };
}
const STATUS: Record<string, string> = { pending: '待处理', approved: '已通过', rejected: '已拒绝', withdrawn: '已撤回' };
const items = ref<Application[]>([]);
const loading = ref(true);
const acting = ref(false);
const pending = computed(() => items.value.filter((a) => a.status === 'pending'));

onShow(() => { if (requireRole('manager')) void load(); });
onPullDownRefresh(async () => { await load(); uni.stopPullDownRefresh(); });

async function load() {
  loading.value = true;
  try { const data = await request<{ items: Application[] }>('/manager/applications'); items.value = data.items; }
  catch (err) { toast(err instanceof Error ? err.message : '加载失败'); }
  finally { loading.value = false; }
}

async function decide(a: Application, decision: 'approved' | 'rejected') {
  const verb = decision === 'approved' ? '通过' : '拒绝';
  const res = await uni.showModal({ title: `${verb}申请`, content: `确认${verb} ${a.staff.nickname} 的申请？`, confirmText: verb });
  if (!res.confirm) return;
  acting.value = true;
  try {
    await request(`/manager/applications/${a.id}/${decision}`, { method: 'POST', data: { note: decision === 'approved' ? '门店已通过' : '岗位暂不匹配' } });
    toast(decision === 'approved' ? '已通过并生成班次' : '已拒绝');
    await load();
  } catch (err) { toast(err instanceof Error ? err.message : '操作失败'); }
  finally { acting.value = false; }
}
</script>

<style scoped>
.page-head { display: flex; justify-content: space-between; align-items: flex-start; margin: 8rpx 0 20rpx; }
.page-title { display: block; font-size: 44rpx; font-weight: 800; }
.info-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12rpx; margin-top: 14rpx; }
.info-grid .label { display: block; color: var(--ss-muted); font-size: 20rpx; }
.info-grid .value { display: block; font-size: 25rpx; margin-top: 4rpx; }
.reason { display: block; margin-top: 8rpx; color: var(--ss-muted); font-size: 22rpx; }
.actions { display: flex; justify-content: flex-end; gap: 12rpx; margin-top: 14rpx; }
</style>
