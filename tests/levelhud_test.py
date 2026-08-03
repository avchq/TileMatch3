import subprocess, time, sys, os
from playwright.sync_api import sync_playwright

# The level's top bar carries the LEVEL number, the coin pill, the cog and the
# back button — and NOTHING else. The remaining-tiles readout ("<n> tiles left")
# that used to sit under the level title is gone: no such text may appear
# anywhere in the level scene, on any level, at any point in a level's life
# (fresh board, after collecting tiles, after an undo).

SC = os.path.join(os.path.dirname(os.path.abspath(__file__)), "output")
os.makedirs(SC, exist_ok=True)
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
os.chdir(ROOT)
srv = subprocess.Popen([sys.executable, "-m", "http.server", "8099"],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1.5)

# Every string rendered by the live level scene, walked over the whole display
# tree (PIXI.Text nodes carry a `text` property) — not just the top-level
# controls, so a counter hidden inside a container is caught too.
SCENE_TEXTS = """() => {
  const out = [];
  const walk = (n) => {
    if (!n) return;
    if (typeof n.text === "string" && n.text) out.push(n.text);
    for (const c of (n.children || [])) walk(c);
  };
  walk(window.__game.scene);
  return out;
}"""

def check(page, when):
    texts = page.evaluate(SCENE_TEXTS)
    print(f"  {when}: {texts}")
    bad = [t for t in texts if "tiles left" in t.lower() or "tile left" in t.lower()]
    assert not bad, f"{when}: remaining-tiles readout must be gone, found {bad}"
    names = [c["name"] for c in page.evaluate("window.__game.controls()")
             if c["scene"] == "level"]
    assert "progressText" not in names, f"{when}: level controls still list it: {names}"
    return texts

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
        page.wait_for_function("window.__game && window.__game.settings", timeout=20000)
        time.sleep(0.5)

        # A player past the first level, so the full (non-stripped) top bar shows.
        page.evaluate("window.__game.completeLevel(1); window.__game.flushSave();")
        page.reload()
        page.wait_for_function("window.__game && window.__game.settings", timeout=20000)
        time.sleep(0.5)
        page.evaluate("window.__game.grantBooster('undo', 99)")

        for lvl in (1, 2):
            print(f"[level {lvl}]")
            page.evaluate(f"async () => {{ await window.__game.startLevel({lvl}); window.__game.closeTutorial(); }}")
            time.sleep(0.7)
            texts = check(page, "fresh board")
            assert any(t.upper().startswith("LEVEL") for t in texts), \
                ("the level title itself must stay", texts)

            # Collect two tiles (the board count changes — that is exactly when the
            # old counter re-rendered) and then undo one.
            for _ in range(2):
                page.evaluate("window.__game.solveTap()")
                time.sleep(0.35)
            check(page, "after collecting")
            page.evaluate("window.__game.scene.undo()")
            time.sleep(0.4)
            check(page, "after undo")

        page.screenshot(path=f"{SC}/levelhud_no_tiles_left.png")
        assert not errs, f"page errors: {errs[:5]}"
        print("LEVEL HUD TEST PASSED")
        b.close()
finally:
    srv.terminate()
