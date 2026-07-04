// Generates the tile-face textures at runtime by drawing an emoji onto a
// white rounded "mahjong" tile — mirrors Tile Match 3's 20-icon food theme.
// (The original game's per-theme icon atlas is not among the downloaded
//  Cocos native assets, so we regenerate an equivalent set here.)

export const TILE_EMOJIS = [
  "🍎", "🍊", "🍋", "🍇", "🍉", "🍓", "🍒", "🍑", "🥝", "🥥",
  "🍍", "🥭", "🍌", "🥕", "🌽", "🍅", "🥑", "🍆", "🫐", "🥦",
];

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function drawTileFace(emoji, size) {
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const ctx = c.getContext("2d");
  const pad = size * 0.055;
  const w = size - pad * 2;
  const r = size * 0.17;

  // soft drop shadow
  ctx.save();
  ctx.shadowColor = "rgba(30,45,80,0.28)";
  ctx.shadowBlur = size * 0.06;
  ctx.shadowOffsetY = size * 0.03;
  roundRect(ctx, pad, pad, w, w, r);
  const g = ctx.createLinearGradient(0, pad, 0, pad + w);
  g.addColorStop(0, "#ffffff");
  g.addColorStop(1, "#dfe7f2");
  ctx.fillStyle = g;
  ctx.fill();
  ctx.restore();

  // inner top highlight
  roundRect(ctx, pad + size * 0.02, pad + size * 0.02, w - size * 0.04, w * 0.5, r * 0.8);
  const hg = ctx.createLinearGradient(0, pad, 0, pad + w * 0.55);
  hg.addColorStop(0, "rgba(255,255,255,0.85)");
  hg.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = hg;
  ctx.fill();

  // border
  roundRect(ctx, pad, pad, w, w, r);
  ctx.lineWidth = size * 0.025;
  ctx.strokeStyle = "rgba(120,140,175,0.5)";
  ctx.stroke();

  // emoji
  ctx.font = `${Math.round(size * 0.56)}px "Noto Color Emoji","Apple Color Emoji","Segoe UI Emoji",sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(emoji, size / 2, size * 0.55);

  return c;
}

/** Returns an array of PIXI.Texture, one per tile type. */
export function makeTileTextures(size = 128) {
  return TILE_EMOJIS.map((e) => PIXI.Texture.from(drawTileFace(e, size)));
}

/** A single empty slot cell texture for the tray. */
export function makeSlotTexture(size = 120) {
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const ctx = c.getContext("2d");
  const pad = size * 0.06;
  const w = size - pad * 2;
  roundRect(ctx, pad, pad, w, w, size * 0.16);
  ctx.fillStyle = "rgba(20,30,55,0.32)";
  ctx.fill();
  ctx.lineWidth = size * 0.03;
  ctx.strokeStyle = "rgba(255,255,255,0.22)";
  ctx.stroke();
  return PIXI.Texture.from(c);
}
