// Lobby / home screen — shown on load and after each completed level.
// Displays the game title and a big centred "Level <n>" button that starts the
// next level the player is on. Styled to match the in-game chrome (rounded
// buttons, same palette + backgrounds) in the spirit of the original Cocos game.

import { tween, easeOutBack } from "./tween.js";
import { makeCogButton } from "./settings.js";
import { makeCoinPill } from "./shop.js";
import { buildColumnBackground, fitTextWidth } from "./layout.js";
import { FeatureRail, RAIL_LEFT_X } from "./featurerail.js";

const DESIGN_W = 750;
const DESIGN_H = 1334;

// The corner chrome (settings cog / fortune-wheel / daily-bonus buttons) occupies
// a column on the left up to ~x155 (button + caption). Keep the centred title and
// subtitle inside the clear centre band so wide text can never overlap that column,
// no matter how far the vertically-centred UI block slides on a tall screen.
const CHROME_COL = 175;
const CENTER_MAX_W = DESIGN_W - 2 * CHROME_COL; // 400

export class LobbyScene extends PIXI.Container {
  constructor(app, backgrounds, audio, maxLevel, user) {
    super();
    this.app = app;
    this.backgrounds = backgrounds; // { 1: tex, 2: tex, 3: tex }
    this.audio = audio;
    this.maxLevel = maxLevel;
    this.user = user;       // player profile — for the coin balance pill
    this.fortuneWheel = null; // the FortuneWheelScene (set by the host) — for gating/badges
    this.dailyBonus = null; // the DailyBonusScene (set by the host) — for gating
    this.onPlay = null;     // (levelNum) => void
    this.onSettings = null; // () => void — open the settings screen
    this.onShop = null;     // () => void — open the shop screen
    this.onFortuneWheel = null; // () => void — open the fortune wheel
    this.onDailyBonus = null; // () => void — open the daily bonus

    // Responsive layout state (updated by layout()); defaults to the base design.
    this.viewW = DESIGN_W; this.viewH = DESIGN_H;

    this.bgLayer = new PIXI.Container();
    this.uiLayer = new PIXI.Container();
    this.topHud  = new PIXI.Container(); // pinned to the screen's top edge
    this.addChild(this.bgLayer, this.uiLayer, this.topHud);

    this._buildStatic();
  }

  // Reflow into a DW×DH design area: centre the UI block in the safe area and
  // extend the background to cover the whole view (see GameScene.layout).
  layout(DW, DH) {
    this.viewW = DW; this.viewH = DH;
    this.uiLayer.position.set((DW - DESIGN_W) / 2, (DH - DESIGN_H) / 2);
    this.topHud.position.set((DW - DESIGN_W) / 2, 0);
    if (this.visible) this._buildBackground(this._level);
  }

  // The independent interface controls this scene owns, for the resize/overlap
  // regression test (see window.__game.controls). Decorative children (badges,
  // captions) count as part of their parent button, so only top-level controls
  // are listed; only currently-visible ones are reported by the caller.
  controls() {
    return [
      { name: "title", obj: this.title },
      { name: "subtitle", obj: this.subtitle },
      { name: "fruits", obj: this.fruits },
      { name: "playBtn", obj: this.playBtn },
      { name: "hint", obj: this.hint },
      { name: "cog", obj: this.cog },
      { name: "coinPill", obj: this.coinPill },
      { name: "wheelBtn", obj: this.wheelBtn },
      { name: "dailyBtn", obj: this.dailyBtn },
    ];
  }

  _buildStatic() {
    // Title block
    this.title = new PIXI.Text("TILE MATCH 3", {
      fontFamily: "Arial", fontSize: 82, fontWeight: "900", fill: 0xffe27a,
      stroke: 0x5a3a00, strokeThickness: 9, align: "center",
    });
    this.title.anchor.set(0.5);
    this.title.position.set(DESIGN_W / 2, 330);
    fitTextWidth(this.title, CENTER_MAX_W); // keep clear of the left chrome column
    this.uiLayer.addChild(this.title);

    this.subtitle = new PIXI.Text("Match 3 fruits · clear the board", {
      fontFamily: "Arial", fontSize: 32, fontWeight: "700", fill: 0xdce7ff,
      stroke: 0x122043, strokeThickness: 4,
    });
    this.subtitle.anchor.set(0.5);
    this.subtitle.position.set(DESIGN_W / 2, 420);
    fitTextWidth(this.subtitle, CENTER_MAX_W);
    this.uiLayer.addChild(this.subtitle);

    // A little fruity flourish
    const fruits = new PIXI.Text("🍉  🍓  🍊  🍇  🍋", { fontFamily: "Arial", fontSize: 60 });
    fruits.anchor.set(0.5);
    fruits.position.set(DESIGN_W / 2, 520);
    this.uiLayer.addChild(fruits);
    this.fruits = fruits;

    // Big centred play button
    this.playBtn = this._makePlayButton();
    this.playBtn.position.set(DESIGN_W / 2, 820);
    this.uiLayer.addChild(this.playBtn);

    this.hint = new PIXI.Text("Tap to start", {
      fontFamily: "Arial", fontSize: 26, fontWeight: "700", fill: 0xaebfe0,
    });
    this.hint.anchor.set(0.5);
    this.hint.position.set(DESIGN_W / 2, 960);
    this.uiLayer.addChild(this.hint);

    // Settings (cog) — top-left. Opens the settings screen via the host.
    const cog = makeCogButton(this.audio, () => this.onSettings && this.onSettings());
    cog.position.set(60, 84);
    this.topHud.addChild(cog);
    this.cog = cog;

    // Coin balance pill — top-right, mirroring the cog. Tapping it opens the shop.
    this.coinPill = makeCoinPill(this.user, () => this.onShop && this.onShop());
    this.coinPill.position.set(DESIGN_W - 108, 84);
    this.topHud.addChild(this.coinPill);

    // Fortune Wheel entry button — a self-animating little wheel in the top-left
    // corner (on topHud so it tracks the corner on tall screens, like the cog).
    // Gated on progression + daily spins remaining, with "new" and "free spin"
    // badges (see _updateWheelBadges / _startWheelSpin).
    this.wheelBtn = this._makeWheelButton();
    this.wheelBtn.visible = false;
    this.topHud.addChild(this.wheelBtn);
    this._startWheelSpin();

    // Daily Bonus entry button — a gently pulsing gift. It only appears while
    // today's gift is unclaimed (no separate red-dot — the pulse IS the
    // indicator) and hides the moment it's claimed, returning at the next
    // calendar-day rollover.
    this.dailyBtn = this._makeDailyButton();
    this.dailyBtn.visible = false;
    this.topHud.addChild(this.dailyBtn);
    this._startDailyPulse();

    // Neither button owns a position: they are entries on the left-edge FEATURE
    // RAIL, which packs whichever ones are available into consecutive slots in
    // THIS registration order — Free Spin first, Daily Bonus second — and
    // animates them between slots as availability changes (see featurerail.js).
    this.rail = new FeatureRail(this.app.ticker, { x: RAIL_LEFT_X });
    this.rail.add("freeSpin", this.wheelBtn, () => this._freeSpinAvailable());
    this.rail.add("dailyBonus", this.dailyBtn, () => this._dailyBonusAvailable());

    // Keep the rail live: progression unlocks features, a wheel spin / rollover
    // changes the free-spin badge, and a daily claim retires the gift.
    this.user.on((domain) => {
      if (domain === "fortuneWheel" || domain === "dailyBonus" || domain === "progress") {
        this.refreshFeatures();
      }
    });
  }

  _makeWheelButton() {
    const c = new PIXI.Container();
    const bg = new PIXI.Graphics();
    bg.beginFill(0x22335e).drawCircle(0, 0, 54).endFill();
    bg.lineStyle(5, 0xffe27a, 0.9).drawCircle(0, 0, 54);
    c.addChild(bg);

    // The spinning wheel graphic (six alternating sectors).
    const wheelG = new PIXI.Graphics();
    const seg = 6;
    for (let i = 0; i < seg; i++) {
      const a0 = (i / seg) * Math.PI * 2, a1 = ((i + 1) / seg) * Math.PI * 2;
      wheelG.beginFill(i % 2 ? 0x39c06a : 0xffcb2e).moveTo(0, 0).arc(0, 0, 40, a0, a1).lineTo(0, 0).endFill();
    }
    c.addChild(wheelG);
    c.wheelG = wheelG;
    const hub = new PIXI.Graphics();
    hub.beginFill(0xffffff).drawCircle(0, 0, 9).endFill();
    c.addChild(hub);

    // Pointer at the top — flicks against the wheel during the self-animation.
    const ptr = new PIXI.Graphics();
    ptr.beginFill(0xff5252).moveTo(0, 0).lineTo(-9, -17).lineTo(9, -17).lineTo(0, 0).endFill();
    ptr.position.set(0, -39);
    c.addChild(ptr);
    c.ptr = ptr;

    const cap = new PIXI.Text("Free Spin", {
      fontFamily: "Arial", fontSize: 22, fontWeight: "900", fill: 0xffe27a,
      stroke: 0x5a3a00, strokeThickness: 4,
    });
    cap.anchor.set(0.5);
    cap.position.set(0, 74);
    c.addChild(cap);

    // "new" badge (until first-ever open) — top-right.
    const newBadge = new PIXI.Container();
    const nbg = new PIXI.Graphics();
    nbg.beginFill(0xff3b3b).drawRoundedRect(-25, -15, 50, 30, 14).endFill();
    nbg.lineStyle(3, 0xffffff, 0.8).drawRoundedRect(-25, -15, 50, 30, 14);
    const ntx = new PIXI.Text("NEW", { fontFamily: "Arial", fontSize: 17, fontWeight: "900", fill: 0xffffff });
    ntx.anchor.set(0.5);
    newBadge.addChild(nbg, ntx);
    newBadge.position.set(43, -43);
    c.addChild(newBadge);
    c.newBadge = newBadge;

    // "free spin available" badge — top-left.
    const freeBadge = new PIXI.Container();
    const fbg = new PIXI.Graphics();
    fbg.beginFill(0x2f9e6a).drawCircle(0, 0, 16).endFill();
    fbg.lineStyle(3, 0xffffff, 0.85).drawCircle(0, 0, 16);
    const ftx = new PIXI.Text("★", { fontFamily: "Arial", fontSize: 20, fontWeight: "900", fill: 0xffe27a });
    ftx.anchor.set(0.5);
    freeBadge.addChild(fbg, ftx);
    freeBadge.position.set(-43, -43);
    c.addChild(freeBadge);
    c.freeBadge = freeBadge;

    c.eventMode = "static";
    c.cursor = "pointer";
    c.hitArea = new PIXI.Circle(0, 0, 56);
    c._hover = false;
    c._pressed = false;
    this._wheelBase = 1;
    c.on("pointertap", () => { this.audio.play("btn_01"); this.onFortuneWheel && this.onFortuneWheel(); });
    c.on("pointerover", () => { c._hover = true; });
    c.on("pointerout", () => { c._hover = false; });
    c.on("pointerdown", () => { c._pressed = true; c.scale.set(this._wheelBase * 0.92); });
    c.on("pointerup", () => { c._pressed = false; });
    c.on("pointerupoutside", () => { c._pressed = false; });
    return c;
  }

  // The button's animation. At rest it beats slowly (a gentle grow/shrink, like the
  // daily gift) and swells while hovered. Layered on top, the little wheel does a
  // discrete spin (spin up → hold → wind down, the pointer flicking against it) that
  // fires periodically on its own AND on mouse-over — but a hover won't retrigger a
  // spin that's already in progress.
  _startWheelSpin() {
    if (this._wheelAnim) this.app.ticker.remove(this._wheelAnim);
    let beat = 0, idle = 0, running = false, rt = 0, prevHover = false;
    const fn = () => {
      const btn = this.wheelBtn;
      if (!btn || !btn.visible) { if (btn) btn._hover = false; prevHover = false; return; }
      const dt = this.app.ticker.deltaMS / 1000;
      beat += this.app.ticker.deltaMS;

      // Slow rest-beat, swelling to a steady "active" size while hovered.
      const rest = 1 + 0.05 * Math.sin(beat / 460);
      const target = btn._hover ? 1.10 : rest;
      this._wheelBase += (target - this._wheelBase) * Math.min(1, dt * 10);
      if (!btn._pressed) btn.scale.set(this._wheelBase);

      // Kick off a spin on hover-enter (if not already spinning) or after an idle wait.
      const hoverEnter = btn._hover && !prevHover;
      prevHover = btn._hover;
      if (!running) {
        idle += dt;
        if (hoverEnter || idle >= 5) { running = true; rt = 0; idle = 0; }
        else return;
      }
      rt += dt;
      let vel; // deg/s
      if (rt <= 0.25) { vel = 900 * (rt / 0.25); btn.ptr.rotation = Math.min(btn.ptr.rotation + 3 * dt, 0.5); }
      else if (rt <= 1.25) { vel = 900; btn.ptr.rotation = 0.5 + Math.sin(rt * 40) * 0.05; }
      else if (rt <= 1.9) { vel = 900 * (1 - (rt - 1.25) / 0.65); btn.ptr.rotation = Math.max(0, btn.ptr.rotation - 2 * dt); }
      else { running = false; idle = 0; btn.ptr.rotation = 0; vel = 0; }
      btn.wheelG.rotation += (vel * Math.PI / 180) * dt;
    };
    this._wheelAnim = fn;
    this.app.ticker.add(fn);
  }

  // ---- feature availability ------------------------------------------------
  // The rail asks these on every refresh to decide who gets a slot. They only say
  // WHETHER a feature is offered; WHERE its button sits is the rail's business.

  // The wheel is offered once progression unlocks it and while the day's spins
  // aren't used up.
  _freeSpinAvailable() {
    const w = this.fortuneWheel;
    return !!w && this.user.progress.level >= w.unlockLevel && w.canSpin();
  }

  // The gift is offered once progression unlocks it and while today's is unclaimed.
  _dailyBonusAvailable() {
    const d = this.dailyBonus;
    return !!d && this.user.progress.level >= d.unlockLevel && d.canClaim();
  }

  /**
   * Re-gate every feature button and re-pack the rail. Pass `animate: false` to
   * snap (used on lobby entry, so arriving never plays a slide).
   */
  refreshFeatures({ animate = true } = {}) {
    if (!this.rail) return;
    this._updateWheelBadges();
    this.rail.refresh({ animate });
  }

  // Badges the rail knows nothing about: "new" until the wheel is first opened,
  // "free" while the free spin of the cycle is unclaimed.
  _updateWheelBadges() {
    if (!this.wheelBtn) return;
    this.wheelBtn.newBadge.visible = !this.user.wheelSeen();
    this.wheelBtn.freeBadge.visible = this.user.wheelSpinsUsed() === 0;
  }

  /**
   * Is a feature currently offered? Distinct from `<btn>.visible`, which is also
   * false while an entering button waits out a reflow, or true mid fade-out.
   */
  featureAvailable(key) {
    return !!this.rail && this.rail.available(key);
  }

  _makeDailyButton() {
    const c = new PIXI.Container();
    const bg = new PIXI.Graphics();
    bg.beginFill(0x5a2f7e).drawCircle(0, 0, 54).endFill();
    bg.lineStyle(5, 0xffe27a, 0.9).drawCircle(0, 0, 54);
    c.addChild(bg);

    const gift = new PIXI.Text("🎁", { fontFamily: "Arial", fontSize: 58 });
    gift.anchor.set(0.5);
    c.addChild(gift);
    c.gift = gift;

    const cap = new PIXI.Text("Daily Bonus", {
      fontFamily: "Arial", fontSize: 22, fontWeight: "900", fill: 0xffe27a,
      stroke: 0x5a3a00, strokeThickness: 4,
    });
    cap.anchor.set(0.5);
    cap.position.set(0, 74);
    c.addChild(cap);

    c.eventMode = "static";
    c.cursor = "pointer";
    c.hitArea = new PIXI.Circle(0, 0, 56);
    c._hover = false;
    c._pressed = false;
    this._dailyBase = 1;
    c.on("pointertap", () => { this.audio.play("btn_01"); this.onDailyBonus && this.onDailyBonus(); });
    c.on("pointerover", () => { c._hover = true; });
    c.on("pointerout", () => { c._hover = false; });
    c.on("pointerdown", () => { c._pressed = true; c.scale.set(this._dailyBase * 0.92); });
    c.on("pointerup", () => { c._pressed = false; });
    c.on("pointerupoutside", () => { c._pressed = false; });
    return c;
  }

  // The gift button's animation: a gentle looping grow/shrink beat at rest (the
  // "unclaimed" indicator, no red-dot badge); on mouse-over the button swells and
  // the gift wiggles, both settling back when the pointer leaves. Layered on top,
  // the gift gives a little squashy hop periodically — on the same ~5s cadence as
  // the wheel's self-spin — to draw the eye.
  _startDailyPulse() {
    if (this._dailyAnim) this.app.ticker.remove(this._dailyAnim);
    this._dailyBase = 1;
    let beat = 0, idle = 0, hopping = false, ht = 0;
    const HOP_DUR = 0.5; // seconds
    const fn = () => {
      const btn = this.dailyBtn;
      if (!btn || !btn.visible) {
        if (btn) { btn._hover = false; btn.gift.position.y = 0; btn.gift.scale.set(1); }
        idle = 0; hopping = false;
        return;
      }
      const dt = this.app.ticker.deltaMS / 1000;
      beat += this.app.ticker.deltaMS;
      const rest = 1 + 0.05 * Math.sin(beat / 460);
      const target = btn._hover ? 1.12 : rest;
      this._dailyBase += (target - this._dailyBase) * Math.min(1, dt * 10);
      if (!btn._pressed) btn.scale.set(this._dailyBase);
      // Wiggle the gift while hovered; ease it back upright otherwise.
      if (btn._hover) btn.gift.rotation = 0.16 * Math.sin(beat * 0.018);
      else btn.gift.rotation += (0 - btn.gift.rotation) * Math.min(1, dt * 12);

      // Periodic hop: idle for ~5s, then arc up and back down over HOP_DUR with a
      // tiny anticipatory squash, then rest again. `_hopNow` lets a test trigger one
      // immediately (the idle timer is frame-rate bound, so it's unreliable under load).
      if (!hopping) {
        idle += dt;
        if (idle >= 5 || btn._hopNow) { hopping = true; ht = 0; idle = 0; btn._hopNow = false; }
      }
      if (hopping) {
        ht += dt;
        if (ht >= HOP_DUR) { hopping = false; btn.gift.position.y = 0; btn.gift.scale.set(1); }
        else {
          const e = ht / HOP_DUR;                 // 0..1
          btn.gift.position.y = -18 * Math.sin(Math.PI * e);   // up then down
          const squash = 0.08 * Math.sin(Math.PI * 2 * e);     // stretch up, squash on landing
          btn.gift.scale.set(1 - squash, 1 + squash);
        }
      }
    };
    this._dailyAnim = fn;
    this.app.ticker.add(fn);
  }

  _makePlayButton() {
    const c = new PIXI.Container();
    const w = 440, h = 138;
    const g = new PIXI.Graphics();
    g.beginFill(0x2f9e6a).drawRoundedRect(-w / 2, -h / 2, w, h, h / 2.6).endFill();
    g.beginFill(0x39c06a).drawRoundedRect(-w / 2, -h / 2, w, h - 12, h / 2.6).endFill();
    g.lineStyle(6, 0xffffff, 0.4).drawRoundedRect(-w / 2, -h / 2, w, h, h / 2.6);
    const label = new PIXI.Text("Level 1", {
      fontFamily: "Arial", fontSize: 52, fontWeight: "900", fill: 0xffffff,
      stroke: 0x1c5c39, strokeThickness: 6,
    });
    label.anchor.set(0.5);
    c.addChild(g, label);
    c.label = label;
    c.eventMode = "static";
    c.cursor = "pointer";
    c.on("pointertap", () => {
      if (this._locked) return;
      this.audio.play("btn_01");
      this.onPlay && this.onPlay(this._level);
    });
    c.on("pointerdown", () => c.scale.set(0.95 * this._pulseBase));
    c.on("pointerup", () => c.scale.set(this._pulseBase));
    c.on("pointerupoutside", () => c.scale.set(this._pulseBase));
    return c;
  }

  _buildBackground(levelNum) {
    this.bgLayer.removeChildren();
    const tex = this.backgrounds[levelNum] || this.backgrounds[1];
    if (tex) {
      // Keep the game a fixed-width vertical column: crisp art in the centred
      // 750-wide band, a blurred copy filling the sides on a wide screen.
      for (const sp of buildColumnBackground(tex, this.viewW, this.viewH)) this.bgLayer.addChild(sp);
    }
    const dark = new PIXI.Graphics();
    dark.beginFill(0x0a1226, 0.5).drawRect(0, 0, this.viewW, this.viewH).endFill();
    this.bgLayer.addChild(dark);
  }

  /** Show the lobby for the given level (the next level to play). */
  show(level, { celebrate = false } = {}) {
    this._level = level;
    this._locked = false;
    this.visible = true;
    this._buildBackground(level);
    this.playBtn.label.text = `Level ${level}`;
    // Snap, don't slide: the rail should already be arranged when the lobby appears.
    this.refreshFeatures({ animate: false });

    const allDone = celebrate && level >= this.maxLevel;
    this.subtitle.text = allDone
      ? "All levels cleared — nice!"
      : celebrate
        ? "Level complete!"
        : "Match 3 fruits · clear the board";
    fitTextWidth(this.subtitle, CENTER_MAX_W); // re-fit for the new text width

    // entrance pop of the play button + a gentle attention pulse
    this._pulseBase = 1;
    this.playBtn.scale.set(0.2);
    tween(this.app.ticker, {
      duration: 460, ease: easeOutBack,
      onUpdate: (e) => this.playBtn.scale.set(0.2 + 0.8 * e),
      onComplete: () => this._startPulse(),
    });
  }

  hide() {
    this.visible = false;
    if (this._pulse) { this.app.ticker.remove(this._pulse); this._pulse = null; }
  }

  _startPulse() {
    if (this._pulse) this.app.ticker.remove(this._pulse);
    let el = 0;
    const fn = () => {
      el += this.app.ticker.deltaMS;
      this._pulseBase = 1 + 0.035 * Math.sin(el / 480);
      if (this.playBtn.scale.x < 1.2) this.playBtn.scale.set(this._pulseBase);
    };
    this._pulse = fn;
    this.app.ticker.add(fn);
  }
}
