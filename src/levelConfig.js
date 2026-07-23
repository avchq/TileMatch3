// The single source of truth for every level in the game.
//
// To add a level, append ONE entry here with its background image, level-data
// file, and how many distinct tile types it uses — nothing else needs editing.
// Two things are derived from this list:
//   - MAX_LEVEL           = LEVELS.length  (the highest playable level)
//   - the asset MANIFEST  (src/assets.js builds one load group per entry)
//
// `types` controls the count of distinct tile faces the level draws from (every
// one is guaranteed to appear on the board; more types = harder). It may be:
//   - a plain integer  → a fixed count, or
//   - a [min, max] range → the count is a random value within that range,
//     drawn deterministically per level (stable across reloads/sessions).
// `preload: true` fetches that level's assets on boot; entries without it
// lazy-load on demand the first time the player reaches them. (Not to be
// confused with src/level.js, which is the level-data PARSER/solver.)

import { mulberry32 } from "./level.js";

export const LEVELS = [
  { background: "assets/bg/bg1.jpg",  data: "assets/levels/level1.json", types: [9, 10], preload: true },
  { background: "assets/bg/bg2.jpg",  data: "assets/levels/level2.json", types: [9, 10], preload: true },
  { background: "assets/bg/bg14.jpg", data: "assets/levels/level3.json", types: [9, 11], preload: true },
  { background: "assets/bg/bg14.jpg", data: "assets/levels/level4.json", types: [9, 11] },
  { background: "assets/bg/bg1.jpg",  data: "assets/levels/level5.json", types: [10, 15] },
  { background: "assets/bg/bg1.jpg",  data: "assets/levels/level6.json", types: [10, 15] },
  { background: "assets/bg/bg1.jpg",  data: "assets/levels/level7.json", types: [10, 15] },
  { background: "assets/bg/bg1.jpg",  data: "assets/levels/level8.json", types: [10, 15] },



];

// The highest playable level is simply how many levels are configured.
export const MAX_LEVEL = LEVELS.length;

// Max distinct types the palette can render (must match TILE_EMOJIS.length in
// src/icons.js) — resolved counts are clamped to this.
const PALETTE_SIZE = 20;

// Distinct tile types for a level (1-based). Accepts either a fixed integer or
// a [min, max] range; a range resolves to a per-level count that is random but
// deterministic (identical every load, seeded distinctly from the board-LAYOUT
// seed in game.js so the two don't correlate). Falls back to a safe default for
// any level number outside the configured range.
export function typesForLevel(levelNum) {
  const spec = LEVELS[levelNum - 1]?.types ?? 5;
  if (!Array.isArray(spec)) return spec; // bare integer = fixed count
  const min = Math.max(1, Math.min(spec[0], spec[1]));
  const max = Math.min(PALETTE_SIZE, Math.max(spec[0], spec[1]));
  const rng = mulberry32((levelNum * 0x85ebca6b) >>> 0);
  return min + Math.floor(rng() * (max - min + 1));
}
