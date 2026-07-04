import { GameScene } from "./game.js";
import { LobbyScene } from "./lobby.js";
import { makeTileTextures, makeSlotTexture } from "./icons.js";
import { AudioManager } from "./audio.js";

const DESIGN_W = 750;
const DESIGN_H = 1334;
const MAX_LEVEL = 3;
const LEVEL_KEY = "tilemaster.level"; // persisted "next level to play"

function loadSavedLevel() {
  const n = parseInt(localStorage.getItem(LEVEL_KEY) || "1", 10);
  return Number.isFinite(n) && n >= 1 && n <= MAX_LEVEL ? n : 1;
}
function saveLevel(n) {
  try { localStorage.setItem(LEVEL_KEY, String(n)); } catch (_) {}
}

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
  const tileTextures = makeTileTextures(128);
  const slotTexture = makeSlotTexture(120);

  const bgUrls = { 1: "assets/bg/bg1.jpg", 2: "assets/bg/bg2.jpg", 3: "assets/bg/bg14.jpg" };
  const backgrounds = {};
  await Promise.all(
    Object.entries(bgUrls).map(async ([k, url]) => {
      backgrounds[k] = await PIXI.Assets.load(url);
    })
  );

  const audio = new AudioManager();
  audio.add("Game_bgm", "assets/audio/Game_bgm.mp3", { loop: true, volume: 0.4 });
  audio.add("tile_bop", "assets/audio/tile_bop.mp3", { volume: 0.7 });
  audio.add("merge_click", "assets/audio/merge_click.mp3", { volume: 0.8 });
  audio.add("win", "assets/audio/win.mp3", { volume: 0.8 });
  audio.add("fail", "assets/audio/fail.mp3", { volume: 0.7 });
  audio.add("btn_01", "assets/audio/btn_01.mp3", { volume: 0.6 });

  const levels = {};
  for (const n of [1, 2, 3]) {
    levels[n] = await (await fetch(`assets/levels/level${n}.json`)).json();
  }

  // ---- scenes --------------------------------------------------------------
  // The player is on a given level (persisted). The lobby is the landing screen
  // on load and after each win; its centred "Level <n>" button starts play.
  let currentLevel = loadSavedLevel();

  const scene = new GameScene(app, tileTextures, slotTexture, backgrounds, audio);
  const lobby = new LobbyScene(app, backgrounds, audio, MAX_LEVEL);
  root.addChild(scene, lobby);

  function showLobby(level, opts) {
    scene.visible = false;
    lobby.show(level, opts);
  }
  function startLevel(level) {
    lobby.hide();
    scene.visible = true;
    if (levels[level]) scene.loadLevel(levels[level], level);
  }

  lobby.onPlay = (level) => startLevel(level);

  scene.onLevelComplete = (completed) => {
    // advance to the next level (capped) and return to the lobby
    currentLevel = Math.min(completed + 1, MAX_LEVEL);
    saveLevel(currentLevel);
    showLobby(currentLevel, { celebrate: true });
  };

  // land on the lobby at the player's saved level
  showLobby(currentLevel);

  // start bgm on first user gesture (autoplay policy)
  const startAudio = () => {
    audio.playBgm("Game_bgm");
    window.removeEventListener("pointerdown", startAudio);
  };
  window.addEventListener("pointerdown", startAudio);

  document.getElementById("loading").style.display = "none";

  // ---- test / debug API (used by the headless verification driver) ---------
  window.__game = {
    app, scene, lobby,
    currentLevel: () => currentLevel,
    inLobby: () => lobby.visible,
    lobbyButtonText: () => lobby.playBtn.label.text,
    startLevel,
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
