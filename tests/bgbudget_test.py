import json, os, struct, sys

# BACKGROUND ART MUST FIT THE COLUMN IT IS DRAWN INTO.
#
# Every background in the game reaches the screen through exactly one helper,
# `buildColumnBackground` (src/layout.js): a CRISP copy cover-fitted into the
# centred 750-design-unit column, plus a blurred, `cacheAsBitmap`-baked copy
# behind it for the side margins on a wide screen. Both are cover-fits, so the
# source resolution is irrelevant past the point where it covers the column —
# every extra pixel is downloaded on the critical boot path and then decoded into
# VRAM to be thrown away by the scaler.
#
# Two hard numbers fall out of the layout contract (src/layout.js): the stage is
# scaled by min(vw/750, vh/1334), so the design area is always >= 750x1334 in
# BOTH axes. Therefore:
#
#   * the crisp column is ALWAYS exactly 750 design units wide and >= 1334 tall,
#     so the visible crop of the art is never wider, relative to its height, than
#     750:1334 — anything wider than that aspect is width that no device ever
#     shows;
#   * the column occupies at most 750*3 = 2250 device px across and ~2532 down on
#     the tallest DPR-3 phone, so 1500x2668 (2x the design column) is already
#     more resolution than any handset can resolve.
#
# This test is the guard on both, and on the resulting boot payload. It is
# deliberately static — no browser: decoded texture bytes are exactly w*h*4, so
# the files themselves decide the answer and a live measurement would only add
# flakiness. It caught 6000x4000 JPEGs (96 MB of VRAM each) and an 11.8 MB
# three-file boot payload shipping behind the splash screen.

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
os.chdir(ROOT)

# 2x the 750x1334 design column: covers a DPR-3 phone's 1170x2532 column exactly.
MAX_W, MAX_H = 1500, 2668
# The widest crop the column can ever show, with 3% slack for rounding an odd crop.
MAX_ASPECT = (750 / 1334) * 1.03
# Bytes fetched before the splash can hand over, and for the whole shipped set.
BOOT_BUDGET = 1.5 * 1024 * 1024
TOTAL_BUDGET = 5.0 * 1024 * 1024

BG_DIR = "assets/bg"


def dimensions(path):
    """(w, h) of a JPEG or PNG, without decoding it."""
    with open(path, "rb") as f:
        d = f.read()
    if d[:8] == b"\x89PNG\r\n\x1a\n":
        w, h = struct.unpack(">II", d[16:24])
        return "png", w, h
    assert d[:2] == b"\xff\xd8", f"{path}: not a JPEG or a PNG"
    i = 2
    while i < len(d) - 9:
        if d[i] != 0xFF:
            i += 1
            continue
        m = d[i + 1]
        if m in (0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF):
            h, w = struct.unpack(">HH", d[i + 5:i + 9])
            return "jpeg", w, h
        if m == 0xD8 or 0xD0 <= m <= 0xD9:
            i += 2
            continue
        i += 2 + struct.unpack(">H", d[i + 2:i + 4])[0]
    raise AssertionError(f"{path}: no JPEG frame header")


levels = json.load(open("assets/config/levels.json"))
backgrounds = []          # (path, preload)
for row in levels:
    bg = row.get("background")
    if bg and bg not in [b for b, _ in backgrounds]:
        backgrounds.append((bg, bool(row.get("preload"))))

shipped = sorted(os.path.join(BG_DIR, f) for f in os.listdir(BG_DIR))

print(f"--- {len(shipped)} shipped backgrounds, {len(backgrounds)} referenced by levels.json ---")
failures = []
vram = 0
for path in shipped:
    kind, w, h = dimensions(path)
    size = os.path.getsize(path)
    decoded = w * h * 4
    vram += decoded
    print(f"  {os.path.basename(path):<10} {kind:<4} {w:>5}x{h:<5} "
          f"{size/1024:>7.0f} KB   {decoded/1048576:>5.1f} MB decoded")
    if kind != "jpeg":
        failures.append(f"{path}: {kind.upper()} — photographic backgrounds ship as JPEG")
    if w > MAX_W or h > MAX_H:
        failures.append(f"{path}: {w}x{h} exceeds {MAX_W}x{MAX_H} "
                        f"({decoded/1048576:.0f} MB of VRAM to fill a 750-wide column)")
    if w / h > MAX_ASPECT:
        failures.append(f"{path}: aspect {w/h:.3f} > {MAX_ASPECT:.3f} — width the "
                        f"750:1334 column crop can never show")

print(f"total decoded if every background were resident: {vram/1048576:.0f} MB")

# Everything referenced must actually be on disk (a renamed file that levels.json
# still points at is a 404 on the boot path, not a build error).
for path, _ in backgrounds:
    if not os.path.exists(path):
        failures.append(f"levels.json references {path}, which does not exist")

boot = [p for p, pre in backgrounds if pre and os.path.exists(p)]
boot_bytes = sum(os.path.getsize(p) for p in boot)
total_bytes = sum(os.path.getsize(p) for p in shipped)
print(f"boot background payload ({len(boot)} preloaded): {boot_bytes/1048576:.2f} MB")
print(f"whole shipped background set: {total_bytes/1048576:.2f} MB")
if boot_bytes > BOOT_BUDGET:
    failures.append(f"boot background payload {boot_bytes/1048576:.2f} MB exceeds "
                    f"{BOOT_BUDGET/1048576:.2f} MB — this is the first-launch experience")
if total_bytes > TOTAL_BUDGET:
    failures.append(f"background set {total_bytes/1048576:.2f} MB exceeds "
                    f"{TOTAL_BUDGET/1048576:.2f} MB")

if failures:
    print(f"--- {len(failures)} FAILURES ---")
    for f in failures:
        print("  ", f)
    sys.exit(1)
print("ALL BACKGROUND BUDGET CHECKS PASSED")
