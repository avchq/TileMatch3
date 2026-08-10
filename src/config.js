// ============================================================================
//  GAME CONFIG — the single source of truth for every KEY PARAMETER
// ============================================================================
//
//  This file holds the game's *tuning knobs*: feature gates, unlock schedules,
//  progression thresholds and economy amounts. They used to be scattered as
//  `const`s across src/game.js, src/user/User.js, src/fortunewheel.js … which
//  meant re-reading the code to answer "when does the shop open?". They all
//  live here now, each with an explanation of what it does and what happens if
//  you change it, so the whole design can be re-balanced from one screen.
//
//  >>> RULE: every NEW tunable parameter goes in this file. <<<
//  If you find yourself typing a bare number or a level threshold into a module
//  under src/, add it here instead and import it. Modules should read config,
//  never define it.
//
//  ---- What belongs here, and what does not --------------------------------
//  IN:  anything a designer would want to re-balance — level gates, unlock
//       levels, grant sizes, rewards, capacities, thresholds, timings that
//       change how the game *plays*.
//  OUT: (a) LAYOUT/VISUAL constants — panel sizes, slot pitch, colours, tween
//           durations. They belong next to the scene that draws them (see
//           src/layout.js `DESIGN_W/H` and the per-scene consts).
//       (b) STRUCTURAL invariants that code cannot honour if changed — e.g. a
//           match is 3 tiles: the solvable-board generator in src/level.js is
//           built around triples, so "3" is not a knob and is deliberately
//           absent from this file.
//       (c) Big DATA TABLES, which stay as JSON under assets/config/ so they can
//           be edited without touching source at all:
//             assets/config/levels.json      — the level table (bg/data/types)
//             assets/config/prices.json      — coin prices (helper buys, continue)
//             assets/config/turntable.json   — Fortune Wheel prize groups + odds
//             assets/config/dailybonus.json  — Daily Bonus weighted prize pool
//             assets/config/tasks.json       — Tasks: achievement chains + weekly list
//           The *gates and pacing* for those features (unlock level, spins per
//           cycle, weekly reset day) live HERE; the JSON files hold only the
//           prize/goal data.
//
//  ---- Why a JS module and not another JSON file ---------------------------
//  Two reasons. (1) Comments: JSON has none, and these parameters are useless
//  without the paragraph that says what they mean. (2) Timing: JSON configs are
//  fetched (async) during boot, but some of these values are needed
//  synchronously — `User.migrate()` reads the unlock schedule while rehydrating
//  a saved profile, before any fetch could have resolved. A plain ES module
//  import has neither problem, and with no build step it is still just a data
//  file you can edit and reload.
//
//  Everything is frozen: config is read-only at runtime. Tune it by editing
//  this file, not by assigning to it.
// ============================================================================

export const CONFIG = deepFreeze({

  // --------------------------------------------------------------------------
  //  PROGRESSION — what the player is allowed to do, by level reached
  // --------------------------------------------------------------------------
  //  NOTE ON THE LEVEL CONVENTION used by every `unlockLevel` below:
  //  a gate of N reads "available from level N onward", i.e. it opens once the
  //  player has CLEARED level N-1 (`user.completedLevel() >= N - 1`). So N = 1
  //  means "available from the very start" and N = 3 means "after passing
  //  level 2". Gates are derived from progress, never stored, so a QA jump
  //  straight to a later level is honoured with no bookkeeping to repair.
  progression: {
    // The level that opens the modal "How To Play" popup and runs the guided
    // opening (two moves played for the player, pointing hand on the third).
    // The gate is the LEVEL NUMBER, not "is a new player" — so a returning
    // player who replays this level meets the tutorial again. Raising it moves
    // the lesson to a later level; there is no "off" value short of setting it
    // to a level that does not exist.
    tutorialLevel: 1,

    // AUTO COMPLETE — the free endgame shortcut that sweeps the remaining tiles
    // into the tray and wins the level. It is not a booster and costs nothing,
    // so both bounds below exist to stop it from eating real play.
    autoComplete: {
      // Withheld on the levels below this one. Level 1 exists to teach the core
      // loop, and a free "finish it for me" would let a new player skip the
      // lesson — so the button first appears on level 2. Set to 1 to offer it
      // everywhere, or raise it to keep players hand-playing for longer.
      minLevel: 2,

      // Offered only once the endgame is trivially solvable: this many tiles or
      // fewer left (board + tray) AND nothing still covered. 12 = four easy
      // triples. The remaining count is always a multiple of 3, so this can
      // never hand a win over a genuinely unmatchable leftover. Raising it makes
      // the shortcut appear earlier (and skips more of the level); lowering it
      // makes it a last-two-triples courtesy.
      maxTiles: 12,
    },
  },

  // --------------------------------------------------------------------------
  //  FEATURE GATES — which features are offered, and when
  // --------------------------------------------------------------------------
  //  Each entry gates one whole feature behind progression, using the level
  //  convention documented above. A gated feature is not merely disabled: its
  //  entry point (the shop's cart badge, the lobby's feature-rail buttons) is
  //  withheld entirely, so the interface stays as small as the player's
  //  vocabulary. Where a feature also has pacing knobs, they sit alongside its
  //  gate here; its PRIZE DATA stays in the matching JSON file.
  features: {
    // THE COIN SHOP (src/shop.js), reached by tapping the coin pill.
    shop: {
      // Below this, the coin pill is a plain balance counter: no shopping-cart
      // badge and taps do nothing (in the lobby and in a level alike). 3 = the
      // store opens after passing level 2, and lights up live with no reload.
      // No amount of coins buys past this gate.
      unlockLevel: 3,
    },

    // THE FORTUNE WHEEL (src/fortunewheel.js) — the daily prize wheel reached
    // from the lobby's feature rail. Prize groups + odds: assets/config/turntable.json.
    fortuneWheel: {
      // Below this the lobby's Free Spin button does not exist (and the Daily
      // Bonus button slides up into its slot). NOTE: this port currently ships
      // 13 levels, so 5 is reachable in normal play — but if you want to demo
      // the wheel immediately, drop this to 1.
      unlockLevel: 5,

      // Spins allowed per daily cycle. The FIRST is free; every one after costs
      // a rewarded video (stubbed — no ad network is wired up yet). The wheel
      // closes itself once the last spin resolves, and the count resets at the
      // next calendar-day rollover along with the won-prize list. It also sizes
      // the row of "pips" drawn under the wheel.
      spinsPerCycle: 6,

      // The prize `type` treated as the wheel's headline: winning it gets an
      // extra highlight before it flies to its counter. Must match a `type` used
      // in turntable.json (coins|undo|wand|shuffle|lightning) or nothing is ever
      // highlighted. "lightning" is a coins bonus kept as the jackpot slice.
      headlinePrize: "lightning",
    },

    // THE DAILY BONUS (src/dailybonus.js) — the free once-a-day mystery box,
    // second entry on the lobby's feature rail. Prize pool + weights:
    // assets/config/dailybonus.json. There is no streak and no cycle state:
    // eligibility is purely "has the calendar day changed since the last claim?".
    dailyBonus: {
      // 1 = available from the very start, which is the point: it is the
      // day-one return hook. Raise it only if the first session feels crowded.
      unlockLevel: 1,
    },

    // TASKS (src/tasks.js) — the checklist of goals reached from the lobby's
    // RIGHT-edge feature rail. Two lists in one screen: permanent tiered
    // Achievements and a weekly set that resets every Monday. Both are scored
    // off the same lifetime activity counters on the profile
    // (user.tasks.stats), so one match or booster use feeds every task
    // watching it. The goal table itself — the chains, their tiers, the
    // targets and the rewards — is a big data table and lives in
    // assets/config/tasks.json.
    tasks: {
      // Below this the lobby's Tasks button does not exist and the screen
      // cannot be opened. 10 is late on purpose: the feature is a
      // long-horizon hook, and offering it to a player who has not yet met
      // boosters, the shop and the wheel just crowds the lobby. Counters tick
      // from the very first level either way, so a player arriving at the gate
      // finds their history already filled in (and usually a few tiers
      // stacked up, ready to claim). NOTE: this port currently ships 13
      // levels, so 10 is reachable but late — drop it to demo the screen sooner.
      unlockLevel: 10,

      // The weekday the WEEKLY list resets on, at local midnight:
      // 0 = Sunday, 1 = Monday (shipped), … 6 = Saturday. On reset every
      // weekly task's progress returns to zero and every one becomes
      // claimable again, including ones already claimed. Achievements are
      // permanent and ignore this entirely. Changing it moves the deadline
      // (and the "Reset in: 3d-14h" countdown) to a different weekday; the
      // current week ends early or runs long exactly once, then settles.
      weeklyResetDay: 1,
    },
  },

  // --------------------------------------------------------------------------
  //  BOOSTERS — the in-level helpers (Undo / Reshuffle / Wand)
  // --------------------------------------------------------------------------
  boosters: {
    // Every helper code the game knows about. The inventory on the player
    // profile is a KEYED MAP, so adding a helper here (plus its rows in
    // `startingInventory` / `unlocks` and a button in src/game.js) needs no
    // change to the User model itself.
    kinds: ["undo", "shuffle", "wand"],

    // What a BRAND-NEW account is awarded. All zeroes on purpose: helpers are a
    // progression reward, not a starting hand, so the first levels are played
    // with nothing but taps and the unlock below is the moment they arrive.
    // Bump a value to hand new players a free taste of that helper instead.
    startingInventory: { undo: 0, shuffle: 0, wand: 0 },

    // THE UNLOCK SCHEDULE — the one table that decides when each helper turns on
    // and how much stock it arrives with. Until its `level` is reached the button
    // still shows its icon (so the row is familiar by the time it comes alive)
    // but is dimmed, wears a 🔒 badge, and refuses both taps and scripted calls
    // with an "Unlocks at Level N" label.
    //
    //   level — the usual "usable from level N onward" convention (see above).
    //   grant — uses added to the inventory the moment it unlocks, ONCE and only
    //           once (`user.boosterUnlocks` records what has been paid out, so
    //           spending the stock and clearing more levels never re-grants it).
    //
    // Order matters only for readability; retiming a helper is a single edit
    // here. Note the staggering: one new thing to learn per level or two.
    unlocks: {
      undo: { level: 2, grant: 2 },     // the safety net, so it comes first
      wand: { level: 3, grant: 2 },     // the one that always works, taught early
      shuffle: { level: 5, grant: 2 },  // "the board is stuck" — needs a fuller board to make sense
    },

    // THE COACHED FIRST USE — unlocking a helper is only half the lesson. On the
    // level a helper turns on, the screen dims, that one button is lifted out of
    // the dim with a caption and a tap effect, and the only thing the player can
    // do is use it once, for real (a genuine use: it spends a charge and the
    // helper actually acts). It happens once per helper, ever — the record lives
    // on the profile as `user.boosterCoach`.
    //
    // A helper whose unlock level was never played — a QA jump, or a save that
    // was already past the gate before coaching existed — is still OWED its
    // coaching and gets it on the next level played, one helper per level,
    // lowest unlock level first. Without that the feature would never reach an
    // existing player at all.
    coach: {
      // Master switch. false ships the unlock schedule with no coaching at all:
      // helpers simply stop being grey, as they did before.
      enabled: true,

      // Undo is the one helper that cannot be demonstrated on a fresh board —
      // there is nothing to undo until a tile has been collected — so its
      // coaching waits for the first collect and then this beat, long enough
      // that the tile has landed in the tray and the dim doesn't clip the
      // animation. The other two coach the moment the board finishes building.
      undoDelayMs: 250,
    },
  },

  // --------------------------------------------------------------------------
  //  ECONOMY — currencies and the free coin faucet
  // --------------------------------------------------------------------------
  //  Coin PRICES (buying a helper at 0 stock, and the Out-of-Moves continue) are
  //  a data table and live in assets/config/prices.json instead.
  economy: {
    // Known virtual currency codes. The wallet is a keyed map like the booster
    // inventory, so a new currency is just a code here (credit/debit/balance
    // take an arbitrary code) — no model change. "gems" is reserved: nothing
    // spends or earns it yet.
    currencies: ["coins", "gems"],

    // The wallet a brand-new account starts with. Zero coins means the first
    // helper buy must be earned by clearing levels (or bought in the shop),
    // which is what gives `coinWinReward` its pull. Seed it if playtests show
    // players stalling before their first purchase.
    startingWallet: { coins: 0, gems: 0 },

    // Coins paid for clearing a level (the win overlay shows the reward). This
    // is the game's only FREE coin faucet — packages in the shop are the paid
    // source — so it sets how fast a non-paying player can afford the helper
    // buys and the Out-of-Moves continue in prices.json. Balance the two
    // together: at 25/level, a 300-coin continue costs about a dozen wins.
    coinWinReward: 25,
  },

  // --------------------------------------------------------------------------
  //  BOARD — the rules of the play space
  // --------------------------------------------------------------------------
  //  Sizes and positions are NOT here (see the layout consts in src/game.js);
  //  this is the one board number that changes how the game plays.
  board: {
    // Slots in the bottom tray — the core difficulty dial. Collect a tile and it
    // goes here; fill every slot with no triple completed and the round is lost
    // (the Out-of-Moves overlay). Fewer slots = far harder; more = nearly
    // impossible to lose. 7 matches the original game. This is the BASE capacity
    // every level starts with; `extraSlot` below can raise it by one for the rest
    // of a level. The tray's on-screen slot size is derived from the number of
    // cells drawn so the row always fits the 750-wide column, meaning a big change
    // here also visibly resizes the tray.
    traySlots: 7,

    // THE 8th SLOT — an ad-funded, ONE-PER-LEVEL capacity boost. Not a permanent
    // upgrade, not bought with coins, and not persisted: an extra cell at the
    // right-hand end of the tray, covered by a "📺 +1" button, that a completed
    // rewarded video turns into an ordinary empty slot for the remainder of the
    // level being played. Capacity returns to `traySlots` on every board build
    // (next level, Replay, retry after a loss) and with it the offer, so each
    // attempt is a fresh one. A revive keeps whatever capacity the tray has,
    // because it does not rebuild the board.
    extraSlot: {
      // The campaign level from which the extra cell is DRAWN and the offer made
      // at all — the usual "available from level N onward" convention, i.e. once
      // level N-1 has been cleared. Below it the tray is a plain row of
      // `traySlots` cells, centred with no gap where the extra one would be; there
      // is no lock icon, no announcement and nothing to claim — the cell simply
      // starts being there. The gate reads CAMPAIGN progress, not the level of the
      // board you happen to be on, and is re-checked every time a board is built.
      // 9 keeps the base tray as the whole difficulty story for the first eight
      // levels; drop it to offer the boost (and its ad) sooner.
      unlockLevel: 9,

      // Slots the video adds. Exactly one, and the offer is only shown while
      // capacity is still at the base value — so the button disappears the moment
      // it is taken and there is no way to stack this to 9 slots. Raising it makes
      // a single video worth more, not the offer repeatable.
      grant: 1,
    },

    // TRAY PRESSURE WARNINGS — how much room is left before the tray is full,
    // counted in FREE slots against the LIVE capacity rather than a fixed tile
    // count. That is what makes taking the 8th slot shift both cues up by exactly
    // one tile (the pulse from 5-of-7 to 6-of-8, the bubble from 6-of-7 to 7-of-8)
    // instead of firing early on a boosted tray.
    warnings: {
      // Free slots at which the whole tray starts pulsing. 2 = "two tiles from
      // full". Raise it to warn earlier (and more often); 0 switches the pulse off.
      pulseAtFree: 2,

      // Free slots at which an "Insufficient space!" bubble pops above the tray.
      // 1 = the last-chance warning, one tile from a loss. It fires once per
      // crossing, not on every tap while the tray sits at the threshold. Must be
      // at or below `pulseAtFree` to read as an escalation; 0 switches it off.
      bubbleAtFree: 1,
    },
  },

  // --------------------------------------------------------------------------
  //  PERSISTENCE — how eagerly the profile is written back
  // --------------------------------------------------------------------------
  persistence: {
    // Autosave debounce. Every change to the player profile schedules a save
    // this many milliseconds later, so a burst of mutations (a win crediting
    // coins, advancing the level and paying an unlock grant) collapses into one
    // write. A pending write is always flushed when the tab is hidden or closed,
    // so raising this only trades write frequency for a slightly larger window
    // in a hard crash. Cloud adapters (Facebook/Telegram/Reddit) are slow and
    // rate-limited, which is why this is not 0.
    saveDebounceMs: 400,
  },
});

// Recursively freeze so a stray `CONFIG.features.shop.unlockLevel = 1` throws in
// strict mode (ES modules are always strict) instead of silently re-balancing
// the game at runtime.
function deepFreeze(obj) {
  for (const v of Object.values(obj)) {
    if (v && typeof v === "object") deepFreeze(v);
  }
  return Object.freeze(obj);
}
