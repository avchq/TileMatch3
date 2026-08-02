import { GameScene } from "./game.js";
import { LobbyScene } from "./lobby.js";
import { SettingsScene } from "./settings.js";
import { ShopScene } from "./shop.js";
import { FortuneWheelScene } from "./fortunewheel.js";
import { DailyBonusScene } from "./dailybonus.js";
import { makePayments } from "./user/payments.js";
import { makeTileTextures, makeSlotTexture } from "./icons.js";
import { AudioManager } from "./audio.js";
import { AssetManager, PRELOAD_GROUPS, MANIFEST, buildLevelGroups } from "./assets.js";
import { loadLevels } from "./levelConfig.js";
import { UserStore } from "./user/UserStore.js";

const DESIGN_W = 750;
const DESIGN_H = 1334;

async function boot() {
  // The renderer fills the whole viewport; the stage is uniformly scaled so the
  // constraining viewport dimension maps exactly onto the 750×1334 design (no
  // distortion). The other dimension gains extra design units, which the scenes
  // reflow into (top HUD to the top edge, tray/helpers to the bottom, board
  // filling the middle, background covering everything) — so the game adapts to
  // any aspect ratio, portrait or landscape, with no letterbox bars.
  const app = new PIXI.Application({
    width: window.innerWidth,
    height: window.innerHeight,
    backgroundColor: 0x10131a,
    antialias: true,
    resolution: Math.min(window.devicePixelRatio || 1, 2),
    autoDensity: true,
  });
  document.getElementById("game").appendChild(app.view);

  const root = new PIXI.Container();
  app.stage.addChild(root);

  // resize() is defined once the scenes exist (it lays them out); see below.
  let resize = () => {};
  window.addEventListener("resize", () => resize());

  // ---- assets --------------------------------------------------------------
  // Procedural (no network): tile faces + tray slot are drawn at runtime.
  const tileTextures = makeTileTextures(128);
  const slotTexture = makeSlotTexture(120);

  // Network assets flow through the AssetManager: PRELOAD the essential minimum
  // (shared audio + levels 1–3), then LAZY-load any further level on demand.
  const audio = new AudioManager();
  const assets = new AssetManager(audio);

  // The level table (which levels exist, their bg/data/types/preload) — fetched
  // from JSON like the other configs, then used to build the asset manifest.
  // Essential config, so a failure is fatal (unlike prices/turntable below,
  // which degrade gracefully). The highest playable level is just its length.
  const levels = await loadLevels();
  buildLevelGroups(levels);   // populate MANIFEST + PRELOAD_GROUPS in place
  const maxLevel = levels.length;

  // The player profile (identity, progress, wallet, settings). One object, saved
  // through a platform storage adapter (localStorage on the web; FB/Reddit/Telegram
  // adapters swap in later). Everything the game persists lives here.
  const store = new UserStore();
  const user = await store.init();

  const loadingEl = document.getElementById("loading");
  await assets.preload(PRELOAD_GROUPS, (done, total) => {
    if (loadingEl) loadingEl.textContent = `Loading… ${Math.round((done / total) * 100)}%`;
  });

  // Shared, live maps the scenes read from (mutated in place as groups load).
  const backgrounds = assets.backgrounds;

  // ---- scenes --------------------------------------------------------------
  // The player is on a given level (persisted in the User profile). The lobby is
  // the landing screen on load and after each win; its centred "Level <n>" button
  // starts play.
  let currentLevel = user.progress.level;

  // The payment provider for real-money coin purchases (mock on the open web; FB /
  // Telegram / Reddit providers swap in later — see user/payments.js).
  const payments = makePayments(store.platform);

  // Coin prices for in-level consumable purchases (buying a helper when its stock
  // hits 0). Kept in a JSON config so they're tunable without touching code; on a
  // fetch failure we fall back to no prices (purchases simply stay unavailable).
  let prices = { boosters: {} };
  try { prices = await fetch("assets/config/prices.json").then((r) => r.json()); }
  catch (_) { /* keep the empty default */ }

  // Fortune Wheel prize table + constants (groups, both odds sets, unlock level,
  // spins per cycle). Same defensive load as prices.json — a failure leaves the
  // wheel with no groups, so its lobby button simply stays hidden.
  let turntable = null;
  try { turntable = await fetch("assets/config/turntable.json").then((r) => r.json()); }
  catch (_) { /* keep null — FortuneWheelScene falls back to safe defaults */ }

  // Daily Bonus prize pool + unlock level. Same defensive load — a failure leaves
  // the scene with no prizes, so its lobby button (which gates on canClaim, and
  // canClaim requires a non-empty pool) simply stays hidden.
  let dailybonus = null;
  try { dailybonus = await fetch("assets/config/dailybonus.json").then((r) => r.json()); }
  catch (_) { /* keep null — DailyBonusScene falls back to safe defaults */ }

  const scene = new GameScene(app, tileTextures, slotTexture, backgrounds, audio, user, prices);
  const lobby = new LobbyScene(app, backgrounds, audio, maxLevel, user);
  const settings = new SettingsScene(app, audio);
  const shop = new ShopScene(app, audio, user, payments);
  const wheel = new FortuneWheelScene(app, audio, user, turntable);
  const daily = new DailyBonusScene(app, audio, user, dailybonus);
  root.addChild(scene, lobby, settings, shop, wheel, daily); // overlays draw on top of whichever scene is active

  // Fit the viewport: size the renderer to the window, scale the stage so the
  // constraining dimension fills exactly, then hand each scene the resulting
  // design area (DW×DH, one dimension ≥ its nominal) to reflow into.
  resize = () => {
    const vw = window.innerWidth, vh = window.innerHeight;
    const scale = Math.min(vw / DESIGN_W, vh / DESIGN_H);
    const DW = vw / scale, DH = vh / scale;
    app.renderer.resize(vw, vh);
    root.scale.set(scale);
    scene.layout(DW, DH);
    lobby.layout(DW, DH);
    settings.layout(DW, DH);
    shop.layout(DW, DH);
    wheel.layout(DW, DH);
    daily.layout(DW, DH);
  };
  resize();

  // The cog button in either scene opens the settings overlay; Back just hides it,
  // returning to whatever scene is underneath.
  lobby.onSettings = () => settings.open();
  scene.onSettings = () => settings.open();

  // Tapping the coin pill in either scene opens the shop overlay.
  lobby.onShop = () => shop.open();
  scene.onShop = () => shop.open();

  // The fortune-wheel lobby button opens the wheel overlay; the lobby reads the
  // wheel's unlock level + daily spins-left to gate its button.
  lobby.fortuneWheel = wheel;
  lobby.onFortuneWheel = () => wheel.open();
  wheel.onBack = () => {}; // just hides — the lobby is underneath

  // The daily-bonus lobby button opens the gift overlay; the lobby reads the
  // scene's unlock level + canClaim() to gate (and pulse) its button.
  lobby.dailyBonus = daily;
  lobby.onDailyBonus = () => daily.open();
  daily.onBack = () => {}; // just hides — the lobby is underneath

  // Check the daily rollover continuously while running, so a player left open
  // across midnight gets their new cycle (fresh group + free spin) without a
  // restart. checkRollover emits "fortuneWheel", refreshing the lobby button and an
  // open wheel. Cheap, so a few-second cadence is plenty.
  let _rollAcc = 0;
  app.ticker.add(() => {
    _rollAcc += app.ticker.deltaMS;
    if (_rollAcc >= 4000) {
      _rollAcc = 0;
      wheel.checkRollover();
      // The daily-bonus button reappears purely because the calendar day changed
      // (no user-state mutation fires), so refresh it here too — a lobby left open
      // across midnight re-shows the gift live, like the wheel's fresh free spin.
      lobby._refreshDailyBtn();
    }
  });

  // Real-money package purchase: run the platform payment provider, and only grant
  // the contents here (the trusted host) on success — a coins credit plus any
  // boosters in the package. A real integration validates the receipt server-side
  // before this point (see user/payments.js). The resulting wallet/booster changes
  // autosave and refresh the shop + coin pills + helper badges automatically.
  async function purchasePackage(productId) {
    try {
      const res = await payments.purchase(productId);
      if (res && res.ok) {
        if (res.coins) user.credit("coins", res.coins);
        for (const [kind, n] of Object.entries(res.boosters || {})) user.grantBooster(kind, n);
      }
      return res;
    } catch (_) { return { ok: false }; } // cancelled / failed — nothing changes
  }
  shop.onBuyPackage = (productId) => purchasePackage(productId);

  // Back button inside the level: stop play and return to the lobby at the level
  // the player is on. The User record is untouched here, so anything changed
  // during the level (progress, wallet, settings) has already autosaved and
  // persists across the transition.
  scene.onExit = () => showLobby(currentLevel);

  function showLobby(level, opts) {
    scene.visible = false;
    lobby.show(level, opts);
  }
  async function startLevel(level) {
    // Lazy-load this level's assets if they weren't part of the preload set
    // (levels 1–3 are already in memory, so this resolves instantly for them).
    if (assets.hasLevel(level) && !assets.levelData(level)) {
      if (loadingEl) { loadingEl.textContent = "Loading…"; loadingEl.style.display = "flex"; }
      try { await assets.ensureLevel(level); }
      finally { if (loadingEl) loadingEl.style.display = "none"; }
    }
    const data = assets.levelData(level);
    if (!data) return;
    lobby.hide();
    scene.visible = true;
    scene.loadLevel(data, level);
  }

  lobby.onPlay = (level) => startLevel(level);

  scene.onLevelComplete = (completed) => {
    // advance to the next level (capped) and return to the lobby
    currentLevel = Math.min(completed + 1, maxLevel);
    user.setLevel(currentLevel); // emits change -> UserStore autosaves
    showLobby(currentLevel, { celebrate: true });
  };

  // land on the lobby at the player's saved level
  showLobby(currentLevel);

  // Apply the persisted music/sound preferences (without re-persisting them),
  // then wire any later change back into the User profile (which autosaves).
  audio.setMusic(user.settings.music, { persist: false });
  audio.setSound(user.settings.sound, { persist: false });
  audio.onMusicChange = (on) => user.setMusic(on);
  audio.onSoundChange = (on) => user.setSound(on);

  // Background music for the lobby. Select the track now (it plays immediately
  // if the browser permits autoplay). Browsers gate audio behind a user gesture,
  // so also arm listeners that resume the context on the first interaction —
  // any pointer / touch / mouse / key event, anywhere on the page. We keep the
  // listeners until the context is confirmed running, so a gesture the browser
  // doesn't honour (or one made while muted) simply retries on the next one.
  audio.playBgm("Game_bgm");
  const gestureEvents = ["pointerdown", "mousedown", "touchstart", "click", "keydown"];
  const unlockAudio = () => {
    // unlock() resumes synchronously within the gesture; remove the listeners
    // only once the context is confirmed running (or the player has muted).
    audio.unlock().then(() => {
      if (audio.isRunning() || audio.muted) {
        gestureEvents.forEach((ev) => window.removeEventListener(ev, unlockAudio, true));
      }
    });
  };
  gestureEvents.forEach((ev) => window.addEventListener(ev, unlockAudio, true));

  // Silence audio while the tab is hidden (switched to another tab / minimised)
  // and restore it on return — without altering the player's music/sound settings.
  document.addEventListener("visibilitychange", () => {
    audio.setPageVisible(document.visibilityState === "visible");
  });

  if (loadingEl) loadingEl.style.display = "none";

  // ---- test / debug API (used by the headless verification driver) ---------
  window.__game = {
    app, scene, lobby, settings, assets, audio, store,
    openSettings: () => settings.open(),
    settingsVisible: () => settings.visible,
    currentLevel: () => currentLevel,
    inLobby: () => lobby.visible,
    // Responsive-fit info: the design area the scenes reflow into and how the
    // renderer maps onto the viewport (used by the orientation/fit test).
    view: () => ({
      vw: window.innerWidth, vh: window.innerHeight,
      canvasW: app.view.width, canvasH: app.view.height,
      rootScale: root.scale.x,
      designW: scene.viewW, designH: scene.viewH,
      ox: scene.ox, oy: scene.oy,
      boardCX: scene.boardCX, boardCY: scene.boardCY,
    }),
    // Bounds of every independent, currently-visible interface control, in
    // DESIGN-SPACE units (0..designW × 0..designH), aggregated across whichever
    // scenes/overlays are visible. Each scene exposes a controls() listing its
    // top-level controls; here we measure each with getBounds() (logical screen
    // px) and divide by root.scale to get design units. Used by the
    // resize/overlap regression test to assert no control leaves the view or
    // overlaps another. Skips controls with empty bounds (e.g. an empty board).
    controls: () => {
      const s = root.scale.x || 1;
      const out = [];
      const add = (sceneName, sc) => {
        if (!sc || !sc.visible || typeof sc.controls !== "function") return;
        for (const { name, obj } of sc.controls()) {
          if (!obj || !obj.visible) continue;
          const b = obj.getBounds();
          if (!b.width || !b.height) continue;
          out.push({
            scene: sceneName, name,
            x: b.x / s, y: b.y / s, w: b.width / s, h: b.height / s,
          });
        }
      };
      // Base scene first (only one of lobby/level is visible at a time), then any
      // open overlay on top.
      add("lobby", lobby);
      add("level", scene);
      add("settings", settings);
      add("shop", shop);
      add("wheel", wheel);
      add("daily", daily);
      return out;
    },
    // Tray sizing: the per-level slot size, the on-screen board tile size it
    // tracks (TILE_DRAW * boardScale), and the clamp bounds (used by tray_size test).
    traySize: () => ({
      slot: scene.slot,
      tileOnScreen: 96 * scene.boardScale, // TILE_DRAW * boardScale
      boardScale: scene.boardScale,
      slotMin: 56, slotMax: (750 - 2 * 24 - 2 * 18 - 6 * 6) / 7,
      panelW: scene.trayPanel.width,
      slotXs: scene.slotPositions.map((p) => p.x),
    }),
    lobbyButtonText: () => lobby.playBtn.label.text,
    startLevel,
    exitLevel: () => scene.onExit && scene.onExit(),
    reshuffle: () => scene.reshuffle(),
    wand: () => scene.wand(),
    // Which tiles the Wand would pull next (a pure read of _wandPick), each with
    // its availability — free/available (aliveCovers 0, top layer) vs covered/
    // unavailable. Lets tests assert the availability-first waterfall without
    // relying on animation timing. null when the board is empty.
    wandPreview: () => {
      const pick = scene._wandPick();
      if (!pick) return null;
      return {
        type: pick.type,
        tiles: pick.tiles.map((t) => ({ id: t.id, cov: t.aliveCovers, free: t.aliveCovers === 0 })),
      };
    },
    autoComplete: () => scene.autoComplete(),
    autoState: () => ({
      available: scene._autoAvailable(),
      total: scene.boardCount + scene.tray.length,
      covered: scene.tiles.filter((t) => !t.inTray && !t.matched && t.aliveCovers > 0).length,
      boardCount: scene.boardCount,
      autoVisible: scene.autoBtn.visible,
      helpersVisible: scene.undoBtn.visible,
    }),
    playSound: (name) => audio.play(name),
    soundNames: () => Object.keys(audio.buffers),
    manifest: MANIFEST,
    loadedGroups: () => [...assets._loaded],
    audioState: () => ({
      music: audio.musicOn,
      sound: audio.soundOn,
      muted: audio.muted,
      bgmStarted: !!audio._bgmSource,
      ctx: audio._ctx ? audio._ctx.state : "none",
    }),
    // ---- user profile (identity / progress / wallet / settings) ----
    user: () => store.user.toJSON(),
    setLevel: (n) => { currentLevel = Math.max(1, Math.min(n, maxLevel)); user.setLevel(currentLevel); },
    balance: (cur) => user.balance(cur),
    credit: (cur, n) => user.credit(cur, n),
    debit: (cur, n) => user.debit(cur, n),
    // ---- shop / coins UI ----
    openShop: () => shop.open(),
    shopVisible: () => shop.visible,
    coinPillText: () => ({ lobby: lobby.coinPill.label.text, game: scene.coinPill.label.text }),
    packages: () => payments.getCatalog(),
    // Buy a package via the payment provider; grants its contents (coins +
    // boosters). Returns a promise resolving to the post-purchase profile snapshot.
    buyPackage: async (productId) => {
      await purchasePackage(productId);
      return { coins: user.balance("coins"), boosters: user.toJSON().boosters };
    },
    // ---- fortune wheel ----
    openWheel: () => wheel.open(),
    wheelVisible: () => wheel.visible,
    // Take a spin (returns the promise that resolves once it settles + collects).
    spinWheel: () => wheel.spin(),
    // Press the on-screen spin button (exercises the button hit path).
    pressWheelSpin: () => wheel._spinBtn.emit("pointertap"),
    wheelState: () => ({
      unlocked: user.progress.level >= wheel.unlockLevel,
      buttonVisible: lobby.wheelBtn.visible,
      group: user.wheelGroup(),
      spinsUsed: user.wheelSpinsUsed(),
      spinsLeft: wheel.spinsPerCycle - user.wheelSpinsUsed(),
      won: user.wheelWon(),
      seen: user.wheelSeen(),
      spinning: wheel._spinning,
      overlayOpen: wheel.visible,
      canSpin: wheel.canSpin(),
      slices: wheel.currentPrizes().length,
      day: user.wheelDay(),
    }),
    wheelBadges: () => ({
      new: lobby.wheelBtn.newBadge.visible && lobby.wheelBtn.visible,
      free: lobby.wheelBtn.freeBadge.visible && lobby.wheelBtn.visible,
    }),
    // Force the day-key and re-check the rollover (day-rollover tests).
    setWheelToday: (key) => { wheel._todayOverride = key; wheel.checkRollover(); },
    // Pin the next winning slice index (deterministic prize tests).
    forceWheelPrize: (index) => { wheel._forceIndex = index; },
    // Force the ad-spin outcome: "succeed" | "cancel" | "fail".
    setWheelAdResult: (mode) => { wheel._adResult = mode; },
    // ---- daily bonus ----
    openDailyBonus: () => daily.open(),
    dailyBonusVisible: () => daily.visible,
    // Tap a box open (returns the promise that resolves once it reveals).
    pickDailyBox: (i) => daily._openBox(i),
    // Take the revealed prize as-is (x1) / after watching the double-it ad (x2).
    takeDailyBonus: () => daily._take(1),
    doubleDailyBonus: () => daily._double(),
    // Press the on-screen buttons (exercises the button hit path).
    pressDailyDouble: () => daily._doubleBtn.emit("pointertap"),
    pressDailyClaim: () => daily._claimBtn.emit("pointertap"),
    dailyBonusState: () => ({
      unlocked: user.progress.level >= daily.unlockLevel,
      buttonVisible: lobby.dailyBtn.visible,
      canClaim: daily.canClaim(),
      lastDay: user.dailyBonusLastDay(),
      overlayOpen: daily.visible,
      opened: daily._opened,
      chosen: daily._chosen,
      doubled: daily._doubled,
      taken: daily._taken,
      day: daily._today(),
      prizes: (daily._prizes || []).map((p) => (p ? { type: p.type, amount: p.amount } : null)),
    }),
    // Force the day-key (rollover tests) — also refresh the lobby gift button.
    setDailyToday: (key) => { daily._todayOverride = key; lobby._refreshDailyBtn(); },
    // Pin the prize behind every box (deterministic prize tests).
    forceDailyPrize: (index) => { daily._forceIndex = index; },
    // Trigger the lobby gift's periodic hop immediately (its idle timer is
    // frame-rate bound, so a wall-clock wait is unreliable under CPU load).
    forceDailyHop: () => { if (lobby.dailyBtn) lobby.dailyBtn._hopNow = true; },
    // Force the double-it ad outcome: "succeed" | "cancel" | "fail".
    setDailyAdResult: (mode) => { daily._adResult = mode; },
    // ---- helper (booster) inventory ----
    boosterCount: (kind) => user.boosterCount(kind),
    grantBooster: (kind, n) => user.grantBooster(kind, n),
    // Coin price to buy one of a helper when its stock is empty (from prices.json).
    boosterPrice: (kind) => scene._boosterPrice(kind),
    boosterState: () => ({
      undoUsable: scene.undoBtn.eventMode === "static",
      shuffleUsable: scene.shuffleBtn.eventMode === "static",
      wandUsable: scene.wandBtn.eventMode === "static",
      // greyed-out appearance (alpha < 1) — mirrors "usable" so the look matches
      // whether a tap actually does anything.
      undoDimmed: scene.undoBtn.alpha < 1,
      shuffleDimmed: scene.shuffleBtn.alpha < 1,
      wandDimmed: scene.wandBtn.alpha < 1,
      undoBadge: scene.undoBadge.text.text,
      shuffleBadge: scene.shuffleBadge.text.text,
      wandBadge: scene.wandBadge.text.text,
      // Acquisition tier shown on each helper: "stock" (own ≥1) / "buy" (afford with
      // coins) / "ad" (out of stock & coins -> watch an ad).
      undoMode: scene.undoBtn._boosterMode,
      shuffleMode: scene.shuffleBtn._boosterMode,
      wandMode: scene.wandBtn._boosterMode,
    }),
    // ---- out-of-moves / continue overlay ----
    // Coin price to continue a lost round (from prices.json "continue"; null if
    // unconfigured -> Continue always falls back to the free ad tier).
    continuePrice: () => scene.continuePrice,
    loseState: () => ({
      overlayCount: scene.overlayLayer.children.length,
      loseOverlay: !!scene._loseBtns, // the Out-of-Moves overlay is up
      // Which pay tier the Continue button offers: "coins" (afford the price) or
      // "ad" (can't afford -> watch a rewarded ad for a free continue).
      continueMode: scene._loseBtns ? scene._loseBtns.cont._payMode : null,
      // The dim swallows taps (modal) — nothing behind the overlay is tappable.
      dimModal: !!scene._overlayDim && scene._overlayDim.eventMode === "static",
    }),
    // Tray placement order (tile ids, oldest-first) and the order tiles flew back
    // to the board on the last Continue (newest-first — reverse placement order).
    historyOrder: () => scene.history.map((t) => t.id),
    returnOrder: () => scene._lastReturnOrder || null,
    pressLoseContinue: () => scene._loseBtns && scene._loseBtns.cont.emit("pointertap"),
    pressLoseHome: () => scene._loseBtns && scene._loseBtns.home.emit("pointertap"),
    pressLoseReplay: () => scene._loseBtns && scene._loseBtns.replay.emit("pointertap"),
    setMusic: (on) => audio.setMusic(on),
    setSound: (on) => audio.setSound(on),
    setMuted: (m) => audio.setMuted(m),
    setPageVisible: (v) => audio.setPageVisible(v),
    flushSave: () => store._flush(),
    reset: () => store.reset(),
    state: () => ({
      level: scene.levelNum,
      boardCount: scene.boardCount,
      tray: scene.tray.map((t) => t.type),
      locked: scene.locked,
      overlay: scene.overlayLayer.children.length > 0,
      inLobby: lobby.visible,
    }),
    freeTiles: () =>
      scene.tiles.filter((t) => !t.inTray && !t.matched && t.aliveCovers === 0)
        .map((t) => ({ id: t.id, type: t.type })),
    // tap the next not-yet-collected tile from the guaranteed solution order
    solveTap: () => {
      for (const id of scene.solutionOrder) {
        const t = scene.tiles[id];
        if (!t.inTray && !t.matched) {
          scene._onTapTile(t);
          return t.id;
        }
      }
      return -1;
    },
  };
}

boot().catch((e) => {
  console.error(e);
  const l = document.getElementById("loading");
  if (l) l.textContent = "Error: " + e.message;
});
