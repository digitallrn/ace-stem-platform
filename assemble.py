#!/usr/bin/env python3
"""
assemble.py — builds a single self-contained HTML file from the dev split
(index.html + styles.css + render.js + grading.js + app.js + test-data.js)
for previewing in the claude.ai panel, exactly as index-live.html has always
worked — this just generalizes that pattern now that the app script is split
across several files instead of one.

Only LOCAL files are inlined. External references (the KaTeX CDN <link>/
<script> tags) are left untouched, same as the Desmos calculator already
requires internet — nothing new here.

Does NOT touch, know about, or produce sat-2026-june-asia-v1.html — that
fork is a separate, frozen artifact published from its own original chat.
This script only builds the PLATFORM track's preview file.

USAGE:
    python3 assemble.py [--out dist/index-live.html]
"""

import re
import argparse
from pathlib import Path

LOCAL_CSS_RE = re.compile(r'<link rel="stylesheet" href="(?!https?://)([^"]+)">')
LOCAL_JS_RE = re.compile(r'<script src="(?!https?://)([^"]+)"></script>')


def inline(html, base_dir):
    def css_sub(m):
        path = base_dir / m.group(1)
        if not path.exists():
            raise FileNotFoundError(f"assemble.py: missing {path} (referenced in index.html)")
        return "<style>\n" + path.read_text(encoding="utf-8") + "\n</style>"

    def js_sub(m):
        path = base_dir / m.group(1)
        if not path.exists():
            raise FileNotFoundError(f"assemble.py: missing {path} (referenced in index.html)")
        return "<script>\n" + path.read_text(encoding="utf-8") + "\n</script>"

    html = LOCAL_CSS_RE.sub(css_sub, html)
    html = LOCAL_JS_RE.sub(js_sub, html)
    return html


def main():
    parser = argparse.ArgumentParser(description=__doc__,
                                      formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--index", default="index.html", help="dev shell to assemble from")
    parser.add_argument("--out", default="dist/index-live.html", help="output path")
    args = parser.parse_args()

    index_path = Path(args.index)
    base_dir = index_path.parent if index_path.parent != Path("") else Path(".")
    html = index_path.read_text(encoding="utf-8")

    assembled = inline(html, base_dir)

    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(assembled, encoding="utf-8")

    remaining_local = LOCAL_CSS_RE.search(assembled) or LOCAL_JS_RE.search(assembled)
    print(f"✓ wrote {out_path} ({len(assembled):,} bytes)")
    if remaining_local:
        print("⚠ a local <link>/<script> reference survived inlining — check index.html")


if __name__ == "__main__":
    main()
