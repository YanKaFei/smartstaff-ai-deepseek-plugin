<template>
  <view class="ss-page">
    <view v-if="loading" class="empty">正在读取调配方案…</view>
    <template v-else>
      <view v-if="shadowMode" class="shadow-banner">
        <text class="shadow-title">影子模式</text>
        <text>只记录 AI 推荐与匹配结果，不发送兼职邀约、不产生工作承诺或费用。</text>
      </view>
      <view v-if="banner" class="banner">{{ banner }}</view>

      <view v-if="forecast" class="ss-card forecast-head" :class="{ alert: forecast.peakGap > 0 }">
        <view class="ss-spread">
          <view>
            <text class="head-gap">{{ forecast.peakGap > 0 ? `缺 ${forecast.peakGap} 人` : '人力充足' }}</text>
            <text class="ss-sub">{{ fmtDate(forecast.horizonStart) }} · 未来 3 小时 · 需求 {{ forecast.peakRequiredStaff }} 人 / 在岗 {{ forecast.onDutyStaff }} 人</text>
          </view>
          <text class="ss-pill" :class="forecast.peakGap > 0 ? 'warn' : 'ok'">{{ bottleneckLabel(forecast.bottleneck) }}</text>
        </view>
        <text class="ai-summary">{{ forecast.ai.summary || forecast.reliabilityReason }}</text>
        <view v-if="forecast.ai.bottleneckExplanation" class="ai-reason">
          <text class="ai-reason-label">AI 判断</text>
          <text class="ss-sub">{{ forecast.ai.bottleneckExplanation }}</text>
        </view>
        <view class="meta-row">
          <text class="ss-pill">可靠性{{ reliabilityLabel(forecast.reliability) }}</text>
          <text class="ss-pill" :class="forecast.aiStatus === 'ok' ? 'ok' : ''">{{ forecast.aiStatus === 'ok' ? (forecast.aiCached ? 'AI 缓存解释' : 'DeepSeek 已解释') : '确定性引擎降级' }}</text>
          <text class="ss-pill" :class="forecast.model === 'service_minutes' ? 'warn' : ''">{{ forecast.model === 'service_minutes' ? (forecast.serviceMode === 'full' ? '分钟模型·全程代烤' : forecast.serviceMode === 'self' ? '分钟模型·自主烤制' : '分钟模型·部分代烤') : '旧算法基线' }}</text>
          <text class="ss-pill">{{ forecast.slots.length }} 个时段</text>
        </view>
        <view v-if="forecast.modelWarning" class="model-warning">{{ forecast.modelWarning }}</view>
        <view class="slots-mini">
          <view v-for="slot in forecast.slots" :key="slot.startAt" class="slot-mini" :class="{ need: slot.gap > 0 }">
            <text class="slot-time">{{ slot.label }}</text>
            <text class="slot-line">在用 {{ slot.projectedActiveTables }} 桌</text>
            <text class="slot-line">排队 {{ slot.projectedQueueGroups }} 组</text>
            <text class="slot-gap">{{ slot.gap > 0 ? `缺 ${slot.gap} 人` : '可覆盖' }}</text>
          </view>
        </view>
        <view v-if="forecast.gapRanges.length" class="ranges">
          <text class="ss-sub">建议增派：</text>
          <text v-for="range in forecast.gapRanges" :key="range.startAt" class="range-chip">{{ timeRange(range.startAt, range.endAt) }} · {{ range.headcount }} 人</text>
        </view>
      </view>

      <view v-if="!needsStaff" class="ss-card">
        <view class="ss-title">无需增派</view>
        <text class="ss-sub">{{ noNeedMessage }}</text>
        <button class="btn-primary regen-btn" :disabled="working" @tap="regenerate">{{ working ? '计算中…' : '重新计算未来 3 小时' }}</button>
      </view>

      <template v-else>
        <view class="ss-spread plans-head">
          <text class="plans-title">选择调配方案</text>
          <button class="btn-ghost small" :disabled="working" @tap="regenerate">{{ working ? '生成中…' : '重新生成' }}</button>
        </view>

        <view
          v-for="plan in plans"
          :key="plan.id"
          class="plan-card"
          :class="{ selected: selectedId === plan.id }"
          @tap="selectPlan(plan)"
        >
          <view class="ss-spread plan-head">
            <view>
              <view class="ss-row">
                <text class="plan-name">{{ plan.planType === 'economic' ? '经济方案' : '保障方案' }}</text>
                <text class="ss-pill" :class="plan.planType === 'economic' ? 'accent' : 'ok'">
                  {{ plan.planType === 'economic' ? '成本优先' : '高峰期保障' }}
                </text>
              </view>
              <text class="ss-sub">{{ plan.headcount }} 人 · 预计 ¥{{ plan.totalCost }}</text>
            </view>
            <view class="select-dot" :class="{ on: selectedId === plan.id }">{{ selectedId === plan.id ? '✓' : '' }}</view>
          </view>

          <view v-if="plan.shortage.length" class="shortage">
            <text v-for="s in plan.shortage" :key="s.startAt">缺口：{{ timeRange(s.startAt, s.endAt) }} 需 {{ s.needed }} 人，仅找到 {{ s.found }} 人</text>
          </view>

          <view v-for="item in plan.items" :key="item.staffId + item.startAt" class="member">
            <view class="avatar small">{{ item.nickname.slice(0, 1) }}</view>
            <view class="member-info">
              <view class="ss-spread">
                <text class="member-name">{{ item.nickname }}</text>
                <text class="member-rate">¥{{ item.hourlyRate }}/h</text>
              </view>
              <text class="ss-sub">{{ item.startLabel }}-{{ item.endLabel }} · 预计 {{ item.arriveLabel }} 到店 · ¥{{ item.estimatedCost }}</text>
              <text class="member-reason">{{ item.reason }}</text>
            </view>
            <button class="btn-ghost small" @tap.stop="replace(plan, item)">替换</button>
          </view>

          <view v-if="!plan.items.length" class="empty">没有符合硬性条件的候选人。系统不会虚构可接单人员。</view>

          <button
            v-if="selectedId === plan.id"
            class="btn-primary confirm-btn"
            :disabled="working || !plan.items.length"
            @tap.stop="confirm(plan)"
          >
            {{ working ? '处理中…' : shadowMode ? '记录影子建议（不邀约）' : '确认调配并发起邀约' }}
          </button>
        </view>

        <view class="ss-card note-card">
          <view class="ss-title">调配规则</view>
          <text class="ss-sub">兼职接受邀约后班次才正式确认。超时或拒绝会自动顺延到下一候选；同一人不会被派往重叠时段。预测失败时，确定性计算与匹配仍可运行。</text>
        </view>
      </template>
    </template>

    <BottomNav role="manager" current="plans" />
  </view>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import { onPullDownRefresh, onShow } from '@dcloudio/uni-app';
import BottomNav from '../../components/BottomNav.vue';
import { requireRole, request, toast } from '../../api/client';
import type { Forecast, PilotSummary, Plan, PlanBundle, PlanItem, PlanAlternative } from '../../api/types';
import { BOTTLENECK, RELIABILITY, fmtDate, fmtTime } from '../../api/format';

const forecast = ref<Forecast | null>(null);
const plans = ref<Plan[]>([]);
const selectedId = ref('');
const loading = ref(true);
const working = ref(false);
const needsStaff = ref(true);
const banner = ref('');
const noNeedMessage = ref('当前人力可覆盖预测客流，无需增派。');
const pilot = ref<PilotSummary | null>(null);
const shadowMode = computed(() => Boolean(pilot.value?.shadowMode));
const flowStartedAt = ref(Date.now());
const actionCount = ref(0);

onShow(() => {
  if (!requireRole('manager')) return;
  void load();
});

onPullDownRefresh(async () => {
  await load();
  uni.stopPullDownRefresh();
});

function bottleneckLabel(v: string) {
  return BOTTLENECK[v] ?? v;
}
function reliabilityLabel(v: string) {
  return RELIABILITY[v] ?? v;
}
function timeRange(start: number, end: number) {
  return `${fmtTime(start)}-${fmtTime(end)}`;
}

async function load() {
  loading.value = true;
  try {
    flowStartedAt.value = Date.now();
    actionCount.value = 0;
    const [latest, planList, pilotSummary] = await Promise.all([
      request<Forecast | null>('/manager/forecast/latest'),
      request<Plan[]>('/manager/plans'),
      request<PilotSummary>('/manager/pilot/summary'),
    ]);
    pilot.value = pilotSummary;
    forecast.value = latest;
    const proposed = planList.filter((p) => p.status === 'proposed');
    plans.value = proposed;
    if (proposed.length) {
      selectedId.value = selectedId.value && proposed.some((p) => p.id === selectedId.value)
        ? selectedId.value
        : proposed[0].id;
      needsStaff.value = true;
      banner.value = '';
    } else if (latest && latest.peakGap > 0) {
      await generatePlans(latest.id);
    } else {
      needsStaff.value = false;
      noNeedMessage.value = latest
        ? latest.peakGap === 0
          ? '当前人力可覆盖预测客流，无需增派。'
          : latest.bottleneckReason
        : '尚无预测结果，请先计算。';
    }
  } catch (err) {
    toast(err instanceof Error ? err.message : '加载失败');
  } finally {
    loading.value = false;
  }
}

async function generatePlans(forecastId?: string) {
  const bundle = await request<PlanBundle>('/manager/plans', { method: 'POST', data: forecastId ? { forecastId } : {} });
  forecast.value = bundle.forecast;
  needsStaff.value = bundle.needsStaff;
  noNeedMessage.value = bundle.message;
  plans.value = bundle.plans;
  if (bundle.plans.length) selectedId.value = bundle.plans[0].id;
  banner.value = bundle.message;
}

async function regenerate() {
  if (working.value) return;
  working.value = true;
  try {
    const data = await request<{ forecast: Forecast }>('/manager/forecast', { method: 'POST', data: { useAi: true } });
    forecast.value = data.forecast;
    await generatePlans(data.forecast.id);
    toast('已重新计算并生成方案');
  } catch (err) {
    toast(err instanceof Error ? err.message : '生成失败');
  } finally {
    working.value = false;
  }
}

function replace(plan: Plan, item: PlanItem) {
  const alternatives = item.alternatives || [];
  if (!alternatives.length) return toast('该时段没有其他合格候选');
  uni.showActionSheet({
    itemList: alternatives.slice(0, 6).map((a: PlanAlternative) => `${a.nickname} · ¥${a.hourlyRate}/h · ${a.distanceKm.toFixed(1)}km · 准点${Math.round(a.onTimeRate * 100)}%`),
    success: async (res) => {
      const alt = alternatives[res.tapIndex];
      if (!alt) return;
      try {
        const updated = await request<Plan>(`/manager/plans/${plan.id}/replace`, {
          method: 'POST',
          data: { staffId: item.staffId, startAt: item.startAt, replacementStaffId: alt.staffId },
        });
        const idx = plans.value.findIndex((p) => p.id === plan.id);
        if (idx >= 0) plans.value[idx] = updated;
        toast(`已替换为 ${alt.nickname}`);
      } catch (err) {
        toast(err instanceof Error ? err.message : '替换失败');
      }
    },
  });
}

function selectPlan(plan: Plan) {
  selectedId.value = plan.id;
  actionCount.value += 1;
}

async function confirm(plan: Plan) {
  if (working.value) return;
  working.value = true;
  actionCount.value += 1;
  try {
    const result = await request<{ offersCreated: number; message: string; failed: unknown[]; shadow?: boolean; shadowRunId?: string }>(
      `/manager/plans/${plan.id}/confirm`,
      { method: 'POST', data: {} },
    );
    await request('/manager/pilot/ux-metric', {
      method: 'POST',
      data: {
        flow: result.shadow ? 'shadow_plan_confirm' : 'plan_confirm',
        actionCount: actionCount.value,
        elapsedMs: Date.now() - flowStartedAt.value,
        planId: plan.id,
        shadow: Boolean(result.shadow),
      },
    }).catch(() => undefined);
    toast(result.message);
    setTimeout(() => uni.reLaunch({ url: result.shadow ? '/pages/manager/home' : '/pages/manager/records' }), 700);
  } catch (err) {
    toast(err instanceof Error ? err.message : '确认失败');
  } finally {
    working.value = false;
  }
}
</script>

<style scoped>
.shadow-banner { display: flex; flex-direction: column; gap: 6rpx; background: rgba(138, 150, 255, 0.1); border: 1rpx solid rgba(138, 150, 255, 0.45); color: var(--ss-text); font-size: 21rpx; padding: 16rpx 20rpx; border-radius: 18rpx; margin-bottom: 18rpx; line-height: 1.5; }
.shadow-title { color: #aab4ff; font-weight: 800; font-size: 23rpx; }
.banner { background: rgba(216, 255, 79, 0.09); border: 1rpx solid rgba(216, 255, 79, 0.3); color: var(--ss-accent); font-size: 23rpx; padding: 18rpx 22rpx; border-radius: 18rpx; margin-bottom: 20rpx; line-height: 1.5; }
.forecast-head { border-color: rgba(216, 255, 79, 0.3); }
.forecast-head.alert { border-color: rgba(255, 184, 77, 0.45); background: linear-gradient(150deg, rgba(255, 184, 77, 0.09), transparent 55%), var(--ss-panel); }
.head-gap { display: block; font-size: 52rpx; font-weight: 900; line-height: 1.05; color: var(--ss-warn); }
.ai-summary { display: block; font-size: 25rpx; line-height: 1.6; margin-top: 14rpx; }
.ai-reason { margin-top: 12rpx; padding: 16rpx; border-radius: 14rpx; background: var(--ss-panel-2); }
.ai-reason-label { display: block; font-size: 20rpx; color: var(--ss-accent); margin-bottom: 4rpx; }
.meta-row { display: flex; gap: 10rpx; flex-wrap: wrap; margin-top: 16rpx; }
.model-warning { margin-top: 12rpx; padding: 12rpx 14rpx; border: 1rpx solid rgba(255, 184, 77, 0.35); border-radius: 12rpx; color: var(--ss-warn); font-size: 20rpx; line-height: 1.5; }
.slots-mini { display: flex; flex-wrap: wrap; gap: 10rpx; margin-top: 18rpx; }
.slot-mini { width: calc((100% - 20rpx) / 3); border: 1rpx solid var(--ss-line); border-radius: 16rpx; padding: 14rpx; background: var(--ss-panel-2); box-sizing: border-box; }
.slot-mini.need { border-color: rgba(255, 184, 77, 0.35); }
.slot-time { display: block; font-size: 22rpx; font-weight: 700; }
.slot-line { display: block; font-size: 19rpx; color: var(--ss-muted); margin-top: 4rpx; }
.slot-gap { display: block; font-size: 21rpx; font-weight: 700; color: var(--ss-warn); margin-top: 8rpx; }
.ranges { display: flex; flex-wrap: wrap; gap: 8rpx; align-items: center; margin-top: 16rpx; }
.range-chip { font-size: 20rpx; color: var(--ss-warn); border: 1rpx solid rgba(255, 184, 77, 0.35); border-radius: 999rpx; padding: 4rpx 12rpx; }
.regen-btn { margin-top: 22rpx; }
.plans-head { margin: 8rpx 0 16rpx; }
.plans-title { font-size: 30rpx; font-weight: 800; }
.plan-card { background: var(--ss-panel); border: 1rpx solid var(--ss-line); border-radius: 26rpx; padding: 24rpx; margin-bottom: 20rpx; transition: border-color 0.2s; }
.plan-card.selected { border-color: rgba(216, 255, 79, 0.65); box-shadow: 0 0 0 1rpx rgba(216, 255, 79, 0.25) inset; }
.plan-name { font-size: 32rpx; font-weight: 800; }
.select-dot { width: 44rpx; height: 44rpx; border-radius: 50%; border: 1rpx solid var(--ss-line); display: flex; align-items: center; justify-content: center; color: var(--ss-accent-ink); font-size: 24rpx; }
.select-dot.on { background: var(--ss-accent); border-color: var(--ss-accent); }
.shortage { margin-top: 14rpx; padding: 14rpx 16rpx; border-radius: 14rpx; background: rgba(255, 107, 87, 0.08); color: var(--ss-danger); font-size: 21rpx; line-height: 1.6; }
.member { display: flex; gap: 14rpx; align-items: flex-start; padding: 18rpx 0; border-bottom: 1rpx solid var(--ss-line); }
.member:last-of-type { border-bottom: none; }
.avatar.small { width: 62rpx; height: 62rpx; border-radius: 18rpx; font-size: 26rpx; }
.member-info { flex: 1; min-width: 0; }
.member-name { font-size: 26rpx; font-weight: 700; }
.member-rate { font-size: 24rpx; color: var(--ss-accent); font-weight: 700; }
.member-reason { display: block; font-size: 20rpx; color: var(--ss-muted); margin-top: 8rpx; line-height: 1.55; }
.confirm-btn { margin-top: 20rpx; }
.note-card { margin-top: 4rpx; }
</style>
