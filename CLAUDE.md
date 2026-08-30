# Tile Match 3 — Pixi.js port

A vanilla-JS / Pixi.js game. No build step **in development**: `index.html` loads
ES modules from `src/` and the vendored `vendor/pixi.min.js`. Keep it that way —
do not add a bundler, a framework, or an npm dependency to the game itself.

Production is a separate artifact, not a different source tree: `tools/build.py`
bundles, minifies and obfuscates `src/` into one file, strips the `window.__game`
debug API, and uploads it to S3 under the commit hash. Its toolchain lives in
`tools/package.json` and is never imported by the game. See the README's
*Deploying* section, and note the `DEBUG:` labelled blocks in `src/main.js` and
`src/splash.js` — esbuild drops them from a production bundle, so **any new debug
or test seam hung off `window` belongs inside one**. `tests/debugseam_test.py`
enforces that. Two more build rules the tests enforce: a new top-level file or
directory must be classified in `tools/build.py` (`SHIP_DIRS`/`SHIP_GLOBS` or
`NOT_SHIPPED`), and a new asset file extension needs a `CONTENT_TYPES` entry.

A deploy also repoints a CloudFront distribution's origin at the new build and
invalidates the edge cache, so the key layout and the `Cache-Control` headers in
`tools/build.py` are load-bearing beyond S3. In particular: players fetch stable
URLs (`/src/main.js` is the same for every build, because the commit is in the
*origin path*), so assets must never be marked `immutable` — that would strand
them on an old build past any invalidation. `tests/cloudfront_test.py` guards
this.

## Read the docs before changing code

**Before making any change, read `README.md`** (root) to understand the current
gameplay, UI, and architecture, and `tests/README.md` for the test harness. The
root README documents tile/tray mechanics, boosters, level config, and the
responsive 750×1334 design-space layout system — context you need so a change fits
existing behaviour instead of contradicting it.

## Key parameters go in `src/config.js`

Feature gates, unlock levels, progression thresholds and economy amounts live in
the single central config `src/config.js` (exported as the frozen `CONFIG`
object), each with a comment explaining what it does. **Every new tunable
parameter must be added there** — never inline a level threshold, grant size or
reward amount into a module; import it from the config instead. Layout/visual
constants stay with their scene, and large data tables stay in
`assets/config/*.json`. `tests/config_test.py` enforces this.

## Testing is mandatory for every change

**Always run the test suite after any change to game code, and never consider a
change done until the suite passes.**

```bash
python3 tests/run_all.py           # full suite
python3 tests/run_all.py settings  # subset (substring match on filename)
```

The tests are Playwright-Python end-to-end tests that drive the real game in
headless Chromium via the `window.__game` debug API (defined in `src/main.js`).
They need `playwright` installed with the Chromium browser.

**If your change is not covered by an existing test, write a test for it FIRST,
then run the suite.** A good regression test should fail on the old behaviour and
pass on the new — verify this by temporarily reverting your fix and confirming the
new test fails. One `*_test.py` file per area; `run_all.py` auto-discovers any
file matching `*_test.py`. Expose whatever state the test needs through the
`window.__game` API rather than reaching into internals.

## Keep docs in sync

Update the relevant `README.md` (root and/or `tests/README.md`) whenever you
change gameplay, UI layout, or the tests.
