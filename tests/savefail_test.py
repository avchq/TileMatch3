import os, sys, time
from playwright.sync_api import sync_playwright

import harness

# A FAILED PROFILE WRITE MUST NOT BE SILENT.
#
# `LocalStorageAdapter.save` used to swallow every exception, so it resolved
# successfully whether or not the bytes landed. That made `UserStore.save`'s
# error path unreachable on the default (web) backend, and its own comment —
# "swallow — a failed save is retried on the next change" — described a retry
# that could never fire: the store believed every save succeeded. A player whose
# storage rejects writes (iOS Safari private browsing throws on EVERY setItem; a
# full quota does the same) played a whole session and lost all of it, with
# nothing logged and nothing shown.
#
# The contract is now: the adapter's save() REJECTS when the write did not land,
# and `UserStore.save` is the one and only place that swallows it — recording it
# (`saveFailures` / `lastSaveError`), warning, and offering an `onSaveError`
# hook. load()/clear() still degrade quietly; only a lost WRITE is data loss.
#
# Two injections, because the two halves are separable:
#   (a) the REAL adapter against a REAL broken localStorage — tests adapters.js
#   (b) a rejecting `adapter.save` — the cloud-backend (FBInstant / Telegram /
#       Devvit) case the serialize-and-coalesce machinery was written for, and
#       it exercises UserStore independently of localStorage.
#
# The store is reached through `window.__game.store`, which the DEBUG block
# already exposes — the same handle reset_test.py monkey-patches. No new seam.

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
os.chdir(ROOT)
BASE = harness.serve()

# The new log line is a console WARNING, deliberately: harness.watch() collects
# console *errors*, which dozens of tests assert is empty. Collect the warnings
# on a separate list so we can assert one was emitted without polluting that.
warnings = []

with sync_playwright() as p:
    browser, page, errors = harness.launch(p, viewport=(780, 1334))
    page.on("console", lambda m: warnings.append(m.text) if m.type == "warning" else None)

    harness.boot(page, "window.__game && window.__game.store")

    uid = page.evaluate("window.__game.user().id")
    UKEY = f"tm3.user:{uid}"

    # =====================================================================
    # 0) CONTROL: with storage working, nothing changes. The new reject path
    #    must cost the happy path exactly nothing.
    # =====================================================================
    page.evaluate("window.__game.setLevel(2)")
    page.evaluate("() => window.__game.store.save()")
    page.wait_for_function("!window.__game.store._saving", timeout=10000)
    ok = page.evaluate("""(k) => ({
            failures: window.__game.store.saveFailures,
            lastError: window.__game.store.lastSaveError,
            stored: JSON.parse(localStorage.getItem(k) || "null"),
          })""", UKEY)
    print("CONTROL (storage works):", ok["failures"], "| stored level:",
          (ok["stored"] or {}).get("progress", {}).get("level"))
    assert ok["failures"] == 0, ("a healthy write must not count as a failure", ok["failures"])
    assert ok["lastError"] is None, ok["lastError"]
    assert ok["stored"]["progress"]["level"] == 2, ("the control write must land", ok["stored"])

    # =====================================================================
    # 1) INJECTION (a): the real adapter against a real broken localStorage.
    #
    #    setItem throws QuotaExceededError for `tm3.user:` keys ONLY, so
    #    `tm3.uid` and `tm3.language` keep working and everything else about
    #    the session is normal. Patched AFTER boot so boot itself is untouched
    #    and the test controls exactly when storage starts failing.
    # =====================================================================
    broken = page.evaluate("""async () => {
          const store = window.__game.store;
          const orig = Storage.prototype.setItem;
          let attempts = 0;
          Storage.prototype.setItem = function (k, v) {
            if (String(k).startsWith("tm3.user:")) {
              attempts++;
              throw new DOMException("quota", "QuotaExceededError");
            }
            return orig.call(this, k, v);
          };
          window.__origSetItem = orig;   // so we can repair it below

          // The host's hook: this is what a player-facing notice would hang off.
          const seen = [];
          store.onSaveError = (e) => seen.push(e && e.name);

          window.__game.setLevel(3);
          window.__game.credit("coins", 40);
          await store.save();            // never rejects — it swallows, once
          return {
            attempts,
            failures: store.saveFailures,
            lastError: store.lastSaveError ? store.lastSaveError.name : null,
            hook: seen,
            live: store.user.progress.level,   // the model advanced anyway
          };
        }""")
    print("BROKEN localStorage ->", broken)

    # The regression assertions. On the old code the adapter swallowed, so the
    # save resolved "successfully" and none of these could ever move.
    assert broken["attempts"] >= 1, ("the adapter must actually attempt the write", broken)
    assert broken["failures"] >= 1, (
        "a write that did not land must be counted — the adapter has to reject "
        "rather than swallow, or UserStore can never know", broken)
    assert broken["lastError"] == "QuotaExceededError", (
        "the real error must reach the store, not a generic one", broken)
    assert broken["hook"] == ["QuotaExceededError"], (
        "onSaveError must fire once, with the error", broken)
    assert broken["live"] == 3, ("the model must still advance — a failed save is "
                                 "not a failed move", broken)

    # 2) The warning. Not an error: the game keeps playing.
    hit = [w for w in warnings if "UserStore" in w and "save failed" in w]
    print("WARNINGS ->", hit[:2])
    assert hit, ("a lost write must be logged (console.warn), not silent", warnings[-5:])
    assert not errors, ("a failed save must not raise a console error or a page "
                        "error — it is survivable", errors[:3])

    # 3) Nothing landed. The counter is reporting a genuine loss: storage still
    #    holds the pre-failure blob from the control step.
    stale = page.evaluate("(k) => JSON.parse(localStorage.getItem(k) || 'null')", UKEY)
    print("PERSISTED while broken -> level", stale["progress"]["level"],
          "coins", stale["wallet"]["coins"])
    assert stale["progress"]["level"] == 2 and stale["wallet"]["coins"] == 0, (
        "nothing may have landed while setItem was throwing", stale)

    # =====================================================================
    # 4) The retry the comment promises is now real: repair storage, make
    #    another change, and the next save writes the LATEST snapshot.
    # =====================================================================
    repaired = page.evaluate("""async () => {
          Storage.prototype.setItem = window.__origSetItem;
          const store = window.__game.store;
          const before = store.saveFailures;
          window.__game.credit("coins", 2);
          await store.save();
          return { before, after: store.saveFailures };
        }""")
    print("REPAIRED ->", repaired)
    assert repaired["after"] == repaired["before"], (
        "a healthy write after a failure must not count as another failure", repaired)

    page.evaluate("window.__game.flushSave()")
    page.reload()
    page.wait_for_function("window.__game && window.__game.store", timeout=60000)
    back = page.evaluate("window.__game.user()")
    print("AFTER repair + reload ->", back["progress"], back["wallet"])
    assert back["id"] == uid, "identity must survive"
    assert back["progress"]["level"] == 3 and back["wallet"]["coins"] == 42, (
        "once storage works again the pending state must be written and survive "
        "a reload — the retry-on-next-change the store documents", back)
    assert page.evaluate("window.__game.store.saveFailures") == 0, (
        "the counter is per-session; a fresh page starts clean")

    # =====================================================================
    # 5) INJECTION (b): a rejecting adapter — the cloud-backend shape.
    #
    #    Same assertions, reached without touching localStorage at all. This is
    #    the case the serialize-and-coalesce machinery in UserStore.save was
    #    actually written for (an FBInstant / Telegram / Devvit write that
    #    fails is far more likely than a localStorage one).
    # =====================================================================
    cloud = page.evaluate("""async () => {
          const store = window.__game.store;
          const orig = store.adapter.save.bind(store.adapter);
          let calls = 0;
          store.adapter.save = async () => {
            calls++;
            await new Promise((r) => setTimeout(r, 20));   // a network round-trip
            throw new Error("cloud write rejected");
          };
          const seen = [];
          store.onSaveError = (e) => seen.push(e && e.message);

          window.__game.credit("coins", 5);
          await store.save();
          const failures = store.saveFailures;
          const lastError = store.lastSaveError ? store.lastSaveError.message : null;

          store.adapter.save = orig;
          return { calls, failures, lastError, hook: seen, saving: store._saving };
        }""")
    print("REJECTING ADAPTER ->", cloud)
    assert cloud["calls"] >= 1, cloud
    assert cloud["failures"] >= 1, (
        "an async adapter that rejects must be counted too", cloud)
    assert cloud["lastError"] == "cloud write rejected", cloud
    assert cloud["hook"] == ["cloud write rejected"], (
        "onSaveError must fire for a cloud-backend failure as well", cloud)
    assert cloud["saving"] is None, (
        "the in-flight slot must be released even when the write rejected, or "
        "every later save would coalesce onto a dead promise", cloud)

    # The store must still work after a rejection — not be wedged.
    page.evaluate("""async () => {
          window.__game.credit('coins', 1);
          await window.__game.store.save();
        }""")
    final = page.evaluate("(k) => JSON.parse(localStorage.getItem(k) || 'null')", UKEY)
    print("AFTER a rejecting write, the next one lands ->", final["wallet"])
    assert final["wallet"]["coins"] == 48, (
        "a rejected save must not wedge the store — the next change still writes",
        final["wallet"])

    assert not errors, errors[:3]
    print("ALL SAVE-FAILURE CHECKS PASSED")
    browser.close()
