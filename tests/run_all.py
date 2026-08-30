#!/usr/bin/env python3
"""Run the end-to-end tests and summarise pass/fail.

Each test is a standalone script that drives the game in headless Chromium via
Playwright and exits non-zero on failure. They used to run strictly one at a
time, because all 48 of them started their own static server on the same
hard-coded port. They no longer do: `tests/harness.py` gives each one its own
server on a free port, so this runner can fan them out across cores.

Usage:  python3 tests/run_all.py [name ...]   # names are substrings
        python3 tests/run_all.py --smoke      # the fast tier, for the inner loop
        python3 tests/run_all.py -j 4         # fewer workers
        python3 tests/run_all.py --serial     # one at a time (debugging a flake)
        python3 tests/run_all.py -v           # stream every test's own output

Failures always print the failing test's full output. Passes print a duration,
and the summary ranks the slowest — that ranking is how the remaining blind
`time.sleep()` calls in the suite get found and retired.
"""
import argparse
import glob
import os
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor

import harness

HERE = os.path.dirname(os.path.abspath(__file__))

# The fast tier: broad coverage in the fewest browser boots — the game boots at
# all, a new player is routed correctly, the lobby draws, a level is playable,
# progress survives a reload, settings work, and all 13 languages load. Run this
# while iterating; the full suite is what gates a deploy (see tools/build.py).
SMOKE = [
    "boot_resilience_test.py",
    "newuser_test.py",
    "lobby_test.py",
    "firstlevel_test.py",
    "user_test.py",
    "settings_test.py",
    "i18n_test.py",
]

# Tests that must not share the machine. They run on their own, after the rest.
#
#   build_test.py       runs the real build pipeline three times over (esbuild
#                       plus the obfuscator, via node) — purely CPU-hungry.
#   fortunewheel_test.py \
#   tasks_test.py         |  these MEASURE ANIMATION DYNAMICS — not that a tween
#   featurerail_test.py   |  ended somewhere, but how it got there, frame by
#   dailybonus_test.py   /   frame: the wheel's click bed thinning out as it
#                       slows, a flick landing inside a button whose height is
#                       read mid-settle, two rail buttons never overlapping
#                       *during* a reflow.
#
#                       Starve the renderer and there are fewer frames to
#                       sample, and a tween stepping on a huge delta really can
#                       jump one button through another for a frame. The failure
#                       is real; it is a fact about the machine, not about the
#                       game, and no player at 60fps will ever see it. Waiting
#                       on a condition cannot help when the condition IS the
#                       frame rate — so these get the CPU to themselves.
#
#                       The signature to watch for when adding a test here: a
#                       `requestAnimationFrame` sampler inside `page.evaluate`,
#                       or a Python loop collecting samples while something
#                       animates. Asserting on a FINAL state is always safe and
#                       belongs in the parallel batch.
SERIAL = ["build_test.py", "fortunewheel_test.py", "tasks_test.py",
          "featurerail_test.py", "dailybonus_test.py"]


def run_one(path, env, verbose):
    name = os.path.basename(path)
    t0 = time.perf_counter()
    r = subprocess.run([sys.executable, path], env=env,
                       capture_output=not verbose, text=True)
    return name, r.returncode == 0, time.perf_counter() - t0, r.stdout or "", r.stderr or ""


def report(done, total, name, ok, secs, out, err, verbose):
    print(f"[{done}/{total}] {'PASS' if ok else 'FAIL'}  {name}  {secs:.1f}s", flush=True)
    if not ok and not verbose:
        # A failure is worth every line it printed on the way down.
        print(f"{'-' * 60}\n{out}{err}{'-' * 60}", flush=True)


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("names", nargs="*", help="substrings matched against filenames")
    ap.add_argument("--smoke", action="store_true",
                    help=f"run only the fast tier ({len(SMOKE)} files)")
    # Four, not one-per-core: headless Chromium renders through SwiftShader, so
    # every worker is CPU-bound on software WebGL. Eight at once on a 14-core
    # box starved each other badly enough to blow Playwright's 30s navigation
    # timeout — the suite went red for want of CPU, not for a real defect.
    ap.add_argument("-j", "--jobs", type=int, default=min(4, os.cpu_count() or 1),
                    help="tests to run at once (default: min(4, cores))")
    ap.add_argument("--serial", action="store_true",
                    help="one at a time — for reproducing a flake")
    ap.add_argument("-v", "--verbose", action="store_true",
                    help="stream each test's own output instead of capturing it")
    args = ap.parse_args()

    tests = sorted(glob.glob(os.path.join(HERE, "*_test.py")))
    if args.smoke:
        tests = [t for t in tests if os.path.basename(t) in SMOKE]
    if args.names:
        tests = [t for t in tests if any(n in os.path.basename(t) for n in args.names)]
    if not tests:
        print("no tests matched", file=sys.stderr)
        return 1

    jobs = 1 if (args.serial or args.verbose) else max(1, args.jobs)
    parallel = [t for t in tests if os.path.basename(t) not in SERIAL]
    serial = [t for t in tests if os.path.basename(t) in SERIAL]
    if jobs == 1:
        parallel, serial = parallel + serial, []

    # No shared server: each test starts its own on a free port (see
    # tests/harness.py serve()). One server for the whole run sounds tidier, but
    # http.server's backlog of five collapses under parallel browsers.
    env = dict(os.environ)

    print(f"{len(tests)} test(s), {jobs} at a time"
          + ("  [smoke]" if args.smoke else ""), flush=True)

    started = time.perf_counter()
    results, done = [], 0

    if jobs > 1 and parallel:
        with ThreadPoolExecutor(max_workers=jobs) as ex:
            for res in ex.map(lambda t: run_one(t, env, args.verbose), parallel):
                done += 1
                results.append(res[:3])
                report(done, len(tests), *res, args.verbose)
    else:
        for t in parallel:
            res = run_one(t, env, args.verbose)
            done += 1
            results.append(res[:3])
            report(done, len(tests), *res, args.verbose)

    for t in serial:
        res = run_one(t, env, args.verbose)
        done += 1
        results.append(res[:3])
        report(done, len(tests), *res, args.verbose)

    elapsed = time.perf_counter() - started
    failed = [n for n, ok, _ in results if not ok]

    print(f"\n{'=' * 60}\nSUMMARY\n{'=' * 60}")
    for name, ok, secs in sorted(results):
        print(f"  {'PASS' if ok else 'FAIL'}  {name:<28} {secs:6.1f}s")

    slowest = sorted(results, key=lambda r: -r[2])[:10]
    if len(results) > 10:
        print("\n  slowest:")
        for name, _, secs in slowest:
            print(f"    {secs:6.1f}s  {name}")

    print(f"\n{len(results) - len(failed)}/{len(results)} passed in {elapsed:.1f}s")
    if failed:
        print("failed: " + ", ".join(failed))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
