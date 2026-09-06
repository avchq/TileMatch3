"""Hard Levels — the occasional difficulty spike, tagged before it is played.

Six things make this feature, and this file holds each of them to its rule:

  1. THE CADENCE is a rule, not a roster. A level is hard when its number ends in
     `CONFIG.progression.hardLevel.endsWith`, so it scales with the level table
     instead of needing a second list kept in step with it.
  2. THE BOARD is the only thing hardness actually changes. A hard level scatters
     each tile face's three copies across a WINDOW of the solution order instead
     of laying them on three consecutive slots, so complete sets are not sitting
     there ready to take. Measured, not asserted from config: `typeSpread()`
     walks the solution order in threes and reports how many of those aligned
     triples are still a single face. At the baseline that is every one of them.
  3. IT IS STILL WINNABLE. The window is capped so the worst moment of following
     the solution order fits the tray, and the board must clear to zero.
  4. NOTHING ELSE MOVED. Every ordinary level's board is bit-for-bit what it was.
  5. THE TAG shows before the level is played, in both places: the lobby's Play
     button and the win screen, under the number of the NEXT level.
  6. THE ANNOUNCEMENT blocks. A fresh hard board dims, announces itself and only
     then unlocks — and it does NOT replay on a revive, which continues the
     existing board rather than dealing a new one.

Written before the feature, and it fails on the old behaviour: check 2 reads an
aligned fraction of exactly 1.0 for every level on a build without the scatter.
"""

import os
import time

from playwright.sync_api import sync_playwright

import harness

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
os.chdir(ROOT)

OUT = harness.OUTPUT
os.makedirs(OUT, exist_ok=True)


def solve(page, limit=4000):
    """Auto-solve the current board, reporting the peak tray occupancy.

    Follows the guaranteed solution order via `solveTap()` — the same order the
    generator promises is winnable — so the peak it reports is the real worst
    case of the scatter, not a lucky line.
    """
    peak = 0
    for _ in range(limit):
        st = page.evaluate("window.__game.state()")
        if st["overlay"] or st["inLobby"]:
            break
        peak = max(peak, len(st["tray"]))
        if page.evaluate("window.__game.solveTap()") == -1:
            time.sleep(0.05)
        time.sleep(0.02)
    time.sleep(0.5)
    return peak


with sync_playwright() as p:
    with harness.session(p) as (browser, page, errors):
        harness.boot(page)
        # Play forward past the first-run flow — a brand-new profile is dropped
        # into a GUIDED level 1 that plays moves of its own — and take the
        # unlocked helpers' coached first use as read, since a coaching parks the
        # board this test starts and blocks by hand. (Both idioms are
        # continue_test.py's.)
        page.evaluate("window.__game.completeLevel(5)")
        page.evaluate("window.__game.markBoosterCoached('all')")
        harness.frames(page)

        cfg = page.evaluate("window.__game.config()")
        hard_cfg = cfg["progression"]["hardLevel"]
        digit = hard_cfg["endsWith"]
        baseline = cfg["board"]["mixPercent"]
        max_level = page.evaluate("window.__game.winState().maxLevel")
        print("CONFIG -> endsWith:", digit, "hard mixPercent:", hard_cfg["mixPercent"],
              "baseline:", baseline, "maxLevel:", max_level)

        # ---- 1. the cadence ------------------------------------------------
        # The rule is the config digit and nothing else. Asserted over the whole
        # table rather than on a hand-picked pair, so re-phasing the spike (a new
        # digit) keeps this test honest instead of breaking it.
        hard = [n for n in range(1, max_level + 1)
                if page.evaluate("(n) => window.__game.hardLevel(n)", n)]
        expected = [n for n in range(1, max_level + 1) if n % 10 == digit]
        print("HARD LEVELS ->", hard, "expected:", expected)
        assert hard == expected, (
            "the hard cadence is not the configured last digit", hard, expected)
        assert hard, ("no level in the table is hard — the digit cannot be exercised",
                      digit, max_level)
        assert 1 not in hard, "the tutorial level must never be a hard level"

        # A hard level always scatters MORE than its neighbours, never less.
        assert hard_cfg["mixPercent"] > baseline, (
            "a hard level must scatter above the baseline, not below it",
            hard_cfg["mixPercent"], baseline)
        for n in (hard[0] - 1, hard[0], hard[0] + 1):
            got = page.evaluate("(n) => window.__game.mixPercent(n)", n)
            want = hard_cfg["mixPercent"] if n in hard else baseline
            assert got == want, ("wrong scatter for level", n, got, want)

        first_hard = hard[0]
        plain = first_hard - 1

        # ---- 4. every ordinary level's board is untouched -------------------
        # Captured before anything else so the fingerprints below are the ones a
        # player actually gets. A pure baseline board must lay every triple on
        # three consecutive slots, exactly as it did before scatter existed.
        page.evaluate("(n) => window.__game.setLevel(n)", plain)
        page.evaluate("async (n) => { await window.__game.startLevel(n); }", plain)
        harness.frames(page)
        plain_spread = page.evaluate("window.__game.typeSpread()")
        plain_board = page.evaluate("window.__game.boardTypes()")
        print(f"LEVEL {plain} (ordinary) -> spread:", plain_spread)
        assert plain_spread["groups"] > 0, "no triples on the board?"
        assert plain_spread["alignedFrac"] == 1.0, (
            "an ordinary level must still lay every triple consecutively",
            plain_spread)

        # …and it is stable: the same level rebuilt is the same board.
        page.evaluate("window.__game.exitLevel()")
        harness.frames(page)
        page.evaluate("async (n) => { await window.__game.startLevel(n); }", plain)
        harness.frames(page)
        assert page.evaluate("window.__game.boardTypes()") == plain_board, (
            "an ordinary level's board is no longer deterministic")

        # ---- 2. the hard board is scattered --------------------------------
        page.evaluate("(n) => window.__game.setLevel(n)", first_hard)
        page.evaluate("async (n) => { await window.__game.startLevel(n); }", first_hard)
        harness.frames(page)
        hard_spread = page.evaluate("window.__game.typeSpread()")
        print(f"LEVEL {first_hard} (hard) -> spread:", hard_spread)
        page.screenshot(path=f"{OUT}/hardlevel_board.png")
        assert hard_spread["groups"] > 0, "no triples on the hard board?"
        # THE regression line. On a build without the scatter this reads 1.0 and
        # the test goes red; the window has to actually break triples apart.
        assert hard_spread["alignedFrac"] < 0.5, (
            "a hard level's triples are still sitting on consecutive slots — "
            "the scatter window is not being applied",
            hard_spread)

        # ---- 3. …and still winnable ----------------------------------------
        # The whole point of capping the window: following the solution order must
        # never overflow the tray, and the board must clear to nothing.
        capacity = page.evaluate("window.__game.traySize().capacity")
        peak = solve(page)
        st = page.evaluate("window.__game.state()")
        print(f"LEVEL {first_hard} SOLVED -> boardCount:", st["boardCount"],
              "peak tray:", peak, "of", capacity)
        assert st["overlay"] is True and st["boardCount"] == 0, (
            "a hard level did not clear", st)
        # It runs right up to capacity by design (2W + 1 == traySlots at the cap
        # — see MAX_WINDOW in src/level.js), so this asserts the bound, not slack.
        assert peak <= capacity, ("following the solution order overflowed the tray "
                                  "on a hard level — the window cap is wrong",
                                  peak, capacity)

        # ---- 5b. the win screen warns about the next level ------------------
        # We are standing on the win overlay of a hard level, so the NEXT level is
        # an ordinary one: no warning.
        tag = page.evaluate("window.__game.winHardTag()")
        print(f"WIN OF {first_hard} -> winHardTag:", tag)
        assert tag["visible"] is False, (
            "the win screen warned about an ordinary next level", tag)
        # …and from the level BEFORE a hard one, it does warn, naming that level.
        # startLevel tears the win overlay down on its way in, so there is no need
        # to press Continue (which on some levels stops at a chest reward first).
        page.evaluate("(n) => window.__game.setLevel(n)", plain)
        page.evaluate("async (n) => { await window.__game.startLevel(n); }", plain)
        harness.frames(page)
        solve(page)
        tag = page.evaluate("window.__game.winHardTag()")
        print(f"WIN OF {plain} -> winHardTag:", tag)
        page.screenshot(path=f"{OUT}/hardlevel_winscreen.png")
        assert tag["visible"] is True, (
            "the win screen gave no advance warning of the hard level ahead", tag)
        assert tag["level"] == first_hard, ("warned about the wrong level", tag)
        assert tag["caption"].strip(), "the ribbon caption is empty"
        assert tag["caption"] != "hard_level", (
            "the ribbon shows its KEY — assets/lang/*.json is missing hard_level")
        caption_en = tag["caption"]

        # ---- 5a. the lobby ribbon ------------------------------------------
        # It describes the level the Play button will start, so it comes and goes
        # on its own as progress moves.
        for level in (plain, first_hard, first_hard + 1):
            if level > max_level:
                continue
            page.evaluate("(n) => window.__game.showLobby(n)", level)
            harness.frames(page)
            got = page.evaluate("window.__game.lobbyHardTag()")
            want = level in hard
            print(f"LOBBY AT {level} -> ribbon visible:", got["visible"], "want:", want)
            if want:
                page.screenshot(path=f"{OUT}/hardlevel_lobby.png")
            assert got["visible"] is want, (
                "the lobby ribbon does not track the level on the Play button",
                level, got)
            if want:
                assert got["caption"] == caption_en, (
                    "the lobby and win-screen ribbons disagree", got, caption_en)

        # The caption is a translated phrase, not an untranslated mark like NEW:
        # it must change with the language.
        page.evaluate("(n) => window.__game.showLobby(n)", first_hard)
        page.evaluate("async () => { await window.__game.setLanguage('fr'); }")
        harness.frames(page)
        fr = page.evaluate("window.__game.lobbyHardTag()")
        print("LOBBY RIBBON in fr ->", fr)
        assert fr["visible"] is True and fr["caption"].strip(), (
            "the ribbon lost its caption on a language swap", fr)
        assert fr["caption"] != caption_en, (
            "the ribbon caption is not localised", fr, caption_en)
        page.evaluate("async () => { await window.__game.setLanguage('en'); }")
        harness.frames(page)

        # ---- 6. the opening announcement blocks -----------------------------
        # Started WITHOUT awaiting, so the banner can be caught while it is up.
        page.evaluate("(n) => window.__game.setLevel(n)", first_hard)
        page.evaluate("(n) => { window.__hard = window.__game.startLevel(n); }", first_hard)
        harness.settle(page, "window.__game.hardBannerState().visible", timeout=15000)
        banner = page.evaluate("window.__game.hardBannerState()")
        st = page.evaluate("window.__game.state()")
        print("BANNER UP ->", banner, "locked:", st["locked"])
        # The blocking checks come before the screenshot: the whole announcement
        # lasts about a second and a half, and a PNG write is long enough to spend
        # the rest of it.
        assert banner["caption"] == caption_en, ("wrong banner caption", banner)
        assert st["locked"] is True, (
            "the board was playable behind the hard-level announcement", st)
        # …and it really is blocking: a tap collects nothing while it is up.
        page.evaluate("window.__game.solveTap()")
        harness.frames(page)
        assert page.evaluate("window.__game.state().tray") == [], (
            "a tile was collected through the announcement's dimmer")
        # `state().overlay` must keep meaning the win/lose overlays — the
        # announcement rides above them, on its own layer.
        assert st["overlay"] is False, (
            "the announcement registers as a win/lose overlay", st)
        page.screenshot(path=f"{OUT}/hardlevel_banner.png")

        page.evaluate("async () => { await window.__hard; }")
        harness.frames(page)
        after = page.evaluate("window.__game.hardBannerState()")
        st = page.evaluate("window.__game.state()")
        print("AFTER startLevel ->", after, "locked:", st["locked"])
        assert after["visible"] is False, ("the announcement outlived the level start",
                                           after)
        assert st["locked"] is False, ("the board never unlocked", st)
        # loadLevel's promise still means "complete, unlocked and playable".
        assert page.evaluate("window.__game.solveTap()") != -1
        harness.frames(page)
        assert len(page.evaluate("window.__game.state().tray")) == 1, (
            "play did not resume once the announcement was gone")

        # An ORDINARY level is never interrupted.
        page.evaluate("async (n) => { await window.__game.startLevel(n); }", plain)
        harness.frames(page)
        assert page.evaluate("window.__game.hardBannerState()")["visible"] is False, (
            "an ordinary level played the hard-level announcement")

        # ---- 6b. never on a revive -----------------------------------------
        # A revive continues the EXISTING board — there is no new board to
        # announce, so the banner must not come back. Fill the tray without
        # matching to lose, then pay to continue.
        page.evaluate("(n) => window.__game.setLevel(n)", first_hard)
        page.evaluate("async (n) => { await window.__game.startLevel(n); }", first_hard)
        harness.frames(page)
        page.evaluate("window.__game.credit('coins', 100000)")
        # Fill the tray to capacity without ever completing a triple — the same
        # hand-driven loss continue_test.py uses, through the game's own
        # _collect/_settle path so _lose() fires for real.
        filled = page.evaluate("""() => {
              const s = window.__game.scene;
              let guard = 0;
              while (s.tray.length < s.traySlots && guard++ < 400) {
                const counts = {};
                for (const t of s.tray) counts[t.type] = (counts[t.type] || 0) + 1;
                const cand = s.tiles
                  .filter(t => !t.inTray && !t.matched && t.aliveCovers === 0)
                  .filter(t => (counts[t.type] || 0) < 2)
                  .sort((a, b) => (counts[a.type] || 0) - (counts[b.type] || 0));
                if (!cand.length) break;
                s._collect(cand[0]);
              }
              return s.tray.length;
            }""")
        time.sleep(0.6)   # the last _collect's setTimeout(_settle, 190) -> _lose
        lose = page.evaluate("window.__game.loseState()")
        print("LOSE ON HARD LEVEL -> filled:", filled, lose)
        assert lose["loseOverlay"] is True, ("could not fill the tray to lose", lose)
        page.evaluate("window.__game.pressLoseContinue()")
        time.sleep(1.6)
        revived = page.evaluate("window.__game.hardBannerState()")
        st = page.evaluate("window.__game.state()")
        print("AFTER REVIVE ->", revived, "locked:", st["locked"], "inLobby:", st["inLobby"])
        assert revived["visible"] is False, (
            "the announcement replayed on a revive — it continues the same board",
            revived)
        assert st["locked"] is False, "the board did not unlock after the revive"

        print("ERRORS:", len(errors))
        for e in errors[:10]:
            print("  ", e)
        assert not errors, errors
        print("ALL HARD LEVEL CHECKS PASSED")
