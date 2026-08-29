// Real-money purchase abstraction. Each platform the game ships on (Facebook
// Instant, Reddit, Telegram) exposes its own in-app-purchase SDK; this file hides
// those behind one small async contract so the rest of the game stays
// platform-agnostic (mirrors adapters.js, which does the same for storage/identity):
//
//   getCatalog()        -> [{ id, price, label, coins, boosters }]   (packages for sale)
//   purchase(productId) -> { ok, productId, coins, boosters }        (async; ok=false if cancelled)
//
// A PACKAGE is what the player buys for real money. Its contents are flexible:
// a `coins` amount (may be 0) plus a `boosters` map of helper -> count (may be
// empty) — so a package can be a single item (just coins) or a bundle (coins +
// a mix of wands / undos / reshuffles).
//
// The provider is PURE I/O: on a successful purchase it just reports the package
// contents that were bought — the HOST applies them (User.credit / grantBooster).
// This matches how the storage adapters never touch the model directly. IMPORTANT:
// a real integration MUST validate the purchase/receipt server-side before granting
// (see the per-platform TODOs) — the same server-trust caveat adapters.js flags.
//
// MockPaymentProvider is fully working and is the default on the open web (it
// "succeeds" instantly with no real charge, so the flow is testable). The three
// platform providers are STUBS: they extend the mock so TODAY they succeed locally,
// and each documents the exact SDK calls (// TODO(SDK):) to swap in once we
// integrate that platform for real. Nothing outside this file changes at that point.

import { detectPlatform } from "./platform.js";

// The packages offered for real money. `id` is the product/catalog id the platform
// store is configured with; `coins` + `boosters` are what a successful purchase
// grants. A package may hold just coins (a single item) or a combination.
//
// `nameKey` is a TEXT KEY, not wording: the shop looks it up in the active
// language (assets/lang/<code>.json), which is what makes the same catalog row
// read correctly in all 13 languages. `price` stays a literal — it is a store
// price string, not copy.
export const PACKAGES = [
  { id: "coins_small",   price: "$0.99", nameKey: "Pouch Of Coins",
    coins: 100,  boosters: {} },
  { id: "starter_bundle", price: "$4.99", nameKey: "Starter Bundle",
    coins: 300,  boosters: { wand: 1, undo: 2 } },
  { id: "mega_bundle",    price: "$9.99", nameKey: "Mega Bundle",
    coins: 1200, boosters: { wand: 3, undo: 5, shuffle: 1 } },
];

export class MockPaymentProvider {
  constructor() { this.platform = "web"; }

  getCatalog() { return PACKAGES.slice(); }

  // Resolve the package for an id (shared by every provider below).
  _package(productId) { return PACKAGES.find((p) => p.id === productId) || null; }

  // Web/dev default: pretend the purchase succeeded, no real charge. Returns the
  // package contents so the host can grant them (coins + boosters).
  async purchase(productId) {
    const pkg = this._package(productId);
    if (!pkg) return { ok: false, productId, coins: 0, boosters: {} };
    return { ok: true, productId, coins: pkg.coins || 0, boosters: { ...(pkg.boosters || {}) } };
  }
}

// --- Platform stubs -------------------------------------------------------
// Each "succeeds" via the inherited mock behaviour for now. The comments mark
// precisely where the real SDK purchase calls go when we integrate each platform,
// and where server-side receipt validation must happen before crediting coins.

export class FacebookInstantPayments extends MockPaymentProvider {
  constructor() { super(); this.platform = "facebook"; }
  // TODO(SDK): getCatalog() -> const c = await FBInstant.payments.getCatalogAsync();
  //   merge each p.productID with its PACKAGES contents; use p.price / p.title for display.
  // TODO(SDK): purchase(id)  -> const r = await FBInstant.payments.purchaseAsync({ productID: id });
  //   validate r.signedRequest server-side, then FBInstant.payments.consumePurchaseAsync(r.purchaseToken),
  //   and only then resolve { ok: true, coins, boosters } from the package.
}

export class TelegramPayments extends MockPaymentProvider {
  constructor() { super(); this.platform = "telegram"; }
  // TODO(SDK): purchase(id) -> the bot backend creates an invoice (Telegram Stars / XTR)
  //   and returns an invoice url; then Telegram.WebApp.openInvoice(url, (status) => …)
  //   (callback API — wrap in a Promise). Credit only after the bot confirms the
  //   successful_payment update server-side; resolve { ok:false } on "cancelled"/"failed".
}

export class RedditPayments extends MockPaymentProvider {
  constructor() { super(); this.platform = "reddit"; }
  // TODO(SDK): Reddit games run on Devvit — payments are server-side. The webview
  //   posts a purchase request over the postMessage bridge; the Devvit runtime runs
  //   the payments API (addPaymentHandler / onOrder), validates the order, grants
  //   the coins on the server, and posts the result back. Resolve from that reply.
}

export function makePayments(platform = detectPlatform()) {
  switch (platform) {
    case "facebook": return new FacebookInstantPayments();
    case "telegram": return new TelegramPayments();
    case "reddit":   return new RedditPayments();
    default:         return new MockPaymentProvider();
  }
}
