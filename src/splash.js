// The loading splash screen — a DOM overlay, not a Pixi scene.
//
// It lives in index.html so the browser paints it from the first frame, before
// vendor/pixi.min.js and these ES modules have parsed; a Pixi splash could only
// appear once the Application exists, leaving the earliest (and, on a cold
// cache, slowest) part of boot on a blank screen. Being outside the stage also
// keeps it clear of the 750×1334 design-space layout system: it is not a `root`
// child, gets no layout() call, and never shows up in window.__game.controls().
//
// main.js drives it across the WHOLE of boot() — the level table, the profile,
// the asset preload, the tunable configs and the scene build all get a slice of
// the bar — then hides it just before the first scene is handed over.

/** Create the splash controller over the markup in index.html. */
export function createSplash() {
  const el = document.getElementById("splash");
  const fill = document.getElementById("splash-fill");
  const pct = document.getElementById("splash-pct");
  const status = document.getElementById("splash-status");

  const splash = {
    el,
    // Every (progress, status) step, oldest first. The splash is long gone by
    // the time window.__game exists, so this is how tests inspect the boot after
    // the fact (see tests/splash_test.py).
    history: [],
    _p: 0,
    _holds: 0,
    _failed: false,

    /**
     * Report progress. `p` is 0..1 and MONOTONIC — a later stage reporting a
     * smaller fraction can never make the bar walk backwards. `text` (optional)
     * replaces the status line.
     */
    set(p, text) {
      if (!el || this._failed) return;
      const next = Math.max(this._p, Math.min(1, Math.max(0, p || 0)));
      this._p = next;
      if (fill) fill.style.width = `${(next * 100).toFixed(1)}%`;
      if (pct) pct.textContent = `${Math.round(next * 100)}%`;
      if (text && status) status.textContent = text;
      this.history.push({ p: next, status: status ? status.textContent : "" });
    },

    /**
     * Take a hold on the splash, showing it (and restarting the bar) if it was
     * hidden. Holds are counted: boot takes one, and a mid-session lazy level
     * load takes another, so a lazy load that happens *inside* boot (the
     * first-run branch dropping into level 1) can't hide the boot splash early.
     */
    show(text) {
      if (!el) return;
      this._holds++;
      if (this._holds === 1) {
        this._p = 0;
        this._failed = false;
        el.classList.remove("hiding", "error");
        el.style.display = "";
        if (fill) fill.style.width = "0%";
      }
      this.set(this._p, text);
    },

    /** Release a hold; the last one out fades the splash away. */
    hide() {
      if (!el || this._failed) return;
      this._holds = Math.max(0, this._holds - 1);
      if (this._holds > 0) return;
      this.set(1);
      // `hiding` drops pointer-events straight away, so the fading overlay never
      // swallows a tap meant for the canvas underneath.
      el.classList.add("hiding");
      const done = () => { if (el.classList.contains("hiding")) el.style.display = "none"; };
      el.addEventListener("transitionend", done, { once: true });
      setTimeout(done, 400); // belt and braces: transitionend can be skipped
    },

    /** Boot failed: keep the splash up and say why, rather than a blank screen. */
    fail(message) {
      if (!el) return;
      this._failed = true;
      this._holds = 1;
      el.classList.remove("hiding");
      el.style.display = "";
      el.classList.add("error");
      if (status) status.textContent = message;
    },
  };

  // Test seam only — nothing in the game reads this back.
  window.__splash = splash;
  return splash;
}
