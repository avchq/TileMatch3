// Level parsing + guaranteed-solvable tile-type assignment.
//
// Level format (decrypted from the Cocos XXTEA blobs): an array of layer
// strings, bottom layer first. Each layer is "x|y,x|y,..." where x,y are
// grid coordinates (in tile units; adjacent layers are offset by 0.5 so an
// upper tile straddles up to four lower ones).

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
 *   2. Group consecutive triples in that order and give each triple one type.
 * Because every triple is consecutive in a valid order, clearing them in order
 * never needs more than 3 tray slots — so the board can always be won.
 * Types are drawn from a palette of `numTypes`; sharing types across triples
 * only adds matching options, never removes solvability.
 */
export function assignSolvableTypes(tiles, numTypes, rng) {
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
  // each triple is still a single type, consecutive in a valid removal order.
  const numGroups = Math.floor(order.length / 3);
  const groupTypes = [];
  for (let g = 0; g < numGroups; g++) {
    groupTypes.push(g < numTypes ? g : Math.floor(rng() * numTypes));
  }
  for (let i = groupTypes.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [groupTypes[i], groupTypes[j]] = [groupTypes[j], groupTypes[i]];
  }

  const types = new Array(n).fill(0);
  for (let g = 0; g < numGroups; g++) {
    for (let s = 0; s < 3; s++) types[order[g * 3 + s]] = groupTypes[g];
  }
  tiles.forEach((t, i) => (t.type = types[i]));
  // Expose a known-good clearing order (indices into `tiles`) for auto-solve /
  // verification. Following it in triples always wins with only 3 tray slots.
  tiles.solutionOrder = order;
  return tiles;
}
