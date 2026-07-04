// Simple HTML5 Audio manager. SFX are cloned per play so they can overlap.

export class AudioManager {
  constructor() {
    this.sounds = {};   // name -> { el, volume, loop }
    this.muted = false;
    this._bgm = null;
  }

  add(name, url, { loop = false, volume = 1 } = {}) {
    const el = new Audio(url);
    el.loop = loop;
    el.volume = volume;
    el.preload = "auto";
    this.sounds[name] = { el, volume, loop };
  }

  play(name) {
    if (this.muted) return;
    const s = this.sounds[name];
    if (!s) return;
    if (s.loop) {
      s.el.currentTime = 0;
      s.el.play().catch(() => {});
      this._bgm = s.el;
    } else {
      const c = s.el.cloneNode();
      c.volume = s.volume;
      c.play().catch(() => {});
    }
  }

  playBgm(name) {
    const s = this.sounds[name];
    if (!s) return;
    this._bgm = s.el;
    if (!this.muted) s.el.play().catch(() => {});
  }

  setMuted(m) {
    this.muted = m;
    if (this._bgm) {
      if (m) this._bgm.pause();
      else this._bgm.play().catch(() => {});
    }
  }
}
