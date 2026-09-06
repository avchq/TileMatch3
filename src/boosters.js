// Shared helper (booster) vocabulary — the one place this port answers "which
// in-level helpers exist, and what does each one look like".
//
// Six screens draw a helper: the level's row of round buttons (src/game.js),
// the coached first use that lifts one of them out of the dim
// (src/boostercoach.js), the prize chips along the top of the Fortune Wheel,
// the Daily Bonus and Tasks, the package contents summary in the shop
// (src/shop.js), and the lobby rail's Super Wand read-out (src/lobby.js).
// Every one of them carried its own copy of the glyph, and three of them a
// byte-identical copy of the CHIP that draws it — same 96x60 pill, same fill,
// same rim, same fonts, under the same `[kind, emoji, x]` array. So "what
// colour is the Wand" had six answers that only happened to agree, and changing
// one icon meant finding all six. This module is that answer, once.
//
// WHAT IS DELIBERATELY NOT HERE:
//  * The BALANCE KNOBS. Which helpers exist (`kinds`), what a new account owns,
//    when each unlocks and what it grants, the coaching switch, the Super
//    Wand's streak — all tuning, all still in CONFIG.boosters (src/config.js).
//    This module READS that roster and never restates one of its values; there
//    is no second copy to drift out of agreement.
//  * The COIN PRICES, which are a data table (assets/config/prices.json) and
//    reach a scene as `boosterPrices`.
//  * The LAYOUT. Where the level's button row sits, where a chip row sits:
//    those are each scene's own numbers and stay beside the scene that draws
//    them, per the rule in src/config.js. What a scene takes from here is the
//    IDENTITY that goes in the slot, never the slot.
//  * The localized NAME of a helper (ITEM_KEYS / itemName() in src/i18n.js), the
//    wording of its coach caption (the language tables), what one is worth as a
//    REWARD (src/rewards.js) and how many the player owns (src/user/User.js).
//    Each of those already owns its facet.
//
// It imports src/config.js and NOTHING else — no scene, no i18n, no PIXI module
// (PIXI is a global from the vendored bundle, same as src/rewards.js relies on).
// That is what lets src/shop.js and src/rewards.js both use it: rewards.js
// already imports shop.js, so a registry with any further dependency would
// close an import cycle. tests/boosters_test.py holds it to that.

import { CONFIG } from "./config.js";

// The FACE of each helper: the glyph it wears, the colour of the disc behind it
// and the text key of the one line its coached first use shows. Presentation —
// but SHARED presentation, the helper's identity across six screens rather than
// one scene's styling, which is the same reason REWARD_EMOJI lives in
// src/rewards.js and not in the four features that draw it.
//
// NOTE these colours are not a palette. 0x4d8dff and 0xff8a3d are also the
// standard blue and orange used by buttons, badges and pills all over the game
// (the "watch an ad" bubble is blue on ALL three helpers, the "buy" price tag
// orange on all three). Only these three uses are "the helper's own colour";
// the others merely share a hex and must not be pointed here.
const FACES = {
  undo:    { glyph: "⤺",  color: 0x4d8dff, coachKey: "coach_undo" },
  wand:    { glyph: "🪄", color: 0x9b59f6, coachKey: "coach_wand" },
  shuffle: { glyph: "🔀", color: 0xff8a3d, coachKey: "coach_shuffle" },
};

// What a code listed in CONFIG.boosters.kinds with no face above draws as. It
// is unreachable with the shipped roster and nothing branches on it; it exists
// only so a lookup mid-render cannot hand a build `undefined` and throw. A
// mistyped kind should be visible, never fatal.
const UNKNOWN = Object.freeze({ glyph: "❔", color: 0x55617f, coachKey: "" });

// THE SUPER WAND'S FACE. Not a row: the Super Wand is not a helper code — it is
// a MODE of `wand`, backed by `user.superWand`, spending an ordinary wand charge
// per sweep (see superWand() in src/game.js). It has no inventory, no unlock row
// and no price, so it never appears in CONFIG.boosters.kinds. What it does have
// is a second face, worn by the same button in the level, by the lobby rail's
// progress button and by the promo card — hence one constant, here, beside the
// ordinary face it swaps with, so the swap cannot half-apply across screens.
export const SUPER_WAND_FACE = Object.freeze({ id: "wand", glyph: "✨", color: 0xffb02e });

// PRESENTATION ORDER — the order a list of helpers is drawn in when a screen
// has no reason of its own to differ. Stated as a literal because that is what
// it is today: all three chip rows were hardcoded undo → wand → shuffle. It
// happens to be unlock order too (levels 2 → 3 → 5), but it is NOT derived from
// the schedule: deriving it would couple where a chip sits to a balance knob,
// a coupling that does not exist today and that a rebalance would spring.
//
// A screen with its own reason to differ keeps that order NEXT TO ITS GEOMETRY
// and says why: the level's button row is laid out left-to-right at three fixed
// x (HELPER_ROW in src/game.js) and the shop's summary reads headline-item first
// (CONTENT_ORDER in src/shop.js).
const ORDER = ["undo", "wand", "shuffle"];

const ranked = (id) => {
  const i = ORDER.indexOf(id);
  return i === -1 ? ORDER.length : i;   // anything unlisted sorts last, stably
};

// THE REGISTRY — one row per code in CONFIG.boosters.kinds, in ORDER. The
// ROSTER is the config's (adding a helper is a config edit); the FACE is this
// file's. `unlock` is a live reference to that helper's CONFIG.boosters.unlocks
// row, or null — a reference, never a copy, so it cannot go stale.
export const BOOSTERS = Object.freeze(
  CONFIG.boosters.kinds
    .map((id, i) => ({ id, i }))
    .sort((a, b) => ranked(a.id) - ranked(b.id) || a.i - b.i)
    .map(({ id }) => Object.freeze({
      id,
      ...(FACES[id] || UNKNOWN),
      unlock: CONFIG.boosters.unlocks[id] || null,
    })));

const BY_ID = Object.freeze(Object.fromEntries(BOOSTERS.map((b) => [b.id, b])));

/** The face to DRAW for `id`. Never null: an unrecognised code gets the neutral
 *  face rather than throwing inside a build, because the caller is mid-render
 *  and has nothing useful to do with a failure. */
export function boosterFace(id) {
  return BY_ID[id] || UNKNOWN;
}

// ---------------------------------------------------------------------------
//  The shared chip
// ---------------------------------------------------------------------------

/**
 * One helper counter chip: a rounded pill carrying the helper's glyph and the
 * player's live remaining-uses count, drawn around its own origin (96x60) so
 * the caller places it by its centre.
 *
 * The Fortune Wheel, the Daily Bonus and Tasks each pin a ROW of these to the
 * top of their overlay, and each carried a byte-identical private copy of this
 * function. This is that code, once.
 *
 * It subscribes to the profile's "boosters" change and re-reads, which is also
 * what makes it a valid FLY TARGET for a booster prize (see flyReward in
 * src/rewards.js): the number ticks exactly as the icon lands on it.
 *
 * Not exported: every caller wants the whole ROW, below.
 */
function makeBoosterChip(user, id) {
  const c = new PIXI.Container();
  const w = 96, h = 60;
  const g = new PIXI.Graphics();
  g.beginFill(0x0a1226, 0.55).drawRoundedRect(-w / 2, -h / 2, w, h, h / 2).endFill();
  g.lineStyle(3, 0xffffff, 0.35).drawRoundedRect(-w / 2, -h / 2, w, h, h / 2);
  c.addChild(g);
  const e = new PIXI.Text(boosterFace(id).glyph, { fontFamily: "Arial", fontSize: 30 });
  e.anchor.set(0.5); e.position.set(-w / 2 + 26, 0);
  c.addChild(e);
  const t = new PIXI.Text("0", {
    fontFamily: "Arial", fontSize: 28, fontWeight: "900", fill: 0xffffff,
    stroke: 0x14361f, strokeThickness: 4,
  });
  t.anchor.set(0, 0.5); t.position.set(-w / 2 + 46, 0);
  c.addChild(t);
  c.label = t;
  c.update = () => { t.text = String(user ? user.boosterCount(id) : 0); };
  c.update();
  user.on((domain) => { if (domain === "boosters") c.update(); });
  return c;
}

/**
 * The whole chip row — one chip per helper, in registry order — added to
 * `parent` and returned as an `{ id: chip }` map, the shape the three overlays'
 * fly-target lookup already expects (`(b && this._chips[b]) || this.coinPill`).
 *
 * THE GEOMETRY IS THE CALLER'S: `geom` is `{ x0, dx, y }` in that scene's own
 * design units, so where the row sits stays a fact of the screen that draws it.
 * What the registry supplies is how many chips there are and what goes in each.
 */
export function makeBoosterChipRow(user, parent, { x0, dx, y }) {
  const chips = {};
  BOOSTERS.forEach((b, i) => {
    const chip = makeBoosterChip(user, b.id);
    chip.position.set(x0 + i * dx, y);
    parent.addChild(chip);
    chips[b.id] = chip;
  });
  return chips;
}

/**
 * The row's entries for a scene's controls() — the seam the resize/overlap test
 * measures. The names are the ones the three overlays have always reported
 * (chipUndo / chipWand / chipShuffle), so a failure still names a chip a human
 * can point at, and a fourth helper gets its entry for free.
 */
export function boosterChipControls(chips) {
  return BOOSTERS
    .filter((b) => chips[b.id])
    .map((b) => ({
      name: "chip" + b.id[0].toUpperCase() + b.id.slice(1),
      obj: chips[b.id],
    }));
}
