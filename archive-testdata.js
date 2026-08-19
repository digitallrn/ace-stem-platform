#!/usr/bin/env node
/* archive-testdata.js — pin every superseded test build so a testVersion bump
 * never revokes question-level review or breaks an in-progress sitting.
 *
 * WHY THIS EXISTS
 * testdata/<testId>.js is REPLACED on every regeneration. Review Mode and
 * resume are version-keyed (ATTEMPTS-SPEC §9), so before archiving existed,
 * bumping a test's version orphaned every completed attempt sat on the old
 * build — the student's review silently stopped opening. Content is small
 * (~0.2–0.8 MB per build), so we simply keep every build ever committed:
 *
 *   testdata/archive/<testId>@<testVersion>.js   the superseded build, byte-
 *                                                identical to the committed
 *                                                file it once was
 *   testdata/archive/index.js                    window.TEST_ARCHIVE_INDEX —
 *                                                {testId: [versions]}; the
 *                                                small startup script the
 *                                                loader consults for
 *                                                availability
 *   testdata/archive/ARCHIVE.md                  human listing: file → the
 *                                                git commit it came from
 *
 * WHAT A RUN DOES (idempotent — safe to re-run any time):
 *   1. For every test in testdata/manifest.js — and every testId that has
 *      files in testdata/archive/ (covers retired tests) — walk
 *      `git log HEAD` over testdata/<testId>.js.
 *   2. Verify EVERY existing archive file: filename `<id>@<version>.js`,
 *      internal registration key, testId and testVersion all agree, and the
 *      bytes match a committed blob of that test. An existing archive file is
 *      NEVER overwritten — archives are frozen the way attempts are. A test
 *      that was retired from the manifest keeps its archives (they are inert
 *      at runtime until the id returns) — that is not an error.
 *   3. Only if everything verifies: extract any committed superseded build
 *      that has no archive file yet, then regenerate index.js and ARCHIVE.md
 *      from the files on disk. Nothing is written when verification fails.
 *
 * `node archive-testdata.js --verify` writes NOTHING and exits non-zero if
 * anything a normal run would write is missing or stale — a superseded
 * committed build with no archive file, or an out-of-date index/listing.
 * netlify.toml runs it before every deploy, so a forgotten archive run after
 * a version bump fails the build WHEN THE DEPLOY CHECKOUT CAN SEE THE
 * HISTORY (a shallow clone sees less; even depth 2 catches the common case,
 * since the replaced build sits in the immediately preceding commits). The
 * definitive step remains running this script after every export — the
 * build check is a net, not the procedure.
 *
 * WHEN TO RUN: after every export_to_platform.py run that changes a
 * testVersion, BEFORE committing — the replaced build is still at HEAD, so
 * step 1 finds it. Running later still works: the build stays reachable in
 * history forever, and re-running heals a missed archive retroactively.
 *
 * Builds that predate the per-test library (the single-file test-data.js era,
 * before commit 15f0ad0 / testVersion 2026-08-01-c) are deliberately NOT
 * archived: they registered a different global (window.TEST_DATA) under a
 * different architecture, and no production attempt on this site references
 * them. If one ever surfaces, the app shows its honest "earlier version isn't
 * available" state rather than guessing.
 */
"use strict";
const fs = require("fs");
const path = require("path");
const cp = require("child_process");

const VERIFY = process.argv.indexOf("--verify") !== -1;
const TESTDATA = "testdata";
const ARCHIVE = path.join(TESTDATA, "archive");
const INDEX_JS = path.join(ARCHIVE, "index.js");
const ARCHIVE_MD = path.join(ARCHIVE, "ARCHIVE.md");

let failures = 0;
function fail(msg){ console.error("FAIL  " + msg); failures++; }
function bail(){
  console.error("\n" + failures + " failure(s) — nothing was written."
    + (VERIFY ? "" : " Fix the cause and re-run."));
  process.exit(1);
}

function git(args, opts){
  // stderr piped, not inherited: an expected miss (rev-parse on a commit that
  // deleted the file — routine for retired tests) is handled by the caller's
  // catch and must not spray "fatal:" noise over a run that is succeeding
  return cp.execFileSync("git", args,
    Object.assign({ maxBuffer: 1 << 26, stdio: ["ignore", "pipe", "pipe"] }, opts || {}));
}
function gitText(args){ return git(args).toString("utf8").trim(); }

function versionOf(text){
  const m = text.match(/"testVersion":\s*"([^"]+)"/);
  return m ? m[1] : null;
}
function stripCr(buf){ return Buffer.from(buf.toString("latin1").replace(/\r\n/g, "\n"), "latin1"); }

/* ---- A. what exists: manifest, archive files, git history ---- */
const manifestSrc = fs.readFileSync(path.join(TESTDATA, "manifest.js"), "utf8");
const mm = manifestSrc.match(/window\.TEST_MANIFEST\s*=\s*(\[[\s\S]*\]);/);
if(!mm){ console.error("cannot parse testdata/manifest.js"); process.exit(1); }
const manifest = JSON.parse(mm[1]);

fs.mkdirSync(ARCHIVE, { recursive: true });
const files = fs.readdirSync(ARCHIVE)
  .filter(f => f.endsWith(".js") && f !== "index.js").sort();

/* history over the union of manifest ids and archived-file ids, so archives
   of a RETIRED test (file and manifest entry deleted) still verify against
   the history that produced them instead of wedging the whole script */
const allIds = new Set(manifest.map(e => e.testId));
for(const f of files){
  const m = f.match(/^(.+)@(.+)\.js$/);
  if(m) allIds.add(m[1]);
}
const history = {};   // id -> [{commit, blobSha, ver, bytes}] newest first
for(const id of allIds){
  const rel = TESTDATA + "/" + id + ".js";
  const commits = gitText(["log", "--format=%H", "HEAD", "--", rel]);
  history[id] = [];
  for(const c of commits ? commits.split("\n") : []){
    let blobSha;
    try{ blobSha = gitText(["rev-parse", c + ":" + rel]); }
    catch(e){ continue; }   // commit deleted the file
    const bytes = git(["cat-file", "blob", blobSha]);
    const ver = versionOf(bytes.toString("utf8"));
    if(ver) history[id].push({ commit: c, blobSha, ver, bytes });
  }
}

/* current version per manifest test, from the WORKING-TREE file — with the
   manifest cross-checked so a half-done state (file exported, manifest not,
   or vice versa) fails HERE with its real cause, not later as a bogus
   complaint about a correct archive */
const currentOf = {};
for(const entry of manifest){
  const p = path.join(TESTDATA, entry.testId + ".js");
  let src;
  try{ src = fs.readFileSync(p, "utf8"); }
  catch(e){
    fail(entry.testId + ": manifest lists it but " + p + " is missing or unreadable — "
      + "finish the export (or remove the entry) and re-run.");
    continue;
  }
  const ver = versionOf(src);
  if(!ver){ fail(entry.testId + ".js has no readable testVersion"); continue; }
  if((entry.testVersion || null) !== ver){
    fail(entry.testId + ": manifest says testVersion \"" + entry.testVersion
      + "\" but testdata/" + entry.testId + ".js carries \"" + ver + "\" — "
      + "the export writes both together; commit or regenerate the pair, then re-run.");
    continue;
  }
  currentOf[entry.testId] = ver;
}

/* ---- B. verify every existing archive file (nothing written yet) ---- */
const listing = [];   // {file, id, ver, commit, retired}
const byId = {};      // id -> [versions]
for(const f of files){
  const m = f.match(/^(.+)@(.+)\.js$/);
  if(!m){ fail(f + ": name is not <testId>@<testVersion>.js"); continue; }
  const [, id, ver] = m;
  const bytes = fs.readFileSync(path.join(ARCHIVE, f));
  const src = bytes.toString("utf8");
  const reg = src.match(/window\.__TESTDATA__\[\"([^\"]+)\"\]\s*=\s*(\{[\s\S]*\});/);
  if(!reg){ fail(f + ": does not register into window.__TESTDATA__"); continue; }
  let t;
  try{ t = JSON.parse(reg[2]); }
  catch(e){ fail(f + ": registered object is not valid JSON: " + e.message); continue; }
  if(reg[1] !== id) fail(f + ": registers \"" + reg[1] + "\", filename says \"" + id + "\"");
  if(t.testId !== id) fail(f + ": internal testId \"" + t.testId + "\" != filename \"" + id + "\"");
  if(t.testVersion !== ver) fail(f + ": internal testVersion \"" + t.testVersion + "\" != filename \"" + ver + "\"");
  if(!Array.isArray(t.modules) || !t.modules.length) fail(f + ": no modules");
  const retired = !(id in currentOf);
  if(!retired && currentOf[id] === ver)
    fail(f + ": " + ver + " is the CURRENT version of " + id + " — an archive must be superseded");
  /* provenance: the bytes must equal some committed blob of this test —
     newest such commit is "the commit it came from" */
  const src2 = (history[id] || []).find(h => Buffer.compare(h.bytes, bytes) === 0);
  if(!src2){
    const crlfTwin = (history[id] || []).find(h => Buffer.compare(stripCr(h.bytes), stripCr(bytes)) === 0);
    fail(f + ": bytes match NO committed build of " + id + " — archives may only come from git history."
      + (crlfTwin
        ? " (The difference is ONLY line endings: this checkout smudged the file to CRLF —"
          + " core.autocrlf without the repo's .gitattributes. Re-materialize the file, e.g."
          + " `git checkout -- testdata/archive/`, and re-run.)"
        : ""));
    continue;
  }
  listing.push({ file: f, id, ver, commit: src2.commit, retired });
  (byId[id] = byId[id] || []).push(ver);
}

/* ---- C. what a complete archive would contain (still nothing written) ---- */
const planned = [];   // {id, ver, bytes, commit}
for(const entry of manifest){
  const current = currentOf[entry.testId];
  if(!current) continue;               // already failed above with a clear cause
  const seen = new Set((byId[entry.testId] || []));
  for(const h of history[entry.testId]){
    if(h.ver === current || seen.has(h.ver)) continue;
    seen.add(h.ver);        // newest blob of each version wins (walk is newest-first)
    planned.push({ id: entry.testId, ver: h.ver, bytes: h.bytes, commit: h.commit });
  }
}
if(VERIFY && planned.length){
  planned.forEach(p => fail(p.id + "@" + p.ver + " is a superseded committed build with NO archive file — "
    + "run `node archive-testdata.js` and commit its output."));
}

if(failures) bail();

/* ---- D. extract (normal mode only — everything above verified clean) ---- */
if(!VERIFY){
  for(const p of planned){
    const out = path.join(ARCHIVE, p.id + "@" + p.ver + ".js");
    fs.writeFileSync(out, p.bytes);
    listing.push({ file: path.basename(out), id: p.id, ver: p.ver, commit: p.commit, retired: false });
    (byId[p.id] = byId[p.id] || []).push(p.ver);
  }
}

/* ---- E. regenerate index.js + ARCHIVE.md (verify mode: compare only) ---- */
listing.sort((a, b) => a.file < b.file ? -1 : a.file > b.file ? 1 : 0);
const ids = Object.keys(byId).sort();
ids.forEach(id => byId[id].sort());
const indexJs =
`/* testdata/archive/index.js — which superseded builds are archived.
   Generated by archive-testdata.js — do not hand-edit. Loaded at startup
   (it is tiny); the archived builds themselves lazy-load exactly like
   current test files, only when a pinned attempt opens. */
window.TEST_ARCHIVE_INDEX = {
${ids.map(id => ` "${id}": [${byId[id].map(v => `"${v}"`).join(", ")}]`).join(",\n")}
};
`;

const mdRows = listing.map(l => {
  const meta = gitText(["log", "-1", "--format=%ad|%s", "--date=short", l.commit]).split("|");
  return `| \`${l.file}\` | \`${l.commit.slice(0, 12)}\` | ${meta[0]} | ${meta.slice(1).join("|")}${l.retired ? " *(test since retired from the manifest — inert until the id returns)*" : ""} |`;
});
const archiveMd =
`# testdata/archive — every superseded test build, pinned

Generated by \`archive-testdata.js\` — do not hand-edit. Each file is
byte-identical to the committed \`testdata/<testId>.js\` it once was; the
commit column is the newest commit at which that exact content was current.
Review Mode and resume load these so an attempt always opens on the exact
content it was sat on (ATTEMPTS-SPEC §9).

| archived build | source commit | committed | commit subject |
| --- | --- | --- | --- |
${mdRows.join("\n")}

Builds that predate the per-test library (the single-file \`test-data.js\`
era, before commit \`15f0ad05d3d5\` / testVersion \`2026-08-01-c\`) are
deliberately not archived: they registered a different global
(\`window.TEST_DATA\`) under a different architecture, and no production
attempt on this site references them. Such an attempt would show the app's
honest "earlier version isn't available" state.

Renaming a \`testId\` does NOT rename its archives: records resolve through
\`legacyIds\`, but the archive index is keyed by filename id, so archived
builds of a renamed test stop being offered until the archive files are
renamed to match (a manual step of any rename, done alongside \`legacyIds\`).
`;

let wrote = 0;
for(const [p, content] of [[INDEX_JS, indexJs], [ARCHIVE_MD, archiveMd]]){
  const prev = fs.existsSync(p) ? fs.readFileSync(p, "utf8") : null;
  if(prev === content) continue;
  if(VERIFY){
    fail(p + " is stale — run `node archive-testdata.js` and commit its output.");
    continue;
  }
  fs.writeFileSync(p, content);
  wrote++;
  console.log("wrote " + p);
}
if(failures) bail();

console.log("archive-testdata.js" + (VERIFY ? " --verify" : "") + ": "
  + listing.length + " archived build(s) across " + ids.length + " test(s); "
  + (VERIFY
    ? "archive complete and index/listing current."
    : planned.length + " newly extracted"
      + (planned.length ? " (" + planned.map(p => p.id + "@" + p.ver + ".js").join(", ") + ")" : "")
      + "; index/listing " + (wrote ? "updated" : "unchanged") + "."));
