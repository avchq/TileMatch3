"""The start-of-level DEAL — a board arrives layer by layer, not all at once.

Every level opens by dealing its stack in from the bottom up: layer 0 pops in
first, layer 1 a beat later, and so on, so the player watches the pile being
built and can read its depth before the first tap. Until the last layer lands
the level is LOCKED (there is nothing to tap yet) and the level's opening — the
"How To Play" popup, the guided first moves, a helper's coaching — is held back,
so nothing is ever explained over a half-built board.

What this file guards (all of it via `window.__game.dealState()`, which reports
the live mean opacity of each layer plus the moment that layer started):

  1. the wave: at some point during the deal the bottom layer is solid while the
     top one has not started, and a lower layer is NEVER less visible than one
     above it;
  2. the order and the beat: each layer starts after the one below it, with a
     real gap between them, and the whole deal stays inside its ceiling;
  3. the finish: every tile ends at full opacity and its laid-out size, the
     board is unlocked, and `startLevel` does not resolve before that;
  4. the handover: on level 1 the How To Play popup is not up while the board is
     still arriving — it opens once the deal is done.

Before this animation existed the board was painted outright by _layoutBoard, so
every check below (1, 2 and 4 especially) fails on that behaviour: there is no
wave to catch, no per-layer start to order, and the popup is up from the first
frame.
"""
import os
import time

from playwright.sync_api import sync_playwright

import harness

# A level with several layers, so there is a wave to see at all (level 5 is a
# 4-layer board). Levels 1-3 are preloaded; this one lazy-loads, which is also
# worth covering — the deal must survive being started after an asset fetch.
DEAL_LEVEL = 5

# The ceiling the deal is tuned to (DEAL.maxMs in src/game.js) plus room for a
# software-rendered headless frame or two.
MAX_DEAL_MS = 480
SLACK_MS = 400

# Layers must start at least this far apart. The beat is 70ms; a frame at 60Hz
# is ~17ms, and SwiftShader drops some, so this only asserts the gap is real.
MIN_GAP_MS = 30

# Sample the deal from INSIDE the page, one snapshot per animation frame, so the
# wave is captured without a Playwright round-trip per sample. Starts the level,
# then records until the board for `lvl` has finished dealing.
SAMPLE = """async (lvl) => {
  const snaps = [];
  const shot = () => {
    const st = window.__game.state();
    return { t: performance.now() - t0, level: st.level, locked: st.locked,
             tutorial: window.__game.tutorialState().visible,
             deal: window.__game.dealState() };
  };
  const t0 = performance.now();
  const started = window.__game.startLevel(lvl);
  // Stop only once THIS board's deal has been seen running and then finished —
  // level 1 is already on screen when the sampler starts, so "not animating" on
  // its own would end the run before the new board had even been built.
  let seen = false;
  for (let i = 0; i < 900 && performance.now() - t0 < 8000; i++) {
    const s = shot();
    snaps.push(s);
    seen = seen || (s.level === lvl && s.deal.animating);
    if (seen && s.level === lvl && !s.deal.animating) break;
    await new Promise((r) => requestAnimationFrame(r));
  }
  await started;                       // resolves on a finished, playable board
  snaps.push({ ...shot(), settled: true });
  return snaps;
}"""


def on_board(snaps, level):
    """Only the snapshots taken once `level`'s own board existed."""
    return [s for s in snaps if s["level"] == level and s["deal"]["layers"]]


def alphas(snap):
    return [round(l["alpha"], 3) for l in snap["deal"]["layers"]]


ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
os.chdir(ROOT)
URL = harness.serve()

with sync_playwright() as p:
    with harness.session(p, viewport=(750, 1334)) as (browser, page, errors):
        harness.boot(page, "window.__game && window.__game.scene")

        # A returning player back on the lobby, so the guided level-1 flow is not
        # in the way and no helper is owed its coached first use.
        page.evaluate("window.__game.completeLevel(4)")
        page.evaluate("window.__game.markBoosterCoached('all')")
        page.evaluate("window.__game.closeTutorial()")
        page.evaluate("window.__game.exitLevel()")
        os.makedirs(harness.OUTPUT, exist_ok=True)
        time.sleep(0.4)

        # ---- 1 + 2 + 3: the deal itself -----------------------------------
        snaps = page.evaluate(SAMPLE, DEAL_LEVEL)
        board = on_board(snaps, DEAL_LEVEL)
        assert board, "no snapshot ever saw the new board"
        layers = len(board[-1]["deal"]["layers"])
        print(f"LEVEL {DEAL_LEVEL} -> layers: {layers}, snapshots on board: {len(board)}")
        print("  ALPHA TRACE:", [alphas(s) for s in board[:: max(1, len(board) // 8)]])
        assert layers >= 3, f"pick a deeper level to test the wave ({layers} layers)"

        # The board starts hidden and locked: the first frame it exists on, not
        # one tile of it is painted.
        first = board[0]
        print("  FIRST FRAME ->", alphas(first), "animating:", first["deal"]["animating"],
              "locked:", first["locked"])
        assert first["deal"]["animating"] is True, "the board did not deal in at all"
        assert max(alphas(first)) == 0, \
            f"the board was painted before the deal started: {alphas(first)}"
        assert first["locked"] is True, "a board still arriving must not accept taps"

        # THE WAVE. Some frame has the bottom layer solid while the top one has
        # not begun — which is what "layer by layer" means.
        wave = [s for s in board if s["deal"]["layers"][0]["alpha"] > 0.9
                and s["deal"]["layers"][-1]["alpha"] == 0]
        print("  WAVE FRAMES:", len(wave), "e.g.", alphas(wave[0]) if wave else None)
        assert wave, ("the layers never came up one after another — no frame had the "
                      "bottom layer solid with the top one still unpainted")

        # …and it only ever runs upwards: a lower layer is never fainter than one
        # above it, and no layer ever fades back.
        for s in board:
            a = alphas(s)
            assert all(x >= y for x, y in zip(a, a[1:])), \
                f"an upper layer arrived before a lower one at t={s['t']:.0f}ms: {a}"
        for prev, cur in zip(board, board[1:]):
            for i, (a, b) in enumerate(zip(alphas(prev), alphas(cur))):
                assert b >= a - 0.01, f"layer {i} faded back out: {a} -> {b}"

        # The recorded per-layer starts: in order, really spaced, and the whole
        # deal inside its ceiling.
        starts = [l["startedAt"] for l in board[-1]["deal"]["layers"]]
        step = board[-1]["deal"]["layerDelayMs"]
        print("  LAYER STARTS (ms):", [round(x) for x in starts], "beat:", round(step, 1))
        assert all(x is not None for x in starts), f"a layer never started: {starts}"
        gaps = [b - a for a, b in zip(starts, starts[1:])]
        assert all(g >= MIN_GAP_MS for g in gaps), f"layers dealt on top of each other: {gaps}"
        total = starts[-1] + board[-1]["deal"]["durationMs"]
        assert total <= MAX_DEAL_MS + SLACK_MS, \
            f"the deal took {total:.0f}ms — the opening must not make the player wait"

        # THE FINISH: every layer fully painted, the board unlocked, and
        # startLevel resolved only once that was true.
        last = board[-1]
        assert last.get("settled") is True, \
            "startLevel resolved before the board had finished dealing in"
        print("  SETTLED ->", alphas(last), "animating:", last["deal"]["animating"],
              "locked:", last["locked"])
        assert last["deal"]["animating"] is False
        assert alphas(last) == [1.0] * layers, f"a tile never reached full opacity: {alphas(last)}"
        assert last["locked"] is False, "the board must be playable once it is dealt"

        # Every tile is at the size _layoutBoard gave it — the pop overshoots on
        # the way in, so this is the guard that it lands exactly.
        scaled = page.evaluate("""() => {
              const s = window.__game.scene;
              return s.tiles.filter(t => !t.inTray && !t.matched)
                .filter(t => Math.abs(t.container.scale.x - t.homeScale) > 0.001).length;
            }""")
        assert scaled == 0, f"{scaled} tiles were left at the wrong scale by the deal"

        # A real tap now works, on a board that dealt itself in.
        tapped = page.evaluate("window.__game.solveTap()")
        assert tapped != -1, "the dealt board did not accept a tap"

        # ---- 4: the level's opening waits for the last layer ---------------
        # A brand-new player on level 1: the How To Play popup must not open
        # over a board that is still arriving.
        harness.boot(page, "window.__game && window.__game.scene")
        snaps = page.evaluate(SAMPLE, 1)
        board = on_board(snaps, 1)
        during = [s for s in board if s["deal"]["animating"]]
        print("LEVEL 1 -> dealing frames:", len(during),
              "popup up during the deal:", any(s["tutorial"] for s in during))
        assert during, "level 1 did not deal in"
        assert not any(s["tutorial"] for s in during), \
            "the How To Play popup opened over a half-dealt board"
        page.wait_for_function("window.__game.tutorialState().visible === true", timeout=15000)
        page.screenshot(path=f"{harness.OUTPUT}/deal_level1_after.png")
        print("  popup opened once the board had landed")

        # A mid-deal screenshot, for the eye: start a level and shoot it while
        # the upper layers are still missing.
        page.evaluate("window.__game.closeTutorial()")
        page.evaluate("() => { window.__game.startLevel(%d); }" % DEAL_LEVEL)
        time.sleep(0.2)   # part-way up the stack, where the wave is worth looking at
        page.screenshot(path=f"{harness.OUTPUT}/deal_mid.png")
        time.sleep(1.0)
        page.screenshot(path=f"{harness.OUTPUT}/deal_done.png")

        print("ERRORS:", len(errors))
        for e in errors[:10]:
            print("  ", e)
        assert not errors, errors
        print("ALL DEAL CHECKS PASSED")
