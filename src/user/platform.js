// Platform detection + adapter factory. Kept tiny and dependency-free so it can
// run before anything else during boot.

import {
  LocalStorageAdapter,
  FacebookInstantAdapter,
  TelegramAdapter,
  RedditAdapter,
} from "./adapters.js";

/** Best-effort sniff of the host platform. Defaults to "web" (open browser). */
export function detectPlatform() {
  try {
    if (typeof window !== "undefined") {
      if (window.FBInstant) return "facebook";
      if (window.Telegram && window.Telegram.WebApp && window.Telegram.WebApp.initData) return "telegram";
      if (window.devvit) return "reddit"; // Devvit webview bridge
    }
  } catch (_) {}
  return "web";
}

export function makeAdapter(platform = detectPlatform()) {
  switch (platform) {
    case "facebook": return new FacebookInstantAdapter();
    case "telegram": return new TelegramAdapter();
    case "reddit":   return new RedditAdapter();
    default:         return new LocalStorageAdapter();
  }
}
