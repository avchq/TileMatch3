import subprocess, time, sys, os
from playwright.sync_api import sync_playwright

import harness
SC = os.path.join(os.path.dirname(os.path.abspath(__file__)), "output")
os.makedirs(SC, exist_ok=True)
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
os.chdir(ROOT)
BASE = harness.serve()

# The bottom tray is sized to the CURRENT LEVEL's on-screen tile size, not a fixed
# 84px slot. A board tile is drawn at TILE_DRAW(96) * boardScale, so the tray slot
# matches that (a collected tile keeps its size flying into the tray), clamped to
# [SLOT_MIN, SLOT_MAX] so the 7-slot tray always fits the 750-wide safe band. Since
# the board scales to FILL the screen its tiles are large, so on normal screens the
# slot clamps at SLOT_MAX; a denser board (smaller tiles) would shrink the tray.
# (Regression: the old tray was a hard-coded SLOT=84 independent of the level.)

def clamp(v, lo, hi):
    return max(lo, min(hi, v))

with sync_playwright() as p:
    b, page, errs = harness.launch(p, viewport=(390, 844))
    page.goto(f"{BASE}/index.html")
    page.evaluate("() => localStorage.clear()")
    page.reload()
    page.wait_for_function("window.__game && window.__game.scene", timeout=60000)
    time.sleep(0.4)

    def tray():
        return page.evaluate("window.__game.traySize()")

    # 1) The slot size is DERIVED from the level's tile size, clamped to fit.
    #    Check the identity slot == clamp(tileOnScreen, SLOT_MIN, SLOT_MAX) for a
    #    spread of levels (each has its own boardScale, so its own tile size).
    for lvl in (1, 3, 7, 10):
        page.evaluate(f"window.__game.startLevel({lvl})")
        time.sleep(0.5)
        t = tray()
        print(f"level {lvl}:", {k: round(v, 2) if isinstance(v, float) else v
                                for k, v in t.items() if k != "slotXs"})
        expect = clamp(t["tileOnScreen"], t["slotMin"], t["slotMax"])
        assert abs(t["slot"] - expect) < 0.01, \
            (f"level {lvl}: slot must track the tile size (clamped)", t)
        # not the old hard-coded 84
        assert abs(t["slot"] - 84) > 0.5, (f"level {lvl}: tray still fixed at 84?", t)

    # 2) The 7 slots are evenly spaced by (slot + gap) and the tray panel stays
    #    inside the 750-wide safe band (no overflow) and centred on it.
    page.evaluate("async () => { await window.__game.startLevel(1); window.__game.closeTutorial(); }")
    time.sleep(0.5)
    t = tray()
    xs = t["slotXs"]
    assert len(xs) == 7, ("expected 7 slots", xs)
    gaps = [round(xs[i + 1] - xs[i], 2) for i in range(6)]
    assert all(abs(g - (t["slot"] + 6)) < 0.5 for g in gaps), \
        ("slots must be spaced by slot+gap(6)", gaps, t["slot"])
    assert t["panelW"] <= 750 + 0.5, ("tray panel overflows the 750 safe band", t)
    assert abs((xs[0] + xs[-1]) / 2 - 375) < 0.5, ("tray not centred on the band", xs)

    # 3) On a normal screen the board tile is bigger than the tray can hold 7 of,
    #    so the slot clamps at SLOT_MAX (the widest that fits) — still != 84.
    assert t["tileOnScreen"] > t["slotMax"], ("expected a large board tile here", t)
    assert abs(t["slot"] - t["slotMax"]) < 0.01, ("slot must clamp to SLOT_MAX", t)

    # 4) A collected tile renders at the slot size in the tray (TILE_DRAW=96 * its
    #    container scale ≈ slot), i.e. the tray tile visually matches its slot,
    #    which in turn tracks the level's tile size.
    page.evaluate("window.__game.solveTap()")

    # The collected tile FLIES into the tray, shrinking as it goes. Sleeping half
    # a second and measuring is a bet that the tween has landed; on a loaded
    # machine it has not, and the tile is caught mid-flight at its board size.
    # Wait for the size to stop changing, then assert what it settled at —
    # polling until it merely matched the slot would make the assertion vacuous.
    def settled_tile_size():
        """The size the tile settles at once the fly-in lands.

        Frame-driven, and both halves of that matter. It waits for the value to
        have MOVED and then held still, because before the tween starts the tile
        is also not changing — at its full board size — and a naive settle-poll
        returns that. And it steps on requestAnimationFrame rather than a Python
        sleep, because on a starved renderer two polls 50ms apart can straddle
        zero painted frames: "unchanged" then means "nothing was drawn", not
        "the tween finished", and the test reads a half-shrunk tile as final.
        Counting frames cannot make that mistake.

        Waiting this way is fine in the parallel batch — what would not be is
        ASSERTING on the frames themselves (see the SERIAL list in run_all.py).
        """
        return page.evaluate("""() => new Promise(resolve => {
            const read = () => { const s = window.__game.scene;
                return s.tray.length ? s.tray[0].container.scale.x * 96 : null; };
            let prev = null, still = 0, moved = false, frames = 0;
            (function tick() {
                const cur = read();
                if (cur !== null && prev !== null) {
                    if (Math.abs(cur - prev) > 1e-6) { moved = true; still = 0; }
                    else if (++still >= 3 && moved) return resolve(cur);
                }
                prev = cur;
                if (++frames > 1800) return resolve(cur);   // hard stop
                requestAnimationFrame(tick);
            })();
        })""")

    rendered = settled_tile_size()
    print("collected tile rendered size:", rendered, "slot:", t["slot"])
    assert rendered is not None, "expected a tile in the tray after solveTap"
    assert abs(rendered - t["slot"]) < 1.0, \
        ("a collected tray tile must render at the slot size", rendered, t["slot"])

    page.screenshot(path=f"{SC}/tray_size.png")
    print("PAGE ERRORS:", len(errs), errs[:5])
    assert not errs
    print("TRAY SIZE TEST PASSED")
    b.close()