#!/usr/bin/env python3
# End-to-end test for the SHARED animation primitive (src/tween.js) — ARCH-01.
#
# The codebase had converged on one correct answer to async staleness (a
# monotonic generation token plus a stale() predicate) and implemented it four
# separate times, once per owner, with no shared primitive. The sequence that
# needed it most did not get it, and that was PRAC-01: a tween wrote through a
# destroyed tile and the exception escaped into a Pixi ticker listener.
#
# That escape is the defect this file pins. Pixi v7's Ticker is (verbatim from
# vendor/pixi.min.js):
#
#     _tick = t => { this._requestId = null,
#       this.started && (this.update(t),
#         this.started && this._requestId === null && this._head.next
#           && (this._requestId = requestAnimationFrame(this._tick))) }
#
# and `update()` assigns `this.lastTime = t` as its LAST statement, after the
# listener walk. So an exception out of a listener means: rAF is never re-armed,
# `lastTime` freezes, and `started` stays true. The render loop is gone for good
# and the canvas silently stops — in production the boot-error overlay correctly
# stays away (index.html gates it on <html data-booted>), so the player just
# gets a dead game.
#
# Two consequences shape the checks below:
#
#   * `started` is a USELESS detector (it stays true) and so is harness.frames()
#     (it drives its own requestAnimationFrame, which keeps working after Pixi's
#     loop has died). Only `ticker.lastTime` advancing proves liveness — the
#     same detector auto_test.py uses for PRAC-01.
#   * Liveness must be sampled REPEATEDLY. `_addListener` calls
#     `_requestIfNeeded()`, which re-arms rAF whenever `_requestId === null`, so
#     any later ticker.add() anywhere buys exactly one more frame before the
#     still-registered poisoned listener throws it away again. A single
#     "did one frame pass?" sample can therefore be fooled.
#
# tween() now contains a throwing callback: it unhooks the listener FIRST, then
# reports through console.error, and ALWAYS RESOLVES ("done" | "abandoned" |
# "error"). It deliberately does not reject — two dozen call sites are
# fire-and-forget, and _autoComplete awaits a Promise.all whose rejection would
# abort the sweep with the board still locked, trading a dead render loop for an
# unwinnable level.
#
# Checks 1-3 drive the real module in the real page; check 4 needs no browser
# and runs in milliseconds.

import os
import re
import sys

from playwright.sync_api import sync_playwright

import harness

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
os.chdir(ROOT)

SC = os.path.join(os.path.dirname(os.path.abspath(__file__)), "output")
os.makedirs(SC, exist_ok=True)


def text(path):
    with open(os.path.join(ROOT, path), encoding="utf-8") as fh:
        return fh.read()


failures = []


def check(ok, msg):
    if not ok:
        failures.append(msg)
        print("  FAIL:", msg)
    else:
        print("  ok:", msg)


# ---------------------------------------------------------------------------
#  4. One animator, one staleness spelling  (source analysis, no browser)
# ---------------------------------------------------------------------------
# Run first: it is instant, and a failure here means the extraction was undone.
print("\n[4] source analysis — one owner per idiom")

# The re-targetable value animator used to be private to src/featurerail.js,
# reachable by nothing outside that file. It lives in src/tween.js now.
ANIMATOR = re.compile(
    r"^\s*(?:export\s+)?(?:const\s+animator\s*=|function\s+(?:retarget|step)\s*\()", re.M)
ANIMATOR_OWNER = "src/tween.js"

for name in sorted(os.listdir(os.path.join(ROOT, "src"))):
    if not name.endswith(".js"):
        continue
    path = "src/" + name
    if path == ANIMATOR_OWNER:
        continue
    hits = ANIMATOR.findall(text(path))
    check(not hits, f"{path} declares no value animator of its own ({len(hits)} hit(s))")

check(bool(ANIMATOR.search(text(ANIMATOR_OWNER))),
      f"{ANIMATOR_OWNER} is where the animator lives")
# The rail is the animator's one consumer: it must now IMPORT what it used to own.
RAIL_IMPORT = re.compile(
    r"import\s*\{([^}]*)\}\s*from\s*\"\./tween\.js\"", re.S)
rail = text("src/featurerail.js")
m = RAIL_IMPORT.search(rail)
named = {x.strip() for x in (m.group(1).split(",") if m else [])}
check(m is not None and {"animator", "retarget", "snap", "moving", "step"} <= named,
      f"src/featurerail.js imports the animator from tween.js instead of declaring it "
      f"(imports: {sorted(named)})")

# GameScene's generation token is compared in ONE place: the _stale() helper.
# Nine sites used to inline it, in four different shapes (two of them with the
# operands reversed). `const run = this._guideRun` captures are not comparisons.
GUIDE_CMP = re.compile(r"_guideRun\s*!==|!==\s*this\._guideRun")
game = text("src/game.js")
n = len(GUIDE_CMP.findall(game))
check(n == 1, f"src/game.js compares _guideRun in exactly one place (the _stale helper); found {n}")
check("_stale(run) {" in game, "src/game.js declares the _stale(run) helper")

# tutorial.js states its predicate once, in _stale(). Its four object-scoped
# guards (obj.destroyed / t.sprite.destroyed) are deliberately NOT folded in:
# _stale would add this.destroyed || this.closing and stop a live sprite
# animating during a close. They are a different question, not a copy.
tut = text("src/tutorial.js")
dup = tut.count("this._run !== run || this.destroyed || this.closing")
check(dup == 1, f"src/tutorial.js states its _stale body once, not twice; found {dup}")

# THE LOBBY REGRESSION. tween() is arity-2: tween(ticker, opts). Passing the
# duration positionally — tween(ticker, 180, {onUpdate}) — does not throw,
# because destructuring a Number just boxes it: `duration` silently falls back
# to 300 and `onUpdate` is undefined. src/lobby.js:870/872 did exactly that, so
# flashHint()'s "level failed to load" pill never faded in and was invisible in
# production for as long as it had been there.
CALL = re.compile(r"(?<![\w.$])tween\s*\(")
for name in sorted(os.listdir(os.path.join(ROOT, "src"))):
    if not name.endswith(".js"):
        continue
    path, src = "src/" + name, text("src/" + name)
    for m in CALL.finditer(src):
        i, depth = m.end(), 1
        while i < len(src) and depth:                 # find this call's first top-level comma
            c = src[i]
            if c in "([{":
                depth += 1
            elif c in ")]}":
                depth -= 1
                if not depth:
                    break
            elif c == "," and depth == 1:
                break
            i += 1
        if i < len(src) and src[i] == ",":
            rest = src[i + 1:].lstrip()
            line = src[:m.start()].count("\n") + 1
            check(rest.startswith("{"),
                  f"{path}:{line} passes tween() an options OBJECT, not a positional duration")

# ---------------------------------------------------------------------------
#  1-3. The real primitive in the real page
# ---------------------------------------------------------------------------
# This half deliberately poisons the shared ticker, so it gets its own session
# and does nothing else on that page.
POISON = "synthetic tween onUpdate throw"

BASE = harness.serve()
with sync_playwright() as p:
    with harness.session(p, viewport=(780, 1334)) as (browser, page, errors):
        # Get onto an ORDINARY board first. A fresh profile boots into level 1,
        # which is the guided level: the How To Play popup is up and the first-run
        # guide locks the board behind its demo moves, so a tap there proves
        # nothing. Clear level 1, reload into the lobby, and start level 2.
        harness.boot(page, "window.__game && window.__game.lobby", url=BASE)
        page.evaluate("window.__game.completeLevel(1); window.__game.flushSave();")
        page.reload()
        harness.ready(page, "window.__game && window.__game.lobby")
        page.evaluate("window.__game.startLevel(2)")
        harness.settle(page, "window.__game.state().locked === false", timeout=25000)
        harness.frames(page, 3)

        def live(label, timeout=5000):
            """The ticker really advanced — the only detector that works here."""
            t = page.evaluate("window.__game.app.ticker.lastTime")
            harness.settle(page, f"window.__game.app.ticker.lastTime > {t}", timeout=timeout)
            print(f"    {label}: lastTime moved past {t:.1f}")

        print("\n[0] baseline — the render loop is alive")
        live("baseline")

        print("\n[1] a throwing onUpdate must not take the render loop with it")
        # Fired exactly the way the ~24 fire-and-forget call sites fire: as a
        # statement, with nobody awaiting and nobody catching. Imported by URL,
        # so this is the very same module record the game itself is running.
        page.evaluate(
            """(msg) => import('/src/tween.js').then(({ tween }) => {
                   window.__settled = null;
                   tween(window.__game.app.ticker, {
                     duration: 400,
                     onUpdate: () => { throw new Error(msg); },
                   }).then((v) => { window.__settled = 'resolved:' + v; },
                           () => { window.__settled = 'rejected'; });
               })""", POISON)
        harness.frames(page, 4)

        # Sampled three times: one sample can be fooled, because any later
        # ticker.add() re-arms rAF for a single frame (see the header).
        for i in range(3):
            live(f"after the throw, sample {i + 1}", timeout=4000)
        check(page.evaluate("window.__game.app.ticker.started") is True,
              "the ticker is still started (it never stopped being — hence lastTime)")

        settled = page.evaluate("window.__settled")
        print("    the tween's promise settled as:", settled)
        check(settled == "resolved:error",
              f"a throwing tween resolves 'error' — never rejects, never hangs (got {settled!r})")

        hits = [e for e in errors if "tween: a callback threw" in e]
        check(len(hits) == 1,
              f"the throw is reported exactly once, not once per frame (got {len(hits)})")

        print("\n[2] `while` abandons: off the ticker, and onComplete never fires")
        res = page.evaluate(
            """() => import('/src/tween.js').then(({ tween }) => {
                   let updates = 0, frames = 0, live = true, completed = false;
                   const count = () => { if (++frames >= 3) live = false; };
                   window.__game.app.ticker.add(count);
                   const t0 = performance.now();
                   return tween(window.__game.app.ticker, {
                     duration: 3000,
                     onUpdate: () => { updates++; },
                     onComplete: () => { completed = true; },
                     while: () => live,
                   }).then((settled) => {
                     const elapsed = performance.now() - t0, atStop = updates;
                     return new Promise((r) => setTimeout(r, 250)).then(() => {
                       window.__game.app.ticker.remove(count);
                       return { settled, elapsed, atStop, after: updates, completed };
                     });
                   });
               })""")
        print("    ", res)
        check(res["settled"] == "abandoned",
              f"a `while` that goes false resolves 'abandoned' (got {res['settled']!r})")
        check(res["elapsed"] < 1500,
              f"…and resolves THEN, not at the full 3000ms duration ({res['elapsed']:.0f}ms)")
        check(res["after"] == res["atStop"],
              f"…and its listener really came off the ticker "
              f"({res['atStop']} updates at stop, {res['after']} 250ms later)")
        check(res["completed"] is False,
              "an abandoned tween does NOT run onComplete — which is why onComplete "
              "must never carry teardown that has to happen either way")

        print("\n[3] the game is still playable after all that")
        print("    state:", page.evaluate("window.__game.state()"))
        before = len(page.evaluate("window.__game.state().tray"))
        page.evaluate("window.__game.solveTap()")
        harness.frames(page, 6)
        after = len(page.evaluate("window.__game.state().tray"))
        print(f"    tray {before} -> {after}")
        check(after > before, "a tap still collects a tile on a board that survived the poison")
        page.screenshot(path=f"{SC}/tween_after_poison.png")

        # The synthetic throw is deliberate and is asserted above; nothing else
        # may have gone wrong. (bootguard_test.py filters its own the same way.)
        stray = [e for e in errors
                 if "tween: a callback threw" not in e and POISON not in e]
        print("\nPAGE ERRORS (excluding the synthetic one):", len(stray), stray[:5])
        check(not stray, f"no unexpected console/page errors: {stray[:5]}")

print()
if failures:
    print(f"TWEEN TEST FAILED ({len(failures)}):")
    for f in failures:
        print("  -", f)
    sys.exit(1)
print("TWEEN TEST PASSED — a throwing tween is contained, `while` abandons cleanly, "
      "and one owner holds the animator and the staleness spelling")
