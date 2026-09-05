// Shared responsive-layout helpers.
//
// The game is designed for a 750×1334 portrait canvas and reflowed to fit any
// viewport by main.js's resize(): the stage is uniformly scaled by
// min(vw/750, vh/1334) so the constraining dimension maps exactly onto the
// design (no letterbox, no distortion) and the other dimension gains extra
// design units. Because it's the MIN scale, the resulting design area is always
// >= 750×1334 in BOTH axes — content is never compressed, only given extra
// margin. Each scene's layout(DW, DH) then anchors its bands into that area
// (HUD → top edge, tray/boosters → bottom edge, board fills the middle,
// overlays cover the whole view with a centred panel).
//
// These helpers keep the per-scene layout() methods consistent instead of
// re-deriving the same maths in each file.

import { locText } from "./i18n.js";

export const DESIGN_W = 750;
export const DESIGN_H = 1334;

// Cover-fit a background sprite over a w×h area centred at (cx, cy): scale it up
// uniformly until it covers that area (cropping the overflow), so the art fills
// it without stretching. Defaults centre it in a w×h view (cx=w/2, cy=h/2).
// Used both for the full-view blurred backdrop and the crisp 750-wide game column.
export function coverBackground(sprite, w, h, cx = w / 2, cy = h / 2) {
  const scale = Math.max(w / sprite.texture.width, h / sprite.texture.height);
  sprite.scale.set(scale);
  sprite.anchor.set(0.5);
  sprite.position.set(cx, cy);
  return sprite;
}

// Build the two-layer background the game uses so it stays a fixed-width vertical
// column on any screen: a BLURRED copy of the art covering the whole view (fills
// the side margins on a screen wider than the 750-wide design), with a CRISP copy
// covering just the centred 750-wide column on top. On a portrait screen the crisp
// column already fills the width, so the blur is simply hidden behind it. Returns
// the two sprites (already positioned); the caller adds them to its bg layer.
export function buildColumnBackground(texture, viewW, viewH) {
  const blurred = coverBackground(new PIXI.Sprite(texture), viewW, viewH);
  // Overscan so the blur's soft edge stays off-screen (no seam at the view edges).
  blurred.scale.set(blurred.scale.x * 1.15);
  blurred.filters = [new PIXI.BlurFilter(28)];
  // Bake the (static) blur to a texture once instead of re-running the filter every
  // frame — the background only changes when it's rebuilt (resize / level change),
  // so per-frame blur cost is pure waste and slows animation-heavy screens.
  blurred.cacheAsBitmap = true;
  const crisp = coverBackground(new PIXI.Sprite(texture), DESIGN_W, viewH, viewW / 2, viewH / 2);
  return [blurred, crisp];
}

// Constrain a centred text label to a maximum on-screen width by scaling it down
// uniformly if its natural width exceeds maxWidth (never scales up). Used to keep
// decorative centred text (e.g. the lobby title/subtitle) inside the safe centre
// column so it can never intrude into the corner-chrome (settings cog / wheel /
// daily-bonus button column on the left). Resets scale first so re-fitting after a
// text change recomputes from the natural width.
export function fitTextWidth(text, maxWidth) {
  text.scale.set(1);
  if (text.width > maxWidth) text.scale.set(maxWidth / text.width);
}

// The game's floating "pill" label — a dark-glass rounded capsule with a single
// line of white text, drawn around its own centre so the caller only has to
// position it. Used for every short in-level message: the helper row's "Unlocks
// at Level N" refusal, the tray's "Insufficient space!" warning and the 8th
// slot's "Ad not ready" refusal (all in GameScene, which fades them in and out),
// and the coached first use's caption (BoosterCoach, which holds it until the
// lesson closes). It carries its own `__text` as a test seam and `__w` so the
// caller can clamp it inside the safe band, and starts at alpha 0 — a static user
// sets alpha 1, a fading one animates from there.
export function makeHintPill(text) {
  const c = new PIXI.Container();
  c.__text = text;
  const label = new PIXI.Text(text, {
    fontFamily: "Arial", fontSize: 26, fontWeight: "700", fill: 0xffffff,
  });
  label.anchor.set(0.5);
  const w = label.width + 40, h = 52;
  const g = new PIXI.Graphics();
  g.beginFill(0x0a1226, 0.88).drawRoundedRect(-w / 2, -h / 2, w, h, h / 2).endFill();
  g.lineStyle(3, 0xffffff, 0.35).drawRoundedRect(-w / 2, -h / 2, w, h, h / 2);
  c.addChild(g, label);
  c.__w = w;
  c.alpha = 0;
  return c;
}

// Defensive fit for a centred overlay panel: if the panel's natural (unscaled)
// size would exceed the visible DW×DH area minus a margin, scale it down
// uniformly so it always stays fully on-screen. With the min-scale invariant
// above the design area is normally >= nominal, so for design-sized panels this
// is a no-op (scale 1) — but a content-driven panel (e.g. the shop, whose height
// grows with the package count) can outgrow the view, and this guarantees it
// never gets clipped at the top/bottom. The panel is drawn around its own origin
// (pivot at centre) and positioned at the view centre by the caller.
export function fitPanel(panel, DW, DH, margin = 24) {
  const b = panel.getLocalBounds();
  if (!b || !b.width || !b.height) return 1;
  const s = Math.min(1, (DW - 2 * margin) / b.width, (DH - 2 * margin) / b.height);
  panel.scale.set(s);
  return s;
}

// The game's standard "pill" button: a filled rounded rect with a white hairline,
// a centred bold label, a press-scale on pointerdown, and the shared `btn_01`
// click cue on tap.
//
// It lives here rather than on a scene because it WAS a scene method, nine times
// over — game, settings, shop, tutorial, fortune wheel, tasks, daily bonus, the
// Super Wand promo and the language picker each carried a private `_makeButton`.
// The copies were identical in shape and disagreed on the cue: six were silent
// and every one of their callers played `btn_01` from its own handler to make up
// for it. That compensation is invisible from the button, so it drifted both ways
// — a forgotten one (Daily Bonus's "Double It" on a cancelled ad) and a doubled
// one (the language picker's Back). The cue belongs to the PRESS, so it is played
// here and exactly once; a handler that plays its own now double-fires.
//
// It needs `audio`, which is the one reason it was not already in this file:
// everything else here is a pure function of its arguments. Passing the manager
// in keeps it a plain function.
//
// `key` labels the button from the i18n table and re-letters itself on a language
// change (see locText); `label` is a literal that does not — a price, or text a
// caller has already translated and decorated ("📺  Double it"). Pass one.
// `tests/buttonsound_test.py` pins the one-cue-per-press invariant.
export function makeButton({ audio, label, key, w, h, cx, cy, color,
                             fontSize = 32, onClick }) {
  const c = new PIXI.Container();
  c.position.set(cx, cy);
  // The drawn size, kept on the container so a caller's geometry() can measure the
  // button without re-deriving it from the constants it is meant to be checking.
  c.__w = w; c.__h = h;
  const g = new PIXI.Graphics();
  g.beginFill(color).drawRoundedRect(-w / 2, -h / 2, w, h, h / 2.4).endFill();
  g.lineStyle(4, 0xffffff, 0.35).drawRoundedRect(-w / 2, -h / 2, w, h, h / 2.4);
  const style = { fontFamily: "Arial", fontSize, fontWeight: "800", fill: 0xffffff };
  const t = key ? locText(key, style) : new PIXI.Text(label, style);
  t.anchor.set(0.5);
  c.addChild(g, t);
  c.label = t;                 // callers re-letter a literal label through this
  c.eventMode = "static";
  c.cursor = "pointer";
  c.on("pointertap", () => {
    if (audio) audio.play("btn_01");
    onClick();
  });
  c.on("pointerdown", () => c.scale.set(0.95));
  c.on("pointerup", () => c.scale.set(1));
  c.on("pointerupoutside", () => c.scale.set(1));
  return c;
}

// The game's progress meter — a dark-glass rounded track with a coloured rounded
// fill and, by default, a centred "n / m" count, drawn around its own centre so
// the caller only has to position the returned `node`.
//
// It lives here rather than on a scene because it WAS a scene-local copy, six
// times over: the Super Wand streak bar and its "at risk" twin and the Level
// Chest bar on the level's overlays (game.js), the lobby's persistent chest bar
// (lobby.js), the Super Wand promo's meter (superwandpromo.js) and the Tasks row
// meter (tasks.js) — whose look the chest bar's own comment used to cite ("the
// Tasks-row style"), which is how far the copying had travelled. The family
// differs in BEHAVIOUR — at-risk drains, the streak fills one notch and punches
// its caption, the chest fills and pops open, the lobby bar just redraws — and
// each caller keeps all of that. Only the widget is shared.
//
// Two rules the copies all kept by hand and nothing enforced, now stated once:
//
//   * the fill is never narrower than `h`. At one notch of sixteen a proportional
//     rect would be a 20-px sliver whose two rounded ends meet; the floor keeps it
//     a legible stub. This is why `draw` is not just a scale on a static fill.
//   * `of <= 0` draws nothing instead of dividing by it. Two of the six copies
//     guarded this and four did not, which made a mistuned `needed: 0` a
//     rendering question rather than a config one.
//
// `outline` adds the white hairline the two bars that sit on busy art carry (the
// lobby's, over the background column, and the promo's, over its panel art); the
// four on solid overlay panels do without it. `label: false` omits the count for
// the one caller — a Tasks row — whose counter is not centred on its track but
// sits further right in the row, and which formats it without spaces; that row
// keeps its own PIXI.Text and takes only the track and the fill from here.
//
// `tests/progressbar_test.py` pins the contract and that this stays the only copy.
export function makeProgressBar({ w, h, color, outline = false, label = true }) {
  const node = new PIXI.Container();
  // The drawn size, on the container, for the same reason makeButton carries it.
  node.__w = w; node.__h = h;
  const track = new PIXI.Graphics();
  track.beginFill(0x0a1226, 0.75).drawRoundedRect(-w / 2, -h / 2, w, h, h / 2).endFill();
  if (outline) {
    track.lineStyle(3, 0xffffff, 0.14).drawRoundedRect(-w / 2, -h / 2, w, h, h / 2);
  }
  const fill = new PIXI.Graphics();
  node.addChild(track, fill);
  let text = null;
  if (label) {
    text = new PIXI.Text("", {
      fontFamily: "Arial", fontSize: 22, fontWeight: "900", fill: 0xdce7ff,
      stroke: 0x122043, strokeThickness: 3,
    });
    text.anchor.set(0.5);
    node.addChild(text);
  }
  // `n` may be fractional — the callers that animate a notch tween through it.
  const draw = (n, of) => {
    fill.clear();
    const pct = of > 0 ? Math.max(0, Math.min(1, n / of)) : 0;
    if (pct > 0) {
      fill.beginFill(color)
        .drawRoundedRect(-w / 2, -h / 2, Math.max(h, w * pct), h, h / 2).endFill();
    }
    if (text) text.text = `${Math.round(n)} / ${of}`;
  };
  return { node, track, fill, label: text, draw };
}
