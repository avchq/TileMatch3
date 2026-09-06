// The HARD LEVEL opening banner — the one thing in this game that interrupts a
// level between the board landing and the player being allowed to touch it.
//
// A hard level is announced, not merely tagged: once the deal-in wave has put the
// last tile down, the screen dims, a slowly turning starburst and the emblem snap
// up out of nothing with the caption under them, the whole thing holds for about
// two thirds of a second and shrinks away again. Only then does the board unlock.
// It is genuinely blocking — GameScene awaits play() inside loadLevel's hand-off,
// before it clears `locked` — so no tap and no helper can reach the board while
// it is up, and the dim swallows taps aimed at the tiles underneath.
//
// It plays on every FRESH build of a hard level: first attempt, Replay, and the
// retry after a loss. It cannot play on a revive, because _continueAfterLoss
// returns the tray to the existing board without going through loadLevel at all.
//
// Everything is drawn (Graphics + an emoji glyph), like the rest of this game's
// effects — there is no artwork to load. The numbers below are visual timings and
// belong here rather than in src/config.js, which is for parameters that change
// how the game PLAYS (see its header).

import { tween, delay, easeOutBack, easeInCubic } from "./tween.js";
import { locText } from "./i18n.js";
import { fitTextWidth, DESIGN_W, DESIGN_H } from "./layout.js";

const DIM_ALPHA = 0.7;        // how dark the board goes behind the banner
const GROW_MS = 330;          // the three elements scaling up out of nothing
const HOLD_MS = 700;          // …how long they hold at full size…
const SHRINK_MS = 330;        // …and back down to nothing while the dim lifts
const SPIN_MS = 10000;        // one full revolution of the starburst, i.e. a glow

const RAYS = 14;              // starburst spokes
const RAY_INNER = 60;
const RAY_OUTER = 300;
const RAY_WIDTH = 0.16;       // half-angle of a spoke at its base, in radians

const EMBLEM = "🔥";
const EMBLEM_R = 92;          // the disc the emblem sits on
const CAPTION_Y = 190;        // caption baseline, below the emblem
const CAPTION_MAX_W = 560;

// The caption is RED — the colour is the whole point of the hard variant. (The
// same component has an orange "bonus level" personality in the original; nothing
// in this build ever puts a level into bonus mode, so only the red one exists.)
const CAPTION_FILL = 0xff3b3b;

export class HardLevelBanner extends PIXI.Container {
  /** @param app the Pixi application — the ticker drives both tweens and the spin. */
  constructor(app) {
    super();
    this.app = app;
    this.viewW = DESIGN_W;
    this.viewH = DESIGN_H;

    // The dim is its own child so it can fade independently of the group's scale,
    // and it is `static` so every tap lands on it instead of on a tile.
    this.dim = new PIXI.Graphics();
    this.dim.eventMode = "static";
    this.addChild(this.dim);

    // One centred group: a resize re-centres the whole banner by moving one
    // object, and the grow/shrink is a single scale on it.
    this.group = new PIXI.Container();
    this.addChild(this.group);

    this.rays = new PIXI.Graphics();
    for (let i = 0; i < RAYS; i++) {
      const a = (i / RAYS) * Math.PI * 2;
      // Painted as light rather than as a tint: a low-alpha gold over a dimmed
      // board blends toward grey (the same lesson superwandpromo.js records).
      this.rays.beginFill(0xffd98a, i % 2 ? 0.30 : 0.55);
      this.rays.moveTo(Math.cos(a - RAY_WIDTH) * RAY_INNER, Math.sin(a - RAY_WIDTH) * RAY_INNER);
      this.rays.lineTo(Math.cos(a) * RAY_OUTER, Math.sin(a) * RAY_OUTER);
      this.rays.lineTo(Math.cos(a + RAY_WIDTH) * RAY_INNER, Math.sin(a + RAY_WIDTH) * RAY_INNER);
      this.rays.closePath();
      this.rays.endFill();
    }
    this.group.addChild(this.rays);

    const disc = new PIXI.Graphics();
    disc.beginFill(0x8c0d0d).drawCircle(0, 0, EMBLEM_R).endFill();
    disc.beginFill(0xe02020).drawCircle(0, 0, EMBLEM_R - 8).endFill();
    disc.lineStyle(6, 0xffffff, 0.7).drawCircle(0, 0, EMBLEM_R);
    const emblem = new PIXI.Text(EMBLEM, { fontFamily: "Arial", fontSize: 96 });
    emblem.anchor.set(0.5);
    this.group.addChild(disc, emblem);

    this.caption = locText("hard_level", {
      fontFamily: "Arial", fontSize: 66, fontWeight: "900", fill: CAPTION_FILL,
      stroke: 0x3a0000, strokeThickness: 9, align: "center",
    });
    this.caption.anchor.set(0.5);
    this.caption.position.set(0, CAPTION_Y);
    fitTextWidth(this.caption, CAPTION_MAX_W);
    this.group.addChild(this.caption);

    this.group.scale.set(0);
    this.dim.alpha = 0;
    this.layout(DESIGN_W, DESIGN_H);
  }

  layout(DW, DH) {
    this.viewW = DW; this.viewH = DH;
    this.dim.clear().beginFill(0x000000, DIM_ALPHA).drawRect(0, 0, DW, DH).endFill();
    this.group.position.set(DW / 2, DH / 2);
  }

  /**
   * Run the whole announcement and resolve when the screen is clear again.
   *
   * `alive` is the caller's staleness check (GameScene's `run` token): the level
   * can be swapped out mid-banner, and every tween carries it so the animation
   * abandons itself instead of finishing over somebody else's board. It always
   * resolves — tween() never rejects — so an abandoned banner still hands control
   * back and the caller's own guard decides what to do next.
   */
  async play(alive = () => true) {
    const t = this.app.ticker;
    const live = () => !this.destroyed && alive();

    // The spin is a plain ticker listener rather than a tween: it has to keep
    // turning across all three phases, and it is unhooked in destroy().
    this._spin = () => { this.rays.rotation += (t.deltaMS / SPIN_MS) * Math.PI * 2; };
    t.add(this._spin);

    await tween(t, {
      duration: GROW_MS, ease: easeOutBack, while: live,
      onUpdate: (e) => { this.group.scale.set(Math.max(0, e)); this.dim.alpha = Math.min(1, e); },
    });
    if (live()) await delay(t, HOLD_MS);
    if (live()) {
      await tween(t, {
        duration: SHRINK_MS, ease: easeInCubic, while: live,
        onUpdate: (e) => { this.group.scale.set(1 - e); this.dim.alpha = 1 - e; },
      });
    }
    // The caller may have torn it down already (loadLevel closes a banner left
    // over from a level swapped out mid-announcement), so this is a no-op then.
    if (!this.destroyed) this.destroy({ children: true });
  }

  /** Flat state for the debug API — never a live display object. */
  state() {
    return {
      visible: !this.destroyed && this.dim.alpha > 0.01,
      alpha: this.destroyed ? 0 : this.dim.alpha,
      scale: this.destroyed ? 0 : this.group.scale.x,
      caption: this.destroyed ? "" : this.caption.text,
    };
  }

  destroy(opts) {
    if (this.destroyed) return;
    if (this._spin) { this.app.ticker.remove(this._spin); this._spin = null; }
    super.destroy(opts);
  }
}
