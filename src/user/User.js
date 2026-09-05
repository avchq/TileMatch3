// Platform-agnostic player model: identity, progress, a multi-currency wallet,
// and client settings (music / sound). Pure data + typed accessors — NO I/O.
// Persistence lives in UserStore + the storage adapters; this class only emits a
// domain-tagged change event whenever it is mutated, so the store can autosave
// and UI can react live (mirrors audio.js's onMusicChange/onSoundChange callbacks).

import { CONFIG } from "../config.js";

export const SCHEMA_VERSION = 8;

// Every tunable this model reads — the starting wallet and booster inventory,
// the helper unlock schedule and EVERY feature gate — lives in src/config.js,
// documented there. The tables and levels are pulled out as local aliases so the
// logic below stays readable; config.js remains the only place to EDIT them.
// This model owns all of the gates (the is*Unlocked family), in the one spelling
// config.js's level-convention note documents; no scene re-derives one.
const BOOSTER_UNLOCKS = CONFIG.boosters.unlocks;
const SUPER_WAND = CONFIG.boosters.superWand;
const SHOP_UNLOCK_LEVEL = CONFIG.features.shop.unlockLevel;
const TASKS_UNLOCK_LEVEL = CONFIG.features.tasks.unlockLevel;
const FORTUNE_WHEEL_UNLOCK_LEVEL = CONFIG.features.fortuneWheel.unlockLevel;
const DAILY_BONUS_UNLOCK_LEVEL = CONFIG.features.dailyBonus.unlockLevel;
const TASK_ACTIVITIES = CONFIG.features.tasks.activities;
const EXTRA_SLOT_UNLOCK_LEVEL = CONFIG.board.extraSlot.unlockLevel;

// The wallet / inventory a brand-new account starts with (config.js). Copied on
// every use — CONFIG is frozen, and these become live mutable state.
const startingWallet = () => ({ ...CONFIG.economy.startingWallet });
const startingBoosters = () => ({ ...CONFIG.boosters.startingInventory });

const defaults = () => ({
  version: SCHEMA_VERSION,
  id: "",
  platform: "web",
  name: "",
  // level: next level to play. completed: highest level ever finished (0 = none,
  // i.e. a brand-new player who has never cleared level 1) — the signal the
  // first-run flow gates on (see isNewPlayer). Room to grow: stars, completed[]…
  progress: { level: 1, completed: 0 },
  wallet: startingWallet(),     // currency code -> balance (config.js)
  boosters: startingBoosters(), // helper code -> remaining uses (none to start)
  // Helper codes whose one-time unlock grant has already been paid out. Purely
  // bookkeeping so a grant can't be collected twice — whether a helper is
  // *locked* is derived from progress (see isBoosterUnlocked).
  boosterUnlocks: [],
  // Helper codes whose COACHED FIRST USE has already been played (see
  // CONFIG.boosters.coach and src/boostercoach.js). Same shape and spirit as
  // boosterUnlocks above — a one-time, idempotent record — but a separate list
  // because the two happen at different moments: the grant is paid the instant
  // the gate opens, the lesson waits until the player is actually in a level.
  boosterCoach: [],
  settings: { music: true, sound: true },
  // THE SUPER WAND — the Wand's earned upgrade (see CONFIG.boosters.superWand
  // and src/game.js). Three fields, and no inventory entry: it is not a
  // consumable, so it never appears in `boosters` above.
  //   streak    — consecutive NEW clears banked toward the next charge. While
  //               `charged` is true this is PINNED at streakLength, so the bar on
  //               the level-complete screen (and the lobby rail's pill) reads full
  //               for as long as the streak lives. ACCEPTING A LOSS is the only
  //               thing that empties either field: using a Super Wand takes
  //               nothing away, because the reward is the streak itself. (A sweep
  //               still costs one ordinary WAND use — the streak earns the
  //               upgrade, not free uses.)
  //   charged   — a Super Wand is banked and the Wand's button is upgraded. It
  //               stays upgraded across uses, wins, levels and restarts.
  //   announced — its arrival has already been celebrated on a board. Kept
  //               per-charge rather than per-level so the flourish plays once,
  //               not again on every Replay and re-entry while it sits banked.
  superWand: { streak: 0, charged: false, announced: false },
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
  // Tasks / Achievements state (see src/tasks.js).
  //   stats   — the LIFETIME counter for every tracked activity
  //             (levelsCompleted, tilesMatched, coinsSpent, …). These are the
  //             source of truth: every task, weekly or achievement, is scored
  //             by comparing a target against one of these, so nothing is
  //             counted twice and a task added later starts already filled in.
  //   claimed — ids of the achievement tiers whose reward has been collected
  //             ("levels:25"). Same idempotent one-time ledger as
  //             boosterUnlocks/boosterCoach above; a claimed tier is gone for
  //             good and the chain moves on to its next one.
  //   weekly  — the weekly list's per-period state. `week` is the day-key
  //             (YYYY-MM-DD) of the Monday the current week began, and a
  //             change of that key rolls the period over. `claimed` is the
  //             same ledger as above but wiped on every roll. `base` is a
  //             SNAPSHOT of `stats` taken at the start of the week: weekly
  //             progress is simply stats - base, which is why the weekly tab
  //             needs no counters of its own and a reset is a snapshot rather
  //             than a wipe.
  tasks: { stats: {}, claimed: [], weekly: { week: "", claimed: [], base: {} } },
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
    // An array, so it can't ride the shallow sub-object merge above.
    this.boosterUnlocks = (data.boosterUnlocks || d.boosterUnlocks).slice();
    this.boosterCoach = (data.boosterCoach || d.boosterCoach).slice();
    this.settings = { ...d.settings, ...(data.settings || {}) };
    this.superWand = { ...d.superWand, ...(data.superWand || {}) };
    this.fortuneWheel = { ...d.fortuneWheel, ...(data.fortuneWheel || {}) };
    this.dailyBonus = { ...d.dailyBonus, ...(data.dailyBonus || {}) };
    // Nested maps and arrays can't ride the shallow sub-object merge, so the
    // counters, the two claim ledgers and the week's baseline are rebuilt here.
    const t = data.tasks || {};
    const w = t.weekly || {};
    this.tasks = {
      stats: { ...(t.stats || {}) },
      claimed: (t.claimed || []).slice(),
      weekly: {
        week: w.week || "",
        claimed: (w.claimed || []).slice(),
        base: { ...(w.base || {}) },
      },
    };
    this._listeners = new Set();
  }

  // ---- change events -------------------------------------------------------
  /** Subscribe. Callback is fn(domain, user) where domain ∈ progress|wallet|boosters|superWand|settings|fortuneWheel|dailyBonus|tasks.
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
  /** Highest level ever completed (0 = none). */
  completedLevel() { return this.progress.completed || 0; }
  /** Record a level as cleared (monotonic — never walks back). Clearing a level
   *  is also what unlocks helpers, so any grants that just came due are paid
   *  out here (see _grantPendingUnlocks). */
  completeLevel(n) {
    const v = Math.max(0, Math.floor(n) || 0);
    if (v <= this.completedLevel()) return;
    // Levels-completed is a LIFETIME task counter, and this early return is
    // exactly the "first clear only" rule the achievements want: replaying a
    // level already beaten never reaches here, so it never counts.
    this.bumpStat("levelsCompleted", v - this.completedLevel());
    this.progress.completed = v;
    this._emit("progress");
    this._grantPendingUnlocks();
  }
  /** A brand-new player: never played, no progress, never completed level 1.
   *  The first-run flow sends them straight into level 1 instead of the lobby. */
  isNewPlayer() { return this.progress.level <= 1 && this.completedLevel() === 0; }

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
    // "Coins spent" is a task counter measured by AMOUNT, not by number of
    // purchases. Counting it here — the one place coins ever leave the wallet —
    // means every spend (a helper buy, the Out-of-Moves continue, anything
    // added later) is counted without its own call site to forget.
    if (cur === "coins" && n) this.bumpStat("coinsSpent", n);
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
    // Every helper is spent through here (GameScene._acquireBooster funnels
    // stock / buy / ad into this one call), so this is the single place that
    // has to count them: the helper's own task counter plus the combined
    // "boosters used" total that a third set of tasks watches.
    this.bumpStat(kind + "Used");
    this.bumpStat("boostersUsed");
    this._emit("boosters");
    return true;
  }

  // ---- the Super Wand (the Wand's earned upgrade) --------------------------
  /** Consecutive new clears banked toward the next charge (pinned at the full
   *  streak length while one is already banked). */
  superWandStreak() { return this.superWand.streak || 0; }
  /** Is a Super Wand banked? While it is, the Wand's button IS the upgraded one
   *  and every press sweeps. Sweeping costs a WAND use like any other wand press,
   *  but it never touches this state — only an accepted loss does. */
  superWandCharged() { return !!this.superWand.charged; }
  /** Has the streak started accruing yet? Derived from progress like every other
   *  gate here, so a QA jump straight to a later level is honoured with nothing
   *  to repair. */
  isSuperWandUnlocked() { return this.completedLevel() >= SUPER_WAND.unlockLevel - 1; }

  /** Count one win toward the streak, charging a Super Wand when it completes.
   *  Returns `{ from, to, needed, justCharged }` so the level-complete screen can
   *  animate the notch that was just filled — or null when the gate is still shut
   *  or a charge is already banked (the caller then shows no bar and no notch).
   *  Only GENUINELY NEW clears should reach here; see GameScene._win. */
  recordSuperWandWin() {
    if (!this.isSuperWandUnlocked() || this.superWandCharged()) return null;
    const needed = SUPER_WAND.streakLength;
    const from = this.superWandStreak();
    const to = Math.min(needed, from + 1);
    this.superWand.streak = to;
    const justCharged = to >= needed;
    if (justCharged) {
      this.superWand.charged = true;
      this.superWand.announced = false; // a fresh charge is owed its celebration
    }
    this._emit("superWand");
    return { from, to, needed, justCharged };
  }

  /** A loss the player has accepted — the ONE thing that clears any of this.
   *  Empties the streak AND the banked charge together.
   *
   *  USING a Super Wand does NOT clear it: while the win streak is alive the Wand's
   *  button simply IS the upgraded one, and every press sweeps. The reward is the
   *  STATE of being on a streak, not a single-shot token, so the only way to lose
   *  it is to break the streak — which is exactly what accepting a loss does.
   *
   *  Returns true only when something actually reset, so the caller can show the
   *  break rather than animating a bar that was already empty. */
  breakSuperWandStreak() {
    if (!this.superWandCharged() && !this.superWandStreak()) return false;
    this.superWand = { streak: 0, charged: false, announced: false };
    this._emit("superWand");
    return true;
  }

  /** Is a banked charge still owed its arrival celebration? */
  superWandNeedsAnnounce() { return this.superWandCharged() && !this.superWand.announced; }
  /** Record that the arrival has been celebrated (once per charge, not per level). */
  markSuperWandAnnounced() {
    if (this.superWand.announced) return;
    this.superWand.announced = true;
    this._emit("superWand");
  }

  // ---- booster progression (helpers unlock over the first levels) ----------
  /** The level a helper becomes usable from (1 = available from the start). */
  boosterUnlockLevel(kind) {
    const u = BOOSTER_UNLOCKS[kind];
    return u ? u.level : 1;
  }
  /** Has the player reached the level that unlocks this helper? Derived from
   *  progress rather than stored, so a jump straight to a later level (a QA
   *  setLevel/completeLevel) is honoured with no bookkeeping to repair. */
  isBoosterUnlocked(kind) {
    return this.completedLevel() >= this.boosterUnlockLevel(kind) - 1;
  }
  /** Is the coin shop offered yet? Derived from progress like isBoosterUnlocked,
   *  so a QA jump straight to a later level is honoured with nothing to repair.
   *  The coin pill keeps showing the balance either way — only the cart
   *  affordance (and the tap that opens the shop) waits for this. */
  isShopUnlocked() { return this.completedLevel() >= SHOP_UNLOCK_LEVEL - 1; }
  /** Is the Tasks screen offered yet? Same derived-from-progress gate as the
   *  shop, so a QA jump to a later level opens it with nothing to repair. The
   *  counters behind it tick from level 1 regardless — only the entry point
   *  waits, so a player arriving at the gate finds their history already there. */
  isTasksUnlocked() { return this.completedLevel() >= TASKS_UNLOCK_LEVEL - 1; }
  /** Is the Fortune Wheel offered yet? The same derived-from-progress gate, so
   *  the lobby rail and the wheel itself both stop spelling the convention: the
   *  stored `progress.level` is DERIVED (min(completed + 1, maxLevel)), which is
   *  why it must never be what a gate reads — a QA jump, or any future screen
   *  that sets the level backwards, would move it without clearing anything. */
  isFortuneWheelUnlocked() { return this.completedLevel() >= FORTUNE_WHEEL_UNLOCK_LEVEL - 1; }
  /** Is the Daily Bonus offered yet? Same rule again. The shipped gate is 1 —
   *  "available from the very start" — so this reads `>= 0` and the gift is the
   *  first thing a brand-new player is offered. */
  isDailyBonusUnlocked() { return this.completedLevel() >= DAILY_BONUS_UNLOCK_LEVEL - 1; }
  /** Is the tray's 8th cell drawn (and its "+1" video offered) yet? The same
   *  derived-from-progress gate again, which is what makes it read the CAMPAIGN
   *  level rather than the level of the board being played — so a replay of an
   *  early level still gets the offer once progress is past the gate. Nothing is
   *  earned, claimed or persisted by this: it only decides whether the cell and
   *  its offer exist. Whether the extra slot is USABLE is per-level scene state
   *  (GameScene.traySlots), reset on every board build. */
  isExtraSlotUnlocked() { return this.completedLevel() >= EXTRA_SLOT_UNLOCK_LEVEL - 1; }

  /** Pay out the one-time stock for every helper that is unlocked but hasn't
   *  been granted yet. Idempotent — boosterUnlocks records what's been paid. */
  _grantPendingUnlocks() {
    for (const kind of Object.keys(BOOSTER_UNLOCKS)) {
      if (this.boosterUnlocks.includes(kind)) continue;
      if (!this.isBoosterUnlocked(kind)) continue;
      this.boosterUnlocks.push(kind);
      this.grantBooster(kind, BOOSTER_UNLOCKS[kind].grant); // emits "boosters"
    }
  }

  // ---- booster coaching (the guided first use of each helper) ---------------
  /** Has this helper's coached first use already been played? */
  isBoosterCoached(kind) { return this.boosterCoach.includes(kind); }
  /** Record that it has. Idempotent — the lesson happens once, ever. */
  markBoosterCoached(kind) {
    if (!kind || this.isBoosterCoached(kind)) return;
    this.boosterCoach.push(kind);
    this._emit("boosters");
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

  // ---- tasks / achievements ------------------------------------------------
  /** Lifetime total for a tracked activity (0 if it has never happened). */
  stat(activity) { return this.tasks.stats[activity] || 0; }
  /** Add to a lifetime counter. `stats` is a keyed map, exactly as the wallet
   *  is — the model does not need to know which counters the goal table watches
   *  to store one. But a code nobody watches is a bug that shows up as a task
   *  row stuck at 0/N forever with nothing logged, so the vocabulary is
   *  enumerated in CONFIG.features.tasks.activities and a stranger is reported.
   *  It is still RECORDED: refusing the write would turn a typo into silent data
   *  loss instead of a silent row. */
  bumpStat(activity, n = 1) {
    const v = Math.max(0, Math.floor(n) || 0);
    if (!activity || !v) return this.stat(activity);
    DEBUG: {
      // Development only — `tools/build.py` passes --drop-labels=DEBUG to
      // esbuild, which deletes this block from a production bundle. A WARN, not
      // an error: tests/harness.py collects console *errors* into the list
      // dozens of tests assert is empty, and a counter typo should fail the one
      // test that checks the roster, not redden the whole suite.
      if (!TASK_ACTIVITIES.includes(activity)) {
        console.warn("[tasks] unknown activity", JSON.stringify(activity),
          "— not in CONFIG.features.tasks.activities, so no goal row can score it");
      }
    }
    this.tasks.stats[activity] = this.stat(activity) + v;
    this._emit("tasks");
    return this.tasks.stats[activity];
  }
  /** Progress on an activity SINCE THE START OF THE CURRENT WEEK — the lifetime
   *  counter minus the snapshot taken when the week rolled over. This is the
   *  whole of the weekly list's bookkeeping. */
  weeklyStat(activity) {
    return Math.max(0, this.stat(activity) - (this.tasks.weekly.base[activity] || 0));
  }
  /** Has this task's reward been collected? `weekly` picks the ledger — the
   *  weekly one is wiped on every roll, the achievement one never is. */
  isTaskClaimed(id, weekly = false) {
    const list = weekly ? this.tasks.weekly.claimed : this.tasks.claimed;
    return list.includes(id);
  }
  /** Record a collection. Idempotent, so a double tap can't pay out twice. */
  markTaskClaimed(id, weekly = false) {
    if (!id || this.isTaskClaimed(id, weekly)) return false;
    (weekly ? this.tasks.weekly.claimed : this.tasks.claimed).push(id);
    this._emit("tasks");
    return true;
  }
  /** The week-key (the reset weekday's date, YYYY-MM-DD) the weekly list is
   *  currently on. "" = never rolled. */
  taskWeek() { return this.tasks.weekly.week || ""; }
  /** Roll the weekly list into a new period: stamp the new week-key, clear the
   *  claim ledger so every task is available again, and re-snapshot the
   *  lifetime counters so progress restarts from zero. Called on the first
   *  check after the reset weekday passes (and on the very first open). */
  rollTaskWeek(weekKey) {
    this.tasks.weekly.week = String(weekKey || "");
    this.tasks.weekly.claimed = [];
    this.tasks.weekly.base = { ...this.tasks.stats };
    this._emit("tasks");
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
    this.boosterUnlocks = d.boosterUnlocks.slice();
    this.boosterCoach = d.boosterCoach.slice();
    this.settings = { ...d.settings };
    this.superWand = { ...d.superWand };
    this.fortuneWheel = { ...d.fortuneWheel };
    this.dailyBonus = { ...d.dailyBonus };
    this.tasks = { stats: {}, claimed: [], weekly: { week: "", claimed: [], base: {} } };
    this._emit("progress");
    this._emit("wallet");
    this._emit("boosters");
    this._emit("superWand");
    this._emit("settings");
    this._emit("fortuneWheel");
    this._emit("dailyBonus");
    this._emit("tasks");
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
      boosterUnlocks: this.boosterUnlocks.slice(),
      boosterCoach: this.boosterCoach.slice(),
      settings: { ...this.settings },
      superWand: { ...this.superWand },
      fortuneWheel: { ...this.fortuneWheel, won: (this.fortuneWheel.won || []).slice() },
      dailyBonus: { ...this.dailyBonus },
      tasks: {
        stats: { ...this.tasks.stats },
        claimed: this.tasks.claimed.slice(),
        weekly: {
          week: this.tasks.weekly.week,
          claimed: this.tasks.weekly.claimed.slice(),
          base: { ...this.tasks.weekly.base },
        },
      },
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
    // v3 -> v4: adds progress.completed. Older blobs never tracked it, but levels
    // only ever advanced on a win, so a player sitting on level N had completed
    // N-1 — derive it, otherwise an existing player would look brand-new and get
    // dropped into the first-run flow.
    if (o.version === 3) {
      const p = { ...(o.progress || {}) };
      p.completed = Math.max(0, (Math.floor(p.level) || 1) - 1);
      o.progress = p;
      o.version = 4;
    }
    // v4 -> v5: helpers stopped being handed out at account creation and now
    // unlock over the first levels (BOOSTER_UNLOCKS). Existing players were
    // given a starter stock up front, so seed boosterUnlocks with everything
    // they have already reached — otherwise their next win would pay out a
    // fresh grant on top. Anything still locked has its stock zeroed: a v4
    // profile that never cleared a level was carrying 3/3/3 it should not have.
    if (o.version === 4) {
      const completed = Math.max(0, Math.floor((o.progress || {}).completed) || 0);
      const boosters = { ...(o.boosters || {}) };
      const unlocked = [];
      for (const [kind, u] of Object.entries(BOOSTER_UNLOCKS)) {
        if (completed >= u.level - 1) unlocked.push(kind);
        else boosters[kind] = 0;
      }
      o.boosters = boosters;
      o.boosterUnlocks = unlocked;
      o.version = 5;
    }
    // v5 -> v6: adds boosterCoach, the record of which helpers have had their
    // coached first use. It is left EMPTY on purpose — that is the whole point.
    // An existing player is already past some of these gates, so seeding it the
    // way v4->v5 seeded boosterUnlocks would mean they never meet the coaching
    // at all. Empty means every helper they have unlocked is still owed its
    // lesson, and gets it on the next level played (one per level, lowest
    // unlock first — see GameScene._maybeCoachBooster).
    if (o.version === 5) o.version = 6;
    // v6 -> v7: adds `tasks` — the lifetime activity counters plus the claim
    // ledgers behind the Achievements / Weekly Tasks screen. Unlike v5->v6 this
    // one derives what it honestly can, in the spirit of v3->v4: levels
    // completed is the ONE counter reconstructible from an existing profile
    // (progress.completed IS the lifetime total), so seed it rather than
    // pretending a veteran has never finished a level. Everything else starts
    // at 0 — those histories were simply never recorded. The consequence is
    // intended: an existing player opens the screen to find several tiers of
    // the levels chain already finished and stacked up ready to claim, which is
    // how adding tasks to a live game is supposed to feel.
    if (o.version === 6) {
      const completed = Math.max(0, Math.floor((o.progress || {}).completed) || 0);
      const stats = completed ? { levelsCompleted: completed } : {};
      // The week's baseline is the same snapshot, so the WEEKLY list starts at
      // zero instead of opening pre-completed off the back of that history.
      o.tasks = { stats, claimed: [], weekly: { week: "", claimed: [], base: { ...stats } } };
      o.version = 7;
    }
    // v7 -> v8: adds `superWand` — the win-streak state behind the Wand's earned
    // upgrade. Nothing here is reconstructible: win streaks were never recorded,
    // and a player's streak is by definition about their RECENT run, not their
    // history, so seeding one off `progress.completed` would be inventing a fact
    // rather than deriving it (contrast v3->v4 and v6->v7, where the old field
    // genuinely implied the new one). Every existing player therefore starts the
    // feature at zero and earns their first Super Wand honestly. The constructor
    // shallow-merges the sub-object from defaults(), so this step only has to
    // stamp the version — the same shape as v1->v2 and v2->v3.
    if (o.version === 7) o.version = 8;
    return o;
  }
}
