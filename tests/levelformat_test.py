import json, os, sys, hashlib, glob, re
from playwright.sync_api import sync_playwright

import harness

# The board format (assets/levels/*.tmb) — see src/level.js for the grammar.
#
# This is the parity test for the re-encoding. The boards used to be JSON arrays
# of "x|y,x|y" layer strings; the fingerprints in tests/data/level_geometry.sha256
# were taken from THOSE files, before any of them were converted, so matching
# them proves the new encoding carries exactly the old geometry.
#
# The authoritative recomputation runs through the JS parser in the browser, not
# the Python one in tools/levelfmt.py. That is the point: the converter's writer
# and its own reader could share a bug (a transposed axis, a sign flip) and
# cancel it out. A second implementation in a different language cannot.
#
# tests/data/level_faces.sha256 goes further for the 28 playable levels: it pins
# the position -> FACE map, which the geometry hash cannot see. Tile order decides
# which face lands where (see parseLevel's note in src/level.js), so a board can
# keep every coordinate and still be repainted.

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
os.chdir(ROOT)
sys.path.insert(0, os.path.join(ROOT, "tools"))
import levelfmt  # noqa: E402

DATA = os.path.join(ROOT, "tests", "data")
LEVELS = os.path.join(ROOT, "assets", "levels")


def load_sums(name):
    with open(os.path.join(DATA, name), encoding="utf-8") as fh:
        return dict(l.split() for l in fh if l.strip())


fails = []
def check(ok, label):
    print(("  ok   " if ok else "  FAIL ") + label)
    if not ok:
        fails.append(label)


# ---- tier 1: the files themselves, no browser -----------------------------
print("board files")

tmb = sorted(glob.glob(os.path.join(LEVELS, "*.tmb")))
leftover = glob.glob(os.path.join(LEVELS, "*.json"))
check(len(tmb) == 1000, f"1000 .tmb boards on disk ({len(tmb)})")
check(not leftover, f"no .json boards left behind ({leftover[:3]})")

geom = load_sums("level_geometry.sha256")
check(len(geom) == 1000, f"1000 geometry fingerprints ({len(geom)})")

bad = []
for path in tmb:
    name = os.path.splitext(os.path.basename(path))[0]
    try:
        with open(path, encoding="utf-8") as fh:
            board = levelfmt.parse_board(fh.read(), path)
    except levelfmt.BoardError as e:
        bad.append(str(e))
        continue
    if board.fingerprint() != geom.get(name):
        bad.append(f"{name}: geometry fingerprint differs from the pre-conversion snapshot")
check(not bad, f"every board parses and matches its snapshot ({bad[:2]})")

# The level table must point at boards that exist — a renamed file is a 404 on
# the boot path, which no build check would catch.
with open(os.path.join(ROOT, "assets", "config", "levels.json"), encoding="utf-8") as fh:
    table = json.load(fh)
missing = [r["data"] for r in table
           if not r["data"].endswith(".tmb") or not os.path.isfile(os.path.join(ROOT, r["data"]))]
check(not missing, f"every levels.json `data` path is an existing .tmb ({missing[:3]})")

# ---- tier 1b: the parser rejects what it should ---------------------------
print("validation")

GOOD = "tmb 1\nsize 3 2\nanchor 0 1\ntiles 3\nlayer 0\n#.#\n..#\n"
BAD = {
    "no version":        "size 3 2\nanchor 0 1\nlayer 0\n#.#\n..#\n",
    "wrong version":     "tmb 9\nsize 3 2\nanchor 0 1\nlayer 0\n#.#\n..#\n",
    "ragged row":        "tmb 1\nsize 3 2\nanchor 0 1\nlayer 0\n#.##\n..#\n",
    "unknown glyph":     "tmb 1\nsize 3 2\nanchor 0 1\nlayer 0\n#o#\n..#\n",
    "missing size":      "tmb 1\nanchor 0 1\nlayer 0\n#.#\n",
    "missing anchor":    "tmb 1\nsize 3 2\nlayer 0\n#.#\n..#\n",
    "layer out of seq":  "tmb 1\nsize 3 2\nanchor 0 1\nlayer 1\n#.#\n..#\n",
    "too few rows":      "tmb 1\nsize 3 3\nanchor 0 1\nlayer 0\n#.#\n..#\n",
    "too many rows":     "tmb 1\nsize 3 2\nanchor 0 1\nlayer 0\n#.#\n..#\n#.#\n",
    "tiles mismatch":    "tmb 1\nsize 3 2\nanchor 0 1\ntiles 9\nlayer 0\n#.#\n..#\n",
    "not a multiple of 3": "tmb 1\nsize 3 2\nanchor 0 1\nlayer 0\n#.#\n...\n",
    "unknown directive": "tmb 1\nanchr 0 1\nsize 3 2\nlayer 0\n#.#\n..#\n",
    "duplicate size":    "tmb 1\nsize 3 2\nsize 3 2\nanchor 0 1\nlayer 0\n#.#\n..#\n",
}

check(len(levelfmt.parse_board(GOOD).tiles) == 3, "a well-formed board parses")
# Whitespace between cells is free, so a hand-spaced grid is the same board.
check(levelfmt.parse_board(GOOD).tiles ==
      levelfmt.parse_board("tmb 1\nsize 3 2\nanchor 0 1\nlayer 0\n# . #\n. . #\n").tiles,
      "`# . #` and `#.#` are the same row")

survived = []
for label, text in BAD.items():
    try:
        levelfmt.parse_board(text, "bad.tmb")
        survived.append(label)
    except levelfmt.BoardError:
        pass
check(not survived, f"python parser rejects every malformed board ({survived})")

# ---- tier 2: the real JS parser -------------------------------------------
print("the JS parser (src/level.js)")

BASE = harness.serve()
with sync_playwright() as p:
    browser, page, errors = harness.launch(p)
    harness.boot(page, "window.__game && typeof window.__game.parseBoard === 'function'")

    # All 1000 in ONE round trip: fetch, parse through the shipped parser, hash.
    digests = page.evaluate(
        """async (names) => {
             const enc = new TextEncoder(); const out = {};
             for (const n of names) {
               const text = await (await fetch(`assets/levels/${n}.tmb`)).text();
               const t = window.__game.parseBoard(text, n);
               const body = t.tiles.map(v => `${v.layer},${v.gx},${v.gy}`).sort().join(';');
               const buf = await crypto.subtle.digest('SHA-256', enc.encode(body));
               out[n] = [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
             }
             return out;
           }""",
        sorted(geom, key=lambda n: int(n[5:])),
    )
    off = [n for n, h in geom.items() if digests.get(n) != h]
    check(not off, f"all 1000 boards match the snapshot through the JS parser ({off[:3]})")

    # The JS parser must refuse exactly what the Python one refuses.
    js_survived = page.evaluate(
        """(cases) => Object.entries(cases)
             .filter(([, text]) => { try { window.__game.parseBoard(text, 'bad.tmb'); return true; }
                                     catch (e) { return false; } })
             .map(([label]) => label)""",
        BAD,
    )
    check(not js_survived, f"js parser rejects every malformed board ({js_survived})")
    check(page.evaluate("() => window.__game.parseBoard(%s).tiles.length" % json.dumps(GOOD)) == 3,
          "js parser accepts a well-formed board")

    # ---- the faces, for the levels that are actually played ---------------
    faces = load_sums("level_faces.sha256")
    check(len(faces) == len(table), f"a face fingerprint per playable level ({len(faces)})")
    off = []
    for n in range(1, len(table) + 1):
        assert page.evaluate(f"() => window.__game.startLevel({n})")
        got = page.evaluate(
            """() => {
                 const rows = window.__game.scene.tiles
                   .map(t => `${t.layer},${t.gx},${t.gy},${t.type}`).sort().join(';');
                 return rows;
               }"""
        )
        if hashlib.sha256(got.encode()).hexdigest() != faces.get(f"level{n}"):
            off.append(n)
    check(not off, f"every playable level's face layout is unchanged ({off[:5]})")

    check(not errors, f"no console errors ({errors[:2]})")
    browser.close()

print("LEVEL FORMAT CHECKS PASSED" if not fails else f"FAILED: {fails}")
sys.exit(1 if fails else 0)
