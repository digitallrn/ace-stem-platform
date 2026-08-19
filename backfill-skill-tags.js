#!/usr/bin/env node
/* backfill-skill-tags.js — write `skill` into archived testdata builds so
 * historical attempts' Score Details group by domain instead of "Other".
 *
 * WHY THIS EXISTS: testVersion 2026-08-19-a (commit c873f37) lit up `skill`
 * on ten current forms. Version pinning means every attempt sat before that
 * bump opens on an ARCHIVED build, whose `skill` is still blank. skill is
 * classification metadata about a question, not the question itself, so
 * backfilling it into the archive does not misrepresent what a student saw
 * or answered — content, choices, keys, figures, ordering are untouched.
 *
 * WHAT A RUN DOES (idempotent — safe to re-run any time):
 *   For every archived build listed in testdata/archive/index.js:
 *     1. Load it and its CURRENT tagged source (testdata/<testId>.js).
 *     2. Verify the archive's question ids map 1:1 onto the current build,
 *        in the same per-module order and the same module order. Any
 *        mismatch ABORTS THE ENTIRE RUN (nothing written) — a wrong tag
 *        misinforms a student about their weak areas, so guessing is not
 *        an option here.
 *     3. Per question, decide: already consistent -> no-op; archive blank,
 *        source has a tag -> patch; archive holds a non-blank value that IS
 *        a real skill (skilldomains.js vocabulary) and disagrees with the
 *        source -> ABORT THE ENTIRE RUN (never silently overwrite a real
 *        prior tagging decision); archive holds a non-blank value that is
 *        NOT a real skill (corrupt/junk) -> patch (overwrite allowed), and
 *        logged separately as a junk overwrite for the record.
 *     4. Apply patches via skill-patch.js's applyPatches — a narrow textual
 *        substitution of only the `"skill":` value token per touched
 *        question, so nothing else in the file can move. Independently
 *        re-verified with diffExceptSkill (parse old vs new, assert zero
 *        non-skill differences) before the write is trusted.
 *     5. Record an entry in testdata/archive/skill-backfills.json: which
 *        real git blob the file derives from (so archive-testdata.js
 *        --verify can re-derive and byte-compare, instead of requiring a
 *        direct match no legitimate edit could ever produce) and the exact
 *        patch list applied.
 *
 * `--check` runs the analysis and prints the mapping report + patch plan
 * without writing anything — review this before the real run.
 */
"use strict";
const fs = require("fs");
const path = require("path");
const cp = require("child_process");
const crypto = require("crypto");
const vm = require("vm");
const { applyPatches, diffExceptSkill } = require("./skill-patch.js");

const CHECK = process.argv.indexOf("--check") !== -1;
const ROOT = __dirname;
const TESTDATA = path.join(ROOT, "testdata");
const ARCHIVE = path.join(TESTDATA, "archive");
const MANIFEST_PATH = path.join(ARCHIVE, "skill-backfills.json");
const REG_RE = /window\.__TESTDATA__\[\"([^\"]+)\"\]\s*=\s*(\{[\s\S]*\});\s*$/;

function sha256(buf){ return crypto.createHash("sha256").update(buf).digest("hex"); }

function loadTestFile(file){
  const bytes = fs.readFileSync(file);
  const m = bytes.toString("utf8").match(REG_RE);
  if(!m) throw new Error("no window.__TESTDATA__ registration found in " + file);
  return { bytes, data: JSON.parse(m[2]) };
}

function flatten(data){
  const out = [];
  (data.modules || []).forEach((mod, mi) => {
    (mod.questions || []).forEach((q, qi) => {
      out.push({ modIdx: mi, moduleId: mod.moduleId, qIdx: qi, id: q.id, skill: q.skill == null ? null : q.skill });
    });
  });
  return out;
}

function loadSkillVocab(){
  const src = fs.readFileSync(path.join(ROOT, "skilldomains.js"), "utf8");
  const sandbox = { window: {} };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  const domains = sandbox.window.SKILL_DOMAINS;
  if(!domains || !domains.skillToDomain) throw new Error("could not load SKILL_DOMAINS from skilldomains.js");
  return new Set(Object.keys(domains.skillToDomain));
}

function gitHistoryFor(testId){
  const rel = "testdata/" + testId + ".js";
  let commitsText;
  try{
    commitsText = cp.execFileSync("git", ["log", "--format=%H", "HEAD", "--", rel],
      { cwd: ROOT, maxBuffer: 1 << 26 }).toString("utf8").trim();
  }catch(e){ return []; }
  const out = [];
  for(const c of commitsText ? commitsText.split("\n") : []){
    let blobSha;
    try{ blobSha = cp.execFileSync("git", ["rev-parse", c + ":" + rel], { cwd: ROOT }).toString("utf8").trim(); }
    catch(e){ continue; }
    const bytes = cp.execFileSync("git", ["cat-file", "blob", blobSha], { cwd: ROOT, maxBuffer: 1 << 26 });
    out.push({ commit: c, blobSha, bytes });
  }
  return out;
}

function isBlank(v){ return v == null || v === ""; }

/* ---- load inputs ---- */
const vocab = loadSkillVocab();
const aim = fs.readFileSync(path.join(ARCHIVE, "index.js"), "utf8")
  .match(/window\.TEST_ARCHIVE_INDEX\s*=\s*(\{[\s\S]*\});/);
if(!aim) throw new Error("cannot parse testdata/archive/index.js");
const archiveIndex = JSON.parse(aim[1]);

let manifest = { files: {} };
if(fs.existsSync(MANIFEST_PATH)){
  manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
  if(!manifest.files) manifest.files = {};
}

const mappingReport = [];
const patchPlans = [];
let abort = null;

for(const id of Object.keys(archiveIndex).sort()){
  const currentFile = path.join(TESTDATA, id + ".js");
  if(!fs.existsSync(currentFile)){ console.error("SKIP " + id + ": no current testdata/" + id + ".js"); continue; }
  const { data: current } = loadTestFile(currentFile);
  const currentFlat = flatten(current);
  const currentById = new Map(currentFlat.map(q => [q.id, q]));
  const currentModOrder = current.modules.map(m => m.moduleId);
  const currentIds = currentFlat.map(q => q.id);
  const currentIdSet = new Set(currentIds);

  for(const ver of archiveIndex[id]){
    const file = id + "@" + ver + ".js";
    const af = path.join(ARCHIVE, file);
    if(!fs.existsSync(af)){ console.error("SKIP " + file + ": archive file missing"); continue; }
    const { bytes: archBytes, data: arch } = loadTestFile(af);
    const archFlat = flatten(arch);
    const archModOrder = arch.modules.map(m => m.moduleId);
    const archIds = archFlat.map(q => q.id);
    const archIdSet = new Set(archIds);

    const onlyInArch = archIds.filter(x => !currentIdSet.has(x));
    const onlyInCurrent = currentIds.filter(x => !archIdSet.has(x));
    const setMatches = onlyInArch.length === 0 && onlyInCurrent.length === 0 && archIds.length === currentIds.length;
    const orderMatches = setMatches && archIds.every((x, i) => x === currentIds[i]);
    const modOrderMatches = JSON.stringify(archModOrder) === JSON.stringify(currentModOrder);
    const clean = setMatches && orderMatches && modOrderMatches;

    mappingReport.push({ file, id, ver, archCount: archIds.length, currentCount: currentIds.length,
      setMatches, orderMatches, modOrderMatches, onlyInArch, onlyInCurrent });

    if(!clean){
      abort = "STOP: " + file + " does not map 1:1 onto its tagged source (setMatches=" + setMatches
        + " orderMatches=" + orderMatches + " modOrderMatches=" + modOrderMatches + "). onlyInArch="
        + JSON.stringify(onlyInArch) + " onlyInCurrent=" + JSON.stringify(onlyInCurrent);
      continue; // keep building the report for every other file before aborting
    }

    const patches = [], junkOverwrites = [], leftoverJunk = [], conflicts = [];
    archFlat.forEach(q => {
      const existing = q.skill;
      const targetQ = currentById.get(q.id);
      const target = targetQ ? (targetQ.skill == null ? null : targetQ.skill) : null;
      if(existing === target) return;                       // already consistent
      const existingBlank = isBlank(existing), targetBlank = isBlank(target);
      if(existingBlank && targetBlank) return;                // both blank, different encoding — leave as-is
      if(existingBlank && !targetBlank){ patches.push({ qid: q.id, before: existing, after: target }); return; }
      // existing is non-blank
      if(!vocab.has(existing)){
        if(!targetBlank){ patches.push({ qid: q.id, before: existing, after: target }); junkOverwrites.push(q.id); }
        else leftoverJunk.push({ qid: q.id, existing });
        return;
      }
      conflicts.push({ qid: q.id, existing, target });        // real prior decision that disagrees
    });

    if(conflicts.length){
      abort = "STOP: " + file + " has " + conflicts.length
        + " question(s) with an existing valid-vocabulary skill that disagrees with the tagged source — "
        + "never overwritten: " + JSON.stringify(conflicts);
      continue;
    }

    patchPlans.push({ file, id, ver, archBytes, patches, junkOverwrites, leftoverJunk, currentTestVersion: current.testVersion });
  }
}

console.log("=== mapping report (" + mappingReport.length + " archived file(s)) ===");
mappingReport.forEach(r => console.log(
  (r.setMatches && r.orderMatches && r.modOrderMatches ? "OK  " : "FAIL") +
  "  " + r.file + "   arch=" + r.archCount + " current=" + r.currentCount
));
const allClean = mappingReport.length > 0 && mappingReport.every(r => r.setMatches && r.orderMatches && r.modOrderMatches);
console.log(mappingReport.filter(r => r.setMatches && r.orderMatches && r.modOrderMatches).length
  + "/" + mappingReport.length + " files clean on ids+ordering; all clean: " + allClean);

if(abort){
  console.error("\n" + abort);
  console.error("\nABORTING — nothing written.");
  process.exit(1);
}

console.log("\n=== patch plan ===");
let totalPatches = 0, filesWithChanges = 0;
patchPlans.forEach(p => {
  if(p.patches.length){
    filesWithChanges++; totalPatches += p.patches.length;
    console.log(p.file + ": " + p.patches.length + " patch(es)"
      + (p.junkOverwrites.length ? " (" + p.junkOverwrites.length + " junk overwrite(s): " + p.junkOverwrites.join(", ") + ")" : "")
      + (p.leftoverJunk.length ? " [" + p.leftoverJunk.length + " leftover junk left untouched: " + p.leftoverJunk.map(j => j.qid).join(", ") + "]" : ""));
  } else {
    console.log(p.file + ": already consistent, no-op"
      + (p.leftoverJunk.length ? " [" + p.leftoverJunk.length + " leftover junk: " + p.leftoverJunk.map(j => j.qid).join(", ") + "]" : ""));
  }
});
console.log(filesWithChanges + " file(s) need writes, " + totalPatches + " total question(s) patched.");

if(CHECK){ console.log("\n--check: no files written."); process.exit(0); }

/* ---- apply ---- */
const historyCache = {};
function historyFor(id){ return historyCache[id] || (historyCache[id] = gitHistoryFor(id)); }

let wrote = 0;
for(const p of patchPlans){
  if(!p.patches.length) continue;
  const result = applyPatches(p.archBytes, p.patches);

  const oldObj = JSON.parse(p.archBytes.toString("utf8").match(REG_RE)[2]);
  const newObj = JSON.parse(result.toString("utf8").match(REG_RE)[2]);
  const drift = diffExceptSkill(oldObj, newObj);
  if(drift.length){
    console.error("ABORT " + p.file + ": isolation check found non-skill drift: " + JSON.stringify(drift));
    process.exit(1);
  }

  const srcHist = historyFor(p.id).find(h => Buffer.compare(h.bytes, p.archBytes) === 0);
  if(!srcHist){
    console.error("ABORT " + p.file + ": could not resolve its own pre-backfill bytes to a real git blob — refusing to write");
    process.exit(1);
  }

  fs.writeFileSync(path.join(ARCHIVE, p.file), result);
  wrote++;

  manifest.files[p.file] = {
    testId: p.id,
    testVersion: p.ver,
    sourceCommit: srcHist.commit,
    sourceBlobSha: srcHist.blobSha,
    sourceSha256: sha256(p.archBytes),
    resultSha256: sha256(result),
    backfilledFromTestVersion: p.currentTestVersion,
    appliedAt: new Date().toISOString().slice(0, 10),
    patches: p.patches,
    junkOverwrites: p.junkOverwrites
  };
  console.log("wrote " + p.file + " (" + p.patches.length + " patch(es))");
}

manifest._header = {
  purpose: "Records skill-tag backfills applied to archived testdata builds after testVersion "
    + "2026-08-19-a shipped skill on ten current forms (CLAUDE.md, c873f37). Each entry lets "
    + "archive-testdata.js --verify re-derive a backfilled file's exact bytes from its real "
    + "pre-backfill git blob plus this recorded patch list, since a legitimate skill-only edit "
    + "can never satisfy a direct byte match against history.",
  mappingResult: mappingReport.filter(r => r.setMatches && r.orderMatches && r.modOrderMatches).length
    + "/" + mappingReport.length + " archived files across the tagged tests matched their current "
    + "tagged source 1:1 on question ids, per-module question order, and module order — clean, no "
    + "id-mismatch/reordering STOP condition triggered. (202603asiav1's one archived build has no "
    + "tagged source — its TSV is regressed and it was excluded from the c873f37 tagging pass — so "
    + "it produced zero patches and needed no entry here.)",
  vocabularySource: "skilldomains.js SKILL_DOMAINS (30 fine-skill strings). skill_vocabulary.py does "
    + "not exist in this repo; a pre-existing non-blank skill value is treated as a real prior "
    + "tagging decision (never overwritten) when it is a member of this vocabulary, and as "
    + "corrupt/junk (overwrite allowed) when it isn't.",
  generatedBy: "backfill-skill-tags.js"
};

fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + "\n");
console.log("\nwrote " + wrote + " archive file(s); updated " + MANIFEST_PATH);
