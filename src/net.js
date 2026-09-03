// Bounded network fetches for boot-critical JSON.
//
// WHY THIS EXISTS: a `try/catch` cannot rescue a promise that never settles. An
// un-timed `fetch` on a stalled connection (a captive portal, a dead PoP, a
// phone that lost the network mid-request) hangs forever, and every caller
// awaiting it hangs with it — which is how boot could park at "Loading
// settings… 80%" with no error, no canvas and nothing in the console. Every
// fetch that boot or a level load waits on goes through here.
//
// Three things this adds over a bare fetch:
//   1. a TIMEOUT (AbortController), so a stall becomes a failure
//   2. an `r.ok` check, so a 404/5xx becomes a failure instead of a JSON parse
//      error twenty lines away
//   3. a bounded RETRY for the failures that are plausibly transient
//
// The retry rule is deliberate: a 4xx is the server telling us the thing is not
// there, and hammering it changes nothing — only network errors, timeouts and
// 5xx are retried. `src/i18n.js` has its own copy of the timeout half of this
// because it runs before anything else and must not import a module that could
// itself fail; the constant is shared through CONFIG.

import { CONFIG } from "./config.js";

// Read defensively. Like src/i18n.js's langCfg(), this must survive a stale
// cached `src/config.js` from before the section existed — a module-scope throw
// here would kill the whole graph before boot() is ever defined.
const NET_DEFAULTS = { fetchTimeoutMs: 8000, retryAttempts: 2, retryBackoffMs: 400 };
function netCfg() {
  const c = (typeof CONFIG === "object" && CONFIG && CONFIG.network) || {};
  return {
    fetchTimeoutMs: c.fetchTimeoutMs || NET_DEFAULTS.fetchTimeoutMs,
    retryAttempts: c.retryAttempts || NET_DEFAULTS.retryAttempts,
    retryBackoffMs: c.retryBackoffMs || NET_DEFAULTS.retryBackoffMs,
  };
}

/** An HTTP status that is worth trying again. A 4xx is not. */
function retriable(err) {
  return !(err && typeof err.status === "number" && err.status >= 400 && err.status < 500);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * One bounded attempt. Rejects on a timeout, a network error, or a non-2xx —
 * with `err.status` set for the last of those so the caller can tell a missing
 * file from a broken connection.
 */
async function attempt(url, timeoutMs) {
  const ctrl = typeof AbortController === "function" ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : 0;
  let res;
  try {
    res = await fetch(url, ctrl ? { signal: ctrl.signal } : undefined);
  } catch (e) {
    // An abort reads as a plain DOMException; say what actually happened.
    if (ctrl && ctrl.signal.aborted) throw new Error(`${url}: timed out after ${timeoutMs}ms`);
    throw e;
  } finally {
    if (timer) clearTimeout(timer);
  }
  if (!res.ok) {
    const err = new Error(`${url}: HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res;
}

/**
 * Fetch with a timeout and a bounded retry, returning the Response.
 * `attempts` counts total tries, not extra ones: 2 means one retry.
 */
export async function fetchOnce(url, opts = {}) {
  const cfg = netCfg();
  const timeoutMs = opts.timeoutMs || cfg.fetchTimeoutMs;
  const attempts = opts.attempts || cfg.retryAttempts;
  const backoff = opts.backoffMs || cfg.retryBackoffMs;
  let last;
  for (let i = 0; i < attempts; i++) {
    try {
      return await attempt(url, timeoutMs);
    } catch (e) {
      last = e;
      if (i === attempts - 1 || !retriable(e)) break;
      // Exponential with jitter, so a transient outage does not produce a
      // synchronised retry storm from every client that hit it at once.
      await sleep(backoff * Math.pow(3, i) * (0.75 + Math.random() * 0.5));
    }
  }
  throw last;
}

/** Bounded fetch + JSON parse. The shape every config table is loaded through. */
export async function fetchJSON(url, opts) {
  return (await fetchOnce(url, opts)).json();
}

/** Bounded fetch + ArrayBuffer. Used for audio, which is decoded, not parsed. */
export async function fetchBuffer(url, opts) {
  return (await fetchOnce(url, opts)).arrayBuffer();
}

/**
 * Bound a promise this module does not own — specifically `PIXI.Assets.load`,
 * which has no timeout of its own. A stalled image would otherwise hold a level
 * group's `Promise.all` open forever, and with it the loading splash in front
 * of it. The underlying load is NOT cancelled (Pixi caches by URL, so a later
 * retry rejoins it); this only stops the caller waiting on it.
 */
export function withTimeout(promise, url, timeoutMs) {
  const ms = timeoutMs || netCfg().fetchTimeoutMs;
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${url}: timed out after ${ms}ms`)), ms);
    }),
  ]);
}
