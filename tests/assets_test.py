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

        reqs = Counter()          # url -> count of network requests
        errors = []
        page.on("request", lambda r: reqs.update([r.url.split("localhost:8099/")[-1]]))
        page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
        page.on("pageerror", lambda e: errors.append("PAGEERROR: " + str(e)))

        page.goto("http://localhost:8099/index.html")
        # Let the first boot fully settle (all preload fetches done) BEFORE we
        # clear the counter and reload — otherwise its in-flight fetches leak
        # past reqs.clear() and get counted against the reload, inflating counts.
        page.wait_for_function("window.__game && window.__game.soundNames().length >= 7", timeout=20000)
        page.evaluate("localStorage.removeItem('tm3.level')")
        reqs.clear()
        page.reload()
        page.wait_for_function("window.__game && window.__game.soundNames().length >= 7", timeout=20000)
        time.sleep(0.8)

        print("--- network requests during load (assets) ---")
        asset_reqs = {u: c for u, c in reqs.items() if u.startswith("assets/")}
        for u in sorted(asset_reqs):
            print(f"  {asset_reqs[u]:>2}x  {u}")

        sounds = page.evaluate("window.__game.soundNames()")
        print("decoded sounds:", sounds)
        assert len(sounds) == 8, f"expected 8 decoded sounds, got {sounds}"

        # every audio file fetched exactly once during preload
        audio_loads = {u: c for u, c in reqs.items() if u.startswith("assets/audio/")}
        print("audio fetches during preload:", audio_loads)
        assert all(c == 1 for c in audio_loads.values()), "audio should be fetched once"
        assert len(audio_loads) == 8, "all 8 audio files preloaded"

        # NOW the key test: play each sound 20 times; expect ZERO new network reqs
        reqs.clear()
        for _ in range(20):
            for name in sounds:
                page.evaluate("(n) => window.__game.playSound(n)", name)
        time.sleep(0.6)
        new_audio_reqs = {u: c for u, c in reqs.items() if u.startswith("assets/audio/")}
        any_new = {u: c for u, c in reqs.items() if u.startswith("assets/")}
        print(f"--- after 140 sound plays: new asset requests = {any_new} ---")
        assert not new_audio_reqs, f"NETWORK GET on play! {new_audio_reqs}"
        assert not any_new, f"unexpected asset refetch on play: {any_new}"
        print("PASS: 120 plays -> 0 network requests")

        # play a full level through, counting audio refetches (bop/merge/win)
        reqs.clear()
        page.evaluate("async () => { await window.__game.startLevel(1); window.__game.closeTutorial(); }")
        time.sleep(0.5)
        for _ in range(4000):
            s = page.evaluate("window.__game.state()")
            if s["overlay"] or s["inLobby"]:
                break
            r = page.evaluate("window.__game.solveTap()")
            if r == -1:
                time.sleep(0.05)
            time.sleep(0.015)
        time.sleep(0.4)
        gameplay_audio = {u: c for u, c in reqs.items() if u.startswith("assets/audio/")}
        print("audio refetches during a full level play:", gameplay_audio or "NONE")
        assert not gameplay_audio, f"gameplay refetched audio: {gameplay_audio}"

        print("ERRORS:", len(errors))
        for e in errors[:10]:
            print("  ", e)
        print("ALL ASSET/AUDIO CHECKS PASSED" if not errors else "COMPLETED WITH ERRORS")
        browser.close()
finally:
    srv.terminate()
