import { GameScene } from "./game.js";
import { LobbyScene } from "./lobby.js";
import { makeTileTextures, makeSlotTexture } from "./icons.js";
import { AudioManager } from "./audio.js";
import { AssetManager, PRELOAD_GROUPS, MANIFEST } from "./assets.js";
import { UserStore } from "./user/UserStore.js";

const DESIGN_W = 750;
const DESIGN_H = 1334;
const MAX_LEVEL = 3;

async function boot() {
  // Render at the original design resolution; the canvas ELEMENT is then scaled
  // to fit the viewport while preserving the original 750:1334 aspect ratio, so
  // the displayed view always matches the original game exactly (no distortion).
  const app = new PIXI.Application({
    width: DESIGN_W,
    height: DESIGN_H,
    backgroundColor: 0x10131a,
    antialias: true,
    resolution: Math.min(window.devicePixelRatio || 1, 2),
    autoDensity: true,
  });
  document.getElementById("game").appendChild(app.view);

  const root = new PIXI.Container();
  app.stage.addChild(root);

  function resize() {
    const scale = Math.min(window.innerWidth / DESIGN_W, window.innerHeight / DESIGN_H);
    app.view.style.width = `${Math.round(DESIGN_W * scale)}px`;
    app.view.style.height = `${Math.round(DESIGN_H * scale)}px`;
  }
  window.addEventListener("resize", resize);
  resize();

  // ---- assets --------------------------------------------------------------
  // Procedural (no network): tile faces + tray slot are drawn at runtime.
  const tileTextures = makeTileTextures(128);
  const slotTexture = makeSlotTexture(120);

  // Network assets flow through the AssetManager: PRELOAD the essential minimum
  // (shared audio + levels 1–3), then LAZY-load any further level on demand.
  const audio = new AudioManager();
  const assets = new AssetManager(audio);

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

  const scene = new GameScene(app, tileTextures, slotTexture, backgrounds, audio);
  const lobby = new LobbyScene(app, backgrounds, audio, MAX_LEVEL);
  root.addChild(scene, lobby);

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
    currentLevel = Math.min(completed + 1, MAX_LEVEL);
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
  if (scene.muteBtn) scene.muteBtn.label.text = audio.muted ? "✕" : "♪";

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
    app, scene, lobby, assets, audio, store,
    currentLevel: () => currentLevel,
    inLobby: () => lobby.visible,
    lobbyButtonText: () => lobby.playBtn.label.text,
    startLevel,
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
    setLevel: (n) => { currentLevel = Math.max(1, Math.min(n, MAX_LEVEL)); user.setLevel(currentLevel); },
    balance: (cur) => user.balance(cur),
    credit: (cur, n) => user.credit(cur, n),
    debit: (cur, n) => user.debit(cur, n),
    setMusic: (on) => audio.setMusic(on),
    setSound: (on) => audio.setSound(on),
    setMuted: (m) => audio.setMuted(m),
    setPageVisible: (v) => audio.setPageVisible(v),
    flushSave: () => store._flush(),
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
