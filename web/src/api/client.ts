import type {
  AuthResponse, FishingStartResponse, FishingStateResponse, FishingStopResponse,
  FXCandlesResponse, FXGrain, FXQuotesResponse, FXSide, FXTradeResponse,
  GuildInventoryResponse, GuildSellRequest, GuildSellResponse,
  LotteryClaimResponse, LotteryCraftResponse, LotteryDrawResponse, LotteryStatusResponse, LotteryTier,
  MeResponse, RepairResponse, ScratchCardsResponse, ScratchCardType, ScratchMutationResponse,
  Success, UpgradeResponse,
} from './types';

export class ApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'ApiError';
  }
}

let activeToken: string | null = null;

export function setAuthToken(token: string | null) {
  activeToken = token;
}

export function getAuthToken(): string | null {
  return activeToken;
}

function requireToken(): string {
  if (!activeToken) {
    throw new ApiError(401, '会话未登录或已失效，请重新登录。');
  }
  return activeToken;
}

const unauthorizedListeners = new Set<(token: string) => void>();

export function onUnauthorized(listener: (token: string) => void) {
  unauthorizedListeners.add(listener);
  return () => { unauthorizedListeners.delete(listener); };
}

export function createRequestKey() {
  return typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : Date.now().toString(36) + '-' + Array.from(crypto.getRandomValues(new Uint32Array(4)), (part) => part.toString(36)).join('-');
}

async function request<T extends Success>(
  path: string, token?: string, body?: object, signal?: AbortSignal,
): Promise<T> {
  const headers = new Headers({ Accept: 'application/json' });
  if (token) headers.set('Authorization', 'Bearer ' + token);
  if (body) headers.set('Content-Type', 'application/json');
  const response = await fetch('/api' + path, {
    method: body ? 'POST' : 'GET',
    headers,
    body: body ? JSON.stringify(body) : undefined,
    cache: 'no-store',
    signal,
  });
  if (response.status === 401 && token && !signal?.aborted) {
    for (const listener of unauthorizedListeners) listener(token);
  }

  let data: { ok?: unknown; error?: unknown } | null = null;
  try {
    data = await response.json();
  } catch (error) {
    if (signal?.aborted) throw error;
    if (response.ok) throw new ApiError(response.status, '服务器返回了无效数据。');
  }
  if (!response.ok || data?.ok !== true) {
    const message = typeof data?.error === 'string' ? data.error : '请求失败（HTTP ' + response.status + '）。';
    throw new ApiError(response.status, message);
  }
  return data as T;
}

export function errorMessage(error: unknown) {
  if (error instanceof ApiError) return error.message;
  return '暂时无法连接服务器，请重试。';
}

export const api = {
  register: (username: string, password: string) =>
    request<AuthResponse>('/auth/register', undefined, { username, password }),
  login: (username: string, password: string) =>
    request<AuthResponse>('/auth/login', undefined, { username, password }),
  logout: (token: string) => request<Success>('/auth/logout', token, {}),
  me: (token: string, signal?: AbortSignal) => request<MeResponse>('/auth/me', token, undefined, signal),

  fishingState: (token: string, signal?: AbortSignal) =>
    request<FishingStateResponse>('/fishing/state', token, undefined, signal),
  startFishing: (token: string, depthId?: string) =>
    request<FishingStartResponse>('/fishing/start', token, { depth_id: depthId }),
  stopFishing: (token: string) => request<FishingStopResponse>('/fishing/stop', token, {}),
  repairRod: (token: string, rodId: number) =>
    request<RepairResponse>('/fishing/repair', token, { rod_id: rodId }),
  upgradeAutoRepair: (token: string) =>
    request<UpgradeResponse>('/fishing/upgrade', token, { upgrade_id: 'autoRepair' }),

  inventory: (token: string, signal?: AbortSignal) =>
    request<GuildInventoryResponse>('/guild/inventory', token, undefined, signal),
  guildSell: (token: string, body: GuildSellRequest) =>
    request<GuildSellResponse>('/guild/sell', token, body),
  fxQuotes: (token: string, signal?: AbortSignal) =>
    request<FXQuotesResponse>('/fx/quotes', token, undefined, signal),
  fxCandles: (token: string, symbol: string, grain: FXGrain, signal?: AbortSignal) => {
    const query = new URLSearchParams({ symbol, grain: String(grain) });
    return request<FXCandlesResponse>('/fx/candles?' + query, token, undefined, signal);
  },
  tradeFX: (token: string, side: FXSide, symbol: string, qty: number) =>
    request<FXTradeResponse>('/fx/' + side, token, { symbol, qty }),

  lotteryStatus: (token: string, signal?: AbortSignal) =>
    request<LotteryStatusResponse>('/lottery/status', token, undefined, signal),
  craftLottery: (token: string, tier: LotteryTier, quantity: number, requestKey = createRequestKey()) =>
    request<LotteryCraftResponse>('/lottery/craft', token, { tier, quantity, request_key: requestKey }),
  drawLottery: (token: string, batchId: string) =>
    request<LotteryDrawResponse>('/lottery/draw', token, { batch_id: batchId }),
  claimLottery: (token: string, requestKey = createRequestKey()) =>
    request<LotteryClaimResponse>('/lottery/claim', token, { request_key: requestKey }),
  scratchCards: (token: string, signal?: AbortSignal) =>
    request<ScratchCardsResponse>('/scratch/cards', token, undefined, signal),
  buyScratch: (token: string, cardType: ScratchCardType, requestKey = createRequestKey()) =>
    request<ScratchMutationResponse>('/scratch/buy', token, { card_type: cardType, request_key: requestKey }),
  revealScratch: (token: string, cardId: number, requestKey = createRequestKey()) =>
    request<ScratchMutationResponse>('/scratch/reveal', token, { card_id: cardId, request_key: requestKey }),
};

export const sessionApi = {
  logout: async () => api.logout(requireToken()),
  me: async (signal?: AbortSignal) => api.me(requireToken(), signal),

  fishingState: async (signal?: AbortSignal) => api.fishingState(requireToken(), signal),
  startFishing: async (depthId?: string) => api.startFishing(requireToken(), depthId),
  stopFishing: async () => api.stopFishing(requireToken()),
  repairRod: async (rodId: number) => api.repairRod(requireToken(), rodId),
  upgradeAutoRepair: async () => api.upgradeAutoRepair(requireToken()),

  inventory: async (signal?: AbortSignal) => api.inventory(requireToken(), signal),
  guildSell: async (body: GuildSellRequest) => api.guildSell(requireToken(), body),
  fxQuotes: async (signal?: AbortSignal) => api.fxQuotes(requireToken(), signal),
  fxCandles: async (symbol: string, grain: FXGrain, signal?: AbortSignal) =>
    api.fxCandles(requireToken(), symbol, grain, signal),
  tradeFX: async (side: FXSide, symbol: string, qty: number) =>
    api.tradeFX(requireToken(), side, symbol, qty),

  lotteryStatus: async (signal?: AbortSignal) => api.lotteryStatus(requireToken(), signal),
  craftLottery: async (tier: LotteryTier, quantity: number, requestKey = createRequestKey()) =>
    api.craftLottery(requireToken(), tier, quantity, requestKey),
  drawLottery: async (batchId: string) => api.drawLottery(requireToken(), batchId),
  claimLottery: async (requestKey = createRequestKey()) => api.claimLottery(requireToken(), requestKey),
  scratchCards: async (signal?: AbortSignal) => api.scratchCards(requireToken(), signal),
  buyScratch: async (cardType: ScratchCardType, requestKey = createRequestKey()) =>
    api.buyScratch(requireToken(), cardType, requestKey),
  revealScratch: async (cardId: number, requestKey = createRequestKey()) =>
    api.revealScratch(requireToken(), cardId, requestKey),
};
