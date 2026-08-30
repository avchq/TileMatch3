import importlib.util, json, os, shutil, subprocess, sys, tempfile, time
from playwright.sync_api import sync_playwright

import harness

# THE PRODUCTION ARTIFACT MUST BE MINIFIED, OBFUSCATED, STRIPPED — AND STILL BOOT.
#
# `tools/build.py` bundles the 28 ES modules into one file, minifies it,
# obfuscates it, drops the `window.__game` cheat console, and uploads the result
# to S3 under the commit hash. Every other test in this suite serves the *repo
# root* and drives the game through `__game`, so not one of them would notice if
# the shipped bundle were broken, readable, or still carrying the debug API. This
# test is the only thing standing between an obfuscator setting and a dead game.
#
# It builds twice, into a temp directory so ./build is never disturbed:
#
#   A. the real production build — asserts the sources are gone, the bundle is
#      genuinely obfuscated, `__game` and `__splash` do not exist, and the game
#      still renders with zero page errors and zero failed requests;
#   B. the same pipeline with --keep-debug-api — bundled, minified and obfuscated
#      exactly as A, but with the debug API left in, so the deep assertions
#      (state, config, language tables, a level from the far end of
#      assets/levels/) can prove obfuscation did not change BEHAVIOUR.
#
# Then it calls verify() directly on a damaged artifact to prove the pre-upload
# gate rejects it rather than shipping it.

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


def build(tmp, *flags):
    r = subprocess.run([sys.executable, BUILD_PY, "--no-upload", "--allow-dirty",
                        "--build-dir", tmp, *flags],
                       capture_output=True, text=True)
    if r.returncode != 0:
        print(r.stdout)
        print(r.stderr, file=sys.stderr)
        raise SystemExit(f"build {flags} failed with {r.returncode}")
    names = os.listdir(tmp)
    assert len(names) == 1, names
    return os.path.join(tmp, names[0]), r.stdout


def boot(dest, then):
    """Serve THE BUILD (not the repo) and run `then(page)` against it.

    This test cannot use the suite's shared server: that one serves the repo
    root, and the whole point here is to drive the staged artifact instead. It
    gets its own, on its own free port, so it still runs alongside the rest.
    """
    base, srv = harness.serve_dir(dest)
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(args=harness.LAUNCH_ARGS)
            page = browser.new_page(viewport={"width": 750, "height": 1334})
            harness.patient(page)
            errors, failed = [], []
            page.on("pageerror", lambda e: errors.append(str(e)))
            page.on("requestfailed", lambda r: failed.append(r.url))
            page.goto(f"{base}/index.html")
            then(page, errors, failed)
            browser.close()
    finally:
        srv.terminate()
        srv.wait()


tmp_a = tempfile.mkdtemp(prefix="tm3-prod-")
tmp_b = tempfile.mkdtemp(prefix="tm3-debug-")
try:
    # ======== A. the real production build ==================================
    dest, out = build(tmp_a)
    print(out.strip())

    head = subprocess.run(["git", "rev-parse", "HEAD"], capture_output=True,
                          text=True).stdout.strip()
    check(os.path.basename(dest).startswith(head[:12]),
          f"build dir '{os.path.basename(dest)}' is named after HEAD {head[:12]}")

    info = json.load(open(os.path.join(dest, "build-info.json")))
    check(info["commit"] == head, "build-info.json records the full commit hash")
    check(info["bundled"] and info["minified"] and info["obfuscated"],
          f"build-info.json records the pipeline ({info['bundled']}/{info['minified']}/{info['obfuscated']})")
    check(info["debug_api"] is False, "build-info.json records that the debug API was stripped")

    # ---- the sources are gone, one bundle remains --------------------------
    src_files = sorted(os.listdir(os.path.join(dest, "src")))
    check(src_files == ["main.js"],
          f"src/ is one bundle, not 28 readable modules (got {src_files})")
    check(not os.path.isdir(os.path.join(dest, "src", "user")),
          "src/user/ is bundled away, not shipped")

    bundle = open(os.path.join(dest, "src", "main.js"), encoding="utf-8").read()
    check('from "./' not in bundle and "from'./" not in bundle,
          "the bundle has no relative imports left")

    # ---- it is actually obfuscated, not merely minified --------------------
    # Exported class names and debug-API method names are unmissable in the
    # source and must not survive. Note these are all *identifiers*: lowercase
    # module names like "dailybonus" are deliberately NOT asserted, because they
    # also occur inside asset URLs ("assets/config/dailybonus.json") which have
    # to survive in some decodable form for the game to fetch anything.
    for token in ("__game", "__splash", "solveTap", "clearSoundLog",
                  "FortuneWheelScene", "LobbyScene", "DailyBonusScene",
                  "TasksScene", "LanguagePickerScene"):
        check(token not in bundle, f"'{token}' does not appear in the shipped bundle")
    check("_0x" in bundle or "a0_" in bundle or bundle.count("0x") > 200,
          "the bundle carries obfuscator-style identifiers/literals")

    for required in ("index.html", "src/main.js", "vendor/pixi.min.js"):
        check(os.path.isfile(os.path.join(dest, required)), f"ships {required}")

    # ---- assets ship verbatim: they are the game's content -----------------
    for group, least in (("assets/audio", 10), ("assets/bg", 1), ("assets/config", 6),
                         ("assets/lang", 13), ("assets/levels", 1000)):
        n = len(os.listdir(os.path.join(dest, group))) if os.path.isdir(os.path.join(dest, group)) else 0
        check(n >= least, f"ships {group} ({n} files, need >= {least})")

    leaked = []
    for dirpath, dirnames, filenames in os.walk(dest):
        for name in dirnames + filenames:
            if name in ("tests", "tools", ".venv", ".git", ".claude", "CLAUDE.md",
                        "README.md", "node_modules", "__pycache__") or name.endswith(".py"):
                leaked.append(os.path.relpath(os.path.join(dirpath, name), dest))
    check(not leaked, f"no dev files in the artifact (leaked: {leaked[:5]})")

    # ---- and it still runs -------------------------------------------------
    def check_prod(page, errors, failed):
        page.wait_for_timeout(6000)
        seen = page.evaluate("""() => {
          const c = document.querySelector('canvas');
          const s = document.getElementById('splash');
          return { canvas: !!c, w: c ? c.width : 0, h: c ? c.height : 0,
                   splashHidden: !s || getComputedStyle(s).display === 'none',
                   game: typeof window.__game, splash: typeof window.__splash,
                   pixi: typeof window.PIXI };
        }""")
        page.screenshot(path=os.path.join(ROOT, "tests", "output", "build_production.png"))
        print(f"  production build booted: {seen}")
        check(not errors, f"no page errors booting the production build ({errors[:2]})")
        check(not failed, f"no failed requests ({failed[:3]})")
        check(seen["canvas"] and seen["w"] == 750, "the game canvas is up at design width")
        check(seen["splashHidden"], "the splash handed over — boot() completed")
        check(seen["game"] == "undefined",
              "window.__game is NOT in the production build (it is a cheat console)")
        check(seen["splash"] == "undefined", "window.__splash is NOT in the production build")
    boot(dest, check_prod)

    # ======== B. same pipeline, debug API kept: prove behaviour survived =====
    dest_b, _ = build(tmp_b, "--keep-debug-api")
    info_b = json.load(open(os.path.join(dest_b, "build-info.json")))
    check(info_b["obfuscated"] and info_b["debug_api"] is True,
          "the staging build is obfuscated but keeps the debug API")

    def check_debug(page, errors, failed):
        page.wait_for_function("window.__game !== undefined", timeout=90000)
        page.wait_for_timeout(1500)
        state = page.evaluate("() => window.__game.state()")
        lang = page.evaluate("() => window.__game.language()")
        cfg = page.evaluate("() => window.__game.config()")
        missing = page.evaluate("() => window.__game.missingKeys()")
        deep = page.evaluate("""async () => {
          const r = await fetch('assets/levels/level1000.json');
          return { ok: r.ok, size: r.ok ? JSON.stringify(await r.json()).length : 0 };
        }""")
        page.screenshot(path=os.path.join(ROOT, "tests", "output", "build_staging.png"))
        print(f"  obfuscated build behaves: {state}, language={lang}")
        check(not errors, f"no page errors in the obfuscated build ({errors[:2]})")
        check(state["level"] == 1 and state["boardCount"] > 0,
              f"a real level is built after obfuscation ({state})")
        check(lang == "en", f"localization still resolves after obfuscation (got {lang})")
        check(isinstance(cfg, dict) and "board" in cfg,
              "src/config.js survived bundling and is readable through the API")
        check(not missing, f"no missing language keys in the obfuscated build ({missing[:5]})")
        check(deep["ok"] and deep["size"] > 100,
              f"a level from deep in assets/levels/ is served ({deep})")
    boot(dest_b, check_debug)

    # ======== the pre-upload gate ===========================================
    spec = importlib.util.spec_from_file_location("gamebuild", BUILD_PY)
    gamebuild = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(gamebuild)

    check(not gamebuild.verify(dest), "verify() passes a good artifact")

    shutil.copy(os.path.join(ROOT, "src", "config.js"),
                os.path.join(dest, "src", "config.js"))
    check(any("unbundled" in p for p in gamebuild.verify(dest)),
          "verify() rejects an artifact with unbundled sources left in it")
    os.remove(os.path.join(dest, "src", "config.js"))

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

    # An extension with no explicit Content-Type would go to S3 as
    # application/octet-stream, which is the sort of thing that only ever
    # reproduces in production.
    with open(os.path.join(dest, "assets", "config", "sprites.atlas"), "w") as f:
        f.write("atlas")
    check(any("Content-Type mapping for '.atlas'" in p for p in gamebuild.verify(dest)),
          "verify() rejects an asset whose extension has no Content-Type mapping")

    # ---- the top-level classification --------------------------------------
    # Every entry in the repo root must be known to ship or known not to. Tested
    # against a fabricated tree so the real repo is never touched.
    fake = tempfile.mkdtemp(prefix="tm3-root-")
    try:
        for d in ("src", "vendor", "assets"):
            os.makedirs(os.path.join(fake, d))
        open(os.path.join(fake, "index.html"), "w").write("<html></html>")
        open(os.path.join(fake, "src", "main.js"), "w").write("")

        got = gamebuild.walk_ship(fake)
        check("index.html" in got and "src/main.js" in got,
              f"walk_ship ships index.html and src/ from a clean tree ({got})")

        open(os.path.join(fake, "privacy.html"), "w").write("<html></html>")
        check("privacy.html" in gamebuild.walk_ship(fake),
              "a second top-level .html entry point ships automatically")
        os.remove(os.path.join(fake, "privacy.html"))

        os.makedirs(os.path.join(fake, "tests"))          # known: never ships
        open(os.path.join(fake, "README.md"), "w").write("")
        check("tests" not in " ".join(gamebuild.walk_ship(fake)),
              "known dev directories are still left out")

        open(os.path.join(fake, "sw.js"), "w").write("")  # unknown: must stop
        stopped = False
        try:
            gamebuild.walk_ship(fake)
        except SystemExit:
            stopped = True
        check(stopped, "an unclassified top-level file stops the build "
                       "(rather than silently not shipping)")
        os.remove(os.path.join(fake, "sw.js"))

        os.makedirs(os.path.join(fake, "shaders"))
        stopped = False
        try:
            gamebuild.walk_ship(fake)
        except SystemExit:
            stopped = True
        check(stopped, "an unclassified top-level directory stops the build")

        # ...unless it is the output directory itself, wherever it was pointed.
        check("shaders" not in " ".join(gamebuild.walk_ship(fake, os.path.join(fake, "shaders"))),
              "the build directory is never treated as an input")
    finally:
        shutil.rmtree(fake, ignore_errors=True)

    # ======== upload metadata a browser is strict about =====================
    check(gamebuild.content_type("src/main.js").startswith("text/javascript"),
          "the bundle uploads as text/javascript (a browser refuses anything else)")
    check(gamebuild.content_type("a.json").startswith("application/json"), "JSON content type")
    check(gamebuild.content_type("a.mp3") == "audio/mpeg", "mp3 content type")
    # Deploys switch the CloudFront ORIGIN PATH, so the commit hash is no longer
    # in the URL the browser asks for — /src/main.js is the same string for
    # every build. `immutable` would therefore park the old bundle in a player's
    # disk cache where no invalidation can reach it. Browsers revalidate;
    # CloudFront holds the object at the edge until the deploy clears it.
    check("immutable" not in gamebuild.CACHE_EDGE,
          "assets are NOT marked immutable (viewer URLs are stable now)")
    check("max-age=0" in gamebuild.CACHE_EDGE
          and "must-revalidate" in gamebuild.CACHE_EDGE,
          "browsers revalidate every asset request")
    check("s-maxage=31536000" in gamebuild.CACHE_EDGE,
          "…while CloudFront caches at the edge for a year")
    check(gamebuild.CACHE_REVALIDATE == "no-cache, must-revalidate",
          "index.html and build-info.json are never cached")

    # The obfuscator seed is derived from the commit, so a rebuild of the same
    # commit is byte-identical — which is what keeps the S3 ETag skip working.
    tmp_c = tempfile.mkdtemp(prefix="tm3-repeat-")
    try:
        dest_c, _ = build(tmp_c)
        a = open(os.path.join(tmp_a, os.listdir(tmp_a)[0], "src", "main.js"), "rb").read() \
            if False else None
        rebuilt = open(os.path.join(dest_c, "src", "main.js"), "rb").read()
        check(len(rebuilt) == len(bundle.encode("utf-8")) and
              rebuilt == bundle.encode("utf-8"),
              "rebuilding the same commit produces a byte-identical bundle")
    finally:
        shutil.rmtree(tmp_c, ignore_errors=True)

finally:
    shutil.rmtree(tmp_a, ignore_errors=True)
    shutil.rmtree(tmp_b, ignore_errors=True)

if failures:
    print(f"\nBUILD TEST FAILED — {len(failures)} check(s):")
    for f in failures:
        print(f"  - {f}")
    sys.exit(1)
print("\nBUILD TEST PASSED")
