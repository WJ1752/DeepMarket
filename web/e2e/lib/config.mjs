import os from 'node:os';
import path from 'node:path';

const VALID_TIERS = new Set(['1', '2', '3', '4', '5', '1-5', 'all']);

export function parseCliConfig(argv = process.argv.slice(2)) {
  let baseUrl = process.env.E2E_BASE_URL || 'http://127.0.0.1:18080';
  let tier = 'all';
  let screenshotDir = process.env.E2E_SCREENSHOT_DIR || path.join(os.tmpdir(), 'deepmarket-e2e-screenshots');
  let jsonReport = null;
  let headed = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--headed') {
      headed = true;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      printUsageAndExit(0);
    }
    const next = argv[i + 1];
    if (arg === '--base-url') {
      if (!next) throw new Error('--base-url requires a value');
      baseUrl = next;
      i += 1;
    } else if (arg.startsWith('--base-url=')) {
      baseUrl = arg.slice('--base-url='.length);
    } else if (arg === '--tier') {
      if (!next) throw new Error('--tier requires a value (1|2|3|4|5|1-5|all)');
      tier = next.toLowerCase();
      i += 1;
    } else if (arg.startsWith('--tier=')) {
      tier = arg.slice('--tier='.length).toLowerCase();
    } else if (arg === '--screenshot-dir') {
      if (!next) throw new Error('--screenshot-dir requires a directory path');
      screenshotDir = next;
      i += 1;
    } else if (arg.startsWith('--screenshot-dir=')) {
      screenshotDir = arg.slice('--screenshot-dir='.length);
    } else if (arg === '--json-report') {
      if (!next) throw new Error('--json-report requires a file path');
      jsonReport = next;
      i += 1;
    } else if (arg.startsWith('--json-report=')) {
      jsonReport = arg.slice('--json-report='.length);
    } else {
      throw new Error(`Unknown CLI argument: ${arg}`);
    }
  }

  if (!VALID_TIERS.has(tier)) {
    throw new Error(`Invalid --tier "${tier}". Expected one of: 1, 2, 3, 4, 5, 1-5, all`);
  }

  baseUrl = baseUrl.replace(/\/+$/, '');
  const resolvedScreenshotDir = path.resolve(screenshotDir);
  const normalizedShot = resolvedScreenshotDir.toLowerCase();
  if (
    normalizedShot.includes(`${path.sep}web${path.sep}src`) ||
    normalizedShot.includes(`${path.sep}web${path.sep}dist`)
  ) {
    throw new Error(`--screenshot-dir must NOT point inside web/src or web/dist: ${resolvedScreenshotDir}`);
  }

  return {
    baseUrl,
    tier,
    screenshotDir: resolvedScreenshotDir,
    jsonReport: jsonReport ? path.resolve(jsonReport) : null,
    headed,
  };
}

function printUsageAndExit(code) {
  console.log(
    [
      'Usage: node F:\\FISHMarket\\web\\e2e\\run.mjs [options]',
      '  --base-url <url>          Target server URL (default: http://127.0.0.1:18080)',
      '  --tier <1|2|3|4|5|1-5|all> Tier to run (default: all -> Tiers 1-4)',
      '  --screenshot-dir <dir>    Output directory for Tier 4 PNG screenshots',
      '  --json-report <path>      Write structured JSON summary report',
      '  --headed                  Run browser in headed mode',
    ].join('\n'),
  );
  process.exit(code);
}

export function makeUniqueUsername(tag = 'e2e') {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 7);
  return `e2e_${tag}_${ts}_${rand}`.slice(0, 30);
}
