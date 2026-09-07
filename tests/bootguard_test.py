"""Two CRITICAL boot defects, and the guards that must keep them closed.

Both were session-killers with no way out but a reload, and both were invisible
to the rest of the suite.

  BOOT-001 — the boot-error overlay was a permanent kill-switch, IN PRODUCTION
  ONLY. index.html's inline handler asked `window.__game` whether the game had
  finished booting. That symbol lives inside a `DEBUG:` block, and
  `tools/build.py` passes `--drop-labels=DEBUG` to esbuild, so it does not exist
  in the artifact players run. The guard could never fire there: the FIRST
  post-boot error — an unhandled rejection from any discarded promise — dropped
  #splash (`position: fixed; inset: 0`, opaque) over a running game and left it
  there. Every test ran the dev tree, where __game exists and the guard worked,
  so nothing saw it. The flag is now `<html data-booted>`, set outside any DEBUG
  block, and this file deletes __game before triggering an error so the dev tree
  behaves like the artifact.

  BOOT-002 — one failed asset fetch permanently poisoned a level group.
  AssetManager caught each job's failure, so `Promise.all` always resolved and
  the group was added to `_loaded` regardless; the memo at the top of
  loadGroup() then short-circuited every later attempt. A single transient 5xx
  on a level's JSON meant the Play button did nothing on every tap for the rest
  of the session — no message, no retry, and the splash had reported 100%
  because failures ticked progress too. A group must now be marked loaded only
  if every one of its assets arrived.

The two compose: before this, a failing level ALSO reached index.html's handler
as an unhandled rejection, so the reward for a bad fetch was the red overlay.
"""
import time

from playwright.sync_api import sync_playwright

import harness

BASE = harness.serve()
failures = []


def check(cond, msg):
    print(f"  {'ok  ' if cond else 'FAIL'} {msg}")
    if not cond:
        failures.append(msg)


def splash_of(page):
    return page.evaluate("""() => {
        const el = document.getElementById('splash');
        const cs = el ? getComputedStyle(el) : null;
        return {
          cls: el ? el.className : null,
          display: cs ? cs.display : null,
          opacity: cs ? cs.opacity : null,
          status: (document.getElementById('splash-status') || {}).textContent,
          booted: document.documentElement.dataset.booted || null,
        };
    }""")


with sync_playwright() as p:
    # ======================================================================
    #  BOOT-001 — a post-boot error must not cover a live game
    # ======================================================================
    with harness.session(p) as (browser, page, errors):
        harness.boot(page, "window.__game && window.__game.inLobby !== undefined")
        harness.frames(page, 2)

        s = splash_of(page)
        print("after boot:", s)
        check(s["booted"] == "1",
              "boot sets <html data-booted>, outside any DEBUG block")
        check("error" not in (s["cls"] or ""), "splash is not in its error state")

        # Make the dev tree behave like a production bundle: __game is what
        # esbuild strips, and it is exactly what the old guard relied on.
        page.evaluate("() => { delete window.__game_backup; window.__game_backup = window.__game; delete window.__game; }")
        check(page.evaluate("() => typeof window.__game") == "undefined",
              "window.__game removed, as --drop-labels=DEBUG would")

        # An unhandled rejection — the shape the discarded startLevel promise
        # and the rollover ticker actually produced.
        page.evaluate("""() => { Promise.reject(new Error('synthetic post-boot rejection')); }""")
        # …and a plain uncaught error, the other half of index.html's handler.
        page.evaluate("""() => { setTimeout(() => { throw new Error('synthetic post-boot throw'); }, 0); }""")
        time.sleep(0.5)
        harness.frames(page, 2)

        s = splash_of(page)
        print("after a post-boot error:", s)
        check("error" not in (s["cls"] or ""),
              "a post-boot error does NOT paint the splash's error state")
        check(s["display"] == "none" or float(s["opacity"] or 0) == 0.0,
              f"the splash stays down over a live game (display={s['display']}, "
              f"opacity={s['opacity']})")

        # The real damage was that the overlay swallowed input. Prove the canvas
        # is still the thing under the pointer at the centre of the screen.
        top = page.evaluate("""() => {
            const el = document.elementFromPoint(innerWidth / 2, innerHeight / 2);
            return el ? el.tagName : null;
        }""")
        print("element at the centre of the viewport:", top)
        check(top == "CANVAS", f"the game still receives taps (topmost element: {top})")

        page.evaluate("() => { window.__game = window.__game_backup; }")
        page.screenshot(path=f"{harness.OUTPUT}/bootguard_post_boot_error.png")

    # ======================================================================
    #  BOOT-002 — a failed fetch must not permanently poison a level group
    # ======================================================================
    #  Level 5 is lazy (only levels 1-3 and the player's own level preload), so
    #  its group is cold and its fetch is ours to break.
    with harness.session(p) as (browser, page, errors):
        state = {"fail": True, "hits": 0}

        def route_level5(route):
            state["hits"] += 1
            if state["fail"]:
                route.fulfill(status=503, content_type="text/plain", body="nope")
            else:
                route.continue_()

        page.route("**/assets/levels/level5.tmb", route_level5)
        harness.boot(page, "window.__game && window.__game.inLobby !== undefined")

        check("level5" not in page.evaluate("window.__game.loadedGroups()"),
              "level 5 starts cold (it is not in the preload set)")

        # The lazy load fails. It must REJECT — the old code resolved.
        res = page.evaluate("""async () => {
            try { await window.__game.assets.ensureLevel(5); return 'resolved'; }
            catch (e) { return 'rejected: ' + e.message; }
        }""")
        print("ensureLevel(5) with the fetch failing ->", res)
        check(res.startswith("rejected"),
              "a failed asset fetch REJECTS instead of resolving quietly")
        check("level5" not in page.evaluate("window.__game.loadedGroups()"),
              "the group is NOT marked loaded — this is the whole defect")
        check(page.evaluate("window.__game.assets.levelData(5)") is None,
              "and no level data was cached")

        # The Play button's path: refused, and it must SAY so rather than
        # silently doing nothing.
        ok = page.evaluate("async () => await window.__game.startLevel(5)")
        check(ok is False, "startLevel(5) reports failure instead of half-starting")

        page.evaluate("""() => window.__game.lobby.flashHint(window.__game.t('level_load_failed'))""")
        harness.frames(page, 3)
        hint = page.evaluate("""() => {
            const f = window.__game.lobby._flash;
            return f ? { text: f.__text, alpha: f.alpha } : null;
        }""")
        print("lobby refusal pill:", hint)
        check(hint is not None and hint["text"] and hint["text"] != "level_load_failed",
              "the refusal is a localized message, not a raw key")
        # ...and it is actually VISIBLE. makeHintPill builds the pill at alpha 0
        # and the fade-in is the only thing that raises it, so this asserts the
        # fade ran at all. It used to be called as `tween(ticker, 180, {onUpdate})`
        # — the pre-options positional signature — and since destructuring a
        # Number just boxes it, `onUpdate` was silently undefined and the pill
        # sat at 0 for its whole life: the refusal was invisible in production.
        check(hint is not None and hint["alpha"] > 0,
              f"the refusal pill actually faded in (alpha={hint and hint['alpha']})")

        # NOW LET IT THROUGH. The point of not poisoning the group is that the
        # very next attempt is a real retry.
        state["fail"] = False
        before = state["hits"]
        res = page.evaluate("""async () => {
            try { await window.__game.assets.ensureLevel(5); return 'resolved'; }
            catch (e) { return 'rejected: ' + e.message; }
        }""")
        print(f"retry after recovery -> {res} (fetch attempts: {before} -> {state['hits']})")
        check(res == "resolved", "the retry succeeds")
        check(state["hits"] > before, "the retry really went back to the network")
        check("level5" in page.evaluate("window.__game.loadedGroups()"),
              "and the group is loaded now")
        check(page.evaluate("window.__game.assets.levelData(5)") is not None,
              "level 5's data is in memory")

        ok = page.evaluate("async () => await window.__game.startLevel(5)")
        check(ok is True, "the Play button works on the very next tap")
        page.evaluate("() => window.__game.exitLevel()")

    # ======================================================================
    #  BOOT-002 (b) — a partial group keeps what arrived and retries the rest
    # ======================================================================
    with harness.session(p) as (browser, page, errors):
        state = {"fail": True}
        page.route("**/assets/bg/*", lambda r: (
            r.fulfill(status=503, content_type="text/plain", body="nope")
            if state["fail"] and "bg6" in r.request.url else r.continue_()))
        harness.boot(page, "window.__game && window.__game.inLobby !== undefined")

        res = page.evaluate("""async () => {
            try { await window.__game.assets.ensureLevel(6); return 'resolved'; }
            catch (e) { return 'rejected'; }
        }""")
        print("level 6 with only its background failing ->", res)
        check(res == "rejected", "a failed BACKGROUND fails the group too")
        check("level6" not in page.evaluate("window.__game.loadedGroups()"),
              "the group stays unloaded")
        check(page.evaluate("window.__game.assets.levelData(6)") is not None,
              "…but the level DATA that did arrive is kept, not thrown away")
        # Playable despite the missing art — a background is decoration.
        ok = page.evaluate("async () => await window.__game.startLevel(6)")
        check(ok is True, "the level is still playable without its background")
        page.evaluate("() => window.__game.exitLevel()")

        state["fail"] = False
        res = page.evaluate("""async () => {
            try { await window.__game.assets.ensureLevel(6); return 'resolved'; }
            catch (e) { return 'rejected'; }
        }""")
        check(res == "resolved", "the retry picks up only the missing background")
        check(page.evaluate("window.__game.assets.background(6) != null") is True,
              "and the background is in memory")

    # ======================================================================
    #  BOOT-003 — no boot fetch may hang forever
    # ======================================================================
    #  A try/catch cannot rescue a promise that never settles. The handler below
    #  never answers the route, which is exactly how a dead connection behaves.
    with harness.session(p) as (browser, page, errors):
        harness.boot(page, "window.__game && window.__game.inLobby !== undefined")
        timeout_ms = page.evaluate("window.__game.config().network.fetchTimeoutMs")
        print("CONFIG.network.fetchTimeoutMs =", timeout_ms)
        check(isinstance(timeout_ms, (int, float)) and timeout_ms > 0,
              "the fetch timeout is a config knob, not an inlined constant")

        page.route("**/assets/levels/level5.tmb", lambda route: None)
        t0 = time.time()
        res = page.evaluate("""async () => {
            try { await window.__game.assets.ensureLevel(5); return 'resolved'; }
            catch (e) { return 'rejected: ' + e.message; }
        }""")
        took = time.time() - t0
        print(f"stalled level fetch -> {res} after {took:.1f}s")
        check(res.startswith("rejected"), "a stalled fetch fails instead of hanging")
        # Two attempts plus backoff, then it must be over. Generous, but bounded.
        check(took < (timeout_ms * 3) / 1000.0,
              f"it gave up within a bounded time ({took:.1f}s)")
        check("level5" not in page.evaluate("window.__game.loadedGroups()"),
              "a timed-out group is not marked loaded either")

print()
if failures:
    print(f"BOOT GUARD TEST FAILED — {len(failures)} check(s):")
    for f in failures:
        print(f"  - {f}")
    raise SystemExit(1)
print("ALL BOOT GUARD CHECKS PASSED")
