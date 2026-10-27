import type { Db } from '../db/index.js';
import type { AppConfig } from '../config.js';
import { run } from '../lib/db.js';
import { id } from '../lib/ids.js';
import { logger } from '../lib/logger.js';

export function queueEmail(db: Db, input: { to: string; subject: string; body: string; kind: string }, now = Date.now()) {
  const emailId = id('mail');
  run(db, "INSERT INTO email_outbox(id, recipient, subject, body, kind, status, attempts, created_at) VALUES(?,?,?,?,?, 'queued', 0, ?)", [emailId, input.to, input.subject, input.body, input.kind, now]);
  return emailId;
}

export async function deliverEmail(db: Db, cfg: AppConfig, emailId: string, fetchImpl: typeof fetch = fetch) {
  const row = db.prepare('SELECT id, recipient, subject, body, status FROM email_outbox WHERE id = ?').get(emailId) as { id: string; recipient: string; subject: string; body: string; status: string } | undefined;
  if (!row) return { status: 'missing' as const };
  if (row.status === 'sent') return { status: 'sent' as const };
  if (cfg.email.provider !== 'resend' || !cfg.email.apiKey || !cfg.email.from) {
    run(db, "UPDATE email_outbox SET status='not_configured', attempts=attempts+1, last_error=? WHERE id=?", ['EMAIL_PROVIDER_NOT_CONFIGURED', row.id]);
    return { status: 'not_configured' as const, message: '未配置邮件服务；邮件已进入 outbox，未声称已发送。' };
  }
  try {
    const res = await fetchImpl('https://api.resend.com/emails', {
      method: 'POST',
      headers: { authorization: `Bearer ${cfg.email.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ from: cfg.email.from, to: [row.recipient], subject: row.subject, html: row.body }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`EMAIL_HTTP_${res.status}`);
    run(db, "UPDATE email_outbox SET status='sent', attempts=attempts+1, sent_at=? WHERE id=?", [Date.now(), row.id]);
    return { status: 'sent' as const };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn('email_delivery_failed', { emailId, error: message.slice(0, 200) });
    run(db, "UPDATE email_outbox SET status='failed', attempts=attempts+1, last_error=? WHERE id=?", [message.slice(0, 300), row.id]);
    return { status: 'failed' as const, message: '邮件发送失败，可稍后重试。' };
  }
}

export function verificationEmail(cfg: AppConfig, token: string) {
  const link = `${cfg.email.appUrl.replace(/\/$/, '')}/admin/account.html?verify=${encodeURIComponent(token)}`;
  return { subject: '验证你的 SmartStaff AI 账户', body: `<p>点击验证邮箱：</p><p><a href="${link}">${link}</a></p><p>30 分钟内有效。</p>` };
}
export function invitationEmail(cfg: AppConfig, token: string, orgName: string) {
  const link = `${cfg.email.appUrl.replace(/\/$/, '')}/admin/account.html?invite=${encodeURIComponent(token)}`;
  return { subject: `加入 ${orgName} 的 SmartStaff AI`, body: `<p>你被邀请加入 ${orgName}。</p><p><a href="${link}">${link}</a></p><p>7 天内有效。</p>` };
}
export function resetEmail(cfg: AppConfig, token: string) {
  const link = `${cfg.email.appUrl.replace(/\/$/, '')}/admin/account.html?reset=${encodeURIComponent(token)}`;
  return { subject: '重置 SmartStaff AI 密码', body: `<p>点击重置密码：</p><p><a href="${link}">${link}</a></p><p>30 分钟内有效。</p>` };
}
