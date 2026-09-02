import time, os
from playwright.sync_api import sync_playwright

import harness
SC = os.path.join(os.path.dirname(os.path.abspath(__file__)), "output")
os.makedirs(SC, exist_ok=True)
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
os.chdir(ROOT)
BASE = harness.serve()

# The SUPER WAND — the Wand's upgraded form, and the only helper that is EARNED
# rather than bought. Consecutive NEW level clears charge it; once charged it takes
# the ordinary Wand's own button over, and one tap sweeps at least two COMPLETE
# sets off the board in a single combined elimination. The streak earns the UPGRADE,
# not free uses: a sweep is still a wand press, so it costs one Wand use down the
# same waterfall every helper runs (own stock → buy with coins → watch an ad) and
# counts toward the wandUsed / boostersUsed totals like any other. What it never
# spends is the charge itself — only an accepted loss takes that away.
#
# The rule it must never break is that it only ever eliminates whole sets of three
# — the batch is always a multiple of 3 — because sweeping a partial set away would
# delete the player's progress rather than cash it in.
#
# See wand_test.py for the ordinary Wand it upgrades, which must keep working
# untouched whenever no charge is banked.

# The smallest level past the unlock gate (30 tiles), so the two tests that need a
# GENUINE level win don't spend a minute each grinding taps.
SMALL_LEVEL = 11


def solve(page, guard=400):
    """Play a level out to its win overlay through the guaranteed solution order."""
    n = 0
    while True:
        s = page.evaluate("window.__game.state()")
        if s["overlay"] or s["boardCount"] == 0:
            break
        if page.evaluate("window.__game.solveTap()") == -1:
            break
        time.sleep(0.16)
        n += 1
        assert n < guard, "too many taps — the board did not solve"
    harness.settle(page, "window.__game.state().overlay", timeout=8000)


with sync_playwright() as p:
    b, page, errs = harness.launch(p, viewport=(780, 1334))
    harness.boot(page, "window.__game && window.__game.scene")

    CFG = page.evaluate("window.__game.config()")["boosters"]["superWand"]
    UNLOCK, NEED = CFG["unlockLevel"], CFG["streakLength"]
    MIN_TILES, EXTRA = CFG["minTiles"], CFG["extraRounds"]
    print("config:", CFG)
    assert MIN_TILES % 3 == 0, ("the sweep target must be whole sets", CFG)

    def sw():      return page.evaluate("window.__game.superWandState()")
    def prev():    return page.evaluate("window.__game.superWandPreview()")
    def bar():     return page.evaluate("window.__game.superWandBar()")
    def st():      return page.evaluate("window.__game.state()")
    def free():    return page.evaluate("window.__game.freeTiles()")
    def wcount():  return page.evaluate("window.__game.boosterCount('wand')")

    def enter(level):
        page.evaluate("async (n) => { await window.__game.startLevel(n);"
                      " window.__game.closeTutorial(); }", level)
        harness.settle(page, f"window.__game.state().level === {level}", timeout=15000)
        harness.frames(page)

    def tap(tile_id):
        page.evaluate("(id) => window.__game.scene._onTapTile(window.__game.scene.tiles[id])",
                      tile_id)
        time.sleep(0.16)

    def charge_and_enter(level):
        """Charge a Super Wand and enter a level with it banked — the REAL flow.
        A charge is only ever won on a level-complete screen, so it is announced on
        the next board that loads (loadLevel), not mid-level."""
        page.evaluate("window.__game.chargeSuperWand()")
        enter(level)
        harness.settle(page, "window.__game.superWandState().announced", timeout=8000)
        harness.frames(page)

    def sweep():
        """Fire the sweep and wait for control to come back. Clears any tray
        message the PLAYER's own taps raised first, so what is left afterwards is
        attributable to the sweep alone (the pill lingers ~1.4s as it fades)."""
        page.evaluate("window.__game.scene._clearTrayMessage()")
        page.evaluate("window.__game.superWand()")
        harness.settle(page, "!window.__game.superWandState().running"
                             " && !window.__game.state().locked", timeout=15000)
        harness.frames(page)

    # ---- 1) THE GATE ------------------------------------------------------
    # The streak only accrues from CONFIG.boosters.superWand.unlockLevel onward,
    # on the usual "available from level N" convention (cleared N-1).
    s = sw()
    print("fresh profile:", s)
    assert s["unlocked"] is False, ("a new player is behind the gate", s)
    assert s["streak"] == 0 and s["charged"] is False, s
    page.evaluate(f"window.__game.completeLevel({UNLOCK - 2})")
    assert sw()["unlocked"] is False, ("one level short of the gate is still shut", sw())
    # Below the gate, wins do not count at all.
    page.evaluate("window.__game.superWandWin()")
    assert sw()["streak"] == 0, ("a win below the gate counts for nothing", sw())

    page.evaluate(f"window.__game.completeLevel({UNLOCK - 1})")
    s = sw()
    print("at the gate:", s)
    assert s["unlocked"] is True and s["streak"] == 0, s

    # ---- 2) CHARGING ------------------------------------------------------
    # Each counted win fills one notch; the last one banks a Super Wand, and further
    # wins leave it pinned at the top rather than overflowing.
    for i in range(1, NEED + 1):
        page.evaluate("window.__game.superWandWin()")
        s = sw()
        assert s["streak"] == i, (f"win {i} fills notch {i}", s)
        assert s["charged"] is (i >= NEED), (f"charged only on win {NEED}", s)
    page.evaluate("window.__game.superWandWin()")
    s = sw()
    print("after an extra win:", s)
    assert s["streak"] == NEED and s["charged"] is True, ("pinned full while banked", s)

    # ---- 3) PERSISTENCE ---------------------------------------------------
    # A streak reward is only meaningful if it survives closing the game.
    page.evaluate("window.__game.flushSave()")
    time.sleep(0.25)
    page.reload()
    page.wait_for_function("window.__game && window.__game.scene", timeout=60000)
    s = sw()
    print("after a reload:", s)
    assert s["charged"] is True and s["streak"] == NEED, ("the charge survived a reload", s)

    page.evaluate("window.__game.markBoosterCoached('all')")  # skip the helper lessons

    # ---- 4) THE BUTTON TAKEOVER ------------------------------------------
    # It gets no button of its own: it takes the Wand's over, and the changeover is
    # announced with a beat, an effect and a scale-punch rather than a silent swap.
    enter(SMALL_LEVEL)
    s = sw()
    print("on entry, mid-announce:", s)
    assert s["active"] is True, ("a banked charge owns the button", s)
    assert s["mode"] == "stock" and s["icon"] == "🪄", \
        ("the face is still the ordinary Wand's during the announce beat", s)
    harness.settle(page, "window.__game.superWandState().announced", timeout=8000)
    harness.frames(page)
    s = sw()
    print("after the upgrade beat:", s)
    assert s["mode"] == "super", ("the button changed to its upgraded mode", s)
    assert s["icon"] == "✨" and s["icon"] != "🪄", ("…and to its upgraded art", s)
    assert s["badge"] == str(wcount()), \
        ("the badge carries the WAND's stock — a sweep costs one use, so the"
         " player has to be able to see how many are left", s, wcount())
    assert s["usable"] is True, s
    assert "super_hint" in page.evaluate("window.__game.soundLog()"), \
        "the upgrade moment has its own cue"
    # The two modes must not both be live: while charged the ordinary Wand is inert,
    # even when called directly, so they can never interleave.
    wand_before = wcount()
    page.evaluate("window.__game.wand()")
    time.sleep(0.4)
    assert wcount() == wand_before, ("wand() is a no-op while the upgrade is banked", wcount())
    assert st()["tray"] == [], "…and it completed no triple"

    # ---- 5) THE BATCH: whole sets, cheapest first ------------------------
    # From an EMPTY tray there is nothing to complete, so the batch is topped up
    # with whole fresh triples off the board — two of them, six tiles.
    pv = prev()
    print("empty-tray preview:", {"total": pv["total"],
                                  "sets": [(x["type"], x["need"], x["have"]) for x in pv["sets"]]})
    assert pv["total"] >= MIN_TILES, ("a sweep clears at least two full sets", pv["total"])
    assert pv["total"] % 3 == 0, ("the batch is always whole sets", pv["total"])
    assert len(pv["sets"]) == 2, ("two sets is the target", pv["sets"])
    assert all(x["need"] == 3 and x["have"] == 0 for x in pv["sets"]), \
        ("an empty tray means whole triples pulled off the board", pv["sets"])
    assert len({x["type"] for x in pv["sets"]}) == 2, ("two DIFFERENT colours", pv["sets"])
    assert len(pv["sets"]) <= EXTRA, ("…within the top-up budget", pv["sets"])
    # The sweep must favour tiles the player could plausibly have reached — the same
    # availability-first rule the ordinary Wand follows (wand_test.py §2b). Stated
    # exactly: within a set, tiles are drawn most-accessible-first, and a COVERED
    # tile is used only when that colour hasn't enough free ones left to finish.
    # (A naive picker that grabbed tiles in id order would fail both halves.)
    def board_by_type():
        return page.evaluate("""() => {
            const m = {};
            for (const t of window.__game.scene.tiles) {
                if (t.inTray || t.matched) continue;
                (m[t.type] = m[t.type] || []).push(t.aliveCovers === 0);
            }
            return m;
        }""")

    def assert_availability_first(pv, board):
        for s_ in pv["sets"]:
            covs = [t["cov"] for t in s_["tiles"]]
            assert covs == sorted(covs), \
                ("a set draws its free tiles before its covered ones", s_)
            free_avail = sum(1 for f in board[str(s_["type"])] if f)
            used_covered = sum(1 for t in s_["tiles"] if not t["free"])
            assert used_covered == max(0, s_["need"] - free_avail), \
                ("covered tiles are used only when the colour runs out of free ones",
                 s_, free_avail)

    assert_availability_first(pv, board_by_type())

    # Now the ordering rule: a waiting PAIR is a cheaper completion than a lone
    # single, so it must be finished first. Build one of each.
    tiles = free()
    by_type = {}
    for t in tiles:
        by_type.setdefault(t["type"], []).append(t["id"])
    # Deliberately give the PAIR the HIGHER face id: a picker that ignored
    # "cheapest first" and just walked the tray colours in face-id (or tray) order
    # would then finish the single first and fail below. Without this the
    # assertion can pass by coincidence — a regression test that cannot fail is
    # not one.
    pair_type = max((ty for ty, ids in by_type.items() if len(ids) >= 2), default=None)
    single_type = min((ty for ty in by_type if ty != pair_type), default=None)
    assert pair_type is not None and single_type is not None, \
        ("sanity: the opening board offers a pair and a second colour", by_type)
    assert single_type < pair_type, \
        ("sanity: the single's face id must be the LOWER one for this to be a real "
         "test of the ordering rule", pair_type, single_type, by_type)
    tap(by_type[pair_type][0]); tap(by_type[pair_type][1])
    tap(by_type[single_type][0])
    s0 = st()
    assert len(s0["tray"]) == 3, ("a waiting pair plus a single", s0)
    pv = prev()
    print("pair+single preview:", [(x["type"], x["need"], x["have"]) for x in pv["sets"]])
    assert pv["sets"][0]["type"] == pair_type, \
        ("the pair — one tile from done — is completed FIRST", pv["sets"])
    assert pv["sets"][0]["need"] == 1 and pv["sets"][0]["have"] == 2, pv["sets"]
    assert pv["sets"][1]["type"] == single_type and pv["sets"][1]["need"] == 2, pv["sets"]
    assert pv["total"] == 6 and pv["total"] % 3 == 0, pv
    assert all(x["need"] + x["have"] == 3 for x in pv["sets"]), \
        ("never a partial set", pv["sets"])
    assert_availability_first(pv, board_by_type())

    # ---- 6) THE SWEEP -----------------------------------------------------
    before = st()
    pulled = len(pv["tiles"])
    page.evaluate("window.__game.clearSoundLog()")
    sweep()
    after = st()
    # ONE combined elimination, not a rapid sequence of matches: a single sweep
    # cue and a single merge, however many sets went with it.
    log = page.evaluate("window.__game.soundLog()")
    print("sweep sounds:", log)
    assert log.count("super_hint") == 1 and log.count("merge_click") == 1, \
        ("the whole batch resolves as one event, with one burst and one merge", log)
    # A sweep must not cry "Insufficient space!" on its way through. This sweep
    # lands the tray on exactly capacity-1 for a beat, which is precisely where the
    # near-full bubble would fire — but those tiles are already spoken for, so
    # warning about them mid-celebration would be a lie. (Regression: it did.)
    tw = page.evaluate("window.__game.trayWarning()")
    print("tray warning after the sweep:", tw)
    assert tw["message"] == "", ("a sweep must not raise the near-full warning", tw)
    print("swept:", {"board": (before["boardCount"], after["boardCount"]),
                     "tray": (before["tray"], after["tray"])})
    assert before["boardCount"] - after["boardCount"] == pulled, \
        ("exactly the previewed tiles left the board", before, after)
    cleared = (before["boardCount"] + len(before["tray"])) - \
              (after["boardCount"] + len(after["tray"]))
    assert cleared == 6 and cleared % 3 == 0, ("six tiles — two whole sets — cleared", cleared)
    assert after["tray"] == [], ("both completed sets left the tray", after)
    assert after["overlay"] is False and after["locked"] is False, \
        ("control comes back and the level stays playable", after)
    # A SWEEP DOES NOT CONSUME THE CHARGE. The reward is the win streak itself,
    # not a single-shot token: the button stays upgraded and the next press sweeps
    # again, for as long as the streak lives. Only accepting a loss ever takes it
    # away (section 12). What a sweep DOES cost is one ordinary WAND use — the
    # streak earns the upgrade, not free uses.
    s = sw()
    print("after the sweep:", s, "| wand stock", wand_before, "->", wcount())
    assert s["charged"] is True and s["streak"] == NEED, \
        ("using a Super Wand must NOT consume it", s)
    assert s["mode"] == "super" and s["icon"] == "✨", \
        ("…so the button is still the upgraded one", s)
    assert wcount() == wand_before - 1, \
        ("a sweep spends one WAND use, like any other wand press",
         wand_before, wcount())

    # And it really does fire again: a second press sweeps a second batch of whole
    # sets off the same board, spending a second wand use, with the charge still
    # standing afterwards.
    page.evaluate("window.__game.grantBooster('wand', 1)")
    w0, b0 = wcount(), st()["boardCount"]
    sweep()
    b1 = st()["boardCount"]
    print("second sweep on the same board:", b0, "->", b1, sw())
    assert b0 > b1 and (b0 - b1) % 3 == 0, \
        ("the second press sweeps again, by whole sets", b0, b1)
    assert sw()["charged"] is True, ("and still leaves the charge standing", sw())
    assert wcount() == w0 - 1, ("…having spent another wand use", w0, wcount())

    # ---- 6b) THE ACQUISITION WATERFALL ------------------------------------
    # Out of wand stock, the sweep follows the SAME ladder every helper does:
    # own → buy with coins → watch a (stubbed) rewarded ad. It never becomes free
    # just because the button is gold.
    page.evaluate("() => { const u = window.__game.scene.user;"
                  " u.boosters.wand = 0; u._emit('boosters'); }")
    price = page.evaluate("window.__game.scene._boosterPrice('wand')")
    page.evaluate(f"window.__game.credit('coins', {price})")
    harness.frames(page)
    s = sw()
    print("out of wand stock, affordable:", s["badge"], "| usable:", s["usable"])
    assert s["badge"] == str(price), \
        ("with none left the badge shows the BUY price, not a bare star", s, price)
    assert s["usable"] is True, ("…and the button stays pressable", s)
    coins0, b0 = page.evaluate("window.__game.balance('coins')"), st()["boardCount"]
    sweep()
    print("buy tier: coins", coins0, "->", page.evaluate("window.__game.balance('coins')"),
          "| board", b0, "->", st()["boardCount"])
    assert page.evaluate("window.__game.balance('coins')") == coins0 - price, \
        ("the sweep paid the wand's coin price", coins0, price)
    assert b0 - st()["boardCount"] >= MIN_TILES, ("…and swept", b0, st()["boardCount"])
    assert wcount() == 0, ("buy-then-use nets no stock", wcount())

    # Broke as well: the ad tier. Still usable, still free, still a full sweep.
    page.evaluate("() => { const u = window.__game.scene.user;"
                  " u.wallet.coins = 0; u._emit('wallet'); }")
    harness.frames(page)
    s = sw()
    print("out of stock and broke:", s["badge"], "| usable:", s["usable"])
    assert s["usable"] is True, ("the ad tier is never greyed out", s)
    b0 = st()["boardCount"]
    sweep()
    print("ad tier: board", b0, "->", st()["boardCount"])
    assert page.evaluate("window.__game.balance('coins')") == 0, "the ad tier costs no coins"
    assert b0 - st()["boardCount"] >= MIN_TILES, ("…and swept", b0, st()["boardCount"])
    assert sw()["charged"] is True, ("the charge is still untouched", sw())

    # ---- 7) RAPID TAPS ----------------------------------------------------
    # The sweep is long and dramatic, which makes double-spending easy: the button
    # must be inert for the whole of it.
    charge_and_enter(SMALL_LEVEL)
    page.evaluate("window.__game.grantBooster('wand', 4)")
    w_before = wcount()
    b0 = st()["boardCount"]
    page.evaluate("window.__game.superWand(); window.__game.superWand()")
    harness.settle(page, "!window.__game.superWandState().running"
                         " && !window.__game.state().locked", timeout=15000)
    harness.frames(page)
    b1 = st()["boardCount"]
    print("double-fire: board", b0, "->", b1)
    assert b0 - b1 <= 6, ("a double-tap sweeps once, not twice", b0, b1)
    assert (b0 - b1) % 3 == 0, ("…and still by whole sets", b0, b1)
    assert sw()["charged"] is True, ("a sweep never consumes the charge", sw())
    assert wcount() == w_before - 1, \
        ("…and it spends ONE wand use, not two", w_before, wcount())

    # ---- 8) NEAR-FULL TRAY ------------------------------------------------
    # The incoming tiles take the tray briefly OVER capacity before they resolve.
    # That has to be safe, not merely assumed to be: verify no loss is triggered.
    charge_and_enter(SMALL_LEVEL)
    cap = page.evaluate("window.__game.scene.traySlots")
    by_type = {}
    for t in free():
        by_type.setdefault(t["type"], []).append(t["id"])
    singles = [ids[0] for ids in by_type.values()][:cap - 1]
    assert len(singles) == cap - 1, \
        ("sanity: enough distinct colours to fill the tray to capacity-1", by_type)
    for tid in singles:
        tap(tid)
    s0 = st()
    print(f"tray filled to {len(s0['tray'])} of {cap}:", s0["tray"])
    assert len(s0["tray"]) == cap - 1, ("one slot from a loss", s0)
    assert s0["overlay"] is False, "not lost yet"
    pv = prev()
    assert pv["total"] % 3 == 0, pv
    sweep()
    s1 = st()
    print("after the near-full sweep:", s1)
    assert page.evaluate("window.__game.loseState()")["loseOverlay"] is False, \
        "a sweep into a nearly-full tray must not lose the level"
    # …nor raise a warning of its own (sweep() clears the one the hand-taps above
    # legitimately raised, so anything here came from the sweep).
    tw = page.evaluate("window.__game.trayWarning()")
    print("tray warning after the near-full sweep:", tw)
    assert tw["message"] == "", \
        ("a sweep must not raise the near-full tray warning", tw)
    assert tw["free"] > 0, ("…and the tray really did free up", tw)
    assert s1["overlay"] is False, ("the level is still being played", s1)
    assert len(s1["tray"]) < cap, ("the tray ended under capacity", s1, cap)
    assert len(s1["tray"]) < len(s0["tray"]), ("…and freed up rather than growing", s0, s1)

    # ---- 9) NOTHING TO GATHER: a no-op that KEEPS the charge --------------
    # A wasted reward is worse than a no-op. Force the degenerate board (nothing
    # left to pull from) and check the charge is still banked afterwards.
    charge_and_enter(SMALL_LEVEL)
    page.evaluate("""() => {
        const s = window.__game.scene;
        for (const t of s.tiles) if (!t.inTray && !t.matched) t.matched = true;
        s.boardCount = 0;
    }""")
    assert prev() is None, "nothing can be gathered off an empty board"
    w_before = wcount()
    page.evaluate("window.__game.superWand()")
    time.sleep(0.6)
    s = sw()
    print("no-op sweep:", s)
    assert s["charged"] is True and s["streak"] == NEED, \
        ("a sweep that can gather nothing changes nothing", s)
    assert wcount() == w_before, \
        ("…and above all charges no wand use for the no-op", w_before, wcount())
    assert st()["overlay"] is False, "…and must leave the level playable"

    # ---- 10) LEVEL ALREADY WON -> the button does nothing ------------------
    page.evaluate(f"window.__game.completeLevel(20)")   # every level is now a replay
    enter(SMALL_LEVEL)
    page.evaluate("window.__game.chargeSuperWand()")
    solve(page)
    assert st()["overlay"] is True, "the win overlay is up"
    # A replay must not advance the streak — only genuinely NEW clears count, the
    # same rule the Level Chest uses, so a charge can't be farmed on one easy level.
    s = sw()
    print("after replaying a beaten level:", s)
    assert s["streak"] == NEED and s["charged"] is True, \
        ("a replay leaves the streak untouched", s)
    assert bar()["shown"] is False, ("…and shows no streak bar", bar())
    b0, w0 = st()["boardCount"], wcount()
    page.evaluate("window.__game.superWand()")
    time.sleep(0.6)
    assert st()["boardCount"] == b0, "the sweep does nothing once the level is won"
    assert sw()["charged"] is True, "…and leaves the charge alone"
    assert wcount() == w0, "…and spends no wand use either"

    # ---- 11) A GENUINELY NEW CLEAR CHARGES IT, AND SAYS SO ----------------
    # Reset to just under the gate's far side so SMALL_LEVEL is a new clear again.
    page.evaluate("async () => { await window.__game.reset(); }")
    harness.frames(page)
    # A profile wipe takes the Super Wand with it — a banked charge must not
    # survive a reset the way it survives a loss.
    s = sw()
    print("after a profile reset:", s)
    assert s["streak"] == 0 and s["charged"] is False, \
        ("reset() wipes the streak and any banked charge", s)
    assert s["unlocked"] is False, ("…and puts it back behind its gate", s)
    page.evaluate(f"window.__game.completeLevel({SMALL_LEVEL - 1})")
    page.evaluate("window.__game.markBoosterCoached('all')")
    assert sw()["unlocked"] is True and sw()["streak"] == 0, sw()
    enter(SMALL_LEVEL)
    solve(page)
    s = sw()
    print("after a real new clear:", s)
    assert s["streak"] == 1, ("winning a new level fills one notch", s)
    bs = bar()
    print("streak bar:", bs)
    assert bs["shown"] is True, ("progress is shown on the level-complete screen", bs)
    assert bs["from"] == 0 and bs["to"] == 1 and bs["needed"] == NEED, bs
    assert str(NEED) in bs["caption"], ("the label names the streak length", bs)
    harness.settle(page, "window.__game.superWandBar().label === '1 / %d'" % NEED, timeout=6000)
    # The chest bar shares this screen — both must be up, and must not collide.
    chest = page.evaluate("window.__game.chestState()")
    if chest["shown"]:
        btn_y = page.evaluate("window.__game.scene._winBtn.y")
        bs = bar()
        print("coexisting with the chest:", chest["label"], "| btnY", btn_y, "| barY", bs["barY"])
        assert bs["barY"] + bs["trackH"] / 2 < btn_y - 46, \
            ("the streak bar clears the Continue button", bs, btn_y)
        assert bs["capY"] < bs["barY"], ("caption above its bar", bs)
    page.screenshot(path=f"{SC}/superwand_win_bar.png")

    # ---- 12) A LOSS BREAKS THE STREAK — VISIBLY ---------------------------
    # Continue rescues the attempt and the streak with it; Home/Replay accept the
    # loss, and the player watches the bar drain rather than finding out later.
    page.evaluate("window.__game.pressWinContinue()")
    time.sleep(0.6)
    enter(SMALL_LEVEL)
    assert sw()["streak"] == 1, ("the streak carried into the next level", sw())
    # Fill the tray until the level is lost, only ever tapping a colour that has
    # fewer than two waiting — so no tap can complete a triple and free a slot.
    guard = 0
    while not page.evaluate("window.__game.loseState().loseOverlay"):
        counts = {}
        for ty in st()["tray"]:
            counts[ty] = counts.get(ty, 0) + 1
        nxt = next((t["id"] for t in free() if counts.get(t["type"], 0) < 2), None)
        assert nxt is not None, ("ran out of tiles that can't complete a triple", counts)
        tap(nxt)
        guard += 1
        assert guard < 40, "the tray never filled"
    harness.settle(page, "window.__game.loseState().loseOverlay", timeout=8000)
    ls = page.evaluate("window.__game.loseState()")
    print("out of moves:", ls)
    bs = bar()
    print("streak at risk:", bs)
    assert bs["shown"] is True, ("the overlay says the streak is on the table", bs)
    assert bs["from"] == 1, bs
    assert sw()["streak"] == 1, ("…but Continue can still rescue it, so it is intact", sw())
    page.screenshot(path=f"{SC}/superwand_streak_risk.png")
    # Accept the loss: the streak resets, and the bar drains before we leave.
    page.evaluate("window.__game.pressLoseReplay()")
    harness.settle(page, "window.__game.superWandState().streak === 0", timeout=8000)
    s = sw()
    print("after accepting the loss:", s)
    assert s["streak"] == 0, ("a loss the player accepts breaks the streak", s)
    assert s["charged"] is False, s

    # A BANKED CHARGE IS AT STAKE TOO, and more of it: accepting a loss is the
    # only thing that can ever take one away, so the overlay must show a full meter
    # exactly as it shows a partial one, and the charge must be gone afterwards.
    page.evaluate("window.__game.chargeSuperWand()")
    assert sw()["charged"] is True, sw()
    page.evaluate("window.__game.flushSave()")
    time.sleep(0.25)
    page.reload()
    page.wait_for_function("window.__game && window.__game.scene", timeout=60000)
    assert sw()["charged"] is True, ("a banked charge persists across a restart", sw())

    page.evaluate("window.__game.markBoosterCoached('all')")
    enter(SMALL_LEVEL)
    guard = 0
    while not page.evaluate("window.__game.loseState().loseOverlay"):
        counts = {}
        for ty in st()["tray"]:
            counts[ty] = counts.get(ty, 0) + 1
        nxt = next((t["id"] for t in free() if counts.get(t["type"], 0) < 2), None)
        assert nxt is not None, ("ran out of tiles that can't complete a triple", counts)
        tap(nxt)
        guard += 1
        assert guard < 40, "the tray never filled"
    harness.settle(page, "window.__game.loseState().loseOverlay", timeout=8000)
    bs = bar()
    print("charged, and at risk:", bs)
    assert bs["shown"] is True and bs["from"] == NEED, \
        ("a banked charge shows on the lose overlay too, full", bs)
    page.evaluate("window.__game.pressLoseHome()")
    harness.settle(page, "!window.__game.superWandState().charged", timeout=8000)
    s = sw()
    print("after accepting the loss while charged:", s)
    assert s["charged"] is False and s["streak"] == 0, \
        ("accepting a loss is what takes a banked Super Wand away", s)

    # ---- 13) THE COACHED FIRST WAND USE IS NOT SWALLOWED ------------------
    # The two modes share one button, and a banked charge normally owns it. But
    # while the ORDINARY Wand's coached first use is up, the lesson owns it —
    # that lesson is what is being taught, and the upgrade arrives afterwards.
    #
    # The regression: _blockedByCoach() CLOSES the lesson it lets through, which
    # clears `_coach` — and `_coach` is one of the terms of _superWandActive().
    # Read after the coaching gate instead of before it, the predicate flipped
    # from false to true inside the very same call, so the taught press spent the
    # lesson and then did nothing: no tiles moved, and the player was left staring
    # at a gold button having been told to press a purple one.
    page.evaluate("() => localStorage.clear()")
    page.reload()
    page.wait_for_function("window.__game && window.__game.scene", timeout=60000)
    page.evaluate(f"window.__game.completeLevel({UNLOCK - 1})")
    # Undo and Shuffle unlock BELOW the Wand, and _owedCoach() serves the lowest
    # owed lesson first — take those two as read so the WAND's is the one that opens.
    page.evaluate("window.__game.markBoosterCoached('undo')")
    page.evaluate("window.__game.markBoosterCoached('shuffle')")
    # NOT charge_and_enter(): the upgrade celebration is deliberately withheld
    # while a lesson is up (_superWandActive is false), so `announced` stays false
    # until the lesson closes — waiting on it here would hang.
    page.evaluate("window.__game.chargeSuperWand()")
    enter(SMALL_LEVEL)
    harness.settle(page, "() => { const c = window.__game.scene._coach;"
                         " return !!c && c.kind === 'wand'; }", timeout=8000)
    s = sw()
    print("wand lesson up, charge banked:", s["mode"], s["icon"], "charged:", s["charged"])
    assert s["charged"] is True, ("the charge is banked", s)
    assert s["mode"] == "stock" and s["active"] is False, \
        ("the LESSON owns the button while it is up, not the upgrade", s)

    before = st()["boardCount"]
    page.evaluate("window.__game.pressBooster('wand')")
    harness.settle(page, "!window.__game.state().locked", timeout=8000)
    harness.frames(page)
    after = st()["boardCount"]
    print("coached press: board", before, "->", after,
          "| taught:", page.evaluate("window.__game.boosterCoached('wand')"),
          "| charge kept:", sw()["charged"])
    assert page.evaluate("() => !window.__game.scene._coach"), "the lesson closed"
    assert page.evaluate("window.__game.boosterCoached('wand')") is True, \
        "and was marked taught"
    assert before - after == 3, \
        ("the taught press must actually run the ORDINARY Wand — one triple, three"
         " tiles off the board — not be swallowed by the charged-mode guard",
         before, after)
    assert sw()["charged"] is True, \
        ("and it must not touch the banked charge: the lesson is about the"
         " ordinary Wand", sw())

    page.screenshot(path=f"{SC}/superwand_state.png")
    print("PAGE ERRORS:", len(errs), errs[:5])
    assert not errs
    print("SUPER WAND TEST PASSED")
    b.close()
