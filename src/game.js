import { parseLevel, computeCoverers, assignSolvableTypes, mulberry32 } from "./level.js";
import { easeOutCubic, easeOutBack, easeInOutQuad, tween, delay } from "./tween.js";
import { makeCogButton } from "./settings.js";
import { makeCoinPill, makeCoinIcon } from "./shop.js";
import { typesForLevel } from "./levelConfig.js";
import { coverBackground } from "./layout.js";

const DESIGN_W = 750;
const DESIGN_H = 1334;

// Coins awarded for completing a level — the free source of coins that seeds the
// shop economy (packs are the paid source). A plain const, trivially tunable.
const COIN_WIN_REWARD = 25;

const CELL = 88;          // tile footprint in board units (px at scale 1)
const TILE_DRAW = 96;     // drawn tile size (slightly larger than cell for overlap)
const LIFT = 7;           // per-layer vertical lift for the 3D-stack look
const TRAY_SLOTS = 7;
const SLOT = 84;          // default tray slot size, before a level sizes it to fit
const SLOT_GAP = 6;       // horizontal gap between tray slots
const SLOT_PAD = 18;      // padding between the slot row and the tray panel edge
const SLOT_MARGIN = 24;   // min gap from the tray panel to the 750-wide safe band edge
const SLOT_MIN = 56;      // floor so a very dense level's tray tiles stay tappable
// Largest slot that keeps the 7-slot tray (with its gaps + panel padding + margin)
// inside the 750-wide safe band. Used to clamp the per-level slot size below.
const SLOT_MAX =
  (DESIGN_W - 2 * SLOT_MARGIN - 2 * SLOT_PAD - (TRAY_SLOTS - 1) * SLOT_GAP) / TRAY_SLOTS;

const BOARD_AREA = { x: 375, top: 250, bottom: 1030 };
const TRAY_Y = 1140;

export class GameScene extends PIXI.Container {
  constructor(app, tileTextures, slotTexture, backgrounds, audio, user, prices) {
    super();
    this.app = app;
    this.tileTextures = tileTextures;
    this.slotTexture = slotTexture;
    this.backgrounds = backgrounds; // { 1: tex, 2: tex, 3: tex }
    this.audio = audio;
    this.user = user; // player profile — the helper (booster) inventory lives here
    // Coin prices for buying a helper when its stock hits 0 (from the JSON config;
    // see prices.json / main.js). A keyed map: helper code -> coin cost.
    this.boosterPrices = (prices && prices.boosters) || {};
    // Coin price to CONTINUE a lost round (tray full): return every collected tile
    // to the board and keep playing. Tunable via the same JSON config (prices.json,
    // "continue" key). null when unconfigured — Continue then always falls back to
    // the free rewarded-ad tier.
    this.continuePrice = (prices && typeof prices.continue === "number") ? prices.continue : null;

    this.bgLayer = new PIXI.Container();
    this.boardLayer = new PIXI.Container();
    this.trayLayer = new PIXI.Container();
    this.fxLayer = new PIXI.Container();
    this.hudLayer = new PIXI.Container();
    this.overlayLayer = new PIXI.Container();
    this.addChild(this.bgLayer, this.boardLayer, this.trayLayer, this.fxLayer, this.hudLayer, this.overlayLayer);

    // Responsive layout state (updated by layout()); defaults to the base design
    // so the scene is correct even before the first layout() call.
    this.viewW = DESIGN_W; this.viewH = DESIGN_H;
    this.ox = 0; this.oy = 0;         // safe-area offsets: horizontal band, bottom anchor
    this.boardTop = BOARD_AREA.top;
    this.boardBottom = BOARD_AREA.bottom;
    this.boardCX = DESIGN_W / 2;
    this.boardCY = (BOARD_AREA.top + BOARD_AREA.bottom) / 2;

    // The HUD splits into a top band (anchored to the top edge) and a bottom band
    // (anchored to the bottom edge); the tray group is bottom-anchored too. Each
    // band keeps its original 0..750 coords and is centred in a 750-wide safe area
    // by layout(), so nothing is ever cropped and the extra space becomes margin.
    this.hudTop = new PIXI.Container();
    this.hudBottom = new PIXI.Container();
    this.hudLayer.addChild(this.hudTop, this.hudBottom);
    this.trayGroup = new PIXI.Container();
    this.trayLayer.addChild(this.trayGroup);

    this.tiles = [];
    this.tray = [];
    this.history = [];      // collected tile refs, newest last (for undo)
    this.boardCount = 0;
    this.levelNum = 1;
    this.locked = false;    // blocks input during win/lose transitions
    this._autoRunning = false; // true while the Auto Complete sweep animates
    this._loseBtns = null;  // { cont, home, replay } while the Out-of-Moves overlay is up
    this.onLevelComplete = null; // (levelNum) => void — set by the host (main.js)
    this.onSettings = null;      // () => void — open the settings screen
    this.onShop = null;          // () => void — open the shop screen
    this.onExit = null;          // () => void — leave the level, back to the lobby

    this.slot = SLOT; // current tray slot size; sized per-level by _layoutBoard
    this._buildHud();
    this._buildTraySlots();
    // Keep the helper buttons in sync when the inventory changes elsewhere (e.g. a
    // reward grant), not just when we spend one during a level — and when the coin
    // wallet changes, since that flips whether an empty helper is affordable to buy.
    if (this.user) this.user.on((domain) => {
      if (domain === "boosters" || domain === "wallet") this._updateBoosters();
    });
    this._updateBoosters();
  }

  // Reflect the helper (booster) inventory on the HUD: each helper shows its
  // remaining-uses count in a bubble, and is disabled (greyed-out, ignores taps)
  // when the player has none left — or, for Undo, when there's nothing to undo.
  _updateBoosters() {
    // The Auto Complete sweep owns the HUD row while it runs — leave it alone.
    if (this._autoRunning) return;
    // When the endgame is trivially solvable, Auto Complete REPLACES the three
    // helpers in the row: hide them (buttons + badges) and show the wide button.
    const avail = this._autoAvailable();
    this.autoBtn.visible = avail;
    for (const n of [this.shuffleBtn, this.wandBtn, this.undoBtn,
      this.shuffleBadge, this.wandBadge, this.undoBadge]) n.visible = !avail;
    if (avail) return; // helpers hidden — skip the per-helper refresh below
                       // (it would otherwise force each badge back to visible)

    const undoLeft = this.user ? this.user.boosterCount("undo") : 0;
    const shuffleLeft = this.user ? this.user.boosterCount("shuffle") : 0;
    const wandLeft = this.user ? this.user.boosterCount("wand") : 0;
    // Each helper is usable when its *context* allows a move (a tile to undo, a
    // board to shuffle/wand). At 0 stock the button doesn't just disable — while a
    // move exists it stays live and the acquisition ladder (buy with coins, else
    // watch an ad) supplies a use on tap (see _setBoosterButton / _acquireBooster).
    this._setBoosterButton(this.undoBtn, this.undoBadge, "undo", undoLeft, this.history.length > 0);
    this._setBoosterButton(this.shuffleBtn, this.shuffleBadge, "shuffle", shuffleLeft, this.boardCount > 0);
    // Wand completes one triple from the board, so it needs at least one tile still
    // on the board to have anything to bring in.
    this._setBoosterButton(this.wandBtn, this.wandBadge, "wand", wandLeft, this.boardCount > 0);
  }

  // Coin price to buy one use of a helper when its stock is empty (null if the
  // config has no price for it — then it simply can't be bought in-level).
  _boosterPrice(kind) {
    const p = this.boosterPrices[kind];
    return typeof p === "number" ? p : null;
  }

  // Buy one use of a helper with coins (used only when the inventory is empty).
  // Debits the wallet and grants one; returns false (spending nothing) if there's
  // no configured price or the player can't afford it.
  _buyBooster(kind) {
    const price = this._boosterPrice(kind);
    if (price == null || !this.user) return false;
    if (!this.user.debit("coins", price)) return false; // can't afford -> no change
    this.user.grantBooster(kind, 1);
    return true;
  }

  // Rewarded-ad fallback: when a helper is empty AND the player can't afford to buy
  // one, they can "watch an ad" for a free use. No ad network is wired up yet, so
  // this stub grants the reward immediately.
  // TODO(SDK): show a real rewarded ad and only grant on a completed view
  //   (FBInstant.getRewardedVideoAsync / Telegram / Devvit ad units).
  _watchAd(kind) {
    if (!this.user) return false;
    this.user.grantBooster(kind, 1);
    return true;
  }

  // Get one use of a helper to spend, walking the acquisition ladder: draw from the
  // inventory; else buy one with coins; else watch a (rewarded) ad. Grants-then-uses
  // in a single tap, so the net inventory change is 0 on the buy/ad tiers. Returns
  // false only if there's no user (callers then stay a clean no-op).
  _acquireBooster(kind) {
    if (!this.user) return false;
    if (this.user.useBooster(kind)) return true;               // had stock
    if (this._buyBooster(kind)) return this.user.useBooster(kind); // paid with coins
    if (this._watchAd(kind)) return this.user.useBooster(kind);    // watched an ad
    return false;
  }

  // Auto Complete becomes available only in a trivially-solvable endgame: a small
  // number of tiles left (≤ 4 easy triples) with NONE still covered, so every
  // remaining tile is directly reachable. The remaining count is always a
  // multiple of 3 (each clear removes exactly 3), so this can never grant a win
  // over a genuinely unmatchable leftover.
  _autoAvailable() {
    return !this.locked && this.boardCount > 0
      && (this.boardCount + this.tray.length) <= 12
      && !this.tiles.some((t) => !t.inTray && !t.matched && t.aliveCovers > 0);
  }

  // Reflect one helper's state on its button + badge. `contextOk` is whether a move
  // is possible right now (a tile to undo, a board to shuffle/wand), independent of
  // stock. The badge reflects the three-tier acquisition: OWN one → count; else
  // AFFORD one → coin price; else → "watch an ad". A tap always resolves through
  // that ladder (see _acquireBooster), so the button is live whenever a move is
  // possible; when no move is possible it's greyed and shows the plain stock count.
  _setBoosterButton(btn, badge, kind, count, contextOk) {
    const price = this._boosterPrice(kind);
    const affordable = price != null && !!this.user && this.user.canAfford("coins", price);
    // With no move to make, buying/ads are pointless — show the plain stock count.
    const mode = !contextOk ? "stock" : (count > 0 ? "stock" : (affordable ? "buy" : "ad"));
    btn._boosterMode = mode; // read by tests / for clarity; matches the badge
    btn.eventMode = contextOk ? "static" : "none";
    btn.cursor = contextOk ? "pointer" : "default";
    btn.alpha = contextOk ? 1 : 0.4; // greyed only when there's no move to make
    badge.visible = true;
    badge.setBadge(mode, count, price);
  }

  // ---- responsive layout ---------------------------------------------------

  // Reflow the scene into a DW×DH design area. The host sizes the renderer to the
  // whole viewport and scales the stage so the constraining dimension fills
  // exactly, so DW ≥ 750 and DH ≥ 1334 — the larger dimension just gains extra
  // room. The top HUD stays anchored to the top edge, the tray + helper row
  // anchor to the bottom edge, the board fills the space between, and the
  // background/overlays extend to cover the whole view (no letterbox bars).
  layout(DW, DH) {
    this.viewW = DW; this.viewH = DH;
    this.ox = (DW - DESIGN_W) / 2; // centre the 750-wide safe area
    this.oy = DH - DESIGN_H;       // push the bottom cluster to the bottom edge
    this.hudTop.position.set(this.ox, 0);
    this.hudBottom.position.set(this.ox, this.oy);
    this.trayGroup.position.set(this.ox, this.oy);
    this.boardTop = BOARD_AREA.top;
    this.boardBottom = TRAY_Y + this.oy - 110; // grow the board down toward the tray
    this.boardCX = DW / 2;
    this.boardCY = (this.boardTop + this.boardBottom) / 2;
    if (this.rawArr) {
      this._buildBackground();
      if (this.tiles.length) this._layoutBoard();
    }
    // Reflow an open win/lose overlay to the new centre.
    if (this.overlayLayer.children.length && this._overlayGroup) {
      this._overlayGroup.position.set(DW / 2, DH / 2);
      this._overlayDim.clear();
      this._overlayDim.beginFill(0x040814, 0.62).drawRect(0, 0, DW, DH).endFill();
    }
  }

  // The independent interface controls this scene owns, for the resize/overlap
  // regression test (see window.__game.controls). The helper row reports whichever
  // buttons are currently shown (the three round helpers, or the wide Auto Complete
  // pill that replaces them). `boardLayer` is the live board footprint — it holds
  // only on-board tiles (collected/matched ones are reparented away), so its bounds
  // are the play area. Only currently-visible controls are reported by the caller.
  controls() {
    const list = [
      { name: "levelText", obj: this.levelText },
      { name: "progressText", obj: this.progressText },
      { name: "coinPill", obj: this.coinPill },
      { name: "cog", obj: this.cog },
      { name: "back", obj: this.backBtn },
      { name: "trayPanel", obj: this.trayPanel },
      { name: "board", obj: this.boardLayer },
      { name: "shuffleBtn", obj: this.shuffleBtn },
      { name: "wandBtn", obj: this.wandBtn },
      { name: "undoBtn", obj: this.undoBtn },
      { name: "autoBtn", obj: this.autoBtn },
    ];
    return list;
  }

  // ---- static chrome -------------------------------------------------------

  _buildBackground() {
    this.bgLayer.removeChildren();
    const tex = this.backgrounds[this.levelNum] || this.backgrounds[1];
    if (tex) {
      // cover-fit the whole view so the background reaches every screen edge
      const sp = coverBackground(new PIXI.Sprite(tex), this.viewW, this.viewH);
      this.bgLayer.addChild(sp);
    }
    const dark = new PIXI.Graphics();
    dark.beginFill(0x0a1226, 0.34).drawRect(0, 0, this.viewW, this.viewH).endFill();
    this.bgLayer.addChild(dark);
  }

  _buildHud() {
    // top bar
    const bar = new PIXI.Graphics();
    bar.beginFill(0x0a1226, 0.35).drawRoundedRect(24, 40, DESIGN_W - 48, 120, 28).endFill();
    this.hudTop.addChild(bar);

    this.levelText = new PIXI.Text("LEVEL 1", {
      fontFamily: "Arial", fontSize: 40, fontWeight: "900", fill: 0xffffff,
      stroke: 0x1a2a52, strokeThickness: 6,
    });
    this.levelText.anchor.set(0.5);
    this.levelText.position.set(DESIGN_W / 2, 84);
    this.hudTop.addChild(this.levelText);

    this.progressText = new PIXI.Text("", {
      fontFamily: "Arial", fontSize: 24, fontWeight: "700", fill: 0xcfe0ff,
    });
    this.progressText.anchor.set(0.5);
    this.progressText.position.set(DESIGN_W / 2, 128);
    this.hudTop.addChild(this.progressText);

    // Coin balance pill — top-right of the HUD bar. Tapping it opens the shop.
    this.coinPill = makeCoinPill(this.user, () => this.onShop && this.onShop());
    this.coinPill.position.set(DESIGN_W - 108, 84);
    this.hudTop.addChild(this.coinPill);

    // buttons row — round, icon-only. Placed BELOW the tray panel (whose bottom
    // edge sits at TRAY_Y + slot/2 + SLOT_PAD, at most TRAY_Y + SLOT_MAX/2 + SLOT_PAD)
    // so the two never overlap even at the widest per-level slot size.
    // Helper (booster) buttons. Each carries a count bubble showing how many
    // uses remain in the player's inventory; both are disabled when empty
    // (see _updateBoosters).
    const by = 1266;
    this.shuffleBtn = this._makeRoundButton("🔀", 54, 175, by, 0xff8a3d, () => this.reshuffle());
    this.wandBtn = this._makeRoundButton("🪄", 54, 375, by, 0x9b59f6, () => this.wand());
    this.undoBtn = this._makeRoundButton("⤺", 54, 575, by, 0x4d8dff, () => this.undo());
    this.shuffleBadge = this._makeCountBadge(175 + 38, by - 38);
    this.wandBadge = this._makeCountBadge(375 + 38, by - 38);
    this.undoBadge = this._makeCountBadge(575 + 38, by - 38);
    this.hudBottom.addChild(this.shuffleBtn, this.wandBtn, this.undoBtn,
      this.shuffleBadge, this.wandBadge, this.undoBadge);

    // Auto Complete — a wide pill sharing the helper baseline, centred over the
    // three round buttons. Hidden until the endgame is trivially solvable, when
    // it REPLACES the helpers (see _updateBoosters / _autoAvailable).
    this.autoBtn = this._makeButton("✓ Auto Complete", 460, 92, DESIGN_W / 2, by, 0x39c06a,
      () => this.autoComplete());
    this.autoBtn.visible = false;
    this.hudBottom.addChild(this.autoBtn);

    // Settings (cog) — top-left. Opens the settings screen via the host.
    const cog = makeCogButton(this.audio, () => this.onSettings && this.onSettings());
    cog.position.set(60, 84);
    this.hudTop.addChild(cog);
    this.cog = cog;

    // Back — sits next to the cog. Stops the level and returns to the lobby;
    // any user-record changes made during the level are left intact (persisted).
    this.backBtn = this._makeRoundButton("‹", 38, 148, 84, 0x334063, () => this.onExit && this.onExit());
    this.hudTop.addChild(this.backBtn);
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

  // A small badge pinned to a button's top-right corner. setBadge(mode, count,
  // price) gives it one of three looks matching the helper's acquisition tier:
  //  • "stock" — a round bubble with the remaining-uses count (green when stocked,
  //     muted grey at 0). Shown whenever the player owns ≥1 (or a move isn't
  //     possible, so buying/ads would be pointless).
  //  • "buy"   — out of stock but the player can afford one: a gold coin + the coin
  //     price, so a tap reads as "buy one for N coins".
  //  • "ad"    — out of stock AND can't afford one: a "watch an ad" icon (a free
  //     use via a rewarded ad). No ad network is wired up yet — it's just the icon.
  //  (Named setBadge, NOT render — DisplayObject.render is PIXI's per-frame draw
  //   hook and must not be shadowed.)
  _makeCountBadge(cx, cy) {
    const c = new PIXI.Container();
    c.position.set(cx, cy);
    c.eventMode = "none"; // decorative — never intercepts taps meant for the button
    const g = new PIXI.Graphics();
    const coin = makeCoinIcon(11);
    const ad = new PIXI.Text("📺", { fontFamily: "Arial", fontSize: 22 });
    ad.anchor.set(0.5);
    const t = new PIXI.Text("0", {
      fontFamily: "Arial", fontSize: 26, fontWeight: "900", fill: 0xffffff,
      stroke: 0x14361f, strokeThickness: 4,
    });
    t.anchor.set(0.5);
    c.addChild(g, coin, ad, t);
    c.text = t;
    c.setBadge = (mode, count, price) => {
      g.clear();
      coin.visible = false;
      ad.visible = false;
      if (mode === "buy") {
        // Buy tag: gold coin on the left, price to its right, in an orange pill
        // that hugs the button's top-right corner (right edge near the corner).
        t.text = String(price);
        t.style.fontSize = 22;
        coin.visible = true;
        const h = 34, padL = 26, padR = 14;
        const w = padL + t.width + padR, left = 14 - w;
        g.beginFill(0xff8a3d).drawRoundedRect(left, -h / 2, w, h, h / 2).endFill();
        g.lineStyle(3, 0xffffff, 0.9).drawRoundedRect(left, -h / 2, w, h, h / 2);
        coin.position.set(left + 15, 0);
        t.position.set(coin.position.x + 11 + t.width / 2, 0);
      } else if (mode === "ad") {
        // "Watch an ad" bubble — a play/TV glyph in a blue bubble.
        t.text = "";
        ad.visible = true;
        const r = 20;
        g.beginFill(0x4d8dff).drawCircle(0, 0, r).endFill();
        g.lineStyle(3, 0xffffff, 0.9).drawCircle(0, 0, r);
      } else {
        // Stock bubble: remaining count, grey at 0 to signal an empty stock.
        t.text = String(count);
        t.style.fontSize = 26;
        t.position.set(0, 0);
        const r = 20;
        g.beginFill(count === 0 ? 0x8a93ab : 0x2ecc71).drawCircle(0, 0, r).endFill();
        g.lineStyle(3, 0xffffff, 0.9).drawCircle(0, 0, r);
      }
    };
    c.setBadge("stock", 0, null);
    return c;
  }

  _buildTraySlots() {
    // The panel + slot sprites are (re)drawn by _layoutTraySlots() whenever the
    // per-level slot size changes; create the containers once, in back-to-front
    // order (panel behind slots), then let the reflow fill them in.
    this.trayPanel = new PIXI.Graphics();
    this.slotContainer = new PIXI.Container();
    this.trayGroup.addChild(this.trayPanel, this.slotContainer);
    this._layoutTraySlots();
  }

  // (Re)build the tray panel + slot sprites at the current slot size (this.slot).
  // Keeps the row centred in the 750-wide safe band; collected tiles (added to
  // trayGroup on top of these) are untouched and re-placed by _layoutTray().
  _layoutTraySlots() {
    const SZ = this.slot;
    const totalW = TRAY_SLOTS * SZ + (TRAY_SLOTS - 1) * SLOT_GAP;
    const startX = DESIGN_W / 2 - totalW / 2 + SZ / 2;
    this.slotPositions = [];
    this.trayPanel.clear();
    this.trayPanel.beginFill(0x0a1226, 0.4)
      .drawRoundedRect(DESIGN_W / 2 - totalW / 2 - SLOT_PAD, TRAY_Y - SZ / 2 - SLOT_PAD,
        totalW + 2 * SLOT_PAD, SZ + 2 * SLOT_PAD, 26)
      .endFill();
    this.slotContainer.removeChildren();
    for (let i = 0; i < TRAY_SLOTS; i++) {
      const x = startX + i * (SZ + SLOT_GAP);
      this.slotPositions.push({ x, y: TRAY_Y });
      const s = new PIXI.Sprite(this.slotTexture);
      s.anchor.set(0.5);
      s.width = s.height = SZ;
      s.position.set(x, TRAY_Y);
      this.slotContainer.addChild(s);
    }
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
    this._autoRunning = false; // clear in case a prior level ended via Auto Complete
    this._loseBtns = null;     // drop any stale Out-of-Moves overlay refs

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
    const areaW = this.viewW - 60; // fill the full available width, not a fixed band
    const areaH = this.boardBottom - this.boardTop;
    this.boardScale = Math.min(areaW / spanX, areaH / spanY); // no cap: grow to fill
    const s = this.boardScale;

    // Size the bottom tray to the current level's on-screen tile size: a board
    // tile is drawn at TILE_DRAW * boardScale, so match that so a collected tile
    // keeps its size as it flies into the tray. Clamp to [SLOT_MIN, SLOT_MAX] so
    // the 7-slot tray always fits the safe band (dense boards, whose tiles are
    // small, shrink the tray to match; roomy boards cap it at the widest that fits).
    const slot = Math.max(SLOT_MIN, Math.min(SLOT_MAX, TILE_DRAW * s));
    if (slot !== this.slot) {
      this.slot = slot;
      this._layoutTraySlots();
      if (this.tray.length) this._layoutTray();
    }

    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    this.boardCX = this.viewW / 2;
    this.boardCY = (this.boardTop + this.boardBottom) / 2;

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
    this.trayGroup.addChild(t.container);
    const local = this.trayGroup.toLocal(gp);
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
      // Normal play never exceeds TRAY_SLOTS, but the Wand can momentarily bring
      // the tray over capacity before the completed triple clears in the same
      // beat — clamp to the last slot so we never index past slotPositions.
      const pos = this.slotPositions[Math.min(i, TRAY_SLOTS - 1)];
      this._animateTo(t.container, pos.x, pos.y, 200, easeOutCubic);
      this._animateScale(t.container, this.slot / TILE_DRAW, 200);
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

  // Return one collected tile from the tray back to the board: restore its board
  // state (inTray/coverage/boardCount), remove it from the tray + history, and
  // reparent it. Cancels any in-flight tray-slide tween FIRST — if the tile was
  // collected moments ago, its _layoutTray slide (container.__mv) is still running
  // and would keep lerping it toward its old tray slot after we reparent, dropping
  // it at a wrong spot instead of its home cell (the "undo returns a tile to a
  // random position" bug). Does NOT re-lay-out the board/tray or refresh states —
  // the caller batches that once (Undo returns one tile; Continue returns them
  // all). Returns false if the tile isn't in the tray.
  _returnTileToBoard(t) {
    const idx = this.tray.indexOf(t);
    if (idx < 0) return false;
    this.tray.splice(idx, 1);
    const h = this.history.indexOf(t);
    if (h >= 0) this.history.splice(h, 1);
    t.inTray = false;
    this.boardCount++;
    // restore coverage on tiles beneath
    for (const belowId of t.covered) {
      const b = this.tiles[belowId];
      if (!b.inTray && !b.matched) b.aliveCovers++;
    }
    const cont = t.container;
    if (cont.__mv) { this.app.ticker.remove(cont.__mv); cont.__mv = null; }
    this.trayGroup.removeChild(cont);
    this.boardLayer.addChild(cont);
    cont.eventMode = "static";
    return true;
  }

  undo() {
    if (this.locked) return;
    if (this.history.length === 0) return;      // nothing to undo
    // Undo is a helper: get one to spend via the acquisition ladder (own → buy with
    // coins → watch an ad), then use it. See _acquireBooster.
    if (!this._acquireBooster("undo")) return;
    // Send the most-recently-added tile home (also drops it from history).
    const t = this.history[this.history.length - 1];
    if (!t || !this._returnTileToBoard(t)) return;
    // _layoutBoard snaps the tile to its ORIGINAL cell — homeX/homeY are recomputed
    // from its immutable grid coords (gx/gy) — and lays out the other board tiles.
    this._layoutBoard();
    this._animateScale(t.container, t.homeScale, 1);
    this._refreshFreeStates();
    this._layoutTray();
    this._updateProgress();
    this._updateBoosters();
  }

  // Return EVERY collected tile from the tray to its original board cell, ANIMATED:
  // the tiles fly back one at a time in REVERSE placement order (newest first),
  // exactly as a rapid run of Undos would pop them off the top of the stack. Used by
  // Continue-after-loss to reset the tray so the player can keep going. Input stays
  // locked for the whole sweep so a tile can't be tapped mid-flight; it unlocks when
  // the last tile lands.
  async _returnTrayToBoard() {
    this.locked = true;
    const ticker = this.app.ticker;

    // Restore each tile's board state UP FRONT (synchronously) so boardCount,
    // coverage, and the (now empty) tray are immediately correct; capture the
    // tray-slot position to animate from. Walk history newest-first (reverse
    // placement order); the trailing tray sweep is a safety net for any tile not
    // tracked there (never expected).
    const returning = [];
    for (const t of [...this.history.slice().reverse(), ...this.tray.slice()]) {
      if (this.tray.indexOf(t) < 0) continue; // already handled (dedup) / not in tray
      const cont = t.container;
      if (cont.__mv) { ticker.remove(cont.__mv); cont.__mv = null; }
      if (cont.__sc) { ticker.remove(cont.__sc); cont.__sc = null; }
      const gp = cont.getGlobalPosition();       // its current on-screen (tray) spot
      const ss = cont.scale.x;
      this._returnTileToBoard(t);                // restore state + reparent to board
      const start = this.boardLayer.toLocal(gp); // same spot, in board space
      cont.position.set(start.x, start.y);
      cont.scale.set(ss);
      returning.push({ t, cont, sx: start.x, sy: start.y, ss });
    }
    // Record the fly-back order (tile ids, newest-first) for tests/debug.
    this._lastReturnOrder = returning.map((r) => r.t.id);

    // _layoutBoard computes each tile's home cell (homeX/homeY/homeScale) and snaps
    // everything there; re-seat the animating tiles back at their tray slot so they
    // FLY home instead of teleporting.
    this._layoutBoard();
    for (const r of returning) {
      r.hx = r.t.homeX; r.hy = r.t.homeY; r.hs = r.t.homeScale;
      r.cont.position.set(r.sx, r.sy);
      r.cont.scale.set(r.ss);
    }
    this._refreshFreeStates();
    this._updateProgress();
    this._layoutTray();
    this._updateBoosters();

    // Fly each tile from its tray slot to its home cell, staggered oldest-first.
    if (returning.length) this.audio.play("tile_bop");
    await Promise.all(returning.map(async (r, i) => {
      await delay(ticker, i * 110);
      const sx = r.cont.x, sy = r.cont.y, ss = r.cont.scale.x;
      await tween(ticker, {
        duration: 300, ease: easeOutCubic,
        onUpdate: (e) => {
          if (r.cont.destroyed) return;
          r.cont.x = sx + (r.hx - sx) * e;
          r.cont.y = sy + (r.hy - sy) * e;
          r.cont.scale.set(ss + (r.hs - ss) * e);
        },
      });
    }));

    // Land: snap to the exact home cells, refresh interactivity, resume play.
    this._layoutBoard();
    this._refreshFreeStates();
    this.locked = false;
  }

  // The Wand ("hint") helper: guarantee one instant match. It completes a triple
  // using AVAILABLE (free, top-layer, tappable) tiles wherever possible, only
  // reaching into UNAVAILABLE (greyed-out, still-covered) tiles when a colour
  // hasn't enough free tiles to finish — see _wandPick for the waterfall. It
  // flies the missing tiles from the board into the tray and lets them resolve
  // and clear — freeing tray space. A consumable like the other helpers: one
  // charge per use, disabled at zero. (The upgraded "super" wand that clears
  // several sets shares this button but is out of scope here.)
  wand() {
    if (this.locked) return;                       // won/lost, or a wand animation in flight
    if (!this.user) return;
    // Check there's a move to make BEFORE spending/buying, so we never charge for a
    // no-op (an empty board, etc.). _wandPick() is a pure read.
    const pick = this._wandPick();
    if (!pick || pick.tiles.length === 0) return;  // nothing to bring in -> don't spend a charge
    // Get a charge to spend via the acquisition ladder (own → buy → ad), then use it.
    if (!this._acquireBooster("wand")) return;

    // Lock out further input (incl. a second wand tap) until the tiles land and
    // the triple resolves, so a rapid double-tap can't spend two charges.
    this.locked = true;
    for (const t of pick.tiles) {
      t.inTray = true;
      this.boardCount--;
      // free up tiles beneath, exactly as a manual collect would
      for (const belowId of t.covered) {
        const b = this.tiles[belowId];
        if (!b.inTray && !b.matched) b.aliveCovers = Math.max(0, b.aliveCovers - 1);
      }
      // reparent to the tray keeping world position, then group with its kind
      const gp = t.container.getGlobalPosition();
      this.boardLayer.removeChild(t.container);
      this.trayGroup.addChild(t.container);
      const local = this.trayGroup.toLocal(gp);
      t.container.position.set(local.x, local.y);
      t.sprite.tint = 0xffffff;
      t.container.eventMode = "none";
      let lastMatch = -1;
      for (let i = this.tray.length - 1; i >= 0; i--) {
        if (this.tray[i].type === t.type) { lastMatch = i; break; }
      }
      if (lastMatch >= 0) this.tray.splice(lastMatch + 1, 0, t);
      else this.tray.push(t);
      this.history.push(t);
    }
    this._refreshFreeStates();
    this.audio.play("tile_bop");
    this._layoutTray();
    this._updateProgress();

    // Let the tiles fly in, then unlock and resolve the completed triple.
    setTimeout(() => {
      this.locked = false;
      this._settle();
      this._updateBoosters();
    }, 360);
  }

  // Choose the colour the Wand completes and the board tiles it pulls in.
  //
  // The Wand must prioritise AVAILABLE tiles (free — aliveCovers 0 — on the top,
  // tappable layer) and only fall back to UNAVAILABLE tiles (greyed-out, still
  // covered on a lower layer) when a colour hasn't enough free tiles left to
  // finish its triple. So the selection waterfall is, over every colour that can
  // still reach a triple:
  //   1) FEWEST covered tiles used — an all-available completion beats one that
  //      must dip into a covered tile, which beats one needing two, etc. (This is
  //      the core rule: available first, covered only when nothing free is left.)
  //   2) then the CHEAPEST completion — a waiting pair (pull 1, frees 2 slots)
  //      beats a single (pull 2, frees 1) beats a fresh board triple (pull 3,
  //      space-neutral).
  //   3) then a stable tiebreak: tray order (for colours waiting in the tray),
  //      then face id.
  // Within the chosen colour the tiles are drawn most-accessible first (free
  // tiles ahead of covered, then by id) so a pull consumes available tiles
  // before ever touching a covered layer, and the move reads as one the player
  // could have made. Returns null if the board is empty.
  _wandPick() {
    const boardTiles = this.tiles.filter((t) => !t.matched && !t.inTray);
    if (boardTiles.length === 0) return null;

    // tray composition, remembering first-appearance order (for the tiebreak)
    const trayCount = new Map();
    const trayOrder = [];
    for (const t of this.tray) {
      if (!trayCount.has(t.type)) { trayCount.set(t.type, 0); trayOrder.push(t.type); }
      trayCount.set(t.type, trayCount.get(t.type) + 1);
    }
    const trayRank = (ty) => {
      const i = trayOrder.indexOf(ty);
      return i === -1 ? trayOrder.length : i;   // tray colours before fresh ones
    };

    // board tiles grouped by face, each list MOST-ACCESSIBLE first (available
    // tiles — aliveCovers 0 — ahead of covered ones, then by id) so a pull draws
    // free tiles before dipping into covered layers.
    const boardByType = new Map();
    for (const t of boardTiles) {
      if (!boardByType.has(t.type)) boardByType.set(t.type, []);
      boardByType.get(t.type).push(t);
    }
    for (const list of boardByType.values()) {
      list.sort((a, b) => a.aliveCovers - b.aliveCovers || a.id - b.id);
    }

    // Build a completion candidate per colour: how many tiles it still needs to
    // reach a triple (given what's waiting in the tray) and, of those, how many
    // would have to come from COVERED tiles because there aren't enough free ones.
    const candidates = [];
    for (const [ty, list] of boardByType) {
      const trayN = trayCount.get(ty) || 0;    // 0, 1 or 2 (a third would have cleared)
      const need = 3 - trayN;
      if (list.length < need) continue;         // can't finish this colour into a triple
      const freeN = list.filter((t) => t.aliveCovers === 0).length;
      const unavailUsed = Math.max(0, need - freeN);
      candidates.push({ ty, need, unavailUsed });
    }

    let chosen;
    if (candidates.length) {
      candidates.sort((a, b) =>
        a.unavailUsed - b.unavailUsed ||        // 1) prioritise available tiles
        a.need - b.need ||                      // 2) cheapest completion
        trayRank(a.ty) - trayRank(b.ty) ||      // 3) tray order, then face id
        a.ty - b.ty);
      chosen = candidates[0];
    } else {
      // No colour can complete a triple right now (rare — near-empty board).
      // Fall back to the colour with the most free tiles to still make progress.
      let best = null;
      for (const [ty, list] of boardByType) {
        const freeN = list.filter((t) => t.aliveCovers === 0).length;
        if (!best || freeN > best.freeN || (freeN === best.freeN && ty < best.ty)) {
          best = { ty, freeN, list };
        }
      }
      chosen = { ty: best.ty, need: Math.min(best.list.length, 3) };
    }

    return { type: chosen.ty, tiles: boardByType.get(chosen.ty).slice(0, chosen.need) };
  }

  // Auto Complete: sweep every remaining tile into a pile, then fly them one by
  // one along a curved path into the tray's first slot, discarding each on
  // arrival — and win the level. Free (no booster). Only reachable when
  // _autoAvailable() holds (a trivially-solvable endgame). Locks input for the
  // whole sweep so a rapid double-tap can't launch it twice.
  async autoComplete() {
    if (this.locked || this._autoRunning || !this._autoAvailable()) return;
    this.locked = true;
    this._autoRunning = true;

    // The animation owns the HUD row — hide every helper node and the button.
    for (const n of [this.shuffleBtn, this.wandBtn, this.undoBtn,
      this.shuffleBadge, this.wandBadge, this.undoBadge, this.autoBtn]) n.visible = false;

    const ticker = this.app.ticker;
    const remaining = [
      ...this.tiles.filter((t) => !t.inTray && !t.matched), // board
      ...this.tray,                                          // rack
    ];

    // Stage every tile on fxLayer (above board + tray, below the win overlay),
    // keeping its on-screen position, and stop any in-flight tray/board tween so
    // it can't fight the sweep.
    for (const t of remaining) {
      const cont = t.container;
      if (cont.__mv) { ticker.remove(cont.__mv); cont.__mv = null; }
      if (cont.__sc) { ticker.remove(cont.__sc); cont.__sc = null; }
      const gp = cont.getGlobalPosition();
      cont.parent.removeChild(cont);
      this.fxLayer.addChild(cont);
      const local = this.fxLayer.toLocal(gp);
      cont.position.set(local.x, local.y);
      cont.eventMode = "none";
      t.sprite.tint = 0xffffff;
    }

    // Phase A — gather into a loose pile near the board centre.
    const pile = { x: this.boardCX, y: this.boardCY };
    this.audio.play("tile_bop");
    await Promise.all(remaining.map((t, i) => {
      const cont = t.container;
      const sx = cont.x, sy = cont.y, ss = cont.scale.x;
      const jx = ((i % 5) - 2) * 12, jy = (Math.floor(i / 5) - 1) * 12; // small heap jitter
      const tx = pile.x + jx, ty = pile.y + jy, ts = 0.7;
      return tween(ticker, {
        duration: 320, ease: easeOutCubic,
        onUpdate: (e) => {
          cont.x = sx + (tx - sx) * e;
          cont.y = sy + (ty - sy) * e;
          cont.scale.set(ss + (ts - ss) * e);
        },
      });
    }));

    // Phase B — stream tiles one by one along a quadratic Bézier into slot 0.
    // slot 0 lives in the (offset) tray group; project it into fxLayer space.
    const slot0 = this.fxLayer.toLocal(this.trayGroup.toGlobal(this.slotPositions[0]));
    const C = { x: pile.x - 135, y: (pile.y + slot0.y) / 2 - 200 }; // rise then dive
    const endScale = this.slot / TILE_DRAW;
    await Promise.all(remaining.map(async (t, i) => {
      const cont = t.container;
      await delay(ticker, i * 90);         // stagger the launches
      const p0x = cont.x, p0y = cont.y, s0 = cont.scale.x;
      await tween(ticker, {
        duration: 460, ease: easeInOutQuad,
        onUpdate: (e) => {
          const u = 1 - e;
          cont.x = u * u * p0x + 2 * u * e * C.x + e * e * slot0.x;
          cont.y = u * u * p0y + 2 * u * e * C.y + e * e * slot0.y;
          cont.scale.set(s0 + (endScale - s0) * e);
        },
      });
      this._popMatch(cont);                // pulse + fade + destroy = "discarded"
    }));
    await delay(ticker, 260);              // let the final pop finish before the overlay

    // Finalize: everything is cleared. Mark tiles matched, empty the tray/history,
    // and declare the win directly (never via _checkEnd, which early-returns on
    // locked and could branch to _lose).
    for (const t of remaining) t.matched = true;
    this.tray = [];
    this.history = [];
    this.boardCount = 0;
    this._autoRunning = false;
    this._updateProgress();
    this._win();
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
    // Reshuffle is a helper: get one to spend via the acquisition ladder (own → buy
    // with coins → watch an ad), then use it. See _acquireBooster.
    if (!this._acquireBooster("shuffle")) return;

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
    // Award coins for clearing the level (the free source that seeds the shop).
    if (this.user) this.user.credit("coins", COIN_WIN_REWARD);
    const last = this.levelNum >= 3;
    this._showOverlay(
      last ? "🏆 You Win!" : "Level Complete!",
      `${last ? "You cleared levels 1–3" : "Great matching!"}  +${COIN_WIN_REWARD}`,
      "Continue",
      // hand control back to the lobby, which advances to the next level
      () => this.onLevelComplete && this.onLevelComplete(this.levelNum),
      COIN_WIN_REWARD // show a gold coin next to the reward
    );
  }

  _lose() {
    this.locked = true;
    this.audio.play("fail");
    this._showLoseOverlay();
  }

  // The "Out of Moves" overlay, shown when the tray fills with no match left (or a
  // rare stranded-deck end). It is strictly MODAL — the full-view dim swallows every
  // tap and there is NO close affordance, so the only ways out are its three
  // buttons:
  //   • Home     → leave to the lobby, progress kept (onExit)
  //   • Replay   → restart this level from scratch
  //   • Continue → PAY to keep playing this very board: return every collected tile
  //                to its origin (mirroring Undo) and resume. It follows the same
  //                waterfall as the helpers — spend coins when the player can afford
  //                the continue price, else watch a rewarded ad (free). The button's
  //                face reflects which tier applies (coin price vs 📺). See
  //                _continueAfterLoss / _makeContinueButton.
  _showLoseOverlay() {
    this.overlayLayer.removeChildren();
    const dim = new PIXI.Graphics();
    dim.beginFill(0x040814, 0.62).drawRect(0, 0, this.viewW, this.viewH).endFill();
    dim.eventMode = "static"; // modal: swallow taps meant for the board/helpers
    this.overlayLayer.addChild(dim);
    this._overlayDim = dim;

    const group = new PIXI.Container();
    group.position.set(this.viewW / 2, this.viewH / 2);
    this.overlayLayer.addChild(group);
    this._overlayGroup = group;

    const panel = new PIXI.Graphics();
    panel.beginFill(0x22335e, 1).drawRoundedRect(-290, -230, 580, 470, 34).endFill();
    panel.lineStyle(6, 0xffffff, 0.15).drawRoundedRect(-290, -230, 580, 470, 34);
    group.addChild(panel);

    const tt = new PIXI.Text("Out of Moves", {
      fontFamily: "Arial", fontSize: 52, fontWeight: "900", fill: 0xffe27a,
      stroke: 0x5a3a00, strokeThickness: 6,
    });
    tt.anchor.set(0.5); tt.position.set(0, -162);
    const stt = new PIXI.Text("The tray is full — keep going?", {
      fontFamily: "Arial", fontSize: 28, fill: 0xd7e2ff,
    });
    stt.anchor.set(0.5); stt.position.set(0, -104);
    group.addChild(tt, stt);

    // Secondary row: Home (lobby) | Replay (restart), above the Continue button.
    const home = this._makeButton("Home", 250, 88, -136, -6, 0x556080, () => {
      this._loseBtns = null;
      this.overlayLayer.removeChildren();
      if (this.onExit) this.onExit();
    });
    const replay = this._makeButton("Replay", 250, 88, 136, -6, 0x4d8dff, () => {
      this._loseBtns = null;
      this.overlayLayer.removeChildren();
      this.restart();
    });
    group.addChild(home, replay);

    // Continue — the primary action, anchored at the BOTTOM of the overlay. Its
    // face reflects the pay waterfall: a coin price when affordable, else a 📺
    // rewarded-ad tag.
    const canPay = this.continuePrice != null && !!this.user
      && this.user.canAfford("coins", this.continuePrice);
    const cont = this._makeContinueButton(canPay, () => this._continueAfterLoss());
    cont.position.set(0, 130);
    group.addChild(cont);
    this._loseBtns = { cont, home, replay };

    tt.scale.set(0.2);
    tween(this.app.ticker, {
      duration: 420, ease: easeOutBack,
      onUpdate: (e) => tt.scale.set(0.2 + 0.8 * e),
    });
  }

  // Build the Continue button for the lose overlay. `canPay` picks the tier the
  // face shows: a gold coin + the continue price ("pay coins") when true, else a
  // 📺 "watch an ad" glyph (a free continue via a rewarded ad). Its `_payMode`
  // ("coins" | "ad") is exposed for tests. Pressing it runs `onClick` either way;
  // _continueAfterLoss re-derives the tier and charges/ads accordingly.
  _makeContinueButton(canPay, onClick) {
    const w = 440, h = 104;
    const c = new PIXI.Container();
    const g = new PIXI.Graphics();
    g.beginFill(0x39c06a).drawRoundedRect(-w / 2, -h / 2, w, h, h / 2.4).endFill();
    g.lineStyle(4, 0xffffff, 0.35).drawRoundedRect(-w / 2, -h / 2, w, h, h / 2.4);
    c.addChild(g);
    const label = new PIXI.Text("Continue", {
      fontFamily: "Arial", fontSize: 34, fontWeight: "800", fill: 0xffffff,
    });
    label.anchor.set(0, 0.5);
    c.addChild(label);
    if (canPay) {
      // [ Continue  🪙 price ] — laid out as one centred unit.
      const coin = makeCoinIcon(17);
      const amt = new PIXI.Text(String(this.continuePrice), {
        fontFamily: "Arial", fontSize: 34, fontWeight: "900", fill: 0xffe27a,
        stroke: 0x5a3a00, strokeThickness: 4,
      });
      amt.anchor.set(0, 0.5);
      const gap1 = 20, gap2 = 8, coinD = 34;
      const total = label.width + gap1 + coinD + gap2 + amt.width;
      label.position.set(-total / 2, 0);
      coin.position.set(-total / 2 + label.width + gap1 + coinD / 2, 0);
      amt.position.set(coin.position.x + coinD / 2 + gap2, 0);
      c.addChild(coin, amt);
    } else {
      // [ Continue  📺 ] — free continue via a rewarded ad.
      const ad = new PIXI.Text("📺", { fontFamily: "Arial", fontSize: 34 });
      ad.anchor.set(0, 0.5);
      const gap = 16;
      const total = label.width + gap + ad.width;
      label.position.set(-total / 2, 0);
      ad.position.set(-total / 2 + label.width + gap, 0);
      c.addChild(ad);
    }
    c._payMode = canPay ? "coins" : "ad";
    c.eventMode = "static";
    c.cursor = "pointer";
    c.on("pointertap", () => { this.audio.play("btn_01"); onClick(); });
    c.on("pointerdown", () => c.scale.set(0.96));
    c.on("pointerup", () => c.scale.set(1));
    c.on("pointerupoutside", () => c.scale.set(1));
    return c;
  }

  // Pay to continue a lost round. Charge the continue price in coins when the
  // player can afford it; otherwise watch a (stubbed) rewarded ad for a free
  // continue — the same waterfall the helpers use. On success, close the overlay,
  // unlock input, and return every collected tile to the board so play resumes.
  // A no-op only if there's no user.
  // TODO(SDK): on the ad tier, show a real rewarded ad and only continue on a
  //   completed view (FBInstant / Telegram / Devvit ad units).
  _continueAfterLoss() {
    if (!this.user) return;
    if (this.continuePrice != null && this.user.canAfford("coins", this.continuePrice)) {
      if (!this.user.debit("coins", this.continuePrice)) return; // lost a race for coins
    }
    // else: can't afford (or no price configured) -> rewarded ad, free continue.
    this._loseBtns = null;
    this.overlayLayer.removeChildren();
    this._overlayGroup = null;
    // _returnTrayToBoard animates the tiles home and owns the lock: it keeps input
    // locked for the whole fly-back and unlocks when the last tile lands.
    this._returnTrayToBoard();
  }

  _showOverlay(title, subtitle, btnLabel, onBtn, coinReward = 0) {
    this._loseBtns = null; // this path is the win overlay — no lose buttons live
    this.overlayLayer.removeChildren();
    // Full-view dim + a centred group whose children are laid out relative to its
    // centre, so the panel stays centred on any screen (and reflows on resize).
    const dim = new PIXI.Graphics();
    dim.beginFill(0x040814, 0.62).drawRect(0, 0, this.viewW, this.viewH).endFill();
    dim.eventMode = "static";
    this.overlayLayer.addChild(dim);
    this._overlayDim = dim;

    const group = new PIXI.Container();
    group.position.set(this.viewW / 2, this.viewH / 2);
    this.overlayLayer.addChild(group);
    this._overlayGroup = group;

    const panel = new PIXI.Graphics();
    panel.beginFill(0x22335e, 1).drawRoundedRect(-280, -180, 560, 360, 34).endFill();
    panel.lineStyle(6, 0xffffff, 0.15).drawRoundedRect(-280, -180, 560, 360, 34);
    group.addChild(panel);

    const tt = new PIXI.Text(title, {
      fontFamily: "Arial", fontSize: 56, fontWeight: "900", fill: 0xffe27a,
      stroke: 0x5a3a00, strokeThickness: 6,
    });
    tt.anchor.set(0.5); tt.position.set(0, -90);
    const st = new PIXI.Text(subtitle, {
      fontFamily: "Arial", fontSize: 30, fill: 0xd7e2ff,
    });
    group.addChild(tt, st);
    if (coinReward) {
      // Lay out "subtitle" + a gold coin icon as a centred unit.
      const icon = makeCoinIcon(16);
      const gap = 12;
      const total = st.width + gap + 32; // 32 = coin diameter
      st.anchor.set(0, 0.5); st.position.set(-total / 2, -20);
      icon.position.set(-total / 2 + st.width + gap + 16, -20);
      group.addChild(icon);
    } else {
      st.anchor.set(0.5); st.position.set(0, -20);
    }

    const btn = this._makeButton(btnLabel, 320, 92, 0, 100, 0x39c06a, () => {
      this.overlayLayer.removeChildren();
      onBtn();
    });
    group.addChild(btn);

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
      // The container can be destroyed mid-tween (e.g. a level reload or a matched
      // triple popping); PIXI nulls its transform, so bail before touching x/y.
      if (cont.destroyed) { this.app.ticker.remove(fn); cont.__mv = null; return; }
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
      // Guard against a destroy mid-tween (transform goes null) — see _animateTo.
      if (cont.destroyed) { this.app.ticker.remove(fn); cont.__sc = null; return; }
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
