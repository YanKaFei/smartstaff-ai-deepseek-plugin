import test from 'node:test';
import assert from 'node:assert/strict';
import { freshApp, api, type TestApp } from './helpers.js';
import { deliverEmail, queueEmail } from '../src/domain/email.js';
import { makeConfig } from '../src/config.js';
import { get } from '../src/lib/db.js';

const strong = 'SaaS-Strong-2026!';

test('R8 email: registration queues mail but never claims delivery without a provider', async () => {
  const app = await freshApp();
  try {
    const reg = await api<{ emailDelivery: string; verificationToken: string }>(app.base, 'POST', '/api/auth/register-account', { email: 'mail@example.com', password: strong, name: '邮箱用户', organizationName: '邮件组织' });
    assert.equal(reg.data.emailDelivery, 'not_configured');
    assert.ok(reg.data.verificationToken);
    const row = get<{ status: string; recipient: string }>(app.db, "SELECT status, recipient FROM email_outbox WHERE kind = 'email_verify' ORDER BY created_at DESC LIMIT 1")!;
    assert.equal(row.status, 'not_configured');
    assert.equal(row.recipient, 'mail@example.com');
  } finally { await app.close(); }
});

test('R8 email: a mocked HTTP provider transition is recorded without changing the failure semantics', async () => {
  const app = await freshApp();
  try {
    const cfg = makeConfig({ email: { provider: 'resend', apiKey: 'test-key', from: 'no-reply@example.com', appUrl: 'http://127.0.0.1:8787' } });
    const id = queueEmail(app.db, { to: 'ok@example.com', subject: 'test', body: '<p>test</p>', kind: 'test' });
    const sent = await deliverEmail(app.db, cfg, id, (async () => new Response('{"id":"x"}', { status: 200 })) as typeof fetch);
    assert.equal(sent.status, 'sent');
    const row = get<{ status: string }>(app.db, 'SELECT status FROM email_outbox WHERE id = ?', [id])!;
    assert.equal(row.status, 'sent');
    const id2 = queueEmail(app.db, { to: 'fail@example.com', subject: 'test', body: '<p>test</p>', kind: 'test' });
    const failed = await deliverEmail(app.db, cfg, id2, (async () => new Response('{}', { status: 500 })) as typeof fetch);
    assert.equal(failed.status, 'failed');
  } finally { await app.close(); }
});
