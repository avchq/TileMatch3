// Platform-agnostic player model: identity, progress, a multi-currency wallet,
// and client settings (music / sound). Pure data + typed accessors — NO I/O.
// Persistence lives in UserStore + the storage adapters; this class only emits a
// domain-tagged change event whenever it is mutated, so the store can autosave
// and UI can react live (mirrors audio.js's onMusicChange/onSoundChange callbacks).

export const SCHEMA_VERSION = 3;

// Known virtual currencies. The wallet is a keyed map, so adding a currency is
// just a new code here (or even an arbitrary code passed to credit/debit) — no
// other code change is required.
export const CURRENCIES = ["coins", "gems"];

// In-game helpers ("boosters") the player can spend during a level. Like the
// wallet, the inventory is a keyed map, so adding a helper is just a new code
// here — no other model change is required. New players get a small starter
// stock so the helpers are usable out of the box; once a helper hits 0 it is
// shown disabled until the player earns/buys more.
export const BOOSTERS = ["undo", "shuffle", "wand"];
const STARTER_BOOSTERS = { undo: 3, shuffle: 3, wand: 3 };

const defaults = () => ({
  version: SCHEMA_VERSION,
  id: "",
  platform: "web",
  name: "",
  progress: { level: 1 },        // next level to play (room to grow: stars, completed[]…)
  wallet: { coins: 0, gems: 0 }, // currency code -> balance
  boosters: { ...STARTER_BOOSTERS }, // helper code -> remaining uses
  settings: { music: true, sound: true },
  // Fortune Wheel per-cycle state (see src/fortunewheel.js). group: active prize
  // group (1-based; 0 = never cycled). day: the day-key (YYYY-MM-DD) of the
  // current cycle — a change of calendar day rolls the cycle over. spinsUsed:
  // spins taken this cycle (the 1st is free, the rest cost an ad). won: slice
  // indices already won this cycle (a prize can only be won once). seen: the
  // wheel has been opened at least once (clears the "new" badge, forever).
  fortuneWheel: { group: 0, day: "", spinsUsed: 0, won: [], seen: false },
  // Daily Bonus state (see src/dailybonus.js). The feature is a free once-a-day
  // gift, NOT a streak — so the ONLY thing stored is lastClaimDay: the day-key
  // (YYYY-MM-DD) of the most recent claim. "Has the calendar date changed since
  // then?" is the whole eligibility check; "" means never claimed.
  dailyBonus: { lastClaimDay: "" },
});

export class User {
  constructor(data = {}) {
    const d = defaults();
    this.version = SCHEMA_VERSION;
    this.id = data.id ?? d.id;
    this.platform = data.platform ?? d.platform;
    this.name = data.name ?? d.name;
    // shallow-merge each sub-object over defaults so missing fields are filled
    this.progress = { ...d.progress, ...(data.progress || {}) };
    this.wallet = { ...d.wallet, ...(data.wallet || {}) };
    this.boosters = { ...d.boosters, ...(data.boosters || {}) };
    this.settings = { ...d.settings, ...(data.settings || {}) };
    this.fortuneWheel = { ...d.fortuneWheel, ...(data.fortuneWheel || {}) };
    this.dailyBonus = { ...d.dailyBonus, ...(data.dailyBonus || {}) };
    this._listeners = new Set();
  }

  // ---- change events -------------------------------------------------------
  /** Subscribe. Callback is fn(domain, user) where domain ∈ progress|wallet|boosters|settings|fortuneWheel|dailyBonus.
   *  Returns an unsubscribe function. */
  on(fn) { this._listeners.add(fn); return () => this._listeners.delete(fn); }
  off(fn) { this._listeners.delete(fn); }
  _emit(domain) {
    for (const fn of this._listeners) { try { fn(domain, this); } catch (_) {} }
  }

  // ---- progress ------------------------------------------------------------
  get level() { return this.progress.level; }
  setLevel(n) {
    const v = Math.max(1, Math.floor(n) || 1);
    if (v === this.progress.level) return;
    this.progress.level = v;
    this._emit("progress");
  }

  // ---- wallet (currency-agnostic) -----------------------------------------
  balance(cur) { return this.wallet[cur] || 0; }
  canAfford(cur, amount) { return this.balance(cur) >= amount; }
  /** Add funds. Returns the new balance. */
  credit(cur, amount) {
    const n = Math.max(0, Math.floor(amount) || 0);
    if (!n) return this.balance(cur);
    this.wallet[cur] = this.balance(cur) + n;
    this._emit("wallet");
    return this.wallet[cur];
  }
  /** Spend funds. Returns false (and changes nothing) if the balance is insufficient. */
  debit(cur, amount) {
    const n = Math.max(0, Math.floor(amount) || 0);
    if (!this.canAfford(cur, n)) return false;
    this.wallet[cur] = this.balance(cur) - n;
    this._emit("wallet");
    return true;
  }

  // ---- boosters (helper inventory, code-agnostic) -------------------------
  /** Remaining uses of a helper (0 if unknown/empty). */
  boosterCount(kind) { return this.boosters[kind] || 0; }
  hasBooster(kind) { return this.boosterCount(kind) > 0; }
  /** Add helper uses. Returns the new count. */
  grantBooster(kind, amount = 1) {
    const n = Math.max(0, Math.floor(amount) || 0);
    if (!n) return this.boosterCount(kind);
    this.boosters[kind] = this.boosterCount(kind) + n;
    this._emit("boosters");
    return this.boosters[kind];
  }
  /** Consume one use of a helper. Returns false (changing nothing) if the
   *  inventory is empty, so callers can gate the helper on the return value. */
  useBooster(kind) {
    if (!this.hasBooster(kind)) return false;
    this.boosters[kind] = this.boosterCount(kind) - 1;
    this._emit("boosters");
    return true;
  }

  // ---- fortune wheel (daily prize wheel per-cycle state) --------------------
  wheelGroup() { return this.fortuneWheel.group || 0; }
  wheelDay() { return this.fortuneWheel.day || ""; }
  wheelSpinsUsed() { return this.fortuneWheel.spinsUsed || 0; }
  /** Slice indices already won this cycle (a copy — callers must not mutate). */
  wheelWon() { return (this.fortuneWheel.won || []).slice(); }
  wheelSeen() { return !!this.fortuneWheel.seen; }
  /** Roll the wheel to a new daily cycle: advance to the next prize group
   *  (wrapping after the last), stamp the new day-key, and clear the per-cycle
   *  spin count + won list. Called on the first check after the calendar day
   *  changes (and on the very first open, from group 0 → 1). */
  advanceWheelCycle(dayKey, groupCount) {
    const n = Math.max(1, Math.floor(groupCount) || 1);
    let g = (this.fortuneWheel.group || 0) + 1;
    if (g > n) g = 1;
    this.fortuneWheel.group = g;
    this.fortuneWheel.day = String(dayKey || "");
    this.fortuneWheel.spinsUsed = 0;
    this.fortuneWheel.won = [];
    this._emit("fortuneWheel");
  }
  /** Record one spin: bump the spin count and mark the slice index as won.
   *  Recorded before the wheel animates, so a rapid double-tap can't spend two
   *  spins and a won prize can't be won again. */
  recordWheelSpin(index) {
    this.fortuneWheel.spinsUsed = (this.fortuneWheel.spinsUsed || 0) + 1;
    if (!this.fortuneWheel.won) this.fortuneWheel.won = [];
    this.fortuneWheel.won.push(Math.floor(index));
    this._emit("fortuneWheel");
  }
  /** Mark the wheel as opened at least once (drops the lobby "new" badge). */
  markWheelSeen() {
    if (this.fortuneWheel.seen) return;
    this.fortuneWheel.seen = true;
    this._emit("fortuneWheel");
  }

  // ---- daily bonus (free once-a-day gift) ----------------------------------
  /** Day-key (YYYY-MM-DD) of the most recent claim, "" if never claimed. */
  dailyBonusLastDay() { return this.dailyBonus.lastClaimDay || ""; }
  /** Record a claim by stamping today's day-key — the single value that drives
   *  eligibility ("has the date changed since this?"). Called the moment the
   *  player opens a box, so today's gift can't be re-rolled or claimed twice. */
  recordDailyClaim(dayKey) {
    const v = String(dayKey || "");
    if (v === this.dailyBonus.lastClaimDay) return;
    this.dailyBonus.lastClaimDay = v;
    this._emit("dailyBonus");
  }

  // ---- settings ------------------------------------------------------------
  get music() { return this.settings.music; }
  get sound() { return this.settings.sound; }
  setMusic(on) {
    const v = !!on;
    if (v === this.settings.music) return;
    this.settings.music = v;
    this._emit("settings");
  }
  setSound(on) {
    const v = !!on;
    if (v === this.settings.sound) return;
    this.settings.sound = v;
    this._emit("settings");
  }

  // ---- reset ---------------------------------------------------------------
  /** Wipe progress / wallet / settings back to defaults, KEEPING identity
   *  (id / platform / name). Mutates in place so existing references and
   *  listeners stay valid, and emits a change in every domain so the store
   *  autosaves and any UI updates. */
  reset() {
    const d = defaults();
    this.progress = { ...d.progress };
    this.wallet = { ...d.wallet };
    this.boosters = { ...d.boosters };
    this.settings = { ...d.settings };
    this.fortuneWheel = { ...d.fortuneWheel };
    this.dailyBonus = { ...d.dailyBonus };
    this._emit("progress");
    this._emit("wallet");
    this._emit("boosters");
    this._emit("settings");
    this._emit("fortuneWheel");
    this._emit("dailyBonus");
  }

  // ---- serialization -------------------------------------------------------
  toJSON() {
    return {
      version: this.version,
      id: this.id,
      platform: this.platform,
      name: this.name,
      progress: { ...this.progress },
      wallet: { ...this.wallet },
      boosters: { ...this.boosters },
      settings: { ...this.settings },
      fortuneWheel: { ...this.fortuneWheel, won: (this.fortuneWheel.won || []).slice() },
      dailyBonus: { ...this.dailyBonus },
    };
  }

  static fromJSON(obj) { return new User(User.migrate(obj || {})); }

  /** Upgrade an older persisted blob to the current schema shape before load. */
  static migrate(obj) {
    const o = { ...obj };
    if (!o.version) o.version = 1; // v0/undefined -> v1 (no structural change)
    // v1 -> v2: adds the fortuneWheel sub-object. The constructor shallow-merges
    // it from defaults(), so no field transform is needed here — just stamp it.
    if (o.version === 1) o.version = 2;
    // v2 -> v3: adds the dailyBonus sub-object. Like v1->v2, the constructor
    // shallow-merges it from defaults(), so just stamp the version.
    if (o.version === 2) o.version = 3;
    return o;
  }
}
