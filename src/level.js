// Level parsing + guaranteed-solvable tile-type assignment.
//
// BOARD FORMAT (`assets/levels/*.tmb`) — plain text, line-oriented, one file per
// board, drawn as a character grid at HALF-TILE resolution so the shape in the
// file is the shape on screen:
//
//     tmb 1
//     ; Level 1 — the teaching board
//
//     size   9 6
//     anchor -4 3
//     tiles  27
//
//     layer 0
//     .........
//     #.#.#.#.#
//     .........
//     #.#.#.#.#
//     .........
//     #.#.#.#.#
//
//     layer 1
//     .#.#.#.#.
//     ...
//
// Tiles are one unit square but sit on a HALF-unit lattice, so ONE CHARACTER IS
// ONE HALF-TILE and an upper layer lands in the gaps of the one below — visible
// on the page as the interleave above, and the reason a tile straddles up to
// four beneath it. All layers share one grid, so they stay registered.
//
//   tmb 1        format version, first non-comment line. Required, so a future
//                v2 is REJECTED here rather than quietly misread.
//   ;            comment to end of line, anywhere. Blank lines are ignored.
//   size W H     grid size in half-tile cells. Required. Not redundant with the
//                rows: most rows are entirely blank, and dropping one from every
//                layer would leave a self-consistent file with every tile shifted
//                half a tile. `size` is the only thing that catches that.
//   anchor X Y   the (x, y) of the TOP-LEFT cell, in INTEGER half-tile units.
//                Required. Cell (col, row) is gx = (X + col) / 2,
//                gy = (Y - row) / 2 — so the parser never touches a float, and
//                y grows upward on screen while rows run down the page.
//   tiles N      optional total, checked when present. Catches a dropped or stray
//                `#`, which nothing else does. The converter always writes it.
//   layer k      starts a layer block, k sequential from 0, BOTTOM LAYER FIRST
//                (computeCoverers below reads `a.layer > b.layer`). Exactly H
//                grid rows follow.
//
// A grid row is read by stripping ALL whitespace and taking each remaining
// character as one cell, so `. . # .` and `..#.` are the same row — spaced is
// easier to hand-edit, dense is what the converter writes. Cells are `.` empty
// and `#` a tile. AN ALL-EMPTY ROW MUST BE WRITTEN AS DOTS: a blank line is a
// comment, not a row of nothing.
//
// parseBoard() VALIDATES, and unknown directives are rejected rather than
// ignored — a typo'd `anchr -4 3` must not fall back to a default. The encoding
// it replaced (the decrypted XXTEA blobs: an array of "x|y,x|y" layer strings)
// validated nothing at all, so a typo became a NaN coordinate and a tile that
// landed nowhere. tools/levelfmt.py converts, checks and fingerprints boards
// outside the game, and is a deliberately independent second implementation.
//
// TILE ORDER IS LOAD-BEARING. assignSolvableTypes seeds its `free` list in index
// order, so the removal order it derives — and therefore which position wears
// which face — is a function of the order tiles are listed in. parseBoard emits
// a canonical order (layer, then down the board, then across); tools/levelfmt.py
// must sort identically or the two disagree about every board.

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

/** Thrown by parseBoard for a board file it cannot read. */
export class BoardError extends Error {}

const FORMAT_VERSION = 1;
const EMPTY = ".", TILE = "#";

/**
 * Parse a `.tmb` board. Throws a BoardError naming the file and line on
 * anything it cannot read — see the format notes at the top of this file.
 *
 * Returns `{ tiles, size, anchor }`, where `tiles` is a frozen array of
 * `{ gx, gy, layer }` in CANONICAL order (layer, then down the board, then
 * across). The freeze is deliberate: this object is cached per level by
 * src/assets.js and shared by every load of it, so a caller that means to
 * decorate tiles with gameplay state (`.type`, a solution order) must copy them
 * first. assignSolvableTypes mutates what it is given.
 */
export function parseBoard(text, url = "<board>") {
  const die = (line, msg) => { throw new BoardError(`${url}:${line}: ${msg}`); };
  const bare = (msg) => { throw new BoardError(`${url}: ${msg}`); };

  let size = null, anchor = null, declared = null, version = false;
  let layer = null, rows = 0;
  const tiles = [];
  const lines = String(text).split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;
    const line = lines[i].split(";")[0].trim();   // ';' comments out the rest
    if (!line) continue;                          // blank lines carry nothing
    const head = line.split(/\s+/)[0];

    if (head === "tmb") {
      if (version) die(lineNo, "duplicate 'tmb' directive");
      const m = /^tmb\s+(\d+)$/.exec(line);
      if (!m) die(lineNo, `malformed version line: "${line}" (want 'tmb ${FORMAT_VERSION}')`);
      if (+m[1] !== FORMAT_VERSION) {
        die(lineNo, `unsupported format version ${m[1]}, this parser reads ${FORMAT_VERSION}`);
      }
      version = true;
      continue;
    }
    if (!version) die(lineNo, `expected 'tmb ${FORMAT_VERSION}' as the first line, got "${line}"`);

    if (head === "layer") {
      if (!size || !anchor) die(lineNo, "'layer' before 'size'/'anchor'");
      if (layer !== null && rows !== size[1]) {
        die(lineNo, `layer ${layer} has ${rows} rows, 'size' declares ${size[1]}`);
      }
      const m = /^layer\s+(\d+)$/.exec(line);
      if (!m) die(lineNo, `malformed layer header: "${line}"`);
      const k = +m[1], expect = layer === null ? 0 : layer + 1;
      if (k !== expect) die(lineNo, `layer ${k} out of sequence, expected ${expect}`);
      layer = k; rows = 0;
      continue;
    }

    if (head === "size" || head === "anchor" || head === "tiles") {
      if (layer !== null) die(lineNo, `'${head}' must come before the first 'layer'`);
      const m = head === "tiles"
        ? /^tiles\s+(\d+)$/.exec(line)
        : new RegExp(`^${head}\\s+(-?\\d+)\\s+(-?\\d+)$`).exec(line);
      if (!m) die(lineNo, `malformed '${head}' directive: "${line}"`);
      if (head === "size") {
        if (size) die(lineNo, "duplicate 'size'");
        size = [+m[1], +m[2]];
        if (size[0] < 1 || size[1] < 1) die(lineNo, `'size' must be positive, got ${size[0]}x${size[1]}`);
      } else if (head === "anchor") {
        if (anchor) die(lineNo, "duplicate 'anchor'");
        anchor = [+m[1], +m[2]];
      } else {
        if (declared !== null) die(lineNo, "duplicate 'tiles'");
        declared = +m[1];
      }
      continue;
    }

    // Anything else has to be a grid row inside a layer.
    if (layer === null) die(lineNo, `unknown directive "${head}"`);
    const cells = line.replace(/\s+/g, "");
    const [W, H] = size;
    if (rows >= H) die(lineNo, `layer ${layer} has more than the ${H} rows 'size' declares`);
    if (cells.length !== W) die(lineNo, `row is ${cells.length} cells, 'size' declares ${W}`);
    for (const ch of cells) {
      if (ch !== EMPTY && ch !== TILE) {
        die(lineNo, `unknown cell glyph "${ch}" (want "${EMPTY}" or "${TILE}")`);
      }
    }
    const [X, Y] = anchor;
    for (let col = 0; col < W; col++) {
      if (cells[col] === TILE) tiles.push({ gx: (X + col) / 2, gy: (Y - rows) / 2, layer });
    }
    rows++;
  }

  if (!version) bare(`empty board (no 'tmb ${FORMAT_VERSION}' line)`);
  if (!size) bare("missing 'size'");
  if (!anchor) bare("missing 'anchor'");
  if (layer === null) bare("no layers");
  if (rows !== size[1]) bare(`layer ${layer} has ${rows} rows, 'size' declares ${size[1]}`);
  if (declared !== null && declared !== tiles.length) {
    bare(`'tiles ${declared}' but the grid holds ${tiles.length}`);
  }
  // assignSolvableTypes deals in triples and reshuffle() assumes it too; a board
  // that cannot be split into threes is unwinnable, so refuse it here rather
  // than build it and find out.
  if (tiles.length % 3) bare(`${tiles.length} tiles is not a multiple of 3`);

  // The row-major scan above already emits this order; sorting states the
  // invariant rather than relying on the loop, and must stay identical to
  // tools/levelfmt.py or the two disagree about every board's faces.
  tiles.sort((a, b) => a.layer - b.layer || b.gy - a.gy || a.gx - b.gx);
  return { tiles: Object.freeze(tiles), size, anchor };
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
