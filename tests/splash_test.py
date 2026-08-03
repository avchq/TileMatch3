"""The loading splash screen (index.html #splash + src/splash.js).

Covers: the overlay is painted before boot finishes, its bar advances across the
WHOLE of boot() (not just the asset preload), it really renders mid-flight on a
slow connection, it is gone and non-blocking by the time window.__game exists,
and a fatal boot failure leaves it up in its error state.
"""
import subprocess, time, sys, os
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
os.chdir(ROOT)
srv = subprocess.Popen([sys.executable, "-m", "http.server", "8099"],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1.5)
URL = "http://localhost:8099/index.html"
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "output")
os.makedirs(OUT, exist_ok=True)
try:
    with sync_playwright() as p:
        browser = p.chromium.launch(args=[
            "--use-gl=angle", "--use-angle=swiftshader",
            "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"])
        context = browser.new_context(viewport={"width": 780, "height": 1334})
        page = context.new_page()
        errors = []
        page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
        page.on("pageerror", lambda e: errors.append("PAGEERROR: " + str(e)))

        def splash_state():
            return page.evaluate("""() => {
              const el = document.getElementById("splash");
              if (!el) return null;
              const cs = getComputedStyle(el);
              const fill = document.getElementById("splash-fill");
              const track = document.querySelector("#splash .splash-track");
              const r = el.getBoundingClientRect();
              return {
                display: cs.display, opacity: parseFloat(cs.opacity),
                pointerEvents: cs.pointerEvents,
                hiding: el.classList.contains("hiding"),
                error: el.classList.contains("error"),
                w: r.width, h: r.height,
                title: (el.querySelector(".splash-title") || {}).textContent || "",
                status: (document.getElementById("splash-status") || {}).textContent || "",
                pct: (document.getElementById("splash-pct") || {}).textContent || "",
                fillW: fill ? fill.getBoundingClientRect().width : -1,
                trackW: track ? track.getBoundingClientRect().width : -1,
                booted: !!window.__game,
              };
            }""")

        # ---- 1 + 3: the splash is up, and its bar visibly advances, while the
        # game is still loading. Throttle the connection over CDP so loading takes
        # long enough to observe (a local http.server is otherwise near-instant).
        cdp = context.new_cdp_session(page)
        cdp.send("Network.enable")
        cdp.send("Network.emulateNetworkConditions", {
            "offline": False, "latency": 40,
            "downloadThroughput": 400 * 1024, "uploadThroughput": 400 * 1024})
        page.goto(URL, wait_until="commit")
        # The markup sits above the <script> tags, so it is parsed (and painted)
        # before pixi.min.js and the ES modules are even fetched.
        page.wait_for_selector("#splash", state="attached", timeout=15000)

        first = splash_state()
        print("EARLY ->", first)
        assert first is not None, "#splash markup must exist in index.html"
        assert first["booted"] is False, "splash must be up before boot finishes"
        assert first["display"] != "none" and first["opacity"] > 0.9, "splash must be visible"
        assert first["w"] >= 780 and first["h"] >= 1334, "splash must cover the viewport"
        assert "Tile Match 3" in first["title"], f"unexpected title {first['title']!r}"

        # Sample the rendered bar until the game is up; it must be caught part-way.
        mid = []
        for _ in range(1200):
            s = splash_state()
            if s["booted"]:
                break
            if 0 < s["fillW"] < s["trackW"]:
                mid.append(s)
            time.sleep(0.02)
        page.wait_for_function("window.__game && window.__game.lobby", timeout=40000)
        print("MID-FLIGHT SAMPLES:", len(mid),
              "e.g.", [(round(m["fillW"] / m["trackW"], 2), m["pct"], m["status"]) for m in mid[:4]])
        assert mid, "the progress bar was never rendered part-way through loading"
        fracs = [m["fillW"] / m["trackW"] for m in mid]
        pcts = [float(m["pct"].rstrip("%")) for m in mid]
        # It grows, never shrinks, and really crosses the track rather than
        # sitting at one value. (The rendered fill lags the percentage slightly —
        # it is CSS-transitioned — so the two are only compared for direction.)
        assert all(b >= a - 0.01 for a, b in zip(fracs, fracs[1:])), \
            f"the bar shrank mid-load: {[round(f, 2) for f in fracs]}"
        assert all(b >= a for a, b in zip(pcts, pcts[1:])), f"the percentage went backwards: {pcts}"
        assert min(fracs) < 0.4 and max(fracs) > 0.6, \
            f"the bar did not visibly advance across the track: {min(fracs):.2f}..{max(fracs):.2f}"
        cdp.send("Network.emulateNetworkConditions", {
            "offline": False, "latency": 0,
            "downloadThroughput": -1, "uploadThroughput": -1})

        # ---- 2: the recorded progress covers the whole boot, monotonically.
        # Boot as a RETURNING player so this load lands on the lobby (a fresh
        # profile is routed straight into level 1 by the first-run flow), which is
        # what check 4 below clicks on.
        page.goto(URL)
        page.wait_for_function("window.__game && window.__game.lobby", timeout=20000)
        page.evaluate("window.__game.completeLevel(1); window.__game.flushSave();")
        page.reload()
        page.wait_for_function("window.__game && window.__game.inLobby()", timeout=20000)
        hist = page.evaluate("window.__splash.history")
        ps = [h["p"] for h in hist]
        statuses = [h["status"] for h in hist]
        print("HISTORY -> steps:", len(ps), "first:", ps[0], "last:", ps[-1])
        print("STATUSES:", sorted(set(statuses)))
        assert ps, "no progress was reported"
        assert all(b >= a for a, b in zip(ps, ps[1:])), f"progress went backwards: {ps}"
        assert ps[0] < 0.2, f"progress must start near 0, got {ps[0]}"
        assert ps[-1] == 1, f"progress must finish at 1, got {ps[-1]}"
        # Not driven by the asset preload alone: stages before and after it report too.
        assert any("level table" in s for s in statuses), "the level table stage is silent"
        assert any("profile" in s for s in statuses), "the profile stage is silent"
        assert any("assets" in s for s in statuses), "the asset preload stage is silent"
        assert any("settings" in s for s in statuses), "the config stage is silent"
        assert any("board" in s for s in statuses), "the scene-build stage is silent"
        # ... and the pre-preload stages really are pre-preload.
        assets_at = next(p for p, s in zip(ps, statuses) if "assets" in s)
        board_at = next(p for p, s in zip(ps, statuses) if "board" in s)
        assert 0 < assets_at < board_at < 1, \
            f"stages out of order (assets {assets_at}, board {board_at})"

        # ---- 4: gone, and not swallowing input, once the game is ready.
        s = splash_state()
        print("ONCE READY ->", {k: s[k] for k in ("display", "opacity", "pointerEvents", "hiding", "booted")})
        assert s["booted"] is True
        # Taps must reach the canvas the instant boot finishes — the fade-out must
        # not keep the overlay interactive while it plays.
        assert s["pointerEvents"] == "none", f"splash still swallowing taps after boot: {s}"
        # ... and it must then take itself out of the document entirely.
        page.wait_for_function(
            "getComputedStyle(document.getElementById('splash')).display === 'none'", timeout=5000)
        page.screenshot(path=f"{OUT}/splash_after_boot.png")

        # A real canvas click must reach the game (regression guard: a splash left
        # up would eat it). Press the lobby cog through its on-screen position.
        assert page.evaluate("window.__game.inLobby()") is True, "expected the lobby"
        cog = page.evaluate("""() => {
          const c = window.__game.controls().find(c => c.scene === "lobby" && c.name === "cog");
          const v = window.__game.view();
          const r = document.querySelector("canvas").getBoundingClientRect();
          return { x: r.x + r.width * ((c.x + c.w / 2) / v.designW),
                   y: r.y + r.height * ((c.y + c.h / 2) / v.designH) };
        }""")
        page.mouse.click(cog["x"], cog["y"])
        time.sleep(0.5)
        opened = page.evaluate("window.__game.settingsVisible()")
        print("CANVAS CLICK ON COG -> settingsVisible:", opened)
        assert opened is True, "a canvas click did not reach the game"

        print("ERRORS:", len(errors))
        for e in errors[:10]:
            print("  ", e)
        clean = not errors

        # ---- 5: a fatal boot failure leaves the splash up, explaining itself.
        page.route("**/assets/config/levels.json", lambda route: route.abort())
        page.goto(URL)
        page.wait_for_function(
            "document.getElementById('splash').classList.contains('error')", timeout=15000)
        s = splash_state()
        print("BOOT FAILURE ->", {k: s[k] for k in ("display", "opacity", "error", "status", "booted")})
        assert s["booted"] is False, "boot should not have completed"
        assert s["display"] != "none" and s["opacity"] > 0.9, "splash must stay up on a fatal error"
        assert s["status"].startswith("Error"), f"no error message shown: {s['status']!r}"
        page.screenshot(path=f"{OUT}/splash_error.png")
        page.unroute("**/assets/config/levels.json")

        print("ALL SPLASH CHECKS PASSED" if clean else "COMPLETED WITH ERRORS")
        browser.close()
finally:
    srv.terminate()
