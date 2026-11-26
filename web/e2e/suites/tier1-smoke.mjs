import { assert } from '../lib/harness.mjs';
import { makeUniqueUsername } from '../lib/config.mjs';
import {
  assertLotteryCraftOpen,
  countCatchesInFeed,
  getFishingCanvas,
  getFxChartFocusTarget,
  getFxChartReadoutText,
  getFxChartSurface,
  getFxOrderForm,
  getRevealedScratchRewards,
  getScratchBuyButton,
  getScratchCards,
  loginViaUi,
  logoutViaUi,
  navigateToTab,
  readHeaderMetrics,
  registerViaUi,
  revealFirstScratchCard,
  selectDepth,
  sellAllGuildRows,
  sellFirstGuildRow,
  startFishing,
  stopFishing,
  submitFxOrder,
  waitForAuthGate,
  waitForCatches,
  waitForWorkspaceReady,
} from '../lib/locators.mjs';
import { sampleCanvasSignature, verifyFxChartNonBlank } from '../lib/layout-audit.mjs';

export async function runTier1Smoke(harness) {
  console.log('\n=== Tier 1: Core Smoke & Happy Path (>= 25 checks across F1..F5) ===');
  const context = await harness.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await harness.newPage(context, '/');
  const username = makeUniqueUsername('t1');
  const password = 'Password123!';

  try {
    // ---------------- F1: AuthGate (5 checks) ----------------
    await harness.check('T1-F1-1', 'tier1', 'F1:AuthGate', 'Initial render and login/register mode toggle', async () => {
      await waitForAuthGate(page);
      const regBtn = page.getByRole('button', { name: /^(注册|Register)$/i }).first();
      const loginBtn = page.getByRole('button', { name: /^(登录|Sign\s*In|Login)$/i }).first();
      assert((await loginBtn.getAttribute('aria-pressed')) === 'true', 'Login mode should be active initially');
      await regBtn.click();
      assert((await regBtn.getAttribute('aria-pressed')) === 'true', 'Register mode should activate on click');
      const submitText = await page.locator('form button[type="submit"]').textContent();
      assert(/创建账号|Register/i.test(submitText || ''), `Unexpected register submit text: ${submitText}`);
      return `submit="${(submitText || '').trim()}"`;
    });

    await harness.check('T1-F1-2', 'tier1', 'F1:AuthGate', 'Register fresh unique account via UI', async () => {
      await registerViaUi(page, username, password);
      const metrics = await readHeaderMetrics(page);
      assert(metrics.rawText.includes(username), `Header should show username ${username}`);
      assert(metrics.coins === 0, `Fresh user should start with 0 coins, got ${metrics.coins}`);
      assert(metrics.sseConnected, 'SSE should connect after registration');
      return `user=${username}, coins=${metrics.coins}`;
    });

    await harness.check('T1-F1-3', 'tier1', 'F1:AuthGate', 'Session persists across page.reload()', async () => {
      const mePromise = page.waitForResponse((r) => r.url().includes('/api/auth/me'), { timeout: 15000 });
      const invPromise = page.waitForResponse((r) => r.url().includes('/api/guild/inventory'), { timeout: 15000 });
      const lotPromise = page.waitForResponse((r) => r.url().includes('/api/lottery/status'), { timeout: 15000 });
      await page.reload({ waitUntil: 'domcontentloaded' });
      const meRes = await mePromise;
      assert(meRes.status() === 200, `Expected /api/auth/me 200 on reload, got ${meRes.status()}`);
      await Promise.all([invPromise, lotPromise]);
      await waitForWorkspaceReady(page);
      const metrics = await readHeaderMetrics(page);
      assert(metrics.rawText.includes(username), 'Username missing after reload');
      assert(metrics.sseConnected, 'SSE did not reconnect after reload');
      return 'reloaded, hydrated & SSE online';
    });

    await harness.check('T1-F1-4', 'tier1', 'F1:AuthGate', 'Logout clears session and returns to AuthGate', async () => {
      await logoutViaUi(page);
      const stored = await page.evaluate(() => localStorage.getItem('deepmarket.session'));
      assert(!stored, `Expected localStorage deepmarket.session cleared, got ${stored}`);
      return 'session cleared';
    });

    await harness.check('T1-F1-5', 'tier1', 'F1:AuthGate', 'Login restores authenticated workspace', async () => {
      await loginViaUi(page, username, password);
      const metrics = await readHeaderMetrics(page);
      assert(metrics.rawText.includes(username), 'Username missing after login');
      assert(metrics.sseConnected, 'SSE not connected after login');
      return 'logged in & SSE online';
    });

    // ---------------- F2: FishingDeck & DeepSeaCanvas (5 checks) ----------------
    await harness.check('T1-F2-1', 'tier1', 'F2:FishingDeck', 'DeepSeaCanvas renders non-blank pixel art', async () => {
      const canvas = getFishingCanvas(page);
      const sample = await sampleCanvasSignature(canvas);
      assert(sample.nonZeroPixels > sample.totalPixels * 0.5, `Canvas mostly transparent (${sample.nonZeroPixels}/${sample.totalPixels})`);
      assert(sample.uniqueBuckets > 2, `Canvas lacks color variation (buckets=${sample.uniqueBuckets})`);
      return `${sample.boxWidth}x${sample.boxHeight}, buckets=${sample.uniqueBuckets}`;
    });

    await harness.check('T1-F2-2', 'tier1', 'F2:FishingDeck', 'Depth selection supports shelf and returns to shore', async () => {
      await selectDepth(page, 'shelf');
      await selectDepth(page, 'shore');
      const mainText = await page.locator('main').textContent();
      assert(/近岸|shore/i.test(mainText || ''), 'Shore depth label not visible');
      return 'shelf -> shore';
    });

    await harness.check('T1-F2-3', 'tier1', 'F2:FishingDeck', 'Start fishing activates running state and meters', async () => {
      await startFishing(page);
      const chargeMeter = page.getByRole('meter', { name: /蓄力|Charge/i }).first();
      const tensionMeter = page.getByRole('meter', { name: /鱼线张力|张力|Tension/i }).first();
      const durabilityMeter = page.getByRole('meter', { name: /耐久|Durability/i }).first();
      assert(await chargeMeter.isVisible(), 'Charge meter not visible');
      assert(await tensionMeter.isVisible(), 'Tension meter not visible');
      assert(await durabilityMeter.isVisible(), 'Durability meter not visible');
      return 'fishing started + 3 meters visible';
    });

    await harness.check('T1-F2-4', 'tier1', 'F2:FishingDeck', 'Live SSE catch updates feed and syncs fishing/guild state', async () => {
      const invSyncPromise = page.waitForResponse(
        (r) => r.url().includes('/api/guild/inventory') && r.status() === 200,
        { timeout: 25000 },
      );
      await waitForCatches(page, 1, 25000);
      await invSyncPromise;
      const firstCatchText = (await page.locator('main ol li, main [role="list"] li, .fishing-feed li').first().textContent()) || '';
      assert(/捕获|Caught/i.test(firstCatchText), `Expected catch entry in feed, got: ${firstCatchText}`);
      const durText = await page.getByRole('meter', { name: /耐久|Durability/i }).first().getAttribute('aria-valuetext');
      const durVal = durText ? Number(durText.split('/')[0].replace(/[^\d]/g, '')) : 0;
      assert(durVal > 0 && durVal <= 1000, `Expected valid rod durability (1..1000), got ${durText}`);
      return `1st catch="${firstCatchText.replace(/\s+/g, ' ').trim()}", durability=${durText}`;
    });

    await harness.check('T1-F2-5', 'tier1', 'F2:FishingDeck', 'Farm 3 catches, stop fishing, and verify rod maintenance controls', async () => {
      await waitForCatches(page, 3, 45000);
      await stopFishing(page);
      const mainText = await page.locator('main').textContent();
      assert(/潮汐钓竿/.test(mainText || ''), 'Starter rod name 潮汐钓竿 not displayed');
      assert(/深蓝晶片/.test(mainText || ''), 'Material 深蓝晶片 not displayed');
      assert(await page.getByRole('button', { name: /手动修理/ }).isVisible(), 'Manual repair button missing');
      assert(await page.getByRole('button', { name: /自动修理/ }).isVisible(), 'Auto-repair button missing');
      return '3 catches farmed & stopped cleanly';
    });

    // ---------------- F3: GuildPanel (5 checks) ----------------
    await harness.check('T1-F3-1', 'tier1', 'F3:GuildPanel', 'Navigate to Tidal Guild and render caught fish table', async () => {
      await navigateToTab(page, 'guild');
      const rows = page.locator('main table tbody tr');
      await rows.first().waitFor({ state: 'visible', timeout: 8000 });
      const count = await rows.count();
      assert(count >= 3, `Expected >= 3 fish stacks in Guild warehouse, got ${count}`);
      return `${count} fish stacks visible`;
    });

    await harness.check('T1-F3-2', 'tier1', 'F3:GuildPanel', 'Row checkbox and Select-All toggle update selection summary', async () => {
      const firstRowCb = page.locator('main table tbody tr').first().locator('input[type="checkbox"]');
      await firstRowCb.check();
      const summaryOne = await page.locator('main').textContent();
      assert(/已选\s*1\s*(?:个堆栈|堆)/.test(summaryOne || ''), 'Expected 已选 1 个堆栈/堆 after checking first row');

      const selectAllCb = page.getByRole('checkbox', { name: /选择全部|选择当前可见渔获|Select\s*All/i }).first();
      await selectAllCb.check();
      const rowCount = await page.locator('main table tbody tr').count();
      const summaryAll = await page.locator('main').textContent();
      assert(new RegExp(`已选\\s*${rowCount}\\s*(?:个堆栈|堆)`).test(summaryAll || ''), `Expected 已选 ${rowCount} 个堆栈/堆`);
      await selectAllCb.uncheck();
      return `single=1, selectAll=${rowCount}`;
    });

    await harness.check('T1-F3-3', 'tier1', 'F3:GuildPanel', 'Sell selected fish row and verify receipt + FX flows', async () => {
      await sellFirstGuildRow(page);
      const receipt = page.locator('main [role="status"]').filter({ hasText: /已出售/ }).first();
      await receipt.waitFor({ state: 'visible', timeout: 8000 });
      const receiptText = await receipt.textContent();
      assert(/\+\d+\s*金币/.test(receiptText || '') && /\+\d+\s*空白票/.test(receiptText || ''), `Unexpected receipt: ${receiptText}`);
      return (receiptText || '').replace(/\s+/g, ' ').trim();
    });

    await harness.check('T1-F3-4', 'tier1', 'F3:GuildPanel', 'Sell remaining stacks individually and verify header wallet/ticket sync', async () => {
      const before = await readHeaderMetrics(page);
      // Sell remaining stacks individually to guarantee >= 3 blank tickets total
      while ((await page.locator('main table tbody tr').count()) > 0) {
        await sellFirstGuildRow(page);
      }
      await page.waitForFunction(
        (prevInv) => {
          const text = document.querySelector('header')?.textContent || '';
          const m = text.match(/inv_rev\s*(\d+)/i);
          return m && Number(m[1]) > prevInv;
        },
        before.invRev ?? 0,
        { timeout: 8000 },
      );
      const after = await readHeaderMetrics(page);
      assert((after.coins ?? 0) > (before.coins ?? 0), `Expected coins to increase (${before.coins} -> ${after.coins})`);
      assert((after.blankTickets ?? 0) >= 3, `Expected >= 3 blank tickets, got ${after.blankTickets}`);
      return `coins=${after.coins}, tickets=${after.blankTickets}, inv_rev=${after.invRev}`;
    });

    await harness.check('T1-F3-5', 'tier1', 'F3:GuildPanel', 'Materials and Rods panels display accurate starter equipment', async () => {
      const mainText = await page.locator('main').textContent();
      assert(/材料/.test(mainText || ''), 'Materials heading missing');
      assert(/鱼竿/.test(mainText || ''), 'Rods heading missing');
      assert(/潮汐钓竿/.test(mainText || '') && /装备中/.test(mainText || ''), 'Equipped 潮汐钓竿 badge missing');
      const progress = page.locator('main progress, main [role="progressbar"], main [role="meter"]').first();
      assert(await progress.isVisible(), 'Rod durability progress bar missing');
      return 'materials + equipped rod verified';
    });

    // ---------------- F4: FxTerminal (5 checks) ----------------
    await harness.check('T1-F4-1', 'tier1', 'F4:FxTerminal', '8-symbol FX watchlist renders in DeepSea FX', async () => {
      await navigateToTab(page, 'fx');
      const expectedSymbols = ['swift', 'armored', 'luminous', 'heavy', 'ancient', 'surge', 'abyssal', 'prismatic'];
      await page.locator('main table tbody tr').first().waitFor({ state: 'visible', timeout: 10000 });
      const text = (await page.locator('main').textContent()) || '';
      for (const sym of expectedSymbols) {
        assert(text.includes(sym), `Missing FX symbol ${sym} in watchlist`);
      }
      return '8/8 symbols visible';
    });

    await harness.check('T1-F4-2', 'tier1', 'F4:FxTerminal', 'Selecting symbol updates chart and order ticket', async () => {
      const armoredBtn = page.locator('main table button').filter({ hasText: /armored|重甲/i }).first();
      await armoredBtn.click();
      assert((await armoredBtn.getAttribute('aria-pressed')) === 'true', 'armored button should have aria-pressed=true');
      const mainText = (await page.locator('main').textContent()) || '';
      assert(/重甲\s*·\s*K\s*线|交易\s*·\s*重甲/.test(mainText), 'Chart or order heading did not update to 重甲');
      return 'switched to armored';
    });

    await harness.check('T1-F4-3', 'tier1', 'F4:FxTerminal', 'Grain buttons (15m/30m/60m/120m) reload candles', async () => {
      const candlesPromise = page.waitForResponse(
        (r) => r.url().includes('/api/fx/candles') && r.url().includes('grain=15'),
        { timeout: 10000 },
      );
      const btn15 = page.getByRole('button', { name: /^15m$/ }).first();
      await btn15.click();
      const res = await candlesPromise;
      assert(res.status() === 200, `Expected /api/fx/candles grain=15 200, got ${res.status()}`);
      assert((await btn15.getAttribute('aria-pressed')) === 'true', '15m grain button not marked active');

      const btn60 = page.getByRole('button', { name: /^60m$/ }).first();
      await btn60.click();
      assert((await btn60.getAttribute('aria-pressed')) === 'true', '60m grain button not marked active');
      return '15m & 60m grains verified';
    });

    await harness.check('T1-F4-4', 'tier1', 'F4:FxTerminal', 'Chart surface renders non-blank geometry and keyboard crosshair updates OHLCV readout', async () => {
      const surface = getFxChartSurface(page);
      const geom = await verifyFxChartNonBlank(surface);
      const focusTarget = getFxChartFocusTarget(page);
      if (await focusTarget.count()) {
        await focusTarget.focus();
      } else {
        await surface.click();
      }
      const beforeReadout = await getFxChartReadoutText(page);
      await page.keyboard.press('ArrowLeft');
      await page.keyboard.press('ArrowLeft');
      const afterReadout = await getFxChartReadoutText(page);
      assert(/开.*高.*低.*收/.test(afterReadout) && /\d/.test(afterReadout), `OHLCV readout missing or empty: ${afterReadout}`);
      assert(beforeReadout !== afterReadout, `Expected ArrowLeft crosshair to change readout: "${beforeReadout}" vs "${afterReadout}"`);
      return `surface=${Math.round(geom.box.width)}x${Math.round(geom.box.height)} (${geom.kind}), readoutChanged=true`;
    });

    await harness.check('T1-F4-5', 'tier1', 'F4:FxTerminal', 'Buy and sell 1 swift unit updates position and wallet', async () => {
      // Ensure we have enough coins for 1 swift + 30 scratch later
      let metrics = await readHeaderMetrics(page);
      if ((metrics.coins ?? 0) < 45) {
        await navigateToTab(page, 'fishing');
        await startFishing(page);
        const beforeC = await countCatchesInFeed(page);
        await waitForCatches(page, beforeC + 1, 22000);
        await stopFishing(page);
        await navigateToTab(page, 'guild');
        await sellAllGuildRows(page);
        await navigateToTab(page, 'fx');
      }

      const swiftBtn = page.locator('main table button').filter({ hasText: /swift|迅游/i }).first();
      await swiftBtn.click();
      const buyRes = await submitFxOrder(page, 'buy', 1);
      assert(buyRes.status() === 200, `Expected /api/fx/buy 200, got ${buyRes.status()}`);
      const buyReceipt = await getFxOrderForm(page).locator('[role="status"]').textContent();
      assert(/买入\s*1\s*swift/i.test(buyReceipt || '') && /持仓\s*1/.test(buyReceipt || ''), `Unexpected buy receipt: ${buyReceipt}`);

      const sellRes = await submitFxOrder(page, 'sell', 1);
      assert(sellRes.status() === 200, `Expected /api/fx/sell 200, got ${sellRes.status()}`);
      const sellReceipt = await getFxOrderForm(page).locator('[role="status"]').textContent();
      assert(/卖出\s*1\s*swift/i.test(sellReceipt || '') && /持仓\s*0/.test(sellReceipt || ''), `Unexpected sell receipt: ${sellReceipt}`);
      return 'buy 1 -> pos 1 -> sell 1 -> pos 0';
    });

    // ---------------- F5: LotteryScratchHall (5 checks) ----------------
    await harness.check('T1-F5-1', 'tier1', 'F5:LotteryScratch', 'UTC countdown timer and 3 lottery pools render', async () => {
      await navigateToTab(page, 'lottery');
      const timer = page.getByRole('timer').first();
      await timer.waitFor({ state: 'visible', timeout: 8000 });
      const timerText = (await timer.textContent()) || '';
      assert(/^\d{2}:\d{2}:\d{2}$/.test(timerText.trim()), `Invalid countdown format: ${timerText}`);
      const mainText = (await page.locator('main').textContent()) || '';
      for (const pool of ['普通场', '高级场', '大师场']) {
        assert(mainText.includes(pool), `Missing lottery pool: ${pool}`);
      }
      return `timer=${timerText.trim()}`;
    });

    await harness.check('T1-F5-2', 'tier1', 'F5:LotteryScratch', 'Craft 1 normal lottery ticket consumes 3 blank tickets', async () => {
      const before = await readHeaderMetrics(page);
      const input = await assertLotteryCraftOpen(page, '普通场制券数量');
      await input.fill('1');
      const craftBtn = input.locator('xpath=ancestor::form[1]//button[@type="submit"]');
      const craftResP = page.waitForResponse(
        (r) => r.url().includes('/api/lottery/craft') && r.request().method() === 'POST',
        { timeout: 10000 },
      );
      await craftBtn.click();
      const craftRes = await craftResP;
      assert(craftRes.status() === 200, `Expected /api/lottery/craft 200, got ${craftRes.status()}`);
      await page.waitForFunction(
        (prev) => {
          const text = document.querySelector('header')?.textContent || '';
          const m = text.match(/([\d,]+)\s*空白券/);
          return m && Number(m[1].replace(/,/g, '')) === prev - 3;
        },
        before.blankTickets ?? 3,
        { timeout: 8000 },
      );
      const myTicketsText = (await page.locator('main').textContent()) || '';
      assert(/普通场/.test(myTicketsText) && !/暂无(?:待开奖或待领取的)?号码券/.test(myTicketsText), 'Crafted ticket should appear in 我的号码券');
      return `tickets ${before.blankTickets} -> ${(before.blankTickets ?? 3) - 3}`;
    });

    await harness.check('T1-F5-3', 'tier1', 'F5:LotteryScratch', 'Buy scratch-tide card deducts 30 coins', async () => {
      const before = await readHeaderMetrics(page);
      const buyBtn = getScratchBuyButton(page, 'tide');
      const buyResP = page.waitForResponse(
        (r) => r.url().includes('/api/scratch/buy') && r.request().method() === 'POST',
        { timeout: 10000 },
      );
      await buyBtn.click();
      const buyRes = await buyResP;
      assert(buyRes.status() === 200, `Expected /api/scratch/buy 200, got ${buyRes.status()}`);
      await page.waitForFunction(
        (expectedCoins) => {
          const text = document.querySelector('header')?.textContent || '';
          const m = text.match(/([\d,]+)\s*金币/);
          return m && Number(m[1].replace(/,/g, '')) === expectedCoins;
        },
        (before.coins ?? 30) - 30,
        { timeout: 8000 },
      );
      const cardCount = await getScratchCards(page).count();
      assert(cardCount >= 1, 'Expected >= 1 scratch card in collection');
      return `coins ${(before.coins ?? 30)} -> ${(before.coins ?? 30) - 30}`;
    });

    await harness.check('T1-F5-4', 'tier1', 'F5:LotteryScratch', 'Reveal scratch card shows slots and payout summary', async () => {
      const revealRes = await revealFirstScratchCard(page);
      assert(revealRes.status() === 200, `Expected /api/scratch/reveal 200, got ${revealRes.status()}`);
      const rewards = getRevealedScratchRewards(page);
      await rewards.waitFor({ state: 'visible', timeout: 8000 });
      const text = (await rewards.textContent()) || '';
      assert(/组奖励|未形成中奖组合|已刮开/.test(text), `Unexpected scratch reveal summary: ${text}`);
      return text.replace(/\s+/g, ' ').trim();
    });

    await harness.check('T1-F5-5', 'tier1', 'F5:LotteryScratch', 'Draw history renders and zero runtime/network errors occurred', async () => {
      const historyHeading = page.getByRole('heading', { name: /近期开奖记录/ }).first();
      assert(await historyHeading.isVisible(), '近期开奖记录 heading missing');
      assert(harness.pageErrors.length === 0, `Page errors detected: ${JSON.stringify(harness.pageErrors)}`);
      assert(harness.consoleErrors.length === 0, `Console errors detected: ${JSON.stringify(harness.consoleErrors)}`);
      assert(harness.unexpectedHttpErrors.length === 0, `Unexpected HTTP errors: ${JSON.stringify(harness.unexpectedHttpErrors)}`);
      return '0 pageerror, 0 console.error, 0 unexpected HTTP errors';
    });
  } finally {
    await context.close();
  }
}
