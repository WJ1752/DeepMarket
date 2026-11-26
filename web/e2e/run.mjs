import fs from 'node:fs';
import path from 'node:path';
import { ApiClient } from './lib/api-client.mjs';
import { parseCliConfig } from './lib/config.mjs';
import { TestHarness } from './lib/harness.mjs';
import { launchBrowser, loadPlaywright } from './lib/playwright.mjs';
import { runTier1Smoke } from './suites/tier1-smoke.mjs';
import { runTier2Boundaries } from './suites/tier2-boundaries.mjs';
import { runTier3E2eFlows } from './suites/tier3-e2e-flows.mjs';
import { runTier4VisualDesktop } from './suites/tier4-visual-desktop.mjs';
import { runTier5Adversarial } from './suites/tier5-adversarial.mjs';

async function main() {
  const startedAt = new Date().toISOString();
  const config = parseCliConfig();

  console.log(`DeepMarket Opaque-Box E2E Runner`);
  console.log(`  Base URL       : ${config.baseUrl}`);
  console.log(`  Tier           : ${config.tier}`);
  console.log(`  Screenshot Dir : ${config.screenshotDir}`);
  if (config.jsonReport) {
    console.log(`  JSON Report    : ${config.jsonReport}`);
  }

  // Verify live backend /healthz first
  const api = new ApiClient(config.baseUrl);
  const health = await api.healthz();
  if (!health.ok) {
    throw new Error(`Backend /healthz failed at ${config.baseUrl}/healthz (status=${health.status}, body=${health.rawText})`);
  }
  console.log(`  Backend Health : 200 OK`);

  const { playwright, resolvedFrom } = loadPlaywright();
  console.log(`  Playwright     : ${resolvedFrom}`);

  const { browser, launchStrategy, browserVersion } = await launchBrowser(playwright, {
    headed: config.headed,
  });
  console.log(`  Browser        : ${launchStrategy} (${browserVersion})`);

  const harness = new TestHarness({
    baseUrl: config.baseUrl,
    browser,
    screenshotDir: config.screenshotDir,
  });

  let executionError = null;
  const runTier = (t) => config.tier === '1-5' || (config.tier === 'all' && t !== '5') || config.tier === t;
  try {
    if (runTier('1')) await runTier1Smoke(harness);
    if (runTier('2')) await runTier2Boundaries(harness);
    if (runTier('3')) await runTier3E2eFlows(harness);
    if (runTier('4')) await runTier4VisualDesktop(harness);
    if (runTier('4')) harness.verifyScreenshotsOnDisk();
    if (runTier('5')) await runTier5Adversarial(harness);
  } catch (err) {
    executionError = err;
  } finally {
    await browser.close();
  }

  const summary = harness.summary();
  const report = {
    startedAt,
    finishedAt: new Date().toISOString(),
    config,
    runtime: { resolvedFrom, launchStrategy, browserVersion },
    executionError: executionError ? executionError.message : null,
    ...summary,
  };

  if (config.jsonReport) {
    fs.mkdirSync(path.dirname(config.jsonReport), { recursive: true });
    fs.writeFileSync(config.jsonReport, JSON.stringify(report, null, 2), 'utf8');
  }

  console.log('\n=== E2E Execution Summary ===');
  for (const [tierName, stats] of Object.entries(summary.byTier)) {
    console.log(`  ${tierName.padEnd(8)}: ${stats.passed}/${stats.total} passed (${stats.failed} failed)`);
  }
  console.log(`  Total Checks         : ${summary.passedChecks}/${summary.totalChecks}`);
  console.log(`  Page Errors          : ${summary.pageErrors.length}`);
  console.log(`  Console Errors       : ${summary.consoleErrors.length}`);
  console.log(`  Unexpected HTTP >=400: ${summary.unexpectedHttpErrors.length}`);
  console.log(`  Screenshots Saved    : ${summary.screenshots.length}`);

  if (summary.pageErrors.length) console.error('Page Errors:', summary.pageErrors);
  if (summary.consoleErrors.length) console.error('Console Errors:', summary.consoleErrors);
  if (summary.unexpectedHttpErrors.length) console.error('Unexpected HTTP Errors:', summary.unexpectedHttpErrors);

  if (executionError || !summary.ok) {
    if (executionError) console.error(`\nExecution aborted: ${executionError.stack || executionError.message}`);
    process.exit(1);
  }

  console.log('\nALL SELECTED E2E TIERS PASSED.');
}

main().catch((err) => {
  console.error(err?.stack || err?.message || err);
  process.exit(1);
});
