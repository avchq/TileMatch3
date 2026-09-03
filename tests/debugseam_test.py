import os, re, sys

# EVERY DEBUG SEAM HUNG OFF `window` MUST BE INSIDE A `DEBUG:` BLOCK.
#
# `tools/build.py` strips the test/debug surface from a production bundle by
# passing `--drop-labels=DEBUG` to esbuild, which deletes `DEBUG: { … }` blocks
# outright. That is the ONLY mechanism doing the stripping: a seam written
# outside such a block ships to players, and `window.__game` is a cheat console
# (setLevel, completeLevel, the live config, direct handles on every scene).
#
# Nothing else notices. The rest of the suite serves raw source, where the label
# is inert and everything works either way; build_test.py boots the artifact and
# checks the two seams that exist TODAY are gone, but it cannot know about a
# third one added next month. So this test reads the source instead: any
# assignment to `window.<x>` or `globalThis.<x>` under src/ that is not inside a
# DEBUG block is a failure, with the fix being to wrap it, not to allowlist it.
#
# Pure source analysis — no browser, no server, runs in milliseconds.

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
os.chdir(ROOT)

ASSIGN = re.compile(r"\b(window|globalThis)\.([A-Za-z_$][\w$]*)\s*=(?!=)")
LABEL = re.compile(r"\bDEBUG\s*:\s*\{")

failures = []
def check(cond, msg):
    if not cond:
        failures.append(msg)
        print(f"  FAIL {msg}")
    else:
        print(f"  ok   {msg}")


def blank_noncode(src):
    """Replace string/template literals and comments with spaces.

    Length is preserved so offsets still line up with the original text, which
    keeps the line numbers in a failure message honest. Without this a `window.x
    = ` inside a comment or a string would read as a real assignment.
    """
    out = list(src)
    i, n = 0, len(src)
    while i < n:
        c = src[i]
        if c in "'\"`":
            j = i + 1
            while j < n:
                if src[j] == "\\":
                    j += 2
                    continue
                if src[j] == c:
                    break
                j += 1
            for k in range(i + 1, min(j, n)):
                if out[k] != "\n":
                    out[k] = " "
            i = j + 1
            continue
        if c == "/" and i + 1 < n and src[i + 1] == "/":
            j = src.find("\n", i)
            j = n if j < 0 else j
            for k in range(i, j):
                out[k] = " "
            i = j
            continue
        if c == "/" and i + 1 < n and src[i + 1] == "*":
            j = src.find("*/", i + 2)
            j = n if j < 0 else j + 2
            for k in range(i, j):
                if out[k] != "\n":
                    out[k] = " "
            i = j
            continue
        i += 1
    return "".join(out)


def debug_ranges(code):
    """(start, end) of every DEBUG-labelled block, by brace matching."""
    ranges = []
    for m in LABEL.finditer(code):
        depth, i = 0, m.end() - 1
        while i < len(code):
            if code[i] == "{":
                depth += 1
            elif code[i] == "}":
                depth -= 1
                if depth == 0:
                    break
            i += 1
        ranges.append((m.start(), i))
    return ranges


def seams(path):
    """Every window/globalThis assignment in a file, and whether it is guarded."""
    src = open(path, encoding="utf-8").read()
    code = blank_noncode(src)
    guarded = debug_ranges(code)
    found = []
    for m in ASSIGN.finditer(code):
        line = code[:m.start()].count("\n") + 1
        inside = any(a <= m.start() <= b for a, b in guarded)
        found.append((f"{m.group(1)}.{m.group(2)}", line, inside))
    return found, len(guarded)


# ---- the detector must actually detect ------------------------------------
# A source check that has never seen a violation proves nothing, so run it over
# a fabricated file first: two seams that must be caught, three lookalikes that
# must not be.
sample = '''
  DEBUG: {
    window.__good = { a: 1 };
  }
  window.__bad = 2;
  // window.__commented = 3;
  const s = "window.__string = 4";
  if (window.__read === 5) {}
  globalThis.__alsoBad = 6;
'''
code = blank_noncode(sample)
got = [(n, guarded) for n, _, guarded in
       [(m.group(1) + "." + m.group(2), code[:m.start()].count("\n") + 1,
         any(a <= m.start() <= b for a, b in debug_ranges(code)))
        for m in ASSIGN.finditer(code)]]
check(("window.__bad", False) in got, "detector catches an unguarded window seam")
check(("globalThis.__alsoBad", False) in got, "detector catches a globalThis seam")
check(("window.__good", True) in got, "detector accepts a DEBUG-guarded seam")
check(not any(n.endswith("__commented") for n, _ in got),
      "detector ignores a commented-out seam")
check(not any(n.endswith("__string") for n, _ in got),
      "detector ignores a seam inside a string literal")
check(not any(n.endswith("__read") for n, _ in got),
      "detector ignores a comparison, which is not an assignment")

# ---- now the real source tree ---------------------------------------------
files = []
for dirpath, dirnames, filenames in os.walk(os.path.join(ROOT, "src")):
    dirnames[:] = sorted(d for d in dirnames if d != "node_modules")
    files += [os.path.join(dirpath, f) for f in sorted(filenames) if f.endswith(".js")]
check(len(files) >= 25, f"scanned the whole module tree ({len(files)} files)")

unguarded, guarded_seams, labelled_files = [], [], 0
for path in files:
    found, n_labels = seams(path)
    if n_labels:
        labelled_files += 1
    for name, line, inside in found:
        rel = os.path.relpath(path, ROOT)
        (guarded_seams if inside else unguarded).append(f"{rel}:{line} {name}")

for s in guarded_seams:
    print(f"  ---  guarded seam: {s}")

check(not unguarded,
      "every window/globalThis seam in src/ is inside a DEBUG: block"
      + (f" — UNGUARDED: {unguarded}" if unguarded else ""))

# The two that exist today. If one of these disappears from the list, either it
# was renamed (update this test) or its DEBUG label was dropped (a real leak).
check(any("window.__game" in s for s in guarded_seams),
      "window.__game is present and guarded (src/main.js)")
check(any("window.__splash" in s for s in guarded_seams),
      "window.__splash is present and guarded (src/splash.js)")
check(labelled_files >= 2, f"DEBUG blocks exist in {labelled_files} module(s)")

# ---- and the label must actually mean something ---------------------------
build_py = open(os.path.join(ROOT, "tools", "build.py"), encoding="utf-8").read()
check("--drop-labels=DEBUG" in build_py,
      "tools/build.py passes --drop-labels=DEBUG, so the label really strips")

# ---- nothing OUTSIDE the module tree may READ a debug seam ----------------
# The mirror image of the check above, and the one that would have caught
# BOOT-001. index.html is a classic script: esbuild never touches it, so it
# survives into production intact — while everything it names inside a DEBUG
# block does not. Its boot-error handler asked `window.__game` whether the game
# had finished starting, which is always false in the artifact players run, so
# the FIRST post-boot error painted an opaque red overlay across a live session
# and left it there. Every test ran the dev tree, where the symbol exists and
# the guard worked, so the whole suite was blind to it.
#
# The rule: index.html may not READ a stripped symbol at all, in any form — not
# just assign one. The replacement flag is `<html data-booted>`, set by boot()
# outside every DEBUG block. Comments are blanked first, so the explanation
# beside that guard is free to name the old symbol.
STRIPPED = re.compile(r"__(game|splash)\b")
html = blank_noncode(open(os.path.join(ROOT, "index.html"), encoding="utf-8").read())
hits = sorted({m.group(0) for m in STRIPPED.finditer(html)})
check(not hits,
      "index.html never names a DEBUG-stripped symbol"
      + (f" — FOUND: {hits}" if hits else ""))
check("data-booted" in open(os.path.join(ROOT, "index.html"), encoding="utf-8").read()
      or "dataset.booted" in html,
      "index.html's boot guard reads the data-booted flag instead")
main_js = open(os.path.join(ROOT, "src", "main.js"), encoding="utf-8").read()
main_code = blank_noncode(main_js)
flag = "documentElement.dataset.booted = "
pos = main_code.find(flag)
check(pos >= 0, "src/main.js sets documentElement.dataset.booted")
if pos >= 0:
    inside = any(a <= pos <= b for a, b in debug_ranges(main_code))
    check(not inside,
          "…and sets it OUTSIDE any DEBUG block, so production gets it too")

if failures:
    print(f"\nDEBUG SEAM TEST FAILED — {len(failures)} check(s):")
    for f in failures:
        print(f"  - {f}")
    print("\nFix: wrap the seam in `DEBUG: { … }` so the production build drops it.")
    sys.exit(1)
print("\nDEBUG SEAM TEST PASSED")
