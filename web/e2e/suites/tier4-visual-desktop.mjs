import { makeUniqueUsername } from '../lib/config.mjs';
import { assert } from '../lib/harness.mjs';
import {
  auditDesktopLayout,
  diffCanvasSamples,
  sampleCanvasSignature,
  verifyFxChartNonBlank,
} from '../lib/layout-audit.mjs';
import {
  closeSeaChartIfOpen,
  countCatchesInFeed,
  getFishingCanvas,
  getFxChartFocusTarget,
  getFxChartReadoutText,
  getFxChartStateSignature,
  getFxChartSurface,
  getScratchBuyButton,
  loginViaUi,
  logoutViaUi,
  navigateToTab,
  openSeaChartIfPresent,
  readHeaderMetrics,
  registerViaUi,
  revealFirstScratchCard,
  selectDepth,
  sellFirstGuildRow,
  startFishing,
  stopFishing,
  submitFxOrder,
  waitForAuthGate,
  waitForCatches,
  waitForWorkspaceReady,
} from '../lib/locators.mjs';

const EXPECTED_SCREENSHOTS = [
  '1440x900-01-authgate.png',
  '1440x900-02-fishing-deck.png',
  '1440x900-02b-sea-chart.png',
  '1440x900-03-guild-panel.png',
  '1440x900-04-fx-terminal.png',
  '1440x900-05-lottery-scratch.png',
  '1280x800-01-authgate.png',
  '1280x800-02-fishing-deck.png',
  '1280x800-02b-sea-chart.png',
  '1280x800-03-guild-panel.png',
  '1280x800-04-fx-terminal.png',
  '1280x800-05-lottery-scratch.png',
];

export async function runTier4VisualDesktop(harness) {
  console.log('\n=== Tier 4: Real-World Desktop Scenarios, Layout Audit, Canvas Diff & Screenshots ===');
  const username = makeUniqueUsername('t4');
  const password = 'Password123!';

  const context = await harness.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await harness.newPage(context, '/');

  try {
    // Capture 1440x900 AuthGate screenshot & layout audit first, then seed rich populated state
    await harness.check('T4-S1', 'tier4', 'Scenario1:PopulatedEconomySetup', 'Seed realistic populated state across all 5 views for desktop audits', async () => {
      await waitForAuthGate(page);
      await auditDesktopLayout(page, 'AuthGate-1440x900');
      await harness.saveScreenshot(page, '1440x900-01-authgate.png');

      await registerViaUi(page, username, password);
      await selectDepth(page, 'shore');
      await startFishing(page);
      await waitForCatches(page, 4, 70000);
      await stopFishing(page);

      // Sell 3 stacks individually, leaving >= 1 fish row in Guild warehouse so Guild screenshot is populated
      await navigateToTab(page, 'guild');
      await page.locator('main table tbody tr').first().waitFor({ state: 'visible', timeout: 8000 });
      for (let i = 0; i < 3; i += 1) {
        const rows = await page.locator('main table tbody tr').count();
        if (rows <= 1) break;
        await sellFirstGuildRow(page);
      }

      // Ensure >= 70 coins so we can hold 1 swift position + buy/reveal 1 scratch card
      let metrics = await readHeaderMetrics(page);
      if ((metrics.coins ?? 0) < 70) {
        await navigateToTab(page, 'fishing');
        await startFishing(page);
        const cur = await countCatchesInFeed(page);
        await waitForCatches(page, cur + 1, 25000);
        await stopFishing(page);
        await navigateToTab(page, 'guild');
        const rows = await page.locator('main table tbody tr').count();
        if (rows > 1) {
          await sellFirstGuildRow(page);
        }
        metrics = await readHeaderMetrics(page);
      }

      // Buy 1 swift position on FX so FX terminal displays active position & avg cost
      await navigateToTab(page, 'fx');
      await page.locator('main table tbody tr').first().waitFor({ state: 'visible', timeout: 10000 });
      await page.locator('main table button').filter({ hasText: /swift|迅游/i }).first().click();
      const buyFx = await submitFxOrder(page, 'buy', 1);
      assert(buyFx.status() === 200, `FX buy failed during T4 seeding: ${buyFx.status()}`);

      // Craft 1 lottery ticket + buy & reveal 1 scratch card (if coins >= 30)
      await navigateToTab(page, 'lottery');
      metrics = await readHeaderMetrics(page);
      if ((metrics.blankTickets ?? 0) >= 3) {
        const craftInput = page.getByLabel(/普通场制券数量/).first();
        if (await craftInput.isEnabled().catch(() => false)) {
          await craftInput.fill('1');
          const cp = page.waitForResponse((r) => r.url().includes('/api/lottery/craft'));
          await craftInput.locator('xpath=ancestor::form[1]//button[@type="submit"]').click();
          await cp;
        }
      }
      if ((metrics.coins ?? 0) >= 30) {
        const buyP = page.waitForResponse((r) => r.url().includes('/api/scratch/buy'));
        await getScratchBuyButton(page, 'tide').click();
        await buyP;
        await revealFirstScratchCard(page);
      }

      return `seeded populated user ${username}`;
    });

    // Scenario 2: 1440x900 full 5-view layout audit & deterministic screenshots
    await harness.check('T4-S2', 'tier4', 'Scenario2:1440x900Layout&Screenshots', 'Audit layout bounds & capture 5 populated views at 1440x900', async () => {
      await page.setViewportSize({ width: 1440, height: 900 });

      // 02 FishingDeck (active fishing for animated stage)
      await navigateToTab(page, 'fishing');
      await startFishing(page);
      await page.waitForTimeout(500);
      await auditDesktopLayout(page, 'FishingDeck-1440x900');
      await harness.saveScreenshot(page, '1440x900-02-fishing-deck.png');
      await stopFishing(page);

      // 02b SeaChart (M2 modal if available, else depth selector state)
      const modal = await openSeaChartIfPresent(page);
      await auditDesktopLayout(page, 'SeaChart-1440x900');
      await harness.saveScreenshot(page, '1440x900-02b-sea-chart.png');
      if (modal) await closeSeaChartIfOpen(page);

      // 03 GuildPanel
      await navigateToTab(page, 'guild');
      await page.waitForTimeout(300);
      await auditDesktopLayout(page, 'GuildPanel-1440x900');
      await harness.saveScreenshot(page, '1440x900-03-guild-panel.png');

      // 04 FxTerminal
      await navigateToTab(page, 'fx');
      await getFxChartSurface(page).waitFor({ state: 'visible', timeout: 8000 });
      await page.waitForTimeout(350);
      await auditDesktopLayout(page, 'FxTerminal-1440x900');
      await harness.saveScreenshot(page, '1440x900-04-fx-terminal.png');

      // 05 LotteryScratchHall
      await navigateToTab(page, 'lottery');
      await page.getByRole('timer').first().waitFor({ state: 'visible', timeout: 8000 });
      await page.waitForTimeout(300);
      await auditDesktopLayout(page, 'LotteryScratch-1440x900');
      await harness.saveScreenshot(page, '1440x900-05-lottery-scratch.png');

      return '6 deterministic 1440x900 screenshots + 0 layout violations';
    });

    // Scenario 3: 1280x800 full 5-view layout audit & deterministic screenshots
    await harness.check('T4-S3', 'tier4', 'Scenario3:1280x800Layout&Screenshots', 'Audit layout bounds & capture all views at 1280x800', async () => {
      await page.setViewportSize({ width: 1280, height: 800 });

      // 02 FishingDeck
      await navigateToTab(page, 'fishing');
      await startFishing(page);
      await page.waitForTimeout(450);
      await auditDesktopLayout(page, 'FishingDeck-1280x800');
      await harness.saveScreenshot(page, '1280x800-02-fishing-deck.png');
      await stopFishing(page);

      // 02b SeaChart
      const modal = await openSeaChartIfPresent(page);
      await auditDesktopLayout(page, 'SeaChart-1280x800');
      await harness.saveScreenshot(page, '1280x800-02b-sea-chart.png');
      if (modal) await closeSeaChartIfOpen(page);

      // 03 GuildPanel
      await navigateToTab(page, 'guild');
      await page.waitForTimeout(300);
      await auditDesktopLayout(page, 'GuildPanel-1280x800');
      await harness.saveScreenshot(page, '1280x800-03-guild-panel.png');

      // 04 FxTerminal
      await navigateToTab(page, 'fx');
      await getFxChartSurface(page).waitFor({ state: 'visible', timeout: 8000 });
      await page.waitForTimeout(350);
      await auditDesktopLayout(page, 'FxTerminal-1280x800');
      await harness.saveScreenshot(page, '1280x800-04-fx-terminal.png');

      // 05 LotteryScratchHall
      await navigateToTab(page, 'lottery');
      await page.getByRole('timer').first().waitFor({ state: 'visible', timeout: 8000 });
      await page.waitForTimeout(300);
      await auditDesktopLayout(page, 'LotteryScratch-1280x800');
      await harness.saveScreenshot(page, '1280x800-05-lottery-scratch.png');

      // 01 AuthGate at 1280x800 (logout, capture, login back)
      await logoutViaUi(page);
      await page.waitForTimeout(250);
      await auditDesktopLayout(page, 'AuthGate-1280x800');
      await harness.saveScreenshot(page, '1280x800-01-authgate.png');
      await loginViaUi(page, username, password);
      await waitForWorkspaceReady(page);

      return '6 deterministic 1280x800 screenshots + 0 layout violations';
    });

    // Scenario 4: Animated DeepSeaCanvas pixel diff over time + depth transition diff
    await harness.check('T4-S4', 'tier4', 'Scenario4:DeepSeaCanvasAnimation', 'Verify animated canvas pixel diff over time and depth palette transition', async () => {
      await page.setViewportSize({ width: 1440, height: 900 });
      await navigateToTab(page, 'fishing');
      await selectDepth(page, 'shore');
      await startFishing(page);

      const canvas = getFishingCanvas(page);
      const frame0 = await sampleCanvasSignature(canvas);
      assert(frame0.nonBgPixels > frame0.totalPixels * 0.05, `Canvas appears blank (nonBg=${frame0.nonBgPixels})`);

      await page.waitForTimeout(500);
      const frame1 = await sampleCanvasSignature(canvas);
      await page.waitForTimeout(500);
      const frame2 = await sampleCanvasSignature(canvas);

      const diff01 = diffCanvasSamples(frame0, frame1);
      const diff02 = diffCanvasSamples(frame0, frame2);
      assert(
        diff01 > 10 && diff02 > 10,
        `Expected meaningful animated pixel changes (> 10) at 500ms & 1000ms, got diff01=${diff01}, diff02=${diff02}`,
      );

      await stopFishing(page);
      const shoreIdle = await sampleCanvasSignature(canvas);
      await selectDepth(page, 'abyss');
      await page.waitForTimeout(300);
      const abyssIdle = await sampleCanvasSignature(canvas);
      const depthDiff = diffCanvasSamples(shoreIdle, abyssIdle);
      assert(depthDiff > 100, `Expected shore -> abyss palette pixel diff > 100, got ${depthDiff}`);

      await selectDepth(page, 'shore');
      return `animDiff=(${diff01}, ${diff02}), shore->abyssDiff=${depthDiff}`;
    });

    // Scenario 5: Interactive FxTerminal chart exploration (symbols, grains, crosshair, zoom/pan)
    await harness.check('T4-S5', 'tier4', 'Scenario5:FxChartInteractive', 'Verify symbol switches, 4 candle grains, keyboard crosshair & zoom/pan controls', async () => {
      await navigateToTab(page, 'fx');
      await page.locator('main table tbody tr').first().waitFor({ state: 'visible', timeout: 10000 });

      for (const symRegex of [/luminous|辉光/i, /prismatic|棱彩/i, /swift|迅游/i]) {
        const candlesP = page.waitForResponse((r) => r.url().includes('/api/fx/candles'), { timeout: 10000 });
        await page.locator('main table button').filter({ hasText: symRegex }).first().click();
        assert((await candlesP).status() === 200, 'Candles request failed on symbol switch');
      }

      for (const grain of ['15m', '30m', '60m', '120m']) {
        const grainValue = grain.replace('m', '');
        const gp = page.waitForResponse(
          (r) => r.url().includes('/api/fx/candles') && r.url().includes(`grain=${grainValue}`),
          { timeout: 10000 },
        );
        await page.getByRole('button', { name: new RegExp(`^${grain}$`) }).first().click();
        assert((await gp).status() === 200, `Candles request failed on grain ${grain}`);
      }

      const surface = getFxChartSurface(page);
      const geom = await verifyFxChartNonBlank(surface);
      const focusable = getFxChartFocusTarget(page);
      if (await focusable.count()) {
        await focusable.focus();
      } else {
        await surface.click();
      }
      const beforeReadout = await getFxChartReadoutText(page);
      await page.keyboard.press('ArrowLeft');
      await page.keyboard.press('ArrowLeft');
      await page.keyboard.press('ArrowLeft');
      const afterReadout = await getFxChartReadoutText(page);
      assert(/开.*高.*低.*收/.test(afterReadout) && /\d/.test(afterReadout), `Invalid OHLCV readout: ${afterReadout}`);
      assert(
        beforeReadout !== afterReadout,
        `Expected ArrowLeft crosshair to change OHLCV readout: "${beforeReadout}" vs "${afterReadout}"`,
      );

      // Exercise optional M3 zoom/pan controls when enabled and assert observable chart/readout change
      let zoomPanTriggered = 0;
      for (const labelRe of [
        /放大|zoom\s*in|\(\+\)|^\+$/i,
        /更早|左移|pan\s*left/i,
        /较新|右移|pan\s*right/i,
        /缩小|zoom\s*out|\(-\)|^[-−]$/i,
      ]) {
        const btn = page.locator('main').getByRole('button', { name: labelRe }).first();
        if ((await btn.count()) > 0 && (await btn.isVisible().catch(() => false)) && !(await btn.isDisabled())) {
          const beforeSig = await getFxChartStateSignature(page, surface);
          await btn.click();
          await page.waitForTimeout(120);
          const afterSig = await getFxChartStateSignature(page, surface);
          const changed =
            beforeSig.readoutText !== afterSig.readoutText ||
            beforeSig.zoomText !== afterSig.zoomText ||
            beforeSig.geomKey !== afterSig.geomKey;
          assert(changed, `FX control ${labelRe} clicked while enabled but produced no observable chart/readout change`);
          zoomPanTriggered += 1;
        }
      }
      if (zoomPanTriggered > 0) {
        const resetBtn = page.locator('main').getByRole('button', { name: /返回最新|重置视图|Reset/i }).first();
        if (
          (await resetBtn.count()) > 0 &&
          (await resetBtn.isVisible().catch(() => false)) &&
          !(await resetBtn.isDisabled())
        ) {
          const beforeSig = await getFxChartStateSignature(page, surface);
          await resetBtn.click();
          await page.waitForTimeout(120);
          const afterSig = await getFxChartStateSignature(page, surface);
          const changed =
            beforeSig.readoutText !== afterSig.readoutText ||
            beforeSig.zoomText !== afterSig.zoomText ||
            beforeSig.geomKey !== afterSig.geomKey;
          if (changed) zoomPanTriggered += 1;
        }
      }

      const verifiedCount = harness.verifyScreenshotsOnDisk(EXPECTED_SCREENSHOTS);

      assert(harness.pageErrors.length === 0, `Page errors in Tier 4: ${JSON.stringify(harness.pageErrors)}`);
      assert(harness.consoleErrors.length === 0, `Console errors in Tier 4: ${JSON.stringify(harness.consoleErrors)}`);
      assert(harness.unexpectedHttpErrors.length === 0, `Unexpected HTTP errors in Tier 4: ${JSON.stringify(harness.unexpectedHttpErrors)}`);

      return `grains=4, geom=${geom.kind}, readoutChanged=true, zoomPanOps=${zoomPanTriggered}, screenshots=${verifiedCount}`;
    });
  } finally {
    await context.close();
  }
}
