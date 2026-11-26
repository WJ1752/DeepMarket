import fs from 'node:fs';
import path from 'node:path';

export class TestHarness {
  constructor({ baseUrl, browser, screenshotDir }) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.browser = browser;
    this.screenshotDir = screenshotDir;
    this.checks = [];
    this.screenshots = [];
    this.pageErrors = [];
    this.consoleErrors = [];
    this.unexpectedHttpErrors = [];
    this.allowedHttpRules = [];
    this.recentlyAllowedConsoleStatuses = [];
    this._ruleSeq = 0;
  }

  async newContext(options = {}) {
    const context = await this.browser.newContext({
      viewport: options.viewport ?? { width: 1440, height: 900 },
      deviceScaleFactor: options.deviceScaleFactor ?? 1,
      ...options,
    });
    context.on('page', (page) => this.attachPageGuards(page));
    return context;
  }

  async newPage(context, urlPath = '/') {
    const page = await context.newPage();
    this.attachPageGuards(page);
    if (urlPath !== null) {
      await page.goto(`${this.baseUrl}${urlPath}`, { waitUntil: 'domcontentloaded' });
    }
    return page;
  }

  attachPageGuards(page) {
    if (page.__deepmarketGuarded) return;
    page.__deepmarketGuarded = true;

    page.on('pageerror', (err) => {
      this.pageErrors.push({
        message: err?.message || String(err),
        stack: err?.stack || '',
        url: page.url(),
        ts: new Date().toISOString(),
      });
    });

    page.on('response', (res) => {
      const status = res.status();
      if (status < 400) return;

      const url = res.url();
      const method = res.request().method();
      const isAllowed = this._isAllowedHttpError(method, url, status);
      if (isAllowed) {
        this.recentlyAllowedConsoleStatuses.push({
          status,
          expiresAt: Date.now() + 4000,
        });
        return;
      }

      // Ignore favicon 404 if browser requests it, though DeepMarket shouldn't emit 4xx/5xx
      this.unexpectedHttpErrors.push({
        method,
        url,
        status,
        ts: new Date().toISOString(),
      });
    });

    page.on('console', (msg) => {
      if (msg.type() !== 'error') return;
      const text = msg.text();
      if (this._isExpectedResourceConsoleError(text)) {
        return;
      }
      this.consoleErrors.push({
        text,
        url: page.url(),
        ts: new Date().toISOString(),
      });
    });
  }

  _isAllowedHttpError(method, url, status) {
    for (const rule of this.allowedHttpRules) {
      if (rule.method && rule.method !== method) continue;
      if (rule.statuses && !rule.statuses.includes(status)) continue;
      if (rule.urlPattern && !rule.urlPattern.test(url)) continue;
      return true;
    }
    return false;
  }

  _isExpectedResourceConsoleError(text) {
    const now = Date.now();
    this.recentlyAllowedConsoleStatuses = this.recentlyAllowedConsoleStatuses.filter((e) => e.expiresAt > now);
    const match = text.match(/responded with a status of (\d{3})/);
    if (!match) return false;
    const status = Number(match[1]);
    const idx = this.recentlyAllowedConsoleStatuses.findIndex((e) => e.status === status);
    if (idx >= 0) {
      this.recentlyAllowedConsoleStatuses.splice(idx, 1);
      return true;
    }
    // Also allow if an active rule covers that status right now
    return this.allowedHttpRules.some((r) => !r.statuses || r.statuses.includes(status));
  }

  async allowExpectedHttpError(rule, fn) {
    const id = ++this._ruleSeq;
    const entry = { id, ...rule };
    this.allowedHttpRules.push(entry);
    try {
      return await fn();
    } finally {
      this.allowedHttpRules = this.allowedHttpRules.filter((r) => r.id !== id);
    }
  }

  async check(id, tier, feature, title, fn) {
    const started = performance.now();
    try {
      const detail = await fn();
      const durationMs = Math.round(performance.now() - started);
      this.checks.push({
        id,
        tier,
        feature,
        title,
        passed: true,
        durationMs,
        detail: detail ? String(detail) : '',
      });
      console.log(`  [PASS] ${id} (${feature}) - ${title} (${durationMs}ms)${detail ? ` :: ${detail}` : ''}`);
      return true;
    } catch (err) {
      const durationMs = Math.round(performance.now() - started);
      const message = err?.message || String(err);
      this.checks.push({
        id,
        tier,
        feature,
        title,
        passed: false,
        durationMs,
        error: message,
      });
      console.error(`  [FAIL] ${id} (${feature}) - ${title} (${durationMs}ms)\n         ${message}`);
      throw err;
    }
  }

  async softCheck(id, tier, feature, title, fn) {
    const started = performance.now();
    try {
      const detail = await fn();
      const durationMs = Math.round(performance.now() - started);
      this.checks.push({
        id,
        tier,
        feature,
        title,
        passed: true,
        durationMs,
        detail: detail ? String(detail) : '',
      });
      console.log(`  [PASS] ${id} (${feature}) - ${title} (${durationMs}ms)${detail ? ` :: ${detail}` : ''}`);
      return true;
    } catch (err) {
      const durationMs = Math.round(performance.now() - started);
      const message = err?.message || String(err);
      this.checks.push({
        id,
        tier,
        feature,
        title,
        passed: false,
        durationMs,
        error: message,
      });
      console.error(`  [FAIL] ${id} (${feature}) - ${title} (${durationMs}ms)\n         ${message}`);
      return false;
    }
  }

  async saveScreenshot(page, filename, { fullPage = true } = {}) {
    if (this.screenshots.some((s) => s.filename === filename)) {
      throw new Error(`Duplicate screenshot filename "${filename}" would overwrite an earlier capture`);
    }
    fs.mkdirSync(this.screenshotDir, { recursive: true });
    const outPath = path.join(this.screenshotDir, filename);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: outPath, fullPage, animations: 'allow' });
    if (!fs.existsSync(outPath)) {
      throw new Error(`Screenshot ${outPath} did not exist on disk after page.screenshot()`);
    }
    const stat = fs.statSync(outPath);
    if (!stat.isFile() || stat.size < 1024) {
      throw new Error(`Screenshot ${outPath} is empty or too small (${stat.size} bytes)`);
    }
    const fd = fs.openSync(outPath, 'r');
    try {
      const header = Buffer.alloc(8);
      fs.readSync(fd, header, 0, 8, 0);
      const pngMagic = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      if (!header.equals(pngMagic)) {
        throw new Error(`Screenshot ${outPath} is not a valid PNG file`);
      }
    } finally {
      fs.closeSync(fd);
    }
    this.screenshots.push({ filename, path: outPath, bytes: stat.size });
    return outPath;
  }

  verifyScreenshotsOnDisk(expectedFilenames = []) {
    const missing = [];
    for (const expected of expectedFilenames) {
      if (!this.screenshots.some((s) => s.filename === expected)) {
        missing.push(`${expected} (not recorded)`);
      }
    }
    for (const shot of this.screenshots) {
      if (!fs.existsSync(shot.path)) {
        missing.push(`${shot.filename} (missing at ${shot.path})`);
        continue;
      }
      const stat = fs.statSync(shot.path);
      if (!stat.isFile() || stat.size <= 0) {
        missing.push(`${shot.filename} (invalid size=${stat.size})`);
      }
    }
    if (missing.length > 0) {
      throw new Error(`Screenshot disk verification failed: ${missing.join(', ')}`);
    }
    return this.screenshots.length;
  }

  summary() {
    const failedChecks = this.checks.filter((c) => !c.passed);
    const byTier = {};
    for (const c of this.checks) {
      if (!byTier[c.tier]) byTier[c.tier] = { total: 0, passed: 0, failed: 0 };
      byTier[c.tier].total += 1;
      if (c.passed) byTier[c.tier].passed += 1;
      else byTier[c.tier].failed += 1;
    }

    const runtimeOk =
      this.pageErrors.length === 0 &&
      this.consoleErrors.length === 0 &&
      this.unexpectedHttpErrors.length === 0;

    return {
      ok: failedChecks.length === 0 && runtimeOk,
      totalChecks: this.checks.length,
      passedChecks: this.checks.length - failedChecks.length,
      failedChecks: failedChecks.length,
      byTier,
      pageErrors: this.pageErrors,
      consoleErrors: this.consoleErrors,
      unexpectedHttpErrors: this.unexpectedHttpErrors,
      screenshots: this.screenshots,
      checks: this.checks,
    };
  }
}

export function assert(condition, message) {
  if (!condition) {
    throw new Error(message || 'Assertion failed');
  }
}
