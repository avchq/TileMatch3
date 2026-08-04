#!/usr/bin/env python3
# End-to-end test for Tasks / Achievements (src/tasks.js).
#
# Drives the real game headlessly through the window.__game debug API. Covers:
# the level-10 gate on the lobby's right-edge rail, every lifetime activity
# counter ticking at the place the activity really happens (including "first
# clear only" for levels and "by amount" for coins), the one-unfinished-tier-per-
# chain rule with finished tiers stacked on top, claiming (exact payout, once
# only, persisted), the weekly list scoring against a week baseline and resetting
# on the configured weekday, the red dot, the tab auto-select, the scrolling
# list, and the v6 -> v7 profile migration.

import subprocess, time, sys, os, json
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
        page.wait_for_function(
            "window.__game && window.__game.scene && !!window.__game.tasksState", timeout=20000)
        time.sleep(0.5)

        # A fixed test week so the weekly clock is deterministic — a real Monday
        # crossing could otherwise reset the list underneath the assertions.
        # 2050-06-13 is a Monday; 2050-06-20 is the Monday after it.
        WEEK0, WEEK1 = "2050-06-13", "2050-06-20"

        def st():          return page.evaluate("window.__game.tasksState()")
        def stats():       return page.evaluate("window.__game.taskStats()")
        def stat(a):       return page.evaluate(f"window.__game.taskStat('{a}')")
        def wstat(a):      return page.evaluate(f"window.__game.weeklyStat('{a}')")
        def bump(a, n=1):  page.evaluate(f"window.__game.bumpStat('{a}', {n})")
        def rows(tab=""):  return page.evaluate(f"window.__game.tasksList({json.dumps(tab) if tab else ''})")
        def ids(tab=""):   return [r["id"] for r in rows(tab)]
        def open_t():      page.evaluate("window.__game.openTasks()")
        def close_t():     page.evaluate("window.__game.closeTasks()")
        def tab(t):        page.evaluate(f"window.__game.setTasksTab('{t}')")
        def setweek(k):    page.evaluate(f"window.__game.setTasksWeek('{k}')")
        def coins():       return page.evaluate("window.__game.balance('coins')")
        def undos():       return page.evaluate("window.__game.boosterCount('undo')")
        def right_rail():  return page.evaluate("window.__game.featureRail('right')")
        def flush():       page.evaluate("window.__game.flushSave()")

        def claim(task_id):
            """Press a row's Claim button through the real pointer path, then wait
            for the reward flight + row retirement to finish. Waiting on the
            scene's own `busy` flag rather than a sleep keeps this reliable under
            load — and a REFUSED claim never sets it, so the double-claim and
            drag cases fall straight through instead of hanging."""
            page.evaluate(f"window.__game.pressTaskClaim({json.dumps(task_id)})")
            page.wait_for_function("!window.__game.tasksState().busy", timeout=10000)
            time.sleep(0.15)

        # A fresh profile boots straight into level 1 with the tutorial up.
        page.evaluate("window.__game.closeTutorial()")
        time.sleep(0.3)
        page.evaluate("window.__game.exitLevel()")
        time.sleep(0.4)

        # ---- 1. The gate ----------------------------------------------------
        s = st()
        print("LOCKED ->", s["unlocked"], s["buttonVisible"], "unlockLevel", s["unlockLevel"])
        assert s["unlockLevel"] == 10, ("shipped gate is level 10", s)
        assert s["unlocked"] is False, ("locked for a brand-new player", s)
        assert s["buttonVisible"] is False, ("no Tasks button below the gate", s)
        assert right_rail()[0]["available"] is False, ("right rail empty below the gate", right_rail())
        # …and the screen genuinely cannot be opened, not merely un-navigated-to.
        open_t()
        time.sleep(0.3)
        assert st()["overlayOpen"] is False, ("a locked Tasks screen refuses to open", st())

        # Counters tick from level 1 even though the screen is still locked — that
        # is what fills a player's history in before they ever reach the gate.
        assert stat("levelsCompleted") == 0, stats()
        page.evaluate("window.__game.completeLevel(9)")
        page.evaluate("window.__game.markBoosterCoached('all')")
        time.sleep(0.4)
        assert stat("levelsCompleted") == 9, ("clearing levels counts while locked", stats())

        # The gate opens LIVE — clearing level 9 means "completed >= 10 - 1".
        s = st()
        print("UNLOCKED ->", s["unlocked"], s["buttonVisible"], "badge", s["badge"])
        assert s["unlocked"] is True, ("level 9 cleared opens the level-10 gate", s)
        assert s["buttonVisible"] is True, ("the Tasks button appears, live", s)
        rr = right_rail()
        assert rr[0]["key"] == "tasks" and rr[0]["available"] is True and rr[0]["slot"] == 0, rr
        assert rr[0]["x"] == 664, ("the Tasks button rides the RIGHT rail column", rr)

        # ---- 2. Red dot + tab auto-select -----------------------------------
        # 9 levels cleared already finishes the first two tiers of the levels chain.
        assert s["badge"] is True, ("the red dot lights when anything is claimable", s)
        open_t()
        time.sleep(0.6)
        s = st()
        assert s["overlayOpen"] is True, s
        assert s["tab"] == "achievements", ("opens on the tab with claimables", s)
        page.screenshot(path=f"{SC}/tasks_1_achievements.png")

        # ---- 3. One unfinished tier per chain, finished ones stacked on top --
        ach = rows("achievements")
        lvl = [r for r in ach if r["activity"] == "levelsCompleted"]
        print("LEVELS CHAIN ->", [(r["target"], r["claimable"]) for r in lvl])
        assert [r["target"] for r in lvl] == [1, 5, 10], (
            "both finished tiers plus exactly one unfinished tier", lvl)
        assert [r["claimable"] for r in lvl] == [True, True, False], lvl
        # No chain ever shows two unfinished tiers.
        for act in set(r["activity"] for r in ach):
            unfinished = [r for r in ach if r["activity"] == act and not r["claimable"]]
            assert len(unfinished) <= 1, ("one unfinished tier per chain", act, unfinished)
        # Claimable rows are sorted to the top of the list.
        flags = [r["claimable"] for r in ach]
        assert flags == sorted(flags, reverse=True), ("claimables first", flags)

        # ---- 4. Claiming ----------------------------------------------------
        c0 = coins()
        claim("levels:1")
        assert coins() == c0 + 20, ("pays exactly the configured reward", c0, coins())
        assert page.evaluate("window.__game.taskClaimed('levels:1')") is True
        assert "levels:1" not in ids("achievements"), ("a claimed tier leaves the list for good", ids())
        # Claiming does not reveal a new tier here (levels:10 was already showing),
        # but the chain still holds exactly one unfinished tier.
        lvl = [r for r in rows("achievements") if r["activity"] == "levelsCompleted"]
        assert [r["target"] for r in lvl] == [5, 10], lvl

        # A booster reward lands in the inventory, not the wallet.
        u0, c1 = undos(), coins()
        bump("levelsCompleted", 1)          # 10 total -> levels:10 becomes claimable
        time.sleep(0.3)
        page.evaluate("window.__game.openTasks()")   # refresh the rendered rows
        time.sleep(0.5)
        claim("levels:10")
        assert undos() == u0 + 2, ("booster rewards grant boosters", u0, undos())
        assert coins() == c1, ("…and leave the wallet alone", c1, coins())
        # The next tier of the chain takes its place.
        lvl = [r for r in rows("achievements") if r["activity"] == "levelsCompleted"]
        assert [r["target"] for r in lvl] == [5, 25], ("the next tier appears", lvl)

        # It cannot be claimed twice, even through the pointer path.
        c2 = coins()
        claim("levels:1")
        assert coins() == c2, ("a claimed tier can never pay out again", c2, coins())

        # ---- 5. Every counter ticks at its own site -------------------------
        close_t()
        time.sleep(0.3)

        # coinsSpent counts the AMOUNT, not the number of purchases.
        page.evaluate("window.__game.credit('coins', 500)")
        spent0 = stat("coinsSpent")
        page.evaluate("window.__game.debit('coins', 120)")
        assert stat("coinsSpent") == spent0 + 120, ("coins spent counts by amount", stat("coinsSpent"))
        # A refused debit spends nothing and so counts nothing.
        page.evaluate("window.__game.debit('coins', 999999)")
        assert stat("coinsSpent") == spent0 + 120, ("a refused spend counts nothing", stat("coinsSpent"))

        # Helper uses tick both the helper's own counter and the combined props total.
        page.evaluate("window.__game.grantBooster('shuffle', 3)")
        sh0, pr0 = stat("shuffleUsed"), stat("propsUsed")
        page.evaluate("async () => { await window.__game.startLevel(2); window.__game.closeTutorial(); }")
        time.sleep(1.0)
        page.evaluate("window.__game.reshuffle()")
        time.sleep(0.8)
        assert stat("shuffleUsed") == sh0 + 1, ("a reshuffle counts", stat("shuffleUsed"))
        assert stat("propsUsed") == pr0 + 1, ("…and also counts as a prop used", stat("propsUsed"))

        # Tiles matched are credited as the level's WHOLE tile count, and only when
        # the level is actually completed. We are standing in level 2 (started for
        # the reshuffle check above), so its board count is that known total.
        tm0 = stat("tilesMatched")
        total2 = page.evaluate("window.__game.state()")["boardCount"]
        assert total2 > 0 and total2 % 3 == 0, ("a level is a whole number of triples", total2)
        # Matching mid-level must move nothing: an attempt in progress has not been
        # completed yet, and might still be abandoned or lost.
        for _ in range(6):
            if page.evaluate("window.__game.solveTap()") < 0:
                break
            time.sleep(0.05)
        time.sleep(0.6)
        assert page.evaluate("window.__game.state()")["boardCount"] < total2, "some tiles were collected"
        assert stat("tilesMatched") == tm0, (
            "matching mid-level counts nothing until the level is finished", tm0, stat("tilesMatched"))
        # Finishing it credits the level total, exactly once and exactly in full.
        for _ in range(400):
            if page.evaluate("window.__game.solveTap()") < 0:
                break
            time.sleep(0.02)
        page.wait_for_function("window.__game.state().boardCount === 0", timeout=15000)
        time.sleep(1.2)
        tm = stat("tilesMatched")
        print("TILES MATCHED -> level 2 total", total2, ":", tm0, "->", tm)
        assert tm - tm0 == total2, ("completing a level credits its whole tile count", tm0, tm, total2)

        # Winning level 2 is a REPLAY (9 levels were already cleared), so it must
        # not count — "levels completed" is first clears only.
        lc = stat("levelsCompleted")
        assert lc == 10, ("replaying a cleared level counts nothing", lc)

        # ABANDONING a level credits nothing, however much was matched in it.
        page.evaluate("async () => { await window.__game.startLevel(3); window.__game.closeTutorial(); }")
        time.sleep(1.0)
        tm0 = stat("tilesMatched")
        for _ in range(6):
            if page.evaluate("window.__game.solveTap()") < 0:
                break
            time.sleep(0.05)
        time.sleep(0.6)
        page.evaluate("window.__game.exitLevel()")
        time.sleep(0.6)
        print("AFTER ABANDON ->", tm0, "->", stat("tilesMatched"))
        assert stat("tilesMatched") == tm0, (
            "walking out of a level credits none of its tiles", tm0, stat("tilesMatched"))

        # AUTO COMPLETE credits the full total too. The sweep never goes through the
        # matching path — it marks the remaining tiles cleared and declares the win
        # directly — so this is the case a per-match tally silently under-counts.
        page.evaluate("async () => { await window.__game.startLevel(3); window.__game.closeTutorial(); }")
        time.sleep(1.0)
        tm0 = stat("tilesMatched")
        total3 = page.evaluate("window.__game.state()")["boardCount"]
        swept = 0
        for _ in range(400):
            a = page.evaluate("window.__game.autoState()")
            if a["available"]:
                swept = a["total"]
                page.evaluate("window.__game.autoComplete()")
                break
            if page.evaluate("window.__game.solveTap()") < 0:
                break
            time.sleep(0.02)
        assert swept > 0, "the level-3 descent should pass through the Auto Complete window"
        page.wait_for_function("window.__game.state().boardCount === 0", timeout=20000)
        time.sleep(1.5)
        tm = stat("tilesMatched")
        print("AFTER AUTO COMPLETE -> level 3 total", total3, "swept", swept, ":", tm0, "->", tm)
        assert tm - tm0 == total3, (
            "an auto-completed level credits its whole tile count, sweep included",
            tm0, tm, total3, swept)
        # Leave through the win overlay's own Continue, back to the lobby.
        page.evaluate("window.__game.pressWinContinue()")
        page.wait_for_function("window.__game.inLobby() === true", timeout=15000)
        time.sleep(0.4)

        # Winning level 2 is a REPLAY (9 levels were already cleared), so it must
        # not count — "levels completed" is first clears only.
        lc = stat("levelsCompleted")
        assert lc == 10, ("replaying a cleared level counts nothing", lc)

        # Wheel spins and daily-gift claims count at their own sites.
        page.evaluate("window.__game.setDailyToday('2050-06-15')")
        d0 = stat("dailyBonusClaimed")
        page.evaluate("window.__game.openDailyBonus()")
        time.sleep(0.5)
        page.evaluate("window.__game.pickDailyBox(0)")
        time.sleep(1.2)
        assert stat("dailyBonusClaimed") == d0 + 1, ("a daily claim counts", stat("dailyBonusClaimed"))
        page.evaluate("window.__game.takeDailyBonus()")
        time.sleep(1.2)

        w0 = stat("wheelSpins")
        page.evaluate("window.__game.setWheelToday('2050-06-15')")
        page.evaluate("window.__game.openWheel()")
        time.sleep(0.5)
        page.evaluate("window.__game.spinWheel()")
        time.sleep(4.0)
        assert stat("wheelSpins") == w0 + 1, ("a wheel spin counts", stat("wheelSpins"))
        # The wheel has no close hook; a reload is the clean way back to the lobby.
        page.reload()
        page.wait_for_function("window.__game && !!window.__game.tasksState", timeout=20000)
        time.sleep(0.6)

        # A shop package purchase counts once, on success.
        sp0 = stat("shopPurchases")
        pkg = page.evaluate("window.__game.packages()")[0]["id"]
        page.evaluate(f"window.__game.buyPackage({json.dumps(pkg)})")
        time.sleep(0.8)
        assert stat("shopPurchases") == sp0 + 1, ("a package purchase counts", stat("shopPurchases"))

        # ---- 6. Counters and claims survive a reload ------------------------
        before = stats()
        flush()
        page.reload()
        page.wait_for_function("window.__game && !!window.__game.tasksState", timeout=20000)
        time.sleep(0.6)
        assert stats() == before, ("lifetime counters persist", before, stats())
        assert page.evaluate("window.__game.taskClaimed('levels:1')") is True, "claims persist"

        # ---- 7. Weekly tasks ------------------------------------------------
        setweek(WEEK0)
        time.sleep(0.3)
        s = st()
        assert s["week"] == WEEK0, ("the week rolled to the pinned key", s)
        open_t()
        time.sleep(0.5)
        tab("weekly")
        time.sleep(0.4)
        s = st()
        assert s["tab"] == "weekly", s
        assert "New Tasks Every Week!" in s["note"], ("the weekly banner", s["note"])
        assert "Reset in:" in s["note"], ("a live countdown to the reset", s["note"])
        page.screenshot(path=f"{SC}/tasks_2_weekly.png")

        # Weekly progress is measured from the week's baseline, NOT the lifetime
        # total — the counters above are all well past these targets already.
        wk = rows("weekly")
        print("WEEKLY ->", [(r["id"], r["count"], r["target"], r["claimable"]) for r in wk])
        assert wk, "the weekly list has goals"
        assert all(r["count"] == 0 for r in wk), ("a fresh week starts at zero", wk)
        assert all(not r["claimable"] for r in wk), wk

        # Driving an activity moves the weekly row and the lifetime one together.
        life0 = stat("levelsCompleted")
        bump("levelsCompleted", 5)
        assert wstat("levelsCompleted") == 5, ("weekly progress = lifetime - baseline", wstat("levelsCompleted"))
        assert stat("levelsCompleted") == life0 + 5, ("…while the lifetime total keeps climbing", stats())
        page.evaluate("window.__game.openTasks()")
        time.sleep(0.5)
        tab("weekly")
        time.sleep(0.4)
        w_levels = [r for r in rows("weekly") if r["id"] == "w_levels"][0]
        assert w_levels["claimable"] is True, ("5 levels this week finishes the weekly goal", w_levels)

        wc0 = coins()
        claim("w_levels")
        assert coins() == wc0 + 75, ("the weekly reward pays out", wc0, coins())
        assert "w_levels" not in ids("weekly"), ("a claimed weekly task leaves the list", ids("weekly"))

        # The reset re-arms everything, INCLUDING tasks already claimed.
        setweek(WEEK1)
        time.sleep(0.4)
        assert st()["week"] == WEEK1, st()
        assert page.evaluate("window.__game.taskClaimed('w_levels', true)") is False, "the weekly ledger is wiped"
        assert wstat("levelsCompleted") == 0, ("progress restarts from the new baseline", wstat("levelsCompleted"))
        wk = rows("weekly")
        assert "w_levels" in [r["id"] for r in wk], ("a claimed weekly task returns after the reset", wk)
        assert all(r["count"] == 0 for r in wk), wk
        # Achievements are untouched by the weekly reset.
        assert page.evaluate("window.__game.taskClaimed('levels:1')") is True, "achievements never reset"

        # ---- 8. The red dot clears when nothing is left ---------------------
        page.evaluate("window.__game.closeTasks()")
        time.sleep(0.3)
        # Claim everything currently claimable on both tabs.
        for _ in range(40):
            if not st()["hasClaimable"]:
                break
            page.evaluate("window.__game.openTasks()")
            time.sleep(0.45)
            target = None
            for t in ("achievements", "weekly"):
                cand = [r for r in rows(t) if r["claimable"]]
                if cand:
                    tab(t)
                    time.sleep(0.35)
                    target = cand[0]["id"]
                    break
            if target is None:
                break
            claim(target)
            page.evaluate("window.__game.closeTasks()")
            time.sleep(0.25)
        s = st()
        print("AFTER CLAIM SWEEP ->", "hasClaimable", s["hasClaimable"], "badge", s["badge"])
        assert s["hasClaimable"] is False, ("nothing left to collect", s)
        assert s["badge"] is False, ("the red dot goes out", s)
        # …and the button itself stays: Tasks is permanent once unlocked.
        assert s["buttonVisible"] is True, ("the Tasks button never goes away again", s)

        # ---- 9. Scrolling ---------------------------------------------------
        page.evaluate("window.__game.openTasks()")
        time.sleep(0.5)
        tab("achievements")
        time.sleep(0.4)
        sc = page.evaluate("window.__game.tasksScroll()")
        print("SCROLL ->", sc)
        assert sc["scrollable"] is True, ("the achievements list is taller than its viewport", sc)
        assert sc["y"] == 0, ("it opens at the top", sc)
        # It clamps at both ends rather than dragging off into space.
        sc = page.evaluate("window.__game.scrollTasks(-100000)")
        assert sc["y"] == sc["min"], ("clamped at the bottom", sc)
        sc = page.evaluate("window.__game.scrollTasks(100000)")
        assert sc["y"] == 0, ("clamped at the top", sc)

        # A DRAG must scroll the list and must NOT fire the Claim under the finger.
        # Put a claimable row up first so there is a Claim button to hit.
        bump("tilesMatched", 100000)
        page.evaluate("window.__game.openTasks()")
        time.sleep(0.5)
        top = rows("achievements")[0]
        assert top["claimable"] is True, ("a claimable row is on top to drag over", top)
        c3 = coins()
        # Drag from the middle of that row's Claim button, upward — but only far
        # enough to stay ON the button. That is the case the guard exists for: a
        # longer drag ends over some other object and Pixi never fires a tap at
        # all, so it would prove nothing. A SHORT flick both scrolls and releases
        # on the Claim, and must still not pay out.
        r = page.evaluate(f"window.__game.taskClaimRect({json.dumps(top['id'])})")
        assert r, ("the top row has a Claim button on screen", top)
        cx, cy = r["x"] + r["w"] / 2, r["y"] + r["h"] / 2
        drag = 20
        assert drag < r["h"] / 2, ("the flick has to end inside the button", r)
        page.mouse.move(cx, cy)
        page.mouse.down()
        for i in range(1, 11):
            page.mouse.move(cx, cy - i * (drag / 10))
            time.sleep(0.02)
        page.mouse.up()
        time.sleep(0.6)
        sc = page.evaluate("window.__game.tasksScroll()")
        print("AFTER DRAG ->", sc, "coins", c3, coins())
        assert sc["y"] <= -(drag - 2), ("the flick scrolled the list by the drag distance", sc)
        assert coins() == c3, ("a drag must never also claim the row under it", c3, coins())
        assert page.evaluate(f"window.__game.taskClaimed({json.dumps(top['id'])})") is False, (
            "…and the row is still unclaimed", top)
        # A plain tap on that same button, with no drag, DOES claim it — so the
        # guard is rejecting the gesture, not breaking the button.
        claim(top["id"])
        assert coins() > c3, ("a tap on the same button still claims", c3, coins())
        page.screenshot(path=f"{SC}/tasks_3_scrolled.png")
        page.evaluate("window.__game.closeTasks()")
        time.sleep(0.3)

        # ---- 10. v6 -> v7 migration -----------------------------------------
        # An existing profile predating the feature: its level history is derived
        # into the lifetime counter (nothing else could be), and the week baseline
        # matches it so the WEEKLY list still starts from zero.
        uid = page.evaluate("() => localStorage.getItem('tilemaster.uid')")
        v6 = {
            "version": 6, "id": uid, "platform": "web", "name": "",
            "progress": {"level": 8, "completed": 7},
            "wallet": {"coins": 400, "gems": 0},
            "boosters": {"undo": 1, "shuffle": 1, "wand": 1},
            "boosterUnlocks": ["undo", "wand", "shuffle"],
            "boosterCoach": ["undo", "wand", "shuffle"],
            "settings": {"music": True, "sound": True},
            "fortuneWheel": {"group": 0, "day": "", "spinsUsed": 0, "won": [], "seen": False},
            "dailyBonus": {"lastClaimDay": ""},
        }
        page.evaluate(
            "([k, v]) => localStorage.setItem(k, v)",
            [f"tilemaster.user:{uid}", json.dumps(v6)])
        page.reload()
        page.wait_for_function("window.__game && !!window.__game.tasksState", timeout=20000)
        time.sleep(0.6)
        prof = page.evaluate("window.__game.user()")
        print("MIGRATED ->", prof["version"], prof["tasks"])
        assert prof["version"] == 7, ("the profile migrated to v7", prof["version"])
        assert prof["tasks"]["stats"]["levelsCompleted"] == 7, (
            "levels completed is derived from progress.completed", prof["tasks"])
        assert prof["tasks"]["claimed"] == [], ("nothing is pre-claimed", prof["tasks"])
        assert prof["tasks"]["weekly"]["base"]["levelsCompleted"] == 7, (
            "the week baseline matches, so weekly starts at zero", prof["tasks"])
        assert wstat("levelsCompleted") == 0, ("…and it really reads as zero", wstat("levelsCompleted"))
        # This profile is still short of the gate (7 cleared, 9 needed), so the
        # button stays hidden — but the derived history has already stacked up the
        # tiers it earned, which is the point of deriving it at all. They are
        # waiting to be claimed the moment the feature opens.
        s = st()
        assert s["unlocked"] is False and s["buttonVisible"] is False, (
            "completed 7 is still below the level-10 gate", s)
        stacked = [r for r in rows("achievements")
                   if r["activity"] == "levelsCompleted" and r["claimable"]]
        assert [r["target"] for r in stacked] == [1, 5], (
            "the tiers the migrated history already earned are stacked up", stacked)

        # ---- 11. Profile reset wipes it -------------------------------------
        page.evaluate("window.__game.reset()")
        time.sleep(0.5)
        prof = page.evaluate("window.__game.user()")
        assert prof["tasks"]["stats"] == {}, ("reset clears the counters", prof["tasks"])
        assert prof["tasks"]["claimed"] == [], ("reset clears the claim ledger", prof["tasks"])
        assert st()["unlocked"] is False, ("reset re-locks the feature", st())

        print("ERRORS:", len(errs))
        for e in errs[:10]:
            print("  ", e)
        assert not errs, ("no console/page errors", errs)
        print("TASKS TEST PASSED")
        b.close()
finally:
    srv.terminate()
