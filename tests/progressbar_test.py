#!/usr/bin/env python3
# End-to-end test for the SHARED progress meter (src/layout.js makeProgressBar) — DUP-03.
#
# "Dark rounded track + coloured rounded fill + centred `n / m` count" was
# hand-copied SIX times: the two Super Wand streak bars and the Level Chest bar
# on the level's overlays (src/game.js), the lobby's persistent chest bar
# (src/lobby.js), the Super Wand promo's meter (src/superwandpromo.js) and the
# Tasks row meter (src/tasks.js) — whose style the game.js chest bar names in its
# own comment ("the Tasks-row style"), which is how far the copying had travelled.
#
# The copies had already drifted three ways, none of them intentional: the track
# alpha (0.75 / 0.72 / 0.70), the divide-by-zero guard on `needed` (two of the
# six had it, four did not), and the minimum fill width — `Math.max(h, w * pct)`,
# so one notch reads as a rounded stub rather than a sliver, which every copy
# happened to keep but nothing enforced.
#
# The checks are in three parts:
#
#   A. Source analysis, no browser, milliseconds (the debugseam_test.py idiom,
#      as used by rewards_test.py and tween_test.py). This is the part that fails
#      when a SEVENTH copy grows back: the fill idiom must have exactly one owner.
#   B. The widget's own contract, driven directly — src/layout.js is imported BY
#      URL, the same module record the game is running (tween_test.py's trick), so
#      this needs no window.__game seam at all.
#   C. Two converted call sites measured on screen, against geometry recorded
#      from the tree BEFORE the extraction. The lobby bar and the promo bar are
#      the two that carry the white hairline, and the lobby's is the one whose
#      track is offset from its container's origin — the two conversions with
#      something to get wrong. The other four are pinned by superwand_test.py,
#      levelchest_test.py, tasks_test.py and langfit_test.py.

import os
import re
import sys

from playwright.sync_api import sync_playwright

import harness

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
os.chdir(ROOT)


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
#  A. One owner for the meter  (source analysis, no browser)
# ---------------------------------------------------------------------------
print("\n[A] the progress meter has exactly one owner")

# The minimum-fill-width trick is the copies' fingerprint. Each spelled it with
# its own names — `Math.max(trackH, trackW * pct)`, `Math.max(TRACK_H, TRACK_W *
# pct)`, `Math.max(bar._trackH, bar._trackW * pct)` — so the stable signature is
# the shape, not the identifiers.
FILL_IDIOM = re.compile(r"Math\.max\([^)]*\*\s*pct\s*\)")
OWNER = "src/layout.js"
# Every scene that DRAWS one. src/levelchest.js is not a member and must not
# become one: it computes `filled`/`needed` and stays free of the UI side.
SHARERS = ["src/game.js", "src/lobby.js", "src/superwandpromo.js", "src/tasks.js"]

for name in sorted(os.listdir(os.path.join(ROOT, "src"))):
    if not name.endswith(".js"):
        continue
    path = "src/" + name
    if path == OWNER:
        continue
    hit = FILL_IDIOM.search(text(path))
    check(not hit,
          f"{path} draws its own progress fill"
          + (f" ({hit.group(0).strip()})" if hit else "")
          + " — the meter belongs to src/layout.js alone")

lay = text(OWNER)
check(bool(FILL_IDIOM.search(lay)), "src/layout.js owns the minimum-fill-width rule")
check("export function makeProgressBar" in lay, "src/layout.js exports makeProgressBar")

IMPORT = re.compile(r"import\s*\{([^}]*)\}\s*from\s*\"\./layout\.js\"", re.S)
for path in SHARERS:
    m = IMPORT.search(text(path))
    named = {x.strip() for x in (m.group(1).split(",") if m else [])}
    check("makeProgressBar" in named,
          f"{path} takes its meter from ./layout.js (imports: {sorted(named)})")

# The track is dark glass at ONE alpha now. 0.72 (lobby) and 0.70 (tasks) had no
# stated rationale and no test; three spellings of the same slab is exactly the
# drift this extraction closes.
check(len(re.findall(r"0x0a1226,\s*0\.7[02]\b", lay)) == 0,
      "src/layout.js states one track alpha, not the three the copies had")

# ---------------------------------------------------------------------------
#  B. The widget's contract, driven directly (no debug seam)
# ---------------------------------------------------------------------------
CONTRACT = """
async () => {
  const { makeProgressBar } = await import('/src/layout.js');
  const out = {};
  const bar = makeProgressBar({ w: 320, h: 22, color: 0xffcf4d });
  const rect = (o) => { const b = o.getLocalBounds();
    return [+b.x.toFixed(2), +b.y.toFixed(2), +b.width.toFixed(2), +b.height.toFixed(2)]; };

  out.children = bar.node.children.length;
  out.seams = [bar.node.__w, bar.node.__h];
  out.track = rect(bar.track);
  out.plainPasses = bar.track.geometry.graphicsData.length;

  bar.draw(0, 4);   out.empty = [bar.fill.width, bar.label.text];
  bar.draw(4, 4);   out.full = [+bar.fill.width.toFixed(2), bar.label.text];
  bar.draw(2, 4);   out.half = [+bar.fill.width.toFixed(2), bar.label.text];
  bar.draw(0.01, 4); out.sliver = [+bar.fill.width.toFixed(2), bar.label.text];
  bar.draw(1.6, 4); out.rounded = bar.label.text;
  bar.draw(9, 4);   out.over = +bar.fill.width.toFixed(2);
  bar.draw(1, 0);   out.zero = [bar.fill.width, bar.label.text];

  const lined = makeProgressBar({ w: 290, h: 24, color: 0x39c06a, outline: true });
  out.linedPasses = lined.track.geometry.graphicsData.length;
  out.linedTrack = rect(lined.track);

  const bare = makeProgressBar({ w: 280, h: 20, color: 0x39c06a, label: false });
  out.bareChildren = bare.node.children.length;
  out.bareLabel = bare.label;
  bare.draw(3, 5);
  out.bareFill = +bare.fill.width.toFixed(2);
  return out;
}
"""

# ---------------------------------------------------------------------------
#  C. The converted sites, measured  (baselines from the pre-extraction tree)
# ---------------------------------------------------------------------------
MEASURE = """
(which) => {
  const root = which === "lobby"
    ? window.__game.lobby.chestBar
    : window.__game.lobby.superWandPromo.group;
  const s = window.__game.app.stage.scale.x || 1;
  const gfx = [], txt = [];
  const r = (o) => { const b = o.getBounds();
    return [+(b.x/s).toFixed(2), +(b.y/s).toFixed(2), +(b.width/s).toFixed(2), +(b.height/s).toFixed(2)]; };
  const walk = (o) => {
    for (const c of (o.children || [])) {
      if (!c.visible) { continue; }
      const b = c.getBounds();
      if (b.width && b.height) {
        if (c instanceof PIXI.Text) txt.push([c.text, r(c)]);
        else if (c instanceof PIXI.Graphics) gfx.push(r(c));
      }
      walk(c);
    }
  };
  walk(root);
  return { gfx, txt };
}
"""


def has_rect(rects, want, tol=0.6):
    return any(all(abs(a - b) <= tol for a, b in zip(got, want)) for got in rects)


BASE = harness.serve()
with sync_playwright() as p:
    with harness.session(p, viewport=(780, 1334)) as (browser, page, errors):
        harness.boot(page, "window.__game && window.__game.lobby", url=BASE)

        print("\n[B] makeProgressBar's contract")
        c = page.evaluate(CONTRACT)
        print("   ", c)
        check(c["children"] == 3, f"track + fill + label, in that order ({c['children']} children)")
        check(c["seams"] == [320, 22], f"__w/__h measure the drawn size ({c['seams']})")
        check(has_rect([c["track"]], [-160, -11, 320, 22]),
              f"the track is drawn around its own centre ({c['track']})")
        check(c["plainPasses"] == 1, f"no hairline unless asked for ({c['plainPasses']} passes)")
        check(c["empty"] == [0, "0 / 4"], f"an empty meter draws nothing ({c['empty']})")
        check(c["full"] == [320.0, "4 / 4"], f"a full meter fills the track ({c['full']})")
        check(c["half"] == [160.0, "2 / 4"], f"half fills half ({c['half']})")
        # The load-bearing one: a single notch must still read as a rounded stub.
        check(c["sliver"] == [22.0, "0 / 4"],
              f"the fill never goes narrower than its own height ({c['sliver']})")
        check(c["rounded"] == "2 / 4", f"a mid-tween fraction rounds in the label ({c['rounded']})")
        check(c["over"] == 320.0, f"an over-full count clamps to the track ({c['over']})")
        # Four of the six copies had no guard here and would have produced NaN.
        check(c["zero"] == [0, "1 / 0"], f"a zero target draws nothing rather than NaN ({c['zero']})")
        check(c["linedPasses"] == 2, f"outline:true adds the white hairline ({c['linedPasses']})")
        check(has_rect([c["linedTrack"]], [-146.5, -13.5, 293, 27], tol=0.6),
              f"the hairline grows the track by its own width ({c['linedTrack']})")
        check(c["bareChildren"] == 2 and c["bareLabel"] is None,
              f"label:false draws no count ({c['bareChildren']} children, label={c['bareLabel']})")
        check(c["bareFill"] == 168.0, f"a label-less meter still fills ({c['bareFill']})")

        print("\n[C] the converted sites still sit where they sat")
        page.evaluate("window.__game.completeLevel(1); window.__game.flushSave();")
        page.reload()
        harness.ready(page, "window.__game && window.__game.lobby")
        harness.frames(page, 3)

        lc = page.evaluate("window.__game.lobbyChestState()")
        check(lc["visible"] is True and lc["label"] == "1 / 4",
              f"the lobby bar reads one notch of four ({lc['visible']}, {lc['label']!r})")
        ctl = [x for x in page.evaluate("window.__game.controls()")
               if x["scene"] == "lobby" and x["name"] == "chestBar"]
        check(len(ctl) == 1, f"the chest bar is a live lobby control ({ctl})")
        if ctl:
            got = [ctl[0]["x"], ctl[0]["y"], ctl[0]["w"], ctl[0]["h"]]
            check(has_rect([got], [211.5, 638.5, 352.0, 43]),
                  f"the lobby bar's bounds are unmoved ({got})")

        lobby = page.evaluate(MEASURE, "lobby")
        check(has_rect(lobby["gfx"], [270.5, 646.5, 293.01, 27]),
              f"the lobby track (290x24 + hairline) is unmoved ({lobby['gfx']})")
        check(has_rect(lobby["gfx"], [272, 648, 72.5, 24]),
              f"the lobby fill is one quarter of the track ({lobby['gfx']})")
        check(any(t == "1 / 4" for t, _ in lobby["txt"]),
              f"the lobby count is on the bar ({lobby['txt']})")

        page.evaluate("window.__game.openSuperWandPromo()")
        harness.frames(page, 4)
        promo = page.evaluate(MEASURE, "promo")
        # The promo's whole panel is uniformly scaled by fitPanel, and that scale
        # depends on text metrics that settle a frame or two after boot — so this
        # one is asserted by SHAPE, not by absolute units: the track keeps the
        # 380x26 + 3px-hairline aspect it is drawn at, and the count sits on it.
        aspect = [g for g in promo["gfx"] if abs(g[2] / g[3] - 383 / 29) < 0.05]
        check(len(aspect) == 1, f"the promo track keeps its drawn aspect ({promo['gfx']})")
        cnt = [r for t, r in promo["txt"] if t == "0 / 5"]
        check(len(cnt) == 1, f"the promo count reads zero of five ({promo['txt']})")
        if aspect and cnt:
            tc = (aspect[0][0] + aspect[0][2] / 2, aspect[0][1] + aspect[0][3] / 2)
            lc = (cnt[0][0] + cnt[0][2] / 2, cnt[0][1] + cnt[0][3] / 2)
            check(abs(tc[0] - lc[0]) < 1.5 and abs(tc[1] - lc[1]) < 1.5,
                  f"the promo count is centred on its track (track {tc}, label {lc})")
        page.evaluate("window.__game.closeSuperWandPromo()")
        harness.frames(page, 2)

        page.screenshot(path=os.path.join(harness.OUTPUT, "progressbar_lobby.png"))
        check(not errors, f"no console errors ({errors})")

if failures:
    print("\nFAILED:")
    for f in failures:
        print("  -", f)
    sys.exit(1)
print("\nPASS — one progress meter, six callers")
