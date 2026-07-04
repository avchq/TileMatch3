import { parseLevel, computeCoverers, assignSolvableTypes, mulberry32 } from "./level.js";
import { easeOutCubic, easeOutBack, tween } from "./tween.js";

const DESIGN_W = 750;
const DESIGN_H = 1334;

const CELL = 88;          // tile footprint in board units (px at scale 1)
const TILE_DRAW = 96;     // drawn tile size (slightly larger than cell for overlap)
const LIFT = 7;           // per-layer vertical lift for the 3D-stack look
const TRAY_SLOTS = 7;
const SLOT = 84;

const BOARD_AREA = { x: 375, top: 250, bottom: 1030 };
const TRAY_Y = 1168;

// distinct tile types per level (grows with difficulty)
const TYPES_PER_LEVEL = { 1: 3, 2: 4, 3: 5 };

export class GameScene extends PIXI.Container {
  constructor(app, tileTextures, slotTexture, backgrounds, audio) {
    super();
    this.app = app;
    this.tileTextures = tileTextures;
    this.slotTexture = slotTexture;
    this.backgrounds = backgrounds; // { 1: tex, 2: tex, 3: tex }
    this.audio = audio;

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

    this._buildHud();
    this._buildTraySlots();
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

    // buttons row (bottom of screen)
    const by = 1270;
    this.hudLayer.addChild(this._makeButton("↺ Restart", 200, 74, 150, by, 0xff8a3d, () => this.restart()));
    this.hudLayer.addChild(this._makeButton("⤺ Undo", 200, 74, 600, by, 0x4d8dff, () => this.undo()));

    this.muteBtn = this._makeButton("♪", 74, 74, 690, 84, 0x2f9e6a, () => {
      this.audio.setMuted(!this.audio.muted);
      this.muteBtn.label.text = this.audio.muted ? "✕" : "♪";
    });
    this.hudLayer.addChild(this.muteBtn);
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
    const numTypes = TYPES_PER_LEVEL[levelNum] || 5;
    // seed varies per attempt for fresh boards, but stays solvable by construction
    const seed = (levelNum * 1000 + Math.floor(Math.random() * 100000)) >>> 0;
    assignSolvableTypes(positions, numTypes, mulberry32(seed));
    this.solutionOrder = positions.solutionOrder || [];

    this.tiles = positions.map((p, i) => this._createTile(p, i, coverers[i], covered[i]));
    this.boardCount = this.tiles.length;

    this._layoutBoard();
    this._refreshFreeStates();
    this._updateProgress();
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

    // insert into tray, grouped by type (stable)
    this.tray.push(t);
    this.tray.sort((a, b) => a.type - b.type);
    this.history.push(t);

    this.audio.play("tile_bop");
    this._layoutTray();
    this._updateProgress();

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
    // count per type
    const byType = new Map();
    for (const t of this.tray) {
      if (!byType.has(t.type)) byType.set(t.type, []);
      byType.get(t.type).push(t);
    }
    let matched = false;
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
      }
    }
    if (matched) {
      this.audio.play("merge_click");
      this._layoutTray();
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
  }

  restart() {
    if (this.rawArr) this.loadLevel(this.rawArr, this.levelNum);
  }

  // ---- outcomes ------------------------------------------------------------

  _win() {
    this.locked = true;
    this.audio.play("win");
    const last = this.levelNum >= 3;
    this._showOverlay(
      last ? "🏆 You Win!" : "Level Complete!",
      last ? "You cleared levels 1–3" : "Great matching!",
      last ? "Play Again" : "Next Level",
      () => {
        if (last) this.loadLevel(this.rawArr, this.levelNum);
        else this.onNextLevel && this.onNextLevel(this.levelNum + 1);
      }
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
