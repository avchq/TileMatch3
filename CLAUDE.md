# Tile Match 3 — Pixi.js port

A vanilla-JS / Pixi.js game. No build step: `index.html` loads ES modules from
`src/` and the vendored `vendor/pixi.min.js`.

## Read the docs before changing code

**Before making any change, read `README.md`** (root) to understand the current
gameplay, UI, and architecture, and `tests/README.md` for the test harness. The
root README documents tile/tray mechanics, boosters, level config, and the
responsive 750×1334 design-space layout system — context you need so a change fits
existing behaviour instead of contradicting it.

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
