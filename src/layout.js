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
