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
for(const e of everyEntry()) entries.push(e);
console.log(`    ${entries.length.toLocaleString()} enterable strings`);

/* every SPR key shipped in the library, plus the draft that motivated this */
global.window = {};
require(path.join(repo, "testdata", "202606asiav1.js"));
require(path.join(repo, "testdata", "202606asiav2.js"));
const T = global.window.__TESTDATA__;
const keys = [];
Object.keys(T).forEach(testId => T[testId].modules.forEach(m => m.questions.forEach(q => {
  if(q.type === "spr") keys.push({ testId, qid: q.id, q });
})));
console.log(`    ${keys.length} shipped SPR questions\n`);

let totalDiffs = 0;
const diffDetail = [];
keys.forEach(k => {
  const changed = [];
  entries.forEach(e => {
    const before = [k.q.correctAnswer].concat(k.q.altAnswers || [])
      .some(key => oldSprValueMatches(e, key));
    const after = G.answerMatches(k.q, e);
    if(before !== after) changed.push({ e, before, after });
  });
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

/* The direction of every change matters: the new rule must never turn a
   wrong answer into a right one for a shipped key. Anything moving the other
   way is the fix doing its job, but it still has to be reviewed against
   stored attempts, which is why the list above is printed in full. */
const anyNewlyCorrect = diffDetail.some(({ changed }) => changed.some(c => !c.before && c.after));
check("no shipped key turns a previously-wrong entry into a correct one", anyNewlyCorrect, false);

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
  const records = Array.isArray(raw) ? raw
    : Array.isArray(raw.attempts) ? raw.attempts
    : Array.isArray(raw.records) ? raw.records : [raw];
  const qIndex = {};
  Object.keys(T).forEach(testId => T[testId].modules.forEach(m => m.questions.forEach(q => {
    qIndex[testId + "|" + q.id] = q;
    (T[testId].legacyIds || []).forEach(l => { qIndex[l + "|" + q.id] = q; });
  })));
  let audited = 0, sprSeen = 0, moved = [], unknown = 0, storedDisagree = [];
  records.forEach(r => {
    if(!r || !r.answers || !r.testId) return;
    audited++;
    Object.keys(r.answers).forEach(qid => {
      const q = qIndex[r.testId + "|" + qid];
      if(!q){ unknown++; return; }
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
  console.log(`    ${audited} record(s), ${sprSeen} answered SPR item(s)` +
    (unknown ? `, ${unknown} answer(s) for questions not in the library (skipped)` : ""));
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
}

console.log(`\n${fail ? "FAIL" : "ALL PASS"} — ${pass} passed, ${fail} failed`);
if(failures.length){ console.log("\nFailures:"); failures.forEach(f => console.log("  - " + f)); }
process.exit(fail ? 1 : 0);
