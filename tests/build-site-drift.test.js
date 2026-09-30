/* tests/build-site-drift.test.js — run: node tests/build-site-drift.test.js (repo root)

   build-site.js compares the canonical-id index (testdata/dedup-index.js)
   with both manifests and WARNS in the deploy log when the index is behind a
   form or a bank. From 2026-09-07 until 2026-09-30 the bank half never ran:
   its pattern had lost its backslashes (`window.BANK_MANIFESTs*=s*…`),
   matched nothing, and a silent fallback read that as "no banks".

   This runs the REAL build the way netlify.toml does (gen-config.js, then
   build-site.js — archive-testdata.js --verify is left out: it needs the git
   history, and it checks the archive, not this) inside a throwaway copy of
   the checkout, never touching the repo's own _site/ or config.js:

     1. the unmodified tree builds and the drift check stays QUIET;
     2. a planted bank-version drift (bank-manifest.js) is named;
     3. a bank the index doesn't list is named;
     4. a planted form-version drift (manifest.js) is still named;
     5. a manifest the check can no longer parse is a WARNING naming the
        file, never a silent "nothing to compare";
   and every case still builds (drift is a warning by design, not a red build).

   To watch it fail on the broken check:
     git show f64c512:build-site.js > <scratch>/build-site-pre.js
     BUILD_SITE_SRC=<scratch>/build-site-pre.js node tests/build-site-drift.test.js */
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("vm");
const { spawnSync } = require("child_process");

const REPO = path.resolve(__dirname, "..");
const BUILD_SRC = path.resolve(process.env.BUILD_SITE_SRC || path.join(REPO, "build-site.js"));

let pass = 0, fail = 0;
const failures = [];
function check(ok, label, detail){
  if(ok){ pass++; console.log("PASS | " + label); }
  else { fail++; failures.push(label + (detail ? " — " + detail : ""));
         console.log("FAIL | " + label + (detail ? " — " + detail : "")); }
}

/* A mistyped BUILD_SITE_SRC must fail before ~40 MB is copied anywhere. */
if(!fs.existsSync(BUILD_SRC)){
  console.log("FAIL | BUILD_SITE_SRC not found: " + BUILD_SRC + " — nothing was copied");
  process.exit(1);
}
/* ---- a throwaway checkout: every top-level file plus testdata/, never
   config.js (gen-config.js writes it, as on Netlify). Created and filled
   INSIDE the try below, whose finally removes it — a setup that throws
   halfway must not leave a copy of testdata/ in %TEMP%; Ctrl-C too. ---- */
let tmp = null;
const cleanup = () => { if(tmp){ try{ fs.rmSync(tmp, { recursive: true, force: true }); }catch(e){} tmp = null; } };
process.on("SIGINT", () => { cleanup(); process.exit(130); });

let BANKS, TESTS, INDEX;
function setup(){
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "build-site-drift-"));
  fs.readdirSync(REPO).forEach(f => {
    const full = path.join(REPO, f);
    if(f === "config.js" || !fs.statSync(full).isFile()) return;
    fs.copyFileSync(full, path.join(tmp, f));
  });
  fs.cpSync(path.join(REPO, "testdata"), path.join(tmp, "testdata"), { recursive: true });
  fs.copyFileSync(BUILD_SRC, path.join(tmp, "build-site.js"));
  BANKS = load("bank-manifest.js", "BANK_MANIFEST");
  TESTS = load("manifest.js", "TEST_MANIFEST");
  INDEX = load("dedup-index.js", "DEDUP_INDEX");
}
function load(file, global){
  const c = { window: {} };
  vm.createContext(c);
  vm.runInContext(fs.readFileSync(path.join(tmp, "testdata", file), "utf8"), c);
  return c.window[global];
}
/* A failure says what was MISSING — in the regression this exists for, no
   WARNING line is printed at all — and shows the build's tail as context. */
function why(r){
  return "exit " + r.status + "; " + (r.warn ? "WARNING lines:\n" + r.warn : "NO drift WARNING line was printed") +
    (r.status !== 0 || !r.warn ? "\n--- build output tail ---\n" + r.out.slice(-400) : "");
}

const ENV = Object.assign({}, process.env, {
  SUPABASE_URL: "https://drifttestproject.supabase.co",
  SUPABASE_PUBLISHABLE_KEY: "sb_publishable_drift-test-not-a-real-key"
});
function build(){
  const gen = spawnSync(process.execPath, ["gen-config.js"], { cwd: tmp, env: ENV, encoding: "utf8" });
  if(gen.status !== 0) return { status: gen.status, out: gen.stdout + gen.stderr, warn: "" };
  const r = spawnSync(process.execPath, ["build-site.js"], { cwd: tmp, env: ENV, encoding: "utf8" });
  const out = (r.stdout || "") + (r.stderr || "");
  return { status: r.status, out: out, warn: out.split(/\r?\n/).filter(l => /WARNING/.test(l) || /^\s+The dashboard will show/.test(l)).join("\n") };
}
/* plant: rewrite one file of the copy, build, restore the exact bytes */
function planted(file, edit){
  const p = path.join(tmp, "testdata", file);
  const orig = fs.readFileSync(p);
  const next = edit(orig.toString("utf8"));
  if(next === orig.toString("utf8")) throw new Error("the plant changed nothing in " + file);
  fs.writeFileSync(p, next);
  try{ return build(); } finally { fs.writeFileSync(p, orig); }
}
function run(label, fn){
  try{ fn(); }catch(e){ check(false, label + " — case could not run: " + (e && e.stack || e)); }
}

try{
  setup();
  run("clean", () => {
    check(Array.isArray(BANKS) && BANKS.length >= 1 && Array.isArray(TESTS) && TESTS.length >= 1 && INDEX && INDEX.reference,
      "the copy holds both manifests and the index (" + TESTS.length + " tests, " + BANKS.length + " banks)");
    const r = build();
    check(r.status === 0 && /publish directory _site\/ contains/.test(r.out), "the unmodified tree builds", r.out.slice(-400));
    check(r.warn === "", "the unmodified tree: the drift check is QUIET (index, manifest and bank manifest agree)", r.warn);
  });

  run("bank-version", () => {
    const b = BANKS[BANKS.length - 1];
    const r = planted("bank-manifest.js", s => s.replace(
      new RegExp('("bankId"\\s*:\\s*"' + b.bankId + '"[\\s\\S]*?"bankVersion"\\s*:\\s*")[^"]+(")'), "$1sha-planted0000$2"));
    const want = b.bankId + " (index " + INDEX.reference.banks.find(x => x.bankId === b.bankId).bankVersion + ", bank manifest sha-planted0000)";
    check(r.status === 0 && r.warn.indexOf("dedup-index.js is behind the manifest") !== -1 && r.warn.indexOf(want) !== -1,
      "a planted bank-version drift is named: " + want, why(r));
  });

  run("bank-missing", () => {
    const b = BANKS[0];
    const r = planted("dedup-index.js", s => s.replace(new RegExp('"bankId"\\s*:\\s*"' + b.bankId + '"'), '"bankId": "bank-not-this-one"'));
    check(r.status === 0 && r.warn.indexOf(b.bankId + " (bank not in the index)") !== -1,
      "a bank the index doesn't list is named: " + b.bankId + " (bank not in the index)", why(r));
  });

  run("form-version", () => {
    const t = TESTS[0];
    const r = planted("manifest.js", s => s.replace(
      new RegExp('("testId"\\s*:\\s*"' + t.testId + '"[\\s\\S]*?"testVersion"\\s*:\\s*")[^"]+(")'), "$12099-01-01-z$2"));
    check(r.status === 0 && r.warn.indexOf(t.testId + " (index ") !== -1 && r.warn.indexOf(", manifest 2099-01-01-z)") !== -1,
      "a planted form-version drift is still named (" + t.testId + ")", why(r));
  });

  run("unparseable", () => {
    const r = planted("bank-manifest.js", s => s.replace(/window\.BANK_MANIFEST\s*=/, "window.BANK_MANIFEST_RENAMED ="));
    check(r.status === 0 && /could not compare testdata\/dedup-index\.js/.test(r.warn) && /bank-manifest\.js does not match/.test(r.warn),
      "a bank manifest the check can't parse is a WARNING naming the file, not a silent 'no banks'", why(r));
  });
}finally{
  cleanup();
}

console.log(`\n${fail ? "FAIL" : "ALL PASS"} — ${pass} passed, ${fail} failed`);
if(failures.length){ console.log("Failures:"); failures.forEach(f => console.log("  - " + f)); }
process.exit(fail ? 1 : 0);
