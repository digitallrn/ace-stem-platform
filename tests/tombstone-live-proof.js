/* tests/tombstone-live-proof.js — run against the REAL Supabase project:
       SUPABASE_URL=https://<ref>.supabase.co SUPABASE_PUBLISHABLE_KEY=sb_publishable_… node tests/tombstone-live-proof.js
   (or SUPABASE_ANON_KEY for a legacy key; or leave both unset and it reads
   config.js if that file holds real values). Optional: --deleted-code
   AS-XXXXXXXX (a code you have deleted) proves the student RPCs refuse it;
   --after-probe-b (or --deleted-attempt <key>) proves a DELETED SITTING
   refuses the write a device still holding it would make — the in-progress
   protection, exercisable with nothing but the anon key.

   The Phase H proofs (PHASE-H-SPEC §8) were run from the browser console:
   "confirm the anon key cannot select/insert/update/delete records directly
   — only the RPCs work". This is that proof for the tombstone surface,
   scriptable: holding ONLY the anon key (what every student holds), the
   caller must be refused by fn_tombstone_attempt, fn_tombstone_student and
   the internal fn_tombstone_attempt_any, and by every REST verb on tomb:
   rows — while a student RPC still answers, so a refusal is a refusal and
   not a dead endpoint. Nothing here can create, change or remove anything:
   every call is expected to be refused, and the control reads a code that
   exists nowhere.

   FAILS CLOSED: if the tombstone functions do not exist (404 / PGRST202)
   the migration has not been applied and this reports MIGRATION NOT
   APPLIED, which is a failure, not a pass. The one thing it cannot prove is
   the positive half — that an AUTHENTICATED tutor session IS allowed — and
   the migration file names the one-click human check for that. */
"use strict";
const fs = require("fs");
const path = require("path");

const args = process.argv.slice(2);
const argOf = flag => { const i = args.indexOf(flag); return i === -1 ? null : args[i + 1]; };
let URL_ = process.env.SUPABASE_URL || null;
let KEY = process.env.SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_ANON_KEY || null;
if(!URL_ || !KEY){
  try{
    const cfg = fs.readFileSync(path.join(__dirname, "..", "config.js"), "utf8");
    const u = /"SUPABASE_URL"\s*:\s*"([^"]+)"/.exec(cfg), k = /"SUPABASE_ANON_KEY"\s*:\s*"([^"]+)"/.exec(cfg);
    if(u && k && !/stub|YOUR-/.test(u[1] + k[1])){ URL_ = URL_ || u[1]; KEY = KEY || k[1]; }
  }catch(e){}
}
if(!URL_ || !KEY){
  console.log("No project: set SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY (or SUPABASE_ANON_KEY), or fill config.js.");
  console.log("Nothing was proven.");
  process.exit(2);
}
if(/sb_secret|service_role/.test(KEY)){ console.log("REFUSING to run with a secret/service_role key — this proof is about what the ANON key can do."); process.exit(2); }
URL_ = URL_.replace(/\/+$/, "");

let pass = 0, fail = 0;
const failures = [];
function check(ok, label, detail){
  if(ok){ pass++; console.log("PASS | " + label); }
  else { fail++; failures.push(label + (detail ? " — " + detail : ""));
         console.log("FAIL | " + label + (detail ? " — " + detail : "")); }
}
async function call(method, pathAndQuery, body, headers){
  const res = await fetch(URL_ + pathAndQuery, {
    method: method,
    headers: Object.assign({ "apikey": KEY, "Authorization": "Bearer " + KEY, "Content-Type": "application/json" }, headers || {}),
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await res.text();
  let data = null; try{ data = text ? JSON.parse(text) : null; }catch(e){ data = text; }
  return { status: res.status, data: data, message: (data && (data.message || data.error)) || "", code: (data && data.code) || "" };
}
const rpc = (fn, args) => call("POST", "/rest/v1/rpc/" + fn, args);
const refused = r => r.status === 401 || r.status === 403 || (r.status === 400 && /permission denied/i.test(r.message));
const notFound = r => r.status === 404 || /PGRST202/.test(r.code) || /could not find the function/i.test(r.message);
const say = r => r.status + " " + (r.code ? r.code + " " : "") + String(r.message).slice(0, 90);

(async () => {
  console.log("Project: " + URL_ + "  (anon key ending …" + KEY.slice(-6) + ")\n");

  /* ---- 0. the endpoint is alive and the student RPCs answer (control) ---- */
  const ctrl = await rpc("fn_get_own_attempts", { p_code: "AS-ZZZZZZZZ" });     // valid shape, exists nowhere
  check(ctrl.status === 200 && Array.isArray(ctrl.data) && ctrl.data.length === 0,
    "control: a student RPC answers the anon key (empty list for a code that exists nowhere)", say(ctrl));
  const bad = await rpc("fn_get_assignments", { p_code: "nope" });
  check(bad.status === 400 && /invalid code/.test(bad.message), "control: the student RPC's own refusal is visible as a 400 'invalid code'", say(bad));

  /* ---- 1. the tombstone functions exist and refuse anon ---- */
  const ta = await rpc("fn_tombstone_attempt", { p_key: "attempt:202606asiav1:1:zzzz" });
  if(notFound(ta)){
    check(false, "MIGRATION NOT APPLIED — fn_tombstone_attempt does not exist on this project (apply supabase/migrations/2026-09-18_tombstones.sql)", say(ta));
  } else {
    check(refused(ta), "anon cannot call fn_tombstone_attempt (permission denied)", say(ta));
  }
  const ts = await rpc("fn_tombstone_student", { p_code: "AS-ZZZZZZZZ" });
  if(notFound(ts)) check(false, "MIGRATION NOT APPLIED — fn_tombstone_student does not exist", say(ts));
  else check(refused(ts), "anon cannot call fn_tombstone_student (permission denied)", say(ts));
  const tany = await rpc("fn_tombstone_attempt_any", { p_key: "attempt:202606asiav1:1:zzzz", p_reason: "student" });
  if(notFound(tany)) check(false, "MIGRATION NOT APPLIED — fn_tombstone_attempt_any does not exist", say(tany));
  else check(refused(tany), "anon cannot call the internal fn_tombstone_attempt_any (permission denied)", say(tany));
  const helper = await rpc("fn_student_deleted", { p_code: "AS-ZZZZZZZZ" });
  check(refused(helper) || notFound(helper), "anon cannot call the fn_student_deleted helper directly", say(helper));

  /* ---- 2. no REST verb on tomb: rows for anon (RLS: no anon policy, no privileges) ---- */
  const sel = await call("GET", "/rest/v1/records?select=key&key=like.tomb%3A*");
  check(!(sel.status >= 200 && sel.status < 300), "anon cannot SELECT tomb: rows through REST", say(sel));
  const ins = await call("POST", "/rest/v1/records", [{ key: "tomb:attempt:proof:0:zzzz", owner_code: "AS-ZZZZZZZZ",
    value: { kind: "tombstone", targetKind: "attempt", target: "attempt:proof:0:zzzz" } }], { "Prefer": "return=minimal" });
  check(!(ins.status >= 200 && ins.status < 300), "anon cannot INSERT a tomb: row through REST", say(ins));
  const upd = await call("PATCH", "/rest/v1/records?key=like.tomb%3A*", { value: {} }, { "Prefer": "return=minimal" });
  check(!(upd.status >= 200 && upd.status < 300), "anon cannot UPDATE tomb: rows through REST", say(upd));
  const del = await call("DELETE", "/rest/v1/records?key=like.tomb%3A*", undefined, { "Prefer": "return=minimal" });
  check(!(del.status >= 200 && del.status < 300), "anon cannot DELETE tomb: rows through REST", say(del));

  /* ---- 3. the student write RPC cannot mint a tomb: key ---- */
  const forged = await rpc("fn_upsert_attempt", { p_code: "AS-ZZZZZZZZ", p_key: "tomb:attempt:proof:0:zzzz", p_value: { kind: "tombstone" } });
  check(forged.status === 400 && /invalid attempt key/.test(forged.message), "fn_upsert_attempt refuses a tomb: key ('invalid attempt key')", say(forged));

  /* ---- 3b. a DELETED ATTEMPT refuses the write a device still holding that
     sitting would make. This is the in-progress protection, and it IS
     anon-exercisable: fn_upsert_attempt is the student path, and the tomb
     check fires before any write, so nothing is created.
     Guarded behind --after-probe-b because it needs a marker to already
     exist: probe B (see the migration header) leaves tomb:attempt:probe:0:zzzz
     in the table for ever, naming no real student. WITHOUT that marker the
     same call would INSERT a junk row, so it is skipped rather than risked. */
  const probeKey = argOf("--deleted-attempt") || "attempt:probe:0:zzzz";
  if(args.indexOf("--after-probe-b") !== -1 || argOf("--deleted-attempt")){
    const r = await rpc("fn_upsert_attempt", { p_code: "AS-ZZZZZZZZ", p_key: probeKey, p_value: { status: "in-progress" } });
    check(r.status === 400 && r.message === "attempt deleted",
      "a device still holding a DELETED sitting is refused its write with exactly 'attempt deleted' (the terminal refusal the client drops on)", say(r));
    /* The ONLY outcome in which the insert was actually reached: no marker
       existed, so this call CREATED a row. Say so loudly and hand over the
       cleanup — a silent junk row in live data is worse than a red check. */
    if(r.status >= 200 && r.status < 300){
      fail++; failures.push("this run WROTE A ROW — see the cleanup line above");
      console.log("  !! NO MARKER EXISTED for " + probeKey + ": this call CREATED a live row. Probe B was not run first.");
      console.log("     Remove it in the SQL editor (it is not a tomb: row, so the trigger allows this):");
      console.log("       delete from records where key = '" + probeKey + "';");
      console.log("     Then run human probe B and re-run this proof.");
    } else {
      const after = await call("GET", "/rest/v1/records?select=key&key=eq." + encodeURIComponent(probeKey));
      check(!(after.status >= 200 && after.status < 300), "…and anon still cannot read the table to check (the refusal came from the RPC, not from a read)", say(after));
    }
  } else {
    console.log("skip | --after-probe-b not given: the 'attempt deleted' refusal was not exercised.");
    console.log("       Run human probe B first (it leaves a permanent marker naming no student), then re-run with --after-probe-b.");
    console.log("       Without an existing marker the same call would CREATE a row, so it is skipped rather than risked.");
  }

  /* ---- 4. optional: a code David has deleted is refused everywhere ---- */
  const dc = argOf("--deleted-code");
  if(dc){
    for(const [fn, a] of [["fn_get_assignments", { p_code: dc }], ["fn_get_own_attempts", { p_code: dc }], ["fn_get_profile", { p_code: dc }],
                          ["fn_get_set", { p_code: dc, p_set_id: "pset-none" }], ["fn_insert_bug", { p_code: dc, p_value: { text: "proof" } }],
                          ["fn_upsert_attempt", { p_code: dc, p_key: "attempt:proof:0:zzzz", p_value: { status: "in-progress" } }]]){
      const r = await rpc(fn, a);
      check(r.status === 400 && r.message === "student deleted", fn + " refuses the deleted code with exactly 'student deleted'", say(r));
    }
  } else {
    console.log("skip | --deleted-code not given: the 'student deleted' refusals were not exercised live");
  }

  console.log(`\n${fail ? "FAIL" : "ALL PASS"} — ${pass} passed, ${fail} failed`);
  if(failures.length){ console.log("Failures:"); failures.forEach(f => console.log("  - " + f)); }
  console.log("\nNot provable from here: that an AUTHENTICATED tutor session IS allowed to call the tombstone RPCs — see the one-click human check in the migration header.");
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error("HARNESS ERROR:", e && e.stack || e); process.exit(2); });
