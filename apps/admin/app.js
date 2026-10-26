(() => {
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const state = {
    token: localStorage.getItem('ss_token') || '',
    refreshToken: localStorage.getItem('ss_refresh') || '',
    storeId: localStorage.getItem('ss_store') || '',
    stores: [],
    overview: null,
    tab: 'overview',
    staffFilter: 'pending',
    staff: [],
    timer: null,
  };
  const STATUS_TEXT = {
    invited: '待接受', confirmed: '已确认', checked_in: '服务中', completed: '已完成',
    cancelled: '已取消', no_show: '缺席', pending: '待处理', accepted: '已接受',
    rejected: '已拒绝', expired: '已超时', queued: '排队中', called: '已叫号', seated: '已入座',
    approved: '已通过', suspended: '已暂停',
  };
  const SIM_STATUS = { high: '高', medium: '中', low: '低' };
  const BOTTLENECK = { staff: '人员瓶颈', table: '桌位瓶颈', none: '供需平衡' };

  function esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function fmtTime(ms) {
    if (!ms) return '—';
    const d = new Date(ms + 8 * 3600 * 1000);
    return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
  }
  function fmtDateTime(ms) {
    if (!ms) return '—';
    const d = new Date(ms + 8 * 3600 * 1000);
    return `${d.getUTCMonth() + 1}/${d.getUTCDate()} ${fmtTime(ms)}`;
  }
  function toast(message, isError = false) {
    const el = $('#toast');
    el.textContent = message;
    el.className = 'toast' + (isError ? ' error' : '');
    clearTimeout(toast.t);
    toast.t = setTimeout(() => el.classList.add('hidden'), 2600);
  }
  async function parseJson(res) {
    let json = null;
    try { json = await res.json(); } catch { /* ignore */ }
    return json;
  }
  async function api(path, options = {}, retried = false) {
    const res = await fetch('/api' + path, {
      method: options.method || 'GET',
      headers: { 'content-type': 'application/json', ...(state.token ? { authorization: 'Bearer ' + state.token } : {}) },
      body: options.body ? (typeof options.body === 'string' ? options.body : JSON.stringify(options.body)) : undefined,
    });
    const json = await parseJson(res);
    if (res.status === 401 && !retried && state.refreshToken && path !== '/auth/refresh') {
      const refreshed = await refreshTokens();
      if (refreshed) return api(path, options, true);
      logout();
      throw new Error('登录已过期，请重新登录');
    }
    if (!res.ok || !json || json.ok === false) {
      if (res.status === 401) logout();
      throw new Error((json && json.error && json.error.message) || `请求失败 (${res.status})`);
    }
    return json.data;
  }
  async function refreshTokens() {
    try {
      const res = await fetch('/api/auth/refresh', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ refreshToken: state.refreshToken }),
      });
      const json = await parseJson(res);
      if (!res.ok || !json || json.ok === false) return false;
      state.token = json.data.token;
      state.refreshToken = json.data.refreshToken;
      localStorage.setItem('ss_token', state.token);
      localStorage.setItem('ss_refresh', state.refreshToken);
      return true;
    } catch {
      return false;
    }
  }

  function login() {
    $('#login').classList.remove('hidden');
    $('#shell').classList.add('hidden');
  }
  function logout() {
    localStorage.removeItem('ss_token');
    localStorage.removeItem('ss_refresh');
    localStorage.removeItem('ss_store');
    state.token = '';
    state.refreshToken = '';
    clearInterval(state.timer);
    login();
  }
  async function enter(token, refreshToken = '') {
    state.token = token;
    state.refreshToken = refreshToken;
    localStorage.setItem('ss_token', token);
    if (refreshToken) localStorage.setItem('ss_refresh', refreshToken);
    $('#login').classList.add('hidden');
    $('#shell').classList.remove('hidden');
    await loadStores();
    await refresh();
    clearInterval(state.timer);
    state.timer = setInterval(() => {
      if (document.visibilityState === 'visible' && ['overview', 'simulator'].includes(state.tab)) refresh(true);
    }, 8000);
  }
  async function loadStores() {
    state.stores = await api('/admin/stores');
    if (!state.storeId || !state.stores.some((s) => s.id === state.storeId)) {
      state.storeId = state.stores[0] ? state.stores[0].id : '';
    }
    localStorage.setItem('ss_store', state.storeId);
    $('#store-select').innerHTML = state.stores.map((s) => `<option value="${esc(s.id)}"${s.id === state.storeId ? ' selected' : ''}>${esc(s.name)} · ${esc(s.manager_code)}</option>`).join('');
  }
  async function refresh(silent = false) {
    try {
      state.overview = await api('/admin/overview?storeId=' + encodeURIComponent(state.storeId));
      renderOverview();
      if (state.tab === 'simulator') renderSimulator();
      if (state.tab === 'staff') await loadStaff();
      if (state.tab === 'orders') await loadOrders();
      if (state.tab === 'logs') await loadLogs();
    } catch (err) {
      if (!silent) toast(err.message, true);
    }
  }

  function metric(label, value, suffix = '', alert = false) {
    return `<div class="metric${alert ? ' alert' : ''}"><div class="label">${esc(label)}</div><div class="value">${esc(value)}${suffix ? `<small>${esc(suffix)}</small>` : ''}</div></div>`;
  }
  const PAGE_META = {
    overview: ['经营概览', '门店经营、桌位、排队与 AI 人力需求'],
    staff: ['人员审核', '审核兼职资格与岗位培训状态'],
    orders: ['订单与异常', '工作邀约、班次状态与异常处理'],
    simulator: ['门店模拟器', '真实写入业务状态；可加速观察预测、补员与接单链路。'],
    data: ['数据接入 / AI', '经营事件、Webhook 签名、AI 用量与预算'],
    ai: ['AI 模型与 API', 'DeepSeek 业务推理设置、凭据、连接测试和用量'],
    logs: ['审计日志', '系统操作与状态变更追踪'],
  };
  function setPageMeta(tab) {
    const meta = PAGE_META[tab] || PAGE_META.overview;
    $('#page-title').textContent = meta[0];
    if (state.overview) {
      $('#page-sub').textContent = tab === 'overview'
        ? `${state.overview.store.name} · ${state.overview.today.businessDate} · ${state.overview.store.address}`
        : meta[1];
    }
  }
  function renderOverview() {
    const o = state.overview;
    if (!o) return;
    const f = o.forecast;
    const t = o.today;
    if (state.tab === 'overview') {
      $('#page-title').textContent = '经营概览';
      $('#page-sub').textContent = `${o.store.name} · ${t.businessDate} · ${o.store.address}`;
    }
    $('#sim-clock').textContent = o.sim.nowLabel;
    $('#sim-mode').textContent = o.sim.running ? `模拟运行中 · ${o.sim.speed}×` : '模拟器已暂停';
    const budget = o.system.aiBudget;
    $('#system-line').textContent = budget
      ? `DeepSeek ${o.system.aiConfigured ? o.system.model : '未配置'} · 今日 $${budget.dailyUsedUsd}/$${budget.dailyBudgetUsd}`
      : `DeepSeek: ${o.system.aiConfigured ? o.system.model : '未配置（确定性降级）'}`;
    $('#staff-badge').textContent = o.counts.pendingStaff || '';
    $('#exc-badge').textContent = o.counts.openExceptions || '';

    $('#overview-metrics').innerHTML = [
      metric('在岗员工', t.businessDay.onDutyStaff, '人'),
      metric('当前排队', t.queue.groups, '组'),
      metric('最新叫号', t.queue.latestCallNo, '号'),
      metric('今日已入座', t.metrics.seatedToday, '组'),
      metric('AI 缺口', f ? f.peakGap : '—', f ? '人' : '', Boolean(f && f.peakGap > 0)),
      metric('待审核兼职', o.counts.pendingStaff, '人'),
    ].join('');

    const rows = t.tables.byType.map((type) => {
      const total = Math.max(1, type.total);
      return `<div class="ts-row"><span>${esc(type.label)} <b>${type.total}</b></span>
        <span class="ts-bar">
          <span class="bar-dining" style="width:${(type.dining / total) * 100}%" title="用餐中 ${type.dining}"></span>
          <span class="bar-checkout" style="width:${(type.checkout / total) * 100}%" title="已结账 ${type.checkout}"></span>
          <span class="bar-cleaning" style="width:${(type.cleaning / total) * 100}%" title="待清台 ${type.cleaning}"></span>
          <span class="bar-free" style="width:${(type.available / total) * 100}%" title="空闲 ${type.available}"></span>
        </span><span>空闲 ${type.available}</span></div>`;
    }).join('');
    $('#table-status').innerHTML = rows;

    if (!f) {
      $('#forecast-summary').innerHTML = '<p class="empty">尚未生成预测。进入模拟器推进时间，或由店长在小程序内生成。</p>';
    } else {
      const ranges = (f.gapRanges || []).map((r) => `${fmtTime(r.startAt)}-${fmtTime(r.endAt)} 需 ${r.headcount} 人`).join('；') || '无增派时段';
      $('#forecast-summary').innerHTML = `
        <div class="fc-head"><strong>${f.peakGap > 0 ? '缺 ' + f.peakGap + ' 人' : '人力充足'}</strong>
          <span class="pill ${f.peakGap > 0 ? 'warn' : 'ok'}">${BOTTLENECK[f.bottleneck] || f.bottleneck}</span>
          <span class="pill">可靠性 ${SIM_STATUS[f.reliability] || f.reliability}</span>
          <span class="pill ${f.aiStatus === 'ok' ? 'ok' : ''}">${f.aiStatus === 'ok' ? 'AI 已解释' : '确定性引擎'}</span>
        </div>
        <div class="fc-reason">${esc(f.ai && f.ai.summary ? f.ai.summary : f.reliabilityReason)}</div>
        <div class="fc-reason">需求 ${f.peakRequiredStaff} 人 / 在岗 ${f.onDutyStaff} 人 · ${esc(ranges)}</div>
        <div class="fc-reason">${esc(f.ai && f.ai.bottleneckExplanation ? f.ai.bottleneckExplanation : f.bottleneckReason)}</div>`;
    }

    $('#overview-exceptions').innerHTML = o.openExceptions.length
      ? o.openExceptions.slice(0, 5).map((e) => `<div class="list-item"><div><b>${esc(e.type)}</b> · ${esc(e.message)}<div class="meta">${fmtDateTime(e.createdAt)}</div></div>
          <button class="ghost" data-resolve="${esc(e.id)}">标记处理</button></div>`).join('')
      : '<p class="empty">没有待处理异常。</p>';

    $('#overview-shifts').innerHTML = o.recentShifts.length
      ? o.recentShifts.slice(0, 6).map((s) => `<div class="list-item"><div><b>${esc(s.staffName)}</b> · ${esc(s.role)}<div class="meta">${fmtDateTime(s.startAt)}-${fmtTime(s.endAt)} · ¥${esc(s.hourlyRate)}/h</div></div>
          <span class="pill ${s.status === 'completed' ? 'ok' : s.status === 'no_show' ? 'bad' : ''}">${STATUS_TEXT[s.status] || s.status}</span></div>`).join('')
      : '<p class="empty">今日还没有班次。</p>';

    $$('[data-resolve]').forEach((btn) => btn.addEventListener('click', async () => {
      try { await api('/admin/exceptions/' + btn.dataset.resolve + '/resolve', { method: 'POST' }); toast('已标记处理'); await refresh(); }
      catch (err) { toast(err.message, true); }
    }));
  }

  function renderSimulator() {
    const o = state.overview;
    if (!o) return;
    if (state.tab === 'simulator') {
      $('#page-title').textContent = '门店模拟器';
      $('#page-sub').textContent = '真实写入业务状态；可加速观察预测、补员与接单链路。';
    }
    $('#sim-big').textContent = o.sim.nowLabel;
    $('#sim-date').textContent = `${o.today.businessDate} · ${o.sim.running ? '运行中' : '已暂停'} · 数据源 ${o.sim.dataSource}`;
    $('#sim-toggle').textContent = o.sim.running ? '暂停模拟' : '开始模拟';
    $('#sim-speed').value = String(o.sim.speed);
    const s = o.sim.lastSummary;
    $('#sim-summary').innerHTML = s
      ? [
          ['入座', s.seated], ['结账', s.checkout], ['离店', s.left], ['清台', s.cleaned], ['叫号', s.calls], ['当前排队', s.queueGroups],
        ].map(([k, v]) => `<div><b>${esc(v)}</b>${esc(k)}</div>`).join('')
      : '尚未推进。点击 +15 分钟开始。';
    const f = o.forecast;
    if (!f) {
      $('#sim-slots').innerHTML = '<p class="empty">尚无预测。推进至少 1 分钟后，系统按 30 分钟节奏自动生成；也可让店长在小程序手动生成。</p>';
    } else {
      $('#sim-slots').innerHTML = f.slots.map((slot) => `<div class="slot${slot.gap > 0 ? ' need' : ''}">
        <span class="head">${esc(slot.label)}</span>
        <span>在用 ${slot.projectedActiveTables} 桌</span>
        <span>排队 ${slot.projectedQueueGroups} 组</span>
        <span>需求 ${slot.requiredStaff} 人</span>
        <span>${slot.gap > 0 ? `<b style="color:var(--warn)">缺 ${slot.gap} 人</b>` : '可覆盖'}</span>
        <span class="pill ${slot.bottleneck === 'staff' ? 'warn' : slot.bottleneck === 'table' ? 'bad' : 'ok'}">${BOTTLENECK[slot.bottleneck]}</span>
      </div>`).join('');
    }
  }

  async function loadStaff() {
    const data = await api('/admin/staff?storeId=' + encodeURIComponent(state.storeId));
    state.staff = data.items;
    const filter = state.staffFilter;
    const items = filter === 'all' ? data.items : data.items.filter((s) => s.status === filter);
    $('#staff-list').innerHTML = items.length ? items.map((s) => `
      <div class="staff-card">
        <h3>${esc(s.nickname)} <span class="pill ${s.status === 'approved' ? 'ok' : s.status === 'pending' ? 'warn' : 'bad'}">${STATUS_TEXT[s.status] || s.status}</span>${s.source === 'simulator' ? '<span class="pill">模拟数据</span>' : ''}</h3>
        <div class="meta">${esc(s.area)} · ${s.distanceKm}km · ¥${s.expectedRate}/h · 经验 ${s.experienceYears} 年<br>
          准点率 ${Math.round(s.onTimeRate * 100)}% · 完成 ${s.shiftsCompleted} 班 · 缺席 ${s.noShowCount} 次<br>
          培训：${s.qualified ? '已合格' : '未合格'} · 技能 ${esc((s.skills || []).join(' / '))}<br>
          手机验证：${s.phoneVerified ? '已验证' : '未验证'} · 微信绑定：${s.openidBound ? '已绑定' : '未绑定'}<br>
          可工作时间：${s.availability.length ? s.availability.map((w) => `周${['日','一','二','三','四','五','六'][w.weekday]} ${String(Math.floor(w.startMin / 60)).padStart(2, '0')}:${String(w.startMin % 60).padStart(2, '0')}-${String(Math.floor(w.endMin / 60) % 24).padStart(2, '0')}:${String(w.endMin % 60).padStart(2, '0')}`).join('，') : '未填写'}<br>
          手机：${esc(s.phone || '—')}</div>
        <div class="actions">
          ${s.status !== 'approved' && s.qualified ? `<button class="ok" data-review="${esc(s.id)}" data-status="approved" data-qualified="true">通过并允许接单</button>` : ''}
          ${!s.qualified ? `<button class="ghost" data-review="${esc(s.id)}" data-status="${esc(s.status)}" data-qualified="true">标记培训合格</button>` : ''}
          ${!s.phoneVerified ? `<button class="ghost" data-verify-phone="${esc(s.id)}">核验手机号</button>` : ''}
          ${s.status !== 'suspended' ? `<button class="ghost" data-review="${esc(s.id)}" data-status="suspended" data-qualified="${s.qualified}">暂停接单</button>` : ''}
          ${s.status !== 'rejected' ? `<button class="danger" data-review="${esc(s.id)}" data-status="rejected" data-qualified="${s.qualified}">驳回</button>` : ''}
        </div>
      </div>`).join('') : '<p class="empty">该筛选下没有人员。</p>';

    $$('[data-verify-phone]').forEach((btn) => btn.addEventListener('click', async () => {
      try {
        await api('/admin/staff/' + btn.dataset.verifyPhone + '/verify-phone', { method: 'POST' });
        toast('手机号已标记为验证');
        await refresh();
      } catch (err) { toast(err.message, true); }
    }));

    $$('[data-review]').forEach((btn) => btn.addEventListener('click', async () => {
      try {
        await api('/admin/staff/' + btn.dataset.review + '/review', {
          method: 'POST',
          body: { status: btn.dataset.status, qualified: btn.dataset.qualified === 'true' },
        });
        toast('人员状态已更新');
        await refresh();
      } catch (err) { toast(err.message, true); }
    }));
  }

  async function loadOrders() {
    const [exceptions, shifts] = await Promise.all([
      api('/admin/exceptions?storeId=' + encodeURIComponent(state.storeId)),
      api('/admin/shifts?storeId=' + encodeURIComponent(state.storeId)),
    ]);
    $('#exception-list').innerHTML = exceptions.length ? exceptions.slice(0, 20).map((e) => `<div class="list-item">
      <div><b>${esc(e.type)}</b> · ${esc(e.message)}<div class="meta">${fmtDateTime(e.createdAt)} · ${e.status === 'open' ? '待处理' : '已处理'}</div></div>
      ${e.status === 'open' ? `<button class="ghost" data-exc="${esc(e.id)}">标记处理</button>` : '<span class="pill ok">已处理</span>'}
    </div>`).join('') : '<p class="empty">暂无异常记录。</p>';
    $('#shift-list').innerHTML = shifts.length ? shifts.slice(0, 40).map((s) => `<div class="list-item">
      <div><b>${esc(s.staffName)}</b> · ${esc(s.role)} · ${fmtDateTime(s.startAt)}-${fmtTime(s.endAt)}
        <div class="meta">邀约 ${s.offer ? (STATUS_TEXT[s.offer.status] || s.offer.status) + ' / 第' + s.offer.attempt + '轮' : '—'} · 实际 ${s.actualMinutes || 0} 分钟 · ¥${s.payAmount || 0}</div></div>
      <span class="pill ${s.status === 'completed' ? 'ok' : s.status === 'no_show' ? 'bad' : ''}">${STATUS_TEXT[s.status] || s.status}</span>
    </div>`).join('') : '<p class="empty">暂无班次。</p>';
    $$('[data-exc]').forEach((btn) => btn.addEventListener('click', async () => {
      try { await api('/admin/exceptions/' + btn.dataset.exc + '/resolve', { method: 'POST' }); toast('已标记处理'); await refresh(); }
      catch (err) { toast(err.message, true); }
    }));
  }

  async function loadData() {
    const [status, events, ai] = await Promise.all([
      api('/admin/ingest/status?storeId=' + encodeURIComponent(state.storeId)),
      api('/admin/ingest/events?storeId=' + encodeURIComponent(state.storeId)),
      api('/admin/ai-usage?storeId=' + encodeURIComponent(state.storeId)),
    ]);
    $('#ingest-status').innerHTML = `
      <div class="list-item"><div><b>${status.stale ? '数据陈旧' : '同步正常'}</b><div class="meta">来源 ${esc(status.dataSource)} · 最近 ${status.lastSource || '—'} · ${status.lastEvent ? fmtDateTime(status.lastEvent.occurredAt) : '暂无事件'}</div></div>
        <span class="pill ${status.stale ? 'warn' : 'ok'}">${status.stale ? '需检查' : '在线'}</span></div>
      <div class="list-item"><div>已接收 / 已应用 / 异常<div class="meta">${JSON.stringify(status.counts)}</div></div>
        <span class="pill ${status.webhookConfigured ? 'ok' : 'warn'}">${status.webhookConfigured ? 'Webhook 已配置' : 'Webhook 未配置'}</span></div>`;
    $('#ai-usage').innerHTML = `
      <div class="list-item"><div><b>$${ai.budget.dailyUsedUsd}</b> / $${ai.budget.dailyBudgetUsd} 今日<div class="meta">30 日 $${ai.budget.monthlyUsedUsd} / $${ai.budget.monthlyBudgetUsd} · 模型 ${esc(ai.model)}</div></div>
        <span class="pill ${ai.budget.allowed ? 'ok' : 'bad'}">${ai.budget.allowed ? '预算可用' : '预算已用尽'}</span></div>
      ${ai.usage.slice(0, 8).map((u) => `<div class="list-item"><div>${esc(u.status)} ${u.cacheHit ? '· 缓存' : ''}<div class="meta">${u.totalTokens} tokens · ${u.latencyMs}ms · $${u.costUsd} · ${esc(u.costBasis)}</div></div><span class="pill ${u.status === 'ok' ? 'ok' : u.status === 'cache_hit' ? '' : 'warn'}">${esc(u.model)}</span></div>`).join('') || '<p class="empty">暂无 AI 调用记录（未配置 Key 时不会调用）。</p>'}`;
    $('#ingest-events').innerHTML = events.length ? events.slice(0, 40).map((e) => `
      <div class="list-item"><div><b>${esc(e.eventType)}</b> · ${esc(e.source)} · ${esc(e.status)}
        <div class="meta">${fmtDateTime(e.occurredAt)} · ${esc(e.externalId)}${e.error ? ' · ' + esc(e.error) : ''}</div></div>
        ${['error','stale'].includes(e.status) ? `<button class="ghost" data-replay="${esc(e.id)}">重放</button>` : ''}
      </div>`).join('') : '<p class="empty">暂无摄取事件。</p>';
    $$('[data-replay]').forEach((btn) => btn.addEventListener('click', async () => {
      try { await api('/admin/ingest/' + btn.dataset.replay + '/replay', { method: 'POST' }); toast('已重放'); await loadData(); }
      catch (err) { toast(err.message, true); }
    }));
  }

  let lastImportId = null;

  function fileToBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  async function importData() {
    const input = $('#import-file');
    const file = input.files?.[0];
    if (!file) return toast('请选择 CSV 或 XLSX 文件', true);
    const ext = file.name.toLowerCase().endsWith('.xlsx') ? 'xlsx' : 'csv';
    const contentBase64 = await fileToBase64(file);
    const data = await api(`/admin/stores/${encodeURIComponent(state.storeId)}/data/import`, {
      method: 'POST',
      body: JSON.stringify({
        filename: file.name,
        format: ext,
        contentBase64,
        dataOrigin: $('#import-origin').value,
      }),
    });
    lastImportId = data.importId;
    $('#run-replay').disabled = false;
    $('#import-result').innerHTML = `<div class="list-item"><div><b>已导入 ${esc(data.importId)}</b><div class="meta">${esc(data.quality.dataOrigin)} · 有效 ${data.quality.validCount} / 总 ${data.quality.rowCount} · 重复 ${data.quality.duplicateCount} · 无效 ${data.quality.invalidCount} · 时间顺序异常 ${data.quality.timeOrderIssues}</div></div><span class="pill ${data.quality.invalidCount || data.quality.duplicateCount ? 'warn' : 'ok'}">数据质量</span></div>
      <p class="tiny">缺失统计：${esc(JSON.stringify(data.quality.missing))}</p>`;
  }

  async function submitFeedback() {
    const reasons = $('#fb-reasons').value.split(',').map((s) => s.trim()).filter(Boolean);
    const body = {
      recommended: Number($('#fb-recommended').value || 0),
      managerActual: Number($('#fb-actual').value || 0),
      onDuty: Number($('#fb-onduty').value || 0),
      overloaded: $('#fb-decision').value === 'too_few',
      decision: $('#fb-decision').value,
      reasons,
      correction: $('#fb-correction').value || undefined,
    };
    await api(`/admin/stores/${encodeURIComponent(state.storeId)}/pilot/feedback`, { method: 'POST', body: JSON.stringify(body) });
    toast('反馈已记录');
  }

  async function runReplay() {
    if (!lastImportId) return toast('先导入数据', true);
    const data = await api(`/admin/stores/${encodeURIComponent(state.storeId)}/data/replay`, {
      method: 'POST',
      body: JSON.stringify({ importId: lastImportId }),
    });
    $('#replay-result').innerHTML = `<div class="list-item"><div><b>回放完成 · ${esc(data.dataOrigin)}</b><div class="meta">${data.points} 个预测时点 · ${data.runs.length} 个模型变体</div></div></div>` +
      data.runs.map((r) => `<div class="list-item"><div><b>${esc(r.model)} / ${esc(r.serviceMode)}</b><div class="meta">MAE ${r.metrics.mae ?? '—'} · 偏差 ${r.metrics.bias ?? '—'} · 过度 ${r.metrics.overstaffedPersonHours} 人时 · 不足 ${r.metrics.understaffedPersonHours} 人时 · 高峰缺人 ${r.metrics.peakMissCount}</div></div><span class="pill">${r.metrics.evaluatedCount} 评估</span></div>`).join('');
  }

  async function loadAi() {
    const [settings, status, usage] = await Promise.all([
      api('/admin/ai/settings'),
      api('/admin/ai/status'),
      api('/admin/ai/usage?storeId=' + encodeURIComponent(state.storeId)),
    ]);
    state.ai = { settings, status, usage };
    $('#ai-provider').value = 'DeepSeek';
    $('#ai-base-url').value = settings.baseUrl;
    $('#ai-model').value = settings.model;
    $('#ai-timeout').value = settings.timeoutMs;
    $('#ai-enabled').value = String(settings.enabled);
    $('#ai-daily-budget').value = settings.dailyBudgetUsd;
    $('#ai-monthly-budget').value = settings.monthlyBudgetUsd;
    $('#ai-key').value = '';
    $('#ai-key').placeholder = settings.credentialConfigured ? '已配置；输入新 Key 替换' : '未配置；请输入 DeepSeek API Key';
    const lastSuccess = settings.lastSuccessAt ? fmtDateTime(settings.lastSuccessAt) : '—';
    const lastTest = settings.lastTestAt ? fmtDateTime(settings.lastTestAt) : '—';
    const statusLabel = settings.credentialConfigured
      ? (settings.enabled ? (settings.lastTestStatus === 'ok' ? '连接成功' : '已配置，未验证') : '已停用')
      : '未配置';
    $('#ai-status').innerHTML = `
      <b>${esc(statusLabel)}</b>
      <span class="meta">凭据：${esc(settings.credentialHint)} · 来源 ${esc(settings.credentialSource)}</span>
      <span class="meta">模型 ${esc(settings.model)} · 超时 ${settings.timeoutMs}ms · 最近成功 ${esc(lastSuccess)}</span>
      <span class="meta">最近测试 ${esc(lastTest)} · ${esc(settings.lastTestStatus || '—')}${settings.lastTestError ? ' · ' + esc(settings.lastTestError) : ''}</span>
      <span class="meta">计价：$${settings.pricing.inputPerMTokUsd}/M input · $${settings.pricing.outputPerMTokUsd}/M output · ${esc(settings.pricing.updatedAt || '未标注更新日期')}</span>`;
    $('#ai-usage').innerHTML = `
      <div class="list-item"><div><b>${usage.total}</b> 次调用 · 成功 ${usage.successes} · 失败 ${usage.failures}<div class="meta">成功率 ${usage.successRate === null ? '—' : Math.round(usage.successRate * 100) + '%'} · 平均 ${usage.averageLatencyMs ?? '—'}ms · 今日预算 $${usage.budget.dailyUsedUsd}/$${usage.budget.dailyBudgetUsd}</div></div><span class="pill ${usage.budget.allowed ? 'ok' : 'warn'}">${usage.budget.allowed ? '预算可用' : '预算用尽'}</span></div>
      <div class="list-item"><div>tokens：input ${usage.inputTokens} / output ${usage.outputTokens}<div class="meta">估算费用 $${usage.estimatedCostUsd} · ${esc(usage.costBasis)} · 价格更新 ${esc(usage.pricingUpdatedAt || '未标注')}</div></div><span class="pill">${usage.lastFailure ? '最近失败 ' + esc(usage.lastFailure.errorCode || usage.lastFailure.status) : '无失败'}</span></div>`;
    $('#ai-recent').innerHTML = usage.recent.length ? usage.recent.map((r) => `
      <div class="list-item"><div>${esc(r.status)} · ${esc(r.model)}<div class="meta">${r.totalTokens} tokens · ${r.latencyMs}ms · $${r.costUsd} · ${fmtDateTime(r.createdAt)}</div></div><span class="pill ${r.status === 'ok' ? 'ok' : r.status === 'cache_hit' ? '' : 'warn'}">${esc(r.errorCode || r.status)}</span></div>`).join('') : '<p class="empty">暂无调用记录。</p>';
  }

  async function saveAiSettings() {
    const data = await api('/admin/ai/settings', {
      method: 'PUT',
      body: JSON.stringify({
        model: $('#ai-model').value,
        timeoutMs: Number($('#ai-timeout').value),
        enabled: $('#ai-enabled').value === 'true',
        dailyBudgetUsd: Number($('#ai-daily-budget').value),
        monthlyBudgetUsd: Number($('#ai-monthly-budget').value),
      }),
    });
    toast('AI 配置已保存');
    await loadAi();
    return data;
  }

  async function saveAiKey() {
    const apiKey = $('#ai-key').value.trim();
    if (!apiKey) return toast('请输入新 API Key', true);
    await api('/admin/ai/credential', { method: 'PUT', body: JSON.stringify({ apiKey }) });
    $('#ai-key').value = '';
    toast('API Key 已加密保存；页面不会显示原始 Key');
    await loadAi();
  }

  async function testAi() {
    try {
      const data = await api('/admin/ai/test', { method: 'POST', body: JSON.stringify({}) });
      toast(data.status === 'CONNECTED' ? '连接成功' : `连接失败：${data.errorCode || ''} ${data.message || ''}`);
      await loadAi();
    } catch (err) {
      toast(err.message, true);
      await loadAi().catch(() => undefined);
    }
  }

  async function revokeAiKey() {
    if (!window.confirm('撤销服务端已保存的 DeepSeek Key？不会影响环境变量中的 Key（如有）。')) return;
    await api('/admin/ai/credential', { method: 'DELETE', body: JSON.stringify({}) });
    toast('已撤销服务端保存的 Key');
    await loadAi();
  }

  async function loadLogs() {
    const logs = await api('/admin/logs?limit=100');
    $('#log-list').innerHTML = logs.map((l) => `<div class="log-row"><span>${fmtDateTime(l.createdAt)}</span><span>${esc(l.actorRole || 'system')}</span><span><b>${esc(l.action)}</b> ${esc(l.entity || '')} ${esc(l.entityId || '')}</span></div>`).join('') || '<p class="empty">暂无日志。</p>';
  }

  function showTab(tab) {
    state.tab = tab;
    $$('#nav button').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
    $$('.panel').forEach((p) => p.classList.add('hidden'));
    const panel = $('#panel-' + tab);
    if (panel) panel.classList.remove('hidden');
    if (tab === 'staff') loadStaff().catch((e) => toast(e.message, true));
    if (tab === 'orders') loadOrders().catch((e) => toast(e.message, true));
    if (tab === 'logs') loadLogs().catch((e) => toast(e.message, true));
    if (tab === 'data') loadData().catch((e) => toast(e.message, true));
    if (tab === 'ai') loadAi().catch((e) => toast(e.message, true));
    setPageMeta(tab);
    renderOverview();
    if (tab === 'simulator') renderSimulator();
  }

  $('#login-btn').addEventListener('click', async () => {
    const password = $('#password').value.trim();
    if (!password) return toast('请输入管理员密码', true);
    try {
      const data = await api('/auth/admin-login', { method: 'POST', body: { password } });
      toast('登录成功');
      await enter(data.token, data.refreshToken);
    } catch (err) { toast(err.message, true); }
  });
  $('#password').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#login-btn').click(); });
  $('#logout').addEventListener('click', logout);
  $$('#nav button').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));
  $('#store-select').addEventListener('change', async (e) => {
    state.storeId = e.target.value;
    localStorage.setItem('ss_store', state.storeId);
    await refresh();
    toast('已切换门店');
  });
  $('#staff-badge').addEventListener('click', () => showTab('staff'));
  $$('[data-staff-filter]').forEach((b) => b.addEventListener('click', () => {
    state.staffFilter = b.dataset.staffFilter;
    $$('[data-staff-filter]').forEach((x) => x.classList.toggle('active', x === b));
    loadStaff().catch((e) => toast(e.message, true));
  }));
  $('#rotate-webhook').addEventListener('click', async () => {
    try {
      const data = await api('/admin/stores/' + encodeURIComponent(state.storeId) + '/webhook-secret', { method: 'POST' });
      window.prompt('Webhook 密钥（仅显示一次，请立即保存）', data.secret);
      await loadData();
    } catch (err) { toast(err.message, true); }
  });
  $('#refresh-data').addEventListener('click', () => loadData().catch((e) => toast(e.message, true)));
  $('#ai-save').addEventListener('click', () => saveAiSettings().catch((e) => toast(e.message, true)));
  $('#ai-save-key').addEventListener('click', () => saveAiKey().catch((e) => toast(e.message, true)));
  $('#ai-test').addEventListener('click', () => testAi().catch((e) => toast(e.message, true)));
  $('#ai-revoke').addEventListener('click', () => revokeAiKey().catch((e) => toast(e.message, true)));
  $('#import-data').addEventListener('click', () => importData().catch((e) => toast(e.message, true)));
  $('#run-replay').addEventListener('click', () => runReplay().catch((e) => toast(e.message, true)));
  $('#submit-feedback').addEventListener('click', () => submitFeedback().catch((e) => toast(e.message, true)));

  $('#change-password').addEventListener('click', async () => {
    const currentPassword = window.prompt('当前管理员密码');
    if (!currentPassword) return;
    const newPassword = window.prompt('新密码（至少 12 位，含大小写、数字、符号）');
    if (!newPassword) return;
    try {
      await api('/auth/admin/change-password', { method: 'POST', body: { currentPassword, newPassword } });
      toast('密码已更新，请重新登录');
      logout();
    } catch (err) { toast(err.message, true); }
  });

  $('#claim-btn').addEventListener('click', async () => {
    try {
      const data = await api('/admin/stores/' + encodeURIComponent(state.storeId) + '/claim-code', { method: 'POST' });
      window.prompt('一次性店长授权码（24 小时有效，仅显示一次）', data.code);
    } catch (err) { toast(err.message, true); }
  });

  $('#sim-toggle').addEventListener('click', async () => {
    try {
      const running = !state.overview.sim.running;
      const speed = Number($('#sim-speed').value);
      await api('/admin/sim/control', { method: 'POST', body: { storeId: state.storeId, running, speed } });
      toast(running ? `模拟已开始（${speed}×）` : '模拟已暂停');
      await refresh();
    } catch (err) { toast(err.message, true); }
  });
  $('#sim-speed').addEventListener('change', async () => {
    if (!state.overview || !state.overview.sim.running) return;
    try {
      await api('/admin/sim/control', { method: 'POST', body: { storeId: state.storeId, running: true, speed: Number($('#sim-speed').value) } });
      toast('倍速已更新');
    } catch (err) { toast(err.message, true); }
  });
  $$('[data-advance]').forEach((b) => b.addEventListener('click', async () => {
    b.disabled = true;
    try {
      const result = await api('/admin/sim/advance', { method: 'POST', body: { storeId: state.storeId, minutes: Number(b.dataset.advance) } });
      toast(`已推进 ${b.dataset.advance} 分钟，模拟时间 ${result.status.nowLabel}`);
      await refresh();
    } catch (err) { toast(err.message, true); }
    finally { b.disabled = false; }
  }));

  if (state.token) {
    enter(state.token, state.refreshToken).catch(() => logout());
  } else {
    login();
  }
})();
