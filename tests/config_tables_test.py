#!/usr/bin/env python3
# The six JSON config tables, fed a BAD ROW (DATA-03).
#
# assets/config/*.json is edited by whoever balances the game, deliberately
# without touching source (src/config.js:28-30 says so). Nothing schema-validates
# them, which is fine and intended — the question this file asks is what a
# structurally valid but SEMANTICALLY wrong row does. Every other test in the
# suite asserts the SHIPPED values; none of them ever hands a loader a bad table.
#
# The four defects it guards, each one config edit away on the old code:
#
#   A. levelChest.json shorter than CONFIG.features.levelChest.repeatStart left
#      `tailLen = count - repeatStart` at or below zero. `(t-1) % 0` is NaN,
#      `m[NaN]` is undefined, and reading `.reward` off it threw — from inside
#      the win-overlay build, AFTER the dim and the (empty) group were mounted.
#      The throw came out of a Pixi ticker listener, so the rAF loop died with
#      it: the player won a level and got a dimmed screen with no Continue.
#   B. tasks.json with an unrecognised reward `type`. TasksScene._claim commits
#      the claim BEFORE granting (rightly — a double tap must not pay twice), so
#      the tier was marked claimed, granted nothing, and vanished from the list
#      as if paid. The achievement ledger is never wiped, so that was permanent.
#   C. prices.json with a negative price. User.debit clamps to a non-negative
#      integer; the badge printed String(price) raw. A "-10" helper was free and
#      advertised a number the wallet would never honour.
#   D. levels.json with a bare-integer `types` above the palette. The [min,max]
#      branch clamps to PALETTE_SIZE; the bare-integer branch returned it raw, so
#      tileTextures[25] was undefined -> Pixi substitutes Texture.EMPTY ->
#      invisible but still tappable tiles.
#
# Each hostile table is served with page.route(...) -> route.fulfill(...) (the
# tests/boot_resilience_test.py idiom) and the game reloaded, so the real
# fetch -> loader -> constructor path runs on it. No new state is reached into;
# part D uses the one seam this finding added, __game.levelTypes().
#
# Part E then walks the SHIPPED tables asserting the semantic invariants none of
# them has ever been checked for. It needs no browser and runs in milliseconds.
# (The activity roster is already held by tasks_test.py and the unknown-type warn
# by rewards_test.py, so neither is repeated here.)

import json, os, re, time
from playwright.sync_api import sync_playwright

import harness

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
os.chdir(ROOT)
SC = harness.OUTPUT
os.makedirs(SC, exist_ok=True)

CFG = os.path.join(ROOT, "assets", "config")


def table(name):
    with open(os.path.join(CFG, name), encoding="utf-8") as f:
        return json.load(f)


def source(name):
    with open(os.path.join(ROOT, "src", name), encoding="utf-8") as f:
        return f.read()


def block(text, opener):
    """The body of a `const X = {` … `};` literal, by its opening line."""
    i = text.index(opener)
    return text[i + len(opener):text.index("\n};", i)]


def fulfil(page, glob, body):
    """Serve `body` (a JSON-able object) for every request matching `glob`."""
    payload = json.dumps(body)
    page.route(glob, lambda route: route.fulfill(
        status=200, content_type="application/json", body=payload))


# The vocabularies the tables are validated against, read from the source that
# owns each one rather than restated here (a copy would drift, which is the very
# failure mode this file is about).
GRANT_TYPES = set(re.findall(
    r"^\s*(\w+):", block(source("rewards.js"), "export const REWARD_GRANT = {"), re.M))
CHEST_ITEM_IDS = {int(n) for n in re.findall(
    r"^\s*(\d+):", block(source("levelchest.js"), "const ITEM_TYPE = {"), re.M)}
PALETTE_SIZE = int(re.search(r"const PALETTE_SIZE = (\d+)", source("levelConfig.js")).group(1))
REPEAT_START = int(re.search(r"repeatStart:\s*(\d+)", source("config.js")).group(1))

assert GRANT_TYPES and CHEST_ITEM_IDS and PALETTE_SIZE and REPEAT_START, (
    "failed to read the reward/palette vocabularies out of src/",
    GRANT_TYPES, CHEST_ITEM_IDS, PALETTE_SIZE, REPEAT_START)
print("vocabulary:", sorted(GRANT_TYPES), "| chest item ids", sorted(CHEST_ITEM_IDS),
      "| palette", PALETTE_SIZE, "| repeatStart", REPEAT_START)

BASE = harness.serve()


# ==========================================================================
#  E — the shipped tables hold the invariants (no browser)
# ==========================================================================
def check_shipped():
    tasks = table("tasks.json")
    for chain in tasks["achievements"]:
        targets = [t["target"] for t in chain["tiers"]]
        # _achievementRows breaks at the first unfinished tier, so a chain whose
        # targets do not ascend hides an already-earned later tier behind it.
        assert targets == sorted(targets) and len(set(targets)) == len(targets), (
            "achievement tiers must ascend strictly", chain["id"], targets)
        for tier in chain["tiers"]:
            assert tier["reward"]["type"] in GRANT_TYPES, (
                "achievement reward type is not grantable", chain["id"], tier["reward"])
    for w in tasks["weekly"]:
        assert w["reward"]["type"] in GRANT_TYPES, (
            "weekly reward type is not grantable", w["id"], w["reward"])
    print("  ok   tasks.json: tiers ascend, every reward type is grantable")

    for group in table("turntable.json")["groups"]:
        for prize in group:
            assert prize["type"] in GRANT_TYPES, ("wheel prize type", prize)
            assert prize["freeWeight"] >= 0 and prize["adWeight"] >= 0, ("wheel weight", prize)
        assert sum(p["freeWeight"] for p in group) > 0, ("a wheel with no free weight", group)
        assert sum(p["adWeight"] for p in group) > 0, ("a wheel with no ad weight", group)
    for prize in table("dailybonus.json")["prizes"]:
        assert prize["type"] in GRANT_TYPES, ("daily prize type", prize)
        assert prize["weight"] >= 0, ("daily weight", prize)
    print("  ok   turntable.json / dailybonus.json: types grantable, weights sane")

    rows = [r for r in table("levelChest.json")["levelChest"].values() if isinstance(r, list)]
    levels = [r[1] for r in rows]
    assert levels == sorted(levels) and len(set(levels)) == len(levels), (
        "levelChest milestones must be strictly ascending", levels)
    assert len(rows) > REPEAT_START, (
        "levelChest.json has no tail left to loop: shrinking it below "
        "CONFIG.features.levelChest.repeatStart stops the chest arriving at all",
        len(rows), REPEAT_START)
    for r in rows:
        item, _, count = str(r[2]).partition("|")
        assert int(item) in CHEST_ITEM_IDS, ("unknown chest item id", r)
        assert int(count) > 0, ("chest reward pays nothing", r)
    print(f"  ok   levelChest.json: {len(rows)} milestones ascending, tail of "
          f"{len(rows) - REPEAT_START} to loop, every item id known")

    for i, lvl in enumerate(table("levels.json")):
        spec = lvl["types"]
        got = spec if isinstance(spec, list) else [spec, spec]
        assert all(1 <= v <= PALETTE_SIZE for v in got), (
            "level types outside the tile palette", i + 1, spec, PALETTE_SIZE)
    print("  ok   levels.json: every `types` is within the tile palette")

    prices = table("prices.json")
    for k, v in list(prices["boosters"].items()) + [("continue", prices["continue"])]:
        assert isinstance(v, (int, float)) and v >= 0, ("prices must be non-negative", k, v)
    print("  ok   prices.json: every price is a non-negative number")


print("\n=== E. the shipped tables ===")
check_shipped()


with sync_playwright() as p:
    browser = p.chromium.launch(args=harness.LAUNCH_ARGS)

    # ======================================================================
    #  A — a levelChest.json too short to have a repeating tail
    # ======================================================================
    print("\n=== A. level chest: a schedule shorter than repeatStart ===")
    page, errors = harness.new_page(browser)
    # Three milestones against a repeatStart of 6: there is no tail to loop.
    fulfil(page, "**/assets/config/levelChest.json", {"levelChest": {
        "100001": [100001, 4, "0|25"],
        "100002": [100002, 8, "0|25"],
        "100003": [100003, 12, "10|2"],
    }})
    harness.boot(page, "window.__game && !!window.__game.chestInfo", timeout=60000, url=BASE)
    harness.frames(page, 3)

    assert page.evaluate("window.__game.chestCount()") == 3, "the routed table is the one loaded"

    # Every level past the last milestone takes the looping-tail branch. It must
    # answer "no chest", not throw: the caller is mid-render of the win overlay.
    for lv in (13, 20, 200):
        r = page.evaluate(
            "(lv) => { try { return { ok: true, v: window.__game.chestInfo(lv) }; }"
            "         catch (e) { return { ok: false, err: String(e) }; } }", lv)
        assert r["ok"], (f"chestInfo({lv}) threw past the end of a short schedule", r.get("err"))
        assert r["v"] is None, (f"a schedule with no tail cannot name a chest for level {lv}", r)
    print("  ok   chestInfo past the last milestone returns null instead of throwing")

    # The consequence that matters: winning a level past the schedule's end must
    # still build a complete win overlay. On the old code the TypeError landed
    # between the dim and the Continue button and killed the ticker with it.
    page.evaluate("window.__game.closeTutorial()")
    harness.frames(page, 2)
    page.evaluate("window.__game.exitLevel()")
    time.sleep(0.4)
    page.evaluate("window.__game.completeLevel(12); window.__game.flushSave();")
    page.evaluate("window.__game.markBoosterCoached('all')")
    page.evaluate("async () => { await window.__game.startLevel(13); window.__game.closeTutorial(); }")
    time.sleep(0.6)

    for _ in range(8000):
        s = page.evaluate("window.__game.state()")
        if s["overlay"] or s["inLobby"]:
            break
        if page.evaluate("window.__game.solveTap()") == -1:
            time.sleep(0.05)
        time.sleep(0.015)
    time.sleep(0.5)

    cs = page.evaluate("window.__game.chestState()")
    print("  win overlay:", cs)
    page.screenshot(path=os.path.join(SC, "config_tables_chest_short.png"))
    assert cs["winPanel"] is True, (
        "the level-complete overlay must be complete (Continue and all) even when "
        "the chest schedule cannot name a chest", cs)
    assert cs["shown"] is False, ("no chest bar when the schedule has no tail", cs)
    # The rAF loop is still alive: a frame still paints after the overlay is up.
    harness.frames(page, 3)
    assert not errors, ("a short chest schedule must not throw", errors[:5])
    print("  ok   the win overlay still builds, and the ticker survives")
    page.context.close()

    # ======================================================================
    #  B — a tasks.json reward type nothing can grant
    # ======================================================================
    print("\n=== B. tasks: a reward type with no grant ===")
    page, errors = harness.new_page(browser)
    warns = []
    page.on("console", lambda m: warns.append(m.text) if m.type == "warning" else None)
    fulfil(page, "**/assets/config/tasks.json", {
        "titles": {"levelsCompleted": {"title": "title_task_1", "one": "title_task_1_one"}},
        "achievements": [
            {"id": "bad", "activity": "levelsCompleted",
             "tiers": [{"target": 1, "reward": {"type": "gems", "amount": 5}}]},
            {"id": "good", "activity": "levelsCompleted",
             "tiers": [{"target": 1, "reward": {"type": "coins", "amount": 40}}]},
        ],
        "weekly": [],
    })
    harness.boot(page, "window.__game && !!window.__game.tasksState", timeout=60000, url=BASE)
    harness.frames(page, 3)

    page.evaluate("window.__game.closeTutorial()")
    harness.frames(page, 2)
    page.evaluate("window.__game.exitLevel()")
    time.sleep(0.4)
    page.evaluate("window.__game.completeLevel(9); window.__game.flushSave();")
    page.evaluate("window.__game.bumpStat('levelsCompleted', 9)")
    page.evaluate("window.__game.openTasks()")
    time.sleep(0.5)

    ids = [r["id"] for r in page.evaluate("window.__game.tasksList('achievements')")]
    print("  rows:", ids)
    assert ids == ["bad:1", "good:1"], ("the routed goal table is the one loaded", ids)

    coins0 = page.evaluate("window.__game.balance('coins')")
    page.evaluate("window.__game.pressTaskClaim('bad:1')")
    page.wait_for_function("!window.__game.tasksState().busy", timeout=30000)
    time.sleep(0.3)

    assert page.evaluate("window.__game.taskClaimed('bad:1')") is False, (
        "a tier whose reward cannot be granted must NOT be marked claimed — the "
        "achievement ledger is never wiped, so that reward would be gone for good")
    assert "bad:1" in [r["id"] for r in page.evaluate("window.__game.tasksList('achievements')")], \
        "the refused row stays on the list, claimable once the config is fixed"
    assert page.evaluate("window.__game.balance('coins')") == coins0, "nothing was paid"
    assert any("gems" in w for w in warns), (
        "an ungrantable reward type must leave a console warning for whoever "
        "edited the table", warns)
    print("  ok   the claim is refused, the row survives, and the warn names the type")

    # …and the guard is specific: an ordinary row beside it still pays.
    page.evaluate("window.__game.pressTaskClaim('good:1')")
    page.wait_for_function("!window.__game.tasksState().busy", timeout=30000)
    time.sleep(0.3)
    assert page.evaluate("window.__game.taskClaimed('good:1')") is True, "a valid tier still claims"
    assert page.evaluate("window.__game.balance('coins')") == coins0 + 40, "and still pays"
    page.screenshot(path=os.path.join(SC, "config_tables_tasks_bad_reward.png"))
    assert not errors, errors[:5]
    print("  ok   a grantable row beside it is unaffected")
    page.context.close()

    # ======================================================================
    #  C — a negative price in prices.json
    # ======================================================================
    print("\n=== C. prices: a negative coin price ===")
    page, errors = harness.new_page(browser)
    fulfil(page, "**/assets/config/prices.json", {
        "boosters": {"undo": -10, "shuffle": -80, "wand": "free"},
        "continue": -5,
    })
    harness.boot(page, "window.__game && !!window.__game.boosterPrice", timeout=60000, url=BASE)
    harness.frames(page, 3)

    # The wallet already reads a negative price as 0 (User.debit clamps), so the
    # display has to read it the same way or it advertises a price nothing honours.
    assert page.evaluate("window.__game.boosterPrice('undo')") == 0, (
        "a negative booster price must read as 0 — the wallet charges 0 for it",
        page.evaluate("window.__game.boosterPrice('undo')"))
    assert page.evaluate("window.__game.continuePrice()") == 0, (
        "a negative continue price must read as 0",
        page.evaluate("window.__game.continuePrice()"))
    # A non-number is still "no price at all", which degrades to the ad tier.
    assert page.evaluate("window.__game.boosterPrice('wand')") is None, (
        "a non-numeric price is not a price", page.evaluate("window.__game.boosterPrice('wand')"))
    print("  ok   negative -> 0, non-numeric -> null")

    # And the badge — the display half of the asymmetry — says the same number.
    page.evaluate("window.__game.closeTutorial()")
    harness.frames(page, 2)
    page.evaluate("window.__game.exitLevel()")
    time.sleep(0.4)
    page.evaluate("window.__game.completeLevel(5); window.__game.markBoosterCoached('all');")
    page.evaluate("async () => { await window.__game.startLevel(1); window.__game.closeTutorial(); }")
    time.sleep(0.7)
    page.evaluate("window.__game.credit('coins', 1000)")
    while page.evaluate("window.__game.boosterCount('shuffle')") > 0:
        page.evaluate("window.__game.reshuffle()")
        time.sleep(0.35)

    bs = page.evaluate("window.__game.boosterState()")
    print("  empty shuffle:", bs["shuffleMode"], repr(bs["shuffleBadge"]))
    page.screenshot(path=os.path.join(SC, "config_tables_negative_price.png"))
    assert bs["shuffleMode"] == "buy", ("0 stock + affordable -> the buy tier", bs)
    assert bs["shuffleBadge"] == "0", (
        "the badge must never advertise a negative price the wallet will not charge",
        bs["shuffleBadge"])
    assert not errors, errors[:5]
    print("  ok   the badge prints what the wallet would actually charge")
    page.context.close()

    # ======================================================================
    #  D — a bare-integer `types` above the palette
    # ======================================================================
    print("\n=== D. levels: a bare-integer `types` above the palette ===")
    page, errors = harness.new_page(browser)
    levels = table("levels.json")
    victim = len(levels)                 # the last level — nothing here enters it
    levels[victim - 1] = {**levels[victim - 1], "types": PALETTE_SIZE + 5}
    fulfil(page, "**/assets/config/levels.json", levels)
    harness.boot(page, "window.__game && !!window.__game.levelTypes", timeout=60000, url=BASE)
    harness.frames(page, 3)

    faces = page.evaluate("window.__game.tileFaces()")["types"]
    assert faces == PALETTE_SIZE, ("the palette and PALETTE_SIZE must agree", faces, PALETTE_SIZE)
    got = page.evaluate(f"window.__game.levelTypes({victim})")
    print(f"  level {victim}: types {PALETTE_SIZE + 5} in the config resolved to {got}")
    assert 1 <= got <= PALETTE_SIZE, (
        "a bare-integer `types` must be clamped to the palette exactly as a "
        "[min,max] range is — an unclamped one indexes past tileTextures and "
        "Pixi silently substitutes Texture.EMPTY (invisible, still tappable)",
        got, PALETTE_SIZE)
    # The range branch is unchanged: level 1 still resolves inside its own bounds.
    spec = levels[0]["types"]
    lo, hi = (min(spec), max(spec)) if isinstance(spec, list) else (spec, spec)
    one = page.evaluate("window.__game.levelTypes(1)")
    assert lo <= one <= hi, ("the [min,max] branch is untouched", one, spec)
    assert not errors, errors[:5]
    print("  ok   the bare-integer branch clamps like the range branch")
    page.context.close()

    browser.close()

print("\nCONFIG-TABLES CHECKS PASSED")
