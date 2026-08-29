#!/usr/bin/env python3
"""Build a production copy of the game and upload it to S3.

There is no bundler here — `index.html` loads plain ES modules — so a "build" is
a *staged, versioned, verified copy* of exactly the files that ship:

    build/<commit>/index.html
    build/<commit>/src/…
    build/<commit>/vendor/pixi.min.js
    build/<commit>/assets/…          (audio, bg, config, lang, all 1000 levels)
    build/<commit>/build-info.json   (what this is and where it came from)

The build number IS the commit hash, and it is the directory name both locally
and in the bucket. That makes every deploy immutable and addressable: the URL
`…/<commit>/index.html` can only ever mean one tree, so two releases can sit side
by side and a rollback is a pointer change, not a re-upload.

It also fixes the failure this project has already hit once. `index.html` pulls
`src/main.js`, which imports the rest of the graph; a browser holding a *stale
half* of that graph — a fresh `i18n.js` against a cached `config.js` — throws at
module scope, kills the graph before `boot()` runs, and freezes the splash at
"Starting up… 0%". Under a commit-addressed prefix that mix cannot happen: a
given URL's bytes never change, so everything under it is uploaded
`immutable, max-age=1y` and only the HTML entry point revalidates.

Two other things S3 will get wrong unless told:

  * **Content-Type.** S3 does not guess; `PutObject` without one stores
    `binary/octet-stream`, and a browser refuses to execute an ES module that is
    not served as JavaScript. Every extension is mapped explicitly below.
  * **Re-uploading unchanged bytes.** 1064 files per build. Objects whose ETag
    already matches the local MD5 are skipped, so re-deploying a commit costs a
    few HEADs instead of 6 MB.

Usage
-----
    python3 tools/build.py --bucket my-bucket                  # build + upload
    python3 tools/build.py --no-upload                          # stage locally only
    python3 tools/build.py --bucket my-bucket --dry-run         # show the plan
    python3 tools/build.py --bucket my-bucket --prefix game --latest

Credentials come from the usual boto3 chain (env vars, `~/.aws/credentials`,
instance role); `--profile` picks a named profile. Requires `boto3`:

    .venv/bin/python -m pip install boto3
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

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# What ships. Everything else in the repo — tests/, tools/, .venv/, .git/,
# .claude/, the READMEs, CLAUDE.md — is deliberately absent from the artifact.
SHIP = ["index.html", "src", "vendor", "assets"]

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


def walk_ship(src_root):
    """Every file that ships, as paths relative to the repo root."""
    out = []
    for entry in SHIP:
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


def verify(dest):
    """Gate the artifact before it can reach a bucket.

    Cheap checks for the failures that are invisible until the game is live: a
    missing entry point, a truncated asset tree, or a JSON file that does not
    parse (which at runtime means a level or a language table that throws during
    load and takes the module graph down with it).
    """
    problems = []

    for required in ("index.html", "src/main.js", "src/config.js",
                     "vendor/pixi.min.js"):
        if not os.path.isfile(os.path.join(dest, required)):
            problems.append(f"missing {required}")

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
    # bundle. Empty directories here mean a deploy that boots and then fails.
    for group in ("assets/audio", "assets/bg", "assets/config",
                  "assets/lang", "assets/levels"):
        path = os.path.join(dest, group)
        if not os.path.isdir(path) or not os.listdir(path):
            problems.append(f"asset group missing or empty: {group}")

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

    files = walk_ship(ROOT)
    total = stage(dest, files)

    problems = verify(dest)
    if problems:
        print("\nbuild verification FAILED:", file=sys.stderr)
        for p in problems:
            print(f"  - {p}", file=sys.stderr)
        shutil.rmtree(dest, ignore_errors=True)
        die("artifact discarded; nothing was uploaded")

    manifest = {
        **info,
        "build": build_id,
        "built_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "files": len(files),
        "bytes": total,
    }
    with open(os.path.join(dest, "build-info.json"), "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=2, sort_keys=True)
        f.write("\n")

    print(f"  staged {len(files)} files, {total / 1e6:.1f} MB → "
          f"{os.path.relpath(dest, ROOT)}/")
    print(f"  verified: entry points, asset groups, 13 language tables, "
          f"{sum(1 for f in files if f.endswith('.json'))} JSON files parse")

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
