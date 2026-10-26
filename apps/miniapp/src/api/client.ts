export interface Session {
  token: string;
  accessToken?: string;
  refreshToken?: string;
  accessExpiresAt?: number;
  refreshExpiresAt?: number;
  role: 'manager' | 'staff' | 'admin';
  name: string;
  storeCode?: string;
}

const SESSION_KEY = 'smartstaff_session';
const API_ENV = (import.meta.env && import.meta.env.VITE_API_BASE) || '';

export function apiBase(): string {
  if (API_ENV) return API_ENV.replace(/\/$/, '');
  // #ifdef H5
  return '/api';
  // #endif
  // #ifndef H5
  return 'http://127.0.0.1:8787/api';
  // #endif
}

export function getSession(): Session | null {
  try {
    const raw = uni.getStorageSync(SESSION_KEY);
    return raw ? (JSON.parse(raw) as Session) : null;
  } catch {
    return null;
  }
}

export function saveSession(session: Session): void {
  uni.setStorageSync(SESSION_KEY, JSON.stringify(session));
}

export function clearSession(): void {
  uni.removeStorageSync(SESSION_KEY);
}

export interface ApiErrorShape {
  code: string;
  message: string;
  details?: unknown;
}

export class ApiError extends Error {
  code: string;
  status: number;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

let redirecting = false;
let refreshPromise: Promise<boolean> | null = null;

function rawRequest<T>(
  path: string,
  options: { method?: string; data?: unknown; token?: string },
): Promise<{ status: number; body: { ok?: boolean; data?: T; error?: ApiErrorShape } }> {
  return new Promise((resolve, reject) => {
    uni.request({
      url: `${apiBase()}${path}`,
      method: (options.method ?? 'GET') as UniApp.RequestOptions['method'],
      data: options.data as UniApp.RequestOptions['data'],
      timeout: 20000,
      header: {
        'content-type': 'application/json',
        ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      },
      success: (res) =>
        resolve({
          status: res.statusCode,
          body: res.data as { ok?: boolean; data?: T; error?: ApiErrorShape },
        }),
      fail: (err) => reject(new ApiError(0, 'NETWORK_ERROR', err.errMsg || '网络连接失败，请检查 API 服务')),
    });
  });
}

async function refreshAccessToken(): Promise<boolean> {
  if (refreshPromise) return refreshPromise;
  refreshPromise = (async () => {
    const session = getSession();
    if (!session?.refreshToken) return false;
    try {
      const res = await rawRequest<{
        token: string;
        accessToken?: string;
        refreshToken: string;
        accessExpiresAt?: number;
        refreshExpiresAt?: number;
      }>('/auth/refresh', { method: 'POST', data: { refreshToken: session.refreshToken } });
      if (res.status !== 200 || !res.body.ok || !res.body.data) return false;
      saveSession({
        ...session,
        token: res.body.data.token,
        accessToken: res.body.data.accessToken ?? res.body.data.token,
        refreshToken: res.body.data.refreshToken,
        accessExpiresAt: res.body.data.accessExpiresAt,
        refreshExpiresAt: res.body.data.refreshExpiresAt,
      });
      return true;
    } catch {
      return false;
    } finally {
      refreshPromise = null;
    }
  })();
  return refreshPromise;
}

function forceLogin(message = '登录已过期，请重新登录'): void {
  if (redirecting) return;
  clearSession();
  redirecting = true;
  uni.showToast({ title: message, icon: 'none' });
  setTimeout(() => {
    redirecting = false;
    uni.reLaunch({ url: '/pages/login/index' });
  }, 60);
}

export async function request<T>(
  path: string,
  options: { method?: string; data?: unknown; silent?: boolean } = {},
  retried = false,
): Promise<T> {
  const session = getSession();
  let res: { status: number; body: { ok?: boolean; data?: T; error?: ApiErrorShape } };
  try {
    res = await rawRequest<T>(path, {
      method: options.method,
      data: options.data,
      token: session?.token,
    });
  } catch (err) {
    if (err instanceof ApiError) throw err;
    throw new ApiError(0, 'NETWORK_ERROR', '网络连接失败，请检查 API 服务');
  }
  if (res.status === 401 && !retried && path !== '/auth/refresh') {
    const refreshed = await refreshAccessToken();
    if (refreshed) return request<T>(path, options, true);
    forceLogin();
    throw new ApiError(401, 'UNAUTHORIZED', '登录已过期');
  }
  if (res.status >= 200 && res.status < 300 && res.body.ok) return res.body.data as T;
  throw new ApiError(
    res.status,
    res.body.error?.code ?? 'REQUEST_FAILED',
    res.body.error?.message ?? '请求失败',
  );
}

export function requireRole(role: 'manager' | 'staff'): Session | null {
  const session = getSession();
  if (!session || session.role !== role) {
    uni.reLaunch({ url: '/pages/login/index' });
    return null;
  }
  return session;
}

export function toast(title: string, icon: 'none' | 'success' | 'error' = 'none'): void {
  uni.showToast({ title, icon: icon === 'success' ? 'success' : 'none', duration: 2200 });
}
