<template>
  <view class="ss-page">
    <view v-if="loading" class="empty">正在读取兼职资料…</view>
    <template v-else>
      <view class="profile-head">
        <view class="avatar big">{{ form.nickname.slice(0, 1) || '兼' }}</view>
        <view class="profile-main">
          <view class="ss-row">
            <text class="name">{{ form.nickname }}</text>
            <text class="ss-pill" :class="profile?.status === 'approved' ? 'ok' : 'warn'">{{ STAFF_STATUS[profile?.status || 'pending'] }}</text>
          </view>
          <text class="ss-sub">{{ storeName }} · {{ profile?.qualified ? '岗位培训合格' : '待完成岗位培训' }}</text>
        </view>
      </view>

      <view v-if="profile && profile.status !== 'approved'" class="ss-card warn-card">
        <text class="ss-sub">资料通过审核并完成烤肉辅助岗位培训后，系统才会把你纳入自动匹配。可用时间填写得越完整，被匹配的机会越大。</text>
      </view>

      <view class="ss-card">
        <view class="ss-title">个人资料</view>
        <view class="field"><text class="label">昵称</text><input v-model="form.nickname" maxlength="20" /></view>
        <view class="field"><text class="label">所在区域</text><input v-model="form.area" placeholder="科技园" maxlength="30" /></view>
        <view class="field"><text class="label">距门店距离</text><view class="ss-row"><input v-model.number="form.distanceKm" type="digit" class="num" /><text class="unit">km</text></view></view>
        <view class="field"><text class="label">期望时薪</text><view class="ss-row"><text class="ss-muted">¥</text><input v-model.number="form.expectedRate" type="digit" class="num" /><text class="unit">/小时</text></view></view>
        <view class="field"><text class="label">烤肉经验</text><view class="ss-row"><input v-model.number="form.experienceYears" type="digit" class="num" /><text class="unit">年</text></view></view>
        <view class="field"><text class="label">可服务岗位</text><text class="ss-pill accent">{{ form.skills.join(' / ') }}</text></view>
        <view class="field bio-field">
          <text class="label">个人简介</text>
          <textarea v-model="form.bio" class="bio-input" maxlength="160" placeholder="例如：熟悉换篦子、补炭与高峰翻台配合" />
        </view>
        <button class="btn-primary" :disabled="saving" @tap="saveProfile">{{ saving ? '保存中…' : '保存个人资料' }}</button>
      </view>

      <view class="ss-card">
        <view class="ss-title">
          <text>每周可用时间</text>
          <text class="ss-pill">{{ windows.length }} 段</text>
        </view>
        <text class="ss-sub avail-tip">只有覆盖完整班次（含到店路程与 15 分钟通知时间）才会收到邀约。可设置跨午夜时段，例如 17:00 - 02:00。</text>

        <view v-if="!windows.length" class="empty">还没有可用时间，添加后才能被匹配。</view>
        <view v-for="(w, idx) in windows" :key="idx" class="window-row">
          <text class="window-day">{{ WEEKDAYS[w.weekday] }}</text>
          <text class="window-time">{{ minToHHMM(w.startMin) }} - {{ minToHHMM(w.endMin) }}</text>
          <text v-if="w.endMin < w.startMin" class="ss-pill">跨午夜</text>
          <text class="remove" @tap="removeWindow(idx)">删除</text>
        </view>

        <view class="add-panel">
          <view class="add-head">添加时间段</view>
          <view class="add-row">
            <picker mode="selector" :range="WEEKDAYS" :value="weekday" @change="(e: any) => (weekday = Number(e.detail.value))">
              <view class="picker-chip">{{ WEEKDAYS[weekday] }}</view>
            </picker>
            <picker mode="time" :value="startTime" @change="(e: any) => (startTime = e.detail.value)">
              <view class="picker-chip">{{ startTime }}</view>
            </picker>
            <text class="ss-muted">至</text>
            <picker mode="time" :value="endTime" @change="(e: any) => (endTime = e.detail.value)">
              <view class="picker-chip">{{ endTime }}</view>
            </picker>
            <button class="btn-ghost small accent" @tap="addWindow">添加</button>
          </view>
        </view>

        <view class="preset-row">
          <text class="ss-sub">快捷添加：</text>
          <text class="preset" @tap="preset('evening')">今晚 17:00-23:00</text>
          <text class="preset" @tap="preset('weekend')">本周末 11:00-21:00</text>
        </view>

        <button class="btn-primary avail-save" :disabled="savingAvailability" @tap="saveAvailability">
          {{ savingAvailability ? '保存中…' : '保存可用时间' }}
        </button>
      </view>

      <view class="ss-card">
        <view class="ss-title">匹配规则</view>
        <text class="ss-sub">系统先按硬性条件过滤：时间覆盖、无班次冲突、岗位资格、能否按时到店；再按距离、历史准点率、经验与用工成本排序，生成经济方案和保障方案。同一人不会被派往重叠时段。</text>
      </view>

      <button class="btn-ghost btn-block logout-btn" @tap="logout">退出登录</button>
    </template>

    <BottomNav role="staff" current="availability" />
  </view>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import { onShow } from '@dcloudio/uni-app';
import BottomNav from '../../components/BottomNav.vue';
import { clearSession, requireRole, request, toast } from '../../api/client';
import type { AvailabilityWindow, StaffProfile } from '../../api/types';
import { STAFF_STATUS, WEEKDAYS } from '../../api/format';

const loading = ref(true);
const saving = ref(false);
const savingAvailability = ref(false);
const profile = ref<StaffProfile | null>(null);
const storeName = ref('');
const windows = ref<AvailabilityWindow[]>([]);
const weekday = ref(Math.min(6, new Date().getDay()));
const startTime = ref('17:00');
const endTime = ref('23:00');
const form = ref({
  nickname: '',
  area: '',
  distanceKm: 2,
  expectedRate: 32,
  experienceYears: 0,
  skills: ['烤肉辅助'] as string[],
  bio: '',
});

onShow(() => {
  if (!requireRole('staff')) return;
  void load();
});

function minToHHMM(min: number) {
  const m = ((min % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}
function hhmmToMin(value: string) {
  const [h, m] = value.split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}

async function load() {
  loading.value = true;
  try {
    const me = await request<{ staff: StaffProfile; store: { name: string }; windows: AvailabilityWindow[] }>('/staff/me');
    profile.value = me.staff;
    storeName.value = me.store.name;
    windows.value = me.windows.map((w) => ({ ...w }));
    form.value = {
      nickname: me.staff.nickname,
      area: me.staff.area,
      distanceKm: me.staff.distanceKm,
      expectedRate: me.staff.expectedRate,
      experienceYears: me.staff.experienceYears,
      skills: me.staff.skills.length ? me.staff.skills : ['烤肉辅助'],
      bio: me.staff.bio,
    };
  } catch (err) {
    toast(err instanceof Error ? err.message : '加载失败');
  } finally {
    loading.value = false;
  }
}

function addWindow() {
  const startMin = hhmmToMin(startTime.value);
  let endMin = hhmmToMin(endTime.value);
  if (endMin === startMin) return toast('开始与结束时间不能相同');
  // "00:00" end for an evening window means midnight / next day.
  if (endMin === 0 && startMin > 0) endMin = 1440;
  windows.value.push({ weekday: weekday.value, startMin, endMin });
  toast('已添加，记得保存');
}

function removeWindow(index: number) {
  windows.value.splice(index, 1);
}

function preset(kind: 'evening' | 'weekend') {
  if (kind === 'evening') {
    const today = new Date().getDay();
    windows.value.push({ weekday: today, startMin: 17 * 60, endMin: 23 * 60 });
    toast('已添加今晚时段');
  } else {
    windows.value.push({ weekday: 6, startMin: 11 * 60, endMin: 21 * 60 });
    windows.value.push({ weekday: 0, startMin: 11 * 60, endMin: 21 * 60 });
    toast('已添加周末时段');
  }
}

async function saveProfile() {
  if (saving.value) return;
  if (!form.value.nickname.trim()) return toast('请填写昵称');
  if (!form.value.area.trim()) return toast('请填写所在区域');
  saving.value = true;
  try {
    const data = await request<{ staff: StaffProfile }>('/staff/me', {
      method: 'PATCH',
      data: {
        nickname: form.value.nickname.trim(),
        area: form.value.area.trim(),
        distanceKm: Number(form.value.distanceKm) || 0,
        expectedRate: Number(form.value.expectedRate) || 32,
        experienceYears: Number(form.value.experienceYears) || 0,
        skills: form.value.skills,
        bio: form.value.bio,
      },
    });
    profile.value = data.staff;
    toast('个人资料已保存', 'success');
  } catch (err) {
    toast(err instanceof Error ? err.message : '保存失败');
  } finally {
    saving.value = false;
  }
}

function logout() {
  uni.showModal({
    title: '退出登录',
    content: '退出后需重新登录查看邀约。',
    success: (res) => {
      if (!res.confirm) return;
      clearSession();
      uni.reLaunch({ url: '/pages/login/index' });
    },
  });
}

async function saveAvailability() {
  if (savingAvailability.value) return;
  savingAvailability.value = true;
  try {
    const data = await request<{ availability: AvailabilityWindow[] }>('/staff/me/availability', {
      method: 'PUT',
      data: { windows: windows.value },
    });
    windows.value = data.availability;
    toast('可用时间已保存', 'success');
  } catch (err) {
    toast(err instanceof Error ? err.message : '保存失败');
  } finally {
    savingAvailability.value = false;
  }
}
</script>

<style scoped>
.profile-head { display: flex; gap: 18rpx; align-items: center; margin-bottom: 22rpx; }
.avatar.big { width: 100rpx; height: 100rpx; border-radius: 30rpx; font-size: 40rpx; }
.profile-main { flex: 1; }
.name { font-size: 34rpx; font-weight: 800; }
.warn-card { border-color: rgba(255, 184, 77, 0.35); }
.field .num { width: 140rpx; }
.bio-field { display: block; }
.bio-input { width: 100%; height: 180rpx; min-height: 180rpx; margin-top: 12rpx; padding: 16rpx; border: 1rpx solid var(--ss-line); border-radius: 14rpx; background: var(--ss-panel-2); font-size: 24rpx; color: var(--ss-text); }
.avail-tip { display: block; margin-bottom: 16rpx; }
.window-row { display: flex; align-items: center; gap: 14rpx; padding: 18rpx 0; border-bottom: 1rpx solid var(--ss-line); }
.window-day { width: 90rpx; font-size: 24rpx; font-weight: 700; }
.window-time { flex: 1; font-size: 26rpx; font-variant-numeric: tabular-nums; }
.remove { color: var(--ss-danger); font-size: 22rpx; padding: 6rpx 10rpx; }
.add-panel { margin-top: 20rpx; padding: 18rpx; border-radius: 16rpx; background: var(--ss-panel-2); }
.add-head { font-size: 23rpx; color: var(--ss-muted); margin-bottom: 12rpx; }
.add-row { display: flex; align-items: center; gap: 10rpx; flex-wrap: wrap; }
.picker-chip { padding: 12rpx 18rpx; border: 1rpx solid var(--ss-line); border-radius: 12rpx; font-size: 24rpx; background: var(--ss-bg); }
.preset-row { display: flex; align-items: center; flex-wrap: wrap; gap: 12rpx; margin-top: 16rpx; }
.preset { font-size: 21rpx; color: var(--ss-accent); border: 1rpx solid rgba(216, 255, 79, 0.3); padding: 6rpx 14rpx; border-radius: 999rpx; }
.avail-save { margin-top: 22rpx; }
.logout-btn { color: var(--ss-muted); margin-bottom: 10rpx; }
</style>
