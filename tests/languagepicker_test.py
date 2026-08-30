import subprocess, time, sys, os, json
from playwright.sync_api import sync_playwright

import harness

# The LANGUAGE PICKER — the settings screen's Language row and the scrolling list
# it opens (src/settings.js + src/languagepicker.js).
#
# The contract:
#   * Settings carries a Language row showing the current language's OWN name.
#   * Tapping it opens a scrolling list of all 13, in the picker's fixed order,
#     with the current one tick-marked and auto-scrolled into view.
#   * The names in the list are NOT translated — a Russian player still sees
#     "Deutsch" and "Traditional Chinese". The heading "Language" is the only
#     word in the popup that changes with the language.
#   * Tapping a row moves the tick and changes NOTHING ELSE. The choice applies
#     on CONFIRM; closing the popup any other way discards it.
#   * The panel's own layout holds together: the list viewport ends a clear gap
#     above the Confirm button (which used to be drawn over the bottom row), the
#     two buttons don't collide, and all three stay inside the panel.
#
# The engine behind it (detection, storage, the swap, the rough edges) is
# i18n_test.py's subject.

CODES = ["zh", "zh-tw", "en", "id", "de", "es", "fr", "in", "it", "jp", "ko", "ru", "pt"]
LABELS = ["Chinese", "Traditional Chinese", "English", "Bahasa Indonesia", "Deutsch",
          "Español", "Français", "Hindi", "Italiano", "Japanese", "Korean",
          "Русский", "Português"]

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
os.chdir(ROOT)
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "output")
os.makedirs(OUT, exist_ok=True)
LANG = {c: json.load(open(os.path.join(ROOT, "assets", "lang", c + ".json"),
                          encoding="utf-8")) for c in CODES}

BASE = harness.serve()
with sync_playwright() as p:
    browser, page, errors = harness.launch(p, viewport=(750, 1334))

    page.goto(f"{BASE}/index.html")
    page.evaluate("() => localStorage.clear()")
    page.reload()
    page.wait_for_function("window.__game && window.__game.language", timeout=60000)
    # Boot into the LOBBY: a profile that never cleared level 1 is routed
    # straight into the level by the first-run flow.
    page.evaluate("window.__game.completeLevel(1); window.__game.flushSave();")
    page.reload()
    page.wait_for_function("window.__game && window.__game.language", timeout=60000)
    time.sleep(0.6)

    box = page.eval_on_selector("canvas", "c => { const r=c.getBoundingClientRect();"
                                          " return {x:r.x,y:r.y,w:r.width,h:r.height}; }")
    def click_design(dx, dy):
        page.mouse.click(box["x"] + box["w"] * (dx / 750),
                         box["y"] + box["h"] * (dy / 1334))
        time.sleep(0.35)

    def st():   return page.evaluate("window.__game.languagePickerState()")
    def row():  return page.evaluate("window.__game.languageRowText()")
    def snap(tag): page.screenshot(path=f"{OUT}/langpicker_{tag}.png")

    COG = (60, 84)              # settings cog, top-left
    LANGUAGE_ROW = (375, 847)   # the Language row, panel centre + 180

    # ---- the settings row ------------------------------------------------
    assert page.evaluate("window.__game.language()") == "en"
    click_design(*COG)
    assert page.evaluate("window.__game.settingsVisible()") is True
    r = row()
    print("LANGUAGE ROW ->", r)
    assert r["label"] == LANG["en"]["language"] == "Language", r
    assert r["value"] == "English", ("the row shows the language's own name", r)
    snap("settings_en")

    # ---- tapping it opens the picker ------------------------------------
    click_design(*LANGUAGE_ROW)
    s = st()
    print("PICKER ->", s["visible"], "picked:", s["picked"])
    assert s["visible"] is True, "the Language row must open the picker"
    assert s["codes"] == CODES, s["codes"]
    assert s["labels"] == LABELS, s["labels"]
    # The list is longer than its viewport, and the current choice is on
    # screen when the popup opens rather than needing to be hunted for.
    assert s["scroll"]["scrollable"] is True, s["scroll"]
    assert s["picked"] == "en" and s["pickedVisible"] is True, s
    snap("open_en")

    # ---- the panel's layout ---------------------------------------------
    # The list is a masked viewport with the two buttons pinned below it. The
    # Confirm button used to be drawn ON TOP of the bottom of the list (list
    # bottom +300 vs Confirm top +275), slicing the last visible language row.
    # Nothing inside the panel may overlap anything else, and the list must
    # end a real gap above Confirm, not merely touch it.
    g = page.evaluate("window.__game.languagePickerGeometry()")
    print("GEOMETRY ->", g)
    list_bottom = g["list"]["y"] + g["list"]["h"]
    confirm_top = g["confirm"]["y"]
    gap = confirm_top - list_bottom
    print(f"LIST BOTTOM {list_bottom} / CONFIRM TOP {confirm_top} / GAP {gap}")
    assert list_bottom <= confirm_top, \
        ("Confirm must not overlap the language list", list_bottom, confirm_top)
    assert gap >= 24, ("the list needs real clearance above Confirm, not a "
                       "hairline", gap)
    assert g["confirm"]["y"] + g["confirm"]["h"] <= g["back"]["y"], \
        ("Confirm must not overlap Back", g["confirm"], g["back"])
    # Everything the panel draws stays inside the panel.
    pan = g["panel"]
    for name in ("list", "confirm", "back"):
        r = g[name]
        assert r["x"] >= pan["x"] and r["x"] + r["w"] <= pan["x"] + pan["w"], (name, r, pan)
        assert r["y"] >= pan["y"] and r["y"] + r["h"] <= pan["y"] + pan["h"], (name, r, pan)
    snap("layout")

    # ---- tapping a row moves the tick and NOTHING else -------------------
    before = page.evaluate("""() => ({
            title: window.__game.lobby.title.text,
            lang: window.__game.language(),
            stored: window.__game.storedLanguage(),
            rowValue: window.__game.languageRowText().value,
        })""")
    page.evaluate("window.__game.tapLanguageRow('ru')")
    time.sleep(0.25)
    s = st()
    after = page.evaluate("""() => ({
            title: window.__game.lobby.title.text,
            lang: window.__game.language(),
            stored: window.__game.storedLanguage(),
            rowValue: window.__game.languageRowText().value,
        })""")
    print("AFTER TAP ->", s["picked"], after)
    assert s["picked"] == "ru", "the tick must move to the tapped row"
    assert s["active"] == "en", "the ACTIVE language must not have changed yet"
    assert after == before, ("tapping a row must change nothing but the tick",
                             before, after)
    snap("picked_ru")

    # ---- closing any other way DISCARDS ---------------------------------
    page.evaluate("window.__game.closeLanguagePicker()")
    time.sleep(0.3)
    assert page.evaluate("window.__game.languagePickerVisible()") is False
    assert page.evaluate("window.__game.language()") == "en", \
        "closing without Confirm must discard the pick"
    assert page.evaluate("window.__game.storedLanguage()") == "en"
    # Re-opening starts from the ACTIVE language again, not the discarded pick.
    page.evaluate("window.__game.openLanguagePicker()")
    time.sleep(0.35)
    s = st()
    assert s["picked"] == "en", ("a discarded pick must not survive the reopen", s)
    assert s["pickedVisible"] is True, s

    # ---- Confirm applies -------------------------------------------------
    page.evaluate("window.__game.tapLanguageRow('ru')")
    time.sleep(0.2)
    page.evaluate("async () => await window.__game.confirmLanguage()")
    time.sleep(0.5)
    assert page.evaluate("window.__game.languagePickerVisible()") is False, \
        "Confirm must close the popup"
    assert page.evaluate("window.__game.language()") == "ru"
    assert page.evaluate("window.__game.storedLanguage()") == "ru"
    assert page.evaluate("window.__game.lobby.title.text") == LANG["ru"]["game_title"], \
        "Confirm must re-letter the screen underneath"
    r = row()
    print("ROW AFTER CONFIRM ->", r)
    assert r["label"] == LANG["ru"]["language"], ("the heading translates", r)
    assert r["value"] == "Русский", r
    snap("confirmed_ru")

    # The list itself is still in its own languages — only the heading moved.
    page.evaluate("window.__game.openLanguagePicker()")
    time.sleep(0.35)
    s = st()
    assert s["labels"] == LABELS, ("the language names are never translated", s["labels"])
    assert s["picked"] == "ru" and s["pickedVisible"] is True, \
        ("the popup opens on the current choice, scrolled to it", s)
    assert page.evaluate("window.__game.languagePicker.title.text") == \
        LANG["ru"]["language"]
    snap("open_ru")

    # ---- re-picking the current language just closes ---------------------
    page.evaluate("window.__game.tapLanguageRow('ru')")
    time.sleep(0.15)
    page.evaluate("async () => await window.__game.confirmLanguage()")
    time.sleep(0.35)
    assert page.evaluate("window.__game.languagePickerVisible()") is False
    assert page.evaluate("window.__game.language()") == "ru"

    # ---- the choice survives a reload, with progress intact --------------
    page.evaluate("window.__game.flushSave()")
    page.reload()
    page.wait_for_function("window.__game && window.__game.language", timeout=60000)
    time.sleep(0.6)
    assert page.evaluate("window.__game.language()") == "ru"
    assert page.evaluate("window.__game.user().progress.completed") == 1
    print("AFTER RELOAD ->", page.evaluate("window.__game.lobby.title.text"))

    # ---- the picker also reflows, and owns one control -------------------
    page.set_viewport_size({"width": 500, "height": 1000})
    time.sleep(0.4)
    page.evaluate("window.__game.openLanguagePicker()")
    time.sleep(0.35)
    assert page.evaluate("window.__game.languagePickerVisible()") is True
    snap("narrow")
    page.evaluate("window.__game.closeLanguagePicker()")

    print("PAGE ERRORS:", len(errors), errors[:5])
    assert not errors
    print("ALL LANGUAGE PICKER CHECKS PASSED")
    browser.close()