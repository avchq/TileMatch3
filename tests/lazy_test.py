import subprocess, time, sys, os
from collections import Counter
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
os.chdir(ROOT)
srv = subprocess.Popen([sys.executable, "-m", "http.server", "8099"],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1.5)
try:
    with sync_playwright() as p:
        browser = p.chromium.launch(args=[
            "--use-gl=angle", "--use-angle=swiftshader",
            "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist",
            "--autoplay-policy=no-user-gesture-required"])
        page = browser.new_page(viewport={"width": 780, "height": 1334})
        reqs = Counter()
        errors = []
        page.on("request", lambda r: reqs.update([r.url.split("localhost:8099/")[-1]]))
        page.on("pageerror", lambda e: errors.append("PAGEERROR: " + str(e)))

        page.goto("http://localhost:8099/index.html")
        page.evaluate("localStorage.removeItem('tm3.level')")
        page.reload()
        page.wait_for_function("window.__game && window.__game.loadedGroups().length >= 4", timeout=20000)
        time.sleep(0.5)

        print("loaded groups on boot:", page.evaluate("window.__game.loadedGroups()"))

        # Register a hypothetical FUTURE level 4 in the live manifest, reusing
        # existing files as stand-in assets (level4.json / a background).
        page.evaluate("""() => {
          window.__game.manifest.level4 = {
            backgrounds: { 4: 'assets/bg/bg2.jpg' },
            levels: { 4: 'assets/levels/level3.json' },
          };
        }""")

        # It must NOT have been fetched yet (not part of preload).
        assert page.evaluate("window.__game.assets.hasLevel(4)") is True
        assert page.evaluate("window.__game.assets.levelData(4)") in (None, )  # undefined -> None
        print("level4 registered, not yet loaded ->", "level4" not in page.evaluate("window.__game.loadedGroups()"))

        # Trigger it on demand via ensureLevel (the progress-gated path).
        reqs.clear()
        page.evaluate("() => window.__game.assets.ensureLevel(4)")
        page.wait_for_function("window.__game.loadedGroups().includes('level4')", timeout=10000)
        time.sleep(0.3)
        fetched = {u: c for u, c in reqs.items() if u.startswith("assets/")}
        print("fetched on lazy ensureLevel(4):", fetched)
        assert reqs.get("assets/levels/level3.json", 0) >= 1, "level4 json should fetch on demand"
        assert page.evaluate("window.__game.assets.levelData(4)") is not None

        # Second ensure -> cached, no new fetch.
        reqs.clear()
        page.evaluate("() => window.__game.assets.ensureLevel(4)")
        time.sleep(0.3)
        again = {u: c for u, c in reqs.items() if u.startswith("assets/")}
        print("fetched on 2nd ensureLevel(4):", again or "NONE")
        assert not again, f"cached level should not refetch: {again}"

        print("ERRORS:", len(errors))
        print("LAZY-LOAD CHECKS PASSED" if not errors else "COMPLETED WITH ERRORS")
        browser.close()
finally:
    srv.terminate()
