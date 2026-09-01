/* tests/verify-attemptid-key.js — pre-deploy check for the loader's
   attemptId-must-equal-storage-key rule (attempts.js loadForStudent,
   dashboard.js loadFromStorage), against REAL records rather than fixtures.

   Run:  node tests/verify-attemptid-key.js path/to/records.json

   It NEVER writes and NEVER commits — it only reads the file you point it at.
   Keep that file OUT of git (it is student data); the scratchpad or your
   Desktop is fine, the repo tree is not.

   THE PREDICATE the loaders apply:  keep a record iff  record.attemptId === its
   storage key.  A legitimate record always stores under its own attemptId
   (Attempts.save), so the expected result is ZERO drops.  This reports, BY KEY,
   every record the loaders would exclude.

   Two input shapes are accepted:

   1. KEY+VALUE rows (the AUTHORITATIVE input) — an array of
      {key, value:{…}} (or {key, owner_code, value}). This is what
      `AttemptStore.adminSelectAll()` returns and what a Supabase
      `select key, value from records` yields. With keys present the check is
      EXACT: it compares each key to value.attemptId.

   2. A dashboard archive export ({schema, records:[…]}) or a bare array of
      records — VALUES ONLY, no storage keys. The exact predicate CANNOT be
      evaluated from this (the key is exactly what is missing), so this mode
      runs the weaker NECESSARY checks it CAN — every attemptId is a
      well-formed `attempt:` string, and attemptIds are UNIQUE (a duplicate
      means at least one record is stored under a key that isn't its
      attemptId) — and says plainly that it is not the exact check.

   For the exact production answer prefer the SQL one-liner:
     select key, value->>'attemptId' as attempt_id_field
       from records
      where key like 'attempt:%'
        and key is distinct from (value->>'attemptId');
   (expected: 0 rows), or the browser-console snippet over
   AttemptStore.adminSelectAll() (see the review report). */
"use strict";
const fs = require("fs");

const path = process.argv[2];
if(!path){
  console.error("usage: node tests/verify-attemptid-key.js path/to/records.json");
  process.exit(2);
}
let raw;
try{ raw = JSON.parse(fs.readFileSync(path, "utf8")); }
catch(e){ console.error("CANNOT READ " + path + ": " + (e.message || e)); process.exit(2); }

/* find the array of items, whatever the wrapper */
let items = null;
if(Array.isArray(raw)) items = raw;
else if(raw && Array.isArray(raw.records)) items = raw.records;
else if(raw && Array.isArray(raw.rows)) items = raw.rows;
if(!items){
  console.error("Could not find an array of records/rows in " + path + ".");
  console.error("Expected an array, or {records:[…]} / {rows:[…]}.");
  process.exit(2);
}

/* normalise each item to { key, value } — key present only in shape (1) */
const norm = items.map(it => {
  if(it && typeof it === "object" && "value" in it && ("key" in it || "owner_code" in it)){
    return { key: it.key, value: it.value };            // {key, [owner_code,] value}
  }
  return { key: undefined, value: it };                 // a bare record VALUE
});

const hasKeys = norm.some(n => typeof n.key === "string");
const attempts = norm.filter(n => n.value && typeof n.value === "object" &&
  ((n.key ? String(n.key) : String(n.value.attemptId || "")).indexOf("attempt:") === 0));

console.log("read " + items.length + " item(s); " + attempts.length + " attempt record(s).");

let dropped = [], fail = false;

if(hasKeys){
  console.log("input carries storage KEYS — running the EXACT loader predicate.\n");
  attempts.forEach(n => {
    const aid = n.value ? n.value.attemptId : undefined;
    if(aid !== n.key) dropped.push({ key: n.key, attemptId: aid });
  });
  if(dropped.length){
    fail = true;
    console.log("DROPPED " + dropped.length + " record(s) — the loaders would EXCLUDE these:");
    dropped.forEach(d => console.log("  key=" + d.key + "   attemptId=" + JSON.stringify(d.attemptId)));
  } else {
    console.log("ZERO drops — every attempt record's attemptId equals its storage key.");
  }
} else {
  console.log("input is VALUES ONLY (no storage keys) — the exact predicate can't");
  console.log("be evaluated; running the necessary checks it implies.\n");
  const ATTEMPT_RE = /^attempt:[^:]+:\d+:[0-9a-z]+$/i;
  const malformed = attempts.filter(n => !ATTEMPT_RE.test(String(n.value.attemptId || "")));
  const seen = new Map();
  const dups = [];
  attempts.forEach(n => {
    const id = String(n.value.attemptId || "");
    if(seen.has(id)) dups.push(id); else seen.set(id, true);
  });
  if(malformed.length){
    fail = true;
    console.log("MALFORMED attemptId on " + malformed.length + " record(s):");
    malformed.forEach(n => console.log("  attemptId=" + JSON.stringify(n.value.attemptId)));
  } else console.log("every attemptId is a well-formed attempt: string.");
  if(dups.length){
    fail = true;
    console.log("DUPLICATE attemptId(s) — at least one record is stored under a non-matching key:");
    [...new Set(dups)].forEach(id => console.log("  " + id));
  } else console.log("every attemptId is unique.");
  console.log("\nNOTE: this is a NECESSARY-not-sufficient check. For the exact");
  console.log("answer, use the SQL query or the adminSelectAll console snippet");
  console.log("(both carry the storage key this export omits).");
}

console.log("\n" + (fail ? "FOUND RECORDS THE LOADER WOULD DROP — investigate before shipping."
                          : "OK — no record the loader would drop was found in this input."));
process.exit(fail ? 1 : 0);
