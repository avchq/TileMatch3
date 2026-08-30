import subprocess, time, sys, os, json
from playwright.sync_api import sync_playwright

import harness

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
os.chdir(ROOT)
BASE = harness.serve()

with sync_playwright() as p:
    browser, page, errors = harness.launch(p, viewport=(780, 1334))

    page.goto(f"{BASE}/index.html")
    page.evaluate("() => localStorage.clear()")
    page.reload()
    page.wait_for_function("window.__game && window.__game.store", timeout=60000)

    # =====================================================================
    # 1) reset() wipes progress/wallet/settings on the ACTIVE backend and
    #    persists the clean state (survives reload), keeping identity.
    # =====================================================================
    id0 = page.evaluate("window.__game.user().id")
    page.evaluate("window.__game.setLevel(3)")
    page.evaluate("window.__game.credit('coins', 250)")
    page.evaluate("window.__game.setMusic(false)")
    page.evaluate("window.__game.flushSave()")
    print("BEFORE reset:", page.evaluate("window.__game.user()"))

    page.evaluate("() => window.__game.reset()")
    time.sleep(0.1)
    after = page.evaluate("window.__game.user()")
    print("AFTER reset (in-memory):", after)
    assert after["progress"]["level"] == 1, "progress must reset"
    assert after["wallet"] == {"coins": 0, "gems": 0}, "wallet must reset"
    assert after["settings"] == {"music": True, "sound": True}, "settings must reset"
    assert after["id"] == id0, "identity must be preserved across reset"

    page.evaluate("window.__game.flushSave()")   # persist the clean defaults
    page.reload()
    page.wait_for_function("window.__game && window.__game.store", timeout=60000)
    reloaded = page.evaluate("window.__game.user()")
    print("AFTER reset + reload:", reloaded)
    assert reloaded["progress"]["level"] == 1 and reloaded["wallet"] == {"coins": 0, "gems": 0}, \
        "reset must be durable across reload"
    assert reloaded["id"] == id0, "identity must survive reset + reload"

    # =====================================================================
    # 2) reset() goes through the ADAPTER (adapter.clear was called), so it
    #    works on any backend — not by manually clearing localStorage.
    # =====================================================================
    cleared_ok = page.evaluate("""async () => {
          const store = window.__game.store;
          let clearedId = null;
          const origClear = store.adapter.clear.bind(store.adapter);
          store.adapter.clear = async (id) => { clearedId = id; return origClear(id); };
          window.__game.setLevel(2);
          window.__game.flushSave();
          await store.reset();
          store.adapter.clear = origClear;
          return { clearedId, uid: store.user.id };
        }""")
    print("adapter.clear called with:", cleared_ok)
    assert cleared_ok["clearedId"] == cleared_ok["uid"], \
        "reset() must clear via the adapter (works on cloud backends), keyed by the player id"

    # =====================================================================
    # 3) Async save is serialized + last-write-wins: simulate a SLOW cloud
    #    adapter and fire rapid overlapping saves. No two writes may run
    #    concurrently, and the final persisted value must be the latest.
    # =====================================================================
    result = page.evaluate("""async () => {
          const store = window.__game.store;
          const orig = store.adapter.save.bind(store.adapter);
          const writes = [];
          let busy = false, concurrent = false;
          store.adapter.save = async (id, data) => {
            if (busy) concurrent = true;   // overlap detected -> race
            busy = true;
            writes.push(data.wallet.coins);
            await new Promise(r => setTimeout(r, 120));  // slow network write
            const res = await orig(id, data);
            busy = false;
            return res;
          };
          // reset to a known wallet, then fire 6 rapid change+save pairs
          await store.reset();
          for (let i = 1; i <= 6; i++) { window.__game.credit('coins', 1); store.save(); }
          await store._saving;                // drain the serialized chain
          store.adapter.save = orig;
          return { writes, concurrent, coins: store.user.balance('coins') };
        }""")
    print("serialized-save result:", result)
    assert result["concurrent"] is False, "async saves must never overlap (they are serialized)"
    assert result["writes"][-1] == result["coins"] == 6, "last write must win (final snapshot persisted)"

    page.evaluate("window.__game.flushSave()")
    page.reload()
    page.wait_for_function("window.__game && window.__game.store", timeout=60000)
    assert page.evaluate("window.__game.user().wallet.coins") == 6, "final coins must persist across reload"

    print("PAGE ERRORS:", len(errors), errors[:5])
    assert not errors
    print("ALL RESET / ASYNC-SAVE CHECKS PASSED")
    browser.close()