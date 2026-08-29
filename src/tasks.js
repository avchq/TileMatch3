// Tasks — the game's checklist of goals, shown as an overlay on top of the lobby
// and entered from the Tasks button on the lobby's RIGHT-edge feature rail.
// Built on the same template as ShopScene / FortuneWheelScene / DailyBonusScene
// (full-screen dim + centred panel + easeOutBack entrance pop + layout(DW,DH)
// reflow + a top HUD of reward fly-targets), and hidden by default.
//
// Two lists share the screen, on two tabs:
//   ACHIEVEMENTS are permanent and TIERED. One config entry is a CHAIN — one
//     activity broken into ascending targets — and only ONE unfinished tier of a
//     chain is ever on screen, so ~10 chains stay a readable list instead of
//     sixty rows. Claim it and the next tier takes its place. Claimed tiers are
//     gone for good; there is no trophy cabinet.
//   WEEKLY TASKS are flat one-shot goals that all reset at midnight on the
//     configured weekday (Monday as shipped), with a live countdown.
//
// Both are scored against the SAME lifetime counters on the profile
// (user.tasks.stats, bumped from the places the activities actually happen).
// Achievements compare a target to the lifetime total directly; weekly tasks
// compare it to `total - base`, where base is a snapshot taken when the week
// rolled over. That is why a week reset is a snapshot rather than a wipe, and
// why nothing here counts anything a second time.
//
// A consequence worth knowing: because progress is measured against lifetime
// totals rather than a per-tier counter, blowing past several tiers at once — or
// adding a new chain to a live game — leaves the already-earned tiers stacked up
// and instantly claimable, rather than needing to be re-earned.
//
// Nothing here is hardcoded: the GOAL TABLE (chains, tiers, targets, rewards)
// comes from assets/config/tasks.json (passed in as cfg) and the feature's GATE
// and reset weekday from CONFIG.features.tasks in src/config.js. The row TITLES
// are not here either — the same config file names one TEXT KEY per activity
// (its `titles` map), looked up in the active language. Only the row ICONS live
// in this file.

import { tween, easeOutCubic, easeInOutQuad, easeOutBack } from "./tween.js";
import { makeCoinIcon } from "./shop.js";
import { fitTextWidth } from "./layout.js";
import { CONFIG } from "./config.js";
import { t, locText } from "./i18n.js";

const DESIGN_W = 750;
const DESIGN_H = 1334;

// The GLYPH per tracked activity. The row's WORDING is not here: it is named as
// a text key by the `titles` map in assets/config/tasks.json and looked up in
// the active language (see the Localization section of the README), so the same
// row reads correctly in all 13 languages. An activity with no entry here still
// works — it falls back to a neutral glyph, and a title key missing from the
// language table shows up as the key itself.
const ACTIVITY = {
  levelsCompleted:   { icon: "🏁" },
  tilesMatched:      { icon: "🍉" },
  boostersUsed:      { icon: "🧰" },
  undoUsed:          { icon: "⤺"  },
  shuffleUsed:       { icon: "🔀" },
  wandUsed:          { icon: "🪄" },
  coinsSpent:        { icon: "coin" },
  dailyBonusClaimed: { icon: "🎁" },
  wheelSpins:        { icon: "🎡" },
  shopPurchases:     { icon: "🛒" },
};

// How a reward `type` is granted — the same mapping (and the same vocabulary in
// the JSON) the wheel and the daily gift use.
const REWARD_GRANT = {
  coins: { cur: "coins" },
  undo: { booster: "undo" },
  wand: { booster: "wand" },
  shuffle: { booster: "shuffle" },
};
const REWARD_EMOJI = { undo: "⤺", wand: "🪄", shuffle: "🔀" };

// ---- panel geometry (design units, laid out around the panel's own origin) ---
const PANEL_W = 690, PANEL_H = 1020;
const LIST_W = 640, LIST_H = 620, LIST_TOP = -258;
const ROW_W = 620, ROW_H = 132, ROW_PITCH = 144;

const pad2 = (n) => String(n).padStart(2, "0");

export class TasksScene extends PIXI.Container {
  constructor(app, audio, user, cfg) {
    super();
    this.app = app;
    this.audio = audio;
    this.user = user;
    this.onBack = null;             // () => void — optional hook when the overlay closes

    // GOAL DATA from the JSON config; the GATE + reset weekday from src/config.js.
    cfg = cfg || {};
    this.achievements = Array.isArray(cfg.achievements) ? cfg.achievements : [];
    // activity -> { title, one }: the TEXT KEYS for each row's title, not the
    // wording itself (route 3 of the localization — see src/i18n.js).
    this.titles = (cfg.titles && typeof cfg.titles === "object") ? cfg.titles : {};
    this.weekly = Array.isArray(cfg.weekly) ? cfg.weekly : [];
    this.unlockLevel = CONFIG.features.tasks.unlockLevel;
    this.resetDay = CONFIG.features.tasks.weeklyResetDay;

    // Test / runtime seams (mirroring the wheel's _todayOverride).
    this._nowOverride = null;       // pin "now" (countdown + rollover tests)
    this._weekOverride = null;      // pin the week-key outright

    this._tab = "achievements";
    this._rowNodes = [];
    this._rows = [];
    this._claiming = false;
    this._el = 0;

    // Scroll state.
    this._dragging = false;
    this._dragged = false;          // this gesture moved — suppress the claim tap
    this._dragY = 0;
    this._dragFrom = 0;
    this._contentH = 0;

    this.visible = false;
    this.viewW = DESIGN_W; this.viewH = DESIGN_H;

    this._tick = () => {
      this._el += this.app.ticker.deltaMS;
      // Pulse every claimable row's button so what's collectable draws the eye.
      const s = 1 + 0.06 * Math.sin(this._el / 220);
      for (const n of this._rowNodes) if (n.claimBtn && n.claimBtn.visible) n.claimBtn.scale.set(s);
      // The weekly countdown ticks live, so a deadline passing while the player
      // is looking at it resets the list in front of them — but never mid-claim,
      // which would rebuild the list out from under a reward still in flight.
      if (this._tab === "weekly" && !this._claiming) {
        this._refreshCountdown();
        this.checkRollover();
      }
    };

    // The scroll wheel is a raw DOM event — nothing else in the game listens for
    // one. Bound once here; attached only while the overlay is open.
    this._onWheel = (ev) => {
      if (!this.visible) return;
      ev.preventDefault();
      this._setScroll(this.listContent.y - ev.deltaY);
    };

    this._build();
  }

  // ---- the weekly period ---------------------------------------------------
  _now() { return this._nowOverride ? new Date(this._nowOverride) : new Date(); }

  /** Day-key (YYYY-MM-DD) of the most recent reset weekday on or before today —
   *  the id of the week the weekly list is in. Same day-key convention as the
   *  wheel and the daily gift, so there is still no timestamp in the profile. */
  _weekKey() {
    if (this._weekOverride) return this._weekOverride;
    const d = this._now();
    const back = (d.getDay() - this.resetDay + 7) % 7;
    const s = new Date(d.getFullYear(), d.getMonth(), d.getDate() - back);
    return `${s.getFullYear()}-${pad2(s.getMonth() + 1)}-${pad2(s.getDate())}`;
  }

  /** Milliseconds until the next reset (local midnight on the reset weekday). */
  _msToReset() {
    const d = this._now();
    const back = (d.getDay() - this.resetDay + 7) % 7;
    const next = new Date(d.getFullYear(), d.getMonth(), d.getDate() - back + 7);
    return Math.max(0, next.getTime() - d.getTime());
  }

  _resetText() {
    let s = Math.floor(this._msToReset() / 1000);
    const dys = Math.floor(s / 86400); s -= dys * 86400;
    const hrs = Math.floor(s / 3600);  s -= hrs * 3600;
    const mins = Math.floor(s / 60);   s -= mins * 60;
    if (dys) return t("reset_in_dh", dys, hrs);
    if (hrs) return t("reset_in_hm", hrs, mins);
    return t("reset_in_ms", mins, s);
  }

  /** Roll the weekly list over if the period has changed. Gated on the feature's
   *  unlock so an unreachable screen never writes to the profile; the first check
   *  after it unlocks stamps the week and snapshots the counters, which is what
   *  makes weekly progress start from zero rather than from a lifetime total. */
  checkRollover() {
    if (!this.user.isTasksUnlocked()) return;
    const wk = this._weekKey();
    if (this.user.taskWeek() === wk) return;
    this.user.rollTaskWeek(wk);
    // The host polls this every 4s, so it can land mid-claim — rebuilding the
    // list would destroy the row whose reward is still in flight. The claim ends
    // with a refresh of its own, so skipping here only defers the redraw.
    if (this.visible && !this._claiming) this.refresh();
  }

  // ---- the rows ------------------------------------------------------------
  /** Is there a goal table at all? A failed config fetch leaves both lists empty,
   *  which is what keeps the lobby button hidden. */
  hasTable() { return this.achievements.length > 0 || this.weekly.length > 0; }

  /** The achievement rows: per chain, every finished-but-unclaimed tier PLUS the
   *  first tier still in progress. Because tiers ascend and progress is a single
   *  lifetime total, the finished-unclaimed ones are a prefix — so this is one
   *  pass down the chain, not a search. */
  _achievementRows() {
    const out = [];
    for (const chain of this.achievements) {
      const tiers = Array.isArray(chain.tiers) ? chain.tiers : [];
      const count = this.user.stat(chain.activity);
      for (const tier of tiers) {
        const id = `${chain.id}:${tier.target}`;
        if (this.user.isTaskClaimed(id)) continue;
        const done = count >= tier.target;
        out.push({
          id, weekly: false, activity: chain.activity,
          count, target: tier.target, reward: tier.reward || {}, claimable: done,
        });
        if (!done) break;   // one unfinished tier per chain, and nothing past it
      }
    }
    return out;
  }

  _weeklyRows() {
    const out = [];
    for (const t of this.weekly) {
      if (this.user.isTaskClaimed(t.id, true)) continue;
      const count = this.user.weeklyStat(t.activity);
      out.push({
        id: t.id, weekly: true, activity: t.activity,
        count, target: t.target, reward: t.reward || {}, claimable: count >= t.target,
      });
    }
    return out;
  }

  /** The rows of a tab, collectable ones first (a stable sort, so within each
   *  group the config order is preserved). */
  rowsFor(tab) {
    const rows = tab === "weekly" ? this._weeklyRows() : this._achievementRows();
    return rows
      .map((r, i) => ({ r, i }))
      .sort((a, b) => (b.r.claimable - a.r.claimable) || (a.i - b.i))
      .map((x) => x.r);
  }

  /** Is anything on either tab waiting to be collected? Drives the lobby's red
   *  dot, which is the feature's entire discovery mechanism. */
  hasClaimable() {
    if (!this.hasTable() || !this.user.isTasksUnlocked()) return false;
    return this.rowsFor("achievements").some((r) => r.claimable) ||
           this.rowsFor("weekly").some((r) => r.claimable);
  }

  // ---- build ---------------------------------------------------------------
  _build() {
    // Full-screen modal dim (swallows taps meant for the lobby beneath).
    const dim = new PIXI.Graphics();
    dim.beginFill(0x040814, 0.82).drawRect(0, 0, DESIGN_W, DESIGN_H).endFill();
    dim.eventMode = "static";
    this.addChild(dim);
    this.dim = dim;

    // Top HUD — the reward fly targets, pinned to the top edge like the lobby's.
    this.topHud = new PIXI.Container();
    this.addChild(this.topHud);
    this._chips = {};
    const chipDefs = [["undo", "⤺", 70], ["wand", "🪄", 190], ["shuffle", "🔀", 310]];
    for (const [kind, emoji, x] of chipDefs) {
      const chip = this._makeBoosterChip(kind, emoji);
      chip.position.set(x, 84);
      this.topHud.addChild(chip);
      this._chips[kind] = chip;
    }
    this.coinPill = this._makeCoinCounter();
    this.coinPill.position.set(DESIGN_W - 150, 84);
    this.topHud.addChild(this.coinPill);

    // Centred panel (children drawn around its origin, so the pop is from centre).
    this.panel = new PIXI.Container();
    this.panel.position.set(DESIGN_W / 2, DESIGN_H / 2);
    this.addChild(this.panel);

    const bg = new PIXI.Graphics();
    bg.beginFill(0x22335e, 0.98)
      .drawRoundedRect(-PANEL_W / 2, -PANEL_H / 2, PANEL_W, PANEL_H, 36).endFill();
    bg.lineStyle(6, 0xffffff, 0.15)
      .drawRoundedRect(-PANEL_W / 2, -PANEL_H / 2, PANEL_W, PANEL_H, 36);
    this.panel.addChild(bg);

    const title = locText("task_title", {
      fontFamily: "Arial", fontSize: 64, fontWeight: "900", fill: 0xffe27a,
      stroke: 0x5a3a00, strokeThickness: 7,
    });
    title.anchor.set(0.5);
    title.position.set(0, -448);
    this.panel.addChild(title);

    // Tabs.
    this._tabBtns = {
      achievements: this._makeTab("tab_achievements", -156, () => this.setTab("achievements")),
      weekly: this._makeTab("tab_weekly", 156, () => this.setTab("weekly")),
    };
    this.panel.addChild(this._tabBtns.achievements, this._tabBtns.weekly);

    // The line under the tabs: the weekly countdown + banner, or a word about
    // what the achievements tab is.
    this._note = new PIXI.Text("", {
      fontFamily: "Arial", fontSize: 27, fontWeight: "800", fill: 0xdce7ff,
      stroke: 0x122043, strokeThickness: 4, align: "center",
    });
    this._note.anchor.set(0.5);
    this._note.position.set(0, -292);
    this.panel.addChild(this._note);

    // ---- the scrolling list ------------------------------------------------
    // A masked viewport holding a taller content container whose y IS the scroll
    // offset. Nothing else in this game scrolls, so this is the only mask and the
    // only drag handling in the codebase.
    this.listView = new PIXI.Container();
    this.listView.position.set(0, LIST_TOP);
    this.panel.addChild(this.listView);

    const maskG = new PIXI.Graphics();
    maskG.beginFill(0xffffff).drawRoundedRect(-LIST_W / 2, 0, LIST_W, LIST_H, 24).endFill();
    this.listView.addChild(maskG);
    this.listView.mask = maskG;

    this.listContent = new PIXI.Container();
    this.listView.addChild(this.listContent);

    // The viewport takes the drag. Its children (the rows' Claim buttons) still
    // get their taps — the gesture only becomes a scroll once it has actually
    // moved, and _dragged is what stops a scroll from also firing a Claim.
    this.listView.eventMode = "static";
    this.listView.hitArea = new PIXI.Rectangle(-LIST_W / 2, 0, LIST_W, LIST_H);
    this.listView.on("pointerdown", (e) => {
      this._dragging = true;
      this._dragged = false;
      this._dragY = this.listView.toLocal(e.global).y;
      this._dragFrom = this.listContent.y;
    });
    // globalpointermove fires wherever the pointer is, so a drag that wanders off
    // the list keeps scrolling instead of sticking.
    this.listView.on("globalpointermove", (e) => {
      if (!this._dragging) return;
      const dy = this.listView.toLocal(e.global).y - this._dragY;
      if (Math.abs(dy) > 6) this._dragged = true;
      this._setScroll(this._dragFrom + dy);
    });
    const endDrag = () => { this._dragging = false; };
    this.listView.on("pointerup", endDrag);
    this.listView.on("pointerupoutside", endDrag);

    // Shown instead of the list when a tab has nothing left on it.
    this._empty = new PIXI.Text("", {
      fontFamily: "Arial", fontSize: 30, fontWeight: "800", fill: 0xaebfe0,
      align: "center",
    });
    this._empty.anchor.set(0.5);
    this._empty.position.set(0, LIST_TOP + LIST_H / 2);
    this._empty.visible = false;
    this.panel.addChild(this._empty);

    this._backBtn = this._makeButton(t("btn_back"), 220, 74, 0, 440, 0x3a4a72, () => this._close());
    this.panel.addChild(this._backBtn);

    // Reward flight layer (above everything, and outside the list's mask).
    this.fxLayer = new PIXI.Container();
    this.addChild(this.fxLayer);
  }

  // ---- widgets -------------------------------------------------------------
  _makeButton(label, w, h, cx, cy, color, onClick) {
    const c = new PIXI.Container();
    c.position.set(cx, cy);
    const g = new PIXI.Graphics();
    g.beginFill(color).drawRoundedRect(-w / 2, -h / 2, w, h, h / 2.4).endFill();
    g.lineStyle(4, 0xffffff, 0.35).drawRoundedRect(-w / 2, -h / 2, w, h, h / 2.4);
    const t = new PIXI.Text(label, { fontFamily: "Arial", fontSize: 32, fontWeight: "800", fill: 0xffffff });
    t.anchor.set(0.5);
    c.addChild(g, t);
    c.label = t;
    c.eventMode = "static";
    c.cursor = "pointer";
    c.on("pointertap", onClick);
    c.on("pointerdown", () => c.scale.set(0.95));
    c.on("pointerup", () => c.scale.set(1));
    c.on("pointerupoutside", () => c.scale.set(1));
    return c;
  }

  // A tab button. Like SettingsScene's toggle it keeps a local draw() and exposes
  // __set(on), so selecting one is a redraw in place rather than a rebuild.
  _makeTab(labelKey, cx, onTap) {
    const c = new PIXI.Container();
    c.position.set(cx, -364);
    const w = 300, h = 76;
    const g = new PIXI.Graphics();
    c.addChild(g);
    const tab = locText(labelKey, { fontFamily: "Arial", fontSize: 28, fontWeight: "800", fill: 0xffffff });
    tab.anchor.set(0.5);
    fitTextWidth(tab, w - 28);
    c.addChild(tab);
    c.label = tab;
    c.__fit = () => fitTextWidth(tab, w - 28);
    const draw = (on) => {
      g.clear();
      g.beginFill(on ? 0x4d8dff : 0x2b3a63).drawRoundedRect(-w / 2, -h / 2, w, h, h / 2.4).endFill();
      g.lineStyle(4, 0xffffff, on ? 0.5 : 0.18).drawRoundedRect(-w / 2, -h / 2, w, h, h / 2.4);
      tab.alpha = on ? 1 : 0.7;
    };
    draw(false);
    c.__set = draw;
    c.eventMode = "static";
    c.cursor = "pointer";
    c.on("pointertap", onTap);
    return c;
  }

  // A live coins counter for the top HUD (a gold coin + the balance), refreshed on
  // any wallet change so a claimed reward ticks it up on landing.
  _makeCoinCounter() {
    const c = new PIXI.Container();
    const w = 168, h = 60;
    const g = new PIXI.Graphics();
    g.beginFill(0x0a1226, 0.55).drawRoundedRect(-w / 2, -h / 2, w, h, h / 2).endFill();
    g.lineStyle(3, 0xffffff, 0.35).drawRoundedRect(-w / 2, -h / 2, w, h, h / 2);
    c.addChild(g);
    const coin = makeCoinIcon(19);
    coin.position.set(-w / 2 + 28, 0);
    c.addChild(coin);
    const label = new PIXI.Text("0", {
      fontFamily: "Arial", fontSize: 32, fontWeight: "900", fill: 0xffffff,
      stroke: 0x14361f, strokeThickness: 4,
    });
    label.anchor.set(0, 0.5);
    label.position.set(-w / 2 + 52, 0);
    c.addChild(label);
    c.label = label;
    c.update = () => { label.text = String(this.user ? this.user.balance("coins") : 0); };
    c.update();
    this.user.on((domain) => { if (domain === "wallet") c.update(); });
    return c;
  }

  _makeBoosterChip(kind, emoji) {
    const c = new PIXI.Container();
    const w = 96, h = 60;
    const g = new PIXI.Graphics();
    g.beginFill(0x0a1226, 0.55).drawRoundedRect(-w / 2, -h / 2, w, h, h / 2).endFill();
    g.lineStyle(3, 0xffffff, 0.35).drawRoundedRect(-w / 2, -h / 2, w, h, h / 2);
    c.addChild(g);
    const e = new PIXI.Text(emoji, { fontFamily: "Arial", fontSize: 30 });
    e.anchor.set(0.5); e.position.set(-w / 2 + 26, 0);
    c.addChild(e);
    const t = new PIXI.Text("0", {
      fontFamily: "Arial", fontSize: 28, fontWeight: "900", fill: 0xffffff,
      stroke: 0x14361f, strokeThickness: 4,
    });
    t.anchor.set(0, 0.5); t.position.set(-w / 2 + 46, 0);
    c.addChild(t);
    c.label = t;
    c.update = () => { t.text = String(this.user ? this.user.boosterCount(kind) : 0); };
    c.update();
    this.user.on((domain) => { if (domain === "boosters") c.update(); });
    return c;
  }

  /** The activity's glyph. Coins are the drawn gold coin, not an emoji — the
   *  emoji fonts render 🪙 silver (see makeCoinIcon in shop.js). */
  _makeIcon(kind, size) {
    if (kind === "coin" || kind === "coins") return makeCoinIcon(size * 0.42);
    const t = new PIXI.Text(kind || "❔", { fontFamily: "Arial", fontSize: size });
    t.anchor.set(0.5);
    return t;
  }

  _rewardChip(reward) {
    const c = new PIXI.Container();
    const icon = reward.type === "coins"
      ? this._makeIcon("coin", 46)
      : this._makeIcon(REWARD_EMOJI[reward.type] || "❔", 30);
    icon.position.set(-26, 0);
    c.addChild(icon);
    const t = new PIXI.Text(
      reward.type === "coins" ? `+${reward.amount}` : `×${reward.amount}`,
      { fontFamily: "Arial", fontSize: 26, fontWeight: "900", fill: 0xffe27a,
        stroke: 0x5a3a00, strokeThickness: 4 });
    t.anchor.set(0, 0.5);
    t.position.set(-8, 0);
    c.addChild(t);
    return c;
  }

  // ---- rows ----------------------------------------------------------------
  _makeRow(row, y) {
    const c = new PIXI.Container();
    c.position.set(0, y);
    c.__row = row;

    // Claimable rows go gold, so what's collectable reads at a glance.
    const g = new PIXI.Graphics();
    g.beginFill(row.claimable ? 0x4a3f1c : 0x1b2848, 0.95)
      .drawRoundedRect(-ROW_W / 2, -ROW_H / 2, ROW_W, ROW_H, 22).endFill();
    g.lineStyle(3, row.claimable ? 0xffe27a : 0xffffff, row.claimable ? 0.75 : 0.14)
      .drawRoundedRect(-ROW_W / 2, -ROW_H / 2, ROW_W, ROW_H, 22);
    c.addChild(g);

    const meta = ACTIVITY[row.activity] || {};
    const icon = this._makeIcon(meta.icon || "❔", 44);
    icon.position.set(-258, 0);
    c.addChild(icon);

    const t2 = new PIXI.Text(this._rowTitle(row), {
      fontFamily: "Arial", fontSize: 25, fontWeight: "800", fill: 0xffffff,
      stroke: 0x1a2140, strokeThickness: 4,
    });
    t2.anchor.set(0, 0.5);
    // Capped so a long title can never run into the reward chip to its right.
    fitTextWidth(t2, 285);
    t2.position.set(-212, row.claimable ? 0 : -30);
    c.addChild(t2);
    c.titleText = t2;
    c.__row = row;

    if (row.claimable) {
      // Finished: the bar has nothing left to say, so the reward and the button
      // take the whole right-hand side.
      const chip = this._rewardChip(row.reward);
      chip.position.set(132, 0);
      c.addChild(chip);

      const btn = this._makeButton(t("claim"), 120, 58, 248, 0, 0x39c06a, () => this._claim(c));
      c.addChild(btn);
      c.claimBtn = btn;
    } else {
      const trackW = 280, trackH = 20, trackX = -212;
      const bar = new PIXI.Graphics();
      const pct = row.target > 0 ? Math.min(1, row.count / row.target) : 0;
      bar.beginFill(0x0a1226, 0.7).drawRoundedRect(trackX, 30 - trackH / 2, trackW, trackH, trackH / 2).endFill();
      if (pct > 0) {
        bar.beginFill(0x39c06a)
          .drawRoundedRect(trackX, 30 - trackH / 2, Math.max(trackH, trackW * pct), trackH, trackH / 2)
          .endFill();
      }
      c.addChild(bar);

      const cnt = new PIXI.Text(`${Math.min(row.count, row.target)}/${row.target}`, {
        fontFamily: "Arial", fontSize: 21, fontWeight: "900", fill: 0xdce7ff,
        stroke: 0x122043, strokeThickness: 3,
      });
      cnt.anchor.set(0.5);
      cnt.position.set(152, 30);
      c.addChild(cnt);

      const chip = this._rewardChip(row.reward);
      chip.position.set(140, -30);
      c.addChild(chip);
    }
    return c;
  }

  /** Rebuild the visible list from the profile. Cheap enough to run whole — the
   *  lists are ~10 rows — and it keeps "what is on screen" a pure function of
   *  the counters plus the claim ledgers. */
  refresh({ keepScroll = false } = {}) {
    const scroll = keepScroll ? this.listContent.y : 0;
    for (const n of this._rowNodes) n.destroy({ children: true });
    this._rowNodes.length = 0;
    this.listContent.removeChildren();

    this._tabBtns.achievements.__set(this._tab === "achievements");
    this._tabBtns.weekly.__set(this._tab === "weekly");
    this._note.text = this._tab === "weekly"
      ? t("tasks_note_weekly", this._resetText())
      : t("tasks_note_achievements");

    this._rows = this.rowsFor(this._tab);
    let y = ROW_H / 2 + 8;
    for (const row of this._rows) {
      const node = this._makeRow(row, y);
      this.listContent.addChild(node);
      this._rowNodes.push(node);
      y += ROW_PITCH;
    }
    this._contentH = this._rows.length ? y - ROW_PITCH + ROW_H / 2 + 8 : 0;

    this._empty.visible = this._rows.length === 0;
    this._empty.text = this._tab === "weekly"
      ? t("tasks_empty_weekly")
      : t("tasks_empty_achievements");

    // Claiming keeps the player where they were reading; a tab switch or a fresh
    // open starts at the top. _setScroll re-clamps either way, so a list that
    // just got shorter can't be left scrolled past its end.
    this._setScroll(scroll);
  }

  _refreshCountdown() {
    if (this._tab !== "weekly") return;
    this._note.text = t("tasks_note_weekly", this._resetText());
  }

  /**
   * A row's title, in the active language. The key comes from the config
   * table's `titles` map (activity -> { title, one }), never from wording baked
   * into this file: `title` carries a %value placeholder filled with the row's
   * target, and `one` is the singular used when that target is 1. An activity
   * the table doesn't name falls back to its own code, exactly as before.
   */
  _rowTitle(row) {
    const keys = this.titles[row.activity];
    if (!keys) return `${row.activity} ${row.target}`;
    if (row.target === 1 && keys.one) return t(keys.one);
    return t(keys.title, row.target);
  }

  /**
   * Re-letter. The panel title, both tabs and the Back button carry their keys
   * and refresh themselves; the note line, the empty-state message and every
   * row title are assembled in code, so they are re-read here. The rows are
   * re-titled in place rather than rebuilt, so a reward already in flight and
   * the player's scroll position both survive the swap.
   */
  relocalize() {
    this._backBtn.label.text = t("btn_back");
    this._tabBtns.achievements.__fit();
    this._tabBtns.weekly.__fit();
    this._note.text = this._tab === "weekly"
      ? t("tasks_note_weekly", this._resetText())
      : t("tasks_note_achievements");
    this._empty.text = this._tab === "weekly"
      ? t("tasks_empty_weekly")
      : t("tasks_empty_achievements");
    for (const node of this._rowNodes) {
      if (!node.__row || !node.titleText || node.titleText.destroyed) continue;
      node.titleText.text = this._rowTitle(node.__row);
      fitTextWidth(node.titleText, 285);
      if (node.claimBtn) node.claimBtn.label.text = t("claim");
    }
  }

  // ---- scrolling -----------------------------------------------------------
  _setScroll(y) {
    // Content shorter than the viewport never scrolls; otherwise clamp so the
    // list can't be dragged past either end.
    const min = Math.min(0, LIST_H - this._contentH);
    this.listContent.y = Math.max(min, Math.min(0, y));
  }

  /** Scroll offset + bounds (debug / test hook). */
  scrollState() {
    return {
      y: this.listContent.y,
      min: Math.min(0, LIST_H - this._contentH),
      contentH: this._contentH,
      viewH: LIST_H,
      scrollable: this._contentH > LIST_H,
    };
  }

  // ---- tabs ----------------------------------------------------------------
  setTab(tab) {
    const t = tab === "weekly" ? "weekly" : "achievements";
    // Same reason as checkRollover: don't rebuild the list while a claimed
    // reward is still flying out of it.
    if (t === this._tab || this._claiming) return;
    this.audio.play("btn_01");
    this._tab = t;
    this.refresh();
  }

  tab() { return this._tab; }

  /** Which tab to land on: whichever has something to collect, preferring
   *  Achievements when both do. */
  _autoTab() {
    if (this.rowsFor("achievements").some((r) => r.claimable)) return "achievements";
    if (this.rowsFor("weekly").some((r) => r.claimable)) return "weekly";
    return "achievements";
  }

  // ---- claiming ------------------------------------------------------------
  /** Collect a row's reward. Takes the row NODE so the reward can fly from where
   *  it is on screen. A no-op unless the row is really finished and unclaimed. */
  async _claim(node) {
    const row = node && node.__row;
    if (!row || !row.claimable || this._claiming) return;
    // A drag that ends over a Claim button must not also claim it.
    if (this._dragged) { this._dragged = false; return; }
    if (!this.user.markTaskClaimed(row.id, row.weekly)) return;  // commit first: no double pay

    this._claiming = true;
    this.audio.play("merge_click");
    if (node.claimBtn) { node.claimBtn.eventMode = "none"; node.claimBtn.visible = false; }
    await this._collect(row.reward, node);
    await this._retireRow(node);
    this._claiming = false;
    this.refresh({ keepScroll: true });
  }

  _grantTarget(reward) {
    const g = REWARD_GRANT[reward.type];
    if (g && g.booster && this._chips[g.booster]) return this._chips[g.booster];
    return this.coinPill;   // coins + any fallback
  }

  _grant(reward) {
    const g = REWARD_GRANT[reward.type];
    if (!g) return;
    if (g.cur) this.user.credit(g.cur, reward.amount);
    else if (g.booster) this.user.grantBooster(g.booster, reward.amount);
  }

  /** Fly the reward from its row up to its counter, granting ON LANDING so the
   *  number ticks in sync with the visual (same arc the wheel and the daily
   *  gift use). Grants outright if the geometry can't be measured. */
  async _collect(reward, node) {
    const target = this._grantTarget(reward);
    let start, end;
    try {
      start = this.fxLayer.toLocal(node.getGlobalPosition());
      end = this.fxLayer.toLocal(target.getGlobalPosition());
    } catch (_) { this._grant(reward); return; }

    const flyer = reward.type === "coins"
      ? this._makeIcon("coin", 80)
      : this._makeIcon(REWARD_EMOJI[reward.type] || "❔", 44);
    flyer.position.set(start.x, start.y);
    this.fxLayer.addChild(flyer);

    const C = { x: (start.x + end.x) / 2, y: Math.min(start.y, end.y) - 150 };
    await tween(this.app.ticker, {
      duration: 540, ease: easeInOutQuad,
      onUpdate: (e) => {
        const u = 1 - e;
        flyer.x = u * u * start.x + 2 * u * e * C.x + e * e * end.x;
        flyer.y = u * u * start.y + 2 * u * e * C.y + e * e * end.y;
        flyer.scale.set(1 - 0.3 * e);
      },
    });
    this._grant(reward);
    this._bump(target);
    if (!flyer.destroyed) flyer.destroy();
  }

  _bump(node) {
    return tween(this.app.ticker, {
      duration: 240, ease: easeOutCubic,
      onUpdate: (e) => node.scale.set(1 + 0.28 * Math.sin(Math.PI * e)),
    });
  }

  /** A claimed row slides out and fades, then refresh() drops it for good. */
  _retireRow(node) {
    const x0 = node.x;
    return tween(this.app.ticker, {
      duration: 260, ease: easeOutCubic,
      onUpdate: (e) => { node.x = x0 + 420 * e; node.alpha = 1 - e; },
    });
  }

  // ---- open / close / layout ----------------------------------------------
  open() {
    if (!this.hasTable() || !this.user.isTasksUnlocked()) return;
    this.checkRollover();

    this.visible = true;
    this._el = 0;
    this._dragging = false;
    this._dragged = false;
    this._claiming = false;
    // Land on whatever has something to collect.
    this._tab = this._autoTab();
    this.refresh();

    // Remove-then-add so re-opening an already-open screen (a refresh from the
    // host, a test driving it twice) can't stack a second ticker callback.
    this.app.ticker.remove(this._tick);
    this.app.ticker.add(this._tick);
    this.app.view.addEventListener("wheel", this._onWheel, { passive: false });

    this.panel.scale.set(0.6);
    tween(this.app.ticker, {
      duration: 300, ease: easeOutBack,
      onUpdate: (e) => this.panel.scale.set(0.6 + 0.4 * e),
    });
  }

  _close() {
    if (!this.visible) return;
    this.audio.play("btn_01");
    this.visible = false;
    this.app.ticker.remove(this._tick);
    this.app.view.removeEventListener("wheel", this._onWheel);
    if (this.onBack) this.onBack();
  }

  layout(DW, DH) {
    this.viewW = DW; this.viewH = DH;
    this.dim.clear();
    this.dim.beginFill(0x040814, 0.82).drawRect(0, 0, DW, DH).endFill();
    this.panel.position.set(DW / 2, DH / 2);
    // NOT layout.js's fitPanel. That measures getLocalBounds(), and this panel is
    // the one whose content is deliberately TALLER than the box it's drawn in —
    // that is what makes the list scroll. Pixi does clip bounds to a mask, so
    // fitPanel would in fact work today, but the panel's on-screen size would then
    // depend on how many rows a chain happens to have and on that mask-bounds
    // detail. The panel is a fixed design size; fit to that and it stays put.
    this.panel.scale.set(Math.min(1, (DW - 48) / PANEL_W, (DH - 48) / PANEL_H));
    this.topHud.position.set((DW - DESIGN_W) / 2, 0);
  }

  // The independent controls this overlay owns (for the resize/overlap test): the
  // centred panel plus the top-HUD reward counters (the fly targets).
  controls() {
    return [
      { name: "panel", obj: this.panel },
      { name: "coinPill", obj: this.coinPill },
      { name: "chipUndo", obj: this._chips.undo },
      { name: "chipWand", obj: this._chips.wand },
      { name: "chipShuffle", obj: this._chips.shuffle },
    ];
  }
}
