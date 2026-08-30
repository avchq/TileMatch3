import subprocess, time, sys, os, json
from playwright.sync_api import sync_playwright

import harness

# EVERY TRANSLATION MUST FIT THE BUTTON IT SITS ON.
#
# The game's buttons are fixed-width pills with the label centred on top: the
# text is not clipped by a mask and not shrunk to fit, so a translation that runs
# long simply spills over the artwork. Nothing else in the suite can see that —
# the key-set and placeholder checks in i18n_test.py all pass on a string that is
# perfectly correct and twice too wide.
#
# So: boot each of the 13 languages in turn and measure the labels that live on a
# fixed-width widget, in design units, against that widget's width. Labels that
# are already run through fitTextWidth() (the lobby title and subtitle, the task
# rows, the tab buttons, the picker's language names) are deliberately NOT here —
# they shrink themselves, so measuring them proves nothing.
#
# A failure is a translation to shorten, not a layout to widen.

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
os.chdir(ROOT)
CODES = ["zh", "zh-tw", "en", "id", "de", "es", "fr", "in", "it", "jp", "ko", "ru", "pt"]

# label path -> the inner width it has to live inside. Each is the widget's own
# width less a little breathing room, matching how the pill is drawn.
#   (see _makeButton in game.js / settings.js / languagepicker.js for the widths)
CHECKS = """() => {
  const g = window.__game;
  const s = g.app.stage.scale.x || 1;
  const w = (o) => (o && !o.destroyed) ? o.getBounds().width / s : 0;
  const out = [];
  const push = (name, obj, limit) => {
    if (obj && !obj.destroyed) out.push([name, obj.text, Math.round(w(obj)), limit]);
  };
  push("lobby play button", g.lobby.playBtn.label, 440 - 40);
  push("settings Back",     g.settings.panel.children.find(c => c.label)?.label, 300 - 32);
  push("settings Language", g.settings.languageRow.children[0], 300);
  push("settings value",    g.settings.languageRow.value, 280);
  push("picker Confirm",    g.languagePicker.confirmBtn.label, 300 - 32);
  push("picker Back",       g.languagePicker.backBtn.label, 220 - 28);
  push("picker heading",    g.languagePicker.title, 620 - 60);
  push("level HUD",         g.scene.levelText, 750 - 220);
  push("auto complete",     g.scene.autoBtn.label, 460 - 40);
  return out;
}"""

BASE = harness.serve()
with sync_playwright() as p:
    browser = p.chromium.launch(args=[
        "--use-gl=angle", "--use-angle=swiftshader",
        "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"])
    page = browser.new_page(viewport={"width": 750, "height": 1334})
    harness.patient(page)
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))

    overflow = []
    for code in CODES:
        page.goto(f"{BASE}/index.html")
        page.evaluate("(c) => { localStorage.clear();"
                      " localStorage.setItem('tm3.language', c); }", code)
        page.reload()
        page.wait_for_function("window.__game && window.__game.language", timeout=60000)
        # Past every gate, so the whole interface is built and reachable.
        page.evaluate("window.__game.completeLevel(9); window.__game.flushSave();")
        page.reload()
        page.wait_for_function("window.__game && window.__game.language", timeout=60000)
        page.evaluate("window.__game.markBoosterCoached('all')")
        assert page.evaluate("window.__game.language()") == code, code
        # Build the in-level widgets too, then come back for the overlays.
        page.evaluate("async () => { await window.__game.startLevel(2);"
                      " window.__game.closeTutorial(); }")
        time.sleep(0.6)
        page.evaluate("window.__game.openSettings()")
        page.evaluate("window.__game.openLanguagePicker()")
        time.sleep(0.4)

        rows = page.evaluate(CHECKS)
        worst = max((wd / lim) for _, _, wd, lim in rows)
        print(f"{code:6} widest {worst*100:5.1f}% of its widget", end="")
        bad = [(code, n, txt, wd, lim) for n, txt, wd, lim in rows if wd > lim]
        print("   OVERFLOW" if bad else "")
        for b in bad:
            print(f"        {b[1]}: {b[2]!r} = {b[3]}px > {b[4]}px")
        overflow += bad
        page.screenshot(path=os.path.join(ROOT, "tests", "output", f"langfit_{code}.png"))
        page.evaluate("window.__game.closeLanguagePicker();"
                      " window.__game.settings._back();"
                      " window.__game.exitLevel();")

    assert not overflow, ("a translation overflows its button — shorten the "
                          "string in assets/lang/<code>.json", overflow)
    assert not errors, errors[:5]
    print("ALL LANGUAGE FIT CHECKS PASSED")
    browser.close()