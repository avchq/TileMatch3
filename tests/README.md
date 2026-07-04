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

### Gameplay

- **`undo_test.py`** — undo is a multi-step stack: it restores collected tiles
  one at a time back to the board, is a no-op on empty history, and cannot undo a
  completed triple (matched tiles leave the history). Also checks tray grouping:
  a collected tile lands next to its matching group, and undo still pops the
  last-added tile even from a middle slot.
- **`reshuffle_test.py`** — reshuffle reassigns the board tile faces while keeping
  the level, board count, and the tray/deck unchanged, and stays in the level.

### User profile & persistence

- **`user_test.py`** — a fresh profile has the expected defaults (platform, a
  non-empty id, level 1, zeroed wallet, music/sound on) and progress persists
  across a reload.
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
