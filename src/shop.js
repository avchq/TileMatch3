// Shop screen — an overlay shown on top of whichever scene is active (lobby or
// game), opened by tapping the coin pill in the top HUD. It sells PACKAGES for real
// money: each package grants a mix of contents (a coins amount and/or a set of
// boosters), so it can be a single item (just coins) or a bundle. Modeled on
// SettingsScene (same dim + centred panel + entrance pop + layout reflow), and it
// also exports makeCoinPill(), the shared coin-balance HUD control used by both the
// lobby and the level (parallel to makeCogButton in settings.js).
//
// Buying a package is delegated to the host via onBuyPackage(productId), which runs
// the platform payment provider and, on success, applies the contents
// (user.credit("coins", …) + user.grantBooster(kind, n)). Those emit change events
// that UserStore autosaves and that refresh this panel + the coin pills live.
// (Spending coins on helpers happens on-demand inside a level, not here.)

import { tween, easeOutBack } from "./tween.js";
import { PACKAGES } from "./user/payments.js";

const DESIGN_W = 750;
const DESIGN_H = 1334;

// Icons for the per-package contents summary, matching the in-level helper buttons.
// Ordered so a summary always reads coins → wand → undo → reshuffle.
const CONTENT_ICONS = [["wand", "🪄"], ["undo", "⤺"], ["shuffle", "🔀"]];

// A one-line summary of what a package grants, e.g. "🪙 1200   🪄 3   ⤺ 5   🔀 1".
function packageContents(pkg) {
  const parts = [];
  if (pkg.coins) parts.push(`🪙 ${pkg.coins}`);
  for (const [kind, icon] of CONTENT_ICONS) {
    const n = pkg.boosters && pkg.boosters[kind];
    if (n) parts.push(`${icon} ${n}`);
  }
  return parts.join("   ");
}

// A coin balance "pill" for the top HUD: a 🪙 icon + the live coin count. Reads the
// balance from the User model, refreshes itself on any wallet change, and calls
// onTap (→ open the shop) when pressed. Caller positions it. Exposes update() and
// destroy() (to drop the model subscription when the pill goes away).
export function makeCoinPill(user, onTap) {
  const c = new PIXI.Container();
  const w = 150, h = 60;
  const g = new PIXI.Graphics();
  g.beginFill(0x0a1226, 0.55).drawRoundedRect(-w / 2, -h / 2, w, h, h / 2).endFill();
  g.lineStyle(3, 0xffffff, 0.35).drawRoundedRect(-w / 2, -h / 2, w, h, h / 2);
  c.addChild(g);

  const coin = new PIXI.Text("🪙", { fontFamily: "Arial", fontSize: 38 });
  coin.anchor.set(0.5);
  coin.position.set(-w / 2 + 26, 0);
  c.addChild(coin);

  const label = new PIXI.Text("0", {
    fontFamily: "Arial", fontSize: 32, fontWeight: "900", fill: 0xffffff,
    stroke: 0x14361f, strokeThickness: 4,
  });
  label.anchor.set(0, 0.5);
  label.position.set(-w / 2 + 50, 0);
  c.addChild(label);
  c.label = label;

  c.update = () => { label.text = String(user ? user.balance("coins") : 0); };
  c.update();

  // Live refresh on wallet changes (mirrors the booster-badge listener in game.js).
  const unsub = user ? user.on((domain) => { if (domain === "wallet") c.update(); }) : null;
  c.destroy = ((orig) => function (opts) { if (unsub) unsub(); orig.call(c, opts); })(c.destroy);

  c.eventMode = "static";
  c.cursor = "pointer";
  c.hitArea = new PIXI.Rectangle(-w / 2, -h / 2, w, h);
  c.on("pointertap", () => { onTap && onTap(); });
  c.on("pointerdown", () => c.scale.set(0.94));
  c.on("pointerup", () => c.scale.set(1));
  c.on("pointerupoutside", () => c.scale.set(1));
  return c;
}

const PANEL_W = 640;
const ROW_H = 116;

export class ShopScene extends PIXI.Container {
  constructor(app, audio, user, payments) {
    super();
    this.app = app;
    this.audio = audio;
    this.user = user;
    this.payments = payments;
    this.onBack = null;              // () => void — optional hook when returning
    this.onBuyPackage = null;        // (productId) => Promise — host runs the payment + grants
    this.visible = false;
    this._build();

    // Keep the coin balance header in sync when the wallet changes (a purchase, a
    // win reward…).
    if (this.user) this.user.on((domain) => { if (domain === "wallet") this._refresh(); });
  }

  // Reflow into a DW×DH design area: cover the whole view with the dim and keep the
  // panel centred (see SettingsScene.layout / GameScene.layout).
  layout(DW, DH) {
    this.dim.clear();
    this.dim.beginFill(0x040814, 0.72).drawRect(0, 0, DW, DH).endFill();
    this.panel.position.set(DW / 2, DH / 2);
  }

  _build() {
    // Full-screen dim that also swallows taps meant for the scene beneath.
    const dim = new PIXI.Graphics();
    dim.beginFill(0x040814, 0.72).drawRect(0, 0, DESIGN_W, DESIGN_H).endFill();
    dim.eventMode = "static";
    this.addChild(dim);
    this.dim = dim;

    // Panel — height derived from the number of packages so the list always fits.
    const packages = this.payments ? this.payments.getCatalog() : PACKAGES;
    const pw = PANEL_W;
    const ph = 250 + packages.length * ROW_H + 96;
    this.panel = new PIXI.Container();
    this.panel.position.set(DESIGN_W / 2, DESIGN_H / 2); // pivot at centre for the entrance pop
    this.addChild(this.panel);

    const g = new PIXI.Graphics();
    g.beginFill(0x22335e, 1).drawRoundedRect(-pw / 2, -ph / 2, pw, ph, 36).endFill();
    g.lineStyle(6, 0xffffff, 0.15).drawRoundedRect(-pw / 2, -ph / 2, pw, ph, 36);
    this.panel.addChild(g);

    const title = new PIXI.Text("Shop", {
      fontFamily: "Arial", fontSize: 60, fontWeight: "900", fill: 0xffe27a,
      stroke: 0x5a3a00, strokeThickness: 6,
    });
    title.anchor.set(0.5);
    title.position.set(0, -ph / 2 + 66);
    this.panel.addChild(title);

    // Live coin balance under the title.
    this.balanceText = new PIXI.Text("🪙 0", {
      fontFamily: "Arial", fontSize: 40, fontWeight: "900", fill: 0xffffff,
      stroke: 0x14361f, strokeThickness: 5,
    });
    this.balanceText.anchor.set(0.5);
    this.balanceText.position.set(0, -ph / 2 + 136);
    this.panel.addChild(this.balanceText);

    // One row per package.
    let y = -ph / 2 + 250;
    for (const pkg of packages) {
      this._packageRow(pkg, y);
      y += ROW_H;
    }

    // Back button
    const back = this._makeButton("Back", 300, 84, 0, ph / 2 - 62, 0x4d8dff, () => this._back());
    this.panel.addChild(back);

    this._refresh();
  }

  // A package row: name + a contents summary on the left, a "$price" buy button on
  // the right. Buying grants everything in the package (delegated to the host).
  _packageRow(pkg, y) {
    const leftX = -PANEL_W / 2 + 44;

    const name = new PIXI.Text(pkg.label, {
      fontFamily: "Arial", fontSize: 34, fontWeight: "900", fill: 0xffffff,
      stroke: 0x1a2a52, strokeThickness: 4,
    });
    name.anchor.set(0, 0.5);
    name.position.set(leftX, y - 24);
    this.panel.addChild(name);

    const contents = new PIXI.Text(packageContents(pkg), {
      fontFamily: "Arial", fontSize: 26, fontWeight: "700", fill: 0xcfe0ff,
    });
    contents.anchor.set(0, 0.5);
    contents.position.set(leftX, y + 22);
    this.panel.addChild(contents);

    const btn = this._makeButton(pkg.price, 178, 74, PANEL_W / 2 - 44 - 89, y, 0xff8a3d, () => {
      this.audio.play("btn_01");
      // Real-money purchase is delegated to the host, which runs the platform
      // payment provider and grants the package contents on success.
      if (this.onBuyPackage) this.onBuyPackage(pkg.id);
    });
    this.panel.addChild(btn);
  }

  _refresh() {
    if (this.balanceText) {
      this.balanceText.text = `🪙 ${this.user ? this.user.balance("coins") : 0}`;
    }
  }

  _makeButton(label, w, h, cx, cy, color, onClick) {
    const c = new PIXI.Container();
    c.position.set(cx, cy);
    const g = new PIXI.Graphics();
    g.beginFill(color).drawRoundedRect(-w / 2, -h / 2, w, h, h / 2.4).endFill();
    g.lineStyle(4, 0xffffff, 0.35).drawRoundedRect(-w / 2, -h / 2, w, h, h / 2.4);
    const t = new PIXI.Text(label, {
      fontFamily: "Arial", fontSize: 32, fontWeight: "800", fill: 0xffffff,
    });
    t.anchor.set(0.5);
    c.addChild(g, t);
    c.label = t;
    c.eventMode = "static";
    c.cursor = "pointer";
    c.on("pointertap", onClick);
    c.on("pointerdown", () => c.scale.set(0.95));
    c.on("pointerup", () => c.scale.set(1));
    c.on("pointerupoutside", () => c.scale.set(1));
    return c;
  }

  // Show the screen, syncing the balance header to the current wallet.
  open() {
    this.visible = true;
    this._refresh();
    this.panel.scale.set(0.6);
    tween(this.app.ticker, {
      duration: 300, ease: easeOutBack,
      onUpdate: (e) => this.panel.scale.set(0.6 + 0.4 * e),
    });
  }

  _back() {
    this.audio.play("btn_01");
    this.visible = false;
    if (this.onBack) this.onBack();
  }
}
