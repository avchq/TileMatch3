#!/usr/bin/env python3
"""Run every *_test.py in this directory sequentially and summarise pass/fail.

Each test is a standalone script: it starts its own static server on :8099,
drives the game in headless Chromium via Playwright, and exits non-zero on
failure. They must run one at a time because they share the port.

Usage:  python3 tests/run_all.py [name ...]
        (names are substrings; with none given, all tests run)
"""
import glob, os, subprocess, sys

HERE = os.path.dirname(os.path.abspath(__file__))
tests = sorted(glob.glob(os.path.join(HERE, "*_test.py")))
filt = sys.argv[1:]
if filt:
    tests = [t for t in tests if any(f in os.path.basename(t) for f in filt)]

results = []
for t in tests:
    name = os.path.basename(t)
    print(f"\n{'='*60}\nRUN {name}\n{'='*60}", flush=True)
    r = subprocess.run([sys.executable, t])
    results.append((name, r.returncode == 0))

print(f"\n{'='*60}\nSUMMARY\n{'='*60}")
for name, ok in results:
    print(f"  {'PASS' if ok else 'FAIL'}  {name}")
failed = [n for n, ok in results if not ok]
print(f"\n{len(results) - len(failed)}/{len(results)} passed")
sys.exit(1 if failed else 0)
