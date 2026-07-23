import subprocess, time, sys, os
from playwright.sync_api import sync_playwright
SC = os.path.join(os.path.dirname(os.path.abspath(__file__)), "output")
os.makedirs(SC, exist_ok=True)
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
os.chdir(ROOT)
srv = subprocess.Popen([sys.executable, "-m", "http.server", "8099"],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1.5)

# Coins are a spendable currency on the USER record (wallet.coins). They are shown
# in a top-HUD pill (lobby + level), earned by winning a level, spent in the shop on
# boosters, and topped up with real-money coin packs via the payment provider.
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
        page.wait_for_function("window.__game && window.__game.scene && !!window.__game.openShop", timeout=20000)
        time.sleep(0.5)

        def coins():    return page.evaluate("window.__game.balance('coins')")
        def pill():     return page.evaluate("window.__game.coinPillText()")
        def bcount(k):  return page.evaluate(f"window.__game.boosterCount('{k}')")

        # 1) Fresh profile: 0 coins, and the lobby coin pill shows 0.
        assert coins() == 0, coins()
        assert pill()["lobby"] == "0", pill()
        print("FRESH coins:", coins(), "pill:", pill())

        # 2) Crediting coins updates the pill LIVE (wallet-change subscription).
        page.evaluate("window.__game.credit('coins', 200)")
        time.sleep(0.1)
        assert coins() == 200 and pill()["lobby"] == "200", pill()

        # The in-level pill reflects the same balance once a level is started.
        page.evaluate("window.__game.startLevel(1)")
        time.sleep(0.6)
        assert pill()["game"] == "200", pill()

        # 3) Shop: opens as an overlay and lists the packages for sale (each with a
        #    price and a contents mix of coins and/or boosters).
        page.evaluate("window.__game.openShop()")
        time.sleep(0.3)
        assert page.evaluate("window.__game.shopVisible()") is True, "shop should be open"
        packs = page.evaluate("window.__game.packages()")
        print("packages:", packs)
        ids = [p["id"] for p in packs]
        assert "coins_small" in ids and "mega_bundle" in ids, packs

        # 4) Buy a BUNDLE package (real money, mock provider) — it grants coins AND a
        #    mix of boosters, all in one purchase.
        mega = next(p for p in packs if p["id"] == "mega_bundle")
        print("mega bundle contents:", mega["coins"], mega["boosters"])
        c_before = coins()
        b_before = {k: bcount(k) for k in ("wand", "undo", "shuffle")}
        res = page.evaluate("window.__game.buyPackage('mega_bundle')")
        time.sleep(0.1)
        assert coins() == c_before + mega["coins"], ("bundle credited coins", coins())
        for k, n in mega["boosters"].items():
            assert bcount(k) == b_before[k] + n, (f"bundle granted {k}", bcount(k))
        print("after mega bundle: coins", coins(), "boosters", {k: bcount(k) for k in ("wand", "undo", "shuffle")})

        # 5) Buy a SINGLE-ITEM package (just coins) — only the coin balance changes.
        small = next(p for p in packs if p["id"] == "coins_small")
        assert small["boosters"] == {}, ("coins_small is a single-item pack", small)
        c_before = coins()
        b_before = {k: bcount(k) for k in ("wand", "undo", "shuffle")}
        page.evaluate("window.__game.buyPackage('coins_small')")
        time.sleep(0.1)
        assert coins() == c_before + small["coins"], ("coin pack credited", coins())
        assert {k: bcount(k) for k in ("wand", "undo", "shuffle")} == b_before, "single-item pack grants no boosters"
        print("after coin pack: coins", coins())

        # 6) Winning a level awards coins (+reward) and the win overlay shows it.
        page.evaluate("window.__game.startLevel(1)")
        time.sleep(0.6)
        before_win = coins()
        # Solve the level to a win.
        for _ in range(400):
            r = page.evaluate("window.__game.solveTap()")
            time.sleep(0.12)
            if page.evaluate("window.__game.state().boardCount") == 0:
                break
        time.sleep(0.4)
        assert page.evaluate("window.__game.state().boardCount") == 0, "level should be won"
        gained = coins() - before_win
        print("win reward gained:", gained)
        assert gained == 25, ("level win should award 25 coins", gained)
        overlay_txt = page.evaluate("""() => {
            const g = window.__game.scene._overlayGroup; let s = '';
            g && g.children.forEach(ch => { if (ch.text) s += ch.text + '|'; });
            return s;
        }""")
        print("overlay text:", overlay_txt)
        assert "🪙" in overlay_txt, ("win overlay should show the coin reward", overlay_txt)

        # 7) The coin balance persists across a reload (it's on the user record).
        page.evaluate("window.__game.flushSave()")
        time.sleep(0.2)
        persisted = coins()
        page.reload()
        page.wait_for_function("window.__game && !!window.__game.openShop", timeout=20000)
        time.sleep(0.4)
        assert coins() == persisted, ("coins persist across reload", coins(), persisted)
        assert pill()["lobby"] == str(persisted), pill()
        print("AFTER reload coins:", coins())

        page.screenshot(path=f"{SC}/coins_state.png")
        print("PAGE ERRORS:", len(errs), errs[:5])
        assert not errs
        print("COINS TEST PASSED")
        b.close()
finally:
    srv.terminate()
