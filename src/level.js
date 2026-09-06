// Level parsing + guaranteed-solvable tile-type assignment.
//
// Level format (decrypted from the original XXTEA blobs): an array of layer
// strings, bottom layer first. Each layer is "x|y,x|y,..." where x,y are
// grid coordinates (in tile units; adjacent layers are offset by 0.5 so an
// upper tile straddles up to four lower ones).

import { CONFIG } from "./config.js";

// The widest scatter window the tray can survive, in triples.
//
// Following the solution order through one window, the worst line takes two
// tiles of every group in it before any triple completes — 2*W cells held. The
// very next tap must then complete one, so the tray peaks at 2*W + 1 for the
// instant before that triple clears, and the rule is 2*W + 1 <= traySlots. At
// the default 7 slots that is W <= 3, and a hard board really does run right up
// to it: a solve of one peaks at exactly 7 of 7 and still clears.
// Derived, not tuned — widening the tray widens what a 100% scatter may mean.
const MAX_WINDOW = Math.max(1, Math.floor((CONFIG.board.traySlots - 1) / 2));

// Map a scatter percentage (0..100, see CONFIG.board.mixPercent) onto that
// window. 0 -> 1 triple per window, which is the consecutive-triples layout this
// generator has always produced; 100 -> MAX_WINDOW.
export function mixWindow(mixPercent) {
  const pct = Math.max(0, Math.min(100, Number(mixPercent) || 0));
  return 1 + Math.round((pct / 100) * (MAX_WINDOW - 1));
}

// A deterministic PRNG so a level always builds the same board per seed.
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Parse raw level array into a flat list of tile position records. */
export function parseLevel(rawArr) {
  const tiles = [];
  rawArr.forEach((layerStr, layer) => {
    layerStr
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .forEach((pos) => {
        const [x, y] = pos.split("|").map(Number);
        tiles.push({ gx: x, gy: y, layer });
      });
  });
  return tiles;
}

const OVERLAP = 0.99; // two unit tiles overlap when centres are < 1 unit apart

/**
 * Compute, for each tile, the set of tile indices in a HIGHER layer whose
 * footprint overlaps it (its "coverers"). A tile is selectable only when all
 * its coverers have been removed.
 */
export function computeCoverers(tiles) {
  const n = tiles.length;
  const coverers = Array.from({ length: n }, () => []);
  const covered = Array.from({ length: n }, () => []); // tiles this one sits on top of
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (i === j) continue;
      const a = tiles[i], b = tiles[j];
      if (
        a.layer > b.layer &&
        Math.abs(a.gx - b.gx) < OVERLAP &&
        Math.abs(a.gy - b.gy) < OVERLAP
      ) {
        coverers[j].push(i); // i covers j
        covered[i].push(j);  // i sits on j
      }
    }
  }
  return { coverers, covered };
}

/**
 * Assign a type to every tile so the board is guaranteed solvable:
 *   1. Derive a valid full removal order by repeatedly removing any tile that
 *      is currently free (a linear extension of the covering DAG).
 *   2. Walk that order in WINDOWS of `W` triples and deal each window's slots
 *      randomly among its groups, one type per triple.
 * `W` comes from `mixPercent` (see mixWindow above) and is what makes one board
 * harder than another. At W = 1 — the baseline, and everything this generator
 * did before the setting existed — a triple owns three CONSECUTIVE slots, so
 * complete sets are ready to take and rarely need more than 3 tray cells. As W
 * grows, a triple's three tiles are scattered across up to 3W slots and so
 * across different depths: fewer matches are available up front and the tray
 * carries half-finished sets. Solvability survives because a group never
 * straddles a window boundary — the tray empties at every one — so clearing in
 * `order` never holds more than 2W tiles waiting, and peaks at 2W + 1 for the
 * instant the completing tap lands. That is exactly what MAX_WINDOW caps against
 * the tray's capacity.
 * Types are drawn from a palette of `numTypes`; sharing types across triples
 * only adds matching options, never removes solvability.
 */
export function assignSolvableTypes(tiles, numTypes, rng, mixPercent = 0) {
  const n = tiles.length;
  const { coverers } = computeCoverers(tiles);
  const remaining = coverers.map((c) => c.length);
  const removed = new Array(n).fill(false);

  // tiles this index covers (to decrement when it is removed)
  const covers = Array.from({ length: n }, () => []);
  coverers.forEach((cvs, j) => cvs.forEach((i) => covers[i].push(j)));

  const free = [];
  for (let i = 0; i < n; i++) if (remaining[i] === 0) free.push(i);

  const order = [];
  while (order.length < n && free.length) {
    const k = Math.floor(rng() * free.length);
    const idx = free[k];
    free[k] = free[free.length - 1];
    free.pop();
    removed[idx] = true;
    order.push(idx);
    for (const j of covers[idx]) {
      if (!removed[j] && --remaining[j] === 0) free.push(j);
    }
  }

  // One type per triple. Guarantee every type in the palette appears at least
  // once (so a level shows `numTypes` distinct tiles) when there are enough
  // triples: seed the first `numTypes` groups with 0..numTypes-1, fill the rest
  // randomly, then shuffle the group→type mapping. Solvability is unaffected —
  // each triple is still a single type, and still confined to one window.
  const numGroups = Math.floor(order.length / 3);
  const groupTypes = [];
  for (let g = 0; g < numGroups; g++) {
    groupTypes.push(g < numTypes ? g : Math.floor(rng() * numTypes));
  }
  for (let i = groupTypes.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [groupTypes[i], groupTypes[j]] = [groupTypes[j], groupTypes[i]];
  }

  // Deal the groups onto the order, one window at a time. A window owns exactly
  // the slots its own groups would have taken anyway, so no group can leak into
  // the next window and the tray is empty again at every boundary. At W = 1 the
  // shuffle is a no-op on the result (all three slots go to the same group), so
  // an unmixed board is identical to the one this produced before mixing existed.
  const W = mixWindow(mixPercent);
  const types = new Array(n).fill(0);
  for (let g0 = 0; g0 < numGroups; g0 += W) {
    const gEnd = Math.min(numGroups, g0 + W);
    const slots = [];
    for (let g = g0; g < gEnd; g++) for (let s = 0; s < 3; s++) slots.push(g * 3 + s);
    for (let i = slots.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [slots[i], slots[j]] = [slots[j], slots[i]];
    }
    let k = 0;
    for (let g = g0; g < gEnd; g++) {
      for (let s = 0; s < 3; s++) types[order[slots[k++]]] = groupTypes[g];
    }
  }
  tiles.forEach((t, i) => (t.type = types[i]));
  // Expose a known-good clearing order (indices into `tiles`) for auto-solve /
  // verification. Following it wins within the tray, peaking at 2W + 1 cells.
  tiles.solutionOrder = order;
  return tiles;
}
