<template>
  <view class="bottom-nav">
    <view
      v-for="item in items"
      :key="item.path"
      class="nav-item"
      :class="{ active: current === item.key }"
      @tap="go(item)"
    >
      <text class="nav-icon">{{ item.icon }}</text>
      <text class="nav-label">{{ item.label }}</text>
      <text v-if="item.badge" class="nav-badge">{{ item.badge }}</text>
    </view>
  </view>
</template>

<script setup lang="ts">
import { computed } from 'vue';

const props = defineProps<{ role: 'manager' | 'staff'; current: string; badges?: Record<string, number> }>();

const items = computed(() => {
  if (props.role === 'manager') {
    return [
      { key: 'home', label: '今日经营', icon: '▦', path: '/pages/manager/home', badge: 0 },
      { key: 'plans', label: 'AI 调配', icon: '◈', path: '/pages/manager/plans', badge: props.badges?.plans ?? 0 },
      { key: 'applications', label: '兼职申请', icon: '↗', path: '/pages/manager/applications', badge: props.badges?.applications ?? 0 },
      { key: 'records', label: '调配记录', icon: '≡', path: '/pages/manager/records', badge: props.badges?.records ?? 0 },
    ];
  }
  return [
    { key: 'offers', label: '工作邀约', icon: '✳', path: '/pages/staff/offers', badge: props.badges?.offers ?? 0 },
    { key: 'market', label: '缺位广场', icon: '⌖', path: '/pages/staff/market', badge: props.badges?.market ?? 0 },
    { key: 'shifts', label: '我的班次', icon: '◷', path: '/pages/staff/shifts', badge: 0 },
    { key: 'availability', label: '可用时间', icon: '⌘', path: '/pages/staff/availability', badge: 0 },
  ];
});

function go(item: { path: string; key: string }) {
  if (item.key === props.current) return;
  uni.reLaunch({ url: item.path });
}
</script>

<style scoped>
.bottom-nav {
  position: fixed;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 20;
  display: flex;
  background: rgba(11, 13, 12, 0.96);
  border-top: 1px solid var(--ss-line);
  padding: 8rpx 0 calc(8rpx + env(safe-area-inset-bottom));
  backdrop-filter: blur(16px);
}
.nav-item {
  position: relative;
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4rpx;
  padding: 12rpx 0 8rpx;
  color: var(--ss-muted);
}
.nav-item.active { color: var(--ss-accent); }
.nav-icon { font-size: 34rpx; line-height: 1; }
.nav-label { font-size: 20rpx; }
.nav-badge {
  position: absolute;
  top: 4rpx;
  right: 50%;
  margin-right: -34rpx;
  min-width: 26rpx;
  height: 26rpx;
  padding: 0 6rpx;
  border-radius: 999rpx;
  background: var(--ss-danger);
  color: #fff;
  font-size: 18rpx;
  line-height: 26rpx;
  text-align: center;
}
</style>
