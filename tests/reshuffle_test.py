import subprocess, time, sys, os
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
os.chdir(ROOT)
srv = subprocess.Popen([sys.executable, "-m", "http.server", "8099"],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1.5)

def tiles(page):
    return page.evaluate(
        "window.__game.scene.tiles.map(t=>({id:t.id,type:t.type,inTray:t.inTray,matched:t.matched}))")

def types_sig(ts):
    # signature of face types over still-active (not matched) tiles, keyed by id
    return {t["id"]: t["type"] for t in ts if not t["matched"]}

def tray_sig(ts):
    # face types of tiles currently in the tray (the pre-match deck), keyed by id
    return {t["id"]: t["type"] for t in ts if t["inTray"] and not t["matched"]}

def board_sig(ts):
    return {t["id"]: t["type"] for t in ts if not t["inTray"] and not t["matched"]}

def type_counts(ts):
    c = {}
    for t in ts:
        if not t["matched"]:
            c[t["type"]] = c.get(t["type"], 0) + 1
    return c

try:
    with sync_playwright() as p:
        browser = p.chromium.launch(args=[
            "--use-gl=angle", "--use-angle=swiftshader",
            "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"])
        page = browser.new_page(viewport={"width": 780, "height": 1334})
        errors = []
        page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
        page.on("pageerror", lambda e: errors.append("PAGEERROR: " + str(e)))

        page.goto("http://localhost:8099/index.html")
        page.evaluate("() => localStorage.clear()")
        page.reload()
        page.wait_for_function("window.__game && window.__game.scene", timeout=20000)
        # Reshuffle is a helper consumed from the inventory, and it is LOCKED in the
        # first levels: play forward past its unlock, then top it up so this test
        # exercises reshuffle MECHANICS without running out (the inventory ladder is
        # covered in booster_test.py, the unlock gate in boosterunlock_test.py).
        page.evaluate("window.__game.completeLevel(5)")
        time.sleep(0.2)
        page.evaluate("window.__game.grantBooster('shuffle', 999)")

        page.evaluate("async () => { await window.__game.startLevel(1); window.__game.closeTutorial(); }")
        time.sleep(0.6)

        def solve_some(n):
            for _ in range(n):
                r = page.evaluate("window.__game.solveTap()")
                if r == -1:
                    time.sleep(0.05)
                time.sleep(0.02)

        def solve_to_win(tag):
            for _ in range(4000):
                s = page.evaluate("window.__game.state()")
                if s["overlay"] or s["inLobby"]:
                    return s
                page.evaluate("window.__game.solveTap()")
                time.sleep(0.02)
            return page.evaluate("window.__game.state()")

        # --- Collect a few tiles so there is partial progress + a non-empty tray
        solve_some(5)
        time.sleep(0.35)  # let the delayed _settle() finish so the tray is stable
        before = page.evaluate("window.__game.state()")
        bt = tiles(page)
        sig_before = types_sig(bt)
        counts_before = type_counts(bt)
        print("BEFORE reshuffle -> level:", before["level"], "boardCount:", before["boardCount"],
              "tray:", before["tray"], "activeTypeCounts:", counts_before)

        # --- Reshuffle #1
        page.evaluate("window.__game.reshuffle()")
        time.sleep(0.5)
        after = page.evaluate("window.__game.state()")
        at = tiles(page)
        sig_after = types_sig(at)
        print("AFTER reshuffle  -> level:", after["level"], "boardCount:", after["boardCount"],
              "tray:", after["tray"], "overlay:", after["overlay"], "inLobby:", after["inLobby"])

        # 1) Must NOT restart the level: same level, still playing, board count unchanged
        assert after["level"] == before["level"], "level must not change"
        assert after["inLobby"] is False and after["overlay"] is False, "must stay in the level"
        assert after["boardCount"] == before["boardCount"], \
            f"board tile count must be unchanged (no restart): {before['boardCount']} -> {after['boardCount']}"

        # 2) The pre-match deck (tray) MUST be untouched: same tiles, same faces.
        tray_before, tray_after = tray_sig(bt), tray_sig(at)
        print("  tray before:", tray_before, "| tray after:", tray_after)
        assert tray_before == tray_after, "reshuffle must NOT change the tray/deck tiles or their faces"

        # 3) No tiles leave or join — nothing is re-dealt, only board faces change.
        active_before = sum(1 for t in bt if not t["matched"])
        active_after = sum(1 for t in at if not t["matched"])
        assert active_before == active_after, "reshuffle must not add/remove tiles"

        # 4) Faces actually changed for at least some BOARD tiles (it really reshuffled)
        board_before, board_after = board_sig(bt), board_sig(at)
        changed = sum(1 for tid, ty in board_after.items() if board_before.get(tid) != ty)
        print("  board tiles whose face changed:", changed, "/", len(board_after))
        assert changed > 0, "reshuffle should change at least some board tile faces"

        # 4) Every active type count is a multiple of 3 (a necessary condition for a clearable board)
        for ty, n in type_counts(at).items():
            assert n % 3 == 0, f"type {ty} has {n} active tiles (not a multiple of 3) -> unwinnable"

        # 5) Reshuffle repeatedly mid-solve, then prove the board is STILL solvable to a win
        for i in range(3):
            solve_some(4)
            time.sleep(0.35)  # let the delayed _settle() finish before reshuffling
            s = page.evaluate("window.__game.state()")
            if s["overlay"] or s["inLobby"]:
                break
            page.evaluate("window.__game.reshuffle()")
            time.sleep(0.3)
            s2 = page.evaluate("window.__game.state()")
            print(f"  mid-solve reshuffle #{i+1} -> boardCount:", s2["boardCount"], "tray:", s2["tray"])
            assert s2["inLobby"] is False, "reshuffle must never bounce to the lobby"
            for ty, n in type_counts(tiles(page)).items():
                assert n % 3 == 0, f"after reshuffle #{i+1}, type {ty} count {n} not multiple of 3"

        final = solve_to_win("final")
        print("FINAL solve -> overlay:", final["overlay"], "boardCount:", final["boardCount"])
        assert final["overlay"] is True and final["boardCount"] == 0, \
            "board must remain fully solvable after reshuffles (reached a win)"

        print("PAGE ERRORS:", len(errors), errors[:5])
        assert not errors
        print("ALL RESHUFFLE CHECKS PASSED")
        browser.close()
finally:
    srv.terminate()
