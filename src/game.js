import { parseLevel, computeCoverers, assignSolvableTypes, mulberry32 } from "./level.js";
import { easeOutCubic, easeOutBack, tween } from "./tween.js";
import { makeCogButton } from "./settings.js";
import { typesForLevel } from "./levelConfig.js";

const DESIGN_W = 750;
const DESIGN_H = 1334;

const CELL = 88;          // tile footprint in board units (px at scale 1)
const TILE_DRAW = 96;     // drawn tile size (slightly larger than cell for overlap)
const LIFT = 7;           // per-layer vertical lift for the 3D-stack look
const TRAY_SLOTS = 7;
const SLOT = 84;

const BOARD_AREA = { x: 375, top: 250, bottom: 1030 };
const TRAY_Y = 1140;

export class GameScene extends PIXI.Container {
  constructor(app, tileTextures, slotTexture, backgrounds, audio, user) {
    super();
    this.app = app;
    this.tileTextures = tileTextures;
    this.slotTexture = slotTexture;
    this.backgrounds = backgrounds; // { 1: tex, 2: tex, 3: tex }
    this.audio = audio;
    this.user = user; // player profile — the helper (booster) inventory lives here

    this.bgLayer = new PIXI.Container();
    this.boardLayer = new PIXI.Container();
    this.trayLayer = new PIXI.Container();
    this.fxLayer = new PIXI.Container();
    this.hudLayer = new PIXI.Container();
    this.overlayLayer = new PIXI.Container();
    this.addChild(this.bgLayer, this.boardLayer, this.trayLayer, this.fxLayer, this.hudLayer, this.overlayLayer);

    this.tiles = [];
    this.tray = [];
    this.history = [];      // collected tile refs, newest last (for undo)
    this.boardCount = 0;
    this.levelNum = 1;
    this.locked = false;    // blocks input during win/lose transitions
    this.onLevelComplete = null; // (levelNum) => void — set by the host (main.js)
    this.onSettings = null;      // () => void — open the settings screen
    this.onExit = null;          // () => void — leave the level, back to the lobby

    this._buildHud();
    this._buildTraySlots();
    // Keep the helper buttons in sync when the inventory changes elsewhere
    // (e.g. a reward grant), not just when we spend one during a level.
    if (this.user) this.user.on((domain) => { if (domain === "boosters") this._updateBoosters(); });
    this._updateBoosters();
  }

  // Reflect the helper (booster) inventory on the HUD: each helper shows its
  // remaining-uses count in a bubble, and is disabled (greyed-out, ignores taps)
  // when the player has none left — or, for Undo, when there's nothing to undo.
  _updateBoosters() {
    const undoLeft = this.user ? this.user.boosterCount("undo") : 0;
    const shuffleLeft = this.user ? this.user.boosterCount("shuffle") : 0;
    this._setBoosterButton(this.undoBtn, this.undoBadge, undoLeft, undoLeft > 0 && this.history.length > 0);
    this._setBoosterButton(this.shuffleBtn, this.shuffleBadge, shuffleLeft, shuffleLeft > 0);
  }

  _setBoosterButton(btn, badge, count, usable) {
    btn.eventMode = usable ? "static" : "none";
    btn.cursor = usable ? "pointer" : "default";
    // Grey the button out whenever it can't be used right now — an empty stock
    // OR (for Undo) an empty tray with no move to undo. The count bubble still
    // shows the owned stock so the player sees they have helpers in reserve.
    btn.alpha = usable ? 1 : 0.4;
    badge.text.text = String(count);
    badge.visible = true; // always show the stock, even at 0, so the player sees it
    badge.dim(count === 0);
  }

  // ---- static chrome -------------------------------------------------------

  _buildBackground() {
    this.bgLayer.removeChildren();
    const tex = this.backgrounds[this.levelNum] || this.backgrounds[1];
    if (tex) {
      const sp = new PIXI.Sprite(tex);
      // cover-fit
      const scale = Math.max(DESIGN_W / tex.width, DESIGN_H / tex.height);
      sp.scale.set(scale);
      sp.anchor.set(0.5);
      sp.position.set(DESIGN_W / 2, DESIGN_H / 2);
      this.bgLayer.addChild(sp);
    }
    const dark = new PIXI.Graphics();
    dark.beginFill(0x0a1226, 0.34).drawRect(0, 0, DESIGN_W, DESIGN_H).endFill();
    this.bgLayer.addChild(dark);
  }

  _buildHud() {
    // top bar
    const bar = new PIXI.Graphics();
    bar.beginFill(0x0a1226, 0.35).drawRoundedRect(24, 40, DESIGN_W - 48, 120, 28).endFill();
    this.hudLayer.addChild(bar);

    this.levelText = new PIXI.Text("LEVEL 1", {
      fontFamily: "Arial", fontSize: 40, fontWeight: "900", fill: 0xffffff,
      stroke: 0x1a2a52, strokeThickness: 6,
    });
    this.levelText.anchor.set(0.5);
    this.levelText.position.set(DESIGN_W / 2, 84);
    this.hudLayer.addChild(this.levelText);

    this.progressText = new PIXI.Text("", {
      fontFamily: "Arial", fontSize: 24, fontWeight: "700", fill: 0xcfe0ff,
    });
    this.progressText.anchor.set(0.5);
    this.progressText.position.set(DESIGN_W / 2, 128);
    this.hudLayer.addChild(this.progressText);

    // buttons row — round, icon-only. Placed BELOW the tray panel (whose bottom
    // edge sits at TRAY_Y + SLOT/2 + 18) so the two never overlap.
    // Helper (booster) buttons. Each carries a count bubble showing how many
    // uses remain in the player's inventory; both are disabled when empty
    // (see _updateBoosters).
    const by = 1266;
    this.shuffleBtn = this._makeRoundButton("🔀", 54, 175, by, 0xff8a3d, () => this.reshuffle());
    this.undoBtn = this._makeRoundButton("⤺", 54, 575, by, 0x4d8dff, () => this.undo());
    this.shuffleBadge = this._makeCountBadge(175 + 38, by - 38);
    this.undoBadge = this._makeCountBadge(575 + 38, by - 38);
    this.hudLayer.addChild(this.shuffleBtn, this.undoBtn, this.shuffleBadge, this.undoBadge);

    // Settings (cog) — top-left. Opens the settings screen via the host.
    const cog = makeCogButton(this.audio, () => this.onSettings && this.onSettings());
    cog.position.set(60, 84);
    this.hudLayer.addChild(cog);

    // Back — sits next to the cog. Stops the level and returns to the lobby;
    // any user-record changes made during the level are left intact (persisted).
    this.hudLayer.addChild(
      this._makeRoundButton("‹", 38, 148, 84, 0x334063, () => this.onExit && this.onExit())
    );
  }

  _makeButton(label, w, h, cx, cy, color, onClick) {
    const c = new PIXI.Container();
    c.position.set(cx, cy);
    const g = new PIXI.Graphics();
    g.beginFill(color).drawRoundedRect(-w / 2, -h / 2, w, h, h / 2.4).endFill();
    g.lineStyle(4, 0xffffff, 0.35).drawRoundedRect(-w / 2, -h / 2, w, h, h / 2.4);
    const t = new PIXI.Text(label, {
      fontFamily: "Arial", fontSize: 30, fontWeight: "800", fill: 0xffffff,
    });
    t.anchor.set(0.5);
    c.addChild(g, t);
    c.label = t;
    c.eventMode = "static";
    c.cursor = "pointer";
    c.on("pointertap", () => {
      this.audio.play("btn_01");
      onClick();
    });
    c.on("pointerdown", () => (c.scale.set(0.94)));
    c.on("pointerup", () => c.scale.set(1));
    c.on("pointerupoutside", () => c.scale.set(1));
    return c;
  }

  // A round, icon-only action button (r = radius). Same press feel as _makeButton.
  _makeRoundButton(icon, r, cx, cy, color, onClick) {
    const c = new PIXI.Container();
    c.position.set(cx, cy);
    const g = new PIXI.Graphics();
    g.beginFill(color).drawCircle(0, 0, r).endFill();
    g.lineStyle(4, 0xffffff, 0.35).drawCircle(0, 0, r);
    const t = new PIXI.Text(icon, {
      fontFamily: "Arial", fontSize: Math.round(r * 0.95), fontWeight: "800", fill: 0xffffff,
    });
    t.anchor.set(0.5);
    c.addChild(g, t);
    c.label = t;
    c.eventMode = "static";
    c.cursor = "pointer";
    c.hitArea = new PIXI.Circle(0, 0, r);
    c.on("pointertap", () => {
      this.audio.play("btn_01");
      onClick();
    });
    c.on("pointerdown", () => c.scale.set(0.94));
    c.on("pointerup", () => c.scale.set(1));
    c.on("pointerupoutside", () => c.scale.set(1));
    return c;
  }

  // A small count "bubble" pinned to a button's top-right corner, showing how
  // many uses of a helper remain. dim(true) greys it to signal an empty stock.
  _makeCountBadge(cx, cy) {
    const c = new PIXI.Container();
    c.position.set(cx, cy);
    c.eventMode = "none"; // decorative — never intercepts taps meant for the button
    const r = 20;
    const g = new PIXI.Graphics();
    const draw = (fill) => {
      g.clear();
      g.beginFill(fill).drawCircle(0, 0, r).endFill();
      g.lineStyle(3, 0xffffff, 0.9).drawCircle(0, 0, r);
    };
    draw(0x2ecc71);
    const t = new PIXI.Text("0", {
      fontFamily: "Arial", fontSize: 26, fontWeight: "900", fill: 0xffffff,
      stroke: 0x14361f, strokeThickness: 4,
    });
    t.anchor.set(0.5);
    c.addChild(g, t);
    c.text = t;
    // Green bubble when stocked, muted grey when empty.
    c.dim = (empty) => draw(empty ? 0x8a93ab : 0x2ecc71);
    return c;
  }

  _buildTraySlots() {
    this.slotContainer = new PIXI.Container();
    const totalW = TRAY_SLOTS * SLOT + (TRAY_SLOTS - 1) * 6;
    const startX = DESIGN_W / 2 - totalW / 2 + SLOT / 2;
    this.slotPositions = [];
    // backing panel
    const panel = new PIXI.Graphics();
    panel.beginFill(0x0a1226, 0.4)
      .drawRoundedRect(DESIGN_W / 2 - totalW / 2 - 18, TRAY_Y - SLOT / 2 - 18, totalW + 36, SLOT + 36, 26)
      .endFill();
    this.trayLayer.addChild(panel);
    for (let i = 0; i < TRAY_SLOTS; i++) {
      const x = startX + i * (SLOT + 6);
      this.slotPositions.push({ x, y: TRAY_Y });
      const s = new PIXI.Sprite(this.slotTexture);
      s.anchor.set(0.5);
      s.width = s.height = SLOT;
      s.position.set(x, TRAY_Y);
      this.slotContainer.addChild(s);
    }
    this.trayLayer.addChild(this.slotContainer);
  }

  // ---- level setup ---------------------------------------------------------

  loadLevel(rawArr, levelNum) {
    this.levelNum = levelNum;
    this.rawArr = rawArr;
    this.levelText.text = `LEVEL ${levelNum}`;
    this._buildBackground();
    this.overlayLayer.removeChildren();
    this.boardLayer.removeChildren();
    // clear any tray tiles from a previous run
    this.tray.forEach((t) => t.container.destroy());
    this.tray = [];
    this.history = [];
    this.locked = false;

    const positions = parseLevel(rawArr);
    const { coverers, covered } = computeCoverers(positions);
    const numTypes = typesForLevel(levelNum);
    // Deterministic seed derived only from the level number, so a level's type
    // layout is identical every time it loads (a given tile — e.g. strawberry —
    // is always in the same spot across reloads/sessions). Multiplying by a large
    // odd constant spreads adjacent levels to well-separated RNG streams. Still
    // solvable by construction; the Reshuffle button is the way to re-randomise.
    const seed = (levelNum * 0x9e3779b1) >>> 0;
    assignSolvableTypes(positions, numTypes, mulberry32(seed));
    this.solutionOrder = positions.solutionOrder || [];

    this.tiles = positions.map((p, i) => this._createTile(p, i, coverers[i], covered[i]));
    this.boardCount = this.tiles.length;

    this._layoutBoard();
    this._refreshFreeStates();
    this._updateProgress();
    this._updateBoosters();
  }

  _createTile(p, id, coverers, covered) {
    const cont = new PIXI.Container();
    const sp = new PIXI.Sprite(this.tileTextures[p.type]);
    sp.anchor.set(0.5);
    sp.width = sp.height = TILE_DRAW;
    cont.addChild(sp);
    cont.eventMode = "static";
    cont.cursor = "pointer";

    const tile = {
      id, gx: p.gx, gy: p.gy, layer: p.layer, type: p.type,
      container: cont, sprite: sp,
      coverers: coverers.slice(),   // ids of tiles above
      covered: covered.slice(),     // ids of tiles below
      aliveCovers: coverers.length, // remaining coverers on board
      inTray: false, matched: false,
    };
    cont.on("pointertap", () => this._onTapTile(tile));
    this.boardLayer.addChild(cont);
    return tile;
  }

  _layoutBoard() {
    // bounds from grid coords
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, maxLayer = 0;
    for (const t of this.tiles) {
      minX = Math.min(minX, t.gx); maxX = Math.max(maxX, t.gx);
      minY = Math.min(minY, t.gy); maxY = Math.max(maxY, t.gy);
      maxLayer = Math.max(maxLayer, t.layer);
    }
    const spanX = (maxX - minX + 1) * CELL;
    const spanY = (maxY - minY + 1) * CELL + maxLayer * LIFT;
    const areaW = DESIGN_W - 60;
    const areaH = BOARD_AREA.bottom - BOARD_AREA.top;
    this.boardScale = Math.min(1, areaW / spanX, areaH / spanY);
    const s = this.boardScale;

    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    this.boardCX = BOARD_AREA.x;
    this.boardCY = (BOARD_AREA.top + BOARD_AREA.bottom) / 2;

    // draw order: lower layers first; within a layer, farther rows (higher gy) first
    const ordered = [...this.tiles].sort((a, b) =>
      a.layer - b.layer || b.gy - a.gy || a.gx - b.gx);
    this.boardLayer.removeChildren();
    for (const t of ordered) {
      // leave collected/matched tiles in the tray — only lay out board tiles
      if (t.inTray || t.matched) continue;
      const px = this.boardCX + (t.gx - cx) * CELL * s;
      const py = this.boardCY - (t.gy - cy) * CELL * s - t.layer * LIFT * s;
      t.container.position.set(px, py);
      t.container.scale.set(s * 1.0);
      t.homeX = px; t.homeY = py; t.homeScale = s;
      this.boardLayer.addChild(t.container);
    }
  }

  // ---- interaction ---------------------------------------------------------

  _isFree(t) {
    return !t.inTray && !t.matched && t.aliveCovers === 0;
  }

  _refreshFreeStates() {
    for (const t of this.tiles) {
      if (t.inTray || t.matched) continue;
      const free = t.aliveCovers === 0;
      t.sprite.tint = free ? 0xffffff : 0x8a93ab;
      t.container.eventMode = free ? "static" : "none";
      t.container.cursor = free ? "pointer" : "default";
    }
  }

  _onTapTile(t) {
    if (this.locked) return;
    if (!this._isFree(t)) {
      this._shake(t.container);
      return;
    }
    if (this.tray.length >= TRAY_SLOTS) return;
    this._collect(t);
  }

  _collect(t) {
    t.inTray = true;
    this.boardCount--;
    // free up tiles beneath
    for (const belowId of t.covered) {
      const b = this.tiles[belowId];
      if (!b.inTray && !b.matched) b.aliveCovers = Math.max(0, b.aliveCovers - 1);
    }
    this._refreshFreeStates();

    // reparent to tray keeping world position
    const gp = t.container.getGlobalPosition();
    this.boardLayer.removeChild(t.container);
    this.trayLayer.addChild(t.container);
    const local = this.trayLayer.toLocal(gp);
    t.container.position.set(local.x, local.y);
    t.sprite.tint = 0xffffff;
    t.container.eventMode = "none";

    // Insert into the tray keeping matches together: if a tile of the same type
    // is already in the tray, drop this one in right after the last of its kind
    // so the group stays contiguous; otherwise it goes on the top (end) of the
    // stack. `history` keeps the raw add-order so undo() always pops the tile
    // that was added last, wherever grouping placed it.
    let lastMatch = -1;
    for (let i = this.tray.length - 1; i >= 0; i--) {
      if (this.tray[i].type === t.type) { lastMatch = i; break; }
    }
    if (lastMatch >= 0) this.tray.splice(lastMatch + 1, 0, t);
    else this.tray.push(t);
    this.history.push(t);

    this.audio.play("tile_bop");
    this._layoutTray();
    this._updateProgress();
    this._updateBoosters();

    // settle after the slide-in
    setTimeout(() => this._settle(), 190);
  }

  _layoutTray() {
    this.tray.forEach((t, i) => {
      const pos = this.slotPositions[i];
      this._animateTo(t.container, pos.x, pos.y, 200, easeOutCubic);
      this._animateScale(t.container, SLOT / TILE_DRAW, 200);
    });
  }

  _settle() {
    if (this.locked) return;
    // Clear every complete triple in the tray. Normal play only ever adds one
    // tile at a time (so at most one triple forms), but a reshuffle can create
    // several at once — loop until the tray is stable.
    let matched = false;
    for (;;) {
      const byType = new Map();
      for (const t of this.tray) {
        if (!byType.has(t.type)) byType.set(t.type, []);
        byType.get(t.type).push(t);
      }
      let cleared = false;
      for (const [, group] of byType) {
        if (group.length >= 3) {
          const three = group.slice(0, 3);
          for (const t of three) {
            t.matched = true;
            this.tray.splice(this.tray.indexOf(t), 1);
            this.history.splice(this.history.indexOf(t), 1);
            this._popMatch(t.container);
          }
          matched = true;
          cleared = true;
        }
      }
      if (!cleared) break;
    }
    if (matched) {
      this.audio.play("merge_click");
      this._layoutTray();
      this._updateBoosters();
    }
    this._checkEnd();
  }

  _checkEnd() {
    if (this.locked) return;
    if (this.boardCount === 0 && this.tray.length === 0) {
      this._win();
    } else if (this.boardCount === 0 && this.tray.length > 0) {
      this._lose(); // stranded tiles
    } else if (this.tray.length >= TRAY_SLOTS) {
      this._lose();
    }
  }

  _updateProgress() {
    this.progressText.text = `${this.boardCount} tiles left`;
  }

  undo() {
    if (this.locked) return;
    if (this.history.length === 0) return;      // nothing to undo
    // Undo is a helper: consume one from the inventory. If the player has none,
    // the button is already disabled — this also guards the debug/test entry.
    if (!this.user || !this.user.useBooster("undo")) return;
    const t = this.history.pop();
    if (!t) return;
    const idx = this.tray.indexOf(t);
    if (idx < 0) return;
    this.tray.splice(idx, 1);
    t.inTray = false;
    this.boardCount++;
    // restore coverage on tiles beneath
    for (const belowId of t.covered) {
      const b = this.tiles[belowId];
      if (!b.inTray && !b.matched) b.aliveCovers++;
    }
    // back to board
    this.trayLayer.removeChild(t.container);
    this.boardLayer.addChild(t.container);
    t.container.eventMode = "static";
    this._layoutBoard();
    this._animateScale(t.container, t.homeScale, 1);
    this._refreshFreeStates();
    this._layoutTray();
    this._updateProgress();
    this._updateBoosters();
  }

  restart() {
    if (this.rawArr) this.loadLevel(this.rawArr, this.levelNum);
  }

  // Reshuffle the FACES of the tiles still on the play board into a fresh,
  // still-guaranteed-solvable arrangement. The bottom tray (the pre-match deck)
  // is NOT touched — collected tiles keep their faces. Positions/coverage are
  // unchanged and no progress is lost; only board tile types are reassigned.
  // Unlike restart(), the level is NOT rebuilt.
  reshuffle() {
    if (this.locked) return;
    const boardTiles = this.tiles.filter((t) => !t.matched && !t.inTray);
    if (boardTiles.length === 0) return;
    // Reshuffle is a helper: consume one from the inventory (button is disabled
    // when empty; this also guards the debug/test entry point).
    if (!this.user || !this.user.useBooster("shuffle")) return;

    const order = this._boardRemovalOrder(boardTiles); // fresh valid removal order (refs)
    const B = order.length;
    const numTypes = typesForLevel(this.levelNum);

    // The deck's open groups (each tray type currently holds 1 or 2 — a full 3
    // would have cleared). We finish these off with the FIRST board removals,
    // then fill the rest of the board with fresh triples. Types are independent
    // of coverage, so we can lay any type onto any position of `order`.
    const pending = new Map();
    for (const t of this.tray) pending.set(t.type, (pending.get(t.type) || 0) + 1);
    const pairs = [];   // tray types needing 1 more to complete
    const singles = []; // tray types needing 2 more
    for (const [ty, c] of pending) {
      if (c % 3 === 2) pairs.push(ty);
      else if (c % 3 === 1) singles.push(ty);
    }

    // Order matters for the 7-slot limit: completing pairs frees slots fastest,
    // so do those first, then singles. Following this sequence keeps the tray at
    // ≤7 as long as the deck isn't 6 lone singletons (an already-lost state the
    // board can't rescue without touching the deck — then we just fall back to a
    // self-contained board so the reshuffle is still a fresh, valid board).
    const feasible = singles.length <= 5;
    const typeSeq = [];
    if (feasible) {
      for (const ty of pairs) typeSeq.push(ty);
      for (const ty of singles) typeSeq.push(ty, ty);
    }
    // Remaining board tiles become fresh triples (one type each, palette variety
    // first). This never breaks solvability — each triple is self-contained.
    const numFresh = Math.floor((B - typeSeq.length) / 3);
    const freshTypes = [];
    for (let g = 0; g < numFresh; g++) {
      freshTypes.push(g < numTypes ? g : Math.floor(Math.random() * numTypes));
    }
    for (let i = freshTypes.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [freshTypes[i], freshTypes[j]] = [freshTypes[j], freshTypes[i]];
    }
    for (const ty of freshTypes) typeSeq.push(ty, ty, ty);
    // Guard: only trips if the active count isn't a multiple of 3 (a valid board
    // never is) — keep any tail tiles matchable rather than stranded.
    while (typeSeq.length < B) typeSeq.push(typeSeq[typeSeq.length - 1] ?? 0);

    for (let i = 0; i < B; i++) {
      const tile = order[i];
      tile.type = typeSeq[i];
      tile.sprite.texture = this.tileTextures[tile.type];
    }

    // Publish the new known-good clearing order (board tiles only — the leading
    // ones complete the deck's open groups). Used by solveTap / tests.
    this.solutionOrder = order.map((t) => t.id);
    this._refreshFreeStates();
    this._updateProgress();
  }

  // A fresh valid removal order (a linear extension of the covering DAG) over
  // the given board tiles, honouring their live coverage. Types are independent
  // of coverage, so any type can later be assigned to any position in this order.
  _boardRemovalOrder(boardTiles) {
    const present = new Set(boardTiles.map((t) => t.id));
    const remaining = new Map();
    for (const t of boardTiles) {
      let c = 0;
      for (const cid of t.coverers) if (present.has(cid)) c++;
      remaining.set(t.id, c);
    }
    const free = boardTiles.filter((t) => remaining.get(t.id) === 0);
    const order = [];
    const done = new Set();
    while (order.length < boardTiles.length && free.length) {
      const k = Math.floor(Math.random() * free.length);
      const t = free[k];
      free[k] = free[free.length - 1];
      free.pop();
      done.add(t.id);
      order.push(t);
      for (const belowId of t.covered) {
        if (!present.has(belowId) || done.has(belowId)) continue;
        const r = remaining.get(belowId) - 1;
        remaining.set(belowId, r);
        if (r === 0) free.push(this.tiles[belowId]);
      }
    }
    return order;
  }

  // ---- outcomes ------------------------------------------------------------

  _win() {
    this.locked = true;
    this.audio.play("win");
    const last = this.levelNum >= 3;
    this._showOverlay(
      last ? "🏆 You Win!" : "Level Complete!",
      last ? "You cleared levels 1–3" : "Great matching!",
      "Continue",
      // hand control back to the lobby, which advances to the next level
      () => this.onLevelComplete && this.onLevelComplete(this.levelNum)
    );
  }

  _lose() {
    this.locked = true;
    this.audio.play("fail");
    this._showOverlay("Board Full!", "No moves left", "Try Again", () => this.restart());
  }

  _showOverlay(title, subtitle, btnLabel, onBtn) {
    this.overlayLayer.removeChildren();
    const dim = new PIXI.Graphics();
    dim.beginFill(0x040814, 0.62).drawRect(0, 0, DESIGN_W, DESIGN_H).endFill();
    dim.eventMode = "static";
    this.overlayLayer.addChild(dim);

    const panel = new PIXI.Graphics();
    panel.beginFill(0x22335e, 1).drawRoundedRect(95, 500, 560, 360, 34).endFill();
    panel.lineStyle(6, 0xffffff, 0.15).drawRoundedRect(95, 500, 560, 360, 34);
    this.overlayLayer.addChild(panel);

    const tt = new PIXI.Text(title, {
      fontFamily: "Arial", fontSize: 56, fontWeight: "900", fill: 0xffe27a,
      stroke: 0x5a3a00, strokeThickness: 6,
    });
    tt.anchor.set(0.5); tt.position.set(DESIGN_W / 2, 590);
    const st = new PIXI.Text(subtitle, {
      fontFamily: "Arial", fontSize: 30, fill: 0xd7e2ff,
    });
    st.anchor.set(0.5); st.position.set(DESIGN_W / 2, 660);
    this.overlayLayer.addChild(tt, st);

    const btn = this._makeButton(btnLabel, 320, 92, DESIGN_W / 2, 780, 0x39c06a, () => {
      this.overlayLayer.removeChildren();
      onBtn();
    });
    this.overlayLayer.addChild(btn);

    tt.scale.set(0.2);
    tween(this.app.ticker, {
      duration: 420, ease: easeOutBack,
      onUpdate: (e) => tt.scale.set(0.2 + 0.8 * e),
    });
  }

  // ---- micro-animations ----------------------------------------------------

  _animateTo(cont, x, y, dur = 220, ease = easeOutCubic) {
    if (cont.__mv) this.app.ticker.remove(cont.__mv);
    const sx = cont.x, sy = cont.y;
    let el = 0;
    const fn = () => {
      el += this.app.ticker.deltaMS;
      const t = Math.min(1, el / dur);
      const e = ease(t);
      cont.x = sx + (x - sx) * e;
      cont.y = sy + (y - sy) * e;
      if (t >= 1) { this.app.ticker.remove(fn); cont.__mv = null; }
    };
    cont.__mv = fn;
    this.app.ticker.add(fn);
  }

  _animateScale(cont, target, dur = 200) {
    if (cont.__sc) this.app.ticker.remove(cont.__sc);
    const s0 = cont.scale.x;
    let el = 0;
    const fn = () => {
      el += this.app.ticker.deltaMS;
      const t = Math.min(1, el / dur);
      const e = easeOutCubic(t);
      cont.scale.set(s0 + (target - s0) * e);
      if (t >= 1) { this.app.ticker.remove(fn); cont.__sc = null; }
    };
    cont.__sc = fn;
    this.app.ticker.add(fn);
  }

  _popMatch(cont) {
    if (cont.__mv) this.app.ticker.remove(cont.__mv);
    let el = 0;
    const s0 = cont.scale.x;
    const fn = () => {
      el += this.app.ticker.deltaMS;
      const t = Math.min(1, el / 260);
      cont.scale.set(s0 * (1 + 0.35 * Math.sin(Math.min(1, t * 1.6) * Math.PI)));
      cont.alpha = 1 - t;
      if (t >= 1) { this.app.ticker.remove(fn); cont.destroy(); }
    };
    this.app.ticker.add(fn);
  }

  _shake(cont) {
    const x0 = cont.x;
    let el = 0;
    const fn = () => {
      el += this.app.ticker.deltaMS;
      const t = Math.min(1, el / 260);
      cont.x = x0 + Math.sin(t * Math.PI * 6) * 6 * (1 - t);
      if (t >= 1) { this.app.ticker.remove(fn); cont.x = x0; }
    };
    this.app.ticker.add(fn);
  }
}
