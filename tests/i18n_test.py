import subprocess, time, sys, os, re, json, glob
from playwright.sync_api import sync_playwright

import harness

# The game ships in 13 languages and every one of them is complete: the same key
# set in all 13, no gaps, no fallback to English, no partially-translated locale.
# The player can change language at any time from the settings screen and the
# whole interface re-letters itself immediately — no restart, no reload, no loss
# of progress.
#
# This test is the guard on all of that. It checks, in order:
#   1. THE FILES — all 13 parse, their key lists are byte-for-byte identical, no
#      value is empty, no phrase is left sitting in English, and the placeholder
#      tokens survive translation intact;
#   2. COVERAGE — every key the code and the config tables reference exists, and
#      nothing ships that nothing reads;
#   3. DETECTION — the device-language map, including the regional variants and
#      the two trap codes (`in` is HINDI, `jp` is used for `ja`);
#   4. THE STORED CHOICE — detection runs exactly ONCE, after which the stored
#      `tm3.language` wins outright;
#   5. THE LIVE SWAP — changing language re-letters the scenes in place;
#   6. THE ROUGH EDGES — a failed download still counts as a choice, a missing
#      key displays the key itself, and nothing ever unloads a language.
#
# The picker UI is languagepicker_test.py's subject.

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
os.chdir(ROOT)
LANG_DIR = os.path.join(ROOT, "assets", "lang")

# The 13, in the order the picker lists them. `in` is Hindi (Indonesian is `id`)
# and `jp` stands where the standard code would be `ja` — both are the game's
# own invention and are deliberately mirrored here.
CODES = ["zh", "zh-tw", "en", "id", "de", "es", "fr", "in", "it", "jp", "ko", "ru", "pt"]
LABELS = ["Chinese", "Traditional Chinese", "English", "Bahasa Indonesia", "Deutsch",
          "Español", "Français", "Hindi", "Italiano", "Japanese", "Korean",
          "Русский", "Português"]

# The device-language map, tag -> the code the game picks. Anything unrecognised
# becomes English, which is the `None` rows (mapTag returns null; detection then
# falls back to CONFIG.language.defaultLanguage).
DETECT = {
    "de": "de", "de-AT": "de", "de-CH": "de", "de-LI": "de",
    "es": "es", "es-ES": "es", "es-419": "es", "es-AR": "es", "es-MX": "es",
    "es-CO": "es", "es-PR": "es", "es-US": "es",
    "fr": "fr", "fr-BE": "fr", "fr-CH": "fr", "fr-LU": "fr",
    "zh": "zh", "zh-CN": "zh", "zh-SG": "zh",
    "zh-TW": "zh-tw", "zh-HK": "zh-tw", "zh-MO": "zh-tw", "zh-Hant-TW": "zh-tw",
    "id": "id", "en-ID": "id",          # Indonesian AND Indonesian-region English
    "hi": "in", "en-IN": "in",          # Hindi AND Indian English -> `in`
    "ja": "jp",                          # the game's code is `jp`, not `ja`
    "ko": "ko", "ru": "ru", "pt": "pt", "pt-BR": "pt", "it": "it", "en": "en",
    "en-GB": "en", "en-US": "en",
    "xx": None, "tr": None, "sv-SE": None, "": None,
}

TOKEN_RE = re.compile(r"\{\d\}")

# ---------------------------------------------------------------------------
#  1) THE FILES
# ---------------------------------------------------------------------------
tables = {}
for code in CODES:
    path = os.path.join(LANG_DIR, code + ".json")
    assert os.path.exists(path), f"missing language file: assets/lang/{code}.json"
    with open(path, encoding="utf-8") as fh:
        tables[code] = json.load(fh)

on_disk = sorted(os.path.basename(p)[:-5] for p in glob.glob(os.path.join(LANG_DIR, "*.json")))
assert on_disk == sorted(CODES), ("assets/lang/ must hold exactly the 13 offered "
                                  "languages", on_disk)

EN = tables["en"]
en_keys = list(EN.keys())
print(f"LANGUAGES: {len(tables)}   KEYS: {len(en_keys)}")

# The key list is identical across all 13 — no language has a key the others lack.
for code, table in tables.items():
    assert list(table.keys()) == en_keys, (
        f"{code}.json key list differs from en.json",
        sorted(set(table) ^ set(en_keys)))
    for key, val in table.items():
        assert isinstance(val, str) and val.strip(), (code, key, "empty value")

# Not a single PHRASE is left sitting in English. A one- or two-word cognate is
# fine (German "Level", Italian "Pass", Indonesian "OK"); a whole sentence copied
# through from en.json is a missed string.
def word_count(s):
    return len([w for w in TOKEN_RE.sub(" ", s.replace("%value", " ")).split() if w])

untranslated = []
for code, table in tables.items():
    if code == "en":
        continue
    for key in en_keys:
        if table[key] == EN[key] and word_count(EN[key]) >= 3:
            untranslated.append((code, key, EN[key]))
assert not untranslated, ("phrases left in English", untranslated[:10])

# Placeholders survive translation. There is no formatting system — the game does
# a plain FIRST-MATCH replace — so a placeholder repeated for emphasis would have
# its first copy filled and the second left as literal text on screen.
bad = []
for code, table in tables.items():
    for key in en_keys:
        src, dst = EN[key], table[key]
        if src.count("%value") != dst.count("%value"):
            bad.append((code, key, "%value count", src, dst))
        if dst.count("%value") > 1:
            bad.append((code, key, "%value appears more than once", dst))
        if sorted(TOKEN_RE.findall(src)) != sorted(TOKEN_RE.findall(dst)):
            bad.append((code, key, "{n} token set", src, dst))
        for tok in set(TOKEN_RE.findall(dst)):
            if dst.count(tok) > 1:
                bad.append((code, key, f"{tok} appears more than once", dst))
        if ("\n" in src) != ("\n" in dst):
            bad.append((code, key, "line break lost", src, dst))
assert not bad, ("placeholder damage", bad[:10])

# BADGE WORDS ARE NOT COPY. Short all-caps marks like NEW / HOT / TOP are part of
# the badge's artwork, not text: they sit in fixed-width pills sized around three
# characters, and they read as themselves worldwide. They stay as literals in the
# scene that draws them — the same treatment as the emoji glyphs — so none of
# them may acquire a key here.
BADGE_WORDS = {"NEW", "HOT", "TOP", "SALE", "BEST", "VIP", "PRO", "LIMITED", "SOON"}
badged = [(k, v) for k, v in EN.items() if v.strip().upper() in BADGE_WORDS]
assert not badged, ("badge words must not be localized — keep them as literals in "
                    "the scene that draws them", badged)
# …and the one this build has really is still a literal.
lobby_src = open(os.path.join(ROOT, "src", "lobby.js"), encoding="utf-8").read()
assert 'new PIXI.Text("NEW"' in lobby_src, \
    "the lobby's NEW badge must stay an untranslated literal"

print("FILES OK -> identical key sets, no English phrases, placeholders intact, "
      "no badge words")

# ---------------------------------------------------------------------------
#  2) COVERAGE — nothing ships that nothing reads
# ---------------------------------------------------------------------------
# The reverse direction — every key a SCREEN reaches for really resolves — is
# checked against the live game further down (`missingKeys`), because the keys
# arrive by three different routes and only the runtime sees all three:
#   1. baked into the screen layout   — locText("key", …)
#   2. looked up from the game logic  — t("key", …)
#   3. named by a config table        — assets/config/tasks.json `titles`,
#                                       PACKAGES `nameKey` in user/payments.js
# Here we only need the cheap static half: a key nothing anywhere mentions.
# Look for each key as a quoted literal anywhere in the source. Matching key by
# key rather than scanning for string literals keeps this immune to the quote
# pairing a naive scan gets wrong (escapes, regex literals, template strings).
source = "\n".join(open(path, encoding="utf-8").read()
                   for path in glob.glob(os.path.join(ROOT, "src", "**", "*.js"),
                                         recursive=True))
mentioned = {k for k in en_keys if f'"{k}"' in source}

tasks_cfg = json.load(open(os.path.join(ROOT, "assets", "config", "tasks.json"),
                           encoding="utf-8"))
assert "titles" in tasks_cfg, "tasks.json must name its row titles as text keys"
for activity, keys in tasks_cfg["titles"].items():
    mentioned |= {keys["title"], keys["one"]}
# itemName() composes item_<base>[_plural] from its own table, so those never
# appear whole in the source.
mentioned |= {f"item_{b}{suffix}" for b in ("coin", "undo", "wand", "shuffle")
              for suffix in ("", "_plural")}

dead = sorted(set(en_keys) - mentioned)
assert not dead, ("keys shipped that nothing reads", dead)
print(f"COVERAGE OK -> no dead keys among {len(en_keys)}")

# Every activity in the goal table has a title key, so a task row can never fall
# back to printing its internal activity code at the player.
activities = {r["activity"] for r in tasks_cfg["achievements"]} | \
             {r["activity"] for r in tasks_cfg["weekly"]}
assert activities <= set(tasks_cfg["titles"]), (
    "activity with no title key", sorted(activities - set(tasks_cfg["titles"])))

# ---------------------------------------------------------------------------
#  the live game
# ---------------------------------------------------------------------------
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "output")
os.makedirs(OUT, exist_ok=True)
BASE = harness.serve()
ARGS = ["--use-gl=angle", "--use-angle=swiftshader",
        "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"]
with sync_playwright() as p:
    browser = p.chromium.launch(args=ARGS)

    def new_page(locale=None):
        ctx = browser.new_context(viewport={"width": 750, "height": 1334},
                                  locale=locale) if locale else None
        page = ctx.new_page() if ctx else browser.new_page(
            viewport={"width": 750, "height": 1334})
        harness.patient(page)
        page.on("pageerror", lambda e: errors.append("PAGEERROR: " + str(e)))
        page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
        return page

    errors = []
    page = new_page()

    def boot():
        page.wait_for_function("window.__game && window.__game.language", timeout=60000)
        time.sleep(0.5)

    page.goto(f"{BASE}/index.html")
    page.evaluate("() => localStorage.clear()")
    page.reload()
    boot()

    # ---- 3) detection ---------------------------------------------------
    # The offered set is hard-coded in the program, in picker order, with the
    # names written in their own language rather than translated.
    langs = page.evaluate("window.__game.languages()")
    assert [l["code"] for l in langs] == CODES, [l["code"] for l in langs]
    assert [l["label"] for l in langs] == LABELS, [l["label"] for l in langs]

    for tag, want in DETECT.items():
        got = page.evaluate("(t) => window.__game.mapTag(t)", tag)
        assert got == want, (tag, got, want)
    print("DETECTION MAP OK -> including en-IN->in, en-ID->id, ja->jp, zh-HK->zh-tw")

    # Headless Chromium reports en-US, so a fresh profile detects English —
    # which is what keeps the rest of the suite reading English.
    assert page.evaluate("window.__game.language()") == "en"
    assert page.evaluate("window.__game.storedLanguage()") == "en", \
        "detection must WRITE its result, so it never runs a second time"
    assert page.evaluate("document.documentElement.lang") == "en"

    # <html lang> must carry a VALID BCP-47 tag, not the game's internal code:
    # `jp` and `in` are not real tags (`in` is in fact the legacy code for
    # Indonesian, the opposite of what this game means by it), and a wrong
    # lang skews the browser's font matching.
    for code, tag in [("en", "en"), ("ru", "ru"), ("de", "de"),
                      ("jp", "ja"), ("in", "hi"),
                      ("zh", "zh-Hans"), ("zh-tw", "zh-Hant")]:
        assert page.evaluate("(c) => window.__game.languageTag(c)", code) == tag, (code, tag)

    # ---- 4) the stored choice wins --------------------------------------
    # A device set to German boots into German — once.
    de_page = new_page(locale="de-AT")
    de_page.goto(f"{BASE}/index.html")
    de_page.evaluate("() => localStorage.clear()")
    de_page.reload()
    de_page.wait_for_function("window.__game && window.__game.language", timeout=60000)
    time.sleep(0.5)
    assert de_page.evaluate("window.__game.detectLanguage()") == "de"
    assert de_page.evaluate("window.__game.language()") == "de", "de-AT must boot German"
    assert de_page.evaluate("window.__game.storedLanguage()") == "de"
    # The detected choice lands on the namespaced key, and the legacy
    # unprefixed one is never written.
    assert de_page.evaluate("() => localStorage.getItem('tm3.language')") == "de"
    assert de_page.evaluate("() => localStorage.getItem('ck_language')") is None
    assert de_page.evaluate("window.__game.lobby.title.text") == tables["de"]["game_title"]
    print("DETECTED de-AT ->", de_page.evaluate("window.__game.lobby.title.text"))

    # …and from then on the STORED value wins, whatever the device says. This
    # browser still reports de-AT, but the game comes up in Russian.
    de_page.evaluate("() => localStorage.setItem('tm3.language', 'ru')")
    de_page.reload()
    de_page.wait_for_function("window.__game && window.__game.language", timeout=60000)
    time.sleep(0.5)
    assert de_page.evaluate("window.__game.detectLanguage()") == "de", \
        "the device still says German"
    assert de_page.evaluate("window.__game.language()") == "ru", \
        "the stored choice must win over the device language"

    # A code the game doesn't recognise is silently treated as English.
    de_page.evaluate("() => localStorage.setItem('tm3.language', 'klingon')")
    de_page.reload()
    de_page.wait_for_function("window.__game && window.__game.language", timeout=60000)
    time.sleep(0.5)
    assert de_page.evaluate("window.__game.language()") == "en", "unknown code -> English"
    de_page.context.close()
    print("STORED CHOICE OK -> written once, then it wins; unknown code -> English")

    # ---- 5) every screen resolves --------------------------------------
    # Get onto the lobby past every feature gate (a fresh profile is routed
    # into level 1 instead, and Tasks needs level 9 cleared).
    page.evaluate("window.__game.completeLevel(9); window.__game.flushSave();")
    page.reload()
    boot()
    page.evaluate("window.__game.markBoosterCoached('all')")
    assert page.evaluate("window.__game.inLobby()") is True

    # Walk every screen and assert not one key came back missing. This is the
    # route-agnostic half of the coverage check: it does not care whether a
    # label got its key from the layout, from game logic or from a config
    # table — if the key is not in the language file, the raw key goes on
    # screen and it is recorded here.
    page.evaluate("window.__game.clearMissingKeys()")
    page.evaluate("""async () => {
            const g = window.__game;
            g.openSettings();            g.settings._back();
            g.openLanguagePicker();      g.closeLanguagePicker();
            g.openShop();                g.closeShop();
            g.openWheel();
            g.openDailyBonus();
            g.openTasks();
            g.setTasksTab('weekly');
            g.setTasksTab('achievements');
            g.closeTasks();
        }""")
    time.sleep(0.6)
    page.evaluate("async () => { await window.__game.startLevel(2); "
                  "window.__game.closeTutorial(); }")
    time.sleep(0.7)
    for kind in ("undo", "shuffle", "wand"):
        page.evaluate("(k) => window.__game.pressBooster(k)", kind)
        time.sleep(0.15)
    missing = page.evaluate("window.__game.missingKeys()")
    print("MISSING AFTER WALKING EVERY SCREEN ->", missing)
    assert missing == [], ("a screen reached for a key no language file has", missing)
    page.evaluate("window.__game.exitLevel()")
    time.sleep(0.5)

    # ---- 6) the live swap -----------------------------------------------
    assert page.evaluate("window.__game.inLobby()") is True
    page.evaluate("() => { window.__noReload = true; }")

    before = page.evaluate("""() => ({
            title: window.__game.lobby.title.text,
            play: window.__game.lobby.playBtn.label.text,
            level: window.__game.currentLevel(),
            coins: window.__game.balance('coins'),
        })""")
    print("BEFORE ->", before)
    assert before["title"] == EN["game_title"]
    page.screenshot(path=f"{OUT}/i18n_lobby_en.png")

    swapped = page.evaluate("async () => await window.__game.setLanguage('ru')")
    time.sleep(0.4)
    assert swapped is True, "setLanguage must report the swap happened"
    after = page.evaluate("""() => ({
            title: window.__game.lobby.title.text,
            play: window.__game.lobby.playBtn.label.text,
            level: window.__game.currentLevel(),
            coins: window.__game.balance('coins'),
            lang: window.__game.language(),
            stored: window.__game.storedLanguage(),
            html: document.documentElement.lang,
            alive: !!window.__noReload,
        })""")
    print("AFTER  ->", after)
    RU = tables["ru"]
    assert after["lang"] == "ru" and after["stored"] == "ru", after
    assert after["html"] == "ru", after
    assert after["alive"] is True, "the swap must not reload the page"
    assert after["level"] == before["level"] and after["coins"] == before["coins"], \
        "changing language must not touch progress"
    assert after["title"] == RU["game_title"], (after["title"], RU["game_title"])
    assert after["title"] != before["title"], "the lobby title did not re-letter"
    # The play button is assembled in code — "Level {0}" with the level in it.
    assert after["play"] == RU["Language1"].replace("{0}", str(after["level"])), after
    page.screenshot(path=f"{OUT}/i18n_lobby_ru.png")

    # A screen that was NOT open re-letters too, and reads correctly the next
    # time it is opened.
    page.evaluate("window.__game.openSettings()")
    time.sleep(0.3)
    row = page.evaluate("window.__game.languageRowText()")
    print("SETTINGS ROW ->", row)
    assert row["label"] == RU["language"], row
    assert row["value"] == "Русский", ("the language's own name is never translated", row)
    page.screenshot(path=f"{OUT}/i18n_settings_ru.png")
    page.evaluate("window.__game.settings._back()")
    time.sleep(0.2)

    # Text assembled inside a level re-letters in place as well.
    page.evaluate("async () => { await window.__game.startLevel(2); "
                  "window.__game.closeTutorial(); }")
    time.sleep(0.7)
    assert page.evaluate("window.__game.scene.levelText.text") == \
        RU["hud_level"].replace("{0}", "2")
    page.evaluate("async () => await window.__game.setLanguage('jp')")
    time.sleep(0.4)
    JP = tables["jp"]
    hud = page.evaluate("window.__game.scene.levelText.text")
    print("IN-LEVEL HUD (jp) ->", hud)
    assert hud == JP["hud_level"].replace("{0}", "2"), hud
    # …and the DOM carries `ja`, the real tag for the game's internal `jp`.
    assert page.evaluate("document.documentElement.lang") == "ja", \
        page.evaluate("document.documentElement.lang")
    page.screenshot(path=f"{OUT}/i18n_level_jp.png")

    # The placeholder rules, driven through the live lookup.
    assert page.evaluate("window.__game.t('Language1', 7)") == \
        JP["Language1"].replace("{0}", "7")
    assert page.evaluate("window.__game.t('title_task_1', 12)") == \
        JP["title_task_1"].replace("%value", "12")
    assert page.evaluate("window.__game.t('reset_in_dh', 2, 14)") == \
        JP["reset_in_dh"].replace("{0}", "2").replace("{1}", "14")
    # A string with no placeholder is returned untouched, extra values or not.
    assert page.evaluate("window.__game.t('claim', 5)") == JP["claim"]

    # ---- 7) the rough edges ---------------------------------------------
    # A MISSING KEY DISPLAYS THE KEY ITSELF — there is no fallback to English.
    for key in ("bonus_desc4", "level_up_desc", "level_down_desc"):
        assert page.evaluate("(k) => window.__game.hasKey(k)", key) is False, key
        assert page.evaluate("(k) => window.__game.t(k)", key) == key, key
    print("MISSING KEY OK -> the label shows the key")

    # A FAILED DOWNLOAD STILL COUNTS AS A CHOICE: the text on screen stays as
    # it was, but the new language is written to storage, so the next launch
    # comes up in it (or fails to, again).
    # Aborting the request makes the browser log a net::ERR_FAILED of its
    # own. That is the condition under test, not a fault — so remember how
    # many errors were legitimate up to here and ignore the induced one.
    expected_errors = len(errors) + 1
    page.route("**/assets/lang/it.json", lambda route: route.abort())
    held = page.evaluate("window.__game.scene.levelText.text")
    ok = page.evaluate("async () => await window.__game.setLanguage('it')")
    time.sleep(0.3)
    state = page.evaluate("""() => ({
            lang: window.__game.language(),
            stored: window.__game.storedLanguage(),
            hud: window.__game.scene.levelText.text,
        })""")
    print("FAILED DOWNLOAD ->", ok, state)
    assert ok is False, "a failed download is not a swap"
    assert state["lang"] == "jp" and state["hud"] == held, \
        "the on-screen text must stay as it was"
    assert state["stored"] == "it", \
        "the choice is remembered even though the download failed"
    page.unroute("**/assets/lang/it.json")

    # NOTHING EVER UNLOADS A LANGUAGE: every one visited this session stays
    # resident. The release path exists but is not on any code path.
    page.evaluate("async () => { await window.__game.setLanguage('de'); "
                  "await window.__game.setLanguage('ko'); }")
    time.sleep(0.4)
    loaded = page.evaluate("window.__game.loadedLanguages()")
    print("RESIDENT ->", loaded)
    assert set(loaded) >= {"en", "ru", "jp", "de", "ko"}, loaded

    # Re-picking the language already in use is a no-op.
    assert page.evaluate("async () => await window.__game.setLanguage('ko')") is False

    # The choice survives a reload, with progress intact.
    page.evaluate("window.__game.flushSave()")
    page.reload()
    boot()
    assert page.evaluate("window.__game.language()") == "ko"
    assert page.evaluate("window.__game.lobby.title.text") == tables["ko"]["game_title"]
    assert page.evaluate("window.__game.user().progress.completed") == 9, \
        "progress must survive every language change"
    print("RELOAD OK -> came back in", page.evaluate("window.__game.language()"))

    print("PAGE ERRORS:", len(errors), errors[:5])
    # Everything except the one net::ERR_FAILED the aborted fetch above
    # necessarily produces.
    unexpected = [e for e in errors if "ERR_FAILED" not in e]
    assert not unexpected, ("console errors during the localization checks",
                            unexpected)
    assert len(errors) <= expected_errors, ("more failed requests than the one "
                                            "the test induced", errors)
    print("ALL LOCALIZATION CHECKS PASSED")
    browser.close()