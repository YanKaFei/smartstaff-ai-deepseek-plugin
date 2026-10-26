process.env.LOG_LEVEL = 'silent';

import { openDatabase, type DbHandle } from '../src/db/index.js';
import { makeConfig, type AppConfig } from '../src/config.js';
import { seedDemo } from '../src/seed.js';
import { buildApp } from '../src/app.js';
import { theme } from './theme.js';
import type { Server } from 'node:http';

export interface TestApp {
  db: DbHandle['db'];
  cfg: AppConfig;
  base: string;
  storeId: string;
  close: () => Promise<void>;
}

export async function freshApp(overrides: Partial<AppConfig> = {}): Promise<TestApp> {
  const handle = openDatabase(':memory:');
  const cfg = makeConfig({
    adminPassword: 'test-admin',
    nodeEnv: 'test',
    auth: { demoLoginEnabled: true },
    deepseek: { apiKey: '', baseUrl: 'http://127.0.0.1:1', model: 'deepseek-flash', timeoutMs: 500 },
    ...overrides,
  });
  const seeded = seedDemo(handle.db, cfg, false, { dateKey: '2026-10-26' });
  const server: Server = buildApp(handle.db, cfg);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('server did not bind');
  const base = `http://127.0.0.1:${address.port}`;
  return {
    db: handle.db,
    cfg,
    base,
    storeId: seeded.storeId,
    close: async () => {
      server.closeIdleConnections?.();
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      handle.close();
    },
  };
}

export interface HttpResponse<T = any> {
  status: number;
  json: { ok: boolean; data?: T; error?: { code: string; message: string; details?: unknown } };
  data: T;
}

export async function api<T = any>(
  base: string,
  method: string,
  path: string,
  body?: unknown,
  token?: string,
): Promise<HttpResponse<T>> {
  const response = await fetch(base + path, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await response.json()) as HttpResponse<T>['json'];
  return { status: response.status, json, data: json.data as T };
}

export async function managerLogin(app: TestApp, code = 'K001'): Promise<string> {
  const res = await api(app.base, 'POST', '/api/auth/mini-login', { role: 'manager', storeCode: code });
  if (!res.json.ok) throw new Error(`manager login failed: ${JSON.stringify(res.json)}`);
  return res.data.token;
}

export async function staffLogin(app: TestApp, phone: string): Promise<string> {
  const res = await api(app.base, 'POST', '/api/auth/mini-login', { role: 'staff', storeCode: 'K001', phone });
  if (!res.json.ok) throw new Error(`staff login failed: ${JSON.stringify(res.json)}`);
  return res.data.token;
}

export async function adminLogin(app: TestApp, password = 'test-admin'): Promise<string> {
  const res = await api(app.base, 'POST', '/api/auth/admin-login', { password });
  if (!res.json.ok) throw new Error(`admin login failed: ${JSON.stringify(res.json)}`);
  return res.data.token;
}

export { theme };
