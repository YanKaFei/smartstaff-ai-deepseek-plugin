(() => {
  const $ = (s) => document.querySelector(s); const token = localStorage.getItem('ss_saas_token') || '';
  if (!token) location.href = './account.html';
  const msg = (t, e = false) => { const el = $('#org-msg'); el.textContent = t; el.style.color = e ? 'var(--bad)' : 'var(--muted)'; };
  async function api(path, opts = {}) {
    const res = await fetch('/api' + path, { method: opts.method || 'GET', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token }, body: opts.body ? JSON.stringify(opts.body) : undefined });
    const json = await res.json().catch(() => null);
    if (!res.ok || !json || json.ok === false) throw new Error((json && json.error && json.error.message) || `请求失败 (${res.status})`);
    return json.data;
  }
  let data;
  async function load() {
    data = await api('/org');
    $('#org-dashboard').classList.remove('hidden');
    $('#org-name').textContent = data.organization.name;
    $('#org-meta').textContent = `${data.organization.slug} · ${data.organization.plan} · 我的角色 ${data.organization.myRole}`;
    $('#stat-members').textContent = data.members.length; $('#stat-stores').textContent = data.stores.length; $('#stat-invites').textContent = data.invitations.length;
    $('#invite-store').innerHTML = '<option value="">不绑定</option>' + data.stores.map((s) => `<option value="${s.id}">${s.name}</option>`).join('');
    $('#member-rows').innerHTML = data.members.map((m) => `<tr><td><b>${m.name}</b><div class="tiny">${m.email || ''}</div></td>
      <td><select data-member-role="${m.id}"><option ${m.role==='owner'?'selected':''}>owner</option><option ${m.role==='admin'?'selected':''}>admin</option><option ${m.role==='manager'?'selected':''}>manager</option><option ${m.role==='staff'?'selected':''}>staff</option></select></td>
      <td>${m.storeId || '—'}</td><td>${m.status}</td><td><button class="ghost" data-member-save="${m.id}">保存角色</button></td></tr>`).join('');
    $('#store-rows').innerHTML = data.stores.map((s) => `<tr><td>${s.name}</td><td>${s.managerCode}</td><td class="tiny">${s.id}</td></tr>`).join('') || '<tr><td colspan="3" class="tiny">还没有门店</td></tr>';
    $('#invite-list').innerHTML = data.invitations.length ? data.invitations.map((i) => `<div class="org-invite">${i.email} · ${i.role} · 待接受 <button class="ghost" data-revoke="${i.id}">撤销</button></div>`).join('') : '<p class="tiny">暂无待处理邀请。</p>';
    bind();
  }
  function bind() {
    document.querySelectorAll('[data-member-save]').forEach((b) => b.addEventListener('click', async () => {
      const id = b.dataset.memberSave; const role = document.querySelector(`[data-member-role="${id}"]`).value;
      try { await api('/org/members/' + id, { method: 'PATCH', body: { role } }); msg('角色已更新'); await load(); } catch (e) { msg(e.message, true); }
    }));
    document.querySelectorAll('[data-revoke]').forEach((b) => b.addEventListener('click', async () => {
      try { await api('/org/invitations/' + b.dataset.revoke, { method: 'DELETE' }); msg('邀请已撤销'); await load(); } catch (e) { msg(e.message, true); }
    }));
  }
  $('#invite-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const r = await api('/org/invitations', { method: 'POST', body: { email: $('#invite-email').value, role: $('#invite-role').value, storeId: $('#invite-store').value || undefined } });
      $('#invite-result').classList.remove('hidden');
      $('#invite-result').innerHTML = `邀请已创建。<div class="org-invite">开发环境 token：${r.inviteToken || '（生产环境已隐藏）'}</div>`;
      await load();
    } catch (err) { msg(err.message, true); }
  });
  $('#store-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try { await api('/org/stores', { method: 'POST', body: { name: $('#store-name').value, managerCode: $('#store-code').value, address: $('#store-address').value } }); msg('门店已创建'); await load(); } catch (err) { msg(err.message, true); }
  });
  load().catch((e) => { msg(e.message, true); setTimeout(() => location.href = './account.html', 1200); });
})();
