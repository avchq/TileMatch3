# Tests

End-to-end tests that drive the actual game in headless Chromium via
[Playwright](https://playwright.dev/python/). Each test serves the project over
`python -m http.server` on port `8099`, loads `index.html`, and exercises
behaviour through the `window.__game` debug API exposed in `src/main.js`.

## Requirements

- Python 3 with `playwright` installed (`pip install playwright` then
  `playwright install chromium`).

## Running

```bash
# all tests
python3 tests/run_all.py

# a subset (substring match on the filename)
python3 tests/run_all.py settings back
```

Or run one directly:

```bash
python3 tests/settings_test.py
```

Each test starts and stops its own server, so they run **one at a time** (they
share port 8099). A test exits non-zero and prints an assertion on failure;
`run_all.py` prints a final PASS/FAIL summary.

## Screenshots

Tests drop PNG snapshots into `tests/output/` (gitignored) for eyeballing.

## The tests

Each file is a standalone script covering one area. Descriptions below are one
line per test.

### Navigation & UI

- **`lobby_test.py`** — the game lands on the lobby with the correct `Level N`
  play button; starting a level leaves the lobby, and solving it reaches the win
  overlay (`boardCount == 0`) and returns to the lobby.
- **`back_test.py`** — the in-level Back button returns to the lobby *without*
  advancing the level, and a user-record change made mid-level (e.g. crediting
  coins) survives both the Back press and a reload.
- **`settings_test.py`** — the settings cog (top-left) opens the settings overlay
  from both the lobby and inside a level; the Music/Sound toggles switch the
  audio channels and persist to the user profile.
- **`roundbtn_test.py`** — the in-level round buttons (undo / reshuffle) are
  clickable at their HUD positions and drive their actions without errors.
- **`cog_corner_test.py`** — the settings cog is pinned to the **top-left corner**
  of the screen in both the lobby and inside a level, and stays there on viewports
  taller than the 750×1334 design canvas (regression guard: the lobby cog used to
  ride the vertically-centred UI layer and drifted down on tall screens).
- **`orientation_test.py`** — the game fits **any** viewport with no letterbox
  bars and never crops. Across a spread of resolutions (the required
  `344×882`, `374×667`, `1024×366`, `412×914` plus a tablet-portrait and a
  generic-landscape extra) it asserts, for both the lobby and inside a level,
  that the canvas covers the viewport at its exact aspect ratio (uniform scale,
  no stretch), the design area is never smaller than the 750×1334 nominal
  (nothing cropped) with exactly one dimension filling it edge-to-edge, and the
  board (centred), tray, and helper row all sit inside the view without
  overlapping — resizing the viewport live between each check.
- **`scaling_test.py`** — the board **scales to fill the screen** rather than
  sitting at a fixed size. On a roomy portrait screen `boardScale` grows past
  **1** (the old code capped it at 1.0, leaving big margins); the board footprint
  fills most of the available width; and on a landscape screen it fills the
  vertical band between the HUD and tray (~full `areaH`, not ~40 %). Also checks
  the board never overflows its available width/height.

### Gameplay

- **`undo_test.py`** — undo is a multi-step stack: it restores collected tiles
  one at a time back to the board, is a no-op on empty history, and cannot undo a
  completed triple (matched tiles leave the history). Also checks tray grouping:
  a collected tile lands next to its matching group, and undo still pops the
  last-added tile even from a middle slot. Plus position regressions: a **fast
  undo** (fired mid tray-slide, before the animation settles) still lands the tile
  on its **original board cell** (not a stray tray-slot position), and undoing
  several collected tiles returns each to its own home cell in **reverse placement
  order**.
- **`reshuffle_test.py`** — reshuffle reassigns the board tile faces while keeping
  the level, board count, and the tray/deck unchanged, and stays in the level.
- **`layout_test.py`** — a level's type layout is deterministic: the same fruit
  lands on the same position across re-loads and full page reloads, different
  levels differ, and the fixed board is still solvable to a win.
- **`booster_test.py`** — the Undo/Shuffle helpers draw from an inventory on the
  user record: a fresh profile has the starter stock, each use decrements it and
  updates the count bubble, the inventory persists across a reload, and a grant
  re-enables it live. A helper is disabled only when there's no move to make (Undo
  with an empty tray); at 0 stock with no coins it enters the **ad tier** (still
  usable — a tap grants a free use, spending no coins and netting 0 stock).
- **`boosterbuy_test.py`** — the in-level acquisition ladder when a helper's stock
  hits 0: prices come from the JSON config (`assets/config/prices.json`); with
  enough coins a tap **buys** one and uses it in the same press (coins drop by the
  config price, net stock 0); using owned stock costs no coins; and when the player
  can't afford one the helper drops to the **"watch an ad"** tier — still usable,
  granting a free use for no coins. Covers both Shuffle (board-gated) and Undo
  (tray-gated).
- **`wand_test.py`** — the Wand helper completes one triple end to end: from an
  empty tray it banks a fresh triple off the board (space-neutral), a waiting
  pair is finished by pulling a single tile (freeing two slots), a rapid
  double-tap spends only one charge, and the spent stock persists across a reload.
  At zero stock (board up, no coins) it falls back to the **ad tier** rather than
  disabling — a tap watches a stubbed rewarded ad to complete a triple for free.
- **`continue_test.py`** — filling the tray no longer dead-ends: it opens a modal
  **"Out of Moves"** overlay (Home / Replay / Continue). The overlay dim is modal
  (`eventMode:"static"`). **Continue** follows the booster waterfall — a broke player
  gets the **ad tier** (free continue, no coins spent) and a player with coins gets
  the **coin tier** (spends exactly the config `continue` price); either way every
  collected tile returns to the board (tray empties, board count restored) and play
  resumes. **Replay** restarts the level in place; **Home** returns to the lobby
  without advancing. The continue price comes from `assets/config/prices.json`.
- **`auto_test.py`** — the free Auto Complete button appears (replacing the three
  helpers) exactly when the endgame is trivial (≤12 tiles left, none covered):
  the availability flag matches the gate at every step of a level-1 descent and
  the HUD row mirrors it, pressing it sweeps every tile into the first slot and
  wins the level (board/rack empty, overlay shown), Continue advances a level,
  and the next level's helper row recovers (the `_autoRunning` reset).

### User profile & persistence

- **`user_test.py`** — a fresh profile has the expected defaults (platform, a
  non-empty id, level 1, zeroed wallet, music/sound on) and progress persists
  across a reload.
- **`coins_test.py`** — coins are a spendable wallet currency with a top-HUD coin
  pill (lobby + level) that updates live on credit; winning a level awards coins
  (the win overlay shows the reward); the Shop lists packages for sale and buying one
  via the mock payment provider grants its contents — a bundle grants coins **and** a
  mix of boosters, a single-item pack grants only coins; the balance persists across
  a reload.
- **`reset_test.py`** — resetting the profile restores progress, wallet, and
  settings to defaults while preserving the identity (`id`), and the reset
  persists across a reload.

### Assets & loading

- **`assets_test.py`** — the preload fetches and decodes all 6 audio files exactly
  once, and starting play triggers no asset re-fetch.
- **`lazy_test.py`** — levels beyond the preload set are registered but not loaded
  until `ensureLevel` fetches their JSON on demand (and only once).

### Audio lifecycle

- **`bgm_test.py`** — lobby background music starts on load with a running audio
  context, and muting stops it.
- **`bgm_gesture_test.py`** — background music does not start while the audio
  context is suspended on load (no warnings); a user gesture unlocks and starts
  it.
- **`bgm_suspend_test.py`** — BGM start is deferred while the context is suspended
  (not created synchronously) and begins once the context resumes.
- **`visibility_test.py`** — hiding the tab suspends audio and returning resumes
  it, without altering the user's music/sound settings.
