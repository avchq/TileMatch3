// ============================================================================
//  LOCALIZATION — the game's 13 languages
// ============================================================================
//
//  Every piece of user-visible text in the game is a KEY that is looked up in
//  the active language's string table. The tables are plain JSON, one file per
//  locale, under the folder named by `CONFIG.language.textDir`; only the file
//  for the active language is ever fetched.
//
//  Three routes reach the same table (see README "Localization"):
//    1. BAKED IN  — a label is created with `bindText()` / `locText()` and
//       carries its key, so it re-letters itself whenever the language changes.
//    2. LOOKED UP — anything assembled at runtime ("Level 12", "2d 14h") calls
//       `t(key, ...values)` and stitches the result together in code.
//    3. NAMED BY A CONFIG TABLE — the JSON data tables under assets/config/
//       store a text KEY rather than the text itself, so the same table row
//       reads correctly in every language.
//
//  A key that is missing from the active language DISPLAYS THE KEY ITSELF.
//  There is no fallback to English: every key must exist in all 13 files, and
//  tests/i18n_test.py enforces that.
// ============================================================================

import { CONFIG } from "./config.js";

// The browser-storage key holding the player's choice, namespaced like every
// other key the game writes (`tm3.uid`, `tm3.user`, `tm3.tutorialDone`).
// Setting it by hand before loading the page is how you start the game in
// another language.
export const STORAGE_KEY = "tm3.language";

// --------------------------------------------------------------------------
//  Reading the config — defensively, on purpose
// --------------------------------------------------------------------------
//  This module builds its singleton at IMPORT time (see `i18n` at the bottom),
//  so reaching into `CONFIG.language.x` directly would throw during module
//  EVALUATION if the config were ever missing or stale — and a throw there kills
//  the whole module graph before boot() can run, leaving the splash frozen at
//  "Starting up… 0%" with nothing able to report why. That is not theoretical:
//  it is exactly how a phone holding an older src/config.js in its module cache
//  broke, while the desktop that fetched everything fresh was fine.
//
//  src/config.js remains the single source of truth. The values below are a
//  last-ditch floor for a broken load, NOT a second place to tune them — change
//  a default in config.js, and tests/config_test.py asserts the real values.
const LANG_DEFAULTS = { defaultLanguage: "en", textDir: "assets/lang" };

function langCfg() {
  const c = (typeof CONFIG === "object" && CONFIG && CONFIG.language) || {};
  return {
    defaultLanguage: c.defaultLanguage || LANG_DEFAULTS.defaultLanguage,
    textDir: c.textDir || LANG_DEFAULTS.textDir,
  };
}

// How long to wait for a language table before giving up on it. A robustness
// constant rather than a tuning knob, so it lives here beside the fetch. It
// exists because i18n.init() is the FIRST await in boot(), ahead of the
// renderer: an un-timed fetch that never settles would freeze the game at 0%
// with no canvas and no diagnostics. On a timeout the load simply fails and
// init() falls through to the default table.
const LOAD_TIMEOUT_MS = 8000;

// --------------------------------------------------------------------------
//  The offered languages — HARD-CODED, in the order the picker lists them.
// --------------------------------------------------------------------------
//  This list is the program's, not data: adding a language means three edits,
//  not one — a new translated text file, an entry HERE, and a new case in the
//  device-language detection below. Otherwise the language exists but nothing
//  can reach it.
//
//  Two of the codes are traps for the unwary:
//    * `in` is HINDI, not Indonesian — Indonesian is `id`.
//    * `jp` is used where the standard code would be `ja`.
//  Both are the game's own invention and appear everywhere, including in the
//  folder names of the translated artwork.
//
//  `label` is NOT translated. Each language is written in its own language (or
//  in English, for the Asian ones), so a Russian player browsing the picker
//  sees "Chinese", "English", "Deutsch", "Русский", "Traditional Chinese".
export const LANGUAGES = Object.freeze([
  { code: "zh", label: "Chinese" },              // Simplified
  { code: "zh-tw", label: "Traditional Chinese" },
  { code: "en", label: "English" },
  { code: "id", label: "Bahasa Indonesia" },
  { code: "de", label: "Deutsch" },
  { code: "es", label: "Español" },
  { code: "fr", label: "Français" },
  { code: "in", label: "Hindi" },                // the code is `in`, the language is Hindi
  { code: "it", label: "Italiano" },
  { code: "jp", label: "Japanese" },             // not `ja`
  { code: "ko", label: "Korean" },
  { code: "ru", label: "Русский" },
  { code: "pt", label: "Português" },
].map(Object.freeze));

/** The 13 offered codes, in picker order. */
export const LANGUAGE_CODES = Object.freeze(LANGUAGES.map((l) => l.code));

/** True if `code` is one of the 13 the game offers. */
export function isSupported(code) {
  return LANGUAGE_CODES.indexOf(String(code || "").toLowerCase()) >= 0;
}

// The game's internal codes are not all valid BCP-47: `jp` should be `ja`, and
// `in` is actually the legacy code for INDONESIAN — the opposite of what this
// game means by it. They are fine as internal identifiers, but writing one into
// `<html lang>` mislabels the document and skews the browser's font matching,
// which bites hardest on mobile. Map to a real tag for the DOM only; every other
// use of a code stays exactly as it is.
const BCP47 = { jp: "ja", in: "hi", zh: "zh-Hans", "zh-tw": "zh-Hant" };

/** A code as a valid BCP-47 tag, for `<html lang>`. */
export function bcp47(code) {
  return BCP47[code] || String(code || langCfg().defaultLanguage);
}

/** The picker label for a code ("Русский" for `ru`), or the code itself. */
export function languageLabel(code) {
  const e = LANGUAGES.find((l) => l.code === code);
  return e ? e.label : String(code || "");
}

// --------------------------------------------------------------------------
//  Device-language detection — runs EXACTLY ONCE, on a brand-new player
// --------------------------------------------------------------------------
//  The mapping is generous about regional variants: every flavour of Spanish
//  lands on `es`, Austrian/Swiss/Liechtenstein German on `de`, and so on.
//  ANYTHING UNRECOGNISED BECOMES ENGLISH.
//
//  Exact BCP-47 tags first, so the regional splits (zh-HK vs zh-CN, en-IN vs
//  en-ID vs plain en) can disagree with their base language.
const EXACT_TAGS = {
  // Chinese splits: mainland + Singapore are Simplified; HK/Macau/Taiwan are Traditional.
  "zh-cn": "zh", "zh-sg": "zh", "zh-hans": "zh",
  "zh-tw": "zh-tw", "zh-hk": "zh-tw", "zh-mo": "zh-tw", "zh-hant": "zh-tw",
  // English by region: an Indian device gets Hindi, an Indonesian one Indonesian.
  "en-in": "in", "en-id": "id",
  // German-speaking neighbours.
  "de-at": "de", "de-ch": "de", "de-li": "de",
  // Spanish, everywhere it is spoken.
  "es-es": "es", "es-419": "es", "es-ar": "es", "es-mx": "es",
  "es-co": "es", "es-pr": "es", "es-us": "es",
  // French-speaking neighbours.
  "fr-be": "fr", "fr-ch": "fr", "fr-lu": "fr",
};

//  …then the base language, for any tag the table above does not name.
const BASE_LANGS = {
  zh: "zh",     // bare `zh` is Simplified
  en: "en",
  id: "id",     // Indonesian — NOT `in`
  de: "de",
  es: "es",
  fr: "fr",
  hi: "in",     // Hindi — the game's code for it is `in`
  it: "it",
  ja: "jp",     // the game's code is `jp`, not `ja`
  ko: "ko",
  ru: "ru",
  pt: "pt",
};

/**
 * Map one BCP-47 tag ("de-AT", "zh-Hant-TW", "hi") onto one of the 13 codes,
 * or `null` if it is not one the game recognises.
 */
export function mapTag(tag) {
  const t = String(tag || "").toLowerCase().replace(/_/g, "-");
  if (!t) return null;
  if (EXACT_TAGS[t]) return EXACT_TAGS[t];
  // "zh-Hant-TW" → try "zh-tw" (base + region) before falling back to "zh".
  const parts = t.split("-");
  if (parts.length > 2) {
    const short = parts[0] + "-" + parts[parts.length - 1];
    if (EXACT_TAGS[short]) return EXACT_TAGS[short];
  }
  return BASE_LANGS[parts[0]] || null;
}

/**
 * Ask the DEVICE what language it is set to and map it onto one of the 13.
 *
 * This is the BROWSER/DEVICE language, not the Facebook account language — on
 * Instant Games the two normally agree, but they are not the same signal and
 * the Facebook locale is never consulted.
 */
export function detectLanguage(nav) {
  const n = nav || (typeof navigator !== "undefined" ? navigator : null);
  const tags = [];
  if (n) {
    if (Array.isArray(n.languages)) tags.push(...n.languages);
    if (n.language) tags.push(n.language);
  }
  for (const tag of tags) {
    const code = mapTag(tag);
    if (code) return code;
  }
  return langCfg().defaultLanguage;
}

// --------------------------------------------------------------------------
//  Placeholders — a plain find-and-replace, no formatting system
// --------------------------------------------------------------------------
//  Two styles, depending on which developer wrote the string:
//    `%value`   for anything counted   — "Complete %value levels"
//    `{0}` `{1}` for levels and ranges — "Level {0}", "{0} to {1}"
//
//  Because the substitution is a plain FIRST-MATCH replace, EACH PLACEHOLDER
//  MAY APPEAR ONLY ONCE PER STRING. A translator who repeats `%value` for
//  emphasis gets the first one filled and the second left as literal text.
//  `{0}` and `{1}` are substituted one after another, so they must stay
//  distinct tokens and cannot be collapsed into each other.
function fill(str, values) {
  if (!values || !values.length) return str;
  let out = str;
  // `%value` takes the FIRST argument. String#replace with a string pattern
  // replaces one occurrence — that is the documented limit, not an oversight.
  if (out.indexOf("%value") >= 0) out = out.replace("%value", String(values[0]));
  for (let i = 0; i < values.length; i++) {
    out = out.replace("{" + i + "}", String(values[i]));
  }
  return out;
}

// --------------------------------------------------------------------------
//  The live localization state
// --------------------------------------------------------------------------

class I18n {
  constructor() {
    this.code = langCfg().defaultLanguage;
    this.ready = false;
    // Every language visited this session stays resident: switching back and
    // forth is instant and a table is a few tens of kilobytes. `unload()`
    // releases one when that ever stops being true.
    this._tables = Object.create(null);
    this._listeners = new Set();
    // Labels created through bindText(): { target, key, values }. Pruned of
    // destroyed display objects on every re-letter.
    this._bound = [];
    // Every key that was looked up and NOT found, in the order first seen. A
    // miss is not an error — the key itself goes on screen — so this is the only
    // record of one. tests/i18n_test.py walks every screen and asserts it is
    // empty, which catches a typo'd key whatever route reached the table.
    this._missing = [];
  }

  // ---- reading ----------------------------------------------------------

  /** The active language's flat key → string table (empty before init). */
  get table() { return this._tables[this.code] || {}; }

  /** True if `key` exists in the ACTIVE language. */
  has(key) { return Object.prototype.hasOwnProperty.call(this.table, key); }

  /**
   * Look up `key` and fill its placeholders.
   *
   * A key that is missing from the active language RETURNS THE KEY ITSELF —
   * the string shows up on screen as e.g. `bonus_desc4`, which is how a
   * missing translation is meant to be noticed rather than silently papered
   * over with English.
   */
  t(key, ...values) {
    const raw = this.table[key];
    if (typeof raw !== "string") {
      const k = String(key);
      if (this._missing.indexOf(k) < 0) this._missing.push(k);
      return k;
    }
    return fill(raw, values);
  }

  /** Keys looked up this session that the active language does not have. */
  missingKeys() { return this._missing.slice(); }

  /** Forget the misses recorded so far (test seam). */
  clearMissing() { this._missing.length = 0; }

  // ---- loading ----------------------------------------------------------

  /** The URL of a language's string table. */
  fileUrl(code) {
    return `${langCfg().textDir}/${code}.json`;
  }

  /**
   * Fetch and cache one language's table. Idempotent and de-duplicated: an
   * already-resident language resolves immediately, so re-picking a language
   * visited earlier this session costs no request.
   */
  async load(code) {
    if (this._tables[code]) return this._tables[code];
    // Bounded: see LOAD_TIMEOUT_MS. A request that never settles must not be
    // able to hold boot open forever.
    const ctrl = typeof AbortController === "function" ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), LOAD_TIMEOUT_MS) : 0;
    let res;
    try {
      res = await fetch(this.fileUrl(code), ctrl ? { signal: ctrl.signal } : undefined);
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (!res.ok) throw new Error(`language ${code}: HTTP ${res.status}`);
    const table = await res.json();
    if (!table || typeof table !== "object") throw new Error(`language ${code}: not a table`);
    this._tables[code] = table;
    return table;
  }

  /** Release a resident language. Nothing calls this — see the note above. */
  unload(code) {
    if (code === this.code) return false;
    if (!this._tables[code]) return false;
    delete this._tables[code];
    return true;
  }

  /** The codes resident in memory right now (test seam). */
  loaded() { return Object.keys(this._tables); }

  // ---- the stored choice ------------------------------------------------

  /** The raw stored choice, or null if the player has never had one. */
  stored() {
    try { return localStorage.getItem(STORAGE_KEY); } catch (_) { return null; }
  }

  _store(code) {
    try { localStorage.setItem(STORAGE_KEY, code); } catch (_) {}
  }

  /**
   * Decide the boot language and load it. Called once, early in boot(),
   * before any scene is built.
   *
   * DETECTION RUNS EXACTLY ONCE. On a brand-new player the device language is
   * mapped onto one of the 13 and written to storage; from then on the stored
   * value wins, so changing the device language later has no effect — the
   * player must change it in-game.
   */
  async init() {
    const saved = this.stored();
    let code;
    if (saved && isSupported(saved)) {
      code = saved;
    } else {
      if (saved) {
        console.warn(`[i18n] unknown stored language "${saved}" — using ` +
                     `${langCfg().defaultLanguage}`);
        code = langCfg().defaultLanguage;
      } else {
        code = detectLanguage();
      }
      this._store(code);
    }
    this.code = code;
    try {
      await this.load(code);
    } catch (err) {
      // Boot must not die on a missing translation. Fall back to the default
      // language's table so the game is at least readable.
      console.warn(`[i18n] could not load "${code}":`, err && err.message);
      const fallback = langCfg().defaultLanguage;
      if (code !== fallback) {
        try { await this.load(fallback); this.code = fallback; } catch (_) {}
      }
    }
    this.ready = true;
    return this.code;
  }

  /**
   * Change language — what the picker's Confirm does.
   *
   * Picking the language already in use is a no-op. Otherwise the new table is
   * downloaded, swapped in, every bound label re-lettered and every listener
   * told to refresh, and the choice remembered.
   *
   * A FAILED DOWNLOAD STILL COUNTS AS A CHOICE: the on-screen text stays as it
   * was, but the new language is written to storage, so the next launch comes
   * up in it (or fails to, again). Returns true if the swap happened.
   */
  async setLanguage(code) {
    if (!isSupported(code)) {
      console.warn(`[i18n] unknown language "${code}" — using ` +
                   `${langCfg().defaultLanguage}`);
      code = langCfg().defaultLanguage;
    }
    if (code === this.code) return false;
    let ok = true;
    try {
      await this.load(code);
    } catch (err) {
      console.warn(`[i18n] could not load "${code}":`, err && err.message);
      ok = false;
    }
    this._store(code); // the choice is remembered either way
    if (!ok) return false;
    this.code = code;
    this.refresh();
    return true;
  }

  // ---- re-lettering -----------------------------------------------------

  /**
   * Tie a PIXI.Text to a key: it is filled in now and re-lettered on every
   * language change, for as long as the display object lives. This is route 1
   * — "baked into the screen layout".
   */
  bindText(target, key, ...values) {
    target.text = this.t(key, ...values);
    target.__i18nKey = key;
    this._bound.push({ target, key, values });
    return target;
  }

  /** Re-point an already-bound label at a different key (or new values). */
  rebindText(target, key, ...values) {
    const entry = this._bound.find((b) => b.target === target);
    if (entry) { entry.key = key; entry.values = values; }
    else this._bound.push({ target, key, values });
    target.text = this.t(key, ...values);
    target.__i18nKey = key;
    return target;
  }

  /**
   * Subscribe to language changes. Scenes that assemble text in code (route 2)
   * register a `relocalize()` here, the same way they take a `layout()` on
   * resize. Returns an unsubscribe function.
   */
  onChange(fn) {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  /**
   * Re-letter everything: every bound label, then every listener. Screens that
   * are not currently visible re-letter themselves the next time they are
   * opened, so the swap is seamless either way.
   */
  refresh() {
    this._bound = this._bound.filter((b) => !b.target.destroyed);
    for (const b of this._bound) b.target.text = this.t(b.key, ...b.values);
    for (const fn of Array.from(this._listeners)) {
      try { fn(this.code); } catch (err) { console.warn("[i18n] listener failed:", err); }
    }
  }

  /** How many live bound labels there are (test seam). */
  boundCount() {
    this._bound = this._bound.filter((b) => !b.target.destroyed);
    return this._bound.length;
  }
}

/** The one live localization state. Import this, don't construct another. */
export const i18n = new I18n();

/** Shorthand for `i18n.t` — the lookup route used all over the scenes. */
export function t(key, ...values) { return i18n.t(key, ...values); }

// --------------------------------------------------------------------------
//  Item vocabulary
// --------------------------------------------------------------------------
//  The word the chest popup, the wheel and the daily gift all show for the same
//  reward type. `coins` and `lightning` both pay out coins, so they share a
//  word. Singular and plural are two separate KEYS rather than an "s" appended
//  in code — most of the 13 languages do not form a plural that way, and
//  several do not distinguish one at all.
const ITEM_KEYS = {
  coins: "coin", lightning: "coin", undo: "undo", wand: "wand", shuffle: "shuffle",
};

/** The localized name of a reward type, for `count` of it. */
export function itemName(type, count) {
  const base = ITEM_KEYS[type];
  if (!base) return String(type); // an unknown reward shows its own code, as before
  return i18n.t(count === 1 ? `item_${base}` : `item_${base}_plural`);
}

/**
 * Create a PIXI.Text already bound to a key (route 1). Everything else about
 * it — style, anchor, position — is the caller's, exactly as before.
 */
export function locText(key, style, ...values) {
  const txt = new PIXI.Text("", style);
  i18n.bindText(txt, key, ...values);
  return txt;
}
