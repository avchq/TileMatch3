// The single source of truth for every level in the game.
//
// To add a level, append ONE entry here with its background image, level-data
// file, and how many distinct tile types it uses — nothing else needs editing.
// Two things are derived from this list:
//   - MAX_LEVEL           = LEVELS.length  (the highest playable level)
//   - the asset MANIFEST  (src/assets.js builds one load group per entry)
//
// `types` is the count of distinct tile faces the level draws from (every one
// is guaranteed to appear on the board; more types = harder). `preload: true`
// fetches that level's assets on boot; entries without it lazy-load on demand
// the first time the player reaches them. (Not to be confused with
// src/level.js, which is the level-data PARSER/solver.)

export const LEVELS = [
  { background: "assets/bg/bg1.jpg",  data: "assets/levels/level1.json", types: 7, preload: true },
  { background: "assets/bg/bg2.jpg",  data: "assets/levels/level2.json", types: 8, preload: true },
  { background: "assets/bg/bg14.jpg", data: "assets/levels/level3.json", types: 9, preload: true },
  { background: "assets/bg/bg14.jpg", data: "assets/levels/level4.json", types: 7 },
  { background: "assets/bg/bg1.jpg",  data: "assets/levels/level5.json", types: 9 },
];

// The highest playable level is simply how many levels are configured.
export const MAX_LEVEL = LEVELS.length;

// Distinct tile types for a level (1-based). Falls back to a safe default for
// any level number outside the configured range.
export function typesForLevel(levelNum) {
  return LEVELS[levelNum - 1]?.types ?? 5;
}
