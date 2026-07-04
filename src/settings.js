// Settings screen — an overlay shown on top of whichever scene is active (lobby
// or game). Two toggles (Music = background music, Sound = tap/match SFX) plus a
// Back button that returns to the previous screen. The toggles drive the audio
// channels (audio.setMusic / setSound), which persist to the User profile via
// the onMusicChange / onSoundChange callbacks wired up in main.js.

import { tween, easeOutBack } from "./tween.js";

const DESIGN_W = 750;
const DESIGN_H = 1334;

// A round HUD button showing a cog icon. Used top-right of the lobby and the
// level scene to open the settings screen. Caller positions it.
export function makeCogButton(audio, onTap) {
  const size = 76;
  const bg = 0x334063;
  const c = new PIXI.Container();
  const g = new PIXI.Graphics();
  g.beginFill(bg).drawRoundedRect(-size / 2, -size / 2, size, size, size / 2.4).endFill();
  g.lineStyle(4, 0xffffff, 0.35).drawRoundedRect(-size / 2, -size / 2, size, size, size / 2.4);
  c.addChild(g);
  c.addChild(makeCog(size * 0.34, 0xffffff, bg));
  c.eventMode = "static";
  c.cursor = "pointer";
  c.on("pointertap", () => { audio.play("btn_01"); onTap(); });
  c.on("pointerdown", () => c.scale.set(0.92));
  c.on("pointerup", () => c.scale.set(1));
  c.on("pointerupoutside", () => c.scale.set(1));
  return c;
}

// Draw a cog/gear glyph: a toothed body with a punched centre hole (drawn in
// holeColor so it reads as a hole over the button background).
function makeCog(r, color, holeColor) {
  const c = new PIXI.Container();
  const teeth = 8;
  const toothW = r * 0.42, toothH = r * 0.5;
  for (let i = 0; i < teeth; i++) {
    const a = (i / teeth) * Math.PI * 2;
    const t = new PIXI.Graphics();
    t.beginFill(color).drawRoundedRect(-toothW / 2, -toothH / 2, toothW, toothH, toothW * 0.3).endFill();
    t.position.set(Math.cos(a) * r * 0.92, Math.sin(a) * r * 0.92);
    t.rotation = a + Math.PI / 2;
    c.addChild(t);
  }
  const body = new PIXI.Graphics();
  body.beginFill(color).drawCircle(0, 0, r * 0.95).endFill();
  body.beginFill(holeColor).drawCircle(0, 0, r * 0.4).endFill();
  c.addChild(body);
  return c;
}

export class SettingsScene extends PIXI.Container {
  constructor(app, audio) {
    super();
    this.app = app;
    this.audio = audio;
    this.onBack = null; // () => void — optional hook when returning
    this.visible = false;
    this._build();
  }

  _build() {
    // Full-screen dim that also swallows taps meant for the scene beneath.
    const dim = new PIXI.Graphics();
    dim.beginFill(0x040814, 0.72).drawRect(0, 0, DESIGN_W, DESIGN_H).endFill();
    dim.eventMode = "static";
    this.addChild(dim);

    // Panel
    const pw = 600, ph = 580;
    const px = (DESIGN_W - pw) / 2, py = (DESIGN_H - ph) / 2;
    this.panel = new PIXI.Container();
    this.panel.position.set(DESIGN_W / 2, DESIGN_H / 2); // pivot at centre for the entrance pop
    this.addChild(this.panel);

    const g = new PIXI.Graphics();
    g.beginFill(0x22335e, 1).drawRoundedRect(-pw / 2, -ph / 2, pw, ph, 36).endFill();
    g.lineStyle(6, 0xffffff, 0.15).drawRoundedRect(-pw / 2, -ph / 2, pw, ph, 36);
    this.panel.addChild(g);

    const title = new PIXI.Text("Settings", {
      fontFamily: "Arial", fontSize: 60, fontWeight: "900", fill: 0xffe27a,
      stroke: 0x5a3a00, strokeThickness: 6,
    });
    title.anchor.set(0.5);
    title.position.set(0, -ph / 2 + 78);
    this.panel.addChild(title);

    // Two toggle rows (coordinates relative to the panel centre)
    const labelX = -pw / 2 + 56;
    const toggleX = pw / 2 - 92;
    this.musicToggle = this._buildRow("Music", labelX, toggleX, -40, (on) => this.audio.setMusic(on));
    this.soundToggle = this._buildRow("Sound", labelX, toggleX, 70, (on) => this.audio.setSound(on));

    // Back button
    const back = this._makeButton("Back", 300, 88, 0, ph / 2 - 84, 0x4d8dff, () => this._back());
    this.panel.addChild(back);
  }

  _buildRow(labelText, labelX, toggleX, y, onChange) {
    const label = new PIXI.Text(labelText, {
      fontFamily: "Arial", fontSize: 42, fontWeight: "800", fill: 0xffffff,
    });
    label.anchor.set(0, 0.5);
    label.position.set(labelX, y);
    this.panel.addChild(label);
    const toggle = this._makeToggle(toggleX, y, true, onChange);
    this.panel.addChild(toggle);
    return toggle;
  }

  // A sliding on/off switch. Exposes __set(on) to sync it to the live state.
  _makeToggle(cx, cy, initial, onChange) {
    const c = new PIXI.Container();
    c.position.set(cx, cy);
    const w = 108, h = 54, r = h / 2;
    const track = new PIXI.Graphics();
    const knob = new PIXI.Graphics();
    c.addChild(track, knob);
    let state = !!initial;
    const draw = () => {
      track.clear();
      track.beginFill(state ? 0x39c06a : 0x54648c, 1)
        .drawRoundedRect(-w / 2, -h / 2, w, h, r).endFill();
      track.lineStyle(3, 0xffffff, 0.25).drawRoundedRect(-w / 2, -h / 2, w, h, r);
      knob.clear();
      knob.beginFill(0xffffff).drawCircle(0, 0, r - 7).endFill();
      knob.position.set(state ? (w / 2 - r) : (-w / 2 + r), 0);
    };
    draw();
    c.eventMode = "static";
    c.cursor = "pointer";
    c.on("pointertap", () => {
      state = !state;
      draw();
      this.audio.play("btn_01");
      onChange(state);
    });
    c.__set = (on) => { state = !!on; draw(); };
    return c;
  }

  _makeButton(label, w, h, cx, cy, color, onClick) {
    const c = new PIXI.Container();
    c.position.set(cx, cy);
    const g = new PIXI.Graphics();
    g.beginFill(color).drawRoundedRect(-w / 2, -h / 2, w, h, h / 2.4).endFill();
    g.lineStyle(4, 0xffffff, 0.35).drawRoundedRect(-w / 2, -h / 2, w, h, h / 2.4);
    const t = new PIXI.Text(label, {
      fontFamily: "Arial", fontSize: 36, fontWeight: "800", fill: 0xffffff,
    });
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

  // Show the screen, syncing the toggles to the current audio state.
  open() {
    this.visible = true;
    this.musicToggle.__set(this.audio.musicOn);
    this.soundToggle.__set(this.audio.soundOn);
    this.panel.scale.set(0.6);
    tween(this.app.ticker, {
      duration: 300, ease: easeOutBack,
      onUpdate: (e) => this.panel.scale.set(0.6 + 0.4 * e),
    });
  }

  _back() {
    this.audio.play("btn_01");
    this.visible = false;
    if (this.onBack) this.onBack();
  }
}
