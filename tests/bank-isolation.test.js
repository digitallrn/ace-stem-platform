/* tests/bank-isolation.test.js — BANKS ARE NOT TESTS, proven, not asserted.
   Run: node tests/bank-isolation.test.js (from the repo root)

   The claim (custom-practice-sets contract 1): a question bank must never
   appear in any test picker, assignment list, Past bucket, or anywhere a
   TEST_MANIFEST entry renders. The proof has three legs:

   1. STRUCTURAL — the real shipped files keep the two worlds in disjoint
      globals with disjoint id conventions: nothing in bank-manifest.js /
      bank-index.js / testdata/<bankId>.js touches TEST_MANIFEST or
      __TESTDATA__, and no id can live in both lists.

   2. RESOLUTION — every student-visible render path that could show a test
      starts at app.js's testById() (assignment cards, Past cards' canView
      gate, crash-resume, canServeVersion, the dashboard's testsById mirror).
      Extracted and run against the REAL manifest with the REAL banks loaded:
      testById() returns null for every bankId and every bank ref, so a bank
      cannot resolve into any of those surfaces even if a crafted assignment
      or record names one. (The dashboard's test <select> iterates
      window.TEST_MANIFEST directly — covered by leg 1.)

   3. SOURCE HYGIENE — the render functions that build the home cards and
      the dashboard's test pickers never read BANK_MANIFEST/__BANKDATA__/
      BANK_INDEX. A regression that merges the lists has to touch one of
      these functions, and this leg turns that into a red test.

   A fourth, DOM-level pass runs in the browser during smoke (home screen +
   dashboard pickers queried for bank ids/names) — this file is the
   CI-able core. */
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { extractFn } = require("./extract-helper");

const root = path.join(__dirname, "..");
const read = f => fs.readFileSync(path.join(root, f), "utf8");

let pass = 0, fail = 0;
const failures = [];
function check(ok, label, detail){
  if(ok){ pass++; console.log("PASS | " + label); }
  else { fail++; failures.push(label + (detail ? " — " + detail : ""));
         console.log("FAIL | " + label + (detail ? " — " + detail : "")); }
}

/* ---- load the real shipped files into one sandbox ---- */
const sandbox = {};
sandbox.window = sandbox;
vm.createContext(sandbox);
vm.runInContext(read("testdata/manifest.js"), sandbox);
vm.runInContext(read("testdata/bank-manifest.js"), sandbox);
vm.runInContext(read("testdata/bank-index.js"), sandbox);
const preTestdata = JSON.stringify(Object.keys(sandbox.__TESTDATA__ || {}));
(sandbox.BANK_MANIFEST || []).forEach(b => {
  vm.runInContext(read("testdata/" + b.bankId + ".js"), sandbox);
});

console.log("--- 1. structural disjointness (the shipped files themselves) ---");
const tests = sandbox.TEST_MANIFEST || [];
const banks = sandbox.BANK_MANIFEST || [];
check(Array.isArray(tests) && tests.length > 0, "TEST_MANIFEST loaded and non-empty");
check(Array.isArray(banks) && banks.length > 0, "BANK_MANIFEST loaded and non-empty");

const FORM_ID = /^\d{6}[a-z]+v\d+$/;
const BANK_ID = /^bank-[a-z0-9]+(-[a-z0-9]+)*$/;
check(tests.every(t => FORM_ID.test(t.testId)),
  "every TEST_MANIFEST id follows the form convention (structurally not a bankId)");
check(banks.every(b => BANK_ID.test(b.bankId)),
  "every BANK_MANIFEST id follows the bank convention (structurally not a testId)");
check(banks.every(b => b.type === "bank"),
  "every BANK_MANIFEST entry is explicitly typed \"bank\"");
check(tests.every(t => t.type === undefined || t.type !== "bank"),
  "no TEST_MANIFEST entry is typed \"bank\"");
check(tests.every(t => t.bankId === undefined),
  "no TEST_MANIFEST entry carries a bankId");
check(banks.every(b => b.testId === undefined),
  "no BANK_MANIFEST entry carries a testId");

const testIds = new Set(tests.flatMap(t => [t.testId].concat(t.legacyIds || [])));
const bankIds = new Set(banks.map(b => b.bankId));
check([...bankIds].every(id => !testIds.has(id)),
  "testId set (incl. legacyIds) and bankId set are disjoint");

check(JSON.stringify(Object.keys(sandbox.__TESTDATA__ || {})) === preTestdata,
  "loading every bank file left __TESTDATA__ untouched (banks register only into __BANKDATA__)");
const bankDataIds = Object.keys(sandbox.__BANKDATA__ || {});
check(bankDataIds.length === banks.length && bankDataIds.every(id => bankIds.has(id)),
  "__BANKDATA__ holds exactly the manifest-listed banks");

const idx = sandbox.BANK_INDEX || {};
check(Array.isArray(idx.entries) && idx.entries.length > 0, "BANK_INDEX loaded and non-empty");
check((idx.entries || []).every(e => e.containerType === "bank" && bankIds.has(e.bankId) &&
    e.ref === e.bankId + ":" + e.qid),
  "every BANK_INDEX entry is containerType bank with a fully-qualified ref into a manifest bank");

console.log("--- 2. resolution: testById() cannot return a bank ---");
/* the REAL function out of app.js, run over the REAL manifest */
const appSrc = read("app.js");
const testByIdSrc = extractFn(appSrc, "testById");
const bankByIdSrc = extractFn(appSrc, "bankById");
const world = new Function("state", "window",
  testByIdSrc + "\n" + bankByIdSrc +
  "\nreturn { testById, bankById };")({ tests: tests }, sandbox);

check([...bankIds].every(id => world.testById(id) === null),
  "testById(bankId) is null for every shipped bank — a crafted assignment/record naming a bank yields no card, no resume, no review");
check((idx.entries || []).every(e => world.testById(e.bankId) === null),
  "testById is null for every BANK_INDEX entry's bankId");
check(tests.every(t => world.bankById(t.testId) === null),
  "bankById(testId) is null for every shipped test (the mirror direction)");

console.log("--- 3. source hygiene: render paths never read the bank globals ---");
/* The functions that build every student-visible test surface, plus the
   dashboard picker builders. If someone merges banks into a test list, one
   of these has to start mentioning a bank global — and this goes red. */
const RENDER_FNS = ["renderHome", "renderYourTests", "renderActiveCards",
  "renderPastCards", "assignmentCard", "startTestFlow", "openScoreDetails",
  "crashResumeCandidate", "canServeVersion", "loadTest"];
const BANK_GLOBALS = /BANK_MANIFEST|__BANKDATA__|BANK_INDEX|bankById|loadBank/;
RENDER_FNS.forEach(fn => {
  let src = null;
  try{ src = extractFn(appSrc, fn); }catch(e){}
  check(src !== null && !BANK_GLOBALS.test(src),
    "app.js " + fn + "() reads no bank global",
    src === null ? "function not found — update this test" : "bank global referenced");
});
/* dashboard: the test filter and the assignment-form test <select> iterate
   TEST_MANIFEST / testsById; they must not iterate a bank list */
const dashSrc = read("dashboard.js");
["renderAll", "viewAssign"].forEach(fn => {
  let src = null;
  try{ src = extractFn(dashSrc, fn); }catch(e){}
  check(src !== null && !BANK_GLOBALS.test(src),
    "dashboard.js " + fn + "() reads no bank global",
    src === null ? "function not found — update this test" : "bank global referenced");
});

/* and the inverse guard: the set/bank code never writes the test globals */
const SET_FNS = ["loadBank", "resolveSetRefs", "buildSetTestFromRecord", "syntheticSetTest"];
SET_FNS.forEach(fn => {
  let src = null;
  try{ src = extractFn(appSrc, fn); }catch(e){}
  check(src !== null && !/TEST_MANIFEST|state\.tests\s*=|__TESTDATA__\s*\[[^\]]*\]\s*=/.test(src),
    "app.js " + fn + "() neither reads TEST_MANIFEST nor writes __TESTDATA__/state.tests",
    src === null ? "function not found — update this test" : "test global touched");
});

console.log(`\n${fail ? "FAIL" : "ALL PASS"} — ${pass} passed, ${fail} failed`);
if(failures.length){ console.log("Failures:"); failures.forEach(f => console.log("  - " + f)); }
process.exit(fail ? 1 : 0);
