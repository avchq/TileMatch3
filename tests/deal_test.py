"""The start-of-level DEAL — a board arrives as a wave, not all at once.

Every level opens with a wave that crosses the board diagonally, popping each
tile in as it reaches it, so the pile assembles itself in front of the player and
its shape and depth are readable before the first tap. The corner it starts from
is **picked per board** out of the four (bottom-left, bottom-right, top-left,
top-right), never the same one twice running, so a level replayed does not open
the same way twice. Each layer is set back a little further than the one it rests
on, so the wave climbs the stack as it sweeps across. Until the last tile lands
the level is LOCKED (there is nothing to tap yet) and the level's opening — the
"How To Play" popup, the guided first moves, a helper's coaching — is held back,
so nothing is ever explained over a half-built board.

What this file guards, through `window.__game.dealState()` (every board tile with
its grid position, the delay the wave gave it and its live opacity) and
`window.__game.setDealCorner()` (which pins the corner so the geometry can be
checked one corner at a time):

  1. every corner's geometry: pinned to each of the four in turn, a tile's delay
     never runs backwards along that corner's axis — move away from the corner in
     either direction, or onto a higher layer, and a tile can only be dealt later
     — and on the ground layer the first tile dealt is the corner itself and the
     last is the tile diagonally opposite it;
  2. the variety: left to itself the game really does move the corner around, and
     never repeats one twice in a row;
  3. the wave on screen: some frame catches the near corner solid while the far
     one has not started, no tile ever fades back out, and no tile the wave deals
     later is ever ahead of one it deals earlier;
  4. the finish: every tile ends at full opacity and at its laid-out size, the
     board is unlocked, and `startLevel` does not resolve before that;
  5. the handover: on level 1 the How To Play popup is not up while the board is
     still arriving — it opens once the deal is done.

Before this animation existed the board was painted outright by _layoutBoard, so
every check below fails on that behaviour: there is no wave to catch, no delays
to order, and the popup is up from the first frame.
"""
import os
import time

from playwright.sync_api import sync_playwright

import harness

# A level with several layers, so the wave has depth to climb as well as ground
# to cross (level 5 is a 4-layer board). Levels 1-3 are preloaded; this one
# lazy-loads, which is worth covering too — the deal must survive being started
# after an asset fetch.
DEAL_LEVEL = 5

# A cheap preloaded board to re-deal over and over for the variety check, and how
# many times to deal it.
VARIETY_LEVEL = 2
VARIETY_DEALS = 8

# The deal is squeezed to fit DEAL.maxMs in src/game.js. This is not that number
# — it is the outer bound on what still counts as an OPENING rather than a wait,
# so the timings stay tunable without editing the test.
MAX_TOTAL_MS = 1400

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
    return [s for s in snaps if s["level"] == level and s["deal"]["tiles"]]


def wave_axis(tiles, corner):
    """Where each tile sits on the wave's axis: 0 at `corner`, 1 opposite it.

    The same reading _dealIn uses — grid coords, each direction counted from
    whichever end the corner sits at and normalised by the board's own span, gy
    counting UPWARDS on screen (see _layoutBoard), so "b" really is the bottom of
    the board. Computed here from the reported positions rather than trusted from
    the game, so the test is checking the shape of the wave and not echoing it.
    """
    xs = [t["gx"] for t in tiles]
    ys = [t["gy"] for t in tiles]
    minX, spanX = min(xs), max(1e-6, max(xs) - min(xs))
    minY, spanY = min(ys), max(1e-6, max(ys) - min(ys))
    from_right, from_top = corner[1] == "r", corner[0] == "t"

    def axis(t):
        fx = (t["gx"] - minX) / spanX
        fy = (t["gy"] - minY) / spanY
        return ((1 - fx if from_right else fx) + (1 - fy if from_top else fy)) / 2
    return axis


def alpha_of(snap, tile_id):
    return next(t["alpha"] for t in snap["deal"]["tiles"] if t["id"] == tile_id)


def check_geometry(deal, tag):
    """Every ordering rule the wave's shape has to obey, from one dealState()."""
    tiles = deal["tiles"]
    corner = deal["corner"]
    assert corner in deal["corners"], f"{tag}: unknown corner {corner!r}"
    delays = {t["id"]: t["delayMs"] for t in tiles}
    assert all(d is not None for d in delays.values()), f"{tag}: a tile got no place in the wave"
    axis = wave_axis(tiles, corner)

    # Moving AWAY from the corner in either direction — or up onto a higher layer
    # — can only push a tile later, never earlier.
    away_x = (lambda a, b: a["gx"] >= b["gx"]) if corner[1] == "r" else (lambda a, b: a["gx"] <= b["gx"])
    away_y = (lambda a, b: a["gy"] >= b["gy"]) if corner[0] == "t" else (lambda a, b: a["gy"] <= b["gy"])
    for a in tiles:
        for b in tiles:
            if (away_x(a, b) and away_y(a, b) and a["layer"] <= b["layer"]
                    and delays[a["id"]] > delays[b["id"]] + 1e-6):
                raise AssertionError(
                    f"{tag}: the wave ran backwards — tile {a['id']} at "
                    f"({a['gx']},{a['gy']},L{a['layer']}) waits {delays[a['id']]:.0f}ms but "
                    f"{b['id']} at ({b['gx']},{b['gy']},L{b['layer']}), further from the "
                    f"{corner} corner, waits only {delays[b['id']]:.0f}ms")

    # On the ground layer, where the per-layer set-back is out of the picture, the
    # wave must be a clean diagonal from the corner to the tile opposite it.
    ground = [t for t in tiles if t["layer"] == 0]
    near = min(ground, key=lambda t: delays[t["id"]])
    far_g = max(ground, key=lambda t: delays[t["id"]])
    assert abs(axis(near) - min(axis(t) for t in ground)) < 1e-9, \
        f"{tag}: the wave did not start at the {corner} corner"
    assert abs(axis(far_g) - max(axis(t) for t in ground)) < 1e-9, \
        f"{tag}: the wave did not end at the corner opposite {corner}"
    assert delays[far_g["id"]] > delays[near["id"]], f"{tag}: the wave never crossed the board"
    ordered = sorted(ground, key=axis)
    for a, b in zip(ordered, ordered[1:]):
        assert delays[b["id"]] >= delays[a["id"]] - 1e-6, \
            (f"{tag}: the ground layer was dealt out of order — axis {axis(a):.2f} at "
             f"{delays[a['id']]:.0f}ms before axis {axis(b):.2f} at {delays[b['id']]:.0f}ms")
    return delays, axis, near


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

        # ---- 1: each corner's geometry ------------------------------------
        corners = page.evaluate("window.__game.dealState().corners")
        print("CORNERS ->", corners)
        assert sorted(corners) == ["bl", "br", "tl", "tr"], corners
        for c in corners:
            page.evaluate("(c) => window.__game.setDealCorner(c)", c)
            page.evaluate(
                "async (n) => { await window.__game.startLevel(n); }", DEAL_LEVEL)
            deal = page.evaluate("window.__game.dealState()")
            assert deal["corner"] == c, (c, deal["corner"])
            delays, axis, near = check_geometry(deal, f"corner {c}")
            print(f"  {c}: wave {deal['waveMs']:.0f}ms over {len(deal['tiles'])} tiles, "
                  f"first ({near['gx']},{near['gy']}) at {delays[near['id']]:.0f}ms, "
                  f"last at {max(delays.values()):.0f}ms")
            assert deal["totalMs"] <= MAX_TOTAL_MS, \
                f"the deal took {deal['totalMs']:.0f}ms — an opening, not a wait"

        # ---- 2: the variety ------------------------------------------------
        # Left to itself the corner moves around, and never repeats twice running.
        page.evaluate("window.__game.setDealCorner(null)")
        seen = []
        for _ in range(VARIETY_DEALS):
            page.evaluate(
                "async (n) => { await window.__game.startLevel(n); }", VARIETY_LEVEL)
            seen.append(page.evaluate("window.__game.dealState().corner"))
        print(f"{VARIETY_DEALS} DEALS ->", " ".join(seen))
        assert all(c in corners for c in seen), seen
        assert len(set(seen)) >= 2, f"the wave always started from the same corner: {seen}"
        assert all(a != b for a, b in zip(seen, seen[1:])), \
            f"the same corner was used twice running: {seen}"

        # ---- 3 + 4: the wave on screen, and the finish ---------------------
        # Sampled with the corner left to the game, so this is the real path.
        snaps = page.evaluate(SAMPLE, DEAL_LEVEL)
        board = on_board(snaps, DEAL_LEVEL)
        assert board, "no snapshot ever saw the new board"
        last = board[-1]
        tiles = last["deal"]["tiles"]
        layers = len({t["layer"] for t in tiles})
        print(f"LEVEL {DEAL_LEVEL} -> {len(tiles)} tiles over {layers} layers from the "
              f"{last['deal']['corner']} corner, {len(board)} snapshots on board")
        print(f"  wave: {last['deal']['waveMs']:.0f}ms  pop: {last['deal']['durationMs']}ms  "
              f"whole deal: {last['deal']['totalMs']:.0f}ms")
        assert layers >= 3, f"pick a deeper level to test the wave ({layers} layers)"
        delays, axis, near = check_geometry(last["deal"], "sampled deal")
        far = max(tiles, key=lambda t: delays[t["id"]])

        # The board arrives locked and all but unpainted — the first frame it
        # exists on is caught in the wave's first moments, so most of it is still
        # to come and the far corner has not started at all. (How early that frame
        # lands is up to the renderer, which is why this is a share rather than
        # "every tile at zero".)
        first = board[0]
        blank = sum(1 for t in first["deal"]["tiles"] if t["alpha"] == 0)
        print(f"  FIRST FRAME -> {blank}/{len(first['deal']['tiles'])} tiles unpainted, "
              f"far end at {alpha_of(first, far['id'])}, "
              f"animating: {first['deal']['animating']}, locked: {first['locked']}")
        assert first["deal"]["animating"] is True, "the board did not deal in at all"
        assert first["locked"] is True, "a board still arriving must not accept taps"
        assert alpha_of(first, far["id"]) == 0, \
            "the far end of the board was already painted on the deal's first frame"
        assert blank >= len(tiles) / 2, \
            f"the board was painted outright: only {blank} of {len(tiles)} tiles were waiting"

        # Some frame then has the near corner solid while the far one has still
        # not begun, and nothing ever fades back out.
        caught = [s for s in board
                  if alpha_of(s, near["id"]) > 0.9 and alpha_of(s, far["id"]) == 0]
        print("  FRAMES WITH THE FRONT MID-BOARD:", len(caught))
        assert caught, ("the tiles never came up in a wave — no frame had the near corner "
                        "solid with the far one still unpainted")
        for prev, cur in zip(board, board[1:]):
            pa = {t["id"]: t["alpha"] for t in prev["deal"]["tiles"]}
            for t in cur["deal"]["tiles"]:
                assert t["alpha"] >= pa.get(t["id"], 0) - 0.01, \
                    f"tile {t['id']} faded back out: {pa.get(t['id'])} -> {t['alpha']}"

        # …and on any given frame a tile dealt EARLIER is never fainter than one
        # dealt later — which is what makes the front read as a line crossing the
        # board rather than tiles popping at random.
        for s in caught:
            order = sorted(s["deal"]["tiles"], key=lambda t: delays[t["id"]])
            for a, b in zip(order, order[1:]):
                if delays[b["id"]] - delays[a["id"]] > 1e-6:
                    assert a["alpha"] >= b["alpha"] - 0.01, \
                        (f"a later tile ({b['id']}) was ahead of an earlier one ({a['id']}) "
                         f"at t={s['t']:.0f}ms")

        # THE FINISH: every tile fully painted, the board unlocked, and startLevel
        # resolved only once that was true.
        assert last.get("settled") is True, \
            "startLevel resolved before the board had finished dealing in"
        faint = [t["id"] for t in tiles if t["alpha"] != 1]
        print("  SETTLED -> animating:", last["deal"]["animating"], "locked:", last["locked"],
              "tiles short of full opacity:", len(faint))
        assert last["deal"]["animating"] is False
        assert not faint, f"tiles never reached full opacity: {faint[:6]}"
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

        # ---- 5: the level's opening waits for the last tile ----------------
        # A brand-new player on level 1: the How To Play popup must not open
        # over a board that is still arriving.
        harness.boot(page, "window.__game && window.__game.scene")
        snaps = page.evaluate(SAMPLE, 1)
        during = [s for s in on_board(snaps, 1) if s["deal"]["animating"]]
        print("LEVEL 1 -> dealing frames:", len(during),
              "popup up during the deal:", any(s["tutorial"] for s in during))
        assert during, "level 1 did not deal in"
        assert not any(s["tutorial"] for s in during), \
            "the How To Play popup opened over a half-dealt board"
        page.wait_for_function("window.__game.tutorialState().visible === true", timeout=15000)
        page.screenshot(path=f"{harness.OUTPUT}/deal_level1_after.png")
        print("  popup opened once the board had landed")

        # Mid-deal screenshots, for the eye: one wave from each corner, caught
        # part-way across.
        page.evaluate("window.__game.closeTutorial()")
        for c in corners:
            page.evaluate("(c) => window.__game.setDealCorner(c)", c)
            page.evaluate("(n) => { window.__game.startLevel(n); }", DEAL_LEVEL)
            time.sleep(0.35)
            page.screenshot(path=f"{harness.OUTPUT}/deal_wave_{c}.png")
            time.sleep(0.8)
        page.evaluate("window.__game.setDealCorner(null)")
        page.screenshot(path=f"{harness.OUTPUT}/deal_done.png")

        print("ERRORS:", len(errors))
        for e in errors[:10]:
            print("  ", e)
        assert not errors, errors
        print("ALL DEAL CHECKS PASSED")
