#!/usr/bin/env python3
# End-to-end test for the SHARED helper (booster) module (src/boosters.js).
#
# Six screens draw an in-level helper: the level's row of round buttons, the
# coached first use that lifts one of them out of the dim, the prize chips along
# the top of the Fortune Wheel, the Daily Bonus and Tasks, the package contents
# summary in the shop, and the lobby rail's Super Wand button. Every one of them
# carried its OWN copy of the glyph and the disc colour, and three of them a
# byte-identical copy of the chip that draws it — verified identical by md5, all
# three including the same `[kind, emoji, x]` array above it.
#
# So "what does the Wand look like" had six answers that only happened to agree,
# and changing one icon meant finding all six. src/boosters.js is the single
# owner now: one row per helper, holding the glyph, the disc colour and the
# coach caption key, plus the one shared chip control.
#
# What this file guards:
#
#   1. The duplication itself, as pure source analysis: no module but
#      src/boosters.js may spell a helper glyph in CODE (a comment may still
#      illustrate one — src/shop.js draws an example summary in prose), and none
#      may carry a private chip factory or a private `[kind, emoji, x]` table.
#
#   2. The registry stays a LEAF. It may import src/config.js and nothing else.
#      src/rewards.js already imports src/shop.js, and both want the registry —
#      one further dependency here would close a cycle.
#
#   3. The three per-type tables that deliberately stay hand-written still COVER
#      the roster. REWARD_GRANT (src/rewards.js) and ITEM_TYPE (src/levelchest.js)
#      are parsed out of source by tests/config_tables_test.py, so they must stay
#      literals; ITEM_KEYS (src/i18n.js) is the localized-name map. None of the
#      three is a restatement of a booster FACT — each maps one vocabulary onto
#      another — but each has to mention every helper, and nothing else checks
#      that they still do.
#
#   4. Live: the row and the chips are still where and what they were. This is a
#      behaviour-preserving refactor, so the live half is a parity check, not a
#      new-behaviour check — the glyph the level's Wand button wears is the one
#      the registry declares, and all three overlays still report three chips
#      under their old names at their old positions.
#
# Checks 1-3 need no browser and run in milliseconds; 4 drives the real game
# headlessly through window.__game.

import json
import os
import re
import sys

from playwright.sync_api import sync_playwright

import harness

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
os.chdir(ROOT)

OWNER = "src/boosters.js"


def text(path):
    with open(os.path.join(ROOT, path), encoding="utf-8") as fh:
        return fh.read()


def src_files():
    for name in sorted(os.listdir(os.path.join(ROOT, "src"))):
        if name.endswith(".js"):
            yield f"src/{name}"
    sub = os.path.join(ROOT, "src", "user")
    for name in sorted(os.listdir(sub)):
        if name.endswith(".js"):
            yield f"src/user/{name}"


def block(text_, opener):
    """The body of a `const X = {` … `};` literal, by its opening line.

    The same idiom tests/config_tables_test.py uses to read a vocabulary out of
    the module that owns it, rather than restating it here where it would drift.
    """
    i = text_.index(opener)
    return text_[i + len(opener):text_.index("\n};", i)]


def code_lines(src):
    """(lineno, line) for lines that are not whole-line comments.

    A comment may legitimately spell a glyph — src/shop.js:54 draws an example
    contents summary (`[🪙]1200  🪄 3  ⤺ 5  🔀 1`) to explain the layout, and that
    prose is worth keeping. It is only a glyph in executable code that means the
    table grew a seventh copy.
    """
    for n, line in enumerate(src.splitlines(), 1):
        s = line.lstrip()
        if s.startswith("//") or s.startswith("*") or s.startswith("/*"):
            continue
        yield n, line


# ---------------------------------------------------------------------------
#  The roster, read from the config that owns it
# ---------------------------------------------------------------------------
CONFIG_SRC = text("src/config.js")
KINDS = re.search(r"kinds:\s*\[([^\]]*)\]", CONFIG_SRC).group(1)
KINDS = [k.strip().strip('"').strip("'") for k in KINDS.split(",") if k.strip()]
assert KINDS, "failed to read CONFIG.boosters.kinds out of src/config.js"
print("roster:", KINDS)


# ---------------------------------------------------------------------------
#  1. No second copy of the helper vocabulary  (source analysis, no browser)
# ---------------------------------------------------------------------------
# Run first: instant, and a failure here means the extraction was undone.

assert os.path.exists(os.path.join(ROOT, OWNER)), (
    OWNER + " must exist — it is the one owner of the helper vocabulary")

# ⤺ Undo, 🪄 Wand, 🔀 Reshuffle, ✨ the Super Wand's upgraded face. NOT ⚡ (a
# reward type the wheel headlines, no helper) and NOT ❔ (the generic unknown
# marker, which several modules legitimately draw).
GLYPHS = ["⤺", "\U0001fa84", "\U0001f500", "✨"]

failures = []
for path in src_files():
    if path == OWNER:
        continue
    for n, line in code_lines(text(path)):
        for g in GLYPHS:
            if g in line:
                failures.append(f"{path}:{n}  {line.strip()[:88]}")
assert not failures, (
    "a helper glyph is spelled in code outside " + OWNER + " — the glyph, the "
    "disc colour and the coach caption are one row in the registry, and every "
    "screen looks them up:\n  " + "\n  ".join(failures))
print(f"  ok   no helper glyph in code outside {OWNER} ({len(GLYPHS)} glyphs checked)")

# The private chip factory and the `[kind, emoji, x]` table above it — the
# triplicated pair. `makeBoosterChip` (no underscore) is the shared one and
# lives in the registry; `_makeBoosterChip` was the method each overlay owned.
PRIVATE_CHIP = re.compile(r"_makeBoosterChip\s*\(|const\s+chipDefs\s*=")
for path in src_files():
    if path == OWNER:
        continue
    hit = PRIVATE_CHIP.search(text(path))
    assert not hit, (
        path + " carries a private booster chip (" + hit.group(0).strip() + ") — "
        "all three overlays drew a byte-identical one; makeBoosterChipRow() in "
        + OWNER + " is that code, once")
print("  ok   no private booster chip factory or chipDefs table outside the registry")

# The three overlays that show a chip row must take it from the registry.
CHIP_ROWS = ["src/fortunewheel.js", "src/dailybonus.js", "src/tasks.js"]
for path in CHIP_ROWS:
    assert re.search(r'from\s+"\./boosters\.js"', text(path)), (
        path + " must take its chip row from ./boosters.js")
print("  ok   all three chip rows import ./boosters.js")


# ---------------------------------------------------------------------------
#  2. The registry is a leaf
# ---------------------------------------------------------------------------
imports = re.findall(r'^\s*import\s.*?from\s+"([^"]+)"', text(OWNER), re.M)
assert imports == ["./config.js"], (
    OWNER + " must import ./config.js and nothing else. src/rewards.js already "
    "imports src/shop.js and both want the registry; a second dependency here "
    "closes a cycle.", imports)
print("  ok   the registry imports ./config.js and nothing else")


# ---------------------------------------------------------------------------
#  3. The hand-written per-type tables still cover the roster
# ---------------------------------------------------------------------------
# These three stay literals ON PURPOSE — two of them are parsed out of source by
# tests/config_tables_test.py, and all three map one vocabulary onto another
# rather than restating a booster fact. What they must not do is forget a
# helper, which is what this replaces.
grant = set(re.findall(
    r"^\s*(\w+):", block(text("src/rewards.js"), "export const REWARD_GRANT = {"), re.M))
# ITEM_KEYS packs several rows onto one line, so this one is not line-anchored.
# Every row maps a type straight to a string key, so `name: "` is unambiguous —
# unlike REWARD_GRANT above, whose values are objects with their own keys.
item_keys = set(re.findall(
    r'(\w+):\s*"', block(text("src/i18n.js"), "const ITEM_KEYS = {")))
chest = set(re.findall(
    r'^\s*\d+:\s*"(\w+)"', block(text("src/levelchest.js"), "const ITEM_TYPE = {"), re.M))

for name, got in (("REWARD_GRANT (src/rewards.js)", grant),
                  ("ITEM_KEYS (src/i18n.js)", item_keys),
                  ("ITEM_TYPE (src/levelchest.js)", chest)):
    missing = [k for k in KINDS if k not in got]
    assert not missing, (
        name + " does not mention every helper in CONFIG.boosters.kinds — a "
        "helper it forgets is one a reward cannot pay, cannot name, or cannot "
        "come out of a chest", missing, sorted(got))
print("  ok   REWARD_GRANT, ITEM_KEYS and ITEM_TYPE each cover the roster")


# ---------------------------------------------------------------------------
#  4. Live parity — the row and the chips are unchanged
# ---------------------------------------------------------------------------
# The glyph the registry declares for the Wand, so the live assertion compares
# the drawn button against the single source rather than against a copy here.
WAND_GLYPH = re.search(r'wand:\s*\{\s*glyph:\s*"([^"]+)"', text(OWNER)).group(1)

# Where the three chips and the three helper buttons have always sat, in design
# units. Centres, so the assertion does not depend on a rim's stroke width.
CHIP_X = {"chipUndo": 70, "chipWand": 190, "chipShuffle": 310}
CHIP_Y = 84
HELPER_X = {"shuffleBtn": 175, "wandBtn": 375, "undoBtn": 575}

BASE = harness.serve()
with sync_playwright() as p:
    # The DESIGN viewport exactly (750x1334), not the suite's usual 780: with no
    # letterboxing the coordinates controls() reports ARE design units, so the x
    # below can be the row's own numbers rather than those plus a margin.
    browser, page, errs = harness.launch(p, viewport=harness.DESIGN_VIEWPORT)
    harness.boot(page, "window.__game && window.__game.scene "
                       "&& !!window.__game.controls", url=BASE)

    # Level 9 clear: every helper unlocked and granted and every feature gate
    # (wheel, daily, tasks) open, every lesson skipped — so nothing is greyed
    # out, hidden behind a coaching dim, or missing a chip row to measure.
    page.evaluate("window.__game.completeLevel(9); window.__game.flushSave();")
    page.evaluate("window.__game.markBoosterCoached('all')")

    def centres(scene, prefix):
        out = {}
        for c in page.evaluate("window.__game.controls()"):
            if c["scene"] == scene and c["name"].startswith(prefix):
                out[c["name"]] = (round(c["x"] + c["w"] / 2), round(c["y"] + c["h"] / 2))
        return out

    # ---- the level's helper row ----------------------------------------
    page.evaluate("async () => { await window.__game.startLevel(1); "
                  "window.__game.closeTutorial(); }")
    harness.settle(page, "window.__game.controls().some(c => c.scene === 'level')")

    row = {n: xy for n, xy in centres("level", "").items() if n in HELPER_X}
    assert len(row) == 3, ("the helper row is still exactly three buttons", row)
    for name, x in HELPER_X.items():
        assert abs(row[name][0] - x) <= 2, (
            "the helper row's geometry is GameScene's own and does not move",
            name, row[name], x)
    print("  ok   the helper row is three buttons at 175/375/575")

    icon = page.evaluate("window.__game.superWandState().icon")
    assert icon == WAND_GLYPH, (
        "the Wand button wears the glyph the registry declares", icon, WAND_GLYPH)
    print(f"  ok   the Wand button draws the registry's glyph ({icon})")

    page.evaluate("window.__game.exitLevel()")
    harness.settle(page, "window.__game.inLobby() === true")

    # ---- the three chip rows -------------------------------------------
    # The overlays are allowed to stack (resize_overlap_test relies on it), so
    # each is opened on top of the last and measured by its own scene key.
    for scene, opener in (("wheel", "openWheel"), ("daily", "openDailyBonus"),
                          ("tasks", "openTasks")):
        page.evaluate(f"window.__game.{opener}()")
        harness.settle(page,
                       f"window.__game.controls().some(c => c.scene === '{scene}')")
        harness.frames(page, 2)
        chips = centres(scene, "chip")
        assert set(chips) == set(CHIP_X), (
            scene + " still reports its three chips under their old names — the "
            "resize/overlap test names them", sorted(chips))
        for name, x in CHIP_X.items():
            assert abs(chips[name][0] - x) <= 2 and abs(chips[name][1] - CHIP_Y) <= 2, (
                scene + " chip moved", name, chips[name], (x, CHIP_Y))
        print(f"  ok   {scene}: chipUndo/chipWand/chipShuffle at 70/190/310")

    assert not errs, ("no page errors", errs)
    browser.close()

print("PASS boosters_test.py")
