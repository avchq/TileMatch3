// Orchestrates identity + persistence for the User model. On init() it resolves
// the platform, identifies the player, loads any saved profile (or creates a
// fresh one), then autosaves — debounced — whenever the model changes, plus a
// flush on tab hide/close so a pending debounced write is never lost.

import { User } from "./User.js";
import { detectPlatform, makeAdapter } from "./platform.js";
import { CONFIG } from "../config.js";

// How long a change waits before it is written back (src/config.js).
const SAVE_DEBOUNCE_MS = CONFIG.persistence.saveDebounceMs;

export class UserStore {
  constructor(adapter) {
    this.platform = detectPlatform();
    this.adapter = adapter || makeAdapter(this.platform);
    this.user = null;
    this._saveTimer = null;
    this._saving = null;  // in-flight save promise (serializes async adapter writes)
    this._dirty = false;  // a change arrived while a save was in flight
    // A lost write is the one storage failure that costs the player something,
    // so it is recorded rather than swallowed anonymously (see save()).
    this.onSaveError = null;   // (err) => void — the host's chance to react
    this.saveFailures = 0;     // writes lost this session
    this.lastSaveError = null; // the most recent one
    this._flush = this._flush.bind(this);
  }

  async init() {
    const { id, platform, name } = await this.adapter.identify();
    const raw = await this.adapter.load(id);
    // Existing player -> rehydrate; first-time player -> fresh profile.
    this.user = raw ? User.fromJSON(raw) : new User({ id, platform, name });
    // Always trust the live identity for id/platform (keep any saved name).
    this.user.id = id;
    this.user.platform = platform;
    if (name && !this.user.name) this.user.name = name;

    // Autosave on any change (progress / wallet / settings).
    this.user.on(() => this._scheduleSave());

    // Persist-on-exit so a debounced change survives a tab close/navigation.
    try {
      window.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "hidden") this._flush();
      });
      window.addEventListener("pagehide", this._flush);
    } catch (_) {}

    return this.user;
  }

  _scheduleSave() {
    if (this._saveTimer) return; // coalesce a burst of changes into one write
    try {
      this._saveTimer = setTimeout(() => { this._saveTimer = null; this.save(); }, SAVE_DEBOUNCE_MS);
    } catch (_) { this.save(); }
  }

  // Persist a PENDING debounced change immediately. If nothing is pending
  // (already saved, or nothing changed since load) this is a no-op — critically,
  // so a bare page refresh never re-writes (resurrects) profile data the user may
  // have just cleared from storage. Only genuinely-unsaved changes are flushed.
  _flush() {
    if (!this._saveTimer) return;
    clearTimeout(this._saveTimer);
    this._saveTimer = null;
    this.save();
  }

  // Serialized, last-write-wins save. Crucial for the (async) cloud adapters —
  // FBInstant / Telegram / Devvit writes take a network round-trip, so without
  // serialization two overlapping saves could land out of order and an older
  // snapshot could clobber a newer one. Here a save requested while another is
  // in flight just marks the store dirty; when the current write settles we do
  // exactly ONE more write of the latest snapshot. Returns the in-flight promise.
  save() {
    if (!this.user) return Promise.resolve();
    this._pendingData = this.user.toJSON(); // newest snapshot always wins
    if (this._saving) { this._dirty = true; return this._saving; }
    const id = this.user.id;
    this._saving = (async () => {
      try {
        do {
          this._dirty = false;
          await this.adapter.save(id, this._pendingData);
        } while (this._dirty);
      } catch (err) {
        // The adapter contract is that save() REJECTS when the bytes did not
        // land. Absorb it HERE and only here — save() is called from a debounce
        // timer and from a pagehide handler, neither of which can handle a
        // rejection — and the next change reschedules a write, so the retry this
        // comment used to promise is now a real one rather than a description of
        // an adapter that never failed. What must not happen is that it stays
        // silent: a player on a full quota, or in Safari private browsing (which
        // throws on every setItem), otherwise loses a whole session with nothing
        // logged and nothing shown.
        this.saveFailures++;
        this.lastSaveError = err;
        console.warn("[UserStore] profile save failed:", err && err.message);
        try { if (this.onSaveError) this.onSaveError(err); } catch (_) {}
      } finally {
        this._saving = null;
      }
    })();
    return this._saving;
  }

  // Reset the record for this player back to a fresh profile, on WHATEVER
  // storage backend is active (localStorage today; FBInstant / Telegram / Devvit
  // once wired). Identity is preserved. This is the correct, platform-agnostic
  // way to "reset progress" — it does NOT rely on the user manually clearing
  // localStorage (which would do nothing on a cloud backend).
  async reset() {
    // Stop pending + in-flight writes so nothing resurrects the old record.
    if (this._saveTimer) { clearTimeout(this._saveTimer); this._saveTimer = null; }
    this._dirty = false;
    if (this._saving) { try { await this._saving; } catch (_) {} }

    // Remove the stored record (adapter-specific), then reset the model in place.
    try { await this.adapter.clear(this.user.id); } catch (_) {}
    this.user.reset(); // in-place → external refs & listeners stay valid; emits changes
    // The emitted changes queue a debounced save that persists the clean
    // defaults, so storage ends in a consistent, valid state on every backend.
    return this.user;
  }
}
