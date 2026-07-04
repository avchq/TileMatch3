// Lobby / home screen — shown on load and after each completed level.
// Displays the game title and a big centred "Level <n>" button that starts the
// next level the player is on. Styled to match the in-game chrome (rounded
// buttons, same palette + backgrounds) in the spirit of the original Cocos game.

import { tween, easeOutBack } from "./tween.js";

const DESIGN_W = 750;
const DESIGN_H = 1334;

export class LobbyScene extends PIXI.Container {
  constructor(app, backgrounds, audio, maxLevel) {
    super();
    this.app = app;
    this.backgrounds = backgrounds; // { 1: tex, 2: tex, 3: tex }
    this.audio = audio;
    this.maxLevel = maxLevel;
    this.onPlay = null; // (levelNum) => void

    this.bgLayer = new PIXI.Container();
    this.uiLayer = new PIXI.Container();
    this.addChild(this.bgLayer, this.uiLayer);

    this._buildStatic();
  }

  _buildStatic() {
    // Title block
    this.title = new PIXI.Text("TILE MATCH 3", {
      fontFamily: "Arial", fontSize: 82, fontWeight: "900", fill: 0xffe27a,
      stroke: 0x5a3a00, strokeThickness: 9, align: "center",
    });
    this.title.anchor.set(0.5);
    this.title.position.set(DESIGN_W / 2, 330);
    this.uiLayer.addChild(this.title);

    this.subtitle = new PIXI.Text("Match 3 fruits · clear the board", {
      fontFamily: "Arial", fontSize: 32, fontWeight: "700", fill: 0xdce7ff,
      stroke: 0x122043, strokeThickness: 4,
    });
    this.subtitle.anchor.set(0.5);
    this.subtitle.position.set(DESIGN_W / 2, 420);
    this.uiLayer.addChild(this.subtitle);

    // A little fruity flourish
    const fruits = new PIXI.Text("🍉  🍓  🍊  🍇  🍋", { fontFamily: "Arial", fontSize: 60 });
    fruits.anchor.set(0.5);
    fruits.position.set(DESIGN_W / 2, 520);
    this.uiLayer.addChild(fruits);

    // Level-progress dots (1..maxLevel)
    this.dotLayer = new PIXI.Container();
    this.uiLayer.addChild(this.dotLayer);

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
      const sp = new PIXI.Sprite(tex);
      const scale = Math.max(DESIGN_W / tex.width, DESIGN_H / tex.height);
      sp.scale.set(scale);
      sp.anchor.set(0.5);
      sp.position.set(DESIGN_W / 2, DESIGN_H / 2);
      this.bgLayer.addChild(sp);
    }
    const dark = new PIXI.Graphics();
    dark.beginFill(0x0a1226, 0.5).drawRect(0, 0, DESIGN_W, DESIGN_H).endFill();
    this.bgLayer.addChild(dark);
  }

  _buildDots(level) {
    this.dotLayer.removeChildren();
    const n = this.maxLevel;
    const gap = 54;
    const startX = DESIGN_W / 2 - ((n - 1) * gap) / 2;
    for (let i = 1; i <= n; i++) {
      const done = i < level;          // levels already cleared
      const current = i === level;     // the one you're about to play
      const dot = new PIXI.Graphics();
      const color = done ? 0x39c06a : current ? 0xffe27a : 0x54648c;
      dot.beginFill(color, 1).drawCircle(0, 0, current ? 15 : 11).endFill();
      dot.lineStyle(3, 0xffffff, 0.5).drawCircle(0, 0, current ? 15 : 11);
      dot.position.set(startX + (i - 1) * gap, 640);
      this.dotLayer.addChild(dot);
    }
  }

  /** Show the lobby for the given level (the next level to play). */
  show(level, { celebrate = false } = {}) {
    this._level = level;
    this._locked = false;
    this.visible = true;
    this._buildBackground(level);
    this._buildDots(level);
    this.playBtn.label.text = `Level ${level}`;

    const allDone = celebrate && level >= this.maxLevel;
    this.subtitle.text = allDone
      ? "All levels cleared — nice!"
      : celebrate
        ? "Level complete!"
        : "Match 3 fruits · clear the board";

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
