# DeepMarket Opaque-Box E2E Suite (`F:\FISHMarket\web\e2e`)

Self-contained Playwright E2E and desktop layout/screenshot verification suite targeting the live Go backend (`http://127.0.0.1:18080`) serving `F:\FISHMarket\web\dist`.

## Design & Isolation
- Completely decoupled from `F:\FISHMarket\web\src\`, `package.json`, `tsconfig.json`, and `dist/`.
- **Zero-install Playwright resolution** (`lib/playwright.mjs`): resolves `playwright` or `playwright-core` via `PLAYWRIGHT_MODULE_PATH`, `require.resolve`, or cached `_npx` installs (`npm_config_cache`, `%LOCALAPPDATA%\npm-cache`, `F:\DS数据\_caches\npm`).
- **Browser launch resilience**: honors `E2E_BROWSER_EXECUTABLE` / `E2E_BROWSER_CHANNEL`, tries default `chromium`, and automatically falls back to `channel: 'msedge'` (or Edge executable paths) on Windows hosts where Playwright Chromium revisions are absent or unstable.
- **Unique live-DB test accounts**: registers timestamped `e2e_<tier>_<ts>_<rand>` users per run; never mutates existing player accounts.

## Usage
```powershell
node F:\FISHMarket\web\e2e\run.mjs --base-url http://127.0.0.1:18080 --tier all
```

### CLI Options
- `--base-url <url>` (env `E2E_BASE_URL`, default `http://127.0.0.1:18080`)
- `--tier <1|2|3|4|5|1-5|all>` (default `all` -> Tiers 1–4 `59` checks; `5` -> Tier 5 adversarial `10` checks; `1-5` -> all `69` checks)
- `--screenshot-dir <dir>` (env `E2E_SCREENSHOT_DIR`, default `<os.tmpdir()>/deepmarket-e2e-screenshots`, never inside `web/src` or `web/dist`)
- `--json-report <path>` (optional structured JSON telemetry output)
- `--headed` (launch browser with UI window instead of headless)

### Environment Overrides
- `PLAYWRIGHT_MODULE_PATH`: explicit path to a `playwright` or `playwright-core` package entry.
- `E2E_BROWSER_EXECUTABLE`: explicit browser binary path.
- `E2E_BROWSER_CHANNEL`: Playwright browser channel (e.g., `msedge`, `chrome`).

## Tiers
- **Tier 1 (`suites/tier1-smoke.mjs`)**: `>= 25` happy-path checks (`>= 5` per area: AuthGate, FishingDeck/Canvas/SSE, GuildPanel, FxTerminal, LotteryScratchHall).
- **Tier 2 (`suites/tier2-boundaries.mjs`)**: `>= 25` boundary, negative, and regression checks (including `card.payouts` omitted `payouts ?? []` route-interception test).
- **Tier 3 (`suites/tier3-e2e-flows.mjs`)**: Full cross-feature economy loop + multi-tab SSE `scratch_revealed` and fishing synchronization.
- **Tier 4 (`suites/tier4-visual-desktop.mjs`)**: 5 desktop scenarios across `1440x900` and `1280x800` viewports (layout overflow/clipping/overlap audit, animated canvas pixel-diff, FX chart interactivity, and deterministic PNG screenshots).
- **Tier 5 (`suites/tier5-adversarial.mjs`, `--tier 5` / `--tier 1-5`)**: 10 adversarial edge-case scenarios (`T5-1`..`T5-10`) covering mobile/narrow breakpoints (`390x844`, `760x800`, `1024x768`), fishing critical tension / recovery / auto-stop / reduced-motion / repair & upgrade, FX 0/1/flat/zero-candle & extreme zoom bounds, Guild filters/sort/cross-filter hidden selection, Lottery `00:00:00` countdown/drawn/claim/hash-copy/`scratch-super` 9-slot foil drag (strictly `page.route()` mocked without mutating live `current_batch.drawn`), and `401`/`500`/malformed SSE resilience.

## Exit Code
Exits `0` if and only if all selected tier checks pass AND there are zero `pageerror`, zero unexpected `console.error`, zero HTTP `>= 500`, and zero unexpected HTTP `>= 400` responses.
