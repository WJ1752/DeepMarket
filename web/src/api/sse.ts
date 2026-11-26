import type { SSEEnvelope, SSEEvent } from './types';

const events: readonly SSEEvent[] = [
  'fishing_started', 'fishing_stopped', 'catch', 'escape',
  'auto_repair', 'fx_tick', 'lottery_drawn', 'scratch_revealed',
];

export type SSEConnection = 'connecting' | 'connected' | 'reconnecting' | 'closed';

export function sseSemanticKey(envelope: SSEEnvelope): string {
  if (envelope.event === 'catch' || envelope.event === 'escape') {
    return `${envelope.event}:${envelope.user_id}:${envelope.inv_rev}`;
  }
  return envelope.id;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isCounter(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function parseEnvelope(event: string, frame: MessageEvent<string>): SSEEnvelope | null {
  let data: unknown;
  try {
    data = JSON.parse(frame.data);
  } catch {
    return null;
  }
  if (!isObject(data) || data.event !== event ||
      (data.channel !== 'user' && data.channel !== 'global') ||
      !isCounter(data.user_id) || !isCounter(data.seq) || data.seq === 0 ||
      !isCounter(data.inv_rev) || !isCounter(data.version) || !isCounter(data.ts_ms) ||
      typeof data.id !== 'string' || data.id !== frame.lastEventId ||
      data.id !== [data.channel, data.user_id, data.seq].join('-') ||
      typeof data.sig !== 'string' || !/^[a-f0-9]{64}$/.test(data.sig) ||
      !isObject(data.payload)) {
    return null;
  }

  const payload = data.payload;
  if (event === 'catch' || event === 'escape') {
    if (typeof payload.name !== 'string' || typeof payload.species_id !== 'string' ||
        typeof payload.tier !== 'string' || typeof payload.weight_g !== 'number' ||
        typeof payload.durability_loss !== 'number' || typeof payload.durability !== 'number' ||
        (payload.traits !== null && (!Array.isArray(payload.traits) ||
          !payload.traits.every((trait: unknown) => typeof trait === 'string'))) ||
        (event === 'catch' && typeof payload.quantity !== 'number')) {
      return null;
    }
  }
  return data as unknown as SSEEnvelope;
}

export class DeepMarketSSE {
  private source: EventSource | null = null;
  private retry: number | undefined;
  private seen = new Set<string>();
  private listeners = new Set<(envelope: SSEEnvelope) => void>();
  private connectionListeners = new Set<(state: SSEConnection) => void>();
  state: SSEConnection = 'closed';
  // The server holds the HMAC key. The client validates the signature field's format.
  lastEnvelope: SSEEnvelope | null = null;

  constructor(private readonly token: string, private readonly userId: number) {}

  subscribe(listener: (envelope: SSEEnvelope) => void) {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  subscribeConnection(listener: (state: SSEConnection) => void) {
    this.connectionListeners.add(listener);
    listener(this.state);
    return () => { this.connectionListeners.delete(listener); };
  }

  connect() {
    if (this.source) return;
    const query = new URLSearchParams({ token: this.token, global: 'true' });
    if (this.lastEnvelope) query.set('last_event_id', this.lastEnvelope.id);
    this.setState(this.state === 'reconnecting' ? 'reconnecting' : 'connecting');
    const source = new EventSource('/api/sse/stream?' + query);
    this.source = source;
    source.onopen = () => {
      if (this.source === source) this.setState('connected');
    };
    source.onerror = () => {
      if (this.source !== source) return;
      this.setState('reconnecting');
      // EventSource handles ordinary retries with Last-Event-ID. A terminal
      // response requires opening a fresh source with the last accepted ID.
      if (source.readyState !== EventSource.CLOSED) return;
      this.source = null;
      this.retry = window.setTimeout(() => {
        this.retry = undefined;
        this.connect();
      }, 5000);
    };
    for (const event of events) {
      source.addEventListener(event, (frame: MessageEvent<string>) => {
        if (this.source !== source) return;
        const envelope = parseEnvelope(event, frame);
        if (!envelope ||
            (envelope.channel === 'user' && envelope.user_id !== this.userId)) return;
        const key = envelope.id + '/' + envelope.sig;
        if (this.seen.has(key)) return;
        this.seen.add(key);
        if (this.seen.size > 512) {
          const oldest = this.seen.values().next().value;
          if (oldest !== undefined) this.seen.delete(oldest);
        }
        this.lastEnvelope = envelope;
        for (const listener of this.listeners) listener(envelope);
      });
    }
  }

  close() {
    window.clearTimeout(this.retry);
    this.retry = undefined;
    this.source?.close();
    this.source = null;
    this.setState('closed');
  }

  private setState(state: SSEConnection) {
    if (this.state === state) return;
    this.state = state;
    for (const listener of this.connectionListeners) listener(state);
  }
}
