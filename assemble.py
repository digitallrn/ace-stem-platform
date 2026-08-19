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
import sys
import argparse
from pathlib import Path

# Windows consoles default to cp1252, which cannot encode the ✓/⚠ in the status
# lines below — so a SUCCESSFUL build died at its own success message and exited
# nonzero, which reads as a failed build. Force UTF-8 on the streams instead.
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8")
    except (AttributeError, ValueError):
        pass

LOCAL_CSS_RE = re.compile(r'<link rel="stylesheet" href="(?!https?://)([^"]+)">')
LOCAL_JS_RE = re.compile(r'<script src="(?!https?://)([^"]+)"></script>')

# Never inline these, even if index.html references them plainly. config.js
# holds the Supabase anon key for a static deployment; dist/index-live.html is
# the single file David hands around and the artifact build (which uses shared
# storage and needs no remote config at all), so keys must not end up in it.
# The tag in index.html also carries data-no-inline, which LOCAL_JS_RE already
# skips — this list is the explicit, self-documenting guard.
SKIP_INLINE = {"config.js"}

# The archive index must not ride into the single file AS-IS: archived builds
# themselves are never inlined (only manifest-listed current tests are), and a
# single self-contained file has no origin to fetch them from — so an inlined
# real index would advertise builds the artifact can never serve, turning the
# designed honest "unavailable" state into an endless connection-blaming
# Retry. Inline an EMPTY index instead: every superseded-version attempt gets
# the same honest pre-archive labels, and the artifact still never fetches.
REPLACE_INLINE = {
    "testdata/archive/index.js":
        "<script>\n/* single-file build: archived builds cannot be fetched "
        "(no origin), so the\n   archive index is deliberately empty — see "
        "assemble.py. Superseded-version\n   attempts show their honest "
        "\"unavailable\" state here. */\nwindow.TEST_ARCHIVE_INDEX = {};\n"
        "</script>"
}

# Anything matching these in the output means a real secret VALUE leaked into
# the build. Deliberately matches values, not identifiers: attempts.js legitimately
# mentions SUPABASE_URL / SUPABASE_ANON_KEY when reading window.ACESTEM_CONFIG.
#
# Covers both Supabase key generations:
#   legacy  — JWT-shaped anon / service_role keys (eyJ...)
#   current — sb_publishable_... (public by design) and sb_secret_... (never
#             belongs anywhere near this repo, the build, or a browser)
SECRET_PATTERNS = (
    (re.compile(r"eyJ[A-Za-z0-9_-]{20,}\."), "a JWT-shaped key (legacy anon/service_role)"),
    (re.compile(r"sb_secret_[A-Za-z0-9_-]{4,}"), "a Supabase SECRET key — never ship this"),
    (re.compile(r"sb_publishable_[A-Za-z0-9_-]{4,}"), "a Supabase publishable key"),
    (re.compile(r"https://(?!YOUR-)[a-z0-9-]+\.supabase\.co"), "a real Supabase project URL"),
    (re.compile(r"service_role"), "the service_role key name"),
)


MANIFEST_REL = "testdata/manifest.js"


def inlined_tests(base_dir):
    """Every test the manifest lists, as one <script>.

    Test content is normally fetched per test at runtime, which a single
    self-contained file cannot do — the published artifact has no origin, and
    file:// blocks the fetch. The loader checks memory before cache before
    network, so with these present the preview and the artifact never fetch.
    """
    testdata_dir = base_dir / "testdata"
    manifest = testdata_dir / MANIFEST_REL.split("/")[-1]
    if not manifest.exists():
        raise FileNotFoundError("assemble.py: testdata/manifest.js is missing")
    ids = re.findall(r'"testId"\s*:\s*"([^"]+)"', manifest.read_text(encoding="utf-8"))
    if not ids:
        raise ValueError("assemble.py: testdata/manifest.js lists no tests")
    blobs = []
    for tid in ids:
        f = testdata_dir / (tid + ".js")
        if not f.exists():
            raise FileNotFoundError(
                f"assemble.py: manifest lists {tid} but testdata/{tid}.js is missing")
        blobs.append(f.read_text(encoding="utf-8"))
    return ("<script>\n/* inlined test content — see assemble.py. Placed before "
            "app.js on purpose: app.js boots during parse. */\n"
            + "\n".join(blobs) + "\n</script>")


def inline(html, base_dir):
    def css_sub(m):
        path = base_dir / m.group(1)
        if not path.exists():
            raise FileNotFoundError(f"assemble.py: missing {path} (referenced in index.html)")
        return "<style>\n" + path.read_text(encoding="utf-8") + "\n</style>"

    def js_sub(m):
        name = m.group(1)
        if name in SKIP_INLINE:
            return m.group(0)            # leave the tag; do not read the file
        if name in REPLACE_INLINE:
            return REPLACE_INLINE[name]  # substitute, never read the file
        path = base_dir / name
        if not path.exists():
            raise FileNotFoundError(f"assemble.py: missing {path} (referenced in index.html)")
        out = "<script>\n" + path.read_text(encoding="utf-8") + "\n</script>"
        # Test content rides immediately behind the manifest, which is the first
        # script in the document. It MUST land before app.js: app.js ends in a
        # boot IIFE that runs during parse, and a crash-resume there reads the
        # test content — appending at </body> would leave it undefined and send
        # a resuming student to the download-failed screen in the one build that
        # has no origin to download from.
        if name == MANIFEST_REL:
            out += "\n" + inlined_tests(base_dir)
        return out

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

    leaked = [why for rx, why in SECRET_PATTERNS if rx.search(assembled)]
    if leaked:
        out_path.unlink(missing_ok=True)
        raise SystemExit(
            "assemble.py: refusing to write — the build contains "
            + ", ".join(leaked)
            + ". Supabase config must never be inlined into dist/."
        )

    out_path.write_text(assembled, encoding="utf-8")

    remaining = LOCAL_CSS_RE.search(assembled) or LOCAL_JS_RE.search(assembled)
    print(f"✓ wrote {out_path} ({len(assembled):,} bytes)")
    if remaining:
        print("⚠ a local <link>/<script> reference survived inlining — check index.html")


if __name__ == "__main__":
    main()
