<template>
  <view class="ss-page">
    <view v-if="loading" class="empty">正在读取工作邀约…</view>
    <template v-else>
      <view class="staff-head">
        <view>
          <text class="hello">你好，{{ profile?.nickname || '兼职伙伴' }}</text>
          <text class="ss-sub">{{ storeName }} · {{ nowLabel }}</text>
        </view>
        <view class="status-pill" :class="profile?.status === 'approved' ? 'ok' : 'warn'">
          {{ profile ? STAFF_STATUS[profile.status] || profile.status : '未注册' }}
        </view>
      </view>

      <view v-if="profile && profile.status !== 'approved'" class="ss-card warn-card">
        <view class="ss-title">资料{{ STAFF_STATUS[profile.status] || '审核中' }}</view>
        <text class="ss-sub">
          {{ profile.qualified ? '岗位培训已合格，等待管理员通过审核后即可接单。' : '管理员审核并完成岗位培训后，你才能收到工作邀约。' }}
        </text>
        <button class="btn-ghost small" @tap="goAvailability">完善我的资料与可用时间</button>
      </view>

      <view v-if="pending.length" class="section-label">
        <text>待回应</text>
        <text class="ss-pill warn">{{ pending.length }} 个</text>
      </view>

      <view v-for="offer in pending" :key="offer.id" class="offer-card pending">
        <view class="ss-spread">
          <view>
            <text class="store-name">{{ offer.store.name }}</text>
            <text class="ss-sub">{{ offer.store.address }}</text>
          </view>
          <text class="ss-pill warn">{{ countdownText(offer.expiresAt) }}</text>
        </view>
        <view class="offer-grid">
          <view class="offer-cell"><text class="cell-label">工作时间</text><text class="cell-value">{{ fmtDate(offer.shift.startAt) }}</text><text class="cell-value">{{ fmtRange(offer.shift.startAt, offer.shift.endAt) }}</text></view>
          <view class="offer-cell"><text class="cell-label">工作内容</text><text class="cell-value">{{ offer.shift.role }}</text></view>
          <view class="offer-cell"><text class="cell-label">预计报酬</text><text class="cell-value accent">¥{{ offer.payEstimate }}</text></view>
          <view class="offer-cell"><text class="cell-label">时薪</text><text class="cell-value">¥{{ offer.shift.hourlyRate }}/h</text></view>
        </view>
        <text class="ss-sub offer-note">接受后班次才正式确认。超时未回应会自动顺延给下一位候选。</text>
        <view class="offer-actions">
          <button class="btn-ghost danger" @tap="reject(offer)">拒绝</button>
          <button class="btn-primary" :disabled="acting" @tap="accept(offer)">{{ acting ? '处理中…' : '接受邀约' }}</button>
        </view>
      </view>

      <view class="section-label"><text>历史邀约</text></view>
      <view v-if="!history.length" class="ss-card"><view class="empty">暂无历史邀约。收到邀约后会显示在这里。</view></view>
      <view v-for="offer in history" :key="offer.id" class="ss-card history-card">
        <view class="ss-spread">
          <view>
            <text class="history-store">{{ offer.store.name }}</text>
            <text class="ss-sub">{{ fmtDate(offer.shift.startAt) }} {{ fmtRange(offer.shift.startAt, offer.shift.endAt) }} · {{ offer.shift.role }}</text>
          </view>
          <text class="ss-pill" :class="offer.status === 'accepted' ? 'ok' : offer.status === 'pending' ? 'warn' : ''">{{ OFFER_STATUS[offer.status] || offer.status }}</text>
        </view>
      </view>
    </template>

    <BottomNav role="staff" current="offers" :badges="{ offers: pending.length }" />
  </view>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import { onPullDownRefresh, onShow } from '@dcloudio/uni-app';
import BottomNav from '../../components/BottomNav.vue';
import { requireRole, request, toast } from '../../api/client';
import type { StaffOffer, StaffProfile } from '../../api/types';
import { OFFER_STATUS, STAFF_STATUS, countdown, fmtDate, fmtRange, fmtTime } from '../../api/format';

const offers = ref<StaffOffer[]>([]);
const profile = ref<StaffProfile | null>(null);
const storeName = ref('');
const loading = ref(true);
const acting = ref(false);
const nowOffset = ref(0);
const tick = ref(0);

const pending = computed(() => offers.value.filter((o) => o.status === 'pending'));
const history = computed(() => offers.value.filter((o) => o.status !== 'pending'));
const nowLabel = computed(() => fmtTime(Date.now() + nowOffset.value));

onShow(() => {
  if (!requireRole('staff')) return;
  void load();
});
onPullDownRefresh(async () => { await load(); uni.stopPullDownRefresh(); });

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
    const [me, data] = await Promise.all([
      request<{ staff: StaffProfile; store: { name: string } }>('/staff/me'),
      request<{ items: StaffOffer[]; now: number }>('/staff/offers'),
    ]);
    profile.value = me.staff;
    storeName.value = me.store.name;
    offers.value = data.items.filter((o): o is StaffOffer => Boolean(o));
    nowOffset.value = data.now - Date.now();
  } catch (err) {
    toast(err instanceof Error ? err.message : '加载失败');
  } finally {
    loading.value = false;
  }
}

function goAvailability() {
  uni.reLaunch({ url: '/pages/staff/availability' });
}

function accept(offer: StaffOffer) {
  uni.showModal({
    title: '接受工作邀约',
    content: `${offer.store.name}\n${fmtRange(offer.shift.startAt, offer.shift.endAt)} · ${offer.shift.role}\n预计报酬 ¥${offer.payEstimate}`,
    confirmText: '接受',
    success: async (res) => {
      if (!res.confirm) return;
      acting.value = true;
      try {
        await request(`/staff/offers/${offer.id}/accept`, { method: 'POST', data: {} });
        toast('已接受，班次已确认', 'success');
        await load();
      } catch (err) {
        toast(err instanceof Error ? err.message : '接单失败');
        await load();
      } finally {
        acting.value = false;
      }
    },
  });
}

function reject(offer: StaffOffer) {
  const reasons = ['时间冲突', '距离太远', '临时有事', '身体不适'];
  uni.showActionSheet({
    itemList: reasons,
    success: async (res) => {
      const reason = reasons[res.tapIndex] ?? '本人拒绝';
      try {
        await request(`/staff/offers/${offer.id}/reject`, { method: 'POST', data: { reason } });
        toast('已拒绝，系统将顺延给下一位候选');
        await load();
      } catch (err) {
        toast(err instanceof Error ? err.message : '操作失败');
        await load();
      }
    },
  });
}
</script>

<style scoped>
.staff-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 24rpx; }
.hello { display: block; font-size: 38rpx; font-weight: 800; margin-bottom: 6rpx; }
.status-pill { padding: 8rpx 18rpx; border-radius: 999rpx; font-size: 21rpx; border: 1rpx solid var(--ss-line); }
.status-pill.ok { color: var(--ss-ok); border-color: rgba(100, 230, 162, 0.4); }
.status-pill.warn { color: var(--ss-warn); border-color: rgba(255, 184, 77, 0.4); }
.warn-card { border-color: rgba(255, 184, 77, 0.35); }
.warn-card .btn-ghost { margin-top: 16rpx; }
.section-label { display: flex; justify-content: space-between; align-items: center; font-size: 26rpx; font-weight: 700; margin: 12rpx 0 16rpx; color: var(--ss-muted); }
.offer-card { background: linear-gradient(150deg, rgba(216, 255, 79, 0.1), transparent 55%), var(--ss-panel); border: 1rpx solid rgba(216, 255, 79, 0.38); border-radius: 26rpx; padding: 26rpx; margin-bottom: 22rpx; }
.store-name { display: block; font-size: 31rpx; font-weight: 800; margin-bottom: 4rpx; }
.offer-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14rpx; margin: 20rpx 0; }
.offer-cell { background: var(--ss-panel-2); border-radius: 14rpx; padding: 14rpx 16rpx; }
.cell-label { display: block; font-size: 19rpx; color: var(--ss-muted); margin-bottom: 4rpx; }
.cell-value { display: block; font-size: 24rpx; font-weight: 700; }
.cell-value.accent { color: var(--ss-accent); }
.offer-note { display: block; margin-bottom: 18rpx; }
.offer-actions { display: flex; gap: 14rpx; }
.offer-actions .btn-ghost { flex: 0 0 190rpx; min-height: 88rpx; }
.offer-actions .btn-primary { flex: 1; min-height: 88rpx; }
.history-card { padding: 22rpx; }
.history-store { display: block; font-size: 26rpx; font-weight: 700; }
</style>
