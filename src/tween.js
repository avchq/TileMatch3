// Minimal ticker-based animation helpers (Pixi v7 has no built-in tween).
//
// Two halves, and picking the wrong one is the mistake this module exists to
// prevent: `tween()` runs a value from A to B once and tells you how it ended;
// the value animators at the bottom run a value TOWARD a target that is allowed
// to change mid-flight. Cancelling and re-aiming are different things.

export const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);
export const easeInCubic = (t) => t * t * t;
export const easeOutBack = (t) => {
  const c1 = 1.70158, c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
};
export const easeInOutQuad = (t) =>
  t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;

/**
 * Run a tween on the shared Pixi ticker.
 *
 * The contract, in the order it matters:
 *
 *  1. IT ALWAYS RESOLVES — never rejects, not on an abandon and not on a throw.
 *     Two dozen call sites are fire-and-forget (a bare `tween(...)` statement),
 *     and autoComplete awaits a `Promise.all` of them; a rejecting member there
 *     would abort the sweep with the board still `locked` and its tiles stranded
 *     on fxLayer, trading a dead render loop for an unwinnable level. The
 *     resolved value says what happened instead: "done" | "abandoned" | "error".
 *
 *  2. A THROW OUT OF A CALLBACK MUST NOT ESCAPE THIS LISTENER. Pixi's
 *     `Ticker._tick` is `this._requestId = null, this.started && (this.update(t),
 *     … this._requestId === null && (this._requestId = requestAnimationFrame(…)))`
 *     — the re-arm is sequenced AFTER `update()` returns, and `update()` assigns
 *     `lastTime` as its last statement. So an exception escaping a ticker
 *     listener stops the rAF loop for good: `lastTime` freezes while `started`
 *     stays true, which is why tests detect this with `lastTime` and never with
 *     `started`. It is only PERMANENT because the listener stays registered —
 *     any later `ticker.add()` re-arms rAF for one frame, which the same
 *     listener throws away again. Hence: unhook FIRST, then report. (PRAC-01,
 *     the Auto Complete freeze, was one instance of this.)
 *
 *  3. `while` is the owner check — "abandon if this stops being true". It skips
 *     onComplete, so onComplete is for "it landed", never for teardown that has
 *     to happen either way (tutorial.js's close() puts its only destroy() there;
 *     it must never gain a `while`). Never put a non-monotonic condition such as
 *     `!visible` in it: `while` is a one-way door, an `if (…) return` inside
 *     onUpdate is not. And `while` CANCELS, it does not RE-AIM — a value that
 *     has to be re-targeted mid-flight wants the animators below.
 *
 * @returns {Promise<"done"|"abandoned"|"error">} always resolves.
 */
export function tween(ticker, {
  duration = 300, ease = easeOutCubic, onUpdate, onComplete, while: alive,
} = {}) {
  return new Promise((resolve) => {
    let elapsed = 0;
    const fn = () => {
      try {
        if (alive && !alive()) { ticker.remove(fn); resolve("abandoned"); return; }
        elapsed += ticker.deltaMS;
        const t = Math.min(1, elapsed / duration);
        const done = t >= 1;
        // Unhook BEFORE the callback runs, not after it returns: cleanup written
        // below a throwing call is never reached (see 2 above).
        if (done) ticker.remove(fn);
        if (onUpdate) onUpdate(ease(t), t);
        if (done) {
          if (onComplete) onComplete();
          resolve("done");
        }
      } catch (err) {
        ticker.remove(fn);
        // Reported, not thrown and not rejected: the frame loop survives, and
        // the suite still goes red because harness.watch() collects console
        // errors. `alive()` throwing lands here too, deliberately.
        console.error("tween: a callback threw — this tween was abandoned", err);
        resolve("error");
      }
    };
    ticker.add(fn);
  });
}

export const delay = (ticker, ms) =>
  tween(ticker, { duration: ms, ease: (t) => t, onUpdate: () => {} });

// ---- re-targetable value animators -----------------------------------------
// A duration-based animator per value, for the case `tween()` deliberately does
// not cover: a target that changes while the value is still travelling.
// Re-targeting mid-flight just restarts from wherever the value is right now,
// which a promise-shaped tween cannot express — `while` abandons an animation,
// it does not re-aim one. The feature rail is the original and still the only
// consumer (availability can flip while a slide is running); it lives here so
// the second consumer does not write it again.
export const animator = (v) => ({ value: v, from: v, to: v, t: 0, dur: 0, delay: 0 });

// Aim at a new value, optionally after a hold. A no-op when we're already heading
// there — the day-rollover poller in main.js refreshes the rail every 4s, and
// restarting the tween on each of those would leave a moving button twitching in
// place forever. (`hold` rather than `delay`: the module exports a `delay()` of
// its own, and shadowing it here is exactly the trap that made a lobby.js call
// silently do nothing.)
export function retarget(a, to, dur, hold = 0) {
  if (a.to === to) return;
  a.from = a.value; a.to = to; a.t = 0; a.dur = dur; a.delay = hold;
}

export const snap = (a, to) => { a.value = a.from = a.to = to; a.t = 0; a.dur = 0; a.delay = 0; };

export const moving = (a) => a.value !== a.to;

export function step(a, dtMs, ease) {
  if (a.value === a.to) return;
  a.t += dtMs;
  if (a.t < a.delay) return;
  if (a.dur <= 0) { a.value = a.to; return; }
  const p = Math.min(1, (a.t - a.delay) / a.dur);
  a.value = p >= 1 ? a.to : a.from + (a.to - a.from) * ease(p);
}
