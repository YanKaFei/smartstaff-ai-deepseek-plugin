(() => {
  const $ = (s) => document.querySelector(s);
  const msg = (text, cls = '') => { const el = $('#account-msg'); el.textContent = text; el.className = 'account-msg ' + cls; };
  const tokenKey = 'ss_saas_token';
  let token = localStorage.getItem(tokenKey) || '';
  let verifyToken = '';

  const api = async (path, options = {}) => {
    const res = await fetch('/api' + path, {
      method: options.method || 'GET',
      headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) },
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
    const json = await res.json().catch(() => null);
    if (!res.ok || !json || json.ok === false) throw new Error((json && json.error && json.error.message) || `请求失败 (${res.status})`);
    return json.data;
  };

  const show = (name) => {
    for (const id of ['login-form', 'register-form', 'forgot-form']) $('#' + id).classList.add('hidden');
    $('#' + name + '-form').classList.remove('hidden');
    document.querySelectorAll('.account-tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
    msg('');
  };
  document.querySelectorAll('.account-tabs button').forEach((b) => b.addEventListener('click', () => show(b.dataset.tab)));

  async function loadMe() {
    if (!token) return;
    try {
      const data = await api('/account/me');
      for (const id of ['login-form', 'register-form', 'forgot-form']) $('#' + id).classList.add('hidden');
      $('#account-dashboard').classList.remove('hidden');
      $('#account-dashboard').innerHTML = `
        <h2 style="margin:0 0 6px">${data.user.name}</h2>
        <p class="tiny">${data.user.email || ''} · ${data.user.emailVerified ? '邮箱已验证' : '邮箱未验证'}</p>
        ${data.memberships.map((m) => `<div class="membership"><b>${m.organizationName}</b><span class="ss-pill ok">${m.role}</span><p class="tiny">组织 ${m.organizationId}${m.storeId ? ' · 门店 ' + m.storeId : ' · 尚未绑定门店'}</p></div>`).join('')}
        <p class="tiny">下一步：组织管理员邀请成员、创建门店并分配角色。</p>
        <button class="ghost" type="button" id="account-logout">退出登录</button>`;
      $('#account-logout').addEventListener('click', () => { token = ''; localStorage.removeItem(tokenKey); location.reload(); });
      msg('');
    } catch (err) { token = ''; localStorage.removeItem(tokenKey); msg(err.message, 'error'); }
  }

  $('#login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const data = await api('/auth/email-login', { method: 'POST', body: { email: $('#login-email').value, password: $('#login-password').value } });
      token = data.token; localStorage.setItem(tokenKey, token);
      msg('登录成功', 'ok'); await loadMe();
    } catch (err) { msg(err.message, 'error'); }
  });

  $('#register-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const data = await api('/auth/register-account', { method: 'POST', body: {
        email: $('#reg-email').value, password: $('#reg-password').value, name: $('#reg-name').value, organizationName: $('#reg-org').value,
      } });
      verifyToken = data.verificationToken || '';
      msg(data.message || '注册成功；请验证邮箱。', 'ok');
      if (verifyToken) { $('#account-verify').classList.remove('hidden'); $('#verify-token').textContent = verifyToken; }
    } catch (err) { msg(err.message, 'error'); }
  });

  $('#verify-btn').addEventListener('click', async () => {
    try { await api('/auth/verify-email', { method: 'POST', body: { token: verifyToken } }); msg('邮箱已验证，可以登录。', 'ok'); $('#account-verify').classList.add('hidden'); show('login'); }
    catch (err) { msg(err.message, 'error'); }
  });

  $('#forgot-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const data = await api('/auth/forgot-password', { method: 'POST', body: { email: $('#forgot-email').value } });
      msg(data.message, 'ok');
      if (data.resetToken) $('#reset-token').value = data.resetToken;
    } catch (err) { msg(err.message, 'error'); }
  });

  $('#reset-btn').addEventListener('click', async () => {
    try { await api('/auth/reset-password', { method: 'POST', body: { token: $('#reset-token').value, password: $('#reset-password').value } }); msg('密码已重置，旧会话已失效。', 'ok'); show('login'); }
    catch (err) { msg(err.message, 'error'); }
  });

  if (token) loadMe();
})();
