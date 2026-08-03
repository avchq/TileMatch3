// Web Audio manager. Each sound file is fetched + decoded exactly ONCE into an
// in-memory AudioBuffer (see AssetManager). Playback spins up a throwaway
// AudioBufferSourceNode from that buffer — so sounds overlap freely and NO
// network request is made per play (the previous HTML5 `cloneNode()` approach
// re-fetched the file from the server every single time a sound was played).

export class AudioManager {
  constructor() {
    // Two independent channels (persisted separately via the User settings):
    //   musicOn -> background music (bgm)   soundOn -> one-shot sound effects
    this.musicOn = true;
    this.soundOn = true;
    this.buffers = {};      // name -> { buffer, volume, loop }
    this._ctx = null;
    this._bgmName = null;
    this._bgmSource = null;
    this._bgSuspended = false; // true only while WE paused a running ctx for a hidden tab
    this.onMusicChange = null; // (on) => void — host persists the preference
    this.onSoundChange = null; // (on) => void
    this.onPlay = null;        // (name) => void — fired per one-shot ACTUALLY emitted
  }

  // Compat: a single "muted" view of both channels for the in-game master
  // mute button. The settings screen uses setMusic/setSound independently.
  get muted() { return !this.musicOn && !this.soundOn; }

  _ensureCtx() {
    if (!this._ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (AC) this._ctx = new AC();
    }
    return this._ctx;
  }

  /** Decode a fetched audio file (ArrayBuffer) into a reusable AudioBuffer. */
  async register(name, arrayBuffer, { loop = false, volume = 1 } = {}) {
    const ctx = this._ensureCtx();
    if (!ctx) return; // Web Audio unavailable — play() will simply no-op
    // decodeAudioData detaches its input; slice so callers keep their copy.
    const buffer = await ctx.decodeAudioData(arrayBuffer.slice(0));
    this.buffers[name] = { buffer, volume, loop };
  }

  isRunning() {
    return !!this._ctx && this._ctx.state === "running";
  }

  /**
   * Resume the context + start the bgm. MUST be called synchronously from a
   * user-gesture handler (click / touch / key) — browser autoplay policy only
   * permits resume() to take effect while a user activation is in progress.
   * Returns a promise that resolves once the resume settles.
   */
  unlock() {
    const ctx = this._ensureCtx();
    if (!ctx) return Promise.resolve();
    if (ctx.state === "running") {
      this._startBgm();
      return Promise.resolve();
    }
    return ctx.resume().then(() => this._startBgm()).catch(() => {});
  }

  _source(entry, loop) {
    const ctx = this._ctx;
    const src = ctx.createBufferSource();
    src.buffer = entry.buffer;
    src.loop = loop;
    const gain = ctx.createGain();
    gain.gain.value = entry.volume;
    src.connect(gain).connect(ctx.destination);
    return src;
  }

  /** Fire-and-forget one-shot (used for SFX). Overlaps freely, no network. */
  play(name) {
    if (!this.soundOn) return;
    const entry = this.buffers[name];
    if (!entry || !this._ctx) return;
    const src = this._source(entry, false);
    src.start(0);
    if (this.onPlay) this.onPlay(name);
    return src;
  }

  // Select the bgm track and start it IF the context is already running. Does
  // NOT call resume() — so calling it on page load never triggers the browser's
  // "AudioContext was not allowed to start" warning. Use unlock() from a gesture
  // to actually resume a suspended context.
  playBgm(name) {
    if (!this.buffers[name]) return;
    this._bgmName = name;
    this._startBgm();
  }

  // A BufferSource started while the context is suspended does not reliably
  // begin when it later resumes, so we only create the source once the context
  // is actually running.
  _startBgm() {
    if (!this.musicOn || !this._bgmName || this._bgmSource || !this._ctx) return;
    if (this._ctx.state !== "running") return; // wait for a gesture -> unlock()
    const entry = this.buffers[this._bgmName];
    if (!entry) return;
    const src = this._source(entry, true);
    src.start(0);
    this._bgmSource = src;
  }

  _stopBgm() {
    if (this._bgmSource) {
      try { this._bgmSource.stop(); } catch (_) {}
      this._bgmSource = null;
    }
  }

  // Toggle background music. Enabling only (re)starts the source if the context
  // is already running; it never calls resume() (that would log an autoplay
  // warning on load) — the gesture-unlock path in main.js resumes the context.
  setMusic(on, { persist = true } = {}) {
    this.musicOn = !!on;
    if (this.musicOn) this._startBgm();
    else this._stopBgm();
    if (persist && this.onMusicChange) this.onMusicChange(this.musicOn);
  }

  // Toggle sound effects. Pure gate on play(); no context work needed.
  setSound(on, { persist = true } = {}) {
    this.soundOn = !!on;
    if (persist && this.onSoundChange) this.onSoundChange(this.soundOn);
  }

  // Compat master toggle for the in-game HUD button (flips both channels).
  setMuted(m) {
    this.setMusic(!m);
    this.setSound(!m);
  }

  // Pause/resume audio when the tab loses/gains visibility. This silences the
  // music while the player is on another tab WITHOUT changing their music/sound
  // settings: we suspend the whole context (playback position is preserved) and
  // resume it on return. We only auto-resume a context we ourselves suspended,
  // so a still-locked (pre-gesture) context is never resumed here — that would
  // both fail and log an autoplay warning.
  setPageVisible(visible) {
    const ctx = this._ctx;
    if (!ctx) return;
    if (!visible) {
      if (ctx.state === "running") {
        this._bgSuspended = true;
        ctx.suspend().catch(() => {});
      }
    } else if (this._bgSuspended) {
      this._bgSuspended = false;
      ctx.resume().then(() => this._startBgm()).catch(() => {});
    }
  }
}
