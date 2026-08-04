#!/usr/bin/env python3
"""Verify every internal /docs link (and its #anchor) resolves in the built site.

Starlight generates heading anchors at build time, so hand-written cross-links
like `/docs/guides/x/#some-heading` only break once a heading is renamed — which
is exactly the kind of rot a build does not catch. Run this after `astro build`:

    cd apps/www && pnpm build && python3 scripts/check-doc-links.py

Exits non-zero and prints every broken link.

Scope: root-relative `/docs/...` hrefs in the rendered HTML, which is how every
internal doc link in this repo is written. Relative (`../foo`) and external links
are not checked, so a clean run means "no broken absolute internal doc link",
not "no broken link anywhere".
"""

from __future__ import annotations

import os
import re
import sys
from urllib.parse import urldefrag

DIST = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "dist")

HREF_RE = re.compile(r'href="(/[^"]*)"')
ID_RE = re.compile(r'id="([^"]+)"')


def main() -> int:
    if not os.path.isdir(DIST):
        print(f"error: {DIST} not found — run `pnpm build` first", file=sys.stderr)
        return 2

    pages: dict[str, str] = {}
    for root, _, files in os.walk(DIST):
        if "index.html" not in files:
            continue
        rel = os.path.relpath(root, DIST).replace(os.sep, "/")
        url = "/" if rel == "." else f"/{rel}/"
        with open(os.path.join(root, "index.html"), encoding="utf-8") as fh:
            pages[url] = fh.read()

    ids = {url: set(ID_RE.findall(html)) for url, html in pages.items()}

    broken: list[tuple[str, str, str]] = []
    for url, html in pages.items():
        for href in HREF_RE.findall(html):
            path, frag = urldefrag(href)
            if not path.startswith("/docs"):
                continue
            if not path.endswith("/"):
                path += "/"
            if path not in pages:
                broken.append((url, href, "missing page"))
            elif frag and frag not in ids[path]:
                broken.append((url, href, "missing anchor"))

    unique = sorted(set(broken))
    for source, href, reason in unique:
        print(f"{reason}: {href}  (linked from {source})")

    doc_pages = sum(1 for url in pages if url.startswith("/docs"))
    print(f"\n{len(unique)} broken internal doc link(s) across {doc_pages} doc pages")
    return 1 if unique else 0


if __name__ == "__main__":
    sys.exit(main())
