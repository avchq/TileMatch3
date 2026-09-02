# Tile Match 3 — Pixi.js

**Tile Match 3** is a JavaScript/[Pixi.js](https://pixijs.com) stacked-tile
match-3 game. The playable levels are declared in the JSON config
`assets/config/levels.json` (currently **13**).

## Gameplay
The first thing on screen is the **splash screen** — the game title over a
**progress bar**, a percentage and a status line ("Loading assets…") — held until
everything the first screen needs is in memory, then faded out. It is plain
**DOM/CSS** (`index.html` + `src/splash.js`), not a Pixi scene, so it is painted
from the very first frame, before `vendor/pixi.min.js` and the ES modules have
even been fetched, and covers the whole of boot rather than only the part after
Pixi starts. If boot **fails**, the splash stays up and turns red with the
reason instead of fading onto a blank canvas — including for failures that
happen *before* `boot()` exists (a bad import, a module that throws while being
evaluated), which an inline handler in `index.html` catches, since `boot()`'s own
`.catch()` cannot see those. `boot_resilience_test.py` guards it. See the boot section below for what fills the bar.

After it fades you land on the **lobby** screen, which shows a big
**"Level &lt;n&gt;"** button for the level you're on, anchored to the **bottom edge**
of the screen under the centred title block (progress is saved in `localStorage`,
so it's remembered between visits). Tap it to start.

**Except on a player's very first run.** A **brand-new user** — one who has never
played, has no progress and has never completed level 1 — skips the lobby entirely
and is dropped **straight into level 1**. They meet the lobby for the first time
when they **complete** that level, which is also what ends the first-run flow: from
then on every load lands on the lobby as usual. See `user.isNewPlayer()` /
`progress.completed` in the User section below.

### The "How To Play" popup
The very first thing level 1 does — before the player is handed any control — is
open a modal **"How To Play"** popup over the freshly dealt board. It carries a
single line, **"Collect 3 identical tiles to remove them"**, over an animated
demonstration of exactly that: a small **3×3 board** (three groups of three) above
its own **tray**, with a pointing hand that collects matching tiles one by one —
each flies down into the tray, and the moment the third of a kind lands the triple
pops and vanishes, the ordinary game loop in miniature. The board refills and the
demonstration loops. Its pieces (title, line, the three board rows, the arrow and
tray, the button) **fade in one after another** over spinning light rays.

An **OK** button closes it, and once that fade-in sequence has finished a tap
**anywhere** closes it too. There is **no skip button** anywhere in the sequence.
Closing it also writes a "tutorial done" marker into the browser's own storage
(`localStorage`, separate from the save record) — a leftover from an earlier
design: **nothing in the game ever reads that marker back**.

The popup is tied to *being on level 1*, not to being a new player, so in normal
linear play (level 1 is played once) it is a strictly first-session experience —
but a returning player who replays level 1 does meet it again. Closing it hands
straight over to the guided opening below.

### The guided first level
That first level is deliberately pared back to the one thing there is to learn —
tapping tiles. While a brand-new player is in level 1:
- The top bar shows **only the coin counter**. The **settings** cog is hidden, and
  so is the **shop**: the coin pill keeps the balance but loses its cart badge and
  no longer opens the store. (The cog and Back button come back the moment level 1
  is cleared; the **shop** waits longer — it has a progression gate of its own and
  only appears after **level 2** is passed, see Coins below.)
- There is **no Back button** — the level can't be left before it's played. (There
  is therefore no way to quit level 1 part-way; the only way out is to finish it.)
- **The How To Play popup opens first** (above) and locks the level behind it;
  everything below starts when it closes.
- **The first two moves are played for you.** As soon as the board is built the
  game looks for three identical tiles that are all free to tap right now. Finding
  a group, it flies **two** of them into the tray on their own, with no input, and
  puts an **animated pointing hand** on the third — so the very first tap is
  guaranteed to complete a match and show the whole loop (collect →
  three-of-a-kind → the tiles vanish) in one action. The hand disappears the
  moment **any** tile is collected, and on leaving for the home screen. If the
  board happens not to offer a clean group of three free tiles, the guidance is
  simply skipped and play starts normally.
- **The helpers are locked** (see below), so there is nothing else to press.

The stripped-down treatment applies to *any* play of level 1 while the player is
still brand new, not just the one the boot flow opened; completing level 1 brings
the ordinary interface back.

Tap any **fully-uncovered** tile to move it to the tray at the bottom. The tray
keeps **matching types grouped**: a collected tile drops in next to others of its
kind, or onto the end (top) of the row if its type isn't there yet. Collect
**3 of the same fruit** to clear them. Clear the whole board to win — you're
returned to the lobby, now advanced to the next level. If the tray fills up with
no match — **7 tiles**, or **8** once the ad-funded [8th slot](#the-8th-slot--an-ad-funded-extra-cell)
has been taken — you're **out of moves** — a modal **"Out of Moves"** overlay
gives you a second chance instead of a dead end (see below). Space running out is
signalled before it happens: **two tiles from full** the whole tray starts
**pulsing**, and **one tile from full** an **"Insufficient space!"** bubble pops
above it. Both are measured against the tray's *current* capacity, so taking the
8th slot shifts each of them up by one tile. In-game
**helpers** (boosters), a row of three below the tray: **Reshuffle** (left),
**Wand** (middle), **Undo** (right).
- **Undo** — return the last-added tile (the most recent one, wherever grouping
  placed it in the tray) back to **its original cell on the board**; repeated
  undos walk the stack back in **reverse placement order**. It lands on the exact
  cell even if you tap Undo mid-slide (the in-flight tray-slide animation is
  cancelled first, so the tile can't be dragged to a wrong spot). **Disabled/
  greyed-out when the tray is empty**, as there's nothing to undo.
- **Wand** (magic hint) — **guarantee one instant match**: the tiles needed to
  complete a triple fly from the board into the tray and immediately clear,
  relieving tray pressure. It **prioritises available tiles** — the free,
  top-layer, tappable ones — and only reaches into **unavailable** tiles (the
  greyed-out ones still covered on a lower layer) when a colour hasn't enough
  free tiles left to finish its triple. So it first picks the completion that
  uses the **fewest covered tiles** (an all-available triple beats one that must
  dip into a covered tile), and only then the cheapest completion — a colour
  already holding a **pair** in the tray (pull 1 more, frees two slots), else a
  colour holding a **single** (pull 2), else a fresh colour off the board (pull a
  full 3). Within a colour, tiles are drawn most-accessible-first so the move
  reads as one you could have made. A win streak can charge the Wand's button
  into its upgraded form, the **Super Wand** — see
  [Super Wand — an earned upgrade to the Wand](#super-wand--an-earned-upgrade-to-the-wand)
  below.
- **Reshuffle** — redeal the faces of the tiles still on the play board into a
  fresh arrangement that's still guaranteed solvable; the bottom tray/deck is
  left untouched, and positions and progress are kept, so the level is **not**
  restarted.

**Helpers are not available in the first levels.** A new account is awarded
**none of them**, and each one **unlocks at its own level** — **Undo** from level
2, **Wand** from 3, **Reshuffle** from 5 — paying out **2 uses** the
moment it unlocks (once, and only once). Until then the button still shows its
icon, so the row is familiar by the time it comes alive, but it is **dimmed and
wears a 🔒 lock badge** and cannot be used: a tap plays a "nope", shakes the
button and floats an **"Unlocks at Level N"** label above it. "Unlocks at level N"
means the player has **cleared level N-1**. The schedule is a single table,
`boosters.unlocks` in the central config **`src/config.js`** (see Key parameters
below).

Once unlocked, a helper is drawn from a **limited inventory** stored on the player
profile — a count **bubble** on the button shows how many uses remain and every use
spends one. When a helper hits **0** it doesn't just disable — tapping it walks an
**acquisition ladder** so you can keep playing:
1. **Own one** → the bubble shows the remaining **count** (green) and a tap spends
   one, as usual.
2. **Out of stock, can afford one** → the bubble shows the **coin price** (a gold
   coin + amount); a tap **buys one with coins** from your wallet and uses it in
   the same press (net inventory unchanged, coins spent).
3. **Out of stock and can't afford one** → the bubble shows a **"watch an ad"**
   icon (📺); a tap grants a **free** use via a rewarded ad. *(No ad network is
   wired up yet — the tap grants the reward immediately; the icon is the
   placeholder.)*

An *unlocked* helper is only **disabled/greyed** when there's **no move to make**
(e.g. Undo with an empty tray), never merely because stock ran out — the ladder
always yields a use. A **locked** one is greyed regardless: no amount of coins
buys past a progression gate. The **coin prices** live
in a JSON config (`assets/config/prices.json`) so they're tunable without touching
code.

#### The coached first use

Unlocking a helper is only half the lesson — on its own, the button just stops
being grey. So the first time each helper is available, the level **dims**, that
one button is **lifted out of the dim** with a **caption** above it and a pulsing
tap effect on top, and the rest of the game is parked:

| Helper | Coached on level | Caption |
| --- | --- | --- |
| **Undo** | 2 | *"Undo the last move"* |
| **Wand** | 3 | *"Auto match a group of tiles"* |
| **Reshuffle** | 5 | *"Reset the remaining tiles in this level"* |

While it is up **nothing else responds** — tiles, the other two helpers, Auto
Complete — and there is **no way to dismiss it**: no OK button, and tapping the
dim does nothing. The only way out is to use the helper, which is the point of
it. The tap is **not a demo**: it runs the real helper on the real board and
spends a charge through the ordinary ladder, so the undo genuinely rolls the last
move back, the wand genuinely completes a triple, and the reshuffle genuinely
re-deals.

**Wand** and **Reshuffle** coach the instant the board finishes building.
**Undo** waits for the **first collected tile** — there is nothing to undo before
that — and appears a beat later. A helper that has **no move to make** is not
coached at all that level (it would be a modal with no exit); the lesson simply
stays owed.

Each helper is coached **once, ever**, recorded on the profile as
`user.boosterCoach`. Leaving the level mid-lesson doesn't count — it fires again
next time. And a helper whose unlock level was **never played** (a QA jump, or a
save that was already past the gate) is **still owed** its coaching and gets it on
the next level played, one helper per level, lowest unlock level first. The
feature can be switched off wholesale with `boosters.coach.enabled` in
**`src/config.js`**.

### The 8th slot — an ad-funded extra cell
The tray normally holds **7 tiles**, and filling all 7 without completing a match
is how you lose — so tray space *is* the difficulty. The **8th slot** is an extra
cell at the right-hand end of the row. It is **not** a permanent upgrade and **not**
bought with coins: it is an **ad-funded, one-per-level capacity boost**.

- **It is hidden entirely before level 9.** Up to and including level 8 the tray is
  a plain row of 7 cells, centred with no gap where the extra one would be. From
  level 9 (`board.extraSlot.unlockLevel` in **`src/config.js`**) the tray is drawn
  with 8 cells and the whole row **re-centres** to make room. Nothing is earned,
  claimed or persisted — no lock icon, no announcement, no popup; the slot simply
  starts being there. The check is re-run every time a board is built, so it
  appears on the very next level you start after crossing the threshold, and it
  reads your **campaign progress**, not the level of the board you're on (so a
  replay of an early level still gets it).
- **The cell being visible does not mean it is usable.** It arrives covered by a
  button showing a **📺 video-ad icon and "+1"**, and the tray's real capacity is
  still 7 — a 7th tile still loses you the level. **Tap "+1" and watch a rewarded
  video** *(stubbed — no ad network is wired up yet)* and the capacity goes 7 → 8,
  the button disappears, and the cell becomes an ordinary empty slot.
- **Once per level.** The button is only shown while capacity is at the base value,
  so the moment it is raised the offer is gone — there is no way to reach 9 slots.
- **During live play only.** The button does nothing while the level isn't running
  or the board is busy: a match resolving, an Auto Complete sweep, a revive, the
  tutorial popup, a coached first use, or the end-of-level overlay.
- **The offer is shown whether or not an ad is loaded.** Unlike the fail screen,
  which swaps its ad button for a coin button when no video is available, this
  button is always present. If no video is ready you get **"Ad not ready, please
  try again later!"**, nothing is consumed, and the button stays for another
  attempt. Cancelling or failing simply leaves the tray at 7.
- **It shifts both warnings up by one**, since they are measured against capacity:
  the tray pulses at 6 tiles instead of 5, and the "Insufficient space!" bubble
  pops at 7 instead of 6.
- **It lasts one level.** Capacity is reset to 7 every time a board is **built** —
  starting the next level, replaying, retrying after a loss — and the "+1" button
  comes back with it, so each attempt is a fresh offer. A **revive** (Out of Moves
  → Continue) does *not* rebuild the board, so it **keeps** whatever capacity the
  tray has.
- **It is not persisted.** The original saves the boost alongside a mid-level save
  so a resumed level keeps the expanded tray; this port has **no mid-level save at
  all** — leaving a level always rebuilds the board on return — so there is nothing
  to restore into, and the boost ends with the attempt exactly as a rebuild would
  end it. No new profile state, no schema migration.

The revive on the loss screen addresses the same problem from the other end and is
a separate offer with its own rules (once per level, coins or a video, hands most
of your collected tiles back to the board). The 8th slot is **preventative**, the
revive is **corrective**; taking one does not affect the other.

### Out of Moves — a paid second chance
When the tray fills with no match left, a strictly **modal "Out of Moves"**
overlay appears (the dim swallows all taps — there's **no way to close it** except
its three buttons):
- **Home** — leave to the lobby with progress kept.
- **Replay** — restart the level from scratch.
- **Continue** — **pay to keep playing this very board**. It follows the same
  **waterfall** as the boosters: if you can **afford** the coin price, the button
  shows a **gold coin + price** and a tap **spends coins**; if you **can't afford**
  it, the button shows a **📺 "watch an ad"** tag and a tap grants a **free**
  continue via a rewarded ad *(stubbed — grants immediately)*. On Continue, every
  collected tile **flies back to its original board cell** — animated, **one at a
  time**, in **reverse placement order** (newest first, exactly as a rapid run of
  **Undo**s pops them off the top of the stack); input is locked until the last tile
  lands, then play resumes. The continue **price** lives in the
  same `assets/config/prices.json` (the `continue` key), so it's tunable without
  touching code.

**Coins** are a spendable currency shown in a **coin pill** at the top-right of
both the lobby and the level HUD. You **earn 25 coins for clearing a level** (the
win overlay shows the reward).

The **shop is a progression unlock like the helpers**: it only opens up once the
player has **passed level 2** (`features.shop.unlockLevel` = 3 in
**`src/config.js`**, read as "available from level 3 onward"). Until then the pill is a plain coin
counter — it still shows the balance, but it loses its **shopping-cart badge** and
ignores taps, in the lobby and in a level alike. Clearing level 2 lights it up
**live**, with no reload. Afterwards, tapping the coin pill opens the **Shop**, which sells
**packages** for real money — each grants a mix of contents (a coins amount and/or a
set of boosters), so a package can be a single item (just coins) or a bundle (e.g.
1200 coins + 3 wands + 5 undos + 1 reshuffle). See the Shop + User sections below.

When the board is down to a **trivially solvable endgame** — **12 or fewer tiles
left** (≤ 4 easy triples) with **nothing still covered** — an **Auto Complete**
button appears in the helper row, **replacing** the three helpers. It's **free**
(not a booster). Press it and every remaining tile gathers into a pile, then
flies one-by-one along a curved path into the tray's first slot, popping on
arrival — **each landing bops**, the same cue a hand-collected tile makes, so the
sweep sounds like the run of moves it stands in for rather than falling silent
after the gather — when the last one lands, the level is won. It is **not offered on
level 1** — the teaching level is played by hand all the way to the win — so it
first appears on level 2. The **cog** (top-left) opens Settings and the
**‹ Back** button beside it leaves the level for the lobby with progress kept.

### Feature buttons — the lobby rails
The lobby's **feature entry buttons** are not pinned to fixed spots. They are
entries on a **feature rail** (`src/featurerail.js`): a vertical ladder of
**slots** running top-to-bottom down an **outer edge** of the game column, filled
by whichever buttons are currently **available**, in a **fixed priority order**.

There are **two rails**, one down each edge, and they are two instances of the
same class — the rail owns only an `x` and a slot ladder, so a second edge needs
no new machinery:

- **Left rail** (`RAIL_LEFT_X` 86), under the settings cog — the **daily** features,
  which come and go with the day's cycle, plus one standing read-out registered
  after them:
  1. **Free Spin**
  2. **Daily Bonus**
  3. **Super Wand** — a "streak/needed" progress pill, not a doorway (see
     [Super Wand](#super-wand--an-earned-upgrade-to-the-wand)). It is registered
     last precisely so it never bumps a claimable Free Spin or Daily Bonus out of
     the top slot; it just settles into whichever slot is left.
- **Right rail** (`RAIL_RIGHT_X` 664), under the coin pill — the **permanent**
  destinations:
  1. **Tasks**

The split is by behaviour, not by looks: a left-rail button disappears once the
day's spin is used or the gift is claimed and returns at the next rollover, so the
column genuinely reflows. **Tasks** never goes away once unlocked, so it would
just sit at the bottom of the left rail forever — and putting it opposite keeps
the reflowing column short. The Super Wand read-out is likewise never hidden
once unlocked — unlike the two daily buttons above it there is no "used up
today" state, so it is offered whether its meter reads empty, filling or full —
but it stays on the left rail rather than joining Tasks on the right, since it
is registered as the last entry on the left ladder and simply drops into
whichever slot the daily buttons leave open.

The rail always packs them into **consecutive slots with no holes**. If #1 is
unavailable, **#2 takes its place**; the moment #1 becomes available again it
reclaims the top slot and #2 **moves back down** to its ordered position. Every
such move is **animated** — a button changing slots **slides** between them
(~320 ms, ease-in-out) while one entering **fades in** at its slot and one leaving
**fades out** in place (~220 ms). A leaving button stops accepting taps at the
*start* of its fade, not the end. Arriving at the lobby **snaps** the rail into its
arrangement rather than playing a slide.

The reflow is **staggered**: a button entering the rail holds its fade-in until the
slides have finished. Slots are only about **1.2 button-heights** apart, so a
neighbour sliding past would otherwise be sitting on top of the arriving button for
most of the move — and two overlapping controls is exactly what
`resize_overlap_test.py` forbids. A button waiting to enter is not on screen at
all (opacity drives `visible`), so it is neither hit-testable nor counted as a
control.

Availability is per feature and unchanged by the rail — it decides only *where* an
available button sits, never *whether* it is offered (Free Spin: unlocked by
progression and spins left this cycle; Daily Bonus: unlocked by progression and
today's gift unclaimed; Super Wand: unlocked by progression and then permanently,
whether the streak it reports is empty, filling or full; Tasks: unlocked by
progression, and then permanently).
Because the wheel unlocks at level **5** and the gift at level **1**, a new player
sees the gift alone, in the **first** slot of the left rail, with the Super Wand
read-out and the right rail both empty until level **10**.

The rail owns only an `x` and the slot ladder (`RAIL_LEFT_X` / `RAIL_RIGHT_X`,
`RAIL_Y0` 214, `RAIL_GAP` 182). Adding a feature button is one
`rail.add(key, button, isAvailable)` call in the priority order, on whichever
rail. The always-on corner chrome (settings **cog**, **coin pill**) is *not* on a
rail: it never reflows. Both rails sit on the lobby's `topHud` layer, so they
track the **top corners** on tall screens like the cog does.

### Fortune Wheel — a daily prize wheel
A **prize wheel** reached from the lobby (not part of a level): a daily-return
hook that hands out coins and boosters used elsewhere. Its **wheel button** is the
**first entry on the lobby's left-edge feature rail** (see above), below the
settings cog — it **beats slowly** at rest (a gentle grow/shrink) and its little wheel **spins**
both **periodically on its own** (every few seconds — spins up, the pointer flicks,
winds down) and **on mouse-over** (a hover kicks off a spin unless one's already
running); it swells while hovered. It carries a
**NEW** badge until the wheel is opened for the first time ever, and a **free-spin**
badge whenever the current cycle's free spin is unclaimed (the badge drops the
moment that spin is used, live, with no reload). The button only appears once the
player has **progressed to the unlock level** and hides again once the day's spins
are used up, reappearing at the next daily rollover — and while it is away the
Daily Bonus button slides up into its slot.

Prizes are organised into **groups** — one wheel's worth each — and the wheel is
built from the **active group** (its slice count comes from the group, not a fixed
number). The active group **advances once per calendar day** (wrapping after the
last), and that rollover also clears the per-cycle state (spins taken + the list of
prizes already won). The rollover is checked continuously while running, so leaving
the game open across midnight still yields a fresh cycle.

Each **cycle allows a fixed number of spins**; the **first is free** and every spin
after costs a **rewarded video** (stubbed — grants on a successful view; cancel or
failure spends nothing, and a failure shows a brief "ad not available" message).
The result is **decided before the wheel turns**, then it animates to the winning
slice (accelerate → hold → decelerate, with a marquee lamp ring that blinks idle /
chases while spinning / flashes on a win). A **click bed plays for exactly as long
as the wheel turns**: a looping run of clicks whose playback rate rides the wheel's
live angular speed, so it winds up, holds and slows with the wheel rather than
replaying a canned slow-down, and stops the moment the wheel does. The red pointer at the top pivots about
its tip where it rests on the rim and **leans in the direction of the spin** — hard
while the wheel is fast (with a slight rattle), easing back to upright as it slows,
so it ends pointing straight at the winning slice. A prize can only
be **won once per cycle** — the pool shrinks each spin and won slices are marked.
On landing, the prize **flies to its top-bar counter**, which ticks up; the
headline prize gets an extra highlight before it collects. After the last spin the
wheel closes itself back to the lobby.

The prize table lives in `assets/config/turntable.json` (groups of prizes, each
with an `amount` and independent `freeWeight`/`adWeight`), so odds are tunable
without touching code; the feature's **gate and pacing** (`unlockLevel`,
`spinsPerCycle`, and which prize `type` is the `headlinePrize`) sit with every
other key parameter in **`src/config.js`** (`features.fortuneWheel`). Prize types map to this port's
economy: `coins` → wallet, `undo`/`wand`/`shuffle` → boosters (the original's
"Hint" is this game's **wand**), and `lightning` → a coins bonus (kept as the
headline prize). **Note:** the shipped `unlockLevel` is **5** — lower
`features.fortuneWheel.unlockLevel` in `src/config.js` to demo it sooner.

### Daily Bonus — a free once-a-day gift
A second daily-return hook, separate from the wheel and **not** a login-streak
calendar: there is no Day 1→7 chain, no streak, and no penalty for missing a day.
Its **gift button** is the **second entry on the lobby's left-edge feature rail**
(see above) — under the wheel button when that one is offered, and **in its place**
when it isn't; it **beats slowly** (a looping grow/shrink) and — unlike the wheel — carries **no
badge**, because the beat itself is the "unclaimed" indicator; layered on top, the
gift gives a little squashy **hop** every few seconds (the same ~5s cadence as the
wheel's self-spin) to draw the eye. On **mouse-over** the button swells and the
gift **wiggles**. The button **only
appears while today's gift is unclaimed** and hides the moment it's claimed,
returning (and animating back into its slot) at the next calendar-day rollover. Eligibility is a plain **"has the
calendar date changed since the last claim?"** check — a **midnight reset, one
claim per day**; the **only** thing persisted is the day-key of the most recent
claim (`user.dailyBonus.lastClaimDay`).

Opening the popup shows **three closed mystery boxes** (green / red / blue) bobbing,
with a "Pick a box!" tip. Three prizes are **pre-rolled** — one behind each box, each
an independent weighted draw. Tapping a box **commits today's claim then and there**
(so the boxes can't be re-rolled), slides it to centre, lifts its lid, and reveals
the prize (icon + name + amount + a rotating shine + a "Congratulations" line); the
other two boxes never open. After the reveal a **"📺 Double it!"** button appears
first and a plain **Claim** button fades in about **two seconds later** — the
interface nudges toward the ad. Watching the (stubbed) rewarded video **doubles** the
revealed amount; if the ad isn't ready the player is told so and can still take the
base prize. Either way the reward is credited (coins → wallet, boosters →
inventory, flying to its top-bar counter) and the popup closes.

The prize pool lives in `assets/config/dailybonus.json` — a list of
`{ type, amount, weight }` rows (`type`: `coins`/`undo`/`wand`/`shuffle`; the
original's "Hint" is this port's **wand**); its `unlockLevel` (shipped as **1**, so
it's available from the start) lives in **`src/config.js`**
(`features.dailyBonus`). The draw is **weighted**, strongly favouring
small coin amounts and rarely giving boosters — tune the odds by editing the
weights, no code change.

### Tasks — achievements and weekly goals
The game's **checklist of goals**: "Complete 50 levels", "Use 10 boosters", "Match
1000 tiles" — each a row with a **progress bar** and a **reward** you tap to
collect. It is the one long-horizon hook; everything else in the game pays out
once and forgets. Its **📋 Tasks button** is the only entry on the lobby's
**right-edge feature rail**, under the coin pill.

- The button is **hidden until level 10** (`features.tasks.unlockLevel`). Below
  that the feature does not exist as far as the player is concerned — but the
  **counters behind it run from level 1**, so a player arriving at the gate finds
  their history already filled in and several tiers waiting to be claimed.
- It carries a **red dot** whenever *anything* — achievement or weekly — is
  finished and waiting. That dot is the entire discovery mechanism: no popup, no
  other nag. Unlike the wheel and the gift, the button itself does **not**
  animate; it is a permanent destination, not a "claim me today" prompt.
- Opening picks the tab for you: whichever has something to collect, preferring
  **Achievements** when both do.

Two lists share the screen, on two tabs:

**Achievements** are permanent and organised into **chains** — one activity broken
into escalating tiers (complete 1 → 5 → 10 → 25 → 50 → 100 → 250 levels), with
rewards growing as the tiers get harder.
- **Only one unfinished tier per chain is ever on screen.** Claim it and the next
  takes its place — that is what keeps ~10 chains a readable list instead of sixty
  rows.
- **Finished-but-unclaimed tiers are always shown**, sorted to the **top**, and
  the row turns **gold** with a pulsing **Claim** button.
- **Claimed tiers vanish permanently** — there is no trophy cabinet, only live goals.
- Progress is measured against **lifetime totals**, not a per-tier counter. So
  blowing past several tiers at once — or adding a new chain to a live game —
  leaves the already-earned tiers **stacked up and instantly claimable** rather
  than needing to be re-earned.

**Weekly Tasks** are a short **flat** list (no tiers) that **all reset at local
midnight on Monday** (`features.tasks.weeklyResetDay`). Progress returns to zero
and every task becomes available again, *including ones already claimed*. The tab
shows a live **"Reset in: 3d 14h"** countdown and a "New Tasks Every Week!"
banner; a deadline passing while the screen is open resets the list in front of
you (the same 4 s poller that rolls the wheel's day).

Claiming credits the reward immediately — the item **flies to its top-bar counter**
on the same Bézier arc the wheel and the gift use, granting **on landing** so the
number ticks in sync — and the row **slides away and disappears**. There is no
"watch an ad to double it" anywhere in this feature: tasks pay exactly what they
say, once. The list **scrolls** (drag or mouse wheel); a drag that ends on a Claim
button deliberately does *not* claim it.

**What counts as progress.** Ten activities, each with a lifetime counter, and any
task on either tab watching that activity moves when it moves:

| Activity | What makes it tick | Counted in |
| --- | --- | --- |
| `levelsCompleted` | beating a level **for the first time** (a replay counts nothing) | `User.completeLevel` |
| `tilesMatched` | a **completed** level's whole tile count, credited on the win | `GameScene._win` |
| `undoUsed` / `shuffleUsed` / `wandUsed` | each individual helper use | `User.useBooster` |
| `boostersUsed` | any of the three above — one use ticks both | `User.useBooster` |
| `coinsSpent` | by the **amount** spent, not one per purchase | `User.debit` |
| `dailyBonusClaimed` | each Daily Bonus collection | `DailyBonusScene._openBox` |
| `wheelSpins` | each Fortune Wheel spin | `FortuneWheelScene` |
| `shopPurchases` | each package bought (on success) | `main.js purchasePackage` |

Note how few call sites that is: helpers all spend through `User.useBooster` and
coins only ever leave through `User.debit`, so those two counters catch every
route — including any added later — without a site to forget.

**Tiles are counted per completed level, not per match.** Clearing a level means
every one of its tiles was matched, so `_win()` credits the level's own tile
count — a fixed number set once in `loadLevel` and never added to. Tallying
triples as they cleared would have got two cases wrong: an attempt that is
**abandoned** (Back) or **lost** (Out of Moves → Home/Replay) would still have
counted, when it should count nothing; and the **Auto Complete** sweep would have
been missed entirely, since it clears its tiles directly and declares the win
without ever passing through the matching path. Replaying a cleared level *does*
count again — unlike `levelsCompleted`, a tile-matching goal is meant to be
grindable.

**Weekly progress is derived, not counted separately**: it is `lifetime total −
base`, where `base` is a snapshot of the counters taken when the week rolled over.
That is why one counting path serves both tabs and why a reset is a *snapshot*
rather than a wipe.

The **goal table** lives in `assets/config/tasks.json` — `achievements[]` (chains
with a `tiers[]` of `{target, reward}`) and `weekly[]` (flat `{activity, target,
reward}` rows), rewards written as `{type, amount}` with the same
`coins`/`undo`/`wand`/`shuffle` vocabulary as the wheel and the gift. Adding
**tiers** to an existing chain is a change to that file alone; adding a genuinely
**new kind** of task needs three things — the rows, a `titles` entry naming its
**text key** (plus that key in all 13 language files, see
[Localization](#localization)) and an icon in the `ACTIVITY` map at the top of
`src/tasks.js`, which is now glyphs only. The feature's **gate and reset weekday**
sit in **`src/config.js`** (`features.tasks`) with every other key parameter.

**Note:** the shipped `unlockLevel` is **10**, and this port ships 13 levels — so
it is reachable but late. Lower `features.tasks.unlockLevel` in `src/config.js` to
demo it sooner.

### Level Chest — a filling reward on the win screen
A **progress bar with a treasure-chest icon** on the **level-complete screen**: an
endless "keep playing and you'll open another chest soon" carrot. Each time you
clear a level **you haven't cleared before**, the bar advances **one notch**; when
it fills, the chest **pops open right there** (open-box animation + the `openbox`
sound) and pays a reward. The **same bar also sits on the lobby** (in the centre band
below the fruit row) as a **persistent "progress toward the next chest" indicator**,
so you can see how close the next reward is without finishing a level first. The
lobby bar never opens a chest — it only reflects your standing; opening happens on
the win screen. It updates **live** as you clear levels, and once a milestone chest
has opened it rolls forward to show the **next** chest freshly empty (via
`LevelChest.currentFor`, as opposed to the win screen's `infoFor`, which shows the
chest that clear filled). A brand-new player (no level cleared yet) sees no bar.

- **Only genuinely new progress counts.** The bar is tied strictly to pushing your
  **furthest level** higher — replaying or re-clearing a level you've already beaten
  does nothing, and the bar (and its icon) **don't even appear** on the results
  screen for a replay. The label reads **"notches filled / notches needed"** (e.g.
  `5 / 16`).
- **Opening & rewards.** A full chest opens and delivers its reward through a popup
  that also offers the usual **"📺 watch a short video to double it"** (stubbed —
  grants immediately; `succeed` doubles, `fail`/`cancel` leave the base amount). The
  reward flies to its top-bar counter and is **credited on landing** — coins/lightning
  to the coin pill, a booster to its helper button. There is **no separate claim
  step**; as soon as one chest opens, the **next begins filling** from the next new
  level.
- **The schedule.** Chests follow a defined list of **milestones** at increasing
  level numbers; the gap to the previous milestone is how many wins that chest takes,
  and each carries **its own reward**. The shipped schedule (50 milestones, last at
  level 752) starts short — the first three take **4 wins** (levels 4, 8, 12), then
  **8** (level 20), **12** (level 32), and from level 48 on **every chest is 16
  wins**. After the last milestone the tail **loops forever** from a configured
  **repeat-start** point, so chests never run out — a late-game player sees a fixed
  `? / 16` bar. Contents are **flat, not escalating**: the overwhelming default is
  **25 coins**, with the odd booster chest (2 Undos, 2 Hints→**wands**, 2 Shuffles,
  6 Lightning→**coins**) and one **100-coin** chest (level 288) as a change of pace.
- **What it remembers: nothing new.** Which chest you're on and how full it is are
  both **derived** from the **highest level you've cleared** (`progress.completed`,
  already saved), so the state can never drift and a QA level jump lands straight on
  the right chest — there is no chest field on the profile and no migration.
- **A note on the label.** The original game's wrap-around had an off-by-one that
  briefly showed **negative** progress numbers just past the last milestone. This
  port ships the **corrected** label — it always counts up cleanly `0 → needed`, so
  no negative-progress window ever appears. The opening cadence and rewards are
  identical to the original either way.

The chest **schedule** is a JSON data table, `assets/config/levelChest.json` (one
`[id, levelId, "itemId|count"]` row per milestone; item ids `0`=coins, `10`=Undo,
`11`=Hint→wand, `12`=Shuffle, `20`=Lightning→coins). Its one pacing knob — the
**repeat-start** index — lives in `src/config.js` (`features.levelChest.repeatStart`,
shipped `6`, i.e. the 7th milestone/level 64 begins the looping tail).

### Super Wand — an earned upgrade to the Wand
The **Super Wand** is the Wand's upgraded form, and the only helper in the game
that is **earned rather than bought** — a win streak charges it instead of coins,
stock or a rewarded ad. Where the ordinary Wand is a small favour (one triple), a
charged Super Wand is a board-clearing event: one tap sweeps **at least two
complete sets at once** (6+ tiles) off the board in a single combined
elimination — one burst, one sound, one beat — rather than a rapid sequence of
individual matches. It consumes **nothing**: it is not a stocked token but the
state of being on a win streak, so the very next tap sweeps again, on the same
board, across levels and app restarts, for as long as the streak lives.

- **Earning it.** Consecutive **genuinely new** level clears charge it —
  `CONFIG.boosters.superWand.streakLength` (**5**) of them in a row — and only
  from `unlockLevel` (**10**) onward. A replay of an already-beaten level does
  **not** count, the same "pushes your furthest level higher" rule the Level
  Chest uses, so a charge can't be farmed by grinding one easy level. (The
  original ships this gate at level 20; this port's campaign is currently **20
  levels long**, and since only a genuinely new clear counts, a gate of 20 would
  leave exactly one qualifying win and the reward could never actually be
  earned. 10 is the nearest value that keeps it reachable — clear 10–14 to
  charge it, then 15–20 to use it — without making it farmable; raise it back
  toward 20 as the level table grows.) Progress is shown on the **level-complete
  screen** as a filling **gold** bar with a caption reading "Clear 5 levels in a
  row!" (the 5 comes from config, so retuning the streak length re-letters the
  label rather than contradicting it). It coexists with the Level Chest's green
  bar on the same panel — the panel grows and both are shown together, laid out
  so neither collides with the Continue button.
- **The lobby read-out.** The same streak also shows on the lobby's left-edge
  feature rail (see [Feature buttons](#feature-buttons--the-lobby-rails)), as a
  third entry below Free Spin and Daily Bonus: the round Wand disc with a dark
  "streak/needed" pill where the other rail buttons put their caption. It has no
  tap handler — there is no Super Wand screen to open, so it is a pure read-out —
  and it is offered from `unlockLevel` on and then always, with no "used up
  today" state to hide it again. A banked charge pins the pill full and flips the
  whole face to the same gold disc + ✨ glyph the in-level helper button wears,
  and a charged button breathes gently (a filling one sits still) as the only
  "ready" indicator; there is no badge or red dot. Because using a Super Wand no
  longer spends anything, that gold ✨ **5/5** stays on screen through any number
  of sweeps, across levels and app restarts — it only drops back to a plain 🪄
  **0/5** when a loss is accepted. It repaints live off the profile's
  `superWand` domain, so the pill ticks over without a scene rebuild the moment
  a streak win lands or a loss is accepted, and survives a reload the same way
  every other rail entry does.
- **Losing it.** The Super Wand is not a single-shot token — it is the **state
  of being on a win streak** — so using it takes nothing away. The only thing
  that ever clears it is a loss the player **accepts**: pressing Home or Replay
  on the Out-of-Moves overlay clears the streak-in-progress **and** a banked
  charge together. Paying to **Continue** rescues the board and whatever streak
  state it carries. While the overlay is up it shows the streak bar with a
  "Streak at risk — Continue to keep it" caption — a full 5/5 meter when a
  charge is banked, a partial one otherwise, since either is lost the same way —
  and if Home/Replay is pressed instead it **drains the bar visibly** with a
  "Streak lost" caption, so the reset is watched rather than discovered later.
- **The shared button.** It gets no button of its own: it takes the **Wand's**
  button over. Uncharged, the button is the ordinary Wand. Charged, the face
  changes (glyph 🪄→✨, the disc purple→gold, and a gold ★ badge with no count,
  since there is nothing to buy or stock) and **every** tap sweeps instead of
  completing a triple — the same board, the same button, for as long as the
  streak lives. The changeover is announced on the first board where the charge
  can actually be used (charging happens on the *previous* level's complete
  screen) with a brief beat, an effect on the button and a scale-punch as the
  icon swaps — once per charge, so a Replay or a reload while it sits banked
  doesn't replay the announcement, and using it again never replays it either.
  The two modes are mutually exclusive through one predicate
  (`_superWandActive()`), checked by both the ordinary `wand()` and
  `superWand()`, so a scripted call is held to the same rule as a real tap and
  the two can never interleave. Input is locked for the whole sweep, so a rapid
  double-tap can't start a second sweep over the animation.
- **How it chooses (`_superWandPick`).** It works from the tray outward,
  cheapest completions first — the same instinct behind the ordinary Wand's
  picker: group the tray by colour, order those groups by how close each is to
  completing (a waiting **pair** before a lone **single**, tied-broken by tray
  order), and for each pull just enough board tiles to reach a triple, banking
  the finished set. It stops once the batch reaches `minTiles` (**6**, i.e. two
  complete sets). If the tray runs dry while the batch is still short, it tops up
  with **whole fresh triples** taken straight off the board — a colour not
  already in the batch, at most `extraRounds` (**2**) of them, most-free-tiles
  first. A colour the board cannot fully complete is **skipped outright, never
  half-taken** — every set in the batch is finished, and the batch is always a
  whole multiple of 3, because sweeping a partial set away would delete the
  player's progress rather than cash it in. Board tiles are drawn
  most-accessible-first (free/uncovered before still-covered, then by id) — the
  identical deterministic order the ordinary Wand's `_wandPick` uses — so the
  sweep reads as an extraordinarily good run of play, not tiles conjured out of
  the pile. The invariant is checked in development builds only, inside a
  `DEBUG:` labelled block in `src/game.js`'s `_superWandClear` — a
  `console.error` if it is ever violated, so a regression fails the e2e suite's
  zero-errors assertion; `--drop-labels=DEBUG` strips the check from production.
- **Not a consumable.** A sweep never goes through the acquisition ladder
  (`_acquireBooster`/`useBooster`), so it spends **no Wand charge** and bumps
  **no** `wandUsed`/`boostersUsed` task counter. There is no inventory entry and
  no price for it — it is absent from `CONFIG.boosters.kinds`,
  `startingInventory` and `unlocks` on purpose; see `user.superWand` for the
  small state it actually keeps (`streak`/`charged`/`announced`). There used to
  be a fourth accessor here, `User.spendSuperWand()` — it has been deleted
  entirely, because there is nothing left for a "spend" to do.
- **Edge cases.** A board that can't supply two full sets clears whatever
  complete sets it can. A sweep that can gather nothing at all is a graceful
  no-op — the charge is never at risk from a bad board, since only an accepted
  loss can ever take it away. The button does nothing once the level is already
  won or lost. A sweep into a nearly-full tray is safe: the tray briefly goes over capacity while the
  incoming tiles fly in, but the scene stays locked for the whole sweep so the
  tray-full loss check never observes the overflow, and every pulled tile leaves
  again with the set it completed — so the tray always ends up **smaller** than
  it started, never bigger. The tray's **near-full warning** (the pulse and the
  "Insufficient space!" bubble) sits the sweep out for the same reason: those
  incoming tiles are already spoken for, so flashing a danger that doesn't exist
  in the middle of the payoff moment would be a lie. `_updateTrayWarning` returns
  early while a sweep is running and is re-run once it settles, judging the
  *settled* tray.
- **Analytics.** Earning a streak win, charging and each sweep are all reported
  through `GameScene._reportSuperWand()`, a `console.debug` stub with a
  `TODO(SDK)` naming the intended events (`CK_SuperWand_Earn`,
  `CK_SuperWand_Charge`, `CK_SuperWand_Use` — "Use" rather than "Spend", since a
  sweep consumes nothing), exactly like `FortuneWheelScene._reportSpin`.

## Localization

The game ships in **13 languages**, and every one of them is complete: the same
**96 pieces of text** exist in all 13, with no gaps, no fallbacks to English, and
no partially-translated locale. The player can change language at any time from
the settings screen, and the whole interface **re-letters itself immediately** —
no restart, no reload, no loss of progress.

The 13, in the order the picker lists them:

| Code | Shown in the picker as | |
| --- | --- | --- |
| `zh` | Chinese | Simplified |
| `zh-tw` | Traditional Chinese | |
| `en` | English | |
| `id` | Bahasa Indonesia | |
| `de` | Deutsch | |
| `es` | Español | |
| `fr` | Français | |
| `in` | Hindi | the code is `in`, the language is Hindi |
| `it` | Italiano | |
| `jp` | Japanese | |
| `ko` | Korean | |
| `ru` | Русский | |
| `pt` | Português | |

Two of these codes are **traps for the unwary**. **`in` means Hindi, not
Indonesian** — Indonesian is `id`. And **`jp`** is used where the standard code
would be `ja`. Both are the game's own convention and appear everywhere.

### Picking a language

#### The first time — automatic
On a brand-new player the game asks the **device** what language it is set to and
maps that onto one of its 13. The mapping is generous about regional variants:
Austrian, Swiss and Liechtenstein German all land on `de`; every flavour of
Spanish (Spain, Latin America, Argentina, Mexico, Colombia, Puerto Rico, US
Spanish) lands on `es`; Belgian, Swiss and Luxembourgish French land on `fr`;
mainland and Singapore Chinese land on `zh` while Hong Kong, Macau and Taiwan
land on `zh-tw`; Indonesian *and* Indonesian-region English land on `id`; Hindi
*and* Indian English land on `in`. **Anything unrecognised becomes English**
(`CONFIG.language.defaultLanguage`).

Two details worth knowing:
- The detection uses the **browser/device language** (`navigator.languages`),
  not any platform account language. On Facebook Instant the two normally agree,
  but they are not the same signal — the Facebook locale is never consulted.
- Detection runs **exactly once**. The result is written into browser storage
  under the key **`tm3.language`**, and from then on that stored value wins.
  Changing the device language later has no effect; the player must change it
  in-game.

#### Afterwards — the language picker
Settings carries a **Language** row showing the current language's own name.
Tapping it opens a **scrolling list** of all 13, with the current one
tick-marked; the list **auto-scrolls** so the current choice is visible when the
popup opens. Tapping a row moves the tick but changes nothing yet — the choice
only applies on **Confirm**. Closing the popup any other way (Back, or a tap on
the dim) discards it.

The names in that list are **not translated**. Each language is written in its
own language (or in English, for the Asian ones): a Russian player browsing the
list sees "Chinese", "English", "Deutsch", "Русский", "Traditional Chinese". The
only word in the popup that does translate is the heading **"Language"** itself.

#### What happens on Confirm
If the picked language is the current one, the popup just closes. Otherwise the
game downloads that language's text, swaps it in, **re-letters every label
currently on screen**, remembers the choice, and closes the popup. Screens that
are not currently visible re-letter themselves too, so the swap is seamless
whichever way the player arrives back at them.

Labels the game writes itself — the lobby's level counter, the game screen's
`LEVEL 12` heading, the tasks countdown and note lines, the shop's package
names — are told to refresh in place through the `relocalize()` broadcast in
`src/main.js`, the language-change twin of the existing `resize()`.

Two rough edges, kept deliberately:
- **A failed download still counts as a choice.** If the language file can't be
  fetched, the on-screen text stays as it was — but the new language is still
  written to storage, so the next launch will come up in it (or fail to, again).
- **The old language is never unloaded.** `i18n.unload()` exists but nothing
  calls it, so switching back and forth in one session leaves every visited
  language resident. Harmless in practice — a table is a few kilobytes — and it
  makes switching back instant.

The **splash screen** is a special case: it is painted before any module has
parsed, so its first status line ("Starting up…") is the markup's own English.
Every line after it — "Loading level table…" onward — is localized, because
`i18n.init()` is the first thing `boot()` does.

### Where the text lives
Each language is one flat JSON file of `key → translated string`,
`assets/lang/<code>.json`; only the one for the **active** language is ever
fetched. The folder is configurable (`CONFIG.language.textDir`); the **set of
offered languages is not** — it is hard-coded as `LANGUAGES` in `src/i18n.js`,
because a data-driven list would let a language exist that nothing can reach.

There are **100 keys**, and the key list is **byte-for-byte identical across all
13 languages** — `tests/i18n_test.py` enforces that, along with "not a single
phrase is left sitting in English". Where a translation looks like English it is
a one- or two-word cognate (German `Level`, `Shop`; Indonesian `OK`), not a
missed string.

The keys are mixed-convention, a fingerprint of a sheet that grew by several
hands: mostly `snake_case` (`daily_reward`, `btn_go`, `insufficient_space`), a
`Capitalised_Numbered` family (`Language1`, `Language2`), and a few English
phrases used as their own key (`Pouch Of Coins`, `Starter Bundle`).

### How a screen gets its text
Three routes, all landing in the same table.

**1. Baked into the screen layout.** A label made with `locText("key", style)`
carries its key and fills itself in whenever the language changes — no scene
code needed. Panel titles, buttons and captions all work this way.

**2. Fetched by name from the game logic.** Anything assembled at runtime —
`Level 12`, a `2d 14h` countdown, a task title — calls `t(key, …values)` and is
re-run from that scene's `relocalize()`.

**3. Named by a config table.** Two tables store a text **key** rather than the
text itself, so the same row reads correctly in every language:

| Table | Column | Example |
| --- | --- | --- |
| `assets/config/tasks.json` | `titles.<activity>.title` / `.one` | `levelsCompleted` → `title_task_1` → "Complete %value levels" |
| `PACKAGES` (`src/user/payments.js`) | `nameKey` | `Pouch Of Coins` → "Pouch of Coins" |

Every activity in the goal table has a title key, so a task row can never fall
back to printing its internal activity code at the player.

### What is *not* localized
Three kinds of on-screen text deliberately have no key and are literals in the
scene that draws them:

- **Emoji and glyphs** — the fruit flourish, 🎁 📺 🔒 🛒 ✓ ★, the helper icons.
  Where one sits next to a word the two are separate objects (`📺` + `t("spin_btn")`),
  so a translator never has to carry a glyph and can't reorder it by accident.
- **Badge words** — the lobby's red **`NEW`** pill. A badge word is part of the
  badge's *artwork*, not copy: it sits in a fixed-width pill sized around three
  characters, and the mark reads as itself worldwide. Any future `HOT`, `TOP` or
  `SALE` badge gets the same treatment. `i18n_test.py` fails if one of them turns
  up as a key.
- **Numbers and prices** — counters, `7/12`, `+25`, the shop's `$0.99`.

### Placeholders
There is no formatting system — the game does a plain find-and-replace on two
placeholder styles:

- **`%value`**, for anything counted — `title_task_1` = "Complete %value levels".
- **`{0}` / `{1}`**, for levels and ranges — `Language1` = "Level {0}",
  `reset_in_dh` = "Reset in: {0}d {1}h".

Because the substitution is a plain **first-match replace**, **each placeholder
may appear only once per string**. A translator who repeats `%value` for emphasis
gets the first one filled and the second left as literal text. `{0}` and `{1}`
are substituted one after another, so they must stay distinct tokens — they may
be **reordered**, but not merged. The tests check all of this against English.

A placeholder can be filled with **another translated string**: `win_subtitle`
(`"{0}  +{1}"`) takes the win line and the coin reward, and `tasks_note_weekly`
takes the localized countdown.

**Singulars and plurals are two separate keys** (`item_coin` / `item_coin_plural`,
`title_task_1` / `title_task_1_one`) rather than an "s" appended in code — most
of the 13 do not form a plural that way, and several do not distinguish one at
all.

### When a key is missing
A label whose key isn't in the active language **displays the key itself**. There
is no fallback to English: a missing translation is meant to be noticed rather
than papered over. Every key the shipped screens reach for resolves — the test
walks every screen and asserts `i18n.missingKeys()` is empty.

### Fonts
Every label renders in the font it was designed with (`Arial`, with the browser's
own fallback behind it). The Chinese, Japanese, Korean, Russian and Hindi text
all display correctly, so no language-aware font selection is wired up.

Long translations are a real hazard: buttons are fixed-width pills with the label
centred on top, neither masked nor auto-shrunk, so an over-long string spills over
the artwork. `tests/langfit_test.py` measures every such label in all 13 languages
against its widget — **a failure there means shortening the translation, not
widening the button.** Labels that pass through `fitTextWidth()` (the lobby title
and subtitle, task rows, tab buttons, the picker's own language names) shrink
themselves and are exempt.

### Adding a language
Three edits, not one — otherwise the language exists but nothing can reach it:
1. a new translated text file, `assets/lang/<code>.json`, with **exactly** the
   same key set as `en.json`;
2. an entry in the hard-coded `LANGUAGES` list in `src/i18n.js`;
3. a new case in the device-language detection (`EXACT_TAGS` / `BASE_LANGS` in
   the same file).

### Testing another language locally
The stored choice is the browser-storage key **`tm3.language`**. Setting it to any
of the 13 codes before loading the page starts the game in that language;
clearing it makes the game re-detect from the browser. The in-game picker writes
the same key, so the two are interchangeable. A code the game doesn't recognise
is silently treated as English.

```js
localStorage.setItem("tm3.language", "jp");  // then reload
```

## Run it
Because it uses ES modules and `fetch`, it must be served over HTTP (not
opened via `file://`):

```bash
cd JS
python3 -m http.server 8099
# then open http://localhost:8099/index.html
```

**Testing on a phone?** Use the no-cache server instead:

```bash
python3 tools/serve.py 8099        # then open http://<LAN IP>:8099/index.html
```

`python3 -m http.server` sends no cache headers, so a mobile browser will hold ES
modules indefinitely and revalidate none of them. That gets you a *partially*
stale module graph — a fresh `src/i18n.js` against a cached `src/config.js`, say
— and a module that throws while being evaluated takes the whole graph down
**before `boot()` runs**, so the splash freezes at "Starting up… 0%". `serve.py`
sends `Cache-Control: no-store` so every reload gets the current tree. (If a
device is already stuck, one hard reload clears it.)

A boot that dies that way now says so: an inline handler in `index.html` catches
errors the module graph throws before `boot()` exists and paints them into the
splash's error state, instead of leaving a frozen bar.

## Deploying — `tools/build.py`
In development the game has **no build step**: `index.html` loads the ES modules
in `src/` directly, which is why you can edit a file and reload. Production is a
different artifact. `tools/build.py` bundles those 28 modules into one file,
minifies it, obfuscates it, strips the debug API, verifies the result, and
uploads it to S3 under the **commit hash it was built from**:

```
build/<commit>/index.html
build/<commit>/src/main.js       one obfuscated bundle — the other 28 modules are gone
build/<commit>/vendor/pixi.min.js
build/<commit>/assets/…          audio, bg, config, lang, all 1000 level files
build/<commit>/build-info.json   commit, toolchain, and what was done to the code
```

Nothing else in the repo ships — no `tests/`, `tools/`, `.venv/`, READMEs.

A deploy runs strictly in this order, and stops at the first failure:

```
build → verify → upload → (every object OK?) → move the CloudFront origin → invalidate
```

```bash
npm --prefix tools install                           # once: esbuild + obfuscator

python3 tools/build.py --no-upload                   # build locally
python3 tools/build.py --bucket my-bucket            # build, verify and upload
python3 tools/build.py --bucket my-bucket --dry-run  # show the plan, call nothing

# the full thing: upload, repoint the distribution, clear the edge cache
python3 tools/build.py --bucket my-bucket --prefix game \
                       --distribution-id E2ABCDEF12345 --wait
```

Without `--distribution-id` (or `GAME_CF_DISTRIBUTION_ID`) the script uploads and
stops, exactly as it did before — nothing points at the new build.

`build/` is gitignored. Uploading needs `boto3` (`.venv/bin/python -m pip install
boto3`) and credentials from the usual chain — env vars, `~/.aws/credentials`, an
instance role, or `--profile`. Bucket and prefix can also come from
`GAME_S3_BUCKET` / `GAME_S3_PREFIX`.

### The code pipeline
1. **Bundle and minify** with esbuild — one IIFE, transpiled to es2019 so older
   mobile Safari is fine, names shortened, comments and whitespace gone.
2. **Strip the debug API.** The `window.__game` block in `src/main.js` and the
   `window.__splash` seam in `src/splash.js` sit inside `DEBUG:` labelled blocks,
   and esbuild is passed `--drop-labels=DEBUG`, which deletes them from the
   bundle. This is not cosmetic: `__game` is a **cheat console** — `setLevel`,
   `completeLevel`, `config`, `completeLevel`, direct handles on every scene —
   and obfuscating the code while shipping that would be pointless. In raw source
   a label is inert, so dev and the whole test suite are unaffected.
   `--keep-debug-api` opts back in for a staging build you want to drive from a
   test. A `DEBUG:` block can also guard an in-source assertion rather than a
   `window` seam — `src/game.js`'s Super Wand sweep (`_superWandClear`) checks its
   own whole-sets invariant this way, with a `console.error` that fails the e2e
   suite in dev but is dropped from production the same way.
3. **Obfuscate** with javascript-obfuscator — identifier mangling, string-array
   extraction and encoding, numbers rewritten as expressions.

The obfuscator seed is derived from the commit, so the same commit always
produces the same bytes: builds stay reproducible and the S3 ETag skip keeps
working.

`vendor/pixi.min.js` is already minified and is copied untouched. Assets are
copied verbatim — they are the game's content, fetched at runtime.

### What each level costs
`--obfuscate-level` picks how far to go. Measured on this game (JS only; the
`assets/` tree is another 3 MB either way):

| | bytes | gzipped |
|---|---:|---:|
| raw modules (`--no-bundle`) | 476,601 | 145,051 |
| bundled only (`--no-minify --no-obfuscate`) | 379,999 | 97,576 |
| bundled + minified (`--no-obfuscate`) | 167,208 | 44,590 |
| `--obfuscate-level low` | 212,453 | 49,163 |
| `--obfuscate-level medium` *(default)* | 322,413 | 118,346 |
| `--obfuscate-level high` | 680,260 | 285,168 |

- **low** — identifier mangling only. Readable structure, unreadable names.
- **medium** *(default)* — adds base64-encoded string arrays, split strings and
  number-to-expression rewriting. Roughly 2.7× the gzipped size of plain
  minification, with no measurable frame-time cost.
- **high** — adds control-flow flattening, dead-code injection, RC4 string
  encoding, object-key transformation and self-defending code. It is 6× the
  gzipped payload of medium **and the two flattening options cost real frame
  time**, which matters in a 60 fps game whose hot loop runs over every tile
  every frame. Only reach for it if the logic genuinely needs protecting, and
  measure the result on a mid-range phone.

`renameGlobals` is off at every level, because `PIXI` arrives as a global from
the separately-loaded vendor bundle and must keep its name.

### Why the commit hash is the directory
Every deploy is immutable and addressable: `…/<commit>/index.html` can only ever
mean one tree, two releases can sit side by side, and a rollback is a pointer
change rather than a re-upload. It also makes the stale-module-graph failure
described above *impossible in production* — a given URL's bytes never change,
and after bundling there is only one script that could be stale anyway.

It is also what makes rollback cheap and the ETag skip work: the same commit
always produces the same bytes at the same key, so re-deploying it uploads
nothing. Note that this immutability is a property of the **S3 keys**, not of the
URLs players use — those are stable, because the commit lives in the CloudFront
origin path. See *Cache headers* below for what that means for caching, which is
the one place the distinction really bites.

### Going live — the CloudFront origin switch
Uploading a build does not make it visible; something has to point at it. That
something is the distribution's **origin path**. After a clean upload the script
reads the distribution config, moves `OriginPath` to `/<prefix>/<commit>`, writes
the whole config back guarded by the ETag it read (CloudFront has no partial
update, and the ETag is what stops it clobbering a concurrent console edit), and
then invalidates the edge cache.

**Origin first, invalidation second — and with `--wait`, propagation in between.**
`update_distribution` returns `InProgress`, and the new config reaches every edge
over roughly one to five minutes. An invalidation that completes inside that
window empties edges that are *still running the old config*, and they refill
`/src/main.js` from the **old** origin path — where `s-maxage` then pins the
wrong bytes for a year. The old cache model could not suffer this, because every
release had its own URL; this one can.

So `--wait` blocks on `distribution_deployed` **before** invalidating, and only
then waits for the flush. Without `--wait` the script says plainly that it is
skipping that guard. **Use `--wait` for production deploys.**

| flag | env | |
|---|---|---|
| `--distribution-id` | `GAME_CF_DISTRIBUTION_ID` | the distribution to repoint |
| `--cf-origin-id` | | which origin, when there are several |
| `--no-cloudfront` | | upload only, leave the distribution alone |
| `--invalidate PATH` | | repeatable, defaults to `/*` |
| `--wait` | | block until deployed, then verify through the CDN |
| `--rollback COMMIT` | | repoint at an older build; no build, no upload |
| `--list-builds` | | what is in the bucket, and which one is live |

With `--wait` the full sequence is: update the origin → wait for the
distribution to deploy → invalidate → wait for the flush → fetch
`build-info.json` **through the distribution** and check the commit matches. That is the only check here that
exercises the whole chain — origin path, invalidation, cache headers — rather
than trusting that a successful API call means a correct deployment.

The distribution needs `cloudfront:GetDistributionConfig`, `UpdateDistribution`
and `CreateInvalidation`, plus `GetDistribution` and `GetInvalidation` for
`--wait`. An `AccessDenied` from any of them says so and lists the actions.
Changing `OriginPath` needs no bucket-policy change: an OAC policy is scoped by
the distribution's ARN, not by key prefix, so the new path is already allowed.

The deploy also warns — without failing — about the distribution settings that
let a *successful* deploy serve the wrong thing: an empty `DefaultRootObject` (so
`/` does not reach `index.html`, which the `--wait` check would not notice
because it fetches `/build-info.json`), a `CachingDisabled` cache policy (nothing
is held at the edge, so `s-maxage` buys nothing), a legacy `MinTTL` floor (which
overrides `no-cache` on `index.html`), and an origin whose domain is a different
bucket than the one just uploaded to.

### Rolling back
Every build ever deployed is still in the bucket under its own commit prefix, so
a rollback is a pointer change measured in seconds — no checkout, no build
toolchain, nothing re-uploaded:

```bash
python3 tools/build.py --bucket my-bucket --prefix game \
                       --distribution-id E2ABCDEF12345 --list-builds

builds in s3://my-bucket/game/

  def4567890ab         2026-08-29T18:04:11+00:00  Adds Localization      <- live
  abc1234567de         2026-08-28T11:20:03+00:00  Adds Level Chest

python3 tools/build.py --bucket my-bucket --prefix game \
                       --distribution-id E2ABCDEF12345 --rollback abc1234567de
```

Rollback refuses a commit that has no `build-info.json` in the bucket, and it
checks that *before* touching CloudFront — the failure it exists to prevent is a
live distribution pointed at a prefix that was never uploaded, serving 404s.

### Cache headers, and why they are not `immutable`
The commit hash lives in the *origin* path, not in the URL a browser asks for:
every build serves `/src/main.js` at the same address. That makes `immutable`
actively dangerous. A returning player would find the bundle in local disk cache,
marked good for a year, and **never contact CloudFront at all** — so the deploy's
invalidation could not reach them, and they would keep running the old build.
`index.html` cannot rescue them either: it is copied verbatim and is byte-
identical between builds.

So the two caches get different instructions:

| | |
|---|---|
| `index.html`, `build-info.json` | `no-cache, must-revalidate` |
| everything else | `public, max-age=0, must-revalidate, s-maxage=31536000` |

The browser revalidates every request — a 304 from a nearby edge is quick — while
`s-maxage` lets CloudFront hold the object for a year, until the deploy
invalidates it. The origin is barely touched either way.

The upload's skip check compares the object's **headers as well as its body**,
so a build uploaded under the old `immutable` model is re-uploaded automatically
the next time it is deployed. No `--force`, nothing to remember.

### What the script does that S3 will not do for you
- **Content-Type per extension.** S3 guesses nothing; an object uploaded without
  one is stored as `binary/octet-stream`, and a browser *refuses to execute
  JavaScript* that is not served as JavaScript.
- **Skips unchanged bytes.** Objects whose ETag already matches the local MD5 are
  left alone, so re-deploying a commit costs a few hundred HEADs instead of the
  whole tree. `--force` overrides.
- **Uploads in parallel** (`-j`, default 16) — 1000 of the files are tiny level
  JSONs.

### The gate before anything is uploaded
There are two gates, and they ask different questions.

**First, the test suite — is the source correct?** Before a single file is
staged, a deploy runs the whole of `tests/run_all.py`. A red suite stops the
build there, so a failure costs a test run rather than a full
bundle-and-obfuscate. It is skipped where nothing can reach players — a local
`--no-upload` stage or a `--dry-run` — and `--skip-tests` overrides it for an
emergency, loudly. Note the ordering: the suite tests `src/`, not the artifact,
which is why the second gate still has work to do.

**Second, the staged tree is verified**, and a failure **deletes the artifact and
uploads nothing**:

- `index.html`, `src/main.js` and `vendor/pixi.min.js` exist;
- every local path `index.html` references is present in the build;
- the bundle has no relative imports left, and no unbundled module survived
  next to it;
- every asset group in `assets/` arrived, non-empty and with its full file
  count — the groups are **read off the source tree, not hardcoded**, so a new
  one is checked the day it is added rather than deploying half-copied;
- every shipped extension has an explicit `Content-Type` mapping;
- the 13 language tables are all there and at full key parity with `en.json`;
- all 1019 JSON files parse.

### Adding files to the game
Two rules exist so that a new feature cannot quietly ship broken:

**Every top-level entry in the repo must be classified.** `SHIP_DIRS` /
`SHIP_GLOBS` say what ships (`src/`, `vendor/`, `assets/`, and any top-level
`*.html`), `NOT_SHIPPED` says what deliberately does not (`tests/`, `tools/`,
`build/`, the READMEs…). An entry in neither **stops the build**. Without this, a
`sw.js`, a `manifest.webmanifest` or a `shaders/` directory works perfectly
against the local server and is simply absent in production — a failure that
costs an afternoon to find, versus a build error that costs a minute.

**Every new file extension needs a `CONTENT_TYPES` entry.** Python's `mimetypes`
fallback covers the standard web formats (`.webm`, `.mp4`, `.wasm`, `.avif`,
`.ktx2`), but engine-specific ones — `.atlas`, `.fnt`, `.skel`, `.basis` —
resolve to nothing and would upload as `application/octet-stream`. `verify()`
refuses rather than guessing.

Everything else about adding a feature needs no build change at all: esbuild
walks the import graph from `src/main.js`, so a new scene module is bundled
automatically, and `assets/` is copied wholesale, so new levels, languages, art
and audio ship on their own. The one thing to remember is the `DEBUG:` rule
below.

### Debug seams
Any test or debug hook hung off `window` **must** live inside a `DEBUG: { … }`
block, because `--drop-labels=DEBUG` is the only thing that strips it from a
production bundle. `tests/debugseam_test.py` enforces this by reading the source:
an unguarded `window.x =` anywhere under `src/` fails the suite.

A **dirty working tree is refused** — a build named after a commit must contain
that commit. `--allow-dirty` overrides and tags the build `<commit>-dirty`, which
is deliberately not reproducible.

`tests/build_test.py` covers all of this: it builds twice, boots the game out of
the obfuscated artifact, and asserts the cheat console is really gone.

## How it maps to the original
- **Levels** (`assets/levels/level{1,2,3}.json`) are the *decrypted* original
  level blobs (XXTEA, decrypted offline). Each is an array of
  layer strings of `x|y` grid positions — bottom layer first, upper layers
  offset by 0.5 so a tile straddles up to four below it.
- **Backgrounds** (`assets/bg/*.jpg`) and **audio** (`assets/audio/*.mp3`) are
  the original native assets, copied and renamed — except the Fortune
  Wheel's spin clicks (`wheel-spin-click-slow-down-fast-101154.mp3`), which are
  an added stock sound the original had no equivalent of.
- **Tile faces** are regenerated at runtime (`src/icons.js`) as emoji on white
  tiles — the original per-theme icon atlas was not among the downloaded native
  files, so an equivalent 20-icon food set is drawn instead. Each face is the
  white rounded **tile body** (drawn to a 2D canvas) with the fruit **emoji**
  composited on top **via `PIXI.Text`**, and the pair is baked into one texture
  with `renderer.generateTexture`. This is deliberate: on iOS/WebKit,
  `ctx.fillText` of a colour emoji straight onto a 2D canvas paints **nothing**
  (the tile body drew but the fruit was missing — the "white tiles" bug), whereas
  `PIXI.Text` emoji render correctly there (the on-screen 👆 hand and helper icons
  are `PIXI.Text` and always showed). `makeTileTextures` is therefore **async**
  and takes the app renderer: it first `await`s `document.fonts.ready` and
  verifies a probe emoji actually rasterizes through the pipeline
  (`emojiPaints`, retried across a few frames) before baking the set. `main.js`
  `await`s it during boot (under the splash). `tiles_render_test.py` guards it.

## Design notes
- `src/level.js` assigns tile types with a **guaranteed-solvable** generator: it
  derives a valid removal order (a linear extension of the covering DAG) and
  gives each consecutive triple one type, so every board can always be cleared
  with only 3 tray slots. The number of distinct types is **per-level**, set by
  the `types` field of each entry in `assets/config/levels.json` (resolved by
  `src/levelConfig.js`) — either a fixed integer or a `[min, max]` **range**
  resolved to a count that is random but deterministic per level (every type is
  guaranteed to appear on the board).
  Tile **positions** come straight from the
  level file, and the type assignment is seeded **only from the level number**
  (`game.js` `loadLevel`), so a level's layout is **deterministic** — the same
  fruit is in the same spot on every load/reload/session. (**Reshuffle** is the
  intentional way to re-randomise the faces mid-game.)
- `src/game.js` holds the `GameScene` (board layout, coverage/free-state logic,
  tray, matching, win/lose, animations). The tray keeps same-type tiles grouped
  as they're collected while `history` records raw add-order, so **Undo** always
  pops the most recently added tile and snaps it back to its **original board
  cell** (`_layoutBoard` recomputes each tile's home from its immutable grid
  coords). `undo()` first **cancels the tile's in-flight tray-slide tween**
  (`container.__mv`) before reparenting — otherwise a quick undo (mid-slide) would
  let that tween keep pulling the tile toward its old tray slot and strand it at a
  wrong position. (The micro-animators also bail if their container is destroyed
  mid-tween — e.g. a level reload — so a leftover tween can't crash on a null
  transform.) The **Undo**, **Wand**, and **Reshuffle**
  helpers draw from the player's booster inventory through an **acquisition ladder**
  (`_acquireBooster(kind)`): use owned stock (`user.useBooster`), else buy one with
  coins (`_buyBooster` → `user.debit("coins", price)` + `grantBooster`), else watch
  a rewarded ad (`_watchAd`, a stub that grants for free — no ad SDK yet). The
  press grants-then-uses, so the buy/ad tiers leave the net inventory unchanged.
  Each button's badge (`_setBoosterButton` / `_makeCountBadge.setBadge`) reflects
  the tier: the remaining **count** when stocked, the **coin price** when empty but
  affordable, or a **📺 "watch an ad"** icon when empty and unaffordable. A helper
  is disabled/greyed **only when there's no move to make** — Undo with an empty
  tray, Wand/Reshuffle with an empty board — never merely at 0 stock (the ladder
  always yields one). The coin prices come from `assets/config/prices.json`
  (loaded in `main.js`, passed to `GameScene`).
  Ahead of all of that sits the **progression gate**: `_setBoosterButton` short-
  circuits to a `"locked"` mode (dimmed button, 🔒 badge) while
  `user.isBoosterUnlocked(kind)` is false, and `undo()` / `wand()` / `reshuffle()`
  each open with `_rejectIfLocked(kind, btn)` — so a scripted call
  (`window.__game.wand()`, `scene.undo()`) is refused exactly like a tap, before
  the ladder can spend anything. A refusal plays `fail`, `_shake`s the button and
  floats an **"Unlocks at Level N"** pill (`_showBoosterHint`), replacing any hint
  already up.
  The other side of that gate is the **coached first use** (`src/boostercoach.js`,
  `BoosterCoach`). `loadLevel` ends with `_maybeCoachBooster()`, which asks
  `_owedCoach()` for the lowest-unlock helper that is unlocked but not yet in
  `user.boosterCoach`, checks `_coachCanAct(kind)` (never open a modal the helper
  can't close), and opens the overlay on `tutorialLayer`. The overlay **reparents
  the button and its badge** out of `hudBottom` so they sit above its dim, and
  `close()` hands them back at their row coordinates; `layout()` re-derives that
  position from `ox`/`oy`, so a resize mid-lesson keeps the button on its row.
  `undo` is armed rather than opened, and fires from `_collect` after
  `boosters.coach.undoDelayMs`. While `scene._coach` is set, `_onTapTile`,
  `autoComplete()` and the two non-coached helpers return early; the coached one
  passes through `_blockedByCoach(kind)`, which closes the lesson, marks it taught
  and falls through to the real action — so the tap spends a charge and acts for
  real. Teardown rides the same paths as the hand and the hint (`loadLevel`,
  `_exit`), and leaving that way does **not** mark it taught.
  **Wand** (`wand()` / `_wandPick()`) completes exactly one triple. Over every
  colour that can still reach a triple, `_wandPick` ranks completions by (1) the
  **fewest covered/unavailable tiles used** — so available (free, top-layer)
  tiles are spent before ever touching a still-covered tile — then (2) the
  cheapest completion (waiting pair → single → fresh board colour), then a
  tray-order/face-id tiebreak. It flies the missing tiles in
  most-accessible-first and locks input until the triple resolves so a rapid
  double-tap can't spend two charges. Its upgraded form, the **Super Wand**, is
  earned by a win streak rather than bought and takes this same button over once
  charged — see [Super Wand — an earned upgrade to the Wand](#super-wand--an-earned-upgrade-to-the-wand)
  above for the full behaviour.
  **Auto Complete** (`autoComplete()` / `_autoAvailable()`) is a **free** endgame
  shortcut, not a booster: from `AUTO_MIN_LEVEL` (`config.js`
  `progression.autoComplete.minLevel`, 2) onward, when
  `boardCount + tray.length ≤ AUTO_MAX_TILES` (12) and no board tile
  is still covered, `_updateBoosters` swaps the three round helpers for a wide
  **Auto Complete** pill in the same row. Pressing it stages every remaining tile
  on `fxLayer`, gathers them into a pile, then flies each along a quadratic
  Bézier into the tray's first slot (staggered), playing `tile_bop` and
  `_popMatch`-ing it on arrival,
  and calls `_win()` once the board is empty. The per-arrival `tile_bop` is the
  same one-shot `_addToTray` fires for a hand-collected tile, so a sweep of *n*
  tiles emits *n* bops after the single one that opens the gather phase. Level 1 is exempt (the guided level
  teaches the loop; a free "finish it for me" would cut that short), so
  `_autoAvailable()` tests `levelNum >= AUTO_MIN_LEVEL` first.
  Input is locked for the whole sweep
  (`_autoRunning`), which is reset in `loadLevel` so the next level's helper row
  returns. On a win it calls back to the host
  (`onLevelComplete`) rather than self-looping; the top-left **Back** button
  leaves the level for the lobby mid-level (progress untouched) through `_exit()`
  — the single exit path, so the guidance hand and any floating hint can't be left
  behind on a hidden scene.
  The **"How To Play" popup** (`src/tutorial.js`, `HowToPlayPopup`) is opened by
  `loadLevel` whenever `levelNum === TUTORIAL_LEVEL` (1) — the gate is the level
  number, not `isNewPlayer()`. `_showTutorial()` locks the scene, adds the popup to
  its own **`tutorialLayer`** (above `overlayLayer`, deliberately not on it, so
  `overlayLayer.children.length` keeps meaning "a win/lose overlay is up") and
  captures the current `_guideRun`. The popup owns a modal dim (`eventMode:"static"`,
  swallowing every tap) plus a centred group — panel, spinning `rays` `Graphics`,
  title, line, the mini board/tray/arrow demo and the **OK** button — laid out
  exactly like `_showOverlay`'s group, and re-centred from `GameScene.layout()`.
  `open()` fades the pieces in one after another (~1.6 s) and then sets
  `introDone`, which arms tap-anywhere-to-close and starts `_runDemo`: a loop that
  walks the hand over each matching triple, flies the tiles into the mini tray and
  pops them, then resets the mini board. Every step is guarded by the popup's own
  generation token (`_run`, bumped by `close()`), the same pattern the guided
  opening uses — but the demo is a chain of `await`s, and the popup can be
  **destroyed** between any two of them (leaving the level takes it with it) without
  the token changing. Every resume point therefore goes through `_stale(run)`, which
  checks `destroyed`/`closing` as well as the token; without it, a `_demoPick`
  resuming after a destroy called `addChild` on a dead container and threw. `close()` writes the `tm3.tutorialDone` marker (nothing
  reads it back), calls its `onClose` **immediately** — which unlocks the scene and
  fires `_runFirstRunGuide()` when `_firstRun`, so the demo moves follow the
  explanation — and fades itself out. `_closeTutorial()` tears it down *without*
  the callback from `loadLevel` and `_exit()`, so a popup can't outlive its board
  or be left on a hidden scene. It is not listed in `controls()`, like the win/lose
  overlays.
  The **guided first level** hangs off `loadLevel`, which sets
  `_firstRun = user.isNewPlayer() && levelNum === 1`, calls
  `_applyFirstRunChrome()` (hides `cog` + `backBtn`, `coinPill.setShopEnabled(false)`
  — the hidden controls drop out of `controls()` on their own, since the host skips
  invisible objects) and, once the board is placed, fires `_runFirstRunGuide()`.
  `loadLevel` returns with the board fully interactive — `_layoutBoard` positions
  tiles outright, there is no build-in animation — so that *is* the "board
  finished building" moment. The guide picks a triple with `_findGuideTriple()`
  (free tiles grouped by `type`, lowest type id first, so it's deterministic for a
  given seeded board), locks input, `_collect`s two of them on a timer, then calls
  `_showHand(tile)` — a `PIXI.Text("👆")` plus a ripple `Graphics` on `fxLayer`,
  driven by a ticker loop (`_handAnim`) and repositioned from `layout()` since
  `_layoutBoard` moves its target. `_hideHand()` runs from `_collect` (so **any**
  collection dismisses it), `loadLevel` and `_exit`. Every `await` in the guide is
  guarded by a **generation token** (`_guideRun`, bumped in `loadLevel`): without
  it, re-entering level 1 mid-sequence would leave the previous run collecting
  tiles off the old board.
  The **Level Chest** rides the win overlay. `_win()` computes a `chestLevel` — the
  cleared level, but **only when it beats `user.completedLevel()`** (a genuinely new
  clear; a replay passes `0`). `completeLevel()` hasn't run yet at that point (the
  host fires it on the Continue press), so the old highest is still readable, which is
  exactly the "new clear?" test. `_showOverlay` grows its panel and drops the Continue
  button when a chest is present, then `_mountLevelChest(group, info)` draws the
  treasure icon (`_makeChestIcon`, a lidded chest) and a Tasks-style progress bar,
  animating the last notch up. If `info.full`, `_openChest` plays `openbox`, lifts the
  lid (`easeOutBack`) and calls `_showChestReward` — a reveal + **"📺 Double it!"**
  (immediate) and a **Claim** that fades in ~1.6 s later, the same nudge-toward-the-ad
  shape as `DailyBonusScene`. `_watchChestAd` is the stub (seam `_chestAdResult`);
  `_claimChest` grants at `mult` 1 or 2 and `_collectChestReward` flies the icon on the
  shared quadratic-Bézier arc to its HUD counter (`coinPill` for coins/lightning, else
  the matching helper button), **granting on landing**, with an immediate-grant
  fallback if a target can't be located. The chest lives inside `_overlayGroup` (so the
  `layout()` reflow re-centres it for free and it stays out of `controls()`, like the
  win/lose overlays), and `_resetChestOverlay()` tears it down on Continue, a level
  reload and `_exit`. The schedule/maths are `LevelChest.infoFor` (`src/levelchest.js`),
  and everything is **derived** from the highest level cleared — no chest state is
  stored. This port ships the **corrected** progress label (it always counts up cleanly
  `0 → needed`), unlike the original's off-by-one that briefly showed negative numbers
  just past the last milestone.
  **Out of Moves** (`_lose()` → `_showLoseOverlay()`): a full tray no longer
  dead-ends. `_lose` shows a **modal** overlay (its dim is `eventMode:"static"`, so
  it swallows every tap and there's no close affordance) with **Home** (`onExit`),
  **Replay** (`restart`), and **Continue**. Continue reuses the booster
  **waterfall**: if the player can afford `continuePrice` (from `prices.json`'s
  `continue` key) the button shows a coin price and `_continueAfterLoss` **debits
  coins**; otherwise it shows a 📺 tag and grants a **free** continue via a stubbed
  rewarded ad. On continue it closes the overlay and `_returnTrayToBoard()` flies
  every collected tile home — **animated**, one at a time, staggered over `history`
  in **reverse placement order** (newest first — `history.slice().reverse()`, the
  order a rapid run of **Undo**s would pop them). Each tile reuses the same
  `_returnTileToBoard(t)` state primitive **Undo** uses (cancel any in-flight tray
  tween, restore coverage/`boardCount`, reparent to the board); the tile then tweens
  from its tray slot to its home cell (`_layoutBoard` supplies the target). Input
  stays **locked** for the whole fly-back and unlocks when the last tile lands.
  The **8th slot** splits the tray's one old number into **two**, which is the whole
  trick: `traySlots` is what the tray can **hold** — the loss condition
  (`_checkEnd`), the full-tray tap rejection (`_onTapTile`), the reshuffle's
  feasibility bound and both warning thresholds all read it — while
  `traySlotsDrawn` is how many cells are **painted**. Only the second crosses to 8
  at the gate (`user.isExtraSlotUnlocked()`, derived from `progress.completed` like
  `isShopUnlocked`, so nothing is stored and a QA jump is honoured); the first
  waits for the video. Both are re-derived in `loadLevel`, which is what scopes the
  boost to one board build. Because the cell count changes, `SLOT_MAX` became the
  function `slotMaxFor(n)` (90 at 7 cells, 78 at 8) and `_layoutBoard`'s
  "did the slot size change?" guard also fires on a changed count — crossing the
  gate usually leaves the clamped size untouched, and a size-only guard would leave
  the old row drawn. `_layoutTraySlots` sizes the row from `traySlotsDrawn`, so it
  **re-centres** on its own. The `_makeExtraSlotButton()` "+1" pill sits on
  `hudBottom` (above the slot sprites, same `(ox, oy)` and 0..750 space as
  `trayGroup`, so a slot position places it exactly) and `_placeExtraSlotButton()`
  re-sizes it onto the last cell on every tray reflow. Three questions are kept
  apart: `_extraSlotDrawn()` (does the cell exist), `_extraSlotOffered()` (is the
  button on it — only while capacity is base, which is what makes it once-per-level
  with no route to 9), and `_extraSlotTakeable()` (live play only). `takeExtraSlot()`
  is the single entry point for both the tap and the debug hook, so a scripted call
  is refused on the same terms; it consults `_watchExtraSlotAd()`, a stub with the
  same `"succeed"|"cancel"|"fail"` contract and `_extraSlotAdResult` test seam as
  `fortunewheel.js` / `dailybonus.js` (rather than the boosters' always-succeed
  `_watchAd`, because this offer has to be able to say **"Ad not ready"**).
  It is deliberately **absent from `controls()`**: it sits inside the tray panel's
  footprint by design, so listing it would trip `resize_overlap_test.py` for an
  overlap that is the point — the same reason the helper count badges aren't listed.
  The **tray warnings** hang off `_updateTrayWarning()`, called from `_layoutTray()`
  (which already covers collect / settle / undo / reshuffle / reflow) plus
  `loadLevel` and `takeExtraSlot`. It counts **free slots** against the live
  capacity: at or below `warnings.pulseAtFree` it runs `_startTrayPulse()`, a ticker
  loop breathing `trayGlow` — a `Graphics` tracing the panel's own rounded rect with
  an **inner** stroke (`alignment: 0`) so the panel's bounds, and therefore the
  overlap test, are untouched. At or below `warnings.bubbleAtFree` it floats
  **"Insufficient space!"**, fired **once per crossing** (`_trayWarnFree`) rather
  than as a state, or it would pop on every tap while the tray sits at the
  threshold. Both that bubble and the "Ad not ready" refusal go through
  `_showTrayMessage`, which keeps its own field so it and the helper row's
  "Unlocks at Level N" can be up independently, but shares their fade
  (`_floatPill` / `_clearPill`) and their look: the dark-glass pill itself moved
  to **`layout.js`** as `makeHintPill(text)`, so `boostercoach.js`'s caption —
  which used to carry a hand-copied twin of it — now draws from the same builder
  (statically, at alpha 1, since it holds until the lesson closes).
- `src/lobby.js` is the `LobbyScene` (landing/home screen) with the centred title
  block and the **"Level &lt;n&gt;"** play button. Like the level, it splits its
  layers by anchor: the title/subtitle/fruit row ride the vertically-centred
  `uiLayer`, the corner chrome and both rails ride `topHud` (pinned to the top
  edge), and the play button plus its "Tap to start" hint ride `botHud` (pinned to
  the bottom edge, `y = DH - 1334`, the same trick as `GameScene`'s `hudBottom`) —
  so the call to action keeps a fixed margin above the bottom of the screen on
  every device shape. It also owns the **feature buttons**
  (Free Spin / Daily Bonus) and hands their arrangement to a `FeatureRail`.
  On the centred `uiLayer`, below the fruit row, it draws the **Level Chest bar**
  (`_makeChestBar` / `_refreshChestBar`): a treasure glyph + progress track +
  "filled / needed" label, read from `LevelChest.currentFor(user.completedLevel())`
  and refreshed live on every `progress` change (the same subscription that drives
  the rails and the shop gate). It is hidden when there is no chest yet (a brand-new
  player) and listed in `controls()` only while shown, so it stays inside
  `resize_overlap_test`'s no-overlap guarantee.
- `src/featurerail.js` is the `FeatureRail` — the ordered, self-arranging column of
  lobby feature buttons (see the Gameplay section). `add(key, display, isAvailable)`
  registers an entry **in priority order**; `refresh({ animate })` re-asks every
  predicate, packs the available ones into **consecutive slots** `0..n-1`, and
  re-targets each button's position/opacity. Entries own no position — the rail sets
  `x`/`y`/`alpha`/`visible` and takes `eventMode` away at the *start* of a fade-out
  (an `alpha:0` display object is still hit-testable in Pixi). `visible` is derived
  from opacity (`alpha > 0`), which is what keeps a button still **waiting out a
  reflow** (its fade-in delayed by `moveMs`) out of both hit-testing and the scene's
  `controls()` list. `available(key)` reports the **gate** — what
  `wheelState()/dailyBonusState().buttonVisible` mean, and what `superWandRail()`
  reports as `available` for the third left-rail entry — as opposed to where the
  animation has got to, which is `featureRail()`. Animation is a single
  ticker callback advancing per-entry duration animators (`easeInOutQuad` for the
  slide, `easeOutCubic` for the fade, both from `tween.js`) rather than `tween()`:
  re-targeting mid-flight is the normal case here and `tween()` returns a bare
  promise with no cancel. `retarget` is a **no-op when the target is unchanged**, so
  the 4 s day-rollover poll in `main.js` can refresh the rail freely without ever
  restarting an in-flight move. `slots()` is the debug/test snapshot behind
  `window.__game.featureRail()`. `RAIL_LEFT_X`/`RAIL_RIGHT_X` + `RAIL_Y0`/`RAIL_GAP`
  define the ladder, so a right-edge rail is just another instance.
- `src/shop.js` is the `ShopScene` — an overlay (modeled on `SettingsScene`)
  opened by tapping the **coin pill** in either scene. It lists the **packages** for
  sale (from `payments.js`), each row showing the package name, a one-line contents
  summary (coins + booster icons), and a price button. Buying is delegated to the
  host's `onBuyPackage`, which runs the platform payment provider and, on success,
  applies the contents (`user.credit("coins", …)` + `user.grantBooster(kind, n)`).
  `shop.js` also exports **`makeCoinIcon(r)`** — the coin is **drawn as a gold coin**
  (not the 🪙 emoji, which some hosts render silver) so it's a consistent gold
  everywhere it appears (HUD pill, shop balance header, package contents, the win
  reward) — and **`makeCoinPill(user, onTap)`**, the shared coin-balance HUD control
  used by both the lobby and the level: a gold coin + the live balance + a small
  **shopping-cart** icon signalling that a tap opens the shop. It live-refreshes on
  any `wallet` change (parallel to `makeCogButton` in `settings.js`).
  `setShopEnabled(on)` is the pill's **shop affordance switch**: off, the cart badge
  goes away, the hit area shrinks back to the pill, and the tap handler itself
  returns early (so even a synthesized tap can't open the shop). Two things drive
  it — the shop's **progression gate** (`user.isShopUnlocked()`, refreshed from
  `LobbyScene._refreshShopGate` / `GameScene._applyFirstRunChrome` and on every
  `progress` change, so clearing level 2 lights the cart up live) and the guided
  first level, which withholds it on top of that. The coin reward for
  a win is `economy.coinWinReward` in `src/config.js` (spent by `game.js` `_win()`). (Spending coins on helpers is
  done on-demand inside a level, not in the shop.)
- `src/fortunewheel.js` is the `FortuneWheelScene` — the daily prize-wheel overlay
  (modeled on `ShopScene`: full-screen dim + centred panel + `easeOutBack` pop +
  `layout` reflow), opened from the lobby's wheel button. It folds together the
  per-cycle **logic** and the **presentation** the original split across a
  manager and a view. Persisted state lives on the User model (`user.fortuneWheel`:
  `group` / `day` / `spinsUsed` / `won` / `seen`); `checkRollover()` compares the
  stored day-key to today and calls `user.advanceWheelCycle()` (advance group + wrap
  + clear) on a change — driven both on open and from a low-frequency `main.js`
  ticker so a mid-session midnight still rolls over. A spin **records the spin +
  won slice up front** (so a rapid double-tap can't spend two spins and a prize
  can't repeat — `_spinning` gates re-entry), picks the winner by weighted random
  over the not-yet-won pool (`freeWeight` on the free spin, `adWeight` after —
  never collapsed), animates to it (`_spinWheelTo`), then **grants on the fly's
  landing** (`user.credit`/`user.grantBooster`, so the top-bar counter ticks in
  sync). The prize table comes from `assets/config/turntable.json`
  (loaded in `main.js`, passed to the scene); a missing/failed config degrades to
  no groups (button stays hidden). Its gate + pacing (`unlockLevel`,
  `spinsPerCycle`, `headlinePrize`) are read straight from `src/config.js`. The lobby button, its animation (a slow rest-beat
  plus a wheel spin that fires both periodically and on hover — see
  `_startWheelSpin`), the NEW /
  free-spin badges, and its availability gate live in `src/lobby.js`
  (`_makeWheelButton` / `_startWheelSpin` / `_updateWheelBadges` /
  `_freeSpinAvailable`), reading the wheel's `unlockLevel` / `canSpin()` and
  refreshing live on `user` `fortuneWheel`/`progress` changes. It is entry **#1** on
  the lobby's feature rail; where it sits is the rail's call, not the button's.
- `src/dailybonus.js` is the `DailyBonusScene` — the free once-a-day gift overlay
  (modeled on `FortuneWheelScene`: full-screen dim + centred panel + `easeOutBack`
  pop + `layout` reflow), opened from the lobby's pulsing gift button. It has no
  stored cycle: `canClaim()` derives eligibility straight from the persisted
  day-key (`user.dailyBonus.lastClaimDay`) vs `_today()` — no streak, no
  advance-cycle. `open()` pre-rolls three independent weighted draws
  (`_rollBoxes` / `_pickIndex`, honouring a `_forceIndex` test seam); `_openBox(i)`
  **commits the claim up front** (`user.recordDailyClaim` — hides the lobby button,
  no re-roll), animates the box open, and reveals the prize. `_double()` watches a
  stubbed rewarded ad (`_adResult` seam: `succeed`/`cancel`/`fail`) to double the
  amount; `_take(multiplier)` flies the icon to its HUD counter and grants on
  landing (`user.credit`/`user.grantBooster`), then closes. The prize pool comes
  from `assets/config/dailybonus.json`; a missing/failed config degrades to an
  empty pool (button stays hidden). Its `unlockLevel` gate is read straight from
  `src/config.js`. The lobby button, its animation
  (a slow rest-beat, a periodic squashy hop, and a swell-plus-gift-wiggle on hover —
  see `_startDailyPulse`),
  and
  its gate live in `src/lobby.js` (`_makeDailyButton` / `_startDailyPulse` /
  `_dailyBonusAvailable`), refreshing live on `user` `dailyBonus`/`progress` changes
  and from the same low-frequency `main.js` ticker as the wheel (so a lobby left open
  across midnight re-shows the gift). It is entry **#2** on the lobby's feature rail,
  so it **rises into the wheel button's slot** whenever that one isn't offered.
- `src/levelchest.js` is the `LevelChest` — the **feature logic** of the level-complete
  chest (the schedule and the maths), drawn nowhere itself: it just answers
  `infoFor(level)` → `{ index, filled, needed, label, reward, full }` for the win
  overlay. The schedule comes from `assets/config/levelChest.json` (degrading to an
  empty schedule on a missing/failed config, so the overlay simply shows no chest);
  the **repeat-start** index is read from `CONFIG.features.levelChest`. It is a pure,
  UI-free module — everything is **derived** from the highest level cleared, so it
  holds no per-player state. The bar, the open animation and the reward popup live in
  `GameScene` (see the `game.js` note above) and the persistent bar in `LobbyScene`.
  `infoFor(level)` is the win-screen view (the chest that clear filled, `full` when it
  reaches the top); `currentFor(level)` is the lobby's resting view (identical
  mid-chest, but a just-opened milestone rolls forward to the next chest at 0
  notches). `parseReward`/`rewardIsCoins` translate the `"itemId|count"` reward
  strings to the port's grant vocabulary
  (`0`→coins, `10`→undo, `11`→wand, `12`→shuffle, `20`→lightning→coins).
- `src/tutorial.js` is the `HowToPlayPopup` — the modal tutorial level 1 opens
  before play (see the Gameplay section and the `GameScene` notes above). Unlike
  the other overlays it is **owned by the level scene**, not by `main.js`: it lives
  on the scene's `tutorialLayer`, is created/destroyed by `loadLevel` / `_exit`, and
  re-centres from `GameScene.layout()`. It draws its own mini board and tray from
  the game's real tile/slot textures, and carries its own copy of the standard
  button (`_makeButton`) so it stays independent of the scene.
- `src/settings.js` is the `SettingsScene` — an overlay opened by the **cog
  button** in the top-left of both the lobby and the level. It has **Music** and
  **Sound** toggles (driving `audio.setMusic` / `setSound`, which persist to the
  User object) and a **Back** button that returns to the scene underneath.
- `src/main.js` boots Pixi, owns the lobby ⇄ game flow, and reads/writes player
  state (level, settings, wallet) through the **User object** (see below). The last
  step of boot is the **first-run branch**: `user.isNewPlayer()` → `startLevel(1)`
  (skip the lobby), else `showLobby(currentLevel)`; `onLevelComplete` records the
  clear with `user.completeLevel(n)` — which is what makes the player no longer new
  **and** what pays out any helper unlock that just came due — before advancing the
  level and returning to the lobby. On boot
  it `loadLevels()` (fetches `assets/config/levels.json`) then `buildLevelGroups()`
  to populate the asset manifest; the highest playable level is simply that list's
  length (`levels.length` — there is no separate `MAX_LEVEL` constant). It
  also constructs the **Shop** overlay and the **payment provider**
  (`makePayments`), wires the coin-pill taps to open the shop, and owns
  `purchasePackage` (run the provider, then grant the package's coins + boosters on
  success).
- `src/splash.js` is the **loading splash** controller — a thin wrapper over the
  `#splash` markup in `index.html` (title, bar, percentage, status line), with no
  Pixi dependency at all. `main.js` drives it across **every** boot stage rather
  than just the asset preload, dividing the bar by a `P` table at the top of the
  file: level table 10%, profile 16%, asset preload 80% (the only stage moving
  real bytes — the existing `AssetManager.preload(groups, onProgress)` per-item
  callback is mapped onto that range), the prices/turntable/dailybonus configs
  88%, scene construction + `resize()` 96%, first scene 100%. Progress is
  **monotonic** (a later stage reporting a smaller fraction can never walk the bar
  backwards) and there is **no minimum display time** — `splash.hide()` runs the
  moment the first scene is up, just *ahead* of the `window.__game` assignment, and
  the fade-out drops `pointer-events` immediately so it can never swallow a tap
  meant for the canvas. `show()`/`hide()` are **hold-counted**, so the mid-session
  lazy level load (`startLevel` → `assets.ensureLevel(n, onProgress)`, which now
  reports its 2 items) can reuse the same splash without a nested load hiding the
  boot one early. A fatal boot failure calls `splash.fail(msg)`, which keeps the
  overlay up in an error state instead of fading onto a blank canvas. It is
  deliberately **outside** the Pixi stage: not a `root` child, no `layout()` call,
  and absent from `window.__game.controls()`.
- **Responsive layout** — the game is a **fixed-width 750-unit vertical column**
  that is centred on any screen and never stretched sideways (matching the
  original). `main.js`'s `resize()` sizes the renderer to the whole viewport and
  uniformly scales the stage by `min(vw/750, vh/1334)` — so the game column always
  maps its 750-wide design onto the screen without distortion — then hands each
  scene the resulting design area (`DW×DH`) via `scene.layout(DW, DH)`.
  - **Portrait / narrow screens** (up to 9:16) are *width-constrained*: the 750
    column fills the full width and the extra height becomes vertical margin — the
    top HUD anchors to the **top** edge, the tray + helper row anchor to the
    **bottom** edge, and the board fills (and recentres in) the band between.
  - **Wide screens** (wider than 9:16) are *height-constrained*: the 750 column is
    **centred** and its extra horizontal space is filled with a **blurred copy of
    the background** — the game is never blown up to the full width. The crisp
    background covers only the centred column; a blurred, cover-fit copy fills the
    sides (`layout.js` `buildColumnBackground`). Corner chrome (settings cog, coin
    pill) and the two feature rails (Free Spin / Daily Bonus on the left, Tasks on
    the right) therefore ride the **edges of the column**, not the physical screen
    edges — a rail's `x` and slot ladder are plain design-space coordinates on the
    `topHud` layer, so pinning one to an outer edge needs no per-element anchoring
    logic.
  - The **board is sized to the 750 column**, not the viewport
    (`GameScene._layoutBoard` fits it by `min((min(viewW,750)-60)/spanX,
    areaH/spanY)`), so on a wide screen the tiles stay column-sized and the play
    area is a vertical strip — they do not grow edge-to-edge. On a taller screen
    the column simply gains vertical room (bigger board band).
  - `GameScene.layout` reflows the board/tray/overlay live, so a mid-level rotate
    or resize just re-lays-out in place. The **bottom tray is sized to the current
    level's tile size**, not a fixed slot: a board tile is drawn at `TILE_DRAW(96) *
    boardScale`, so `_layoutBoard` sizes each tray slot to match (a collected tile
    keeps its size flying into the tray), **clamped** to
    `[SLOT_MIN, slotMaxFor(cells)]` so the row always fits the 750-wide column —
    the upper bound depends on how many cells are drawn (90 for the base 7-cell
    row, 78 once the **8th slot** joins it), which is what lets the wider row
    re-centre and still fit (`_layoutTraySlots` redraws the panel + slots on any
    change of size **or** count).
  - Because `resize()` uses the **min** scale, the design area is always **≥
    750×1334 in both axes** — content is never compressed, only given extra margin —
    which is the property that keeps controls from overlapping across
    resizes/rotations. The shared reflow helpers live in **`src/layout.js`**
    (`DESIGN_W/H`, `coverBackground` / `buildColumnBackground` for the
    column-plus-blur background, `fitTextWidth` to keep centred text inside the safe
    centre band, `fitPanel` — a defensive clamp that scales a centred overlay
    panel down if its content would ever outgrow the view — and `makeHintPill`, the
    dark-glass one-line label every short in-level message is made of). Every scene exposes a
    `controls()` list of its independent controls, aggregated by
    `window.__game.controls()` (design-space rects) and asserted overlap-free by
    `tests/resize_overlap_test.py`.
- Pixi is vendored at `vendor/pixi.min.js` (v7.4.2).

### Key parameters (`src/config.js`)
Every **tuning knob** of the game — feature gates, unlock schedules, progression
thresholds and economy amounts — lives in **one file**, `src/config.js`, exported
as a single frozen `CONFIG` object with a paragraph of explanation on each value.
**Any new parameter goes there**: modules read config, they never define it. The
sections are:

| Section | What's in it |
| --- | --- |
| `progression` | `tutorialLevel` (which level opens "How To Play" + the guided opening) and `autoComplete.minLevel` / `.maxTiles` (the window the free Auto Complete button is offered in) |
| `features` | one gate/pacing block per feature: `shop.unlockLevel`, `fortuneWheel.unlockLevel` / `.spinsPerCycle` / `.headlinePrize`, `dailyBonus.unlockLevel`, `tasks.unlockLevel` / `.weeklyResetDay`, and `levelChest.repeatStart` (the Level Chest has no gate — it's derived from progress) |
| `boosters` | `kinds`, the `startingInventory` of a new account, `unlocks` — the helper → `{ level, grant }` schedule — `coach` (`enabled`, `undoDelayMs`) for the guided first use, and `superWand` (`unlockLevel` / `streakLength` / `minTiles` / `extraRounds`) for the Wand's earned upgrade |
| `economy` | `currencies`, the `startingWallet`, and `coinWinReward` (the only free coin faucet) |
| `board` | `traySlots` — the base tray capacity, the core difficulty dial — plus `extraSlot` (`unlockLevel` / `grant`, the ad-funded 8th slot) and `warnings` (`pulseAtFree` / `bubbleAtFree`, the two near-full cues, counted against the *live* capacity) |
| `persistence` | `saveDebounceMs` — the autosave debounce |
| `language` | `defaultLanguage` (what an unrecognised device language falls back to) and `textDir` (the folder holding the per-locale string tables). The 13 **offered** codes are deliberately not here — that list is hard-coded in `src/i18n.js`; see Localization above |

Every `unlockLevel` reads **"available from level N onward"**, i.e. it opens once
the player has *cleared* level N-1; gates are derived from `progress.completed`,
never stored, so a QA jump to a later level is honoured with nothing to repair.

Two kinds of value deliberately stay **out** of it:
- **Layout/visual constants** (panel sizes, slot pitch, colours, tween
  durations) — they belong next to the scene that draws them.
- **Large data tables**, which stay as JSON under `assets/config/` so they can be
  re-tuned without touching source at all: `levels.json` (the level table),
  `prices.json` (coin prices), `turntable.json` (wheel prize groups + odds),
  `dailybonus.json` (the weighted prize pool), `tasks.json` (achievement chains +
  the weekly list). Those files hold **prize/level/goal data only** — the *gates
  and pacing* around them are in `config.js`.

It is a JS module rather than a fifth JSON file for two reasons: JSON has no
comments (and these parameters are useless without them), and some values are
needed **synchronously** — `User.migrate()` reads the unlock schedule while
rehydrating a saved profile, before any `fetch` could have resolved. With no
build step it is still just a data file you edit and reload.

### Levels (`assets/config/levels.json` + `src/levelConfig.js`)
Every level is declared in **one place** — the JSON array in
`assets/config/levels.json` (a tunable data config alongside `prices.json` /
`turntable.json`). Each entry is `{ background, data, types, preload? }` (paths to
a background image and a level-data JSON, the count of distinct tile faces the
level uses — an integer or a `[min, max]` range drawn deterministically per level
— plus an optional preload flag). `src/levelConfig.js` fetches this file at boot
(`loadLevels()`) and owns the type-count logic (`typesForLevel()`).
**Adding a level is a single one-line append to the JSON** — nothing else needs
editing:
- The highest playable level is simply the array's **length** (`levels.length`,
  read by `main.js` and passed to the lobby) — there is no separate `MAX_LEVEL`
  constant.
- `src/assets.js` builds its load **manifest** from the loaded table via
  `buildLevelGroups()` (level *N* ↔ entry *N-1*), so a new entry is automatically
  loadable.

### Asset management (`src/assets.js` + `src/audio.js`)
Assets are organised into groups: a shared `core` group plus one `levelN` group
per level, the latter generated from the `levels.json` config above.
- **Preload** — on boot, `AssetManager.preload()` loads the essential minimum:
  `core` audio + every level flagged `preload: true` in the config (backgrounds
  + level data). Its `onProgress(done, total)` callback drives the biggest slice
  of the **splash screen's** progress bar (see `src/splash.js` above).
- **Lazy load** — any level *not* flagged for preload is fetched on demand via
  `ensureLevel(n, onProgress)` (called from `startLevel`), so its assets download
  only when the player reaches it; the optional progress callback re-shows the
  splash with a real bar for the wait. Loads are idempotent and de-duplicated
  (cached results + shared in-flight promises), so nothing is fetched twice.
- **Audio** uses the **Web Audio API**: each file is fetched and decoded into an
  in-memory `AudioBuffer` **once**, and every play spins up a throwaway
  `AudioBufferSourceNode`. Sounds overlap freely and playback makes **no network
  request** — replacing the old HTML5-`Audio` `cloneNode()` approach that
  re-fetched the file from the server on every single play.
- Besides the fire-and-forget one-shots (`audio.play`), a sound can run as a
  **sustained loop** (`audio.playLoop`) for as long as the thing making it does —
  used by the Fortune Wheel's spin clicks. It returns a handle whose `setRate()`
  **retunes the loop live** (so a click bed can speed up and slow down with what
  it is voicing) and whose `stop()` ends it; `loopEnd` loops only the head of a
  recording whose tail is a one-off ending. Loops are cut the moment **Sound** is
  switched off (a one-shot can just stop being started; a loop can't).
- **Background music** starts in the lobby on initial load. Browsers that block
  autoplay before a user gesture start it on the first pointer interaction
  instead. **Music** (bgm) and **Sound** (sfx) are two independent channels
  (`audio.setMusic` / `audio.setSound`), toggled from the **settings screen**
  (see below). Both preferences live on the User object (see below). When the
  tab is hidden (player switches to another tab / minimises) the audio context is
  **suspended** so nothing is audible, and resumed on return — *without* changing
  the saved music/sound settings (`audio.setPageVisible`, driven by
  `visibilitychange`).

### User & persistence (`src/user/`)
All per-player state lives on one platform-agnostic **`User`** object, ready for
publishing on **Facebook Instant, Reddit, and Telegram**:
- **`User.js`** — the model: a stable `id`, `platform`, `progress` (`level`, the
  next level to play, plus `completed`, the highest level ever cleared — 0 for a
  player who has never finished level 1; `completeLevel()` records a clear and
  `isNewPlayer()` = "level 1 and nothing completed", the gate the first-run flow
  reads),
  a **multi-currency `wallet`** (`coins`, `gems`, … — a keyed map, so new
  currencies need no code change: `credit`/`debit`/`balance`/`canAfford`), a
  **helper/booster inventory** (`boosters` — a keyed map of
  `undo`/`shuffle`/`wand`… → remaining uses, mirroring the wallet:
  `boosterCount`/`hasBooster`/`grantBooster`/`useBooster`; a new account is awarded
  **none**), the helper **unlock schedule** (`CONFIG.boosters.unlocks` in `src/config.js`, a
  table of helper → `{ level, grant }`: `boosterUnlockLevel(kind)` and
  `isBoosterUnlocked(kind)` — the latter derived from `completed`, so a jump
  straight to a later level is honoured with no bookkeeping to repair — plus
  `boosterUnlocks`, the list of helpers whose one-time grant has already been paid.
  `completeLevel()` calls `_grantPendingUnlocks()`, which is what pays it out, once),
  the **coaching** record (`boosterCoach` + `isBoosterCoached`/`markBoosterCoached`
  — same one-time, idempotent shape as `boosterUnlocks`, but a separate list
  because the grant is paid the instant the gate opens while the lesson waits
  until the player is actually in a level),
  the **shop** gate (`CONFIG.features.shop.unlockLevel` + `isShopUnlocked()`, derived from
  `completed` the same way and with nothing to grant — it only decides whether the
  coin pill offers the store),
  `settings` (`music`, `sound`), and the **Fortune Wheel**
  per-cycle state (`fortuneWheel` — `group`/`day`/`spinsUsed`/`won`/`seen`, mutated
  via `advanceWheelCycle`/`recordWheelSpin`/`markWheelSeen`, emitting a
  `fortuneWheel` domain), and the **Daily Bonus** claim state (`dailyBonus` —
  just `lastClaimDay`, the day-key of the most recent claim, mutated via
  `recordDailyClaim`, emitting a `dailyBonus` domain), and the **Tasks** state
  (`tasks` — `stats`, the lifetime counter per tracked activity, plus `claimed`
  and `weekly {week, claimed, base}`; read/written via
  `stat`/`bumpStat`/`weeklyStat`, `isTaskClaimed`/`markTaskClaimed` and
  `rollTaskWeek`, with the `isTasksUnlocked()` gate alongside `isShopUnlocked()`,
  emitting a `tasks` domain. The two `claimed` lists are the same idempotent
  one-time ledger as `boosterUnlocks`; `base` is a snapshot of `stats` taken at
  the week's start, so weekly progress is a subtraction rather than a second set
  of counters),
  and the **Super Wand** streak state (`superWand` — `streak`/`charged`/`announced`,
  mutated via `recordSuperWandWin`/`breakSuperWandStreak` — there is no
  "spend", using it takes nothing away — with
  `isSuperWandUnlocked()` gating it off `completed` the same way as the others,
  and `superWandNeedsAnnounce()`/`markSuperWandAnnounced()` tracking whether the
  button-takeover beat has played for the charge currently banked; emitting a
  `superWand` domain — see [Super Wand](#super-wand--an-earned-upgrade-to-the-wand)
  above for what the feature does). It emits a domain-tagged
  change event on every mutation and (de)serializes via `toJSON`/`fromJSON` with a
  `version` for forward migrations (currently **v8** — v1→v2 added `fortuneWheel`,
  v2→v3 added `dailyBonus`; both fill from defaults for older blobs, so each step
  just stamps the version. v3→v4 added `progress.completed`, **derived** as
  `level - 1` — levels only ever advanced on a win — so an existing player is never
  mistaken for a brand-new one and thrown back into level 1. v4→v5 moved helpers
  behind the unlock schedule: existing players were handed a starter stock up
  front, so it seeds `boosterUnlocks` with everything they have already reached —
  otherwise their next win would pay out a second grant on top — and **zeroes** the
  stock of anything still locked, since a v4 profile that never cleared a level was
  carrying helpers it should not have. v5→v6 added `boosterCoach` and deliberately
  leaves it **empty**: an existing player is already past some of these gates, so
  seeding it the way v4→v5 seeded `boosterUnlocks` would mean they never meet the
  coaching at all — empty means every helper they own is still owed its lesson.
  v6→v7 added `tasks`, and unlike v5→v6 it **derives what it honestly can**, in
  the spirit of v3→v4: `stats.levelsCompleted` is seeded from
  `progress.completed`, the one counter an old profile really does record. Every
  other counter starts at 0 — those histories were never written down — and
  `weekly.base` is seeded to match so the weekly list still starts at zero. The
  consequence is intended: an existing player opens the screen to find the level
  tiers they already earned stacked up and ready to claim. v7→v8 added
  `superWand`, the win-streak state behind the Wand's earned upgrade, and this
  time nothing is reconstructible: win streaks were never recorded, and a
  streak is by definition about a player's *recent* run rather than their
  history, so seeding one off `progress.completed` would be inventing a fact
  rather than deriving it (contrast v3→v4 and v6→v7, where the old field
  genuinely implied the new one). Every existing player therefore starts the
  feature at zero and earns their first Super Wand honestly — the constructor
  shallow-merges the sub-object from defaults(), so this step, like v1→v2 and
  v2→v3, only has to stamp the version).
- **`adapters.js`** — a small **async** storage/identity contract
  (`identify` / `load` / `save` / `clear`). `LocalStorageAdapter` is the working
  default on the open web. `FacebookInstantAdapter` / `TelegramAdapter` /
  `RedditAdapter` are **stubs** that persist to `localStorage` for now and mark
  the exact SDK calls (`// TODO(SDK):`) to swap in later (`FBInstant.player`,
  `Telegram.WebApp.CloudStorage`, Devvit KV) — no code outside this file changes
  when a platform is wired in for real. Identity is platform-owned and fixed;
  `clear()` wipes the *data*, never the id.
- **`payments.js`** — the **real-money purchase** contract, mirroring `adapters.js`
  (one small async surface per platform): `getCatalog()` + `purchase(productId)`.
  It exports the **`PACKAGES`** catalog — each package has an id, price, label, a
  `coins` amount, and a `boosters` map (helper → count), so a package is a single
  item (just coins) or a bundle. `MockPaymentProvider` is the working default on the
  open web (it "succeeds" instantly with **no real charge**, so the flow is
  testable). `FacebookInstantPayments` / `TelegramPayments` / `RedditPayments` are
  **stubs** extending the mock, each marking the exact SDK calls to swap in later
  (`// TODO(SDK):` — `FBInstant.payments.purchaseAsync`, `Telegram.WebApp.openInvoice`
  for Stars/XTR, Devvit payments over the webview bridge) plus a `// TODO:` for
  **server-side receipt validation before granting**. The provider is pure I/O: on
  success it reports the package contents and the **host** (`main.js`
  `purchasePackage`) applies them (`user.credit` + `user.grantBooster`), keeping the
  trust boundary in one place. `makePayments(platform)` picks the provider at boot
  (parallels `makeAdapter`).
  - **Adding a package is a single append** to the `PACKAGES` array in
    `payments.js` — nothing else needs editing. Give it a unique `id`, a `price`
    string, a `label`, and its contents (`coins` and/or a `boosters` map, e.g.
    `{ id: "power_pack", price: "$2.99", label: "Power Pack", coins: 200, boosters: { wand: 2 } }`).
    The Shop builds its rows from `getCatalog()`, and the host grants the contents
    generically, so the new package shows up and works with no UI or grant-logic
    change. (For a real platform launch you must also register that `id` as a
    product in the platform's store/catalog — Facebook / Telegram Stars / Devvit —
    per the `// TODO(SDK):` markers; on the open-web mock provider no registration
    is needed.)
- **`platform.js`** — `detectPlatform()` + `makeAdapter()` pick the adapter at boot.
- **`UserStore.js`** — resolves identity, loads/creates the profile, and
  **autosaves** (debounced) on every change plus a flush on tab hide/close. The
  save is **serialized (last-write-wins)** so the slow, async cloud adapters
  can't race two writes out of order; the exit-flush only writes when a change
  is actually pending, so a bare refresh never resurrects data you just cleared.
  `reset()` wipes the record on **whatever backend is active** (not by clearing
  `localStorage` by hand — that does nothing on a cloud backend) and returns the
  profile to defaults, keeping identity.

The game is not published yet, so there is no legacy migration — new players
start fresh. `main.js` sources the current level + audio settings from the User
object and writes changes back to it.

## Layout
```
JS/
  index.html
  vendor/pixi.min.js
  src/config.js             # KEY PARAMETERS: feature gates, unlocks, economy
  src/{main,splash,game,lobby,settings,shop,fortunewheel,dailybonus,tasks,levelchest,level,levelConfig,icons,audio,assets,tween}.js
  src/user/{User,adapters,payments,platform,UserStore}.js
  assets/
    config/levels.json      # the level table: {background,data,types,preload?} per level
    config/prices.json      # coin prices: in-level helper buys + the Out-of-Moves continue
    config/turntable.json   # Fortune Wheel prize groups + odds (gate/pacing: src/config.js)
    config/dailybonus.json  # Daily Bonus weighted prize pool (gate: src/config.js)
    config/tasks.json       # Tasks: achievement chains + weekly list (gate: src/config.js)
    config/levelChest.json  # Level Chest schedule: [id, levelId, reward] milestones (repeat-start: src/config.js)
    levels/level{1..13}.json
    bg/*.jpg
    audio/*.mp3
```
