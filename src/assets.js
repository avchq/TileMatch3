// Asset management: manifest-driven preloading + lazy, on-demand loading.
//
// Assets are grouped: a shared `core` group plus one group per level. The level
// groups are generated from the level table (assets/config/levels.json, loaded
// by src/levelConfig.js) — the single place levels are declared — so adding a
// level is a one-line config edit with no changes here. On boot we PRELOAD
// `core` + every level flagged `preload`; any other level's assets are
// LAZY-loaded on demand via ensureLevel(), fetched only when the player reaches it.
//
// Because the level table is fetched asynchronously at boot, the per-level
// groups can't be built at import time. main.js calls buildLevelGroups(levels)
// once the table is loaded (before any preload) to populate MANIFEST +
// PRELOAD_GROUPS in place.
//
// Every network asset is fetched EXACTLY ONCE and cached in memory:
//   - audio  -> decoded to an AudioBuffer (played from RAM, no per-play GET)
//   - images -> PIXI.Texture (PIXI.Assets caches by URL)
//   - levels -> parsed board (src/level.js parseBoard)
//
// A GROUP IS ONLY "LOADED" IF EVERY ONE OF ITS ASSETS ARRIVED. This used to be
// the other way round: each job swallowed its own failure, so `Promise.all`
// always resolved, the group was marked loaded regardless, and the memo at the
// top of loadGroup() then short-circuited every later attempt. One transient
// 5xx on a level's JSON permanently disabled that level — the Play button did
// nothing, forever, with no message and no way to retry short of a reload.
// Now a failed job is recorded, the group is left UNLOADED, and loadGroup()
// REJECTS with the failed URLs. The work that did succeed is kept, so a retry
// re-fetches only what is actually missing.

import { fetchText, fetchBuffer, withTimeout } from "./net.js";
import { parseBoard } from "./level.js";

// The group a level's assets (its background + board data) live in. Exported so
// boot can name the group for the level the player is ON — see main.js.
export const levelGroup = (n) => `level${n}`;

// The single source of truth for what exists and where it lives. `core` is
// hand-authored; the per-level groups are added by buildLevelGroups() from the
// loaded level table (level N === entry N-1), each keyed by level number so
// ensureLevel(n) can find it.
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
      // The Level Chest bursting open on the level-complete screen (src/game.js).
      { name: "openbox", url: "assets/audio/openbox.mp3", volume: 0.8 },
      // The Super Wand: its arrival on the helper button, and the board-clearing
      // sweep itself. Louder than `merge_click` on purpose — the sweep has to
      // read as a bigger event than the ordinary match it upgrades.
      { name: "super_hint", url: "assets/audio/super_hint.mp3", volume: 0.9 },
      // The Fortune Wheel's spin clicks. Looped (over its head only) and pitched
      // to the wheel's live speed by FortuneWheelScene — see playLoop().
      { name: "wheel_spin", url: "assets/audio/wheel-spin-click-slow-down-fast-101154.mp3", volume: 0.7 },
    ],
  },
};

// The essential minimum to preload on boot: shared assets, plus every level the
// config marks `preload` (appended by buildLevelGroups). The rest lazy-load on
// demand.
export const PRELOAD_GROUPS = ["core"];

// Build the per-level asset groups from the loaded level table, mutating
// MANIFEST + PRELOAD_GROUPS in place. Call once at boot (main.js) after the
// levels are fetched, before any preload/lazy-load.
export function buildLevelGroups(levels) {
  levels.forEach((lvl, i) => {
    const n = i + 1;
    MANIFEST[levelGroup(n)] = {
      backgrounds: { [n]: lvl.background },
      levels: { [n]: lvl.data },
    };
    if (lvl.preload) PRELOAD_GROUPS.push(levelGroup(n));
  });
}

export class AssetManager {
  constructor(audio) {
    this.audio = audio;
    // Live, shared maps handed to scenes; mutated in place as groups load so
    // scenes automatically see newly-available assets.
    this.backgrounds = {};   // levelNum -> PIXI.Texture
    this.levels = {};        // levelNum -> parsed board { tiles, size, anchor }

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
   * has either arrived or failed. `onProgress(loaded, total)` is called as items
   * complete.
   *
   * DELIBERATELY NON-FATAL: a group that fails here is left unloaded and
   * reported, and boot carries on. Boot must not die because one sound file
   * 404'd — but it must not pretend the group is in memory either, because that
   * is what made the failure permanent (see the note at the top of this file).
   * Leaving it unloaded is what lets the on-demand path retry it later.
   *
   * Returns the array of errors, one per failed group (empty on full success).
   */
  async preload(groups = PRELOAD_GROUPS, onProgress) {
    const total = groups.reduce((s, g) => s + this._groupSize(g), 0);
    let done = 0;
    const tick = () => { done++; onProgress && onProgress(done, total); };
    const settled = await Promise.all(
      groups.map((g) => this.loadGroup(g, tick).then(() => null, (e) => e)));
    const failed = settled.filter(Boolean);
    for (const e of failed) console.warn("preload:", e.message);
    return failed;
  }

  /**
   * Lazy-load a level's assets on demand. No-op if already loaded.
   * `onProgress(loaded, total)` is called as items complete, so the caller can
   * show a real bar (a level group is 2 items: its background + its data).
   *
   * REJECTS if any of the group's assets failed — callers must catch. The
   * rejection is the point: it is what tells the Play button to say so and stay
   * pressable, instead of silently doing nothing (see loadGroup).
   */
  async ensureLevel(n, onProgress) {
    const group = levelGroup(n);
    if (!this.hasGroup(group)) {
      throw new Error(`No manifest entry for level ${n} (group "${group}")`);
    }
    const total = this._groupSize(group);
    let done = 0;
    const tick = onProgress ? () => { done++; onProgress(done, total); } : undefined;
    return this.loadGroup(group, tick);
  }

  /**
   * Load one group's assets. Idempotent: returns immediately if already loaded,
   * and shares a single in-flight promise across concurrent callers.
   *
   * Resolves only when EVERY asset in the group arrived; otherwise rejects with
   * an Error carrying `.failed` (the URLs that did not make it) and leaves the
   * group unloaded so a later call tries again. Anything that DID arrive is
   * kept and skipped on the retry — a retry after a failed background re-fetches
   * the background alone, not the level data beside it.
   */
  loadGroup(group, tick) {
    if (this._loaded.has(group)) return Promise.resolve();
    if (this._inflight.has(group)) return this._inflight.get(group);

    const g = MANIFEST[group];
    if (!g) return Promise.reject(new Error(`Unknown asset group "${group}"`));

    const failed = [];
    const jobs = [];
    // Every job ticks progress exactly once whatever happens — including the
    // already-satisfied ones a retry skips — so the bar still reaches 100% and
    // `_groupSize` stays the honest denominator.
    const job = (url, run) => jobs.push(
      Promise.resolve().then(run)
        .catch((e) => { failed.push(url); console.warn(`asset "${url}" failed:`, e); })
        .finally(() => tick && tick())
    );

    for (const spec of g.audio || []) {
      job(spec.url, async () => {
        if (this.audio.buffers[spec.name]) return;    // already decoded
        await this.audio.register(spec.name, await fetchBuffer(spec.url), spec);
      });
    }

    for (const [num, url] of Object.entries(g.backgrounds || {})) {
      job(url, async () => {
        if (this.backgrounds[num]) return;            // already in the texture cache
        // PIXI.Assets.load has no timeout of its own, and a stalled image would
        // otherwise hold this group's Promise.all — and the loading splash in
        // front of it — open forever.
        this.backgrounds[num] = await withTimeout(PIXI.Assets.load(url), url);
      });
    }

    for (const [num, url] of Object.entries(g.levels || {})) {
      job(url, async () => {
        if (this.levels[num]) return;                 // already parsed
        // Parsed HERE, not in the scene. A malformed board then fails exactly
        // like a 404 — this job records the failure, the group is left unloaded
        // and loadGroup rejects — so startLevel's `if (!data)` keeps the Play
        // button pressable and honest. Parsing in loadLevel would instead throw
        // AFTER it has torn down the previous board and shown the scene, leaving
        // a blank locked screen over a hidden lobby.
        this.levels[num] = parseBoard(await fetchText(url), url);
      });
    }

    // `jobs` never rejects (each one catches into `failed`), so this always
    // runs and `_inflight` is always cleared — which is what makes the next
    // call a real retry rather than a re-await of a settled failure.
    const p = Promise.all(jobs).then(() => {
      this._inflight.delete(group);
      if (failed.length) {
        const err = new Error(`asset group "${group}" incomplete: ${failed.join(", ")}`);
        err.failed = failed;
        throw err;
      }
      this._loaded.add(group);
    });
    this._inflight.set(group, p);
    return p;
  }
}
