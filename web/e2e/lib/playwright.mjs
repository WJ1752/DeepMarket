import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

function findNpxPlaywrightCandidates() {
  const cacheRoots = [];
  if (process.env.npm_config_cache) cacheRoots.push(process.env.npm_config_cache);
  if (process.env.LOCALAPPDATA) cacheRoots.push(path.join(process.env.LOCALAPPDATA, 'npm-cache'));
  cacheRoots.push('F:\\DS数据\\_caches\\npm');

  const seenRoots = new Set();
  const candidates = [];

  for (const root of cacheRoots) {
    if (!root) continue;
    const resolvedRoot = path.resolve(root);
    if (seenRoots.has(resolvedRoot)) continue;
    seenRoots.add(resolvedRoot);

    const npxDir = path.join(resolvedRoot, '_npx');
    if (!fs.existsSync(npxDir)) continue;

    let entries = [];
    try {
      entries = fs.readdirSync(npxDir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      for (const pkgName of ['playwright', 'playwright-core']) {
        const pkgDir = path.join(npxDir, entry.name, 'node_modules', pkgName);
        const pkgJsonPath = path.join(pkgDir, 'package.json');
        if (fs.existsSync(pkgJsonPath)) {
          try {
            const stat = fs.statSync(pkgJsonPath);
            candidates.push({
              pkgName,
              pkgDir,
              priority: pkgName === 'playwright' ? 0 : 1,
              mtimeMs: stat.mtimeMs,
            });
          } catch {
            // ignore unreadable cache entry
          }
        }
      }
    }
  }

  candidates.sort((a, b) => a.priority - b.priority || b.mtimeMs - a.mtimeMs);
  return candidates.map((c) => c.pkgDir);
}

export function loadPlaywright() {
  const attempts = [];

  if (process.env.PLAYWRIGHT_MODULE_PATH) {
    attempts.push(process.env.PLAYWRIGHT_MODULE_PATH);
  }

  for (const spec of ['playwright', 'playwright-core']) {
    try {
      const resolved = require.resolve(spec);
      attempts.push(resolved);
    } catch {
      // not in standard node_modules resolution
    }
  }

  for (const dir of findNpxPlaywrightCandidates()) {
    attempts.push(dir);
  }

  const errors = [];
  for (const candidate of attempts) {
    try {
      const mod = require(candidate);
      if (mod && mod.chromium) {
        return { playwright: mod, resolvedFrom: candidate };
      }
    } catch (err) {
      errors.push(`${candidate}: ${err.message}`);
    }
  }

  throw new Error(
    `Unable to locate Playwright module (checked PLAYWRIGHT_MODULE_PATH, require.resolve, and _npx caches). Attempts: ${errors.join(' | ')}`,
  );
}

function getEdgeExecutableCandidates() {
  const list = [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ];
  if (process.env.LOCALAPPDATA) {
    list.push(path.join(process.env.LOCALAPPDATA, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
  }
  return list.filter((p) => fs.existsSync(p));
}

export async function launchBrowser(playwright, { headed = false } = {}) {
  const headless = !headed;
  const attempts = [];

  if (process.env.E2E_BROWSER_EXECUTABLE) {
    attempts.push({
      label: `executablePath=${process.env.E2E_BROWSER_EXECUTABLE}`,
      options: { headless, executablePath: process.env.E2E_BROWSER_EXECUTABLE },
    });
  } else if (process.env.E2E_BROWSER_CHANNEL) {
    attempts.push({
      label: `channel=${process.env.E2E_BROWSER_CHANNEL}`,
      options: { headless, channel: process.env.E2E_BROWSER_CHANNEL },
    });
  } else {
    attempts.push({ label: 'default-chromium', options: { headless } });
    attempts.push({ label: 'channel=msedge', options: { headless, channel: 'msedge' } });
    for (const exe of getEdgeExecutableCandidates()) {
      attempts.push({ label: `executablePath=${exe}`, options: { headless, executablePath: exe } });
    }
  }

  const failures = [];
  for (const attempt of attempts) {
    try {
      const browser = await playwright.chromium.launch(attempt.options);
      const version = browser.version();
      return { browser, launchStrategy: attempt.label, browserVersion: version };
    } catch (err) {
      failures.push(`${attempt.label}: ${err.message.split('\n')[0]}`);
    }
  }

  throw new Error(`Failed to launch any Chromium/Edge browser:\n${failures.join('\n')}`);
}
