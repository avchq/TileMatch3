#!/usr/bin/env python3
# THE SCENE REGISTRY — one list of the scenes `root` owns (SEP-04).
#
# `src/main.js` used to carry FOUR hand-maintained parallel lists over the same
# eight scene objects: `root.addChild(...)`, eight `X.layout(DW, DH)` calls in
# resize(), eight `X.relocalize()` calls in its language-change twin, and eight
# `add("key", X)` calls in the debug controls() seam. Adding a ninth feature
# meant remembering all four, and three of them fail SILENTLY when you don't:
#
#   * a missing layout() call  -> the scene is correct at exactly 750x1334 and
#     wrong on every other screen shape;
#   * a missing relocalize()   -> stale text after a language change;
#   * a missing add() entry    -> the scene is simply not measured by
#     resize_overlap_test.py, so it may overlap another control on every screen
#     and the suite stays green.
#
# One `scenes` array drives all four now. This file guards that in two halves:
#
#   1. SOURCE ANALYSIS (no browser, milliseconds — the debugseam_test.py idiom):
#      main.js may contain no per-scene broadcast call at all. A reintroduced
#      `wheel.layout(...)` or `add("wheel", wheel)` is the four lists growing
#      back, and it is invisible from behaviour until the ninth feature arrives.
#
#   2. THE PROBE SCENE (browser): register a ninth member into the live registry
#      through `window.__game.sceneRegistry()` and prove it receives ALL THREE
#      broadcasts — the real layout(DW, DH) on a resize, relocalize() on a
#      language change, and a row in controls(). That is the property the
#      registry exists for, and it cannot be expressed against four lists.

import os
import re
import sys

from playwright.sync_api import sync_playwright

import harness

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
os.chdir(ROOT)

# The eight scenes, by the variable name main.js holds them under and by the
# public key controls() reports them as. The two differ for two of them
# (`scene` -> "level", `langPicker` -> "language"), which is exactly why the
# registry carries a `key` instead of reusing the identifier.
VARS = ["scene", "lobby", "settings", "shop", "wheel", "daily", "tasks", "langPicker"]
KEYS = ["level", "lobby", "settings", "shop", "wheel", "daily", "tasks", "language"]

failures = []


def check(cond, msg):
    if not cond:
        failures.append(msg)
        print("  FAIL", msg)
    else:
        print("  ok  ", msg)


def text(path):
    with open(os.path.join(ROOT, path), encoding="utf-8") as fh:
        return fh.read()


def blank_noncode(src, strings=True):
    """Comments (and, unless told otherwise, string bodies) -> spaces.

    Offsets are preserved, so the line numbers in a failure message stay
    honest. Same helper debugseam_test.py uses, and for the same reason:
    without it a `wheel.layout(` inside the comment that EXPLAINS the registry
    would read as a real call and this test would fail on its own docs.

    `strings=False` keeps string bodies, which the add("<key>", …) detector
    needs — the scene name it is looking for IS the string.
    """
    out = list(src)
    i, n = 0, len(src)
    while i < n:
        c = src[i]
        if c in "'\"`":
            if not strings:
                j = i + 1
                while j < n:
                    if src[j] == "\\":
                        j += 2
                        continue
                    if src[j] == c:
                        break
                    j += 1
                i = j + 1
                continue
            j = i + 1
            while j < n:
                if src[j] == "\\":
                    j += 2
                    continue
                if src[j] == c:
                    break
                j += 1
            for k in range(i + 1, min(j, n)):
                if out[k] != "\n":
                    out[k] = " "
            i = j + 1
            continue
        if c == "/" and i + 1 < n and src[i + 1] == "/":
            j = src.find("\n", i)
            j = n if j < 0 else j
            for k in range(i, j):
                out[k] = " "
            i = j
            continue
        if c == "/" and i + 1 < n and src[i + 1] == "*":
            j = src.find("*/", i + 2)
            j = n if j < 0 else j + 2
            for k in range(i, j):
                if out[k] != "\n":
                    out[k] = " "
            i = j
            continue
        i += 1
    return "".join(out)


NAMES = "|".join(VARS)
PER_SCENE_LAYOUT = re.compile(r"\b(?:" + NAMES + r")\.layout\s*\(")
PER_SCENE_RELOC = re.compile(r"\b(?:" + NAMES + r")\.relocalize\s*\(")
# The controls() helper takes the scene key as its first argument. Registered
# through the loop it is always the variable `key`; a literal there is a
# hard-coded list growing back. Run over comment-blanked (string-KEEPING)
# source, since the scene name it looks for is itself a string.
PER_SCENE_ADD = re.compile(r"\badd\s*\(\s*[\"'](?:" + "|".join(KEYS) + r")[\"']")
REGISTRY = re.compile(r"\bconst\s+scenes\s*=\s*\[")
ADDCHILD = re.compile(r"\broot\.addChild\s*\(")

# ---------------------------------------------------------------------------
#  0. The detectors must actually detect  (debugseam_test.py's own discipline)
# ---------------------------------------------------------------------------
SAMPLE = """
  // wheel.layout(DW, DH), langPicker.relocalize() and add("wheel", wheel) in a
  // comment are documentation, not calls.
  const scenes = [ { key: "level", obj: scene } ];
  root.addChild(...scenes.map((s) => s.obj));
  for (const s of scenes) s.obj.layout(DW, DH);
  for (const s of scenes) s.obj.relocalize();
  for (const { key, obj } of scenes) add(key, obj);
"""
VIOLATIONS = """
  daily.layout(DW, DH);
  langPicker.relocalize();
  add("language", langPicker);
"""
check(not PER_SCENE_LAYOUT.search(blank_noncode(SAMPLE))
      and not PER_SCENE_RELOC.search(blank_noncode(SAMPLE)),
      "detector: a registry loop and a commented-out call are not per-scene calls")
check(not PER_SCENE_ADD.search(blank_noncode(SAMPLE, strings=False)),
      "detector: add(key, obj) through the loop is not a hard-coded entry")
dirty = blank_noncode(VIOLATIONS)
check(bool(PER_SCENE_LAYOUT.search(dirty)) and bool(PER_SCENE_RELOC.search(dirty)),
      "detector: real per-scene layout/relocalize calls are caught")
check(bool(PER_SCENE_ADD.search(blank_noncode(VIOLATIONS, strings=False))),
      "detector: a real add(\"language\", langPicker) is caught")

# ---------------------------------------------------------------------------
#  1. main.js broadcasts through the registry, not through four lists
# ---------------------------------------------------------------------------
MAIN = text("src/main.js")
code = blank_noncode(MAIN)                       # comments AND strings blanked
literal = blank_noncode(MAIN, strings=False)     # comments blanked, strings kept


def lines_of(rx, src=None):
    src = code if src is None else src
    return [src[:m.start()].count("\n") + 1 for m in rx.finditer(src)]


hits = lines_of(PER_SCENE_LAYOUT)
check(not hits, "src/main.js lays scenes out through the registry only — "
                "per-scene .layout() calls at lines %s" % hits)
hits = lines_of(PER_SCENE_RELOC)
check(not hits, "src/main.js re-letters through the registry only — "
                "per-scene .relocalize() calls at lines %s" % hits)
hits = lines_of(PER_SCENE_ADD, literal)
check(not hits, "controls() measures through the registry only — "
                "hard-coded add(\"<key>\", …) calls at lines %s" % hits)

m = REGISTRY.search(literal)
check(bool(m), "src/main.js declares the `const scenes = [` registry")
if m:
    end = literal.find("];", m.end())
    body = literal[m.end():end if end > 0 else m.end()]
    for key, var in zip(KEYS, VARS):
        check(re.search(r"key\s*:\s*[\"']%s[\"']\s*,\s*obj\s*:\s*%s\b" % (key, var), body)
              is not None,
              "the registry maps %r -> %s" % (key, var))

n = len(ADDCHILD.findall(code))
check(n == 1, "exactly one root.addChild() call, and it spreads the registry; found %d" % n)
m = ADDCHILD.search(code)
if m:
    check("scenes" in code[m.end():m.end() + 120].split(";")[0],
          "the stage is populated FROM the registry (root.addChild(...scenes…))")

if failures:
    print("SOURCE ANALYSIS FAILED:")
    for f in failures:
        print(" -", f)
    sys.exit(1)

# ---------------------------------------------------------------------------
#  2. The probe scene: a ninth member gets all three broadcasts for free
# ---------------------------------------------------------------------------
BASE = harness.serve()
with sync_playwright() as p:
    browser, page, errs = harness.launch(p, viewport=(780, 1334))
    harness.boot(page, "window.__game && window.__game.scene "
                       "&& !!window.__game.sceneRegistry", url=BASE)

    # ---- the roster itself -------------------------------------------------
    # Pinned like buttonsound_test.py's pillButtonNames(): a scene dropping out
    # of the registry is a failure here rather than a scene quietly escaping
    # the reflow, the re-lettering and the overlap test.
    roster = page.evaluate("window.__game.sceneRegistry().map((s) => s.key)")
    print("REGISTRY ->", roster)
    assert roster == KEYS, ("the scene registry roster", roster, KEYS)

    shape = page.evaluate("""() => window.__game.sceneRegistry().map((s) => ({
        key: s.key,
        layout: typeof s.obj.layout === "function",
        relocalize: typeof s.obj.relocalize === "function",
        controls: typeof s.obj.controls === "function",
        parented: !!s.obj.parent,
        siblings: s.obj.parent ? s.obj.parent.children.length : -1,
    }))""")
    for s in shape:
        assert s["layout"] and s["relocalize"] and s["controls"], (
            "every registered scene must answer all three broadcasts — the loop "
            "calls them unconditionally, so a missing one is loud", s)
        assert s["parented"], ("every registered scene is on the stage", s)
        assert s["siblings"] == len(KEYS), (
            "nothing reaches the stage outside the registry", s)
    print("  ok   all %d scenes carry layout/relocalize/controls and are on the stage"
          % len(shape))

    # ---- register a ninth scene, from the test ----------------------------
    # A plain object, not a Pixi scene: controls() only needs `visible` and a
    # `getBounds()`, and layout/relocalize just record that they were called.
    page.evaluate("""() => {
        const probe = {
            visible: true,
            seen: { layout: [], relocalize: 0 },
            layout(w, h) { this.seen.layout.push([w, h]); },
            relocalize() { this.seen.relocalize++; },
            controls() {
                return [{ name: "probe", obj: {
                    visible: true,
                    getBounds: () => ({ x: 100, y: 200, width: 30, height: 40 }),
                } }];
            },
        };
        window.__probe = probe;
        window.__game.sceneRegistry().push({ key: "probe", obj: probe });
    }""")

    seen = page.evaluate("window.__probe.seen")
    assert seen["layout"] == [] and seen["relocalize"] == 0, ("probe starts clean", seen)

    # ---- broadcast 1: the reflow ------------------------------------------
    page.set_viewport_size({"width": 1180, "height": 820})
    harness.settle(page, "window.__probe.seen.layout.length > 0")
    harness.frames(page, 2)
    view = page.evaluate("window.__game.view()")
    got = page.evaluate("window.__probe.seen.layout")[-1]
    print("LAYOUT ->", got, "view ->", (view["designW"], view["designH"]))
    assert abs(got[0] - view["designW"]) < 0.5 and abs(got[1] - view["designH"]) < 0.5, (
        "a registered scene is handed the real design area (DW, DH), the same one "
        "the level scene reflowed into", got, view)

    # ---- broadcast 2: the re-lettering ------------------------------------
    swapped = page.evaluate("async () => await window.__game.setLanguage('ru')")
    assert swapped is True, "setLanguage must report the swap happened"
    harness.settle(page, "window.__probe.seen.relocalize > 0")
    print("RELOCALIZE ->", page.evaluate("window.__probe.seen.relocalize"))

    # ---- broadcast 3: the overlap measurement -----------------------------
    rows = [c for c in page.evaluate("window.__game.controls()") if c["scene"] == "probe"]
    print("CONTROLS ->", rows)
    assert len(rows) == 1, (
        "a registered scene is measured by controls() — this is the one that used "
        "to fail in complete silence, exempting a whole screen from "
        "resize_overlap_test.py", rows)
    assert rows[0]["name"] == "probe" and rows[0]["w"] > 0 and rows[0]["h"] > 0, rows

    print("  ok   a ninth scene registered in ONE place got the stage broadcast, "
          "the reflow, the re-lettering and the overlap measurement")

    # Leave the registry as we found it, so nothing downstream sees the probe.
    page.evaluate("""() => {
        const r = window.__game.sceneRegistry();
        const i = r.findIndex((s) => s.key === "probe");
        if (i >= 0) r.splice(i, 1);
    }""")
    page.evaluate("window.__game.resize && window.__game.resize()")
    harness.frames(page, 2)
    assert not [c for c in page.evaluate("window.__game.controls()")
                if c["scene"] == "probe"], "the probe is gone again"

    assert not errs, ("console errors / uncaught exceptions", errs[:5])
    print("ALL SCENE REGISTRY CHECKS PASSED")
    browser.close()
