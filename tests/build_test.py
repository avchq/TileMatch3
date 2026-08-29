import importlib.util, json, os, shutil, subprocess, sys, tempfile, time
from playwright.sync_api import sync_playwright

# THE PRODUCTION ARTIFACT MUST BOOT.
#
# `tools/build.py` stages a shipping copy of the game into build/<commit>/ and
# uploads it to S3. Nothing else in the suite looks at that copy: every other
# test serves the repo root, so a build that quietly drops `assets/levels/` or
# `vendor/pixi.min.js` would pass all 39 of them and fail only in production, as
# a splash frozen at "Starting up… 0%".
#
# So this test builds for real, then serves *the build directory* — not the repo
# — and boots the game out of it. What it proves:
#
#   1. the artifact is complete: entry points, all five asset groups, the 13
#      language tables, 1000+ level files, and no dev files (tests/, tools/,
#      .venv, READMEs) leaked into it;
#   2. build-info.json records the commit the build is named after;
#   3. the game actually loads and runs from the staged tree, with zero page
#      errors — the check that catches a missing module or asset;
#   4. the verify gate really rejects a damaged artifact instead of shipping it.
#
# The build is staged in a temp directory, so running this never disturbs ./build.

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
os.chdir(ROOT)
BUILD_PY = os.path.join(ROOT, "tools", "build.py")

failures = []
def check(cond, msg):
    if not cond:
        failures.append(msg)
        print(f"  FAIL {msg}")
    else:
        print(f"  ok   {msg}")

tmp = tempfile.mkdtemp(prefix="tm3-build-")
try:
    # ---- 1. build ----------------------------------------------------------
    # --allow-dirty so the test works from a work-in-progress tree; the gate
    # itself is asserted separately below.
    r = subprocess.run([sys.executable, BUILD_PY, "--no-upload", "--allow-dirty",
                        "--build-dir", tmp],
                       capture_output=True, text=True)
    print(r.stdout.strip())
    check(r.returncode == 0, f"build exits 0 (got {r.returncode}: {r.stderr.strip()[:200]})")

    builds = os.listdir(tmp)
    check(len(builds) == 1, f"exactly one build directory (got {builds})")
    dest = os.path.join(tmp, builds[0])

    # ---- 2. named after the commit ----------------------------------------
    head = subprocess.run(["git", "rev-parse", "HEAD"], capture_output=True,
                          text=True).stdout.strip()
    check(builds[0].startswith(head[:12]), f"build dir '{builds[0]}' is named after HEAD {head[:12]}")

    info = json.load(open(os.path.join(dest, "build-info.json")))
    check(info["commit"] == head, "build-info.json records the full commit hash")
    check(info["files"] > 1000, f"build-info.json counts the files ({info['files']})")
    check(info["bytes"] > 1_000_000, f"build-info.json records the size ({info['bytes']} B)")

    # ---- 3. complete, and nothing extra ------------------------------------
    for required in ("index.html", "src/main.js", "src/config.js", "src/game.js",
                     "src/i18n.js", "vendor/pixi.min.js"):
        check(os.path.isfile(os.path.join(dest, required)), f"ships {required}")

    for group, least in (("assets/audio", 10), ("assets/bg", 1), ("assets/config", 6),
                         ("assets/lang", 13), ("assets/levels", 1000)):
        n = len(os.listdir(os.path.join(dest, group))) if os.path.isdir(os.path.join(dest, group)) else 0
        check(n >= least, f"ships {group} ({n} files, need >= {least})")

    leaked = []
    for dirpath, dirnames, filenames in os.walk(dest):
        dirnames[:] = [d for d in dirnames]
        for name in dirnames + filenames:
            if name in ("tests", "tools", ".venv", ".git", ".claude", "CLAUDE.md",
                        "README.md", "__pycache__") or name.endswith(".py"):
                leaked.append(os.path.relpath(os.path.join(dirpath, name), dest))
    check(not leaked, f"no dev files in the artifact (leaked: {leaked[:5]})")

    # ---- 4. the artifact boots ---------------------------------------------
    # Serve the BUILD, not the repo, on the suite's usual port.
    srv = subprocess.Popen([sys.executable, "-m", "http.server", "8099"],
                           cwd=dest, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(1.5)
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(args=[
                "--use-gl=angle", "--use-angle=swiftshader",
                "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"])
            page = browser.new_page(viewport={"width": 750, "height": 1334})
            errors, failed_requests = [], []
            page.on("pageerror", lambda e: errors.append(str(e)))
            page.on("requestfailed", lambda r: failed_requests.append(r.url))
            page.goto("http://localhost:8099/index.html")
            page.wait_for_function("window.__game !== undefined", timeout=30000)
            page.wait_for_timeout(1500)

            state = page.evaluate("() => window.__game.state()")
            lang = page.evaluate("() => window.__game.language()")
            cfg = page.evaluate("() => !!window.__game.config()")
            missing = page.evaluate("() => window.__game.missingKeys()")
            page.screenshot(path=os.path.join(ROOT, "tests", "output", "build_boot.png"))

            print(f"  built artifact booted: {state}, language={lang}")
            check(not errors, f"no page errors booting the build ({errors[:2]})")
            check(not failed_requests, f"no failed requests ({failed_requests[:3]})")
            check(cfg, "src/config.js loaded in the built artifact")
            check(not missing, f"no missing language keys in the build ({missing[:5]})")

            # The level tree really came along. `setLevel` clamps to maxLevel
            # (the 20 entries in assets/config/levels.json), so asking the game
            # for level 1000 proves nothing — fetch the file from the served
            # build instead, which is exactly what a browser would do.
            deep = page.evaluate("""async () => {
              const r = await fetch('assets/levels/level1000.json');
              return { ok: r.ok, status: r.status,
                       tiles: r.ok ? JSON.stringify(await r.json()).length : 0 };
            }""")
            check(deep["ok"] and deep["tiles"] > 100,
                  f"a level from deep in assets/levels/ is served by the build ({deep})")

            last = page.evaluate("() => { window.__game.setLevel(999); return window.__game.currentLevel(); }")
            check(last == 20, f"setLevel clamps to the 20 levels in levels.json (got {last})")
            browser.close()
    finally:
        srv.terminate()
        srv.wait()

    # ---- 5. the verify gate actually rejects a damaged artifact ------------
    spec = importlib.util.spec_from_file_location("gamebuild", BUILD_PY)
    gamebuild = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(gamebuild)

    check(not gamebuild.verify(dest), "verify() passes a good artifact")

    os.remove(os.path.join(dest, "vendor", "pixi.min.js"))
    check(any("pixi" in p for p in gamebuild.verify(dest)),
          "verify() rejects a build missing vendor/pixi.min.js")

    shutil.rmtree(os.path.join(dest, "assets", "levels"))
    check(any("assets/levels" in p for p in gamebuild.verify(dest)),
          "verify() rejects a build with no levels")

    with open(os.path.join(dest, "assets", "config", "tasks.json"), "w") as f:
        f.write("{ not json")
    check(any("malformed JSON" in p for p in gamebuild.verify(dest)),
          "verify() rejects a build containing malformed JSON")

    # ---- 6. content types are set for the files a browser is strict about --
    check(gamebuild.content_type("src/main.js").startswith("text/javascript"),
          "ES modules upload as text/javascript (a browser refuses anything else)")
    check(gamebuild.content_type("a.json").startswith("application/json"), "JSON content type")
    check(gamebuild.content_type("a.mp3") == "audio/mpeg", "mp3 content type")
    check(gamebuild.CACHE_IMMUTABLE.startswith("public, max-age=31536000"),
          "commit-addressed objects are cached immutably")

finally:
    shutil.rmtree(tmp, ignore_errors=True)

if failures:
    print(f"\nBUILD TEST FAILED — {len(failures)} check(s):")
    for f in failures:
        print(f"  - {f}")
    sys.exit(1)
print("\nBUILD TEST PASSED")
