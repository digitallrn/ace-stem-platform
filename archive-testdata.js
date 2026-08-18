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
 *   1. For every test in testdata/manifest.js, walk `git log HEAD` over
 *      testdata/<testId>.js. Every committed version that differs from the
 *      WORKING-TREE version is a superseded build; any that has no archive
 *      file yet is extracted from git byte-for-byte.
 *   2. Verify EVERY archive file: filename `<id>@<version>.js`, internal
 *      registration key, testId and testVersion all agree, and the bytes
 *      match a committed blob of that test. An existing archive file is
 *      NEVER overwritten — archives are frozen the way attempts are.
 *   3. Regenerate index.js and ARCHIVE.md from the files on disk.
 *
 * WHEN TO RUN: after every export_to_platform.py run that changes a
 * testVersion, BEFORE committing — the replaced build is still at HEAD, so
 * step 1 finds it. (Running later still works: the build stays reachable in
 * history forever.) build-site.js fails the deploy if index.js and the files
 * on disk disagree, so a forgotten run surfaces as a red build, not a
 * student-facing hole.
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

const TESTDATA = "testdata";
const ARCHIVE = path.join(TESTDATA, "archive");
const INDEX_JS = path.join(ARCHIVE, "index.js");
const ARCHIVE_MD = path.join(ARCHIVE, "ARCHIVE.md");

let failures = 0;
function fail(msg){ console.error("FAIL  " + msg); failures++; }

function git(args, opts){
  return cp.execFileSync("git", args, Object.assign({ maxBuffer: 1 << 26 }, opts || {}));
}
function gitText(args){ return git(args).toString("utf8").trim(); }

function versionOf(text){
  const m = text.match(/"testVersion":\s*"([^"]+)"/);
  return m ? m[1] : null;
}

/* ---- 1. what does the manifest carry, and what has git ever carried? ---- */
const manifestSrc = fs.readFileSync(path.join(TESTDATA, "manifest.js"), "utf8");
const mm = manifestSrc.match(/window\.TEST_MANIFEST\s*=\s*(\[[\s\S]*\]);/);
if(!mm){ console.error("cannot parse testdata/manifest.js"); process.exit(1); }
const manifest = JSON.parse(mm[1]);

fs.mkdirSync(ARCHIVE, { recursive: true });

/* per test: every committed (commit, blobSha, version) triple, newest first */
const history = {};
for(const entry of manifest){
  const rel = TESTDATA + "/" + entry.testId + ".js";
  const commits = gitText(["log", "--format=%H", "HEAD", "--", rel]);
  history[entry.testId] = [];
  for(const c of commits ? commits.split("\n") : []){
    let blobSha;
    try{ blobSha = gitText(["rev-parse", c + ":" + rel]); }
    catch(e){ continue; }   // commit deleted the file
    const bytes = git(["cat-file", "blob", blobSha]);
    const ver = versionOf(bytes.toString("utf8"));
    if(ver) history[entry.testId].push({ commit: c, blobSha, ver, bytes });
  }
}

/* ---- 2. extract every superseded committed build that isn't archived ---- */
const extracted = [];
for(const entry of manifest){
  const workingTree = fs.readFileSync(path.join(TESTDATA, entry.testId + ".js"), "utf8");
  const current = versionOf(workingTree);
  if(!current){ fail(entry.testId + ".js has no readable testVersion"); continue; }
  const seen = new Set();
  for(const h of history[entry.testId]){
    if(h.ver === current || seen.has(h.ver)) continue;
    seen.add(h.ver);        // newest blob of each version wins (walk is newest-first)
    const out = path.join(ARCHIVE, entry.testId + "@" + h.ver + ".js");
    if(fs.existsSync(out)) continue;      // frozen: never overwrite
    fs.writeFileSync(out, h.bytes);
    extracted.push({ file: path.basename(out), commit: h.commit });
  }
}

/* ---- 3. verify every archive file on disk ---- */
const files = fs.readdirSync(ARCHIVE)
  .filter(f => f.endsWith(".js") && f !== "index.js").sort();
const listing = [];   // {file, id, ver, commit}
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
  const entry = manifest.find(e => e.testId === id);
  if(!entry){ fail(f + ": " + id + " is not in the manifest"); continue; }
  if((entry.testVersion || "unversioned") === ver)
    fail(f + ": " + ver + " is the CURRENT version of " + id + " — an archive must be superseded");
  /* provenance: the bytes must equal some committed blob of this test —
     newest such commit is "the commit it came from" */
  const src2 = (history[id] || []).find(h => Buffer.compare(h.bytes, bytes) === 0);
  if(!src2){ fail(f + ": bytes match NO committed build of " + id + " — archives may only come from git history"); continue; }
  listing.push({ file: f, id, ver, commit: src2.commit });
  (byId[id] = byId[id] || []).push(ver);
}

if(failures){
  console.error("\n" + failures + " failure(s) — index.js and ARCHIVE.md NOT rewritten.");
  process.exit(1);
}

/* ---- 4. regenerate index.js + ARCHIVE.md (write only on change) ---- */
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
  return `| \`${l.file}\` | \`${l.commit.slice(0, 12)}\` | ${meta[0]} | ${meta.slice(1).join("|")} |`;
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
`;

let wrote = 0;
for(const [p, content] of [[INDEX_JS, indexJs], [ARCHIVE_MD, archiveMd]]){
  const prev = fs.existsSync(p) ? fs.readFileSync(p, "utf8") : null;
  if(prev !== content){ fs.writeFileSync(p, content); wrote++; console.log("wrote " + p); }
}

console.log("archive-testdata.js: " + listing.length + " archived build(s) across "
  + ids.length + " test(s); " + extracted.length + " newly extracted"
  + (extracted.length ? " (" + extracted.map(e => e.file).join(", ") + ")" : "")
  + "; index/listing " + (wrote ? "updated" : "unchanged") + ".");
