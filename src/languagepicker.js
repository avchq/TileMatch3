// The LANGUAGE PICKER — the scrolling list behind the settings screen's
// Language row.
//
// It lists all 13 languages the game offers, in the order src/i18n.js declares
// them, with the current one tick-marked and scrolled into view. The names are
// NOT translated: each language is written in its own language (or in English,
// for the Asian ones), so a Russian player browsing the list still recognises
// "Deutsch" and "Traditional Chinese". The heading is the only word in the
// popup that changes with the language.
//
// Tapping a row moves the tick and NOTHING ELSE — the choice only applies on
// Confirm. Closing the popup any other way discards it.

import { tween, easeOutBack } from "./tween.js";
import { fitPanel, fitTextWidth } from "./layout.js";
import { i18n, locText, LANGUAGES } from "./i18n.js";

const DESIGN_W = 750;
const DESIGN_H = 1334;

// Panel + list geometry (layout constants, so they live with the scene that
// draws them rather than in config.js).
const PANEL_W = 620, PANEL_H = 940;
const LIST_W = 540;
const LIST_TOP = -PANEL_H / 2 + 150;
const ROW_W = 520, ROW_H = 66, ROW_PITCH = 74;

// The two footer buttons are pinned to the panel's BOTTOM edge, so the list gets
// whatever height is left above them. LIST_H is derived rather than hard-coded:
// as three independent constants they drifted, and Confirm ended up drawn over
// the bottom of the list. This way the list can never grow back into the buttons
// when the panel or the footer is retuned (languagepicker_test.py checks it).
const CONFIRM_W = 300, CONFIRM_H = 86, CONFIRM_CY = PANEL_H / 2 - 152;
const BACK_W = 220, BACK_H = 74, BACK_CY = PANEL_H / 2 - 58;
const FOOTER_GAP = 40;  // clear space between the list's bottom edge and Confirm
const LIST_H = (CONFIRM_CY - CONFIRM_H / 2 - FOOTER_GAP) - LIST_TOP;

export class LanguagePickerScene extends PIXI.Container {
  constructor(app, audio) {
    super();
    this.app = app;
    this.audio = audio;
    this.onBack = null;     // () => void — fired whichever way the popup closes
    this.visible = false;
    // The row currently ticked. Starts at the active language on every open and
    // is thrown away unless Confirm is pressed.
    this._picked = i18n.code;
    this._rows = [];
    this._build();
  }

  // Cover the whole view with the dim and keep the panel centred (see
  // SettingsScene.layout — the same arrangement).
  layout(DW, DH) {
    this.dim.clear();
    this.dim.beginFill(0x040814, 0.72).drawRect(0, 0, DW, DH).endFill();
    this.panel.position.set(DW / 2, DH / 2);
    fitPanel(this.panel, DW, DH);
  }

  /** The independent controls this overlay owns (for the resize/overlap test). */
  controls() {
    return [{ name: "panel", obj: this.panel }];
  }

  _build() {
    const dim = new PIXI.Graphics();
    dim.beginFill(0x040814, 0.72).drawRect(0, 0, DESIGN_W, DESIGN_H).endFill();
    dim.eventMode = "static";
    // Tapping the dim closes without applying — the same as Back.
    dim.on("pointertap", () => this._close());
    dim.cursor = "default";
    this.addChild(dim);
    this.dim = dim;

    this.panel = new PIXI.Container();
    this.panel.position.set(DESIGN_W / 2, DESIGN_H / 2);
    this.addChild(this.panel);

    const g = new PIXI.Graphics();
    g.beginFill(0x22335e, 1).drawRoundedRect(-PANEL_W / 2, -PANEL_H / 2, PANEL_W, PANEL_H, 36).endFill();
    g.lineStyle(6, 0xffffff, 0.15).drawRoundedRect(-PANEL_W / 2, -PANEL_H / 2, PANEL_W, PANEL_H, 36);
    // The panel swallows taps so a miss inside it doesn't reach the dim.
    g.eventMode = "static";
    this.panel.addChild(g);

    // The one translated word in the popup.
    this.title = locText("language", {
      fontFamily: "Arial", fontSize: 58, fontWeight: "900", fill: 0xffe27a,
      stroke: 0x5a3a00, strokeThickness: 6,
    });
    this.title.anchor.set(0.5);
    this.title.position.set(0, -PANEL_H / 2 + 76);
    this.panel.addChild(this.title);

    // ---- the scrolling list -------------------------------------------------
    // A masked viewport over a taller content container whose y IS the scroll
    // offset — the same arrangement as the Tasks screen's list, the only other
    // scrolling surface in the game.
    this.listView = new PIXI.Container();
    this.listView.position.set(0, LIST_TOP);
    this.panel.addChild(this.listView);

    const maskG = new PIXI.Graphics();
    maskG.beginFill(0xffffff).drawRoundedRect(-LIST_W / 2, 0, LIST_W, LIST_H, 24).endFill();
    this.listView.addChild(maskG);
    this.listView.mask = maskG;

    this.listContent = new PIXI.Container();
    this.listView.addChild(this.listContent);

    // The viewport takes the drag; its children still get their taps, because a
    // gesture only becomes a scroll once it has actually moved (_dragged is what
    // stops a scroll from also picking a language).
    this.listView.eventMode = "static";
    this.listView.hitArea = new PIXI.Rectangle(-LIST_W / 2, 0, LIST_W, LIST_H);
    this.listView.on("pointerdown", (e) => {
      this._dragging = true;
      this._dragged = false;
      this._dragY = this.listView.toLocal(e.global).y;
      this._dragFrom = this.listContent.y;
    });
    this.listView.on("globalpointermove", (e) => {
      if (!this._dragging) return;
      const dy = this.listView.toLocal(e.global).y - this._dragY;
      if (Math.abs(dy) > 6) this._dragged = true;
      this._setScroll(this._dragFrom + dy);
    });
    const endDrag = () => { this._dragging = false; };
    this.listView.on("pointerup", endDrag);
    this.listView.on("pointerupoutside", endDrag);

    // One row per offered language, in the order i18n.js declares them.
    let y = ROW_H / 2 + 8;
    for (const lang of LANGUAGES) {
      const row = this._makeRow(lang, y);
      this.listContent.addChild(row);
      this._rows.push(row);
      y += ROW_PITCH;
    }
    this._contentH = y - ROW_PITCH + ROW_H / 2 + 8;

    // Confirm is the only thing that applies the choice.
    this.confirmBtn = this._makeButton("btn_confirm", CONFIRM_W, CONFIRM_H, 0, CONFIRM_CY,
      0x39c06a, () => this._confirm());
    this.panel.addChild(this.confirmBtn);

    this.backBtn = this._makeButton("btn_back", BACK_W, BACK_H, 0, BACK_CY, 0x3a4a72,
      () => this._close());
    this.panel.addChild(this.backBtn);
  }

  // A language row: its own name on the left, a tick on the right when it is the
  // picked one. The name is deliberately NOT run through i18n.
  _makeRow(lang, y) {
    const c = new PIXI.Container();
    c.position.set(0, y);
    c.__code = lang.code;

    const g = new PIXI.Graphics();
    c.addChild(g);
    c.__g = g;

    const name = new PIXI.Text(lang.label, {
      fontFamily: "Arial", fontSize: 32, fontWeight: "800", fill: 0xffffff,
    });
    name.anchor.set(0, 0.5);
    name.position.set(-ROW_W / 2 + 28, 0);
    fitTextWidth(name, ROW_W - 110); // keep clear of the tick
    c.addChild(name);
    c.__name = name;

    const tick = new PIXI.Text("✓", {
      fontFamily: "Arial", fontSize: 38, fontWeight: "900", fill: 0x8ef0b0,
    });
    tick.anchor.set(0.5);
    tick.position.set(ROW_W / 2 - 34, 0);
    c.addChild(tick);
    c.__tick = tick;

    c.eventMode = "static";
    c.cursor = "pointer";
    c.hitArea = new PIXI.Rectangle(-ROW_W / 2, -ROW_H / 2, ROW_W, ROW_H);
    c.on("pointertap", () => {
      if (this._dragged) return; // that gesture was a scroll, not a pick
      this.pick(lang.code);
    });

    c.__set = (on) => {
      g.clear();
      g.beginFill(on ? 0x35508f : 0x1b2a4e, 1)
        .drawRoundedRect(-ROW_W / 2, -ROW_H / 2, ROW_W, ROW_H, 18).endFill();
      if (on) {
        g.lineStyle(3, 0x8ef0b0, 0.9)
          .drawRoundedRect(-ROW_W / 2, -ROW_H / 2, ROW_W, ROW_H, 18);
      }
      tick.visible = on;
    };
    c.__set(false);
    return c;
  }

  _makeButton(key, w, h, cx, cy, color, onClick) {
    const c = new PIXI.Container();
    c.position.set(cx, cy);
    // The drawn size, kept on the container so geometry() can measure the button
    // without re-deriving it from the constants it is meant to be checking.
    c.__w = w; c.__h = h;
    const g = new PIXI.Graphics();
    g.beginFill(color).drawRoundedRect(-w / 2, -h / 2, w, h, h / 2.4).endFill();
    g.lineStyle(4, 0xffffff, 0.35).drawRoundedRect(-w / 2, -h / 2, w, h, h / 2.4);
    const t = locText(key, {
      fontFamily: "Arial", fontSize: 34, fontWeight: "800", fill: 0xffffff,
    });
    t.anchor.set(0.5);
    c.addChild(g, t);
    c.label = t;
    c.eventMode = "static";
    c.cursor = "pointer";
    c.on("pointertap", () => { this.audio.play("btn_01"); onClick(); });
    c.on("pointerdown", () => c.scale.set(0.95));
    c.on("pointerup", () => c.scale.set(1));
    c.on("pointerupoutside", () => c.scale.set(1));
    return c;
  }

  // ---- picking --------------------------------------------------------------

  /** Move the tick. Changes nothing else — Confirm is what applies it. */
  pick(code) {
    if (this._picked !== code) this.audio.play("btn_02");
    this._picked = code;
    for (const r of this._rows) r.__set(r.__code === code);
  }

  /** The row currently ticked (not necessarily the active language). */
  picked() { return this._picked; }

  // ---- scrolling ------------------------------------------------------------

  _setScroll(y) {
    const min = Math.min(0, LIST_H - this._contentH);
    this.listContent.y = Math.max(min, Math.min(0, y));
  }

  // Put the given row in the middle of the viewport, clamped to the ends — so
  // the current choice is on screen the moment the popup opens.
  _scrollTo(code) {
    const idx = LANGUAGES.findIndex((l) => l.code === code);
    if (idx < 0) return this._setScroll(0);
    const rowCentre = ROW_H / 2 + 8 + idx * ROW_PITCH;
    this._setScroll(LIST_H / 2 - rowCentre);
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

  /**
   * Panel-local rects of the panel, the masked list viewport and the two footer
   * buttons, read off the LIVE display objects (test hook). The list viewport is
   * the drag hitArea, which is drawn to match the mask; the buttons carry their
   * own size. languagepicker_test.py asserts the list ends clear above Confirm —
   * Confirm used to be drawn over the bottom of the list.
   */
  geometry() {
    const r = this.listView.hitArea;
    const btn = (b) => ({ x: b.x - b.__w / 2, y: b.y - b.__h / 2, w: b.__w, h: b.__h });
    return {
      panel: { x: -PANEL_W / 2, y: -PANEL_H / 2, w: PANEL_W, h: PANEL_H },
      list: { x: r.x, y: this.listView.y + r.y, w: r.width, h: r.height },
      confirm: btn(this.confirmBtn),
      back: btn(this.backBtn),
    };
  }

  /** Whether a row is inside the masked viewport right now (test hook). */
  rowVisible(code) {
    const idx = LANGUAGES.findIndex((l) => l.code === code);
    if (idx < 0) return false;
    const top = this.listContent.y + 8 + idx * ROW_PITCH;
    return top >= -1 && top + ROW_H <= LIST_H + 1;
  }

  // ---- open / close ---------------------------------------------------------

  /** Show the picker, ticking (and scrolling to) the ACTIVE language. */
  open() {
    this.visible = true;
    this.pick(i18n.code);
    this._scrollTo(i18n.code);
    this._dragging = false;
    this._dragged = false;
    this.panel.scale.set(0.6);
    tween(this.app.ticker, {
      duration: 300, ease: easeOutBack,
      onUpdate: (e) => this.panel.scale.set(0.6 + 0.4 * e),
    });
  }

  /**
   * Apply the picked language. Picking the one already in use just closes.
   * Otherwise the table is downloaded, swapped in and every label on screen
   * re-lettered (i18n.setLanguage), and then the popup closes — a failed
   * download closes it too, having still recorded the choice.
   */
  async _confirm() {
    const code = this._picked;
    if (code !== i18n.code) await i18n.setLanguage(code);
    this._close({ silent: true });
  }

  _close({ silent = false } = {}) {
    if (!this.visible) return;
    if (!silent) this.audio.play("btn_01");
    this.visible = false;
    if (this.onBack) this.onBack();
  }

  /**
   * Re-letter. The heading and both buttons carry their keys and refresh
   * themselves; the row names are never translated. Only the tick needs
   * re-pointing, at the language that just became active.
   */
  relocalize() {
    if (this.visible) this.pick(i18n.code);
  }
}
