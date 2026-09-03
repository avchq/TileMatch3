import { GameScene } from "./game.js";
import { LobbyScene } from "./lobby.js";
import { SettingsScene } from "./settings.js";
import { ShopScene } from "./shop.js";
import { FortuneWheelScene } from "./fortunewheel.js";
import { DailyBonusScene } from "./dailybonus.js";
import { TasksScene } from "./tasks.js";
import { LevelChest } from "./levelchest.js";
import { makePayments } from "./user/payments.js";
import { makeTileTextures, makeSlotTexture, tilesFontReady, emojiPaints, TILE_EMOJIS } from "./icons.js";
import { AudioManager } from "./audio.js";
import { AssetManager, PRELOAD_GROUPS, MANIFEST, buildLevelGroups } from "./assets.js";
import { loadLevels } from "./levelConfig.js";
import { UserStore } from "./user/UserStore.js";
import { CONFIG } from "./config.js";
import { createSplash } from "./splash.js";
import { i18n, t, LANGUAGES, detectLanguage, mapTag, bcp47 } from "./i18n.js";
import { LanguagePickerScene } from "./languagepicker.js";

const DESIGN_W = 750;
const DESIGN_H = 1334;

// How the loading bar is divided between the boot stages below. Each stage
// finishes at its number, so the bar advances through the whole of boot() —
// not just the asset preload, the one stage that used to report anything. The
// preload gets the biggest slice because it is the only one that moves real
// bytes (audio + backgrounds + level data).
const P = {
  levels: 0.10,   // fetch the level table, build the asset manifest
  profile: 0.16,  // resolve identity + load the saved profile
  assets: 0.80,   // preload core audio + the preload-flagged levels
  configs: 0.88,  // prices / turntable / dailybonus
  scenes: 0.96,   // construct the scenes and lay them out
};

// A splash instance shared by boot() and its error handler.
const splash = createSplash();

async function boot() {
  splash.show("Starting up…");

  // LANGUAGE FIRST. Every scene builds its text in its constructor, so the
  // active language's string table has to be resident before any of them exist
  // — and before the splash writes its own status lines. This is also where the
  // one-and-only device-language detection happens on a brand-new player (see
  // src/i18n.js); from then on the stored `tm3.language` wins.
  // Say what stage this is BEFORE awaiting it: this is the first await in boot()
  // and it runs ahead of the renderer, so a slow language fetch would otherwise
  // look like a dead screen frozen at 0%. English, necessarily — there is no
  // table yet.
  splash.set(0.01, "Loading language…");
  await i18n.init();
  // The DOM wants a real BCP-47 tag, which the game's internal codes are not
  // (`jp`, `in`) — see bcp47() in src/i18n.js.
  document.documentElement.lang = bcp47(i18n.code);
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
  const tileTextures = await makeTileTextures(app.renderer, 128);
  const slotTexture = makeSlotTexture(120);

  // Network assets flow through the AssetManager: PRELOAD the essential minimum
  // (shared audio + levels 1–3), then LAZY-load any further level on demand.
  const audio = new AudioManager();
  const assets = new AssetManager(audio);

  // The level table (which levels exist, their bg/data/types/preload) — fetched
  // from JSON like the other configs, then used to build the asset manifest.
  // Essential config, so a failure is fatal (unlike prices/turntable below,
  // which degrade gracefully). The highest playable level is just its length.
  splash.set(0.02, t("loading_level_table"));
  const levels = await loadLevels();
  buildLevelGroups(levels);   // populate MANIFEST + PRELOAD_GROUPS in place
  const maxLevel = levels.length;
  splash.set(P.levels);

  // The player profile (identity, progress, wallet, settings). One object, saved
  // through a platform storage adapter (localStorage on the web; FB/Reddit/Telegram
  // adapters swap in later). Everything the game persists lives here.
  splash.set(P.levels, t("loading_profile"));
  const store = new UserStore();
  const user = await store.init();
  splash.set(P.profile);

  // The one stage that moves real bytes, so it gets the biggest slice of the
  // bar. AssetManager.preload already reports per-item completion; map that onto
  // the [profile, assets] range.
  splash.set(P.profile, t("loading_assets"));
  await assets.preload(PRELOAD_GROUPS, (done, total) => {
    splash.set(P.profile + (P.assets - P.profile) * (total ? done / total : 1));
  });
  splash.set(P.assets);

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
  splash.set(P.assets, t("loading_settings"));
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

  // The Tasks goal table (achievement chains + the weekly list). Same defensive
  // load — a failure leaves the scene with no goals, which makes hasTable() false
  // and so the lobby's Tasks button simply stays hidden.
  let tasksCfg = null;
  try { tasksCfg = await fetch("assets/config/tasks.json").then((r) => r.json()); }
  catch (_) { /* keep null — TasksScene falls back to empty lists */ }

  // The Level Chest schedule (50 milestones, each level + reward). Same defensive
  // load — a failure leaves an empty schedule, so the level-complete screen simply
  // shows no chest. Chest progress is derived from user.completedLevel(), not stored.
  let levelChestCfg = null;
  try { levelChestCfg = await fetch("assets/config/levelChest.json").then((r) => r.json()); }
  catch (_) { /* keep null — LevelChest falls back to an empty schedule */ }
  const levelChest = new LevelChest(levelChestCfg);
  splash.set(P.configs, t("loading_board"));

  const scene = new GameScene(app, tileTextures, slotTexture, backgrounds, audio, user, prices, levelChest);
  const lobby = new LobbyScene(app, backgrounds, audio, maxLevel, user, levelChest);
  const settings = new SettingsScene(app, audio);
  const shop = new ShopScene(app, audio, user, payments);
  const wheel = new FortuneWheelScene(app, audio, user, turntable);
  const daily = new DailyBonusScene(app, audio, user, dailybonus);
  const tasks = new TasksScene(app, audio, user, tasksCfg);
  const langPicker = new LanguagePickerScene(app, audio);
  root.addChild(scene, lobby, settings, shop, wheel, daily, tasks, langPicker); // overlays draw on top of whichever scene is active

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
    tasks.layout(DW, DH);
    langPicker.layout(DW, DH);
  };
  resize();

  // RE-LETTERING BROADCAST — the language-change twin of resize() above. Same
  // shape, same fixed list: when the picker's Confirm swaps the string table in,
  // every scene is told to rebuild the text it assembles in code ("Level 12",
  // a countdown, a task title). Labels that carry their own key re-letter
  // themselves inside i18n.refresh(), before this runs.
  //
  // Scenes are built once and kept for the whole session, so a screen that is
  // not visible right now still gets the call and simply reads correctly the
  // next time it is opened.
  const relocalize = () => {
    // The mapped tag, not the internal code — same reason as the boot path above.
    document.documentElement.lang = bcp47(i18n.code);
    scene.relocalize();
    lobby.relocalize();
    settings.relocalize();
    shop.relocalize();
    wheel.relocalize();
    daily.relocalize();
    tasks.relocalize();
    langPicker.relocalize();
  };
  i18n.onChange(relocalize);

  splash.set(P.scenes);

  // The cog button in either scene opens the settings overlay; Back just hides it,
  // returning to whatever scene is underneath.
  // The settings screen's Language row opens the picker over it; closing the
  // picker (either way) just reveals the settings screen again underneath.
  settings.onLanguage = () => langPicker.open();
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

  // The Tasks button on the lobby's right-edge rail opens the goals screen; the
  // lobby reads the scene's goal table + the profile's gate to decide whether to
  // offer the button at all, and its hasClaimable() to light the red dot.
  lobby.tasks = tasks;
  lobby.onTasks = () => tasks.open();
  tasks.onBack = () => {}; // just hides — the lobby is underneath

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
      // Same for the weekly task list: a screen left open across the Monday
      // boundary rolls the period over and re-arms every weekly goal live.
      tasks.checkRollover();
      // The daily-bonus button reappears purely because the calendar day changed
      // (no user-state mutation fires), so refresh it here too — a lobby left open
      // across midnight re-shows the gift live, like the wheel's fresh free spin.
      lobby.refreshFeatures();
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
        // A Tasks goal watches shop purchases (see src/tasks.js) — counted here
        // with the grant, so only a purchase that really succeeded counts.
        user.bumpStat("shopPurchases");
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
      splash.show(t("loading_level", level));
      try {
        await assets.ensureLevel(level, (done, total) => splash.set(total ? done / total : 1));
      } finally { splash.hide(); }
    }
    const data = assets.levelData(level);
    if (!data) return false;
    lobby.hide();
    scene.visible = true;
    // loadLevel resolves when the board has finished DEALING ITSELF IN (the
    // layer-by-layer opening in game.js) and is unlocked, so whoever started the
    // level — the lobby's Play button, or the test API — resumes on a board that
    // is complete and playable rather than one still arriving.
    await scene.loadLevel(data, level);
    return true;
  }

  lobby.onPlay = (level) => startLevel(level);

  scene.onLevelComplete = (completed) => {
    // record the clear (this is what ends the first-run flow: once level 1 is
    // completed the player is no longer "brand new"), advance to the next level
    // (capped) and return to the lobby
    user.completeLevel(completed);
    currentLevel = Math.min(completed + 1, maxLevel);
    user.setLevel(currentLevel); // emits change -> UserStore autosaves
    showLobby(currentLevel, { celebrate: true });
  };

  splash.set(1, t("loading_ready"));

  // Boot is done: release its hold on the splash and let it fade. This happens
  // BEFORE the first scene is put up — deliberately. Both branches below fill the
  // canvas within this same tick (nothing is rendered in between, so there is no
  // blank frame), and level 1's board deals itself in over the next few hundred
  // milliseconds: behind a splash still holding the screen, a new player would
  // miss the opening animation entirely.
  // Kept ahead of the window.__game assignment below, so a test that waits on
  // __game never finds the overlay still swallowing canvas taps.
  splash.hide();

  // First-run flow: a brand-new player (never played, no progress, never cleared
  // level 1) is dropped straight into level 1 — no lobby in the way. Everyone
  // else lands on the lobby at their saved level. Completing that first level
  // returns them to the lobby (onLevelComplete above), which is where they meet
  // it for the first time.
  // (If that first level can't be entered — assets missing — fall back to the
  // lobby rather than leaving the player on a blank screen.)
  const enteredFirstLevel = user.isNewPlayer() && (await startLevel(currentLevel));
  if (!enteredFirstLevel) showLobby(currentLevel);

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

  // ---- test / debug API (used by the headless verification driver) ---------
  // Rolling record of the SFX one-shots the audio manager actually emitted,
  // exposed below as soundLog()/clearSoundLog().
  // Production builds ship none of this. The `DEBUG:` label is not decoration:
  // `tools/build.py` passes `--drop-labels=DEBUG` to esbuild, which deletes the
  // whole labelled block from the bundle. That matters because this is a *cheat
  // console* — setLevel, completeLevel, the live config and direct scene handles
  // — and obfuscating the code while shipping this would be pointless.
  //
  // In raw source it is just a labelled block: dev and the entire test suite run
  // this file unmodified, so the API is there exactly as it always was.
  DEBUG: {
    const sfxLog = [];
    audio.onPlay = (name) => { if (sfxLog.length < 500) sfxLog.push(name); };

    window.__game = {
      app, scene, lobby, settings, assets, audio, store,
      openSettings: () => settings.open(),
      // ---- localization -------------------------------------------------------
      // The active language, the 13 the game offers, and the raw lookup — enough
      // for i18n_test.py to check that a swap really re-letters the live scenes
      // rather than only the table behind them.
      language: () => i18n.code,
      languages: () => LANGUAGES.map((l) => ({ code: l.code, label: l.label })),
      t: (key, ...values) => i18n.t(key, ...values),
      hasKey: (key) => i18n.has(key),
      // Every key looked up this session that the active language does not have.
      // A miss is not an error — the key itself is what goes on screen — so this
      // is the only record of one; i18n_test.py walks every screen and asserts it
      // stays empty.
      missingKeys: () => i18n.missingKeys(),
      clearMissingKeys: () => i18n.clearMissing(),
      // What the device-language detection would pick right now, and what is
      // actually stored. Detection runs ONCE, so after the first launch these two
      // can legitimately disagree.
      detectLanguage: () => detectLanguage(),
      mapTag: (tag) => mapTag(tag),
      storedLanguage: () => i18n.stored(),
      // A code as a valid BCP-47 tag — what <html lang> is set to. Defaults to
      // the active language; pass a code to check the mapping for any of the 13.
      languageTag: (code) => bcp47(code || i18n.code),
      // Every language resident in memory. Nothing unloads them, so this grows as
      // the player visits languages (see the README's Localization notes).
      loadedLanguages: () => i18n.loaded().slice().sort(),
      // Change language the way Confirm does: download, swap, re-letter, remember.
      // Resolves to true when the swap actually happened.
      setLanguage: (code) => i18n.setLanguage(code),
      // ---- the language picker ------------------------------------------------
      languagePicker: langPicker,
      openLanguagePicker: () => langPicker.open(),
      closeLanguagePicker: () => langPicker._close(),
      languagePickerVisible: () => langPicker.visible,
      // `picked` is the ticked row, which is NOT applied until confirmLanguage().
      languagePickerState: () => ({
        visible: langPicker.visible,
        picked: langPicker.picked(),
        active: i18n.code,
        codes: LANGUAGES.map((l) => l.code),
        labels: LANGUAGES.map((l) => l.label),
        pickedVisible: langPicker.rowVisible(langPicker.picked()),
        scroll: langPicker.scrollState(),
      }),
      // Panel-local rects of the picker's panel, list viewport and footer buttons,
      // so a test can assert the list ends clear above Confirm.
      languagePickerGeometry: () => langPicker.geometry(),
      tapLanguageRow: (code) => langPicker.pick(code),
      confirmLanguage: () => langPicker._confirm(),
      // The settings screen's Language row, as it reads on screen.
      languageRowText: () => ({
        label: settings.languageRow.children[0].text,
        value: settings.languageRow.value.text,
      }),
      settingsVisible: () => settings.visible,
      currentLevel: () => currentLevel,
      inLobby: () => lobby.visible,
      // The central tuning config (src/config.js) exactly as the game loaded it:
      // every feature gate, unlock level, grant and economy amount. config_test.py
      // reads it and asserts the live game really behaves the way it says.
      config: () => CONFIG,
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
        add("tasks", tasks);
        add("language", langPicker);
        return out;
      },
      // Tray sizing: the per-level slot size, the on-screen board tile size it
      // tracks (TILE_DRAW * boardScale), and the clamp bounds (used by tray_size
      // test). `slots` is how many cells are DRAWN and `capacity` how many the tray
      // can hold — the two differ while the 8th slot's "+1" offer is still up. The
      // clamp bounds come off the scene rather than being re-derived here, since the
      // upper one depends on the cell count.
      traySize: () => ({
        slot: scene.slot,
        tileOnScreen: 96 * scene.boardScale, // TILE_DRAW * boardScale
        boardScale: scene.boardScale,
        slotMin: scene.slotMin(), slotMax: scene.slotMax(),
        panelW: scene.trayPanel.width,
        slots: scene.traySlotsDrawn,
        capacity: scene.traySlots,
        slotXs: scene.slotPositions.map((p) => p.x),
      }),
      // ---- the 8th tray slot (ad-funded, one per level) ----
      // `drawn` is whether the extra CELL exists (a campaign-progress gate),
      // `offered` whether the "+1" button is on it (only while capacity is still
      // base), and `capacity` what the tray can actually hold right now — the three
      // are deliberately distinct, since the cell appears before it is usable.
      extraSlotState: () => {
        if (!scene) return { unlockLevel: 0, unlocked: false, drawn: false, offered: false,
          capacity: 0, baseCapacity: 0, taken: false, btnVisible: false, btnX: 0, btnY: 0 };
        return {
          unlockLevel: CONFIG.board.extraSlot.unlockLevel,
          unlocked: user.isExtraSlotUnlocked(),
          drawn: scene.traySlotsDrawn > CONFIG.board.traySlots,
          offered: scene._extraSlotOffered(),
          takeable: scene._extraSlotTakeable(),
          capacity: scene.traySlots,
          baseCapacity: CONFIG.board.traySlots,
          taken: scene.traySlots > CONFIG.board.traySlots,
          btnVisible: scene.extraBtn.visible,
          btnX: scene.extraBtn.x,
          btnY: scene.extraBtn.y,
        };
      },
      // Press the "+1" the way a finger does, so the live-play guard is exercised
      // rather than bypassed.
      pressExtraSlot: () => scene.extraBtn.emit("pointertap"),
      // Force the outcome of the extra slot's rewarded video: "succeed" | "cancel"
      // | "fail" (parallels setWheelAdResult / setDailyAdResult).
      setExtraSlotAdResult: (mode) => { scene._extraSlotAdResult = mode; },
      // The tray's pressure warnings, both measured against the LIVE capacity: how
      // many slots are free, whether the tray is pulsing, and the floating message
      // currently up ("Insufficient space!" / the ad refusal), "" when none.
      trayWarning: () => ({
        free: Math.max(0, scene.traySlots - scene.tray.length),
        capacity: scene.traySlots,
        pulsing: !!scene._trayPulse,
        message: scene._trayMessage ? scene._trayMessage.__text : "",
      }),
      lobbyButtonText: () => lobby.playBtn.label.text,
      // The lobby's feature-button rail: slot assignment + live geometry of every
      // entry, in design units. `moving` is true while a slide/fade is in flight,
      // so a test can assert a reflow is animated without sampling on a stopwatch.
      // -> [{ key, available, slot, x, y, targetY, visible, alpha, moving }]
      // `side` picks which rail: "left" (default — Free Spin / Daily Bonus) or
      // "right" (Tasks). Defaulted so existing callers keep meaning the left one.
      featureRail: (side) => (side === "right" ? lobby.railRight : lobby.rail).slots(),
      startLevel,
      // Leave the level the way the Back button does — through the scene's single
      // exit path, so the guidance hand / booster hint / tutorial popup are torn
      // down rather than left behind on a hidden scene.
      exitLevel: () => scene._exit(),
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
      // ---- the Super Wand (the Wand's win-streak upgrade) ----
      superWand: () => scene.superWand(),
      // What the sweep would clear next: a pure read of _superWandPick, with each
      // set's colour, how many were already waiting in the tray (`have`) and how
      // many it would pull (`need`), plus the availability of every pulled tile.
      // Lets a test assert the cheapest-first ordering, the whole-sets rule and the
      // availability-first draw without relying on animation timing. null when
      // nothing at all can be completed.
      superWandPreview: () => {
        const p = scene._superWandPick();
        if (!p) return null;
        const tile = (t) => ({ id: t.id, cov: t.aliveCovers, free: t.aliveCovers === 0 });
        return {
          total: p.sets.length * 3,
          sets: p.sets.map((s) => ({
            type: s.type, need: s.need, have: s.have, tiles: s.tiles.map(tile),
          })),
          tiles: p.tiles.map(tile),
        };
      },
      superWandState: () => ({
        unlocked: user.isSuperWandUnlocked(),
        unlockLevel: CONFIG.boosters.superWand.unlockLevel,
        streak: user.superWandStreak(),
        needed: CONFIG.boosters.superWand.streakLength,
        charged: user.superWandCharged(),
        announced: !user.superWandNeedsAnnounce(),
        // Is the shared button in its upgraded mode right now?
        active: scene._superWandActive(),
        running: !!scene._superWandRunning,
        // "super" | "stock" | "buy" | "ad" | "locked" — the same seam the other
        // helpers report through, so the takeover is visible to boosterState too.
        mode: scene.wandBtn._boosterMode,
        icon: scene.wandBtn.label.text,
        badge: scene.wandBadge.text.text,
        usable: scene.wandBtn.eventMode === "static",
      }),
      // Charge one WITHOUT grinding five levels, through the real mutator (so the
      // unlock gate still applies and the change event still fires).
      chargeSuperWand: () => {
        for (let i = 0; i < CONFIG.boosters.superWand.streakLength; i++) user.recordSuperWandWin();
        return user.superWandCharged();
      },
      // One counted win, same path a real level clear takes.
      superWandWin: () => user.recordSuperWandWin(),
      // The streak bar on the win overlay (and its "at risk" twin on the lose
      // overlay). Shaped like chestState(): a zero object when none is up.
      superWandBar: () => ({ ...(scene._superWandBar || { shown: false }) }),
      // The lobby rail's Super Wand read-out: its gate, where the rail parked it,
      // and the face it is wearing. `label` is the pill text ("3/5"); `charged`
      // is the gold/upgraded look. Shaped like featureRail()'s entries so a test
      // can assert the slot and the copy from one call.
      // The Super Wand promo — the modal the rail read-out opens. `open` it by
      // hand, or drive the real path with pressSuperWandRail().
      superWandPromo: () => lobby.superWandPromo.state(),
      openSuperWandPromo: () => lobby.superWandPromo.open(),
      closeSuperWandPromo: () => lobby.superWandPromo.close(),
      // A real tap on the rail's read-out, through its own pointer handler.
      pressSuperWandRail: () => lobby.superWandBtn.emit("pointertap"),
      superWandRail: () => {
        const b = lobby.superWandBtn;
        return {
          available: lobby.featureAvailable("superWand"),
          visible: b.visible,
          y: b.y, alpha: b.alpha,
          label: b.label.text,
          icon: b.icon.text,
          charged: !!b._charged,
        };
      },
      autoComplete: () => scene.autoComplete(),
      autoState: () => ({
        available: scene._autoAvailable(),
        level: scene.levelNum,
        total: scene.boardCount + scene.tray.length,
        covered: scene.tiles.filter((t) => !t.inTray && !t.matched && t.aliveCovers > 0).length,
        boardCount: scene.boardCount,
        autoVisible: scene.autoBtn.visible,
        helpersVisible: scene.undoBtn.visible,
      }),
      playSound: (name) => audio.play(name),
      soundNames: () => Object.keys(audio.buffers),
      // Names of the one-shots actually emitted since the last clearSoundLog(),
      // so a test can assert *when* a cue fires (and how many times) rather than
      // just that the file loads. Capped so a long session can't grow it forever.
      soundLog: () => sfxLog.slice(),
      clearSoundLog: () => { sfxLog.length = 0; },
      manifest: MANIFEST,
      loadedGroups: () => [...assets._loaded],
      // Tile-face readiness (regression guard for the iOS "white tiles, no fruit"
      // bug): whether the emoji font was confirmed warm before the faces were
      // rasterized (`fontsReady`), and, per tile type, whether its fruit emoji
      // actually painted (`painted[i]`) — sampled from each texture's 2D source
      // canvas. NB the raw iOS timing failure can't be reproduced in headless
      // Chromium; this asserts the fix's ordering invariant and non-blank content.
      tileFaces: () => ({
        fontsReady: tilesFontReady(),
        types: tileTextures.length,
        painted: TILE_EMOJIS.map((e) => emojiPaints(app.renderer, e, 128)),
      }),
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
      // ---- first-run flow ----
      // Is this profile still "brand new" (never played, no progress, level 1 not
      // cleared)? Such a player is sent straight into level 1 on boot.
      isNewPlayer: () => user.isNewPlayer(),
      completedLevel: () => user.completedLevel(),
      // Mark the profile as a returning player (used by tests that need to boot
      // into the lobby rather than the first-run level). Also pays out any helper
      // unlocks that come due, exactly as winning the level would.
      completeLevel: (n) => user.completeLevel(n),
      // Is the level currently on screen the guided first one (stripped chrome +
      // the demo opening moves)?
      firstRun: () => !!scene._firstRun,
      // Which pieces of the level's top bar are showing. On the guided first level
      // it's the coin counter alone — no cog, no shop, no Back.
      hudState: () => ({
        cog: scene.cog.visible,
        back: scene.backBtn.visible,
        coinPill: scene.coinPill.visible,
        shopEnabled: scene.coinPill.eventMode === "static",
      }),
      // ---- the "How To Play" popup ----
      // Everything a test needs about the tutorial that opens on every entry into
      // level 1: its copy, how far the staged fade-in has got (`introDone` arms
      // tap-anywhere-to-close), its buttons (there is no skip), and the state of the
      // looping demonstration (types in its mini tray / tiles left on its mini board).
      tutorialState: () => {
        const t = scene._tutorial;
        if (!t || t.destroyed) {
          return { visible: false, title: "", line: "", introDone: false, okVisible: false,
            rowsShown: 0, buttons: [], demoTray: [], demoBoard: 0, cx: 0, cy: 0, dimW: 0, dimH: 0 };
        }
        const demo = t.demoState();
        const dim = t.dim.getLocalBounds();
        return {
          visible: t.visible && !t.closing,
          title: t.titleText.text,
          line: t.lineText.text,
          introDone: t.introDone,
          okVisible: t.okBtn.alpha > 0.5,
          rowsShown: t.rowsShown,
          buttons: t.buttonLabels(),
          demoTray: demo.tray,
          demoBoard: demo.board,
          cx: t.group.x, cy: t.group.y, dimW: dim.width, dimH: dim.height,
        };
      },
      // The two real close paths (button / tap anywhere), through the pointer path.
      pressTutorialOk: () => scene._tutorial && scene._tutorial.okBtn.emit("pointertap"),
      tapTutorialDim: () => scene._tutorial && scene._tutorial.dim.emit("pointertap"),
      // Dismiss it outright — a no-op when none is up. Every test that drives level 1
      // calls this once after entering, since the popup is modal.
      closeTutorial: () => { if (scene._tutorial) scene._tutorial.close(); },
      // The "tutorial done" marker the popup writes on close. Nothing in the game
      // reads it back (the popup is gated on the level number) — only this test hook.
      tutorialMarker: () => localStorage.getItem("tm3.tutorialDone"),
      // The guidance hand: which tile it points at, if it's up at all.
      handState: () => (scene._hand
        ? { visible: true, tileId: scene._hand.__tileId, x: scene._hand.x, y: scene._hand.y }
        : { visible: false, tileId: -1, x: 0, y: 0 }),
      balance: (cur) => user.balance(cur),
      credit: (cur, n) => user.credit(cur, n),
      debit: (cur, n) => user.debit(cur, n),
      // ---- shop / coins UI ----
      // The shop's progression gate (CONFIG.features.shop.unlockLevel) and how each scene's coin
      // pill reflects it: `enabled` is the live cart affordance (cart badge shown +
      // taps accepted), which the guided first level also suppresses on its own.
      shopState: () => ({
        unlocked: user.isShopUnlocked(),
        unlockLevel: CONFIG.features.shop.unlockLevel,
        completed: user.completedLevel(),
        lobbyEnabled: lobby.coinPill.eventMode === "static",
        lobbyCart: lobby.coinPill.children.some((c) => c.text === "🛒" && c.visible),
        gameEnabled: scene.coinPill.eventMode === "static",
      }),
      // Tap the coin pill the way a player does — a no-op while the shop is locked.
      tapCoinPill: (where) => (where === "level" ? scene : lobby).coinPill.emit("pointertap"),
      openShop: () => shop.open(),
      closeShop: () => shop._back(),
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
        // Is the lobby button OFFERED. Not `wheelBtn.visible`: the feature rail
        // fades buttons in/out and holds an entering one back until the reflow
        // settles, so the raw flag lags the gate by up to half a second. Use
        // featureRail() for where the button actually is on screen.
        buttonVisible: lobby.featureAvailable("freeSpin"),
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
        new: lobby.wheelBtn.newBadge.visible && lobby.featureAvailable("freeSpin"),
        free: lobby.wheelBtn.freeBadge.visible && lobby.featureAvailable("freeSpin"),
      }),
      // Live wheel + pointer rotations (pointer-deflection animation tests).
      wheelPointer: () => ({ wheel: wheel.wheel.rotation, pointer: wheel.pointer.rotation }),
      // The spin-click sound bed: is it running, and at what playback rate (which
      // tracks the wheel's live speed). `loops` is the audio manager's total, so a
      // test can also see the bed was not left running after the wheel settled.
      wheelSpinSfx: () => ({
        active: !!wheel._spinSfx && !wheel._spinSfx.stopped,
        rate: wheel._spinSfx ? wheel._spinSfx.rate : 0,
        loops: audio._loops.size,
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
        buttonVisible: lobby.featureAvailable("dailyBonus"), // offered — see wheelState
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
      setDailyToday: (key) => { daily._todayOverride = key; lobby.refreshFeatures(); },
      // Pin the prize behind every box (deterministic prize tests).
      forceDailyPrize: (index) => { daily._forceIndex = index; },
      // Trigger the lobby gift's periodic hop immediately (its idle timer is
      // frame-rate bound, so a wall-clock wait is unreliable under CPU load).
      forceDailyHop: () => { if (lobby.dailyBtn) lobby.dailyBtn._hopNow = true; },
      // Force the double-it ad outcome: "succeed" | "cancel" | "fail".
      setDailyAdResult: (mode) => { daily._adResult = mode; },
      // ---- tasks / achievements ----
      openTasks: () => tasks.open(),
      closeTasks: () => tasks._close(),
      tasksVisible: () => tasks.visible,
      // Press the lobby button the way a player does (a no-op while it's hidden).
      pressTasksButton: () => lobby.tasksBtn.emit("pointertap"),
      tasksState: () => ({
        unlocked: user.isTasksUnlocked(),
        unlockLevel: CONFIG.features.tasks.unlockLevel,
        resetDay: CONFIG.features.tasks.weeklyResetDay,
        completed: user.completedLevel(),
        // Is the button OFFERED — the gate, not where a fade has got to (see wheelState).
        buttonVisible: lobby.featureAvailable("tasks"),
        // The red dot: anything, on either tab, finished and waiting to be collected.
        badge: lobby.tasksBtn.dot.visible,
        hasClaimable: tasks.hasClaimable(),
        overlayOpen: tasks.visible,
        // True from the moment a Claim is accepted until its reward has flown, been
        // granted and the row has left the list — so a test can wait on the flow
        // finishing instead of guessing at a sleep.
        busy: tasks._claiming,
        tab: tasks.tab(),
        week: user.taskWeek(),
        weekKey: tasks._weekKey(),
        note: tasks._note.text,
        emptyVisible: tasks._empty.visible,
        chains: tasks.achievements.length,
        weeklyGoals: tasks.weekly.length,
      }),
      // The rows currently rendered on a tab (defaults to the open one): what the
      // player can actually see, after the one-unfinished-tier-per-chain rule and
      // the claimable-first sort.
      tasksList: (tab) => tasks.rowsFor(tab || tasks.tab()),
      // Rows as laid out on screen right now (ids top-to-bottom) — distinct from
      // tasksList() only while a claimed row is still animating away.
      tasksRowIds: () => tasks._rows.map((r) => r.id),
      setTasksTab: (tab) => tasks.setTab(tab),
      scrollTasks: (y) => { tasks._setScroll(y); return tasks.scrollState(); },
      tasksScroll: () => tasks.scrollState(),
      // Claim through the real pointer path, so a row that isn't claimable (or a
      // drag that ended on the button) is refused exactly as it would be in play.
      pressTaskClaim: (id) => {
        const node = tasks._rowNodes.find((n) => n.__row && n.__row.id === id);
        return node && node.claimBtn ? node.claimBtn.emit("pointertap") : undefined;
      },
      // On-screen rect (client px) of a row's Claim button, so a test can drive a
      // real mouse gesture at it — the only way to prove a DRAG doesn't also claim.
      taskClaimRect: (id) => {
        const node = tasks._rowNodes.find((n) => n.__row && n.__row.id === id);
        if (!node || !node.claimBtn || !node.claimBtn.visible) return null;
        const b = node.claimBtn.getBounds();
        return { x: b.x, y: b.y, w: b.width, h: b.height };
      },
      // Lifetime counters, and a way to drive one without playing the game out.
      taskStats: () => ({ ...user.toJSON().tasks.stats }),
      taskStat: (a) => user.stat(a),
      weeklyStat: (a) => user.weeklyStat(a),
      bumpStat: (a, n) => user.bumpStat(a, n),
      taskClaimed: (id, weekly) => user.isTaskClaimed(id, !!weekly),
      // Force "now" / the week-key (weekly reset + countdown tests).
      setTasksNow: (iso) => { tasks._nowOverride = iso; tasks.checkRollover(); lobby.refreshFeatures(); },
      setTasksWeek: (key) => { tasks._weekOverride = key; tasks.checkRollover(); lobby.refreshFeatures(); },
      // ---- level chest ----
      // The chest state implied by having cleared up to `level` — index / filled /
      // needed / label / reward / full — straight from the schedule (no UI needed),
      // so a test can assert the maths across the whole 50-milestone table and its
      // looping tail without playing levels out.
      chestInfo: (level) => levelChest.infoFor(level),
      chestCount: () => levelChest.count,
      // What the win overlay is showing right now: whether a chest bar is up, its
      // label/reward, whether it opened, and where the reward popup has got to.
      chestState: () => ({ ...scene._chestState }),
      // Drive the reward popup: press its buttons on the real hit path, and pin the
      // double-it ad outcome ("succeed" | "cancel" | "fail"), mirroring the daily bonus.
      pressChestClaim: () => scene._chestClaimBtn && scene._chestClaimBtn.emit("pointertap"),
      pressChestDouble: () => scene._chestDoubleBtn && scene._chestDoubleBtn.emit("pointertap"),
      setChestAdResult: (mode) => { scene._chestAdResult = mode; },
      // The persistent Level Chest bar on the LOBBY: whether it's shown, its label,
      // and the resting "currently filling" chest it reflects (currentFor rolls a
      // just-opened milestone forward to the next chest). Derived from the highest
      // level cleared — nothing stored.
      lobbyChestState: () => ({
        visible: !!(lobby.chestBar && lobby.chestBar.visible),
        label: (lobby.chestBar && lobby.chestBar._label) ? lobby.chestBar._label.text : "",
        completed: user.completedLevel(),
        info: levelChest.currentFor(user.completedLevel()),
      }),
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
        // coins) / "ad" (out of stock & coins -> watch an ad) / "locked" (not yet
        // unlocked by progression — no ladder tier applies).
        undoMode: scene.undoBtn._boosterMode,
        shuffleMode: scene.shuffleBtn._boosterMode,
        wandMode: scene.wandBtn._boosterMode,
        undoLocked: scene.undoBtn._boosterMode === "locked",
        shuffleLocked: scene.shuffleBtn._boosterMode === "locked",
        wandLocked: scene.wandBtn._boosterMode === "locked",
      }),
      // ---- helper progression (locked in the first levels) ----
      boosterUnlocked: (kind) => user.isBoosterUnlocked(kind),
      boosterUnlockLevel: (kind) => user.boosterUnlockLevel(kind),
      // Press a helper button through the real pointer path (so a locked one gets
      // its refusal feedback), rather than calling the action directly.
      pressBooster: (kind) => {
        const btn = { undo: scene.undoBtn, shuffle: scene.shuffleBtn, wand: scene.wandBtn }[kind];
        return btn ? btn.emit("pointertap") : undefined;
      },
      // Text of the floating "Unlocks at Level N" label, "" when none is showing.
      boosterHint: () => (scene._boosterHint ? scene._boosterHint.__text : ""),
      // ---- the coached first use of a helper ----
      // The modal that dims the level and lifts one helper button out of the dim on
      // the level it unlocks. Shaped zero object when none is up, like tutorialState.
      boosterCoachState: () => {
        const c = scene._coach;
        if (!c || c.destroyed) {
          return { visible: false, kind: "", caption: "", btnX: 0, btnY: 0, dimW: 0, dimH: 0 };
        }
        return c.state();
      },
      // The ONE tap the coaching allows, through the real pointer path — so it runs
      // the actual helper, exactly as a player's tap would.
      pressCoachedBooster: () => scene._coach && scene._coach.btn.emit("pointertap"),
      // Tap the dim. Unlike the How To Play popup this must NOT dismiss anything —
      // there is no way out of the coaching but using the helper.
      tapCoachDim: () => scene._coach && scene._coach.dim.emit("pointertap"),
      // Has this helper already had its coached first use? (persisted on the profile)
      boosterCoached: (kind) => user.isBoosterCoached(kind),
      // Mark coaching as already seen without playing it — "all" for every helper.
      // Tests that need ordinary unlocked helpers use this after completeLevel(),
      // since an unlocked-but-untaught helper opens a modal on the next level.
      markBoosterCoached: (kind) => {
        const kinds = kind === "all" ? CONFIG.boosters.kinds : [kind];
        for (const k of kinds) user.markBoosterCoached(k);
      },
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
      // Press the win overlay's "Continue" button (returns to the lobby, advanced).
      pressWinContinue: () => scene._winBtn && scene._winBtn.emit("pointertap"),
      pressLoseContinue: () => scene._loseBtns && scene._loseBtns.cont.emit("pointertap"),
      pressLoseHome: () => scene._loseBtns && scene._loseBtns.home.emit("pointertap"),
      pressLoseReplay: () => scene._loseBtns && scene._loseBtns.replay.emit("pointertap"),
      setMusic: (on) => audio.setMusic(on),
      setSound: (on) => audio.setSound(on),
      setMuted: (m) => audio.setMuted(m),
      setPageVisible: (v) => audio.setPageVisible(v),
      flushSave: () => store._flush(),
      reset: () => store.reset(),
      // The start-of-level deal: is the board still arriving, what beat did it
      // use, and per layer when it started appearing (ms into the deal) plus the
      // live mean opacity of its tiles. deal_test.py samples this mid-deal to
      // assert the layers really come up bottom-first, one behind the other.
      dealState: () => scene.dealState(),
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
}

boot().catch((e) => {
  console.error(e);
  // Keep the splash up and say what went wrong, rather than fading out onto a
  // blank canvas.
  splash.fail("Error: " + e.message);
});
