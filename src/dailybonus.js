// Daily Bonus — a free, once-a-day gift shown as an overlay on top of the lobby,
// entered from the lobby's pulsing gift button. Modeled on FortuneWheelScene /
// ShopScene (full-screen dim + centred panel + easeOutBack entrance pop +
// layout(DW,DH) reflow), and, like the other overlays, hidden by default.
//
// Despite the name it is NOT a login-streak calendar: there is no Day 1→7 chain,
// no streak, and no penalty for missing days. Each day it's available the player
// opens the popup, picks ONE of three mystery boxes, and receives whatever that
// box contains — a single weighted random prize. An optional rewarded ad doubles
// it. Then the popup closes until the next calendar day.
//
// The ONLY persisted state is the day-key of the most recent claim
// (user.dailyBonus.lastClaimDay); "has the calendar date changed since then?" is
// the whole eligibility check. Grants go through user.credit / user.grantBooster
// so they autosave and tick the HUD counters live. Nothing here is hardcoded: the
// PRIZE POOL comes from assets/config/dailybonus.json (passed in as cfg) and the
// feature's GATE (unlock level) from CONFIG.features.dailyBonus in src/config.js,
// alongside every other gate.

import { tween, delay, easeInCubic, easeOutCubic, easeInOutQuad, easeOutBack } from "./tween.js";
import { makeCoinIcon } from "./shop.js";
import { fitPanel } from "./layout.js";
import { CONFIG } from "./config.js";
import { t, locText, itemName } from "./i18n.js";

const DESIGN_W = 750;
const DESIGN_H = 1334;

// How each config prize `type` is granted in this port. Coins credit the wallet;
// undo/wand/shuffle grant boosters. (The source's "Hint" helper is this game's
// wand, so it's baked into the config as `wand` — same mapping the wheel uses.)
const PRIZE_GRANT = {
  coins: { cur: "coins" },
  undo: { booster: "undo" },
  wand: { booster: "wand" },
  shuffle: { booster: "shuffle" },
};

// Glyphs for the non-coin prize types (coins use the drawn gold coin). The NAME
// that goes under the glyph is localized — see itemName() in src/i18n.js.
const PRIZE_EMOJI = { undo: "⤺", wand: "🪄", shuffle: "🔀" };

// The three mystery boxes: green / red / blue (lid + darker body).
const BOXES = [
  { lid: 0x39c06a, body: 0x2f8a54 },
  { lid: 0xff5a4d, body: 0xd6453a },
  { lid: 0x4d8dff, body: 0x3a6fd0 },
];
const BOX_X = [-190, 0, 190];
const BOX_Y = -100;

// Reveal-sequence timings (ms). Visual constants, so they live with the scene
// rather than in src/config.js: how long the two unchosen boxes take to vanish,
// how long the opened box waits behind the revealed prize before fading, and how
// long that fade runs.
const BOX_DISMISS_MS = 220;
const BOX_HIDE_DELAY_MS = 220;
const BOX_HIDE_MS = 320;

export class DailyBonusScene extends PIXI.Container {
  constructor(app, audio, user, cfg) {
    super();
    this.app = app;
    this.audio = audio;
    this.user = user;
    this.onBack = null;            // () => void — optional hook when the overlay closes

    // Prize DATA from the JSON config; the GATE from src/config.js.
    cfg = cfg || {};
    this.prizes = Array.isArray(cfg.prizes) ? cfg.prizes : [];
    this.unlockLevel = CONFIG.features.dailyBonus.unlockLevel;

    // Test / runtime seams.
    this._todayOverride = null;    // force the day-key (rollover tests)
    this._forceIndex = null;       // pin the prize behind every box (deterministic tests)
    this._adResult = "succeed";    // "succeed" | "cancel" | "fail" (double-ad tests)

    // Per-open flow state (reset in open()).
    this._prizes = [];             // the three rolled prizes, one per box
    this._opened = false;          // a box has been tapped (today's claim committed)
    this._chosen = null;           // index of the tapped box
    this._doubled = false;
    this._taken = false;           // the reward has been credited + popup closing
    this._el = 0;                  // ticker clock (box bob / shine spin)

    this.visible = false;
    this.viewW = DESIGN_W; this.viewH = DESIGN_H;

    this._tick = () => {
      const dt = this.app.ticker.deltaMS;
      this._el += dt;
      if (!this._opened) {
        // Bob the closed boxes, each on its own phase.
        for (let i = 0; i < this._boxes.length; i++) {
          const b = this._boxes[i];
          if (b.visible) b.y = BOX_Y + Math.sin(this._el / 320 + i * 1.1) * 8;
        }
      } else if (this._shine) {
        this._shine.rotation += (dt / 1000) * 0.8;   // rotating reveal shine
      }
    };

    this._build();
  }

  // ---- daily eligibility ---------------------------------------------------
  _today() {
    if (this._todayOverride) return this._todayOverride;
    const d = new Date();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const da = String(d.getDate()).padStart(2, "0");
    return `${d.getFullYear()}-${m}-${da}`;
  }

  /** No stored cycle to advance — kept for parity with the wheel and as a place
   *  the day-override hook can call. canClaim() derives everything from the
   *  day-key, so a rollover needs no state mutation. */
  checkRollover() {}

  /** Today's gift is claimable iff the feature is unlocked and the last claim was
   *  on an earlier calendar day (or never). Empty pool (failed config) => never. */
  canClaim() {
    if (!this.prizes.length) return false;
    if (this.user.progress.level < this.unlockLevel) return false;
    return this.user.dailyBonusLastDay() !== this._today();
  }

  /** Weighted random index into the prize pool. Pure — forcing is handled in
   *  _rollBoxes so it can pin all three boxes at once. */
  _pickIndex() {
    const prizes = this.prizes;
    if (!prizes.length) return 0;
    let total = 0;
    const weights = prizes.map((p) => { const w = Math.max(0, p.weight || 0); total += w; return w; });
    if (total <= 0) return 0;
    let r = Math.random() * total;
    for (let k = 0; k < prizes.length; k++) { r -= weights[k]; if (r < 0) return k; }
    return prizes.length - 1;
  }

  /** Roll one independent prize per box. A pinned _forceIndex (test seam) puts the
   *  same prize behind all three so whichever box is tapped is deterministic. */
  _rollBoxes() {
    if (this._forceIndex != null) {
      const f = this._forceIndex; this._forceIndex = null;
      const idx = (f >= 0 && f < this.prizes.length) ? f : 0;
      const p = this.prizes[idx];
      return [p, p, p];
    }
    return [this.prizes[this._pickIndex()], this.prizes[this._pickIndex()], this.prizes[this._pickIndex()]];
  }

  // ---- build ---------------------------------------------------------------
  _build() {
    // Full-screen modal dim (swallows taps meant for the lobby beneath).
    const dim = new PIXI.Graphics();
    dim.beginFill(0x040814, 0.82).drawRect(0, 0, DESIGN_W, DESIGN_H).endFill();
    dim.eventMode = "static";
    this.addChild(dim);
    this.dim = dim;

    // Top HUD (prize fly targets), pinned to the top edge like the lobby's.
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

    // Centred panel (pivot at centre for the pop).
    this.panel = new PIXI.Container();
    this.panel.position.set(DESIGN_W / 2, DESIGN_H / 2);
    this.addChild(this.panel);

    const title = locText("daily_bonus_title", {
      fontFamily: "Arial", fontSize: 64, fontWeight: "900", fill: 0xffe27a,
      stroke: 0x5a3a00, strokeThickness: 7,
    });
    title.anchor.set(0.5);
    title.position.set(0, -460);
    this.panel.addChild(title);

    this._tip = locText("pick_a_box", {
      fontFamily: "Arial", fontSize: 40, fontWeight: "800", fill: 0xdce7ff,
      stroke: 0x122043, strokeThickness: 4,
    });
    this._tip.anchor.set(0.5);
    this._tip.position.set(0, -330);
    this.panel.addChild(this._tip);

    // The three mystery boxes.
    this._boxes = [];
    for (let i = 0; i < BOXES.length; i++) {
      const box = this._makeBox(BOXES[i], i);
      box.position.set(BOX_X[i], BOX_Y);
      this.panel.addChild(box);
      this._boxes.push(box);
    }

    // Reveal group (icon + name + amount + shine + congrats), shown when a box opens.
    this._reveal = new PIXI.Container();
    this._reveal.position.set(0, BOX_Y);
    this._reveal.visible = false;
    this.panel.addChild(this._reveal);

    // "Watch a video to double it" — appears first; the plain Claim fades in ~2s later.
    this._doubleBtn = this._makeButton(`📺  ${t("double_it")}`, 380, 96, 0, 170, 0x2f9e6a, () => this._double());
    this._doubleBtn.visible = false;
    this.panel.addChild(this._doubleBtn);

    this._claimBtn = this._makeButton(t("claim"), 300, 88, 0, 290, 0x4d8dff, () => this._take(1));
    this._claimBtn.visible = false;
    this.panel.addChild(this._claimBtn);

    // Transient toast ("ad not available").
    this.toast = new PIXI.Text("", {
      fontFamily: "Arial", fontSize: 32, fontWeight: "800", fill: 0xffffff,
      stroke: 0x1a2140, strokeThickness: 5, align: "center",
    });
    this.toast.anchor.set(0.5);
    this.toast.position.set(0, 400);
    this.toast.alpha = 0;
    this.panel.addChild(this.toast);

    // Back button — only during the pick phase (before a box is opened).
    this._backBtn = this._makeButton(t("btn_back"), 220, 74, 0, 480, 0x3a4a72, () => this._close());
    this.panel.addChild(this._backBtn);

    // Prize flight layer (on top of everything).
    this.fxLayer = new PIXI.Container();
    this.addChild(this.fxLayer);
  }

  _makeBox(colors, index) {
    const c = new PIXI.Container();
    const bw = 150, bh = 128, lidH = 46;
    // Body.
    const body = new PIXI.Graphics();
    body.beginFill(colors.body).drawRoundedRect(-bw / 2, -bh / 2 + lidH - 8, bw, bh - lidH + 8, 14).endFill();
    body.lineStyle(4, 0xffffff, 0.25).drawRoundedRect(-bw / 2, -bh / 2 + lidH - 8, bw, bh - lidH + 8, 14);
    c.addChild(body);
    // Vertical ribbon down the body.
    const ribbon = new PIXI.Graphics();
    ribbon.beginFill(0xffe27a, 0.9).drawRect(-14, -bh / 2 + lidH - 8, 28, bh - lidH + 8).endFill();
    c.addChild(ribbon);
    // Lid (lifts on open).
    const lid = new PIXI.Container();
    const lg = new PIXI.Graphics();
    lg.beginFill(colors.lid).drawRoundedRect(-bw / 2 - 8, -bh / 2, bw + 16, lidH, 12).endFill();
    lg.lineStyle(4, 0xffffff, 0.3).drawRoundedRect(-bw / 2 - 8, -bh / 2, bw + 16, lidH, 12);
    lid.addChild(lg);
    // A little bow knot on the lid.
    const knot = new PIXI.Text("🎀", { fontFamily: "Arial", fontSize: 34 });
    knot.anchor.set(0.5);
    knot.position.set(0, -bh / 2 + lidH / 2);
    lid.addChild(knot);
    c.addChild(lid);
    c.body = body; c.lid = lid;

    c.eventMode = "static";
    c.cursor = "pointer";
    c.hitArea = new PIXI.Rectangle(-bw / 2 - 8, -bh / 2, bw + 16, bh);
    c.on("pointertap", () => this._openBox(index));
    c.on("pointerdown", () => { if (!this._opened) c.scale.set(0.94); });
    c.on("pointerup", () => { if (!this._opened) c.scale.set(1); });
    c.on("pointerupoutside", () => { if (!this._opened) c.scale.set(1); });
    return c;
  }

  _makeButton(label, w, h, cx, cy, color, onClick) {
    const c = new PIXI.Container();
    c.position.set(cx, cy);
    const g = new PIXI.Graphics();
    g.beginFill(color).drawRoundedRect(-w / 2, -h / 2, w, h, h / 2.4).endFill();
    g.lineStyle(4, 0xffffff, 0.35).drawRoundedRect(-w / 2, -h / 2, w, h, h / 2.4);
    const t = new PIXI.Text(label, { fontFamily: "Arial", fontSize: 34, fontWeight: "800", fill: 0xffffff });
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

  // A live coins counter for the top HUD (a gold coin + the balance), refreshed on
  // any wallet change so the prize collect ticks it up on landing.
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

  // ---- reveal --------------------------------------------------------------
  _makeIconFor(prize, size) {
    if (prize.type === "coins") return makeCoinIcon(size);
    const t = new PIXI.Text(PRIZE_EMOJI[prize.type] || "❔", { fontFamily: "Arial", fontSize: size * 1.7 });
    t.anchor.set(0.5);
    return t;
  }

  _makeShine() {
    const g = new PIXI.Graphics();
    const rays = 12, r1 = 30, r2 = 68, wdt = 0.16;
    for (let i = 0; i < rays; i++) {
      const a = (i / rays) * Math.PI * 2;
      g.beginFill(0xffe27a, 0.5);
      g.moveTo(Math.cos(a - wdt) * r1, Math.sin(a - wdt) * r1);
      g.lineTo(Math.cos(a) * r2, Math.sin(a) * r2);
      g.lineTo(Math.cos(a + wdt) * r1, Math.sin(a + wdt) * r1);
      g.closePath();
      g.endFill();
    }
    return g;
  }

  _amountText(prize) {
    return prize.type === "coins" ? `+${prize.amount}` : `×${prize.amount}`;
  }

  _showReveal(prize) {
    const g = this._reveal;
    g.removeChildren();

    const congr = new PIXI.Text(t("congratulations"), {
      fontFamily: "Arial", fontSize: 40, fontWeight: "900", fill: 0xffe27a,
      stroke: 0x5a3a00, strokeThickness: 5,
    });
    congr.anchor.set(0.5);
    congr.position.set(0, -120);
    g.addChild(congr);

    const shine = this._makeShine();
    shine.position.set(0, -6);
    g.addChild(shine);
    this._shine = shine;

    const icon = this._makeIconFor(prize, 46);
    icon.position.set(0, -6);
    g.addChild(icon);
    this._revealIcon = icon;

    const name = new PIXI.Text(itemName(prize.type, prize.amount) || t("item_prize"), {
      fontFamily: "Arial", fontSize: 34, fontWeight: "800", fill: 0xffffff,
      stroke: 0x1a2140, strokeThickness: 4,
    });
    name.anchor.set(0.5);
    name.position.set(0, 62);
    g.addChild(name);
    this._revealName = name;

    const amt = new PIXI.Text(this._amountText(prize), {
      fontFamily: "Arial", fontSize: 40, fontWeight: "900", fill: 0xffffff,
      stroke: 0x14361f, strokeThickness: 5,
    });
    amt.anchor.set(0.5);
    amt.position.set(0, 108);
    g.addChild(amt);
    this._revealAmt = amt;

    // Pops forward over the open box — it is the foreground now.
    g.visible = true;
    g.alpha = 0;
    g.scale.set(0.7);
    tween(this.app.ticker, { duration: 300, ease: easeOutCubic, onUpdate: (e) => { g.alpha = e; } });
    tween(this.app.ticker, { duration: 360, ease: easeOutBack, onUpdate: (e) => g.scale.set(0.7 + 0.3 * e) });

    // The ad ("double it") button appears first...
    this._doubleBtn.visible = true;
    this._doubleBtn.alpha = 0;
    this._doubleBtn.eventMode = "static";
    tween(this.app.ticker, { duration: 300, ease: easeOutCubic, onUpdate: (e) => { this._doubleBtn.alpha = e; } });

    // ...and the plain Claim button fades in about two seconds later.
    this._claimBtn.visible = true;
    this._claimBtn.alpha = 0;
    this._claimBtn.eventMode = "none";
    delay(this.app.ticker, 2000).then(() => {
      if (this._taken || !this.visible) return;
      this._claimBtn.eventMode = "static";
      tween(this.app.ticker, { duration: 300, ease: easeOutCubic, onUpdate: (e) => { this._claimBtn.alpha = e; } });
    });
  }

  // ---- flow ----------------------------------------------------------------
  async _openBox(index) {
    if (this._opened || !this.visible) return;
    if (index < 0 || index >= this._boxes.length) return;
    this._opened = true;
    this._chosen = index;

    // Commit today's claim the moment a box is opened: the single daily draw is
    // now spent, so the lobby button hides and the boxes can't be re-rolled.
    this.user.recordDailyClaim(this._today());
    // Counted at the same moment for the same reason — the claim is committed
    // here, so this is when a Tasks goal watching the daily gift ticks.
    this.user.bumpStat("dailyBonusClaimed");
    this.audio.play("btn_01");

    this._tip.visible = false;
    this._backBtn.visible = false;

    // The reveal sequence runs strictly in order — each beat finishes before the
    // next starts, so the player reads them one at a time rather than as one blur:
    //   1) the two boxes not chosen disappear (they never open),
    //   2) the chosen box slides to centre and lifts its lid,
    //   3) the prize appears in the foreground, on top of the open box,
    //   4) the box fades away behind it, leaving the prize alone on screen.
    const chosen = this._boxes[index];

    // 1) The unchosen boxes drop out first.
    await Promise.all(this._boxes.map((b, i) => {
      if (i === index) return Promise.resolve();
      return tween(this.app.ticker, {
        duration: BOX_DISMISS_MS, ease: easeOutCubic,
        onUpdate: (e) => { b.alpha = 1 - e; b.scale.set(1 - 0.25 * e); },
      }).then(() => { b.visible = false; });
    }));

    // 2) Slide the chosen box to centre + pop it forward...
    const fromX = chosen.x;
    chosen.y = BOX_Y;
    await tween(this.app.ticker, {
      duration: 300, ease: easeOutCubic,
      onUpdate: (e) => { chosen.x = fromX * (1 - e); chosen.scale.set(1 + 0.15 * e); },
    });
    // ...and lift the lid.
    await tween(this.app.ticker, {
      duration: 260, ease: easeOutCubic,
      onUpdate: (e) => { chosen.lid.y = -78 * e; chosen.lid.alpha = 1 - 0.2 * e; },
    });

    // 3) The award comes up in the foreground (the reveal group is above the
    //    boxes in the panel, so it covers the open box).
    this._showReveal(this._prizes[index]);

    // 4) Once the prize is legible, the spent box fades out behind it.
    await delay(this.app.ticker, BOX_HIDE_DELAY_MS);
    if (!this.visible) return;
    await tween(this.app.ticker, {
      duration: BOX_HIDE_MS, ease: easeInCubic,
      onUpdate: (e) => { chosen.alpha = 1 - e; chosen.scale.set(1.15 - 0.3 * e); },
    });
    chosen.visible = false;
  }

  /** Watch a rewarded video to double the prize. Stub — returns immediately.
   *  TODO(SDK): show a real rewarded video and resolve on the completed view. */
  _watchAd() { return this._adResult || "succeed"; }

  async _double() {
    if (!this._opened || this._taken) return;
    const res = this._watchAd();
    if (res === "succeed") {
      this._doubled = true;
      const prize = this._prizes[this._chosen];
      if (this._revealAmt) this._revealAmt.text = this._amountText({ type: prize.type, amount: prize.amount * 2 });
      await this._take(2);
    } else if (res === "fail") {
      this._showToast(t("ad_not_available"));
    }
    // "cancel": nothing spent — the base Claim stays available.
  }

  async _take(multiplier) {
    if (!this._opened || this._taken) return;
    this._taken = true;
    this._doubleBtn.eventMode = "none";
    this._claimBtn.eventMode = "none";

    const prize = this._prizes[this._chosen];
    const total = (prize.amount || 0) * multiplier;
    await this._collect({ type: prize.type, amount: total });
    this._close();
  }

  _grantTarget(prize) {
    const g = PRIZE_GRANT[prize.type];
    if (g && g.booster && this._chips[g.booster]) return this._chips[g.booster];
    return this.coinPill;   // coins + any fallback
  }

  _grant(prize) {
    const g = PRIZE_GRANT[prize.type];
    if (!g) return;
    if (g.cur) this.user.credit(g.cur, prize.amount);
    else if (g.booster) this.user.grantBooster(g.booster, prize.amount);
  }

  async _collect(prize) {
    const target = this._grantTarget(prize);
    let start, end;
    try {
      start = this.fxLayer.toLocal(this._revealIcon.getGlobalPosition());
      end = this.fxLayer.toLocal(target.getGlobalPosition());
    } catch (_) { this._grant(prize); return; }

    const flyer = this._makeIconFor(prize, 34);
    flyer.position.set(start.x, start.y);
    this.fxLayer.addChild(flyer);

    // Arc up-then-in via a quadratic Bézier (matches the wheel's collect).
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
    // Grant on landing so the counter ticks in sync with the visual.
    this._grant(prize);
    this._bump(target);
    if (!flyer.destroyed) flyer.destroy();
  }

  _bump(node) {
    return tween(this.app.ticker, {
      duration: 240, ease: easeOutCubic,
      onUpdate: (e) => node.scale.set(1 + 0.28 * Math.sin(Math.PI * e)),
    });
  }

  /**
   * Re-letter. The panel title and the "Pick a box!" tip carry their keys and
   * refresh themselves; the three buttons and the revealed prize's name are
   * assembled in code, so they are re-read here. The reveal group is rebuilt on
   * every open anyway — this only matters for a language changed while a prize
   * is still on screen.
   */
  relocalize() {
    this._doubleBtn.label.text = `📺  ${t("double_it")}`;
    this._claimBtn.label.text = t("claim");
    this._backBtn.label.text = t("btn_back");
    if (this._revealName && !this._revealName.destroyed && this._opened) {
      const prize = this._prizes && this._prizes[this._chosen];
      if (prize) this._revealName.text = itemName(prize.type, prize.amount) || t("item_prize");
    }
  }

  _showToast(msg) {
    this.toast.text = msg;
    this.toast.alpha = 1;
    tween(this.app.ticker, {
      duration: 1400, ease: easeInCubic,
      onUpdate: (e) => { this.toast.alpha = 1 - e; },
    });
  }

  // ---- open / close / layout ----------------------------------------------
  open() {
    this.checkRollover();
    if (!this.canClaim()) return;

    this.visible = true;

    // Reset the per-open flow state.
    this._opened = false;
    this._chosen = null;
    this._doubled = false;
    this._taken = false;
    this._shine = null;
    this._revealIcon = null;
    this._revealAmt = null;
    this._el = 0;

    // Roll the three boxes up front (each an independent weighted draw).
    this._prizes = this._rollBoxes();

    // Reset visuals to the closed-boxes pick phase.
    this._reveal.visible = false;
    this._reveal.alpha = 1;
    this._reveal.scale.set(1);
    this._reveal.removeChildren();
    this._doubleBtn.visible = false; this._doubleBtn.eventMode = "none";
    this._claimBtn.visible = false; this._claimBtn.eventMode = "none";
    this.toast.alpha = 0;
    this._tip.visible = true;
    this._backBtn.visible = true;
    for (let i = 0; i < this._boxes.length; i++) {
      const b = this._boxes[i];
      b.visible = true; b.alpha = 1;
      b.scale.set(1);
      b.position.set(BOX_X[i], BOX_Y);
      b.lid.y = 0; b.lid.alpha = 1;
    }

    this.app.ticker.add(this._tick);

    // easeOutBack entrance pop.
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
    if (this.onBack) this.onBack();
  }

  layout(DW, DH) {
    this.viewW = DW; this.viewH = DH;
    this.dim.clear();
    this.dim.beginFill(0x040814, 0.82).drawRect(0, 0, DW, DH).endFill();
    this.panel.position.set(DW / 2, DH / 2);
    fitPanel(this.panel, DW, DH);
    this.topHud.position.set((DW - DESIGN_W) / 2, 0);
  }

  // The independent controls this overlay owns (for the resize/overlap test): the
  // centred gift panel plus the top-HUD prize counters (fly targets).
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
