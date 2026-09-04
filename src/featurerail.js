// Feature-button rail — the ordered, self-arranging column of feature entry
// buttons running down an outer edge of the lobby.
//
// Feature buttons (Free Spin, Daily Bonus, …) are NOT pinned to fixed spots.
// They occupy CONSECUTIVE slots top-to-bottom, filled in a fixed priority order
// by whichever buttons are currently available. When #1 becomes unavailable it
// fades out and everything below it slides UP one slot; the moment it is
// available again the others slide back down and it fades in at its rightful
// place. So the column can never show a hole — which is exactly what the old
// hard-coded positions produced: the wheel unlocks at level 5 and the daily gift
// at level 1, so every new player saw the gift floating below an empty slot.
//
// The rail is edge-agnostic: it owns only an x and a slot ladder, so a second
// rail pinned to the RIGHT edge needs no new machinery, just another instance.
// It knows nothing about what makes a button available — each entry brings its
// own predicate, which the rail re-asks on every refresh().

import { easeInOutQuad, easeOutCubic,
         animator, retarget, snap, moving, step } from "./tween.js";

// The slot ladder, in 750×1334 design units. y0 clears the top-corner chrome row
// (settings cog / coin pill sit at y84); the gap is the spacing the two original
// hard-coded buttons used (214 → 396), kept so the look is unchanged.
export const RAIL_Y0 = 214;
export const RAIL_GAP = 182;
export const RAIL_LEFT_X = 86;
export const RAIL_RIGHT_X = 750 - 86; // 664 — the mirror column on the right edge

export class FeatureRail {
  /**
   * @param ticker the shared Pixi ticker (app.ticker)
   * @param x      design-space x of the column (RAIL_LEFT_X / RAIL_RIGHT_X)
   */
  constructor(ticker, { x = RAIL_LEFT_X, y0 = RAIL_Y0, gap = RAIL_GAP,
                        moveMs = 320, fadeMs = 220 } = {}) {
    this.ticker = ticker;
    this.x = x; this.y0 = y0; this.gap = gap;
    this.moveMs = moveMs; this.fadeMs = fadeMs;
    this.entries = [];
    this._tick = () => this._advance();
    ticker.add(this._tick);
  }

  /**
   * Register a button. CALL ORDER IS THE PRIORITY ORDER — the first-registered
   * available button takes the topmost slot.
   * @param key          stable id (used by the debug/test snapshot)
   * @param display      the PIXI container; the rail owns its x/y/alpha/visible
   * @param isAvailable  () => boolean, re-asked on every refresh()
   */
  add(key, display, isAvailable) {
    const a = animator(display.visible ? display.alpha : 0);
    display.alpha = a.value;
    this.entries.push({
      key, display, isAvailable,
      available: false, slot: -1,
      y: animator(display.y), a,
    });
    return this;
  }

  slotY(i) { return this.y0 + i * this.gap; }

  /**
   * Re-ask every predicate, compact the available buttons into slots 0..n-1 in
   * registration order, and animate each one to where it now belongs.
   * @param animate false to snap into place (used on lobby entry, so arriving at
   *                the lobby never plays a slide).
   */
  refresh({ animate = true } = {}) {
    // Pass 1 — assign slots, slide the buttons that stay, fade out the ones that go.
    let next = 0;
    const entering = [];
    for (const e of this.entries) {
      const avail = !!e.isAvailable();
      e.available = avail;
      e.slot = avail ? next++ : -1;

      if (!avail) {
        // Fade out where it stands while the buttons below close the gap. An
        // alpha-0 display object is still hit-testable in Pixi, so input has to
        // go at the START of the fade, not when it finishes.
        e.display.eventMode = "none";
        // Rail-managed buttons drive their own hover swell off a `_hover` flag
        // (see LobbyScene._startWheelSpin / _startDailyPulse); with input off,
        // no pointerout is coming to clear it.
        if ("_hover" in e.display) e.display._hover = false;
        if (animate && e.a.value > 0) retarget(e.a, 0, this.fadeMs);
        else snap(e.a, 0);
        continue;
      }

      const y = this.slotY(e.slot);
      e.display.eventMode = "static";
      if (e.a.value === 0 && e.a.to === 0) {
        // Fully hidden, so there is nothing to slide: drop it straight into its
        // slot. Pass 2 fades it in, once it knows whether the rail is still moving.
        snap(e.y, y);
        entering.push(e);
      } else if (animate) {
        // On screen (or on its way in) — slide to the new slot, stay/come opaque.
        retarget(e.y, y, this.moveMs);
        retarget(e.a, 1, this.fadeMs);
      } else {
        snap(e.y, y); snap(e.a, 1);
      }
    }

    // Pass 2 — a button ENTERING the rail waits for the reflow to finish before
    // it fades in. Slots are only ~1.2 button-heights apart, so a neighbour
    // sliding past would otherwise be sitting on top of it for most of the move.
    const reflowing = this.entries.some((e) => moving(e.y));
    for (const e of entering) {
      if (animate) retarget(e.a, 1, this.fadeMs, reflowing ? this.moveMs : 0);
      else snap(e.a, 1);
    }

    for (const e of this.entries) this._apply(e);
  }

  /**
   * Is this feature currently offered? This is the GATE, as of the last refresh —
   * not "is its button on screen right now", which also depends on where the
   * fade/slide has got to.
   */
  available(key) {
    const e = this.entries.find((x) => x.key === key);
    return !!e && e.available;
  }

  /** Slot assignment + live geometry of every entry (debug / test hook). */
  slots() {
    return this.entries.map((e) => ({
      key: e.key,
      available: e.available,
      slot: e.slot,
      x: e.display.x, y: e.display.y, targetY: e.y.to,
      visible: e.display.visible, alpha: e.display.alpha,
      moving: moving(e.y) || moving(e.a),
    }));
  }

  destroy() {
    this.ticker.remove(this._tick);
    this.entries.length = 0;
  }

  _advance() {
    const dt = this.ticker.deltaMS;
    for (const e of this.entries) {
      if (!moving(e.y) && !moving(e.a)) continue;
      step(e.y, dt, easeInOutQuad);
      step(e.a, dt, easeOutCubic);
      this._apply(e);
    }
  }

  _apply(e) {
    e.display.position.set(this.x, e.y.value);
    e.display.alpha = e.a.value;
    // A button is on screen exactly while it has some opacity. That keeps a
    // faded-out one out of hit-testing and stops the pulse loops that key off
    // `visible` — and it keeps a button still WAITING to fade in out of the
    // scene's controls() list, so it can't count as overlapping the neighbour
    // sliding past its slot.
    e.display.visible = e.a.value > 0;
  }
}
