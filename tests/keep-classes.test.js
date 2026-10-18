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

   Not only on resume: before the fix the class was stripped on EVERY
   in-sitting re-render of the passage (a flag, a cross-out, a revisit),
   and a highlight saved after one stores the passage WITHOUT the class —
   so blobs written before 2026-09-30 can stay unstyled for good. The fix
   holds from the deploy on; it does not repair old blobs.

   tests/injection-proof.js has a gate for this ("Allowlist covers every
   class fmt() emits in a Reading and Writing field"), but it is a manual
   browser-console script, so nothing ran it. This is that gate in node,
   plus a static one that does not depend on which tokens today's library
   happens to use:

     1. STATIC — every fmt-* class NAMED ANYWHERE in render.js (whatever the
        quoting: "…", '…', a lookup table, className) is kept, render.js
        builds no fmt-* class by concatenation (a "fmt-" + name emitter would
        hide its names from this scan), and the set is exactly the eight
        pinned below, so a new or renamed class is looked at, not waved
        through.
     2. LIBRARY — fmt() over every Reading-and-Writing passage, stem and
        choice of every manifest test and every RW bank question: every
        fmt-* token emitted is kept. Math inside an RW field is the one
        documented exception (KaTeX classes are excluded from KEEP_CLASSES by
        design — they carry positioning and size multipliers; see the
        comment above KEEP_CLASSES): those fields are PINNED by name, so math
        in a NEW RW field fails here instead of degrading quietly; a non-fmt
        class from a field WITHOUT math fails too.
     3. THE REPORTED CASE — 202609usv1 re1-q8's passage emits fmt-credit and
        the list keeps it.
     4. The list tested here is the one the sanitizer actually applies.

   To watch it fail without the fix:
     git show HEAD~1:app.js > <scratch>/app-pre.js      (any commit before it)
     APP_SRC=<scratch>/app-pre.js node tests/keep-classes.test.js
   (that was the fmt-credit fix, bc390d8). The same run against b67d3a7's
   app.js, before the image bytes check, fails 2b's four bytes controls:
   that renderer accepts each of them. */
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

/* 1. static: every fmt-* class NAMED anywhere in render.js, however quoted */
const FMT_PINNED = ["fmt-blank", "fmt-bullets", "fmt-caption", "fmt-credit", "fmt-passage-label", "fmt-quote", "fmt-table", "fmt-tnote"];
const fmtClasses = [...new Set(renderSrc.match(/fmt-[a-z][a-z-]*/g) || [])].sort();
check(JSON.stringify(fmtClasses) === JSON.stringify(FMT_PINNED),
  "render.js names exactly the 8 pinned fmt-* classes (a new or renamed one must be looked at — and added to KEEP_CLASSES)", fmtClasses.join(", "));
const dynamic = (renderSrc.match(/fmt-(?![a-z])/g) || []).length;
check(dynamic === 0, "render.js builds no fmt-* class by concatenation (\"fmt-\" + name would hide its names from this scan)",
  dynamic + " bare 'fmt-' occurrence(s)");
const staticDropped = fmtClasses.filter(t => !KEEP.test(t));
check(staticDropped.length === 0, "STATIC: every fmt-* class named in render.js is in KEEP_CLASSES",
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

/* 2b. IMAGE CHOICES (2026-10-07, IMAGE-CHOICES-SPEC.md). scan() above skips
   a non-string field by its typeof guard — an object entry {image} in
   `choices` is exactly that, so make the skip EXPLICIT: every image choice in
   every form and bank (Math included; the fmt sweep is RW-only) must be one
   the renderer itself ACCEPTS — choiceImageSrc extracted from app.js, which
   since 2026-10-18 checks the decoded bytes against the declared type as
   well as the grammar (imageSourceOk) — and must sit in a 4-entry choices
   array of an MCQ; and ANY non-string, non-object entry in any choices array
   (a null, a number, an array — the renderer shows "Image unavailable" for
   each) is a problem whether or not an image sits beside it. Not covered,
   by contract: mixed text/image items and a bare data:-prefixed STRING (the
   converter's rules; the renderer tolerates the first and treats the second
   as prose). Two items ship the shape since export batch eleven
   (202609asiav1 ma2-q4, 202510usv1 ma2-q1, live at b67d3a7), so the audit
   must SEE at least one — a gate green over zero items has proven nothing —
   and the planted-fixture CONTROL still proves it can fail, bytes included.
   imageSourceOk is taken when present, so the pre-check app.js (APP_SRC)
   reaches the controls and fails the bytes ones rather than crashing; a
   file that calls it without defining it throws at the first audit. */
function optFn(src, name){ try{ return extractFn(src, name); }catch(e){ return ""; } }
const imageGuard = new Function([extractConst(appSrc, "CHOICE_IMAGE_RE"), optFn(appSrc, "imageSourceOk"),
  extractFn(appSrc, "isImageChoice"), extractFn(appSrc, "choiceImageSrc")].join("\n") + "\nreturn { CHOICE_IMAGE_RE, choiceImageSrc };")();
const CHOICE_IMAGE_RE = imageGuard.CHOICE_IMAGE_RE, choiceImageSrc = imageGuard.choiceImageSrc;
function auditChoices(where, q){
  const out = [];
  if(!Array.isArray(q.choices)) return out;           // SPRs carry no choices key
  const ch = q.choices;
  const objs = ch.filter(c => c && typeof c === "object" && !Array.isArray(c));
  if(objs.length){
    if(q.type !== "mcq") out.push(where + ": image choices on a non-MCQ (" + q.type + ")");
    if(ch.length !== 4) out.push(where + ": " + ch.length + " choices, not 4");
  }
  ch.forEach((c, i) => {
    if(typeof c === "string") return;
    if(!c || typeof c !== "object" || Array.isArray(c)){ out.push(where + "#" + i + ": entry is " + (c === null ? "null" : Array.isArray(c) ? "array" : typeof c)); return; }
    if(typeof c.image !== "string") out.push(where + "#" + i + ": image is " + typeof c.image);
    else if(!CHOICE_IMAGE_RE.test(c.image)) out.push(where + "#" + i + ": image fails the grammar (" + c.image.slice(0, 32) + "…)");
    else if(choiceImageSrc(c) !== c.image) out.push(where + "#" + i + ": the renderer refuses the image — its bytes are not the declared type, or do not decode (" + c.image.slice(0, 32) + "…)");
    if("alt" in c && typeof c.alt !== "string") out.push(where + "#" + i + ": alt is " + typeof c.alt);
  });
  return out;
}
let imageChoices = 0;
const imageItems = [];
const choiceProblems = [];
function countImages(where, q){
  const n = (Array.isArray(q.choices) ? q.choices : []).filter(c => c && typeof c === "object" && !Array.isArray(c)).length;
  if(n){ imageChoices += n; imageItems.push(where); }
}
manifest.forEach(entry => {
  const t = (loadData("testdata/" + entry.testId + ".js").__TESTDATA__ || {})[entry.testId];
  if(!t) return;
  t.modules.forEach(m => m.questions.forEach(q => {
    countImages(entry.testId + ":" + q.id, q);
    choiceProblems.push(...auditChoices(entry.testId + ":" + q.id, q));
  }));
});
banks.forEach(b => {
  const bank = (loadData("testdata/" + b.bankId + ".js").__BANKDATA__ || {})[b.bankId];
  if(!bank) return;
  (bank.questions || []).forEach(q => {
    countImages(b.bankId + ":" + q.qid, q);
    choiceProblems.push(...auditChoices(b.bankId + ":" + q.qid, q));
  });
});
console.log("  image choices in the shipped library: " + imageChoices + " on " + imageItems.length + " item(s) (" + imageItems.join(", ") +
  "), each audited through the renderer's own choiceImageSrc: grammar, then decoded bytes against the declared type");
check(imageChoices > 0, "LIBRARY: the audit saw shipped image choices (it is not green over zero items)", imageChoices + " image choices");
check(choiceProblems.length === 0, "LIBRARY: every image choice in every form and bank is one the renderer accepts (grammar and bytes), inside a 4-entry MCQ", choiceProblems.slice(0, 10).join("; "));
/* the control: the audit passes the fixture and FAILS each planted defect */
const FIX = require("./image-choice-fixture");
check(auditChoices("fixture", FIX.question()).length === 0, "CONTROL: the shared fixture item (four image choices) passes the audit");
const planted = {
  "three entries": Object.assign(FIX.question(), { choices: FIX.URIS.slice(0, 3).map(u => ({ image: u })) }),
  "javascript: source": Object.assign(FIX.question(), { choices: [{ image: "javascript:alert(1)" }].concat(FIX.URIS.slice(1).map(u => ({ image: u }))) }),
  "https source": Object.assign(FIX.question(), { choices: [{ image: "https://evil.example/x.png" }].concat(FIX.URIS.slice(1).map(u => ({ image: u }))) }),
  "an SPR carrying images": Object.assign(FIX.question(), { type: "spr", correctAnswer: "3" }),
  "a number entry": Object.assign(FIX.question(), { choices: [5].concat(FIX.URIS.slice(1).map(u => ({ image: u }))) }),
  "a null entry in an all-text item": Object.assign(FIX.question(), { choices: [null, "a", "b", "c"] }),
  "an array entry in an all-text item": Object.assign(FIX.question(), { choices: ["a", ["b"], "c", "d"] }),
  "image not a string": Object.assign(FIX.question(), { choices: [{ image: 5 }].concat(FIX.URIS.slice(1).map(u => ({ image: u }))) }),
  "non-string alt": Object.assign(FIX.question(), { choices: [{ image: FIX.URIS[0], alt: 7 }].concat(FIX.URIS.slice(1).map(u => ({ image: u }))) }),
  /* the bytes half (2026-10-18): each passes the grammar and is refused only
     because its decoded bytes are not what it declares */
  "PNG bytes declared jpeg": Object.assign(FIX.question(), { choices: [{ image: "data:image/jpeg;base64," + FIX.URIS[0].slice(22) }].concat(FIX.URIS.slice(1).map(u => ({ image: u }))) }),
  "SVG bytes declared png": Object.assign(FIX.question(), { choices: [{ image: "data:image/png;base64," + Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>').toString("base64") }].concat(FIX.URIS.slice(1).map(u => ({ image: u }))) }),
  "an SVG with no namespace": Object.assign(FIX.question(), { choices: [{ image: "data:image/svg+xml;base64," + Buffer.from("<svg/>").toString("base64") }].concat(FIX.URIS.slice(1).map(u => ({ image: u }))) }),
  "a payload atob cannot decode (length 1 mod 4)": Object.assign(FIX.question(), { choices: [{ image: FIX.URIS[0].replace(/=+$/, "") + "AAA" }].concat(FIX.URIS.slice(1).map(u => ({ image: u }))) })
};
Object.keys(planted).forEach(k => check(auditChoices("planted", planted[k]).length > 0, "CONTROL: the audit fails a planted defect — " + k));
const libDropped = [...perToken.keys()].filter(t => !KEEP.test(t)).sort();
check(libDropped.length === 0, "LIBRARY: every fmt-* class the shipped RW fields emit is in KEEP_CLASSES",
  libDropped.map(t => t + " (" + perToken.get(t).length + " fields, e.g. " + perToken.get(t).slice(0, 3).join(", ") + ")").join("; "));
check(strayFields.length === 0, "LIBRARY: no field WITHOUT math emits a class the list drops", strayFields.slice(0, 10).join(", "));
console.log("  fmt-* tokens in the RW library: " + [...perToken.keys()].sort().map(t => t + "×" + perToken.get(t).length).join(", "));
/* Math in an RW field is excluded by design (a visible degradation on
   resume, not a hole) — but only for the fields PINNED here, each one known
   and accepted. Math in any other RW field fails, so the next one is a
   decision, not a log line. */
const KNOWN_MATH_RW = ["202608intv1:re2-q10"];     // isotope notation in the passage table and choices B/C (2026-08-27)
const newMath = mathFields.filter(f => KNOWN_MATH_RW.indexOf(f) === -1);
check(newMath.length === 0, "LIBRARY: math appears only in the pinned RW fields (" + KNOWN_MATH_RW.join(", ") +
  ") — anywhere else its KaTeX classes would be stripped on resume", "new: " + newMath.join(", "));
const gone = KNOWN_MATH_RW.filter(f => mathFields.indexOf(f) === -1);
check(gone.length === 0, "LIBRARY: every pinned math-in-RW field still has math (a stale pin is removed, not kept)", "no longer math: " + gone.join(", "));

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
