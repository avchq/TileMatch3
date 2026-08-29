#!/usr/bin/env python3
"""A no-cache static server for the game — use this when testing on a phone.

`python3 -m http.server` sends no cache headers, which lets a browser hold ES
modules indefinitely and revalidate none of them. On desktop you rarely notice;
on a phone you get a *partially* stale module graph — a fresh `src/i18n.js`
running against a cached `src/config.js`, say — and a module that throws during
evaluation kills the whole graph before `boot()` runs, leaving the splash frozen
at "Starting up… 0%". That is a real bug this project hit, and it costs an
afternoon to diagnose because it looks nothing like a caching problem.

`Cache-Control: no-store` makes every reload fetch the current tree, so what you
see on the device is what is on disk.

    python3 tools/serve.py [port]      # default 8099, serves the repo root

The test suite deliberately keeps using plain `http.server`: each run gets a
fresh browser profile, so caching never bites it, and the tests should exercise
the same server anyone else would.
"""
import functools
import http.server
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, max-age=0")
        super().end_headers()

    # A conditional request must not be answered 304 either, or the browser
    # keeps the copy it already has. `self.headers` is an email.message.Message,
    # which has no pop(); __delitem__ removes every occurrence and is a no-op
    # when the header is absent.
    def send_head(self):
        del self.headers["If-Modified-Since"]
        del self.headers["If-None-Match"]
        return super().send_head()


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8099
    handler = functools.partial(NoCacheHandler, directory=ROOT)
    with http.server.ThreadingHTTPServer(("", port), handler) as httpd:
        print(f"serving {ROOT} on http://0.0.0.0:{port} (no-store)")
        print("on a phone, open http://<this machine's LAN IP>:%d/index.html" % port)
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print()


if __name__ == "__main__":
    main()
