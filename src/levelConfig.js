// The single source of truth for every level in the game.
//
// To add a level, append ONE entry here with its background image and level-data
// file — nothing else needs editing. Two things are derived from this list:
//   - MAX_LEVEL           = LEVELS.length  (the highest playable level)
//   - the asset MANIFEST  (src/assets.js builds one load group per entry)
//
// `preload: true` fetches that level's assets on boot; entries without it
// lazy-load on demand the first time the player reaches them. (Not to be
// confused with src/level.js, which is the level-data PARSER/solver.)

export const LEVELS = [
  { background: "assets/bg/bg1.jpg",  data: "assets/levels/level1.json", preload: true },
  { background: "assets/bg/bg2.jpg",  data: "assets/levels/level2.json", preload: true },
  { background: "assets/bg/bg14.jpg", data: "assets/levels/level3.json", preload: true },
  { background: "assets/bg/bg14.jpg", data: "assets/levels/level4.json" },
];

// The highest playable level is simply how many levels are configured.
export const MAX_LEVEL = LEVELS.length;
