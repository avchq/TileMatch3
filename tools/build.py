#!/usr/bin/env python3
"""Build a production copy of the game and upload it to S3.

The game runs from plain ES modules in development — `index.html` loads `src/`
directly, no build step. Production is different: the 29 modules are bundled into
one file, minified, and obfuscated, and the debug API is stripped out.

    build/<commit>/index.html
    build/<commit>/src/main.js       one obfuscated bundle; the other 28 modules are gone
    build/<commit>/vendor/pixi.min.js
    build/<commit>/assets/…          audio, bg, config, lang, all 1000 levels
    build/<commit>/build-info.json   commit, toolchain, and what was done to the code

The build number IS the commit hash, and it is the directory name both locally
and in the bucket. Every deploy is therefore immutable and addressable: the URL
`…/<commit>/index.html` can only ever mean one tree, two releases can sit side by
side, and a rollback is a pointer change, not a re-upload.

It also fixes the failure this project has already hit once. A browser holding a
*stale half* of the module graph — a fresh `i18n.js` against a cached
`config.js` — throws at module scope, kills the graph before `boot()` runs, and
freezes the splash at "Starting up… 0%". Under a commit-addressed prefix that
cannot happen: a given URL's bytes never change, so everything under it is
uploaded `immutable, max-age=1y` and only the HTML entry point revalidates.
Bundling removes the possibility entirely — there is only one script to be stale.

The code pipeline
-----------------
1. **Bundle + minify** with esbuild: `src/main.js` and everything it imports
   become one IIFE, transpiled to es2019 (so older mobile Safari is fine),
   names shortened, comments and whitespace gone.
2. **Strip the debug API.** The `window.__game` block in `src/main.js` and the
   `window.__splash` seam in `src/splash.js` sit inside `DEBUG:` labelled
   blocks, and esbuild is passed `--drop-labels=DEBUG`, which deletes them.
   That block is a *cheat console* — `setLevel`, `completeLevel`, `config`,
   direct scene handles — so obfuscating the code while shipping it would be
   pointless. `--keep-debug-api` opts back in, for a staging build you want to
   drive from a test. In raw source the label is inert, so dev and the test
   suite are completely unaffected.
3. **Obfuscate** with javascript-obfuscator: identifier mangling, string-array
   extraction and encoding, number-to-expression rewriting. `--obfuscate-level`
   picks how far to go; the default deliberately stops short of control-flow
   flattening and dead-code injection, which are the two options that cost real
   frame time in a 60 fps Pixi game.

The obfuscator seed is derived from the commit, so the same commit obfuscates to
the same bytes — builds stay reproducible and the S3 ETag skip keeps working.

`vendor/pixi.min.js` is already minified and is copied untouched. Assets are
copied verbatim: they are the game's content, and the level/language JSON is
loaded by `fetch` at runtime.

Two things S3 will get wrong unless told:

  * **Content-Type.** S3 does not guess; `PutObject` without one stores
    `binary/octet-stream`, and a browser refuses to execute JavaScript that is
    not served as JavaScript. Every extension is mapped explicitly below.
  * **Re-uploading unchanged bytes.** Objects whose ETag already matches the
    local MD5 are skipped, so re-deploying a commit costs a few HEADs.

Usage
-----
    python3 tools/build.py --bucket my-bucket                  # build + upload
    python3 tools/build.py --no-upload                          # build locally
    python3 tools/build.py --no-upload --no-obfuscate           # readable bundle
    python3 tools/build.py --no-upload --no-bundle              # raw modules
    python3 tools/build.py --bucket my-bucket --obfuscate-level high

Requires the build toolchain (esbuild + javascript-obfuscator), which lives under
tools/ and is not a dependency of the game:

    npm --prefix tools install

Uploading additionally needs boto3 (`.venv/bin/python -m pip install boto3`);
credentials come from the usual chain, or `--profile`.
"""
import argparse
import concurrent.futures
import hashlib
import json
import mimetypes
import os
import shutil
import subprocess
import sys
import time
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
NODE_BIN = os.path.join(HERE, "node_modules", ".bin")

# The entry point esbuild walks. Everything reachable from it ends up in the
# bundle; nothing else in src/ ships.
ENTRY = "src/main.js"
BUNDLE = "src/main.js"   # deliberately the same path, so index.html is unchanged

# What ships, and what is deliberately left behind.
#
# Every top-level entry in the repo must be named in one of these two lists. One
# that is in neither STOPS THE BUILD, on purpose: the alternative is that someone
# adds a service worker, a `manifest.webmanifest` or a `shaders/` directory,
# finds it works perfectly against the local server, and discovers only in
# production that it was never uploaded. A build that fails with "I do not know
# whether this ships" costs a minute; that discovery costs an afternoon.
SHIP_DIRS = ["src", "vendor", "assets"]
SHIP_GLOBS = ["*.html"]          # top-level entry points, by pattern
NOT_SHIPPED = {
    "tests", "tools", "build", "node_modules", "__pycache__",
    ".git", ".venv", ".claude", ".idea", ".vscode", ".github",
    ".gitignore", ".gitattributes", ".DS_Store",
    "README.md", "CLAUDE.md", "LICENSE",
}

# Never copied, even from inside a shipped directory.
EXCLUDE_DIRS = {"__pycache__", ".git", "node_modules"}
EXCLUDE_FILES = {".DS_Store", "Thumbs.db"}
EXCLUDE_SUFFIXES = (".pyc", ".pyo", ".swp", ".orig", ".rej")

# S3 stores whatever Content-Type it is handed and guesses nothing. An ES module
# served as binary/octet-stream is refused by the browser, so this map is not a
# nicety — it is the difference between a working and a blank deploy.
CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js":   "text/javascript; charset=utf-8",
    ".mjs":  "text/javascript; charset=utf-8",
    ".css":  "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".mp3":  "audio/mpeg",
    ".ogg":  "audio/ogg",
    ".wav":  "audio/wav",
    ".jpg":  "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png":  "image/png",
    ".webp": "image/webp",
    ".gif":  "image/gif",
    ".svg":  "image/svg+xml",
    ".ico":  "image/x-icon",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".ttf":  "font/ttf",
    ".otf":  "font/otf",
    ".txt":  "text/plain; charset=utf-8",
    ".map":  "application/json; charset=utf-8",
}

# Everything under build/<commit>/ is immutable by construction. The HTML entry
# point still revalidates so that a re-upload of the same commit (or a CDN
# invalidation) is picked up rather than pinned for a year.
CACHE_IMMUTABLE = "public, max-age=31536000, immutable"
CACHE_REVALIDATE = "no-cache, must-revalidate"


def die(msg, code=1):
    print(f"error: {msg}", file=sys.stderr)
    sys.exit(code)


def git(*args):
    r = subprocess.run(["git", "-C", ROOT, *args], capture_output=True, text=True)
    if r.returncode != 0:
        die(f"git {' '.join(args)} failed: {r.stderr.strip()}")
    return r.stdout.strip()


def commit_info(full_hash):
    """The build number: the commit this tree was built from."""
    if not os.path.isdir(os.path.join(ROOT, ".git")):
        die("not a git repository — the build number comes from the commit hash")
    full = git("rev-parse", "HEAD")
    dirty = bool(git("status", "--porcelain"))
    try:
        branch = git("rev-parse", "--abbrev-ref", "HEAD")
    except SystemExit:
        branch = "HEAD"
    return {
        "commit": full,
        "short": full if full_hash else full[:12],
        "branch": branch,
        "dirty": dirty,
        "subject": git("log", "-1", "--pretty=%s"),
        "committed_at": git("log", "-1", "--pretty=%cI"),
    }


def walk_ship(src_root, build_dir=None):
    """Every file that ships, as paths relative to the repo root.

    Also the place where an unclassified top-level entry stops the build.
    """
    import fnmatch

    ships = list(SHIP_DIRS)
    unknown = []
    skip = set(NOT_SHIPPED)
    # The output directory itself is never an input, wherever it was pointed.
    if build_dir:
        rel = os.path.relpath(os.path.abspath(build_dir), src_root)
        if not rel.startswith(".."):
            skip.add(rel.split(os.sep)[0])

    for entry in sorted(os.listdir(src_root)):
        if entry in ships or entry in skip:
            continue
        if any(fnmatch.fnmatch(entry, g) for g in SHIP_GLOBS):
            ships.append(entry)
            continue
        unknown.append(entry)

    if unknown:
        die("unclassified top-level entries — I do not know whether these ship:\n"
            + "".join(f"         {e}\n" for e in unknown)
            + "       add each to SHIP_DIRS/SHIP_GLOBS or NOT_SHIPPED in "
              "tools/build.py.")

    if not any(e == "index.html" for e in ships):
        die("index.html is missing from the tree, cannot build")

    out = []
    for entry in ships:
        path = os.path.join(src_root, entry)
        if not os.path.exists(path):
            die(f"missing from the tree, cannot build: {entry}")
        if os.path.isfile(path):
            out.append(entry)
            continue
        for dirpath, dirnames, filenames in os.walk(path):
            dirnames[:] = sorted(d for d in dirnames if d not in EXCLUDE_DIRS)
            for name in sorted(filenames):
                if name in EXCLUDE_FILES or name.endswith(EXCLUDE_SUFFIXES):
                    continue
                full = os.path.join(dirpath, name)
                out.append(os.path.relpath(full, src_root))
    return out


def stage(dest, files):
    """Copy the shipping files into build/<commit>/, fresh every time."""
    if os.path.exists(dest):
        shutil.rmtree(dest)
    total = 0
    for rel in files:
        src = os.path.join(ROOT, rel)
        dst = os.path.join(dest, rel)
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        shutil.copy2(src, dst)
        total += os.path.getsize(dst)
    return total


def node_tool(name):
    """Path to a build-toolchain binary, or a one-line install instruction."""
    exe = os.path.join(NODE_BIN, name)
    if not os.path.isfile(exe):
        die(f"{name} is not installed — the production pipeline needs it.\n"
            f"       install the build toolchain:  npm --prefix tools install\n"
            f"       or skip the code pipeline:    python3 tools/build.py --no-bundle")
    return exe


def obfuscator_options(level, seed):
    """javascript-obfuscator settings, by how far you want to go.

    Two options are kept OFF at every level below `high` on purpose:
    `controlFlowFlattening` and `deadCodeInjection` are the ones that cost real
    frame time, and this is a 60 fps game whose hot loop runs over every tile
    every frame. `renameGlobals` stays off everywhere because PIXI arrives as a
    global from the separately-loaded vendor bundle and must keep its name.
    """
    base = {
        "compact": True,
        "simplify": True,
        "target": "browser",
        "seed": seed,                       # same commit -> same bytes
        "renameGlobals": False,
        "reservedNames": ["^PIXI$"],
        "identifierNamesGenerator": "mangled",
        "numbersToExpressions": False,
        "stringArray": False,
        "controlFlowFlattening": False,
        "deadCodeInjection": False,
        "selfDefending": False,
        "debugProtection": False,
        "transformObjectKeys": False,
        "unicodeEscapeSequence": False,
    }
    if level == "low":
        # Identifier mangling only — readable structure, unreadable names.
        return base
    medium = {
        **base,
        "numbersToExpressions": True,
        "stringArray": True,
        "stringArrayThreshold": 0.75,
        "stringArrayEncoding": ["base64"],
        "stringArrayIndexShift": True,
        "stringArrayRotate": True,
        "stringArrayShuffle": True,
        "stringArrayWrappersCount": 2,
        "stringArrayWrappersType": "variable",
        "splitStrings": True,
        "splitStringsChunkLength": 12,
    }
    if level == "medium":
        return medium
    # high: everything, at a measurable runtime cost. `transformObjectKeys` and
    # `selfDefending` are the risky pair — verify the build boots before shipping.
    return {
        **medium,
        "stringArrayEncoding": ["rc4"],
        "controlFlowFlattening": True,
        "controlFlowFlatteningThreshold": 0.5,
        "deadCodeInjection": True,
        "deadCodeInjectionThreshold": 0.2,
        "transformObjectKeys": True,
        "selfDefending": True,
    }


def build_code(dest, info, minify, obfuscate, level, keep_debug):
    """Bundle src/ into one file, then minify and obfuscate it in place.

    Returns a dict describing what happened, for build-info.json.
    """
    out = os.path.join(dest, BUNDLE)
    raw_bytes = sum(os.path.getsize(os.path.join(dest, "src", f))
                    for f in os.listdir(os.path.join(dest, "src"))
                    if f.endswith(".js"))

    cmd = [node_tool("esbuild"), os.path.join(ROOT, ENTRY),
           "--bundle", "--format=iife", "--target=es2019",
           "--legal-comments=none", "--log-level=warning",
           f"--outfile={out}"]
    if minify:
        cmd.append("--minify")
    if not keep_debug:
        # Deletes the `DEBUG:` labelled blocks in src/main.js and src/splash.js
        # outright — the window.__game cheat console and the __splash seam. A
        # label is used rather than a folded flag because esbuild drops it
        # unconditionally, with no reliance on constant propagation.
        cmd.append("--drop-labels=DEBUG")

    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        die(f"esbuild failed:\n{r.stderr.strip()}")
    if r.stderr.strip():
        print(f"  esbuild: {r.stderr.strip()}")

    # The bundle is self-contained, so every other module in the staged copy is
    # now dead weight — and shipping readable sources next to an obfuscated
    # bundle would defeat the point.
    src_dir = os.path.join(dest, "src")
    kept = os.path.abspath(out)
    for dirpath, dirnames, filenames in os.walk(src_dir, topdown=False):
        for name in filenames:
            full = os.path.join(dirpath, name)
            if os.path.abspath(full) != kept:
                os.remove(full)
        if dirpath != src_dir and not os.listdir(dirpath):
            os.rmdir(dirpath)

    bundled_bytes = os.path.getsize(out)
    obf_bytes = None

    if obfuscate:
        opts = obfuscator_options(level, int(info["commit"][:8], 16))
        cfg = os.path.join(dest, ".obfuscator.json")
        with open(cfg, "w", encoding="utf-8") as f:
            json.dump(opts, f)
        r = subprocess.run(
            [node_tool("javascript-obfuscator"), out, "--output", out, "--config", cfg],
            capture_output=True, text=True)
        os.remove(cfg)
        if r.returncode != 0:
            die(f"javascript-obfuscator failed:\n{(r.stderr or r.stdout).strip()}")
        obf_bytes = os.path.getsize(out)

    return {
        "bundled": True,
        "minified": bool(minify),
        "obfuscated": bool(obfuscate),
        "obfuscate_level": level if obfuscate else None,
        "debug_api": bool(keep_debug),
        "src_bytes_raw": raw_bytes,
        "bundle_bytes": bundled_bytes,
        "bundle_bytes_obfuscated": obf_bytes,
    }


def verify(dest, bundled=True):
    """Gate the artifact before it can reach a bucket.

    Cheap checks for the failures that are invisible until the game is live: a
    missing entry point, a truncated asset tree, or a JSON file that does not
    parse (which at runtime means a level or a language table that throws during
    load and takes the module graph down with it).
    """
    problems = []

    required = ["index.html", BUNDLE, "vendor/pixi.min.js"]
    if not bundled:
        required += ["src/config.js", "src/game.js"]
    for rel in required:
        if not os.path.isfile(os.path.join(dest, rel)):
            problems.append(f"missing {rel}")

    if bundled:
        # A bundle that still contains an import statement did not bundle.
        code = open(os.path.join(dest, BUNDLE), encoding="utf-8", errors="replace").read()
        if 'from"./' in code or 'from "./' in code:
            problems.append(f"{BUNDLE} still has relative imports — bundling did not happen")
        leftovers = [f for f in os.listdir(os.path.join(dest, "src"))
                     if f.endswith(".js") and f != os.path.basename(BUNDLE)]
        if leftovers:
            problems.append(f"unbundled sources still in the artifact: {leftovers}")

    # Everything index.html pulls directly must have come along.
    index = os.path.join(dest, "index.html")
    if os.path.isfile(index):
        import re
        html = open(index, encoding="utf-8").read()
        for ref in re.findall(r'(?:src|href)="([^"#?:]+)"', html):
            if ref.startswith(("http", "//", "data:")):
                continue
            if not os.path.isfile(os.path.join(dest, ref)):
                problems.append(f"index.html references {ref}, which is not in the build")

    # The asset tree, which is the whole point of shipping a copy rather than a
    # bundle. The groups are read off the source tree rather than hardcoded, so a
    # new one — assets/video/, say — is checked the day it is added instead of
    # deploying unnoticed and half-empty.
    src_assets = os.path.join(ROOT, "assets")
    dst_assets = os.path.join(dest, "assets")
    expected = sorted(d for d in os.listdir(src_assets)
                      if os.path.isdir(os.path.join(src_assets, d)))
    for group in expected:
        path = os.path.join(dst_assets, group)
        if not os.path.isdir(path):
            problems.append(f"asset group missing from the build: assets/{group}")
        elif not os.listdir(path):
            problems.append(f"asset group is empty: assets/{group}")
        else:
            want = len(os.listdir(os.path.join(src_assets, group)))
            got = len(os.listdir(path))
            if got < want:
                problems.append(
                    f"assets/{group} is short: {got} of {want} files copied")

    langs = os.path.join(dest, "assets/lang")
    if os.path.isdir(langs):
        codes = [f[:-5] for f in os.listdir(langs) if f.endswith(".json")]
        if "en.json" not in os.listdir(langs):
            problems.append("assets/lang/en.json missing — the fallback table")
        # Key parity across the 13 language tables, the failure that shows a raw
        # key on screen instead of a word.
        try:
            en = json.load(open(os.path.join(langs, "en.json"), encoding="utf-8"))
            for code in sorted(codes):
                d = json.load(open(os.path.join(langs, f"{code}.json"), encoding="utf-8"))
                missing = sorted(set(en) - set(d))
                if missing:
                    problems.append(
                        f"assets/lang/{code}.json missing {len(missing)} key(s): "
                        f"{', '.join(missing[:5])}")
        except (json.JSONDecodeError, OSError) as e:
            problems.append(f"language tables unreadable: {e}")

    # S3 stores whatever it is handed and guesses nothing, so an extension with
    # no explicit mapping would go up as application/octet-stream. Python's
    # mimetypes fallback covers the standard web formats, but engine-specific
    # ones (.atlas, .fnt, .skel, .basis) resolve to nothing at all — and a
    # silently mistyped asset is the kind of bug that only ever reproduces in
    # production. Make the author decide instead.
    unmapped = {}
    for dirpath, _, filenames in os.walk(dest):
        for name in filenames:
            ext = os.path.splitext(name)[1].lower()
            if ext not in CONTENT_TYPES:
                rel = os.path.relpath(os.path.join(dirpath, name), dest)
                unmapped.setdefault(ext, rel)
    for ext, example in sorted(unmapped.items()):
        problems.append(
            f"no Content-Type mapping for '{ext or '(no extension)'}' "
            f"(e.g. {example}) — add it to CONTENT_TYPES in tools/build.py")

    bad_json = 0
    for dirpath, _, filenames in os.walk(dest):
        for name in filenames:
            if not name.endswith(".json"):
                continue
            try:
                json.load(open(os.path.join(dirpath, name), encoding="utf-8"))
            except (json.JSONDecodeError, UnicodeDecodeError) as e:
                bad_json += 1
                rel = os.path.relpath(os.path.join(dirpath, name), dest)
                problems.append(f"malformed JSON: {rel} ({e})")
                if bad_json >= 5:
                    break

    return problems


def md5_of(path):
    h = hashlib.md5()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def content_type(path):
    ext = os.path.splitext(path)[1].lower()
    if ext in CONTENT_TYPES:
        return CONTENT_TYPES[ext]
    guess, _ = mimetypes.guess_type(path)
    return guess or "application/octet-stream"


def s3_client(region, profile):
    """An S3 client, or a one-line error — never a botocore traceback."""
    try:
        import boto3
        from botocore.exceptions import BotoCoreError, ProfileNotFound
    except ImportError:
        die("boto3 is required to upload.\n"
            "       install it:  .venv/bin/python -m pip install boto3\n"
            "       or stage the build only:  python3 tools/build.py --no-upload")
    try:
        session = boto3.Session(profile_name=profile) if profile else boto3.Session()
        return session.client("s3", region_name=region)
    except ProfileNotFound:
        die(f"AWS profile '{profile}' not found in ~/.aws/config")
    except BotoCoreError as e:
        die(f"could not create an S3 client: {e}")


def upload(dest, bucket, key_prefix, region, profile, jobs, force, dry_run):
    from botocore.exceptions import BotoCoreError, ClientError, NoCredentialsError

    items = []
    for dirpath, _, filenames in os.walk(dest):
        for name in sorted(filenames):
            local = os.path.join(dirpath, name)
            rel = os.path.relpath(local, dest).replace(os.sep, "/")
            items.append((local, f"{key_prefix}/{rel}"))
    items.sort(key=lambda i: i[1])

    if dry_run:
        print(f"\n  DRY RUN — would upload {len(items)} objects to "
              f"s3://{bucket}/{key_prefix}/")
        for local, key in items[:10]:
            print(f"    {key}  [{content_type(local)}]")
        if len(items) > 10:
            print(f"    … and {len(items) - 10} more")
        return 0, 0, 0

    s3 = s3_client(region, profile)

    # Fail fast and legibly on credentials/bucket before firing off N threads.
    try:
        s3.head_bucket(Bucket=bucket)
    except NoCredentialsError:
        die("no AWS credentials found (env, ~/.aws/credentials, or instance role)")
    except ClientError as e:
        code = e.response.get("Error", {}).get("Code", "?")
        die(f"cannot access s3://{bucket} ({code}): {e}")
    except BotoCoreError as e:
        die(f"cannot reach S3: {e}")

    uploaded = skipped = failed = 0
    lock_out = []

    def put(item):
        local, key = item
        ctype = content_type(local)
        cache = CACHE_REVALIDATE if local.endswith((".html", "build-info.json")) \
            else CACHE_IMMUTABLE
        digest = md5_of(local)
        if not force:
            # A single-part upload's ETag is the MD5 of the body, so an exact
            # match means these bytes are already there. Re-deploying a commit
            # then costs a HEAD per object instead of the whole tree.
            try:
                head = s3.head_object(Bucket=bucket, Key=key)
                etag = head.get("ETag", "").strip('"')
                if "-" not in etag and etag == digest:
                    return "skip", key, None
            except ClientError as e:
                if e.response.get("Error", {}).get("Code") not in ("404", "NoSuchKey", "403"):
                    return "fail", key, str(e)
        try:
            with open(local, "rb") as body:
                s3.put_object(Bucket=bucket, Key=key, Body=body,
                              ContentType=ctype, CacheControl=cache)
            return "ok", key, None
        except (ClientError, BotoCoreError, OSError) as e:
            return "fail", key, str(e)

    with concurrent.futures.ThreadPoolExecutor(max_workers=jobs) as pool:
        for status, key, err in pool.map(put, items):
            if status == "ok":
                uploaded += 1
            elif status == "skip":
                skipped += 1
            else:
                failed += 1
                lock_out.append(f"    {key}: {err}")
            done = uploaded + skipped + failed
            if done % 100 == 0 or done == len(items):
                print(f"\r  uploading… {done}/{len(items)} "
                      f"({uploaded} new, {skipped} unchanged)", end="", flush=True)
    print()
    for line in lock_out[:10]:
        print(line, file=sys.stderr)
    return uploaded, skipped, failed


def main():
    ap = argparse.ArgumentParser(
        description="Build the game into build/<commit>/ and upload it to S3.",
        formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--bucket", default=os.environ.get("GAME_S3_BUCKET"),
                    help="target S3 bucket (or set GAME_S3_BUCKET)")
    ap.add_argument("--prefix", default=os.environ.get("GAME_S3_PREFIX", ""),
                    help="key prefix inside the bucket, e.g. 'game' → game/<commit>/…")
    ap.add_argument("--region", default=os.environ.get("AWS_REGION"),
                    help="AWS region (default: from the environment/profile)")
    ap.add_argument("--profile", default=None, help="named AWS profile")
    ap.add_argument("--build-dir", default=os.path.join(ROOT, "build"),
                    help="where builds are staged (default: ./build)")
    ap.add_argument("--full-hash", action="store_true",
                    help="name the build with the full 40-char commit hash "
                         "(default: the first 12)")
    ap.add_argument("--allow-dirty", action="store_true",
                    help="build from a dirty working tree; the build is then "
                         "tagged <commit>-dirty and is NOT reproducible")
    ap.add_argument("--no-bundle", dest="bundle", action="store_false",
                    help="ship src/ as raw ES modules instead of one bundle "
                         "(no minify, no obfuscate, debug API intact)")
    ap.add_argument("--no-minify", dest="minify", action="store_false",
                    help="bundle without minifying")
    ap.add_argument("--no-obfuscate", dest="obfuscate", action="store_false",
                    help="bundle and minify, but skip obfuscation")
    ap.add_argument("--obfuscate-level", choices=("low", "medium", "high"),
                    default="medium",
                    help="how far to obfuscate. low = identifier mangling only; "
                         "medium (default) adds encoded string arrays; high adds "
                         "control-flow flattening and dead-code injection, which "
                         "cost real frame time in a 60fps game")
    ap.add_argument("--keep-debug-api", action="store_true",
                    help="do NOT strip window.__game — for a staging build you "
                         "want to drive from the test suite")
    ap.add_argument("--no-upload", action="store_true", help="stage locally, do not upload")
    ap.add_argument("--dry-run", action="store_true", help="show what would be uploaded")
    ap.add_argument("--latest", action="store_true",
                    help="also write <prefix>/latest.json pointing at this build")
    ap.add_argument("--force", action="store_true",
                    help="re-upload every object even if unchanged")
    ap.add_argument("-j", "--jobs", type=int, default=16,
                    help="parallel uploads (default 16)")
    args = ap.parse_args()

    started = time.time()
    info = commit_info(args.full_hash)

    if info["dirty"] and not args.allow_dirty:
        die("working tree is dirty — a build named after a commit must contain "
            "that commit.\n       commit your changes, or pass --allow-dirty to "
            "build anyway.")

    build_id = info["short"] + ("-dirty" if info["dirty"] else "")
    dest = os.path.join(args.build_dir, build_id)

    print(f"building {build_id}  ({info['branch']}: {info['subject']})")

    files = walk_ship(ROOT, args.build_dir)
    stage(dest, files)

    if args.bundle:
        code = build_code(dest, info, args.minify, args.obfuscate,
                          args.obfuscate_level, args.keep_debug_api)
        shrink = code["src_bytes_raw"] / max(1, code["bundle_bytes_obfuscated"]
                                             or code["bundle_bytes"])
        print(f"  bundled src/ ({code['src_bytes_raw'] / 1e3:.0f} kB across "
              f"{sum(1 for f in files if f.startswith('src/'))} modules) → "
              f"{(code['bundle_bytes_obfuscated'] or code['bundle_bytes']) / 1e3:.0f} kB "
              f"({shrink:.1f}× smaller)"
              + (f", obfuscated [{args.obfuscate_level}]" if args.obfuscate else "")
              + ("" if args.keep_debug_api else ", debug API stripped"))
        if args.keep_debug_api:
            print("  WARNING: window.__game is in this build — it is a cheat "
                  "console (setLevel, completeLevel, config). Do not ship it.")
    else:
        code = {"bundled": False, "minified": False, "obfuscated": False,
                "obfuscate_level": None, "debug_api": True}
        print("  NOT bundled: shipping raw ES modules, debug API intact")

    # Recount after the pipeline — bundling removes 28 files from the artifact.
    shipped = [os.path.relpath(os.path.join(dp, f), dest)
               for dp, _, fs in os.walk(dest) for f in fs]
    total = sum(os.path.getsize(os.path.join(dest, f)) for f in shipped)

    problems = verify(dest, bundled=args.bundle)
    if problems:
        print("\nbuild verification FAILED:", file=sys.stderr)
        for p in problems:
            print(f"  - {p}", file=sys.stderr)
        shutil.rmtree(dest, ignore_errors=True)
        die("artifact discarded; nothing was uploaded")

    manifest = {
        **info,
        **code,
        "build": build_id,
        "built_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "files": len(shipped),
        "bytes": total,
    }
    with open(os.path.join(dest, "build-info.json"), "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=2, sort_keys=True)
        f.write("\n")

    print(f"  staged {len(shipped)} files, {total / 1e6:.1f} MB → "
          f"{os.path.relpath(dest, ROOT)}/")
    print(f"  verified: entry points, asset groups, 13 language tables, "
          f"{sum(1 for f in shipped if f.endswith('.json'))} JSON files parse")

    if args.no_upload:
        print(f"\ndone in {time.time() - started:.1f}s (not uploaded)")
        return

    if not args.bucket:
        die("no bucket — pass --bucket NAME, set GAME_S3_BUCKET, or use --no-upload")

    key_prefix = f"{args.prefix.strip('/')}/{build_id}" if args.prefix.strip("/") else build_id
    uploaded, skipped, failed = upload(dest, args.bucket, key_prefix, args.region,
                                       args.profile, args.jobs, args.force, args.dry_run)

    if failed:
        die(f"{failed} object(s) failed to upload — the deploy is incomplete")

    if args.latest and not args.dry_run:
        s3 = s3_client(args.region, args.profile)
        pointer = json.dumps({"build": build_id, "commit": info["commit"],
                              "prefix": key_prefix,
                              "built_at": manifest["built_at"]}, indent=2) + "\n"
        latest_key = (f"{args.prefix.strip('/')}/latest.json"
                      if args.prefix.strip("/") else "latest.json")
        s3.put_object(Bucket=args.bucket, Key=latest_key,
                      Body=pointer.encode("utf-8"),
                      ContentType="application/json; charset=utf-8",
                      CacheControl=CACHE_REVALIDATE)
        print(f"  latest.json → {build_id}")

    if not args.dry_run:
        print(f"\ndeployed s3://{args.bucket}/{key_prefix}/index.html")
        print(f"  {uploaded} uploaded, {skipped} unchanged, "
              f"{time.time() - started:.1f}s")


if __name__ == "__main__":
    main()
