# Tests

End-to-end tests that drive the actual game in headless Chromium via
[Playwright](https://playwright.dev/python/). Each test serves the project over
`python -m http.server` on a free port, loads `index.html`, and exercises
behaviour through the `window.__game` debug API exposed in `src/main.js`.

The server, the browser and the boot sequence come from **`tests/harness.py`**;
a test file no longer carries any of that itself. Because nothing names a fixed
port any more, the files run **in parallel**.

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
# the fast tier — seven files, broad coverage, for the inner loop
python3 tests/run_all.py --smoke

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

Tests run **four at a time** by default. That is not one-per-core on purpose:
headless Chromium renders through SwiftShader, so every worker is CPU-bound on
software WebGL, and eight at once starved each other badly enough to blow
Playwright's navigation timeout — a red suite for want of CPU, not for a defect.
Tune it with `-j`, or use `--serial` to reproduce a flake one file at a time.

**Five tests run on their own, after the parallel batch** (the `SERIAL` list in
`run_all.py`). `build_test.py` is there because it runs the real build pipeline
three times over. The other four — `fortunewheel`, `tasks`, `featurerail`,
`dailybonus` — measure animation **dynamics**: not that a tween ended somewhere,
but how it got there, frame by frame. Starve the renderer and there are fewer
frames to sample, and a tween stepping on a huge frame delta really can jump one
button through another; the failure is real, but it is a fact about the machine
rather than about the game. Waiting on a condition cannot help when the
condition is the frame rate itself.

The line is what you **assert on**, not how you wait. Asserting on a *final*
state belongs in the parallel batch; asserting on the frames themselves — that a
value fell monotonically, that two things never overlapped *while* moving —
belongs in `SERIAL`.

Waiting with `requestAnimationFrame` is not just allowed, it is the right tool,
and the reason is worth internalising: on a starved renderer two Python polls
50ms apart can straddle **zero painted frames**, so "the value did not change"
means "nothing was drawn", not "the animation finished". A settle-poll built on
`time.sleep` reads a half-finished tween as final. Count frames and that mistake
is impossible. `tray_size_test.py` has a worked example, and it was flaky in
exactly this way until it did.

**Timeouts are deliberately generous** — `wait_for_function` bounds sit around
60s and the harness gives every page a 90s navigation timeout. That costs
nothing when things are healthy, because a wait returns the instant its
condition is true; the bound only decides how long a genuinely stuck test takes
to give up. The alternative is worse than slow: under CPU pressure a tight
timeout turns into a *red suite*, and a starved browser is indistinguishable in
the output from a real defect. Verified by running the smoke tier at `-j 8`,
which is deliberately more load than the default.

A test exits non-zero and prints an assertion on failure. `run_all.py` captures
each test's output and replays it in full **only for failures**, prints a
duration per file, and ranks the slowest — that ranking is how the suite's
remaining blind `time.sleep()` calls get found and retired. `-v` streams
everything instead (and forces serial, since interleaved output is unreadable).

**The full suite gates a deploy.** `tools/build.py` runs it before it stages a
single file; see the root README's *Deploying* section.

## Writing a new test

Take the server and the browser from the harness — never start one, never name
a port, never `time.sleep()` waiting for either:

```python
import harness
from playwright.sync_api import sync_playwright

BASE = harness.serve()                    # a free port, torn down at exit

with sync_playwright() as p:
    browser, page, errors = harness.launch(p, viewport=(780, 1334))
    harness.boot(page, "window.__game && window.__game.lobby")
    ...
```

**Never sleep for an animation.** `time.sleep(0.5)` after triggering a tween is
a bet that the machine is idle; lose it and the test measures a half-finished
layout, which reads as a game bug rather than as the starved renderer it is.
Four separate tests failed this way the day the suite went parallel. Wait on
something real instead: a state flag the game already exposes (`moving` on a
rail entry, `spinning` on the wheel, `vw`/`vh` from `__game.view()`), or
`harness.frames(page)`, which blocks until the page has actually painted two
more frames and is therefore exactly as correct on a loaded machine as on an
idle one. Where the settled *value* is the thing under test, poll until it stops
changing and assert what it landed on — polling until it matches what you expect
makes the assertion vacuous. And where a test has to observe a *transient*
window (a fade still in flight, a lock that lifts after a beat), remember that
its own screenshots and `evaluate` round-trips are what spend that window:
restart the thing to reset the clock, and take the reading and the action in a
single `evaluate` so no round-trip can land outside it.

`harness.launch(..., autoplay=True)` adds the permissive autoplay flag the audio
tests need; `harness.watch(page)` hangs the console/pageerror hooks on a page you
built yourself; `harness.serve_dir(path)` serves somewhere other than the repo
(only `build_test.py` needs that, for a staged artifact).

## Screenshots

Tests drop PNG snapshots into `tests/output/` (gitignored) for eyeballing. Every
file namespaces its own shots, so parallel workers never fight over a filename.

## The tests

Each file is a standalone script covering one area. Descriptions below are one
line per test.

**Note:** the suite runs **in English**. Headless Chromium reports `en-US`, so a
fresh profile's one-time language detection picks `en` and every assertion on
on-screen wording reads the English table (`assets/lang/en.json`). A test that
wants another language sets `localStorage['tm3.language']` before loading — see
`i18n_test.py`.

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
- **`deal_test.py`** — the **opening deal**: every level's board arrives as a
  **wave crossing it from one of its four corners to the one diagonally
  opposite**, popping each tile in as the wave reaches it, instead of being
  painted outright. Using `window.__game.setDealCorner(corner)` to pin each of
  the four corners in turn, it checks that corner's geometry: a tile's delay
  never runs backwards along that corner's axis (moving away from the corner
  in either direction, or onto a higher layer, can only push a tile's deal
  later), and that on the ground layer the first tile dealt is the corner
  itself and the last is the tile diagonally opposite, with the delay only
  growing along the axis. It then unpins the corner (`setDealCorner(null)`)
  and deals a board eight times over, asserting the corner really does move
  around and is never repeated twice in a row. For a pinned corner, sampling
  `window.__game.dealState()` once per animation frame through a level start
  also checks that the board is `locked` and all but unpainted on the very
  first frame, with the far corner still at zero; that there is a frame where
  the near corner is solid while the far one has not begun, with no tile ever
  fading back out and, on that frame, no tile the wave deals later sitting
  ahead of one it deals earlier; that on settling every tile reaches full
  opacity and exactly its `homeScale`, the board is `unlocked`, and
  `startLevel` did not resolve before any of that was true; and, on level 1,
  that the **"How To Play"** popup does **not** open while the board is still
  arriving — only once the deal has landed. Drives it entirely through
  `dealState()`, `setDealCorner()` plus `state().locked`; writes
  `deal_level1_after.png`, `deal_wave_bl.png`, `deal_wave_br.png`,
  `deal_wave_tl.png`, `deal_wave_tr.png` and `deal_done.png` for the eye.
- **`howtoplay_test.py`** — the **"How To Play" popup** that opens at the very
  start of level 1: it is up with the right title and line, the level is locked
  behind it (a `solveTap` collects nothing and the guided opening hasn't started),
  a tap does **not** close it mid fade-in but does once `introDone`, `OK` is the
  only button (no skip), and the looping demonstration really runs (three tiles
  reach its mini tray and a triple leaves its mini board). Pressing **OK** closes
  it, writes the `tm3.tutorialDone` marker (outside the save record) and
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
  `undo`, `wand`, `reshuffle`, `continue`, `coins`, `auto`, `resize_overlap`,
  `config`) → `completeLevel(5)`, past every helper's unlock level; a test that
  needs the **Tasks** screen goes further, to `completeLevel(9)` (the level-10
  gate reads "cleared level 9"). Without it the
  guided level 1 plays two moves of its own and every helper refuses to act.
  **Follow it with `markBoosterCoached('all')`.** Clearing those levels leaves
  every helper unlocked but never *taught*, and an untaught helper opens its
  **coached first use** on the next level entry — a modal that dims the board,
  lifts one helper button out of the HUD and blocks all other input until it is
  used. That is `boostercoach_test.py`'s subject; for every other test it is an
  unexpected modal parked over the board, so take the lesson as read.
- needing a feature **gate moved in either direction** (`featurerail`,
  `fortunewheel`, `config`, `resize_overlap`, `unlockgate`) →
  `window.__game.setCompleted(n)`. Every gate is the profile's
  `completedLevel() >= unlockLevel - 1`, and `completeLevel()` is monotonic on
  purpose, so it can open a gate but never close one again. `setLevel(n)` moves
  the *derived* `progress.level` and no longer touches any gate at all.

**Note:** **every** entry into level 1 — a boot into it, `startLevel(1)`, or the
lose overlay's **Replay** — opens the modal **"How To Play"** popup, which locks the
level behind it. Any test that then drives level 1 must dismiss it first with
`window.__game.closeTutorial()` (a no-op when none is up); the usual shape is
`page.evaluate("async () => { await window.__game.startLevel(1); window.__game.closeTutorial(); }")`.
Only `howtoplay_test.py` leaves it open.
- **`back_test.py`** — the in-level Back button returns to the lobby *without*
  advancing the level, and a user-record change made mid-level (e.g. crediting
  coins) survives both the Back press and a reload. It also holds one board-build
  invariant: `loadLevel` clears **`fxLayer`** (where the Auto Complete sweep
  stages its tiles and `_spawnBurst` draws) along with the two layers it always
  cleared, so a new board never opens with the last one's effects still on it.
  The reachable path is closed — Back is disabled for the duration of a sweep —
  so the test stages a decoy `PIXI.Graphics` on the layer rather than racing an
  animation it cannot interrupt.
- **`settings_test.py`** — the settings cog (top-left) opens the settings overlay
  from both the lobby and inside a level; the Music/Sound toggles switch the
  audio channels and persist to the user profile. (The panel grew downward to
  make room for the **Language** row between Sound and Back, so the Back click
  point moved while the two toggles kept theirs — the row itself is
  `languagepicker_test.py`'s subject.)
- **`roundbtn_test.py`** — the in-level round buttons (undo / reshuffle) are
  clickable at their HUD positions and drive their actions without errors.
- **`levelhud_test.py`** — the level's top bar carries the level title, coin pill,
  cog and Back button and **nothing else**: no text anywhere in the level scene
  reads "*n* tiles left". Checked on a fresh board, after collecting tiles and
  after an undo (the moments the old remaining-tiles counter re-rendered).
- **`hudbar_test.py`** — the level's top bar is **aligned**: the cog, Back, the
  LEVEL title and the coin pill all sit **inside** the translucent panel, are
  **vertically centred** in it, and the outermost two (cog, the pill's cart
  badge) keep the **same margin** from their end of it — checked in design-space
  units across three viewports, plus the longest localized title (`ru`, level
  999) to confirm it is scaled to fit the room between Back and the pill instead
  of running under either. (Regression guard: the cog used to poke out past the
  panel's left edge, the cart badge hung ~20px past its right edge, and the whole
  row was centred 16px above the panel's own centre line.)
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
  the bottom. It also checks the anchoring of the lobby's own bands: the cog stays
  near the top edge and the **"Level N" play button hugs the bottom edge** (within
  200 design units of it) on every shape. Reads control bounds in design-space via
  the `window.__game.controls()` hook (each scene exposes a `controls()` list).
  Regression guard: the lobby title
  used to clip the top-left Daily-Bonus / wheel button column on tall screens — now
  centred text is width-capped to the safe centre band (`layout.js` `fitTextWidth`).
- **`sceneregistry_test.py`** — the **scene registry** in `src/main.js` (SEP-04):
  the eight scenes `root` owns are declared once, and `root.addChild`, `resize()`'s
  `layout(DW, DH)`, the re-lettering broadcast's `relocalize()` and the debug
  `controls()` seam all iterate that one list. They used to be four hand-maintained
  parallel lists, and three of the four failed **silently** when a new feature was
  missed from one — most quietly of all `controls()`, since a scene absent from it
  is simply not measured by `resize_overlap_test.py`. Two halves. The first is pure
  **source analysis** (no browser, milliseconds, the `debugseam_test.py` idiom,
  including its "prove the detector detects" step): `main.js` may contain no
  per-scene `X.layout(…)`, no per-scene `X.relocalize()` and no hard-coded
  `add("<key>", …)`, the `const scenes = [` literal must map all eight keys to their
  scenes, and the stage must be populated from it. The second registers a **ninth
  scene from the test** through the `window.__game.sceneRegistry()` seam (the live
  array) and asserts the probe receives all three broadcasts: the real `(DW, DH)` on
  a viewport resize — checked against `view()` — a `relocalize()` on
  `setLanguage('ru')`, and a row of its own in `controls()`. It also pins the roster
  of eight keys, that every member answers all three calls, and that the stage has
  no children the registry does not know about.
- **`featurerail_test.py`** — the lobby's **feature-button rail**
  (`src/featurerail.js`): the feature buttons fill **consecutive slots** down the
  left edge in the fixed priority order (1. Free Spin, 2. Daily Bonus), with **no
  holes**. Regression guard: with the wheel still locked (level 4 not cleared) the
  Daily Bonus button must sit in the **first** slot (y 214) — it used to hard-code y 396
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
- **`superwandrail_test.py`** — the lobby's **Super Wand read-out**, the third
  entry on the left-edge feature rail below Free Spin and Daily Bonus (see
  `superwand_test.py` for the sweep itself). Covers the **unlock gate** (hidden
  below `unlockLevel`, offered from it on); that it always takes the slot
  **below** whatever else is offered and sits correctly on the rail's slot
  ladder as those other entries come and go; that a counted streak win moves the
  pill's "streak/needed" label live with no scene rebuild; that a banked charge
  pins the pill full and repaints the face to the gold/upgraded look; that it
  **survives a reload**; that **using** the charge in a real level — sweeping,
  then returning to the lobby — changes **nothing**, since a Super Wand is the
  win streak itself and not a single-shot token, so the read-out still reads
  `N/N` in the charged face; and that an **accepted loss** is the one thing that
  ever empties it, dropping the meter to `0/N` and the face back to the ordinary
  glyph on return to the lobby; and — since the pill can only ever show a number
  — that a **tap opens the Super Wand promo**, the modal explaining what the
  number is for: every field it reports (title, illustration line, caption,
  button) is localized copy rather than a raw key, its meter tracks the streak
  live and swaps to the "ready" caption once charged, the OK button and a tap
  on the dim outside the panel both close it (there is no close cross), and
  leaving the lobby for a level closes it too. Drives it via
  `window.__game.superWandRail()` and `window.__game.superWandPromo()` /
  `pressSuperWandRail()`.
- **`tray_size_test.py`** — the bottom tray is sized to the **current level's tile
  size**, not a fixed 84px slot: the slot equals `clamp(TILE_DRAW*boardScale,
  slotMin, slotMax)` across levels, the 7 slots stay evenly spaced and the panel
  fits the 750-wide safe band, and a collected tile renders at the slot size. Since
  the board fills the screen (large tiles) the slot clamps at `slotMax` on normal
  screens. Runs on a fresh profile, so the **8th slot**'s gate is shut and the row
  is the base 7 cells throughout (`eighthslot_test.py` owns the 8-cell geometry).
  Drives it via the `window.__game.traySize()` hook.
- **`scaling_test.py`** — the board **scales to fill the fixed 750-wide game
  column**, not a fixed size and not the whole viewport. On a roomy portrait screen
  `boardScale` grows past **1** (the old code capped it at 1.0, leaving big
  margins) and the board fills most of the 690-wide column; on a **wide/landscape**
  screen the board stays **column-sized** — the same footprint as portrait, well
  under the raw viewport width (the regression guard against blowing the board up
  edge-to-edge; the game stays a vertical strip with the blurred background on the
  sides). Also checks the board never overflows the column width or the vertical
  band.
- **`progressbar_test.py`** — the **shared progress meter**
  (`makeProgressBar` in `src/layout.js`), which was hand-copied six times before
  DUP-03: both Super Wand streak bars and the Level Chest bar on the level's
  overlays, the lobby's chest bar, the Super Wand promo's meter and the Tasks row
  meter. Three parts. **(A)** Source analysis, no browser: the fill idiom
  `Math.max(h, w * pct)` — which each copy spelled with its own identifiers — must
  appear in `layout.js` and **nowhere else** under `src/`, `game.js` / `lobby.js` /
  `superwandpromo.js` / `tasks.js` must all import the helper, and the track alpha
  must be stated once rather than in the three spellings the copies had drifted to.
  This is the half that fails when a **seventh copy** grows back. **(B)** The
  widget's contract, driven directly — `/src/layout.js` is imported **by URL**, the
  same module record the game is running (the `tween_test.py` trick), so it needs no
  `window.__game` seam: the track is drawn around its own centre, an empty meter
  draws nothing, a full one fills the track, an over-full count clamps, a fraction
  **rounds** in the label, the fill is **never narrower than its own height** (the
  one-notch stub), `of == 0` draws nothing rather than `NaN`, `outline: true` adds
  the hairline and `label: false` omits the count. **(C)** Two converted call sites
  measured on screen against geometry recorded from the pre-extraction tree — the
  lobby bar's `controls()` rect and its track/fill rects to the pixel (it is the one
  whose track is **offset** from its container's origin), and the promo bar by shape
  rather than absolute units, since `fitPanel` scales that whole panel.

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
  Wand 3, Reshuffle 5 — the `UNLOCKS` table at the top of the file mirrors
  `CONFIG.boosters.unlocks`, and is the only place the schedule is spelled out) and is
  granted its stock right then, and only that helper. The grant is **one-time** — spend it,
  clear more levels, it stays spent — and both the inventory and the paid-out
  record (`boosterUnlocks`) survive a reload. `reset()` puts everything back behind
  its gate. Also covers the **v4→v5 migration** (an existing save keeps the stock it
  was given up front, is not handed a second grant, and has anything still locked
  zeroed) and **v5→v6**, which adds `boosterCoach` and leaves it deliberately
  **empty** — a migrated save is owed every coached first use.
- **`boostercoach_test.py`** — the **coached first use** each helper gets on the
  level it unlocks: the screen dims, that one button is lifted out of the HUD with
  its caption, and everything else goes inert. Wand and Reshuffle coach the moment
  the board is built; **Undo waits for the first collected tile** (there is nothing
  to undo before that). There is **no way out but using the helper** — tapping the
  dim, tapping tiles and pressing the other two helpers all do nothing — and the
  tap is a **genuine** use: stock drops by one and the helper really acts (undo
  returns the tile, wand clears a triple, reshuffle re-deals without losing tiles).
  Each helper is coached **once, ever**, and the record survives a reload; leaving
  mid-lesson restores the lifted button and leaves it still owed. A profile that
  jumped **past** every gate is owed all three and gets them one per level, lowest
  unlock level first. Level 1 keeps its own guided opening, untouched.
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
- **`superwand_test.py`** — the **Super Wand**, the Wand's earned upgrade. Covers
  the **unlock gate** (a new player and one level short of it get no streak at
  all; wins below the gate count for nothing); **charging** (each counted win
  fills one notch, the last one banks a charge, and further wins leave it
  **pinned** at the top rather than overflowing) and the pinned-full-while-banked
  rule; **persistence** of a banked charge and the streak across a reload; the
  **button takeover** — the ordinary Wand's face on entry, then the announced
  swap to the upgraded glyph/badge with its own sound, once per charge, with the
  badge carrying the **Wand's real stock** (a sweep still costs a use, so the
  count has to stay visible) — and that the ordinary Wand stays inert while
  charged even when called directly (`window.__game.wand()`); the picker's
  **cheapest-first ordering** (a waiting pair completed before a lone single) and
  its **availability-first** tile draw (free tiles before covered ones, matching
  the ordinary Wand); **whole-sets-only** batching (always a multiple of 3, never
  a partial set); the **top-up rounds** that pull whole fresh triples off the
  board from an empty tray; the **combined sweep** clearing both sets in one
  elimination and freeing the tray (proved by the cue log: exactly **one**
  `super_hint` and **one** `merge_click` for the whole batch, not one per set);
  that a sweep **spends one ordinary Wand use** — the charge and streak are
  untouched afterwards and the button is still the upgraded one, but the Wand's
  own stock drops by one, and a **second press spends a second use and sweeps a
  second batch off the same board**; the **acquisition waterfall** (6b) a sweep
  runs when stock is empty, identical to every other helper's — the buy tier
  debits the coin price and nets no stock, the ad tier is free and never greyed
  out, and either way the sweep still fires; a **double-tap firing the sweep
  once**, not twice, spending exactly **one** wand use, and still leaving the
  charge banked; a sweep into a **near-full tray** not losing the level, not
  tripping the "Insufficient space!" warning on the way through, and leaving the
  tray smaller than it started; a sweep that can **gather nothing** leaving the
  charge intact **and spending no wand use** (a no-op — there is nothing to
  charge for); a **replay** of an already-beaten level not advancing the streak,
  not showing the bar, and the button doing nothing — spending no wand use — once
  the level is already won; a **profile reset** wiping the streak
  and any banked charge (unlike a loss, which used to leave a banked charge
  alone — it no longer does, see below); a **genuinely new clear** filling one
  notch and showing the gold streak bar on the level-complete screen,
  **coexisting** with the Level Chest's bar without overlapping it; a **loss**
  breaking the streak only when the player accepts it (Home/Replay), never when
  they Continue; and that accepting a loss while a charge is **banked** clears
  the charge too — the lose overlay shows a full 5/5 "at risk" meter for a
  banked charge exactly as it shows a partial one, and Home/Replay empties both
  together. A final section (13) guards a coaching regression: the ordinary
  Wand's coached first use must actually run (one triple, tiles off the board)
  rather than be swallowed by the charged-mode guard when a charge is banked
  underneath the lesson.
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
- **`eighthslot_test.py`** — the **8th tray slot**, the ad-funded one-per-level
  capacity boost. Keeps the two numbers apart throughout: below
  `board.extraSlot.unlockLevel` the extra cell does not exist (a plain 7-cell row,
  no button); at the gate **8 cells are drawn** — evenly spaced, panel still inside
  the 750 band, row **re-centred** — while the capacity is **still 7**, with the
  "+1" offer sitting on the last cell (a 7th tile still loses the level). A
  **failed** video says *"Ad not ready, please try again later!"* and a **cancelled**
  one says nothing; neither consumes anything and both leave the offer up. A
  **completed** one raises the capacity to 8 and removes the button — and a second
  press grants nothing, so 9 slots is unreachable. It can't be taken while the
  Out-of-Moves overlay is up (live play only). Both warnings then **shift up by
  exactly one tile** (the pulse from 5 to 6, the bubble from 6 to 7) and 7 tiles is
  no longer a loss while 8 is. **Replay** and the next level reset it to 7 with a
  fresh offer; a **revive** keeps it, since Continue does not rebuild the board.
  Drives it via `extraSlotState` / `pressExtraSlot` / `setExtraSlotAdResult` /
  `trayWarning`, plus `traySize().slots` and `.capacity`.
- **`auto_test.py`** — the free Auto Complete button appears (replacing the three
  helpers) exactly when the endgame is trivial (≤12 tiles left, none covered)
  **and the level is 2 or later**. A full level-1 descent reaches that endgame yet
  the button never shows (level 1 is finished by hand); a level-2 descent then
  checks the availability flag against the gate at every step with the HUD row
  mirroring it, pressing it sweeps every tile into the first slot and
  wins the level (board/rack empty, overlay shown). The sweep is also checked to
  **sound**: `soundLog()` must hold one `tile_bop` per tile landing in the tray
  plus the one that opens the gather. Continue advances a level,
  and the next level's helper row recovers (the `_autoRunning` reset).
  Finally it pins **PRAC-01**: for the whole sweep the top-left **Back** button
  is *disabled but not hidden* (`eventMode` `"none"`, `alpha` 0.4, still
  `visible`), and a **real mouse click** on it neither leaves the level nor
  interrupts the sweep — `emit("pointertap")` would bypass hit-testing and prove
  nothing, so this part of the test drives the pointer for real, taking both
  buttons' rects from `controls()`. Leaving mid-sweep used to destroy the tiles
  the tween was still writing to, and that throw — raised inside a Pixi ticker
  listener — killed the rAF loop permanently. The test therefore also asserts
  `app.ticker.lastTime` has advanced afterwards; `harness.frames()` cannot see
  this, because it drives its own `requestAnimationFrame`, which keeps working
  after Pixi's loop has died. Back is asserted live again at the win overlay and
  on the next board (`_applyFirstRunChrome` re-arms it).
- **`hardlevel_test.py`** — **Hard Levels**, the every-tenth difficulty spike.
  Six checks: (1) **the cadence** — `hardLevel(n)` against `n % 10 ==
  progression.hardLevel.endsWith` over the *whole* level table, not a
  hand-picked pair, plus level 1 is never hard and a hard level's `mixPercent`
  always reads above the ordinary baseline; (2) **the measured scatter** — an
  ordinary board's `typeSpread()` reads `alignedFrac == 1.0` (every aligned
  triple is still one face, exactly as before the feature existed) while the
  first hard level's reads `< 0.5`, the regression line that goes red on a
  build without the window; (3) **still winnable** — auto-solving a hard level
  via `solveTap()` clears it to zero and the tray's peak occupancy never
  exceeds capacity, which by design runs right up to it; (4) **ordinary boards
  are untouched** — the level just before the hard one is checked for a fully
  consecutive layout and for being byte-for-byte the same board across a
  reload (`boardTypes()`); (5) **the ribbon**, in both places — hidden on the
  win screen when the next level is ordinary, visible and naming the right
  level when it's hard, tracking the lobby's Play button as `showLobby()` moves
  across levels, and its caption actually changing on a language swap (a
  translated phrase, unlike the untranslated `NEW`/`HOT` marks); (6) **the
  opening announcement blocks** — the board stays `locked` and a tap collects
  nothing while `hardBannerState().visible` is true, `state().overlay` stays
  `false` throughout (the announcement is not a win/lose overlay), play resumes
  the instant `startLevel()`'s promise resolves, an ordinary level never shows
  it, and — driving a real fill-the-tray loss and pressing Continue — it never
  replays on a **revive**, since that continues the existing board rather than
  dealing a new one.

### Fortune Wheel

- **`fortunewheel_test.py`** — the daily prize wheel (`src/fortunewheel.js`). The lobby
  button is **gated on progression** (hidden until the config `unlockLevel` minus
  one has been *cleared*, shown from then on — `unlockgate_test.py` owns the
  convention) and carries a **NEW** badge (until first open) and a **free-spin**
  badge (until the free spin is used). Opening the wheel advances to the first
  daily group and builds the slice count **from the group** (8 prizes). The **free
  spin** grants its prize into the wallet/inventory, marks the slice won, consumes a
  pip, and drops the free badge — and a **rapid double-tap spends only one spin**.
  Over a cycle **a prize is only won once** (no repeats), the cycle allows exactly
  **6 spins**, and the wheel **closes itself after the last spin**. While the wheel
  turns, the **pointer leans with the spin, never against it** (sampled through a
  spin: the wheel rotation only ever increases, so every deflection must be
  negative, reaching the full lean at speed) and **returns to 0 once it settles**.
  Sampled through that same spin, the **spin-click sound bed** runs for as long as
  the wheel turns — exactly one loop, never stacked — with its **playback rate
  riding the wheel's speed** (full cadence at peak, thinning out as it slows), and
  is **stopped when the wheel settles** (no loop left running). It also obeys the
  **Sound** setting: switching sound off mid-spin **cuts the bed immediately**, and
  a spin started with sound off never opens one.
  **Ad spins**
  (every spin after the free one) only resolve on a successful rewarded video —
  **cancel/fail spend nothing and win nothing**. Per-cycle state (group / spins /
  won list) **persists across a reload**, and forcing the **day rollover** advances
  to the next group (wrapping after the last), clears the won list + spin count, and
  restores a fresh free spin. Drives it via the `window.__game` wheel hooks
  (`wheelState`, `wheelBadges`, `wheelPointer`, `wheelSpinSfx`, `openWheel`,
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
  it claimable again. The **reveal sequence** is checked for ORDER, not timing: a
  rAF sampler watches `dailyBoxState()` through one pick and asserts the two
  unchosen boxes disappear **before** the picked one opens, the award appears
  **after** the lid lifts, and the opened box only fades out **after** the award is
  on screen — leaving the prize alone in the foreground. Drives it via the
  `window.__game` daily-bonus hooks (`dailyBonusState`, `dailyBoxState`,
  `openDailyBonus`, `pickDailyBox`, `takeDailyBonus`, `doubleDailyBonus`,
  `forceDailyPrize`, `setDailyAdResult`, `setDailyToday`).

### Tasks / Achievements

- **`tasks_test.py`** — the goals checklist (`src/tasks.js`). Covers the **level-10
  gate** on the lobby's **right-edge rail** (hidden and un-openable below it, then
  appearing live — while the counters behind it tick from level 1 regardless);
  every **activity counter** ticking at the place the activity really happens,
  including the rules that are easy to get wrong (`levelsCompleted` counts a
  **first clear only**, so a replay adds nothing; `coinsSpent` counts the
  **amount**, and a refused debit counts nothing; `tilesMatched` credits a
  **completed** level's whole tile count — nothing moves mid-level, an abandoned
  level counts nothing, and an **Auto Complete**d one still counts in full even
  though its sweep never goes through the matching path); the **one-unfinished-tier-per-
  chain** rule with finished tiers stacked above it and claimables sorted to the
  top; **claiming** (exact payout to wallet *or* inventory, the row leaving the
  list, never claimable twice, persisted across a reload); the **weekly** list
  scoring against a week baseline rather than the lifetime total, and a reset
  re-arming even already-claimed tasks while achievements are untouched; the
  **red dot** lighting and going out while the button itself stays; the **tab
  auto-select**; the **scrolling** list clamping at both ends, and a short drag
  that ends on a Claim button scrolling **without** claiming (a plain tap on the
  same button still does); and the **v6→v7 migration** deriving
  `stats.levelsCompleted` from `progress.completed` with a matching week baseline.
  It also guards the **activity vocabulary** itself (SEP-03): the ten codes are
  enumerated once, in `CONFIG.features.tasks.activities`, and the check reads that
  roster live from `config()` and holds all three copies to it — every `activity`
  and `titles` key in `assets/config/tasks.json`, every key of the `ACTIVITY`
  glyph map in `src/tasks.js`, and every code actually **emitted** under `src/`.
  The emitter half is pure **source analysis** (the `rewards_test.py` idiom:
  comments stripped, then `bumpStat("…")` collected across `src/`, plus the three
  `kind + "Used"` counters derived from `boosters.kinds` the way
  `User.useBooster` synthesises them) and it asserts set **equality**, so it fails
  in both directions — a rostered code nothing bumps is a task row stuck at `0/N`
  forever, and an emitted code the roster does not list is a typo. A last section
  covers the runtime half: `bumpStat('nonsenseActivity')` must produce exactly one
  `console.warn` naming it and still record the count (it warns, it does not
  refuse), while a rostered code stays silent — and since the diagnostic is a
  *warning*, the file's closing `assert not errs` still holds. It runs after the
  profile reset because it has to bump counters to do its job.
  Drives it via the `window.__game` task hooks (`tasksState`, `tasksList`,
  `openTasks`/`closeTasks`, `setTasksTab`, `pressTaskClaim`, `taskClaimRect`,
  `tasksScroll`/`scrollTasks`, `taskStats`/`taskStat`/`bumpStat`, `setTasksWeek`,
  and `config()` for the roster).
  **Waiting:** claims are asynchronous (a reward flies for ~540 ms and the row then
  animates away), so wait on `tasksState().busy` going false rather than sleeping —
  a *refused* claim never sets it, so the double-claim and drag cases fall straight
  through instead of hanging.

### Level Chest

- **`rewards_test.py`** — the shared reward module (`src/rewards.js`), which owns
  the one grant table, the one glyph table, the icon factory and the
  fly-to-counter arc for all four features that pay a `{ type, amount }` out.
  Three checks, guarding the two defects the old private copies had and the
  duplication itself. **A type the old map didn't know still pays**: a
  `lightning` daily prize (valid in `turntable.json`, absent from the daily
  gift's private map) credits the wallet, where it used to be dropped in total
  silence with the day already spent. **A type nothing grants is loud**: a `gems`
  prize pays nothing — there is nothing to pay — but leaves a `console.warn`
  instead of vanishing. **An unmeasurable fly target still pays**: with the
  wheel's target broken (`breakWheelFlyTarget()`), a spin still credits its 30
  coins and raises no page error — the wheel was the one copy that never got the
  `try/catch`, and it threw with `recordWheelSpin` already committed. The third
  check is pure **source analysis** (no browser, milliseconds, the
  `debugseam_test.py` idiom): no file under `src/` but `rewards.js` may declare a
  reward grant/glyph table, and the four paying features must import it.
  `src/levelchest.js` deliberately does **not** — it only decodes `"itemId|count"`
  into a type, and staying clear of the UI-side reward code is what keeps it pure.
  Seams: `setDailyPrizes(list)` replaces the daily prize *pool*
  (`forceDailyPrize` only picks from it) and `breakWheelFlyTarget()` makes the
  wheel's fly target unmeasurable.
- **`boosters_test.py`** — the shared helper (booster) module (`src/boosters.js`),
  which owns the one place Undo/Wand/Reshuffle's glyph, disc colour and coach
  caption key are stated, plus the chip control the Fortune Wheel, Daily Bonus
  and Tasks overlays each used to carry a private copy of. A behaviour-preserving
  refactor, so the checks are guards against the duplication coming back, not
  new-behaviour checks. Four source guards, no browser: **no helper glyph is
  spelled in code** anywhere under `src/` but the registry (a comment may still
  illustrate one, as `src/shop.js` does); **no private chip factory or
  `chipDefs` table** survives outside it, and all three chip-row overlays import
  it; **the registry is a leaf**, importing `./config.js` and nothing else
  (`src/rewards.js` already imports `src/shop.js`, and both want the registry —
  a further dependency here would close a cycle); and the three hand-written
  per-type tables that
  deliberately stay literals — `REWARD_GRANT`, `ITEM_KEYS`, `ITEM_TYPE` — still
  mention every helper in `CONFIG.boosters.kinds`. Then one live parity check:
  the level's Wand button still wears the glyph the registry declares, and all
  three overlays still report `chipUndo`/`chipWand`/`chipShuffle` at x
  70/190/310 while the level's own helper row is still three buttons at
  175/375/575 — that row's geometry stays `GameScene`'s own.
- **`winoverlay_test.py`** — the **win overlay's headline**. Clearing a level puts up
  the level-complete panel, whose title has two forms: `"🏆 You Win!"` for the **last
  level of the campaign** and `"Level Complete!"` for every other clear. The campaign
  length is not a tunable — it is `levels.length`, derived in `src/main.js` and handed
  to `GameScene` the same way it is handed to `LobbyScene`, so the two screens that
  hand off to each other agree. The test reads `assets/config/levels.json` itself
  rather than hardcoding a count (so it keeps holding as levels are added), asserts
  `winState().maxLevel` matches it, then plays three levels down with the solver:
  level 3 and the second-to-last both read `"Level Complete!"` with no trophy, and the
  last level reads `"🏆 You Win!"`. This pins **SEP-02**, where a hardcoded
  `levelNum >= 3` announced the end of a 28-level campaign from level 3 — and then the
  lobby offered level 4. Uses the `window.__game.winState()` seam
  (`{ title, maxLevel }`).

- **`levelchest_test.py`** — the recurring level-complete reward (`src/levelchest.js`
  + the win-overlay bar in `src/game.js`). Covers the **schedule maths**
  (`chestInfo`): the 50-milestone table's labels, `needed` counts, `full` flags and
  rewards across the whole hand-tuned schedule (4/8/12-win chests → the steady
  16-win rhythm) and into its **looping tail** past level 752 — the correct 16-win
  cadence and the wrapped milestone's reward — plus the reward **vocabulary**
  (`0`=coins, `10`=undo, `11`=wand[Hint], `12`=shuffle, `20`=lightning→coins). It
  asserts the **corrected label never goes negative** anywhere (this port
  deliberately fixes the original's negative-progress wrap bug). Then the
  **win-overlay behaviour**: a genuinely new clear shows the bar; a **milestone**
  clear opens the chest on the level-complete panel and then asserts the **ordering**
  — while that panel is up (`chestState().winPanel`) the reward is **not** shown, and
  only once **Continue** closes it does the **Chest Reward!** overlay appear, with the
  level still unadvanced until the reward is claimed (the **double-it** ad path
  doubling the amount into the coin pill, and the claim itself landing back on the
  lobby); the claim's coin flight is pinned to the **foreground** — the panel is
  cleared away first and `chestState().fly` must report a layer **above both the
  overlay and the HUD**; a new **non-milestone** clear shows a partial bar, does not open, and
  advances straight from Continue with no reward overlay; a **replay** of an
  already-cleared level shows no chest at all.
  It also covers the **persistent lobby bar**: hidden for a brand-new player, showing
  and updating **live** as levels are cleared, **rolling a just-opened milestone
  chest forward** to the next one at `0 / N` (`currentFor`), and rendering as a listed
  visible control on the lobby. Because chest progress is **derived** from the highest
  level cleared (nothing stored), it drives the state with `completeLevel` jumps. Uses
  the `window.__game` chest hooks (`chestInfo`, `chestCount`, `chestState` — whose
  `winPanel` flag says whether the level-complete overlay is still up —
  `lobbyChestState`, `pressChestDouble`, `pressChestClaim`, `setChestAdResult`).

### Localization

- **`i18n_test.py`** — the **13-language localization system** (`src/i18n.js` +
  `assets/lang/*.json`). Static half: all 13 files parse, their **key lists are
  byte-for-byte identical**, no value is empty, **no phrase is left sitting in
  English** (a one- or two-word cognate is allowed, a whole sentence is not),
  every `%value` appears at most once and each file's `{0}`/`{1}` token set
  matches English, line breaks survive, **no badge word** (`NEW`, `HOT`, `TOP`, …)
  has acquired a key — those stay literals in the scene that draws them, like the
  emoji — and nothing ships that nothing reads.
  Live half: the **device-language map** including the regional variants and the
  two trap codes (`en-IN`/`hi` → **`in` = Hindi**, `en-ID`/`id` → Indonesian,
  `ja` → **`jp`**, `zh-HK` → `zh-tw`, an unrecognised tag → English); **detection
  runs exactly once** (a `de-AT` browser boots German and writes `tm3.language`,
  after which the stored value wins even though the device still says German, and
  an unrecognised stored code is treated as English); it **walks every screen**
  and asserts `missingKeys()` is empty, which catches a typo'd key whichever of
  the three routes reached the table; `setLanguage('ru')` **re-letters the lobby
  and an in-level HUD in place** with no reload and no loss of progress; and the
  documented rough edges hold — a **missing key renders as the key itself**, a
  **failed download leaves the text alone but still stores the choice**, and every
  visited language **stays resident**.
- **`languagepicker_test.py`** — the **Language row and the picker**
  (`src/settings.js` + `src/languagepicker.js`). The row shows the current
  language's **own name**; tapping it opens the picker with all **13 rows in the
  fixed order**, names **untranslated**, the current one ticked and **scrolled
  into view**. Tapping a row moves the tick and changes **nothing else** (the
  active language, the lobby title and the stored choice are all untouched);
  closing without Confirm **discards** it, and reopening starts from the active
  language again. **Confirm** applies, closes, re-letters the screen underneath
  and translates the popup heading while leaving the list's names alone;
  re-picking the current language just closes. The choice survives a reload with
  progress intact, and the popup reflows on a narrow viewport. It also checks the
  **panel's own layout** through the `languagePickerGeometry()` seam, which reports
  the panel, the masked list viewport and both footer buttons as design-space
  rects: the list must end a **clear gap (≥ 24) above Confirm**, the two buttons
  must not collide, and all three must stay inside the panel. Confirm used to be
  drawn **on top of** the bottom of the list (list bottom +300 vs Confirm top
  +275); `LIST_H` is now derived from the footer geometry in
  `src/languagepicker.js`, so it cannot grow back into the buttons.

- **`langfit_test.py`** — **every translation fits the button it sits on.** The
  game's buttons are fixed-width pills with the label centred on top: the text is
  not masked and not shrunk, so a translation that runs long simply spills over
  the artwork, and `i18n_test.py` passes happily on a string that is perfectly
  correct and twice too wide. This boots all 13 languages in turn and measures
  each label that lives on a fixed-width widget (the play button, the settings
  Back / Language row, the picker's Confirm / Back / heading, the level HUD, Auto
  Complete) against that widget's inner width, in design units. Labels that
  already run through `fitTextWidth()` — the lobby title and subtitle, task rows,
  the tab buttons, the picker's language names — are deliberately excluded, since
  they shrink themselves. **A failure here is a translation to shorten in
  `assets/lang/<code>.json`, not a layout to widen.**

### Boot resilience

- **`boot_resilience_test.py`** — boot survives a broken environment, and when it
  genuinely cannot, it **says so** instead of leaving a frozen loading screen.
  Routes one thing wrong at a time: a **stale `src/config.js`** with the
  `language` section stripped (the real bug — `src/i18n.js` builds its singleton
  at module-evaluation time, so a direct `CONFIG.language.x` read threw *before*
  `boot()` ran and killed the whole graph); a **stalled** `assets/lang/*.json`
  (must not hold boot open — the fetch is time-bounded); **missing** language
  files (boots, and every label shows its key); and a module that **throws at
  import**, which must paint the splash's error state with a message rather than
  freeze at "Starting up… 0%". Finishes with a plain boot under the `iPhone 13`
  and `Galaxy S9+` device profiles.
- **`tween_test.py`** — the shared animation primitive (`src/tween.js`, ARCH-01),
  a session-killer and its guard. The codebase had converged on one correct
  answer to async staleness (a generation token plus a `stale()` predicate) and
  implemented it four times, once per owner, with no shared primitive — and the
  sequence that needed it most did not get it: PRAC-01, where a tween wrote
  through a destroyed tile and the exception escaped into a Pixi ticker
  listener. Its browser half deliberately **poisons the shared ticker**, so it
  runs in its own session and does nothing else on that page: it imports
  `tween.js` by URL (the very module record the game itself runs) and fires a
  bare, unawaited `tween(...)` whose `onUpdate` throws — exactly how the ~24
  fire-and-forget call sites in the game fire it — then asserts the render loop
  is still alive. `started` is a useless detector here (Pixi's `Ticker._tick`
  re-arms `requestAnimationFrame` only *after* `update()` returns, and
  `update()` sets `lastTime` as its last statement, so a listener that throws
  freezes `lastTime` forever while `started` stays true) and so is
  `harness.frames()` (it drives its own `requestAnimationFrame` loop, which
  keeps ticking after Pixi's has died) — only `ticker.lastTime` advancing proves
  the game is still rendering. Liveness is sampled **three times**, not once,
  because `_addListener` re-arms rAF whenever `_requestId === null`, so any
  later `ticker.add()` anywhere — from anything else running on the page — buys
  the still-poisoned listener exactly one more frame before it throws that one
  away too; a single sample could pass by accident. It then asserts the throwing
  tween's promise resolved `"error"` (never rejected, never hung), the throw was
  logged to `console.error` exactly once (not once per frame), a `while:` that
  goes false resolves `"abandoned"` early without ever running `onComplete`, and
  a tap still collects a tile afterward — the game is genuinely still playable,
  not merely still rendering. The second half is pure source analysis, no
  browser: it pins `src/tween.js` as the **one** place the re-targetable
  animator (`animator`/`retarget`/`snap`/`moving`/`step`) is declared and
  asserts `src/featurerail.js` imports it rather than owning a copy, pins
  `src/game.js`'s `_stale(run)` as the **one** place `_guideRun` is compared
  (it used to be inlined at nine sites in four different shapes), pins
  `src/tutorial.js`'s `_stale()` body as stated once rather than duplicated, and
  guards every `tween(` call site in `src/` against ever passing a positional
  duration again — the exact shape of the `src/lobby.js` regression that
  `bootguard_test.py` below catches live.
- **`bootguard_test.py`** — two boot-time defects that were both session-killers
  with no way out but a reload, and both invisible to the rest of the suite
  because every other test runs the dev tree. **BOOT-001**: the boot-error
  overlay's guard used to ask `window.__game` whether boot had finished — a
  symbol only the dev tree has, since `--drop-labels=DEBUG` strips it from
  production — so in the shipped bundle the guard could never fire and the first
  post-boot error (an unhandled rejection, an uncaught throw) dropped the opaque
  `#splash` over a running game permanently. This test deletes `window.__game`
  before firing a synthetic rejection and a synthetic throw, so the dev tree
  behaves like a production bundle, then asserts `<html data-booted>` is set, the
  splash's error state never lights up, and the canvas — not the splash — is
  still the topmost element under a tap. **BOOT-002**: a failed asset fetch used
  to permanently poison a level's group (see Asset management in the root
  README), so it routes a level's JSON fetch to a 503 and asserts
  `ensureLevel()` **rejects** (the old code resolved), the group stays out of
  `loadedGroups()`, and `startLevel()` reports failure instead of half-starting.
  It also drives the Play button's actual refusal path — `lobby.flashHint()` —
  and checks not just that the pill shows a localized message rather than a raw
  key, but that it **actually faded in** (`alpha > 0`): `flashHint()` used to
  call `tween(ticker, 180, { onUpdate: fade })`, the pre-options positional
  signature, and since `tween()` is arity-2 and destructuring a bare number just
  boxes it, `duration` silently fell back to its default and `onUpdate` was
  `undefined` — so the pill sat at its built alpha of 0 for its whole life and
  the "level failed to load, tap again" refusal was invisible in production.
  It then lets the route through and asserts the very next attempt is a real retry
  that succeeds. A follow-up case fails only a level's *background* and confirms
  the level data that did arrive is kept (and the level is still playable without
  its art) while the retry re-fetches just the missing piece. A final case routes
  a level's fetch to a request that never answers at all and asserts it gives up
  within a bounded time instead of hanging — the config knob it reads
  (`CONFIG.network.fetchTimeoutMs`) confirming the bound is `src/config.js`, not
  an inlined constant. Slower than most (60-90s): the stalled-fetch case
  deliberately waits out a timeout plus its retry.
- **`config_tables_test.py`** — the six JSON config tables survive a bad row
  (DATA-03), routed hostile with `page.route`/`route.fulfill` so the real
  fetch-then-load path runs on them, not a unit stub. A 3-milestone
  `levelChest.json` (shorter than `repeatStart`): `chestInfo` past the end
  returns `null` and the win overlay still builds instead of throwing mid-render.
  A `tasks.json` chain paying an unknown reward type `"gems"`: the claim is
  refused and the row survives, while a grantable row beside it still pays. A
  `prices.json` with a negative and a non-numeric price: `boosterPrice`/
  `continuePrice` read `0` and `null`, and the on-screen badge shows `"0"`
  rather than a negative number. A `levels.json` with a bare-integer `types`
  above the palette: `levelTypes()` clamps it. A final browser-free section
  walks the **shipped** tables for invariants nothing checked before —
  achievement tiers ascend strictly, every reward/prize type across
  `tasks.json` / `levelChest.json` / `turntable.json` / `dailybonus.json` is
  grantable, `levelChest.json` milestones ascend and the table is longer than
  `repeatStart`, every `levels.json` `types` sits inside the palette, and every
  price is a non-negative number. Uses the `window.__game.levelTypes(n)` seam
  (reports the distinct tile-face count level `n` resolves to) alongside the
  existing `chestInfo` chest hook.

### Key parameters

- **`config_test.py`** — the central tuning config (`src/config.js`, exposed as
  `window.__game.config()`). Asserts it ships the intended values (the `EXPECT`
  table at the top of the file mirrors `config.js` — re-balancing means editing
  both, on purpose — including the **Hard Level** additions,
  `progression.hardLevel.endsWith` / `.mixPercent` and `board.mixPercent`) and
  is deeply **frozen**; that the **live game** reads them
  rather than a copy that drifted (a new profile's wallet/inventory equal the
  configured starting values, each helper's unlock level and one-time grant match
  the schedule, the shop/wheel/daily/tasks gates open exactly at their
  `unlockLevel` — all four follow the documented "cleared level N-1" convention,
  so they are driven with `completeLevel`/`setCompleted`, never `setLevel`
  (`unlockgate_test.py` owns the convention itself) —
  the wheel offers `spinsPerCycle` spins, the tray lays out `traySlots` slots
  below the 8th slot's gate and `traySlots + extraSlot.grant` cells at it (with
  the capacity still at the base until the video is watched),
  Auto Complete is never offered outside its `minLevel`/`maxTiles` window, and a
  win credits **no coins** — the free faucets are the reward screens, not the win
  itself); and that there is **no second source** — the
  JSON prize tables no longer carry the gates, and the modules the constants came
  from derive them from `CONFIG` instead of re-declaring a literal.
  It also covers the `language` section: an unrecognised tag maps to nothing, a
  fresh player lands on `defaultLanguage`, and the active table really came from
  `textDir`. The `EXPECT` table also carries the `network` section
  (`fetchTimeoutMs` / `retryAttempts` / `retryBackoffMs`), and the no-second-source
  check now includes `src/i18n.js`'s `LOAD_TIMEOUT_MS` (must be derived from
  `CONFIG.network.fetchTimeoutMs`, not a standalone literal) and asserts
  `src/net.js` itself reads `CONFIG.network` rather than carrying its own numbers
  as the source of truth.
  Finally it holds the **written reasoning** to the data: several config comments
  (and the README, and this test's own `EXPECT` commentary) justify a shipped
  value by stating **how long the campaign is**, so every such prose claim is
  scraped out of `src/config.js`, `README.md` and `config_test.py` and checked
  against `len(assets/config/levels.json)`. Growing the level table therefore
  fails this test until the sentences that argue from its length are re-checked —
  which is the point: `features.fortuneWheel.unlockLevel`, `features.tasks.unlockLevel`
  and `boosters.superWand.unlockLevel` are all tuned on that number.

### User profile & persistence

- **`user_test.py`** — a fresh profile has the expected defaults (platform, a
  non-empty id, level 1, nothing completed, zeroed wallet, **no helpers** and no
  unlocks paid out, music/sound on) and progress persists across a reload.
- **`coins_test.py`** — coins are a spendable wallet currency with a top-HUD coin
  pill (lobby + level) that updates live on credit; the Shop lists packages for sale
  and buying one via the mock payment provider grants its contents — a bundle grants
  coins **and** a mix of boosters, a single-item pack grants only coins; winning a
  level pays **no** coins and the win overlay carries no reward — its subtitle is the
  plain "Great matching!" line, with no "+N", no coin icon and no stale "You cleared
  levels 1–3"; the balance persists across a reload.
- **`shopunlock_test.py`** — the **shop's progression gate**
  (`SHOP_UNLOCK_LEVEL` = 3, i.e. **after passing level 2**). Drives `shopState()`
  (`unlocked` / `completed` / `lobbyEnabled` / `lobbyCart` / `gameEnabled`) and
  `tapCoinPill(where)`: a brand-new player and a player who has only cleared level
  **1** get a plain coin counter in **both** scenes — no cart badge, the balance
  still shown, the pill still in `controls()`, and a tap opens nothing. Clearing
  level 2 flips it **live** (no reload) in the level *and* the lobby, the pill then
  opens the shop from either, and the unlock survives a reload (it is derived from
  the persisted `progress.completed`).
- **`unlockgate_test.py`** — **one spelling for every unlock gate**. `src/config.js`
  documents a gate of N as "opens once the player has *cleared* level N-1"
  (`user.completedLevel() >= N - 1`), and the profile's `is*Unlocked()` family is
  the single implementation. The Fortune Wheel and the Daily Bonus used to compare
  the **derived** `progress.level` against a private `unlockLevel` copy instead, in
  four places across three scenes. Two halves. The live half drives the real gates:
  a bare `setLevel` jump to the gate must **not** open the wheel (it opened on the
  spot before — `completed: 1, level: 5, unlocked: True`), clearing level N-1 does
  open it (button on the rail, daily cycle rolled over), walking the level **back**
  afterwards must not take it away again (it re-locked the wheel and the gift while
  the shop, tasks, helpers, Super Wand and 8th slot stayed open — the "replay an
  earlier level" divergence), a gate of `1` still means "from the very start", and
  a sweep over 0..N clears asserts all five feature gates agree with
  `completedLevel() >= unlockLevel - 1` and nothing else. The source half needs no
  browser: only `User.js` and `main.js` may read `progress.level` at all, every
  `is*Unlocked()` on the profile must be spelled the one way (the roster is
  asserted, so a new gate has to be classified), and neither `fortunewheel.js` nor
  `dailybonus.js` may keep a `this.unlockLevel` copy. Gates are moved with the
  `setCompleted(n)` seam — non-monotonic in **both** directions, which
  `completeLevel()` deliberately is not.
- **`reset_test.py`** — resetting the profile restores progress, wallet, and
  settings to defaults while preserving the identity (`id`), and the reset
  persists across a reload.
- **`savefail_test.py`** — a **failed profile write is reported, not swallowed**.
  Two injections, because the two halves of the contract are separable: the real
  adapter against a real broken `localStorage` (`Storage.prototype.setItem`
  patched *after* boot to throw `QuotaExceededError` for `tm3.user:` keys only,
  so identity and language keep working), and a rejecting `store.adapter.save` —
  the cloud-backend shape, using the same monkey-patch-through-`window.__game.store`
  idiom as `reset_test.py`. Under both, `store.saveFailures` climbs,
  `lastSaveError` carries the real error, the `onSaveError` hook fires once, and a
  `console.warn` is emitted — deliberately a **warning**, so `harness.watch()`'s
  console-*error* list (which most tests assert is empty) stays clean and the game
  is shown to keep playing. It also asserts nothing landed while storage was
  broken, that a rejected write does not wedge the store (`_saving` is released
  and the next change still writes), that repairing storage lets the pending state
  through and survive a reload — the retry-on-next-change the store documents —
  and a control case proving a healthy write still counts zero failures.

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
- **`assets_test.py`** — the preload fetches and decodes all 9 audio files exactly
  once, and starting play triggers no asset re-fetch.
- **`tiles_render_test.py`** — the runtime-drawn **tile faces** carry their fruit.
  Regression guard for the iOS "white tiles, no fruit" bug: on iOS/WebKit
  `ctx.fillText` of a colour emoji straight onto a 2D canvas paints nothing, so
  the fix composites the fruit with **`PIXI.Text`** and bakes it over the tile
  body with `renderer.generateTexture` (`src/icons.js`), after awaiting
  `document.fonts.ready`. Drives it via the `window.__game.tileFaces()` hook,
  which renders each fruit emoji through the pipeline (`emojiPaints`, using
  `renderer.extract`): **`fontsReady` true** (the warm-up ran before generation)
  and every **`painted[i]` true** (each emoji rasterizes to colour, not a blank
  glyph). **Note:** the raw iOS failure can't be reproduced in headless Chromium
  (it rasterizes emoji on a 2D canvas fine); the test asserts the fix's mechanism
  and the content invariant, not the device repro.
- **`lazy_test.py`** — levels beyond the preload set are registered but not loaded
  until `ensureLevel` fetches their JSON on demand (and only once). Also the
  **lobby's background prefetch**: booting a profile parked on level 7 puts that
  level's group in the **boot** preload (`bootGroups()`, not merely
  `loadedGroups()` — the distinction is a lobby that is right on its first frame
  versus one that swaps art under the player), so `lobbyBackground()` reads
  `{level: 7, shown: 7}` rather than the level-1 fallback, while the levels around
  it stay lazy. Then the **prefetch ahead**: playing level 7 (`startLevel(7)`)
  must pull `level8`'s group in on its own, since winning lands on that lobby with
  no time to fetch. And the **no-flash rule**: moved on to a cold level
  (`showLobby(10)`), the lobby goes up **immediately** still showing level 7's art
  — `shown: 7`, *not* the level-1 fallback, read in the same `evaluate` as the move
  so no round-trip spends the window — and repaints to `shown: 10` once its own art
  lands, having fetched the group itself with no loading screen.
- **`levels_config_test.py`** — the level table is a JSON config
  (`assets/config/levels.json`) fetched at boot, not a hard-coded array: it's a
  non-empty array of `{background,data,types,preload?}`, the asset manifest's
  per-level groups are derived from it (one per entry, no phantoms), and the
  preload set is exactly `core` + the `preload:true` levels.
- **`levelformat_test.py`** — the board format (`assets/levels/*.tmb`) and the
  parity of the re-encoding. The 1000 boards used to be JSON arrays of
  `"x|y,x|y"` layer strings; `tests/data/level_geometry.sha256` was taken from
  **those** files, before any were converted, so matching it proves the new
  encoding carries exactly the old geometry. The authoritative recomputation runs
  through the **JS** parser in the browser (all 1000 in one `page.evaluate`), not
  the Python one in `tools/levelfmt.py` — a converter's writer and its own reader
  can share a bug and cancel it out, a second implementation in another language
  cannot. `tests/data/level_faces.sha256` goes further for the 28 playable
  levels: it pins the position→**face** map, which a geometry hash cannot see,
  because tile order decides which face lands where. Also: every `levels.json`
  `data` path is an existing `.tmb`; `# . #` and `#.#` are the same row; and both
  parsers reject the same thirteen malformed boards (bad version, ragged row,
  unknown glyph, missing `size`/`anchor`, layer out of sequence, wrong row count,
  `tiles` mismatch, tile total not a multiple of 3, unknown directive, duplicate
  directive).
- **`bgbudget_test.py`** — background art must fit the column it is drawn into.
  Every background reaches the screen through `buildColumnBackground`, which
  *cover-fits* it into the centred 750-design-unit column (plus a blurred backdrop
  for the side margins), so resolution past that point is downloaded on the boot
  path and decoded into VRAM only to be thrown away by the scaler. Static — no
  browser: decoded texture bytes are exactly `w*h*4`, so the files themselves
  decide the answer and a live measurement would only add flakiness. Reads the
  JPEG/PNG headers of everything in `assets/bg/` and asserts each is a JPEG, is no
  wider relative to its height than the 750:1334 crop the column can ever show, is
  within 1500×2668 (2× the design column), and exists if `levels.json` names it;
  then that the `preload:true` payload behind the splash stays under 1.5 MB and the
  whole set under 5 MB. It caught two 6000×4000 JPEGs (92 MB of VRAM each) and an
  11.8 MB three-file boot payload.

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
- **`buttonsound_test.py`** — **one click cue per press** on the shared pill
  button (`makeButton` in `src/layout.js`, DUP-02). The factory replaced a
  `_makeButton` copied into nine modules, six of which were silent and had every
  caller playing `btn_01` from its own handler to compensate — which had already
  drifted into a *missing* cue (Daily Bonus's "Double It" on a cancelled ad) and a
  *doubled* one (the language picker's Back). It presses settings Back, shop Back
  and Buy, the wheel's Back, tasks Back, daily bonus Back / Claim / Double, the
  language picker's Back and Confirm, the Super Wand promo's OK and the level's
  win-overlay Continue — each on the real hit path via `pressPillButton(name)` —
  and asserts `soundLog()` holds exactly one `btn_01` for each. `pillButtonNames()`
  is asserted against the expected roster, so a button that leaves the factory (or
  a new one that joins it) shows up here rather than silently escaping the check.

### Production build

- **`build_test.py`** — the artifact `tools/build.py` produces must be bundled,
  minified, obfuscated, stripped of the debug API, and still boot. No other test
  can catch a broken one: they all serve the **repo root** and drive the game
  through `window.__game`, so none of them would notice if the shipped bundle
  were dead, readable, or still carrying the cheat console. Builds twice into a
  temp directory (never disturbing `./build`): **(A)** the real production build
  — asserts `src/` is one bundle rather than 28 readable modules, that exported
  class names and debug-API method names (`FortuneWheelScene`, `solveTap`,
  `__game`, `__splash`, …) are absent from it, that all five asset groups and the
  1000 level files shipped, that no dev file leaked in, and then serves **the
  build** and boots it: canvas up at design width, splash handed over, zero page
  errors, zero failed requests, and `window.__game`/`window.__splash` genuinely
  `undefined`. **(B)** the same pipeline with `--keep-debug-api`, so the deep
  assertions (level built, config readable, language keys resolved, a level from
  the far end of `assets/levels/` served) can prove obfuscation did not change
  *behaviour*. It then calls `verify()` directly to prove the pre-upload gate
  rejects a damaged artifact — unbundled sources left behind, missing
  `vendor/pixi.min.js`, no levels, malformed JSON — checks the Content-Type map
  sends the bundle as `text/javascript` (a browser refuses anything else), and
  rebuilds the same commit to confirm the output is byte-identical, which is what
  keeps the S3 ETag skip honest.

  Note the lowercase module names (`dailybonus`, …) are deliberately *not*
  asserted absent: they also occur inside asset URLs like
  `assets/config/dailybonus.json`, which must survive for the game to fetch
  anything.

- **`debugseam_test.py`** — every debug seam hung off `window` must sit inside a
  `DEBUG: { … }` block, since `--drop-labels=DEBUG` is the only thing that keeps
  it out of a production bundle. Reads the source rather than running the game:
  strings and comments are blanked out (so a seam in a comment or a string is not
  a false positive), `DEBUG:` blocks are located by brace matching, and any
  `window.x =` or `globalThis.x =` under `src/` outside one fails. It first runs
  the detector over a fabricated file containing two real violations and three
  lookalikes, because a source check that has never seen a violation proves
  nothing; then it asserts the two seams that exist today (`__game`, `__splash`)
  are present *and* guarded — so dropping a label is caught as readily as adding
  an unguarded seam — and that `tools/build.py` really does pass
  `--drop-labels=DEBUG`. No browser, no server; runs in milliseconds.
  It also checks the mirror-image mistake that caused BOOT-001
  (`bootguard_test.py`): `index.html` is a classic script esbuild never touches,
  so it ships into production unchanged, and it must not even **read** `__game`
  or `__splash` — a `window.x =` guard is not enough if something elsewhere just
  asks whether the (always-undefined-in-production) symbol exists. It asserts
  `index.html` names neither symbol at all (comments blanked first, so the
  explanation beside the old guard is free to mention them) and that it reads
  `data-booted`/`dataset.booted` instead, then asserts `src/main.js` sets
  `documentElement.dataset.booted` **outside** any `DEBUG:` block, using the same
  brace-matched ranges as the seam check above.

- **`cloudfront_test.py`** — a deploy finishes by pointing a CloudFront
  distribution's `OriginPath` at the build just uploaded and invalidating the
  edge cache, and none of that can be exercised against real AWS from here (no
  credentials, no network). So the real functions are driven against a **stubbed**
  client (`botocore.stub.Stubber`), which validates every request against the
  actual service model — a malformed `InvalidationBatch` or a missing `IfMatch`
  fails here exactly as it would at AWS. Pins down: the whole
  `DistributionConfig` is written back with only `OriginPath` moved, guarded by
  the ETag it was read with; the **order** — `update_distribution` strictly
  before `create_invalidation`, since the reverse would clear the edge and
  immediately refill it from the old path; that a distribution with several
  origins is never guessed at; that a concurrent edit (`PreconditionFailed`) is
  retried exactly once and not looped; that a rollback to a commit with no
  `build-info.json` in the bucket stops *before* touching CloudFront; and that
  the cache constants still say what the origin switch depends on — assets not
  `immutable`, browsers revalidating, `s-maxage` for the edge. No browser, no
  server, no network.

