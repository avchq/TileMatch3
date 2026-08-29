// The "How To Play" popup — the modal tutorial that opens at the very start of
// level 1, before the player is given any control. It states the one rule the
// game has ("Collect 3 identical tiles to remove them") over a looping
// demonstration of that rule: a small 3x3 board, a tray beneath it, and a
// pointing hand that collects three matching tiles and clears them.
//
// It is tied to being on LEVEL 1 (see TUTORIAL_LEVEL in game.js), not to being a
// new player, so in normal linear play it is a strictly first-session thing.
// There is deliberately NO skip button: OK closes it, and once the fade-in
// sequence has finished a tap anywhere closes it too.

import { tween, delay, easeOutCubic, easeOutBack } from "./tween.js";
import { t, locText } from "./i18n.js";

const PANEL_W = 620;
const PANEL_H = 860;

// Demo geometry, in the popup group's own coordinates (0,0 = panel centre).
const DEMO_STEP = 84;          // grid pitch of the mini board / tray
const DEMO_TILE = 76;          // drawn tile size
const DEMO_ROW_Y = [-186, -102, -18]; // the three board rows
const DEMO_COL_X = [-DEMO_STEP, 0, DEMO_STEP];
const DEMO_TRAY_Y = 196;
const DEMO_ARROW_Y = 78;

// Each type appears once per row and once per column, so collecting a type walks
// the hand across the board rather than along a single row.
const DEMO_TYPES = [
  [0, 1, 2],
  [1, 2, 0],
  [2, 0, 1],
];

// Written on close. A leftover from the original design: nothing in this build
// ever reads it back — the popup is gated on the level number alone. Kept for
// parity, and deliberately separate from the player's save record.
const TUTORIAL_MARKER_KEY = "tm3.tutorialDone";

export class HowToPlayPopup extends PIXI.Container {
  constructor(app, tileTextures, slotTexture, audio, onClose) {
    super();
    this.app = app;
    this.tileTextures = tileTextures;
    this.slotTexture = slotTexture;
    this.audio = audio;
    this.onClose = onClose;
    this.introDone = false;   // the fade-in sequence has finished (tap-anywhere arms)
    this.rowsShown = 0;       // how many board rows have faded in (test seam)
    this.closing = false;
    this._run = 0;            // generation token: invalidates in-flight animations
    this._tickers = [];       // ticker loops to remove on close

    // Modal dim: swallows every tap aimed at the level behind, and is itself the
    // tap-anywhere close target once the intro has played out.
    this.dim = new PIXI.Graphics();
    this.dim.eventMode = "static";
    this.dim.on("pointertap", () => { if (this.introDone) this.close(); });
    this.addChild(this.dim);

    // Everything else hangs off a centred group, so the popup re-centres on a
    // resize by moving one object (see layout()).
    this.group = new PIXI.Container();
    this.addChild(this.group);

    this._buildPanel();
    this._buildDemo();
    this.layout(750, 1334); // sane placement before the host's first layout() call
  }

  // ---- construction --------------------------------------------------------

  _buildPanel() {
    // Spinning light rays behind the demonstration. Same wedge construction as
    // the daily bonus reveal (DailyBonusScene._makeShine), sized to stay inside
    // the panel so no mask is needed.
    this.rays = new PIXI.Graphics();
    const count = 12, r1 = 70, r2 = 300, wdt = 0.2;
    for (let i = 0; i < count; i++) {
      const a = (i / count) * Math.PI * 2;
      this.rays.beginFill(0xffe27a, 0.16);
      this.rays.moveTo(Math.cos(a - wdt) * r1, Math.sin(a - wdt) * r1);
      this.rays.lineTo(Math.cos(a) * r2, Math.sin(a) * r2);
      this.rays.lineTo(Math.cos(a + wdt) * r1, Math.sin(a + wdt) * r1);
      this.rays.closePath();
      this.rays.endFill();
    }
    this.rays.position.set(0, 20);

    const panel = new PIXI.Graphics();
    panel.beginFill(0x22335e, 1)
      .drawRoundedRect(-PANEL_W / 2, -PANEL_H / 2, PANEL_W, PANEL_H, 36).endFill();
    panel.lineStyle(6, 0xffffff, 0.15)
      .drawRoundedRect(-PANEL_W / 2, -PANEL_H / 2, PANEL_W, PANEL_H, 36);
    // The panel is drawn first and the rays over it but under the content, so the
    // sunburst reads as light inside the popup. Their reach (r2 + the centre
    // offset) stays inside the panel, so no mask is needed.
    this.group.addChild(panel, this.rays);

    this.titleText = locText("tutorial_title", {
      fontFamily: "Arial", fontSize: 54, fontWeight: "900", fill: 0xffe27a,
      stroke: 0x5a3a00, strokeThickness: 6,
    });
    this.titleText.anchor.set(0.5);
    this.titleText.position.set(0, -358);
    this.titleText.alpha = 0;

    this.lineText = locText("tutorial_line", {
      fontFamily: "Arial", fontSize: 28, fontWeight: "700", fill: 0xd7e2ff,
      align: "center", wordWrap: true, wordWrapWidth: PANEL_W - 80,
    });
    this.lineText.anchor.set(0.5);
    this.lineText.position.set(0, -288);
    this.lineText.alpha = 0;

    this.group.addChild(this.titleText, this.lineText);

    this.okBtn = this._makeButton(t("ui_ok"), 260, 88, 0, 356, 0x39c06a, () => this.close());
    this.okBtn.alpha = 0;
    this.okBtn.eventMode = "none"; // armed when it fades in
    this.group.addChild(this.okBtn);
  }

  // A button in the game's own style. GameScene._makeButton is a scene method, so
  // the popup carries its own copy of the same shape rather than depending on it.
  _makeButton(label, w, h, cx, cy, color, onClick) {
    const c = new PIXI.Container();
    c.position.set(cx, cy);
    const g = new PIXI.Graphics();
    g.beginFill(color).drawRoundedRect(-w / 2, -h / 2, w, h, h / 2.4).endFill();
    g.lineStyle(4, 0xffffff, 0.35).drawRoundedRect(-w / 2, -h / 2, w, h, h / 2.4);
    const t = new PIXI.Text(label, {
      fontFamily: "Arial", fontSize: 30, fontWeight: "800", fill: 0xffffff,
    });
    t.anchor.set(0.5);
    c.addChild(g, t);
    c.label = t;
    c.__label = label; // test seam: the popup's button labels (there is no skip)
    c.eventMode = "static";
    c.cursor = "pointer";
    c.on("pointertap", () => {
      if (this.audio) this.audio.play("btn_01");
      onClick();
    });
    c.on("pointerdown", () => c.scale.set(0.94));
    c.on("pointerup", () => c.scale.set(1));
    c.on("pointerupoutside", () => c.scale.set(1));
    return c;
  }

  // The demonstration: a 3x3 board over a 3-slot tray, plus the arrow between
  // them and the pointing hand that drives the whole thing.
  _buildDemo() {
    this.demo = new PIXI.Container();
    this.group.addChild(this.demo);

    // Board rows, each its own container so the intro can fade them in one after
    // another ("rows ... fade in one after another").
    this.demoRows = DEMO_ROW_Y.map(() => {
      const row = new PIXI.Container();
      row.alpha = 0;
      this.demo.addChild(row);
      return row;
    });
    this.demoTiles = [];
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 3; c++) {
        const type = DEMO_TYPES[r][c];
        const sp = new PIXI.Sprite(this.tileTextures[type]);
        sp.anchor.set(0.5);
        sp.width = sp.height = DEMO_TILE;
        sp.position.set(DEMO_COL_X[c], DEMO_ROW_Y[r]);
        this.demoRows[r].addChild(sp);
        this.demoTiles.push({ type, sprite: sp, row: r, home: { x: sp.x, y: sp.y } });
      }
    }

    // Arrow: board -> tray.
    this.demoArrow = new PIXI.Graphics();
    this.demoArrow.beginFill(0xffe27a, 0.9)
      .drawRect(-7, DEMO_ARROW_Y - 26, 14, 30)
      .moveTo(-22, DEMO_ARROW_Y + 2).lineTo(22, DEMO_ARROW_Y + 2).lineTo(0, DEMO_ARROW_Y + 32)
      .closePath().endFill();
    this.demoArrow.alpha = 0;
    this.demo.addChild(this.demoArrow);

    // Tray: three slots, drawn from the real tray-slot texture.
    this.demoTray = new PIXI.Container();
    this.demoTray.alpha = 0;
    this.demo.addChild(this.demoTray);
    const panel = new PIXI.Graphics();
    panel.beginFill(0x0a1226, 0.4)
      .drawRoundedRect(-3 * DEMO_STEP / 2 - 14, DEMO_TRAY_Y - DEMO_TILE / 2 - 14,
        3 * DEMO_STEP + 28, DEMO_TILE + 28, 22).endFill();
    this.demoTray.addChild(panel);
    this.demoSlots = DEMO_COL_X.map((x) => {
      const s = new PIXI.Sprite(this.slotTexture);
      s.anchor.set(0.5);
      s.width = s.height = DEMO_TILE;
      s.position.set(x, DEMO_TRAY_Y);
      this.demoTray.addChild(s);
      return { x, y: DEMO_TRAY_Y };
    });
    this.trayTiles = []; // tiles currently sitting in the demo tray (test seam)

    // The pointing hand — the same look as the in-level guidance hand
    // (GameScene._showHand): an emoji finger over an expanding ripple ring.
    this.hand = new PIXI.Container();
    this.handRing = new PIXI.Graphics();
    this.handIcon = new PIXI.Text("👆", {
      fontFamily: '"Noto Color Emoji","Apple Color Emoji","Segoe UI Emoji",Arial',
      fontSize: 54,
    });
    this.handIcon.anchor.set(0.5, 0);
    this.handIcon.position.set(0, 14);
    this.hand.addChild(this.handRing, this.handIcon);
    this.hand.alpha = 0;
    this.demo.addChild(this.hand);
  }

  // ---- open / close --------------------------------------------------------

  // Fade the pieces in one after another, then arm tap-anywhere and start the
  // looping demonstration. Kept to ~1.6s so the player isn't left waiting.
  async open() {
    const run = ++this._run;
    const stale = () => this._run !== run || this.destroyed || this.closing;

    this._spinRays();

    this.group.scale.set(0.7);
    this.group.alpha = 0;
    tween(this.app.ticker, {
      duration: 380, ease: easeOutBack,
      onUpdate: (e) => {
        if (this.destroyed) return;
        this.group.scale.set(0.7 + 0.3 * e);
        this.group.alpha = Math.min(1, e * 1.6);
      },
    });

    await delay(this.app.ticker, 220); if (stale()) return;
    this._fadeIn(this.titleText, 220);
    await delay(this.app.ticker, 180); if (stale()) return;
    this._fadeIn(this.lineText, 220);
    for (let r = 0; r < this.demoRows.length; r++) {
      await delay(this.app.ticker, 170); if (stale()) return;
      this._fadeIn(this.demoRows[r], 200);
      this.rowsShown = r + 1;
    }
    await delay(this.app.ticker, 170); if (stale()) return;
    this._fadeIn(this.demoArrow, 220);
    this._fadeIn(this.demoTray, 220);
    await delay(this.app.ticker, 220); if (stale()) return;
    this._fadeIn(this.okBtn, 200);
    this.okBtn.eventMode = "static";
    await delay(this.app.ticker, 200); if (stale()) return;

    // The sequence is over: a tap anywhere now closes the popup.
    this.introDone = true;
    this._runDemo(run);
  }

  // Close for good. The host is told immediately — input goes back to the player
  // with no dead time — while the popup itself fades out and destroys.
  close() {
    if (this.closing) return;
    this.closing = true;
    this._run++;                 // invalidate every in-flight animation
    this.introDone = false;
    this.dim.eventMode = "none"; // stop swallowing taps the moment it starts leaving
    this.okBtn.eventMode = "none";
    this._writeMarker();
    if (this.onClose) this.onClose();
    tween(this.app.ticker, {
      duration: 180,
      onUpdate: (e) => { if (!this.destroyed) this.alpha = 1 - e; },
      onComplete: () => this.destroy(),
    });
  }

  // Nothing reads this back (see TUTORIAL_MARKER_KEY) — it is written for parity
  // with the original build. Storage can throw (private mode / disabled), and a
  // failed write must never break the tutorial.
  _writeMarker() {
    try { localStorage.setItem(TUTORIAL_MARKER_KEY, "1"); } catch (_) {}
  }

  destroy(opts) {
    if (this.destroyed) return; // close() and the host's teardown can both land here
    for (const fn of this._tickers) this.app.ticker.remove(fn);
    this._tickers = [];
    if (this.parent) this.parent.removeChild(this);
    super.destroy(opts || { children: true });
  }

  // ---- layout --------------------------------------------------------------

  // The dim covers the whole view; the group sits at its centre. Called by
  // GameScene.layout() on every resize.
  layout(DW, DH) {
    if (this.destroyed) return;
    this.dim.clear();
    this.dim.beginFill(0x040814, 0.72).drawRect(0, 0, DW, DH).endFill();
    this.group.position.set(DW / 2, DH / 2);
  }

  // ---- animation -----------------------------------------------------------

  _addTicker(fn) {
    this._tickers.push(fn);
    this.app.ticker.add(fn);
  }

  _fadeIn(obj, duration) {
    obj.alpha = 0;
    return tween(this.app.ticker, {
      duration,
      onUpdate: (e) => { if (!obj.destroyed) obj.alpha = e; },
    });
  }

  _spinRays() {
    const fn = () => {
      if (this.destroyed || this.rays.destroyed) { this.app.ticker.remove(fn); return; }
      this.rays.rotation += this.app.ticker.deltaMS * 0.00018;
    };
    this._addTicker(fn);
  }

  // Move an object to (x, y) over `duration`, resolving when it lands. Bails if
  // the popup closes mid-flight (the same destroyed-guard the scene's tweens use).
  _moveTo(obj, x, y, duration, run) {
    const sx = obj.x, sy = obj.y;
    return tween(this.app.ticker, {
      duration, ease: easeOutCubic,
      onUpdate: (e) => {
        if (obj.destroyed || this._run !== run) return;
        obj.x = sx + (x - sx) * e;
        obj.y = sy + (y - sy) * e;
      },
    });
  }

  // The looping demonstration: collect each type in turn, three tiles at a time,
  // and clear the triple the moment the third lands — the real game's loop, in
  // miniature. Runs until the popup closes (the generation token stops it).
  // The demo is a chain of awaits, so between any two of them the popup may have
  // been closed AND destroyed (leaving the level takes it with it). Every resume
  // point re-checks this before touching the display tree: comparing the
  // generation token alone isn't enough, because a destroy never bumps it — and
  // an addChild onto a destroyed container throws.
  _stale(run) { return this._run !== run || this.destroyed || this.closing; }

  async _runDemo(run) {
    const stale = () => this._stale(run);
    while (!stale()) {
      for (const type of [0, 1, 2]) {
        const tiles = this.demoTiles.filter((t) => t.type === type);
        for (let i = 0; i < tiles.length; i++) {
          await this._demoPick(tiles[i], i, run);
          if (stale()) return;
        }
        await this._demoMatch(run);
        if (stale()) return;
      }
      await delay(this.app.ticker, 520);
      if (stale()) return;
      await this._demoReset(run);
    }
  }

  // Hand travels to a tile, taps it, and the tile flies into the next tray slot.
  async _demoPick(tile, slotIndex, run) {
    const sp = tile.sprite;
    this.hand.alpha = 1;
    await this._moveTo(this.hand, sp.x, sp.y + 6, this._handPlaced ? 240 : 300, run);
    this._handPlaced = true;
    if (this._stale(run)) return;
    await this._handTap(run);
    if (this._stale(run)) return;
    // Lift the tile out of its row onto the demo itself, so it flies OVER the
    // tray panel and slots — then put the hand back on top of everything.
    const slot = this.demoSlots[slotIndex];
    this.demo.addChild(sp);
    this.demo.addChild(this.hand);
    this.trayTiles.push(tile);
    await this._moveTo(sp, slot.x, slot.y, 280, run);
  }

  // The finger dips and a ring pulses out of it — one tap.
  _handTap(run) {
    const icon = this.handIcon, ring = this.handRing;
    return tween(this.app.ticker, {
      duration: 340,
      ease: (t) => t,
      onUpdate: (p) => {
        if (this.destroyed || this._run !== run) return;
        const dip = p < 0.4 ? Math.sin((p / 0.4) * Math.PI) : 0;
        icon.position.set(0, 14 - dip * 12);
        icon.scale.set(1 - dip * 0.08);
        const rp = Math.min(1, p / 0.7);
        ring.clear();
        ring.lineStyle(5, 0xffffff, (1 - rp) * 0.8);
        ring.drawCircle(0, 0, 22 + rp * 30);
      },
    });
  }

  // Three of a kind in the tray: they pop and vanish, exactly as in the game.
  async _demoMatch(run) {
    await delay(this.app.ticker, 200);
    if (this._stale(run)) return;
    const tiles = this.trayTiles.slice();
    this.trayTiles = [];
    const base = tiles.map((t) => t.sprite.scale.x);
    await tween(this.app.ticker, {
      duration: 300,
      onUpdate: (e) => {
        if (this._run !== run) return;
        tiles.forEach((t, i) => {
          if (t.sprite.destroyed) return;
          t.sprite.scale.set(base[i] * (1 + 0.35 * Math.sin(Math.min(1, e * 1.6) * Math.PI)));
          t.sprite.alpha = 1 - e;
        });
      },
    });
    for (const t of tiles) if (!t.sprite.destroyed) t.sprite.visible = false;
  }

  // Put the board back the way it started and fade it in, so the loop can replay.
  async _demoReset(run) {
    if (this._stale(run)) return;
    this.hand.alpha = 0;
    this._handPlaced = false;
    for (const t of this.demoTiles) {
      if (t.sprite.destroyed) continue;
      t.sprite.position.set(t.home.x, t.home.y);
      t.sprite.width = t.sprite.height = DEMO_TILE;
      t.sprite.alpha = 0;
      t.sprite.visible = true;
      this.demoRows[t.row].addChild(t.sprite); // back into its row
    }
    await tween(this.app.ticker, {
      duration: 340,
      onUpdate: (e) => {
        if (this._run !== run) return;
        for (const t of this.demoTiles) if (!t.sprite.destroyed) t.sprite.alpha = e;
      },
    });
  }

  // ---- test seams ----------------------------------------------------------

  // Types currently sitting in the demo tray, and how many tiles are still on the
  // demo board — enough for a test to watch the demonstration actually run.
  demoState() {
    return {
      tray: this.trayTiles.map((t) => t.type),
      board: this.demoTiles.filter((t) => !t.sprite.destroyed && t.sprite.visible
        && !this.trayTiles.includes(t)).length,
    };
  }

  // Labels of every button the popup owns. There is no skip button anywhere in
  // this sequence, and this is what proves it.
  buttonLabels() {
    return [this.okBtn].filter((b) => b && !b.destroyed).map((b) => b.__label);
  }
}
