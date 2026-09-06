// Shared reward vocabulary — the one place this port answers "what is a
// `{ type, amount }` reward, and what happens when you collect it".
//
// Four features pay one out: the Fortune Wheel (src/fortunewheel.js), the Daily
// Bonus (src/dailybonus.js), Tasks (src/tasks.js) and the Level Chest (its
// popup lives in src/game.js). They used to carry four private copies of the
// grant table, the glyph table, the icon factory and the fly-to-counter arc,
// and the copies had drifted apart — the wheel, the ORIGINAL the other three
// say they copy, never got the try/catch that stops an unmeasurable fly target
// from throwing mid-collect and eating a prize the player had already paid a
// spin for. This module is that code, once.
//
// The NAMES that go with these types are localized elsewhere: `ITEM_KEYS` /
// `itemName(type, count)` in src/i18n.js already owned that one facet, and
// still does. This module owns the other four.
//
// Nothing here is a tunable — it is the port's reward VOCABULARY (which types
// exist and how each is paid), not a balance knob, so it stays out of
// src/config.js. The amounts and weights are data, in assets/config/*.json.

import { makeCoinIcon } from "./shop.js";
import { BOOSTERS } from "./boosters.js";
import { tween, easeInOutQuad, easeOutCubic } from "./tween.js";

// How each reward `type` is paid. `cur` credits the wallet; `booster` grants a
// helper. This port has no Lightning helper — the Fortune Wheel keeps
// "lightning" as its headline slice (CONFIG.features.fortuneWheel.headlinePrize)
// and the Level Chest's item id 20 maps to it, but both pay coins.
//
// ADDING A TYPE (gems, say — already reserved in CONFIG.economy.currencies) is
// one row here plus one glyph below, and every feature picks it up.
export const REWARD_GRANT = {
  coins: { cur: "coins" },
  lightning: { cur: "coins" },
  undo: { booster: "undo" },
  wand: { booster: "wand" },
  shuffle: { booster: "shuffle" },
};

// Glyphs for the types drawn as an emoji. Coins are the DRAWN gold coin
// (makeCoinIcon) rather than 🪙, which the emoji fonts render silver.
//
// The three HELPER glyphs are not spelled here: a helper wears the same face
// on the level's button row, on a chip and in the shop summary, and that face
// is one row in src/boosters.js. `lightning` stays local — it is a reward type
// with no helper behind it (the wheel's headline slice, which pays coins), so
// the registry has nothing to say about it.
export const REWARD_EMOJI = {
  ...Object.fromEntries(BOOSTERS.map((b) => [b.id, b.glyph])),
  lightning: "⚡",
};

/** Is this a type anything knows how to pay? The tables are edited without
 *  touching source, so a feature that COMMITS a claim before granting it (Tasks
 *  marks the tier claimed first, so a double tap can't pay twice) has to ask
 *  before committing — otherwise a mistyped row consumes the claim and grants
 *  nothing, permanently. */
export function rewardIsKnown(type) {
  return !!REWARD_GRANT[type];
}

/** True when `type` is credited to the wallet rather than to the booster
 *  inventory. Coins and the lightning bonus both are. */
export function rewardIsCoins(type) {
  const g = REWARD_GRANT[type];
  return !!(g && g.cur === "coins");
}

/** The booster `type` grants, or null when it is not a booster. Used to pick a
 *  fly target: a booster flies to its helper button, everything else to the
 *  coin pill. */
export function rewardBooster(type) {
  const g = REWARD_GRANT[type];
  return (g && g.booster) || null;
}

/**
 * Pay `reward` ({ type, amount }) into `user`.
 *
 * A type with no row above grants nothing — there is nothing to grant — but it
 * says so. That matters because the collect sequences commit the claim FIRST
 * (recordDailyClaim / recordWheelSpin run before the animation) and grant on
 * landing ~2s later: a mistyped config row would otherwise cost the player the
 * whole reward with no diagnostic anywhere at all.
 */
export function grantReward(user, reward) {
  const g = REWARD_GRANT[reward && reward.type];
  if (!g) {
    console.warn(`[rewards] unknown reward type "${reward && reward.type}" — ` +
                 "nothing granted (add it to REWARD_GRANT in src/rewards.js)");
    return;
  }
  if (g.cur) user.credit(g.cur, reward.amount);
  else if (g.booster) user.grantBooster(g.booster, reward.amount);
}

/**
 * The icon for a reward `type`, centred on its own origin.
 *
 * `size` is the coin icon's size; an emoji is drawn at `emojiSize`, which
 * defaults to a proportion of it. Two options rather than one shape because the
 * callers genuinely differ, on purpose:
 *
 *  - `coin` picks the drawn coin over the glyph. It defaults to coins only, so
 *    the wheel keeps its ⚡ headline slice; the Level Chest passes
 *    `rewardIsCoins(type)` instead, because its popup shows what it PAYS and a
 *    lightning chest pays coins.
 *  - `emojiSize` because the tasks list sizes its row chips independently of
 *    the coin beside them.
 */
export function makeRewardIcon(type, size, opts = {}) {
  const coin = opts.coin === undefined ? type === "coins" : opts.coin;
  if (coin) return makeCoinIcon(size);
  const emojiSize = opts.emojiSize === undefined ? size * 1.7 : opts.emojiSize;
  const t = new PIXI.Text(REWARD_EMOJI[type] || "❔",
                          { fontFamily: "Arial", fontSize: emojiSize });
  t.anchor.set(0.5);
  return t;
}

/**
 * Fly `icon` from `from` to `to` on `layer`, then destroy it. Resolves `true`
 * once it has landed, `false` — without animating — when the geometry could not
 * be measured.
 *
 * `from` and `to` are display objects, or global `{ x, y }` points for a caller
 * that read the position before tearing its panel down (the Level Chest does).
 *
 * The measurement is IN here, and its failure is a return value rather than a
 * throw, because every caller has already committed the claim by this point.
 * A destroyed or detached node must cost the player the animation, never the
 * reward — so the caller pattern is:
 *
 *     const flew = await flyReward(...);
 *     grantReward(user, reward);      // always
 *     if (flew) bumpReward(...);      // only if a counter was actually reached
 */
export async function flyReward(ticker, layer, from, to, icon) {
  let start, end;
  try {
    start = layer.toLocal(from.getGlobalPosition ? from.getGlobalPosition() : from);
    end = layer.toLocal(to.getGlobalPosition ? to.getGlobalPosition() : to);
  } catch (_) {
    if (icon && !icon.destroyed) icon.destroy();
    return false;
  }

  icon.position.set(start.x, start.y);
  layer.addChild(icon);

  // Arc up-then-in via a quadratic Bézier, shrinking as it goes.
  const C = { x: (start.x + end.x) / 2, y: Math.min(start.y, end.y) - 150 };
  await tween(ticker, {
    duration: 540, ease: easeInOutQuad,
    onUpdate: (e) => {
      const u = 1 - e;
      icon.x = u * u * start.x + 2 * u * e * C.x + e * e * end.x;
      icon.y = u * u * start.y + 2 * u * e * C.y + e * e * end.y;
      icon.scale.set(1 - 0.3 * e);
    },
  });
  if (!icon.destroyed) icon.destroy();
  return true;
}

/** The landing beat: the counter the reward flew into swells and settles. */
export function bumpReward(ticker, node) {
  return tween(ticker, {
    duration: 240, ease: easeOutCubic,
    onUpdate: (e) => node.scale.set(1 + 0.28 * Math.sin(Math.PI * e)),
  });
}
