import subprocess, time, sys, os
from playwright.sync_api import sync_playwright
SC = os.path.join(os.path.dirname(os.path.abspath(__file__)), "output")
os.makedirs(SC, exist_ok=True)
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
os.chdir(ROOT)
srv = subprocess.Popen([sys.executable, "-m", "http.server", "8099"],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1.5)
try:
    with sync_playwright() as p:
        b = p.chromium.launch(args=["--use-gl=angle", "--use-angle=swiftshader",
            "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"])
        page = b.new_page(viewport={"width": 780, "height": 1334})
        errs = []
        page.on("console", lambda m: errs.append(m.text) if m.type == "error" else None)
        page.on("pageerror", lambda e: errs.append("PAGEERROR: " + str(e)))
        page.goto("http://localhost:8099/index.html")
        page.evaluate("() => localStorage.clear()")
        page.reload()
        page.wait_for_function("window.__game && window.__game.settings", timeout=20000)
        time.sleep(0.5)
        # Undo is a helper consumed from the inventory; top it up so this test
        # exercises undo MECHANICS without running out (booster gating is covered
        # in booster_test.py).
        page.evaluate("window.__game.grantBooster('undo', 999)")

        def st():   return page.evaluate("window.__game.state()")
        def tap():  page.evaluate("window.__game.solveTap()"); time.sleep(0.35)
        def undo(): page.evaluate("window.__game.scene.undo()"); time.sleep(0.35)
        def fresh():
            page.evaluate("window.__game.startLevel(1)"); time.sleep(0.8)

        # Undo semantics in the current code (src/game.js):
        #  - collecting a tile pushes it onto `history`; undo() pops the last one
        #    back to the board. It is a MULTI-STEP stack, not a single step.
        #  - completing a triple splices those tiles out of `history`, so a match
        #    cannot be undone.
        #  - state() exposes boardCount + tray (there is no canUndo flag).

        fresh()
        s0 = st(); b0 = s0["boardCount"]
        print("fresh board:", b0, "tray", s0["tray"], "locked", s0["locked"])
        assert s0["tray"] == [] and s0["locked"] is False

        # 1) empty history -> undo is a no-op
        undo()
        s = st()
        assert s["boardCount"] == b0 and s["tray"] == [], "undo with no moves must do nothing"

        # 2) one tap collects a tile; undo puts it back exactly
        tap()
        s = st()
        assert s["boardCount"] == b0 - 1 and len(s["tray"]) == 1, f"one tap -> one collected: {s}"
        undo()
        s = st()
        assert s["boardCount"] == b0 and len(s["tray"]) == 0, f"undo restores the tile: {s}"

        # 3) multi-step undo walks the whole stack back, tile by tile
        #    (the first two taps of a triple do not merge, so the tray holds 2)
        tap(); tap()
        s = st()
        assert s["boardCount"] == b0 - 2 and len(s["tray"]) == 2, f"two collected, no merge yet: {s}"
        undo()
        s = st()
        assert s["boardCount"] == b0 - 1 and len(s["tray"]) == 1, "undo restores only the last move"
        undo()
        s = st()
        assert s["boardCount"] == b0 and len(s["tray"]) == 0, "a second undo walks further back"
        undo()
        s = st()
        assert s["boardCount"] == b0 and len(s["tray"]) == 0, "undo past the history is a no-op"

        # 4) a completed match is NOT undoable
        fresh()
        b1 = st()["boardCount"]
        tap(); tap(); tap()       # third tap of the type completes a triple
        time.sleep(0.5)
        s = st()
        print("after triple:", s["boardCount"], "tray", s["tray"])
        assert len(s["tray"]) == 0, "the third tap should clear the triple from the tray"
        assert s["boardCount"] == b1 - 3, "three tiles left the board"
        undo()
        s = st()
        assert s["boardCount"] == b1 - 3 and len(s["tray"]) == 0, "a matched triple cannot be undone"

        # 5) the tray GROUPS matches: a tile whose type is already present lands
        #    next to that group; an unmatched tile goes on the end. undo() still
        #    removes the LAST-ADDED tile (add-order), not the visually-last one.
        def tap_id(i):
            page.evaluate(f"window.__game.scene._onTapTile(window.__game.scene.tiles[{i}])")
            time.sleep(0.35)
        def tray():
            return page.evaluate("window.__game.scene.tray.map(t => ({id: t.id, type: t.type}))")

        fresh()
        by_type = {}
        for t in page.evaluate("window.__game.freeTiles()"):
            by_type.setdefault(t["type"], []).append(t["id"])
        # need a type with >=2 free tiles (X) plus a different type with >=1 (Y)
        X = next((ty for ty, ids in by_type.items() if len(ids) >= 2), None)
        Y = next((ty for ty in by_type if ty != X), None)
        assert X is not None and Y is not None, "need two free of one type and one of another"
        x1, x2 = by_type[X][0], by_type[X][1]
        y1 = by_type[Y][0]

        tap_id(x1)   # [x1]
        tap_id(y1)   # no match -> [x1, y1]
        tap_id(x2)   # matches X -> inserted next to x1 -> [x1, x2, y1]
        order = tray()
        print("grouped tray:", order, "| X,Y =", X, Y)
        assert [t["id"] for t in order] == [x1, x2, y1], \
            f"a matching tile must land next to its group: {order}"
        assert [t["type"] for t in order] == [X, X, Y]

        undo()       # last added was x2 (a middle slot) -> that is what pops
        order = tray()
        assert [t["id"] for t in order] == [x1, y1], \
            f"undo must remove the last-added tile (x2), not the visual last: {order}"

        page.screenshot(path=f"{SC}/undo_state.png")
        print("PAGE ERRORS:", len(errs), errs[:5])
        assert not errs
        print("UNDO TEST PASSED")
        b.close()
finally:
    srv.terminate()
