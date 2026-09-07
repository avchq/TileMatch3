#!/usr/bin/env python3
"""Board-file tool: convert, validate and fingerprint `assets/levels/*.tmb`.

Dev-only — `tools/` is in NOT_SHIPPED and the game never imports this. The
authoritative parser is `parseBoard()` in `src/level.js`; this is an independent
second implementation, which is the point: `tests/levelformat_test.py` checks the
shipped boards through the JS parser, so a bug shared by a converter's writer and
its own reader cannot cancel itself out.

Commands
    fingerprint OUT [--from-json]   canonical sha256 per board, one per line
    convert                         assets/levels/*.json -> *.tmb, round-trip verified
    check [FILE ...]                parse + validate (default: every .tmb)

The format is documented in `src/level.js`. In short: one character is one
HALF-tile cell, `#` a tile and `.` empty; `size W H` and `anchor X Y` (integer
half-tile units) fix the grid, and `layer k` blocks run bottom-first.
"""

import glob
import hashlib
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LEVELS = os.path.join(ROOT, "assets", "levels")

VERSION = 1
EMPTY, TILE = ".", "#"


class BoardError(Exception):
    """A board file that cannot be read. Carries the file and line."""


class Board:
    def __init__(self, tiles, size, anchor):
        self.tiles = tiles          # [(gx, gy, layer)] in canonical order
        self.size = size            # (W, H) in half-tile cells
        self.anchor = anchor        # (X, Y) of the top-left cell, half-tiles

    @property
    def layers(self):
        return (max(t[2] for t in self.tiles) + 1) if self.tiles else 0

    def fingerprint(self):
        """Canonical hash of the geometry — order-independent by construction."""
        body = ";".join(sorted(f"{l},{x:g},{y:g}" for x, y, l in self.tiles))
        return hashlib.sha256(body.encode()).hexdigest()


# ---------------------------------------------------------------- parsing ----

def parse_board(text, url="<board>"):
    """Parse a .tmb board. Mirrors parseBoard() in src/level.js."""
    def die(lineno, msg):
        raise BoardError(f"{url}:{lineno}: {msg}")

    size = anchor = declared = None
    seen_version = False
    tiles = []
    layer = None          # index of the layer being read
    rows = 0              # rows read into it so far

    for lineno, raw in enumerate(text.splitlines(), 1):
        line = raw.split(";", 1)[0].strip()
        if not line:
            continue

        head = line.split()[0]
        if head == "tmb":
            if seen_version:
                die(lineno, "duplicate 'tmb' directive")
            m = re.fullmatch(r"tmb\s+(\d+)", line)
            if not m:
                die(lineno, f"malformed version line: {line!r} (want 'tmb {VERSION}')")
            if int(m.group(1)) != VERSION:
                die(lineno, f"unsupported format version {m.group(1)}, this parser reads {VERSION}")
            seen_version = True
            continue

        if not seen_version:
            die(lineno, f"expected 'tmb {VERSION}' as the first line, got {line!r}")

        if head in ("size", "anchor", "tiles", "layer"):
            if head == "layer":
                if size is None or anchor is None:
                    die(lineno, "'layer' before 'size'/'anchor'")
                if layer is not None and rows != size[1]:
                    die(lineno, f"layer {layer} has {rows} rows, 'size' declares {size[1]}")
                m = re.fullmatch(r"layer\s+(\d+)", line)
                if not m:
                    die(lineno, f"malformed layer header: {line!r}")
                k = int(m.group(1))
                expect = 0 if layer is None else layer + 1
                if k != expect:
                    die(lineno, f"layer {k} out of sequence, expected {expect}")
                layer, rows = k, 0
                continue

            if layer is not None:
                die(lineno, f"'{head}' must come before the first 'layer'")
            m = re.fullmatch(rf"{head}\s+(-?\d+)\s+(-?\d+)", line) if head != "tiles" \
                else re.fullmatch(r"tiles\s+(\d+)", line)
            if not m:
                die(lineno, f"malformed '{head}' directive: {line!r}")
            if head == "size":
                if size is not None:
                    die(lineno, "duplicate 'size'")
                size = (int(m.group(1)), int(m.group(2)))
                if size[0] < 1 or size[1] < 1:
                    die(lineno, f"'size' must be positive, got {size[0]}x{size[1]}")
            elif head == "anchor":
                if anchor is not None:
                    die(lineno, "duplicate 'anchor'")
                anchor = (int(m.group(1)), int(m.group(2)))
            else:
                if declared is not None:
                    die(lineno, "duplicate 'tiles'")
                declared = int(m.group(1))
            continue

        # Anything else must be a grid row inside a layer.
        if layer is None:
            die(lineno, f"unknown directive {head!r}")
        cells = re.sub(r"\s+", "", line)
        W, H = size
        if rows >= H:
            die(lineno, f"layer {layer} has more than the {H} rows 'size' declares")
        if len(cells) != W:
            die(lineno, f"row is {len(cells)} cells, 'size' declares {W}")
        bad = set(cells) - {EMPTY, TILE}
        if bad:
            die(lineno, f"unknown cell glyph {sorted(bad)[0]!r} (want {EMPTY!r} or {TILE!r})")
        X, Y = anchor
        for col, ch in enumerate(cells):
            if ch == TILE:
                tiles.append(((X + col) / 2, (Y - rows) / 2, layer))
        rows += 1

    # ---- whole-file checks
    if not seen_version:
        raise BoardError(f"{url}: empty board (no 'tmb {VERSION}' line)")
    if size is None:
        raise BoardError(f"{url}: missing 'size'")
    if anchor is None:
        raise BoardError(f"{url}: missing 'anchor'")
    if layer is None:
        raise BoardError(f"{url}: no layers")
    if rows != size[1]:
        raise BoardError(f"{url}: layer {layer} has {rows} rows, 'size' declares {size[1]}")
    if declared is not None and declared != len(tiles):
        raise BoardError(f"{url}: 'tiles {declared}' but the grid holds {len(tiles)}")
    if len(tiles) % 3:
        raise BoardError(f"{url}: {len(tiles)} tiles is not a multiple of 3")

    # Canonical order: bottom layer first, then down the board, then across —
    # the row-major scan the grid is written in. Keep this identical to
    # parseBoard() in src/level.js, or the two disagree about every board's faces.
    tiles.sort(key=lambda t: (t[2], -t[1], t[0]))
    return Board(tiles, size, anchor)


def parse_legacy(raw):
    """The old encoding: an array of `x|y,x|y,...` layer strings, bottom first."""
    tiles = []
    for layer, s in enumerate(raw):
        for tok in filter(None, (t.strip() for t in s.split(","))):
            x, _, y = tok.partition("|")
            tiles.append((float(x), float(y), layer))
    tiles.sort(key=lambda t: (t[2], -t[1], t[0]))
    return Board(tiles, None, None)


# ---------------------------------------------------------------- writing ----

def render(board, title):
    """Render a board as .tmb text. Dense rows; the parser accepts spaced too."""
    hx = [round(x * 2) for x, _, _ in board.tiles]
    hy = [round(y * 2) for _, y, _ in board.tiles]
    X, Y = min(hx), max(hy)
    W, H = max(hx) - X + 1, Y - min(hy) + 1

    grids = [[[EMPTY] * W for _ in range(H)] for _ in range(board.layers)]
    for x, y, l in board.tiles:
        grids[l][Y - round(y * 2)][round(x * 2) - X] = TILE

    out = [
        f"tmb {VERSION}",
        f"; {title}",
        f"; anchor is in HALF-tile units: top-left cell centre = tile ({X / 2:g}, {Y / 2:g})",
        "",
        f"size   {W} {H}",
        f"anchor {X} {Y}",
        f"tiles  {len(board.tiles)}",
        "",
    ]
    for i, g in enumerate(grids):
        out.append(f"layer {i}")
        out += ["".join(r) for r in g]
        out.append("")
    return "\n".join(out).rstrip("\n") + "\n"


# --------------------------------------------------------------- commands ----

def _legacy_files():
    return sorted(glob.glob(os.path.join(LEVELS, "level*.json")),
                  key=lambda p: int(re.search(r"(\d+)", os.path.basename(p)).group(1)))


def _board_files():
    return sorted(glob.glob(os.path.join(LEVELS, "level*.tmb")),
                  key=lambda p: int(re.search(r"(\d+)", os.path.basename(p)).group(1)))


def cmd_fingerprint(argv):
    """Write `name sha256` per board. --from-json reads the OLD encoding."""
    if not argv:
        sys.exit("usage: levelfmt.py fingerprint OUT [--from-json]")
    out, from_json = argv[0], "--from-json" in argv[1:]
    files = _legacy_files() if from_json else _board_files()
    if not files:
        sys.exit(f"no {'*.json' if from_json else '*.tmb'} boards in {LEVELS}")
    lines = []
    for path in files:
        name = os.path.splitext(os.path.basename(path))[0]
        with open(path, encoding="utf-8") as fh:
            text = fh.read()
        board = parse_legacy(json.loads(text)) if from_json else parse_board(text, path)
        lines.append(f"{name} {board.fingerprint()}")
    os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
    with open(out, "w", encoding="utf-8") as fh:
        fh.write("\n".join(lines) + "\n")
    print(f"wrote {len(lines)} fingerprints -> {out}")


def cmd_convert(argv):
    """Convert every legacy board, verifying the round trip before writing."""
    keep = "--keep" in argv
    files = _legacy_files()
    if not files:
        sys.exit(f"no level*.json in {LEVELS}")
    written = 0
    for path in files:
        name = os.path.splitext(os.path.basename(path))[0]
        with open(path, encoding="utf-8") as fh:
            legacy = parse_legacy(json.load(fh))
        text = render(legacy, f"Level {name[5:]}")
        # The round trip is the whole safety net: re-read what we are about to
        # write and require the identical tile list, in the identical order.
        back = parse_board(text, f"{name}.tmb")
        if back.tiles != legacy.tiles:
            sys.exit(f"{name}: ROUND TRIP FAILED — refusing to write any further boards")
        with open(os.path.join(LEVELS, f"{name}.tmb"), "w", encoding="utf-8") as fh:
            fh.write(text)
        written += 1
        if not keep:
            os.remove(path)
    print(f"converted {written} boards" + ("" if keep else " and removed the .json originals"))


def cmd_check(argv):
    files = argv or _board_files()
    if not files:
        sys.exit(f"no .tmb boards in {LEVELS}")
    bad = 0
    for path in files:
        try:
            with open(path, encoding="utf-8") as fh:
                parse_board(fh.read(), path)
        except (BoardError, OSError) as e:
            bad += 1
            print(e, file=sys.stderr)
    print(f"checked {len(files)} boards, {bad} bad")
    return 1 if bad else 0


def main(argv):
    cmds = {"fingerprint": cmd_fingerprint, "convert": cmd_convert, "check": cmd_check}
    if len(argv) < 2 or argv[1] not in cmds:
        sys.exit(__doc__)
    return cmds[argv[1]](argv[2:]) or 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
