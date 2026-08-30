import subprocess, time, sys, os, re
from playwright.sync_api import sync_playwright

import harness

# BOOT MUST SURVIVE A BROKEN ENVIRONMENT — and when it genuinely cannot, it must
# SAY SO rather than leave a frozen loading screen.
#
# This exists because of a real bug. `src/i18n.js` builds its singleton at module
# EVALUATION time, and that constructor read `CONFIG.language.defaultLanguage`
# directly. On a phone holding an older `src/config.js` in its module cache, that
# was a TypeError thrown while the module graph was being evaluated — before
# `boot()` was ever called. `boot().catch()` in src/main.js cannot see that, and
# index.html had no error handler, so the game died silently with the splash
# stuck on the markup's own "Starting up…" / "0%". Desktop, which had fetched
# everything fresh, was fine, so it looked like anything but a caching problem.
#
# Four guards, each routing one thing wrong at a time:
#   1. a STALE CONFIG (no `language` section)  — must still boot, in English
#   2. a STALLED language fetch               — must not hold boot open
#   3. MISSING language files                 — must boot; labels show their keys
#   4. a module that THROWS at import         — must paint the splash's error
#      state with a message, instead of freezing
# …plus a plain boot under two mobile device profiles.

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
os.chdir(ROOT)
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "output")
os.makedirs(OUT, exist_ok=True)

# A pre-localization src/config.js: the `language` section stripped out, which is
# exactly what a stale cached copy looks like.
CONFIG_SRC = open(os.path.join(ROOT, "src", "config.js"), encoding="utf-8").read()
STALE_CONFIG = re.sub(r"\n  // -+\n  //  LANGUAGE.*?\n  language: \{.*?\n  \},\n",
                      "\n", CONFIG_SRC, flags=re.S)
assert "language:" not in STALE_CONFIG, "failed to build the stale config fixture"

BASE = harness.serve()
with sync_playwright() as p:
    browser = p.chromium.launch(args=[
        "--use-gl=angle", "--use-angle=swiftshader",
        "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"])

    def open_page(**ctx_args):
        ctx = browser.new_context(**(ctx_args or {"viewport": {"width": 750, "height": 1334}}))
        page = ctx.new_page()
        harness.patient(page)
        page.__errors = []
        page.on("pageerror", lambda e: page.__errors.append(str(e)))
        return page

    def splash_of(page):
        return page.evaluate("""() => ({
                status: (document.getElementById('splash-status') || {}).textContent,
                pct: (document.getElementById('splash-pct') || {}).textContent,
                cls: (document.getElementById('splash') || {}).className,
                game: typeof window.__game,
            })""")

    def boot(page, timeout=75000):
        page.goto(f"{BASE}/index.html")
        page.wait_for_function("window.__game && window.__game.language", timeout=timeout)
        time.sleep(0.5)

    # ---- 1) a stale config must not kill the module graph ---------------
    page = open_page()
    page.route("**/src/config.js", lambda route: route.fulfill(
        status=200, content_type="text/javascript", body=STALE_CONFIG))
    boot(page)
    s = splash_of(page)
    print("STALE CONFIG ->", s["status"], s["pct"], "| lang:",
          page.evaluate("window.__game.language()"))
    assert s["game"] == "object", ("boot died on a stale config", s)
    assert "error" not in (s["cls"] or ""), s
    # It falls back to the module's own defaults, which mirror config.js.
    assert page.evaluate("window.__game.language()") == "en", s
    assert page.evaluate("window.__game.lobby.title.text") == "TILE MATCH 3"
    page.screenshot(path=f"{OUT}/boot_stale_config.png")
    page.context.close()

    # ---- 2) a stalled language fetch must not hold boot open ------------
    # The handler deliberately never resolves the route, so the request hangs
    # exactly the way a dead connection does. (Sleeping here instead would
    # block Playwright's own dispatcher, not the request, and prove nothing.)
    # i18n's fetch timeout fires, the load fails, and boot carries on.
    page = open_page()
    page.route("**/assets/lang/*.json", lambda route: None)
    t0 = time.time()
    boot(page)
    took = time.time() - t0
    print(f"STALLED FETCH -> booted in {took:.1f}s")
    assert took < 22, ("boot waited on the stalled language fetch", took)
    assert page.evaluate("window.__game.inLobby()") in (True, False)
    page.context.close()

    # ---- 3) missing language files: boot, and show the keys -------------
    page = open_page()
    page.route("**/assets/lang/*.json", lambda route: route.fulfill(status=404))
    boot(page)
    title = page.evaluate("window.__game.lobby.title.text")
    print("MISSING FILES -> lobby title:", title)
    assert page.evaluate("window.__game.language()") == "en"
    # No table at all, so every label falls back to the documented behaviour:
    # the key itself.
    assert title == "game_title", ("a missing key must render as the key", title)
    page.screenshot(path=f"{OUT}/boot_no_lang_files.png")
    page.context.close()

    # ---- 4) a module that throws must SAY so, not freeze ----------------
    page = open_page()
    page.route("**/src/i18n.js", lambda route: route.fulfill(
        status=200, content_type="text/javascript",
        body="throw new Error('deliberate module-scope failure');"))
    page.goto(f"{BASE}/index.html")
    time.sleep(2.0)
    s = splash_of(page)
    print("MODULE THROWS ->", s)
    assert s["game"] == "undefined", "the graph really should be dead here"
    assert "error" in (s["cls"] or ""), (
        "a module-level throw must paint the splash's error state, not leave "
        "it frozen at 'Starting up… 0%'", s)
    assert s["status"] and s["status"].startswith("Error:"), s
    assert "Starting up" not in s["status"], s
    page.screenshot(path=f"{OUT}/boot_module_error.png")
    page.context.close()

    # ---- 5) a plain boot on mobile profiles ------------------------------
    for name in ("iPhone 13", "Galaxy S9+"):
        page = open_page(**p.devices[name])
        boot(page)
        s = splash_of(page)
        print(f"{name} ->", s["status"], s["pct"], "| lang:",
              page.evaluate("window.__game.language()"),
              "| tag:", page.evaluate("document.documentElement.lang"))
        assert s["game"] == "object", (name, s)
        assert "error" not in (s["cls"] or ""), (name, s)
        assert not page.__errors, (name, page.__errors[:3])
        page.screenshot(path=f"{OUT}/boot_{name.split()[0].lower()}.png")
        page.context.close()

    print("ALL BOOT RESILIENCE CHECKS PASSED")
    browser.close()