// Generates the tile-face textures at runtime: a white rounded "mahjong" tile
// body (drawn to a 2D canvas) with a fruit emoji composited on top — a 20-icon
// food theme. (No prebuilt per-theme icon atlas ships with this build, so we
// regenerate an equivalent set here at runtime.)
//
// The emoji is rendered via PIXI.Text and the whole face is baked into a texture
// with renderer.generateTexture, NOT by drawing the emoji straight onto the 2D
// canvas with ctx.fillText. On iOS/WebKit ctx.fillText of a colour emoji paints
// nothing (the tile body drew but the fruit was missing — the "white tiles"
// bug), whereas PIXI.Text emoji render correctly there (the on-screen 👆 hand /
// helper icons prove it). Baking the proven PIXI.Text path is what makes the
// fruit appear on iOS.

export const TILE_EMOJIS = [
  "🍎", "🍊", "🍋", "🍇", "🍉", "🍓", "🍒", "🍑", "🥝", "🥥",
  "🍍", "🥭", "🍌", "🥕", "🌽", "🍅", "🥑", "🍆", "🫐", "🥦",
];

// Apple Color Emoji first so iOS resolves the colour face directly; the rest are
// fallbacks for other platforms. Matches the (working) PIXI.Text emoji elsewhere.
const EMOJI_FONT = '"Apple Color Emoji","Noto Color Emoji","Segoe UI Emoji",Arial';

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// The tile body only (no emoji): a white→blue gradient rounded rect with a soft
// drop shadow, an inner top highlight and a subtle border. Canvas→WebGL upload
// of a plain (non-emoji) canvas works fine on iOS.
function drawTileBody(size) {
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

  return c;
}

// Build a PIXI.Text for one fruit emoji, sized/placed for a `size`×`size` tile.
function makeEmojiText(emoji, size) {
  const t = new PIXI.Text(emoji, {
    fontFamily: EMOJI_FONT,
    fontSize: Math.round(size * 0.56),
    fill: 0x000000, // opaque, in case a platform falls back to a monochrome glyph
  });
  t.anchor.set(0.5);
  t.position.set(size / 2, size * 0.55);
  return t;
}

// Does the emoji actually rasterize through the render pipeline? Renders a
// standalone PIXI.Text emoji and reads it back with the extract system, scanning
// for a strongly-coloured pixel (fruit emoji are colourful; a blank/monochrome
// fallback has none). This is the same path makeTileTextures bakes, so it is a
// faithful gate/probe. Returns false if the extract API is unavailable.
export function emojiPaints(renderer, emoji, size = 128) {
  const t = makeEmojiText(emoji, size);
  try {
    const px = renderer.extract.pixels(t);
    for (let i = 0; i < px.length; i += 4) {
      if (px[i + 3] < 8) continue; // skip transparent
      const r = px[i], g = px[i + 1], b = px[i + 2];
      if (Math.max(r, g, b) - Math.min(r, g, b) > 30) return true; // saturated
    }
    return false;
  } catch (_) {
    return false;
  } finally {
    t.destroy();
  }
}

let _fontReady = false;
/** True once the emoji font was confirmed to paint before tiles were generated. */
export function tilesFontReady() { return _fontReady; }

// iOS/WebKit can paint nothing for an emoji drawn very early, before its font
// subsystem is warm. Wait for fonts.ready, then verify a probe emoji actually
// rasterizes through the renderer, retrying across a few frames so generation is
// deterministic. Capped so a device that never warms can't hang boot.
async function warmEmojiFont(renderer, size) {
  try { await document.fonts.ready; } catch (_) { /* no CSS Font Loading API */ }
  for (let i = 0; i < 30; i++) {
    if (emojiPaints(renderer, TILE_EMOJIS[0], size)) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  _fontReady = true;
}

/**
 * Returns an array of PIXI.Texture, one per tile type. Async: it waits for the
 * emoji font, then bakes each face (tile body + PIXI.Text emoji) into a texture
 * with `renderer.generateTexture`. Requires the app renderer.
 */
export async function makeTileTextures(renderer, size = 128) {
  await warmEmojiFont(renderer, size);
  return TILE_EMOJIS.map((e) => {
    const cont = new PIXI.Container();
    const body = new PIXI.Sprite(PIXI.Texture.from(drawTileBody(size)));
    body.width = body.height = size;
    cont.addChild(body, makeEmojiText(e, size));
    const tex = renderer.generateTexture(cont);
    cont.destroy({ children: true });
    return tex;
  });
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
