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
buttons: **Undo** (return the last-added tile — the most recent one, wherever
grouping placed it in the tray; **disabled/greyed-out when the tray is empty**, as
there's nothing to undo) and **Reshuffle** (redeal the faces of the tiles
still on the play board into a fresh arrangement that's still guaranteed solvable
— the bottom tray/deck is left untouched, and positions and progress are kept, so
the level is **not** restarted). The **cog** (top-left) opens Settings and the
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
  the `types` field of each entry in `src/levelConfig.js` (every one is
  guaranteed to appear on the board). Tile **positions** come straight from the
  level file, and the type assignment is seeded **only from the level number**
  (`game.js` `loadLevel`), so a level's layout is **deterministic** — the same
  fruit is in the same spot on every load/reload/session. (**Reshuffle** is the
  intentional way to re-randomise the faces mid-game.)
- `src/game.js` holds the `GameScene` (board layout, coverage/free-state logic,
  tray, matching, win/lose, animations). The tray keeps same-type tiles grouped
  as they're collected while `history` records raw add-order, so **Undo** always
  pops the most recently added tile. On a win it calls back to the host
  (`onLevelComplete`) rather than self-looping; the top-left **Back** button
  calls `onExit` to return to the lobby mid-level (progress untouched).
- `src/lobby.js` is the `LobbyScene` (landing/home screen) with the centred
  **"Level &lt;n&gt;"** play button, level-progress dots, and title.
- `src/settings.js` is the `SettingsScene` — an overlay opened by the **cog
  button** in the top-left of both the lobby and the level. It has **Music** and
  **Sound** toggles (driving `audio.setMusic` / `setSound`, which persist to the
  User object) and a **Back** button that returns to the scene underneath.
- `src/main.js` boots Pixi, owns the lobby ⇄ game flow, and reads/writes player
  state (level, settings, wallet) through the **User object** (see below). Its
  `MAX_LEVEL` is imported from `src/levelConfig.js` (= number of levels there).
- Pixi is vendored at `vendor/pixi.min.js` (v7.4.2).

### Levels (`src/levelConfig.js`)
Every level is declared in **one place** — the `LEVELS` array in
`src/levelConfig.js`. Each entry is `{ background, data, types, preload? }`
(paths to a background image and a level-data JSON, the count of distinct tile
faces the level uses, plus an optional preload flag).
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
  currencies need no code change: `credit`/`debit`/`balance`/`canAfford`), and
  `settings` (`music`, `sound`). It emits a domain-tagged change event on every
  mutation and (de)serializes via `toJSON`/`fromJSON` with a `version` for
  forward migrations.
- **`adapters.js`** — a small **async** storage/identity contract
  (`identify` / `load` / `save` / `clear`). `LocalStorageAdapter` is the working
  default on the open web. `FacebookInstantAdapter` / `TelegramAdapter` /
  `RedditAdapter` are **stubs** that persist to `localStorage` for now and mark
  the exact SDK calls (`// TODO(SDK):`) to swap in later (`FBInstant.player`,
  `Telegram.WebApp.CloudStorage`, Devvit KV) — no code outside this file changes
  when a platform is wired in for real. Identity is platform-owned and fixed;
  `clear()` wipes the *data*, never the id.
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
  src/{main,game,lobby,settings,level,levelConfig,icons,audio,assets,tween}.js
  src/user/{User,adapters,platform,UserStore}.js
  assets/
    levels/level{1,2,3,4}.json
    bg/*.jpg
    audio/*.mp3
```
