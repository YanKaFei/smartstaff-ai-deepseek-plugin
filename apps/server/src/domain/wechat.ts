/**
 * WeChat subscribe-message seam.
 *
 * 1.0 deliberately ships in-app notifications only (see notify.ts). Sending a
 * real WeChat subscribe message requires an appid/secret, a user-authorized
 * template id, and an HTTPS callback environment. The interface below is the
 * exact place to plug that in without touching the dispatch state machine.
 */
export interface SubscribeMessagePayload {
  /** WeChat openid of the recipient. 1.0 stores demo identities, not openids. */
  openid: string;
  templateId: string;
  page?: string;
  data: Record<string, string | number>;
}

export interface SubscribeMessageResult {
  status: 'sent' | 'skipped' | 'failed';
  error?: string;
}

export interface SubscribeMessageProvider {
  send(payload: SubscribeMessagePayload): Promise<SubscribeMessageResult>;
}

export interface WechatConfig {
  appId?: string;
  appSecret?: string;
  offerTemplateId?: string;
}

export function createWechatSubscribeProvider(config: WechatConfig): SubscribeMessageProvider {
  const configured = Boolean(config.appId && config.appSecret && config.offerTemplateId);
  return {
    async send(payload) {
      if (!configured) {
        return { status: 'skipped', error: '未配置微信订阅消息 appid/secret/template' };
      }
      // Real implementation: exchange access_token, POST
      // https://api.weixin.qq.com/cgi-bin/message/subscribe/send
      // 1.0 has no authorized openid, so it must not pretend to deliver.
      return { status: 'skipped', error: '1.0 仅站内通知；订阅消息接口已预留未启用' };
    },
  };
}

/** Stable payload builder so template field names stay in one place. */
export function buildOfferMessage(input: {
  storeName: string;
  startLabel: string;
  endLabel: string;
  role: string;
  pay: string;
}): Record<string, string | number> {
  return {
    thing1: input.storeName,
    time2: `${input.startLabel} - ${input.endLabel}`,
    thing3: input.role,
    amount4: input.pay,
  };
}
