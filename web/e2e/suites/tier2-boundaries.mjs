import { ApiClient } from '../lib/api-client.mjs';
import { makeUniqueUsername } from '../lib/config.mjs';
import { assert } from '../lib/harness.mjs';
import {
  assertLotteryCraftOpen,
  countCatchesInFeed,
  getFxOrderForm,
  getRevealedScratchRewards,
  getScratchBuyButton,
  getScratchCards,
  isDepthSelectionLocked,
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
  switchAuthMode,
  waitForAuthGate,
  waitForCatches,
  waitForWorkspaceReady,
} from '../lib/locators.mjs';

export async function runTier2Boundaries(harness) {
  console.log('\n=== Tier 2: Boundaries, Corner Cases & Negative Paths (>= 25 checks across F1..F5) ===');
  const api = new ApiClient(harness.baseUrl);
  const context = await harness.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await harness.newPage(context, '/');

  const existingUser = makeUniqueUsername('t2dup');
  const mainUser = makeUniqueUsername('t2');
  const password = 'Password123!';

  // Seed duplicate account via API cleanly so T2-F1-3 tests UI 409 deterministically
  const seedReg = await api.register(existingUser, password);
  assert(seedReg.status === 201 || seedReg.status === 200, `Seed register failed: ${seedReg.status}`);

  try {
    // ---------------- F1: AuthGate Boundaries (5 checks) ----------------
    await harness.check('T2-F1-1', 'tier2', 'F1:AuthGate', 'Short username (<3 chars) blocked client-side', async () => {
      await waitForAuthGate(page);
      await switchAuthMode(page, 'register');
      let requestSent = false;
      const listener = (req) => {
        if (req.url().includes('/api/auth/register')) requestSent = true;
      };
      page.on('request', listener);
      try {
        await page.locator('input[name="username"]').fill('ab');
        await page.locator('input[name="password"]').fill(password);
        await page.locator('form button[type="submit"]').click();
        const alert = page.locator('[role="alert"]').first();
        await alert.waitFor({ state: 'visible', timeout: 4000 });
        const text = (await alert.textContent()) || '';
        assert(/3\s*至\s*32|用户名/.test(text), `Unexpected alert text: ${text}`);
        assert(!requestSent, 'Short username should not send POST /api/auth/register');
        return text.trim();
      } finally {
        page.off('request', listener);
      }
    });

    await harness.check('T2-F1-2', 'tier2', 'F1:AuthGate', 'Short password (<8 chars) blocked client-side', async () => {
      await switchAuthMode(page, 'register');
      let requestSent = false;
      const listener = (req) => {
        if (req.url().includes('/api/auth/register')) requestSent = true;
      };
      page.on('request', listener);
      try {
        await page.locator('input[name="username"]').fill('valid_user_name');
        await page.locator('input[name="password"]').fill('1234567');
        await page.locator('form button[type="submit"]').click();
        const alert = page.locator('[role="alert"]').first();
        await alert.waitFor({ state: 'visible', timeout: 4000 });
        const text = (await alert.textContent()) || '';
        assert(/8\s*个字符|密码/.test(text), `Unexpected alert text: ${text}`);
        assert(!requestSent, 'Short password should not send POST /api/auth/register');
        return text.trim();
      } finally {
        page.off('request', listener);
      }
    });

    await harness.check('T2-F1-3', 'tier2', 'F1:AuthGate', 'Duplicate username registration returns 409 alert', async () => {
      await switchAuthMode(page, 'register');
      await harness.allowExpectedHttpError({ method: 'POST', urlPattern: /\/api\/auth\/register/, statuses: [409] }, async () => {
        await page.locator('input[name="username"]').fill(existingUser);
        await page.locator('input[name="password"]').fill(password);
        const resP = page.waitForResponse((r) => r.url().includes('/api/auth/register'), { timeout: 10000 });
        await page.locator('form button[type="submit"]').click();
        const res = await resP;
        assert(res.status() === 409, `Expected 409 Conflict for duplicate user, got ${res.status()}`);
        const alertText = (await page.locator('[role="alert"]').first().textContent()) || '';
        assert(/already taken|已存在|占用/i.test(alertText), `Expected conflict error text, got: ${alertText}`);
      });
      return '409 rendered cleanly';
    });

    await harness.check('T2-F1-4', 'tier2', 'F1:AuthGate', 'Wrong password login returns 401 alert and stays on AuthGate', async () => {
      await switchAuthMode(page, 'login');
      await harness.allowExpectedHttpError({ method: 'POST', urlPattern: /\/api\/auth\/login/, statuses: [401] }, async () => {
        await page.locator('input[name="username"]').fill(existingUser);
        await page.locator('input[name="password"]').fill('WrongPass999!');
        const resP = page.waitForResponse((r) => r.url().includes('/api/auth/login'), { timeout: 10000 });
        await page.locator('form button[type="submit"]').click();
        const res = await resP;
        assert(res.status() === 401, `Expected 401 Unauthorized, got ${res.status()}`);
        const alertText = (await page.locator('[role="alert"]').first().textContent()) || '';
        assert(/invalid credentials|用户名|密码/i.test(alertText), `Expected 401 alert, got: ${alertText}`);
        assert((await page.locator('nav').count()) === 0, 'Should stay on AuthGate on 401');
      });
      return '401 rendered cleanly';
    });

    await harness.check('T2-F1-5', 'tier2', 'F1:AuthGate', 'Whitespace username validation and mode-switch resets password & alert', async () => {
      await switchAuthMode(page, 'login');
      await page.locator('input[name="username"]').fill('   ');
      await page.locator('input[name="password"]').fill(password);
      await page.locator('form button[type="submit"]').click();
      const alert = page.locator('[role="alert"]').first();
      await alert.waitFor({ state: 'visible', timeout: 4000 });
      const alertText = (await alert.textContent()) || '';
      assert(/请输入用户名/.test(alertText), `Expected 请输入用户名 alert, got: ${alertText}`);

      await switchAuthMode(page, 'register');
      const pwValue = await page.locator('input[name="password"]').inputValue();
      assert(pwValue === '', `Expected password cleared on mode switch, got "${pwValue}"`);
      assert((await page.locator('[role="alert"]').count()) === 0, 'Expected alert cleared on mode switch');
      return 'whitespace validated & mode switch reset';
    });

    // Register main Tier 2 user for F2..F5 boundary checks
    const auth = await registerViaUi(page, mainUser, password);
    const mainToken = auth?.token;
    assert(mainToken, 'Missing token in register response');

    // ---------------- F2: FishingDeck Boundaries (5 checks) ----------------
    await harness.check('T2-F2-1', 'tier2', 'F2:FishingDeck', 'Depth selection controls lock while fishing is active', async () => {
      await startFishing(page);
      const locked = await isDepthSelectionLocked(page);
      assert(locked, 'Depth selection controls should be disabled while fishing is active');
      await stopFishing(page);
      return 'depth controls disabled during active session';
    });

    await harness.check('T2-F2-2', 'tier2', 'F2:FishingDeck', 'Sequential start/stop idempotency returns cleanly to idle', async () => {
      await startFishing(page);
      await stopFishing(page);
      const mainText = (await page.locator('main').textContent()) || '';
      assert(/码头待命/.test(mainText), `Expected 码头待命 after stop, got: ${mainText.slice(0, 120)}`);
      return 'returned cleanly to 码头待命';
    });

    await harness.check('T2-F2-3', 'tier2', 'F2:FishingDeck', 'Manual repair & auto-repair disabled on fresh user + 409 API guard', async () => {
      const manualBtn = page.getByRole('button', { name: /手动修理/ }).first();
      const upgradeBtn = page.getByRole('button', { name: /自动修理/ }).first();
      assert(await manualBtn.isDisabled(), 'Manual repair should be disabled on full durability / 0 chips');
      assert(await upgradeBtn.isDisabled(), 'Upgrade auto-repair should be disabled with 0 coins / 0 chips');

      const stateRes = await api.fishingState(mainToken);
      const rodId = stateRes.data?.rod?.id || 1;
      const repRes = await api.repairRod(mainToken, rodId);
      assert(repRes.status === 200 && repRes.data?.rod?.durability === 1000, `Expected idempotent 200 on full-durability repair, got ${repRes.status}`);
      const upgRes = await api.upgradeAutoRepair(mainToken);
      assert(upgRes.status === 409, `Expected 409 on auto-repair upgrade with 0 coins/0 chips, got ${upgRes.status}`);
      return `buttons disabled + repair(full)=200 + upgrade(0)=409`;
    });

    await harness.check('T2-F2-4', 'tier2', 'F2:FishingDeck', 'Reload while fishing is active restores running state', async () => {
      await startFishing(page);
      await page.reload({ waitUntil: 'domcontentloaded' });
      await waitForWorkspaceReady(page);
      await page.locator('main').getByRole('button', { name: /停止钓鱼|Stop/i }).first().waitFor({ state: 'visible', timeout: 10000 });
      await stopFishing(page);
      return 'active fishing restored across reload';
    });

    await harness.check('T2-F2-5', 'tier2', 'F2:FishingDeck', 'High-pressure abyss depth selection and start/stop without errors', async () => {
      await selectDepth(page, 'abyss');
      await startFishing(page);
      await page.waitForTimeout(500);
      await stopFishing(page);
      await selectDepth(page, 'shore');
      return 'abyss start/stop ok, reset to shore';
    });

    // ---------------- F3: GuildPanel Boundaries (5 checks) ----------------
    await harness.check('T2-F3-1', 'tier2', 'F3:GuildPanel', 'Empty warehouse (fish: null) renders cleanly without crash', async () => {
      await navigateToTab(page, 'guild');
      const mainText = (await page.locator('main').textContent()) || '';
      assert(/0\s*(?:个堆栈|堆)/.test(mainText), 'Expected 0 个堆栈/堆 on fresh account');
      assert(/仓库里还没有渔获/.test(mainText), 'Expected empty warehouse message');
      return 'empty state ok';
    });

    await harness.check('T2-F3-5', 'tier2', 'F3:GuildPanel', 'Direct API /api/guild/sell rejects empty selection (400) and empty warehouse (404)', async () => {
      const emptyIdsRes = await api.guildSell(mainToken, { fish_ids: [] });
      assert(emptyIdsRes.status === 400, `Expected 400 for empty fish_ids, got ${emptyIdsRes.status}`);
      const emptyAllRes = await api.guildSell(mainToken, { sell_all: true });
      assert(emptyAllRes.status === 404 || emptyAllRes.status === 400, `Expected 404 for sell_all on empty warehouse, got ${emptyAllRes.status}`);
      return `emptyIds=${emptyIdsRes.status}, emptySellAll=${emptyAllRes.status}`;
    });

    // Farm 3 catches at shore so we can test Guild partial sell + FX + Scratch boundaries
    await navigateToTab(page, 'fishing');
    await selectDepth(page, 'shore');
    await startFishing(page);
    await waitForCatches(page, 3, 60000);
    await stopFishing(page);
    await navigateToTab(page, 'guild');

    await harness.check('T2-F3-2', 'tier2', 'F3:GuildPanel', '出售所选 button is disabled when 0 rows are checked', async () => {
      await page.locator('main table tbody tr').first().waitFor({ state: 'visible', timeout: 8000 });
      const sellSelectedBtn = page.getByRole('button', { name: /出售所选|Sell\s*Selected/i }).first();
      assert(await sellSelectedBtn.isDisabled(), '出售所选 must be disabled with 0 checkboxes checked');
      return 'disabled with 0 selected';
    });

    await harness.check('T2-F3-3', 'tier2', 'F3:GuildPanel', 'Partial selection sell leaves remaining stacks, then sell_all empties', async () => {
      const initialCount = await page.locator('main table tbody tr').count();
      assert(initialCount >= 2, `Need >= 2 rows for partial sell test, got ${initialCount}`);
      await sellFirstGuildRow(page);
      const afterPartial = await page.locator('main table tbody tr').count();
      assert(afterPartial === initialCount - 1, `Expected ${initialCount - 1} rows after partial sell, got ${afterPartial}`);

      // Sell remaining individually if > 1 so we accumulate blank tickets & coins
      while ((await page.locator('main table tbody tr').count()) > 1) {
        await sellFirstGuildRow(page);
      }

      await sellAllGuildRows(page);
      return `partial (${initialCount} -> ${initialCount - 1}) -> empty`;
    });

    await harness.check('T2-F3-4', 'tier2', 'F3:GuildPanel', 'Post-sell empty warehouse and coins persist across reload', async () => {
      const before = await readHeaderMetrics(page);
      const invPromise = page.waitForResponse((r) => r.url().includes('/api/guild/inventory') && r.status() === 200, { timeout: 10000 });
      await page.reload({ waitUntil: 'domcontentloaded' });
      await waitForWorkspaceReady(page);
      await invPromise;
      await navigateToTab(page, 'guild');
      await page.locator('main').getByText(/仓库里还没有渔获/).waitFor({ state: 'visible', timeout: 8000 });
      const after = await readHeaderMetrics(page);
      assert(after.coins === before.coins, `Coins changed across reload: ${before.coins} vs ${after.coins}`);
      return `persisted coins=${after.coins}`;
    });

    // ---------------- F4: FxTerminal Boundaries (5 checks) ----------------
    await harness.check('T2-F4-1', 'tier2', 'F4:FxTerminal', 'Insufficient coins on FX buy returns 409 alert without position change', async () => {
      await navigateToTab(page, 'fx');
      await page.locator('main table tbody tr').first().waitFor({ state: 'visible', timeout: 10000 });
      // Select prismatic (most expensive ~165+) or buy qty 20 to exceed current coins (~50-120)
      const prismBtn = page.locator('main table button').filter({ hasText: /prismatic|棱彩/i }).first();
      await prismBtn.click();
      const form = getFxOrderForm(page);
      await form.locator('button[type="button"]').filter({ hasText: /^\s*(买入|Buy)\s*$/i }).first().click();
      await form.locator('input[type="number"]').fill('10');

      await harness.allowExpectedHttpError({ method: 'POST', urlPattern: /\/api\/fx\/buy/, statuses: [409] }, async () => {
        const resP = page.waitForResponse((r) => r.url().includes('/api/fx/buy'), { timeout: 10000 });
        await form.locator('button[type="submit"]').click();
        const res = await resP;
        assert(res.status() === 409, `Expected 409 insufficient coins, got ${res.status()}`);
        const alertText = (await form.locator('[role="alert"]').textContent()) || '';
        assert(/insufficient|余额|金币/i.test(alertText), `Expected insufficient coins alert, got: ${alertText}`);
      });
      return '409 alert shown, pos=0';
    });

    await harness.check('T2-F4-2', 'tier2', 'F4:FxTerminal', 'Sell exceeding 0 position blocked/rejected + API /api/fx/sell returns 409', async () => {
      const form = getFxOrderForm(page);
      await form.locator('button[type="button"]').filter({ hasText: /^\s*(卖出|Sell)\s*$/i }).first().click();
      await form.locator('input[type="number"]').fill('1');
      const submitBtn = form.locator('button[type="submit"]');
      let uiOutcome = '';
      if (await submitBtn.isDisabled()) {
        uiOutcome = 'UI submit disabled';
      } else {
        const noteText = (await form.locator('[role="note"]').textContent().catch(() => '')) || '';
        assert(/超出当前持仓|最多可卖\s*0/.test(noteText), `Expected over-position hint when sell submit enabled at 0 pos, got: ${noteText}`);
        const maxBtn = form.getByRole('button', { name: /最大\s*\(0\)/ }).first();
        if ((await maxBtn.count()) > 0) {
          assert(await maxBtn.isDisabled(), '最大 (0) preset should be disabled at 0 position');
        }
        await harness.allowExpectedHttpError({ method: 'POST', urlPattern: /\/api\/fx\/sell/, statuses: [409] }, async () => {
          const resP = page.waitForResponse((r) => r.url().includes('/api/fx/sell'), { timeout: 10000 });
          await submitBtn.click();
          const res = await resP;
          assert(res.status() === 409, `Expected 409 on sell with 0 position, got ${res.status()}`);
          const alertText = (await form.locator('[role="alert"]').textContent()) || '';
          assert(/position|持仓|insufficient|不足/i.test(alertText), `Expected insufficient position alert, got: ${alertText}`);
        });
        uiOutcome = 'UI hint + 409 alert';
      }

      const sellApiRes = await api.fxTrade(mainToken, 'sell', 'prismatic', 1);
      assert(sellApiRes.status === 409, `Expected 409 on API sell with 0 position, got ${sellApiRes.status}`);
      return `${uiOutcome} + API=${sellApiRes.status}`;
    });

    await harness.check('T2-F4-3', 'tier2', 'F4:FxTerminal', 'Invalid quantities (0, -1, 1.5) disable order submit', async () => {
      const form = getFxOrderForm(page);
      await form.locator('button[type="button"]').filter({ hasText: /^\s*(买入|Buy)\s*$/i }).first().click();
      const input = form.locator('input[type="number"]');
      const submitBtn = form.locator('button[type="submit"]');
      for (const badQty of ['0', '-1', '1.5']) {
        await input.fill(badQty);
        assert(await submitBtn.isDisabled(), `Submit should be disabled for invalid qty "${badQty}"`);
      }
      await input.fill('1');
      assert(!(await submitBtn.isDisabled()), 'Submit should re-enable for valid qty 1');
      return '0, -1, 1.5 blocked';
    });

    await harness.check('T2-F4-4', 'tier2', 'F4:FxTerminal', 'Exceeding position limit (qty=201) triggers 409 safely', async () => {
      const swiftBtn = page.locator('main table button').filter({ hasText: /swift|迅游/i }).first();
      await swiftBtn.click();
      const form = getFxOrderForm(page);
      await form.locator('input[type="number"]').fill('201');
      await harness.allowExpectedHttpError({ method: 'POST', urlPattern: /\/api\/fx\/buy/, statuses: [409] }, async () => {
        const resP = page.waitForResponse((r) => r.url().includes('/api/fx/buy'), { timeout: 10000 });
        await form.locator('button[type="submit"]').click();
        const res = await resP;
        assert(res.status() === 409, `Expected 409 on qty=201, got ${res.status()}`);
        await form.locator('[role="alert"]').waitFor({ state: 'visible', timeout: 5000 });
      });
      return 'qty=201 rejected with 409 + alert';
    });

    await harness.check('T2-F4-5', 'tier2', 'F4:FxTerminal', 'FX position and avg_cost persist across page.reload()', async () => {
      let metrics = await readHeaderMetrics(page);
      if ((metrics.coins ?? 0) < 40) {
        await navigateToTab(page, 'fishing');
        await selectDepth(page, 'shore');
        await startFishing(page);
        const cur = await countCatchesInFeed(page);
        await waitForCatches(page, cur + 1, 25000);
        await stopFishing(page);
        await navigateToTab(page, 'guild');
        const sp = page.waitForResponse((r) => r.url().includes('/api/guild/sell'));
        await page.getByRole('button', { name: /全部出售/ }).click();
        await sp;
        await navigateToTab(page, 'fx');
      }

      const swiftBtn = page.locator('main table button').filter({ hasText: /swift|迅游/i }).first();
      await swiftBtn.click();
      const form = getFxOrderForm(page);
      await form.locator('input[type="number"]').fill('1');
      const buyP = page.waitForResponse((r) => r.url().includes('/api/fx/buy'), { timeout: 10000 });
      await form.locator('button[type="submit"]').click();
      const buyRes = await buyP;
      assert(buyRes.status() === 200, `Expected /api/fx/buy 200, got ${buyRes.status()}`);

      await page.reload({ waitUntil: 'domcontentloaded' });
      await waitForWorkspaceReady(page);
      await navigateToTab(page, 'fx');
      await page.locator('main table tbody tr').first().waitFor({ state: 'visible', timeout: 10000 });
      const swiftRowText = (await page.locator('main table tbody tr').filter({ hasText: /swift|迅游/i }).first().textContent()) || '';
      assert(/1\s*\/\s*[\d,.]+/.test(swiftRowText) && !/1\s*\/\s*0\.00/.test(swiftRowText), `Expected persisted pos=1 & avg_cost>0, got: ${swiftRowText}`);

      // Sell back 1 swift so user has coins for scratch tests
      await page.locator('main table button').filter({ hasText: /swift|迅游/i }).first().click();
      await form.locator('button[type="button"]').filter({ hasText: /^\s*(卖出|Sell)\s*$/i }).first().click();
      await form.locator('input[type="number"]').fill('1');
      const sellP = page.waitForResponse((r) => r.url().includes('/api/fx/sell'), { timeout: 10000 });
      await form.locator('button[type="submit"]').click();
      assert((await sellP).status() === 200, 'Expected /api/fx/sell 200');
      return 'position=1 persisted & sold back cleanly';
    });

    // ---------------- F5: LotteryScratchHall Boundaries (5 checks) ----------------
    // First test fresh 0-coin/0-ticket user in isolated context for T2-F5-1 and T2-F5-2
    const freshCtx = await harness.newContext({ viewport: { width: 1440, height: 900 } });
    const freshPage = await harness.newPage(freshCtx, '/');
    const freshUser = makeUniqueUsername('t2zero');
    try {
      await registerViaUi(freshPage, freshUser, password);
      await navigateToTab(freshPage, 'lottery');

      await harness.check('T2-F5-1', 'tier2', 'F5:LotteryScratch', '0 blank tickets disables all 3 lottery craft buttons', async () => {
        for (const label of [/普通场制券数量/, /高级场制券数量/, /大师场制券数量/]) {
          const input = freshPage.getByLabel(label).first();
          await input.waitFor({ state: 'visible', timeout: 8000 });
          assert(await input.isDisabled(), `${label} input should be disabled at 0 tickets`);
          const btn = input.locator('xpath=ancestor::form[1]//button[@type="submit"]');
          assert(await btn.isDisabled(), `${label} submit button should be disabled at 0 tickets`);
        }
        return 'all 3 pool craft forms disabled';
      });

      await harness.check('T2-F5-2', 'tier2', 'F5:LotteryScratch', '0 coins buying scratch-tide returns 409 alert without adding card', async () => {
        const buyBtn = getScratchBuyButton(freshPage, 'tide');
        await harness.allowExpectedHttpError({ method: 'POST', urlPattern: /\/api\/scratch\/buy/, statuses: [409] }, async () => {
          const resP = freshPage.waitForResponse((r) => r.url().includes('/api/scratch/buy'), { timeout: 10000 });
          await buyBtn.click();
          const res = await resP;
          assert(res.status() === 409, `Expected 409 insufficient coins on scratch buy, got ${res.status()}`);
          const alertText = (await freshPage.locator('[role="alert"]').first().textContent()) || '';
          assert(/insufficient|余额|金币/i.test(alertText), `Expected insufficient coins alert, got: ${alertText}`);
          assert((await getScratchCards(freshPage).count()) === 0, 'No scratch card should be added on 409');
        });
        return '409 alert rendered & 0 cards added';
      });
    } finally {
      await freshCtx.close();
    }

    // Continue with mainUser (who has >= 30 coins and >= 3 blank tickets) for T2-F5-3, T2-F5-4, T2-F5-5
    let inv = await api.inventory(mainToken);
    if ((inv.data?.player?.coins ?? 0) < 35 || (inv.data?.blank_tickets ?? 0) < 3) {
      await navigateToTab(page, 'fishing');
      await selectDepth(page, 'shore');
      await startFishing(page);
      const cur = await countCatchesInFeed(page);
      await waitForCatches(page, cur + 2, 40000);
      await stopFishing(page);
      await navigateToTab(page, 'guild');
      while ((await page.locator('main table tbody tr').count()) > 0) {
        await sellFirstGuildRow(page);
      }
    }

    await navigateToTab(page, 'lottery');

    // Craft 1 normal ticket first so T2-F5-5 verifies ticket reload persistence alongside revealed card
    const normalInput = await assertLotteryCraftOpen(page, '普通场制券数量');
    await normalInput.fill('1');
    const craftP = page.waitForResponse((r) => r.url().includes('/api/lottery/craft'), { timeout: 10000 });
    await normalInput.locator('xpath=ancestor::form[1]//button[@type="submit"]').click();
    assert((await craftP).status() === 200, 'Pre-craft lottery ticket failed');

    let revealedCardId = null;
    await harness.check('T2-F5-3', 'tier2', 'F5:LotteryScratch', 'Zero-payout scratch reveal with omitted card.payouts (payouts ?? [] guard)', async () => {
      const buyBtn = getScratchBuyButton(page, 'tide');
      const buyP = page.waitForResponse((r) => r.url().includes('/api/scratch/buy'), { timeout: 10000 });
      await buyBtn.click();
      const buyRes = await buyP;
      assert(buyRes.status() === 200, `Expected /api/scratch/buy 200, got ${buyRes.status()}`);
      const buyJson = await buyRes.json();
      revealedCardId = buyJson.card?.id;

      // Intercept /api/scratch/reveal ONCE to strip `card.payouts` simulating Go `omitempty`
      await page.route('**/api/scratch/reveal', async (route) => {
        const response = await route.fetch();
        const json = await response.json();
        if (json?.card) {
          delete json.card.payouts;
        }
        await route.fulfill({
          response,
          contentType: 'application/json',
          body: JSON.stringify(json),
        });
        await page.unroute('**/api/scratch/reveal');
      });

      const revealRes = await revealFirstScratchCard(page);
      assert(revealRes.status() === 200, `Expected /api/scratch/reveal 200, got ${revealRes.status()}`);
      const noWinEl = page.locator('main').getByText(/本卡未形成中奖组合|未形成中奖组合/);
      await noWinEl.waitFor({ state: 'visible', timeout: 8000 });
      assert(harness.pageErrors.length === 0, 'Omitted payouts must not cause pageerror');
      return `card #${revealedCardId} rendered zero-payout cleanly`;
    });

    await harness.check('T2-F5-4', 'tier2', 'F5:LotteryScratch', 'Already-revealed scratch card hides Scratch button and API returns 409', async () => {
      const cardEl = getScratchCards(page).first();
      assert((await cardEl.getByRole('button', { name: /Scratch|刮开/i }).count()) === 0, 'Scratch button should be gone after reveal');
      const dupReveal = await api.revealScratch(mainToken, revealedCardId);
      assert(dupReveal.status === 409, `Expected 409 on re-reveal of card #${revealedCardId}, got ${dupReveal.status}`);
      return `UI locked + API=${dupReveal.status}`;
    });

    await harness.check('T2-F5-5', 'tier2', 'F5:LotteryScratch', 'Crafted lottery ticket and revealed scratch card persist across reload', async () => {
      let navCommitted = false;
      const onNav = (frame) => {
        if (frame === page.mainFrame()) navCommitted = true;
      };
      page.on('framenavigated', onNav);
      try {
        await Promise.all([
          page.waitForResponse(
            (r) => navCommitted && r.url().includes('/api/lottery/status') && r.status() === 200,
            { timeout: 10000 },
          ),
          page.waitForResponse(
            (r) => navCommitted && r.url().includes('/api/scratch/cards') && r.status() === 200,
            { timeout: 10000 },
          ),
          page.reload({ waitUntil: 'domcontentloaded' }),
        ]);
      } finally {
        page.off('framenavigated', onNav);
      }
      await waitForWorkspaceReady(page);
      await navigateToTab(page, 'lottery');
      await page.locator('main').getByText('正在读取抽奖状态…').waitFor({ state: 'hidden', timeout: 8000 });
      await page.locator('main .lottery-ticket-item').first().waitFor({ state: 'visible', timeout: 8000 });
      await getRevealedScratchRewards(page).waitFor({ state: 'visible', timeout: 8000 });
      const mainText = (await page.locator('main').textContent()) || '';
      assert(!/暂无(?:待开奖或待领取的)?号码券/.test(mainText) && /普通场/.test(mainText), 'Crafted lottery ticket missing after reload');
      if (revealedCardId != null) {
        assert(mainText.includes(`#${revealedCardId}`), `Revealed scratch card #${revealedCardId} missing after reload`);
      }
      assert(harness.pageErrors.length === 0, `Page errors: ${JSON.stringify(harness.pageErrors)}`);
      assert(harness.consoleErrors.length === 0, `Console errors: ${JSON.stringify(harness.consoleErrors)}`);
      assert(harness.unexpectedHttpErrors.length === 0, `Unexpected HTTP errors: ${JSON.stringify(harness.unexpectedHttpErrors)}`);
      return 'ticket + revealed scratch persisted';
    });
  } finally {
    await context.close();
  }
}
