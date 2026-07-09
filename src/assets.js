// Asset management: manifest-driven preloading + lazy, on-demand loading.
//
// Assets are grouped: a shared `core` group plus one group per level. The level
// groups are generated from the LEVELS config (src/levelConfig.js) — the single
// place levels are declared — so adding a level is a one-line config edit with
// no changes here. On boot we PRELOAD `core` + every level flagged `preload`;
// any other level's assets are LAZY-loaded on demand via ensureLevel(), fetched
// only when the player actually reaches it.
//
// Every network asset is fetched EXACTLY ONCE and cached in memory:
//   - audio  -> decoded to an AudioBuffer (played from RAM, no per-play GET)
//   - images -> PIXI.Texture (PIXI.Assets caches by URL)
//   - levels -> parsed JSON

import { LEVELS } from "./levelConfig.js";

const levelGroup = (n) => `level${n}`;

// The single source of truth for what exists and where it lives. `core` is
// hand-authored; the per-level groups are built from LEVELS (level N === entry
// N-1), each keyed by level number so ensureLevel(n) can find it.
export const MANIFEST = {
  // Shared assets used across all levels — preloaded once.
  core: {
    audio: [
      { name: "Game_bgm", url: "assets/audio/Game_bgm.mp3", loop: true, volume: 0.4 },
      { name: "tile_bop", url: "assets/audio/tile_bop.mp3", volume: 0.7 },
      { name: "merge_click", url: "assets/audio/merge_click.mp3", volume: 0.8 },
      { name: "win", url: "assets/audio/win.mp3", volume: 0.8 },
      { name: "fail", url: "assets/audio/fail.mp3", volume: 0.7 },
      { name: "btn_01", url: "assets/audio/btn_01.mp3", volume: 0.6 },
    ],
  },
};
LEVELS.forEach((lvl, i) => {
  const n = i + 1;
  MANIFEST[levelGroup(n)] = {
    backgrounds: { [n]: lvl.background },
    levels: { [n]: lvl.data },
  };
});

// The essential minimum to preload on boot: shared assets + every level the
// config marks `preload`. The rest lazy-load on demand.
export const PRELOAD_GROUPS = [
  "core",
  ...LEVELS.flatMap((lvl, i) => (lvl.preload ? [levelGroup(i + 1)] : [])),
];

export class AssetManager {
  constructor(audio) {
    this.audio = audio;
    // Live, shared maps handed to scenes; mutated in place as groups load so
    // scenes automatically see newly-available assets.
    this.backgrounds = {};   // levelNum -> PIXI.Texture
    this.levels = {};        // levelNum -> parsed level JSON (array of layers)

    this._loaded = new Set();     // group names fully loaded
    this._inflight = new Map();   // group name -> Promise (dedupe concurrent loads)
  }

  isLoaded(group) { return this._loaded.has(group); }
  hasGroup(group) { return !!MANIFEST[group]; }
  hasLevel(n) { return this.hasGroup(levelGroup(n)); }

  background(n) { return this.backgrounds[n]; }
  levelData(n) { return this.levels[n]; }

  /** Count of individual assets in a group (for progress reporting). */
  _groupSize(group) {
    const g = MANIFEST[group] || {};
    return (g.audio?.length || 0) +
      Object.keys(g.backgrounds || {}).length +
      Object.keys(g.levels || {}).length;
  }

  /**
   * Preload a set of groups (the essential minimum). Resolves once every asset
   * is in memory. `onProgress(loaded, total)` is called as items complete.
   */
  async preload(groups = PRELOAD_GROUPS, onProgress) {
    const total = groups.reduce((s, g) => s + this._groupSize(g), 0);
    let done = 0;
    const tick = () => { done++; onProgress && onProgress(done, total); };
    await Promise.all(groups.map((g) => this.loadGroup(g, tick)));
  }

  /** Lazy-load a level's assets on demand. No-op if already loaded. */
  async ensureLevel(n) {
    const group = levelGroup(n);
    if (!this.hasGroup(group)) {
      throw new Error(`No manifest entry for level ${n} (group "${group}")`);
    }
    return this.loadGroup(group);
  }

  /**
   * Load one group's assets. Idempotent: returns immediately if already loaded,
   * and shares a single in-flight promise across concurrent callers.
   */
  loadGroup(group, tick) {
    if (this._loaded.has(group)) return Promise.resolve();
    if (this._inflight.has(group)) return this._inflight.get(group);

    const g = MANIFEST[group];
    if (!g) return Promise.reject(new Error(`Unknown asset group "${group}"`));

    const jobs = [];

    for (const spec of g.audio || []) {
      jobs.push(
        fetch(spec.url)
          .then((r) => r.arrayBuffer())
          .then((buf) => this.audio.register(spec.name, buf, spec))
          .catch((e) => console.warn(`audio "${spec.name}" failed:`, e))
          .finally(() => tick && tick())
      );
    }

    for (const [num, url] of Object.entries(g.backgrounds || {})) {
      jobs.push(
        PIXI.Assets.load(url)
          .then((tex) => { this.backgrounds[num] = tex; })
          .catch((e) => console.warn(`background ${num} failed:`, e))
          .finally(() => tick && tick())
      );
    }

    for (const [num, url] of Object.entries(g.levels || {})) {
      jobs.push(
        fetch(url)
          .then((r) => r.json())
          .then((data) => { this.levels[num] = data; })
          .catch((e) => console.warn(`level ${num} failed:`, e))
          .finally(() => tick && tick())
      );
    }

    const p = Promise.all(jobs).then(() => {
      this._loaded.add(group);
      this._inflight.delete(group);
    });
    this._inflight.set(group, p);
    return p;
  }
}
