"""Shared plumbing for the end-to-end tests.

Every test file used to carry the same twenty lines: start `python -m http.server`
on the hard-coded port 8099, `time.sleep(1.5)` and hope it had bound, launch
Chromium with the SwiftShader flags, hang the console/pageerror hooks off the
page, then goto / clear storage / reload / wait for `window.__game`. Copied 48
times, that preamble cost the suite 72 seconds of pure sleeping and — because
every file wanted the same port — forced the whole suite to run one file at a
time.

This module owns that preamble instead, and in doing so removes the reason the
suite was serial:

  * `serve()` returns the base URL of a static server on a FREE port rather
    than 8099. Two tests can no longer collide, so `run_all.py` can fan them
    out across cores.
  * the server is polled until it actually accepts a connection (a few ms)
    rather than slept at.

Each test keeps its own server and its own browser, so the per-file isolation
the suite relies on is unchanged — nothing is shared between workers at all.

Writing a new test — the whole contract:

    import harness
    URL = harness.serve()
    with sync_playwright() as p:
        browser, page, errors = harness.launch(p)
        harness.boot(page, "window.__game && window.__game.lobby")
        ...

Never start a server, never name a port, never `time.sleep()` for one.
"""
import atexit
import contextlib
import os
import socket
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

# Where tests drop their PNG snapshots (gitignored). Every file namespaces its
# own shots by test name, so parallel workers never fight over a filename.
OUTPUT = os.path.join(HERE, "output")

# The renderer flags every test needs: headless Chromium has no GPU, so Pixi
# gets a software WebGL via SwiftShader. Without these the canvas never comes up.
LAUNCH_ARGS = [
    "--use-gl=angle", "--use-angle=swiftshader",
    "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist",
]

# Audio tests need this to hear anything without a real user gesture — but
# bgm_suspend_test.py deliberately runs WITHOUT it, to test the gesture gate
# itself. Hence a flag rather than a permanent addition to LAUNCH_ARGS.
AUTOPLAY_ARG = "--autoplay-policy=no-user-gesture-required"

# The design space (see the root README). Most tests use a slightly wider page
# so the letterboxing is visible; a few pick their own to test a shape.
DESIGN_VIEWPORT = (750, 1334)
DEFAULT_VIEWPORT = (780, 1334)

_url = None


# --------------------------------------------------------------------------
#  The static server
# --------------------------------------------------------------------------

def free_port():
    """A port nothing is listening on. Bind :0 and let the kernel choose."""
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def wait_port(port, timeout=15):
    """Block until something accepts on `port`. Replaces `time.sleep(1.5)`."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        with socket.socket() as s:
            s.settimeout(0.25)
            if s.connect_ex(("127.0.0.1", port)) == 0:
                return
        time.sleep(0.01)
    raise RuntimeError(f"static server never came up on port {port}")


def serve_dir(directory):
    """Start a static server for `directory` on a free port.

    Returns (base_url, popen). `--directory` is passed explicitly so the server
    does not depend on the caller's cwd — build_test.py serves a staged build
    rather than the repo, and shares this entry point.
    """
    port = free_port()
    srv = subprocess.Popen(
        [sys.executable, "-m", "http.server", str(port), "--directory", directory],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    atexit.register(_stop, srv)
    wait_port(port)
    return f"http://localhost:{port}", srv


def serve():
    """Base URL for the game, e.g. `http://localhost:41235`.

    Each test process gets its OWN server on its own free port, torn down at
    exit. That is deliberate: `python -m http.server` accepts a listen backlog
    of five, and a single shared server buckles once several browsers are
    fetching a game's worth of assets at once — which showed up as navigation
    timeouts, not as a server error. A server per test costs a few milliseconds
    and removes the contention completely.

    TM3_URL overrides it, for pointing the suite at a server you already have.
    Idempotent.
    """
    global _url
    if _url is None:
        shared = os.environ.get("TM3_URL")
        _url = shared.rstrip("/") if shared else serve_dir(ROOT)[0]
    return _url


def _stop(srv):
    srv.terminate()
    try:
        srv.wait(timeout=5)
    except Exception:
        srv.kill()


# --------------------------------------------------------------------------
#  The browser
# --------------------------------------------------------------------------

# Playwright's default navigation timeout is 30s, which is generous for one
# browser and not generous at all for four sharing a CPU through SwiftShader.
# When it expires the test goes RED — indistinguishable, in the output, from a
# real defect. It has to be the other way round: contention should cost
# wall-clock, never correctness. These are deliberately far past anything a
# healthy boot needs, so a test that hits one is genuinely stuck.
NAV_TIMEOUT_MS = 90_000
ACTION_TIMEOUT_MS = 45_000


def patient(page):
    """Give `page` the timeouts above. Call it on any page built by hand."""
    page.set_default_navigation_timeout(NAV_TIMEOUT_MS)
    page.set_default_timeout(ACTION_TIMEOUT_MS)


def watch(page):
    """Collect console errors and uncaught exceptions off `page`.

    Returns the list the tests assert is empty. Hooked separately from
    `launch()` because a few tests build extra pages from their own contexts —
    call it on any page you build by hand, for the timeouts if nothing else.
    """
    patient(page)
    errors = []
    page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
    page.on("pageerror", lambda e: errors.append("PAGEERROR: " + str(e)))
    return errors


def launch(p, viewport=DEFAULT_VIEWPORT, autoplay=False, **page_args):
    """Chromium + a page + its error list, wired the way every test wants.

    `viewport` is per-test on purpose: the suite is not uniform, and the odd
    sizes (390×844, 1000×2000, the parameterised sweeps) are testing layout.
    """
    args = LAUNCH_ARGS + ([AUTOPLAY_ARG] if autoplay else [])
    browser = p.chromium.launch(args=args)
    page = browser.new_page(
        viewport={"width": viewport[0], "height": viewport[1]}, **page_args)
    return browser, page, watch(page)


@contextlib.contextmanager
def session(p, viewport=DEFAULT_VIEWPORT, autoplay=False, **page_args):
    """`launch()` as a context manager, so the browser is closed even when an
    assertion fails. Yields (browser, page, errors)."""
    browser, page, errors = launch(p, viewport=viewport, autoplay=autoplay,
                                   **page_args)
    try:
        yield browser, page, errors
    finally:
        with contextlib.suppress(Exception):
            browser.close()


def new_page(browser, viewport=DEFAULT_VIEWPORT, **ctx_args):
    """A second page from an existing browser — a fresh context, so a fresh
    profile. For the tests that need two locales, two viewports or two players.
    """
    ctx = browser.new_context(
        viewport={"width": viewport[0], "height": viewport[1]}, **ctx_args)
    page = ctx.new_page()
    return page, watch(page)


# --------------------------------------------------------------------------
#  Booting the game
# --------------------------------------------------------------------------

def boot(page, ready="window.__game", fresh=True, timeout=20000, url=None):
    """Load the game and wait until the debug API answers.

    `fresh=True` wipes storage and reloads, which is what "a brand-new player"
    means to this suite — see tests/README.md for what a fresh profile then
    does (it boots into level 1, not the lobby).
    """
    page.goto(f"{url or serve()}/index.html")
    if fresh:
        page.evaluate("() => localStorage.clear()")
        page.reload()
    page.wait_for_function(ready, timeout=timeout)


def ready(page, expr="window.__game", timeout=20000):
    """Wait for `expr` after a reload the test performed itself."""
    page.wait_for_function(expr, timeout=timeout)


def frames(page, n=2):
    """Block until the page has actually PAINTED `n` more frames.

    The right primitive for "the game has had a chance to react": it counts
    frames rather than wall-clock, so it is exactly as correct on a loaded
    machine as on an idle one — which `time.sleep(0.2)` is not. Two frames is
    enough for a handler that runs on one frame and renders on the next.
    """
    page.evaluate(
        """(n) => new Promise(res => {
             const tick = () => (--n <= 0 ? res() : requestAnimationFrame(tick));
             requestAnimationFrame(tick);
           })""", n)


def settle(page, expr, timeout=5000):
    """Wait for a CONDITION instead of sleeping for a guessed duration.

    The suite still holds ~170s of `time.sleep()` covering animations and scene
    swaps. Each one that can name what it is waiting for belongs here instead.
    """
    page.wait_for_function(expr, timeout=timeout)
