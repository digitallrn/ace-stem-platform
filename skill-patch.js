#!/usr/bin/env node
/* skill-patch.js — the SINGLE deterministic transform used to both APPLY and
 * VERIFY a skill-tag backfill on an archived testdata build. Shared by
 * backfill-skill-tags.js (apply) and archive-testdata.js (re-derive during
 * --verify) so apply-time and verify-time logic can never drift apart —
 * there is exactly one implementation of "how a patch turns source bytes
 * into result bytes".
 *
 * applyPatches(sourceBytes, patches) -> Buffer
 *   patches: [{qid, before, after}]  (before/after are raw `skill` JS values:
 *   null or a string — never anything else, since that's the only shape the
 *   `skill` field takes in testdata.)
 *
 * The patch is applied against RAW TEXT with two narrow anchors — it never
 * parses/re-serializes JSON, so nothing else in the file can move, not even
 * whitespace. This is what makes "skill is the only field that moved"
 * provable by construction rather than merely by testing. Throws (no partial
 * application — the caller must not write anything from a thrown call) if:
 *   - the `"id": "<qid>"` anchor is not found, or is found more than once
 *   - no `"skill":` token follows it before the next `"id":` token
 *   - the skill token's current value does not equal JSON.stringify(before)
 *   - the skill value is neither `null` nor a JSON string
 *
 * diffExceptSkill(oldObj, newObj) -> [{path, oldVal, newVal}]
 *   Independent, second line of proof: a generic deep-diff over the PARSED
 *   objects, with only paths ending in `.modules.<n>.questions.<n>.skill`
 *   filtered out. A non-empty result after applyPatches means something
 *   other than skill moved — the isolation guard's positive control.
 */
"use strict";

function escapeRe(s){ return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

function applyPatches(sourceBytes, patches){
  let text = sourceBytes.toString("utf8");
  for(const p of patches){
    const idAnchor = "\"id\": \"" + p.qid + "\"";
    const idRe = new RegExp(escapeRe(idAnchor), "g");
    const idMatches = [...text.matchAll(idRe)];
    if(idMatches.length === 0) throw new Error("qid not found: " + p.qid);
    if(idMatches.length > 1) throw new Error("qid found " + idMatches.length + " times (not unique): " + p.qid);
    const idIdx = idMatches[0].index;
    const afterId = text.slice(idIdx + idAnchor.length);
    const skillOffset = afterId.indexOf("\"skill\":");
    const nextIdOffset = afterId.indexOf("\"id\":");
    if(skillOffset === -1) throw new Error("no skill key found after qid: " + p.qid);
    if(nextIdOffset !== -1 && nextIdOffset < skillOffset)
      throw new Error("skill key not found within qid's own question object: " + p.qid);

    const skillKeyStart = idIdx + idAnchor.length + skillOffset;
    let cursor = skillKeyStart + "\"skill\":".length;
    if(text[cursor] === " ") cursor++;

    let valueEnd, currentRaw;
    if(text.startsWith("null", cursor)){
      valueEnd = cursor + 4;
      currentRaw = "null";
    } else if(text[cursor] === "\""){
      let i = cursor + 1;
      while(i < text.length){
        if(text[i] === "\\"){ i += 2; continue; }
        if(text[i] === "\""){ i++; break; }
        i++;
      }
      valueEnd = i;
      currentRaw = text.slice(cursor, valueEnd);
    } else {
      throw new Error("skill value is neither null nor a string for qid: " + p.qid);
    }

    const expectedBeforeRaw = JSON.stringify(p.before === undefined ? null : p.before);
    if(currentRaw !== expectedBeforeRaw){
      throw new Error("skill value for " + p.qid + " is " + currentRaw
        + ", expected recorded before " + expectedBeforeRaw);
    }
    const afterRaw = JSON.stringify(p.after === undefined ? null : p.after);
    text = text.slice(0, cursor) + afterRaw + text.slice(valueEnd);
  }
  return Buffer.from(text, "utf8");
}

function deepDiff(a, b, pathStr, out){
  pathStr = pathStr || "";
  out = out || [];
  if(a === b) return out;
  const bothObj = a && b && typeof a === "object" && typeof b === "object";
  if(!bothObj){
    out.push({ path: pathStr, oldVal: a, newVal: b });
    return out;
  }
  const aIsArr = Array.isArray(a), bIsArr = Array.isArray(b);
  if(aIsArr !== bIsArr){ out.push({ path: pathStr, oldVal: a, newVal: b }); return out; }
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  keys.forEach(k => { deepDiff(a[k], b[k], pathStr + "." + k, out); });
  return out;
}

const SKILL_PATH_RE = /\.modules\.\d+\.questions\.\d+\.skill$/;
function diffExceptSkill(oldObj, newObj){
  return deepDiff(oldObj, newObj).filter(d => !SKILL_PATH_RE.test(d.path));
}

module.exports = { applyPatches, deepDiff, diffExceptSkill };
