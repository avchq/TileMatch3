# Tile Match 3 — Pixi.js Port

A JavaScript/[Pixi.js](https://pixijs.com) port of the Cocos Creator game in
`../cocos` ("Tile Match 3"), a stacked-tile match-3 game. Playable
through **levels 1–3**.

## Gameplay
On load you land on the **lobby** screen, which shows a big centred
**"Level &lt;n&gt;"** button for the level you're on (progress is saved in
`localStorage`, so it's remembered between visits). Tap it to start.

Tap any **fully-uncovered** tile to move it to the tray at the bottom. Collect
**3 of the same fruit** to clear them. Clear the whole board to win — you're
returned to the lobby, now advanced to the next level. If the 7-slot tray fills
up with no match, you lose (**Try Again** restarts the level in place). In-game
buttons: **Undo** (return the last collected tile) and **Restart**.

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
  with only 3 tray slots. Distinct types per level: 7 / 8 / 9 (every one is
  guaranteed to appear on the board).
- `src/game.js` holds the `GameScene` (board layout, coverage/free-state logic,
  tray, matching, win/lose, animations). On a win it calls back to the host
  (`onLevelComplete`) rather than self-looping.
- `src/lobby.js` is the `LobbyScene` (landing/home screen) with the centred
  **"Level &lt;n&gt;"** play button, level-progress dots, and title.
- `src/main.js` boots Pixi, loads assets, owns the lobby ⇄ game flow, and
  persists the current level in `localStorage` (`tilemaster.level`).
- Pixi is vendored at `vendor/pixi.min.js` (v7.4.2).

## Layout
```
JS/
  index.html
  vendor/pixi.min.js
  src/{main,game,level,icons,audio,tween}.js
  assets/
    levels/level{1,2,3}.json
    bg/*.jpg
    audio/*.mp3
```
