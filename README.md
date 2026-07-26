# Tile Match 3 — Pixi.js Port

A JavaScript/[Pixi.js](https://pixijs.com) port of the Cocos Creator game in
`../cocos` ("Tile Match 3"), a stacked-tile match-3 game. The playable levels are
declared in `src/levelConfig.js` (currently **4**).

## Gameplay
On load you land on the **lobby** screen, which shows a big centred
**"Level &lt;n&gt;"** button for the level you're on (progress is saved in
`localStorage`, so it's remembered between visits). Tap it to start.

Tap any **fully-uncovered** tile to move it to the tray at the bottom. The tray
keeps **matching types grouped**: a collected tile drops in next to others of its
kind, or onto the end (top) of the row if its type isn't there yet. Collect
**3 of the same fruit** to clear them. Clear the whole board to win — you're
returned to the lobby, now advanced to the next level. If the 7-slot tray fills
up with no match, you lose (**Try Again** restarts the level in place). In-game
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
  relieving tray pressure. It picks the cheapest colour to finish — a colour
  already holding a **pair** in the tray (pull 1 more, frees two slots), else a
  colour holding a **single** (pull 2), else, on an empty tray, a fresh colour
  off the board (pull a full 3). Tiles are drawn most-accessible-first so the
  move reads as one you could have made.
- **Reshuffle** — redeal the faces of the tiles still on the play board into a
  fresh arrangement that's still guaranteed solvable; the bottom tray/deck is
  left untouched, and positions and progress are kept, so the level is **not**
  restarted.

Each helper is drawn from a **limited inventory** stored on the player profile —
a count **bubble** on the button shows how many uses remain and every use spends
one (new players start with a small stock; see the User object below). When a
helper hits **0** it doesn't just disable — tapping it walks an **acquisition
ladder** so you can keep playing:
1. **Own one** → the bubble shows the remaining **count** (green) and a tap spends
   one, as usual.
2. **Out of stock, can afford one** → the bubble shows the **coin price** (a gold
   coin + amount); a tap **buys one with coins** from your wallet and uses it in
   the same press (net inventory unchanged, coins spent).
3. **Out of stock and can't afford one** → the bubble shows a **"watch an ad"**
   icon (📺); a tap grants a **free** use via a rewarded ad. *(No ad network is
   wired up yet — the tap grants the reward immediately; the icon is the
   placeholder.)*

A helper is only **disabled/greyed** when there's **no move to make** (e.g. Undo
with an empty tray), never merely because stock ran out. The **coin prices** live
in a JSON config (`assets/config/prices.json`) so they're tunable without touching
code.

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
arrival — when the last one lands, the level is won. The **cog** (top-left) opens Settings and the
**‹ Back** button beside it leaves the level for the lobby with progress kept.

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
  the `types` field of each entry in `src/levelConfig.js` — either a fixed
  integer or a `[min, max]` **range** resolved to a count that is random but
  deterministic per level (every type is guaranteed to appear on the board).
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
  **Wand** (`wand()` / `_wandPick()`) completes exactly one triple — it selects
  the cheapest colour to finish (waiting pair → single → fresh board colour),
  flies the missing tiles in most-accessible-first, and locks input until the
  triple resolves so a rapid double-tap can't spend two charges. (An upgraded
  "super" wand tied to a win-streak meta shares the button but isn't built.)
  **Auto Complete** (`autoComplete()` / `_autoAvailable()`) is a **free** endgame
  shortcut, not a booster: when `boardCount + tray.length ≤ 12` and no board tile
  is still covered, `_updateBoosters` swaps the three round helpers for a wide
  **Auto Complete** pill in the same row. Pressing it stages every remaining tile
  on `fxLayer`, gathers them into a pile, then flies each along a quadratic
  Bézier into the tray's first slot (staggered), `_popMatch`-ing it on arrival,
  and calls `_win()` once the board is empty. Input is locked for the whole sweep
  (`_autoRunning`), which is reset in `loadLevel` so the next level's helper row
  returns. On a win it calls back to the host
  (`onLevelComplete`) rather than self-looping; the top-left **Back** button
  calls `onExit` to return to the lobby mid-level (progress untouched).
- `src/lobby.js` is the `LobbyScene` (landing/home screen) with the centred
  **"Level &lt;n&gt;"** play button, level-progress dots, and title.
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
- `src/settings.js` is the `SettingsScene` — an overlay opened by the **cog
  button** in the top-left of both the lobby and the level. It has **Music** and
  **Sound** toggles (driving `audio.setMusic` / `setSound`, which persist to the
  User object) and a **Back** button that returns to the scene underneath.
- `src/main.js` boots Pixi, owns the lobby ⇄ game flow, and reads/writes player
  state (level, settings, wallet) through the **User object** (see below). Its
  `MAX_LEVEL` is imported from `src/levelConfig.js` (= number of levels there). It
  also constructs the **Shop** overlay and the **payment provider**
  (`makePayments`), wires the coin-pill taps to open the shop, and owns
  `purchasePackage` (run the provider, then grant the package's coins + boosters on
  success).
- **Responsive layout** — the game fits **any** screen (any aspect ratio,
  portrait or landscape) with **no letterbox bars** and no distortion.
  `main.js`'s `resize()` sizes the renderer to the whole viewport and uniformly
  scales the stage by `min(vw/750, vh/1334)`, so the *constraining* viewport
  dimension maps exactly onto the 750×1334 design; the other dimension gains
  extra design units. It then hands each scene the resulting design area
  (`DW×DH`, one dimension ≥ its nominal) via `scene.layout(DW, DH)`. Each scene
  reflows: the top HUD stays anchored to the **top** edge, the tray + helper row
  anchor to the **bottom** edge, the board fills (and recentres in) the space
  between, and the background/overlays cover the whole view. The 750-wide safe
  band centres the **HUD and tray** (background fills the sides on a wide screen);
  the **board itself scales to fill** the actual available width and the vertical
  band between the HUD and tray, with **no upper cap** — so tiles grow to use the
  space and are genuinely sized to the screen (`GameScene._layoutBoard` fits the
  board by `min((viewW-60)/spanX, areaH/spanY)`). On a very wide screen the board
  may extend over the side background. So a taller screen spreads the chrome to
  the edges with a bigger board, and a wider one enlarges the play area too.
  (`GameScene.layout` reflows the board/tray/overlay live, so a mid-level rotate
  or resize just re-lays-out in place.)
- Pixi is vendored at `vendor/pixi.min.js` (v7.4.2).

### Levels (`src/levelConfig.js`)
Every level is declared in **one place** — the `LEVELS` array in
`src/levelConfig.js`. Each entry is `{ background, data, types, preload? }`
(paths to a background image and a level-data JSON, the count of distinct tile
faces the level uses — an integer or a `[min, max]` range drawn deterministically
per level — plus an optional preload flag).
**Adding a level is a single one-line append** — nothing else needs editing:
- `MAX_LEVEL` is exported as `LEVELS.length`, so the array's length is the
  highest playable level (consumed by `main.js` and the lobby).
- `src/assets.js` builds its load **manifest** from `LEVELS` (level *N* ↔ entry
  *N-1*), so a new entry is automatically loadable.

### Asset management (`src/assets.js` + `src/audio.js`)
Assets are organised into groups: a shared `core` group plus one `levelN` group
per level, the latter generated from the `LEVELS` config above.
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
- **`User.js`** — the model: a stable `id`, `platform`, `progress` (next level),
  a **multi-currency `wallet`** (`coins`, `gems`, … — a keyed map, so new
  currencies need no code change: `credit`/`debit`/`balance`/`canAfford`), a
  **helper/booster inventory** (`boosters` — a keyed map of
  `undo`/`shuffle`/`wand`… → remaining uses, mirroring the wallet:
  `boosterCount`/`hasBooster`/`grantBooster`/`useBooster`; new players get a
  small starter stock), and `settings` (`music`,
  `sound`). It emits a domain-tagged change event on every mutation and
  (de)serializes via `toJSON`/`fromJSON` with a `version` for forward migrations.
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
  src/{main,game,lobby,settings,shop,level,levelConfig,icons,audio,assets,tween}.js
  src/user/{User,adapters,payments,platform,UserStore}.js
  assets/
    config/prices.json      # coin prices for in-level consumable purchases
    levels/level{1,2,3,4}.json
    bg/*.jpg
    audio/*.mp3
```
