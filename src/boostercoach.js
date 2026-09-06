// The coached first use of a helper — what happens on the level a booster
// unlocks. Unlocking alone teaches nothing: the button simply stops being grey.
// So the first time a helper is available, the level dims, THAT ONE BUTTON is
// lifted out of the dim with a caption and a pulsing tap effect, and the only
// thing the player can do is use it once, for real.
//
// Deliberately NOT a fake demo: the button keeps its own pointertap handler, so
// the tap runs the real helper, spends a real charge, and the player watches
// their own board react. GameScene owns the "guiding" state that parks the rest
// of the level while this is up (see _maybeCoachBooster / _closeCoach); this
// file is only the presentation.
//
// It also has NO dismissal path — no OK button, and the dim swallows taps
// without closing (unlike HowToPlayPopup.dim, which closes on tap once its
// intro has played). Using the helper is the only way out, which is the point:
// the lesson is the use.

import { DESIGN_W, DESIGN_H, makeHintPill } from "./layout.js";
import { t } from "./i18n.js";
import { boosterFace } from "./boosters.js";

/** The caption for a helper's coached first use, in the active language.
 *
 *  The TEXT KEY is a field on the helper's row in src/boosters.js, beside its
 *  glyph and disc colour — one row per helper, so adding one does not mean
 *  remembering a second table here. What it names is presentation, not a
 *  tunable: the SCHEDULE (which level, how much stock) is CONFIG.boosters.
 *  unlocks, and the wording itself is in the language tables. */
export function coachCaption(kind) {
  const key = boosterFace(kind).coachKey;
  return key ? t(key) : "";
}

const DIM_COLOR = 0x040814;
const DIM_ALPHA = 0.72;   // same modal dim as SettingsScene / HowToPlayPopup
const CAPTION_DY = -130;  // above the button, clear of the tap ring (r up to 80)
const BEAT_MS = 1200;     // one press-and-ripple cycle, as the guidance hand

export class BoosterCoach extends PIXI.Container {
  // `btn` / `badge` are the live helper button and its count bubble, on loan
  // from the scene's hudBottom: they are reparented in here (above the dim) so
  // they stay bright, and handed back untouched by close(). `home` records where
  // they sit on the helper row so both the re-layout and the restore can put
  // them back exactly.
  constructor(app, kind, btn, badge) {
    super();
    this.app = app;
    this.kind = kind;
    this.btn = btn;
    this.badge = badge;
    this.caption = coachCaption(kind);
    this.closed = false;
    this._home = { bx: btn.x, by: btn.y, gx: badge.x, gy: badge.y };
    this._homeParent = btn.parent;
    this._tickers = [];

    // Modal dim. Swallows every tap aimed at the level behind it and, unlike the
    // How To Play dim, does NOT close on tap — there is no way out but the button.
    this.dim = new PIXI.Graphics();
    this.dim.eventMode = "static";
    this.addChild(this.dim);

    // Lift the button and its badge out of the HUD, above the dim. Their world
    // position is restored in layout() from `home` + the current offsets, so no
    // getGlobalPosition round-trip is needed — the helper row's coordinates are
    // fixed constants in GameScene.
    this.addChild(btn, badge);

    this._buildCaption();
    this._buildTapFx();
    this.layout(DESIGN_W, DESIGN_H); // sane placement before the host's first layout()
  }

  // ---- construction --------------------------------------------------------

  // The shared dark-glass pill (layout.js `makeHintPill`, the same one GameScene
  // floats for "Unlocks at Level N" / "Insufficient space!"), but STATIC: it is
  // opaque from the start and holds until the coaching closes instead of fading
  // itself out after a beat.
  _buildCaption() {
    const c = makeHintPill(this.caption);
    c.alpha = 1;
    c.__halfW = c.__w / 2 + 8; // clamp margin, so a pill on an edge helper stays in the band
    this.captionPill = c;
    this.addChild(c);
  }

  // A tapping finger over an expanding ripple ring — the same beat as the
  // guidance hand that points at a tile on the first level (GameScene._showHand),
  // sized to sit around a helper button rather than a tile.
  _buildTapFx() {
    const c = new PIXI.Container();
    c.eventMode = "none"; // never steals the tap it is asking for
    const ring = new PIXI.Graphics();
    c.addChild(ring);
    // Smaller and tucked closer than the guidance hand that points at a tile: the
    // helper row sits ~68px off the bottom of the design space, so a finger hung
    // below the button the way it hangs below a tile would run off the screen.
    // It overlaps the button's lower edge instead, and still points at it.
    const hand = new PIXI.Text("👆", {
      fontFamily: '"Noto Color Emoji","Apple Color Emoji","Segoe UI Emoji",Arial',
      fontSize: 52,
    });
    hand.anchor.set(0.5, 0);
    c.addChild(hand);
    this.fx = c;
    this.addChild(c);

    let beat = 0;
    this._addTicker(() => {
      beat = (beat + this.app.ticker.deltaMS) % BEAT_MS;
      const p = beat / BEAT_MS;
      const dip = p < 0.25 ? Math.sin((p / 0.25) * Math.PI) : 0; // quick press
      hand.position.set(0, 6 - dip * 14);
      hand.scale.set(1 - dip * 0.08);
      const rp = Math.min(1, p / 0.6);
      ring.clear();
      ring.lineStyle(5, 0xffffff, (1 - rp) * 0.75);
      ring.drawCircle(0, 0, 44 + rp * 36);
    });
  }

  // Register a ticker loop and keep the handle, so close() can remove it. Same
  // bookkeeping as HowToPlayPopup._addTicker.
  _addTicker(fn) {
    const wrapped = () => {
      if (this.destroyed || this.closed) { this.app.ticker.remove(wrapped); return; }
      fn();
    };
    this._tickers.push(wrapped);
    this.app.ticker.add(wrapped);
    return wrapped;
  }

  // ---- layout --------------------------------------------------------------

  // The dim covers the whole view; the lifted button goes back onto the helper
  // row using the same offsets GameScene.layout() gives hudBottom, so a resize
  // mid-coaching keeps it exactly where the row is.
  layout(DW, DH) {
    this.dim.clear();
    this.dim.beginFill(DIM_COLOR, DIM_ALPHA).drawRect(0, 0, DW, DH).endFill();

    const ox = (DW - DESIGN_W) / 2;
    const oy = DH - DESIGN_H;
    const bx = ox + this._home.bx, by = oy + this._home.by;
    this.btn.position.set(bx, by);
    this.badge.position.set(ox + this._home.gx, oy + this._home.gy);
    this.fx.position.set(bx, by);

    const half = this.captionPill.__halfW;
    this.captionPill.position.set(
      Math.min(ox + DESIGN_W - half, Math.max(ox + half, bx)), by + CAPTION_DY);
  }

  // ---- teardown ------------------------------------------------------------

  // Hand the button and badge back to the helper row, at the coordinates they
  // were lent from, and tear everything else down. Safe to call twice.
  close() {
    if (this.closed) return;
    this.closed = true;
    for (const fn of this._tickers) this.app.ticker.remove(fn);
    this._tickers = [];
    if (this._homeParent && !this._homeParent.destroyed) {
      this._homeParent.addChild(this.btn, this.badge);
      this.btn.position.set(this._home.bx, this._home.by);
      this.badge.position.set(this._home.gx, this._home.gy);
    }
    if (this.parent) this.parent.removeChild(this);
    this.destroy({ children: true });
  }

  // Test seam (window.__game.boosterCoachState()).
  state() {
    const dim = this.dim.getLocalBounds();
    return {
      visible: this.visible && !this.closed,
      kind: this.kind,
      caption: this.caption,
      btnX: this.btn.x, btnY: this.btn.y,
      dimW: dim.width, dimH: dim.height,
    };
  }
}
