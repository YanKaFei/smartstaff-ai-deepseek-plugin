<template>
  <view class="ss-page">
    <view v-if="loading" class="empty">正在读取门店配置…</view>
    <template v-else>
      <view class="steps">
        <view v-for="(label, idx) in stepLabels" :key="label" class="step" :class="{ active: step === idx, done: step > idx }">
          <view class="step-dot">{{ step > idx ? '✓' : idx + 1 }}</view>
          <text class="step-label">{{ label }}</text>
        </view>
      </view>

      <view v-if="step === 0" class="ss-card">
        <view class="ss-title">门店基本资料<text class="ss-pill accent">第 1 步</text></view>
        <view class="field">
          <view><text class="label">门店名称</text><text class="hint">展示在首页与邀约中</text></view>
          <input v-model="cfg.basic.name" placeholder="焰遇烤肉 · 科技园店" maxlength="30" />
        </view>
        <view class="field">
          <view><text class="label">营业时间</text><text class="hint">支持跨午夜</text></view>
          <view class="ss-row">
            <picker mode="time" :value="cfg.basic.hoursStart" @change="(e: any) => (cfg.basic.hoursStart = e.detail.value)">
              <view class="time-chip">{{ cfg.basic.hoursStart }}</view>
            </picker>
            <text class="ss-muted">至</text>
            <picker mode="time" :value="cfg.basic.hoursEnd" @change="(e: any) => (cfg.basic.hoursEnd = e.detail.value)">
              <view class="time-chip">{{ cfg.basic.hoursEnd }}</view>
            </picker>
          </view>
        </view>
        <view class="field address-field">
          <view><text class="label">门店位置</text><text class="hint">用于距离与到店时间估算</text></view>
          <input v-model="cfg.basic.address" class="address-input" placeholder="深圳市南山区…" maxlength="80" />
        </view>
        <view class="field">
          <view><text class="label">工作岗位</text><text class="hint">1.0 聚焦烤肉辅助</text></view>
          <input v-model="cfg.basic.jobType" placeholder="烤肉辅助" maxlength="20" />
        </view>
        <view class="field">
          <view><text class="label">岗位小时报酬</text><text class="hint">用于方案成本估算</text></view>
          <view class="ss-row"><text class="ss-muted">¥</text><input v-model.number="cfg.basic.hourlyRate" type="digit" class="num" /><text class="unit">/小时</text></view>
        </view>
      </view>

      <view v-if="step === 1" class="ss-card">
        <view class="ss-title">桌位配置<text class="ss-pill accent">第 2 步</text></view>
        <view v-for="key in tableKeys" :key="key" class="table-block">
          <view class="table-head">
            <text class="table-name">{{ typeLabel(key) }}</text>
            <text class="ss-pill">{{ cfg.tables[key].count }} 张 · {{ cfg.tables[key].seats }} 座</text>
          </view>
          <view class="field compact">
            <text class="label">数量</text>
            <view class="stepper">
              <view class="stepper-btn" @tap="stepTable(key, 'count', -1)">−</view>
              <text class="stepper-value">{{ cfg.tables[key].count }}</text>
              <view class="stepper-btn" @tap="stepTable(key, 'count', 1)">+</view>
            </view>
          </view>
          <view class="field compact">
            <text class="label">座位容量</text>
            <view class="stepper">
              <view class="stepper-btn" @tap="stepTable(key, 'seats', -1)">−</view>
              <text class="stepper-value">{{ cfg.tables[key].seats }}</text>
              <view class="stepper-btn" @tap="stepTable(key, 'seats', 1)">+</view>
            </view>
          </view>
          <view class="field compact">
            <text class="label">平均用餐</text>
            <view class="ss-row"><input v-model.number="cfg.tables[key].avgDiningMin" type="number" class="num" /><text class="unit">分钟</text></view>
          </view>
          <view class="field compact">
            <view><text class="label">服务工作量权重</text><text class="hint">大桌与中桌更耗人力</text></view>
            <input v-model.number="cfg.tables[key].weight" type="digit" class="num" />
          </view>
        </view>
        <view class="divider" />
        <view class="field">
          <view><text class="label">结账至离店</text><text class="hint">结账不代表桌位可复用</text></view>
          <view class="ss-row"><input v-model.number="cfg.tables.checkoutToLeaveMin" type="number" class="num" /><text class="unit">分钟</text></view>
        </view>
        <view class="field">
          <view><text class="label">离店至清台完成</text><text class="hint">翻台额外工作量</text></view>
          <view class="ss-row"><input v-model.number="cfg.tables.leaveToCleanMin" type="number" class="num" /><text class="unit">分钟</text></view>
        </view>
        <view class="divider" />
        <view class="ss-sub mapping-tip">顾客组与桌型适配：系统据此判断排队顾客需要的桌型。</view>
        <view v-for="key in tableKeys" :key="'map-' + key" class="mapping-row">
          <text class="mapping-type">{{ typeLabel(key) }}</text>
          <input v-model.number="mappingOf(key).min" type="number" class="map-input" />
          <text class="ss-muted">位 至</text>
          <input v-model.number="mappingOf(key).max" type="number" class="map-input" />
          <text class="ss-muted">位</text>
        </view>
      </view>

      <view v-if="step === 2" class="ss-card">
        <view class="ss-title">员工配置<text class="ss-pill accent">第 3 步</text></view>
        <view class="field">
          <view><text class="label">日常在岗人数</text><text class="hint">预测的现有服务产能</text></view>
          <view class="stepper">
            <view class="stepper-btn" @tap="cfg.staffing.onDutyCount = Math.max(0, cfg.staffing.onDutyCount - 1)">−</view>
            <text class="stepper-value">{{ cfg.staffing.onDutyCount }}</text>
            <view class="stepper-btn" @tap="cfg.staffing.onDutyCount += 1">+</view>
          </view>
        </view>
        <view class="field">
          <view><text class="label">默认排班时段</text><text class="hint">用于展示与工时参考</text></view>
          <view class="ss-row">
            <picker mode="time" :value="cfg.staffing.shiftStart" @change="(e: any) => (cfg.staffing.shiftStart = e.detail.value)">
              <view class="time-chip">{{ cfg.staffing.shiftStart }}</view>
            </picker>
            <text class="ss-muted">至</text>
            <picker mode="time" :value="cfg.staffing.shiftEnd" @change="(e: any) => (cfg.staffing.shiftEnd = e.detail.value)">
              <view class="time-chip">{{ cfg.staffing.shiftEnd }}</view>
            </picker>
          </view>
        </view>
        <view class="field">
          <view><text class="label">每人可负责{{ cfg.staffing.capacityBasis === 'physical_tables' ? '物理桌数' : '标准桌当量' }}</text><text class="hint">{{ cfg.staffing.capacityBasis === 'physical_tables' ? '按真实桌数计算' : '大桌会按权重折算为更多桌当量' }}</text></view>
          <view class="stepper">
            <view class="stepper-btn" @tap="cfg.staffing.tablesPerStaff = Math.max(1, cfg.staffing.tablesPerStaff - 1)">−</view>
            <text class="stepper-value">{{ cfg.staffing.tablesPerStaff }}</text>
            <view class="stepper-btn" @tap="cfg.staffing.tablesPerStaff += 1">+</view>
          </view>
        </view>
        <view class="field">
          <view><text class="label">岗位资格要求</text><text class="hint">未培训人员不会被匹配</text></view>
          <switch :checked="cfg.staffing.requireQualified" color="#d8ff4f" @change="(e: any) => (cfg.staffing.requireQualified = e.detail.value)" />
        </view>

        <view class="divider" />
        <view class="ss-sub config-label">烤肉服务模式</view>
        <view class="chip-row">
          <view v-for="mode in serviceModes" :key="mode.key" class="select-chip" :class="{ active: cfg.staffing.serviceMode === mode.key }" @tap="cfg.staffing.serviceMode = mode.key">
            {{ mode.label }}
          </view>
        </view>
        <view class="ss-sub">当前模式会影响服务强度：全程代烤 > 部分代烤 > 顾客自主烤制。该参数应与门店真实服务方式一致。</view>

        <view class="config-label">预测模型</view>
        <view class="chip-row">
          <view class="select-chip" :class="{ active: cfg.staffing.capacityModel === 'legacy' }" @tap="cfg.staffing.capacityModel = 'legacy'">旧算法基线</view>
          <view class="select-chip" :class="{ active: cfg.staffing.capacityModel === 'service_minutes' }" @tap="cfg.staffing.capacityModel = 'service_minutes'">服务分钟模型</view>
        </view>
        <view v-if="cfg.staffing.capacityModel === 'legacy'" class="chip-row">
          <view class="select-chip" :class="{ active: cfg.staffing.capacityBasis === 'standard_equivalent' }" @tap="cfg.staffing.capacityBasis = 'standard_equivalent'">标准桌当量口径</view>
          <view class="select-chip" :class="{ active: cfg.staffing.capacityBasis === 'physical_tables' }" @tap="cfg.staffing.capacityBasis = 'physical_tables'">物理桌口径</view>
        </view>
        <view v-if="cfg.staffing.capacityModel === 'service_minutes'" class="service-minutes">
          <view class="ss-sub">每桌完成一次服务的总工作分钟（含上菜、换盘、结账、清台）：</view>
          <view v-for="key in tableKeys" :key="'sm-' + key" class="mapping-row">
            <text class="mapping-type">{{ typeLabel(key) }}</text>
            <input v-model.number="cfg.staffing.serviceMinutes[key]" type="number" class="map-input" />
            <text class="ss-muted">分钟 / 每桌每餐</text>
          </view>
          <view class="field compact">
            <view><text class="label">每人每 30 分钟有效服务分钟</text><text class="hint">扣除走动、等待与管理损耗</text></view>
            <input v-model.number="cfg.staffing.effectiveServiceMinutesPerSlot" type="number" class="num" />
          </view>
          <view class="ss-pill" :class="cfg.staffing.calibrationStatus === 'calibrated' ? 'ok' : 'warn'">
            {{ cfg.staffing.calibrationStatus === 'calibrated' ? '已用真实记录校准' : '未校准：结果可靠性受限' }}
          </view>
        </view>
        <view class="divider" />
        <view class="ss-sub">不同桌型的服务工作量权重：小桌 {{ cfg.tables.small.weight }}、中桌 {{ cfg.tables.medium.weight }}、大桌 {{ cfg.tables.large.weight }}。旧算法仍保留为可比较基线。</view>
      </view>

      <view v-if="step === 3" class="ss-card">
        <view class="ss-title">数据来源<text class="ss-pill accent">第 4 步</text></view>
        <view class="source-list">
          <view v-for="src in sources" :key="src.key" class="source-card" :class="{ active: cfg.dataSource === src.key }" @tap="cfg.dataSource = src.key">
            <view class="ss-spread">
              <text class="source-name">{{ src.title }}</text>
              <text class="ss-pill" :class="{ accent: cfg.dataSource === src.key }">{{ cfg.dataSource === src.key ? '已选择' : '选择' }}</text>
            </view>
            <text class="ss-sub source-desc">{{ src.desc }}</text>
          </view>
        </view>
        <view class="field">
          <view><text class="label">影子模式（试运营）</text><text class="hint">只预测与记录建议，不发送邀约、不产生费用</text></view>
          <switch :checked="cfg.pilot.shadowMode" color="#d8ff4f" @change="(e: any) => (cfg.pilot.shadowMode = e.detail.value)" />
        </view>
        <view class="preview">
          <view class="ss-title">配置摘要</view>
          <view class="preview-row"><text class="ss-muted">门店</text><text>{{ cfg.basic.name }}</text></view>
          <view class="preview-row"><text class="ss-muted">营业</text><text>{{ cfg.basic.hoursStart }} - {{ cfg.basic.hoursEnd }}</text></view>
          <view class="preview-row"><text class="ss-muted">桌位</text><text>小 {{ cfg.tables.small.count }} / 中 {{ cfg.tables.medium.count }} / 大 {{ cfg.tables.large.count }}</text></view>
          <view class="preview-row"><text class="ss-muted">在岗</text><text>{{ cfg.staffing.onDutyCount }} 人 · 每人 {{ cfg.staffing.tablesPerStaff }} 桌</text></view>
          <view class="preview-row"><text class="ss-muted">岗位报酬</text><text>¥{{ cfg.basic.hourlyRate }}/小时</text></view>
          <view class="preview-row"><text class="ss-muted">试点</text><text>{{ cfg.pilot.shadowMode ? '影子模式（不邀约）' : '真实调配' }}</text></view>
        </view>
        <text class="ss-sub">完成配置后，明日起只需在首页确认现有数据，有变化再修改。</text>
      </view>

      <view class="wizard-actions">
        <button v-if="step > 0" class="btn-ghost" @tap="step -= 1">上一步</button>
        <button class="btn-primary" :disabled="saving" @tap="next">
          {{ saving ? '保存中…' : step === 3 ? '完成配置，进入门店' : '保存并继续' }}
        </button>
      </view>
    </template>
  </view>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import { onLoad } from '@dcloudio/uni-app';
import { requireRole, request, toast } from '../../api/client';
import type { StoreConfig } from '../../api/types';

const stepLabels = ['基本资料', '桌位配置', '员工配置', '数据来源'];
const tableKeys = ['small', 'medium', 'large'] as const;
const serviceModes = [
  { key: 'full' as const, label: '全程代烤' },
  { key: 'partial' as const, label: '部分代烤' },
  { key: 'self' as const, label: '顾客自主烤制' },
];
const sources = [
  { key: 'manual' as const, title: '人工快捷录入', desc: '店长在首页用加减按钮维护排队、在岗与桌位，适合立即上手。' },
  { key: 'simulator' as const, title: '内置门店模拟器', desc: '7 天历史 + 实时事件驱动，可加速演练客流、预测、补员、接单与完工。' },
  { key: 'external' as const, title: 'POS / 叫号系统（通用 Webhook）', desc: '通用 HMAC 事件契约已可用；具体厂商适配需 API 文档与凭据，未接入前不得称为已对接。' },
];
const step = ref(0);
const loading = ref(true);
const saving = ref(false);
const cfg = ref<StoreConfig>({} as StoreConfig);

onLoad(() => {
  if (!requireRole('manager')) return;
  void load();
});

async function load() {
  try {
    const data = await request<{ config: StoreConfig }>('/manager/store');
    cfg.value = data.config;
  } catch (err) {
    toast(err instanceof Error ? err.message : '加载失败');
  } finally {
    loading.value = false;
  }
}

function typeLabel(key: 'small' | 'medium' | 'large') {
  return key === 'small' ? '小桌' : key === 'medium' ? '中桌' : '大桌';
}

function mappingOf(key: 'small' | 'medium' | 'large') {
  let entry = cfg.value.tables.partyMapping.find((m) => m.type === key);
  if (!entry) {
    entry = { min: 1, max: 4, type: key };
    cfg.value.tables.partyMapping.push(entry);
  }
  return entry;
}

function stepTable(key: 'small' | 'medium' | 'large', field: 'count' | 'seats', delta: number) {
  const target = cfg.value.tables[key];
  const next = Number(target[field]) + delta;
  target[field] = field === 'count' ? Math.max(0, Math.min(100, next)) : Math.max(1, Math.min(30, next));
}

function normalized(): StoreConfig {
  const c = JSON.parse(JSON.stringify(cfg.value)) as StoreConfig;
  c.basic.hourlyRate = Number(c.basic.hourlyRate);
  c.tables.small.count = Math.round(Number(c.tables.small.count));
  c.tables.medium.count = Math.round(Number(c.tables.medium.count));
  c.tables.large.count = Math.round(Number(c.tables.large.count));
  for (const key of tableKeys) {
    c.tables[key].seats = Math.round(Number(c.tables[key].seats));
    c.tables[key].avgDiningMin = Math.round(Number(c.tables[key].avgDiningMin));
    c.tables[key].weight = Number(c.tables[key].weight);
  }
  c.tables.checkoutToLeaveMin = Math.round(Number(c.tables.checkoutToLeaveMin));
  c.tables.leaveToCleanMin = Math.round(Number(c.tables.leaveToCleanMin));
  c.tables.partyMapping = c.tables.partyMapping.map((m) => ({
    type: m.type,
    min: Math.max(1, Math.round(Number(m.min))),
    max: Math.max(1, Math.round(Number(m.max))),
  }));
  c.staffing.onDutyCount = Math.round(Number(c.staffing.onDutyCount));
  c.staffing.tablesPerStaff = Math.round(Number(c.staffing.tablesPerStaff));
  return c;
}

async function next() {
  if (saving.value) return;
  if (step.value === 0) {
    if (!cfg.value.basic.name.trim()) return toast('请填写门店名称');
    if (!cfg.value.basic.address.trim()) return toast('请填写门店位置');
    if (!(Number(cfg.value.basic.hourlyRate) > 0)) return toast('请填写岗位小时报酬');
  }
  if (step.value === 1) {
    const total = cfg.value.tables.small.count + cfg.value.tables.medium.count + cfg.value.tables.large.count;
    if (total <= 0) return toast('至少配置一张桌位');
  }
  saving.value = true;
  try {
    const nextStep = Math.min(4, step.value + 1);
    const data = await request<{ config: StoreConfig }>('/manager/store/config', {
      method: 'PATCH',
      data: { config: normalized(), step: nextStep },
    });
    cfg.value = data.config;
    if (step.value === 3) {
      await request('/manager/onboarding/finish', { method: 'POST', data: {} });
      toast('配置已保存', 'success');
      setTimeout(() => uni.reLaunch({ url: '/pages/manager/home' }), 350);
      return;
    }
    step.value = nextStep;
  } catch (err) {
    toast(err instanceof Error ? err.message : '保存失败');
  } finally {
    saving.value = false;
  }
}
</script>

<style scoped>
.steps { display: flex; justify-content: space-between; margin: 10rpx 0 30rpx; }
.step { display: flex; flex-direction: column; align-items: center; gap: 8rpx; flex: 1; color: var(--ss-muted); }
.step-dot {
  width: 44rpx; height: 44rpx; border-radius: 50%; border: 1rpx solid var(--ss-line);
  display: flex; align-items: center; justify-content: center; font-size: 22rpx;
}
.step.active .step-dot { background: var(--ss-accent); border-color: var(--ss-accent); color: var(--ss-accent-ink); font-weight: 800; }
.step.done .step-dot { border-color: var(--ss-accent); color: var(--ss-accent); }
.step.active .step-label { color: var(--ss-text); }
.step-label { font-size: 20rpx; }
.time-chip { padding: 12rpx 20rpx; border: 1rpx solid var(--ss-line); border-radius: 14rpx; font-size: 27rpx; background: var(--ss-panel-2); }
.address-field { display: block; }
.address-input { display: flex; align-items: center; width: 100% !important; max-width: 100% !important; height: 84rpx; min-height: 84rpx; line-height: 56rpx; text-align: left; margin-top: 12rpx; padding: 0 16rpx; background: var(--ss-panel-2); border: 1rpx solid var(--ss-line); border-radius: 14rpx; box-sizing: border-box; }
.config-label { display: block; font-size: 26rpx; font-weight: 700; margin: 22rpx 0 10rpx; }
.chip-row { display: flex; flex-wrap: wrap; gap: 12rpx; margin-bottom: 12rpx; }
.select-chip { padding: 14rpx 20rpx; border-radius: 999rpx; border: 1rpx solid var(--ss-line); color: var(--ss-muted); font-size: 23rpx; }
.select-chip.active { background: var(--ss-accent); border-color: var(--ss-accent); color: var(--ss-accent-ink); font-weight: 700; }
.service-minutes { margin-top: 12rpx; padding: 16rpx; border: 1rpx solid var(--ss-line); border-radius: 16rpx; background: var(--ss-panel-2); }
.mapping-tip { display: block; margin-bottom: 6rpx; }
.mapping-row { display: flex; align-items: center; gap: 10rpx; padding: 12rpx 0; }
.mapping-type { width: 80rpx; font-size: 24rpx; color: var(--ss-muted); }
.map-input { width: 96rpx; text-align: center; font-size: 26rpx; border-bottom: 1rpx solid var(--ss-line); padding: 8rpx 0; }
.table-block { border: 1rpx solid var(--ss-line); border-radius: 20rpx; padding: 18rpx 20rpx; margin-bottom: 16rpx; background: var(--ss-panel-2); }
.table-head { display: flex; justify-content: space-between; align-items: center; padding-bottom: 6rpx; }
.table-name { font-size: 28rpx; font-weight: 700; }
.field.compact { padding: 14rpx 0; }
.num { width: 120rpx; text-align: right; font-size: 28rpx; }
.source-list { display: flex; flex-direction: column; gap: 14rpx; }
.source-card { border: 1rpx solid var(--ss-line); border-radius: 20rpx; padding: 20rpx; background: var(--ss-panel-2); }
.source-card.active { border-color: rgba(216, 255, 79, 0.55); background: rgba(216, 255, 79, 0.06); }
.source-name { font-size: 27rpx; font-weight: 700; }
.source-desc { display: block; margin-top: 8rpx; }
.preview { margin-top: 26rpx; border-top: 1rpx solid var(--ss-line); padding-top: 22rpx; }
.preview-row { display: flex; justify-content: space-between; padding: 9rpx 0; font-size: 24rpx; }
.wizard-actions { display: flex; gap: 16rpx; margin-top: 26rpx; }
.wizard-actions .btn-ghost { flex: 0 0 200rpx; }
.wizard-actions .btn-primary { flex: 1; }
</style>
