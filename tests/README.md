# Tests

End-to-end tests that drive the actual game in headless Chromium via
[Playwright](https://playwright.dev/python/). Each test serves the project over
`python -m http.server` on port `8099`, loads `index.html`, and exercises
behaviour through the `window.__game` debug API exposed in `src/main.js`.

## Requirements

- Python 3 with `playwright` installed (`pip install playwright` then
  `playwright install chromium`).

On distros without a system `pip` (e.g. Fedora), set up a virtualenv in the
repo root once — `.venv/` self-ignores, so it stays out of git:

```bash
python3 -m venv .venv
.venv/bin/python -m pip install playwright
.venv/bin/playwright install chromium
```

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

With the virtualenv above, substitute `.venv/bin/python` for `python3`.

Each test starts and stops its own server, so they run **one at a time** (they
share port 8099). A test exits non-zero and prints an assertion on failure;
`run_all.py` prints a final PASS/FAIL summary.

## Screenshots

Tests drop PNG snapshots into `tests/output/` (gitignored) for eyeballing.

## The tests

Each file is a standalone script covering one area. Descriptions below are one
line per test.

### Navigation & UI

- **`newuser_test.py`** — the **first-run flow**: a brand-new profile (fresh
  browser, nothing saved) boots **straight into level 1**, skipping the lobby
  (`isNewPlayer` true, `completedLevel` 0). Quitting level 1 part-way shows the
  lobby but keeps the player new — a reload routes back into the level. Solving
  level 1 and pressing the win overlay's **Continue** lands on the lobby at
  `Level 2`, records `completed == 1` and ends the flow, which **persists**: every
  later boot lands on the lobby. Resetting the profile makes the player brand-new
  again, so the next boot replays the first-run flow. Drives it via the
  `window.__game` hooks `isNewPlayer` / `completedLevel` / `completeLevel` /
  `pressWinContinue`.
- **`howtoplay_test.py`** — the **"How To Play" popup** that opens at the very
  start of level 1: it is up with the right title and line, the level is locked
  behind it (a `solveTap` collects nothing and the guided opening hasn't started),
  a tap does **not** close it mid fade-in but does once `introDone`, `OK` is the
  only button (no skip), and the looping demonstration really runs (three tiles
  reach its mini tray and a triple leaves its mini board). Pressing **OK** closes
  it, writes the `tilemaster.tutorialDone` marker (outside the save record) and
  hands over to the guided opening. It re-centres on a resize, never opens outside
  level 1, opens **again** for a returning player re-entering level 1 (nothing reads
  the marker back), and does not survive leaving the level. Drives it via
  `tutorialState` / `pressTutorialOk` / `tapTutorialDim` / `tutorialMarker`.
- **`firstlevel_test.py`** — the **guided first level** a brand-new player is
  dropped into: the top bar is stripped to the coin counter (`hudState` reports
  `cog` / `back` hidden and `shopEnabled` false, and neither name appears in
  `controls()`); the game plays the first **two** moves itself (two same-type tiles
  in the tray) and puts the pointing hand on a free third (`handState`), so one tap
  clears the triple and dismisses the hand; the three helpers are visible but
  **locked** (`boosterState().*Locked`, dimmed) and a `pressBooster` on each is a
  no-op that floats the right `boosterHint()`. Re-entering level 1 while still new
  keeps the treatment; a returning player gets the full HUD, no demo moves and no
  hand — except the **shop**, which has a progression gate of its own and only
  lights up once level 2 is passed (`shopunlock_test.py`).
- **`lobby_test.py`** — the game lands on the lobby with the correct `Level N`
  play button; starting a level leaves the lobby, and solving it reaches the win
  overlay (`boardCount == 0`) and returns to the lobby.

**Note:** a fresh profile is a brand-new player, so tests have to play forward past
the first-run flow before they can drive the ordinary game:
- needing the **lobby** on boot (`lobby`, `back`, `settings`, `cog_corner`, `bgm`)
  → `window.__game.completeLevel(1)` + `flushSave()`, then reload;
- needing **unlocked helpers** or an unguided level 1 (`booster`, `boosterbuy`,
  `undo`, `wand`, `reshuffle`, `continue`, `coins`, `auto`, `resize_overlap`) →
  `completeLevel(5)`, past every helper's unlock level. Without it the guided
  level 1 plays two moves of its own and every helper refuses to act.

**Note:** **every** entry into level 1 — a boot into it, `startLevel(1)`, or the
lose overlay's **Replay** — opens the modal **"How To Play"** popup, which locks the
level behind it. Any test that then drives level 1 must dismiss it first with
`window.__game.closeTutorial()` (a no-op when none is up); the usual shape is
`page.evaluate("async () => { await window.__game.startLevel(1); window.__game.closeTutorial(); }")`.
Only `howtoplay_test.py` leaves it open.
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
- **`resize_overlap_test.py`** — the systematic **no-overlap** guarantee: across a
  spread of common device shapes (portrait phones, a landscape phone, tablets both
  ways, a 16:9 desktop, plus the exact 750×1334 nominal) and in **every** scene
  (lobby, level, and the settings / shop / fortune-wheel / daily-bonus overlays),
  every interface control stays **fully inside** the design area and **no two
  independent controls overlap** (buttons, text labels, tags, badges, the play
  board, the tray), with the HUD anchored near the top and the tray/helpers near
  the bottom. Reads control bounds in design-space via the `window.__game.controls()`
  hook (each scene exposes a `controls()` list). Regression guard: the lobby title
  used to clip the top-left Daily-Bonus / wheel button column on tall screens — now
  centred text is width-capped to the safe centre band (`layout.js` `fitTextWidth`).
- **`featurerail_test.py`** — the lobby's **feature-button rail**
  (`src/featurerail.js`): the feature buttons fill **consecutive slots** down the
  left edge in the fixed priority order (1. Free Spin, 2. Daily Bonus), with **no
  holes**. Regression guard: with the wheel still locked (below level 5) the Daily
  Bonus button must sit in the **first** slot (y 214) — it used to hard-code y 396
  and float under an empty slot. Unlocking the wheel makes it **reclaim slot 0**
  while the gift **slides back down** to slot 1, and re-locking it promotes the gift
  again — both moves asserted to be **animated** by sampling the button's `y` every
  frame (many samples, seen strictly between the two slots — a teleport would land in
  one). The reflow is also sampled frame-by-frame for **overlap**: the two buttons'
  bounds must never intersect while both are on screen (the arriving button holds its
  fade-in until the slides finish; regression guard — a naive simultaneous fade+slide
  stacked them and tripped `resize_overlap_test.py`).
  Also covers a fade-in reaching `alpha 1`, a fade-out ending `visible:false`,
  a single-occupant rail staying put, an **idle rail not twitching** across the 4 s
  day-rollover poll (`moving:false` — the poller must not restart in-flight tweens),
  an empty rail re-populating when a new day re-arms the gift, and the arrangement
  surviving a round trip through a level. Drives it via `window.__game.featureRail()`
  plus the live `lobby.wheelBtn`/`lobby.dailyBtn` display objects.
- **`tray_size_test.py`** — the bottom tray is sized to the **current level's tile
  size**, not a fixed 84px slot: the slot equals `clamp(TILE_DRAW*boardScale,
  SLOT_MIN, SLOT_MAX)` across levels, the 7 slots stay evenly spaced and the panel
  fits the 750-wide safe band, and a collected tile renders at the slot size. Since
  the board fills the screen (large tiles) the slot clamps at `SLOT_MAX` on normal
  screens. Drives it via the `window.__game.traySize()` hook.
- **`scaling_test.py`** — the board **scales to fill the fixed 750-wide game
  column**, not a fixed size and not the whole viewport. On a roomy portrait screen
  `boardScale` grows past **1** (the old code capped it at 1.0, leaving big
  margins) and the board fills most of the 690-wide column; on a **wide/landscape**
  screen the board stays **column-sized** — the same footprint as portrait, well
  under the raw viewport width (the regression guard against blowing the board up
  edge-to-edge; the game stays a vertical strip with the blurred background on the
  sides). Also checks the board never overflows the column width or the vertical
  band.

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
- **`boosterunlock_test.py`** — helper **progression**: a new account is awarded
  nothing and every helper is locked; each then unlocks at its own level (Undo 2,
  Reshuffle 4, Wand 5 — the `UNLOCKS` table at the top of the file mirrors
  `BOOSTER_UNLOCKS`, and is the only place the schedule is spelled out) and is
  granted its stock right then, and only that helper. The grant is **one-time** — spend it,
  clear more levels, it stays spent — and both the inventory and the paid-out
  record (`boosterUnlocks`) survive a reload. `reset()` puts everything back behind
  its gate. Also covers the **v4→v5 migration**: an existing save keeps the stock it
  was given up front, is not handed a second grant, and has anything still locked
  zeroed.
- **`booster_test.py`** — the Undo/Shuffle helpers draw from an inventory on the
  user record: a fresh profile has **nothing** (helpers are locked), unlocking pays
  out the scheduled stock, each use decrements it and updates the count bubble, the
  inventory persists across a reload, and a grant re-enables it live. An unlocked
  helper is disabled only when there's no move to make (Undo with an empty tray);
  at 0 stock with no coins it enters the **ad tier** (still usable — a tap grants a
  free use, spending no coins and netting 0 stock).
- **`boosterbuy_test.py`** — the in-level acquisition ladder when a helper's stock
  hits 0: prices come from the JSON config (`assets/config/prices.json`); with
  enough coins a tap **buys** one and uses it in the same press (coins drop by the
  config price, net stock 0); using owned stock costs no coins; and when the player
  can't afford one the helper drops to the **"watch an ad"** tier — still usable,
  granting a free use for no coins. Covers both Shuffle (board-gated) and Undo
  (tray-gated).
- **`wand_test.py`** — the Wand helper completes one triple end to end: it
  **prioritises available tiles** — on the empty-tray start (where fully-free
  triples exist) `wandPreview` must pull an all-available triple, never dragging a
  covered/greyed tile out from under others (regression: the old picker chose the
  lowest face-id colour with ≥3 tiles, dipping into a covered tile even when a free
  triple existed). From an empty tray it banks a fresh triple off the board
  (space-neutral), a waiting pair is finished by pulling a single tile (freeing two
  slots), a rapid double-tap spends only one charge, and the spent stock persists
  across a reload. At zero stock (board up, no coins) it falls back to the **ad
  tier** rather than disabling — a tap watches a stubbed rewarded ad to complete a
  triple for free.
- **`continue_test.py`** — filling the tray no longer dead-ends: it opens a modal
  **"Out of Moves"** overlay (Home / Replay / Continue). The overlay dim is modal
  (`eventMode:"static"`). **Continue** follows the booster waterfall — a broke player
  gets the **ad tier** (free continue, no coins spent) and a player with coins gets
  the **coin tier** (spends exactly the config `continue` price); either way every
  collected tile **flies back** to the board — the return is animated, so input
  stays **locked mid-flight** (asserted), and the tiles return in **reverse
  placement order** (newest-first, like a run of Undos — asserted) before the tray
  empties, the board count is restored, and play resumes. **Replay** restarts the
  level in place; **Home** returns to the lobby without advancing. The continue price
  comes from `assets/config/prices.json`.
- **`auto_test.py`** — the free Auto Complete button appears (replacing the three
  helpers) exactly when the endgame is trivial (≤12 tiles left, none covered)
  **and the level is 2 or later**. A full level-1 descent reaches that endgame yet
  the button never shows (level 1 is finished by hand); a level-2 descent then
  checks the availability flag against the gate at every step with the HUD row
  mirroring it, pressing it sweeps every tile into the first slot and
  wins the level (board/rack empty, overlay shown), Continue advances a level,
  and the next level's helper row recovers (the `_autoRunning` reset).

### Fortune Wheel

- **`fortunewheel_test.py`** — the daily prize wheel (`src/fortunewheel.js`). The lobby
  button is **gated on progression** (hidden below the config `unlockLevel`, shown
  once reached) and carries a **NEW** badge (until first open) and a **free-spin**
  badge (until the free spin is used). Opening the wheel advances to the first
  daily group and builds the slice count **from the group** (8 prizes). The **free
  spin** grants its prize into the wallet/inventory, marks the slice won, consumes a
  pip, and drops the free badge — and a **rapid double-tap spends only one spin**.
  Over a cycle **a prize is only won once** (no repeats), the cycle allows exactly
  **6 spins**, and the wheel **closes itself after the last spin**. While the wheel
  turns, the **pointer leans with the spin, never against it** (sampled through a
  spin: the wheel rotation only ever increases, so every deflection must be
  negative, reaching the full lean at speed) and **returns to 0 once it settles**.
  **Ad spins**
  (every spin after the free one) only resolve on a successful rewarded video —
  **cancel/fail spend nothing and win nothing**. Per-cycle state (group / spins /
  won list) **persists across a reload**, and forcing the **day rollover** advances
  to the next group (wrapping after the last), clears the won list + spin count, and
  restores a fresh free spin. Drives it via the `window.__game` wheel hooks
  (`wheelState`, `wheelBadges`, `wheelPointer`, `openWheel`,
  `spinWheel`/`pressWheelSpin`, `forceWheelPrize`, `setWheelAdResult`,
  `setWheelToday`).

### Daily Bonus

- **`dailybonus_test.py`** — the free once-a-day gift (`src/dailybonus.js`). The
  lobby gift button is **available from level 1** and shows while today's gift is
  unclaimed. Opening the popup pre-rolls **three boxes**; a **forced prize** behind
  every box makes the pick deterministic. Tapping a box **commits the claim on the
  spot** (`canClaim` flips to false, the day-key is stamped, the button hides — no
  re-roll), reveals the prize, and **Claim** credits it (coins → wallet, a
  `shuffle×2` prize → +2 boosters). The **double-with-ad** path is covered for all
  three outcomes: `succeed` doubles the amount, `fail`/`cancel` grant nothing extra
  and leave the base Claim available. A claim **persists across a reload** (still
  hidden, same day), and forcing the **daily rollover** re-shows the gift and makes
  it claimable again. Drives it via the `window.__game` daily-bonus hooks
  (`dailyBonusState`, `openDailyBonus`, `pickDailyBox`, `takeDailyBonus`,
  `doubleDailyBonus`, `forceDailyPrize`, `setDailyAdResult`, `setDailyToday`).

### Key parameters

- **`config_test.py`** — the central tuning config (`src/config.js`, exposed as
  `window.__game.config()`). Asserts it ships the intended values (the `EXPECT`
  table at the top of the file mirrors `config.js` — re-balancing means editing
  both, on purpose) and is deeply **frozen**; that the **live game** reads them
  rather than a copy that drifted (a new profile's wallet/inventory equal the
  configured starting values, each helper's unlock level and one-time grant match
  the schedule, the shop/wheel/daily gates open exactly at their `unlockLevel`,
  the wheel offers `spinsPerCycle` spins, the tray lays out `traySlots` slots,
  Auto Complete is never offered outside its `minLevel`/`maxTiles` window, and a
  win pays exactly `coinWinReward`); and that there is **no second source** — the
  JSON prize tables no longer carry the gates, and the modules the constants came
  from derive them from `CONFIG` instead of re-declaring a literal.

### User profile & persistence

- **`user_test.py`** — a fresh profile has the expected defaults (platform, a
  non-empty id, level 1, nothing completed, zeroed wallet, **no helpers** and no
  unlocks paid out, music/sound on) and progress persists across a reload.
- **`coins_test.py`** — coins are a spendable wallet currency with a top-HUD coin
  pill (lobby + level) that updates live on credit; winning a level awards coins
  (the win overlay shows the reward); the Shop lists packages for sale and buying one
  via the mock payment provider grants its contents — a bundle grants coins **and** a
  mix of boosters, a single-item pack grants only coins; the balance persists across
  a reload.
- **`shopunlock_test.py`** — the **shop's progression gate**
  (`SHOP_UNLOCK_LEVEL` = 3, i.e. **after passing level 2**). Drives `shopState()`
  (`unlocked` / `completed` / `lobbyEnabled` / `lobbyCart` / `gameEnabled`) and
  `tapCoinPill(where)`: a brand-new player and a player who has only cleared level
  **1** get a plain coin counter in **both** scenes — no cart badge, the balance
  still shown, the pill still in `controls()`, and a tap opens nothing. Clearing
  level 2 flips it **live** (no reload) in the level *and* the lobby, the pill then
  opens the shop from either, and the unlock survives a reload (it is derived from
  the persisted `progress.completed`).
- **`reset_test.py`** — resetting the profile restores progress, wallet, and
  settings to defaults while preserving the identity (`id`), and the reset
  persists across a reload.

### Assets & loading

- **`splash_test.py`** — the **loading splash** (`index.html` `#splash` +
  `src/splash.js`). The overlay is painted with its title and bar before boot has
  finished (`window.__game` still undefined) and covers the viewport; on a
  CDP-throttled connection the bar is caught **mid-flight**, growing across the
  track and never shrinking, with the percentage tracking it. The recorded
  `window.__splash.history` is **monotonic**, starts near 0, ends at exactly 1,
  and names stages **before and after** the asset preload (level table, profile,
  assets, settings, board) — the guard against a bar driven by the preload alone.
  Once the game is ready the splash is non-interactive **immediately**
  (`pointer-events: none` while it fades) and then `display: none`, and a real
  canvas click on the lobby cog reaches the game. Aborting
  `assets/config/levels.json` leaves the splash up in its **error** state with the
  message shown, rather than fading onto a blank canvas.
- **`assets_test.py`** — the preload fetches and decodes all 6 audio files exactly
  once, and starting play triggers no asset re-fetch.
- **`lazy_test.py`** — levels beyond the preload set are registered but not loaded
  until `ensureLevel` fetches their JSON on demand (and only once).
- **`levels_config_test.py`** — the level table is a JSON config
  (`assets/config/levels.json`) fetched at boot, not a hard-coded array: it's a
  non-empty array of `{background,data,types,preload?}`, the asset manifest's
  per-level groups are derived from it (one per entry, no phantoms), and the
  preload set is exactly `core` + the `preload:true` levels.

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
