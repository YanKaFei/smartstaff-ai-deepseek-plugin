import { AppError } from '../../lib/errors.js';
import { normalizeEvent, type IngestEvent, type IngestEventType } from '../ingest.js';

export type PosCapability = IngestEventType;

export interface PosAdapterContext {
  now: number;
}

/**
 * Standard adapter contract for POS / queue systems. Vendor implementations
 * must normalize into the same event envelope, so signature, idempotency,
 * ordering and replay remain owned by the ingestion layer.
 */
export interface PosAdapterContract {
  readonly id: string;
  readonly label: string;
  readonly capabilities: readonly PosCapability[];
  parse(payload: unknown, ctx: PosAdapterContext): IngestEvent[];
}

export const POS_CAPABILITIES: readonly PosCapability[] = [
  'queue_join',
  'queue_call',
  'queue_abandon',
  'seat',
  'checkout',
  'leave',
  'clean',
  'clean_done',
  'table_status',
  'staff_checkin',
  'staff_checkout',
];

export class GenericHmacPosAdapter implements PosAdapterContract {
  readonly id = 'generic';
  readonly label = '通用 HMAC 事件适配器';
  readonly capabilities = POS_CAPABILITIES;

  parse(payload: unknown, ctx: PosAdapterContext): IngestEvent[] {
    const event = normalizeEvent(payload, ctx.now);
    if (!this.capabilities.includes(event.type)) {
      throw new AppError(422, 'POS_EVENT_UNSUPPORTED', `适配器不支持事件类型 ${event.type}`);
    }
    if (event.type === 'table_status' && !event.tableStatus) {
      throw new AppError(422, 'POS_TABLE_STATUS_REQUIRED', 'table_status 事件缺少 tableStatus');
    }
    return [event];
  }
}

const adapters = new Map<string, PosAdapterContract>([['generic', new GenericHmacPosAdapter()]]);

export function registerPosAdapter(adapter: PosAdapterContract): void {
  adapters.set(adapter.id, adapter);
}

export function getPosAdapter(id?: string | null): PosAdapterContract {
  const adapter = adapters.get(id || 'generic');
  if (!adapter) throw new AppError(422, 'POS_ADAPTER_UNKNOWN', `未知的 POS 适配器：${id}`);
  return adapter;
}

export function listPosAdapters(): Array<Pick<PosAdapterContract, 'id' | 'label' | 'capabilities'>> {
  return [...adapters.values()].map((a) => ({ id: a.id, label: a.label, capabilities: a.capabilities }));
}
