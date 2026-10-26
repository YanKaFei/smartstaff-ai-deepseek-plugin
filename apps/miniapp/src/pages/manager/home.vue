<template>
  <view class="ss-page">
    <view v-if="loading" class="empty">正在读取今日经营数据…</view>
    <template v-else-if="today">
      <!-- 门店状态 -->
      <view class="store-head">
        <view>
          <view class="ss-row">
            <text class="store-name">{{ today.store.name }}</text>
            <text class="ss-pill" :class="today.businessDay.status === 'confirmed' ? 'ok' : 'warn'">
              {{ today.businessDay.status === 'confirmed' ? '今日已确认' : '待确认营业' }}
            </text>
            <text v-if="pilot?.shadowMode" class="ss-pill warn">影子模式</text>
          </view>
          <text class="ss-sub">{{ today.businessDate }} · {{ today.nowLabel }} · 签到码 {{ today.store.managerCode }}</text>
        </view>
        <view class="head-actions">
          <view class="settings" @tap="goSetup">设置</view>
          <view class="settings" @tap="logout">退出</view>
        </view>
      </view>

      <view v-if="today.businessDay.status === 'draft'" class="confirm-card">
        <view class="ss-spread">
          <view>
            <text class="confirm-title">确认今日营业</text>
            <text class="confirm-sub">已恢复上次配置：在岗 {{ today.businessDay.onDutyStaff }} 人、{{ today.tables.total }} 张桌位。无变化直接确认。</text>
          </view>
        </view>
        <button class="btn-primary large" @tap="confirmDay">确认今日营业</button>
      </view>
      <view v-else class="confirmed-strip">
        <text>今日营业已确认</text>
        <text class="ss-muted">有变化随时用下方按钮更新</text>
      </view>

      <view v-if="today.coverage && (today.coverage.openExceptions > 0 || today.coverage.unfilled > 0)" class="risk-banner" @tap="goRecords">
        <view>
          <text class="risk-title">需要处理</text>
          <text class="risk-sub">{{ today.coverage.openExceptions }} 个异常 · 待回复 {{ today.coverage.pending }} · 未填补 {{ today.coverage.unfilled }}</text>
        </view>
        <text class="risk-link">去处理 ›</text>
      </view>

      <!-- 核心指标 -->
      <view class="metric-grid">
        <view class="metric-card">
          <text class="metric-label">在岗员工</text>
          <view class="ss-spread metric-row">
            <text class="metric-value">{{ today.businessDay.onDutyStaff }}<text class="metric-unit">人</text></text>
            <view class="stepper">
              <view class="stepper-btn" @tap="setOnDuty(-1)">−</view>
              <view class="stepper-btn" @tap="setOnDuty(1)">+</view>
            </view>
          </view>
        </view>
        <view class="metric-card">
          <text class="metric-label">排队组数</text>
          <view class="ss-spread metric-row">
            <text class="metric-value">{{ today.queue.groups }}<text class="metric-unit">组</text></text>
            <view class="stepper">
              <view class="stepper-btn" @tap="changeQueue(-1)">−</view>
              <view class="stepper-btn" @tap="changeQueue(1)">+</view>
            </view>
          </view>
        </view>
        <view class="metric-card">
          <text class="metric-label">最新叫号</text>
          <text class="metric-value">{{ today.queue.latestCallNo }}<text class="metric-unit">号</text></text>
          <text class="ss-sub">{{ today.queue.customers }} 位顾客等待</text>
        </view>
        <view class="metric-card">
          <text class="metric-label">空闲桌位</text>
          <text class="metric-value">{{ freeTables }}<text class="metric-unit">/ {{ today.tables.total }}</text></text>
          <text class="ss-sub">占用率 {{ Math.round(today.metrics.occupancyRate * 100) }}%</text>
        </view>
      </view>

      <!-- 今日履约 -->
      <view v-if="today.coverage && today.coverage.demands.length" class="ss-card coverage-card">
        <view class="ss-title"><text>今日履约</text><text class="ss-pill" :class="today.coverage.unfilled > 0 ? 'warn' : 'ok'">{{ today.coverage.unfilled > 0 ? '未填补 ' + today.coverage.unfilled + ' 人' : '已满员' }}</text></view>
        <view class="coverage-grid">
          <view class="coverage-cell"><text class="coverage-value">{{ today.coverage.committed }}</text><text class="coverage-label">已接受</text></view>
          <view class="coverage-cell"><text class="coverage-value ss-accent">{{ today.coverage.checkedIn }}</text><text class="coverage-label">已到岗</text></view>
          <view class="coverage-cell"><text class="coverage-value">{{ today.coverage.pending }}</text><text class="coverage-label">待回复</text></view>
          <view class="coverage-cell"><text class="coverage-value" :class="today.coverage.unfilled > 0 ? 'ss-warn' : ''">{{ today.coverage.unfilled }}</text><text class="coverage-label">未填补</text></view>
        </view>
        <view v-for="d in today.coverage.demands" :key="d.id" class="demand-line">
          <text>{{ timeRange(d.startAt, d.endAt) }} · {{ d.role }}</text>
          <text class="ss-sub">目标 {{ d.headcount }} · 已确认/在岗/完成 {{ d.committed }} · 待回复 {{ d.pending }}</text>
          <text v-if="d.backfillTasks.length" class="backfill-tag" :class="{ failed: d.backfillTasks.some(t => t.status === 'no_candidate' || t.status === 'needs_approval') }">
            候补 {{ backfillLabel(d.backfillTasks[0].status) }}
          </text>
        </view>
        <button v-if="today.coverage.unfilled > 0" class="btn-ghost small handle-btn" @tap="goRecords">查看待处理 / 补员</button>
      </view>

      <!-- 三个主操作；现场微调收在次级入口，避免首页动作过载 -->
      <view class="primary-actions">
        <button class="primary-action" @tap="today.businessDay.status === 'draft' ? confirmDay() : goSetup()">
          <text class="primary-icon">✓</text>
          <text>{{ today.businessDay.status === 'draft' ? '确认营业' : '更新营业' }}</text>
        </button>
        <button class="primary-action accent" :disabled="generating" @tap="generateDispatch">
          <text class="primary-icon">✦</text>
          <text>{{ generating ? '计算中…' : 'AI 调配' }}</text>
        </button>
        <button class="primary-action" @tap="goRecords">
          <text class="primary-icon">!</text>
          <text>处理异常</text>
        </button>
      </view>

      <!-- 次级现场操作 -->
      <view class="quick-toggle" @tap="showQuickOps = !showQuickOps">
        <text>{{ showQuickOps ? '收起现场操作' : '现场操作：加队 / 叫号 / 刷新' }}</text>
        <text>{{ showQuickOps ? '▴' : '▾' }}</text>
      </view>
      <view v-if="showQuickOps" class="quick-row">
        <button class="btn-ghost accent" @tap="changeQueue(1)">+ 加一组排队</button>
        <button class="btn-ghost" @tap="callNext">叫下一位</button>
        <button class="btn-ghost" @tap="load" :disabled="busy">刷新</button>
      </view>

      <!-- AI 预测 -->
      <view class="ss-card forecast-card" :class="{ alert: today.forecast && today.forecast.gap > 0 }">
        <view class="ss-title">
          <text>AI 人力预测</text>
          <text v-if="today.forecast" class="ss-pill" :class="today.forecast.gap > 0 ? 'warn' : 'ok'">
            {{ bottleneckLabel(today.forecast.bottleneck) }}
          </text>
          <text v-else class="ss-pill">尚未预测</text>
        </view>
        <template v-if="today.forecast">
          <view class="ss-row forecast-main">
            <text class="forecast-big">{{ today.forecast.gap > 0 ? today.forecast.gap : '0' }}</text>
            <view>
              <text class="forecast-label">{{ today.forecast.gap > 0 ? '人建议增派' : '人力可覆盖预测客流' }}</text>
              <text class="ss-sub">需求 {{ today.forecast.requiredStaff }} 人 · 在岗 {{ today.forecast.onDutyStaff }} 人 · 可靠性{{ reliabilityLabel(today.forecast.reliability) }}</text>
            </view>
          </view>
          <view class="ai-actions">
            <button class="btn-primary" :disabled="generating" @tap="generateDispatch">
              {{ generating ? 'AI 正在计算…' : today.forecast.gap > 0 ? '生成 AI 调配方案' : '查看未来 3 小时预测' }}
            </button>
          </view>
        </template>
        <template v-else>
          <text class="ss-sub">系统将结合桌位占用、排队、翻台与 7 天历史，计算未来 3 小时人力需求，并匹配可用兼职。</text>
          <button class="btn-primary forecast-btn" :disabled="generating" @tap="generateDispatch">
            {{ generating ? 'AI 正在计算…' : '生成预测与调配方案' }}
          </button>
        </template>
      </view>

      <!-- 影子期一页完成：选择建议即记录，不发邀约 -->
      <view v-if="pilot?.shadowMode && shadowPlans.length" class="ss-card shadow-plans">
        <view class="ss-title"><text>今日影子建议</text><text class="ss-pill">不邀约 · 不产生费用</text></view>
        <view v-for="p in shadowPlans" :key="p.id" class="shadow-plan" @tap="applyShadow(p)">
          <view class="ss-spread">
            <text class="shadow-plan-name">{{ p.planType === 'economic' ? '经济方案' : '保障方案' }}</text>
            <text class="ss-pill" :class="p.planType === 'economic' ? 'accent' : 'ok'">{{ p.headcount }} 人 · ¥{{ p.totalCost }}</text>
          </view>
          <text class="ss-sub">{{ p.planType === 'economic' ? '成本优先' : '高峰保障' }} · 点击记录此建议</text>
          <view class="shadow-plan-btn">记录此建议</view>
        </view>
        <text class="ss-sub">记录后可在试点控制中查看影子结果，不会通知兼职。</text>
      </view>

      <!-- 排队 -->
      <view class="ss-card">
        <view class="ss-title">
          <text>排队与叫号</text>
          <text class="ss-pill" :class="today.queue.groups > 10 ? 'warn' : ''">{{ today.queue.groups }} 组 / {{ today.queue.customers }} 人</text>
        </view>
        <view v-if="!today.queue.entries.length" class="empty">当前没有排队顾客</view>
        <view v-for="q in today.queue.entries" :key="q.id" class="queue-row">
          <view class="queue-no" :class="{ called: q.status === 'called' }">
            {{ q.status === 'called' && q.callNo ? q.callNo : '—' }}
          </view>
          <view class="queue-info">
            <text class="queue-title">{{ q.partySize }} 位 · {{ tableTypeLabel(q.desiredType) }}</text>
            <text class="ss-sub">{{ q.status === 'called' ? '已叫号，等待入座' : '等待中' }} · 已等 {{ q.waitedMin }} 分钟</text>
          </view>
          <button class="btn-ghost small accent" @tap="seatQueue(q.id)">入座</button>
        </view>
        <view class="queue-foot">
          <text class="ss-sub">预计等待 {{ today.queue.estimatedWaitMin }} 分钟 · 叫号不等于入座</text>
          <button class="btn-ghost small" @tap="callNext">叫下一位</button>
        </view>
      </view>

      <!-- 桌位 -->
      <view class="ss-card">
        <view class="ss-title"><text>桌位状态</text><text class="ss-sub">点桌位执行结账 / 离店 / 清台</text></view>
        <view v-for="group in today.tables.byType" :key="group.type" class="table-group">
          <view class="ss-spread group-head">
            <text class="group-name">{{ group.label }}</text>
            <text class="ss-sub">空闲 {{ group.available }} · 用餐 {{ group.dining }} · 待清台 {{ group.cleaning }}</text>
          </view>
          <view class="table-grid">
            <view
              v-for="t in tablesOf(group.type)"
              :key="t.id"
              class="table-chip"
              :class="'state-' + t.status"
              @tap="openTable(t)"
            >
              <text class="table-label">{{ t.label }}</text>
              <text class="table-state">{{ tableStatusLabel(t.status) }}</text>
              <text v-if="t.status !== 'available' && t.elapsedMin" class="table-time">{{ t.elapsedMin }}′</text>
            </view>
          </view>
        </view>
      </view>

      <!-- 模拟器 -->
      <view v-if="sim" class="ss-card sim-card">
        <view class="ss-title">
          <text>门店模拟器</text>
          <text class="ss-pill accent">模拟数据</text>
        </view>
        <view class="ss-spread">
          <view>
            <text class="sim-time">{{ sim.nowLabel }}</text>
            <text class="ss-sub">{{ sim.running ? `运行中 · ${sim.speed}×` : '已暂停' }}</text>
          </view>
          <view class="ss-row">
            <button class="btn-ghost small" :disabled="busy" @tap="advance(15)">+15 分</button>
            <button class="btn-ghost small" :disabled="busy" @tap="advance(60)">+1 小时</button>
          </view>
        </view>
        <text class="ss-sub sim-note">推进时间会生成叫号、入座、结账、离店与清台事件，并按 30 分钟重算需求。</text>
      </view>

      <!-- 试点控制 -->
      <view v-if="pilot" class="ss-card pilot-card">
        <view class="ss-title">
          <text>试点控制</text>
          <text class="ss-pill" :class="pilot.control.paused ? 'bad' : 'ok'">{{ pilot.control.paused ? '调配已暂停' : '调配运行中' }}</text>
        </view>
        <text class="ss-sub">{{ pilot.shadowMode ? '影子模式：只预测与记录建议，不发送邀约。' : '真实调配：店长确认后会发送真实兼职邀约。' }}</text>
        <text v-if="pilot.control.paused" class="ss-sub pilot-reason">暂停原因：{{ pilot.control.reason || '店长紧急停止' }}</text>
        <view class="pilot-actions">
          <button v-if="!pilot.control.paused" class="btn-ghost danger small" @tap="pauseDispatch">紧急暂停调配</button>
          <button v-else class="btn-primary small" @tap="resumeDispatch">恢复调配</button>
          <text class="ss-sub">暂停会取消待回复邀约；已确认班次保留，转人工接管。</text>
        </view>
        <view v-if="pilot.shadowRuns.length" class="ss-sub">已记录 {{ pilot.shadowRuns.length }} 次影子建议 · 人工反馈 {{ pilot.feedback.count }} 次<span v-if="pilot.feedback.mae !== null"> · MAE {{ pilot.feedback.mae }} 人</span></view>
      </view>

      <!-- 数据接入 -->
      <view v-if="ingest" class="ss-card ingest-card">
        <view class="ss-title">
          <text>数据接入</text>
          <text class="ss-pill" :class="ingest.stale ? 'warn' : 'ok'">{{ ingest.stale ? '数据已陈旧' : '同步正常' }}</text>
        </view>
        <view class="ingest-row"><text class="ss-muted">来源</text><text>{{ sourceLabel(ingest.dataSource) }} · {{ ingest.lastSource ? eventSourceLabel(ingest.lastSource) : '暂无事件' }}</text></view>
        <view class="ingest-row"><text class="ss-muted">最近事件</text><text>{{ ingest.lastEvent ? eventLabel(ingest.lastEvent.type) + ' · ' + timeOf(ingest.lastEvent.occurredAt) : '—' }}</text></view>
        <view class="ingest-row"><text class="ss-muted">已应用/异常</text><text>{{ ingest.counts.applied || 0 }} / {{ (ingest.counts.error || 0) + (ingest.counts.stale || 0) }}</text></view>
        <text v-if="ingest.stale" class="ss-sub ingest-warning">超过 {{ ingest.staleThresholdMinutes }} 分钟未接收到经营事件；请检查模拟器/POS/Webhook，或使用人工录入。</text>
        <text v-else class="ss-sub ingest-note">叫号、入座、结账、离店、清台由事件源自动写入，无需逐项手填。</text>
      </view>

      <!-- 动态 -->
      <view class="ss-card">
        <view class="ss-title"><text>今日动态</text></view>
        <view v-if="!today.lastEvents.length" class="empty">暂无事件</view>
        <view v-for="e in today.lastEvents" :key="e.id" class="event-row">
          <text class="event-dot" />
          <text class="event-name">{{ eventLabel(e.type) }}</text>
          <text class="event-time">{{ timeOf(e.at) }}</text>
        </view>
      </view>
    </template>

    <BottomNav role="manager" current="home" :badges="{ plans: today?.proposedPlans || 0, records: today?.unreadNotifications || 0 }" />
  </view>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import { onPullDownRefresh, onShow } from '@dcloudio/uni-app';
import BottomNav from '../../components/BottomNav.vue';
import { clearSession, requireRole, request, toast } from '../../api/client';
import type { Forecast, IngestStatus, PilotSummary, PlanBundle, TableItem, TodayView } from '../../api/types';
import { BOTTLENECK, RELIABILITY, TABLE_STATUS, fmtTime } from '../../api/format';

interface SimStatus {
  nowLabel: string;
  running: boolean;
  speed: number;
  businessDate: string;
}

const today = ref<TodayView | null>(null);
const sim = ref<SimStatus | null>(null);
const ingest = ref<IngestStatus | null>(null);
const pilot = ref<PilotSummary | null>(null);
const shadowPlans = ref<PlanBundle['plans']>([]);
const shadowStartedAt = ref(0);
const applyingShadow = ref(false);
const loading = ref(true);
const busy = ref(false);
const generating = ref(false);
const showQuickOps = ref(false);

const freeTables = computed(() => today.value?.tables.list.filter((t) => t.status === 'available').length ?? 0);

onShow(() => {
  if (!requireRole('manager')) return;
  void load();
});

onPullDownRefresh(async () => {
  await load();
  uni.stopPullDownRefresh();
});

function tablesOf(type: string): TableItem[] {
  return today.value?.tables.list.filter((t) => t.type === type) ?? [];
}
function tableStatusLabel(status: string) {
  return TABLE_STATUS[status] ?? status;
}
function tableTypeLabel(type: string) {
  return type === 'small' ? '小桌' : type === 'medium' ? '中桌' : '大桌';
}
function bottleneckLabel(value: string) {
  return BOTTLENECK[value] ?? value;
}
function reliabilityLabel(value: string) {
  return RELIABILITY[value] ?? value;
}
function timeOf(ms: number) {
  return fmtTime(ms);
}
function timeRange(start: number, end: number) {
  return `${fmtTime(start)}-${fmtTime(end)}`;
}
function backfillLabel(status: string) {
  const map: Record<string, string> = {
    pending: '匹配中',
    offered: '已发邀约',
    filled: '已补齐',
    no_candidate: '无人可接',
    needs_approval: '需店长确认',
    cancelled: '已取消',
  };
  return map[status] ?? status;
}
function sourceLabel(source: string) {
  return source === 'simulator' ? '内置模拟器' : source === 'external' ? '外部 POS / Webhook' : '人工录入';
}
function eventSourceLabel(source: string) {
  return source === 'simulator' ? '模拟器' : source === 'webhook' ? 'Webhook' : source === 'correction' ? '数据修正' : '人工';
}
function eventLabel(type: string) {
  const map: Record<string, string> = {
    queue_join: '新顾客排队',
    queue_call: '叫号',
    seat: '顾客入座',
    checkout: '结账',
    leave: '顾客离店',
    clean_done: '清台完成',
    queue_abandoned: '顾客离队',
  };
  return map[type] ?? type;
}

async function load() {
  try {
    const data = await request<TodayView>('/manager/today');
    today.value = data;
    try {
      sim.value = await request<SimStatus>('/manager/sim/status');
    } catch {
      sim.value = null;
    }
    try {
      ingest.value = await request<IngestStatus>('/manager/ingest/status');
    } catch {
      ingest.value = null;
    }
    try {
      pilot.value = await request<PilotSummary>('/manager/pilot/summary');
    } catch {
      pilot.value = null;
    }
  } catch (err) {
    toast(err instanceof Error ? err.message : '加载失败');
  } finally {
    loading.value = false;
  }
}

async function confirmDay() {
  if (busy.value) return;
  busy.value = true;
  try {
    const data = await request<TodayView>('/manager/today/confirm', { method: 'POST', data: {} });
    today.value = data;
    toast('今日营业已确认', 'success');
  } catch (err) {
    toast(err instanceof Error ? err.message : '确认失败');
  } finally {
    busy.value = false;
  }
}

async function ops(data: Record<string, unknown>, success?: string) {
  if (busy.value) return;
  busy.value = true;
  try {
    const result = await request<{ today: TodayView }>('/manager/ops', { method: 'POST', data });
    today.value = result.today;
    if (success) toast(success);
  } catch (err) {
    toast(err instanceof Error ? err.message : '操作失败');
  } finally {
    busy.value = false;
  }
}

function setOnDuty(delta: number) {
  if (!today.value) return;
  const next = Math.max(0, today.value.businessDay.onDutyStaff + delta);
  if (next === today.value.businessDay.onDutyStaff) return;
  void ops({ type: 'set_on_duty', onDutyStaff: next });
}

function changeQueue(delta: number) {
  if (delta > 0) void ops({ type: 'join_queue', partySize: 3 }, '已加入一组排队');
  else void ops({ type: 'abandon_queue' }, '已移除最近一组排队');
}

function callNext() {
  void ops({ type: 'call_next' }, '已叫号');
}

function seatQueue(queueId: string) {
  void ops({ type: 'seat', queueId }, '已安排入座');
}

function openTable(table: TableItem) {
  const actions: Array<{ label: string; data: Record<string, unknown> }> = [];
  if (table.status === 'dining') actions.push({ label: '结账', data: { type: 'checkout', tableId: table.id } });
  if (table.status === 'checkout') {
    actions.push({ label: '顾客离店', data: { type: 'leave', tableId: table.id } });
    actions.push({ label: '直接完成清台', data: { type: 'clean', tableId: table.id } });
  }
  if (table.status === 'cleaning') actions.push({ label: '完成清台', data: { type: 'clean', tableId: table.id } });
  if (table.status === 'available') {
    const candidate = today.value?.queue.entries.find((q) => q.partySize <= table.seats);
    if (candidate) actions.push({ label: '安排排队顾客入座', data: { type: 'seat', queueId: candidate.id, tableId: table.id } });
    else {
      toast('暂无适配的排队顾客');
      return;
    }
  }
  if (!actions.length) return;
  uni.showActionSheet({
    itemList: actions.map((a) => a.label),
    success: (res) => {
      const action = actions[res.tapIndex];
      if (action) void ops(action.data, '已更新桌位状态');
    },
  });
}

async function generateDispatch() {
  if (generating.value) return;
  generating.value = true;
  try {
    const forecastData = await request<{ forecast: Forecast }>('/manager/forecast', {
      method: 'POST',
      data: { useAi: true },
    });
    const bundle = await request<PlanBundle>('/manager/plans', {
      method: 'POST',
      data: { forecastId: forecastData.forecast.id },
    });
    toast(bundle.message);
    if (pilot.value?.shadowMode && bundle.plans.length) {
      shadowPlans.value = bundle.plans;
      shadowStartedAt.value = Date.now();
      await load();
      return;
    }
    uni.reLaunch({ url: '/pages/manager/plans' });
  } catch (err) {
    toast(err instanceof Error ? err.message : '生成方案失败');
  } finally {
    generating.value = false;
  }
}

async function applyShadow(plan: PlanBundle['plans'][number]) {
  if (applyingShadow.value) return;
  applyingShadow.value = true;
  try {
    const result = await request<{ message: string; shadow?: boolean }>(`/manager/plans/${plan.id}/confirm`, {
      method: 'POST',
      data: {},
    });
    await request('/manager/pilot/ux-metric', {
      method: 'POST',
      data: {
        flow: 'shadow_home_inline',
        actionCount: 2,
        elapsedMs: shadowStartedAt.value ? Date.now() - shadowStartedAt.value : 0,
        planId: plan.id,
        shadow: true,
      },
    }).catch(() => undefined);
    toast(result.message);
    shadowPlans.value = [];
    await load();
  } catch (err) {
    toast(err instanceof Error ? err.message : '记录失败');
  } finally {
    applyingShadow.value = false;
  }
}

async function advance(minutes: number) {
  if (busy.value) return;
  busy.value = true;
  try {
    const data = await request<{ status: SimStatus; today: TodayView }>('/manager/sim/advance', {
      method: 'POST',
      data: { minutes },
    });
    sim.value = data.status;
    today.value = data.today;
    toast(`模拟时间 ${data.status.nowLabel}`);
  } catch (err) {
    toast(err instanceof Error ? err.message : '推进失败');
  } finally {
    busy.value = false;
  }
}

function goRecords() {
  uni.reLaunch({ url: '/pages/manager/records' });
}

function pauseDispatch() {
  uni.showModal({
    title: '紧急暂停调配',
    content: '将立即停止新的调配与候补，并取消所有待回复邀约；已确认班次保留，请人工接管。',
    confirmText: '暂停调配',
    success: async (res) => {
      if (!res.confirm) return;
      try {
        await request('/manager/pilot/pause', { method: 'POST', data: { reason: '店长紧急停止调配', cancelPending: true } });
        toast('已暂停，待回复邀约已取消');
        await load();
      } catch (err) { toast(err instanceof Error ? err.message : '暂停失败'); }
    },
  });
}

function resumeDispatch() {
  uni.showModal({
    title: '恢复调配',
    content: '恢复后将重新允许生成方案、发送邀约与自动候补。确认现场已具备接管条件。',
    success: async (res) => {
      if (!res.confirm) return;
      try {
        await request('/manager/pilot/resume', { method: 'POST', data: {} });
        toast('已恢复调配');
        await load();
      } catch (err) { toast(err instanceof Error ? err.message : '恢复失败'); }
    },
  });
}

function goSetup() {
  uni.navigateTo({ url: '/pages/manager/setup' });
}

function logout() {
  uni.showModal({
    title: '退出登录',
    content: '退出后需重新输入门店编码。',
    success: (res) => {
      if (!res.confirm) return;
      clearSession();
      uni.reLaunch({ url: '/pages/login/index' });
    },
  });
}
</script>

<style scoped>
.store-head { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 22rpx; }
.store-name { font-size: 36rpx; font-weight: 800; letter-spacing: -0.5rpx; }
.head-actions { display: flex; gap: 10rpx; }
.settings { padding: 10rpx 20rpx; border: 1rpx solid var(--ss-line); border-radius: 999rpx; font-size: 22rpx; color: var(--ss-muted); }
.confirm-card { background: linear-gradient(135deg, rgba(216, 255, 79, 0.16), rgba(216, 255, 79, 0.03)); border: 1rpx solid rgba(216, 255, 79, 0.35); border-radius: 28rpx; padding: 28rpx; margin-bottom: 22rpx; }
.confirm-title { display: block; font-size: 34rpx; font-weight: 800; margin-bottom: 8rpx; }
.confirm-sub { display: block; color: var(--ss-muted); font-size: 23rpx; line-height: 1.6; margin-bottom: 24rpx; }
.confirmed-strip { display: flex; justify-content: space-between; padding: 20rpx 26rpx; border-radius: 20rpx; background: rgba(100, 230, 162, 0.07); border: 1rpx solid rgba(100, 230, 162, 0.25); color: var(--ss-ok); font-size: 24rpx; margin-bottom: 22rpx; }
.risk-banner { display: flex; justify-content: space-between; align-items: center; gap: 16rpx; padding: 20rpx 24rpx; border-radius: 20rpx; background: rgba(255, 107, 87, 0.1); border: 1rpx solid rgba(255, 107, 87, 0.35); margin-bottom: 20rpx; }
.risk-title { display: block; color: var(--ss-danger); font-size: 26rpx; font-weight: 800; }
.risk-sub { display: block; color: var(--ss-muted); font-size: 21rpx; margin-top: 4rpx; }
.risk-link { color: var(--ss-danger); font-size: 23rpx; font-weight: 700; }
.coverage-card { border-color: rgba(216, 255, 79, 0.25); }
.coverage-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10rpx; margin: 8rpx 0 16rpx; }
.coverage-cell { background: var(--ss-panel-2); border-radius: 14rpx; padding: 12rpx; text-align: center; }
.coverage-value { display: block; font-size: 36rpx; font-weight: 900; font-variant-numeric: tabular-nums; }
.coverage-label { display: block; font-size: 19rpx; color: var(--ss-muted); margin-top: 2rpx; }
.demand-line { border-top: 1rpx solid var(--ss-line); padding: 14rpx 0; display: flex; flex-direction: column; gap: 4rpx; font-size: 23rpx; }
.backfill-tag { align-self: flex-start; margin-top: 4rpx; font-size: 19rpx; color: var(--ss-accent); border: 1rpx solid rgba(216, 255, 79, 0.35); border-radius: 999rpx; padding: 3rpx 12rpx; }
.backfill-tag.failed { color: var(--ss-danger); border-color: rgba(255, 107, 87, 0.4); }
.handle-btn { margin-top: 6rpx; width: 100%; }
.metric-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16rpx; margin-bottom: 20rpx; }
.metric-card { background: var(--ss-panel); border: 1rpx solid var(--ss-line); border-radius: 24rpx; padding: 22rpx; }
.metric-label { color: var(--ss-muted); font-size: 22rpx; }
.metric-value { display: block; font-size: 52rpx; font-weight: 800; margin-top: 8rpx; font-variant-numeric: tabular-nums; }
.metric-unit { font-size: 22rpx; font-weight: 500; color: var(--ss-muted); margin-left: 6rpx; }
.metric-row { margin-top: 2rpx; align-items: flex-end; }
.metric-row .stepper-btn { width: 56rpx; height: 56rpx; font-size: 30rpx; }
.primary-actions { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10rpx; margin: 18rpx 0 8rpx; }
.primary-action { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 4rpx; min-height: 92rpx; padding: 10rpx 6rpx; border-radius: 16rpx; background: var(--ss-panel-2); border: 1rpx solid var(--ss-line); color: var(--ss-text); font-size: 22rpx; font-weight: 700; }
.primary-action.accent { background: var(--ss-accent); border-color: var(--ss-accent); color: var(--ss-accent-ink); }
.primary-icon { font-size: 24rpx; line-height: 1; }
.quick-toggle { display: flex; justify-content: space-between; align-items: center; padding: 8rpx 4rpx 4rpx; color: var(--ss-muted); font-size: 20rpx; }
.quick-row { display: flex; gap: 14rpx; margin-bottom: 22rpx; }
.quick-row .btn-ghost { flex: 1; padding: 20rpx 0; font-size: 24rpx; }
.forecast-card { border-color: rgba(216, 255, 79, 0.28); }
.forecast-card.alert { background: linear-gradient(160deg, rgba(255, 184, 77, 0.1), transparent 60%), var(--ss-panel); border-color: rgba(255, 184, 77, 0.4); }
.forecast-main { align-items: center; margin: 8rpx 0 18rpx; }
.forecast-big { font-size: 76rpx; font-weight: 900; line-height: 1; margin-right: 18rpx; color: var(--ss-warn); }
.forecast-label { display: block; font-size: 26rpx; font-weight: 700; margin-bottom: 4rpx; }
.forecast-btn { margin-top: 22rpx; }
.ai-actions { margin-top: 4rpx; }
.queue-row { display: flex; align-items: center; gap: 16rpx; padding: 16rpx 0; border-bottom: 1rpx solid var(--ss-line); }
.queue-row:last-of-type { border-bottom: none; }
.queue-no { width: 72rpx; height: 72rpx; border-radius: 20rpx; background: var(--ss-panel-2); color: var(--ss-muted); display: flex; align-items: center; justify-content: center; font-weight: 800; font-size: 26rpx; flex-shrink: 0; }
.queue-no.called { background: rgba(216, 255, 79, 0.16); color: var(--ss-accent); }
.queue-info { flex: 1; min-width: 0; }
.queue-title { display: block; font-size: 26rpx; font-weight: 600; }
.queue-foot { display: flex; justify-content: space-between; align-items: center; margin-top: 18rpx; gap: 10rpx; }
.table-group { margin-bottom: 22rpx; }
.group-head { margin-bottom: 12rpx; }
.group-name { font-size: 26rpx; font-weight: 700; }
.table-grid { display: flex; flex-wrap: wrap; gap: 12rpx; }
.table-chip { width: calc((100% - 48rpx) / 5); min-height: 104rpx; border-radius: 16rpx; border: 1rpx solid var(--ss-line); background: var(--ss-panel-2); display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 2rpx; }
.table-label { font-size: 24rpx; font-weight: 800; }
.table-state { font-size: 18rpx; }
.table-time { font-size: 18rpx; color: var(--ss-muted); }
.state-available { border-color: rgba(255, 255, 255, 0.1); }
.state-dining { border-color: rgba(216, 255, 79, 0.4); background: rgba(216, 255, 79, 0.08); }
.state-dining .table-state { color: var(--ss-accent); }
.state-checkout { border-color: rgba(255, 184, 77, 0.4); background: rgba(255, 184, 77, 0.08); }
.state-checkout .table-state { color: var(--ss-warn); }
.state-cleaning { border-color: rgba(138, 150, 255, 0.4); background: rgba(138, 150, 255, 0.08); }
.state-cleaning .table-state { color: var(--ss-blue); }
.shadow-plans { border-color: rgba(138, 150, 255, 0.35); }
.shadow-plan { margin-top: 14rpx; padding: 18rpx; border: 1rpx solid rgba(138, 150, 255, 0.35); border-radius: 16rpx; background: var(--ss-panel-2); }
.shadow-plan-name { font-size: 28rpx; font-weight: 800; }
.shadow-plan-btn { margin-top: 10rpx; padding: 12rpx; border-radius: 12rpx; background: var(--ss-accent); color: var(--ss-accent-ink); text-align: center; font-size: 22rpx; font-weight: 800; }
.pilot-card { border-color: rgba(255, 184, 77, 0.25); }
.pilot-actions { display: flex; flex-direction: column; gap: 10rpx; margin-top: 14rpx; }
.pilot-reason { display: block; color: var(--ss-warn); margin-top: 6rpx; }
.ingest-card { border-color: rgba(138, 150, 255, 0.25); }
.ingest-row { display: flex; justify-content: space-between; gap: 12rpx; padding: 8rpx 0; font-size: 23rpx; }
.ingest-warning { display: block; margin-top: 10rpx; color: var(--ss-warn); }
.ingest-note { display: block; margin-top: 10rpx; }
.sim-time { font-size: 44rpx; font-weight: 800; font-variant-numeric: tabular-nums; display: block; }
.sim-note { display: block; margin-top: 14rpx; }
.event-row { display: flex; align-items: center; gap: 14rpx; padding: 10rpx 0; font-size: 23rpx; }
.event-dot { width: 10rpx; height: 10rpx; border-radius: 50%; background: var(--ss-accent); opacity: 0.7; }
.event-name { flex: 1; color: var(--ss-text); }
.event-time { color: var(--ss-muted); font-variant-numeric: tabular-nums; }
</style>
