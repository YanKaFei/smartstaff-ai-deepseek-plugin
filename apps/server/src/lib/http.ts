import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { ZodError } from 'zod';
import type { Db } from '../db/index.js';
import type { AppConfig } from '../config.js';
import { AppError, notFound } from './errors.js';
import { logger, errorFields } from './logger.js';
import { resolveSession, type AuthContext } from './auth.js';
import type { Role } from '../domain/types.js';

export interface RequestContext {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  db: Db;
  config: AppConfig;
  params: Record<string, string>;
  query: URLSearchParams;
  body: unknown;
  auth: AuthContext | null;
  requestId: string;
  rawToken: string | undefined;
  rawBody: string;
  serverId: string;
  clientIp: string;
}

export type Handler = (ctx: RequestContext) => Promise<unknown> | unknown;

interface Route {
  method: string;
  segments: string[];
  roles: Role[] | null;
  handler: Handler;
}

const routes: Route[] = [];

export function route(method: string, pattern: string, options: { roles?: Role[] }, handler: Handler): void {
  routes.push({
    method: method.toUpperCase(),
    segments: pattern.split('/').filter(Boolean),
    roles: options.roles ?? null,
    handler,
  });
}

function matchRoute(method: string, pathname: string): { route: Route; params: Record<string, string> } | null {
  const parts = pathname.split('/').filter(Boolean);
  for (const r of routes) {
    if (r.method !== method || r.segments.length !== parts.length) continue;
    const params: Record<string, string> = {};
    let ok = true;
    for (let i = 0; i < r.segments.length; i++) {
      const seg = r.segments[i];
      if (seg.startsWith(':')) params[seg.slice(1)] = decodeURIComponent(parts[i]);
      else if (seg !== parts[i]) {
        ok = false;
        break;
      }
    }
    if (ok) return { route: r, params };
  }
  return null;
}

function readBody(req: http.IncomingMessage, limit: number): Promise<{ data: unknown; raw: string }> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new AppError(413, 'PAYLOAD_TOO_LARGE', '请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (chunks.length === 0) return resolve({ data: {}, raw: '' });
      const text = Buffer.concat(chunks).toString('utf8');
      try {
        resolve({ data: JSON.parse(text), raw: text });
      } catch {
        reject(new AppError(400, 'INVALID_JSON', '请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res: http.ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
};

function bearer(req: http.IncomingMessage): string | undefined {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return undefined;
  return header.slice(7).trim() || undefined;
}

function applyCors(res: http.ServerResponse, cfg: AppConfig, req: http.IncomingMessage): boolean {
  const origin = req.headers.origin;
  const allowed = origin ? cfg.corsOrigins.includes(origin) : false;
  if (allowed && origin) res.setHeader('access-control-allow-origin', origin);
  res.setHeader('access-control-allow-methods', 'GET,POST,PATCH,PUT,DELETE,OPTIONS');
  res.setHeader('access-control-allow-headers', 'content-type,authorization,x-request-id');
  res.setHeader('access-control-max-age', '600');
  res.setHeader('vary', 'origin');
  return !origin || allowed;
}

function securityHeaders(res: http.ServerResponse, secure: boolean): void {
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('x-frame-options', 'DENY');
  res.setHeader('referrer-policy', 'no-referrer');
  res.setHeader('permissions-policy', 'camera=(), microphone=(), geolocation=()');
  if (secure) res.setHeader('strict-transport-security', 'max-age=31536000; includeSubDomains');
}

function isSecureRequest(req: http.IncomingMessage, cfg: AppConfig): boolean {
  if ((req.socket as { encrypted?: boolean }).encrypted) return true;
  if (cfg.trustProxy) {
    const proto = String(req.headers['x-forwarded-proto'] ?? '').split(',')[0].trim();
    if (proto === 'https') return true;
  }
  return false;
}

function remoteIp(req: http.IncomingMessage, cfg: AppConfig): string {
  if (cfg.trustProxy) {
    const forwarded = req.headers['x-forwarded-for'];
    if (typeof forwarded === 'string' && forwarded.trim()) return forwarded.split(',')[0].trim();
  }
  return (req.socket.remoteAddress ?? 'unknown').replace('::ffff:', '');
}

async function serveStatic(
  res: http.ServerResponse,
  root: string,
  relative: string,
  fallbackIndex?: string,
): Promise<boolean> {
  const safe = path.normalize(relative).replace(/^(\.\.[/\\])+/, '');
  let file = path.join(root, safe);
  if (!file.startsWith(root)) return false;
  if (!existsSync(file) || relative === '' || relative.endsWith('/')) {
    const index = path.join(file, fallbackIndex ?? 'index.html');
    if (existsSync(index)) file = index;
    else if (fallbackIndex && existsSync(path.join(root, fallbackIndex))) file = path.join(root, fallbackIndex);
    else return false;
  }
  try {
    const content = await readFile(file);
    res.writeHead(200, {
      'content-type': MIME[path.extname(file)] ?? 'application/octet-stream',
      'content-length': content.length,
      'cache-control': file.endsWith('.html') ? 'no-cache' : 'public, max-age=300',
    });
    res.end(content);
    return true;
  } catch {
    return false;
  }
}

export interface AppServerOptions {
  db: Db;
  config: AppConfig;
  adminDir: string;
  h5Dir: string;
}

export function createHttpServer(options: AppServerOptions): http.Server {
  const { db, config: cfg, adminDir, h5Dir } = options;
  const serverId = randomBytes(6).toString('hex');

  return http.createServer(async (req, res) => {
    const started = Date.now();
    const requestId = `${started.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const originAllowed = applyCors(res, cfg, req);
    const secure = isSecureRequest(req, cfg);
    securityHeaders(res, secure);

    if (req.method === 'OPTIONS') {
      if (!originAllowed) {
        sendJson(res, 403, { ok: false, error: { code: 'CORS_DENIED', message: 'CORS 来源不在白名单' } });
        return;
      }
      res.writeHead(204, {});
      res.end();
      return;
    }

    try {
      const pathname = decodeURIComponent(url.pathname);

      if (cfg.requireHttps && !secure && pathname !== '/health') {
        throw new AppError(426, 'HTTPS_REQUIRED', '生产环境必须通过 HTTPS 访问');
      }

      if (pathname === '/' || pathname === '/admin') {
        res.writeHead(302, { location: '/admin/' });
        res.end();
        return;
      }
      if (pathname === '/app') {
        res.writeHead(302, { location: '/app/' });
        res.end();
        return;
      }
      if (pathname.startsWith('/admin/')) {
        const relative = pathname.replace(/^\/admin\/?/, '');
        if (await serveStatic(res, adminDir, relative)) return;
      }
      if (pathname.startsWith('/app/')) {
        const relative = pathname.replace(/^\/app\/?/, '');
        if (await serveStatic(res, h5Dir, relative, 'index.html')) return;
      }
      if (pathname === '/favicon.ico') {
        res.writeHead(204, {});
        res.end();
        return;
      }
      if (pathname === '/health') {
        sendJson(res, 200, { ok: true, data: { status: 'ok', ts: Date.now() } });
        return;
      }

      if (!pathname.startsWith('/api/')) throw notFound();

      const matched = matchRoute(req.method ?? 'GET', pathname);
      if (!matched) throw new AppError(404, 'ROUTE_NOT_FOUND', '接口不存在');

      const rawToken = bearer(req);
      let auth: AuthContext | null = null;
      if (matched.route.roles) {
        auth = resolveSession(db, rawToken, cfg);
        if (!matched.route.roles.includes(auth.role)) {
          throw new AppError(403, 'FORBIDDEN', '当前角色无权执行该操作');
        }
      }

      const bodyResult =
        req.method === 'GET' || req.method === 'DELETE'
          ? { data: {}, raw: '' }
          : await readBody(req, cfg.maxBodyBytes);
      const body = bodyResult.data;
      const rawBody = bodyResult.raw;

      const ctx: RequestContext = {
        req,
        res,
        db,
        config: cfg,
        params: matched.params,
        query: url.searchParams,
        body,
        auth,
        requestId,
        rawToken,
        rawBody,
        serverId,
        clientIp: remoteIp(req, cfg),
      };

      const data = await matched.route.handler(ctx);
      sendJson(res, 200, { ok: true, data });
      logger.info('request', {
        requestId,
        method: req.method,
        path: pathname,
        status: 200,
        ms: Date.now() - started,
        userId: auth?.userId,
      });
    } catch (err) {
      const appErr =
        err instanceof AppError
          ? err
          : err instanceof ZodError
            ? new AppError(400, 'VALIDATION_ERROR', '输入校验失败', err.issues)
            : new AppError(500, 'INTERNAL_ERROR', '服务器内部错误');
      if (!(err instanceof AppError) && !(err instanceof ZodError)) {
        logger.error('unhandled_error', {
          requestId,
          path: url.pathname,
          ...errorFields(err),
        });
      }
      sendJson(res, appErr.status, {
        ok: false,
        error: { code: appErr.code, message: appErr.message, details: appErr.details },
      });
      logger.warn('request_failed', {
        requestId,
        method: req.method,
        path: url.pathname,
        status: appErr.status,
        code: appErr.code,
        ms: Date.now() - started,
      });
    }
  });
}
