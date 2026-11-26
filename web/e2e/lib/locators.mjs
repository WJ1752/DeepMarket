export const TAB_REGEX = {
  fishing: /钓鱼甲板|Fishing\s*Deck/i,
  guild: /潮汐公会|Tidal\s*Guild/i,
  fx: /深海交易所|DeepSea\s*FX/i,
  lottery: /彩票与刮刮乐|Lottery\s*&\s*Scratch/i,
};

export const DEPTH_LABELS = {
  shore: /近岸|shore/i,
  shelf: /陆架|shelf/i,
  open: /外海|open/i,
  deep: /深海|deep/i,
  rift: /裂谷|rift/i,
  abyss: /深渊|abyss/i,
};

export const FX_TRAITS = [
  { id: 'swift', regex: /swift|迅游/i },
  { id: 'armored', regex: /armored|重甲/i },
  { id: 'luminous', regex: /luminous|辉光/i },
  { id: 'heavy', regex: /heavy|巨型/i },
  { id: 'ancient', regex: /ancient|远古/i },
  { id: 'surge', regex: /surge|深涌/i },
  { id: 'abyssal', regex: /abyssal|渊印/i },
  { id: 'prismatic', regex: /prismatic|棱彩/i },
];

export const ALL_FX_TRAITS_REGEX =
  /swift|迅游|armored|重甲|luminous|辉光|heavy|巨型|ancient|远古|surge|深涌|abyssal|渊印|prismatic|棱彩/i;

const SEA_CHART_TRIGGER_RE = /海图|Sea\s*Chart|航线|海域图|切换海域/i;
const SEA_CHART_MODAL_SELECTOR =
  'dialog[open], [role="dialog"], .water-dialog, .water-chart-modal, .water-chart, [aria-label*="海图"]:not(button)';

export async function waitForAuthGate(page, timeout = 15000) {
  await page.locator('h1').filter({ hasText: /DeepMarket/i }).waitFor({ state: 'visible', timeout });
  await page.locator('input[name="username"]').waitFor({ state: 'visible', timeout });
  await page.locator('input[name="password"]').waitFor({ state: 'visible', timeout });
}

export async function switchAuthMode(page, mode) {
  const regex = mode === 'register' ? /^(注册|Register)$/i : /^(登录|Sign\s*In|Login)$/i;
  const btn = page.getByRole('button', { name: regex }).first();
  await btn.click();
  await page.waitForFunction(
    ({ isReg }) => {
      const buttons = [...document.querySelectorAll('button')];
      const target = buttons.find((b) => (isReg ? /^(注册|Register)$/i : /^(登录|Sign\s*In|Login)$/i).test(b.textContent?.trim() || ''));
      return target?.getAttribute('aria-pressed') === 'true';
    },
    { isReg: mode === 'register' },
    { timeout: 5000 },
  );
}

export async function registerViaUi(page, username, password) {
  await waitForAuthGate(page);
  await switchAuthMode(page, 'register');
  await page.locator('input[name="username"]').fill(username);
  await page.locator('input[name="password"]').fill(password);
  const resPromise = page.waitForResponse(
    (res) => res.url().includes('/api/auth/register') && res.request().method() === 'POST',
    { timeout: 15000 },
  );
  await page.locator('form button[type="submit"]').click();
  const res = await resPromise;
  if (res.status() !== 201 && res.status() !== 200) {
    throw new Error(`Expected /api/auth/register 201/200, got ${res.status()}`);
  }
  const authJson = await res.json().catch(() => null);
  await waitForWorkspaceReady(page);
  return authJson;
}

export async function loginViaUi(page, username, password) {
  await waitForAuthGate(page);
  await switchAuthMode(page, 'login');
  await page.locator('input[name="username"]').fill(username);
  await page.locator('input[name="password"]').fill(password);
  const resPromise = page.waitForResponse(
    (res) => res.url().includes('/api/auth/login') && res.request().method() === 'POST',
    { timeout: 15000 },
  );
  await page.locator('form button[type="submit"]').click();
  const res = await resPromise;
  if (res.status() !== 200) {
    throw new Error(`Expected /api/auth/login 200, got ${res.status()}`);
  }
  const authJson = await res.json().catch(() => null);
  await waitForWorkspaceReady(page);
  return authJson;
}

export async function logoutViaUi(page) {
  const logoutBtn = page.locator('header').getByRole('button', { name: /退出|Logout|Sign\s*Out/i });
  const resPromise = page.waitForResponse(
    (res) => res.url().includes('/api/auth/logout') && res.request().method() === 'POST',
    { timeout: 10000 },
  );
  await logoutBtn.click();
  const res = await resPromise;
  if (res.status() !== 200) {
    throw new Error(`Expected /api/auth/logout 200, got ${res.status()}`);
  }
  await waitForAuthGate(page);
}

export async function waitForWorkspaceReady(page, timeout = 20000) {
  await page.locator('nav').waitFor({ state: 'visible', timeout });
  await page.locator('header').getByRole('button', { name: /退出|Logout/i }).waitFor({ state: 'visible', timeout });
  await waitForSseConnected(page, timeout);
}

export async function waitForSseConnected(page, timeout = 20000) {
  await page.waitForFunction(
    () => {
      const header = document.querySelector('header');
      if (!header) return false;
      const connectedEl = header.querySelector('[data-connected="true"]');
      if (connectedEl) return true;
      return /实时在线|connected/i.test(header.textContent || '');
    },
    null,
    { timeout },
  );
}

export async function navigateToTab(page, tabKey) {
  const regex = TAB_REGEX[tabKey];
  if (!regex) throw new Error(`Unknown tabKey: ${tabKey}`);
  const nav = page.locator('nav').first();
  const btn = nav.getByRole('button', { name: regex }).first();
  await btn.click();
  await page.waitForFunction(
    ({ pattern }) => {
      const re = new RegExp(pattern, 'i');
      const buttons = [...document.querySelectorAll('nav button')];
      const active = buttons.find((b) => re.test(b.textContent || ''));
      return active?.getAttribute('aria-current') === 'page';
    },
    { pattern: regex.source },
    { timeout: 5000 },
  );
}

export async function readHeaderMetrics(page) {
  return page.evaluate(() => {
    const header = document.querySelector('header');
    const text = (header?.textContent || '').replace(/\s+/g, ' ').trim();
    const coinsMatch = text.match(/([\d,]+)\s*金币/);
    const blackCoinsMatch = text.match(/([\d,]+)\s*(?:黑币|深海黑币|black)/i);
    const ticketsMatch = text.match(/([\d,–-]+)\s*空白券/);
    const revMatch = text.match(/inv_rev\s*(\d+)\s*\/\s*v(\d+)/i);
    const hmacMatch = text.match(/HMAC\s+([0-9a-f]{8}|–|-)/i);
    const sseConnected =
      Boolean(header?.querySelector('[data-connected="true"]')) || /实时在线|connected/i.test(text);

    return {
      rawText: text,
      coins: coinsMatch ? Number(coinsMatch[1].replace(/,/g, '')) : null,
      blackCoins: blackCoinsMatch ? Number(blackCoinsMatch[1].replace(/,/g, '')) : null,
      blankTickets:
        ticketsMatch && /\d/.test(ticketsMatch[1]) ? Number(ticketsMatch[1].replace(/,/g, '')) : null,
      invRev: revMatch ? Number(revMatch[1]) : null,
      version: revMatch ? Number(revMatch[2]) : null,
      hmac: hmacMatch ? hmacMatch[1] : null,
      sseConnected,
    };
  });
}

export function getFishingCanvas(page) {
  return page.locator('main .water-scene canvas, main .fishing-scene canvas, main canvas').first();
}

export async function hasSeaChartTrigger(page) {
  const trigger = page
    .locator('main .water-scene, main .fishing-scene, main')
    .getByRole('button', { name: SEA_CHART_TRIGGER_RE })
    .first();
  return (await trigger.count()) > 0 && (await trigger.isVisible().catch(() => false));
}

export async function openSeaChartIfPresent(page) {
  const existing = page.locator(SEA_CHART_MODAL_SELECTOR).first();
  if ((await existing.count()) > 0 && (await existing.isVisible().catch(() => false))) {
    return existing;
  }
  const trigger = page
    .locator('main .water-scene, main .fishing-scene, main')
    .getByRole('button', { name: SEA_CHART_TRIGGER_RE })
    .first();
  if ((await trigger.count()) > 0 && (await trigger.isVisible().catch(() => false))) {
    await trigger.click();
    const modal = page.locator(SEA_CHART_MODAL_SELECTOR).first();
    await modal.waitFor({ state: 'visible', timeout: 5000 });
    return modal;
  }
  return null;
}

export async function closeSeaChartIfOpen(page) {
  const modal = page.locator(SEA_CHART_MODAL_SELECTOR).first();
  if ((await modal.count()) > 0 && (await modal.isVisible().catch(() => false))) {
    const dialogWrapper = page
      .locator('dialog[open], [role="dialog"], .water-dialog, .water-chart-modal')
      .first();
    const scope = (await dialogWrapper.count()) > 0 && (await dialogWrapper.isVisible().catch(() => false))
      ? dialogWrapper
      : modal;
    const closeBtn = scope.getByRole('button', { name: /关闭|确定|完成|Close/i }).first();
    if ((await closeBtn.count()) > 0 && (await closeBtn.isVisible().catch(() => false))) {
      await closeBtn.click();
    } else {
      await page.keyboard.press('Escape');
    }
    await modal.waitFor({ state: 'hidden', timeout: 4000 }).catch(() => {});
    if (await modal.isVisible().catch(() => false)) {
      await page.keyboard.press('Escape').catch(() => {});
      await modal.waitFor({ state: 'hidden', timeout: 2000 });
    }
  }
}

export async function selectDepth(page, depthId) {
  const labelRegex = DEPTH_LABELS[depthId] || new RegExp(depthId, 'i');

  // Case 1: M2 SeaChartModal (check openSeaChartIfPresent first so trigger buttons never collide with inline buttons)
  const modal = await openSeaChartIfPresent(page);
  if (modal) {
    const waypointBtn = modal
      .locator('.water-chart-stop, button')
      .filter({ hasText: labelRegex })
      .filter({ hasNotText: /切换至此|确认切换|关闭|Close/i })
      .first();
    const targetBtn =
      (await waypointBtn.count()) > 0
        ? waypointBtn
        : modal.getByRole('button', { name: labelRegex }).first();
    await targetBtn.waitFor({ state: 'visible', timeout: 5000 });
    await targetBtn.click();

    const confirmBtn = modal
      .getByRole('button', { name: /切换至此海域|切换海域|确认切换|确认|确定|Select|Confirm/i })
      .first();
    if (
      (await confirmBtn.count()) > 0 &&
      (await confirmBtn.isVisible().catch(() => false)) &&
      !(await confirmBtn.isDisabled().catch(() => true))
    ) {
      await confirmBtn.click();
    } else {
      await page
        .waitForFunction(
          ({ pattern }) => {
            const re = new RegExp(pattern, 'i');
            const btns = [...document.querySelectorAll('.water-chart button, dialog[open] button, [role="dialog"] button')];
            const btn = btns.find((b) => re.test(b.textContent || ''));
            return (
              !btn ||
              btn.getAttribute('aria-pressed') === 'true' ||
              btn.getAttribute('aria-current') === 'location'
            );
          },
          { pattern: labelRegex.source },
          { timeout: 4000 },
        )
        .catch(() => {});
    }

    await closeSeaChartIfOpen(page);
    await page.waitForFunction(
      ({ pattern }) => {
        const re = new RegExp(pattern, 'i');
        return re.test(document.querySelector('main')?.textContent || '');
      },
      { pattern: labelRegex.source },
      { timeout: 4000 },
    );
    return;
  }

  // Case 2: Inline depth button strictly inside `main fieldset` (never collide with SeaChart triggers)
  const inlineBtn = page
    .locator('main fieldset')
    .getByRole('button', { name: labelRegex })
    .filter({ hasNotText: SEA_CHART_TRIGGER_RE })
    .first();
  if ((await inlineBtn.count()) > 0 && (await inlineBtn.isVisible().catch(() => false))) {
    await inlineBtn.click();
    await page.waitForFunction(
      ({ pattern }) => {
        const re = new RegExp(pattern, 'i');
        const triggerRe = /海图|Sea\s*Chart|航线|海域图|切换海域/i;
        const btn = [...document.querySelectorAll('main fieldset button')].find(
          (b) => !triggerRe.test(b.textContent || '') && re.test(b.textContent || ''),
        );
        return btn?.getAttribute('aria-pressed') === 'true' || btn?.getAttribute('aria-current') === 'location';
      },
      { pattern: labelRegex.source },
      { timeout: 4000 },
    );
    return;
  }

  throw new Error(`Unable to locate depth selector for "${depthId}"`);
}

export async function isDepthSelectionLocked(page) {
  return page.evaluate(() => {
    const fieldset = document.querySelector('main fieldset');
    if (fieldset && fieldset.hasAttribute('disabled')) return true;
    const lockRe = /近岸|陆架|外海|深海|裂谷|深渊|海图|航线|切换海域|Sea\s*Chart/i;
    const depthBtns = [...document.querySelectorAll('main button')].filter((b) =>
      lockRe.test(b.textContent || b.getAttribute('aria-label') || ''),
    );
    if (
      depthBtns.length > 0 &&
      depthBtns.every((b) => b.hasAttribute('disabled') || b.getAttribute('aria-disabled') === 'true')
    ) {
      return true;
    }
    const directDepthBtns = [...document.querySelectorAll('main button')].filter(
      (b) =>
        /近岸|陆架|外海|深海|裂谷|深渊/i.test(b.textContent || b.getAttribute('aria-label') || '') &&
        !/海图|航线|Sea\s*Chart/i.test(b.textContent || b.getAttribute('aria-label') || ''),
    );
    if (
      directDepthBtns.length > 0 &&
      directDepthBtns.every((b) => b.hasAttribute('disabled') || b.getAttribute('aria-disabled') === 'true')
    ) {
      return true;
    }
    const mainText = document.querySelector('main')?.textContent || '';
    if (
      directDepthBtns.length === 0 &&
      /航行中锁定当前海域|垂钓进行中.*切换海域/i.test(mainText)
    ) {
      return true;
    }
    return false;
  });
}

export async function startFishing(page) {
  const startBtn = page.locator('main').getByRole('button', { name: /开始钓鱼|Start\s*Fishing/i }).first();
  const resPromise = page.waitForResponse(
    (res) => res.url().includes('/api/fishing/start') && res.request().method() === 'POST',
    { timeout: 10000 },
  );
  await startBtn.click();
  const res = await resPromise;
  if (res.status() !== 200) {
    throw new Error(`Expected /api/fishing/start 200, got ${res.status()}`);
  }
  await page.locator('main').getByRole('button', { name: /停止钓鱼|Stop\s*Fishing/i }).first().waitFor({
    state: 'visible',
    timeout: 10000,
  });
}

export async function stopFishing(page) {
  const stopBtn = page.locator('main').getByRole('button', { name: /停止钓鱼|Stop\s*Fishing/i }).first();
  if ((await stopBtn.count()) === 0 || !(await stopBtn.isVisible().catch(() => false))) {
    return;
  }

  let targetVer = 0;
  let targetInvRev = 0;
  let invSynced = false;
  let resolveInvSync = null;
  const invSyncPromise = new Promise((resolve) => {
    resolveInvSync = resolve;
  });

  const onResponse = async (r) => {
    if (invSynced) return;
    if (!r.url().includes('/api/guild/inventory') || r.request().method() !== 'GET' || r.status() !== 200) {
      return;
    }
    if (targetVer === 0 && targetInvRev === 0) return;
    const json = await r.json().catch(() => null);
    const ver = json?.player?.version ?? 0;
    const invRev = json?.player?.inv_rev ?? 0;
    if (ver >= targetVer && invRev >= targetInvRev) {
      invSynced = true;
      resolveInvSync?.(true);
    }
  };
  page.on('response', onResponse);

  try {
    const resPromise = page.waitForResponse(
      (res) => res.url().includes('/api/fishing/stop') && res.request().method() === 'POST',
      { timeout: 10000 },
    );
    await stopBtn.click();
    const res = await resPromise;
    if (res.status() !== 200) {
      throw new Error(`Expected /api/fishing/stop 200, got ${res.status()}`);
    }
    const stopJson = await res.json().catch(() => null);
    targetVer = stopJson?.player_version ?? 0;
    targetInvRev = stopJson?.inv_rev ?? 0;

    if (targetVer > 0 || targetInvRev > 0) {
      let timer;
      await Promise.race([
        invSyncPromise,
        new Promise((resolve) => {
          timer = setTimeout(() => resolve(false), 4000);
        }),
      ]);
      clearTimeout(timer);
      await page.waitForTimeout(50);
    }
  } finally {
    page.off('response', onResponse);
  }

  await page.locator('main').getByRole('button', { name: /开始钓鱼|Start\s*Fishing/i }).first().waitFor({
    state: 'visible',
    timeout: 10000,
  });
}

export async function countCatchesInFeed(page) {
  return page.evaluate(() => {
    const items = [...document.querySelectorAll('main ol li, main [role="list"] li, .fishing-feed li')];
    return items.filter((li) => /捕获|Caught/i.test(li.textContent || '')).length;
  });
}

export async function waitForCatches(page, minCount = 1, timeoutMs = 60000) {
  await page.waitForFunction(
    ({ target }) => {
      const items = [...document.querySelectorAll('main ol li, main [role="list"] li, .fishing-feed li')];
      const catches = items.filter((li) => /捕获|Caught/i.test(li.textContent || ''));
      return catches.length >= target;
    },
    { target: minCount },
    { timeout: timeoutMs, polling: 400 },
  );
}

export function getFxChartSurface(page) {
  return page
    .locator(
      'main .fx-k-plot svg, main .fx-k-wrap svg, main .fx-k-plot canvas, main .fx-k-wrap canvas, main figure canvas, main figure svg:not(button svg):not(h1 svg):not(h2 svg):not(h3 svg)',
    )
    .or(
      page
        .locator('main [aria-label*="K 线"]:not(.fx-chart-controls):not([aria-label*="控制"])')
        .locator('canvas, svg:not(button svg)'),
    )
    .first();
}

export function getFxChartFocusTarget(page) {
  return page
    .locator('main canvas[tabindex="0"], main svg[tabindex="0"]')
    .or(
      page
        .locator('main [tabindex="0"]:not(.fx-chart-controls)')
        .filter({ has: page.locator('svg:not(button svg), canvas') }),
    )
    .first();
}

export function getFxChartReadout(page) {
  return page.locator(
    'main figcaption, main .fx-chart-readout, main .fx-k-readout, main [aria-live="polite"]',
  );
}

export async function getFxChartReadoutText(page) {
  return page.evaluate(() => {
    const describedHosts = [...document.querySelectorAll('main [aria-describedby]')];
    const describedTargets = [];
    for (const host of describedHosts) {
      if (host.querySelector('svg, canvas') || host.matches('svg, canvas')) {
        const ids = (host.getAttribute('aria-describedby') || '').trim().split(/\s+/).filter(Boolean);
        for (const id of ids) {
          const target = document.getElementById(id);
          if (target && (target.textContent || '').trim()) {
            describedTargets.push(target);
          }
        }
      }
    }
    if (describedTargets.length > 0) {
      const ohlcTarget = describedTargets.find((el) => /开.*高.*低.*收/.test(el.textContent || ''));
      return ((ohlcTarget || describedTargets[0]).textContent || '').trim();
    }
    const candidates = [
      ...document.querySelectorAll(
        'main figcaption, main .fx-chart-readout, main .fx-k-readout, main [aria-live="polite"]',
      ),
    ];
    const withOhlc = candidates.find((el) => /开.*高.*低.*收/.test(el.textContent || ''));
    const chosen = withOhlc || candidates[0];
    return (chosen?.textContent || '').trim();
  });
}

export async function getFxChartStateSignature(page, surface) {
  const readoutText = await getFxChartReadoutText(page);
  const domSig = await surface.evaluate((el) => {
    const tag = el.tagName.toLowerCase();
    const panel = el.closest('.fx-chart-shell, .fx-chart-panel, section, figure, article') || el.parentElement;
    const zoomText = panel?.querySelector('.fx-k-zoom, .fx-chart-meta')?.textContent?.trim() || '';
    if (tag === 'svg') {
      const shapes = [...el.querySelectorAll('rect, line, path')];
      const coords = shapes
        .map((n) => [
          n.tagName,
          n.getAttribute('x') || n.getAttribute('x1') || '',
          n.getAttribute('y') || n.getAttribute('y1') || '',
          n.getAttribute('width') || n.getAttribute('x2') || '',
          n.getAttribute('height') || n.getAttribute('y2') || '',
          n.getAttribute('d') || '',
          n.getAttribute('transform') || '',
        ].join(','))
        .join(';');
      return { tag, shapeCount: shapes.length, zoomText, geomKey: `${el.getAttribute('viewBox') || ''}|${shapes.length}|${coords}` };
    }
    if (tag === 'canvas') {
      const w = Math.min(120, Math.max(16, el.width || 120));
      const h = Math.min(80, Math.max(16, el.height || 80));
      const off = document.createElement('canvas');
      off.width = w;
      off.height = h;
      const ctx = off.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(el, 0, 0, w, h);
      const data = ctx.getImageData(0, 0, w, h).data;
      let hash = 2166136261;
      for (let i = 0; i < data.length; i += 4) {
        hash = Math.imul(hash ^ data[i] ^ (data[i + 1] << 8) ^ (data[i + 2] << 16), 16777619);
      }
      return { tag, shapeCount: 0, zoomText, geomKey: `${w}x${h}|${hash >>> 0}` };
    }
    return { tag, shapeCount: 0, zoomText, geomKey: '' };
  });
  return { readoutText, ...domSig };
}

export function getFxOrderForm(page) {
  return page.locator('main form').filter({ has: page.locator('input[type="number"]') }).first();
}

export async function submitFxOrder(page, side, qty) {
  const form = getFxOrderForm(page);
  const sideRegex = side === 'buy' ? /^\s*(买入|Buy)\s*$/i : /^\s*(卖出|Sell)\s*$/i;
  await form.locator('button[type="button"]').filter({ hasText: sideRegex }).first().click();
  await form.locator('input[type="number"]').fill(String(qty));
  const submitBtn = form.locator('button[type="submit"]').first();
  const resPromise = page.waitForResponse(
    (res) => res.url().includes(`/api/fx/${side}`) && res.request().method() === 'POST',
    { timeout: 10000 },
  );
  await submitBtn.click();
  return resPromise;
}

export async function sellFirstGuildRow(page) {
  const rows = page.locator('main table tbody tr');
  const firstRow = rows.first();
  await firstRow.waitFor({ state: 'visible', timeout: 8000 });

  const initialCheckbox = firstRow.locator('input[type="checkbox"]').first();
  const checkboxLabel = await initialCheckbox.getAttribute('aria-label');
  const rowText = ((await firstRow.textContent()) || '').replace(/\s+/g, ' ').trim();
  const targetCheckbox = checkboxLabel
    ? page.locator('main table tbody').getByRole('checkbox', { name: checkboxLabel, exact: true })
    : initialCheckbox;

  await targetCheckbox.check();

  const sellP = page.waitForResponse(
    (r) => r.url().includes('/api/guild/sell') && r.request().method() === 'POST',
    { timeout: 10000 },
  );
  await page.getByRole('button', { name: /出售所选|Sell\s*Selected/i }).click();
  const sellRes = await sellP;
  if (sellRes.status() !== 200) {
    throw new Error(`Expected /api/guild/sell 200, got ${sellRes.status()}`);
  }

  const receipt = page.locator('main [role="status"]').filter({ hasText: /已出售|Sold/i }).first();
  await receipt.waitFor({ state: 'visible', timeout: 8000 });

  if (checkboxLabel) {
    await targetCheckbox.waitFor({ state: 'detached', timeout: 8000 });
  } else {
    await page.waitForFunction(
      (soldText) => {
        const tbody = document.querySelector('main table tbody');
        if (!tbody) return true;
        return ![...tbody.querySelectorAll('tr')].some(
          (tr) => (tr.textContent || '').replace(/\s+/g, ' ').trim() === soldText,
        );
      },
      rowText,
      { timeout: 8000 },
    );
  }

  return sellRes;
}

export async function sellAllGuildRows(page) {
  const sellP = page.waitForResponse(
    (r) => r.url().includes('/api/guild/sell') && r.request().method() === 'POST',
    { timeout: 10000 },
  );
  const invP = page.waitForResponse(
    (r) => r.url().includes('/api/guild/inventory') && r.request().method() === 'GET',
    { timeout: 10000 },
  );
  await page.getByRole('button', { name: /全部出售|Sell\s*All/i }).click();
  const [sellRes] = await Promise.all([sellP, invP]);
  if (sellRes.status() !== 200) {
    throw new Error(`Expected /api/guild/sell 200, got ${sellRes.status()}`);
  }
  await page.locator('main').getByText(/仓库里还没有渔获/).waitFor({ state: 'visible', timeout: 8000 });
  return sellRes;
}

export async function assertLotteryCraftOpen(page, label = '普通场制券数量') {
  const input = page.getByLabel(new RegExp(label)).first();
  await input.waitFor({ state: 'visible', timeout: 8000 });
  if (await input.isDisabled()) {
    const mainText = (await page.locator('main').textContent().catch(() => '')) || '';
    if (/本轮已开奖|已开奖封盘/.test(mainText)) {
      throw new Error(
        'Live server current lottery batch is already drawn (drawn=true); lottery ticket crafting is closed until the next 6h UTC batch or DB batch reset.',
      );
    }
  }
  return input;
}

export function getScratchBuyButton(page, kind = 'tide') {
  const directRe =
    kind === 'super'
      ? /购买深渊超级刮刮乐|花\s*120.*购买|120.*购买/i
      : /购买潮汐刮刮乐|花\s*30.*购买|30.*购买/i;
  const cardTitleRe = kind === 'super' ? /深渊超级刮刮乐/i : /潮汐刮刮乐/i;
  const otherTitleRe = kind === 'super' ? /潮汐刮刮乐/i : /深渊超级刮刮乐/i;
  const fallbackBtnRe = kind === 'super' ? /购买|120|Buy/i : /购买|30|Buy/i;

  const direct = page.locator('main').getByRole('button', { name: directRe }).first();
  const cardScoped = page
    .locator('main .scratch-shop article, main .scratch-shop > *, main article, main section, main div')
    .filter({ hasText: cardTitleRe })
    .filter({ hasNotText: otherTitleRe })
    .filter({ hasNotText: /已刮开|未形成中奖组合|封存涂层/ })
    .getByRole('button', { name: fallbackBtnRe })
    .first();

  return direct.or(cardScoped).first();
}

export function getScratchCards(page) {
  return page
    .locator(
      'main article.scratch-card, main .scratch-card, main [data-scratch-card], main article:not(.scratch-shop-card):not(.lottery-pool):has(.scratch-slots, .scratch-foil, .scratch-foil-canvas, [aria-label*="封存"], [aria-label*="刮奖"], [aria-label*="涂层"], [aria-label*="派奖"], .scratch-payouts, [data-revealed="true"])',
    );
}

export function getRevealedScratchRewards(page) {
  const structured = page.locator(
    'main [aria-label="刮奖派奖"], main .scratch-rewards, main [aria-label*="派奖"], main .scratch-payouts, main .scratch-card-open, main [data-revealed="true"]',
  );
  const textMatched = page
    .locator('main article, main [role="status"]')
    .filter({ hasText: /组奖励|未形成中奖组合/ });
  return structured.or(textMatched).first();
}

export async function revealFirstScratchCard(page) {
  const card = page
    .locator(
      'main .scratch-card:not(.scratch-card-open), main [data-scratch-card]:not([data-revealed="true"]), main article:not(.scratch-shop-card):not(.lottery-pool)',
    )
    .filter({
      has: page.locator(
        'button:has-text("Scratch"), button:has-text("刮开"), [aria-label*="封存"], [aria-label*="涂层"], .scratch-foil, .scratch-foil-canvas, canvas',
      ),
    })
    .first();
  await card.waitFor({ state: 'visible', timeout: 8000 });

  const btn = card.getByRole('button', { name: /Scratch|刮开/i }).first();
  if ((await btn.count()) > 0 && (await btn.isVisible().catch(() => false))) {
    const [res] = await Promise.all([
      page.waitForResponse(
        (r) => r.url().includes('/api/scratch/reveal') && r.request().method() === 'POST',
        { timeout: 10000 },
      ),
      btn.click(),
    ]);
    return res;
  }

  // M4 interactive foil reveal: multi-pass zigzag pointer scratching across y=0.25, 0.5, 0.75 plus click fallback
  const foil = card.locator('[aria-label*="涂层"], [aria-label*="封存"], .scratch-foil-canvas, .scratch-foil, canvas').first();
  const box = await foil.boundingBox();
  if (!box) throw new Error('Neither Scratch button nor foil surface found on unrevealed scratch card');

  let revealedResponse = false;
  const responsePromise = page
    .waitForResponse(
      (r) => r.url().includes('/api/scratch/reveal') && r.request().method() === 'POST',
      { timeout: 10000 },
    )
    .then((r) => {
      revealedResponse = true;
      return r;
    });

  const [res] = await Promise.all([
    responsePromise,
    (async () => {
      const passes = [
        [0.06, 0.18, 0.94, 0.18],
        [0.94, 0.18, 0.06, 0.38],
        [0.06, 0.38, 0.94, 0.38],
        [0.94, 0.38, 0.06, 0.60],
        [0.06, 0.60, 0.94, 0.60],
        [0.94, 0.60, 0.06, 0.82],
        [0.06, 0.82, 0.94, 0.82],
      ];
      await page.mouse.move(box.x + box.width * passes[0][0], box.y + box.height * passes[0][1]);
      await page.mouse.down();
      for (const [, , x2, y2] of passes) {
        await page.mouse.move(box.x + box.width * x2, box.y + box.height * y2, { steps: 10 });
      }
      await page.mouse.up();
      await page.waitForTimeout(50);
      if (!revealedResponse) {
        await foil.click({ timeout: 1500 }).catch(() => {});
      }
    })(),
  ]);
  return res;
}

