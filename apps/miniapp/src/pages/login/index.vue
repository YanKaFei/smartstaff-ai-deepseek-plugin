<template>
  <view class="login-page" :style="{ paddingTop: topPadding + 'px' }">
    <view class="hero">
      <view class="hero-brand">
        <view class="logo">SS</view>
        <text class="brand-name">SmartStaff AI</text>
        <text class="version">1.0</text>
      </view>
      <text class="hero-title">烤肉店的\nAI 排班搭档</text>
      <text class="hero-sub">看经营数据 → 预测未来 3 小时人力 → 自动匹配兼职 → 店长确认 → 到店签到。每天只需确认一次。</text>
      <view class="hero-tags">
        <text class="ss-pill accent">烤肉辅助</text>
        <text class="ss-pill">3 小时预测</text>
        <text class="ss-pill">经济 / 保障双方案</text>
      </view>
    </view>

    <view class="ss-card form-card">
      <view class="role-switch">
        <view class="role-tab" :class="{ active: role === 'manager' }" @tap="role = 'manager'">我是店长</view>
        <view class="role-tab" :class="{ active: role === 'staff' }" @tap="role = 'staff'">我是兼职</view>
      </view>

      <view class="field">
        <view>
          <text class="label">门店编码</text>
          <text class="hint">首次登录由门店提供，例如 K001</text>
        </view>
        <input v-model="storeCode" placeholder="K001" maxlength="10" />
      </view>

      <view v-if="role === 'manager'" class="field">
        <view>
          <text class="label">店长称呼</text>
          <text class="hint">选填，用于调配通知</text>
        </view>
        <input v-model="managerName" placeholder="王店长" maxlength="20" />
      </view>
      <view v-if="role === 'manager'" class="field">
        <view>
          <text class="label">店长授权码</text>
          <text class="hint">首次绑定门店时由管理员或现任店长提供</text>
        </view>
        <input v-model="managerClaim" placeholder="选填" maxlength="20" />
      </view>

      <template v-else>
        <view class="field">
          <view>
            <text class="label">手机号</text>
            <text class="hint">首次登录自动注册，需管理员审核</text>
          </view>
          <input v-model="phone" type="number" placeholder="13800000001" maxlength="15" />
        </view>
        <view class="field">
          <view>
            <text class="label">昵称</text>
            <text class="hint">选填</text>
          </view>
          <input v-model="staffName" placeholder="林小雨" maxlength="20" />
        </view>
      </template>

      <button v-if="demoEnabled || !configLoaded" class="btn-primary large login-btn" :disabled="loading" @tap="submit">
        {{ loading ? '登录中…' : role === 'manager' ? '进入门店' : '登录并查看邀约' }}
      </button>

      <!-- #ifdef MP-WEIXIN -->
      <button class="btn-ghost btn-block wx-btn" :disabled="wxLoading" @tap="wxLogin">
        {{ wxLoading ? '微信登录中…' : '微信一键登录' }}
      </button>
      <text v-if="configLoaded && !wechatEnabled" class="wx-note">微信登录未配置（服务端缺少 AppID/Secret），当前环境不可用。</text>
      <!-- #endif -->

      <view v-if="configLoaded && !demoEnabled" class="demo-row">
        <text class="ss-muted">开发演示登录未启用；请使用微信登录或联系管理员。</text>
      </view>
      <view v-else class="demo-row">
        <text class="ss-muted">演示账号：店长 K001</text>
        <text class="ss-muted">兼职 13800000001</text>
      </view>
    </view>

    <view v-if="demoEnabled || !configLoaded" class="create-line">
      <text class="ss-muted">还没有门店？</text>
      <text class="create-link" @tap="showCreate = !showCreate">{{ showCreate ? '收起' : '创建一家烤肉店' }}</text>
    </view>

    <view v-if="showCreate" class="ss-card create-card">
      <view class="ss-title">创建门店</view>
      <view class="field">
        <text class="label">门店名称</text>
        <input v-model="newStore.name" placeholder="焰遇烤肉 · 新店" maxlength="30" />
      </view>
      <view class="field">
        <text class="label">门店编码</text>
        <input v-model="newStore.code" placeholder="K002" maxlength="10" />
      </view>
      <view class="field">
        <text class="label">店长称呼</text>
        <input v-model="newStore.managerName" placeholder="李店长" maxlength="20" />
      </view>
      <button class="btn-primary" :disabled="creating" @tap="createStore">{{ creating ? '创建中…' : '创建并开始配置' }}</button>
      <text class="ss-sub create-hint">创建后进入首次配置向导：门店资料 → 桌位 → 员工 → 数据来源。配置会永久保存。</text>
    </view>

    <text class="footer-note">数据与岗位仅用于门店内部调配。商用前需落实用工、报酬、保险与个人信息保护要求。</text>
  </view>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import { onShow } from '@dcloudio/uni-app';
import { getSession, request, saveSession, toast, clearSession } from '../../api/client';

interface LoginResponse {
  token: string;
  accessToken?: string;
  refreshToken?: string;
  accessExpiresAt?: number;
  refreshExpiresAt?: number;
  user: { id: string; role: 'manager' | 'staff'; name: string };
  store: { onboardedAt: number | null; managerCode: string } | null;
  staff: { nickname: string; status: string } | null;
}

const role = ref<'manager' | 'staff'>('manager');
const topPadding = ref(40);
const storeCode = ref('K001');
const managerName = ref('');
const phone = ref('');
const staffName = ref('');
const loading = ref(false);
const creating = ref(false);
const showCreate = ref(false);
const newStore = ref({ name: '', code: '', managerName: '' });
const managerClaim = ref('');
const wxLoading = ref(false);
const wechatEnabled = ref(false);
const demoEnabled = ref(true);
const configLoaded = ref(false);

function computeTopPadding() {
  try {
    const info = uni.getSystemInfoSync();
    const statusBar = Number(info.statusBarHeight ?? 0);
    topPadding.value = Math.max(28, statusBar + 24);
  } catch {
    topPadding.value = 40;
  }
}

computeTopPadding();

onShow(() => {
  void loadAuthConfig();
  const session = getSession();
  if (!session) return;
  // A stored session only skips the form; the destination is resolved by role.
  if (session.role === 'manager') {
    uni.reLaunch({ url: '/pages/manager/home' });
  } else if (session.role === 'staff') {
    uni.reLaunch({ url: '/pages/staff/offers' });
  }
});

async function loadAuthConfig() {
  try {
    const cfg = await request<{ demoLoginEnabled: boolean; wechatLoginEnabled: boolean }>('/auth/config');
    demoEnabled.value = cfg.demoLoginEnabled;
    wechatEnabled.value = cfg.wechatLoginEnabled;
  } catch {
    // keep defaults; login will surface the real error
  } finally {
    configLoaded.value = true;
  }
}

async function wxLogin() {
  if (wxLoading.value) return;
  const code = storeCode.value.trim().toUpperCase();
  if (!code) return toast('请输入门店编码');
  if (role.value === 'staff' && !/^\d{5,15}$/.test(phone.value.trim())) return toast('请输入正确的手机号');
  wxLoading.value = true;
  try {
    const loginResult = await new Promise<{ code?: string }>((resolve, reject) => {
      uni.login({
        provider: 'weixin',
        success: (res) => resolve(res as { code?: string }),
        fail: (err) => reject(new Error(err.errMsg || '微信登录失败')),
      });
    });
    if (!loginResult.code) throw new Error('未获取到微信登录凭证');
    const data = await request<LoginResponse>('/auth/wx-login', {
      method: 'POST',
      data: {
        code: loginResult.code,
        role: role.value,
        storeCode: code,
        claimCode: managerClaim.value.trim() || undefined,
        phone: role.value === 'staff' ? phone.value.trim() : undefined,
        name: role.value === 'manager' ? managerName.value.trim() : staffName.value.trim(),
      },
    });
    saveSession({
      token: data.token,
      accessToken: data.accessToken ?? data.token,
      refreshToken: data.refreshToken,
      accessExpiresAt: data.accessExpiresAt,
      refreshExpiresAt: data.refreshExpiresAt,
      role: data.user.role,
      name: data.user.name,
      storeCode: code,
    });
    if (data.user.role === 'manager') {
      uni.reLaunch({ url: data.store?.onboardedAt ? '/pages/manager/home' : '/pages/manager/setup' });
    } else {
      uni.reLaunch({ url: '/pages/staff/offers' });
    }
  } catch (err) {
    toast(err instanceof Error ? err.message : '微信登录失败');
  } finally {
    wxLoading.value = false;
  }
}

async function submit() {
  if (loading.value) return;
  const code = storeCode.value.trim().toUpperCase();
  if (!code) return toast('请输入门店编码');
  if (role.value === 'staff' && !/^\d{5,15}$/.test(phone.value.trim())) return toast('请输入正确的手机号');
  loading.value = true;
  try {
    const data = await request<LoginResponse>('/auth/mini-login', {
      method: 'POST',
      data: {
        role: role.value,
        storeCode: code,
        name: role.value === 'manager' ? managerName.value.trim() : staffName.value.trim(),
        phone: role.value === 'staff' ? phone.value.trim() : undefined,
      },
    });
    saveSession({
      token: data.token,
      accessToken: data.accessToken ?? data.token,
      refreshToken: data.refreshToken,
      accessExpiresAt: data.accessExpiresAt,
      refreshExpiresAt: data.refreshExpiresAt,
      role: data.user.role,
      name: data.user.name,
      storeCode: code,
    });
    if (data.user.role === 'manager') {
      const onboarded = Boolean(data.store?.onboardedAt);
      uni.reLaunch({ url: onboarded ? '/pages/manager/home' : '/pages/manager/setup' });
    } else {
      uni.reLaunch({ url: '/pages/staff/offers' });
    }
  } catch (err) {
    clearSession();
    toast(err instanceof Error ? err.message : '登录失败');
  } finally {
    loading.value = false;
  }
}

async function createStore() {
  if (creating.value) return;
  if (!newStore.value.name.trim()) return toast('请输入门店名称');
  if (!/^[A-Za-z0-9]{3,10}$/.test(newStore.value.code.trim())) return toast('门店编码需 3-10 位字母或数字');
  creating.value = true;
  try {
    const data = await request<LoginResponse>('/auth/register-store', {
      method: 'POST',
      data: {
        storeName: newStore.value.name.trim(),
        managerCode: newStore.value.code.trim().toUpperCase(),
        managerName: newStore.value.managerName.trim() || '门店店长',
      },
    });
    saveSession({
      token: data.token,
      accessToken: data.accessToken ?? data.token,
      refreshToken: data.refreshToken,
      accessExpiresAt: data.accessExpiresAt,
      refreshExpiresAt: data.refreshExpiresAt,
      role: 'manager',
      name: data.user.name,
      storeCode: data.store?.managerCode,
    });
    toast('门店已创建', 'success');
    uni.reLaunch({ url: '/pages/manager/setup' });
  } catch (err) {
    toast(err instanceof Error ? err.message : '创建失败');
  } finally {
    creating.value = false;
  }
}
</script>

<style scoped>
.login-page {
  min-height: 100vh;
  padding: 40px 40rpx 80rpx;
  background:
    radial-gradient(600rpx 500rpx at 90% 0%, rgba(216, 255, 79, 0.14), transparent 70%),
    radial-gradient(500rpx 400rpx at 0% 40%, rgba(138, 150, 255, 0.08), transparent 70%),
    var(--ss-bg);
}
.hero-brand { display: flex; align-items: center; gap: 14rpx; }
.logo {
  width: 64rpx; height: 64rpx; border-radius: 18rpx; background: var(--ss-accent); color: var(--ss-accent-ink);
  display: flex; align-items: center; justify-content: center; font-weight: 900; font-size: 26rpx;
}
.brand-name { font-weight: 800; font-size: 30rpx; letter-spacing: 1rpx; }
.version { font-size: 20rpx; color: var(--ss-muted); border: 1rpx solid var(--ss-line); padding: 2rpx 10rpx; border-radius: 999rpx; }
.hero-title {
  display: block;
  white-space: pre-line;
  font-size: 74rpx;
  line-height: 1.08;
  font-weight: 900;
  letter-spacing: -2rpx;
  margin: 54rpx 0 24rpx;
}
.hero-sub { display: block; color: var(--ss-muted); font-size: 26rpx; line-height: 1.75; }
.hero-tags { display: flex; gap: 12rpx; margin: 28rpx 0 40rpx; flex-wrap: wrap; }
.form-card { padding: 30rpx; }
.role-switch {
  display: flex; background: var(--ss-panel-2); border-radius: 18rpx; padding: 6rpx; margin-bottom: 14rpx;
}
.role-tab {
  flex: 1; text-align: center; padding: 18rpx 0; border-radius: 14rpx; color: var(--ss-muted); font-size: 27rpx;
}
.role-tab.active { background: var(--ss-accent); color: var(--ss-accent-ink); font-weight: 800; }
.login-btn { margin-top: 28rpx; }
.demo-row { display: flex; justify-content: space-between; margin-top: 22rpx; font-size: 21rpx; gap: 12rpx; }
.wx-btn { margin-top: 16rpx; min-height: 84rpx; }
.wx-note { display: block; margin-top: 12rpx; color: var(--ss-warn); font-size: 20rpx; line-height: 1.5; }
.create-line { display: flex; justify-content: center; gap: 10rpx; align-items: center; margin-top: 30rpx; font-size: 24rpx; }
.create-link { color: var(--ss-accent); font-weight: 700; }
.create-card { margin-top: 22rpx; }
.create-hint { display: block; margin-top: 18rpx; }
.footer-note { display: block; text-align: center; color: #667268; font-size: 20rpx; line-height: 1.7; margin-top: 46rpx; }
</style>
