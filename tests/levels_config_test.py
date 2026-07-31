import subprocess, time, sys, os
from playwright.sync_api import sync_playwright

# The level table is a JSON config (assets/config/levels.json), fetched at boot —
# not a hard-coded array in a JS module. This test proves the JSON is the single
# source of truth: it's fetched on load, the asset MANIFEST's per-level groups are
# built from it, and the preload set is exactly `core` + the `preload:true` levels.
# On the old code (no levels.json) the fetch 404s and this test fails.

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
        errors = []
        page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
        page.on("pageerror", lambda e: errors.append("PAGEERROR: " + str(e)))

        page.goto("http://localhost:8099/index.html")
        page.wait_for_function("window.__game && window.__game.loadedGroups().length >= 4", timeout=20000)
        time.sleep(0.5)

        # 1) The level table is a JSON config, fetched at runtime.
        levels = page.evaluate("() => fetch('assets/config/levels.json').then(r => r.json())")
        print("levels in config:", len(levels))
        assert isinstance(levels, list) and len(levels) > 0, "levels.json must be a non-empty array"
        for i, lvl in enumerate(levels):
            assert "background" in lvl and "data" in lvl and "types" in lvl, f"entry {i} shape: {lvl}"

        # 2) The asset MANIFEST's per-level groups are DERIVED from that JSON
        #    (level N === entry N-1), so it holds one group per configured level.
        manifest = page.evaluate("() => window.__game.manifest")
        for i, lvl in enumerate(levels):
            n = i + 1
            grp = manifest.get(f"level{n}")
            assert grp is not None, f"manifest missing level{n}"
            assert grp["levels"][str(n)] == lvl["data"], (n, grp["levels"], lvl["data"])
            assert grp["backgrounds"][str(n)] == lvl["background"], (n, grp["backgrounds"], lvl["background"])
        # No phantom level groups beyond the config.
        level_groups = sorted(k for k in manifest if k.startswith("level"))
        assert len(level_groups) == len(levels), (level_groups, len(levels))

        # 3) The preload set is exactly `core` + every level flagged preload:true.
        expected_preload = ["core"] + [f"level{i + 1}" for i, l in enumerate(levels) if l.get("preload")]
        loaded = page.evaluate("() => window.__game.loadedGroups()")
        print("expected preload:", expected_preload, "loaded:", loaded)
        assert set(expected_preload) == set(loaded), (sorted(expected_preload), sorted(loaded))

        # 4) A non-preload level exists in the manifest but is NOT loaded yet
        #    (proves preload:true is what gates boot loading, straight from the JSON).
        lazy = [i + 1 for i, l in enumerate(levels) if not l.get("preload")]
        if lazy:
            n = lazy[0]
            assert page.evaluate(f"() => window.__game.assets.hasLevel({n})") is True
            assert f"level{n}" not in loaded, f"level{n} should not be preloaded"

        print("ERRORS:", len(errors))
        for e in errors[:10]:
            print("  ", e)
        print("LEVELS-CONFIG CHECKS PASSED" if not errors else "COMPLETED WITH ERRORS")
        browser.close()
finally:
    srv.terminate()
