#!/usr/bin/env python3
"""
dev-server.py — static server for local development.

Sends `Cache-Control: no-store` on everything (per the working agreement:
during development only the service worker manages caching, the HTTP layer
must never hold a stale shell). Plain `python -m http.server` lets the
browser heuristically cache JS, which serves you last hour's bug after a fix.

Usage: python tools/dev-server.py [port]   (default 8080, repo root)
  App:     http://localhost:<port>/app/
  Console: http://localhost:<port>/console/
"""
import http.server
import sys
from pathlib import Path


class NoStoreHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()


if __name__ == '__main__':
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8080
    root = Path(__file__).resolve().parent.parent
    import os
    os.chdir(root)
    print(f'Serving {root} with Cache-Control: no-store')
    print(f'  App:     http://localhost:{port}/app/')
    print(f'  Console: http://localhost:{port}/console/')
    http.server.ThreadingHTTPServer(('', port), NoStoreHandler).serve_forever()
