// Lobby / home screen — shown on load and after each completed level.
// Displays the game title and a big centred "Level <n>" button that starts the
// next level the player is on. Styled to match the in-game chrome (rounded
// buttons, same palette + backgrounds) in the spirit of the original game.

import { tween, delay, easeOutBack } from "./tween.js";
import { makeCogButton } from "./settings.js";
import { makeCoinPill } from "./shop.js";
import { buildColumnBackground, fitTextWidth, makeHintPill } from "./layout.js";
import { FeatureRail, RAIL_LEFT_X, RAIL_RIGHT_X } from "./featurerail.js";
import { t, locText } from "./i18n.js";
import { CONFIG } from "./config.js";
import { SuperWandPromo } from "./superwandpromo.js";

const DESIGN_W = 750;
const DESIGN_H = 1334;

// The corner chrome occupies a column down EACH outer edge — the settings cog and
// the left rail (fortune wheel / daily bonus / super wand) on one side, the coin
// pill and the right rail (Tasks) on the other — each up to ~x155 wide (button + caption). Keep
// the centred title and subtitle inside the clear centre band so wide text can
// never overlap either column, no matter how far the vertically-centred UI block
// slides on a tall screen.
const CHROME_COL = 175;

// The Super Wand's two faces on its lobby progress button — the same pair the
// shared helper-row button wears inside a level (WAND_FACE / SUPER_WAND_FACE in
// game.js), so the banked reward is recognisable in both places.
const WAND_GLYPH = "🪄";
const SUPER_WAND_GLYPH = "✨";
const CENTER_MAX_W = DESIGN_W - 2 * CHROME_COL; // 400

export class LobbyScene extends PIXI.Container {
  constructor(app, backgrounds, audio, maxLevel, user, levelChest) {
    super();
    this.app = app;
    this.backgrounds = backgrounds; // { 1: tex, 2: tex, 3: tex }
    this.audio = audio;
    this.maxLevel = maxLevel;
    this.user = user;       // player profile — for the coin balance pill
    this.levelChest = levelChest || null; // Level Chest schedule — for the progress bar
    this.fortuneWheel = null; // the FortuneWheelScene (set by the host) — for gating/badges
    this.dailyBonus = null; // the DailyBonusScene (set by the host) — for gating
    this.tasks = null;      // the TasksScene (set by the host) — for gating + the red dot
    this.onPlay = null;     // (levelNum) => void
    this.onSettings = null; // () => void — open the settings screen
    this.onShop = null;     // () => void — open the shop screen
    this.onFortuneWheel = null; // () => void — open the fortune wheel
    this.onDailyBonus = null; // () => void — open the daily bonus
    this.onTasks = null;    // () => void — open the tasks screen

    // Responsive layout state (updated by layout()); defaults to the base design.
    this.viewW = DESIGN_W; this.viewH = DESIGN_H;

    this.bgLayer = new PIXI.Container();
    this.uiLayer = new PIXI.Container();
    this.topHud  = new PIXI.Container(); // pinned to the screen's top edge
    this.botHud  = new PIXI.Container(); // pinned to the screen's bottom edge
    this.addChild(this.bgLayer, this.uiLayer, this.botHud, this.topHud);

    this._buildStatic();
  }

  // Reflow into a DW×DH design area: centre the title block in the safe area,
  // keep the corner chrome on the top edge and the play cluster on the bottom
  // one, and extend the background to cover the whole view (see GameScene.layout,
  // which splits its HUD into the same top/bottom anchored bands).
  layout(DW, DH) {
    this.viewW = DW; this.viewH = DH;
    this.uiLayer.position.set((DW - DESIGN_W) / 2, (DH - DESIGN_H) / 2);
    this.topHud.position.set((DW - DESIGN_W) / 2, 0);
    this.botHud.position.set((DW - DESIGN_W) / 2, DH - DESIGN_H);
    // The promo covers the WHOLE view (its own dim), so it takes the raw size
    // rather than a band offset.
    if (this.superWandPromo) this.superWandPromo.layout(DW, DH);
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
      { name: "chestBar", obj: this.chestBar },
      { name: "playBtn", obj: this.playBtn },
      { name: "hint", obj: this.hint },
      { name: "cog", obj: this.cog },
      { name: "coinPill", obj: this.coinPill },
      { name: "wheelBtn", obj: this.wheelBtn },
      { name: "dailyBtn", obj: this.dailyBtn },
      { name: "superWandBtn", obj: this.superWandBtn },
      { name: "tasksBtn", obj: this.tasksBtn },
    ];
  }

  _buildStatic() {
    // Title block
    this.title = locText("game_title", {
      fontFamily: "Arial", fontSize: 82, fontWeight: "900", fill: 0xffe27a,
      stroke: 0x5a3a00, strokeThickness: 9, align: "center",
    });
    this.title.anchor.set(0.5);
    this.title.position.set(DESIGN_W / 2, 330);
    fitTextWidth(this.title, CENTER_MAX_W); // keep clear of the left chrome column
    this.uiLayer.addChild(this.title);

    // The subtitle changes with what just happened (a clear, the last level,
    // or the resting state), so it is assembled in code and re-read by
    // relocalize() rather than carrying a fixed key.
    this._subtitleKey = "lobby_subtitle";
    this.subtitle = new PIXI.Text(t("lobby_subtitle"), {
      fontFamily: "Arial", fontSize: 32, fontWeight: "700", fill: 0xdce7ff,
      stroke: 0x122043, strokeThickness: 4,
    });
    this.subtitle.anchor.set(0.5);
    this.subtitle.position.set(DESIGN_W / 2, 420);
    fitTextWidth(this.subtitle, CENTER_MAX_W);
    this.uiLayer.addChild(this.subtitle);

    // A little fruity flourish. Fitted to the clear centre band like the title
    // and subtitle above it: at full size the row is ~509 wide and reaches into
    // the left chrome column, which collides with a rail button once the rail is
    // three deep (Free Spin + Daily Bonus + the Super Wand read-out).
    const fruits = new PIXI.Text("🍉  🍓  🍊  🍇  🍋", { fontFamily: "Arial", fontSize: 60 });
    fruits.anchor.set(0.5);
    fruits.position.set(DESIGN_W / 2, 520);
    fitTextWidth(fruits, CENTER_MAX_W);
    this.uiLayer.addChild(fruits);
    this.fruits = fruits;

    // Big play button — the primary call to action, so it lives on the BOTTOM
    // band (botHud) rather than the vertically-centred block: it keeps a fixed
    // margin above the screen's bottom edge on every shape, tall screens
    // included, and is the last thing before that edge. Its hint sits above it.
    this.hint = locText("tap_to_start", {
      fontFamily: "Arial", fontSize: 26, fontWeight: "700", fill: 0xaebfe0,
    });
    this.hint.anchor.set(0.5);
    this.hint.position.set(DESIGN_W / 2, 1040);
    this.botHud.addChild(this.hint);

    this.playBtn = this._makePlayButton();
    this.playBtn.position.set(DESIGN_W / 2, 1160);
    this.botHud.addChild(this.playBtn);

    // Level Chest progress bar — a persistent "progress toward the next chest"
    // indicator, derived from the highest level cleared (the same schedule the
    // level-complete screen opens). It sits in the clear centre band below the
    // fruit row, on the vertically-centred uiLayer, so it stays clear of the
    // corner chrome / rails (top) and the play cluster (bottom) on every shape.
    // Hidden until there is a chest to fill (a brand-new player has none).
    this.chestBar = this.levelChest ? this._makeChestBar() : null;
    if (this.chestBar) {
      this.chestBar.position.set(DESIGN_W / 2, 660);
      this.uiLayer.addChild(this.chestBar);
    }

    // Settings (cog) — top-left. Opens the settings screen via the host.
    const cog = makeCogButton(this.audio, () => this.onSettings && this.onSettings());
    cog.position.set(60, 84);
    this.topHud.addChild(cog);
    this.cog = cog;

    // Coin balance pill — top-right, mirroring the cog. Tapping it opens the shop,
    // but only once the shop is unlocked (see _refreshShopGate); until then it is a
    // plain coin counter.
    this.coinPill = makeCoinPill(this.user, () => this.onShop && this.onShop());
    this.coinPill.position.set(DESIGN_W - 108, 84);
    this.topHud.addChild(this.coinPill);
    this._refreshShopGate();

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

    // Super Wand progress — how far along the win streak that charges the Wand's
    // earned upgrade is. Unlike the two above it is a READ-OUT, not a doorway:
    // there is no Super Wand screen, the reward is used on the helper row inside
    // a level (see GameScene.superWand). So it carries no caption: the "streak /
    // needed" pill under the wand is the read-out, and a tap opens the promo that
    // explains what the number is for (src/superwandpromo.js).
    this.superWandBtn = this._makeSuperWandButton();
    this.superWandBtn.visible = false;
    this.topHud.addChild(this.superWandBtn);
    this._startSuperWandPulse();

    // None of these buttons owns a position: they are entries on the left-edge
    // FEATURE RAIL, which packs whichever ones are available into consecutive
    // slots in THIS registration order — Free Spin first, Daily Bonus second,
    // Super Wand third — and animates them between slots as availability changes
    // (see featurerail.js). The read-out goes last so a claimable daily gift is
    // never pushed down the column by it.
    this.rail = new FeatureRail(this.app.ticker, { x: RAIL_LEFT_X });
    this.rail.add("freeSpin", this.wheelBtn, () => this._freeSpinAvailable());
    this.rail.add("dailyBonus", this.dailyBtn, () => this._dailyBonusAvailable());
    this.rail.add("superWand", this.superWandBtn, () => this._superWandAvailable());

    // Tasks — the checklist of goals. It sits on a SECOND rail down the right
    // edge, under the coin pill, rather than sharing the left one: it is a
    // permanent destination (once unlocked it never goes away again), whereas
    // the left rail's entries come and go with the daily cycle. FeatureRail is
    // edge-agnostic, so this is another instance, not new machinery.
    this.tasksBtn = this._makeTasksButton();
    this.tasksBtn.visible = false;
    this.topHud.addChild(this.tasksBtn);

    this.railRight = new FeatureRail(this.app.ticker, { x: RAIL_RIGHT_X });
    this.railRight.add("tasks", this.tasksBtn, () => this._tasksAvailable());

    // Keep the rails live: progression unlocks features, a wheel spin / rollover
    // changes the free-spin badge, and a daily claim retires the gift. Progression
    // also unlocks the shop, so the cart can appear the moment a level is cleared.
    // The `tasks` domain is what lights and clears the Tasks red dot live —
    // a counter ticking over a target, or a reward being collected.
    // The Super Wand promo — the modal behind the rail read-out. The lobby owns it
    // rather than the host: it is a popup over this scene, not a destination like
    // the wheel or the gift, so it needs no scene wiring and re-centres with the
    // lobby's own layout(). Added last, so it draws over every band.
    this.superWandPromo = new SuperWandPromo(this.app, this.user, this.audio);
    this.addChild(this.superWandPromo);

    this.user.on((domain) => {
      if (domain === "fortuneWheel" || domain === "dailyBonus" ||
          domain === "progress" || domain === "tasks" || domain === "superWand") {
        this.refreshFeatures();
      }
      if (domain === "progress") { this._refreshShopGate(); this._refreshChestBar(); }
    });
    this._refreshChestBar();
  }

  // The shop is a progression unlock (CONFIG.features.shop.unlockLevel): until it comes due
  // the pill loses its cart badge and ignores taps, staying a plain coin counter.
  _refreshShopGate() {
    this.coinPill.setShopEnabled(!this.user || this.user.isShopUnlocked());
  }

  // Build the lobby's Level Chest bar: a treasure glyph + a progress track + a
  // "filled / needed" label, all around the container's own centre.
  _makeChestBar() {
    const c = new PIXI.Container();
    const glyph = this._makeChestGlyph();
    glyph.position.set(-150, 0);
    c.addChild(glyph);

    const trackW = 290, trackH = 24, trackX = -118;
    const track = new PIXI.Graphics();
    track.beginFill(0x0a1226, 0.72).drawRoundedRect(trackX, -trackH / 2, trackW, trackH, trackH / 2).endFill();
    track.lineStyle(3, 0xffffff, 0.14).drawRoundedRect(trackX, -trackH / 2, trackW, trackH, trackH / 2);
    c.addChild(track);

    const fill = new PIXI.Graphics();
    c.addChild(fill);

    const label = new PIXI.Text("", {
      fontFamily: "Arial", fontSize: 22, fontWeight: "900", fill: 0xdce7ff,
      stroke: 0x122043, strokeThickness: 3,
    });
    label.anchor.set(0.5); label.position.set(trackX + trackW / 2, 0);
    c.addChild(label);

    c._fill = fill; c._label = label;
    c._trackW = trackW; c._trackH = trackH; c._trackX = trackX;
    return c;
  }

  // A small static treasure chest (the level-complete screen draws a larger one
  // whose lid can lift; this one just needs to read as a chest).
  _makeChestGlyph() {
    const c = new PIXI.Container();
    const w = 52, h = 40, lidH = 16;
    const body = new PIXI.Graphics();
    body.beginFill(0x8a5a2b).drawRoundedRect(-w / 2, -h / 2 + lidH, w, h - lidH, 6).endFill();
    body.lineStyle(3, 0xffe27a, 0.95).drawRoundedRect(-w / 2, -h / 2 + lidH, w, h - lidH, 6);
    const lid = new PIXI.Graphics();
    lid.beginFill(0xb5762f).drawRoundedRect(-w / 2 - 1, -h / 2, w + 2, lidH, 6).endFill();
    lid.lineStyle(3, 0xffe27a, 0.95).drawRoundedRect(-w / 2 - 1, -h / 2, w + 2, lidH, 6);
    const clasp = new PIXI.Graphics();
    clasp.beginFill(0xffcf4d).drawRoundedRect(-8, -h / 2 + lidH - 4, 16, 14, 3).endFill();
    clasp.beginFill(0x5a3a00).drawCircle(0, -h / 2 + lidH + 3, 3).endFill();
    c.addChild(body, lid, clasp);
    return c;
  }

  // Update the lobby chest bar from the highest level cleared. Shows the chest
  // currently being filled (LevelChest.currentFor rolls a just-opened milestone
  // chest forward to the next one at 0 notches); hidden when there is none.
  _refreshChestBar() {
    const bar = this.chestBar;
    if (!bar) return;
    const info = (this.levelChest && this.levelChest.enabled)
      ? this.levelChest.currentFor(this.user ? this.user.completedLevel() : 0) : null;
    if (!info) { bar.visible = false; return; }
    bar.visible = true;
    const pct = info.needed > 0 ? Math.max(0, Math.min(1, info.filled / info.needed)) : 0;
    bar._fill.clear();
    if (pct > 0) {
      bar._fill.beginFill(0x39c06a)
        .drawRoundedRect(bar._trackX, -bar._trackH / 2,
          Math.max(bar._trackH, bar._trackW * pct), bar._trackH, bar._trackH / 2).endFill();
    }
    bar._label.text = info.label;
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

    const cap = locText("free_spin", {
      fontFamily: "Arial", fontSize: 22, fontWeight: "900", fill: 0xffe27a,
      stroke: 0x5a3a00, strokeThickness: 4,
    });
    cap.anchor.set(0.5);
    cap.position.set(0, 74);
    c.addChild(cap);

    // "new" badge (until first-ever open) — top-right.
    // NOT LOCALIZED, deliberately: the word is part of the badge's artwork, not
    // copy. It is a fixed-width red pill sized around three characters, and the
    // mark reads as "new" worldwide — so it has no key in the language tables
    // and stays "NEW" in all 13. Same treatment as the emoji glyphs.
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
  //
  // Every progression gate below is the PROFILE's (user.isXUnlocked(), i.e.
  // completedLevel() >= unlockLevel - 1 — see the level-convention note in
  // src/config.js). The lobby never compares levels itself: `progress.level` is
  // derived and can move without anything being cleared, which used to re-lock
  // the wheel and the gift while every other feature stayed open.

  // The wheel is offered once progression unlocks it and while the day's spins
  // aren't used up.
  _freeSpinAvailable() {
    const w = this.fortuneWheel;
    return !!w && this.user.isFortuneWheelUnlocked() && w.canSpin();
  }

  // The gift is offered once progression unlocks it and while today's is unclaimed.
  _dailyBonusAvailable() {
    const d = this.dailyBonus;
    return !!d && this.user.isDailyBonusUnlocked() && d.canClaim();
  }

  // The streak read-out is offered from its unlock level on, and then always:
  // it is progress, so it stays on the rail whether the meter is empty, filling
  // or full. Nothing about it is "used up for today".
  _superWandAvailable() {
    return !!this.user && this.user.isSuperWandUnlocked();
  }

  // Tasks is offered from its unlock level on, and then permanently — unlike the
  // two daily features there is no "used up for today" state to hide it again.
  // An empty goal table (a failed config fetch) withholds the button entirely.
  _tasksAvailable() {
    const t = this.tasks;
    return !!t && t.hasTable() && this.user.isTasksUnlocked();
  }

  /**
   * Re-gate every feature button and re-pack BOTH rails. Pass `animate: false` to
   * snap (used on lobby entry, so arriving never plays a slide).
   */
  refreshFeatures({ animate = true } = {}) {
    if (!this.rail) return;
    this._updateWheelBadges();
    this._updateSuperWandButton();
    if (this.superWandPromo) this.superWandPromo.refresh();
    this._updateTasksBadge();
    this.rail.refresh({ animate });
    if (this.railRight) this.railRight.refresh({ animate });
  }

  // Badges the rail knows nothing about: "new" until the wheel is first opened,
  // "free" while the free spin of the cycle is unclaimed.
  _updateWheelBadges() {
    if (!this.wheelBtn) return;
    this.wheelBtn.newBadge.visible = !this.user.wheelSeen();
    this.wheelBtn.freeBadge.visible = this.user.wheelSpinsUsed() === 0;
  }

  // The Tasks red dot: on whenever ANYTHING — achievement or weekly — is finished
  // and waiting to be collected. It is the feature's entire discovery mechanism;
  // there is no popup and no other nag.
  _updateTasksBadge() {
    if (!this.tasksBtn) return;
    this.tasksBtn.dot.visible = !!this.tasks && this.tasks.hasClaimable();
  }

  /**
   * Is a feature currently offered? Distinct from `<btn>.visible`, which is also
   * false while an entering button waits out a reflow, or true mid fade-out.
   * Looks in both rails, so the key is enough — the caller needn't know an edge.
   */
  featureAvailable(key) {
    if (this.rail && this.rail.entries.some((e) => e.key === key)) return this.rail.available(key);
    return !!this.railRight && this.railRight.available(key);
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

    const cap = locText("daily_reward", {
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

  // The Super Wand's lobby face: the same round disc the other rail buttons use,
  // a wand glyph, and a "streak / needed" pill where they put their caption (y74,
  // so the slot ladder's spacing is unchanged). It has no pointer handlers — the
  // rail still turns eventMode on for whichever entries are showing, but with
  // nothing listening a tap on the read-out simply does nothing.
  _makeSuperWandButton() {
    const c = new PIXI.Container();
    const disc = new PIXI.Graphics();
    c.addChild(disc);
    c.disc = disc;

    const icon = new PIXI.Text(WAND_GLYPH, { fontFamily: "Arial", fontSize: 54 });
    icon.anchor.set(0.5);
    c.addChild(icon);
    c.icon = icon;

    // The progress pill. Numbers only, so it needs no language key and no
    // fitting pass — it reads the same in all 13 (cf. the NEW badge above).
    const pill = new PIXI.Graphics();
    pill.beginFill(0x0a1226, 0.78).drawRoundedRect(-56, -19, 112, 38, 19).endFill();
    pill.lineStyle(3, 0xffffff, 0.18).drawRoundedRect(-56, -19, 112, 38, 19);
    pill.position.set(0, 76);
    c.addChild(pill);

    const label = new PIXI.Text("", {
      fontFamily: "Arial", fontSize: 24, fontWeight: "900", fill: 0xffffff,
      stroke: 0x122043, strokeThickness: 3,
    });
    label.anchor.set(0.5);
    label.position.set(0, 76);
    c.addChild(label);
    c.label = label;

    // A tap opens the promo — the read-out can only ever show a number, and this
    // is where the player learns what the number is for. Same feedback as the
    // other rail buttons (the click, the press-shrink), so it reads as a button.
    c.eventMode = "static";
    c.cursor = "pointer";
    c.hitArea = new PIXI.Circle(0, 0, 56);
    c.on("pointertap", () => {
      this.audio.play("btn_01");
      this.superWandPromo.open();
    });
    c._pressed = false;
    c.on("pointerdown", () => { c._pressed = true; c.scale.set(0.92); });
    c.on("pointerup", () => { c._pressed = false; c.scale.set(1); });
    c.on("pointerupoutside", () => { c._pressed = false; c.scale.set(1); });

    c._charged = null; // no face painted yet — the first refresh draws the disc
    return c;
  }

  // Repaint the read-out from the profile. The pill always shows the streak out
  // of what a charge costs; a BANKED charge pins it full and swaps the whole
  // face to gold + the upgraded glyph, so the lobby says "your reward is waiting"
  // in the same visual language the helper-row button uses inside a level.
  _updateSuperWandButton() {
    const btn = this.superWandBtn;
    if (!btn || !this.user) return;
    const needed = CONFIG.boosters.superWand.streakLength;
    const charged = this.user.superWandCharged();
    const streak = charged ? needed : Math.min(needed, this.user.superWandStreak());
    btn.label.text = `${streak}/${needed}`;
    if (btn._charged === charged) return; // the disc and glyph only change on a flip
    btn._charged = charged;
    btn.icon.text = charged ? SUPER_WAND_GLYPH : WAND_GLYPH;
    btn.disc.clear();
    btn.disc.beginFill(charged ? 0xb8791a : 0x1f4f9e).drawCircle(0, 0, 54).endFill();
    btn.disc.lineStyle(5, 0xffe27a, 0.9).drawCircle(0, 0, 54);
  }

  // A charged Super Wand breathes; a filling one sits still. Same idiom as the
  // gift's pulse — the animation IS the "ready" indicator, so there is no badge
  // and no red dot to clear.
  _startSuperWandPulse() {
    if (this._superWandAnim) this.app.ticker.remove(this._superWandAnim);
    let beat = 0;
    const fn = () => {
      const btn = this.superWandBtn;
      // `_pressed` keeps the beat off the button while a finger is on it, so the
      // press-shrink isn't overwritten on the very next frame (same guard the
      // wheel and the gift use).
      if (!btn || !btn.visible || !btn._charged) {
        if (btn && !btn._pressed) btn.scale.set(1);
        return;
      }
      beat += this.app.ticker.deltaMS;
      if (!btn._pressed) btn.scale.set(1 + 0.06 * Math.sin(beat / 420));
    };
    this._superWandAnim = fn;
    this.app.ticker.add(fn);
  }

  // The Tasks entry button — a clipboard in the same round style as the wheel and
  // the gift, on the right-edge rail under the coin pill. Unlike those two it does
  // not animate at rest: it is a permanent destination, not a "claim me today"
  // prompt, so the RED DOT does all the work of saying there is something waiting.
  _makeTasksButton() {
    const c = new PIXI.Container();
    const bg = new PIXI.Graphics();
    bg.beginFill(0x2c5a7e).drawCircle(0, 0, 54).endFill();
    bg.lineStyle(5, 0xffe27a, 0.9).drawCircle(0, 0, 54);
    c.addChild(bg);

    const board = new PIXI.Text("📋", { fontFamily: "Arial", fontSize: 56 });
    board.anchor.set(0.5);
    c.addChild(board);

    const cap = locText("task_title", {
      fontFamily: "Arial", fontSize: 22, fontWeight: "900", fill: 0xffe27a,
      stroke: 0x5a3a00, strokeThickness: 4,
    });
    cap.anchor.set(0.5);
    cap.position.set(0, 74);
    c.addChild(cap);

    // The red dot — "something is finished and waiting". Top-right of the button,
    // in button-local coordinates, exactly like the wheel's badges (and, like
    // them, deliberately absent from controls(): it is part of its button).
    const dot = new PIXI.Graphics();
    dot.beginFill(0xff3b3b).drawCircle(0, 0, 15).endFill();
    dot.lineStyle(3, 0xffffff, 0.85).drawCircle(0, 0, 15);
    dot.position.set(40, -40);
    dot.visible = false;
    c.addChild(dot);
    c.dot = dot;

    c.eventMode = "static";
    c.cursor = "pointer";
    c.hitArea = new PIXI.Circle(0, 0, 56);
    c.on("pointertap", () => { this.audio.play("btn_01"); this.onTasks && this.onTasks(); });
    c.on("pointerover", () => c.scale.set(1.08));
    c.on("pointerout", () => c.scale.set(1));
    c.on("pointerdown", () => c.scale.set(0.92));
    c.on("pointerup", () => c.scale.set(1));
    c.on("pointerupoutside", () => c.scale.set(1));
    return c;
  }

  _makePlayButton() {
    const c = new PIXI.Container();
    const w = 440, h = 138;
    const g = new PIXI.Graphics();
    g.beginFill(0x2f9e6a).drawRoundedRect(-w / 2, -h / 2, w, h, h / 2.6).endFill();
    g.beginFill(0x39c06a).drawRoundedRect(-w / 2, -h / 2, w, h - 12, h / 2.6).endFill();
    g.lineStyle(6, 0xffffff, 0.4).drawRoundedRect(-w / 2, -h / 2, w, h, h / 2.6);
    const label = new PIXI.Text(t("Language1", 1), {
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

  /** Repaint the background for the level currently on show. Called when that
   *  level's art finishes loading AFTER the lobby was built — the lobby is put up
   *  immediately and its art is fetched behind it (see main.js `ensureLobbyArt`),
   *  so this is what replaces the level-1 fallback once the real one lands. A
   *  no-op while hidden: `show()` rebuilds from scratch anyway. */
  refreshBackground() {
    if (this.visible) this._buildBackground(this._level);
  }

  _buildBackground(levelNum) {
    this.bgLayer.removeChildren();
    // This level's own art when it is in memory. When it is not — a group still
    // being fetched — KEEP WHATEVER IS ALREADY UP rather than dropping to level
    // 1's background: falling back would flash the wrong art and replace it a
    // moment later, which is far more noticeable than simply holding the picture
    // the player was already looking at. Level 1 is the last resort, for a lobby
    // that has nothing up yet at all. (This path is the safety net; normally
    // main.js has prefetched the level's art long before the lobby asks for it.)
    const own = this.backgrounds[levelNum];        // this level's own art
    const held = this.backgrounds[this._bgLevel];  // the art already on screen
    const tex = own || held || this.backgrounds[1];
    // Which level's art actually went up — whichever of the three above supplied
    // the texture, never merely the one we hoped for. Read by the debug hooks
    // (lobbyBackground), and the thing refreshBackground() exists to correct.
    this._bgLevel = own ? Number(levelNum) : (held ? this._bgLevel : (tex ? 1 : 0));
    if (tex) {
      // Keep the game a fixed-width vertical column: crisp art in the centred
      // 750-wide band, a blurred copy filling the sides on a wide screen.
      for (const sp of buildColumnBackground(tex, this.viewW, this.viewH)) this.bgLayer.addChild(sp);
    }
    const dark = new PIXI.Graphics();
    dark.beginFill(0x0a1226, 0.5).drawRect(0, 0, this.viewW, this.viewH).endFill();
    this.bgLayer.addChild(dark);
  }

  /**
   * Re-letter the text this scene assembles in code. The title, the hint and
   * the three feature captions carry their own keys and refresh themselves;
   * what is left is the play button (which stitches in the level number) and
   * the subtitle (whose wording depends on what just happened). Both are re-fit
   * afterwards, because a translation is rarely the same width.
   */
  relocalize() {
    this.playBtn.label.text = t("Language1", this._level || 1);
    this.subtitle.text = t(this._subtitleKey);
    if (this.superWandPromo) this.superWandPromo.relocalize();
    fitTextWidth(this.title, CENTER_MAX_W);
    fitTextWidth(this.subtitle, CENTER_MAX_W);
  }

  /** Show the lobby for the given level (the next level to play). */
  show(level, { celebrate = false } = {}) {
    this._level = level;
    this._locked = false;
    this.visible = true;
    this._buildBackground(level);
    this.playBtn.label.text = t("Language1", level);
    // Snap, don't slide: the rail should already be arranged when the lobby appears.
    this.refreshFeatures({ animate: false });

    const allDone = celebrate && level >= this.maxLevel;
    this._subtitleKey = allDone
      ? "lobby_all_cleared"
      : celebrate
        ? "lobby_level_complete"
        : "lobby_subtitle";
    this.subtitle.text = t(this._subtitleKey);
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

  /**
   * Float a short refusal above the Play button: fades in, holds, fades out.
   * Only one is ever alive — a second call replaces it.
   *
   * The one caller today is boot's Play handler, telling the player a level's
   * assets did not arrive. That message matters more than it looks: before the
   * asset layer stopped marking a failed group as loaded, a single failed fetch
   * left this button doing NOTHING on every subsequent tap, with no explanation
   * and no way to retry short of a reload. Now the tap is refused out loud and
   * the next one really does try again.
   *
   * Deliberately not in controls(): it is transient, like GameScene's hints, and
   * the overlap test walks the persistent chrome.
   */
  flashHint(text) {
    if (this._flash) { this._flash.destroy({ children: true }); this._flash = null; }
    const c = makeHintPill(text);
    const half = c.__w / 2 + 8;
    // Above the standing "Tap to start" hint at y=1040, not on top of it.
    c.position.set(Math.min(DESIGN_W - half, Math.max(half, DESIGN_W / 2)), 972);
    this.botHud.addChild(c);
    this._flash = c;
    // Guard every frame on `destroyed`: a second call destroys this pill while
    // its tween is still running. tween() now contains a throwing callback
    // itself (one logged error, listener unhooked) rather than letting it stop
    // the frame loop, so this is defence in depth — but it is still the guard
    // that keeps the pill from writing through a torn-down container at all.
    const fade = (e) => { if (!c.destroyed) c.alpha = e; };
    tween(this.app.ticker, { duration: 180, onUpdate: fade })
      .then(() => delay(this.app.ticker, 1600))
      .then(() => tween(this.app.ticker, { duration: 260, onUpdate: (e) => fade(1 - e) }))
      .then(() => {
        if (this._flash !== c) return;   // replaced mid-fade; the newer one owns the slot
        c.destroy({ children: true });
        this._flash = null;
      });
  }

  hide() {
    this.visible = false;
    // Leaving the lobby closes the promo, so coming back doesn't land on a modal
    // the player opened two screens ago.
    if (this.superWandPromo) this.superWandPromo.visible = false;
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
