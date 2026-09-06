// The Super Wand promo — the explanatory modal behind the lobby rail's progress
// read-out. The read-out itself can only ever show a number ("3/5"); this is
// where the player finds out what the number is FOR: what the reward does, how
// it is charged, and how close they are.
//
// It is laid out like every other panel in this game — the same deep-blue rounded
// card with a gold title inside its top edge, content in the middle and one
// button along the bottom (cf. HowToPlayPopup and the win/lose overlays). The
// content is a framed illustration of the sweep (the upgraded wand blowing two
// complete sets apart) over a live progress strip.
//
// Everything is drawn, not loaded: this project has no promo artwork and no
// particle system, so the illustration is the same Graphics + emoji vocabulary
// the rest of the game is built from (cf. HowToPlayPopup, DailyBonusScene).
//
// It is a MODAL over the lobby, not a scene: the lobby owns it, keeps it as its
// topmost child and re-centres it on resize, so it needs no host wiring.

import { tween, easeOutBack } from "./tween.js";
import { t, locText } from "./i18n.js";
import { fitTextWidth, makeButton, makeProgressBar } from "./layout.js";
import { CONFIG } from "./config.js";
import { SUPER_WAND_FACE } from "./boosters.js";

const PANEL_W = 620;
const PANEL_H = 880;

// Panel-local geometry (0,0 = panel centre).
const TITLE_Y = -PANEL_H / 2 + 70;
const ART_TOP = -318;
const ART_H = 440;
const ART_W = 540;
const ART_CY = ART_TOP + ART_H / 2;
const LINE_Y = 176;
const CAP_Y = 240;
const BAR_Y = 284;
const BTN_Y = 372;
const TRACK_W = 380;
const TRACK_H = 26;

// The two colours of the illustrated sweep — three tiles each, because that is
// exactly what one sweep clears: two COMPLETE sets, never a partial one.
const ART_TILES = [
  { glyph: "🍓", tint: 0xff6b8a, at: [-168, -96] },
  { glyph: "🍓", tint: 0xff6b8a, at: [-186, 24] },
  { glyph: "🍓", tint: 0xff6b8a, at: [-118, 132] },
  { glyph: "🍋", tint: 0xffd23f, at: [168, -96] },
  { glyph: "🍋", tint: 0xffd23f, at: [186, 24] },
  { glyph: "🍋", tint: 0xffd23f, at: [118, 132] },
];

export class SuperWandPromo extends PIXI.Container {
  /**
   * @param app   the Pixi application (for its ticker)
   * @param user  the player profile — the strip reads the live streak off it
   * @param audio the shared audio manager
   */
  constructor(app, user, audio) {
    super();
    this.app = app;
    this.user = user;
    this.audio = audio;
    this.visible = false;
    this.viewW = 750; this.viewH = 1334;

    // Modal dim: swallows every tap aimed at the lobby behind, and closes on a
    // tap outside the panel (the panel itself stops taps reaching it).
    this.dim = new PIXI.Graphics();
    this.dim.eventMode = "static";
    this.dim.on("pointertap", () => {
      if (this.audio) this.audio.play("btn_01");
      this.close();
    });
    this.addChild(this.dim);

    // One centred group, so a resize re-centres the whole popup by moving a
    // single object — the same arrangement HowToPlayPopup uses.
    this.group = new PIXI.Container();
    this.addChild(this.group);

    this._build();
    this.layout(750, 1334);
  }

  // ---- construction --------------------------------------------------------

  _build() {
    const panel = new PIXI.Graphics();
    panel.beginFill(0x22335e, 1)
      .drawRoundedRect(-PANEL_W / 2, -PANEL_H / 2, PANEL_W, PANEL_H, 36).endFill();
    panel.lineStyle(6, 0xffffff, 0.15)
      .drawRoundedRect(-PANEL_W / 2, -PANEL_H / 2, PANEL_W, PANEL_H, 36);
    // The panel eats taps, so only the dim AROUND it closes the popup.
    panel.eventMode = "static";
    this.group.addChild(panel);

    // The title sits INSIDE the panel's top edge, in the gold-on-navy the rest of
    // the game titles its panels with (tutorial_title, the win/lose overlays).
    this.title = locText("superwand_title", {
      fontFamily: "Arial", fontSize: 54, fontWeight: "900", fill: 0xffe27a,
      stroke: 0x5a3a00, strokeThickness: 6,
    });
    this.title.anchor.set(0.5);
    this.title.position.set(0, TITLE_Y);
    fitTextWidth(this.title, PANEL_W - 80);
    this.group.addChild(this.title);

    this._buildArt();
    this._buildStrip();

    this.okBtn = makeButton({
      audio: this.audio, label: t("ui_ok"),
      w: 300, h: 88, cx: 0, cy: BTN_Y, color: 0x39c06a,
      onClick: () => this.close(),
    });
    this.group.addChild(this.okBtn);
  }

  // The illustration: the upgraded wand at the centre of a sunburst, blowing two
  // complete sets of three apart. Drawn, like every other effect in this game.
  _buildArt() {
    const frame = new PIXI.Graphics();
    frame.beginFill(0x2b4a86, 1)
      .drawRoundedRect(-ART_W / 2, ART_TOP, ART_W, ART_H, 24).endFill();
    frame.lineStyle(4, 0xffffff, 0.22)
      .drawRoundedRect(-ART_W / 2, ART_TOP, ART_W, ART_H, 24);
    this.group.addChild(frame);

    // Sunburst behind the wand. Its reach stays inside the frame, so no mask is
    // needed — the same trick HowToPlayPopup's rays use.
    const rays = new PIXI.Graphics();
    const count = 12, r1 = 46, r2 = 214, wdt = 0.19;
    for (let i = 0; i < count; i++) {
      const a = (i / count) * Math.PI * 2;
      // Nearly opaque: a low-alpha gold over a blue ground blends toward grey, so
      // the burst has to be painted as light, not as a tint.
      rays.beginFill(0xffe9a8, 0.78);
      rays.moveTo(Math.cos(a - wdt) * r1, Math.sin(a - wdt) * r1);
      rays.lineTo(Math.cos(a) * r2, Math.sin(a) * r2);
      rays.lineTo(Math.cos(a + wdt) * r1, Math.sin(a + wdt) * r1);
      rays.closePath();
      rays.endFill();
    }
    rays.position.set(0, ART_CY);
    this.group.addChild(rays);
    this.rays = rays;

    for (const spec of ART_TILES) {
      const c = new PIXI.Container();
      const g = new PIXI.Graphics();
      g.beginFill(0xf4f7ff).drawRoundedRect(-38, -38, 76, 76, 14).endFill();
      g.lineStyle(4, spec.tint, 0.95).drawRoundedRect(-38, -38, 76, 76, 14);
      const glyph = new PIXI.Text(spec.glyph, { fontFamily: "Arial", fontSize: 46 });
      glyph.anchor.set(0.5);
      c.addChild(g, glyph);
      c.position.set(spec.at[0], ART_CY + spec.at[1]);
      // A slight, deterministic cant so the six read as blown outward rather than
      // laid out on a grid.
      c.rotation = (spec.at[0] / 600) + (spec.at[1] / 1400);
      this.group.addChild(c);
    }

    const disc = new PIXI.Graphics();
    disc.beginFill(SUPER_WAND_FACE.color).drawCircle(0, 0, 62).endFill();
    disc.lineStyle(5, 0xffffff, 0.7).drawCircle(0, 0, 62);
    disc.position.set(0, ART_CY);
    const wand = new PIXI.Text(SUPER_WAND_FACE.glyph, { fontFamily: "Arial", fontSize: 66 });
    wand.anchor.set(0.5);
    wand.position.copyFrom(disc.position);
    this.group.addChild(disc, wand);
    this.disc = disc;

    this.line = locText("superwand_promo_line", {
      fontFamily: "Arial", fontSize: 28, fontWeight: "700", fill: 0xd7e2ff,
      align: "center", wordWrap: true, wordWrapWidth: PANEL_W - 90,
    });
    this.line.anchor.set(0.5);
    this.line.position.set(0, LINE_Y);
    this.group.addChild(this.line);
  }

  // The progress strip — where the reference promo puts its status bar. It is
  // the answer to "how do I get one": the streak caption over a live meter.
  _buildStrip() {
    const needed = CONFIG.boosters.superWand.streakLength;

    // Two bound labels rather than one re-lettered by hand: each carries its own
    // key, so a language swap re-letters whichever is showing for free.
    const capStyle = {
      fontFamily: "Arial", fontSize: 26, fontWeight: "900", fill: 0xffc07a,
      stroke: 0x5a2400, strokeThickness: 4,
    };
    this.capStreak = locText("superwand_streak", capStyle, needed);
    this.capReady = locText("superwand_ready", capStyle);
    for (const c of [this.capStreak, this.capReady]) {
      c.anchor.set(0.5);
      c.position.set(0, CAP_Y);
      fitTextWidth(c, PANEL_W - 90);
      this.group.addChild(c);
    }

    // Outlined, like the lobby's chest bar: this one sits on the promo's art
    // rather than on a flat overlay panel.
    this.bar = makeProgressBar({ w: TRACK_W, h: TRACK_H, color: 0xffcf4d, outline: true });
    this.bar.node.y = BAR_Y;
    this.group.addChild(this.bar.node);
    this.barLabel = this.bar.label;
  }

  // ---- state ---------------------------------------------------------------

  /** Repaint the meter from the profile. Charged pins it full and swaps the
   *  caption to "ready", exactly like the lobby rail's pill. */
  refresh() {
    const needed = CONFIG.boosters.superWand.streakLength;
    const charged = !!this.user && this.user.superWandCharged();
    const streak = charged
      ? needed
      : Math.min(needed, this.user ? this.user.superWandStreak() : 0);
    this.capStreak.visible = !charged;
    this.capReady.visible = charged;
    this.bar.draw(streak, needed);
  }

  /** The live state of the popup, for the debug API / tests. */
  state() {
    return {
      open: this.visible,
      title: this.title.text,
      line: this.line.text,
      caption: (this.capReady.visible ? this.capReady : this.capStreak).text,
      label: this.barLabel.text,
      button: this.okBtn.label.text,
    };
  }

  /** Re-fit the text this popup lays out itself. The strings re-letter on their
   *  own (locText binds them), but a translation is rarely the same width. */
  relocalize() {
    this.okBtn.label.text = t("ui_ok");
    fitTextWidth(this.title, PANEL_W - 80);
    for (const c of [this.capStreak, this.capReady]) fitTextWidth(c, PANEL_W - 90);
  }

  layout(DW, DH) {
    this.viewW = DW; this.viewH = DH;
    this.dim.clear();
    this.dim.beginFill(0x040814, 0.66).drawRect(0, 0, DW, DH).endFill();
    this.group.position.set(DW / 2, DH / 2);
  }

  open() {
    if (this.visible) return;
    this.refresh();
    this.visible = true;
    this.group.scale.set(0.6);
    tween(this.app.ticker, {
      duration: 320, ease: easeOutBack,
      onUpdate: (e) => this.group.scale.set(0.6 + 0.4 * e),
    });
  }

  close() {
    if (!this.visible) return;
    this.visible = false;
  }
}
