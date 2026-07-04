// Storage + identity adapters. Each platform the game ships on (Facebook Instant,
// Reddit, Telegram) has its own identity + cloud-save SDK; this file hides those
// behind one small async contract so the rest of the game stays platform-agnostic:
//
//   identify()      -> { id, platform, name }
//   load(id)        -> plain object | null   (a previously-saved User.toJSON())
//   save(id, data)  -> void                  (data is User.toJSON())
//
// The LocalStorageAdapter is fully working and is the default on the open web.
// The three platform adapters are STUBS: they extend LocalStorageAdapter so that
// TODAY they persist to localStorage (in-session state + local persistence), and
// each documents the exact SDK calls to swap in (// TODO(SDK):) once we integrate
// each platform for real. Nothing outside this file needs to change at that point.

const UID_KEY = "tilemaster.uid";     // stable local identifier for this browser
const USER_KEY = "tilemaster.user";   // saved profile blob (namespaced by id)

function newId() {
  try {
    if (typeof crypto !== "undefined" && crypto.randomUUID) return "u_" + crypto.randomUUID();
  } catch (_) {}
  // Fallback: a monotonic local counter (avoids Math.random / Date.now).
  let n = 0;
  try {
    n = (parseInt(localStorage.getItem(UID_KEY + ".seq") || "0", 10) || 0) + 1;
    localStorage.setItem(UID_KEY + ".seq", String(n));
  } catch (_) {}
  return "u_local_" + n;
}

export class LocalStorageAdapter {
  constructor() { this.platform = "web"; }

  async identify() {
    let id = null;
    try { id = localStorage.getItem(UID_KEY); } catch (_) {}
    if (!id) {
      id = newId();
      try { localStorage.setItem(UID_KEY, id); } catch (_) {}
    }
    return { id, platform: this.platform, name: "" };
  }

  async load(id) {
    try {
      const raw = localStorage.getItem(this._key(id));
      return raw ? JSON.parse(raw) : null;
    } catch (_) { return null; }
  }

  async save(id, data) {
    try { localStorage.setItem(this._key(id), JSON.stringify(data)); } catch (_) {}
  }

  _key(id) { return `${USER_KEY}:${id}`; }
}

// --- Platform stubs -------------------------------------------------------
// Each persists via the inherited localStorage methods for now. The comments
// mark precisely where the real SDK calls go when we integrate each platform.

export class FacebookInstantAdapter extends LocalStorageAdapter {
  constructor() { super(); this.platform = "facebook"; }
  // TODO(SDK): identify() -> await FBInstant.initializeAsync(); await FBInstant.startGameAsync();
  //   return { id: FBInstant.player.getID(), platform: "facebook", name: FBInstant.player.getName() }
  // TODO(SDK): load(id)   -> const d = await FBInstant.player.getDataAsync(["user"]); return d.user ?? null
  // TODO(SDK): save(id,d) -> await FBInstant.player.setDataAsync({ user: d })
}

export class TelegramAdapter extends LocalStorageAdapter {
  constructor() { super(); this.platform = "telegram"; }
  // TODO(SDK): identify() -> const u = Telegram.WebApp.initDataUnsafe.user;
  //   return { id: "tg_" + u.id, platform: "telegram", name: u.username || u.first_name }
  //   (validate Telegram.WebApp.initData server-side before trusting the id).
  // TODO(SDK): load/save  -> Telegram.WebApp.CloudStorage.getItem/setItem("user", cb)
  //   (callback API — wrap in a Promise), or round-trip through the bot backend.
}

export class RedditAdapter extends LocalStorageAdapter {
  constructor() { super(); this.platform = "reddit"; }
  // TODO(SDK): Reddit games run on Devvit — identity + storage are server-side.
  //   The webview posts messages to the Devvit runtime, which resolves the user
  //   (reddit.getCurrentUser()) and persists per-user state (redis / kv). Swap
  //   identify()/load()/save() to that postMessage bridge when integrating.
}
