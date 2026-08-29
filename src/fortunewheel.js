// Fortune Wheel — a daily prize wheel shown as an overlay on top of the lobby,
// entered from the lobby's wheel button. Modeled on ShopScene (full-screen dim +
// centred panel + easeOutBack entrance pop + layout(DW,DH) reflow) and, like the
// other overlays, hidden by default. It folds together what the original
// split across a manager and a view: the per-cycle logic (day rollover, group
// rotation, weighted prize pick) and the presentation (the spinning wheel, the
// pointer, the marquee lamps, the prize fly-to-counter).
//
// Persisted per-cycle state lives on the User model (user.fortuneWheel: group /
// day / spinsUsed / won / seen); grants go through user.credit / user.grantBooster
// so they autosave and refresh the HUD counters live. Nothing here is hardcoded:
// the PRIZE TABLE comes from assets/config/turntable.json (passed in as cfg) and
// the slice count is built from the active group, while the feature's GATE and
// PACING (unlock level, spins per cycle, headline prize) come from
// CONFIG.features.fortuneWheel in src/config.js, alongside every other gate.

import { tween, delay, easeInCubic, easeOutCubic, easeInOutQuad, easeOutBack } from "./tween.js";
import { makeCoinIcon } from "./shop.js";
import { fitPanel } from "./layout.js";
import { CONFIG } from "./config.js";

const DESIGN_W = 750;
const DESIGN_H = 1334;

const LAMPS = 16;                    // marquee lamps around the ring (not per-slice)

// The spin-click sound bed. The recording is a complete "clicks fast, then slows
// to a stop" take (~1.15s), which is both shorter than a spin and already carries
// a slow-down of its own — so we loop just its FAST head and drive the loop's
// playback rate from the wheel's live angular speed instead. The clicks then
// accelerate, hold and slow with the wheel it is actually turning, however long
// the spin runs, rather than replaying a canned slow-down mid-spin.
const SPIN_SFX = "wheel_spin";
const SPIN_SFX_LOOP_END = 0.58;      // s — where the recording starts winding down
const SPIN_SFX_MIN_RATE = 0.3;       // click cadence with the wheel nearly stopped

// How each config prize `type` is granted in this port. Coins credit the wallet;
// undo/wand/shuffle grant boosters. There is no Hint or Lightning helper here, so
// Hint is baked into the config as `wand`, and Lightning grants a coins bonus
// (while staying the headline prize — see cfg.headlinePrize).
const PRIZE_GRANT = {
  coins: { cur: "coins" },
  undo: { booster: "undo" },
  wand: { booster: "wand" },
  shuffle: { booster: "shuffle" },
  lightning: { cur: "coins" },
};

// Glyphs for the non-coin prize types (coins use the drawn gold coin icon).
const PRIZE_EMOJI = { undo: "⤺", wand: "🪄", shuffle: "🔀", lightning: "⚡" };

export class FortuneWheelScene extends PIXI.Container {
  constructor(app, audio, user, cfg) {
    super();
    this.app = app;
    this.audio = audio;
    this.user = user;
    this.onBack = null;            // () => void — optional hook when the overlay closes

    // Prize DATA from the JSON config; GATE + PACING from src/config.js.
    cfg = cfg || {};
    this.groups = Array.isArray(cfg.groups) ? cfg.groups : [];
    this.unlockLevel = CONFIG.features.fortuneWheel.unlockLevel;
    this.spinsPerCycle = CONFIG.features.fortuneWheel.spinsPerCycle;
    this.headlinePrize = CONFIG.features.fortuneWheel.headlinePrize;

    // Geometry.
    this._R = 240;
    this._wheelCY = -40;

    // Test / runtime seams.
    this._todayOverride = null;    // force the day-key (day-rollover tests)
    this._forceIndex = null;       // pin the next winning slice (deterministic tests)
    this._adResult = "succeed";    // "succeed" | "cancel" | "fail" (ad-path tests)
    this._spinning = false;
    this._spinSfx = null;          // live handle on the spin-click loop, if any

    this.visible = false;
    this.viewW = DESIGN_W; this.viewH = DESIGN_H;

    this._build();

    // A mid-open day rollover (or any fortuneWheel change while idle) rebuilds the
    // wheel for the now-active group and refreshes the pips / button / won marks.
    this.user.on((domain) => {
      if (domain === "fortuneWheel" && this.visible && !this._spinning) {
        this._rebuild();
        this._refreshPips();
        this._refreshSpinBtn();
        this._refreshWon();
      }
    });
  }

  // ---- persisted-cycle logic ----------------------------------------------
  _today() {
    if (this._todayOverride) return this._todayOverride;
    const d = new Date();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const da = String(d.getDate()).padStart(2, "0");
    return `${d.getFullYear()}-${m}-${da}`;
  }

  /** Advance to a fresh daily cycle if the calendar day changed since the stored
   *  one. Gated on the feature being unlocked so a locked, low-level player's
   *  state isn't cycled early (mirrors the isOpen()/initLuckWheelData gate).
   *  Also handles the very first cycle (stored day "" -> group 0 becomes 1). */
  checkRollover() {
    if (this.user.progress.level < this.unlockLevel) return;
    const today = this._today();
    if (this.user.wheelDay() !== today) {
      this.user.advanceWheelCycle(today, this.groups.length || 1);
    }
  }

  canSpin() { return this.user.wheelSpinsUsed() < this.spinsPerCycle; }

  /** Prizes of the active group (1-based group -> 0-based array). */
  currentPrizes() {
    const g = this.user.wheelGroup() || 1;
    return this.groups[g - 1] || [];
  }

  // ---- build ---------------------------------------------------------------
  _build() {
    // Full-screen dim that also swallows taps meant for the lobby beneath.
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
    // Coin counter (also the fly target for coins + the lightning headline).
    this.coinPill = this._makeCoinCounter();
    this.coinPill.position.set(DESIGN_W - 150, 84);
    this.topHud.addChild(this.coinPill);

    // Centred panel that holds the wheel + chrome (pivot at centre for the pop).
    this.panel = new PIXI.Container();
    this.panel.position.set(DESIGN_W / 2, DESIGN_H / 2);
    this.addChild(this.panel);

    const title = new PIXI.Text("Fortune Wheel", {
      fontFamily: "Arial", fontSize: 64, fontWeight: "900", fill: 0xffe27a,
      stroke: 0x5a3a00, strokeThickness: 7,
    });
    title.anchor.set(0.5);
    title.position.set(0, -540);
    this.panel.addChild(title);

    // Highlight glow ring for the headline prize (hidden until it lands).
    this.glow = new PIXI.Graphics();
    this.glow.lineStyle(16, 0xffef9f, 0.9).drawCircle(0, 0, this._R + 12);
    this.glow.position.set(0, this._wheelCY);
    this.glow.alpha = 0;
    this.panel.addChild(this.glow);

    // The wheel itself (slices are (re)built per active group).
    this.wheel = new PIXI.Container();
    this.wheel.position.set(0, this._wheelCY);
    this.panel.addChild(this.wheel);

    // Marquee lamp ring.
    this.lampLayer = new PIXI.Container();
    this.lampLayer.position.set(0, this._wheelCY);
    this.panel.addChild(this.lampLayer);
    this._lamps = [];
    for (let i = 0; i < LAMPS; i++) {
      const a = (i / LAMPS) * Math.PI * 2;
      const g = new PIXI.Graphics();
      g.beginFill(0xffe27a).drawCircle(0, 0, 8).endFill();
      g.lineStyle(2, 0x8a6a10, 0.8).drawCircle(0, 0, 8);
      g.position.set(Math.cos(a) * (this._R + 22), Math.sin(a) * (this._R + 22));
      this.lampLayer.addChild(g);
      this._lamps.push(g);
    }
    this._lampMode = "idle";
    this._lampEl = 0;
    this._lampTick = () => { this._lampEl += this.app.ticker.deltaMS; this._paintLamps(); };

    // Pointer at the top of the wheel — its tip touches the wheel's top edge and
    // it deflects (rotates about the tip) as the wheel spins under it.
    this.pointer = new PIXI.Graphics();
    this.pointer.beginFill(0xff5252).moveTo(0, 0).lineTo(-20, -38).lineTo(20, -38).lineTo(0, 0).endFill();
    this.pointer.lineStyle(3, 0xffffff, 0.7).moveTo(0, 0).lineTo(-20, -38).lineTo(20, -38).lineTo(0, 0);
    this.pointer.position.set(0, this._wheelCY - this._R + 6);
    this.panel.addChild(this.pointer);

    // Spin button.
    this._spinBtn = this._makeSpinButton();
    this._spinBtn.position.set(0, 270);
    this.panel.addChild(this._spinBtn);

    // Spin pips — one per spin in the cycle; used ones dim out.
    this.pipRow = new PIXI.Container();
    this.pipRow.position.set(0, 360);
    this.panel.addChild(this.pipRow);
    this._pips = [];
    const gap = 44;
    for (let i = 0; i < this.spinsPerCycle; i++) {
      const p = new PIXI.Graphics();
      p.beginFill(0xffe27a).drawCircle(0, 0, 11).endFill();
      p.lineStyle(2, 0xffffff, 0.4).drawCircle(0, 0, 11);
      p.position.set((i - (this.spinsPerCycle - 1) / 2) * gap, 0);
      this.pipRow.addChild(p);
      this._pips.push(p);
    }

    // A transient toast for "ad not available".
    this.toast = new PIXI.Text("", {
      fontFamily: "Arial", fontSize: 34, fontWeight: "800", fill: 0xffffff,
      stroke: 0x1a2140, strokeThickness: 5, align: "center",
    });
    this.toast.anchor.set(0.5);
    this.toast.position.set(0, 150);
    this.toast.alpha = 0;
    this.panel.addChild(this.toast);

    // Back button.
    const back = this._makeButton("Back", 260, 78, 0, 470, 0x4d8dff, () => this._back());
    this.panel.addChild(back);

    // Prize flight layer (on top of everything). Flyers are placed in its space
    // via global projection, so its own position doesn't matter.
    this.fxLayer = new PIXI.Container();
    this.addChild(this.fxLayer);
  }

  _makeSpinButton() {
    const c = new PIXI.Container();
    const w = 320, h = 108;
    const g = new PIXI.Graphics();
    g.beginFill(0x2f9e6a).drawRoundedRect(-w / 2, -h / 2, w, h, h / 2.6).endFill();
    g.beginFill(0x39c06a).drawRoundedRect(-w / 2, -h / 2, w, h - 10, h / 2.6).endFill();
    g.lineStyle(5, 0xffffff, 0.4).drawRoundedRect(-w / 2, -h / 2, w, h, h / 2.6);
    const label = new PIXI.Text("FREE SPIN", {
      fontFamily: "Arial", fontSize: 40, fontWeight: "900", fill: 0xffffff,
      stroke: 0x1c5c39, strokeThickness: 5,
    });
    label.anchor.set(0.5);
    c.addChild(g, label);
    c.label = label;
    c.eventMode = "static";
    c.cursor = "pointer";
    c.on("pointertap", () => { this.audio.play("btn_01"); this.spin(); });
    c.on("pointerdown", () => c.scale.set(0.95));
    c.on("pointerup", () => c.scale.set(1));
    c.on("pointerupoutside", () => c.scale.set(1));
    return c;
  }

  _makeButton(label, w, h, cx, cy, color, onClick) {
    const c = new PIXI.Container();
    c.position.set(cx, cy);
    const g = new PIXI.Graphics();
    g.beginFill(color).drawRoundedRect(-w / 2, -h / 2, w, h, h / 2.4).endFill();
    g.lineStyle(4, 0xffffff, 0.35).drawRoundedRect(-w / 2, -h / 2, w, h, h / 2.4);
    const t = new PIXI.Text(label, { fontFamily: "Arial", fontSize: 32, fontWeight: "800", fill: 0xffffff });
    t.anchor.set(0.5);
    c.addChild(g, t);
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

  // ---- wheel rendering -----------------------------------------------------
  _makeIconFor(prize, size) {
    if (prize.type === "coins") return makeCoinIcon(size);
    const t = new PIXI.Text(PRIZE_EMOJI[prize.type] || "❔", { fontFamily: "Arial", fontSize: size * 1.7 });
    t.anchor.set(0.5);
    return t;
  }

  _rebuild() { this._buildWheel(this.currentPrizes()); }

  _buildWheel(prizes) {
    this.wheel.removeChildren();
    this.wheel.rotation = 0;
    this._slices = [];
    const n = prizes.length;
    if (!n) return;
    const R = this._R;
    const sa = (Math.PI * 2) / n;
    const COLORS = [0x3d51a0, 0x2c3c7a];
    for (let i = 0; i < n; i++) {
      const prize = prizes[i];
      const center = i * sa;             // slice 0 centred at local angle 0 (to the right)
      const a0 = center - sa / 2, a1 = center + sa / 2;

      const g = new PIXI.Graphics();
      g.beginFill(COLORS[i % 2]).moveTo(0, 0).arc(0, 0, R, a0, a1).lineTo(0, 0).endFill();
      g.lineStyle(3, 0xffffff, 0.18).moveTo(0, 0).arc(0, 0, R, a0, a1).lineTo(0, 0);
      this.wheel.addChild(g);

      // Radial content: icon + amount along the slice's centre spoke.
      const content = new PIXI.Container();
      content.rotation = center;
      const icon = this._makeIconFor(prize, 30);
      icon.position.set(R * 0.58, 0);
      content.addChild(icon);
      const amt = new PIXI.Text(`x${prize.amount}`, {
        fontFamily: "Arial", fontSize: 26, fontWeight: "900", fill: 0xffffff,
        stroke: 0x1a2140, strokeThickness: 4,
      });
      amt.anchor.set(0.5); amt.position.set(R * 0.85, 0);
      content.addChild(amt);
      this.wheel.addChild(content);

      // "Already won" mark — a darkening wedge + a check, hidden until won.
      const markC = new PIXI.Container();
      const mg = new PIXI.Graphics();
      mg.beginFill(0x02030a, 0.6).moveTo(0, 0).arc(0, 0, R, a0, a1).lineTo(0, 0).endFill();
      markC.addChild(mg);
      const chk = new PIXI.Text("✓", { fontFamily: "Arial", fontSize: 40, fontWeight: "900", fill: 0x66ff9e });
      chk.anchor.set(0.5);
      chk.position.set(Math.cos(center) * R * 0.58, Math.sin(center) * R * 0.58);
      markC.addChild(chk);
      markC.visible = false;
      this.wheel.addChild(markC);

      this._slices.push({ prize, icon, mark: markC });
    }

    // Centre hub cap hides the wedge seams.
    const hub = new PIXI.Graphics();
    hub.beginFill(0x1a2450).drawCircle(0, 0, R * 0.17).endFill();
    hub.lineStyle(4, 0xffe27a, 0.9).drawCircle(0, 0, R * 0.17);
    this.wheel.addChild(hub);
  }

  // ---- lamps ---------------------------------------------------------------
  _setLamps(mode) { this._lampMode = mode; this._lampEl = 0; this._paintLamps(); }

  _paintLamps() {
    const el = this._lampEl;
    if (this._lampMode === "spin") {
      const head = (el / 55) % LAMPS;           // a chaser with a fading tail
      for (let i = 0; i < LAMPS; i++) {
        let dist = head - i; while (dist < 0) dist += LAMPS;
        this._lamps[i].alpha = Math.max(0.12, 1 - dist * 0.16);
      }
    } else if (this._lampMode === "win") {
      const on = Math.floor(el / 150) % 2 === 0; // all flash together, fast
      for (const l of this._lamps) l.alpha = on ? 1 : 0.18;
    } else {                                     // idle: alternate slow blink
      const phase = Math.floor(el / 420) % 2;
      for (let i = 0; i < LAMPS; i++) this._lamps[i].alpha = (i % 2 === phase) ? 1 : 0.28;
    }
  }

  // ---- HUD refresh ---------------------------------------------------------
  _refreshPips() {
    const used = this.user.wheelSpinsUsed();
    for (let i = 0; i < this._pips.length; i++) this._pips[i].alpha = i < used ? 0.22 : 1;
  }

  _refreshSpinBtn() {
    const free = this.user.wheelSpinsUsed() === 0;
    this._spinBtn.label.text = free ? "FREE SPIN" : "📺  SPIN";
    const ok = this.canSpin();
    this._spinBtn.eventMode = ok ? "static" : "none";
    this._spinBtn.alpha = ok ? 1 : 0.5;
  }

  _refreshWon() {
    if (!this._slices) return;
    const won = this.user.wheelWon();
    for (let i = 0; i < this._slices.length; i++) this._slices[i].mark.visible = won.includes(i);
  }

  // ---- spin flow -----------------------------------------------------------
  /** Watch a rewarded video for an ad spin. Stub — returns immediately.
   *  TODO(SDK): show a real rewarded video and resolve on the completed view
   *  (FBInstant.getRewardedVideoAsync / Telegram / Devvit ad units). */
  _watchAd() { return this._adResult || "succeed"; }

  /** Take a spin. Returns a promise that resolves once the wheel has settled and
   *  the prize is collected. Inert while a spin (or its ad) is in flight, and once
   *  the cycle's spins are used up. */
  async spin() {
    if (this._spinning) return;
    this.checkRollover();
    if (!this.canSpin()) return;
    this._spinning = true;
    try {
      const isFree = this.user.wheelSpinsUsed() === 0;
      if (isFree) {
        await this._runSpin(true);
      } else {
        const res = this._watchAd();
        if (res === "succeed") await this._runSpin(false);
        else if (res === "fail") this._showToast("Ad not available");
        // "cancel": nothing spent, no message.
      }
    } finally {
      this._spinning = false;
    }
  }

  /** Choose a winning slice INDEX from the not-yet-won pool by weighted random
   *  (free vs ad weights). Returns null if the pool is empty (graceful abort). */
  _pickPrize(isFree, prizes) {
    const won = this.user.wheelWon();
    const pool = [];
    for (let i = 0; i < prizes.length; i++) if (!won.includes(i)) pool.push(i);
    if (!pool.length) return null;
    if (this._forceIndex != null && pool.includes(this._forceIndex)) {
      const f = this._forceIndex; this._forceIndex = null; return f;
    }
    let total = 0;
    const weights = pool.map((i) => {
      const w = Math.max(0, (isFree ? prizes[i].freeWeight : prizes[i].adWeight) || 0);
      total += w; return w;
    });
    if (total <= 0) return pool[0];
    let r = Math.random() * total;
    for (let k = 0; k < pool.length; k++) { r -= weights[k]; if (r < 0) return pool[k]; }
    return pool[pool.length - 1];
  }

  async _runSpin(isFree) {
    const prizes = this.currentPrizes();
    if (!prizes.length) { console.error("[fortunewheel] active group has no prizes"); return; }
    const idx = this._pickPrize(isFree, prizes);
    if (idx == null) { console.error("[fortunewheel] empty prize pool — nothing to win"); return; }
    const prize = prizes[idx];

    // Record BEFORE the wheel turns: spend the spin + mark the slice won, so a
    // rapid double-tap can't spend two spins and this prize can't repeat.
    this.user.recordWheelSpin(idx);
    // A Tasks goal watches wheel spins; count it with the spend, not with the
    // landing, so an interrupted animation can't lose it.
    this.user.bumpStat("wheelSpins");
    this._reportSpin(this.user.wheelSpinsUsed(), prize);
    this._refreshPips();
    this._refreshSpinBtn();

    this._setLamps("spin");
    await this._spinWheelTo(idx, prizes.length);
    this._setLamps("win");
    await this._collect(idx, prize);
    this._refreshWon();
    this._setLamps("idle");
    this.pointer.rotation = 0;

    // Last spin of the cycle: collect fully, then close back to the lobby rather
    // than leaving a dead button.
    if (!this.canSpin()) { await delay(this.app.ticker, 280); this._back(); }
  }

  /** Report a spin to analytics. Stub — TODO(SDK): report 'CK_Spin_Get'
   *  with the 1-based spin number and the reward. */
  _reportSpin(spinNumber, prize) {
    try { console.debug(`[fortunewheel] spin #${spinNumber}: ${prize.type} x${prize.amount}`); } catch (_) {}
  }

  /** Spin the wheel through accelerate -> hold -> decelerate, landing the chosen
   *  slice cleanly under the top pointer. The result is already decided; this only
   *  animates to it. */
  async _spinWheelTo(idx, n) {
    const twoPi = Math.PI * 2;
    const sa = twoPi / n;
    const thetaTarget = -Math.PI / 2 - idx * sa;   // brings slice idx to the top
    const cur = this.wheel.rotation;
    const S = 12;                                  // peak angular speed (rad/s)
    const turns = 4;

    const base = cur + turns * twoPi;
    const tgtMod = ((thetaTarget % twoPi) + twoPi) % twoPi;
    const baseMod = ((base % twoPi) + twoPi) % twoPi;
    let deltaAng = tgtMod - baseMod; if (deltaAng < 0) deltaAng += twoPi;
    const final = base + deltaAng;
    const sweep = final - cur;

    const d1 = 0.5, d3 = 1.4;                      // accel / decel durations (s)
    const accelDist = S * d1 / 2;                  // easeIn: area under a 0->S ramp
    const decelDist = S * d3 / 2;                  // easeOut: area under an S->0 ramp
    const holdDist = Math.max(0, sweep - accelDist - decelDist);
    const d2 = holdDist / S;

    const p1 = cur + accelDist;
    const p2 = p1 + holdDist;

    this._refSpeed = S;
    this._startSpinSfx();
    try {
      await this._rotSeg(cur, p1, d1 * 1000, easeInCubic);
      if (d2 > 0) await this._rotSeg(p1, p2, d2 * 1000, (t) => t);
      await this._rotSeg(p2, final, d3 * 1000, easeOutCubic);
    } finally {
      this._stopSpinSfx();             // never leave the loop running on an abort
    }
    this.wheel.rotation = final;
    this._updatePointer(0);
  }

  _rotSeg(from, to, dur, ease) {
    let prev = from;
    return tween(this.app.ticker, {
      duration: Math.max(1, dur), ease,
      onUpdate: (e) => {
        const r = from + (to - from) * e;
        const dt = Math.max(1, this.app.ticker.deltaMS) / 1000;
        const speed = (r - prev) / dt; prev = r;   // signed: sign = spin direction
        this.wheel.rotation = r;
        this._updatePointer(speed);
        this._updateSpinSfx(speed);
      },
    });
  }

  // ---- spin sound ----------------------------------------------------------
  _startSpinSfx() {
    this._stopSpinSfx();               // paranoia: never stack two beds
    this._spinSfx = this.audio.playLoop(SPIN_SFX, { loopEnd: SPIN_SFX_LOOP_END });
  }

  // The clicks ride the wheel's live speed: full cadence at peak, thinning out to
  // a sparse tick as it settles — the same signal the pointer's lean reads.
  _updateSpinSfx(speed) {
    if (!this._spinSfx || this._spinSfx.stopped) return;   // sound switched off mid-spin
    const ratio = Math.min(1, Math.abs(speed) / (this._refSpeed || 12));
    this._spinSfx.setRate(SPIN_SFX_MIN_RATE + (1 - SPIN_SFX_MIN_RATE) * ratio);
  }

  _stopSpinSfx() {
    if (this._spinSfx) { this._spinSfx.stop(); this._spinSfx = null; }
  }

  // Pointer deflects hard while the wheel is fast, easing back to centre as it
  // slows — a little rattle at high speed sells the contact. It leans WITH the
  // spin: the pointer is a triangle whose tip sits on the wheel's top rim and
  // which pivots about that tip, so the rim dragging the tip sideways swings the
  // body the other way. A clockwise wheel (rotation increasing) moves the rim to
  // the right at the top, which is a negative (counter-clockwise) pointer
  // rotation — hence the sign flip against `speed`.
  _updatePointer(speed) {
    const ratio = Math.max(-1, Math.min(1, speed / (this._refSpeed || 12)));
    let d = -0.42 * ratio;
    if (Math.abs(ratio) > 0.8) { this._jit = (this._jit || 0) + 1; d += (this._jit % 2 ? 0.05 : -0.05); }
    this.pointer.rotation = d;
  }

  _grantTarget(prize) {
    const g = PRIZE_GRANT[prize.type];
    if (g && g.booster && this._chips[g.booster]) return this._chips[g.booster];
    return this.coinPill;   // coins, the lightning headline, and any fallback
  }

  _grant(prize) {
    const g = PRIZE_GRANT[prize.type];
    if (!g) return;
    if (g.cur) this.user.credit(g.cur, prize.amount);
    else if (g.booster) this.user.grantBooster(g.booster, prize.amount);
  }

  async _collect(idx, prize) {
    const slice = this._slices[idx];
    const headline = prize.type === this.headlinePrize;
    if (headline) await this._fadeGlow(1);

    const start = this.fxLayer.toLocal(slice.icon.getGlobalPosition());
    const target = this._grantTarget(prize);
    const end = this.fxLayer.toLocal(target.getGlobalPosition());

    const flyer = this._makeIconFor(prize, 34);
    flyer.position.set(start.x, start.y);
    this.fxLayer.addChild(flyer);

    // Arc up-then-in via a quadratic Bézier (see game.js autoComplete).
    const C = { x: (start.x + end.x) / 2, y: Math.min(start.y, end.y) - 150 };
    await tween(this.app.ticker, {
      duration: 540, ease: easeInOutQuad,
      onUpdate: (e) => {
        const u = 1 - e;
        flyer.x = u * u * start.x + 2 * u * e * C.x + e * e * end.x;
        flyer.y = u * u * start.y + 2 * u * e * C.y + e * e * end.y;
        flyer.scale.set(1 - 0.35 * e);
      },
    });
    // Grant on landing so the counter ticks in sync with the visual.
    this._grant(prize);
    this._bump(target);
    if (!flyer.destroyed) flyer.destroy();

    if (headline) { await delay(this.app.ticker, 400); await this._fadeGlow(0); }
  }

  _bump(node) {
    return tween(this.app.ticker, {
      duration: 240, ease: easeOutCubic,
      onUpdate: (e) => node.scale.set(1 + 0.28 * Math.sin(Math.PI * e)),
    });
  }

  _fadeGlow(to) {
    const from = this.glow.alpha;
    return tween(this.app.ticker, {
      duration: 250, ease: easeOutCubic,
      onUpdate: (e) => { this.glow.alpha = from + (to - from) * e; },
    });
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
    this.visible = true;
    this.user.markWheelSeen();
    this.checkRollover();
    this._rebuild();
    this._refreshPips();
    this._refreshSpinBtn();
    this._refreshWon();
    this._setLamps("idle");
    this.pointer.rotation = 0;
    this.app.ticker.add(this._lampTick);

    this.panel.scale.set(0.6);
    tween(this.app.ticker, {
      duration: 300, ease: easeOutBack,
      onUpdate: (e) => this.panel.scale.set(0.6 + 0.4 * e),
    });
  }

  _back() {
    if (!this.visible) return;
    this.audio.play("btn_01");
    this.visible = false;
    this._stopSpinSfx();           // the bed must not outlive the closed overlay
    this.app.ticker.remove(this._lampTick);
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
  // centred wheel panel plus the top-HUD prize counters (fly targets).
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
