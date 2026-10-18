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
   and every drift case still builds (drift is a warning by design, not a
   red build). Since 2026-10-18 the same harness also proves the build's
   IMAGE GUARD (app.js imageSourceOk over every shipped image): the clean
   tree reports it ran and passed; a figure, an image choice and a bank
   figure whose PNG bytes are relabelled jpeg each FAIL the build naming the
   item; the same plant in an archived build is a WARNING naming the file.
   To watch the guard cases fail without it, point BUILD_SITE_SRC at
   `git show 4416e5d:build-site.js` (before the guard).

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
  /* the build's image guard (2026-10-18) takes imageSourceOk out of app.js
     with the suites' own extractor; Netlify's checkout has tests/, so the
     copy carries that one file of it */
  fs.mkdirSync(path.join(tmp, "tests"));
  fs.copyFileSync(path.join(REPO, "tests", "extract-helper.js"), path.join(tmp, "tests", "extract-helper.js"));
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
/* plant: rewrite one file of the copy, build, restore the exact bytes
   (planted: a testdata/ file; plantedAt: any path relative to the copy) */
function planted(file, edit){ return plantedAt(path.join("testdata", file), edit); }
function plantedAt(rel, edit){
  const p = path.join(tmp, rel);
  const orig = fs.readFileSync(p);
  const next = edit(orig.toString("utf8"));
  if(next === orig.toString("utf8")) throw new Error("the plant changed nothing in " + rel);
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
    /* floors at the 2026-10-18 counts, so a gate that quietly skips one kind
       of image (every SVG, say) or one lane cannot pass on the total (review
       2026-10-18): each type's TOTAL across the lanes (current and bank:
       png 212, jpeg 12, svg+xml 41; archived: 226, 36, 81) only grows,
       because an archived build keeps a replaced figure; and every type must
       appear in BOTH lanes. Not a per-lane floor: a redraw (png -> svg) of a
       current figure legitimately moves one between types. */
    const g = /image guard — (\d+) figures and (\d+) image choices checked/.exec(r.out);
    const t = /figures by type: current and bank \(png (\d+), jpeg (\d+), svg\+xml (\d+)\); archived \(png (\d+), jpeg (\d+), svg\+xml (\d+)\)/.exec(r.out);
    /* and the ARCHIVED lane floored per type on its own (it only grows), so
       a gate that swapped the lanes' labels shows (review 2026-10-18) */
    const FLOOR = { figures: 608, choices: 8, byType: [438, 48, 122], archived: [226, 36, 81] };
    check(!!g && +g[1] >= FLOOR.figures && +g[2] >= FLOOR.choices && /every current and bank image passes/.test(r.out) &&
          !!t && [0, 1, 2].every(i => +t[i + 1] + +t[i + 4] >= FLOOR.byType[i] && +t[i + 1] > 0 && +t[i + 4] >= FLOOR.archived[i]),
      "the unmodified tree: the image guard ran over every shipped image, every type in every lane, and passed (" +
      (g ? g[1] + " figures, " + g[2] + " image choices" : "no guard line") + (t ? "; " + t[0] : "; no per-type line") + ")", r.out.slice(-600));
  });

  /* THE IMAGE GUARD (2026-10-18): an image the renderer would refuse is a
     red build naming the item in a current build or a bank, and a WARNING
     naming it in an archived build (which cannot be re-exported). Each plant
     passes the GRAMMAR, so only the bytes half can refuse it: PNG bytes
     relabelled jpeg. */
  const relabel = s => s.replace(/("(?:figure|image)":\s*"data:image\/)png(;base64,)/, "$1jpeg$2");
  run("image-figure", () => {
    const t = TESTS.find(x => /"figure":\s*"data:image\/png;base64,/.test(fs.readFileSync(path.join(tmp, "testdata", x.testId + ".js"), "utf8")));
    const r = planted(t.testId + ".js", relabel);
    check(r.status === 1 && /Images the renderer would refuse/.test(r.out) && r.out.indexOf("testdata/" + t.testId + ".js ") !== -1 && /figure \(data:image\/jpeg;base64,/.test(r.out),
      "a current build's figure whose PNG bytes are labelled jpeg FAILS the build, naming " + t.testId, why(r));
  });
  run("image-choice", () => {
    const t = TESTS.find(x => /"image":\s*"data:image\/png;base64,/.test(fs.readFileSync(path.join(tmp, "testdata", x.testId + ".js"), "utf8")));
    const r = planted(t.testId + ".js", s => s.replace(/("image":\s*"data:image\/)png(;base64,)/, "$1jpeg$2"));
    check(r.status === 1 && r.out.indexOf("testdata/" + t.testId + ".js ") !== -1 && /choice A \(data:image\/jpeg;base64,/.test(r.out),
      "a shipped image CHOICE relabelled the same way FAILS the build, naming " + t.testId + " and the choice", why(r));
  });
  run("image-bank", () => {
    const b = BANKS.find(x => /"figure":\s*"data:image\/png;base64,/.test(fs.readFileSync(path.join(tmp, "testdata", x.bankId + ".js"), "utf8")));
    const r = planted(b.bankId + ".js", relabel);
    check(r.status === 1 && r.out.indexOf("testdata/" + b.bankId + ".js ") !== -1,
      "a bank figure relabelled the same way FAILS the build, naming " + b.bankId, why(r));
  });
  /* each of the other ways an image can be refused, in a current build: an
     SVG whose root is in no namespace (the converter, checking figures
     against the grammar only, would ship it), a figure that is not a data:
     URI at all, and an image choice with no image */
  const fileWith = re => TESTS.find(x => re.test(fs.readFileSync(path.join(tmp, "testdata", x.testId + ".js"), "utf8")));
  run("image-svg-no-namespace", () => {
    const t = fileWith(/"figure":\s*"data:image\/svg\+xml;base64,/);
    const r = planted(t.testId + ".js", s => s.replace(/("figure":\s*"data:image\/svg\+xml;base64,)[A-Za-z0-9+\/=]+/,
      (m, p) => p + Buffer.from('<svg width="10" height="10"><rect width="10" height="10"/></svg>').toString("base64")));
    check(r.status === 1 && r.out.indexOf("testdata/" + t.testId + ".js ") !== -1 && /figure \(data:image\/svg\+xml;base64,/.test(r.out),
      "a current build's SVG figure whose root is in no namespace FAILS the build, naming " + t.testId, why(r));
  });
  run("image-not-data", () => {
    const t = fileWith(/"figure":\s*"data:image\/png;base64,/);
    const r = planted(t.testId + ".js", s => s.replace(/"figure":\s*"data:image\/png;base64,/, '"figure": "figures/q12.png", "figureWas": "'));
    check(r.status === 1 && r.out.indexOf("testdata/" + t.testId + ".js ") !== -1 && /figure \(figures\/q12\.png/.test(r.out),
      "a figure that is a path, not a data: URI, FAILS the build, naming " + t.testId, why(r));
  });
  run("image-choice-no-image", () => {
    const t = fileWith(/\{"image":\s*"data:image\/png;base64,/);
    const r = planted(t.testId + ".js", s => s.replace(/\{"image":(\s*"data:image\/png;base64,)/, '{"src":$1'));
    check(r.status === 1 && r.out.indexOf("testdata/" + t.testId + ".js ") !== -1 && /choice A \(undefined\)/.test(r.out),
      "an image choice with no image FAILS the build (the renderer would show its placeholder), naming " + t.testId, why(r));
  });
  /* the self-check: a behaviour-preserving refactor of app.js that adds a
     const beside imageSourceOk breaks build-site.js's hand-listed
     extraction. The build must say THAT, not blame the test data. */
  run("image-guard-extraction", () => {
    const r = plantedAt("app.js", s => s.replace('return v === "http://www.w3.org/2000/svg";', "return v === SVG_NS_PLANTED;")
      .replace("  function imageSourceOk(s){", '  const SVG_NS_PLANTED = "http://www.w3.org/2000/svg";\n  function imageSourceOk(s){'));
    check(r.status === 1 && /image guard taken from app\.js is not working here/.test(r.out) && /refuses a known-good svg\+xml/.test(r.out) &&
          !/Images the renderer would refuse/.test(r.out),
      "a const added beside imageSourceOk fails the build as an EXTRACTION problem, not as refused test data", why(r));
  });
  /* each leg of the self-check on its own (review 2026-10-18): a raster-only
     refactor, a helper only choiceImageSrc calls (it THROWS in the extracted
     scope), and a guard that accepts everything */
  const extractionFails = (r, re) => r.status === 1 && re.test(r.out) && /build-site\.js's extraction, not the test data/.test(r.out) && !/Images the renderer would refuse/.test(r.out);
  run("image-guard-png-const", () => {
    const r = plantedAt("app.js", s => s.replace(String.raw`return b.slice(0, 8) === "\x89PNG\r\n\x1A\n";`, "return b.slice(0, 8) === PNG_SIG_PLANTED;")
      .replace("  function imageSourceOk(s){", '  const PNG_SIG_PLANTED = "\\x89PNG\\r\\n\\x1A\\n";\n  function imageSourceOk(s){'));
    check(extractionFails(r, /refuses a known-good png/), "a PNG-only const beside imageSourceOk fails as an extraction problem naming png", why(r));
  });
  run("image-guard-jpeg-const", () => {
    const r = plantedAt("app.js", s => s.replace(String.raw`return b.slice(0, 3) === "\xFF\xD8\xFF";`, "return b.slice(0, 3) === JPEG_SIG_PLANTED;")
      .replace("  function imageSourceOk(s){", '  const JPEG_SIG_PLANTED = "\\xFF\\xD8\\xFF";\n  function imageSourceOk(s){'));
    check(extractionFails(r, /refuses a known-good jpeg/), "a JPEG-only const beside imageSourceOk fails as an extraction problem naming jpeg", why(r));
  });
  run("image-guard-choice-helper", () => {
    const r = plantedAt("app.js", s => s.replace('return (isImageChoice(c) && typeof c.image === "string" && imageSourceOk(c.image)) ? c.image : null;',
        "return choiceOkPlanted(c) ? c.image : null;")
      .replace("  function isImageChoice(c){", '  function choiceOkPlanted(c){ return isImageChoice(c) && typeof c.image === "string" && imageSourceOk(c.image); }\n  function isImageChoice(c){'));
    check(extractionFails(r, /threw \(choiceOkPlanted is not defined\)/), "a helper only choiceImageSrc calls fails as an extraction problem (it throws), not a crash", why(r));
  });
  run("image-guard-choice-only-refusal", () => {
    /* choiceImageSrc alone refuses in the extracted scope, without throwing
       (a const it reads through typeof): only the self-check's CHOICE leg
       can name this as extraction */
    const r = plantedAt("app.js", s => s.replace('return (isImageChoice(c) && typeof c.image === "string" && imageSourceOk(c.image)) ? c.image : null;',
        'return (typeof CHOICE_OK_PLANTED !== "undefined" && isImageChoice(c) && typeof c.image === "string" && imageSourceOk(c.image)) ? c.image : null;')
      .replace("  function isImageChoice(c){", "  const CHOICE_OK_PLANTED = true;\n  function isImageChoice(c){"));
    check(extractionFails(r, /refuses a known-good png/), "a choice-only refusal in the extracted scope fails as an extraction problem (the self-check judges both sites)", why(r));
  });
  /* the mirrors (final review, 2026-10-18): the figure site alone refusing,
     and each site alone ACCEPTING the known-bad image (it returns its input
     unguarded in the extracted scope). Before these, a self-check narrowed
     to either single site stayed green. */
  const FIG_LINE = 'return (q && typeof q.figure === "string" && imageSourceOk(q.figure)) ? q.figure : null;';
  const CHO_LINE = 'return (isImageChoice(c) && typeof c.image === "string" && imageSourceOk(c.image)) ? c.image : null;';
  run("image-guard-figure-only-refusal", () => {
    const r = plantedAt("app.js", s => s.replace(FIG_LINE,
        'return (typeof FIG_OK_PLANTED !== "undefined" && q && typeof q.figure === "string" && imageSourceOk(q.figure)) ? q.figure : null;')
      .replace("  function figureSrc(q){", "  const FIG_OK_PLANTED = true;\n  function figureSrc(q){"));
    check(extractionFails(r, /refuses a known-good png/), "a figure-only refusal in the extracted scope fails as an extraction problem (the goods are judged at the figure site too)", why(r));
  });
  run("image-guard-figure-accepts-bad", () => {
    const r = plantedAt("app.js", s => s.replace(FIG_LINE,
        'return (q && typeof q.figure === "string" && (typeof FIG_GUARD_PLANTED === "undefined" || imageSourceOk(q.figure))) ? q.figure : null;')
      .replace("  function figureSrc(q){", "  const FIG_GUARD_PLANTED = true;\n  function figureSrc(q){"));
    check(extractionFails(r, /accepts PNG bytes labelled jpeg/), "the figure site alone accepting the known-bad image fails the self-check", why(r));
  });
  run("image-guard-choice-accepts-bad", () => {
    const r = plantedAt("app.js", s => s.replace(CHO_LINE,
        'return (isImageChoice(c) && typeof c.image === "string" && (typeof CHO_GUARD_PLANTED === "undefined" || imageSourceOk(c.image))) ? c.image : null;')
      .replace("  function isImageChoice(c){", "  const CHO_GUARD_PLANTED = true;\n  function isImageChoice(c){"));
    check(extractionFails(r, /accepts PNG bytes labelled jpeg/), "the choice site alone accepting the known-bad image fails the self-check", why(r));
  });
  run("image-guard-accepts-everything", () => {
    const r = plantedAt("app.js", s => s.replace("const type = m[1], off = 19 + type.length;", "return true; const type = m[1], off = 19 + type.length;"));
    check(extractionFails(r, /accepts PNG bytes labelled jpeg/), "a guard that accepts everything fails the self-check's known-bad leg", why(r));
  });
  run("image-archived", () => {
    const f = fs.readdirSync(path.join(tmp, "testdata", "archive")).find(x => x.indexOf("@") !== -1 &&
      /"figure":\s*"data:image\/png;base64,/.test(fs.readFileSync(path.join(tmp, "testdata", "archive", x), "utf8")));
    const r = planted(path.join("archive", f), relabel);
    check(r.status === 0 && /archived builds hold images the renderer refuses/.test(r.warn) && r.warn.indexOf(f) !== -1,
      "an ARCHIVED build's relabelled figure still builds, with a WARNING naming " + f, why(r));
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
