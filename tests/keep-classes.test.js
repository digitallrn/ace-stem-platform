/* tests/keep-classes.test.js — run: node tests/keep-classes.test.js (repo root)

   The annotation sanitizer (app.js sanitizeOnce) keeps a class token only if
   KEEP_CLASSES matches it. Highlights and notes are saved as the passage's
   HTML and restored through that sanitizer on resume and in Review Mode, so
   a class fmt() emits that is missing from the list silently loses its
   styling the moment a student highlights and the sitting resumes.
   That happened to {{credit}}: render.js emits <div class="fmt-credit">
   (right-aligned, smaller), KEEP_CLASSES listed the seven fmt-* classes
   measured in 2026-08 and not this eighth one, and "©2016 by A. Hope
   Jahren" under 202609usv1 re1-q8 (also credits on 202403intv2 and
   202510usv1) came back as a plain left-aligned line after a resume.

   tests/injection-proof.js has a gate for this ("Allowlist covers every
   class fmt() emits in a Reading and Writing field"), but it is a manual
   browser-console script, so nothing ran it. This is the same gate in node,
   plus a static one that does not depend on which tokens today's library
   happens to use:

     1. STATIC — every class="fmt-…" literal in render.js is kept.
     2. LIBRARY — fmt() over every Reading-and-Writing passage, stem and
        choice of every manifest test and every RW bank question: every
        fmt-* token emitted is kept. Math inside an RW field is the one
        documented exception (KaTeX classes are excluded from KEEP_CLASSES by
        design — they carry positioning and size multipliers; see the
        comment above KEEP_CLASSES) — those fields are LISTED below, never
        silently skipped, and a non-fmt class from a field WITHOUT math fails.
     3. THE REPORTED CASE — 202609usv1 re1-q8's passage emits fmt-credit and
        the list keeps it.
     4. The list tested here is the one the sanitizer actually applies.

   To watch it fail without the fix:
     git show HEAD~1:app.js > <scratch>/app-pre.js      (any commit before it)
     APP_SRC=<scratch>/app-pre.js node tests/keep-classes.test.js */
"use strict";
const fs = require("fs");
const vm = require("vm");
const { extractFn, extractConst } = require("./extract-helper");

const APP_PATH = process.env.APP_SRC || "app.js";
const appSrc = fs.readFileSync(APP_PATH, "utf8");
const renderSrc = fs.readFileSync("render.js", "utf8");

let pass = 0, fail = 0;
const failures = [];
function check(ok, label, detail){
  if(ok){ pass++; console.log("PASS | " + label); }
  else { fail++; failures.push(label + (detail ? " — " + detail : ""));
         console.log("FAIL | " + label + (detail ? " — " + detail : "")); }
}

const KEEP = new Function(extractConst(appSrc, "KEEP_CLASSES") + "\nreturn KEEP_CLASSES;")();
check(KEEP instanceof RegExp, "KEEP_CLASSES extracted from " + APP_PATH + " as a RegExp");

/* 4. the regex under test is the one the sanitizer applies to class tokens */
const sanitizeOnce = extractFn(appSrc, "sanitizeOnce");
check(/KEEP_CLASSES\.test\(c\)/.test(sanitizeOnce) && /if\(n === "class"\)/.test(sanitizeOnce),
  "sanitizeOnce filters every class token through KEEP_CLASSES.test (the list tested here is the one applied)");

/* 1. static: every fmt-* class render.js can emit */
const emitted = new Set();
(renderSrc.match(/class=\\?"[^"\\]+/g) || []).forEach(m => m.replace(/^class=\\?"/, "").split(/\s+/).forEach(t => t && emitted.add(t)));
const fmtClasses = [...emitted].filter(t => /^fmt-/.test(t)).sort();
check(fmtClasses.length >= 8 && fmtClasses.indexOf("fmt-credit") !== -1,
  "render.js's class literals were found (" + fmtClasses.length + " fmt-* classes, fmt-credit among them)", fmtClasses.join(", "));
const staticDropped = fmtClasses.filter(t => !KEEP.test(t));
check(staticDropped.length === 0, "STATIC: every fmt-* class render.js can emit is in KEEP_CLASSES",
  "dropped: " + staticDropped.join(", "));

/* 2. library: fmt() over every RW field of every shipped test and RW bank question */
const ctx = { window: {} };
vm.createContext(ctx);
vm.runInContext(renderSrc, ctx);                    // no katex here: math renders as .katex-fallback
const fmt = ctx.fmt;
if(typeof fmt !== "function") throw new Error("render.js did not define fmt");
function loadData(file){
  const c = { window: {} };
  vm.createContext(c);
  vm.runInContext(fs.readFileSync(file, "utf8"), c);
  return c.window;
}
const manifest = loadData("testdata/manifest.js").TEST_MANIFEST;
const banks = loadData("testdata/bank-manifest.js").BANK_MANIFEST;
const HAS_MATH = /\{\{mm?\}\}/;
let fields = 0;
const perToken = new Map();             // fmt-* token -> fields emitting it
const mathFields = [];                  // RW fields with math: classes dropped by design
const strayFields = [];                 // a non-fmt class from a field WITHOUT math
function scan(where, values){
  values.forEach((v, i) => {
    if(typeof v !== "string" || !v) return;
    fields++;
    const h = fmt(v, i >= 2 ? { bigInline: true } : undefined);
    const toks = [];
    (h.match(/class="[^"]*"/g) || []).forEach(m => m.slice(7, -1).split(/\s+/).forEach(t => t && toks.push(t)));
    const math = HAS_MATH.test(v);
    toks.forEach(t => {
      if(/^fmt-/.test(t)){ (perToken.get(t) || perToken.set(t, []).get(t)).push(where + "#" + i); return; }
      if(KEEP.test(t)) return;
      if(math){ if(mathFields.indexOf(where) === -1) mathFields.push(where); return; }
      strayFields.push(where + "#" + i + " (" + t + ")");
    });
  });
}
manifest.forEach(entry => {
  const t = (loadData("testdata/" + entry.testId + ".js").__TESTDATA__ || {})[entry.testId];
  if(!t){ check(false, "test file registers " + entry.testId); return; }
  t.modules.filter(m => m.section === "Reading and Writing").forEach(m =>
    m.questions.forEach(q => scan(entry.testId + ":" + q.id, [q.passage, q.questionText].concat(Array.isArray(q.choices) ? q.choices : []))));
});
banks.forEach(b => {
  const bank = (loadData("testdata/" + b.bankId + ".js").__BANKDATA__ || {})[b.bankId];
  if(!bank){ check(false, "bank file registers " + b.bankId); return; }
  (bank.questions || []).filter(q => q && q.subject === "rw").forEach(q =>
    scan(b.bankId + ":" + q.qid, [q.passage, q.questionText].concat(Array.isArray(q.choices) ? q.choices : [])));
});
check(fields > 3000, "fmt() ran over every RW field of " + manifest.length + " tests and " + banks.length + " banks (" + fields + " fields)");
const libDropped = [...perToken.keys()].filter(t => !KEEP.test(t)).sort();
check(libDropped.length === 0, "LIBRARY: every fmt-* class the shipped RW fields emit is in KEEP_CLASSES",
  libDropped.map(t => t + " (" + perToken.get(t).length + " fields, e.g. " + perToken.get(t).slice(0, 3).join(", ") + ")").join("; "));
check(strayFields.length === 0, "LIBRARY: no field WITHOUT math emits a class the list drops", strayFields.slice(0, 10).join(", "));
console.log("  fmt-* tokens in the RW library: " + [...perToken.keys()].sort().map(t => t + "×" + perToken.get(t).length).join(", "));
console.log("  RW fields with math (KaTeX classes dropped BY DESIGN — a visible degradation, not a hole): " +
  (mathFields.length ? mathFields.join(", ") : "none"));

/* 3. the reported case */
const usv1 = loadData("testdata/202609usv1.js").__TESTDATA__["202609usv1"];
const q8 = usv1.modules.reduce((acc, m) => acc.concat(m.questions), []).find(q => q.id === "re1-q8");
const q8html = q8 ? fmt(q8.passage) : "";
check(/<div class="fmt-credit">[^<]*2016 by A\. Hope Jahren/.test(q8html),
  "202609usv1 re1-q8's passage renders its credit line as div.fmt-credit", q8html.slice(-200));
check(KEEP.test("fmt-credit"), "…and KEEP_CLASSES keeps fmt-credit, so a highlighted-then-resumed passage keeps the credit's styling");

console.log(`\n${fail ? "FAIL" : "ALL PASS"} — ${pass} passed, ${fail} failed`);
if(failures.length){ console.log("Failures:"); failures.forEach(f => console.log("  - " + f)); }
process.exit(fail ? 1 : 0);
