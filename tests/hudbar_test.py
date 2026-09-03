import time

from playwright.sync_api import sync_playwright

import harness

# The level scene's top bar: the translucent rounded panel behind the chrome.
# Everything it holds — the settings cog, Back, the LEVEL title, the coin pill
# (with its cart badge) — must sit INSIDE that panel, be vertically centred in
# it, and leave the SAME margin at the left and right ends, so the row reads
# symmetric rather than skewed.
#
# Regression guard: the cog used to poke out past the panel's left edge, the
# coin pill's cart badge hung ~20px past its right edge, and every element was
# centred on y=84 while the panel's own centre was y=100 — content crammed
# against the top with a band of empty panel underneath.

TOL = 3.0        # px, in design units: stroke padding on text/round bounds
SYM_TOL = 4.0    # px, allowed difference between the left and right margins

# Every bar element in DESIGN-SPACE units. Each is a direct child of hudTop at
# scale 1, so local bounds + position is the design-space rect — independent of
# the viewport scale the stage is under.
METRICS = """() => {
  const s = window.__game.scene;
  const r = (o) => {
    const b = o.getLocalBounds();
    const sx = o.scale.x, sy = o.scale.y;   // a long title is scaled to fit
    return { x: b.x * sx + o.x, y: b.y * sy + o.y, w: b.width * sx, h: b.height * sy };
  };
  return {
    bar: r(s.hudBar), cog: r(s.cog), back: r(s.backBtn),
    title: r(s.levelText), pill: r(s.coinPill),
  };
}"""


def check(page, tag):
    m = page.evaluate(METRICS)
    bar = m["bar"]
    bar_cx, bar_cy = bar["x"] + bar["w"] / 2, bar["y"] + bar["h"] / 2
    print(f"[{tag}] bar={bar}")

    for name in ("cog", "back", "title", "pill"):
        e = m[name]
        print(f"   {name:6s} {e}")
        # 1) fully inside the panel
        assert e["x"] >= bar["x"] - TOL, ("sticks out left of the bar", tag, name, e, bar)
        assert e["y"] >= bar["y"] - TOL, ("sticks out above the bar", tag, name, e, bar)
        assert e["x"] + e["w"] <= bar["x"] + bar["w"] + TOL, (
            "sticks out right of the bar", tag, name, e, bar)
        assert e["y"] + e["h"] <= bar["y"] + bar["h"] + TOL, (
            "sticks out below the bar", tag, name, e, bar)
        # 2) vertically centred in the panel — no top/bottom skew
        cy = e["y"] + e["h"] / 2
        assert abs(cy - bar_cy) <= TOL, (
            "not vertically centred in the bar", tag, name, cy, bar_cy)

    # 3) the outermost controls keep the same margin from each end
    left = m["cog"]["x"] - bar["x"]
    right = (bar["x"] + bar["w"]) - (m["pill"]["x"] + m["pill"]["w"])
    print(f"   margins: left={left:.1f} right={right:.1f}")
    assert abs(left - right) <= SYM_TOL, ("bar margins not symmetric", tag, left, right)

    # 4) the title is centred on the panel, and clear of both neighbours
    title_cx = m["title"]["x"] + m["title"]["w"] / 2
    assert abs(title_cx - bar_cx) <= TOL, ("title not centred", tag, title_cx, bar_cx)
    assert m["title"]["x"] > m["back"]["x"] + m["back"]["w"], (
        "title overlaps Back", tag, m["title"], m["back"])
    assert m["title"]["x"] + m["title"]["w"] < m["pill"]["x"], (
        "title overlaps the coin pill", tag, m["title"], m["pill"])

    # 5) the cog and Back don't collide either
    assert m["back"]["x"] > m["cog"]["x"] + m["cog"]["w"], (
        "cog and Back overlap", tag, m["cog"], m["back"])
    return m


with sync_playwright() as p:
    with harness.session(p) as (browser, page, errs):
        harness.boot(page, "window.__game && window.__game.scene")
        # A profile past the shop's unlock gate, so the coin pill wears its cart
        # badge (the widest thing at the right end) — and past the tutorial level.
        page.evaluate("window.__game.completeLevel(9); window.__game.flushSave();")
        page.reload()
        harness.ready(page, "window.__game && window.__game.scene")
        page.evaluate("window.__game.markBoosterCoached('all')")

        for vw, vh in [(780, 1334), (390, 844), (1024, 768)]:
            page.set_viewport_size({"width": vw, "height": vh})
            page.evaluate(
                "async () => { await window.__game.startLevel(25);"
                " window.__game.closeTutorial(); }")
            harness.frames(page, 3)
            assert page.evaluate("window.__game.hudState()")["cog"] is True
            check(page, f"{vw}x{vh}")
            page.screenshot(path=f"{harness.OUTPUT}/hudbar_{vw}x{vh}.png")
            page.evaluate("window.__game.exitLevel()")
            harness.frames(page, 3)

        # The longest localized title must still fit between Back and the pill:
        # the bar is symmetric, so the title's own box is what has to give.
        page.set_viewport_size({"width": 780, "height": 1334})
        for lang in ("ru", "en"):
            page.evaluate("(c) => window.__game.setLanguage(c)", lang)
            page.evaluate(
                "async () => { await window.__game.startLevel(999);"
                " window.__game.closeTutorial(); }")
            harness.frames(page, 3)
            m = check(page, f"lang={lang}")
            print(f"   title[{lang}] w={m['title']['w']:.0f}")
            page.evaluate("window.__game.exitLevel()")
            harness.frames(page, 3)

        assert not errs, f"page errors: {errs[:5]}"
    print("HUD BAR ALIGNMENT TEST PASSED")
