import type { AppConfig } from '../config.js';
import { AppError } from './errors.js';

export interface WxSession {
  openid: string;
  sessionKey?: string;
  unionid?: string;
}

/**
 * Real WeChat code2Session. No mock fallback: without AppID/AppSecret this
 * throws 503 so callers can mark the feature blocked instead of faking login.
 */
export async function code2Session(
  code: string,
  cfg: AppConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<WxSession> {
  if (!cfg.wechat.appId || !cfg.wechat.appSecret) {
    throw new AppError(503, 'WECHAT_NOT_CONFIGURED', '微信登录未配置 AppID/AppSecret，暂时无法使用');
  }
  const url = new URL(cfg.wechat.code2SessionUrl);
  url.searchParams.set('appid', cfg.wechat.appId);
  url.searchParams.set('secret', cfg.wechat.appSecret);
  url.searchParams.set('js_code', code);
  url.searchParams.set('grant_type', 'authorization_code');
  let res: Response;
  try {
    res = await fetchImpl(url.toString(), { signal: AbortSignal.timeout(cfg.wechat.timeoutMs) });
  } catch {
    throw new AppError(502, 'WECHAT_UNAVAILABLE', '微信登录服务暂不可用');
  }
  if (!res.ok) throw new AppError(502, 'WECHAT_UNAVAILABLE', '微信登录服务返回异常');
  const data = (await res.json()) as { openid?: string; session_key?: string; unionid?: string; errcode?: number; errmsg?: string };
  if (!data.openid || (data.errcode && data.errcode !== 0)) {
    throw new AppError(401, 'WECHAT_CODE_INVALID', '微信登录凭证无效或已过期');
  }
  return { openid: data.openid, sessionKey: data.session_key, unionid: data.unionid };
}
