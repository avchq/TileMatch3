# Tile Match 3 — Pixi.js Port

A JavaScript/[Pixi.js](https://pixijs.com) port of the Cocos Creator game in
`../cocos` ("Tile Match 3"), a stacked-tile match-3 game. The playable levels are
declared in the JSON config `assets/config/levels.json` (currently **13**).

## Gameplay
On load you land on the **lobby** screen, which shows a big centred
**"Level &lt;n&gt;"** button for the level you're on (progress is saved in
`localStorage`, so it's remembered between visits). Tap it to start.

**Except on a player's very first run.** A **brand-new user** — one who has never
played, has no progress and has never completed level 1 — skips the lobby entirely
and is dropped **straight into level 1**. They meet the lobby for the first time
when they **complete** that level, which is also what ends the first-run flow: from
then on every load lands on the lobby as usual. See `user.isNewPlayer()` /
`progress.completed` in the User section below.

### The "How To Play" popup
The very first thing level 1 does — before the player is handed any control — is
open a modal **"How To Play"** popup over the freshly dealt board. It carries a
single line, **"Collect 3 identical tiles to remove them"**, over an animated
demonstration of exactly that: a small **3×3 board** (three groups of three) above
its own **tray**, with a pointing hand that collects matching tiles one by one —
each flies down into the tray, and the moment the third of a kind lands the triple
pops and vanishes, the ordinary game loop in miniature. The board refills and the
demonstration loops. Its pieces (title, line, the three board rows, the arrow and
tray, the button) **fade in one after another** over spinning light rays.

An **OK** button closes it, and once that fade-in sequence has finished a tap
**anywhere** closes it too. There is **no skip button** anywhere in the sequence.
Closing it also writes a "tutorial done" marker into the browser's own storage
(`localStorage`, separate from the save record) — a leftover from an earlier
design: **nothing in the game ever reads that marker back**.

The popup is tied to *being on level 1*, not to being a new player, so in normal
linear play (level 1 is played once) it is a strictly first-session experience —
but a returning player who replays level 1 does meet it again. Closing it hands
straight over to the guided opening below.

### The guided first level
That first level is deliberately pared back to the one thing there is to learn —
tapping tiles. While a brand-new player is in level 1:
- The top bar shows **only the coin counter**. The **settings** cog is hidden, and
  so is the **shop**: the coin pill keeps the balance but loses its cart badge and
  no longer opens the store.
- There is **no Back button** — the level can't be left before it's played. (There
  is therefore no way to quit level 1 part-way; the only way out is to finish it.)
- **The How To Play popup opens first** (above) and locks the level behind it;
  everything below starts when it closes.
- **The first two moves are played for you.** As soon as the board is built the
  game looks for three identical tiles that are all free to tap right now. Finding
  a group, it flies **two** of them into the tray on their own, with no input, and
  puts an **animated pointing hand** on the third — so the very first tap is
  guaranteed to complete a match and show the whole loop (collect →
  three-of-a-kind → the tiles vanish) in one action. The hand disappears the
  moment **any** tile is collected, and on leaving for the home screen. If the
  board happens not to offer a clean group of three free tiles, the guidance is
  simply skipped and play starts normally.
- **The helpers are locked** (see below), so there is nothing else to press.

The stripped-down treatment applies to *any* play of level 1 while the player is
still brand new, not just the one the boot flow opened; completing level 1 brings
the ordinary interface back.

Tap any **fully-uncovered** tile to move it to the tray at the bottom. The tray
keeps **matching types grouped**: a collected tile drops in next to others of its
kind, or onto the end (top) of the row if its type isn't there yet. Collect
**3 of the same fruit** to clear them. Clear the whole board to win — you're
returned to the lobby, now advanced to the next level. If the 7-slot tray fills
up with no match, you're **out of moves** — a modal **"Out of Moves"** overlay
gives you a second chance instead of a dead end (see below). In-game
**helpers** (boosters), a row of three below the tray: **Reshuffle** (left),
**Wand** (middle), **Undo** (right).
- **Undo** — return the last-added tile (the most recent one, wherever grouping
  placed it in the tray) back to **its original cell on the board**; repeated
  undos walk the stack back in **reverse placement order**. It lands on the exact
  cell even if you tap Undo mid-slide (the in-flight tray-slide animation is
  cancelled first, so the tile can't be dragged to a wrong spot). **Disabled/
  greyed-out when the tray is empty**, as there's nothing to undo.
- **Wand** (magic hint) — **guarantee one instant match**: the tiles needed to
  complete a triple fly from the board into the tray and immediately clear,
  relieving tray pressure. It **prioritises available tiles** — the free,
  top-layer, tappable ones — and only reaches into **unavailable** tiles (the
  greyed-out ones still covered on a lower layer) when a colour hasn't enough
  free tiles left to finish its triple. So it first picks the completion that
  uses the **fewest covered tiles** (an all-available triple beats one that must
  dip into a covered tile), and only then the cheapest completion — a colour
  already holding a **pair** in the tray (pull 1 more, frees two slots), else a
  colour holding a **single** (pull 2), else a fresh colour off the board (pull a
  full 3). Within a colour, tiles are drawn most-accessible-first so the move
  reads as one you could have made.
- **Reshuffle** — redeal the faces of the tiles still on the play board into a
  fresh arrangement that's still guaranteed solvable; the bottom tray/deck is
  left untouched, and positions and progress are kept, so the level is **not**
  restarted.

**Helpers are not available in the first levels.** A new account is awarded
**none of them**, and each one **unlocks at its own level** — **Undo** from level
2, **Reshuffle** from 4, **Wand** from 5 — paying out a small starter stock the
moment it unlocks (once, and only once). Until then the button still shows its
icon, so the row is familiar by the time it comes alive, but it is **dimmed and
wears a 🔒 lock badge** and cannot be used: a tap plays a "nope", shakes the
button and floats an **"Unlocks at Level N"** label above it. "Unlocks at level N"
means the player has **cleared level N-1**. The schedule is a single table,
`BOOSTER_UNLOCKS` in `src/user/User.js`.

Once unlocked, a helper is drawn from a **limited inventory** stored on the player
profile — a count **bubble** on the button shows how many uses remain and every use
spends one. When a helper hits **0** it doesn't just disable — tapping it walks an
**acquisition ladder** so you can keep playing:
1. **Own one** → the bubble shows the remaining **count** (green) and a tap spends
   one, as usual.
2. **Out of stock, can afford one** → the bubble shows the **coin price** (a gold
   coin + amount); a tap **buys one with coins** from your wallet and uses it in
   the same press (net inventory unchanged, coins spent).
3. **Out of stock and can't afford one** → the bubble shows a **"watch an ad"**
   icon (📺); a tap grants a **free** use via a rewarded ad. *(No ad network is
   wired up yet — the tap grants the reward immediately; the icon is the
   placeholder.)*

An *unlocked* helper is only **disabled/greyed** when there's **no move to make**
(e.g. Undo with an empty tray), never merely because stock ran out — the ladder
always yields a use. A **locked** one is greyed regardless: no amount of coins
buys past a progression gate. The **coin prices** live
in a JSON config (`assets/config/prices.json`) so they're tunable without touching
code.

### Out of Moves — a paid second chance
When the 7-slot tray fills with no match left, a strictly **modal "Out of Moves"**
overlay appears (the dim swallows all taps — there's **no way to close it** except
its three buttons):
- **Home** — leave to the lobby with progress kept.
- **Replay** — restart the level from scratch.
- **Continue** — **pay to keep playing this very board**. It follows the same
  **waterfall** as the boosters: if you can **afford** the coin price, the button
  shows a **gold coin + price** and a tap **spends coins**; if you **can't afford**
  it, the button shows a **📺 "watch an ad"** tag and a tap grants a **free**
  continue via a rewarded ad *(stubbed — grants immediately)*. On Continue, every
  collected tile **flies back to its original board cell** — animated, **one at a
  time**, in **reverse placement order** (newest first, exactly as a rapid run of
  **Undo**s pops them off the top of the stack); input is locked until the last tile
  lands, then play resumes. The continue **price** lives in the
  same `assets/config/prices.json` (the `continue` key), so it's tunable without
  touching code.

**Coins** are a spendable currency shown in a **coin pill** at the top-right of
both the lobby and the level HUD. You **earn 25 coins for clearing a level** (the
win overlay shows the reward). Tapping the coin pill opens the **Shop**, which sells
**packages** for real money — each grants a mix of contents (a coins amount and/or a
set of boosters), so a package can be a single item (just coins) or a bundle (e.g.
1200 coins + 3 wands + 5 undos + 1 reshuffle). See the Shop + User sections below.

When the board is down to a **trivially solvable endgame** — **12 or fewer tiles
left** (≤ 4 easy triples) with **nothing still covered** — an **Auto Complete**
button appears in the helper row, **replacing** the three helpers. It's **free**
(not a booster). Press it and every remaining tile gathers into a pile, then
flies one-by-one along a curved path into the tray's first slot, popping on
arrival — when the last one lands, the level is won. It is **not offered on
level 1** — the teaching level is played by hand all the way to the win — so it
first appears on level 2. The **cog** (top-left) opens Settings and the
**‹ Back** button beside it leaves the level for the lobby with progress kept.

### Fortune Wheel — a daily prize wheel
A **prize wheel** reached from the lobby (not part of a level): a daily-return
hook that hands out coins and boosters used elsewhere. A persistent **wheel
button** sits in the lobby's **top-left corner, right under the settings cog** —
it **beats slowly** at rest (a gentle grow/shrink) and its little wheel **spins**
both **periodically on its own** (every few seconds — spins up, the pointer flicks,
winds down) and **on mouse-over** (a hover kicks off a spin unless one's already
running); it swells while hovered. It carries a
**NEW** badge until the wheel is opened for the first time ever, and a **free-spin**
badge whenever the current cycle's free spin is unclaimed (the badge drops the
moment that spin is used, live, with no reload). The button only appears once the
player has **progressed to the unlock level** and hides again once the day's spins
are used up, reappearing at the next daily rollover.

Prizes are organised into **groups** — one wheel's worth each — and the wheel is
built from the **active group** (its slice count comes from the group, not a fixed
number). The active group **advances once per calendar day** (wrapping after the
last), and that rollover also clears the per-cycle state (spins taken + the list of
prizes already won). The rollover is checked continuously while running, so leaving
the game open across midnight still yields a fresh cycle.

Each **cycle allows a fixed number of spins**; the **first is free** and every spin
after costs a **rewarded video** (stubbed — grants on a successful view; cancel or
failure spends nothing, and a failure shows a brief "ad not available" message).
The result is **decided before the wheel turns**, then it animates to the winning
slice (accelerate → hold → decelerate, with a marquee lamp ring that blinks idle /
chases while spinning / flashes on a win). The red pointer at the top pivots about
its tip where it rests on the rim and **leans in the direction of the spin** — hard
while the wheel is fast (with a slight rattle), easing back to upright as it slows,
so it ends pointing straight at the winning slice. A prize can only
be **won once per cycle** — the pool shrinks each spin and won slices are marked.
On landing, the prize **flies to its top-bar counter**, which ticks up; the
headline prize gets an extra highlight before it collects. After the last spin the
wheel closes itself back to the lobby.

The prize table and constants live in `assets/config/turntable.json` (groups of
prizes, each with an `amount` and independent `freeWeight`/`adWeight`, plus
`unlockLevel`, `spinsPerCycle`, and which prize `type` is the `headlinePrize`), so
odds and pacing are tunable without touching code. Prize types map to this port's
economy: `coins` → wallet, `undo`/`wand`/`shuffle` → boosters (the original's
"Hint" is this game's **wand**), and `lightning` → a coins bonus (kept as the
headline prize). **Note:** the shipped `unlockLevel` is **5**, but this port
currently ships only **4** levels, so with the default the button won't appear in
normal play until more levels exist — lower `unlockLevel` in the config to demo it.

### Daily Bonus — a free once-a-day gift
A second daily-return hook, separate from the wheel and **not** a login-streak
calendar: there is no Day 1→7 chain, no streak, and no penalty for missing a day.
A **gift button** sits in the lobby's **top-left corner, under the wheel button**;
it **beats slowly** (a looping grow/shrink) and — unlike the wheel — carries **no
badge**, because the beat itself is the "unclaimed" indicator; layered on top, the
gift gives a little squashy **hop** every few seconds (the same ~5s cadence as the
wheel's self-spin) to draw the eye. On **mouse-over** the button swells and the
gift **wiggles**. The button **only
appears while today's gift is unclaimed** and hides the moment it's claimed,
returning at the next calendar-day rollover. Eligibility is a plain **"has the
calendar date changed since the last claim?"** check — a **midnight reset, one
claim per day**; the **only** thing persisted is the day-key of the most recent
claim (`user.dailyBonus.lastClaimDay`).

Opening the popup shows **three closed mystery boxes** (green / red / blue) bobbing,
with a "Pick a box!" tip. Three prizes are **pre-rolled** — one behind each box, each
an independent weighted draw. Tapping a box **commits today's claim then and there**
(so the boxes can't be re-rolled), slides it to centre, lifts its lid, and reveals
the prize (icon + name + amount + a rotating shine + a "Congratulations" line); the
other two boxes never open. After the reveal a **"📺 Double it!"** button appears
first and a plain **Claim** button fades in about **two seconds later** — the
interface nudges toward the ad. Watching the (stubbed) rewarded video **doubles** the
revealed amount; if the ad isn't ready the player is told so and can still take the
base prize. Either way the reward is credited (coins → wallet, boosters →
inventory, flying to its top-bar counter) and the popup closes.

The prize pool lives in `assets/config/dailybonus.json` — a list of
`{ type, amount, weight }` rows (`type`: `coins`/`undo`/`wand`/`shuffle`; the
original's "Hint" is this port's **wand**) plus an `unlockLevel` (shipped as **1**,
so it's available from the start). The draw is **weighted**, strongly favouring
small coin amounts and rarely giving boosters — tune the odds by editing the
weights, no code change.

## Run it
Because it uses ES modules and `fetch`, it must be served over HTTP (not
opened via `file://`):

```bash
cd JS
python3 -m http.server 8099
# then open http://localhost:8099/index.html
```

## How it maps to the original
- **Levels** (`assets/levels/level{1,2,3}.json`) are the *decrypted* Cocos
  level blobs (XXTEA, via `../cocos/tools/level_crypto.py`). Each is an array of
  layer strings of `x|y` grid positions — bottom layer first, upper layers
  offset by 0.5 so a tile straddles up to four below it.
- **Backgrounds** (`assets/bg/*.jpg`) and **audio** (`assets/audio/*.mp3`) are
  the original Cocos native assets, copied and renamed.
- **Tile faces** are regenerated at runtime (`src/icons.js`) as emoji on white
  tiles — the original per-theme icon atlas was not among the downloaded Cocos
  native files, so an equivalent 20-icon food set is drawn instead.

## Design notes
- `src/level.js` assigns tile types with a **guaranteed-solvable** generator: it
  derives a valid removal order (a linear extension of the covering DAG) and
  gives each consecutive triple one type, so every board can always be cleared
  with only 3 tray slots. The number of distinct types is **per-level**, set by
  the `types` field of each entry in `assets/config/levels.json` (resolved by
  `src/levelConfig.js`) — either a fixed integer or a `[min, max]` **range**
  resolved to a count that is random but deterministic per level (every type is
  guaranteed to appear on the board).
  Tile **positions** come straight from the
  level file, and the type assignment is seeded **only from the level number**
  (`game.js` `loadLevel`), so a level's layout is **deterministic** — the same
  fruit is in the same spot on every load/reload/session. (**Reshuffle** is the
  intentional way to re-randomise the faces mid-game.)
- `src/game.js` holds the `GameScene` (board layout, coverage/free-state logic,
  tray, matching, win/lose, animations). The tray keeps same-type tiles grouped
  as they're collected while `history` records raw add-order, so **Undo** always
  pops the most recently added tile and snaps it back to its **original board
  cell** (`_layoutBoard` recomputes each tile's home from its immutable grid
  coords). `undo()` first **cancels the tile's in-flight tray-slide tween**
  (`container.__mv`) before reparenting — otherwise a quick undo (mid-slide) would
  let that tween keep pulling the tile toward its old tray slot and strand it at a
  wrong position. (The micro-animators also bail if their container is destroyed
  mid-tween — e.g. a level reload — so a leftover tween can't crash on a null
  transform.) The **Undo**, **Wand**, and **Reshuffle**
  helpers draw from the player's booster inventory through an **acquisition ladder**
  (`_acquireBooster(kind)`): use owned stock (`user.useBooster`), else buy one with
  coins (`_buyBooster` → `user.debit("coins", price)` + `grantBooster`), else watch
  a rewarded ad (`_watchAd`, a stub that grants for free — no ad SDK yet). The
  press grants-then-uses, so the buy/ad tiers leave the net inventory unchanged.
  Each button's badge (`_setBoosterButton` / `_makeCountBadge.setBadge`) reflects
  the tier: the remaining **count** when stocked, the **coin price** when empty but
  affordable, or a **📺 "watch an ad"** icon when empty and unaffordable. A helper
  is disabled/greyed **only when there's no move to make** — Undo with an empty
  tray, Wand/Reshuffle with an empty board — never merely at 0 stock (the ladder
  always yields one). The coin prices come from `assets/config/prices.json`
  (loaded in `main.js`, passed to `GameScene`).
  Ahead of all of that sits the **progression gate**: `_setBoosterButton` short-
  circuits to a `"locked"` mode (dimmed button, 🔒 badge) while
  `user.isBoosterUnlocked(kind)` is false, and `undo()` / `wand()` / `reshuffle()`
  each open with `_rejectIfLocked(kind, btn)` — so a scripted call
  (`window.__game.wand()`, `scene.undo()`) is refused exactly like a tap, before
  the ladder can spend anything. A refusal plays `fail`, `_shake`s the button and
  floats an **"Unlocks at Level N"** pill (`_showBoosterHint`), replacing any hint
  already up.
  **Wand** (`wand()` / `_wandPick()`) completes exactly one triple. Over every
  colour that can still reach a triple, `_wandPick` ranks completions by (1) the
  **fewest covered/unavailable tiles used** — so available (free, top-layer)
  tiles are spent before ever touching a still-covered tile — then (2) the
  cheapest completion (waiting pair → single → fresh board colour), then a
  tray-order/face-id tiebreak. It flies the missing tiles in
  most-accessible-first and locks input until the triple resolves so a rapid
  double-tap can't spend two charges. (An upgraded
  "super" wand tied to a win-streak meta shares the button but isn't built.)
  **Auto Complete** (`autoComplete()` / `_autoAvailable()`) is a **free** endgame
  shortcut, not a booster: from `AUTO_MIN_LEVEL` (2) onward, when
  `boardCount + tray.length ≤ 12` and no board tile
  is still covered, `_updateBoosters` swaps the three round helpers for a wide
  **Auto Complete** pill in the same row. Pressing it stages every remaining tile
  on `fxLayer`, gathers them into a pile, then flies each along a quadratic
  Bézier into the tray's first slot (staggered), `_popMatch`-ing it on arrival,
  and calls `_win()` once the board is empty. Level 1 is exempt (the guided level
  teaches the loop; a free "finish it for me" would cut that short), so
  `_autoAvailable()` tests `levelNum >= AUTO_MIN_LEVEL` first.
  Input is locked for the whole sweep
  (`_autoRunning`), which is reset in `loadLevel` so the next level's helper row
  returns. On a win it calls back to the host
  (`onLevelComplete`) rather than self-looping; the top-left **Back** button
  leaves the level for the lobby mid-level (progress untouched) through `_exit()`
  — the single exit path, so the guidance hand and any floating hint can't be left
  behind on a hidden scene.
  The **"How To Play" popup** (`src/tutorial.js`, `HowToPlayPopup`) is opened by
  `loadLevel` whenever `levelNum === TUTORIAL_LEVEL` (1) — the gate is the level
  number, not `isNewPlayer()`. `_showTutorial()` locks the scene, adds the popup to
  its own **`tutorialLayer`** (above `overlayLayer`, deliberately not on it, so
  `overlayLayer.children.length` keeps meaning "a win/lose overlay is up") and
  captures the current `_guideRun`. The popup owns a modal dim (`eventMode:"static"`,
  swallowing every tap) plus a centred group — panel, spinning `rays` `Graphics`,
  title, line, the mini board/tray/arrow demo and the **OK** button — laid out
  exactly like `_showOverlay`'s group, and re-centred from `GameScene.layout()`.
  `open()` fades the pieces in one after another (~1.6 s) and then sets
  `introDone`, which arms tap-anywhere-to-close and starts `_runDemo`: a loop that
  walks the hand over each matching triple, flies the tiles into the mini tray and
  pops them, then resets the mini board. Every step is guarded by the popup's own
  generation token (`_run`, bumped by `close()`), the same pattern the guided
  opening uses. `close()` writes the `tilemaster.tutorialDone` marker (nothing
  reads it back), calls its `onClose` **immediately** — which unlocks the scene and
  fires `_runFirstRunGuide()` when `_firstRun`, so the demo moves follow the
  explanation — and fades itself out. `_closeTutorial()` tears it down *without*
  the callback from `loadLevel` and `_exit()`, so a popup can't outlive its board
  or be left on a hidden scene. It is not listed in `controls()`, like the win/lose
  overlays.
  The **guided first level** hangs off `loadLevel`, which sets
  `_firstRun = user.isNewPlayer() && levelNum === 1`, calls
  `_applyFirstRunChrome()` (hides `cog` + `backBtn`, `coinPill.setShopEnabled(false)`
  — the hidden controls drop out of `controls()` on their own, since the host skips
  invisible objects) and, once the board is placed, fires `_runFirstRunGuide()`.
  `loadLevel` returns with the board fully interactive — `_layoutBoard` positions
  tiles outright, there is no build-in animation — so that *is* the "board
  finished building" moment. The guide picks a triple with `_findGuideTriple()`
  (free tiles grouped by `type`, lowest type id first, so it's deterministic for a
  given seeded board), locks input, `_collect`s two of them on a timer, then calls
  `_showHand(tile)` — a `PIXI.Text("👆")` plus a ripple `Graphics` on `fxLayer`,
  driven by a ticker loop (`_handAnim`) and repositioned from `layout()` since
  `_layoutBoard` moves its target. `_hideHand()` runs from `_collect` (so **any**
  collection dismisses it), `loadLevel` and `_exit`. Every `await` in the guide is
  guarded by a **generation token** (`_guideRun`, bumped in `loadLevel`): without
  it, re-entering level 1 mid-sequence would leave the previous run collecting
  tiles off the old board.
  **Out of Moves** (`_lose()` → `_showLoseOverlay()`): a full tray no longer
  dead-ends. `_lose` shows a **modal** overlay (its dim is `eventMode:"static"`, so
  it swallows every tap and there's no close affordance) with **Home** (`onExit`),
  **Replay** (`restart`), and **Continue**. Continue reuses the booster
  **waterfall**: if the player can afford `continuePrice` (from `prices.json`'s
  `continue` key) the button shows a coin price and `_continueAfterLoss` **debits
  coins**; otherwise it shows a 📺 tag and grants a **free** continue via a stubbed
  rewarded ad. On continue it closes the overlay and `_returnTrayToBoard()` flies
  every collected tile home — **animated**, one at a time, staggered over `history`
  in **reverse placement order** (newest first — `history.slice().reverse()`, the
  order a rapid run of **Undo**s would pop them). Each tile reuses the same
  `_returnTileToBoard(t)` state primitive **Undo** uses (cancel any in-flight tray
  tween, restore coverage/`boardCount`, reparent to the board); the tile then tweens
  from its tray slot to its home cell (`_layoutBoard` supplies the target). Input
  stays **locked** for the whole fly-back and unlocks when the last tile lands.
- `src/lobby.js` is the `LobbyScene` (landing/home screen) with the centred
  **"Level &lt;n&gt;"** play button and title.
- `src/shop.js` is the `ShopScene` — an overlay (modeled on `SettingsScene`)
  opened by tapping the **coin pill** in either scene. It lists the **packages** for
  sale (from `payments.js`), each row showing the package name, a one-line contents
  summary (coins + booster icons), and a price button. Buying is delegated to the
  host's `onBuyPackage`, which runs the platform payment provider and, on success,
  applies the contents (`user.credit("coins", …)` + `user.grantBooster(kind, n)`).
  `shop.js` also exports **`makeCoinIcon(r)`** — the coin is **drawn as a gold coin**
  (not the 🪙 emoji, which some hosts render silver) so it's a consistent gold
  everywhere it appears (HUD pill, shop balance header, package contents, the win
  reward) — and **`makeCoinPill(user, onTap)`**, the shared coin-balance HUD control
  used by both the lobby and the level: a gold coin + the live balance + a small
  **shopping-cart** icon signalling that a tap opens the shop. It live-refreshes on
  any `wallet` change (parallel to `makeCogButton` in `settings.js`). The coin reward for
  a win is `COIN_WIN_REWARD` in `game.js` (`_win()`). (Spending coins on helpers is
  done on-demand inside a level, not in the shop.)
- `src/fortunewheel.js` is the `FortuneWheelScene` — the daily prize-wheel overlay
  (modeled on `ShopScene`: full-screen dim + centred panel + `easeOutBack` pop +
  `layout` reflow), opened from the lobby's wheel button. It folds together the
  per-cycle **logic** and the **presentation** the Cocos original split across a
  manager and a view. Persisted state lives on the User model (`user.fortuneWheel`:
  `group` / `day` / `spinsUsed` / `won` / `seen`); `checkRollover()` compares the
  stored day-key to today and calls `user.advanceWheelCycle()` (advance group + wrap
  + clear) on a change — driven both on open and from a low-frequency `main.js`
  ticker so a mid-session midnight still rolls over. A spin **records the spin +
  won slice up front** (so a rapid double-tap can't spend two spins and a prize
  can't repeat — `_spinning` gates re-entry), picks the winner by weighted random
  over the not-yet-won pool (`freeWeight` on the free spin, `adWeight` after —
  never collapsed), animates to it (`_spinWheelTo`), then **grants on the fly's
  landing** (`user.credit`/`user.grantBooster`, so the top-bar counter ticks in
  sync). The prize table + constants come from `assets/config/turntable.json`
  (loaded in `main.js`, passed to the scene); a missing/failed config degrades to
  no groups (button stays hidden). The lobby button, its animation (a slow rest-beat
  plus a wheel spin that fires both periodically and on hover — see
  `_startWheelSpin`), the NEW /
  free-spin badges, and its progression gate live in `src/lobby.js`
  (`_makeWheelButton` / `_startWheelSpin` / `_refreshWheelBtn`), reading the wheel's
  `unlockLevel` / `canSpin()` and refreshing live on `user` `fortuneWheel`/`progress`
  changes.
- `src/dailybonus.js` is the `DailyBonusScene` — the free once-a-day gift overlay
  (modeled on `FortuneWheelScene`: full-screen dim + centred panel + `easeOutBack`
  pop + `layout` reflow), opened from the lobby's pulsing gift button. It has no
  stored cycle: `canClaim()` derives eligibility straight from the persisted
  day-key (`user.dailyBonus.lastClaimDay`) vs `_today()` — no streak, no
  advance-cycle. `open()` pre-rolls three independent weighted draws
  (`_rollBoxes` / `_pickIndex`, honouring a `_forceIndex` test seam); `_openBox(i)`
  **commits the claim up front** (`user.recordDailyClaim` — hides the lobby button,
  no re-roll), animates the box open, and reveals the prize. `_double()` watches a
  stubbed rewarded ad (`_adResult` seam: `succeed`/`cancel`/`fail`) to double the
  amount; `_take(multiplier)` flies the icon to its HUD counter and grants on
  landing (`user.credit`/`user.grantBooster`), then closes. The prize pool +
  `unlockLevel` come from `assets/config/dailybonus.json`; a missing/failed config
  degrades to an empty pool (button stays hidden). The lobby button, its animation
  (a slow rest-beat, a periodic squashy hop, and a swell-plus-gift-wiggle on hover —
  see `_startDailyPulse`),
  and
  its gate live in `src/lobby.js` (`_makeDailyButton` / `_startDailyPulse` /
  `_refreshDailyBtn`), refreshing live on `user` `dailyBonus`/`progress` changes and
  from the same low-frequency `main.js` ticker as the wheel (so a lobby left open
  across midnight re-shows the gift).
- `src/tutorial.js` is the `HowToPlayPopup` — the modal tutorial level 1 opens
  before play (see the Gameplay section and the `GameScene` notes above). Unlike
  the other overlays it is **owned by the level scene**, not by `main.js`: it lives
  on the scene's `tutorialLayer`, is created/destroyed by `loadLevel` / `_exit`, and
  re-centres from `GameScene.layout()`. It draws its own mini board and tray from
  the game's real tile/slot textures, and carries its own copy of the standard
  button (`_makeButton`) so it stays independent of the scene.
- `src/settings.js` is the `SettingsScene` — an overlay opened by the **cog
  button** in the top-left of both the lobby and the level. It has **Music** and
  **Sound** toggles (driving `audio.setMusic` / `setSound`, which persist to the
  User object) and a **Back** button that returns to the scene underneath.
- `src/main.js` boots Pixi, owns the lobby ⇄ game flow, and reads/writes player
  state (level, settings, wallet) through the **User object** (see below). The last
  step of boot is the **first-run branch**: `user.isNewPlayer()` → `startLevel(1)`
  (skip the lobby), else `showLobby(currentLevel)`; `onLevelComplete` records the
  clear with `user.completeLevel(n)` — which is what makes the player no longer new
  **and** what pays out any helper unlock that just came due — before advancing the
  level and returning to the lobby. On boot
  it `loadLevels()` (fetches `assets/config/levels.json`) then `buildLevelGroups()`
  to populate the asset manifest; the highest playable level is simply that list's
  length (`levels.length` — there is no separate `MAX_LEVEL` constant). It
  also constructs the **Shop** overlay and the **payment provider**
  (`makePayments`), wires the coin-pill taps to open the shop, and owns
  `purchasePackage` (run the provider, then grant the package's coins + boosters on
  success).
- **Responsive layout** — the game is a **fixed-width 750-unit vertical column**
  that is centred on any screen and never stretched sideways (matching the Cocos
  original). `main.js`'s `resize()` sizes the renderer to the whole viewport and
  uniformly scales the stage by `min(vw/750, vh/1334)` — so the game column always
  maps its 750-wide design onto the screen without distortion — then hands each
  scene the resulting design area (`DW×DH`) via `scene.layout(DW, DH)`.
  - **Portrait / narrow screens** (up to 9:16) are *width-constrained*: the 750
    column fills the full width and the extra height becomes vertical margin — the
    top HUD anchors to the **top** edge, the tray + helper row anchor to the
    **bottom** edge, and the board fills (and recentres in) the band between.
  - **Wide screens** (wider than 9:16) are *height-constrained*: the 750 column is
    **centred** and its extra horizontal space is filled with a **blurred copy of
    the background** — the game is never blown up to the full width. The crisp
    background covers only the centred column; a blurred, cover-fit copy fills the
    sides (`layout.js` `buildColumnBackground`). Corner chrome (settings cog, coin
    pill, Fortune Wheel / Daily Bonus buttons) therefore rides the **corners of the
    column**, not the physical screen corners.
  - The **board is sized to the 750 column**, not the viewport
    (`GameScene._layoutBoard` fits it by `min((min(viewW,750)-60)/spanX,
    areaH/spanY)`), so on a wide screen the tiles stay column-sized and the play
    area is a vertical strip — they do not grow edge-to-edge. On a taller screen
    the column simply gains vertical room (bigger board band).
  - `GameScene.layout` reflows the board/tray/overlay live, so a mid-level rotate
    or resize just re-lays-out in place. The **bottom tray is sized to the current
    level's tile size**, not a fixed slot: a board tile is drawn at `TILE_DRAW(96) *
    boardScale`, so `_layoutBoard` sizes each tray slot to match (a collected tile
    keeps its size flying into the tray), **clamped** to `[SLOT_MIN, SLOT_MAX]` so
    the 7-slot row always fits the 750-wide column (`_layoutTraySlots` redraws the
    panel + slots on any change).
  - Because `resize()` uses the **min** scale, the design area is always **≥
    750×1334 in both axes** — content is never compressed, only given extra margin —
    which is the property that keeps controls from overlapping across
    resizes/rotations. The shared reflow helpers live in **`src/layout.js`**
    (`DESIGN_W/H`, `coverBackground` / `buildColumnBackground` for the
    column-plus-blur background, `fitTextWidth` to keep centred text inside the safe
    centre band, and `fitPanel` — a defensive clamp that scales a centred overlay
    panel down if its content would ever outgrow the view). Every scene exposes a
    `controls()` list of its independent controls, aggregated by
    `window.__game.controls()` (design-space rects) and asserted overlap-free by
    `tests/resize_overlap_test.py`.
- Pixi is vendored at `vendor/pixi.min.js` (v7.4.2).

### Levels (`assets/config/levels.json` + `src/levelConfig.js`)
Every level is declared in **one place** — the JSON array in
`assets/config/levels.json` (a tunable data config alongside `prices.json` /
`turntable.json`). Each entry is `{ background, data, types, preload? }` (paths to
a background image and a level-data JSON, the count of distinct tile faces the
level uses — an integer or a `[min, max]` range drawn deterministically per level
— plus an optional preload flag). `src/levelConfig.js` fetches this file at boot
(`loadLevels()`) and owns the type-count logic (`typesForLevel()`).
**Adding a level is a single one-line append to the JSON** — nothing else needs
editing:
- The highest playable level is simply the array's **length** (`levels.length`,
  read by `main.js` and passed to the lobby) — there is no separate `MAX_LEVEL`
  constant.
- `src/assets.js` builds its load **manifest** from the loaded table via
  `buildLevelGroups()` (level *N* ↔ entry *N-1*), so a new entry is automatically
  loadable.

### Asset management (`src/assets.js` + `src/audio.js`)
Assets are organised into groups: a shared `core` group plus one `levelN` group
per level, the latter generated from the `levels.json` config above.
- **Preload** — on boot, `AssetManager.preload()` loads the essential minimum:
  `core` audio + every level flagged `preload: true` in the config (backgrounds
  + level data).
- **Lazy load** — any level *not* flagged for preload is fetched on demand via
  `ensureLevel(n)` (called from `startLevel`), so its assets download only when
  the player reaches it. Loads are idempotent and de-duplicated (cached results
  + shared in-flight promises), so nothing is fetched twice.
- **Audio** uses the **Web Audio API**: each file is fetched and decoded into an
  in-memory `AudioBuffer` **once**, and every play spins up a throwaway
  `AudioBufferSourceNode`. Sounds overlap freely and playback makes **no network
  request** — replacing the old HTML5-`Audio` `cloneNode()` approach that
  re-fetched the file from the server on every single play.
- **Background music** starts in the lobby on initial load. Browsers that block
  autoplay before a user gesture start it on the first pointer interaction
  instead. **Music** (bgm) and **Sound** (sfx) are two independent channels
  (`audio.setMusic` / `audio.setSound`), toggled from the **settings screen**
  (see below). Both preferences live on the User object (see below). When the
  tab is hidden (player switches to another tab / minimises) the audio context is
  **suspended** so nothing is audible, and resumed on return — *without* changing
  the saved music/sound settings (`audio.setPageVisible`, driven by
  `visibilitychange`).

### User & persistence (`src/user/`)
All per-player state lives on one platform-agnostic **`User`** object, ready for
publishing on **Facebook Instant, Reddit, and Telegram**:
- **`User.js`** — the model: a stable `id`, `platform`, `progress` (`level`, the
  next level to play, plus `completed`, the highest level ever cleared — 0 for a
  player who has never finished level 1; `completeLevel()` records a clear and
  `isNewPlayer()` = "level 1 and nothing completed", the gate the first-run flow
  reads),
  a **multi-currency `wallet`** (`coins`, `gems`, … — a keyed map, so new
  currencies need no code change: `credit`/`debit`/`balance`/`canAfford`), a
  **helper/booster inventory** (`boosters` — a keyed map of
  `undo`/`shuffle`/`wand`… → remaining uses, mirroring the wallet:
  `boosterCount`/`hasBooster`/`grantBooster`/`useBooster`; a new account is awarded
  **none**), the helper **unlock schedule** (`BOOSTER_UNLOCKS`, an exported table of
  helper → `{ level, grant }`: `boosterUnlockLevel(kind)` and
  `isBoosterUnlocked(kind)` — the latter derived from `completed`, so a jump
  straight to a later level is honoured with no bookkeeping to repair — plus
  `boosterUnlocks`, the list of helpers whose one-time grant has already been paid.
  `completeLevel()` calls `_grantPendingUnlocks()`, which is what pays it out, once),
  `settings` (`music`, `sound`), and the **Fortune Wheel**
  per-cycle state (`fortuneWheel` — `group`/`day`/`spinsUsed`/`won`/`seen`, mutated
  via `advanceWheelCycle`/`recordWheelSpin`/`markWheelSeen`, emitting a
  `fortuneWheel` domain), and the **Daily Bonus** claim state (`dailyBonus` —
  just `lastClaimDay`, the day-key of the most recent claim, mutated via
  `recordDailyClaim`, emitting a `dailyBonus` domain). It emits a domain-tagged
  change event on every mutation and (de)serializes via `toJSON`/`fromJSON` with a
  `version` for forward migrations (currently **v5** — v1→v2 added `fortuneWheel`,
  v2→v3 added `dailyBonus`; both fill from defaults for older blobs, so each step
  just stamps the version. v3→v4 added `progress.completed`, **derived** as
  `level - 1` — levels only ever advanced on a win — so an existing player is never
  mistaken for a brand-new one and thrown back into level 1. v4→v5 moved helpers
  behind the unlock schedule: existing players were handed a starter stock up
  front, so it seeds `boosterUnlocks` with everything they have already reached —
  otherwise their next win would pay out a second grant on top — and **zeroes** the
  stock of anything still locked, since a v4 profile that never cleared a level was
  carrying helpers it should not have).
- **`adapters.js`** — a small **async** storage/identity contract
  (`identify` / `load` / `save` / `clear`). `LocalStorageAdapter` is the working
  default on the open web. `FacebookInstantAdapter` / `TelegramAdapter` /
  `RedditAdapter` are **stubs** that persist to `localStorage` for now and mark
  the exact SDK calls (`// TODO(SDK):`) to swap in later (`FBInstant.player`,
  `Telegram.WebApp.CloudStorage`, Devvit KV) — no code outside this file changes
  when a platform is wired in for real. Identity is platform-owned and fixed;
  `clear()` wipes the *data*, never the id.
- **`payments.js`** — the **real-money purchase** contract, mirroring `adapters.js`
  (one small async surface per platform): `getCatalog()` + `purchase(productId)`.
  It exports the **`PACKAGES`** catalog — each package has an id, price, label, a
  `coins` amount, and a `boosters` map (helper → count), so a package is a single
  item (just coins) or a bundle. `MockPaymentProvider` is the working default on the
  open web (it "succeeds" instantly with **no real charge**, so the flow is
  testable). `FacebookInstantPayments` / `TelegramPayments` / `RedditPayments` are
  **stubs** extending the mock, each marking the exact SDK calls to swap in later
  (`// TODO(SDK):` — `FBInstant.payments.purchaseAsync`, `Telegram.WebApp.openInvoice`
  for Stars/XTR, Devvit payments over the webview bridge) plus a `// TODO:` for
  **server-side receipt validation before granting**. The provider is pure I/O: on
  success it reports the package contents and the **host** (`main.js`
  `purchasePackage`) applies them (`user.credit` + `user.grantBooster`), keeping the
  trust boundary in one place. `makePayments(platform)` picks the provider at boot
  (parallels `makeAdapter`).
  - **Adding a package is a single append** to the `PACKAGES` array in
    `payments.js` — nothing else needs editing. Give it a unique `id`, a `price`
    string, a `label`, and its contents (`coins` and/or a `boosters` map, e.g.
    `{ id: "power_pack", price: "$2.99", label: "Power Pack", coins: 200, boosters: { wand: 2 } }`).
    The Shop builds its rows from `getCatalog()`, and the host grants the contents
    generically, so the new package shows up and works with no UI or grant-logic
    change. (For a real platform launch you must also register that `id` as a
    product in the platform's store/catalog — Facebook / Telegram Stars / Devvit —
    per the `// TODO(SDK):` markers; on the open-web mock provider no registration
    is needed.)
- **`platform.js`** — `detectPlatform()` + `makeAdapter()` pick the adapter at boot.
- **`UserStore.js`** — resolves identity, loads/creates the profile, and
  **autosaves** (debounced) on every change plus a flush on tab hide/close. The
  save is **serialized (last-write-wins)** so the slow, async cloud adapters
  can't race two writes out of order; the exit-flush only writes when a change
  is actually pending, so a bare refresh never resurrects data you just cleared.
  `reset()` wipes the record on **whatever backend is active** (not by clearing
  `localStorage` by hand — that does nothing on a cloud backend) and returns the
  profile to defaults, keeping identity.

The game is not published yet, so there is no legacy migration — new players
start fresh. `main.js` sources the current level + audio settings from the User
object and writes changes back to it.

## Layout
```
JS/
  index.html
  vendor/pixi.min.js
  src/{main,game,lobby,settings,shop,fortunewheel,dailybonus,level,levelConfig,icons,audio,assets,tween}.js
  src/user/{User,adapters,payments,platform,UserStore}.js
  assets/
    config/levels.json      # the level table: {background,data,types,preload?} per level
    config/prices.json      # coin prices: in-level helper buys + the Out-of-Moves continue
    config/turntable.json   # Fortune Wheel: prize groups + odds, unlock level, spins/cycle
    config/dailybonus.json  # Daily Bonus: weighted prize pool + unlock level
    levels/level{1..13}.json
    bg/*.jpg
    audio/*.mp3
```
