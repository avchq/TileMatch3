import { parseLevel, computeCoverers, assignSolvableTypes, mulberry32 } from "./level.js";
import { easeOutCubic, easeOutBack, easeInOutQuad, tween, delay } from "./tween.js";
import { makeCogButton } from "./settings.js";
import { makeCoinPill, makeCoinIcon } from "./shop.js";
import { typesForLevel } from "./levelConfig.js";
import { buildColumnBackground, makeHintPill } from "./layout.js";
import { HowToPlayPopup } from "./tutorial.js";
import { BoosterCoach } from "./boostercoach.js";
import { rewardIsCoins } from "./levelchest.js";
import { CONFIG } from "./config.js";
import { t, itemName } from "./i18n.js";

const DESIGN_W = 750;
const DESIGN_H = 1334;

// ---- Tunables (src/config.js) ---------------------------------------------
// Aliased here so the code below reads the same as it always has; config.js is
// where each of them is explained and where they are edited.
const COIN_WIN_REWARD = CONFIG.economy.coinWinReward;   // coins paid for a win
const AUTO_MIN_LEVEL = CONFIG.progression.autoComplete.minLevel;  // no Auto Complete below this level
const AUTO_MAX_TILES = CONFIG.progression.autoComplete.maxTiles;  // …nor above this many tiles left
const TUTORIAL_LEVEL = CONFIG.progression.tutorialLevel; // level that opens "How To Play" + the guide
const TRAY_SLOTS = CONFIG.board.traySlots;               // BASE tray capacity — fill it with no match and you lose
const EXTRA_SLOT = CONFIG.board.extraSlot;               // the ad-funded 8th slot: { unlockLevel, grant }
const TRAY_WARNINGS = CONFIG.board.warnings;             // free-slot thresholds for the pulse + bubble
const BOOSTER_UNLOCKS = CONFIG.boosters.unlocks;         // helper -> { level, grant }
const COACH = CONFIG.boosters.coach;                     // the guided first use of each helper

// ---- Layout (presentation, deliberately NOT in config.js) ------------------
const CELL = 88;          // tile footprint in board units (px at scale 1)
const TILE_DRAW = 96;     // drawn tile size (slightly larger than cell for overlap)
const LIFT = 7;           // per-layer vertical lift for the 3D-stack look
const SLOT = 84;          // default tray slot size, before a level sizes it to fit
const SLOT_GAP = 6;       // horizontal gap between tray slots
const SLOT_PAD = 18;      // padding between the slot row and the tray panel edge
const SLOT_MARGIN = 24;   // min gap from the tray panel to the 750-wide safe band edge
const SLOT_MIN = 56;      // floor so a very dense level's tray tiles stay tappable
// Largest slot that keeps an n-cell tray (with its gaps + panel padding + margin)
// inside the 750-wide safe band. Used to clamp the per-level slot size below. It
// is a function of the CELL COUNT because the 8th slot changes that count: 90 for
// the base 7-cell row, 78 once the extra cell is drawn — which is how the wider
// row re-centres and still fits the column.
const slotMaxFor = (n) =>
  (DESIGN_W - 2 * SLOT_MARGIN - 2 * SLOT_PAD - (n - 1) * SLOT_GAP) / n;

const BOARD_AREA = { x: 375, top: 250, bottom: 1030 };
const TRAY_Y = 1140;

// Level Chest reward glyphs. Coins/lightning draw a gold coin instead of an
// emoji (see makeCoinIcon), matching how the wheel and daily gift show them.
// The WORDS that go with them are localized — see itemName() in src/i18n.js.
const CHEST_REWARD_EMOJI = { undo: "⤺", wand: "🪄", shuffle: "🔀", lightning: "⚡" };

export class GameScene extends PIXI.Container {
  constructor(app, tileTextures, slotTexture, backgrounds, audio, user, prices, levelChest) {
    super();
    this.app = app;
    this.tileTextures = tileTextures;
    this.slotTexture = slotTexture;
    this.backgrounds = backgrounds; // { 1: tex, 2: tex, 3: tex }
    this.audio = audio;
    this.user = user; // player profile — the helper (booster) inventory lives here
    // The Level Chest schedule (src/levelchest.js) — pure feature LOGIC. The bar,
    // open animation and reward popup on the win overlay are drawn here (game.js);
    // this object just answers "which chest, how full, what reward" for a level.
    this.levelChest = levelChest || null;
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
    // The tutorial popup gets its own layer ABOVE the win/lose overlays — keeping
    // it off overlayLayer leaves "is an overlay up?" meaning the win/lose ones.
    this.tutorialLayer = new PIXI.Container();
    this.addChild(this.bgLayer, this.boardLayer, this.trayLayer, this.fxLayer, this.hudLayer,
      this.overlayLayer, this.tutorialLayer);

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
    // ---- level chest (the win-overlay reward bar) --------------------------
    this._chestDoubleBtn = null; // "📺 Double it!" button, while the reward popup is up
    this._chestClaimBtn = null;  // the plain "Claim" button, while the reward popup is up
    this._chestAdResult = "succeed"; // "succeed" | "cancel" | "fail" (double-it test seam)
    this._chestState = { shown: false }; // snapshot for the debug/test hooks
    this._firstRun = false; // true while a brand-new player is in the guided level 1
    this._hand = null;      // the tutorial pointing hand, when shown
    this._handTile = null;  // the tile it points at (so it can follow a re-layout)
    this._handAnim = null;  // its ticker loop
    this._guideRun = 0;     // generation token: invalidates an in-flight guided opening
    this._tutorial = null;  // the "How To Play" popup, while it is up
    this._boosterHint = null; // the floating "Unlocks at Level N" label, when shown
    // ---- tray capacity (the 8th slot) --------------------------------------
    // Two numbers, deliberately not the same one. `traySlots` is what the tray
    // can HOLD — the loss condition and both warning thresholds are measured
    // against it, and the ad raises it by EXTRA_SLOT.grant for the rest of the
    // level. `traySlotsDrawn` is how many cells are PAINTED, which crosses to 8
    // at the progression gate whether or not the video has been watched: the
    // extra cell appears first, covered by the "+1" offer, and only becomes
    // usable when capacity catches up. Both are re-derived in loadLevel.
    this.traySlots = TRAY_SLOTS;
    this.traySlotsDrawn = TRAY_SLOTS;
    this._extraSlotAdResult = "succeed"; // "succeed" | "cancel" | "fail" (test seam)
    this._trayMessage = null; // the floating tray bubble ("Insufficient space!"), when shown
    this._trayPulse = null;   // the tray-glow ticker loop, while the warning is up
    this._trayWarnFree = Infinity; // free slots at the last check (bubble fires on a crossing)
    this._coach = null;       // the coached first use of a helper, while it is up
    this._coachPending = null; // a helper owed its coaching, waiting for the first collect
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
      // Clearing a level can unlock the shop — light the pill's cart up live
      // rather than waiting for the next loadLevel.
      if (domain === "progress") this._applyFirstRunChrome();
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

  // ---- helper progression (locked in the first levels) ---------------------

  // Is this helper still locked behind the unlock schedule (BOOSTER_UNLOCKS)?
  _isBoosterLocked(kind) {
    return !!this.user && !this.user.isBoosterUnlocked(kind);
  }

  // Refuse a locked helper and say so: a "nope" sound, a shake of the button, and
  // a short floating "Unlocks at Level N" label. Returns true when the press was
  // refused, so every helper entry point can early-out on it — the guard lives in
  // undo()/wand()/reshuffle() rather than the button callback, so a scripted call
  // (window.__game.wand(), scene.undo()) is refused just the same.
  _rejectIfLocked(kind, btn) {
    if (!this._isBoosterLocked(kind)) return false;
    this.audio.play("fail");
    if (btn) this._shake(btn);
    this._showBoosterHint(btn, kind);
    return true;
  }

  // Fade a pill in, hold it, fade it out, then clear it — provided it is still the
  // one the field points at (a later message replaces an earlier one mid-flight).
  _floatPill(c, field) {
    const ticker = this.app.ticker;
    tween(ticker, { duration: 160, onUpdate: (v) => { c.alpha = v; } })
      .then(() => delay(ticker, 1000))
      .then(() => tween(ticker, { duration: 260, onUpdate: (v) => { c.alpha = 1 - v; } }))
      .then(() => { if (this[field] === c) this._clearPill(field); })
      .catch(() => {});
  }

  _clearPill(field) {
    const c = this[field];
    this[field] = null;
    if (c && !c.destroyed) { c.parent && c.parent.removeChild(c); c.destroy({ children: true }); }
  }

  // Float a short "Unlocks at Level N" pill above a locked helper: fades in, holds,
  // fades out. Only one is ever alive — a second tap replaces it.
  _showBoosterHint(btn, kind) {
    this._clearBoosterHint();
    if (!btn || !this.user) return;
    const c = makeHintPill(t("booster_unlock_level", this.user.boosterUnlockLevel(kind)));
    // Above the button, clamped so a hint on an edge helper can't run off the
    // 750-wide safe band (the band, not the view — hudBottom is centred in it).
    const half = c.__w / 2 + 8;
    c.position.set(Math.min(DESIGN_W - half, Math.max(half, btn.x)), btn.y - 96);
    this.hudBottom.addChild(c);
    this._boosterHint = c;
    this._floatPill(c, "_boosterHint");
  }

  _clearBoosterHint() { this._clearPill("_boosterHint"); }

  // Float a message above the TRAY — "Insufficient space!" when the tray is one
  // tile from full, and the "Ad not ready" refusal from the +1 offer. Kept in its
  // own field so it never fights the helper row's hint: the two sit at different
  // heights and either can be up on its own.
  _showTrayMessage(text) {
    this._clearTrayMessage();
    const c = makeHintPill(text);
    const half = c.__w / 2 + 8;
    c.position.set(Math.min(DESIGN_W - half, Math.max(half, DESIGN_W / 2)),
      TRAY_Y - this.slot / 2 - SLOT_PAD - 46);
    this.hudBottom.addChild(c);
    this._trayMessage = c;
    this._floatPill(c, "_trayMessage");
  }

  _clearTrayMessage() { this._clearPill("_trayMessage"); }

  // ---- the 8th tray slot ---------------------------------------------------
  //  An ad-funded, ONE-PER-LEVEL capacity boost, not a booster and not a purchase.
  //  Three separate questions, deliberately kept apart:
  //    drawn     — does the extra CELL exist? A pure progression check.
  //    offered   — is the "+1" button on it? Only while capacity is still base.
  //    takeable  — can it be pressed right now? Only during live play.

  // Is the extra cell drawn at all? Reads CAMPAIGN progress (not the level of the
  // board being played) and is re-asked on every board build, so it appears on the
  // very next level started after the gate is crossed. Nothing is claimed or
  // persisted — the cell simply starts being there.
  _extraSlotDrawn() { return !!this.user && this.user.isExtraSlotUnlocked(); }

  // Is the "+1" offer on the table? The cell must be drawn AND the capacity still
  // at the base value — so the button goes the moment the boost is taken, and
  // there is no way to stack it to 9 slots.
  _extraSlotOffered() { return this._extraSlotDrawn() && this.traySlots === TRAY_SLOTS; }

  // …and can it be TAKEN right now? Only when the player is in a state where they
  // could tap a tile: not while the board is locked (a match resolving, a revive,
  // the end-of-level sequence), not mid Auto Complete sweep, and not behind the
  // tutorial popup, a coached first use or a win/lose overlay.
  _extraSlotTakeable() {
    return this._extraSlotOffered() && !this.locked && !this._autoRunning
      && !this._coach && !this._tutorial && !this.overlayLayer.children.length;
  }

  // The button that covers the extra cell until it is paid for: a slot-sized
  // rounded square carrying the video-ad glyph over "+1". Built once; sized and
  // positioned onto the last cell by _placeExtraSlotButton on every tray reflow.
  _makeExtraSlotButton() {
    const c = new PIXI.Container();
    c.__g = new PIXI.Graphics();
    c.__icon = new PIXI.Text("📺", { fontFamily: "Arial", fontSize: 30 });
    c.__icon.anchor.set(0.5);
    c.__label = new PIXI.Text("+1", {
      fontFamily: "Arial", fontSize: 26, fontWeight: "900", fill: 0xffffff,
    });
    c.__label.anchor.set(0.5);
    c.addChild(c.__g, c.__icon, c.__label);
    c.visible = false;
    c.eventMode = "static";
    c.cursor = "pointer";
    // The tap goes through takeExtraSlot() like the debug hook does, so a scripted
    // call is refused on exactly the same terms as a real press.
    c.on("pointertap", () => { this.audio.play("btn_01"); this.takeExtraSlot(); });
    c.on("pointerdown", () => c.scale.set(0.94));
    c.on("pointerup", () => c.scale.set(1));
    c.on("pointerupoutside", () => c.scale.set(1));
    return c;
  }

  _placeExtraSlotButton() {
    const btn = this.extraBtn;
    if (!btn || btn.destroyed || !this.slotPositions.length) return;
    const pos = this.slotPositions[this.slotPositions.length - 1];
    const SZ = this.slot, r = SZ * 0.24;
    btn.position.set(pos.x, pos.y);
    btn.hitArea = new PIXI.Rectangle(-SZ / 2, -SZ / 2, SZ, SZ);
    btn.__g.clear();
    btn.__g.beginFill(0x4d8dff).drawRoundedRect(-SZ / 2, -SZ / 2, SZ, SZ, r).endFill();
    btn.__g.lineStyle(4, 0xffffff, 0.5).drawRoundedRect(-SZ / 2, -SZ / 2, SZ, SZ, r);
    btn.__icon.style.fontSize = Math.round(SZ * 0.36);
    btn.__icon.position.set(0, -SZ * 0.15);
    btn.__label.style.fontSize = Math.round(SZ * 0.30);
    btn.__label.position.set(0, SZ * 0.24);
    this._updateExtraSlot();
  }

  _updateExtraSlot() {
    if (!this.extraBtn || this.extraBtn.destroyed) return;
    // The Auto Complete sweep owns the bottom of the screen while it runs, the
    // same reason the helper row hides.
    this.extraBtn.visible = this._extraSlotOffered() && !this._autoRunning;
  }

  // Rewarded video for the extra slot. No ad network is wired up yet, so this stub
  // reports whatever the test seam says — matching the wheel's and the daily
  // bonus's three-valued contract rather than the boosters' always-succeed one,
  // because the spec requires a visible "not ready" refusal here.
  // TODO(SDK): show a real rewarded video and resolve on the completed view
  //   (FBInstant.getRewardedVideoAsync / Telegram / Devvit ad units).
  _watchExtraSlotAd() { return this._extraSlotAdResult || "succeed"; }

  // Take the offer: watch the video and, on a completed view, raise the tray's
  // capacity by one for the rest of THIS level. Nothing is charged and nothing is
  // refunded — a cancel leaves the tray as it was, and a failure says so and
  // leaves the offer up for another attempt. Unlike the fail screen's Continue
  // there is no coin alternative: the video is the only route.
  takeExtraSlot() {
    if (!this._extraSlotTakeable()) return false;
    const res = this._watchExtraSlotAd();
    if (res === "fail") {
      this.audio.play("fail");
      this._showTrayMessage(t("ad_not_ready"));
      return false;
    }
    if (res !== "succeed") return false; // cancelled — spend nothing, keep the offer
    this.traySlots = TRAY_SLOTS + EXTRA_SLOT.grant;
    this.audio.play("merge_click");
    this._updateExtraSlot();
    // Both warning thresholds just moved up a tile; re-arm the bubble so a tray
    // sitting on the old threshold doesn't count as having crossed the new one.
    this._trayWarnFree = Infinity;
    this._updateTrayWarning();
    return true;
  }

  // ---- tray pressure warnings ----------------------------------------------

  // Both cues are measured in FREE slots against the LIVE capacity, which is what
  // makes taking the 8th slot shift each of them up by exactly one tile.
  _updateTrayWarning() {
    if (!this.trayGlow || this.trayGlow.destroyed) return;
    const free = Math.max(0, this.traySlots - this.tray.length);
    if (free > 0 && free <= TRAY_WARNINGS.pulseAtFree) this._startTrayPulse();
    else this._stopTrayPulse();
    // The bubble fires on CROSSING the threshold, not while sitting on it — as a
    // state it would pop again on every tap once the tray is pinned there.
    if (free > 0 && free <= TRAY_WARNINGS.bubbleAtFree
      && this._trayWarnFree > TRAY_WARNINGS.bubbleAtFree) {
      this._showTrayMessage(t("insufficient_space"));
    }
    this._trayWarnFree = free;
  }

  _startTrayPulse() {
    if (this._trayPulse) return;
    let beat = 0;
    const glow = this.trayGlow;
    const fn = () => {
      if (glow.destroyed) { this._stopTrayPulse(); return; }
      beat = (beat + this.app.ticker.deltaMS) % 900;
      // A slow breathe rather than a blink — it has to read as pressure without
      // competing with the tiles for attention.
      glow.alpha = 0.3 + 0.55 * (0.5 - 0.5 * Math.cos((beat / 900) * Math.PI * 2));
    };
    this._trayPulse = fn;
    this.app.ticker.add(fn);
  }

  _stopTrayPulse() {
    if (this._trayPulse) { this.app.ticker.remove(this._trayPulse); this._trayPulse = null; }
    if (this.trayGlow && !this.trayGlow.destroyed) this.trayGlow.alpha = 0;
  }

  // ---- the coached first use of a helper -----------------------------------

  // Which helper (if any) is owed its coaching right now: unlocked, but never
  // taught. More than one can be owed at once — a save that crossed several
  // gates before this feature existed, or a QA jump — so the lowest unlock level
  // goes first and the rest wait for later levels. One lesson per level entry.
  _owedCoach() {
    if (!COACH.enabled || !this.user) return null;
    let best = null;
    for (const [kind, u] of Object.entries(BOOSTER_UNLOCKS)) {
      if (!this.user.isBoosterUnlocked(kind)) continue;
      if (this.user.isBoosterCoached(kind)) continue;
      if (!best || u.level < best.level) best = { kind, level: u.level };
    }
    return best && best.kind;
  }

  // Is there actually a move for this helper to make? The coaching has no
  // dismissal path — using the helper is the only way out — so opening one over
  // a board where the helper would no-op would strand the player behind a modal
  // that can never close. When it can't act, the lesson simply stays owed and
  // comes round again on the next level.
  _coachCanAct(kind) {
    if (kind === "undo") return this.history.length > 0;
    if (kind === "wand") { const p = this._wandPick(); return !!(p && p.tiles.length); }
    if (kind === "shuffle") return this.tiles.some((t) => !t.matched && !t.inTray);
    return false;
  }

  // Called once the board has finished building. Undo is the odd one out: there
  // is nothing to undo on a fresh board, so it is only ARMED here and opens from
  // _collect once the player has actually collected something.
  _maybeCoachBooster() {
    const kind = this._owedCoach();
    if (!kind) return;
    if (kind === "undo") { this._coachPending = "undo"; return; }
    if (!this._coachCanAct(kind)) return;
    this._openCoach(kind);
  }

  // Dim the level and lift one helper button out of the dim. The rest of the
  // level is parked in a "guiding" state until the player uses it (see the
  // `_coach` guards in _onTapTile / undo / wand / reshuffle / autoComplete).
  _openCoach(kind) {
    if (this._coach || !this.user) return;
    this._coachPending = null;
    const btn = { undo: this.undoBtn, shuffle: this.shuffleBtn, wand: this.wandBtn }[kind];
    const badge = { undo: this.undoBadge, shuffle: this.shuffleBadge, wand: this.wandBadge }[kind];
    if (!btn || !badge) return;
    const coach = new BoosterCoach(this.app, kind, btn, badge);
    this.tutorialLayer.addChild(coach);
    coach.layout(this.viewW, this.viewH);
    this._coach = coach;
  }

  // Take the coaching down and give the button back to the helper row. `taught`
  // is true only on the path that actually used the helper — walking away (a
  // level reload, the Back button) leaves it owed, so it fires again next time.
  _closeCoach(taught = false) {
    const coach = this._coach;
    this._coach = null;
    this._coachPending = null;
    if (!coach) return;
    if (taught && this.user) this.user.markBoosterCoached(coach.kind);
    coach.close();
    this._updateBoosters();
  }

  // The gate every helper opens with while a coaching is up: the coached one is
  // let through (and marked taught), everything else is inert. Returns true when
  // the press should be refused.
  _blockedByCoach(kind) {
    if (!this._coach) return false;
    if (this._coach.kind !== kind) return true;
    this._closeCoach(true);
    return false;
  }

  // Auto Complete becomes available only in a trivially-solvable endgame: at most
  // AUTO_MAX_TILES left with NONE still covered, so every remaining tile is
  // directly reachable. The remaining count is always a multiple of 3 (each clear
  // removes exactly 3), so this can never grant a win over a genuinely
  // unmatchable leftover. Never below AUTO_MIN_LEVEL — the teaching level is
  // played by hand, all the way to the win. Both bounds: src/config.js.
  _autoAvailable() {
    return this.levelNum >= AUTO_MIN_LEVEL && !this.locked && this.boardCount > 0
      && (this.boardCount + this.tray.length) <= AUTO_MAX_TILES
      && !this.tiles.some((t) => !t.inTray && !t.matched && t.aliveCovers > 0);
  }

  // Reflect one helper's state on its button + badge. `contextOk` is whether a move
  // is possible right now (a tile to undo, a board to shuffle/wand), independent of
  // stock. The badge reflects the three-tier acquisition: OWN one → count; else
  // AFFORD one → coin price; else → "watch an ad". A tap always resolves through
  // that ladder (see _acquireBooster), so the button is live whenever a move is
  // possible; when no move is possible it's greyed and shows the plain stock count.
  _setBoosterButton(btn, badge, kind, count, contextOk) {
    // Helpers are not available in the first levels: the icon still shows (so the
    // player learns the row exists) but wears a lock badge, is dimmed, and its
    // action is refused. It stays event-enabled so a tap can say why.
    if (this._isBoosterLocked(kind)) {
      btn._boosterMode = "locked";
      btn.eventMode = "static";
      btn.cursor = "default";
      btn.alpha = 0.55;
      badge.visible = true;
      badge.setBadge("locked", 0, null);
      return;
    }
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
    // _layoutBoard moved the tiles, so the guidance hand has to follow its target.
    if (this._hand && this._handTile && !this._handTile.container.destroyed) {
      this._hand.position.set(this._handTile.container.x, this._handTile.container.y);
    }
    // The tutorial popup re-centres itself (its dim covers the whole view).
    if (this._tutorial && !this._tutorial.destroyed) this._tutorial.layout(DW, DH);
    // The coaching holds a helper button on loan, so it has to put it back on the
    // row at the new offsets rather than leaving it where the old ones put it.
    if (this._coach && !this._coach.destroyed) this._coach.layout(DW, DH);
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
      // Keep the game a fixed-width vertical column: crisp art in the centred
      // 750-wide band, a blurred copy filling the sides on a wide screen.
      for (const sp of buildColumnBackground(tex, this.viewW, this.viewH)) this.bgLayer.addChild(sp);
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

    this.levelText = new PIXI.Text(t("hud_level", 1), {
      fontFamily: "Arial", fontSize: 40, fontWeight: "900", fill: 0xffffff,
      stroke: 0x1a2a52, strokeThickness: 6,
    });
    this.levelText.anchor.set(0.5);
    this.levelText.position.set(DESIGN_W / 2, 84);
    this.hudTop.addChild(this.levelText);

    // Coin balance pill — top-right of the HUD bar. Tapping it opens the shop.
    this.coinPill = makeCoinPill(this.user, () => this.onShop && this.onShop());
    this.coinPill.position.set(DESIGN_W - 108, 84);
    this.hudTop.addChild(this.coinPill);

    // buttons row — round, icon-only. Placed BELOW the tray panel (whose bottom
    // edge sits at TRAY_Y + slot/2 + SLOT_PAD, at most TRAY_Y + slotMaxFor(cells)/2
    // + SLOT_PAD) so the two never overlap even at the widest per-level slot size —
    // and an 8-cell row clamps narrower still, so the extra slot only adds room.
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
    this.autoBtn = this._makeButton(`✓ ${t("auto_complete")}`, 460, 92, DESIGN_W / 2, by, 0x39c06a,
      () => this.autoComplete());
    this.autoBtn.visible = false;
    this.hudBottom.addChild(this.autoBtn);

    // The "+1" offer covering the extra tray cell. It lives on hudBottom rather
    // than in trayGroup so it paints ABOVE the slot sprites, and because both
    // share the same (ox, oy) offset and 0..750 coordinate space a tray slot
    // position places it exactly (see _placeExtraSlotButton).
    this.extraBtn = this._makeExtraSlotButton();
    this.hudBottom.addChild(this.extraBtn);

    // Settings (cog) — top-left. Opens the settings screen via the host.
    const cog = makeCogButton(this.audio, () => this.onSettings && this.onSettings());
    cog.position.set(60, 84);
    this.hudTop.addChild(cog);
    this.cog = cog;

    // Back — sits next to the cog. Stops the level and returns to the lobby;
    // any user-record changes made during the level are left intact (persisted).
    this.backBtn = this._makeRoundButton("‹", 38, 148, 84, 0x334063, () => this._exit());
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
  //  • "locked" — the helper hasn't been unlocked yet (see BOOSTER_UNLOCKS): a
  //     padlock in a muted bubble, sitting on top of a dimmed icon.
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
    const lock = new PIXI.Text("🔒", { fontFamily: "Arial", fontSize: 22 });
    lock.anchor.set(0.5);
    const t = new PIXI.Text("0", {
      fontFamily: "Arial", fontSize: 26, fontWeight: "900", fill: 0xffffff,
      stroke: 0x14361f, strokeThickness: 4,
    });
    t.anchor.set(0.5);
    c.addChild(g, coin, ad, lock, t);
    c.text = t;
    c.setBadge = (mode, count, price) => {
      g.clear();
      coin.visible = false;
      ad.visible = false;
      lock.visible = false;
      if (mode === "locked") {
        // Not unlocked yet: a padlock in a muted bubble. No count — the player
        // owns none and can't buy their way past a progression gate.
        t.text = "";
        lock.visible = true;
        const r = 20;
        g.beginFill(0x5a6480).drawCircle(0, 0, r).endFill();
        g.lineStyle(3, 0xffffff, 0.9).drawCircle(0, 0, r);
      } else if (mode === "buy") {
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

  // The clamp bounds _layoutBoard sizes the tray slot within. Exposed so the debug
  // API can report them without re-deriving the formula — the upper one depends on
  // how many cells are currently drawn.
  slotMin() { return SLOT_MIN; }
  slotMax() { return slotMaxFor(this.traySlotsDrawn); }

  _buildTraySlots() {
    // The panel + slot sprites are (re)drawn by _layoutTraySlots() whenever the
    // per-level slot size or cell count changes; create the containers once, in
    // back-to-front order (panel, then its warning glow, then slots), and let the
    // reflow fill them in.
    this.trayPanel = new PIXI.Graphics();
    this.trayGlow = new PIXI.Graphics();  // the near-full pulse, drawn on the panel rect
    this.trayGlow.alpha = 0;
    this.slotContainer = new PIXI.Container();
    this.trayGroup.addChild(this.trayPanel, this.trayGlow, this.slotContainer);
    this._layoutTraySlots();
  }

  // (Re)build the tray panel + slot sprites at the current slot size (this.slot)
  // and cell count (this.traySlotsDrawn). Keeps the row centred in the 750-wide
  // safe band — which is what re-centres the whole tray when the 8th cell joins
  // it; collected tiles (added to trayGroup on top of these) are untouched and
  // re-placed by _layoutTray().
  _layoutTraySlots() {
    const SZ = this.slot;
    const n = this.traySlotsDrawn;
    const totalW = n * SZ + (n - 1) * SLOT_GAP;
    const startX = DESIGN_W / 2 - totalW / 2 + SZ / 2;
    const rect = [DESIGN_W / 2 - totalW / 2 - SLOT_PAD, TRAY_Y - SZ / 2 - SLOT_PAD,
      totalW + 2 * SLOT_PAD, SZ + 2 * SLOT_PAD];
    this.slotPositions = [];
    this.trayPanel.clear();
    this.trayPanel.beginFill(0x0a1226, 0.4).drawRoundedRect(...rect, 26).endFill();
    // The warning glow traces the same rounded rect with an INNER stroke, so it
    // never grows the panel's bounds (and so can't upset resize_overlap_test).
    this.trayGlow.clear();
    this.trayGlow.lineStyle({ width: 6, color: 0xff8a3d, alpha: 1, alignment: 0 });
    this.trayGlow.drawRoundedRect(...rect, 26);
    this.slotContainer.removeChildren();
    for (let i = 0; i < n; i++) {
      const x = startX + i * (SZ + SLOT_GAP);
      this.slotPositions.push({ x, y: TRAY_Y });
      const s = new PIXI.Sprite(this.slotTexture);
      s.anchor.set(0.5);
      s.width = s.height = SZ;
      s.position.set(x, TRAY_Y);
      this.slotContainer.addChild(s);
    }
    this._placeExtraSlotButton();
  }

  // ---- level setup ---------------------------------------------------------

  loadLevel(rawArr, levelNum) {
    this.levelNum = levelNum;
    this.rawArr = rawArr;
    this.levelText.text = t("hud_level", levelNum);
    // The very first level a brand-new player sees is the guided one: stripped
    // chrome (see _applyFirstRunChrome) plus the opening demo moves below.
    this._firstRun = !!(this.user && this.user.isNewPlayer() && levelNum === 1);
    this._guideRun++; // any guided opening still in flight belongs to the old board
    this._applyFirstRunChrome();
    this._hideHand();
    this._closeTutorial(); // a popup from a previous load belongs to the old board
    this._clearBoosterHint();
    this._clearTrayMessage();
    this._stopTrayPulse();
    // Any coaching from the previous board goes too, and stays owed — reloading
    // out of a lesson is not the same as having had it.
    this._closeCoach();
    this._buildBackground();
    this.overlayLayer.removeChildren();
    this._resetChestOverlay();
    this.boardLayer.removeChildren();
    // clear any tray tiles from a previous run
    this.tray.forEach((t) => t.container.destroy());
    this.tray = [];
    this.history = [];
    this.locked = false;
    this._autoRunning = false; // clear in case a prior level ended via Auto Complete
    this._loseBtns = null;     // drop any stale Out-of-Moves overlay refs
    // The 8th slot is scoped to a single level: capacity returns to the base on
    // EVERY board build — next level, Replay, retry after a loss — and the "+1"
    // offer comes back with it, so each attempt is a fresh one. (A revive does not
    // come through here, which is why it keeps the capacity it has.) Whether the
    // extra CELL is drawn is a pure progression check, re-asked here so it shows
    // up on the very next level started after the gate is crossed.
    this.traySlots = TRAY_SLOTS;
    this.traySlotsDrawn = TRAY_SLOTS + (this._extraSlotDrawn() ? EXTRA_SLOT.grant : 0);
    this._trayWarnFree = Infinity;

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

    this._layoutBoard();   // also rebuilds the tray row if the cell count changed
    this._refreshFreeStates();
    this._updateBoosters();
    this._updateExtraSlot();
    this._updateTrayWarning();

    // The board is fully built and interactive the moment the calls above return
    // (_layoutBoard places tiles outright — there's no build-in animation), so
    // this is the "board finished building" moment the opening waits for.
    // On level 1 the "How To Play" popup comes first and hands over to the guided
    // opening when it closes; every other level starts play straight away.
    if (levelNum === TUTORIAL_LEVEL) this._showTutorial();
    else if (this._firstRun) this._runFirstRunGuide();
    // ...and on any other level, a helper that just came off its gate gets its
    // coached first use here. Level 1 never reaches this branch, and nothing is
    // owed there anyway — every helper is still locked.
    else this._maybeCoachBooster();
  }

  // ---- the "How To Play" popup ---------------------------------------------

  // Open the tutorial over the dealt board and lock input behind it: the player
  // reads the rule and watches it happen before touching anything. Closing it
  // (OK, or a tap anywhere once the intro has played) hands straight over to the
  // guided opening, so the two demo moves follow the explanation.
  _showTutorial() {
    this._closeTutorial();
    this.locked = true;
    const run = this._guideRun; // the board this popup belongs to
    const popup = new HowToPlayPopup(this.app, this.tileTextures, this.slotTexture,
      this.audio, () => {
        if (this._tutorial === popup) this._tutorial = null;
        // A level reload while the popup was up already owns `locked` and has its
        // own opening to run — this one must not touch either.
        if (this._guideRun !== run || this.destroyed) return;
        this.locked = false;
        if (this._firstRun) this._runFirstRunGuide();
      });
    this.tutorialLayer.addChild(popup);
    popup.layout(this.viewW, this.viewH);
    this._tutorial = popup;
    popup.open();
  }

  // Tear the popup down without running its close handler — for the paths that
  // are replacing or leaving the level anyway (loadLevel, _exit).
  _closeTutorial() {
    const popup = this._tutorial;
    this._tutorial = null;
    if (popup && !popup.destroyed) { popup.onClose = null; popup.destroy(); }
  }

  // ---- first-run guidance --------------------------------------------------

  // On the guided first level the interface is deliberately stripped down to the
  // one thing the player has to learn: tap tiles. The top bar keeps the coin
  // counter only — no settings cog, no shop — and there is no Back button, so the
  // level can't be left before it's played.
  // The shop affordance has a gate of its own on top of that (the shop is a
  // progression unlock, see CONFIG.features.shop.unlockLevel), so the cart appears later
  // than the rest of the chrome comes back.
  _applyFirstRunChrome() {
    const full = !this._firstRun;
    this.cog.visible = full;
    this.backBtn.visible = full;
    this.coinPill.setShopEnabled(full && (!this.user || this.user.isShopUnlocked()));
  }

  // Three identical tiles that are all free to tap right now, or null. Scanned in
  // tile order and returned lowest-type-first, so the pick is deterministic for a
  // given board (levels are seeded, so the guided opening is reproducible).
  _findGuideTriple() {
    const byType = new Map();
    for (const t of this.tiles) {
      if (!this._isFree(t)) continue;
      if (!byType.has(t.type)) byType.set(t.type, []);
      byType.get(t.type).push(t);
    }
    let best = null;
    for (const [type, group] of byType) {
      if (group.length < 3) continue;
      if (!best || type < best.type) best = { type, tiles: group.slice(0, 3) };
    }
    return best ? best.tiles : null;
  }

  // Play the player's first two moves for them, then point at the third tile of
  // the triple — so their very first tap completes a match and shows the whole
  // loop (collect → three-of-a-kind → clear) in one action. If the board doesn't
  // offer a clean group of three free tiles, the guidance is simply skipped.
  async _runFirstRunGuide() {
    const trio = this._findGuideTriple();
    if (!trio) return;
    const run = this._guideRun;
    const ticker = this.app.ticker;
    // Guard every await: the player can't leave (no Back button), but a restart or
    // a scripted exitLevel()/startLevel() can hide or rebuild the board out from
    // under the sequence. The generation token catches even a reload of the SAME
    // level — without it a second guide would run over the first's tiles.
    const stale = () =>
      this._guideRun !== run || !this._firstRun || this.destroyed || !this.visible;
    this.locked = true; // the demo moves play with no input from the player
    // A stale run bails WITHOUT touching `locked` — the run that superseded it owns
    // that flag now (and loadLevel clears it on every entry anyway).
    await delay(ticker, 500);
    if (stale()) return;
    this._collect(trio[0]);
    await delay(ticker, 520);
    if (stale()) return;
    this._collect(trio[1]);
    await delay(ticker, 420);
    if (stale()) return;
    this.locked = false;
    this._showHand(trio[2]);
  }

  // An animated pointing hand over a tile: a tapping finger plus a ripple ring, so
  // the target reads even where the emoji renders flat. Lives on fxLayer — above
  // the board and tray, below the HUD — which shares the board's coordinate space,
  // so the tile's own position can be used directly.
  _showHand(tile) {
    this._hideHand();
    if (!tile || !tile.container || tile.container.destroyed) return;
    const c = new PIXI.Container();
    c.__tileId = tile.id; // test seam (window.__game.handState)
    c.eventMode = "none"; // never steals the tap it is asking for
    const ring = new PIXI.Graphics();
    c.addChild(ring);
    const hand = new PIXI.Text("👆", {
      fontFamily: '"Noto Color Emoji","Apple Color Emoji","Segoe UI Emoji",Arial',
      fontSize: 60,
    });
    hand.anchor.set(0.5, 0);
    c.addChild(hand);
    c.position.set(tile.container.x, tile.container.y);
    this.fxLayer.addChild(c);
    this._hand = c;
    this._handTile = tile;

    // Tap loop: the finger dips toward the tile and a ring expands out of it, once
    // per beat. Bails if the container goes away mid-tween (a level reload), like
    // the other micro-animators.
    let beat = 0;
    const fn = () => {
      if (c.destroyed) { this.app.ticker.remove(fn); return; }
      beat = (beat + this.app.ticker.deltaMS) % 1200;
      const p = beat / 1200;
      const dip = p < 0.25 ? Math.sin((p / 0.25) * Math.PI) : 0; // quick press
      hand.position.set(0, 18 - dip * 14);
      hand.scale.set(1 - dip * 0.08);
      const rp = Math.min(1, p / 0.6);
      ring.clear();
      ring.lineStyle(5, 0xffffff, (1 - rp) * 0.75);
      ring.drawCircle(0, 0, 26 + rp * 34);
    };
    this._handAnim = fn;
    this.app.ticker.add(fn);
  }

  // Leave the level for the lobby. The single exit path, so the guidance hand
  // (and any floating hint) can't be left behind on a hidden scene.
  _exit() {
    this._hideHand();
    this._closeTutorial();
    this._clearBoosterHint();
    this._clearTrayMessage();
    this._stopTrayPulse();
    this._closeCoach();
    this.overlayLayer.removeChildren();
    this._resetChestOverlay();
    if (this.onExit) this.onExit();
  }

  _hideHand() {
    if (this._handAnim) { this.app.ticker.remove(this._handAnim); this._handAnim = null; }
    const c = this._hand;
    this._hand = null;
    this._handTile = null;
    if (c && !c.destroyed) { c.parent && c.parent.removeChild(c); c.destroy({ children: true }); }
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
    // Fill the width of the 750-wide game column (never the full viewport): the
    // game stays a fixed-width vertical strip, so on a wide screen the board is
    // sized for the column, not blown up edge-to-edge (the sides show the blurred
    // backdrop). viewW is >= DESIGN_W, so this is just DESIGN_W - 60 = 690.
    const areaW = Math.min(this.viewW, DESIGN_W) - 60;
    const areaH = this.boardBottom - this.boardTop;
    this.boardScale = Math.min(areaW / spanX, areaH / spanY); // no cap: grow to fill
    const s = this.boardScale;

    // Size the bottom tray to the current level's on-screen tile size: a board
    // tile is drawn at TILE_DRAW * boardScale, so match that so a collected tile
    // keeps its size as it flies into the tray. Clamp to [SLOT_MIN, slotMaxFor(n)]
    // so the row always fits the safe band (dense boards, whose tiles are small,
    // shrink the tray to match; roomy boards cap it at the widest that fits) — the
    // upper bound depends on the CELL COUNT, so an 8-cell tray caps narrower.
    const slot = Math.max(SLOT_MIN, Math.min(slotMaxFor(this.traySlotsDrawn), TILE_DRAW * s));
    // Rebuild on a change of size OR of cell count: crossing the 8th slot's gate
    // usually leaves the clamped size untouched (both clamp to their own max), and
    // a size-only guard would then leave the old row drawn.
    if (slot !== this.slot || this.slotPositions.length !== this.traySlotsDrawn) {
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
    // While a coaching is up the level is parked: the dim already swallows real
    // taps, and this stops the scripted ones (window.__game.solveTap()) too.
    if (this._coach) return;
    if (!this._isFree(t)) {
      this._shake(t.container);
      return;
    }
    // Once the tray is full further taps are rejected outright — the tile just
    // bounces back. Capacity is the LIVE one, so the 8th slot (when taken) buys
    // one more tap here as well as one more before the loss.
    if (this.tray.length >= this.traySlots) {
      this._shake(t.container);
      return;
    }
    this._collect(t);
  }

  _collect(t) {
    // The guidance hand has done its job the moment ANY tile is collected — the
    // pointed-at one or not (and including the two moves played for the player).
    this._hideHand();
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
    this._updateBoosters();

    // Undo's coaching waits for exactly this moment — the first collected tile
    // is the first thing there is to undo. The beat lets the tile land in the
    // tray before the dim comes down over it.
    if (this._coachPending === "undo") {
      this._coachPending = null;
      setTimeout(() => {
        // Guarded like the guided opening (_runFirstRunGuide): the player can
        // leave or reload the level inside this beat, and a lesson must never
        // open on a board that is no longer on screen.
        if (this._coach || this.destroyed || !this.visible) return;
        if (this._owedCoach() === "undo" && this._coachCanAct("undo")) this._openCoach("undo");
      }, COACH.undoDelayMs);
    }

    // settle after the slide-in
    setTimeout(() => this._settle(), 190);
  }

  _layoutTray() {
    this.tray.forEach((t, i) => {
      // Normal play never exceeds the capacity, but the Wand can momentarily bring
      // the tray over it before the completed triple clears in the same beat —
      // clamp to the last DRAWN slot so we never index past slotPositions.
      const pos = this.slotPositions[Math.min(i, this.slotPositions.length - 1)];
      this._animateTo(t.container, pos.x, pos.y, 200, easeOutCubic);
      this._animateScale(t.container, this.slot / TILE_DRAW, 200);
    });
    this._updateTrayWarning();
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
    } else if (this.tray.length >= this.traySlots) {
      this._lose();
    }
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
    if (this._blockedByCoach("undo")) return;   // another helper is being taught
    if (this._rejectIfLocked("undo", this.undoBtn)) return; // not unlocked yet
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
    if (this._blockedByCoach("wand")) return;      // another helper is being taught
    if (this._rejectIfLocked("wand", this.wandBtn)) return; // not unlocked yet
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
    if (this.locked || this._autoRunning || this._coach || !this._autoAvailable()) return;
    this.locked = true;
    this._autoRunning = true;

    // The animation owns the HUD row — hide every helper node and the button.
    for (const n of [this.shuffleBtn, this.wandBtn, this.undoBtn,
      this.shuffleBadge, this.wandBadge, this.undoBadge, this.autoBtn,
      this.extraBtn]) n.visible = false;

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
      this.audio.play("tile_bop");         // same landing bop a hand-collected tile makes
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
    if (this._blockedByCoach("shuffle")) return;   // another helper is being taught
    if (this._rejectIfLocked("shuffle", this.shuffleBtn)) return; // not unlocked yet
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

    // Order matters for the tray limit: completing pairs frees slots fastest, so
    // do those first, then singles. Following this sequence keeps the tray within
    // capacity as long as the deck isn't capacity-2 lone singletons (an
    // already-lost state the board can't rescue without touching the deck — then
    // we just fall back to a self-contained board so the reshuffle is still a
    // fresh, valid board). Measured against the LIVE capacity, so the 8th slot
    // widens what a reshuffle can rescue.
    const feasible = singles.length <= this.traySlots - 2;
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
    // "Tiles matched" is a lifetime task counter (src/tasks.js), and only tiles
    // from a level the player actually FINISHES count towards it. Clearing the
    // level means every one of its tiles was matched, so the level's own tile
    // count IS the amount to credit — a fixed number, set once in loadLevel and
    // never added to. Crediting it here rather than tallying triples as they
    // clear gets two things right at once: an attempt that is abandoned or lost
    // never reaches this line and so counts nothing, and the Auto Complete sweep
    // (which clears its tiles directly and lands here without ever passing
    // through _settle) is counted in full instead of being missed.
    if (this.user) this.user.bumpStat("tilesMatched", this.tiles.length);
    // The Level Chest advances one notch only for a GENUINELY NEW clear — pushing
    // the furthest level higher. completeLevel() hasn't run yet (the host fires it
    // on the Continue press), so completedLevel() still holds the OLD highest here:
    // this level is new exactly when it is beyond it. A replay shows no chest.
    const chestLevel = (this.user && this.levelNum > this.user.completedLevel()) ? this.levelNum : 0;
    const last = this.levelNum >= 3;
    this._showOverlay(
      last ? `🏆 ${t("you_win")}` : t("Language2"),
      t("win_subtitle", t(last ? "win_all_cleared" : "win_great_matching"), COIN_WIN_REWARD),
      t("btn_go"),
      // hand control back to the lobby, which advances to the next level
      () => this.onLevelComplete && this.onLevelComplete(this.levelNum),
      COIN_WIN_REWARD, // show a gold coin next to the reward
      chestLevel       // 0 = no chest (a replay); else the level whose chest to show
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
    this._winBtn = null; // this path is the lose overlay — no win button lives
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

    const tt = new PIXI.Text(t("out_of_moves"), {
      fontFamily: "Arial", fontSize: 52, fontWeight: "900", fill: 0xffe27a,
      stroke: 0x5a3a00, strokeThickness: 6,
    });
    tt.anchor.set(0.5); tt.position.set(0, -162);
    const stt = new PIXI.Text(t("tray_full"), {
      fontFamily: "Arial", fontSize: 28, fill: 0xd7e2ff,
    });
    stt.anchor.set(0.5); stt.position.set(0, -104);
    group.addChild(tt, stt);

    // Secondary row: Home (lobby) | Replay (restart), above the Continue button.
    const home = this._makeButton(t("btn_home"), 250, 88, -136, -6, 0x556080, () => {
      this._loseBtns = null;
      this.overlayLayer.removeChildren();
      this._exit();
    });
    const replay = this._makeButton(t("btn_replay"), 250, 88, 136, -6, 0x4d8dff, () => {
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
    const label = new PIXI.Text(t("btn_go"), {
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

  _showOverlay(title, subtitle, btnLabel, onBtn, coinReward = 0, chestLevel = 0) {
    this._loseBtns = null; // this path is the win overlay — no lose buttons live
    this.overlayLayer.removeChildren();
    this._resetChestOverlay();
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

    // Only mount a chest for a genuinely new clear whose schedule resolves. When
    // it does, the panel grows to make room for the bar and the Continue button
    // drops to the bottom; otherwise the layout is exactly the classic overlay.
    const chestInfo = (chestLevel && this.levelChest && this.levelChest.enabled)
      ? this.levelChest.infoFor(chestLevel) : null;
    const tall = !!chestInfo;
    const half = tall ? 250 : 180;
    const titleY = tall ? -half + 66 : -90;
    const subY = tall ? -half + 132 : -20;
    const btnY = tall ? half - 62 : 100;

    const panel = new PIXI.Graphics();
    panel.beginFill(0x22335e, 1).drawRoundedRect(-280, -half, 560, half * 2, 34).endFill();
    panel.lineStyle(6, 0xffffff, 0.15).drawRoundedRect(-280, -half, 560, half * 2, 34);
    group.addChild(panel);

    const tt = new PIXI.Text(title, {
      fontFamily: "Arial", fontSize: 56, fontWeight: "900", fill: 0xffe27a,
      stroke: 0x5a3a00, strokeThickness: 6,
    });
    tt.anchor.set(0.5); tt.position.set(0, titleY);
    const st = new PIXI.Text(subtitle, {
      fontFamily: "Arial", fontSize: 30, fill: 0xd7e2ff,
    });
    group.addChild(tt, st);
    if (coinReward) {
      // Lay out "subtitle" + a gold coin icon as a centred unit.
      const icon = makeCoinIcon(16);
      const gap = 12;
      const total = st.width + gap + 32; // 32 = coin diameter
      st.anchor.set(0, 0.5); st.position.set(-total / 2, subY);
      icon.position.set(-total / 2 + st.width + gap + 16, subY);
      group.addChild(icon);
    } else {
      st.anchor.set(0.5); st.position.set(0, subY);
    }

    const btn = this._makeButton(btnLabel, 320, 92, 0, btnY, 0x39c06a, () => {
      this.overlayLayer.removeChildren();
      this._winBtn = null;
      this._resetChestOverlay();
      onBtn();
    });
    group.addChild(btn);
    this._winBtn = btn; // test seam (window.__game.pressWinContinue)

    if (chestInfo) this._mountLevelChest(group, chestInfo);

    tt.scale.set(0.2);
    tween(this.app.ticker, {
      duration: 420, ease: easeOutBack,
      onUpdate: (e) => tt.scale.set(0.2 + 0.8 * e),
    });
  }

  // ---- level chest (the win-overlay reward bar) ----------------------------

  // Mount the chest bar + treasure icon into an open win overlay. `info` comes
  // from LevelChest.infoFor (filled / needed / reward / full). The bar animates up
  // one notch; if the win FILLED the chest, it then pops open and pays out.
  _mountLevelChest(group, info) {
    this._chestTaken = false;
    this._chestDoubled = false;
    this._chestState = {
      shown: true,
      label: info.label,
      filled: info.filled,
      needed: info.needed,
      reward: { type: info.reward.type, amount: info.reward.amount },
      full: info.full,
      opened: false,
      popup: false,
      claimed: false,
    };

    const icon = this._makeChestIcon();
    icon.position.set(0, -34);
    group.addChild(icon);
    this._chestIcon = icon;

    // Progress bar — the Tasks-row style (dark track + green fill + count label).
    const trackW = 320, trackH = 22, barY = 58;
    const track = new PIXI.Graphics();
    track.beginFill(0x0a1226, 0.75)
      .drawRoundedRect(-trackW / 2, barY - trackH / 2, trackW, trackH, trackH / 2).endFill();
    group.addChild(track);
    const fill = new PIXI.Graphics();
    group.addChild(fill);
    const label = new PIXI.Text(info.label, {
      fontFamily: "Arial", fontSize: 22, fontWeight: "900", fill: 0xdce7ff,
      stroke: 0x122043, strokeThickness: 3,
    });
    label.anchor.set(0.5); label.position.set(0, barY);
    group.addChild(label);
    this._chestBar = { fill, label, trackW, trackH, barY, needed: info.needed };

    // Draw the fill to a given (possibly fractional) notch count.
    const draw = (notches) => {
      fill.clear();
      const pct = info.needed > 0 ? Math.max(0, Math.min(1, notches / info.needed)) : 0;
      if (pct > 0) {
        fill.beginFill(0x39c06a)
          .drawRoundedRect(-trackW / 2, barY - trackH / 2,
            Math.max(trackH, trackW * pct), trackH, trackH / 2).endFill();
      }
      label.text = `${Math.round(notches)} / ${info.needed}`;
    };
    draw(Math.max(0, info.filled - 1));

    // Animate the last notch filling, then open the chest if this win filled it.
    this._chestAnimRun = (this._chestAnimRun || 0) + 1;
    const run = this._chestAnimRun;
    delay(this.app.ticker, 300).then(() => {
      if (fill.destroyed || run !== this._chestAnimRun) return;
      return tween(this.app.ticker, {
        duration: 420, ease: easeOutCubic,
        onUpdate: (e) => { if (!fill.destroyed) draw(info.filled - 1 + e); },
      });
    }).then(() => {
      if (fill.destroyed || run !== this._chestAnimRun) return;
      if (info.full) this._openChest(info.reward);
    });
  }

  // A small treasure chest whose lid lifts when it opens.
  _makeChestIcon() {
    const c = new PIXI.Container();
    const w = 104, h = 74, lidH = 32;
    const body = new PIXI.Graphics();
    body.beginFill(0x8a5a2b).drawRoundedRect(-w / 2, -h / 2 + lidH - 4, w, h - lidH + 4, 10).endFill();
    body.lineStyle(4, 0xffe27a, 0.95).drawRoundedRect(-w / 2, -h / 2 + lidH - 4, w, h - lidH + 4, 10);
    // Gold clasp + keyhole on the body.
    const clasp = new PIXI.Graphics();
    clasp.beginFill(0xffcf4d).drawRoundedRect(-16, -h / 2 + lidH - 6, 32, 26, 6).endFill();
    clasp.beginFill(0x5a3a00).drawCircle(0, -h / 2 + lidH + 4, 5).endFill();
    c.addChild(body, clasp);
    // Lid (a rounded cap, pivoting up from its back edge on open).
    const lid = new PIXI.Container();
    lid.position.set(0, -h / 2 + lidH);
    const lg = new PIXI.Graphics();
    lg.beginFill(0xb5762f).drawRoundedRect(-w / 2 - 2, -lidH, w + 4, lidH, 10).endFill();
    lg.lineStyle(4, 0xffe27a, 0.95).drawRoundedRect(-w / 2 - 2, -lidH, w + 4, lidH, 10);
    lid.addChild(lg);
    c.addChild(lid);
    c.lid = lid; c.body = body;
    return c;
  }

  // Chest is full → pop it open (sound + lid lift), then show the reward popup.
  async _openChest(reward) {
    this.audio.play("openbox");
    this._chestState.opened = true;
    const icon = this._chestIcon;
    if (icon && !icon.destroyed) {
      const lid = icon.lid;
      await tween(this.app.ticker, {
        duration: 340, ease: easeOutBack,
        onUpdate: (e) => {
          if (icon.destroyed) return;
          icon.scale.set(1 + 0.14 * Math.sin(Math.PI * e));
          if (lid) { lid.y = (-34) * e; lid.rotation = -0.5 * e; }
        },
      });
    }
    if (this.overlayLayer.children.length) this._showChestReward(reward);
  }

  // The reward popup: a reveal + "📺 Double it!" (immediate) and a plain "Claim"
  // that fades in a moment later — the same nudge-toward-the-ad shape the daily
  // gift uses. It draws over the win overlay's own panel and, once collected,
  // removes itself to reveal the Continue button underneath.
  _showChestReward(reward) {
    const group = this._overlayGroup;
    if (!group || group.destroyed) return;
    const popup = new PIXI.Container();
    group.addChild(popup);
    this._chestReward = popup;
    this._chestState.popup = true;

    const localDim = new PIXI.Graphics();
    localDim.beginFill(0x081018, 0.82).drawRoundedRect(-280, -250, 560, 500, 34).endFill();
    localDim.eventMode = "static"; // modal over the panel
    popup.addChild(localDim);

    const title = new PIXI.Text(t("chest_reward_title"), {
      fontFamily: "Arial", fontSize: 44, fontWeight: "900", fill: 0xffe27a,
      stroke: 0x5a3a00, strokeThickness: 6,
    });
    title.anchor.set(0.5); title.position.set(0, -160);
    popup.addChild(title);

    const icon = this._makeRewardIcon(reward, 42);
    icon.position.set(0, -56);
    popup.addChild(icon);
    this._chestRewardIcon = icon;

    const amt = new PIXI.Text(this._rewardText(reward), {
      fontFamily: "Arial", fontSize: 34, fontWeight: "800", fill: 0xffffff,
    });
    amt.anchor.set(0.5); amt.position.set(0, 14);
    popup.addChild(amt);
    this._chestRewardAmt = amt;

    const dbl = this._makeButton(`📺  ${t("double_it")}`, 380, 88, 0, 110, 0x2f9e6a,
      () => this._doubleChest(reward));
    popup.addChild(dbl);
    this._chestDoubleBtn = dbl;

    const claim = this._makeButton(t("claim"), 300, 82, 0, 205, 0x4d8dff,
      () => this._claimChest(reward, 1));
    claim.alpha = 0; claim.eventMode = "none";
    popup.addChild(claim);
    this._chestClaimBtn = claim;

    // The plain Claim fades in ~1.6 s after the ad button (dailybonus.js does the
    // same) — guarded so a level that closed the popup meanwhile doesn't revive it.
    delay(this.app.ticker, 1600).then(() => {
      if (claim.destroyed || this._chestReward !== popup) return;
      claim.eventMode = "static";
      tween(this.app.ticker, { duration: 260, onUpdate: (e) => { if (!claim.destroyed) claim.alpha = e; } });
    });
  }

  // Watch a rewarded video to double the chest. Stub — returns the seam value.
  // TODO(SDK): show a real rewarded video and resolve on the completed view.
  _watchChestAd() { return this._chestAdResult || "succeed"; }

  async _doubleChest(reward) {
    if (this._chestTaken) return;
    const res = this._watchChestAd();
    if (res === "succeed") {
      this._chestDoubled = true;
      const doubled = { type: reward.type, amount: (reward.amount || 0) * 2 };
      if (this._chestRewardAmt && !this._chestRewardAmt.destroyed) {
        this._chestRewardAmt.text = this._rewardText(doubled);
      }
      await this._claimChest(reward, 2);
    } else if (res === "fail") {
      this._chestToast(t("ad_not_available"));
    }
    // "cancel": nothing spent — the base Claim stays available.
  }

  async _claimChest(reward, mult) {
    if (this._chestTaken) return;
    this._chestTaken = true;
    if (this._chestDoubleBtn) this._chestDoubleBtn.eventMode = "none";
    if (this._chestClaimBtn) this._chestClaimBtn.eventMode = "none";
    await this._collectChestReward({ type: reward.type, amount: (reward.amount || 0) * mult });
    this._chestState.claimed = true;
    this._chestState.popup = false;
    if (this._chestReward && !this._chestReward.destroyed) this._chestReward.destroy({ children: true });
    this._chestReward = null;
    this._chestDoubleBtn = null;
    this._chestClaimBtn = null;
  }

  // Fly the reward icon to its HUD counter (coins → the coin pill; a booster → its
  // helper button) and grant ON LANDING so the number ticks in sync. Falls back to
  // an immediate grant if the fly-targets can't be located (mirrors dailybonus).
  async _collectChestReward(reward) {
    const grant = () => {
      if (rewardIsCoins(reward.type)) this.user.credit("coins", reward.amount);
      else this.user.grantBooster(reward.type, reward.amount);
    };
    const target = rewardIsCoins(reward.type)
      ? this.coinPill
      : ({ undo: this.undoBtn, wand: this.wandBtn, shuffle: this.shuffleBtn })[reward.type];
    let start, end;
    try {
      start = this.fxLayer.toLocal(this._chestRewardIcon.getGlobalPosition());
      end = this.fxLayer.toLocal((target || this.coinPill).getGlobalPosition());
    } catch (_) { grant(); return; }

    const flyer = this._makeRewardIcon(reward, 34);
    flyer.position.set(start.x, start.y);
    this.fxLayer.addChild(flyer);
    const C = { x: (start.x + end.x) / 2, y: Math.min(start.y, end.y) - 150 };
    await tween(this.app.ticker, {
      duration: 540, ease: easeInOutQuad,
      onUpdate: (e) => {
        const u = 1 - e;
        flyer.x = u * u * start.x + 2 * u * e * C.x + e * e * end.x;
        flyer.y = u * u * start.y + 2 * u * e * C.y + e * e * end.y;
        flyer.scale.set(1 - 0.3 * e);
      },
    });
    grant();
    if (target && !target.destroyed) { target.scale.set(1.22); this._animateScale(target, 1, 220); }
    if (!flyer.destroyed) flyer.destroy();
  }

  _makeRewardIcon(reward, size) {
    if (rewardIsCoins(reward.type)) return makeCoinIcon(size);
    const t = new PIXI.Text(CHEST_REWARD_EMOJI[reward.type] || "❔", {
      fontFamily: "Arial", fontSize: size * 1.6,
    });
    t.anchor.set(0.5);
    return t;
  }

  /**
   * Re-letter the text this scene assembles in code. Only two things outlive a
   * language change here: the HUD's level heading and the Auto Complete button.
   * The win / lose / chest overlays are built fresh every time they are shown —
   * and while one is up its dim swallows every tap, so the settings cog (and
   * with it the picker) cannot be reached anyway.
   */
  relocalize() {
    if (this.levelText && !this.levelText.destroyed) {
      this.levelText.text = t("hud_level", this.levelNum || 1);
    }
    if (this.autoBtn && !this.autoBtn.destroyed) {
      this.autoBtn.label.text = `✓ ${t("auto_complete")}`;
    }
  }

  _rewardText(reward) {
    const n = reward.amount || 0;
    return t("reward_amount", n, itemName(reward.type, n));
  }

  // A brief message inside the reward popup (e.g. "Ad not available").
  _chestToast(msg) {
    const popup = this._chestReward;
    if (!popup || popup.destroyed) return;
    const t = new PIXI.Text(msg, { fontFamily: "Arial", fontSize: 24, fill: 0xffd0d0 });
    t.anchor.set(0.5); t.position.set(0, 58);
    popup.addChild(t);
    delay(this.app.ticker, 1400).then(() => { if (!t.destroyed) t.destroy(); });
  }

  // Tear down any chest overlay state (on Continue, a level reload or an exit) so
  // nothing survives onto the next board.
  _resetChestOverlay() {
    this._chestAnimRun = (this._chestAnimRun || 0) + 1; // invalidate an in-flight fill/open
    this._chestIcon = null;
    this._chestBar = null;
    this._chestReward = null;
    this._chestRewardIcon = null;
    this._chestRewardAmt = null;
    this._chestDoubleBtn = null;
    this._chestClaimBtn = null;
    this._chestTaken = false;
    this._chestDoubled = false;
    this._chestState = { shown: false };
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
