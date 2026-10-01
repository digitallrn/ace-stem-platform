/* tests/spr-grading.test.js — SPR grading rule.
   node tests/spr-grading.test.js

   Three jobs:
   1. Prove the reference-35 Acceptable/Unacceptable table grades exactly as
      printed — that table IS the spec, so anything else is a bug here.
   2. Prove the small-answer case the fixed +/-0.01 tolerance got wrong.
   3. EXHAUSTIVELY compare the old tolerance rule against the new rule over
      every string a student could physically enter, for every SPR key shipped
      in the library — so "no existing stored attempt score may change" is
      answered by enumeration rather than by sampling. Any disagreement is
      printed in full, because a disagreement is exactly a grade that would
      move. */

const fs = require("fs");
const path = require("path");
const repo = path.join(__dirname, "..");

/* load the real grading.js (a plain script, not a module) */
const gradingSrc = fs.readFileSync(path.join(repo, "grading.js"), "utf8");
const G = {};
new Function("exports", gradingSrc + `
  exports.sprValueMatches = sprValueMatches;
  exports.answerMatches = answerMatches;
  exports.sprParseExact = sprParseExact;
  exports.sprCapacities = sprCapacities;
  exports.sprFitsExactly = sprFitsExactly;   // §4b cross-checks its own independent reading against this
`)(G);

/* the rule this replaces, verbatim, so the comparison is against what
   actually shipped rather than against a paraphrase of it */
function oldToFraction(str){
  const m = String(str).trim().match(/^-?\d+\s*\/\s*\d+$/);
  if(!m) return null;
  const parts = str.split("/");
  const num = parseFloat(parts[0]), den = parseFloat(parts[1]);
  if(den === 0 || isNaN(num) || isNaN(den)) return null;
  return num/den;
}
function oldSprValueMatches(given, key){
  const a = String(given).trim(), b = String(key).trim();
  if(a.toLowerCase() === b.toLowerCase()) return true;
  const aNum = oldToFraction(a) ?? parseFloat(a);
  const bNum = oldToFraction(b) ?? parseFloat(b);
  if(!isNaN(aNum) && !isNaN(bNum)) return Math.abs(aNum-bNum) < 0.01;
  return false;
}

/* what the app lets a student type (app.js sanitizeSpr) */
function sanitizeSpr(v){
  v = String(v).replace(/[^0-9./-]/g, "");
  v = v.charAt(0) + v.slice(1).replace(/-/g, "");
  const max = v.startsWith("-") ? 6 : 5;
  return v.slice(0, max);
}

let pass = 0, fail = 0;
const failures = [];
/* The §4 exhaustive sweep is ~11M comparisons (~40s). SPR_AUDIT_ONLY=1 skips
   it to run ONLY the §5 stored-attempt audit fast — used by
   tests/set-audit.test.js, which invokes this script per fixture. §5's own
   deps (the library T/B, oldSprValueMatches, grading.js) load regardless. */
const AUDIT_ONLY = process.env.SPR_AUDIT_ONLY === "1";
if(AUDIT_ONLY){
  console.log("========================================================================");
  console.log("  EXHAUSTIVE SWEEP SKIPPED — not a pre-deploy audit");
  console.log("  (SPR_AUDIT_ONLY=1: running only §5, the stored-attempt audit.");
  console.log("   Run without this flag for the full old-vs-new grading sweep.)");
  console.log("========================================================================");
}
function check(name, got, want){
  const ok = got === want;
  if(ok) pass++; else { fail++; failures.push(`${name}\n     got ${got}, want ${want}`); }
  console.log(`${ok ? "PASS" : "FAIL"} | ${name}`);
}

console.log("\n--- 1. reference 35: the directions' own table for 2/3 ---");
[["2/3", true], [".6666", true], [".6667", true], ["0.666", true], ["0.667", true],
 ["0.66", false], [".66", false], ["0.67", false], [".67", false]]
  .forEach(([entry, want]) =>
    check(`2/3 ${want ? "accepts" : "rejects"} ${entry}`, G.sprValueMatches(entry, "2/3"), want));

console.log("\n--- 1b. the same table for -1/3 (negative gets the 6th slot) ---");
/* -1/3 is -0.3333..., so truncating AND rounding agree at every length:
   -.3333 and -0.333. There is no "-0.334" the way 2/3 has a "0.667" — the
   digit after the cut is a 3, not a 6. The directions' table lists exactly
   -1/3, -.3333, -0.333 as acceptable. */
[["-1/3", true], ["-.3333", true], ["-.3334", false], ["-0.333", true], ["-0.334", false],
 ["-.33", false], ["-0.33", false]]
  .forEach(([entry, want]) =>
    check(`-1/3 ${want ? "accepts" : "rejects"} ${entry}`, G.sprValueMatches(entry, "-1/3"), want));

console.log("\n--- 1c. 3.5: an answer that fits needs no shortening ---");
[["3.5", true], ["3.50", true], ["7/2", true], ["3.4", false], ["3.6", false], ["31/2", false]]
  .forEach(([entry, want]) =>
    check(`3.5 ${want ? "accepts" : "rejects"} ${entry}`, G.sprValueMatches(entry, "3.5"), want));

console.log("\n--- 2. the small-answer case the tolerance got wrong (.0138 = trunc 1/72) ---");
check(".0138 accepts .0138", G.sprValueMatches(".0138", ".0138"), true);
check(".0138 accepts 0.0138", G.sprValueMatches("0.0138", ".0138"), true);
check(".0138 REJECTS .02  (old rule accepted)", G.sprValueMatches(".02", ".0138"), false);
check(".0138 REJECTS .005 (old rule accepted)", G.sprValueMatches(".005", ".0138"), false);
check("   ...and the old rule really did accept .02",  oldSprValueMatches(".02", ".0138"), true);
check("   ...and the old rule really did accept .005", oldSprValueMatches(".005", ".0138"), true);
/* the key is a truncation, so its other legal forms live in alt_answers —
   the test bank already records them for this question */
const q0138 = { type:"spr", correctAnswer:".0138", altAnswers:["1/72",".0139","0.0139"] };
[["1/72", true], [".0139", true], ["0.0139", true], [".0138", true],
 [".02", false], [".005", false], [".014", true], [".013", true]]
  .forEach(([entry, want]) =>
    check(`  with its alt_answers, ${want ? "accepts" : "rejects"} ${entry}`,
      G.answerMatches(q0138, entry), want));

console.log("\n--- 3. integers and negatives are untouched ---");
[["255","255",true], ["255","254",false], ["255","255.0",true],
 ["-189","-189",true], ["-189","-188",false], ["-189","189",false],
 ["62951","62951",true], ["62951","62950",false],
 ["15","15",true], ["15","15.00",true], ["15","14.99",false]]
  .forEach(([key, entry, want]) =>
    check(`key ${key} ${want ? "accepts" : "rejects"} ${entry}`, G.sprValueMatches(entry, key), want));

/* ---------------------------------------------------------------------- */
console.log("\n--- 4. EXHAUSTIVE old-vs-new over every typable entry ---");

/* every string the field can hold, built over its actual alphabet */
const ALPHABET = "0123456789./-";
function* everyEntry(){
  const seen = new Set();
  const rec = (prefix) => {
    if(prefix.length){
      const s = sanitizeSpr(prefix);
      if(s === prefix && !seen.has(s)){ seen.add(s); }
    }
    if(prefix.length >= 6) return;
    for(const c of ALPHABET) rec(prefix + c);
  };
  rec("");
  for(const s of seen) yield s;
}
const entries = [];
if(!AUDIT_ONLY){
  for(const e of everyEntry()) entries.push(e);
  console.log(`    ${entries.length.toLocaleString()} enterable strings`);
} else {
  console.log("    (SPR_AUDIT_ONLY=1 — skipping the exhaustive sweep; running §5 only)");
}

/* Every SPR key shipped in the library, taken from the MANIFEST — the file
   that defines the library and the one build-site.js ships from. Hardcoding
   two requires here meant a test added the documented way ("drop
   testdata/<testId>.js in, add its manifest entry, done") was silently never
   swept, while this suite went on claiming library-wide coverage. */
global.window = {};
require(path.join(repo, "testdata", "manifest.js"));
const manifest = global.window.TEST_MANIFEST;
if(!Array.isArray(manifest) || !manifest.length) throw new Error("manifest did not load");
manifest.forEach(entry => require(path.join(repo, "testdata", entry.testId + ".js")));
const T = global.window.__TESTDATA__;
const missing = manifest.filter(e => !T[e.testId]).map(e => e.testId);
if(missing.length) throw new Error("manifest lists tests that registered nothing: " + missing.join(", "));
console.log(`    library from manifest: ${manifest.map(e => e.testId).join(", ")}`);
/* The bank lane ships SPR keys too (custom practice sets, 2026-08-31) —
   loaded from the BANK manifest the same way, so a newly exported bank is
   automatically swept. Banks are not tests: separate manifest, separate
   global; they only join here because their keys grade through the same
   grading.js. */
require(path.join(repo, "testdata", "bank-manifest.js"));
const bankManifest = global.window.BANK_MANIFEST || [];
bankManifest.forEach(b => require(path.join(repo, "testdata", b.bankId + ".js")));
const B = global.window.__BANKDATA__ || {};
const missingBanks = bankManifest.filter(b => !B[b.bankId]).map(b => b.bankId);
if(missingBanks.length) throw new Error("bank manifest lists banks that registered nothing: " + missingBanks.join(", "));
if(bankManifest.length) console.log(`    banks from bank-manifest: ${bankManifest.map(b => b.bankId).join(", ")}`);

const keys = [];
Object.keys(T).forEach(testId => T[testId].modules.forEach(m => m.questions.forEach(q => {
  if(q.type === "spr") keys.push({ testId, qid: q.id, q });
})));
Object.keys(B).forEach(bankId => (B[bankId].questions || []).forEach(q => {
  if(q.type === "spr") keys.push({ testId: bankId, qid: q.qid, q });
}));
console.log(`    ${keys.length} shipped SPR questions (forms + banks)\n`);

/* The sweep for ONE key, against a given grader — the real one for the
   library, a planted one for the controls in §4b, through the same code. */
function sweepKey(k, grade){
  const changed = [];
  entries.forEach(e => {
    const before = [k.q.correctAnswer].concat(k.q.altAnswers || [])
      .some(key => oldSprValueMatches(e, key));
    const after = grade(k.q, e);
    if(before !== after) changed.push({ e, before, after });
  });
  return changed;
}

/* ---- §4b's exemption arithmetic: exact rationals in BigInt, written here
   and NOT taken from grading.js, so the check never grades the grader with
   the grader's own arithmetic (a self-check below pins that). ---- */
function xGcd(a, b){ a = a < 0n ? -a : a; b = b < 0n ? -b : b; while(b){ const t = a % b; a = b; b = t; } return a; }
function xMake(n, d){
  if(d === 0n) return null;
  if(d < 0n){ n = -n; d = -d; }
  const g = xGcd(n, d) || 1n;
  return { n: n / g, d: d / g };                       // always reduced, so equality is field-wise
}
function xParse(s){
  const t = String(s == null ? "" : s).trim();
  let m = t.match(/^(-?)(\d+)\s*\/\s*(\d+)$/);
  if(m) return xMake((m[1] ? -1n : 1n) * BigInt(m[2]), BigInt(m[3]));
  m = t.match(/^(-?)(\d*)(?:\.(\d*))?$/);
  if(!m || !(m[2] || m[3])) return null;               // "", "-", "." are not values
  const fp = m[3] || "";
  return xMake((m[1] ? -1n : 1n) * BigInt((m[2] || "") + fp), 10n ** BigInt(fp.length));
}
function xCanon(v){ return v.n + "/" + v.d; }
function xEq(a, b){ return a.n === b.n && a.d === b.d; }
function xAbsN(v){ return v.n < 0n ? -v.n : v.n; }
/* The decimals the field holds for a value, per the directions: five
   characters for the magnitude (a minus sign gets its own sixth). |v| < 1 is
   written ".dddd" (4) or "0.ddd" (3) — the reference table accepts both
   .6666 and 0.666 for 2/3; otherwise "I.dd" leaves 4 - intDigits, and only
   a value whose integer part leaves no room for a decimal is cut to 0. */
function xFieldDecimals(v){
  const ip = xAbsN(v) / v.d;
  if(ip === 0n) return [4, 3];
  const digits = String(ip).length;
  return digits <= 3 ? [4 - digits] : [0];
}
/* truncation (toward zero) or rounding (half away from zero) to k places */
function xCut(v, k, round){
  const p = 10n ** BigInt(k), m = xAbsN(v) * p;
  const q = round ? (2n * m + v.d) / (2n * v.d) : m / v.d;
  return xMake((v.n < 0n ? -1n : 1n) * q, p);
}
/* "Cannot be written in the field", read as the DIRECTIONS read it: the
   key's value has no DECIMAL (or integer) form the field can hold. A
   fraction that fits does not count — the directions' own table credits
   .6666 and 0.666 for 2/3, which fits as "2/3", because the rule is about a
   decimal that doesn't fit. Reading it more strictly (any form) would make a
   ruled flip like 142.25 -> 142.2 (142.25 also fits as 569/4) impossible to
   excuse by listing it — the rule-then-list process this pin exists for.
   Decided by the same exhaustive enumeration the sweep runs on (every
   enterable string without a "/"), not by a formula; cross-checked below
   against grading.js's own precondition, sprFitsExactly. */
let enterableDecimals = null;
function fitsField(v){
  if(!enterableDecimals){
    enterableDecimals = new Set();
    entries.forEach(e => { if(e.indexOf("/") !== -1) return; const p = xParse(e); if(p) enterableDecimals.add(xCanon(p)); });
  }
  return enterableDecimals.has(xCanon(v));
}
/* The exempt SHAPE: some key for the item cannot be written in the field,
   and the entry equals that key's truncation or rounding to the decimals the
   field holds. A cut that lands on zero is never an answer. Returns how the
   entry was reached, or null. */
function exemptShape(q, entry){
  const ev = xParse(entry);
  if(!ev || ev.n === 0n) return null;
  for(const key of [q.correctAnswer].concat(q.altAnswers || [])){
    const kv = xParse(key);
    if(!kv || fitsField(kv)) continue;
    for(const k of xFieldDecimals(kv)){
      for(const round of [false, true]){
        const c = xCut(kv, k, round);
        if(c.n !== 0n && xEq(ev, c)) return { key: String(key), how: (round ? "rounding" : "truncation") + " to " + k + " place" + (k === 1 ? "" : "s") };
      }
    }
  }
  return null;
}

let totalDiffs = 0;
const diffDetail = [];
if(!AUDIT_ONLY){
keys.forEach(k => {
  const changed = sweepKey(k, G.answerMatches);
  if(changed.length){
    totalDiffs += changed.length;
    diffDetail.push({ k, changed });
  }
});

/* Split the changes by whether the entry is even a NUMBER. The old rule used
   parseFloat, which reads a valid prefix and ignores the rest — so "255/" and
   "46//" parsed as 255 and 46 and graded CORRECT. Those are not grading-rule
   changes, they are a separate old bug; keeping them apart stops them
   drowning the changes that actually reflect the new rule. */
const wellFormed = c => G.sprParseExact(c.e) !== null;
if(!totalDiffs){
  console.log("    no entry changes grade for any shipped key");
} else {
  let realN = 0, junkN = 0;
  console.log(`    ${totalDiffs} entry/key combinations change grade\n`);
  console.log("    (a) WELL-FORMED entries — the new rule's actual effect:\n");
  diffDetail.forEach(({ k, changed }) => {
    const real = changed.filter(wellFormed);
    junkN += changed.length - real.length;
    if(!real.length) return;
    realN += real.length;
    const nowWrong = real.filter(c => c.before && !c.after).map(c => c.e);
    const nowRight = real.filter(c => !c.before && c.after).map(c => c.e);
    console.log(`      ${k.testId} ${k.qid}  key=${JSON.stringify(k.q.correctAnswer)}` +
      (k.q.altAnswers && k.q.altAnswers.length ? ` alts=${JSON.stringify(k.q.altAnswers)}` : ""));
    if(nowRight.length) console.log(`          NOW CORRECT (${nowRight.length}): ${nowRight.join(" ")}`);
    if(nowWrong.length) console.log(`          NOW WRONG   (${nowWrong.length}): ${nowWrong.join(" ")}`);
  });
  console.log(`\n    (b) MALFORMED entries (not a number at all): ${junkN}`);
  console.log(`        e.g. "255/", "46//", ".12.3" — parseFloat read a prefix and`);
  console.log(`        graded them correct; they are now rejected. Separate old bug.`);
  console.log(`\n    well-formed changes: ${realN}   malformed: ${junkN}`);
}

/* ---- §4b. The direction of every change: wrong -> right ----
   The new rule must never turn a wrong answer into a right one for a shipped
   key. Anything moving the other way is the fix doing its job, but it still
   has to be reviewed against stored attempts, which is why the list above is
   printed in full.

   ONE RULED EXCEPTION (item 6, ruled 2026-09-30). The directions' rule for an
   answer that does not fit: a decimal that doesn't fit in the provided space
   is entered by truncating OR rounding it, to as many digits as the field
   holds. 202505usv1 ma2-q10's answer is 297 + 27*sqrt(73) = 527.6881...
   (R1 and build_202505usv1.py print "527.68766…" — their steps are right,
   the final addition slipped; pinned below), and its keys 527.69 / 527.68
   are that answer's rounding and truncation to two places. Neither can be
   written in the field (six characters), so the field holds ONE decimal and both
   527.6 (truncation) and 527.7 (rounding) are correct entries. David's ruling
   R1 (2026-09-12, test-bank-repo/drafts/202505usv1_RULINGS.md) adjudicated
   that key. The old +/-0.01 band rejected 527.6 (and accepted 527.7 only by
   float luck: 527.7 - 527.69 is 0.00999... in doubles), so "527.6" flips
   wrong -> right: the directions working, not a grading bug, and no stored
   grade moves — the key first shipped 2026-09-24 (8d45238), after the new
   rule (2026-08-02), so no attempt on it was ever graded the old way. The
   check had been red since that export.

   HOW NARROW. A wrong -> right flip is excused only when BOTH hold:
     (1) SHAPE — exemptShape() above: some key for the item cannot be written
         in the field (its value has no decimal form the field holds — the
         directions' precondition, see fitsField) AND the entry equals that
         key's truncation or rounding to the decimals the field holds;
         BigInt arithmetic, independent of grading.js;
     (2) RULED — the flip is listed by name in RULED_EXEMPT.
   (2) is David's pin: the NEXT key too long for its field fails this check
   until someone rules on it, instead of passing through the generic shape.
   And the list must match the sweep EXACTLY, so a pin that stops matching
   (a re-exported key) is reported rather than silently carried. Add a flip
   here only on a ruling, and cite it. */
const RULED_EXEMPT = ["202505usv1 ma2-q10 527.6"];   // R1 (David, 2026-09-12); ruled into this check 2026-09-30

function newlyCorrectVerdicts(detail, ruled){
  const excused = [], unexcused = [];
  detail.forEach(({ k, changed }) => changed.forEach(c => {
    if(c.before || !c.after) return;                   // only wrong -> right
    const id = k.testId + " " + k.qid + " " + c.e;
    const shape = exemptShape(k.q, c.e);
    if(shape && ruled.indexOf(id) !== -1) excused.push(id);
    else unexcused.push({ id, shape });
  }));
  return { excused, unexcused };
}
const unexcusedText = u => u.id + (u.shape
  ? "  — the exempt SHAPE (" + u.shape.how + " of " + u.shape.key + ", which has no decimal form the field holds) but NOT RULED: list it in RULED_EXEMPT only on a ruling"
  : "  — not the exempt shape: a wrong answer the new rule now credits");
/* The two halves of the verdict — the SAME predicates the controls below
   assert on, so a control proves the actual pass/fail rule, not a copy. */
const noUnexcused = v => v.unexcused.length === 0;
const excusedIsExactly = (v, ruled) => JSON.stringify(v.excused.slice().sort()) === JSON.stringify(ruled.slice().sort());
const verdictOk = (v, ruled) => noUnexcused(v) && excusedIsExactly(v, ruled);
const V = newlyCorrectVerdicts(diffDetail, RULED_EXEMPT);
if(V.unexcused.length){
  console.log("\n    WRONG -> RIGHT, NOT EXCUSED:");
  V.unexcused.forEach(u => console.log("      " + unexcusedText(u)));
}
if(V.excused.length) console.log("\n    wrong -> right, excused by ruling: " + V.excused.join(", "));
check("no shipped key turns a previously-wrong entry into a correct one (one ruled exception: " + RULED_EXEMPT.join(", ") + ")",
  noUnexcused(V), true);
check("the ruled exception is exactly what the sweep finds — no unruled flip excused, no stale pin",
  excusedIsExactly(V, RULED_EXEMPT), true);

/* The exemption's own arithmetic, pinned on values worked by hand. */
check("independent arithmetic (constants): 297 + 27*sqrt(73) = 527.6881..., and rounded / truncated to two places it is 527.69 / 527.68 — R1's keys, which the control-items check pins in the shipped item",
  [(297 + 27 * Math.sqrt(73)).toFixed(4), (Math.round((297 + 27 * Math.sqrt(73)) * 100) / 100).toFixed(2), (Math.trunc((297 + 27 * Math.sqrt(73)) * 100) / 100).toFixed(2)].join(" "),
  "527.6881 527.69 527.68");
check("independent: 527.69, 527.68, 142.25 (though it is 569/4), 2/3, -1/3, 1/72 and 500/3 cannot be written as a decimal in the field",
  ["527.69", "527.68", "142.25", "2/3", "-1/3", "1/72", "500/3"].some(s => fitsField(xParse(s))), false);
check("independent: 9.96, .0138, 3.5, 255, -189, .1875 and 62951 can be",
  ["9.96", ".0138", "3.5", "255", "-189", ".1875", "62951"].every(s => fitsField(xParse(s))), true);
/* the independent reading agrees with grading.js's own precondition on every
   shipped key and alt (computed apart, compared here) */
const fitDisagree = [];
keys.forEach(k => [k.q.correctAnswer].concat(k.q.altAnswers || []).forEach(s => {
  const mine = xParse(s), theirs = G.sprParseExact(s);
  if((mine === null) !== (theirs === null)) fitDisagree.push(k.testId + " " + k.qid + " " + JSON.stringify(s) + " (parse)");
  else if(mine && fitsField(mine) !== G.sprFitsExactly(theirs)) fitDisagree.push(k.testId + " " + k.qid + " " + JSON.stringify(s));
}));
check("independent: 'can be written in the field' agrees with grading.js's sprFitsExactly on every shipped key and alt",
  fitDisagree.join(", "), "");
check("independent: the field holds 1 decimal for 527.69 (527.6 / 527.7), 4 or 3 below 1, 0 for 1562.5",
  [JSON.stringify(xFieldDecimals(xParse("527.69"))), xCanon(xCut(xParse("527.69"), 1, false)), xCanon(xCut(xParse("527.69"), 1, true)),
   JSON.stringify(xFieldDecimals(xParse("2/3"))), JSON.stringify(xFieldDecimals(xParse("1562.5"))),
   xCanon(xCut(xParse("-1/3"), 4, true))].join(" "),
  "[1] 2638/5 5277/10 [4,3] [0] -3333/10000");
check("independent: a cut that lands on zero is never the shape (key .00004321 cannot be written; '0' and '.0000' are not its shortening)",
  [exemptShape({ type: "spr", correctAnswer: ".00004321" }, "0"), exemptShape({ type: "spr", correctAnswer: ".00004321" }, ".0000"),
   fitsField(xParse(".00004321"))].map(x => x === null ? "null" : String(!!x)).join(","), "null,null,false");
check("the exemption's arithmetic never calls grading.js",
  [xGcd, xMake, xParse, xCanon, xEq, xAbsN, xFieldDecimals, xCut, fitsField, exemptShape].some(f => /\bG\./.test(String(f))), false);

/* CONTROLS — the narrowed check must still catch a real wrong -> right
   flip. Each runs the SAME sweep (sweepKey) and verdict code as above. */
const findKey = (testId, qid) => keys.find(x => x.testId === testId && x.qid === qid) || null;
const kQ10 = findKey("202505usv1", "ma2-q10"), kQ21 = findKey("202606asiav1", "ma2-q21");
check("control items are in the library (202505usv1 ma2-q10 = 527.69 alt 527.68, as R1 ruled; 202606asiav1 ma2-q21 = 9.96)",
  !!(kQ10 && kQ21) && kQ10.q.correctAnswer === "527.69" && JSON.stringify(kQ10.q.altAnswers || []) === JSON.stringify(["527.68"]) &&
  kQ21.q.correctAnswer === "9.96", true);
const plant = (kk, entry) => (q, e) => (q === kk.q && e === entry) || G.answerMatches(q, e);
const ids = v => JSON.stringify(v.unexcused.map(u => u.id + (u.shape ? " [shape]" : "")).sort());
let changed97 = null;                                  // the ruled 9.97 control finishes at the moved-entries pin below
/* every control goes through ctl(), and the count is asserted after the
   last one — a control block that silently stops running is a failure */
let controlsRan = 0;
const CONTROLS_EXPECTED = 9;
const ctl = (name, got, want) => { controlsRan++; check(name, got, want); };
if(kQ10 && kQ21){
  ctl("shape on the ruled item: 527.6 (truncation) and 527.7 (rounding) are the shape; 527.5, 527 and 528 are not",
    ["527.6", "527.7", "527.5", "527", "528"].map(e => !!exemptShape(kQ10.q, e)).join(","), "true,true,false,false,false");
  /* (a) the ruled control: a grader that accepts 9.97 for the FITTING key
     9.96. The old band ALREADY accepted 9.97 — 9.97 - 9.96 is 0.00999... in
     doubles — so such a grader makes no wrong -> right flip for THIS check to
     see. It is caught by the moved-entries pin below (9.97 must move right ->
     wrong; under this grader it doesn't): proven there, on this same sweep. */
  changed97 = sweepKey(kQ21, plant(kQ21, "9.97"));
  ctl("control: 9.97 for 9.96 is no wrong -> right flip (the old band already took it: 9.97 - 9.96 = " + Math.abs(9.97 - 9.96) + ") — so the moved-entries pin must catch it",
    ids(newlyCorrectVerdicts([{ k: kQ21, changed: changed97 }], RULED_EXEMPT)) === "[]" && Math.abs(9.97 - 9.96) < 0.01, true);
  /* (a') a GENUINE wrong -> right flip on that ordinary, fitting key: 9.98
     (the old band rejected it — 0.0199...) */
  const changed98 = sweepKey(kQ21, plant(kQ21, "9.98"));
  const vA = newlyCorrectVerdicts([{ k: kQ21, changed: changed98 }], RULED_EXEMPT);
  ctl("control: a grader accepting 9.98 for the fitting key 9.96 (old band: wrong) FAILS this check — exactly that flip, not the exempt shape",
    ids(vA) + " " + verdictOk(vA, []), JSON.stringify(["202606asiav1 ma2-q21 9.98"]) + " false");
  /* (b) the ruled item, the wrong number: 527.5 accepted for 527.69 */
  const vB = newlyCorrectVerdicts([{ k: kQ10, changed: sweepKey(kQ10, plant(kQ10, "527.5")) }], RULED_EXEMPT);
  ctl("control: a grader accepting 527.5 for 527.69 FAILS the check (while the ruled 527.6 stays excused)",
    JSON.stringify({ unexcused: JSON.parse(ids(vB)), excused: vB.excused, ok: verdictOk(vB, RULED_EXEMPT) }),
    JSON.stringify({ unexcused: ["202505usv1 ma2-q10 527.5"], excused: ["202505usv1 ma2-q10 527.6"], ok: false }));
  /* (c) the NEXT key too long for its field: the REAL grader on an unlisted
     item — the exact shape the exemption describes, still a failure */
  const kNext = { testId: "control-unruled", qid: "q1", q: { type: "spr", correctAnswer: "731.48", altAnswers: [] } };
  const vC = newlyCorrectVerdicts([{ k: kNext, changed: sweepKey(kNext, G.answerMatches) }], RULED_EXEMPT);
  ctl("control: an UNLISTED flip of the exempt shape (key 731.48 -> 731.4 / 731.5, the real grader) FAILS the check until ruled on",
    ids(vC) + " " + verdictOk(vC, []), JSON.stringify(["control-unruled q1 731.4 [shape]", "control-unruled q1 731.5 [shape]"]) + " false");
  /* (d) the list alone excuses nothing: both conditions are required */
  const vD = newlyCorrectVerdicts([{ k: kQ21, changed: changed98 }], RULED_EXEMPT.concat(["202606asiav1 ma2-q21 9.98"]));
  ctl("control: LISTING a flip that is not the exempt shape (9.98 for 9.96) does not excuse it",
    ids(vD) + " " + verdictOk(vD, ["202606asiav1 ma2-q21 9.98"]), JSON.stringify(["202606asiav1 ma2-q21 9.98"]) + " false");
  /* (e) a stale pin fails: listing a flip the sweep no longer finds */
  const staleList = RULED_EXEMPT.concat(["202505usv1 ma2-q10 527.7"]);   // through the SAME path a real stale pin takes
  ctl("control: a STALE pin (a listed flip the sweep doesn't find, e.g. 527.7) FAILS the check",
    verdictOk(newlyCorrectVerdicts(diffDetail, staleList), staleList), false);
  /* (f) the rule-then-list process works: a decimal key too long for the
     field that IS a short fraction (142.25 = 569/4) — the real grader's
     flips are the shape, fail unlisted, and pass once listed on a ruling */
  const kListed = { testId: "control-ruled", qid: "q1", q: { type: "spr", correctAnswer: "142.25", altAnswers: [] } };
  const changedL = sweepKey(kListed, G.answerMatches);
  const vL = newlyCorrectVerdicts([{ k: kListed, changed: changedL }], RULED_EXEMPT);
  const listedOnRuling = vL.unexcused.map(u => u.id);
  const vL2 = newlyCorrectVerdicts([{ k: kListed, changed: changedL }], listedOnRuling);
  ctl("control: key 142.25's flips are the exempt shape, FAIL unlisted, and pass once listed on a ruling",
    JSON.stringify({ unlisted: JSON.parse(ids(vL)), okUnlisted: verdictOk(vL, []), okListed: verdictOk(vL2, listedOnRuling) }),
    JSON.stringify({ unlisted: ["control-ruled q1 142.2 [shape]", "control-ruled q1 142.3 [shape]", "control-ruled q1 711/5 [shape]"], okUnlisted: false, okListed: true }));
}

/* That assertion alone is satisfied whenever old and new AGREE, so it passes
   under a full revert to the tolerance — the 11.4M comparisons above would
   cost a great deal and prove nothing. These pin the sweep's actual content:
   specific entries that must move, and that the two rules must not be the
   same rule. Reverting grading.js turns these red. */
const movedIn = detail => {
  const set = new Set();
  detail.forEach(({ k, changed }) => changed.forEach(c => set.add(k.testId + "|" + k.qid + "|" + c.e)));
  return set;
};
const movedSet = movedIn(diffDetail);
const mustMove = [
  ["202606asiav1", "ma2-q21", "9.955"],   // inside the old +/-0.01, not a legal shortening
  ["202606asiav1", "ma2-q21", "9.97"],
  ["202606asiav1", "ma1-q19", "45.99"],   // integer key, near-miss
  ["202606asiav1", "ma1-q19", "46.01"],
  ["202606asiav1", "ma1-q4",  ".13"],     // 4/31: stops short of the room it had
  ["202606asiav2", "ma1-q9",  "14.32"],   // 43/3
  ["202606asiav1", "ma1-q6",  "255/"],    // malformed; parseFloat used to read a prefix
];
/* the predicate the pin and its control share */
const unmovedOf = detail => { const set = movedIn(detail); return mustMove.filter(m => !set.has(m.join("|"))); };
const notMoved = unmovedOf(diffDetail);
check("the sweep sees the specific entries the fix targets", notMoved.length, 0);
if(notMoved.length) console.log("    missing: " + notMoved.map(m => m.join(" ")).join(", "));
/* the ruled control (a) lands here: the whole library's sweep, with 9.96's
   row swapped for the planted grader's — this pin then fails on exactly 9.97 */
if(changed97 && kQ21){
  const planted = diffDetail.some(d => d.k === kQ21)
    ? diffDetail.map(d => d.k === kQ21 ? { k: kQ21, changed: changed97 } : d)
    : diffDetail.concat([{ k: kQ21, changed: changed97 }]);
  ctl("control: a grader accepting 9.97 for the fitting key 9.96 FAILS the moved-entries pin — exactly 9.97",
    JSON.stringify(unmovedOf(planted).map(m => m.join(" "))),
    JSON.stringify(["202606asiav1 ma2-q21 9.97"]));
}
check("every §4b control ran (" + CONTROLS_EXPECTED + ")", controlsRan, CONTROLS_EXPECTED);

/* and entries that must NOT move — valid shortenings and exact values */
const mustHold = [
  ["202606asiav1", "ma1-q4",  ".129"], ["202606asiav1", "ma1-q4", ".1290"],
  ["202606asiav1", "ma1-q4",  "0.129"], ["202606asiav1", "ma1-q4", "4/31"],
  ["202606asiav1", "ma2-q21", "9.96"], ["202606asiav1", "ma1-q6", "255"],
  ["202606asiav2", "ma1-q9",  "14.33"], ["202606asiav2", "ma1-q9", "43/3"],
];
const wronglyMoved = mustHold.filter(m => movedSet.has(m.join("|")));
check("valid shortenings and exact values are untouched by the change", wronglyMoved.length, 0);
if(wronglyMoved.length) console.log("    moved: " + wronglyMoved.map(m => m.join(" ")).join(", "));
check("the two rules genuinely differ (guards against a silent revert)", totalDiffs > 0, true);
}   // end if(!AUDIT_ONLY)

/* ---------------------------------------------------------------------- */
/* 5. Audit REAL stored attempts.
   Records live in the backend, not in this repo, so this cannot run itself.
   Point it at a dashboard export ("Download all attempts (JSON)") or a single
   attempt's JSON and it reports every stored SPR answer whose grade moves —
   which is the direct answer to "no existing stored attempt score may
   change", and to whether Review Mode's recomputed correctness still agrees
   with the score stored on the record.

       node tests/spr-grading.test.js path/to/attempts-export.json           */
const archivePath = process.argv[2];
console.log("\n--- 5. stored-attempt audit ---");
if(!archivePath){
  console.log("    no archive given — run with a dashboard export to audit real records:");
  console.log("      node tests/spr-grading.test.js path/to/attempts-export.json");
} else {
  const raw = JSON.parse(fs.readFileSync(archivePath, "utf8"));
  /* FAIL CLOSED. This is the gate the deploy decision rests on, so "I could
     not read this file" must never look like "I read it and found nothing".
     Take the first array of plausible records found anywhere in the wrapper
     rather than guessing at key names, and refuse outright if there is none
     or if nothing in it is a record. */
  const looksLikeRecord = r => r && typeof r === "object" && r.answers && r.testId;
  let records = null;
  if(Array.isArray(raw)) records = raw;
  else if(looksLikeRecord(raw)) records = [raw];
  else if(raw && typeof raw === "object"){
    for(const k of Object.keys(raw)){
      if(Array.isArray(raw[k]) && raw[k].some(looksLikeRecord)){ records = raw[k]; break; }
    }
  }
  if(!records || !records.some(looksLikeRecord)){
    console.log(`    CANNOT READ ${archivePath} — no array of attempt records found.`);
    console.log("    Expected a dashboard export: an array of records, or an object");
    console.log("    holding one. Refusing to report a pass on a file I did not parse.");
    fail++; failures.push("archive audit: unreadable export (fails closed by design)");
    console.log(`\nFAIL — ${pass} passed, ${fail} failed`);
    process.exit(1);
  }
  const qIndex = {};
  Object.keys(T).forEach(testId => T[testId].modules.forEach(m => m.questions.forEach(q => {
    qIndex[testId + "|" + q.id] = q;
    (T[testId].legacyIds || []).forEach(l => { qIndex[l + "|" + q.id] = q; });
  })));
  /* Tombstoned records (deleted by the tutor, 2026-09-18): the export
     carries `tombstones` — one {key, value} per deletion marker — and the
     records themselves stay in `records`, byte-identical. A deleted record
     is on no student surface and its grade can never be seen, so it is
     SKIPPED here, and the count is always printed so a skip is never
     silent. A record is tombstoned only by an attempt marker whose target
     names it, or by a student marker for its code. */
  const tombTargets = new Set(), tombCodes = new Set();
  (Array.isArray(raw.tombstones) ? raw.tombstones : []).forEach(t => {
    const v = t && t.value && typeof t.value === "object" ? t.value : t;
    if(!v || v.kind !== "tombstone" || typeof v.target !== "string") return;
    if(v.targetKind === "attempt") tombTargets.add(v.target);
    else if(v.targetKind === "student") tombCodes.add(String(v.target).toUpperCase());
  });
  const isTombstoned = r => tombTargets.has(r.attemptId) ||
    tombCodes.has(String((r.student && r.student.key) || "").toUpperCase());
  let skippedTomb = 0;
  let audited = 0, sprSeen = 0, moved = [], unknown = 0, storedDisagree = [];
  /* Practice-set records (kind:"set", 2026-08-31) are handled EXPLICITLY:
     their answers key by fully-qualified refs and resolve through the
     record's own frozen snapshot (setQuestions provenance) — bank refs into
     the loaded bank exports (append-only: retired qids are still there),
     form refs into the library. An answer that cannot be resolved is an
     unaudited answer and FAILS below, exactly like the not-in-library check
     for form records — passing over it silently would be a fail-open. */
  let setSeen = 0, setUnresolved = 0;
  const setUnresolvedDetail = [];
  records.forEach(r => {
    if(!r || !r.answers || !r.testId) return;
    if(isTombstoned(r)){ skippedTomb++; return; }     // deleted: not audited, counted below
    audited++;
    const isSet = r.kind === "set";
    const provByRef = {};
    if(isSet){
      setSeen++;
      (Array.isArray(r.setQuestions) ? r.setQuestions : []).forEach(e => {
        if(e && typeof e.ref === "string") provByRef[e.ref] = e;
      });
    }
    Object.keys(r.answers).forEach(qid => {
      let q = null;
      if(isSet){
        const e = provByRef[qid];
        if(e && e.source === "bank"){
          const bank = B[e.bankId];
          q = (bank && (bank.questions || []).find(x => x && x.qid === e.qid)) || null;
        } else if(e && e.source === "form"){
          q = qIndex[e.testId + "|" + e.qid] || null;
        }
        if(!q){
          setUnresolved++;
          setUnresolvedDetail.push(((r.student && r.student.key) || "?") + " " + (r.setId || r.testId) + " " + qid);
          return;
        }
      } else {
        q = qIndex[r.testId + "|" + qid];
        if(!q){ unknown++; return; }
      }
      if(q.type !== "spr") return;
      const a = r.answers[qid];
      if(a.given === null || a.given === undefined) return;
      sprSeen++;
      const before = [q.correctAnswer].concat(q.altAnswers || [])
        .some(key => oldSprValueMatches(a.given, key));
      const after = G.answerMatches(q, a.given);
      if(before !== after){
        moved.push({ code: (r.student && r.student.key) || "?", testId: r.testId, qid,
          given: a.given, key: q.correctAnswer, before, after });
      }
      /* the record's own stored verdict vs what review recomputes today */
      if(typeof a.correct === "boolean" && a.correct !== after){
        storedDisagree.push({ code: (r.student && r.student.key) || "?", testId: r.testId, qid,
          given: a.given, stored: a.correct, recomputed: after });
      }
    });
  });
  console.log(`    ${audited} record(s)` +
    (setSeen ? ` (${setSeen} practice-set record(s), resolved via snapshot provenance)` : "") +
    `, ${sprSeen} answered SPR item(s)` +
    (unknown ? `, ${unknown} answer(s) for questions not in the library (skipped)` : ""));
  console.log(`    ${skippedTomb} tombstoned (deleted) record(s) skipped — not audited by design` +
    (skippedTomb ? "; the export's tombstones name them" : ""));
  if(setUnresolved){
    console.log(`    ${setUnresolved} SET answer(s) whose snapshot ref could not be resolved:`);
    setUnresolvedDetail.forEach(d => console.log("      " + d));
  }
  if(!moved.length) console.log("    no stored SPR answer changes grade");
  else {
    console.log(`    ${moved.length} STORED ANSWER(S) CHANGE GRADE:`);
    moved.forEach(m => console.log(`      ${m.code} ${m.testId} ${m.qid}: entered ${JSON.stringify(m.given)} ` +
      `vs key ${JSON.stringify(m.key)} — ${m.before ? "correct" : "wrong"} -> ${m.after ? "correct" : "wrong"}`));
  }
  if(storedDisagree.length){
    console.log(`    ${storedDisagree.length} record(s) where the STORED verdict and the recomputed one differ:`);
    storedDisagree.forEach(d => console.log(`      ${d.code} ${d.testId} ${d.qid}: stored ${d.stored}, recomputed ${d.recomputed}`));
  } else if(sprSeen){
    console.log("    every stored SPR verdict still matches what Review Mode recomputes");
  }
  check("no stored SPR answer changes grade", moved.length, 0);
  check("stored verdicts agree with recomputed ones", storedDisagree.length, 0);
  /* An answer whose test is not in the library was counted and printed but
     never asserted on — so an export for a test this checkout does not carry
     audited nothing and still passed. It cannot be graded here, so it is an
     unaudited answer, and the gate has to say so. */
  check("every stored answer belonged to a test in the library", unknown, 0);
  /* the set analogue of the line above: an unresolvable snapshot ref is an
     unaudited answer, and the gate says so rather than passing over it */
  check("every set-record answer resolved through its snapshot provenance", setUnresolved, 0);
  check("the export actually contained gradable SPR answers", sprSeen > 0, true);
}

console.log(`\n${fail ? "FAIL" : "ALL PASS"} — ${pass} passed, ${fail} failed` +
  (AUDIT_ONLY ? "  [§5 AUDIT ONLY — exhaustive sweep was SKIPPED, not a pre-deploy grading audit]" : ""));
if(failures.length){ console.log("\nFailures:"); failures.forEach(f => console.log("  - " + f)); }
process.exit(fail ? 1 : 0);
