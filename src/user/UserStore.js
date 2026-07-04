// Orchestrates identity + persistence for the User model. On init() it resolves
// the platform, identifies the player, loads any saved profile (or creates a
// fresh one), then autosaves — debounced — whenever the model changes, plus a
// flush on tab hide/close so a pending debounced write is never lost.

import { User } from "./User.js";
import { detectPlatform, makeAdapter } from "./platform.js";

const SAVE_DEBOUNCE_MS = 400;

export class UserStore {
  constructor(adapter) {
    this.platform = detectPlatform();
    this.adapter = adapter || makeAdapter(this.platform);
    this.user = null;
    this._saveTimer = null;
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

  _flush() {
    if (this._saveTimer) { clearTimeout(this._saveTimer); this._saveTimer = null; }
    this.save();
  }

  async save() {
    if (!this.user) return;
    try { await this.adapter.save(this.user.id, this.user.toJSON()); } catch (_) {}
  }
}
