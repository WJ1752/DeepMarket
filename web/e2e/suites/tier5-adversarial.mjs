import { ApiClient } from '../lib/api-client.mjs';
import { makeUniqueUsername } from '../lib/config.mjs';
import { assert } from '../lib/harness.mjs';
import { diffCanvasSamples, sampleCanvasSignature } from '../lib/layout-audit.mjs';
import {
  closeSeaChartIfOpen,
  getFishingCanvas,
  getFxChartFocusTarget,
  getFxChartReadoutText,
  navigateToTab,
  openSeaChartIfPresent,
  registerViaUi,
  startFishing,
  stopFishing,
  switchAuthMode,
  waitForAuthGate,
  waitForWorkspaceReady,
} from '../lib/locators.mjs';

function buildStressGuildInventory(userId) {
  const now = new Date().toISOString();
  const fish = [
    {
      id: 9001,
      user_id: userId,
      item_id: 'anchovy',
      item_kind: 'fish',
      tier: 'normal',
      traits: ['swift'],
      weight_g: 320,
      quantity: 3,
      created_at: now,
    },
    {
      id: 9002,
      user_id: userId,
      item_id: 'moon_squid',
      item_kind: 'fish',
      tier: 'rare',
      traits: ['luminous', 'swift'],
      weight_g: 1450,
      quantity: 2,
      created_at: now,
    },
    {
      id: 9003,
      user_id: userId,
      item_id: 'abyss_dragonfish',
      item_kind: 'fish',
      tier: 'epic',
      traits: ['abyssal', 'armored'],
      weight_g: 4800,
      quantity: 1,
      created_at: now,
    },
  ];
  const guild_quotes = [
    { id: 9001, item_id: 'anchovy', tier: 'normal', traits: ['swift'], weight_g: 320, quantity: 3, unit_price: 18, total_price: 54 },
    { id: 9002, item_id: 'moon_squid', tier: 'rare', traits: ['luminous', 'swift'], weight_g: 1450, quantity: 2, unit_price: 95, total_price: 190 },
    { id: 9003, item_id: 'abyss_dragonfish', tier: 'epic', traits: ['abyssal', 'armored'], weight_g: 4800, quantity: 1, unit_price: 420, total_price: 420 },
  ];
  return {
    ok: true,
    player: {
      user_id: userId,
      version: 9999,
      inv_rev: 9999,
      coins: 9999999,
      black_coins: 88888,
      state: {},
      last_fishing_settle_at: now,
      house_last_claim_at: null,
      created_at: now,
      updated_at: now,
    },
    fish,
    guild_quotes,
    materials: { 深蓝晶片: 42, 潮汐核心: 7 },
    blank_tickets: 1234,
    rods: [
      {
        id: 1,
        user_id: userId,
        template_id: 'azure',
        slot_type: 'rod',
        equipped: true,
        durability: 1650,
        max_durability: 2000,
        enhance_level: 3,
        affixes: [
          { type: 'speed', value: 0.18 },
          { type: 'technique', value: 0.12 },
          { type: 'doubleCatch', value: 0.15 },
        ],
        locked: false,
      },
    ],
    positions: {},
  };
}

function buildSuperScratchCard(id, revealed) {
  const now = new Date().toISOString();
  const face = [
    { id: 's1', kind: 'coin', name: 'coin', qty: 50, need: 3 },
    { id: 's2', kind: 'coin', name: 'coin', qty: 50, need: 3 },
    { id: 's3', kind: 'coin', name: 'coin', qty: 50, need: 3 },
    { id: 's4', kind: 'material', name: '深蓝晶片', qty: 2, need: 3 },
    { id: 's5', kind: 'material', name: '深蓝晶片', qty: 2, need: 3 },
    { id: 's6', kind: 'material', name: '深蓝晶片', qty: 2, need: 3 },
    { id: 's7', kind: 'material', name: '潮汐核心', qty: 1, need: 3 },
    { id: 's8', kind: 'coin', name: 'coin', qty: 20, need: 3 },
    { id: 's9', kind: 'material', name: '潮汐核心', qty: 1, need: 3 },
  ];
  const payouts = [
    { kind: 'coin', name: 'coin', qty: 100, need: 3, count: 3, combos: 1 },
    { kind: 'material', name: '深蓝晶片', qty: 2, need: 3, count: 3, combos: 1 },
  ];
  return {
    id,
    card_type: 'scratch-super',
    slots: 9,
    revealed,
    created_at: now,
    revealed_at: revealed ? now : null,
    ...(revealed ? { face, payouts } : {}),
  };
}

function buildMockLotteryPayload({ pools, batchId, startAt, endAt, drawn, tickets, recentDraws, blankTickets = 1234 }) {
  return {
    ok: true,
    current_batch: {
      batch_id: batchId,
      start_at: startAt,
      end_at: endAt,
      drawn,
    },
    recent_draws: recentDraws,
    blank_tickets: blankTickets,
    tickets,
    pools,
  };
}

async function auditNarrowLayout(page, viewName) {
  const report = await page.evaluate((label) => {
    window.scrollTo(0, 0);
    const issues = [];
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const docScrollW = document.documentElement.scrollWidth;

    if (docScrollW > vw + 1) {
      issues.push(`Horizontal page overflow on ${label}: scrollWidth=${docScrollW} > innerWidth=${vw}`);
    }

    const isDomShown = (el) => {
      let cur = el;
      while (cur && cur.nodeType === 1) {
        if (cur.hasAttribute('hidden')) return false;
        if (cur.tagName === 'DIALOG' && !cur.hasAttribute('open')) return false;
        if (
          cur.tagName !== 'SUMMARY' &&
          cur.parentElement?.tagName === 'DETAILS' &&
          !cur.parentElement.hasAttribute('open')
        ) {
          return false;
        }
        const style = window.getComputedStyle(cur);
        if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) {
          return false;
        }
        if (cur === document.body) break;
        cur = cur.parentElement;
      }
      return true;
    };

    const isInsideHorizScrollContainer = (el) => {
      let cur = el.parentElement;
      while (cur && cur !== document.body) {
        const st = window.getComputedStyle(cur);
        if ((st.overflowX === 'auto' || st.overflowX === 'scroll') && cur.clientWidth <= vw + 2) {
          return true;
        }
        cur = cur.parentElement;
      }
      return false;
    };

    const describeEl = (el) =>
      (el.textContent || el.getAttribute('aria-label') || el.tagName || '').replace(/\s+/g, ' ').trim().slice(0, 30);

    const selectors = [
      'header button',
      'nav button',
      'main h1',
      'main h2',
      'main button',
      'main input',
      'main .water-scene',
      'main canvas',
      'main svg',
      '[role="meter"]',
      '[role="timer"]',
    ];

    for (const sel of selectors) {
      for (const el of document.querySelectorAll(sel)) {
        if (!isDomShown(el)) continue;
        if (sel === 'main svg' && el.closest('button, h1, h2, h3, span')) continue;
        // .water-scene > canvas uses CSS cover-pan (--scene-width/--scene-left) inside overflow:hidden .water-scene
        if (sel === 'main canvas' && el.parentElement?.classList.contains('water-scene')) continue;

        const r = el.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) {
          issues.push(`Zero-size element (${sel}) on ${label}: "${describeEl(el)}"`);
          continue;
        }
        if (!isInsideHorizScrollContainer(el) && (r.left < -2 || r.right > vw + 2)) {
          issues.push(
            `Horizontal clipping (${sel}) on ${label}: left=${Math.round(r.left)}, right=${Math.round(r.right)}, vw=${vw}, text="${describeEl(el)}"`,
          );
        }
      }
    }

    const interactiveSelectors = [
      'header button',
      'nav button',
      'main button',
      'main input',
      'main select',
      'main textarea',
      'main a[href]',
      'dialog[open] button',
      '[role="dialog"] button',
    ];
    const checkedInteractive = new Set();
    for (const sel of interactiveSelectors) {
      for (const el of document.querySelectorAll(sel)) {
        if (checkedInteractive.has(el)) continue;
        checkedInteractive.add(el);
        if (!isDomShown(el)) continue;
        const r = el.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) continue;
        if (isInsideHorizScrollContainer(el)) continue;
        if (window.getComputedStyle(el).position === 'fixed') continue;

        let cur = el.parentElement;
        while (cur && cur.nodeType === 1) {
          const st = window.getComputedStyle(cur);
          const clipsX = st.overflowX === 'hidden' || st.overflowX === 'clip';
          const clipsY = st.overflowY === 'hidden' || st.overflowY === 'clip';
          if (clipsX || clipsY) {
            const cr = cur.getBoundingClientRect();
            const clippedX = clipsX && cr.width > 0 && (r.left < cr.left - 2 || r.right > cr.right + 2);
            const clippedY = clipsY && cr.height > 0 && (r.top < cr.top - 2 || r.bottom > cr.bottom + 2);
            if (clippedX || clippedY) {
              issues.push(
                `Ancestor overflow clipping (${cur.tagName.toLowerCase()}) on ${label}: control="${describeEl(el)}"`,
              );
              break;
            }
          }
          if (cur === document.body) break;
          cur = cur.parentElement;
        }
      }
    }

    const groupSelectors = [
      'nav',
      'header .market-status',
      'main fieldset .fishing-depth-options',
      '.fx-options',
      '.economy-actions',
      '.hall-actions',
      '.scratch-shop',
      '.lottery-pools',
      '.water-chart',
      '.water-chart-modal',
      '.fx-chart-controls',
      '.fx-k-controls',
      '.sea-chart-waypoints',
      '.scratch-actions',
      '[role="group"]',
    ];
    const seenGroups = new Set();
    for (const gSel of groupSelectors) {
      for (const group of document.querySelectorAll(gSel)) {
        if (seenGroups.has(group)) continue;
        seenGroups.add(group);
        if (!isDomShown(group)) continue;
        const gr = group.getBoundingClientRect();
        if (gr.width <= 0 || gr.height <= 0) continue;
        const children = [...group.children].filter((c) => {
          if (!isDomShown(c)) return false;
          if (c.getAttribute('aria-hidden') === 'true') return false;
          const cr = c.getBoundingClientRect();
          return cr.width > 0 && cr.height > 0;
        });
        for (let i = 0; i < children.length; i += 1) {
          const a = children[i].getBoundingClientRect();
          for (let j = i + 1; j < children.length; j += 1) {
            const b = children[j].getBoundingClientRect();
            const overlapX = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left));
            const overlapY = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
            if (overlapX * overlapY > 4) {
              issues.push(
                `Sibling overlap in ${gSel} on ${label}: "${describeEl(children[i])}" vs "${describeEl(children[j])}" (${Math.round(overlapX)}x${Math.round(overlapY)})`,
              );
            }
          }
        }
      }
    }

    return {
      viewName: label,
      viewport: { width: vw, height: vh },
      scrollWidth: docScrollW,
      issueCount: issues.length,
      issues,
    };
  }, viewName);

  if (report.issueCount > 0) {
    throw new Error(`Narrow layout audit failed for ${viewName} (${report.viewport.width}x${report.viewport.height}):\n  - ${report.issues.join('\n  - ')}`);
  }
  return report;
}

async function auditSeaChartWaypoints(page, label) {
  const result = await page.evaluate(() => {
    const chart = document.querySelector('.water-chart');
    if (!chart) return { found: false, overlaps: [], clipped: [] };
    const cr = chart.getBoundingClientRect();
    const stops = [...chart.querySelectorAll('.water-chart-stop')];
    const items = stops.map((el) => ({
      name: (el.textContent || '').replace(/\s+/g, ' ').trim(),
      rect: el.getBoundingClientRect(),
    }));
    const overlaps = [];
    for (let i = 0; i < items.length; i += 1) {
      for (let j = i + 1; j < items.length; j += 1) {
        const a = items[i].rect;
        const b = items[j].rect;
        const ox = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left));
        const oy = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
        if (ox * oy > 4) {
          overlaps.push(`${items[i].name} vs ${items[j].name} (${Math.round(ox)}x${Math.round(oy)})`);
        }
      }
    }
    const clipped = [];
    for (const item of items) {
      const r = item.rect;
      if (r.left < cr.left - 2 || r.right > cr.right + 2 || r.top < cr.top - 2 || r.bottom > cr.bottom + 2) {
        clipped.push(`${item.name} outside .water-chart`);
      }
    }
    const keyEl = chart.querySelector('.water-chart-key');
    if (keyEl) {
      const kr = keyEl.getBoundingClientRect();
      if (kr.left < cr.left - 2 || kr.right > cr.right + 2 || kr.top < cr.top - 2 || kr.bottom > cr.bottom + 2) {
        clipped.push('.water-chart-key outside .water-chart');
      }
    }
    return { found: true, count: stops.length, overlaps, clipped };
  });
  assert(result.found, `SeaChart .water-chart not found on ${label}`);
  assert(result.count === 6, `Expected 6 .water-chart-stop buttons on ${label}, got ${result.count}`);
  assert(result.overlaps.length === 0, `SeaChart stop overlaps on ${label}: ${result.overlaps.join(', ')}`);
  assert(result.clipped.length === 0, `SeaChart clipped items on ${label}: ${result.clipped.join(', ')}`);
}

export async function runTier5Adversarial(harness) {
  console.log('\n=== Tier 5: Adversarial Coverage Hardening (T5-1 .. T5-10) ===');
  const api = new ApiClient(harness.baseUrl);
  const password = 'Password123!';

  // Fetch pool metadata cleanly from live server (non-mutating read)
  const seedMetaUser = makeUniqueUsername('t5meta');
  const seedMetaAuth = await api.register(seedMetaUser, password);
  assert(seedMetaAuth.ok && seedMetaAuth.data?.token, 'Failed to register metadata seed account');
  const liveLotteryMeta = await api.lotteryStatus(seedMetaAuth.data.token);
  assert(liveLotteryMeta.ok && Array.isArray(liveLotteryMeta.data?.pools), 'Failed to fetch live lottery pools metadata');
  const livePools = liveLotteryMeta.data.pools;

  // ---------------- T5-1: Mobile & Narrow Breakpoint Layout Audit ----------------
  await harness.check('T5-1', 'tier5', 'Responsive:Mobile&Sticky', 'Audit 390x844 & 760x800 views, SeaChart waypoints, and 1024x768 sticky header clearance', async () => {
    const context = await harness.newContext({ viewport: { width: 390, height: 844 } });
    const page = await harness.newPage(context, '/');
    const longUsername = `${makeUniqueUsername('t5')}_max32chr_stress_name`.slice(0, 32);

    try {
      // AuthGate at 390x844 and 760x800
      await waitForAuthGate(page);
      await auditNarrowLayout(page, 'AuthGate-390x844');
      await page.setViewportSize({ width: 760, height: 800 });
      await auditNarrowLayout(page, 'AuthGate-760x800');

      // Intercept /api/auth/register & populated endpoints to stress header with 32-char username, admin role, and max numbers
      await page.route('**/api/auth/register', async (route) => {
        const res = await route.fetch();
        const json = await res.json();
        if (json?.user) {
          json.user.role = 'admin';
        }
        if (json?.player) {
          json.player.coins = 9999999;
          json.player.black_coins = 88888;
          json.player.inv_rev = 9999;
          json.player.version = 9999;
        }
        await route.fulfill({ response: res, contentType: 'application/json', body: JSON.stringify(json) });
      });

      const authRes = await registerViaUi(page, longUsername, password);
      const userId = authRes?.user?.id || 1;
      const stressInv = buildStressGuildInventory(userId);

      await page.route('**/api/guild/inventory', (route) =>
        route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(stressInv) }),
      );
      await page.route('**/api/lottery/status', (route) =>
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(
            buildMockLotteryPayload({
              pools: livePools,
              batchId: '2026-11-26T06:00:00Z',
              startAt: '2026-11-26T06:00:00Z',
              endAt: new Date(Date.now() + 3_600_000).toISOString(),
              drawn: false,
              tickets: [
                {
                  id: 't5-ticket-1',
                  tier: 'normal',
                  batch_id: '2026-11-26T06:00:00Z',
                  numbers: [1, 5, 11, 18, 24],
                  status: 'pending',
                  assigned_at: new Date().toISOString(),
                },
              ],
              recentDraws: [
                {
                  batch_id: '2026-11-26T00:00:00Z',
                  pool_id: 'normal',
                  winning_numbers: [2, 5, 14, 19, 27],
                  draw_seed_hash: 'b'.repeat(64),
                  drawn_at: '2026-11-26T00:00:05Z',
                },
              ],
            }),
          ),
        }),
      );
      await page.route('**/api/scratch/cards', (route) =>
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ ok: true, cards: [buildSuperScratchCard(701, true)] }),
        }),
      );

      // Force refresh to load stress inventory/lottery/scratch
      await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
      await page.waitForFunction(
        () => /9,999,999/.test(document.querySelector('header')?.textContent || ''),
        null,
        { timeout: 8000 },
      );

      for (const vp of [
        { width: 390, height: 844, tag: '390x844' },
        { width: 760, height: 800, tag: '760x800' },
      ]) {
        await page.setViewportSize({ width: vp.width, height: vp.height });

        await navigateToTab(page, 'fishing');
        await page.waitForTimeout(150);
        await auditNarrowLayout(page, `FishingDeck-${vp.tag}`);

        const modal = await openSeaChartIfPresent(page);
        assert(modal, 'SeaChartModal should open');
        await page.waitForTimeout(100);
        await auditNarrowLayout(page, `SeaChart-${vp.tag}`);
        await auditSeaChartWaypoints(page, `SeaChart-${vp.tag}`);
        await closeSeaChartIfOpen(page);

        await navigateToTab(page, 'guild');
        await page.locator('main table tbody tr').first().waitFor({ state: 'visible', timeout: 8000 });
        await auditNarrowLayout(page, `GuildPanel-${vp.tag}`);

        await navigateToTab(page, 'fx');
        await page.locator('main .fx-k').waitFor({ state: 'visible', timeout: 8000 });
        await auditNarrowLayout(page, `FxTerminal-${vp.tag}`);

        await navigateToTab(page, 'lottery');
        await page.getByRole('timer').first().waitFor({ state: 'visible', timeout: 8000 });
        await auditNarrowLayout(page, `LotteryScratch-${vp.tag}`);
      }

      // Check 1024x768 sticky header vs sticky nav clearance when scrolled down
      await page.setViewportSize({ width: 1024, height: 768 });
      await navigateToTab(page, 'lottery');
      await page.waitForTimeout(150);
      const stickyCheck = await page.evaluate(() => {
        window.scrollTo(0, 500);
        const header = document.querySelector('header');
        const nav = document.querySelector('.market-nav');
        if (!header || !nav) return { ok: false, reason: 'missing header or nav' };
        const hr = header.getBoundingClientRect();
        const nr = nav.getBoundingClientRect();
        return {
          ok: hr.bottom <= nr.top + 1,
          headerBottom: Math.round(hr.bottom),
          navTop: Math.round(nr.top),
          overlapY: Math.round(hr.bottom - nr.top),
        };
      });
      assert(stickyCheck.ok, `Sticky header overlaps nav at 1024x768: ${JSON.stringify(stickyCheck)}`);
      return `390x844 & 760x800 clean; 1024x768 sticky overlapY=${stickyCheck.overlapY}px`;
    } finally {
      await page.unrouteAll({ behavior: 'ignoreErrors' });
      await context.close();
    }
  });

  // ---------------- T5-2: FishingDeck / WaterScene / BobberFeedback Edge States ----------------
  await harness.check('T5-2', 'tier5', 'Fishing:EdgeStates', 'Verify critical tension, reduced-motion, recovering, auto_stopped, and repair/upgrade', async () => {
    const context = await harness.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await harness.newPage(context, '/');
    const username = makeUniqueUsername('t5fish');
    let authToken = null;

    try {
      const auth = await registerViaUi(page, username, password);
      authToken = auth?.token;
      const userId = auth?.user?.id || 1;
      await startFishing(page);

      const now = Date.now();
      let mode = 'critical';
      let rodDurability = 18;
      let autoRepairLevel = 0;
      let invCoins = 500;
      let chipQty = 5;

      const buildMockFishingState = () => {
        const ts = Date.now();
        if (mode === 'critical') {
          return {
            ok: true,
            running: true,
            depth_id: 'shore',
            player_version: 50,
            inv_rev: 10,
            coins: invCoins,
            rod: {
              id: 1,
              user_id: userId,
              template_id: 'tide',
              slot_type: 'rod',
              equipped: true,
              durability: 920,
              max_durability: 1000,
              enhance_level: 0,
              affixes: null,
              locked: false,
            },
            fishing: {
              running: true,
              selected_depth_id: 'shore',
              phase: 'reeling',
              progress: 4500,
              tension: 1120,
              recover_until_ms: 0,
              recover_from: 0,
              auto_repair_level: autoRepairLevel,
              auto_repair_at_ms: 0,
              low_durability: false,
              auto_stopped: false,
              manual_resume: false,
              last_tick_at_ms: ts,
              bite: {
                started_at_ms: ts - 1500,
                fish: { species_id: 'moon_squid', name: '月光墨鱼', tier: 'rare', traits: ['luminous'], weight_g: 980 },
                charge_at_bite: 2000,
                charge_required: 10000,
                charge_rate: 1,
                tension_rate: 1.5,
                max_tension: 1200,
                tension_delay_ms: 0,
                loss_base: 4,
              },
            },
          };
        }
        if (mode === 'recovering') {
          return {
            ok: true,
            running: true,
            depth_id: 'shore',
            player_version: 51,
            inv_rev: 11,
            coins: invCoins,
            rod: {
              id: 1,
              user_id: userId,
              template_id: 'tide',
              slot_type: 'rod',
              equipped: true,
              durability: 900,
              max_durability: 1000,
              enhance_level: 0,
              affixes: null,
              locked: false,
            },
            fishing: {
              running: true,
              selected_depth_id: 'shore',
              phase: 'charging',
              progress: 1200,
              tension: 400,
              recover_until_ms: ts + 30000,
              recover_from: 1000,
              auto_repair_level: autoRepairLevel,
              auto_repair_at_ms: 0,
              low_durability: false,
              auto_stopped: false,
              manual_resume: false,
              last_tick_at_ms: ts,
              bite: null,
            },
          };
        }
        return {
          ok: true,
          running: false,
          depth_id: 'shore',
          player_version: 55,
          inv_rev: 12,
          coins: invCoins,
          rod: {
            id: 1,
            user_id: userId,
            template_id: 'tide',
            slot_type: 'rod',
            equipped: true,
            durability: rodDurability,
            max_durability: 1000,
            enhance_level: 0,
            affixes: null,
            locked: false,
          },
          fishing: {
            running: false,
            selected_depth_id: 'shore',
            phase: 'charging',
            progress: 0,
            tension: 0,
            recover_until_ms: 0,
            recover_from: 0,
            auto_repair_level: autoRepairLevel,
            auto_repair_at_ms: 0,
            low_durability: rodDurability <= 20,
            auto_stopped: rodDurability <= 20,
            manual_resume: false,
            last_tick_at_ms: ts,
            bite: null,
          },
        };
      };

      await page.route('**/api/fishing/state', (route) =>
        route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(buildMockFishingState()) }),
      );
      await page.route('**/api/guild/inventory', (route) =>
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            ok: true,
            player: {
              user_id: userId,
              version: 55,
              inv_rev: 12,
              coins: invCoins,
              black_coins: 0,
              state: {},
              last_fishing_settle_at: new Date().toISOString(),
              house_last_claim_at: null,
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            },
            fish: [],
            guild_quotes: [],
            materials: { 深蓝晶片: chipQty },
            blank_tickets: 0,
            rods: [
              {
                id: 1,
                user_id: userId,
                template_id: 'tide',
                slot_type: 'rod',
                equipped: true,
                durability: rodDurability,
                max_durability: 1000,
                enhance_level: 0,
                affixes: null,
                locked: false,
              },
            ],
            positions: {},
          }),
        }),
      );

      // 1) Trigger refresh & assert critical tension + BobberFeedback non-overlap at 1280x800 and 390x844
      await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
      await page.locator('.fishing-meter--tension[data-level="danger"]').waitFor({ state: 'visible', timeout: 8000 });
      await page.locator('.water-feedback-card[data-kind="bite"][data-tension="critical"]').waitFor({ state: 'visible', timeout: 8000 });

      for (const vp of [
        { width: 1280, height: 800 },
        { width: 390, height: 844 },
      ]) {
        await page.setViewportSize(vp);
        await page.waitForTimeout(100);
        const overlap = await page.evaluate(() => {
          const card = document.querySelector('.water-feedback-card');
          const loc = document.querySelector('.water-location');
          const cond = document.querySelector('.water-condition');
          if (!card || !loc || !cond) return { missing: true };
          const area = (a, b) => {
            const ox = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left));
            const oy = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
            return Math.round(ox * oy);
          };
          const cr = card.getBoundingClientRect();
          return {
            missing: false,
            overlapLoc: area(cr, loc.getBoundingClientRect()),
            overlapCond: area(cr, cond.getBoundingClientRect()),
          };
        });
        assert(!overlap.missing, 'Missing water overlay element');
        assert(overlap.overlapLoc === 0 && overlap.overlapCond === 0, `BobberFeedback overlapped HUD at ${vp.width}x${vp.height}: ${JSON.stringify(overlap)}`);
      }
      await page.setViewportSize({ width: 1280, height: 800 });

      // 2) prefers-reduced-motion: reduce while running === true -> 0 pixel diff over 500ms
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.waitForTimeout(150);
      const canvas = getFishingCanvas(page);
      const rmA = await sampleCanvasSignature(canvas);
      await page.waitForTimeout(500);
      const rmB = await sampleCanvasSignature(canvas);
      const rmDiff = diffCanvasSamples(rmA, rmB);
      assert(rmDiff === 0, `Expected 0 canvas pixel diff under prefers-reduced-motion: reduce, got ${rmDiff}`);
      await page.emulateMedia({ reducedMotion: 'no-preference' });

      // 3) recovering state
      mode = 'recovering';
      await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
      await page.locator('.fishing-status[data-recovering="true"]').waitFor({ state: 'visible', timeout: 8000 });
      const statusText = (await page.locator('.fishing-status').textContent()) || '';
      assert(/卸力恢复中/.test(statusText), `Expected 卸力恢复中 status, got: ${statusText}`);
      await page.locator('.water-feedback-card[data-kind="recovering"]').waitFor({ state: 'visible', timeout: 5000 });

      // 4) auto_stopped + repair + upgrade
      mode = 'auto_stopped';
      await page.route('**/api/fishing/repair', async (route) => {
        rodDurability = 68;
        chipQty -= 1;
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            ok: true,
            player: {
              user_id: userId,
              version: 56,
              inv_rev: 13,
              coins: invCoins,
              black_coins: 0,
              state: {},
              last_fishing_settle_at: new Date().toISOString(),
              house_last_claim_at: null,
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            },
            rod: {
              id: 1,
              user_id: userId,
              template_id: 'tide',
              slot_type: 'rod',
              equipped: true,
              durability: rodDurability,
              max_durability: 1000,
              enhance_level: 0,
              affixes: null,
              locked: false,
            },
          }),
        });
      });
      await page.route('**/api/fishing/upgrade', async (route) => {
        autoRepairLevel = 1;
        invCoins -= 100;
        chipQty -= 1;
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            ok: true,
            auto_repair_level: autoRepairLevel,
            player: {
              user_id: userId,
              version: 57,
              inv_rev: 14,
              coins: invCoins,
              black_coins: 0,
              state: {},
              last_fishing_settle_at: new Date().toISOString(),
              house_last_claim_at: null,
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            },
          }),
        });
      });

      await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
      await page.locator('.fishing-alert-note').waitFor({ state: 'visible', timeout: 8000 });
      const alertText = (await page.locator('.fishing-alert-note').textContent()) || '';
      assert(/保护停竿/.test(alertText), `Expected 保护停竿 alert, got: ${alertText}`);
      const badgeText = (await page.locator('.fishing-rod-badge').textContent()) || '';
      assert(/低耐久停竿/.test(badgeText), `Expected 低耐久停竿 badge, got: ${badgeText}`);

      const repairBtn = page.getByRole('button', { name: /手动修理/ }).first();
      await repairBtn.click();
      await page.locator('main [role="status"]').filter({ hasText: /手动修理完成。/ }).waitFor({ state: 'visible', timeout: 5000 });

      const upgradeBtn = page.getByRole('button', { name: /自动修理/ }).first();
      await upgradeBtn.click();
      await page.locator('main [role="status"]').filter({ hasText: /自动修理已升级。/ }).waitFor({ state: 'visible', timeout: 5000 });

      return `critical/recovering/autostop verified; reducedMotion diff=${rmDiff}; repair & upgrade ok (at ${new Date(now).toISOString()})`;
    } finally {
      await page.unrouteAll({ behavior: 'ignoreErrors' });
      if (authToken) {
        await api.stopFishing(authToken).catch(() => {});
      }
      await context.close();
    }
  });

  // ---------------- T5-3: FxCandleChart Boundary States ----------------
  await harness.check('T5-3', 'tier5', 'FxChart:BoundaryCandles', 'Verify 0, 1, flat-price, and zero-price candles render without NaN or broken SVG geometry', async () => {
    const context = await harness.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await harness.newPage(context, '/');
    const username = makeUniqueUsername('t5fxc');

    try {
      await registerViaUi(page, username, password);
      await navigateToTab(page, 'fx');
      await page.locator('main table tbody tr').first().waitFor({ state: 'visible', timeout: 10000 });

      let mockCandles = [];
      await page.route('**/api/fx/candles*', async (route) => {
        const url = new URL(route.request().url());
        const symbol = url.searchParams.get('symbol') || 'swift';
        const grain = Number(url.searchParams.get('grain') || '60');
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ ok: true, symbol, grain, candles: mockCandles }),
        });
      });

      const switchGrainToTriggerFetch = async (grainLabel) => {
        const p = page.waitForResponse((r) => r.url().includes('/api/fx/candles'), { timeout: 8000 });
        await page.getByRole('button', { name: new RegExp(`^${grainLabel}$`) }).first().click();
        await p;
      };

      // 1) 0 candles
      mockCandles = [];
      await switchGrainToTriggerFetch('15m');
      await page.locator('.fx-chart-empty').filter({ hasText: /暂无 K 线数据。/ }).waitFor({ state: 'visible', timeout: 5000 });

      // 2) 1 candle
      const baseTs = Date.now() - 3600_000;
      mockCandles = [{ ts_ms: baseTs, open: 100, high: 105, low: 95, close: 102, volume: 12, settled: true, running: false }];
      await switchGrainToTriggerFetch('30m');
      await page.locator('.fx-k-zoom').filter({ hasText: '1 / 1 根' }).waitFor({ state: 'visible', timeout: 5000 });
      for (const label of ['放大图表', '缩小图表', '查看更早行情', '查看较新行情']) {
        assert(await page.getByRole('button', { name: label }).isDisabled(), `Expected "${label}" disabled for 1 candle`);
      }
      await getFxChartFocusTarget(page).focus();
      await page.keyboard.press('ArrowLeft');
      await page.keyboard.press('ArrowRight');
      const oneReadout = await getFxChartReadoutText(page);
      assert(!/NaN|Infinity/i.test(oneReadout) && /102\.00/.test(oneReadout), `Unexpected 1-candle readout: ${oneReadout}`);

      const validateSvgGeometry = async (tag) => {
        const audit = await page.evaluate(() => {
          const svg = document.querySelector('main .fx-k');
          if (!svg) return { ok: false, reason: 'missing .fx-k svg' };
          const bad = [];
          for (const el of svg.querySelectorAll('rect, line')) {
            for (const attr of ['x', 'y', 'width', 'height', 'x1', 'x2', 'y1', 'y2']) {
              const val = el.getAttribute(attr);
              if (val !== null && (!Number.isFinite(Number(val)) || /NaN|Infinity/i.test(val))) {
                bad.push(`${el.tagName}:${attr}=${val}`);
              }
            }
            if (el.tagName.toLowerCase() === 'rect') {
              const w = Number(el.getAttribute('width'));
              const h = Number(el.getAttribute('height'));
              if (!(w > 0 && h > 0)) bad.push(`non-positive rect ${w}x${h}`);
            }
          }
          const ruler = [...document.querySelectorAll('.fx-k-ruler span')].map((s) => s.textContent?.trim() || '');
          const badRuler = ruler.filter((t) => !t || /NaN|Infinity/i.test(t));
          const readout = document.querySelector('.fx-k-readout')?.textContent || '';
          return {
            ok: bad.length === 0 && badRuler.length === 0 && !/NaN|Infinity/i.test(readout),
            shapeCount: svg.querySelectorAll('rect, line').length,
            bad,
            ruler,
            badRuler,
            readoutHasNaN: /NaN|Infinity/i.test(readout),
          };
        });
        assert(audit.ok && audit.shapeCount > 0, `SVG geometry failed on ${tag}: ${JSON.stringify(audit)}`);
        return audit;
      };

      // 3) 10 flat-price candles (open=high=low=close=42, volume=0)
      mockCandles = Array.from({ length: 10 }, (_, idx) => ({
        ts_ms: baseTs + idx * 60_000,
        open: 42,
        high: 42,
        low: 42,
        close: 42,
        volume: 0,
        settled: true,
        running: false,
      }));
      await switchGrainToTriggerFetch('60m');
      await page.locator('.fx-k-zoom').filter({ hasText: '10 / 10 根' }).waitFor({ state: 'visible', timeout: 5000 });
      const flatAudit = await validateSvgGeometry('flat-42');

      // 4) 5 zero-price candles (0)
      mockCandles = Array.from({ length: 5 }, (_, idx) => ({
        ts_ms: baseTs + idx * 60_000,
        open: 0,
        high: 0,
        low: 0,
        close: 0,
        volume: 0,
        settled: true,
        running: false,
      }));
      await switchGrainToTriggerFetch('120m');
      await page.locator('.fx-k-zoom').filter({ hasText: '5 / 5 根' }).waitFor({ state: 'visible', timeout: 5000 });
      const zeroAudit = await validateSvgGeometry('zero-0');

      return `0-candle empty ok; 1-candle disabled ok; flat(${flatAudit.shapeCount} shapes) & zero(${zeroAudit.shapeCount} shapes) clean`;
    } finally {
      await page.unrouteAll({ behavior: 'ignoreErrors' });
      await context.close();
    }
  });

  // ---------------- T5-4: FxCandleChart Extreme Zoom Bounds, pointercancel & Watchlist Filter ----------------
  await harness.check('T5-4', 'tier5', 'FxChart:Zoom&Filter', 'Verify Alt+Wheel min/max bounds, pointercancel, dblclick reset, and empty held filter on live server', async () => {
    const context = await harness.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await harness.newPage(context, '/');
    const username = makeUniqueUsername('t5fxz');

    try {
      await registerViaUi(page, username, password);
      await navigateToTab(page, 'fx');
      await page.locator('main table tbody tr').first().waitFor({ state: 'visible', timeout: 10000 });

      const c15 = page.waitForResponse((r) => r.url().includes('/api/fx/candles') && r.url().includes('grain=15'), { timeout: 10000 });
      await page.getByRole('button', { name: /^15m$/ }).first().click();
      await c15;

      const wrap = page.locator('main .fx-k-wrap').first();
      await wrap.scrollIntoViewIfNeeded();
      const box = await wrap.boundingBox();
      assert(box, 'Missing .fx-k-wrap boundingBox');

      const parseZoom = async () => {
        const text = (await page.locator('.fx-k-zoom').textContent()) || '';
        const m = text.match(/(\d+)\s*\/\s*(\d+)\s*根/);
        assert(m, `Unexpected .fx-k-zoom text: ${text}`);
        return { visible: Number(m[1]), total: Number(m[2]) };
      };

      const initialZoom = await parseZoom();
      assert(initialZoom.total > 1, `Expected >1 live 15m candles, got ${initialZoom.total}`);

      // Alt+Wheel zoom-in to 1 / N
      await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5);
      await page.keyboard.down('Alt');
      for (let i = 0; i < 30; i += 1) {
        const z = await parseZoom();
        if (z.visible <= 1) break;
        await page.mouse.wheel(0, -180);
        await page.waitForTimeout(25);
      }
      const minZoom = await parseZoom();
      assert(minZoom.visible === 1, `Expected min zoom 1 / ${minZoom.total}, got ${minZoom.visible} / ${minZoom.total}`);
      assert(await page.getByRole('button', { name: '放大图表' }).isDisabled(), '放大图表 should be disabled at 1 / N');

      // Alt+Wheel zoom-out to N / N
      for (let i = 0; i < 35; i += 1) {
        const z = await parseZoom();
        if (z.visible >= z.total) break;
        await page.mouse.wheel(0, 180);
        await page.waitForTimeout(25);
      }
      await page.keyboard.up('Alt');

      const maxZoom = await parseZoom();
      assert(maxZoom.visible === maxZoom.total, `Expected max zoom ${maxZoom.total} / ${maxZoom.total}, got ${maxZoom.visible}`);
      assert(await page.getByRole('button', { name: '缩小图表' }).isDisabled(), '缩小图表 should be disabled at N / N');
      assert(await page.getByRole('button', { name: '查看更早行情' }).isDisabled(), '查看更早行情 should be disabled at N / N');
      assert(await page.getByRole('button', { name: '查看较新行情' }).isDisabled(), '查看较新行情 should be disabled at N / N');

      // Drag + pointercancel clears .is-dragging
      await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.5);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width * 0.4, box.y + box.height * 0.5);
      const draggingDuring = await wrap.evaluate((el) => el.classList.contains('is-dragging'));
      assert(draggingDuring, 'Expected .is-dragging during pointer drag');
      await wrap.dispatchEvent('pointercancel', { pointerId: 1 });
      await page.mouse.up().catch(() => {});
      const draggingAfterCancel = await wrap.evaluate((el) => el.classList.contains('is-dragging'));
      assert(!draggingAfterCancel, 'Expected .is-dragging cleared after pointercancel');

      // Double click restores default zoom (min(64, N) for 15m)
      await wrap.dblclick();
      const restored = await parseZoom();
      const expectedDefault = Math.min(64, restored.total);
      assert(restored.visible === expectedDefault, `Expected dblclick to restore ${expectedDefault} / ${restored.total}, got ${restored.visible}`);

      // Watchlist 持仓中 (0) empty state & restore
      await page.getByRole('button', { name: /持仓中\s*\(0\)/ }).click();
      await page.locator('main').getByText('当前没有持仓中的词条标的。').waitFor({ state: 'visible', timeout: 5000 });
      await page.getByRole('button', { name: '查看全部标的' }).click();
      const rowsRestored = await page.locator('main table tbody tr').count();
      assert(rowsRestored === 8, `Expected 8 FX symbols restored, got ${rowsRestored}`);

      return `15m total=${initialZoom.total}, min=1, max=${maxZoom.total}, dblclick=${restored.visible}, heldFilter=ok`;
    } finally {
      await context.close();
    }
  });

  // ---------------- T5-5: GuildPanel Filtering, Sorting, Reset & Hidden Selection ----------------
  await harness.check('T5-5', 'tier5', 'Guild:FilterSortHidden', 'Verify tier/trait filters, sorting, empty reset, and cross-filter hidden selection count', async () => {
    const context = await harness.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await harness.newPage(context, '/');
    const username = makeUniqueUsername('t5guild');

    try {
      const auth = await registerViaUi(page, username, password);
      const userId = auth?.user?.id || 1;
      const mockInv = buildStressGuildInventory(userId);
      await page.route('**/api/guild/inventory', (route) =>
        route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(mockInv) }),
      );

      await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
      await navigateToTab(page, 'guild');
      await page.locator('main table tbody tr').first().waitFor({ state: 'visible', timeout: 8000 });
      assert((await page.locator('main table tbody tr').count()) === 3, 'Expected 3 mock fish rows');

      // 1) Check normal row, then filter to 稀有 -> .guild-hidden-selection displays （含当前筛选外 1 堆）
      const normalRowCb = page.locator('main table tbody tr').filter({ hasText: /普通/ }).first().locator('input[type="checkbox"]');
      await normalRowCb.check();
      await page.locator('.guild-filter-pill').filter({ hasText: /^稀有/ }).click();
      assert((await page.locator('main table tbody tr').count()) === 1, 'Expected 1 rare row visible');
      const hiddenText = (await page.locator('.guild-hidden-selection').textContent()) || '';
      assert(/（含当前筛选外\s*1\s*堆）/.test(hiddenText), `Unexpected hidden selection note: ${hiddenText}`);

      // 2) Filter to 传说 (0 rows) -> empty message -> 重置筛选 preserves checked selection
      await page.locator('.guild-filter-pill').filter({ hasText: /^传说/ }).click();
      await page.locator('main').getByText('当前筛选条件下没有匹配的渔获。').waitFor({ state: 'visible', timeout: 5000 });
      await page.getByRole('button', { name: /重置筛选/ }).click();
      assert((await page.locator('main table tbody tr').count()) === 3, 'Expected all 3 rows restored after 重置筛选');
      assert(await normalRowCb.isChecked(), 'Normal row checkbox selection should persist across filter reset');

      // 3) Exercise trait filter & sort modes
      const traitSelect = page.getByLabel('按词条筛选');
      await traitSelect.selectOption('luminous');
      assert((await page.locator('main table tbody tr').count()) === 1, 'Expected 1 luminous row');
      await traitSelect.selectOption('all');
      assert((await page.locator('main table tbody tr').count()) === 3, 'Expected 3 rows after resetting trait filter');

      const sortSelect = page.getByLabel('渔获排序');
      for (const sortKey of ['total', 'unit', 'weight', 'tier', 'default']) {
        await sortSelect.selectOption(sortKey);
      }
      const firstAfterTierSort = await (async () => {
        await sortSelect.selectOption('tier');
        return (await page.locator('main table tbody tr').first().textContent()) || '';
      })();
      assert(/史诗/.test(firstAfterTierSort), `Expected epic row first on tier sort, got: ${firstAfterTierSort}`);

      return 'hidden selection=1, reset preserved checkbox, trait+4 sorts verified';
    } finally {
      await page.unrouteAll({ behavior: 'ignoreErrors' });
      await context.close();
    }
  });

  // ---------------- T5-6: Lottery 00:00:00 Countdown, Drawn/Claim, Hash Expand/Copy (MOCK ONLY) ----------------
  await harness.check('T5-6', 'tier5', 'Lottery:Countdown&Claim', 'Verify 00:00:00 settlement poll, drawn badges, seed hash expand/copy, and Claim All receipt (mocked)', async () => {
    const context = await harness.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await harness.newPage(context, '/');
    const username = makeUniqueUsername('t5lot');

    try {
      const auth = await registerViaUi(page, username, password);
      const userId = auth?.user?.id || 1;
      const batchId = '2026-11-26T06:00:00Z';
      const startAt = '2026-11-26T06:00:00Z';
      const endAt = new Date(Date.now() + 2200).toISOString();
      const seedHash = 'c'.repeat(64);

      const mockPools = livePools.map((p) => (p.id === 'advanced' ? { ...p, prizes: [[], ...(p.prizes ?? []).slice(1)] } : p));
      const mockTickets = [
        { id: 'aaaa1111-win', tier: 'normal', batch_id: batchId, numbers: [1, 2, 3, 4, 5], status: 'pending', assigned_at: startAt },
        { id: 'bbbb2222-con', tier: 'normal', batch_id: batchId, numbers: [20, 21, 22, 23, 24], status: 'pending', assigned_at: startAt },
        { id: 'cccc3333-miss', tier: 'advanced', batch_id: batchId, numbers: [20, 21, 22, 23, 24, 25], status: 'pending', assigned_at: startAt },
      ];

      let phase = 'counting';
      let statusPollCount = 0;

      await page.route('**/api/lottery/status', (route) => {
        statusPollCount += 1;
        if (phase === 'counting') {
          return route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify(
              buildMockLotteryPayload({
                pools: mockPools,
                batchId,
                startAt,
                endAt,
                drawn: false,
                tickets: mockTickets,
                recentDraws: [],
              }),
            ),
          });
        }
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(
            buildMockLotteryPayload({
              pools: mockPools,
              batchId,
              startAt,
              endAt,
              drawn: true,
              tickets: phase === 'claimed' ? [] : mockTickets,
              recentDraws: [
                {
                  batch_id: batchId,
                  pool_id: 'normal',
                  winning_numbers: [1, 2, 10, 15, 30],
                  draw_seed_hash: seedHash,
                  drawn_at: new Date().toISOString(),
                },
                {
                  batch_id: batchId,
                  pool_id: 'advanced',
                  winning_numbers: [1, 2, 3, 4, 5, 6],
                  draw_seed_hash: 'd'.repeat(64),
                  drawn_at: new Date().toISOString(),
                },
              ],
            }),
          ),
        });
      });

      await page.route('**/api/lottery/claim', (route) => {
        phase = 'claimed';
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            ok: true,
            claimed: 2,
            replayed: false,
            player: {
              user_id: userId,
              version: 90,
              inv_rev: 20,
              coins: 250,
              black_coins: 0,
              state: {},
              last_fishing_settle_at: new Date().toISOString(),
              house_last_claim_at: null,
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            },
            tickets: [
              { ...mockTickets[0], hits: 2, prizes: [{ type: 'coin', qty: 100 }] },
              { ...mockTickets[1], hits: 0, prizes: [{ type: 'coin', qty: 5 }] },
            ],
          }),
        });
      });

      await navigateToTab(page, 'lottery');
      await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
      await page.getByRole('timer').first().waitFor({ state: 'visible', timeout: 8000 });

      const pollsBeforeZero = statusPollCount;
      await page.locator('.lottery-status-settling').filter({ hasText: '等待开奖结算…' }).waitFor({ state: 'visible', timeout: 7000 });
      await page.waitForFunction(
        () => (document.querySelector('[role="timer"]')?.textContent || '').trim() === '00:00:00',
        null,
        { timeout: 5000 },
      );
      assert(statusPollCount > pollsBeforeZero, `Expected automatic settlement poll at 00:00:00 (before=${pollsBeforeZero}, after=${statusPollCount})`);

      // Transition mock to drawn: true
      phase = 'drawn';
      await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
      await page.locator('.lottery-status-drawn').filter({ hasText: '本轮已开奖' }).waitFor({ state: 'visible', timeout: 8000 });

      for (const label of [/普通场制券数量/, /高级场制券数量/, /大师场制券数量/]) {
        const input = page.getByLabel(label).first();
        assert(await input.isDisabled(), `${label} input must be disabled when drawn=true`);
        const btn = input.locator('xpath=ancestor::form[1]//button[@type="submit"]');
        assert(await btn.isDisabled(), `${label} submit must be disabled when drawn=true`);
      }

      await page.locator('.lottery-ticket-badge').filter({ hasText: /命中\s*2\s*·\s*可领取/ }).waitFor({ state: 'visible', timeout: 5000 });
      await page.locator('.lottery-ticket-badge').filter({ hasText: /已开奖·参与奖可领/ }).waitFor({ state: 'visible', timeout: 5000 });
      await page.locator('.lottery-ticket-badge').filter({ hasText: /已开奖·未中奖/ }).waitFor({ state: 'visible', timeout: 5000 });

      // Expand & Copy draw_seed_hash
      await page.getByRole('button', { name: /展开/ }).first().click();
      const fullHashText = (await page.locator('.lottery-hash-full').first().textContent()) || '';
      assert(fullHashText.trim() === seedHash, `Expected full 64-hex hash, got: ${fullHashText}`);

      await page.getByRole('button', { name: /复制/ }).first().click();
      await page.getByRole('button', { name: /已复制/ }).first().waitFor({ state: 'visible', timeout: 4000 });

      // Claim All & close receipt
      await page.getByRole('button', { name: /Claim All|领取全部/i }).first().click();
      const receipt = page.locator('.lottery-claim-receipt').first();
      await receipt.waitFor({ state: 'visible', timeout: 6000 });
      const receiptText = (await receipt.textContent()) || '';
      assert(/领奖回执 · 已结算 2 张号码券/.test(receiptText), `Unexpected claim receipt: ${receiptText}`);
      await page.getByRole('button', { name: '关闭领奖回执' }).click();
      await receipt.waitFor({ state: 'hidden', timeout: 4000 });

      return `00:00:00 poll=${pollsBeforeZero}->${statusPollCount}, drawn/hash/claim receipt verified`;
    } finally {
      await page.unrouteAll({ behavior: 'ignoreErrors' });
      await context.close();
    }
  });

  // ---------------- T5-7: scratch-super 9-Slot Foil Pointer-Drag & Filters ----------------
  await harness.check('T5-7', 'tier5', 'Scratch:Super9SlotFoil', 'Verify 9-slot scratch-super foil pointer drag (>=45%), multi-combo payouts, and scratch filters', async () => {
    const context = await harness.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await harness.newPage(context, '/');
    const username = makeUniqueUsername('t5sc');

    try {
      const auth = await registerViaUi(page, username, password);
      const userId = auth?.user?.id || 1;

      const unrevealedSuper = buildSuperScratchCard(802, false);
      const revealedTide = {
        id: 801,
        card_type: 'scratch-tide',
        slots: 3,
        revealed: true,
        created_at: new Date().toISOString(),
        revealed_at: new Date().toISOString(),
        face: [
          { id: 't1', kind: 'coin', name: 'coin', qty: 10, need: 2 },
          { id: 't2', kind: 'material', name: '深蓝晶片', qty: 1, need: 2 },
          { id: 't3', kind: 'material', name: '潮汐核心', qty: 1, need: 2 },
        ],
        payouts: [],
      };
      let revealedSuperDone = false;

      await page.route('**/api/scratch/cards', (route) =>
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            ok: true,
            cards: [revealedSuperDone ? buildSuperScratchCard(802, true) : unrevealedSuper, revealedTide],
          }),
        }),
      );

      await page.route('**/api/scratch/reveal', (route) => {
        revealedSuperDone = true;
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            ok: true,
            replayed: false,
            card: buildSuperScratchCard(802, true),
            player: {
              user_id: userId,
              version: 40,
              inv_rev: 15,
              coins: 100,
              black_coins: 0,
              state: {},
              last_fishing_settle_at: new Date().toISOString(),
              house_last_claim_at: null,
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            },
          }),
        });
      });

      await navigateToTab(page, 'lottery');
      await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));

      const foil = page.locator('.scratch-card-super .scratch-foil-canvas').first();
      await foil.waitFor({ state: 'visible', timeout: 8000 });
      await foil.scrollIntoViewIfNeeded();
      const box = await foil.boundingBox();
      assert(box && box.width > 40 && box.height > 40, 'Missing scratch-super foil canvas boundingBox');

      // Drag pointer across >=45% of foil canvas (no button click fallback)
      const revealP = page.waitForResponse((r) => r.url().includes('/api/scratch/reveal') && r.request().method() === 'POST', { timeout: 10000 });
      const passes = [
        [0.06, 0.16, 0.94, 0.16],
        [0.94, 0.16, 0.06, 0.34],
        [0.06, 0.34, 0.94, 0.34],
        [0.94, 0.34, 0.06, 0.52],
        [0.06, 0.52, 0.94, 0.52],
        [0.94, 0.52, 0.06, 0.70],
        [0.06, 0.70, 0.94, 0.70],
        [0.94, 0.70, 0.06, 0.86],
        [0.06, 0.86, 0.94, 0.86],
      ];
      await page.mouse.move(box.x + box.width * passes[0][0], box.y + box.height * passes[0][1]);
      await page.mouse.down();
      for (const [, , x2, y2] of passes) {
        await page.mouse.move(box.x + box.width * x2, box.y + box.height * y2, { steps: 10 });
      }
      await page.mouse.up();
      const revealRes = await revealP;
      assert(revealRes.status() === 200, `Expected /api/scratch/reveal 200, got ${revealRes.status()}`);

      const superCard = page.locator('.scratch-card-super').first();
      await superCard.locator('.scratch-rewards-summary').waitFor({ state: 'visible', timeout: 6000 });
      const slotCount = await superCard.locator('.scratch-slot').count();
      const winnerCount = await superCard.locator('.scratch-slot-winner').count();
      const summaryText = (await superCard.locator('.scratch-rewards-summary').textContent()) || '';
      assert(slotCount === 9, `Expected 9 slots on scratch-super, got ${slotCount}`);
      assert(winnerCount === 6, `Expected 6 winning slots on scratch-super, got ${winnerCount}`);
      assert(/100\s*金币/.test(summaryText) && /深蓝晶片\s*×\s*2/.test(summaryText), `Unexpected multi-combo summary: ${summaryText}`);

      // Verify scratch filters (未刮开 / 已刮开 / 全部)
      await page.locator('.scratch-filters button').filter({ hasText: /^未刮开/ }).click();
      await page.locator('main').getByText('当前筛选条件下暂无刮刮卡。').waitFor({ state: 'visible', timeout: 4000 });
      await page.locator('.scratch-filters button').filter({ hasText: /^已刮开/ }).click();
      assert((await page.locator('.scratch-card').count()) === 2, 'Expected 2 revealed scratch cards');
      await page.locator('.scratch-filters button').filter({ hasText: /^全部/ }).click();
      assert((await page.locator('.scratch-card').count()) === 2, 'Expected 2 total scratch cards');

      return `9 slots, 6 winners, summary="${summaryText.trim()}", filters ok`;
    } finally {
      await page.unrouteAll({ behavior: 'ignoreErrors' });
      await context.close();
    }
  });

  // ---------------- T5-8: 401 Session Expiry Auto-Signout ----------------
  await harness.check('T5-8', 'tier5', 'Resilience:401Signout', 'Verify 401 on background sync clears deepmarket.session and returns to AuthGate', async () => {
    const context = await harness.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await harness.newPage(context, '/');
    const username = makeUniqueUsername('t5401');

    try {
      await registerViaUi(page, username, password);
      const beforeToken = await page.evaluate(() => localStorage.getItem('deepmarket.session'));
      assert(Boolean(beforeToken), 'Expected deepmarket.session stored before 401');

      await page.route('**/api/guild/inventory', (route) =>
        route.fulfill({
          status: 401,
          contentType: 'application/json',
          body: JSON.stringify({ ok: false, error: 'session expired' }),
        }),
      );

      await harness.allowExpectedHttpError({ method: 'GET', urlPattern: /\/api\/guild\/inventory/, statuses: [401] }, async () => {
        await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
        await waitForAuthGate(page, 10000);
      });

      const afterToken = await page.evaluate(() => localStorage.getItem('deepmarket.session'));
      assert(afterToken === null, `Expected deepmarket.session cleared on 401, got: ${afterToken}`);
      return '401 cleared localStorage and returned to AuthGate';
    } finally {
      await page.unrouteAll({ behavior: 'ignoreErrors' });
      await context.close();
    }
  });

  // ---------------- T5-9: /api/auth/me Restore Failure (500) & Retry Recovery ----------------
  await harness.check('T5-9', 'tier5', 'Resilience:Me500Retry', 'Verify 500 on /api/auth/me shows .session-loading alert and Retry recovers workspace', async () => {
    const context = await harness.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await harness.newPage(context, '/');
    const username = makeUniqueUsername('t5500');

    try {
      await registerViaUi(page, username, password);

      let failMe = true;
      await page.route('**/api/auth/me', (route) => {
        if (failMe) {
          return route.fulfill({
            status: 500,
            contentType: 'application/json',
            body: JSON.stringify({ ok: false, error: 'db unavailable' }),
          });
        }
        return route.continue();
      });

      await harness.allowExpectedHttpError({ method: 'GET', urlPattern: /\/api\/auth\/me/, statuses: [500] }, async () => {
        await page.reload({ waitUntil: 'domcontentloaded' });
        const alert = page.locator('.session-loading [role="alert"]').first();
        await alert.waitFor({ state: 'visible', timeout: 8000 });
        const alertText = (await alert.textContent()) || '';
        assert(/db unavailable/.test(alertText), `Expected db unavailable alert, got: ${alertText}`);
        assert(await page.getByRole('button', { name: '重试' }).isVisible(), '重试 button missing');
        assert(await page.getByRole('button', { name: '返回登录' }).isVisible(), '返回登录 button missing');
      });

      failMe = false;
      await page.getByRole('button', { name: '重试' }).click();
      await waitForWorkspaceReady(page, 15000);
      return '500 alert -> 重试 recovered workspace cleanly';
    } finally {
      await page.unrouteAll({ behavior: 'ignoreErrors' });
      await context.close();
    }
  });

  // ---------------- T5-10: Malformed / Invalid-Sig / Mismatched-ID SSE & Valid Global Legendary ----------------
  await harness.check('T5-10', 'tier5', 'Resilience:MalformedSSE', 'Ignore malformed/bad-sig/mismatched-id SSE frames and render valid global legendary banner at 390x844', async () => {
    const context = await harness.newContext({ viewport: { width: 390, height: 844 } });
    const page = await harness.newPage(context, '/');
    const username = makeUniqueUsername('t5sse');

    try {
      const sig = 'a'.repeat(64);
      const ts = Date.now();
      const validGlobal = {
        id: 'global-999-1',
        channel: 'global',
        user_id: 999,
        seq: 1,
        inv_rev: 1,
        version: 1,
        ts_ms: ts,
        sig,
        event: 'catch',
        payload: {
          species_id: 'ghost_jelly',
          name: '静海幽灵水母',
          tier: 'legendary',
          traits: ['luminous', 'abyssal'],
          weight_g: 4200,
          durability: 990,
          previous_durability: 1000,
          durability_loss: 10,
          inv_rev: 1,
          quantity: 1,
        },
      };
      const badSig = { ...validGlobal, id: 'global-999-2', seq: 2, sig: 'not_hex' };
      const mismatchId = { ...validGlobal, id: 'global-999-3', seq: 3, sig };

      const sseBody = [
        `event: catch\nid: global-999-0\ndata: {bad json\n\n`,
        `event: catch\nid: global-999-2\ndata: ${JSON.stringify(badSig)}\n\n`,
        `event: catch\nid: mismatch\ndata: ${JSON.stringify(mismatchId)}\n\n`,
        `event: catch\nid: global-999-1\ndata: ${JSON.stringify(validGlobal)}\n\n`,
      ].join('');

      await page.route('**/api/sse/stream*', (route) =>
        route.fulfill({
          status: 200,
          headers: {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache',
          },
          body: sseBody,
        }),
      );

      // Register via UI form directly (mocked SSE stream closes EOF immediately after delivering the 4 frames,
      // so connection transitions from connected -> reconnecting rather than staying perpetually open).
      await waitForAuthGate(page);
      await switchAuthMode(page, 'register');
      await page.locator('input[name="username"]').fill(username);
      await page.locator('input[name="password"]').fill(password);
      const regP = page.waitForResponse(
        (r) => r.url().includes('/api/auth/register') && r.request().method() === 'POST',
        { timeout: 15000 },
      );
      await page.locator('form button[type="submit"]').click();
      const regRes = await regP;
      assert(regRes.status() === 201 || regRes.status() === 200, `Expected register 201/200, got ${regRes.status()}`);
      await page.locator('nav').waitFor({ state: 'visible', timeout: 15000 });

      const banner = page.locator('.fishing-legendary').first();
      await banner.waitFor({ state: 'visible', timeout: 10000 });
      const bannerText = (await banner.textContent()) || '';
      assert(bannerText.includes('静海幽灵水母') && bannerText.includes('HMAC aaaaaaaa'), `Unexpected legendary banner: ${bannerText}`);

      const headerText = (await page.locator('header').textContent()) || '';
      assert(headerText.includes('HMAC aaaaaaaa'), `Header missing HMAC aaaaaaaa: ${headerText}`);

      // Invalid frames must not pollute user catch feed and must fit 390x844 cleanly
      const userFeedCount = await page.locator('.fishing-feed-list li').count();
      assert(userFeedCount === 0, `Expected 0 user catch feed rows from global/invalid SSE, got ${userFeedCount}`);
      await auditNarrowLayout(page, 'LegendarySSE-390x844');

      assert(harness.pageErrors.length === 0, `Page errors detected: ${JSON.stringify(harness.pageErrors)}`);
      assert(harness.consoleErrors.length === 0, `Console errors detected: ${JSON.stringify(harness.consoleErrors)}`);
      assert(harness.unexpectedHttpErrors.length === 0, `Unexpected HTTP errors: ${JSON.stringify(harness.unexpectedHttpErrors)}`);

      return '3 invalid SSE frames ignored, global legendary 静海幽灵水母 + HMAC aaaaaaaa rendered cleanly';
    } finally {
      await page.unrouteAll({ behavior: 'ignoreErrors' });
      await context.close();
    }
  });
}
