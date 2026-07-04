// Minimal ticker-based tween helpers (Pixi v7 has no built-in tween).

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
 * @returns {Promise<void>} resolves on completion.
 */
export function tween(ticker, { duration = 300, ease = easeOutCubic, onUpdate, onComplete } = {}) {
  return new Promise((resolve) => {
    let elapsed = 0;
    const fn = () => {
      elapsed += ticker.deltaMS;
      const t = Math.min(1, elapsed / duration);
      if (onUpdate) onUpdate(ease(t), t);
      if (t >= 1) {
        ticker.remove(fn);
        if (onComplete) onComplete();
        resolve();
      }
    };
    ticker.add(fn);
  });
}

export const delay = (ticker, ms) =>
  tween(ticker, { duration: ms, ease: (t) => t, onUpdate: () => {} });
