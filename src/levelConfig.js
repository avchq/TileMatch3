// Level logic for the game. The level TABLE itself (which levels exist, their
// background/data/types/preload) lives in the JSON config
// `assets/config/levels.json` — a tunable data file alongside the other configs
// (prices.json, turntable.json) — and is fetched once at boot by loadLevels().
// This module owns the LOGIC that reads that table: the deterministic per-level
// type count. (Not to be confused with src/level.js, the level-data PARSER/solver.)
//
// The highest playable level is simply the length of the loaded table, so there
// is no separate MAX_LEVEL constant — callers read `levels.length` directly.
//
// `types` (per entry) controls the count of distinct tile faces the level draws
// from (every one is guaranteed to appear on the board; more types = harder).
// It may be:
//   - a plain integer  → a fixed count, or
//   - a [min, max] range → the count is a random value within that range,
//     drawn deterministically per level (stable across reloads/sessions).
// `preload: true` fetches that level's assets on boot; entries without it
// lazy-load on demand the first time the player reaches them.

import { mulberry32 } from "./level.js";
import { fetchJSON } from "./net.js";

// The loaded level table, populated once at boot by loadLevels(). Empty until
// then; typesForLevel() reads it, so loadLevels() must resolve before any level
// loads.
let LEVELS = [];

// Fetch the level table (assets/config/levels.json) and cache it here. Returns
// the loaded array. Must run once during boot before any level loads. This is
// essential config, so a fetch failure is fatal (unlike prices/turntable, which
// degrade gracefully) — the game has no levels without it.
//
// Bounded (see src/net.js): fatal must mean "boot stops and says why", not
// "boot waits forever". An un-timed fetch here parked the splash at 10% with no
// error on a stalled connection; now it fails loudly and boot().catch paints it.
export async function loadLevels() {
  LEVELS = await fetchJSON("assets/config/levels.json");
  return LEVELS;
}

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
