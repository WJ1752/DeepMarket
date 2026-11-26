import { makeUniqueUsername } from '../lib/config.mjs';
import { assert } from '../lib/harness.mjs';
import {
  ALL_FX_TRAITS_REGEX,
  FX_TRAITS,
  TAB_REGEX,
  assertLotteryCraftOpen,
  countCatchesInFeed,
  getRevealedScratchRewards,
  getScratchBuyButton,
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
  waitForCatches,
  waitForWorkspaceReady,
} from '../lib/locators.mjs';

export async function runTier3E2eFlows(harness) {
  console.log('\n=== Tier 3: Full Cross-Feature Economy Loop & Multi-Tab SSE Sync ===');
  const context = await harness.newContext({ viewport: { width: 1440, height: 900 } });
  const page1 = await harness.newPage(context, '/');
  const username = makeUniqueUsername('t3');
  const password = 'Password123!';

  try {
    await harness.check('T3-1', 'tier3', 'Flow:Auth->Fishing', 'Register fresh user and farm >= 3 catches at shore', async () => {
      await registerViaUi(page1, username, password);
      const initial = await readHeaderMetrics(page1);
      assert(initial.coins === 0 && initial.blankTickets === 0, `Expected 0 coins/tickets, got ${JSON.stringify(initial)}`);

      await selectDepth(page1, 'shore');
      await startFishing(page1);
      await waitForCatches(page1, 3, 60000);
      await stopFishing(page1);

      const durText = await page1.getByRole('meter', { name: /耐久|Durability/i }).first().getAttribute('aria-valuetext');
      return `3 catches complete, durability=${durText}`;
    });

    await harness.check('T3-2', 'tier3', 'Flow:Fishing->Guild', 'Sell 3 stacks separately to earn coins and >= 3 blank tickets', async () => {
      await navigateToTab(page1, 'guild');
      await page1.locator('main table tbody tr').first().waitFor({ state: 'visible', timeout: 8000 });
      const stackCount = await page1.locator('main table tbody tr').count();
      assert(stackCount >= 3, `Expected >= 3 fish stacks, got ${stackCount}`);

      // Sell stack #1 via checkbox
      await sellFirstGuildRow(page1);

      // Sell stack #2 via checkbox
      await sellFirstGuildRow(page1);

      // Sell remaining via 全部出售
      await sellAllGuildRows(page1);

      // Ensure >= 65 coins for FX + Scratch seamlessly
      let metrics = await readHeaderMetrics(page1);
      if ((metrics.coins ?? 0) < 65) {
        await navigateToTab(page1, 'fishing');
        await startFishing(page1);
        const cur = await countCatchesInFeed(page1);
        await waitForCatches(page1, cur + 1, 25000);
        await stopFishing(page1);
        await navigateToTab(page1, 'guild');
        const extraSellP = page1.waitForResponse((r) => r.url().includes('/api/guild/sell'), { timeout: 10000 });
        await page1.getByRole('button', { name: /全部出售|Sell\s*All/i }).click();
        await extraSellP;
        metrics = await readHeaderMetrics(page1);
      }

      assert((metrics.blankTickets ?? 0) >= 3, `Expected >= 3 blank tickets, got ${metrics.blankTickets}`);
      assert((metrics.coins ?? 0) >= 40, `Expected >= 40 coins, got ${metrics.coins}`);

      // Adaptive M3 check: if receipt has clickable FX deep-link (any of 8 traits), click it and assert FxTerminal + symbol active
      const receiptLink = page1
        .locator('main [role="status"] button, main [role="status"] a')
        .filter({ hasText: ALL_FX_TRAITS_REGEX })
        .first();
      let deepLinked = null;
      if ((await receiptLink.count()) > 0 && (await receiptLink.isVisible().catch(() => false))) {
        const linkText = (await receiptLink.textContent()) || '';
        const matchedTrait = FX_TRAITS.find((t) => t.regex.test(linkText));
        await receiptLink.click();
        await page1.waitForFunction(
          ({ pattern }) => {
            const re = new RegExp(pattern, 'i');
            const buttons = [...document.querySelectorAll('nav button')];
            const active = buttons.find((b) => re.test(b.textContent || ''));
            return active?.getAttribute('aria-current') === 'page';
          },
          { pattern: TAB_REGEX.fx.source },
          { timeout: 5000 },
        );
        if (matchedTrait) {
          const symBtn = page1.locator('main table button').filter({ hasText: matchedTrait.regex }).first();
          await symBtn.waitFor({ state: 'visible', timeout: 8000 });
          assert(
            (await symBtn.getAttribute('aria-pressed')) === 'true',
            `Deep-link click should activate ${matchedTrait.id} in FxTerminal`,
          );
          deepLinked = matchedTrait.id;
        }
      } else {
        await navigateToTab(page1, 'fx');
      }
      return `coins=${metrics.coins}, blankTickets=${metrics.blankTickets}${deepLinked ? `, deepLink=${deepLinked}` : ''}`;
    });

    await harness.check('T3-3', 'tier3', 'Flow:Guild->FX', 'Buy and sell swift on DeepSea FX with wallet & position sync', async () => {
      await page1.locator('main table tbody tr').first().waitFor({ state: 'visible', timeout: 10000 });
      await page1.locator('main table button').filter({ hasText: /swift|迅游/i }).first().click();

      const beforeBuy = await readHeaderMetrics(page1);
      const buyRes = await submitFxOrder(page1, 'buy', 1);
      assert(buyRes.status() === 200, `FX buy failed: ${buyRes.status()}`);
      await page1.waitForFunction(
        (prev) => {
          const m = (document.querySelector('header')?.textContent || '').match(/([\d,]+)\s*金币/);
          return m && Number(m[1].replace(/,/g, '')) < prev;
        },
        beforeBuy.coins ?? 999999,
        { timeout: 8000 },
      );
      const afterBuy = await readHeaderMetrics(page1);

      const sellRes = await submitFxOrder(page1, 'sell', 1);
      assert(sellRes.status() === 200, `FX sell failed: ${sellRes.status()}`);
      await page1.waitForFunction(
        (prev) => {
          const m = (document.querySelector('header')?.textContent || '').match(/([\d,]+)\s*金币/);
          return m && Number(m[1].replace(/,/g, '')) > prev;
        },
        afterBuy.coins ?? 0,
        { timeout: 8000 },
      );
      const afterSell = await readHeaderMetrics(page1);
      return `coins ${beforeBuy.coins} -> ${afterBuy.coins} -> ${afterSell.coins}`;
    });

    await harness.check('T3-4', 'tier3', 'Flow:FX->LotteryScratch+MultiTabSSE', 'Craft lottery, buy/reveal scratch on Tab 1, verify SSE sync on Tab 2', async () => {
      await navigateToTab(page1, 'lottery');

      // Open Tab 2 in the same BrowserContext sharing localStorage session
      const page2 = await harness.newPage(context, '/');
      await waitForWorkspaceReady(page2);
      await navigateToTab(page2, 'lottery');

      // Tab 1: Craft 1 normal lottery ticket
      const craftInput = await assertLotteryCraftOpen(page1, '普通场制券数量');
      await craftInput.fill('1');
      const craftP = page1.waitForResponse((r) => r.url().includes('/api/lottery/craft'), { timeout: 10000 });
      await craftInput.locator('xpath=ancestor::form[1]//button[@type="submit"]').click();
      assert((await craftP).status() === 200, 'Lottery craft failed');

      // Tab 1: Buy 1 scratch-tide & reveal it (emits scratch_revealed SSE)
      const buyBtn = getScratchBuyButton(page1, 'tide');
      const buyP = page1.waitForResponse((r) => r.url().includes('/api/scratch/buy'), { timeout: 10000 });
      await buyBtn.click();
      assert((await buyP).status() === 200, 'Scratch buy failed');

      const revealRes = await revealFirstScratchCard(page1);
      assert(revealRes.status() === 200, 'Scratch reveal failed');
      await getRevealedScratchRewards(page1).waitFor({ state: 'visible', timeout: 8000 });
      const tab1Metrics = await readHeaderMetrics(page1);

      // Multi-tab assertion on Tab 2 WITHOUT page.reload()
      await getRevealedScratchRewards(page2).waitFor({ state: 'visible', timeout: 15000 });
      await page2.waitForFunction(
        (targetCoins) => {
          const text = document.querySelector('header')?.textContent || '';
          const m = text.match(/([\d,]+)\s*金币/);
          return m && Number(m[1].replace(/,/g, '')) === targetCoins;
        },
        tab1Metrics.coins ?? 0,
        { timeout: 10000 },
      );

      // Also verify multi-tab fishing_started / fishing_stopped SSE sync
      await navigateToTab(page1, 'fishing');
      await navigateToTab(page2, 'fishing');
      await startFishing(page1);
      await page2.locator('main').getByRole('button', { name: /停止钓鱼|Stop/i }).first().waitFor({ state: 'visible', timeout: 12000 });
      await stopFishing(page1);
      await page2.locator('main').getByRole('button', { name: /开始钓鱼|Start/i }).first().waitFor({ state: 'visible', timeout: 12000 });

      await page2.close();
      return `multi-tab SSE synced coins=${tab1Metrics.coins}, revealed card + fishing state`;
    });
  } finally {
    await context.close();
  }
}
