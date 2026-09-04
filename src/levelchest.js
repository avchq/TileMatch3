// Level Chest — the recurring reward that fills as you advance the campaign and
// bursts open on the level-complete screen. This module is the FEATURE LOGIC:
// the schedule and the maths that turn "the highest level you've cleared" into
// "which chest you're on, how full it is, and what it pays". It draws nothing —
// the bar, the open animation and the reward popup live in the win overlay
// (src/game.js), which asks this module `infoFor(level)`.
//
// The feature persists NOTHING of its own. Chest progress is derived purely from
// user.completedLevel() (the highest level ever cleared, already saved), so a QA
// level jump just lands on the right chest and there is nothing to migrate.
//
// THE SCHEDULE — a list of milestones, each `[id, levelId, "itemId|count"]`, in
// assets/config/levelChest.json. `levelId` is the level at which a chest
// COMPLETES; the gap to the previous milestone's `levelId` is how many wins that
// chest takes. From CONFIG.features.levelChest.repeatStart onward the tail of the
// list LOOPS forever, so chests keep arriving deep into the campaign.
//
// A note on the label: the original game's wrap-around had an off-by-one that made
// the progress label show negative numbers for a stretch just past the last
// milestone. This port ships the CORRECTED label — it always counts up cleanly
// (0..needed) — so no negative-progress window ever appears. The opening cadence
// and rewards are identical to the original either way.

import { CONFIG } from "./config.js";

// Reward item-id → this port's grant `type`. Item ids follow the original's
// scheme; the port has no Lightning helper, so 20 pays a coins bonus (the same
// choice the Fortune Wheel makes for its "lightning" prize). What each of those
// types then PAYS is not this module's business — REWARD_GRANT in
// src/rewards.js owns that, for every feature. Keeping the import out is
// deliberate: this file stays pure and UI-free.
const ITEM_TYPE = {
  0: "coins",     // gold coins → wallet
  10: "undo",     // Undo helper
  11: "wand",     // the original's "Hint" is this game's Wand
  12: "shuffle",  // Reshuffle helper
  20: "lightning" // no Lightning helper here — granted as a coins bonus
};

/** Parse a `"itemId|count"` reward string into `{ type, amount }`. */
export function parseReward(str) {
  const [idStr, countStr] = String(str || "").split("|");
  const id = Math.floor(Number(idStr));
  const amount = Math.max(0, Math.floor(Number(countStr)) || 0);
  const type = ITEM_TYPE[id] || "coins";
  return { type, amount };
}

export class LevelChest {
  constructor(cfg) {
    // DATA from the JSON config; the repeat-start PACING knob from src/config.js.
    // Degrade to an empty schedule on a missing/failed config (the win overlay
    // then simply shows no chest), mirroring the other feature scenes.
    cfg = cfg || {};
    const table = cfg.levelChest || {};
    // Rows are `[id, levelId, reward]`, keyed by id. Keep only the level + reward
    // and sort by level so the milestone list is ascending regardless of key order.
    this.milestones = Object.values(table)
      .filter((r) => Array.isArray(r) && r.length >= 3)
      .map((r) => ({ levelId: Math.floor(r[1]), reward: String(r[2]) }))
      .sort((a, b) => a.levelId - b.levelId);
    this.repeatStart = CONFIG.features.levelChest.repeatStart;
  }

  /** How many milestones the schedule authors. */
  get count() { return this.milestones.length; }

  /** Whether the feature has any schedule at all (false → no chest is ever shown). */
  get enabled() { return this.count > 0; }

  /** The chest state implied by having cleared up to `level` (the highest level
   *  reached). Returns `{ index, filled, needed, label, reward, full }`, where
   *  `reward` is the parsed `{ type, amount }` and `full` means this exact level
   *  completes the chest (its bar reaches the top). Returns null when there is no
   *  schedule or `level` is below the first milestone's fill range (i.e. <= 0). */
  infoFor(level) {
    const m = this.milestones;
    if (!m.length) return null;
    const lv = Math.floor(level) || 0;
    if (lv <= 0) return null;

    const last = m[m.length - 1].levelId;
    let index, prev, thisLevel, reward;

    if (lv <= last) {
      // Within the authored schedule: the current chest is the first milestone
      // whose completion level is at or above `lv`.
      index = m.findIndex((x) => x.levelId >= lv);
      prev = index > 0 ? m[index - 1].levelId : 0;
      thisLevel = m[index].levelId;
      reward = m[index].reward;
    } else {
      // Past the last authored milestone: the tail [repeatStart .. end] loops.
      // Every looped chest is 16 wins wide (the tail is uniformly 16-spaced), so
      // the completion levels are simply last + 16, last + 32, …
      const tailLen = this.count - this.repeatStart;
      const t = Math.ceil((lv - last) / 16); // 1-based chest past the schedule end
      thisLevel = last + 16 * t;
      prev = thisLevel - 16;
      // Which authored milestone's reward this looped chest carries.
      index = this.repeatStart + ((t - 1) % tailLen);
      reward = m[index].reward;
    }

    const needed = thisLevel - prev;
    const filled = lv - prev;
    return {
      index,
      filled,
      needed,
      label: `${filled} / ${needed}`,
      reward: parseReward(reward),
      full: filled >= needed,
    };
  }

  /** The chest currently being FILLED after clearing up to `level` — the "resting"
   *  view for a persistent indicator (e.g. the lobby bar). It matches infoFor for a
   *  level part-way through a chest, but when `level` sits exactly on a milestone —
   *  whose chest has just OPENED — it rolls forward to the NEXT chest at 0 notches,
   *  so the indicator shows progress toward the reward still to come rather than a
   *  full bar for one already collected. Returns null when there is no chest yet. */
  currentFor(level) {
    const info = this.infoFor(level);
    if (!info) return null;
    if (!info.full) return info;
    // On a milestone: show the next chest, freshly empty. infoFor(level+1) resolves
    // that next chest (its needed/reward), which we re-label with 0 notches filled.
    const next = this.infoFor((Math.floor(level) || 0) + 1);
    if (!next) return null;
    return { ...next, filled: 0, label: `0 / ${next.needed}` };
  }
}
