<template>
  <view class="ss-page">
    <view v-if="loading" class="empty">正在读取全城缺位…</view>
    <template v-else>
      <view class="page-head">
        <view>
          <text class="page-title">缺位广场</text>
          <text class="ss-sub">不同门店的空缺班次，可直接申请</text>
        </view>
        <text class="ss-pill ok">{{ opportunities.length }} 个机会</text>
      </view>

      <view class="tabs">
        <view class="tab" :class="{ active: tab === 'market' }" @tap="tab = 'market'">缺位广场</view>
        <view class="tab" :class="{ active: tab === 'applications' }" @tap="tab = 'applications'">我的申请</view>
      </view>

      <template v-if="tab === 'market'">
        <view v-if="!opportunities.length" class="ss-card"><view class="empty">当前没有开放缺位。门店发布需求后会出现在这里。</view></view>
        <view v-for="o in opportunities" :key="o.id" class="ss-card opp">
          <view class="ss-spread">
            <view>
              <view class="row-title"><text class="store-name">{{ o.store.name }}</text><text v-if="!o.store.isHomeStore" class="pill-cross">跨店</text><text v-else class="ss-pill">本店</text></view>
              <text class="ss-sub">{{ o.store.address }}</text>
            </view>
            <text class="ss-pill warn">缺 {{ o.unfilled }}/{{ o.headcount }}</text>
          </view>
          <view class="info-grid">
            <view><text class="label">日期</text><text class="value">{{ fmtDate(o.startAt) }}</text></view>
            <view><text class="label">时间</text><text class="value">{{ fmtRange(o.startAt, o.endAt) }}</text></view>
            <view><text class="label">岗位</text><text class="value">{{ o.role }}</text></view>
            <view><text class="label">时薪</text><text class="value accent">¥{{ o.hourlyRate }}/h</text></view>
            <view><text class="label">预计报酬</text><text class="value">¥{{ o.payEstimate }}</text></view>
            <view><text class="label">状态</text><text class="value">{{ o.application ? STATUS[o.application.status] || o.application.status : '可申请' }}</text></view>
          </view>
          <text v-if="o.reason" class="reason">{{ o.reason }}</text>
          <button v-if="o.canApply" class="btn-primary" :disabled="acting" @tap="apply(o)">{{ acting ? '提交中…' : '申请这个缺位' }}</button>
          <button v-else-if="o.application && o.application.status === 'pending'" class="btn-ghost" @tap="tab = 'applications'">查看我的申请</button>
          <button v-else-if="o.application && o.application.status === 'approved'" class="btn-primary" @tap="goShifts">已通过，查看班次</button>
        </view>
      </template>

      <template v-else>
        <view v-if="!applications.length" class="ss-card"><view class="empty">还没有申请。去缺位广场看看不同门店的机会。</view></view>
        <view v-for="a in applications" :key="a.id" class="ss-card">
          <view class="ss-spread">
            <view><text class="store-name">{{ a.store.name }}</text><text class="ss-sub">{{ a.role }} · {{ fmtDate(a.startAt) }} {{ fmtRange(a.startAt, a.endAt) }}</text></view>
            <text class="ss-pill" :class="a.status === 'approved' ? 'ok' : a.status === 'pending' ? 'warn' : ''">{{ STATUS[a.status] || a.status }}</text>
          </view>
          <text v-if="a.decisionNote" class="reason">{{ a.decisionNote }}</text>
          <view class="row-actions">
            <button v-if="a.status === 'approved'" class="btn-ghost" @tap="goShifts">查看班次</button>
            <button v-if="a.status === 'pending'" class="btn-ghost danger" @tap="withdraw(a)">撤回申请</button>
          </view>
        </view>
      </template>
    </template>
    <BottomNav role="staff" current="market" :badges="{ market: pendingApplications }" />
  </view>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import { onPullDownRefresh, onShow } from '@dcloudio/uni-app';
import BottomNav from '../../components/BottomNav.vue';
import { requireRole, request, toast } from '../../api/client';
import { fmtDate, fmtRange } from '../../api/format';

interface Opportunity {
  id: string; role: string; startAt: number; endAt: number; hourlyRate: number; headcount: number; unfilled: number; payEstimate: number;
  canApply: boolean; reason: string | null; application: { id: string; status: string } | null;
  store: { id: string; name: string; address: string; isHomeStore: boolean };
}
interface Application {
  id: string; status: string; decisionNote: string | null; role: string; startAt: number; endAt: number;
  store: { name: string };
}
const STATUS: Record<string, string> = { pending: '待处理', approved: '已通过', rejected: '未通过', withdrawn: '已撤回' };
const opportunities = ref<Opportunity[]>([]);
const applications = ref<Application[]>([]);
const loading = ref(true);
const acting = ref(false);
const tab = ref<'market' | 'applications'>('market');
const pendingApplications = computed(() => applications.value.filter((a) => a.status === 'pending').length);

onShow(() => { if (requireRole('staff')) void load(); });
onPullDownRefresh(async () => { await load(); uni.stopPullDownRefresh(); });

async function load() {
  loading.value = true;
  try {
    const [market, mine] = await Promise.all([
      request<{ items: Opportunity[] }>('/staff/opportunities'),
      request<{ items: Application[] }>('/staff/applications'),
    ]);
    opportunities.value = market.items;
    applications.value = mine.items;
  } catch (err) { toast(err instanceof Error ? err.message : '加载失败'); }
  finally { loading.value = false; }
}

async function apply(o: Opportunity) {
  acting.value = true;
  try {
    await request(`/staff/opportunities/${o.id}/apply`, { method: 'POST', data: {} });
    toast('申请已提交，等待门店处理');
    await load();
  } catch (err) { toast(err instanceof Error ? err.message : '申请失败'); }
  finally { acting.value = false; }
}

async function withdraw(a: Application) {
  const res = await uni.showModal({ title: '撤回申请', content: '撤回后可以重新申请该缺位。', confirmText: '撤回' });
  if (!res.confirm) return;
  try { await request(`/staff/applications/${a.id}/withdraw`, { method: 'POST', data: {} }); toast('已撤回'); await load(); }
  catch (err) { toast(err instanceof Error ? err.message : '撤回失败'); }
}

function goShifts() { uni.reLaunch({ url: '/pages/staff/shifts' }); }
</script>

<style scoped>
.page-head { display: flex; justify-content: space-between; align-items: flex-start; margin: 8rpx 0 20rpx; }
.page-title { display: block; font-size: 44rpx; font-weight: 800; }
.tabs { display: flex; gap: 8rpx; padding: 6rpx; border: 1px solid var(--ss-line); border-radius: 18rpx; margin-bottom: 18rpx; }
.tab { flex: 1; text-align: center; padding: 14rpx; color: var(--ss-muted); font-size: 24rpx; border-radius: 12rpx; }
.tab.active { background: var(--ss-accent); color: #0b0d0c; font-weight: 800; }
.opp { display: flex; flex-direction: column; gap: 16rpx; }
.row-title { display: flex; align-items: center; gap: 10rpx; }
.pill-cross { font-size: 18rpx; padding: 2rpx 10rpx; border-radius: 999rpx; background: rgba(217,255,87,.12); color: var(--ss-accent); }
.info-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12rpx; }
.info-grid .label { display: block; color: var(--ss-muted); font-size: 20rpx; }
.info-grid .value { display: block; font-size: 25rpx; margin-top: 4rpx; }
.reason { color: var(--ss-muted); font-size: 22rpx; }
.row-actions { display: flex; justify-content: flex-end; margin-top: 12rpx; }
</style>
