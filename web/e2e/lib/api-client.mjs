import crypto from 'node:crypto';

export function createRequestKey() {
  return crypto.randomUUID();
}

export class ApiClient {
  constructor(baseUrl) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  async request(method, path, { token, body } = {}) {
    const headers = { Accept: 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';

    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    const rawText = await res.text();
    let data = null;
    try {
      data = rawText ? JSON.parse(rawText) : null;
    } catch {
      data = null;
    }

    return {
      status: res.status,
      ok: res.ok && data?.ok === true,
      data,
      rawText,
    };
  }

  healthz() {
    return this.request('GET', '/healthz');
  }

  register(username, password) {
    return this.request('POST', '/api/auth/register', { body: { username, password } });
  }

  login(username, password) {
    return this.request('POST', '/api/auth/login', { body: { username, password } });
  }

  logout(token) {
    return this.request('POST', '/api/auth/logout', { token, body: {} });
  }

  me(token) {
    return this.request('GET', '/api/auth/me', { token });
  }

  fishingState(token) {
    return this.request('GET', '/api/fishing/state', { token });
  }

  startFishing(token, depthId = 'shore') {
    return this.request('POST', '/api/fishing/start', { token, body: { depth_id: depthId } });
  }

  stopFishing(token) {
    return this.request('POST', '/api/fishing/stop', { token, body: {} });
  }

  repairRod(token, rodId) {
    return this.request('POST', '/api/fishing/repair', { token, body: { rod_id: rodId } });
  }

  upgradeAutoRepair(token) {
    return this.request('POST', '/api/fishing/upgrade', { token, body: { upgrade_id: 'autoRepair' } });
  }

  inventory(token) {
    return this.request('GET', '/api/guild/inventory', { token });
  }

  guildSell(token, body) {
    return this.request('POST', '/api/guild/sell', { token, body });
  }

  fxQuotes(token) {
    return this.request('GET', '/api/fx/quotes', { token });
  }

  fxCandles(token, symbol, grain = 60) {
    return this.request('GET', `/api/fx/candles?symbol=${encodeURIComponent(symbol)}&grain=${grain}`, { token });
  }

  fxTrade(token, side, symbol, qty) {
    return this.request('POST', `/api/fx/${side}`, { token, body: { symbol, qty } });
  }

  lotteryStatus(token) {
    return this.request('GET', '/api/lottery/status', { token });
  }

  craftLottery(token, tier, quantity, requestKey = createRequestKey()) {
    return this.request('POST', '/api/lottery/craft', {
      token,
      body: { tier, quantity, request_key: requestKey },
    });
  }

  claimLottery(token, requestKey = createRequestKey()) {
    return this.request('POST', '/api/lottery/claim', {
      token,
      body: { request_key: requestKey },
    });
  }

  scratchCards(token) {
    return this.request('GET', '/api/scratch/cards', { token });
  }

  buyScratch(token, cardType, requestKey = createRequestKey()) {
    return this.request('POST', '/api/scratch/buy', {
      token,
      body: { card_type: cardType, request_key: requestKey },
    });
  }

  revealScratch(token, cardId, requestKey = createRequestKey()) {
    return this.request('POST', '/api/scratch/reveal', {
      token,
      body: { card_id: cardId, request_key: requestKey },
    });
  }
}
