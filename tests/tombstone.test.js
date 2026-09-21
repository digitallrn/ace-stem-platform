/* tests/tombstone.test.js — run: node tests/tombstone.test.js (repo root)

   Tutor-side deletion is a TOMBSTONE (2026-09-18): a separate marker row
   (tomb:<attemptKey>, tomb:student:<CODE>) written only by the tutor through
   the server's authenticated RPCs; the record itself is never edited or
   removed. This suite is the injection-style proof for the five properties
   the feature promised, EACH WITH A CONTROL that shows the check fails when
   its protection is taken away (a check that cannot fail proves nothing):

     (a) a student session cannot tombstone anything — no student write path
         carries a tomb: key or calls fn_tombstone_*; and the SQL contract
         grants those functions to `authenticated` only;
     (b) anon cannot — the same SQL contract (the live half is
         tests/tombstone-live-proof.js, run against the real project);
     (c) a tombstoned attempt is absent from every student surface and
         present-but-marked in the dashboard;
     (d) the assignment-completion logic keeps a deleted completed attempt's
         assignment CLOSED (the 25ef8f7 reopen bug), never resumes a deleted
         sitting, and never lets an untagged deleted sitting close a later
         assignment — on the student home AND the dashboard, in agreement;
     (e) the SPR audit skips tombstoned records and says how many;
     plus the two things the client must do for the above to hold:
     (f) the sync queue drops a write the server refuses as deleted (exactly
         that, nothing else) and the pill knows;
     (g) sign-in fails closed for a deleted code on every entry, offline
         cache fallback included, without deleting anything on the device;
     (h) the confirmation gate, and no bulk / no hard-delete path anywhere in
         the feature (source sweeps).

   attempts.js is vm-loaded whole (as tests/local-mode.test.js does); app.js
   and dashboard.js functions are pulled out by source text (as
   tests/assignment-delete.test.js and tests/tutor-writes.test.js do). */
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const os = require("os");
const { execFileSync } = require("child_process");
const { extractFn, extractConst } = require("./extract-helper");

const repo = path.join(__dirname, "..");
/* sources are read with LF endings whatever the checkout produced (a Windows
   clone with core.autocrlf=true holds CRLF): the SQL controls below splice
   exact multi-line text, and must not depend on the line-ending mode */
const readLf = p => fs.readFileSync(p, "utf8").replace(/\r\n/g, "\n");
const attemptsSrc = readLf(path.join(repo, "attempts.js"));
const appSrc = readLf(path.join(repo, "app.js"));
const dashSrc = readLf(path.join(repo, "dashboard.js"));
/* The LIVE definition of each function is whichever migration re-creates it
   LAST (same rule tests/set-release-rule.test.js applies). The contract is
   checked against the tombstone migration's text AND against the newest
   defining file for every function it covers, so a later migration that
   restated a student RPC without its gate reds this suite instead of
   silently shipping. */
const MIG_DIR = path.join(repo, "supabase", "migrations");
const MIGRATION = path.join(MIG_DIR, "2026-09-18_tombstones.sql");
const sqlSrc = readLf(MIGRATION);
function newestDefining(fn){
  const files = fs.readdirSync(MIG_DIR).filter(f => /\.sql$/.test(f)).sort()
    .filter(f => new RegExp("create or replace function public\\." + fn + "\\s*\\(").test(readLf(path.join(MIG_DIR, f))));
  return files.length ? files[files.length - 1] : null;
}

let pass = 0, fail = 0;
const failures = [];
function check(ok, label, detail){
  if(ok){ pass++; console.log("PASS | " + label); }
  else { fail++; failures.push(label + (detail ? " — " + detail : ""));
         console.log("FAIL | " + label + (detail ? " — " + detail : "")); }
}
async function run(title, fn){
  console.log("--- " + title + " ---");
  try{ await fn(); }
  catch(e){ check(false, "case could not run — " + (e && e.stack || e)); }
}

const CODE = "AS-7K4M9PXR", OTHER = "AS-JKLMNPQR";
const REAL_CFG = { SUPABASE_URL: "https://example-ref.supabase.co", SUPABASE_ANON_KEY: "sb_publishable_testkey" };

/* ---------- attempts.js in a sandbox ---------- */
function loadAttempts(opts){
  opts = opts || {};
  const store = {};
  const timers = [];
  const warns = [];
  const fetches = [];
  const sandbox = {
    localStorage: {
      _d: {}, setItem(k, v){ this._d[k] = String(v); }, getItem(k){ return k in this._d ? this._d[k] : null; },
      removeItem(k){ delete this._d[k]; }, key(i){ return Object.keys(this._d)[i]; },
      get length(){ return Object.keys(this._d).length; }
    },
    location: { search: opts.search || "" },
    document: { addEventListener(){}, createElement: () => ({}) },
    navigator: { userAgent: "node", onLine: opts.online !== false },
    screen: { width: 1, height: 1 },
    hasKey: () => false, answerMatches: () => false,
    console: { warn: (...a) => warns.push(a.join(" ")), log(){}, error(){} },
    setInterval: () => 0, clearInterval(){},
    setTimeout: (fn) => { timers.push(fn); return timers.length; }, clearTimeout(){},
    AbortController: function(){ this.signal = {}; this.abort = () => {}; },
    fetch: async (url, o) => {
      fetches.push({ url: String(url), body: o && o.body ? JSON.parse(o.body) : null, headers: (o && o.headers) || {} });
      const r = opts.fetch ? await opts.fetch(String(url), o) : { status: 500, body: { message: "network blocked in test" } };
      return { ok: r.status >= 200 && r.status < 300, status: r.status, text: async () => JSON.stringify(r.body === undefined ? null : r.body) };
    }
  };
  sandbox.window = sandbox;
  sandbox.addEventListener = () => {};
  if(opts.config) sandbox.ACESTEM_CONFIG = opts.config;
  if(opts.sharedStorage){
    const throwOn = (opts.sharedStorage && opts.sharedStorage.throwOn) || null;   // RegExp: keys whose get() throws
    sandbox.storage = {
      async set(k, v){ store[k] = v; return true; },
      async get(k){ if(throwOn && throwOn.test(k)) throw new Error("storage blip"); return k in store ? { value: store[k] } : null; },
      async list(p){ return { keys: Object.keys(store).filter(k => k.startsWith(p)) }; },
      async delete(k){ delete store[k]; return true; }
    };
  }
  vm.createContext(sandbox);
  vm.runInContext(attemptsSrc, sandbox);
  const flush = async () => {
    const t = timers.splice(0);
    for(const f of t) f();
    for(let i = 0; i < 20; i++) await new Promise(r => setImmediate(r));
  };
  return { AS: sandbox.AttemptStore, AT: sandbox.Attempts, ls: sandbox.localStorage, store, timers, warns, fetches, flush, sandbox };
}
const seedLocal = (ls, key, obj) => ls.setItem("devstore:" + key, JSON.stringify(obj));
const rec = (id, o) => Object.assign({ attemptId: id, recordVersion: 1, student: { code: CODE, key: CODE }, testId: "t1", testName: "T1",
  testVersion: "v1", assignmentId: "a1", timing: 1, conditions: "self-administered", startedAt: "2026-09-01T00:00:00.000Z",
  submittedAt: "2026-09-01T02:00:00.000Z", status: "completed", released: true, modules: [], answers: { q1: { given: 0 } },
  score: { correct: 1, graded: 1 } }, o || {});
const tomb = (target, o) => Object.assign({ kind: "tombstone", targetKind: "attempt", target: target, code: CODE,
  deletedAt: "2026-09-18T10:00:00.000Z", deletedBy: "tutor@example", reason: "attempt", testId: "t1", assignmentId: "a1",
  status: "completed", attemptKind: "form", setId: null, conditions: "self-administered",
  startedAt: "2026-09-01T00:00:00.000Z", submittedAt: "2026-09-01T02:00:00.000Z" }, o || {});
const studentTomb = (code) => ({ kind: "tombstone", targetKind: "student", target: code, code: code,
  deletedAt: "2026-09-18T10:00:00.000Z", deletedBy: "tutor@example", attemptsTombstoned: 1, hadProfile: false });

/* ---------- app.js functions with a plain state object ---------- */
const APP_FNS = ["archivedVersions", "canServeVersion", "testById", "attemptCompleted", "attemptResumable", "canonTestId",
  "isLegacyAssign", "categoryMatchesConditions", "buildAssignmentIndex", "assignmentComplete", "assignmentState",
  "isSetAssign", "setAttemptResumable", "canServeBank", "bankById", "isTombstonedRecord"];
const APP_CONSTS = ["TESTCACHE_PREFIX", "byStartDesc", "BANKCACHE_PREFIX"];
function appWorld(state, windowExtra){
  const body = APP_CONSTS.map(n => extractConst(appSrc, n)).join("\n") + "\n\n" +
    APP_FNS.map(n => extractFn(appSrc, n)).join("\n\n") +
    "\nreturn { buildAssignmentIndex, assignmentComplete, assignmentState, isTombstonedRecord, attemptResumable };";
  const window = Object.assign({ TEST_ARCHIVE_INDEX: undefined, __TESTDATA__: {} }, windowExtra || {});
  return new Function("state", "window", "localStorage", body)(state, window, { getItem: () => null });
}

/* ---------- dashboard.js functions with plain module state ---------- */
const DASH_FNS = ["tombFor", "isDeletedStudent", "isTombstoned", "orphanStubs", "deleteGateOk", "statusBadge", "nameFor",
  "studentCell", "codeOptionLabel", "isFinishedAttempt", "isDeletableAttempt", "fmtDate", "num", "cnt", "countPair",
  "scoreStr", "scorePct", "timingLabel", "timingBadgeHtml", "releaseCell", "viewAttempts", "sortVal",
  "sameTest", "assignCountFor", "attemptCategoryMatches", "attemptsForAssignment", "assignRowStatus",
  "assignmentsAtDeletionOf", "deletedMayClose", "assignmentsAtDeletion", "localTombstone",
  "completedAttemptsOf", "deletedAttemptsOf", "seenCaveat", "knownCodeSet", "generateUnusedCode"];
function dashWorld(seed, genSeq){
  const body = "const testsById = {};\n" + DASH_FNS.map(n => extractFn(dashSrc, n)).join("\n\n") +
    "\nreturn { " + DASH_FNS.join(", ") + ", set(o){ Object.assign(S, o); tombs = S.tombs; recs = S.recs; assigns = S.assigns; profiles = S.profiles; source = S.source; } };";
  const esc = s => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const escAttr = s => esc(s).replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  const seq = (genSeq || []).slice();
  const StudentCode = {
    valid: c => /^AS-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/.test(String(c || "").trim().toUpperCase()),
    normalize: c => String(c || "").trim().toUpperCase().replace(/\s+/g, ""),
    /* scripted, so a case can force Generate to draw a retired code first */
    generate: () => { if(!seq.length) throw new Error("StudentCode.generate called more times than scripted"); return seq.shift(); }
  };
  const els = {};
  const $ = id => els[id] || (els[id] = { value: "", textContent: "" });
  const factory = new Function("S", "esc", "escAttr", "StudentCode", "$", "Date",
    "let tombs = S.tombs, recs = S.recs, assigns = S.assigns, profiles = S.profiles, source = S.source, sortKey = 'startedAt', sortDir = -1;\n" + body);
  const S = Object.assign({ tombs: {}, recs: [], assigns: [], profiles: {}, source: "storage" }, seed || {});
  return factory(S, esc, escAttr, StudentCode, $, Date);
}

/* ---------- the SQL contract, as a checker that returns its failures ---------- */
/* The contract reads CODE, not prose: comments are stripped first, so a gate,
   grant, role check or trigger that only exists inside a comment cannot
   satisfy a clause. A small scanner rather than regexes: Postgres block
   comments NEST, and a `--` inside a string literal is not a comment. */
function stripSql(s){
  let out = "", i = 0;
  while(i < s.length){
    const c = s[i], n = s[i + 1];
    if(c === "'"){                                    // string literal ('' escapes a quote)
      let j = i + 1;
      while(j < s.length){ if(s[j] === "'"){ if(s[j + 1] === "'"){ j += 2; continue; } break; } j++; }
      out += s.slice(i, j + 1); i = j + 1; continue;
    }
    if(c === "$" && n === "$"){                       // dollar-quoted body: keep, but strip comments INSIDE it too
      out += "$$"; i += 2; continue;
    }
    if(c === "-" && n === "-"){ while(i < s.length && s[i] !== "\n") i++; continue; }
    if(c === "/" && n === "*"){
      let depth = 1; i += 2;
      while(i < s.length && depth){ if(s[i] === "/" && s[i + 1] === "*"){ depth++; i += 2; } else if(s[i] === "*" && s[i + 1] === "/"){ depth--; i += 2; } else i++; }
      continue;
    }
    out += c; i++;
  }
  return out;
}
function fnBody(sql, name){
  const re = new RegExp("create or replace function public\\." + name + "\\s*\\(");
  const m = re.exec(sql);
  if(!m) return null;
  const end = sql.indexOf("\n$$;", m.index);
  return end === -1 ? sql.slice(m.index) : sql.slice(m.index, end + 4);
}
function sqlContract(sql){
  sql = stripSql(sql);
  const out = [];
  const tutorFns = ["fn_tombstone_attempt", "fn_tombstone_student"];
  const sigs = { fn_tombstone_attempt: "fn_tombstone_attempt(text)", fn_tombstone_student: "fn_tombstone_student(text)",
    fn_tombstone_attempt_any: "fn_tombstone_attempt_any(text, text)" };
  const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  for(const fn of tutorFns.concat(["fn_tombstone_attempt_any"])){
    const body = fnBody(sql, fn);
    if(!body){ out.push(fn + ": not defined"); continue; }
    if(!/security definer/.test(body)) out.push(fn + ": not security definer");
    if(!/set search_path = public, pg_temp/.test(body)) out.push(fn + ": search_path not pinned");
    if(!/<> 'authenticated' then\s*\n?\s*raise exception/.test(body)) out.push(fn + ": no in-function authenticated-role check");
    if(/\bdelete\s+from\b/i.test(body)) out.push(fn + ": contains DELETE FROM");
    if(/\bupdate\s+public\.records\b/i.test(body) || /do update/i.test(body)) out.push(fn + ": contains an UPDATE of records");
    if(!/on conflict \(key\) do nothing/.test(body) && fn !== "fn_tombstone_attempt") out.push(fn + ": marker insert is not ON CONFLICT DO NOTHING");
    const sig = esc("public." + sigs[fn]);
    if(!new RegExp("revoke all on function " + sig + "\\s+from public, anon, authenticated(, service_role)?;").test(sql)) out.push(fn + ": EXECUTE not revoked from public/anon/authenticated first");
    const grants = sql.match(new RegExp("grant execute on function " + sig + "\\s+to ([^;]+);", "g")) || [];
    if(fn === "fn_tombstone_attempt_any"){
      if(grants.length) out.push(fn + ": internal function must have NO grant, has " + grants.join(" | "));
    } else {
      if(grants.length !== 1) out.push(fn + ": expected exactly one grant, found " + grants.length);
      if(!grants.every(g => /to authenticated;$/.test(g))) out.push(fn + ": granted to something other than authenticated alone: " + grants.join(" | "));
    }
  }
  if(!/'attempt'\)/.test(fnBody(sql, "fn_tombstone_attempt") || "")) out.push("fn_tombstone_attempt: does not pin reason 'attempt'");
  /* the untagged-record rule: which assignments existed at deletion, computed
     for records WITHOUT an assignmentId, by owner + exact testId, sentinel
     excluded by exact key (not a LIKE pattern — `_` is a wildcard) */
  const anyBody = fnBody(sql, "fn_tombstone_attempt_any") || "";
  const vat = /if v_rec\.value ->> 'assignmentId' is null([\s\S]*?)end if;/.exec(anyBody);
  if(!vat) out.push("fn_tombstone_attempt_any: no assignmentsAtDeletion block for untagged records");
  else {
    const b = vat[1];
    /* the list means "these assignments may stay closed", so it is only
       recorded for a FINISHED record — an in-progress one closes nothing */
    if(!/and coalesce\(v_rec\.value ->> 'status', ''\) in \('completed', 'timed-out'\) then/.test(b))
      out.push("assignmentsAtDeletion: not restricted to finished records");
    if(!/jsonb_agg\(split_part\(a\.key, ':', 3\)/.test(b)) out.push("assignmentsAtDeletion: does not collect assignment ids");
    if(!/a\.owner_code = v_owner/.test(b) || !/a\.key like 'assign:' \|\| v_owner \|\| ':%'/.test(b)) out.push("assignmentsAtDeletion: not scoped to the owner's assignment rows");
    if(!/a\.value ->> 'testId' = v_rec\.value ->> 'testId'/.test(b)) out.push("assignmentsAtDeletion: not scoped to the record's testId");
    if(!/a\.key <> 'assign:' \|\| v_owner \|\| ':__none'/.test(b) || /not like '%:__none'/.test(b)) out.push("assignmentsAtDeletion: the __none sentinel is not excluded by exact key");
  }
  if(!/'assignmentsAtDeletion', v_at\)/.test(anyBody)) out.push("fn_tombstone_attempt_any: the marker does not carry assignmentsAtDeletion");
  if(/p_reason/.test((fnBody(sql, "fn_tombstone_attempt") || "").split("as $$")[0])) out.push("fn_tombstone_attempt: exposes a reason argument");
  /* 2026-09-21: an IN-PROGRESS attempt is deletable, so the finished-only
     refusal must be GONE — and with it gone, fn_upsert_attempt's tomb check
     has to be serialised against a concurrent tombstone by taking the
     record's row lock, or a submit racing a deletion could land a completed
     record behind a marker that says in-progress. */
  if(/raise exception 'attempt is in progress'/.test(fnBody(sql, "fn_tombstone_attempt_any") || "")) out.push("fn_tombstone_attempt_any: still refuses an in-progress attempt");
  const lockSel = /select r\.owner_code,[\s\S]*?where r\.key = p_key\s*\n\s*for update;/.test(fnBody(sql, "fn_upsert_attempt") || "");
  if(!lockSel) out.push("fn_upsert_attempt: does not take the record's row lock (FOR UPDATE) before its tomb check");
  if(!/select \* into v_rec from public\.records r where r\.key = p_key for update;/.test(fnBody(sql, "fn_tombstone_attempt_any") || "")) out.push("fn_tombstone_attempt_any: does not lock the record row");
  for(const fn of ["fn_get_assignments", "fn_get_own_attempts", "fn_get_profile", "fn_get_set", "fn_insert_bug", "fn_upsert_attempt"]){
    const body = fnBody(sql, fn);
    if(!body){ out.push(fn + ": not restated"); continue; }
    if(!/if public\.fn_student_deleted\(p_code\) then\s*\n?\s*raise exception 'student deleted';/.test(body)) out.push(fn + ": no 'student deleted' gate");
  }
  const own = fnBody(sql, "fn_get_own_attempts") || "";
  if(!/not exists \(select 1 from public\.records t where t\.key = 'tomb:' \|\| r\.key\)/.test(own)) out.push("fn_get_own_attempts: does not exclude tombstoned attempts");
  if(!/r\.key like 'tomb:attempt:%'/.test(own)) out.push("fn_get_own_attempts: does not return the tomb:attempt rows");
  if(!/r\.value - 'deletedBy'/.test(own)) out.push("fn_get_own_attempts: hands deletedBy to the student");
  const up = fnBody(sql, "fn_upsert_attempt") || "";
  const gateAt = up.indexOf("raise exception 'attempt deleted'"), insAt = up.indexOf("insert into public.records");
  if(gateAt === -1 || insAt === -1 || gateAt > insAt) out.push("fn_upsert_attempt: no 'attempt deleted' refusal before the write");
  /* the whole trigger wiring, in order: drop-if-exists THEN create, BEFORE
     UPDATE OR DELETE, FOR EACH ROW, pointed at fn_protect_tombstones */
  if(!/drop trigger if exists records_protect_tombstones on public\.records;\s*create trigger records_protect_tombstones\s*before update or delete on public\.records\s*for each row execute function public\.fn_protect_tombstones\(\);/.test(sql))
    out.push("no BEFORE UPDATE OR DELETE trigger protecting tomb rows (or not wired to fn_protect_tombstones, or dropped after creation)");
  const trig = fnBody(sql, "fn_protect_tombstones") || "";
  if(!/raise exception 'tombstones are permanent'/.test(trig)) out.push("trigger function does not refuse");
  if(!/if tg_op = 'DELETE' then\s*if old\.key like 'tomb:%' then/.test(trig) || !/if old\.key like 'tomb:%' or new\.key like 'tomb:%' then/.test(trig))
    out.push("trigger function does not test old.key (delete/update) and new.key (update) for the tomb: prefix");
  /* the marker carries identity only — the SQL must never copy the record
     wholesale or any of its answer/score/name fields */
  for(const fn of ["fn_tombstone_attempt_any", "fn_tombstone_student"]){
    const body = fnBody(sql, fn) || "";
    const built = (body.match(/jsonb_build_object\(([\s\S]*?)\);/g) || []).join("\n");
    if(/'(answers|score|modules|displayName|annotations|checkpoint|resume|client)'/.test(built)) out.push(fn + ": the marker copies an answer/score/name field");
    const refs = built.match(/v_rec\.value(?:\s*->>?\s*'[^']*'|\s*#>>\s*'[^']*')?/g) || [];
    const okRef = /^v_rec\.value\s*(->\s*'(testId|assignmentId|status|setId|conditions|startedAt|submittedAt)'|->>\s*'(kind|status|testId|assignmentId)'|#>>\s*'\{student,key\}')$/;
    const bad = refs.filter(x => !okRef.test(x.trim()));
    if(bad.length) out.push(fn + ": the marker reads more of the record than its identity: " + bad.join(", "));
    if(/'value',\s*v_rec\.value\b|v_rec\.value\s*\|\|/.test(body)) out.push(fn + ": the marker embeds the whole record value");
  }
  if(/\bdelete\s+from\s+public\.records\b/i.test(sql)) out.push("migration contains a DELETE FROM records");
  if(/^\s*update\s+public\.records\b/im.test(sql)) out.push("migration contains an UPDATE records statement");
  return out;
}

(async () => {
  /* =================== (a)+(b) the SQL contract, with doctored controls =================== */
  await run("(a)(b) SQL contract: tutor-only tombstone RPCs, deleted-student gates, permanent markers", async () => {
    const real = sqlContract(sqlSrc);
    check(real.length === 0, "the real migration satisfies every clause of the contract", real.join(" | "));
    const covered = ["fn_tombstone_attempt", "fn_tombstone_student", "fn_tombstone_attempt_any", "fn_protect_tombstones", "fn_student_deleted",
      "fn_get_assignments", "fn_get_own_attempts", "fn_get_profile", "fn_get_set", "fn_insert_bug", "fn_upsert_attempt"];
    const later = covered.map(fn => [fn, newestDefining(fn)]).filter(([fn, f]) => f !== "2026-09-18_tombstones.sql");
    check(later.length === 0, "every function the contract covers is LAST defined by the tombstone migration (a later restatement must carry the gates and be added here)", later.map(x => x.join(" -> ")).join(", "));
    check(/service_role/.test(sqlSrc) && (sqlSrc.match(/revoke all on function public\.fn_[a-z_]+\([^)]*\)\s+from public, anon, authenticated, service_role;/g) || []).length === 5,
      "the five tombstone-side functions are revoked from service_role too (Supabase grants it EXECUTE by default)");
    const doctored = [
      ["fn_tombstone_attempt granted to anon too",
        sqlSrc.replace("grant execute on function public.fn_tombstone_attempt(text) to authenticated;", "grant execute on function public.fn_tombstone_attempt(text) to anon, authenticated;"),
        /granted to something other than authenticated/],
      ["fn_tombstone_student's revoke dropped",
        sqlSrc.replace("revoke all on function public.fn_tombstone_student(text)           from public, anon, authenticated, service_role;", ""),
        /fn_tombstone_student: EXECUTE not revoked/],
      ["the internal _any function granted",
        sqlSrc + "\ngrant execute on function public.fn_tombstone_attempt_any(text, text) to authenticated;\n",
        /internal function must have NO grant/],
      ["fn_get_assignments' deleted-student gate removed",
        sqlSrc.replace(/(create or replace function public\.fn_get_assignments[\s\S]*?)  if public\.fn_student_deleted\(p_code\) then\n    raise exception 'student deleted';\n  end if;\n/, "$1"),
        /fn_get_assignments: no 'student deleted' gate/],
      ["fn_upsert_attempt's 'attempt deleted' refusal moved after the write",
        sqlSrc.replace("  if exists (select 1 from public.records t where t.key = 'tomb:' || p_key) then\n    raise exception 'attempt deleted';\n  end if;\n", "")
          .replace(/(   where r\.owner_code = p_code;\nend;\n\$\$;\n\n-- grants unchanged)/, "  if exists (select 1 from public.records t where t.key = 'tomb:' || p_key) then\n    raise exception 'attempt deleted';\n  end if;\n$1"),
        /no 'attempt deleted' refusal before the write/],
      ["in-function role check removed from fn_tombstone_student",
        sqlSrc.replace(/(create or replace function public\.fn_tombstone_student[\s\S]*?)  if coalesce\(v_claims ->> 'role', ''\) <> 'authenticated' then\n    raise exception 'tutor sign-in required';\n  end if;\n/, "$1"),
        /fn_tombstone_student: no in-function authenticated-role check/],
      ["the permanence trigger dropped",
        sqlSrc.replace(/create trigger records_protect_tombstones[\s\S]*?fn_protect_tombstones\(\);\n/, ""),
        /no BEFORE UPDATE OR DELETE trigger/],
      ["fn_get_own_attempts stops excluding tombstoned rows",
        sqlSrc.replace("             and not exists (select 1 from public.records t where t.key = 'tomb:' || r.key))\n", ")\n"),
        /does not exclude tombstoned attempts/],
      ["a hard delete slipped into the migration",
        sqlSrc + "\ndelete from public.records where key like 'attempt:%';\n",
        /contains a DELETE FROM records/],
      ["the trigger re-pointed at another function",
        sqlSrc.replace("for each row execute function public.fn_protect_tombstones();", "for each row execute function public.fn_student_deleted();"),
        /not wired to fn_protect_tombstones/],
      ["drop-if-exists moved after create (a re-run would leave no trigger)",
        sqlSrc.replace("drop trigger if exists records_protect_tombstones on public.records;\ncreate trigger records_protect_tombstones", "create trigger records_protect_tombstones")
          .replace("for each row execute function public.fn_protect_tombstones();", "for each row execute function public.fn_protect_tombstones();\ndrop trigger if exists records_protect_tombstones on public.records;"),
        /no BEFORE UPDATE OR DELETE trigger/],
      ["the marker embeds the whole record",
        sqlSrc.replace("    'assignmentsAtDeletion', v_at);", "    'assignmentsAtDeletion', v_at,\n    'value',        v_rec.value);"),
        /reads more of the record than its identity|embeds the whole record value/],
      ["fn_get_assignments' gate wrapped in a block comment",
        sqlSrc.replace(/(create or replace function public\.fn_get_assignments[\s\S]*?)(  if public\.fn_student_deleted\(p_code\) then\n    raise exception 'student deleted';\n  end if;\n)/, "$1/* $2 */\n"),
        /fn_get_assignments: no 'student deleted' gate/],
      ["the trigger creation turned into a -- comment",
        sqlSrc.replace("create trigger records_protect_tombstones\n  before update or delete on public.records\n  for each row execute function public.fn_protect_tombstones();",
          "-- create trigger records_protect_tombstones before update or delete on public.records for each row execute function public.fn_protect_tombstones();"),
        /no BEFORE UPDATE OR DELETE trigger/],
      ["assignmentsAtDeletion recorded on an in-progress marker too",
        sqlSrc.replace("  if v_rec.value ->> 'assignmentId' is null\n     and coalesce(v_rec.value ->> 'status', '') in ('completed', 'timed-out') then",
          "  if v_rec.value ->> 'assignmentId' is null then"),
        /not restricted to finished records/],
      ["the finished-only refusal put back (an in-progress sitting could not be cleared)",
        sqlSrc.replace("  select * into v_rec from public.records r where r.key = p_key for update;\n  if not found then\n    raise exception 'no such attempt';\n  end if;",
          "  select * into v_rec from public.records r where r.key = p_key for update;\n  if not found then\n    raise exception 'no such attempt';\n  end if;\n  if p_reason = 'attempt' and coalesce(v_rec.value ->> 'status', '') not in ('completed', 'timed-out') then\n    raise exception 'attempt is in progress';\n  end if;"),
        /still refuses an in-progress attempt/],
      ["fn_upsert_attempt's row lock dropped (a submit could race a deletion)",
        sqlSrc.replace("   where r.key = p_key\n     for update;", "   where r.key = p_key;"),
        /does not take the record's row lock/],
      ["assignmentsAtDeletion no longer scoped to the record's testId",
        sqlSrc.replace("       and a.value ->> 'testId' = v_rec.value ->> 'testId';\n  end if;", ";\n  end if;"),
        /not scoped to the record's testId/],
      ["the __none sentinel excluded by a LIKE pattern (underscores are wildcards)",
        sqlSrc.replace("       and a.key <> 'assign:' || v_owner || ':__none'\n", "       and a.key not like '%:__none'\n"),
        /sentinel is not excluded by exact key/],
      ["the role check of fn_tombstone_student commented out on one line",
        sqlSrc.replace(/(create or replace function public\.fn_tombstone_student[\s\S]*?)  if coalesce\(v_claims ->> 'role', ''\) <> 'authenticated' then\n    raise exception 'tutor sign-in required';\n  end if;\n/, "$1  -- if coalesce(v_claims ->> 'role', '') <> 'authenticated' then raise exception 'tutor sign-in required'; end if;\n"),
        /fn_tombstone_student: no in-function authenticated-role check/],
    ];
    /* the marker copies the answers — the earlier control, restated against the new tail */
    check(/copies an answer\/score\/name field/.test(sqlContract(sqlSrc.replace("    'assignmentsAtDeletion', v_at);", "    'assignmentsAtDeletion', v_at,\n    'answers', v_rec.value -> 'answers');")).join("|")),
      "control — the marker copies the answers — is caught");
    for(const [what, text, expect] of doctored){
      if(text === sqlSrc){ check(false, "control could not be applied: " + what); continue; }
      const f = sqlContract(text);
      check(f.some(x => expect.test(x)), "control — " + what + " — is caught", f.join(" | ") || "(no failure reported)");
    }
  });

  await run("(a) no student path writes a tomb: key or calls a tombstone function", async () => {
    check(!/fn_tombstone/.test(attemptsSrc), "attempts.js (the student-side code) never names fn_tombstone_*");
    /* the write API students use: set() enqueues only attempt:/bug: keys */
    const w = loadAttempts({ config: REAL_CFG });
    const ok = await w.AS.set("tomb:attempt:t1:100:aaaa", tomb("attempt:t1:100:aaaa"));
    const q = JSON.parse(w.ls.getItem("devstore:__syncqueue") || "[]");
    check(ok === true && q.length === 0, "set() on a tomb: key writes locally but ENQUEUES NOTHING for the server", "queued=" + q.length);
    await w.AS.set("tomb:student:" + CODE, studentTomb(CODE));
    check(JSON.parse(w.ls.getItem("devstore:__syncqueue") || "[]").length === 0, "set() on a tomb:student key enqueues nothing either");
    /* control: the same call on an attempt key DOES reach the server RPC */
    await w.AS.set("attempt:t1:100:aaaa", rec("attempt:t1:100:aaaa"));
    await w.flush();
    check(w.fetches.some(f => /\/rpc\/fn_upsert_attempt$/.test(f.url)) && !w.fetches.some(f => /fn_tombstone/.test(f.url)),
      "control: an attempt write reaches fn_upsert_attempt, and no fetch ever names a tombstone function", w.fetches.map(f => f.url).join(","));
    /* The recorder's API carries nothing that could CREATE a marker. Two
       names mention deletion and both are read-side or give-up-side:
       tombstoneStub shapes a marker the store already holds, and
       abandonDeleted (2026-09-21) lets go of a sitting the tutor deleted —
       it must write NOTHING, which is asserted below, not just named. */
    const ALLOWED = { tombstoneStub: 1, abandonDeleted: 1 };
    check(!Object.keys(w.AT).some(k => /tomb|delete/i.test(k) && !ALLOWED[k]), "Attempts exposes no deleting/tombstoning method beyond the read-side stub shaper and abandonDeleted", Object.keys(w.AT).join(","));
    {
      const w2 = loadAttempts({ search: "?devstorage=1" });
      const A2 = "attempt:t1:100:aaaa";
      seedLocal(w2.ls, A2, rec(A2, { status: "in-progress", submittedAt: null }));
      const before = w2.ls.getItem("devstore:" + A2);
      w2.AT.resume(rec(A2, { status: "in-progress", submittedAt: null }), { currentTest: null, moduleState: {} });
      w2.ls.setItem("devstore:__syncqueue", JSON.stringify([{ key: A2, kind: "attempt", code: CODE, value: rec(A2), tries: 0, nextAt: 0 }]));
      const gone = w2.AT.abandonDeleted(A2);
      check(gone === A2 && w2.AT.currentAttemptId() === null && w2.ls.getItem("devstore:" + A2) === before
        && JSON.parse(w2.ls.getItem("devstore:__syncqueue")).length === 0,
        "abandonDeleted: lets go of the live sitting, writes NOTHING (the record is byte-identical), and drops its queued writes");
      const w3 = loadAttempts({ search: "?devstorage=1" });
      w3.AT.resume(rec(A2, { status: "in-progress", submittedAt: null }), { currentTest: null, moduleState: {} });
      check(w3.AT.abandonDeleted("attempt:t1:999:zzzz") === null && w3.AT.currentAttemptId() === A2,
        "abandonDeleted refuses a key that is not the live sitting — a stale refusal never kills the sitting in progress");
    }
  });

  /* =================== (c) student surfaces + dashboard marking =================== */
  await run("(c) local/artifact mode: a tombstoned attempt is on no student surface", async () => {
    const w = loadAttempts({ search: "?devstorage=1" });
    const A = "attempt:t1:100:aaaa", B = "attempt:t1:200:bbbb";
    seedLocal(w.ls, A, rec(A)); seedLocal(w.ls, B, rec(B, { assignmentId: "a2", startedAt: "2026-09-02T00:00:00.000Z" }));
    seedLocal(w.ls, "tomb:" + A, tomb(A));
    const res = await w.AT.loadStudentRecords(CODE);
    check(Array.isArray(res.live) && res.live.map(r => r.attemptId).join() === B, "loadStudentRecords: live holds only the un-deleted record", JSON.stringify(res.live && res.live.map(r => r.attemptId)));
    check(res.tombstones.length === 1 && res.tombstones[0].attemptId === A && res.tombstones[0].tombstoned === true
      && res.tombstones[0].assignmentId === "a1" && res.tombstones[0].status === "completed" && !("answers" in res.tombstones[0]) && !("score" in res.tombstones[0]),
      "loadStudentRecords: the deleted record is a bare identity stub (no answers, no score)", JSON.stringify(res.tombstones));
    const past = await w.AT.pastAttempts(CODE);
    check(past.map(r => r.attemptId).join() === B, "pastAttempts (the Past cards' source) omits the deleted record");
    const all = await w.AT.loadForStudent(CODE);
    check(all.map(r => r.attemptId).join() === B, "loadForStudent omits it too");
    /* the raw record is STILL in storage — nothing was removed */
    check(!!w.ls.getItem("devstore:" + A), "the deleted record itself is untouched in storage (local mode never purges)");
    /* control: without the marker the record is back on every surface */
    w.ls.removeItem("devstore:tomb:" + A);
    const res2 = await w.AT.loadStudentRecords(CODE);
    check(res2.live.map(r => r.attemptId).sort().join() === [A, B].sort().join() && res2.tombstones.length === 0,
      "control: remove the marker and the record is live again (the filter is the marker, nothing else)");
    /* a forged marker whose target disagrees with its key is ignored */
    seedLocal(w.ls, "tomb:" + A, tomb(B));
    const res3 = await w.AT.loadStudentRecords(CODE);
    check(res3.live.length === 2 && res3.tombstones.length === 0, "a marker whose target disagrees with its key is ignored (key is authoritative)");
    /* another student's marker never reaches this student's stubs */
    seedLocal(w.ls, "tomb:" + A, tomb(A, { code: OTHER }));
    const res4 = await w.AT.loadStudentRecords(CODE);
    check(res4.tombstones.length === 0, "a marker carrying another student's code is not this student's tombstone");
  });
  await run("(c) resume: a tombstoned in-progress sitting is never offered", async () => {
    const w = loadAttempts({ search: "?devstorage=1" });
    const L = "attempt:t1:300:cccc";
    seedLocal(w.ls, L, rec(L, { status: "in-progress", checkpoint: { moduleIndex: 0, questionIndex: 1 }, submittedAt: null }));
    check((await w.AT.findInProgress(CODE, "t1", "v1")) && (await w.AT.findInProgress(CODE, "t1", "v1")).attemptId === L,
      "control: the in-progress sitting is resumable while un-deleted");
    seedLocal(w.ls, "tomb:" + L, tomb(L, { status: "in-progress", reason: "student" }));
    check((await w.AT.findInProgress(CODE, "t1", "v1")) === null, "with a marker, findInProgress returns nothing");
  });
  await run("(c) remote mode: the server's tomb rows hide the record and the device drops its copy", async () => {
    const A = "attempt:t1:100:aaaa", B = "attempt:t1:200:bbbb";
    let serverRows = [{ key: B, value: rec(B, { assignmentId: "a2" }) }, { key: "tomb:" + A, value: tomb(A) }];
    const w = loadAttempts({ config: REAL_CFG, fetch: async (url) => /fn_get_own_attempts/.test(url) ? { status: 200, body: serverRows } : { status: 500, body: {} } });
    seedLocal(w.ls, A, rec(A));                     // the device recorded it before the deletion
    const res = await w.AT.loadStudentRecords(CODE);
    check(res.live.map(r => r.attemptId).join() === B && res.tombstones.length === 1 && res.tombstones[0].attemptId === A,
      "remote: live = the server's un-deleted rows, stub = the server's marker");
    check(JSON.stringify(JSON.parse(w.ls.getItem("devstore:" + A))) === JSON.stringify(rec(A)) && !!w.ls.getItem("devstore:tomb:" + A),
      "remote: NOTHING on the device is removed — the local copy of the deleted attempt is untouched, the marker is mirrored beside it");
    /* offline afterwards: the mirrored marker still filters a copy that
       somehow comes back (a late flush, a tutor pull on the same browser) */
    seedLocal(w.ls, A, rec(A));
    const w2fetch = async () => ({ status: 500, body: { message: "offline" } });
    w.sandbox.fetch = async (url, o) => { const r = await w2fetch(); return { ok: false, status: r.status, text: async () => JSON.stringify(r.body) }; };
    const res2 = await w.AT.loadStudentRecords(CODE);
    check(res2.live.map(r => r.attemptId).join() === B, "remote, then offline: a re-created local copy is still filtered by the mirrored marker");
    /* control: a server that returns no marker leaves the record live */
    const w3 = loadAttempts({ config: REAL_CFG, fetch: async (url) => /fn_get_own_attempts/.test(url) ? { status: 200, body: [{ key: A, value: rec(A) }] } : { status: 500, body: {} } });
    seedLocal(w3.ls, A, rec(A));
    const res3 = await w3.AT.loadStudentRecords(CODE);
    check(res3.live.map(r => r.attemptId).join() === A && !!w3.ls.getItem("devstore:" + A), "control: no marker from the server, the record stays live and on the device");
  });
  await run("(c) the review surfaces refuse a tombstoned record; the dashboard shows it marked", async () => {
    const A = "attempt:t1:100:aaaa";
    const state = { tests: [{ testId: "t1", testName: "T1", testVersion: "v1", legacyIds: [] }], assignments: [], assignAttempts: {}, tombstoned: { [A]: true } };
    const world = appWorld(state);
    check(world.isTombstonedRecord(rec(A)) === true && world.isTombstonedRecord(rec("attempt:t1:200:bbbb")) === false,
      "app.js isTombstonedRecord: true for the deleted key, false otherwise (openScoreDetails / openSetReview return on it)");
    const world2 = appWorld({ tests: state.tests, tombstoned: {} }, { Dashboard: { isTombstoned: id => id === A } });
    check(world2.isTombstonedRecord(rec(A)) === true, "app.js isTombstonedRecord: the dashboard origin asks the dashboard's tomb map");
    check(/if\(isTombstonedRecord\(record\)\) return;/.test(extractFn(appSrc, "openScoreDetails")) && /if\(isTombstonedRecord\(record\)\) return;/.test(extractFn(appSrc, "openSetReview")),
      "openScoreDetails and openSetReview both refuse a tombstoned record at the top");
    const d = dashWorld({ recs: [rec(A)], tombs: { ["tomb:" + A]: tomb(A) } });
    const html = d.viewAttempts([rec(A)]);
    check(html.indexOf('data-att="' + A + '"') !== -1 && /class="tomb"/.test(html) && />deleted</.test(html),
      "dashboard Attempts tab: the record is LISTED (present) and carries the deleted badge (marked)");
    check(d.isTombstoned(rec(A)) && !d.isDeletableAttempt(rec(A)) && d.releaseCell(rec(A)) === "—",
      "dashboard: a tombstoned record is not deletable again and has no Release button");
    const d2 = dashWorld({ recs: [rec(A)], tombs: {} });
    const html2 = d2.viewAttempts([rec(A)]);
    check(!/class="tomb"/.test(html2) && !/>deleted</.test(html2) && d2.isDeletableAttempt(rec(A)),
      "control: without the marker the row is unmarked and deletable");
    /* a deleted STUDENT marks every one of their records, even one without its own marker */
    const d3 = dashWorld({ recs: [rec(A)], tombs: { ["tomb:student:" + CODE]: studentTomb(CODE) } });
    check(d3.isTombstoned(rec(A)) && d3.isDeletedStudent(CODE) && />deleted</.test(d3.studentCell(CODE)) && /deleted$/.test(d3.codeOptionLabel(CODE)),
      "dashboard: a deleted student's record reads deleted by implication; the student cell and picker label say so");
    check(d3.completedAttemptsOf(CODE).length === 0 && /This student was deleted/.test(d3.seenCaveat({ deletedStudent: true, deleted: 0, unindexed: 0 })),
      "set builder: a deleted student has no seen set and the caveat says so");
    const d4 = dashWorld({ recs: [rec(A), rec("attempt:t1:200:bbbb")], tombs: { ["tomb:" + A]: tomb(A) } });
    check(d4.completedAttemptsOf(CODE).length === 1 && d4.deletedAttemptsOf(CODE).length === 1 && /1 deleted attempt not counted/.test(d4.seenCaveat({ deleted: 1, unindexed: 0 })),
      "set builder: a deleted attempt leaves the seen set and is counted in the caveat");
    /* …but a deleted IN-PROGRESS sitting never entered the seen set, so it is
       not reported as a loss. The caveat is fed the COMPUTED count, not a
       literal, or the check could not fail. */
    const P = "attempt:t1:300:cccc";
    const d4b = dashWorld({ recs: [rec(A), rec(P, { status: "in-progress", submittedAt: null })],
      tombs: { ["tomb:" + A]: tomb(A), ["tomb:" + P]: tomb(P, { status: "in-progress", submittedAt: null }) } });
    const nDel = d4b.deletedAttemptsOf(CODE).length;
    check(nDel === 1 && d4b.seenCaveat({ deleted: nDel, unindexed: 0 }) === "1 deleted attempt not counted.",
      "a deleted IN-PROGRESS sitting is not reported as a lost comparison — it never entered the seen set (without the finished-only filter this reads 2)", "deleted=" + nDel);
    /* 'retired codes are never re-issued': the seen-code set and Generate */
    const RET = "AS-RETIRED2";
    const dk = dashWorld({ recs: [], assigns: [], profiles: {}, tombs: { ["tomb:student:" + RET]: studentTomb(RET) } }, [RET, OTHER]);
    check(dk.knownCodeSet()[RET] === true, "a retired code is in knownCodeSet even with no records, assignments or profile");
    check(dk.generateUnusedCode() === OTHER, "Generate skips the retired code and hands out the next unused one");
    const dk2 = dashWorld({ recs: [], assigns: [], profiles: {}, tombs: {} }, [RET, OTHER]);
    check(dk2.generateUnusedCode() === RET, "control: without the marker the same draw would have re-issued that code");
  });
  await run("(c) analysis surfaces: a deleted record contributes nothing to Item analysis or Insights", async () => {
    /* viewItems/viewInsights need the question index; a null index takes the
       "question text unavailable" branch, which is enough to see whether a
       deleted record's answers reach the tallies */
    const NAMES = ["tombFor", "isDeletedStudent", "isTombstoned", "median", "mmss", "num", "cnt", "givenLabel", "viewItems", "viewInsights"];
    const esc = s => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const els = { dashFilterTest: { value: "" } };
    const $ = id => els[id] || (els[id] = { value: "", textContent: "" });
    const body = "const testsById = {};\nconst qIndex = () => null;\nconst setProvLookup = () => null;\nconst fmt = s => esc(s);\nconst hasKey = () => false;\nconst escAttr = esc;\n" +
      NAMES.map(n => extractFn(dashSrc, n)).join("\n\n") + "\nreturn { viewItems, viewInsights };";
    const mk = (tombs) => new Function("tombs", "recs", "esc", "$", "window", "let sortKey='startedAt', sortDir=-1;\n" + body)(tombs, [], esc, $, {});
    const A = "attempt:t1:100:aaaa";
    const live = rec(A, { answers: { q1: { given: 0, correct: false, timeSpentSeconds: 30, firstGiven: 1, changeCount: 1, markedForReview: true } } });
    const marked = mk({ ["tomb:" + A]: tomb(A) });
    const clear = mk({});
    const insM = marked.viewInsights([live]), insC = clear.viewInsights([live]);
    check(/No attempts match/.test(insM) && !/No attempts match/.test(insC), "Insights: a deleted record is excluded; control: the same record undeleted is analysed");
    const itM = marked.viewItems([live]), itC = clear.viewItems([live]);
    check(/No attempts match/.test(itM) && !/No attempts match/.test(itC), "Item analysis: a deleted record is excluded; control: the same record undeleted is analysed");
  });
  await run("(c) artifact mode: a marker read that FAILS is \"unavailable\", never \"not deleted\"", async () => {
    const A = "attempt:t1:100:aaaa";
    const seed = w => { w.store[A] = JSON.stringify(rec(A)); w.store["assign:" + CODE + ":a1"] = JSON.stringify({ assignmentId: "a1", testId: "t1", category: "practice" }); };
    const w1 = loadAttempts({ sharedStorage: { throwOn: /^tomb:student:/ } }); seed(w1);
    check((await w1.AT.assignments(CODE)) === "unavailable", "assignments(): the student-marker read throws → unavailable (not a list)");
    check((await w1.AT.loadStudentRecords(CODE)) === "unavailable", "loadStudentRecords(): the student-marker read throws → unavailable");
    const w2 = loadAttempts({ sharedStorage: { throwOn: /^tomb:attempt:/ } }); seed(w2); w2.store["tomb:" + A] = JSON.stringify(tomb(A));
    check((await w2.AT.loadStudentRecords(CODE)) === "unavailable", "loadStudentRecords(): an attempt-marker read throws → unavailable (the record is not shown as live)");
    const w3 = loadAttempts({ sharedStorage: true }); seed(w3);
    check(Array.isArray((await w3.AT.assignments(CODE))) && Array.isArray((await w3.AT.loadStudentRecords(CODE)).live), "control: with readable storage both resolve normally");
  });

  /* =================== (d) assignment completion =================== */
  await run("(d) a deleted completed attempt keeps its assignment closed (student home)", async () => {
    const w = loadAttempts({ search: "?devstorage=1" });
    const A = "attempt:t1:100:aaaa";
    /* NO completedAttemptId hint — the remote-mode reality: students cannot
       write assignment rows to the server, so the hint is normally absent */
    const a1 = { assignmentId: "a1", testId: "t1", category: "practice" };
    const state = { tests: [{ testId: "t1", testName: "T1", testVersion: "v1", legacyIds: [] }], assignments: [a1], assignAttempts: {} };
    const world = appWorld(state);
    const stub = w.AT.tombstoneStub("tomb:" + A, tomb(A));
    world.buildAssignmentIndex([stub]);
    check(world.assignmentComplete(a1) === true && world.assignmentState(a1) === "completed",
      "with only the tombstone stub, the assignment reads Completed — no Start, no retake");
    check(Object.keys(state.resumeRecords).length === 0 && world.attemptResumable(stub) === false, "a stub is never resumable and never enters the crash-resume map");
    /* CONTROL: drop the stub — exactly what a hard delete (or a hidden
       tombstone) would do — and the assignment reopens. This is the bug. */
    world.buildAssignmentIndex([]);
    check(world.assignmentComplete(a1) === false && world.assignmentState(a1) === "ready",
      "control: without the stub the assignment REOPENS (the 25ef8f7 class — what the stub exists to prevent)");
    /* a deleted in-progress sitting: not resumable, its assignment is not in progress */
    const a2 = { assignmentId: "a2", testId: "t1", category: "practice" };
    const state2 = { tests: state.tests, assignments: [a2], assignAttempts: {} };
    const world2 = appWorld(state2);
    const liveStub = w.AT.tombstoneStub("tomb:attempt:t1:300:cccc", tomb("attempt:t1:300:cccc", { status: "in-progress", assignmentId: "a2", reason: "student" }));
    world2.buildAssignmentIndex([liveStub]);
    check(world2.assignmentState(a2) !== "in-progress" && world2.assignmentState(a2) !== "completed" && !state2.assignAttempts.a2.resumable && Object.keys(state2.resumeRecords).length === 0,
      "a deleted in-progress sitting is neither resumable nor 'in progress'", world2.assignmentState(a2));
    /* an UNTAGGED deleted sitting keeps closed only an assignment that
       existed when it was deleted — the marker's assignmentsAtDeletion, as
       the server recorded it — never one created after the deletion */
    const untagged = w.AT.tombstoneStub("tomb:attempt:t1:400:dddd", tomb("attempt:t1:400:dddd", { assignmentId: null, assignmentsAtDeletion: ["a3"] }));
    const older = { assignmentId: "a3", testId: "t1", category: "practice", assignedAt: "2026-09-10T00:00:00.000Z" };
    const newer = { assignmentId: "a4", testId: "t1", category: "practice", assignedAt: "2026-09-19T00:00:00.000Z" };
    const skewed = { assignmentId: "a5", testId: "t1", category: "practice", assignedAt: "2026-09-01T00:00:00.000Z" };   // browser clock behind: "older" than the deletion, yet created after it
    for(const [a, want, label] of [[older, true, "an assignment that existed at the deletion stays Completed"],
                                    [newer, false, "an assignment created after the deletion is startable (the re-sit the tutor asked for)"],
                                    [skewed, false, "an assignment created after the deletion on a browser clock that runs behind is STILL startable (no clock comparison)"]]){
      const st = { tests: state.tests, assignments: [a], assignAttempts: {} };
      const wld = appWorld(st);
      wld.buildAssignmentIndex([untagged]);
      check(wld.assignmentComplete(a) === want, "untagged deleted sitting: " + label, String(wld.assignmentComplete(a)));
    }
    const noList = w.AT.tombstoneStub("tomb:attempt:t1:400:dddd", tomb("attempt:t1:400:dddd", { assignmentId: null }));
    const stNL = { tests: state.tests, assignments: [older], assignAttempts: {} };
    const wNL = appWorld(stNL);
    wNL.buildAssignmentIndex([noList]);
    check(wNL.assignmentComplete(older) === false && JSON.stringify(noList.assignmentsAtDeletion) === "[]", "a marker without the list (or with non-strings) closes nothing");
    const stLive = { tests: state.tests, assignments: [newer], assignAttempts: {} };
    const wldLive = appWorld(stLive);
    wldLive.buildAssignmentIndex([rec("attempt:t1:400:dddd", { assignmentId: null })]);
    check(wldLive.assignmentComplete(newer) === true, "control: an untagged LIVE sitting still closes the sole assignment through the fallback, as before");
  });
  await run("(d) the app actually feeds the stubs: refreshStudentState wiring, executed", async () => {
    /* the (d) cases above call buildAssignmentIndex directly; this one runs
       the REAL refreshStudentState with an Attempts stub, so a change that
       stopped handing stubs to the index (or stopped marking state.tombstoned)
       would red here — nothing else exercises that wiring */
    const w = loadAttempts({ search: "?devstorage=1" });
    const A = "attempt:t1:100:aaaa";
    const stub = w.AT.tombstoneStub("tomb:" + A, tomb(A));
    const a1 = { assignmentId: "a1", testId: "t1", category: "practice" };
    const mk = (payload) => {
      const state = { tests: [{ testId: "t1", testName: "T1", testVersion: "v1", legacyIds: [] }], assignments: [a1], assignAttempts: {}, pastAttempts: [], tombstoned: {}, resumeRecords: {} };
      const ended = [];
      /* extractFn slices from the `function` keyword, so the async marker
         has to be put back (tests/tutor-writes.test.js does the same) */
      const body = APP_CONSTS.map(n => extractConst(appSrc, n)).join("\n") + "\n" +
        APP_FNS.map(n => extractFn(appSrc, n)).join("\n\n") + "\n\nasync " + extractFn(appSrc, "refreshStudentState") +
        "\nfunction endDeletedSession(){ ended.push(1); }\nreturn { refreshStudentState, assignmentComplete, assignmentState };";
      const Attempts = { loadStudentRecords: async () => payload };
      const world = new Function("state", "window", "localStorage", "Attempts", "ended", body)(state, { TEST_ARCHIVE_INDEX: undefined, __TESTDATA__: {} }, { getItem: () => null }, Attempts, ended);
      return { world, state, ended };
    };
    const ok = mk({ live: [], tombstones: [stub] });
    const r = await ok.world.refreshStudentState(CODE);
    check(r === true && ok.state.tombstoned[A] === true && ok.state.pastAttempts.length === 0 && ok.world.assignmentComplete(a1) === true,
      "refreshStudentState: the stub reaches the index (assignment Completed), state.tombstoned is marked, Past stays empty");
    const ctrl = mk({ live: [], tombstones: [] });
    await ctrl.world.refreshStudentState(CODE);
    check(ctrl.world.assignmentComplete(a1) === false, "control: with no stub from the read, the same assignment is startable");
    const gone = mk("deleted");
    const r3 = await gone.world.refreshStudentState(CODE);
    check(r3 === "deleted" && gone.ended.length === 1, "refreshStudentState: \"deleted\" ends the session and returns the string (never false)", String(r3));
    const un = mk("unavailable");
    check((await un.world.refreshStudentState(CODE)) === false && un.ended.length === 0, "refreshStudentState: \"unavailable\" is false and ends nothing");
    /* every caller checks for the string before painting a screen */
    /* every caller either RETURNS on "deleted" (the string), or is a .then
       form that only re-renders on a literal true — no caller may treat the
       string as a success. Counted so a new call site cannot slip past
       unguarded: 4 awaited returns (three post-sitting handlers + the
       ended-sitting landing) and 2 .then forms (review exit, and the
       finished-attempt-deleted refresh). */
    const callers = (appSrc.match(/refreshStudentState\(state\.userName\)/g) || []).length;
    const guarded = (appSrc.match(/if\(\(await refreshStudentState\(state\.userName\)\) === "deleted"\) return;/g) || []).length;
    const thenForms = (appSrc.match(/refreshStudentState\(state\.userName\)\.then\(ok => \{\s*if\(ok === true/g) || []).length;
    check(callers === 6 && guarded === 4 && thenForms === 2,
      "every caller honours \"deleted\": 4 awaited returns + 2 .then forms that re-render only on literal true", callers + "/" + guarded + "/" + thenForms);
    check(/const refreshed = await refreshStudentState\(code\);\s*if\(refreshed === "deleted"\) return false;/.test(extractFn(appSrc, "signInWithCode")),
      "signInWithCode returns false on \"deleted\" without showing another screen");
  });
  await run("(d) the dashboard's assignment status agrees", async () => {
    const A = "attempt:t1:100:aaaa";
    const a1 = { assignmentId: "a1", testId: "t1", category: "practice" };
    const d = dashWorld({ recs: [rec(A)], tombs: { ["tomb:" + A]: tomb(A) }, assigns: [{ code: CODE, list: [a1] }] });
    check(d.assignRowStatus(CODE, a1) === "completed", "dashboard: a tombstoned completed record keeps the row Completed");
    /* the record rotated away by archive-then-delete: the ORPHAN marker still closes it */
    const d2 = dashWorld({ recs: [], tombs: { ["tomb:" + A]: tomb(A) }, assigns: [{ code: CODE, list: [a1] }] });
    check(d2.orphanStubs(CODE).length === 1 && d2.assignRowStatus(CODE, a1) === "completed", "dashboard: an orphan marker (record archived away) still reads Completed");
    check(dashWorld({ recs: [], tombs: {}, assigns: [{ code: CODE, list: [a1] }] }).assignRowStatus(CODE, a1) === "pending",
      "control: no record and no marker — pending (startable)");
    const L = "attempt:t1:300:cccc";
    const a2 = { assignmentId: "a2", testId: "t1", category: "practice" };
    const d3 = dashWorld({ recs: [rec(L, { status: "in-progress", assignmentId: "a2" })], tombs: { ["tomb:" + L]: tomb(L, { status: "in-progress", assignmentId: "a2" }) }, assigns: [{ code: CODE, list: [a2] }] });
    check(d3.assignRowStatus(CODE, a2) === "pending", "dashboard: a tombstoned in-progress sitting is not 'in-progress'", d3.assignRowStatus(CODE, a2));
    const U = "attempt:t1:400:dddd";
    const uT = tomb(U, { assignmentId: null, assignmentsAtDeletion: ["a3"] });
    const older = { assignmentId: "a3", testId: "t1", category: "practice" };
    const newer = { assignmentId: "a4", testId: "t1", category: "practice" };
    const d4 = dashWorld({ recs: [rec(U, { assignmentId: null })], tombs: { ["tomb:" + U]: uT }, assigns: [{ code: CODE, list: [older] }] });
    check(d4.assignRowStatus(CODE, older) === "completed", "dashboard: an untagged deleted sitting keeps an assignment named in its marker Completed (parity with the home)");
    const d4b = dashWorld({ recs: [rec(U, { assignmentId: null })], tombs: { ["tomb:" + U]: uT }, assigns: [{ code: CODE, list: [newer] }] });
    check(d4b.assignRowStatus(CODE, newer) === "pending", "dashboard: … and never closes one the marker does not name (created after the deletion)", d4b.assignRowStatus(CODE, newer));
    /* a deleted STUDENT's untagged record with no own marker closes nothing; an orphan marker keeps its list */
    const d4c = dashWorld({ recs: [rec(U, { assignmentId: null })], tombs: { ["tomb:student:" + CODE]: studentTomb(CODE) }, assigns: [{ code: CODE, list: [older] }] });
    check(d4c.assignRowStatus(CODE, older) === "pending", "dashboard: a deleted student's record without its own marker closes nothing (the code is retired)");
    const d4d = dashWorld({ recs: [], tombs: { ["tomb:" + U]: uT }, assigns: [{ code: CODE, list: [older] }] });
    check(d4d.assignRowStatus(CODE, older) === "completed", "dashboard: an orphan untagged marker (record archived away) still closes the assignment it names");
    /* the local-mode marker computes the list the same way the server does: every assignment of that code and test */
    const mkLocal = dashWorld({ recs: [rec(U, { assignmentId: null })], tombs: {}, assigns: [{ code: CODE, list: [older, newer, { assignmentId: "a9", testId: "t2" }] }, { code: OTHER, list: [{ assignmentId: "a8", testId: "t1" }] }] });
    const lt = mkLocal.localTombstone(rec(U, { assignmentId: null }), "attempt", "2026-09-18T10:00:00.000Z", "acestem-admin (local)");
    check(JSON.stringify(lt.assignmentsAtDeletion.slice().sort()) === JSON.stringify(["a3", "a4"]) && mkLocal.localTombstone(rec(U), "attempt", "x", "y").assignmentsAtDeletion.length === 0,
      "local-mode marker: assignmentsAtDeletion = this code's assignments of that test (none for a tagged record)", JSON.stringify(lt.assignmentsAtDeletion));
    /* and the local writer applies the SAME status gate as the SQL, so the
       two deployment modes cannot write different markers for one shape */
    const ltLive = mkLocal.localTombstone(rec(U, { assignmentId: null, status: "in-progress", submittedAt: null }), "attempt", "2026-09-18T10:00:00.000Z", "acestem-admin (local)");
    check(ltLive.status === "in-progress" && ltLive.assignmentsAtDeletion.length === 0,
      "local-mode marker: an untagged IN-PROGRESS sitting records no assignmentsAtDeletion — the same gate fn_tombstone_attempt_any applies", JSON.stringify(ltLive.assignmentsAtDeletion));
    const d5 = dashWorld({ recs: [rec(U, { assignmentId: null })], tombs: {}, assigns: [{ code: CODE, list: [newer] }] });
    check(d5.assignRowStatus(CODE, newer) === "completed", "control: the same untagged sitting, undeleted, closes it");
  });

  /* ============ IN-PROGRESS deletion (2026-09-21) ============
     The tutor can now mark a sitting that is still in progress — the case
     that clears a stale sitting blocking a testVersion bump. Its contract is
     the OPPOSITE of the finished one at the assignment: nothing was
     submitted, so the assignment becomes startable again. Everything else
     (dead on the device, no resume, no card) is the same. */
  await run("(i) the assignment: an in-progress marker leaves it STARTABLE; a finished one keeps it Completed", async () => {
    const w = loadAttempts({ search: "?devstorage=1" });
    const A = "attempt:t1:100:aaaa";
    const a1 = { assignmentId: "a1", testId: "t1", category: "practice" };
    const mk = status => {
      const stub = w.AT.tombstoneStub("tomb:" + A, tomb(A, { status: status, submittedAt: status === "in-progress" ? null : "2026-09-01T02:00:00.000Z" }));
      const state = { tests: [{ testId: "t1", testName: "T1", testVersion: "v1", legacyIds: [] }], assignments: [a1], assignAttempts: {}, resumeRecords: {} };
      const world = appWorld(state);
      world.buildAssignmentIndex([stub]);
      return { state, world, stub };
    };
    const live = mk("in-progress");
    check(live.world.assignmentComplete(a1) === false && live.world.assignmentState(a1) === "ready",
      "in-progress marker: the assignment is STARTABLE again — nothing was submitted", live.world.assignmentState(a1));
    check(live.state.assignAttempts.a1.completed === null && live.state.assignAttempts.a1.resumable === null,
      "in-progress marker: the assignment holds neither a completed nor a resumable attempt (no Active/Resume card)");
    check(Object.keys(live.state.resumeRecords).length === 0 && live.world.attemptResumable(live.stub) === false,
      "in-progress marker: never resumable, never in the crash-resume map");
    /* THE CONTROL that proves the two are told apart by the marker's own
       status and nothing else: the identical marker, status completed */
    const done = mk("completed");
    check(done.world.assignmentComplete(a1) === true && done.world.assignmentState(a1) === "completed",
      "control: the SAME marker with status completed keeps the assignment Completed — `status` is the only discriminator");
    /* and the dashboard agrees, both ways */
    const dLive = dashWorld({ recs: [rec(A, { status: "in-progress", submittedAt: null })], tombs: { ["tomb:" + A]: tomb(A, { status: "in-progress" }) }, assigns: [{ code: CODE, list: [a1] }] });
    check(dLive.assignRowStatus(CODE, a1) === "pending", "dashboard: a marked in-progress sitting is neither in-progress nor completed — the row is startable", dLive.assignRowStatus(CODE, a1));
    const dDone = dashWorld({ recs: [rec(A)], tombs: { ["tomb:" + A]: tomb(A) }, assigns: [{ code: CODE, list: [a1] }] });
    check(dDone.assignRowStatus(CODE, a1) === "completed", "control: the finished one still reads Completed on the dashboard");
    const dUnmarked = dashWorld({ recs: [rec(A, { status: "in-progress", submittedAt: null })], tombs: {}, assigns: [{ code: CODE, list: [a1] }] });
    check(dUnmarked.assignRowStatus(CODE, a1) === "in-progress", "control: unmarked, the same sitting still reads in-progress");
  });
  await run("(i) the ways an assignment could still read Completed after its sitting was deleted", async () => {
    const w = loadAttempts({ search: "?devstorage=1" });
    const LIVE = "attempt:t1:300:cccc", OLD = "attempt:t1:100:aaaa";
    const tests = [{ testId: "t1", testName: "T1", testVersion: "v1", legacyIds: [] }];
    const stub = w.AT.tombstoneStub("tomb:" + LIVE, tomb(LIVE, { status: "in-progress", assignmentId: "a1", submittedAt: null }));
    /* 1. the sole-assignment untagged fallback. Deleting the tagged sitting
       empties the assignment's completed AND resumable slots, which is
       exactly the condition that opens the fallback — an older untagged
       completed run of the same test must NOT be allowed to close it. */
    {
      const a1 = { assignmentId: "a1", testId: "t1", category: "practice" };
      const state = { tests: tests, assignments: [a1], assignAttempts: {}, resumeRecords: {} };
      const world = appWorld(state);
      const untaggedOld = rec(OLD, { assignmentId: null, conditions: "self-administered" });
      world.buildAssignmentIndex([stub, untaggedOld]);
      check(world.assignmentComplete(a1) === false && world.assignmentState(a1) === "ready",
        "an older untagged completed run does NOT close the assignment whose in-progress sitting was just deleted", world.assignmentState(a1));
      /* control: with no record of its own, the same assignment DOES take
         the untagged run through the fallback — the migration rule is intact */
      const state2 = { tests: tests, assignments: [a1], assignAttempts: {}, resumeRecords: {} };
      const world2 = appWorld(state2);
      world2.buildAssignmentIndex([untaggedOld]);
      check(world2.assignmentComplete(a1) === true, "control: with no explicit record the untagged fallback still fires (the migration rule is unchanged)");
      /* The guard also lands on ONE pre-existing shape, deliberately: an
         assignment whose only explicit record is an in-progress sitting with
         no resume/checkpoint blob (begun, then abandoned before the first
         module). That used to open the fallback and let an old untagged run
         mark it Completed; now it reads startable — which is what the
         dashboard already said for it (attemptsForAssignment short-circuits
         on any explicit record), so the two views agree where they did not. */
      const state3 = { tests: tests, assignments: [a1], assignAttempts: {}, resumeRecords: {} };
      const world3 = appWorld(state3);
      const blankLive = rec(LIVE, { status: "in-progress", submittedAt: null, assignmentId: "a1" });   // no resume, no checkpoint
      world3.buildAssignmentIndex([blankLive, untaggedOld]);
      check(world3.assignmentComplete(a1) === false && world3.assignmentState(a1) === "ready",
        "a blank in-progress record of its own also keeps the fallback shut — the assignment is startable, matching the dashboard", world3.assignmentState(a1));
      const dBlank = dashWorld({ recs: [blankLive, rec(OLD, { assignmentId: null })], tombs: {}, assigns: [{ code: CODE, list: [a1] }] });
      check(dBlank.assignRowStatus(CODE, a1) === "in-progress", "…and the dashboard still calls that live record in-progress (it is not deleted), so neither view says Completed");
    }
    /* 2. the persisted completedAttemptId hint must not outlive the attempt
       it names once that attempt is deleted */
    {
      const a1 = { assignmentId: "a1", testId: "t1", category: "practice", completedAttemptId: LIVE };
      const state = { tests: tests, assignments: [a1], assignAttempts: {}, resumeRecords: {}, tombstoned: { [LIVE]: true } };
      const world = appWorld(state);
      world.buildAssignmentIndex([stub]);
      check(world.assignmentComplete(a1) === false, "a hint naming a DELETED attempt is ignored — the assignment is startable again");
      const state2 = { tests: tests, assignments: [a1], assignAttempts: {}, resumeRecords: {}, tombstoned: {} };
      const world2 = appWorld(state2);
      world2.buildAssignmentIndex([]);
      check(world2.assignmentComplete(a1) === true,
        "control: a hint whose attempt is merely ARCHIVED AWAY (not deleted) still closes the assignment — the reason the hint exists");
    }
    /* 3. nothing writes a completion the index cannot check. Read CODE, not
       prose: the comment explaining the removal says "unknown" itself. */
    const stripC = s => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1");
    const submit = stripC(extractFn(appSrc, "submitModule"));
    check(!/\|\| "unknown"/.test(submit) && /const finishedId = Attempts\.currentAttemptId\(\);\s*if\(finishedId\) state\.activeAssignment\.completedAttemptId = finishedId;/.test(submit),
      "submitModule stamps the hint only with a REAL attempt id, never the literal \"unknown\"", submit.match(/completedAttemptId[^\n]*/g));
    const ca = stripC(attemptsSrc.slice(attemptsSrc.indexOf("async completeAssignment("), attemptsSrc.indexOf("currentAttemptId()")));
    check(ca.length > 100 && !/"unknown"/.test(ca), "Attempts.completeAssignment never writes \"unknown\" either", ca.length);
    {
      const w2 = loadAttempts({ search: "?devstorage=1" });
      seedLocal(w2.ls, "assign:" + CODE + ":a1", { assignmentId: "a1", testId: "t1" });
      await w2.AT.completeAssignment(CODE, "a1");            // no live recorder
      const row = JSON.parse(w2.ls.getItem("devstore:assign:" + CODE + ":a1"));
      check(!("completedAttemptId" in row) || !row.completedAttemptId,
        "with the recorder let go (the sitting was deleted), finalising writes NO completion hint", JSON.stringify(row));
    }
  });
  await run("(i) a card rendered before the marker landed cannot resume into a dead sitting", async () => {
    for(const fn of ["resumeTestFlow", "resumeSetFlow"]){
      const src = extractFn(appSrc, fn);
      check(/if\(isTombstonedRecord\(record\)\)\{ renderHome\(\); showOnly\("screen-home"\); return true; \}/.test(src),
        fn + " refuses a tombstoned record and lands home instead of starting a sitting on it");
    }
    /* and the store-level lookup fails CLOSED on an unreadable marker */
    const w = loadAttempts({ sharedStorage: { throwOn: /^tomb:/ } });
    const L = "attempt:t1:300:cccc";
    w.store[L] = JSON.stringify(rec(L, { status: "in-progress", submittedAt: null, checkpoint: { moduleIndex: 0 } }));
    check((await w.AT.findInProgress(CODE, "t1", "v1")) === null, "findInProgress: a marker read that THROWS refuses the record (fails closed, never resumes it)");
    const w2 = loadAttempts({ sharedStorage: true });
    w2.store[L] = JSON.stringify(rec(L, { status: "in-progress", submittedAt: null, checkpoint: { moduleIndex: 0 } }));
    check((await w2.AT.findInProgress(CODE, "t1", "v1")) !== null, "control: with a readable store the same record is resumable");
  });
  await run("(i) the refused key is never re-queued, so 'terminal' is true of the write and not just the item", async () => {
    const LIVE = "attempt:t1:300:cccc";
    const w = loadAttempts({ config: REAL_CFG, fetch: async (url) => /fn_upsert_attempt/.test(url) ? { status: 400, body: { message: "attempt deleted" } } : { status: 200, body: [] } });
    await w.AS.set(LIVE, rec(LIVE, { status: "in-progress", submittedAt: null }));
    await w.flush();
    check(JSON.parse(w.ls.getItem("devstore:__syncqueue") || "[]").length === 0, "the refused write is dropped");
    await w.AS.set(LIVE, rec(LIVE, { status: "in-progress", submittedAt: null, answers: { q1: 1 } }));   // the next 45s checkpoint
    const q = JSON.parse(w.ls.getItem("devstore:__syncqueue") || "[]");
    check(q.length === 0, "the NEXT checkpoint for that key is not queued again — no refuse/drop/re-add treadmill", JSON.stringify(q));
    await w.AS.set("attempt:t1:400:dddd", rec("attempt:t1:400:dddd"));
    check(JSON.parse(w.ls.getItem("devstore:__syncqueue") || "[]").length === 1, "control: a different attempt still queues normally");
  });
  await run("(i) the device: a marked in-progress sitting is absent everywhere, and Past is untouched", async () => {
    const w = loadAttempts({ search: "?devstorage=1" });
    const LIVE = "attempt:t1:300:cccc", DONE = "attempt:t1:100:aaaa";
    seedLocal(w.ls, LIVE, rec(LIVE, { status: "in-progress", submittedAt: null, assignmentId: "a2", checkpoint: { moduleIndex: 0, questionIndex: 3 } }));
    seedLocal(w.ls, DONE, rec(DONE));
    const before = await w.AT.loadStudentRecords(CODE);
    check(before.live.length === 2 && (await w.AT.pastAttempts(CODE)).length === 1, "control: before the marker, both records load and one is in Past");
    seedLocal(w.ls, "tomb:" + LIVE, tomb(LIVE, { status: "in-progress", assignmentId: "a2" }));
    const after = await w.AT.loadStudentRecords(CODE);
    check(after.live.map(r => r.attemptId).join() === DONE && after.tombstones.length === 1 && after.tombstones[0].status === "in-progress",
      "the marked sitting leaves `live`; its stub carries status in-progress", JSON.stringify(after.live.map(r => r.attemptId)));
    const past = await w.AT.pastAttempts(CODE);
    check(past.length === 1 && past[0].attemptId === DONE, "PAST IS UNCHANGED — deleting a sitting in progress touches no finished attempt");
    check((await w.AT.findInProgress(CODE, "t1", "v1")) === null, "findInProgress (the resume lookup) refuses it");
    check(!!w.ls.getItem("devstore:" + LIVE), "the partial record itself is still on the device, untouched — nothing was erased");
    /* the offline test-cache pin lets go too, so a superseded build can be evicted after a bump */
    const pin = new Function("state", "window", "localStorage", "canonTestId", "testIdAliases", "testById", "TESTCACHE_PREFIX",
      extractFn(appSrc, "resumableVersionsFor") + "\nreturn resumableVersionsFor;")(
      { resumeRecords: {}, assignAttempts: {} }, {}, w.ls, id => id, () => ["t1"], id => ({ testId: id }), "acestem:testcache:");
    check(pin("t1").length === 0, "a marked sitting no longer pins its build in the offline test cache");
    w.ls.removeItem("devstore:tomb:" + LIVE);
    check(pin("t1").join() === "v1", "control: unmarked, the same sitting still pins its build");
  });
  await run("(i) a live sitting: the refused write ends it honestly, and writes nothing on the way out", async () => {
    /* remote: the server refuses the checkpoint, the queue drops it as
       terminal, and the app is told which key died */
    const LIVE = "attempt:t1:300:cccc";
    const w = loadAttempts({ config: REAL_CFG, fetch: async (url) => /fn_upsert_attempt/.test(url) ? { status: 400, body: { message: "attempt deleted" } } : { status: 200, body: [] } });
    const killed = [];
    w.AS.onDeleted((key, reason) => killed.push([key, reason]));
    await w.AS.set(LIVE, rec(LIVE, { status: "in-progress", submittedAt: null }));
    await w.flush();
    const q = JSON.parse(w.ls.getItem("devstore:__syncqueue") || "[]");
    check(q.length === 0 && w.warns.some(s => /DROPPED a queued write for " ?attempt:t1:300:cccc|DROPPED a queued write for attempt:t1:300:cccc/.test(s)),
      "remote: the refused checkpoint is dropped as TERMINAL, never retried, and says so in the console", JSON.stringify(q));
    check(killed.length === 1 && killed[0][0] === LIVE && killed[0][1] === "attempt", "remote: the app is told exactly which attempt died, and why", JSON.stringify(killed));
    check(w.AS.syncState(CODE).refused === 0,
      "the pill does NOT redden for it — the sitting ending is the signal, and the existing rule (only 'student deleted' reddens) is unchanged");
    /* local / artifact: no server ever answers, so the recorder finds its own
       marker in the store it just wrote to (this also covers the tutor
       marking it from a dashboard on the SAME device in remote mode) */
    const w2 = loadAttempts({ search: "?devstorage=1" });
    const killed2 = [];
    w2.AS.onDeleted((key, reason) => killed2.push([key, reason]));
    seedLocal(w2.ls, "tomb:" + LIVE, tomb(LIVE, { status: "in-progress" }));
    w2.AT.resume(rec(LIVE, { status: "in-progress", submittedAt: null }), { currentTest: { testId: "t1", modules: [] }, moduleState: {} });
    await w2.AT.questionShown("q1");
    await new Promise(r => setImmediate(r));
    await w2.AT.suspend({ moduleIndex: 0 });
    await new Promise(r => setImmediate(r));          // the probe is advisory: it settles beside the save, not inside it
    check(killed2.some(k => k[0] === LIVE && k[1] === "attempt"), "local/artifact: the recorder finds its own marker on the next save and reports it", JSON.stringify(killed2));
    /* and the probe must never be awaited by the save path — Save and Exit
       waits on save(), and in artifact mode this store is a network hop */
    const saveSrc = attemptsSrc.slice(attemptsSrc.indexOf("  async function save()"), attemptsSrc.indexOf("  function startTicker()"));
    check(/AttemptStore\.get\(TOMB_PREFIX \+ key\)\.then\(/.test(saveSrc) && !/await AttemptStore\.get\(TOMB_PREFIX/.test(saveSrc),
      "the checkpoint probe is fire-and-forget — a slow or hanging store read can never stall a save, a suspend, or Save and Exit");
    /* a marker for a DIFFERENT attempt never reports this one */
    const w3 = loadAttempts({ search: "?devstorage=1" });
    const killed3 = [];
    w3.AS.onDeleted((key, reason) => killed3.push([key, reason]));
    seedLocal(w3.ls, "tomb:attempt:t1:999:zzzz", tomb("attempt:t1:999:zzzz"));
    w3.AT.resume(rec(LIVE, { status: "in-progress", submittedAt: null }), { currentTest: { testId: "t1", modules: [] }, moduleState: {} });
    await w3.AT.suspend({ moduleIndex: 0 });
    await new Promise(r => setImmediate(r));
    check(killed3.length === 0, "control: someone else's marker never reports this sitting", JSON.stringify(killed3));
  });
  await run("(i) app.js routes the kill signal: this sitting ends, a stale key is ignored, a deleted student ends the session", async () => {
    const A = "attempt:t1:100:aaaa";
    /* app.js's OWN registration line is lifted verbatim and evaluated with
       the handlers, so the suite exercises store -> subscriber -> landing.
       Without it the whole kill path hangs on one line nothing checked. */
    const regLine = (appSrc.match(/^[ \t]*AttemptStore\.onDeleted\([A-Za-z0-9_$]+\);[ \t]*$/m) || [])[0];
    check(!!regLine, "app.js subscribes its router to the store's deletion signal (the one line the whole kill path hangs on)", String(regLine));
    const build = (liveKey, refresh, liveStatus) => {
      const calls = [];
      const state = { sessionGen: 1, timerInterval: 5, breakInterval: 6, readyTimer: 7, moduleOverTimer: null, timerRunning: true,
        currentTest: { testId: "t1" }, moduleState: { m: 1 }, activeAssignment: { assignmentId: "a1" }, reviewMode: null, pendingStart: {}, userName: CODE };
      const els = {};
      const el = id => els[id] || (els[id] = { textContent: "", value: "", onclick: null,
        classList: { add(){ calls.push("hide:" + id); }, remove(){}, toggle(){}, contains(){ return true; } } });
      const subList = [];
      const AttemptStore = { onDeleted(fn){ subList.push(fn); }, notifyDeleted(k, r, c){ subList.slice().forEach(fn => { try{ fn(k, r, c); }catch(e){} }); } };
      const body = extractFn(appSrc, "onAttemptDeleted") + "\nasync " + extractFn(appSrc, "endSittingDeleted") + "\n" + (regLine || "") +
        "\nreturn { onAttemptDeleted, endSittingDeleted, els, calls, state, subs: AttemptStore, notify: (k, r, c) => AttemptStore.notifyDeleted(k, r, c) };";
      return new Function("state", "el", "calls", "els", "Attempts", "resetTestChrome", "refreshStudentState", "endDeletedSession", "renderHome", "showOnly", "clearInterval", "clearTimeout", "AttemptStore",
        body)(state, el, calls, els,
        { currentAttemptId: () => liveKey, currentStatus: () => liveStatus || "in-progress", abandonDeleted: k => { calls.push("abandon:" + k); return k; } },
        () => calls.push("resetTestChrome"), async () => { calls.push("refresh"); return refresh === undefined ? true : refresh; },
        () => calls.push("endDeletedSession"), () => calls.push("renderHome"), id => calls.push("show:" + id),
        id => calls.push("clearInterval:" + id), id => calls.push("clearTimeout:" + id), AttemptStore);
    };
    {
      /* through the real subscription, not by calling the router directly */
      const d = build(A);
      let n = 0;
      d.subs.onDeleted = () => { n++; };          // no-op: the count comes from the real one below
      d.notify("probe:none", "attempt", CODE);    // proves a subscriber exists at all
      check(d.calls.length === 0 && n === 0, "a signal for an unrelated key reaches the subscriber and is ignored (a subscriber exists)");
      d.notify(A, "attempt", CODE);
      await new Promise(r => setImmediate(r));
      check(d.calls.indexOf("abandon:" + A) !== -1 && d.calls.indexOf("show:screen-loaderror") !== -1,
        "a refusal delivered through the STORE reaches the landing — store, subscriber and handler are joined", d.calls.join(","));
    }
    {
      /* a FINISHED attempt deleted after the fact is not a sitting that ended */
      const d = build(A, undefined, "completed");
      d.notify(A, "attempt", CODE);
      await new Promise(r => setImmediate(r));
      check(d.calls.indexOf("abandon:" + A) !== -1 && d.calls.indexOf("show:screen-loaderror") === -1
        && d.calls.indexOf("resetTestChrome") === -1 && d.state.currentTest !== null && d.state.sessionGen === 1,
        "a deleted FINISHED attempt lets the recorder go and refreshes, but paints no 'sitting was ended' screen and touches neither the session nor the screen", d.calls.join(","));
    }
    const d = build(A);
    d.onAttemptDeleted(A, "attempt");
    await new Promise(r => setImmediate(r));
    check(d.calls.indexOf("abandon:" + A) !== -1 && d.calls.indexOf("resetTestChrome") !== -1 && d.calls.indexOf("clearInterval:5") !== -1
      && d.calls.indexOf("clearInterval:6") !== -1 && d.calls.indexOf("clearTimeout:7") !== -1,
      "the live sitting is abandoned (no save), its clocks and chrome are torn down", d.calls.join(","));
    check(d.state.currentTest === null && d.state.moduleState && Object.keys(d.state.moduleState).length === 0 && d.state.activeAssignment === null && d.state.sessionGen === 2,
      "the sitting's state is dropped and the session generation is retired, so an in-flight load cannot land a test");
    check(d.calls.indexOf("show:screen-loaderror") !== -1 && d.calls.indexOf("hide:loadErrRetry") !== -1
      && /This sitting was ended/.test(d.els.loadErrTitle.textContent) && /nothing further was saved/.test(d.els.loadErrBody.textContent),
      "the student lands on an honest screen — not a hang — with no retry button", d.els.loadErrTitle.textContent + " | " + d.els.loadErrBody.textContent);
    check(d.calls.indexOf("show:screen-loaderror") < d.calls.indexOf("refresh"),
      "the screen is PAINTED BEFORE the refresh — a store read with no time bound must never leave a dead test screen live and clickable", d.calls.join(","));
    check(d.calls.indexOf("endDeletedSession") === -1, "a single deleted attempt does NOT end the whole session");
    /* the module-over delay: a sitting ended under it must not be resumed,
       submitted, or painted over by the confirmation screen 2.6s later */
    {
      const run = (mutate) => {
        const calls = [], timers = [];
        const state = { sessionGen: 1, moduleOverTimer: null, moduleIndex: 0, currentTest: { testId: "t1", kind: "form" } };
        const fn = new Function("state", "showOnly", "setTimeout", "clearTimeout", "showSetDone", "showSubmitted", "beginModule",
          extractFn(appSrc, "showModuleOver") + "\nreturn showModuleOver;")(
          state, id => calls.push("show:" + id), (f) => { timers.push(f); return timers.length; }, () => calls.push("clearTimeout"),
          () => calls.push("showSetDone"), () => calls.push("showSubmitted"), () => calls.push("beginModule"));
        fn(true);
        mutate(state);
        timers.forEach(f => f());
        return calls;
      };
      check(run(s => { s.sessionGen++; s.currentTest = null; }).join() === "show:screen-moduleover",
        "a sitting ended under the module-over delay: the delay fires and does NOTHING — no submitted screen over the honest landing");
      check(run(() => {}).join() === "show:screen-moduleover,showSubmitted", "control: with the sitting intact the delay shows the confirmation as before");
      const calls2 = run(s => { s.currentTest = null; });
      check(calls2.indexOf("showSubmitted") === -1 && calls2.indexOf("beginModule") === -1,
        "and with currentTest dropped but the generation unchanged it still does nothing — beginModule can never run against a dropped test");
    }
    /* a refusal naming some other attempt must not touch the live sitting */
    const d2 = build(A);
    d2.onAttemptDeleted("attempt:t1:999:zzzz", "attempt");
    await new Promise(r => setImmediate(r));
    check(d2.calls.length === 0 && d2.state.currentTest !== null, "control: a stale refusal for another attempt leaves the sitting alone", d2.calls.join(","));
    /* with no sitting running (between tests, or in review) nothing happens */
    const d3 = build(null);
    d3.onAttemptDeleted(A, "attempt");
    await new Promise(r => setImmediate(r));
    check(d3.calls.length === 0, "control: with no live sitting the signal is inert");
    /* the student was deleted: one landing, the session's own */
    const d4 = build(A);
    d4.onAttemptDeleted(A, "student", CODE);
    await new Promise(r => setImmediate(r));
    check(d4.calls.indexOf("abandon:" + A) !== -1 && d4.calls.indexOf("endDeletedSession") !== -1 && d4.calls.indexOf("show:screen-loaderror") === -1,
      "a deleted STUDENT abandons the sitting without writing and ends the session — one landing, not two", d4.calls.join(","));
    /* THE SHARED-LAPTOP CASE: the sync queue is one device-wide list, so it
       can hold a sibling's leftover write. A 'student deleted' refusal that
       names SOMEONE ELSE'S code must not touch this student's session. */
    const d6 = build(A);
    d6.onAttemptDeleted("attempt:t1:900:zzzz", "student", OTHER);
    await new Promise(r => setImmediate(r));
    check(d6.calls.length === 0 && d6.state.currentTest !== null,
      "a 'student deleted' refusal for ANOTHER student's queued write leaves this student's sitting and session untouched", d6.calls.join(","));
    const d7 = build(A);
    d7.onAttemptDeleted(A, "student");                 // no code at all
    await new Promise(r => setImmediate(r));
    check(d7.calls.length === 0, "…and an unattributed 'student deleted' signal ends nothing either (the session ends only on a positive match)");
    const d8 = build(A);
    d8.onAttemptDeleted(A, "student", CODE.toLowerCase());
    await new Promise(r => setImmediate(r));
    check(d8.calls.indexOf("endDeletedSession") !== -1, "control: the same signal with the signed-in code (any case) does end the session");
    /* the refresh says the code is gone too: the session's landing replaces
       the sitting one (painted first, since the refresh is unbounded) */
    const d5 = build(A, "deleted");
    d5.onAttemptDeleted(A, "attempt");
    await new Promise(r => setImmediate(r));
    check(d5.calls.indexOf("refresh") !== -1 && d5.calls.indexOf("renderHome") === -1,
      "if the refresh reports the code deleted, the ended-sitting handler stops there and leaves the session's own landing in place", d5.calls.join(","));
  });

  /* =================== (e) the SPR audit =================== */
  await run("(e) the SPR audit skips tombstoned records and says how many", async () => {
    const FORM = { testId: "202606asiav2", qid: "ma1-q3" };   // a real SPR question, key "21" (see tests/set-audit.test.js)
    const live = { attemptId: "attempt:202606asiav2:1:live", testId: FORM.testId, student: { key: CODE, code: CODE }, status: "completed",
      answers: { [FORM.qid]: { given: "21", correct: true } } };
    /* the deleted record's STORED verdict disagrees with the recompute — on
       its own this fails the audit; skipped, it must not */
    const dead = { attemptId: "attempt:202606asiav2:2:dead", testId: FORM.testId, student: { key: CODE, code: CODE }, status: "completed",
      answers: { [FORM.qid]: { given: "21", correct: false } } };
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tomb-audit-"));
    const write = (name, payload) => { const p = path.join(dir, name); fs.writeFileSync(p, JSON.stringify(payload)); return p; };
    const runAudit = file => {
      try{ return { code: 0, out: execFileSync(process.execPath, [path.join(__dirname, "spr-grading.test.js"), file], { cwd: repo, env: Object.assign({}, process.env, { SPR_AUDIT_ONLY: "1" }), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) }; }
      catch(e){ return { code: e.status, out: String(e.stdout || "") + String(e.stderr || "") }; }
    };
    const withAttemptTomb = write("with-attempt-tomb.json", { schema: "acestem-attempt-archive-v1", records: [live, dead],
      tombstones: [{ key: "tomb:" + dead.attemptId, value: tomb(dead.attemptId, { testId: FORM.testId }) }] });
    const r1 = runAudit(withAttemptTomb);
    check(r1.code === 0 && /1 tombstoned \(deleted\) record\(s\) skipped/.test(r1.out), "an export whose failing record is tombstoned PASSES and reports 1 skipped", r1.out.split("\n").filter(l => /tombstoned|FAIL|PASS —/.test(l)).join(" | "));
    const withStudentTomb = write("with-student-tomb.json", { records: [live, Object.assign({}, dead, { student: { key: OTHER, code: OTHER } })],
      tombstones: [{ key: "tomb:student:" + OTHER, value: studentTomb(OTHER) }] });
    const r2 = runAudit(withStudentTomb);
    check(r2.code === 0 && /1 tombstoned \(deleted\) record\(s\) skipped/.test(r2.out), "a deleted STUDENT's record is skipped the same way", r2.out.split("\n").filter(l => /tombstoned/.test(l)).join(" | "));
    /* CONTROL: the same export without its tombstones must FAIL on the
       disagreeing verdict — the skip is the marker, not leniency */
    const noTombs = write("no-tombs.json", { records: [live, dead] });
    const r3 = runAudit(noTombs);
    check(r3.code === 1 && /0 tombstoned \(deleted\) record\(s\) skipped/.test(r3.out) && /STORED verdict and the recomputed one differ/.test(r3.out),
      "control: without the tombstones the same export FAILS and reports 0 skipped", r3.out.split("\n").filter(l => /tombstoned|differ|FAIL —/.test(l)).join(" | "));
    /* a marker for some OTHER record does not excuse this one */
    const wrongTomb = write("wrong-tomb.json", { records: [live, dead], tombstones: [{ key: "tomb:attempt:x:9:zz", value: tomb("attempt:x:9:zz") }] });
    check(runAudit(wrongTomb).code === 1, "control: a marker naming a different record does not skip this one");
    /* the audit still refuses an export with NOTHING live to audit */
    const onlyDead = write("only-dead.json", { records: [dead], tombstones: [{ key: "tomb:" + dead.attemptId, value: tomb(dead.attemptId) }] });
    check(runAudit(onlyDead).code === 1, "an export whose only record is tombstoned still fails closed (no gradable SPR answers audited)");
  });

  /* =================== (f) the sync queue =================== */
  await run("(f) a write the server refuses as deleted is dropped; anything else keeps retrying", async () => {
    const drive = async (status, message) => {
      const w = loadAttempts({ config: REAL_CFG, fetch: async (url) => /fn_upsert_attempt/.test(url) ? { status: status, body: { message: message } } : { status: 200, body: [] } });
      const A = "attempt:t1:100:aaaa";
      await w.AS.set(A, rec(A));
      await w.flush();
      const q = JSON.parse(w.ls.getItem("devstore:__syncqueue") || "[]");
      return { q, warns: w.warns, state: w.AS.syncState(), fetched: w.fetches.filter(f => /fn_upsert_attempt/.test(f.url)).length };
    };
    const dropped = await drive(400, "attempt deleted");
    check(dropped.fetched === 1 && dropped.q.length === 0 && dropped.warns.some(s => /DROPPED a queued write for attempt:t1:100:aaaa/.test(s)) && dropped.state.refused === 0,
      "'attempt deleted' (4xx): the item is dropped and the console says so; the pill does NOT go red (the server already holds the record and its marker)", JSON.stringify({ q: dropped.q.length, refused: dropped.state.refused }));
    const dropped2 = await drive(400, "student deleted");
    check(dropped2.q.length === 0 && dropped2.state.refused === 1, "'student deleted' (4xx): dropped, and syncState().refused counts it (this write is genuinely not online)");
    /* the count belongs to the session: sign-in / sign-out / an ended session clear it */
    {
      const w = loadAttempts({ config: REAL_CFG, fetch: async (url) => /fn_upsert_attempt/.test(url) ? { status: 400, body: { message: "student deleted" } } : { status: 200, body: [] } });
      await w.AS.set("attempt:t1:100:aaaa", rec("attempt:t1:100:aaaa"));
      await w.flush();
      check(w.AS.syncState().refused === 1, "refused counted");
      w.AS.clearRefused();
      check(w.AS.syncState().refused === 0, "clearRefused() resets it for the next session");
      check(/AttemptStore\.clearRefused\(\);/.test(extractFn(appSrc, "endDeletedSession")) && /AttemptStore\.clearRefused\(\);/.test(extractFn(appSrc, "signInWithCode")),
        "app.js clears it when a deleted session ends and when a new session signs in");
    }
    /* per-code scoping: the pill asks for the signed-in code's own count, so
       a refusal for someone else's stale write on a shared device never
       reddens this student's pill; no code = the device total */
    {
      const w = loadAttempts({ config: REAL_CFG, fetch: async (url) => /fn_upsert_attempt/.test(url) ? { status: 400, body: { message: "student deleted" } } : { status: 200, body: [] } });
      await w.AS.set("attempt:t1:100:aaaa", rec("attempt:t1:100:aaaa"));
      await w.AS.set("attempt:t1:101:bbbb", rec("attempt:t1:101:bbbb", { student: { code: OTHER, key: OTHER } }));
      await w.flush();
      check(w.AS.syncState(CODE).refused === 1 && w.AS.syncState(OTHER).refused === 1, "syncState(code) counts only that code's refusal", JSON.stringify([w.AS.syncState(CODE), w.AS.syncState(OTHER)]));
      check(w.AS.syncState("as-7k4m9pxr").refused === 1, "the code lookup is case-folded");
      check(w.AS.syncState("AS-ZZZZZZZZ").refused === 0, "a third code reads 0 — another student's refusal does not redden this pill");
      check(w.AS.syncState().refused === 2, "no code = the device total");
      w.AS.clearRefused();
      check(w.AS.syncState(CODE).refused === 0 && w.AS.syncState().refused === 0, "clearRefused() clears every code");
      check(/AttemptStore\.syncState\(state\.userName\)/.test(extractFn(appSrc, "updateSyncTag")), "the pill asks for the signed-in code's count");
    }
    const kept = await drive(500, "attempt deleted");
    check(kept.q.length === 1 && kept.q[0].tries === 1 && kept.state.refused === 0, "control: the same words on a 5xx are NOT a verdict — kept with backoff");
    const kept2 = await drive(400, "not your record");
    check(kept2.q.length === 1 && kept2.q[0].tries === 1 && kept2.state.refused === 0 && kept2.warns.length === 0, "control: a different 4xx message is kept with backoff (exact match only)");
    const kept3 = await drive(400, "attempt deleted!");
    check(kept3.q.length === 1, "control: a near-miss message is not matched");
  });

  /* =================== (g) sign-in fails closed =================== */
  await run("(g) a deleted code cannot sign in — local marker, remote verdict, cache fallback closed", async () => {
    const w = loadAttempts({ search: "?devstorage=1" });
    check(Array.isArray(await w.AT.assignments(CODE)) , "control: no marker — assignments resolve (to a list)");
    seedLocal(w.ls, "tomb:student:" + CODE, studentTomb(CODE));
    check((await w.AT.assignments(CODE)) === "deleted", "local mode: the student marker makes assignments() answer \"deleted\" (sign-in stops)");
    check((await w.AT.loadStudentRecords(CODE)) === "deleted", "local mode: loadStudentRecords answers \"deleted\" too (a signed-in device ends its session)");
    /* remote: the server's exact refusal beats a cached sign-in; nothing on the device is deleted */
    const A = "attempt:t1:100:aaaa";
    const w2 = loadAttempts({ config: REAL_CFG, fetch: async (url) => /fn_get_assignments|fn_get_own_attempts/.test(url) ? { status: 400, body: { message: "student deleted" } } : { status: 200, body: [] } });
    w2.ls.setItem("devstore:__assignsync:" + CODE, "2026-09-01T00:00:00.000Z");
    seedLocal(w2.ls, "assign:" + CODE + ":a1", { assignmentId: "a1", testId: "t1", category: "practice" });
    seedLocal(w2.ls, A, rec(A, { status: "in-progress", submittedAt: null }));       // a never-uploaded sitting
    w2.ls.setItem("devstore:__syncqueue", JSON.stringify([{ key: A, kind: "attempt", code: CODE, value: rec(A), tries: 0, nextAt: 0 }]));
    const v = await w2.AT.assignments(CODE);
    check(v === "deleted", "remote: 'student deleted' from fn_get_assignments answers \"deleted\", never the cached list", String(v));
    check(w2.ls.getItem("devstore:__assignsync:" + CODE) === null, "remote: the assignment sync marker is dropped, so an offline retry cannot fall back to cache");
    check(!!w2.ls.getItem("devstore:" + A) && !!w2.ls.getItem("devstore:assign:" + CODE + ":a1") && JSON.parse(w2.ls.getItem("devstore:__syncqueue")).length === 1,
      "remote: NOTHING on the device is deleted — the never-uploaded sitting, its assignment row and the queue are all still there");
    check((await w2.AT.loadStudentRecords(CODE)) === "deleted", "remote: loadStudentRecords answers \"deleted\" for a signed-in device");
    /* the marker gone + server unreachable = unavailable (retry), not a cached home */
    w2.sandbox.fetch = async () => ({ ok: false, status: 500, text: async () => JSON.stringify({ message: "boom" }) });
    check((await w2.AT.assignments(CODE)) === "unavailable", "remote, then offline: with the marker gone the device answers \"unavailable\" (retry), not the cached assignments");
    /* controls: any other failure keeps the old behaviour */
    const w3 = loadAttempts({ config: REAL_CFG, fetch: async () => ({ status: 500, body: { message: "boom" } }) });
    w3.ls.setItem("devstore:__assignsync:" + CODE, "2026-09-01T00:00:00.000Z");
    seedLocal(w3.ls, "assign:" + CODE + ":a1", { assignmentId: "a1", testId: "t1", category: "practice" });
    const v3 = await w3.AT.assignments(CODE);
    check(Array.isArray(v3) && v3.length === 1 && w3.ls.getItem("devstore:__assignsync:" + CODE) !== null, "control: a 5xx with a sync marker falls back to the cached list (offline behaviour unchanged)");
    const w4 = loadAttempts({ config: REAL_CFG, fetch: async () => ({ status: 400, body: { message: "invalid code" } }) });
    check((await w4.AT.assignments(CODE)) === "unavailable", "control: a different 4xx is \"unavailable\", never \"deleted\"");
    /* a device that already HOLDS the student marker (mirrored by the
       dashboard on a shared laptop) stays closed when the server is
       unreachable — the marker is permanent, so it beats the cache */
    const w5 = loadAttempts({ config: REAL_CFG, fetch: async () => ({ status: 500, body: { message: "boom" } }) });
    w5.ls.setItem("devstore:__assignsync:" + CODE, "2026-09-01T00:00:00.000Z");
    seedLocal(w5.ls, "assign:" + CODE + ":a1", { assignmentId: "a1", testId: "t1", category: "practice" });
    seedLocal(w5.ls, "tomb:student:" + CODE, studentTomb(CODE));
    const v5 = await w5.AT.assignments(CODE);
    check(v5 === "deleted" && w5.ls.getItem("devstore:__assignsync:" + CODE) === null, "remote, offline: a HELD tomb:student marker answers \"deleted\", never the cached list, and drops the sync marker", String(v5));
    check((await w5.AT.loadStudentRecords(CODE)) === "deleted", "remote, offline: loadStudentRecords answers \"deleted\" from the held marker");
    /* and a marker read that FAILS is not "no marker": unavailable, never a cached home */
    const w6 = loadAttempts({ config: REAL_CFG, fetch: async () => ({ status: 500, body: { message: "boom" } }) });
    w6.ls.setItem("devstore:__assignsync:" + CODE, "2026-09-01T00:00:00.000Z");
    seedLocal(w6.ls, "assign:" + CODE + ":a1", { assignmentId: "a1", testId: "t1", category: "practice" });
    const realGet = w6.ls.getItem.bind(w6.ls);
    w6.ls.getItem = k => { if(k === "devstore:tomb:student:" + CODE) throw new Error("storage blip"); return realGet(k); };
    check((await w6.AT.assignments(CODE)) === "unavailable" && (await w6.AT.loadStudentRecords(CODE)) === "unavailable",
      "remote, offline: a marker read that throws is \"unavailable\" on both reads (fail closed)");
    /* app.js wires the sentinel on every entry */
    check(/if\(assigns === "deleted"\)\{\s*await endDeletedSession\(\);\s*return false;/.test(extractFn(appSrc, "signInWithCode")),
      "signInWithCode (typed code, magic link, saved session all go through it) ends the session on \"deleted\"");
    check(/if\(res === "deleted"\)\{\s*await endDeletedSession\(\);\s*return "deleted";/.test(extractFn(appSrc, "refreshStudentState")),
      "refreshStudentState (every later refresh of a signed-in device) ends the session on \"deleted\"");
    const eds = extractFn(appSrc, "endDeletedSession");
    check(!/AttemptStore\.remove|localStorage\.removeItem|purge/.test(eds), "endDeletedSession deletes nothing");
    /* the REAL endDeletedSession, executed against a live-looking state */
    {
      const cleared = { intervals: [], timeouts: [] }, hidden = [], shown = [], calls = [];
      const state = { sessionGen: 3, timerInterval: 7, breakInterval: 8, readyTimer: 9, timerRunning: true, currentTest: { testId: "t1" }, moduleState: { x: 1 },
        pendingStart: {}, reviewMode: {}, userName: CODE, displayName: "E", assignments: [1], assignAttempts: { a: 1 }, pastAttempts: [1], tombstoned: { a: 1 }, resumeRecords: { a: 1 }, activeAssignment: {} };
      let sawAtCall = null, sawAfterTick = null;
      const Attempts = { detach: async () => { sawAtCall = state.currentTest !== null; await new Promise(r => setImmediate(r)); sawAfterTick = state.currentTest !== null; } };
      const AttemptStore = { clearRefused(){ calls.push("clearRefused"); } };
      const els = {}; const el = id => els[id] || (els[id] = { value: "x", textContent: "", classList: { add(){}, remove(){} } });
      const fn = new Function("state", "el", "hide", "showOnly", "forgetSession", "resetTestChrome", "Attempts", "AttemptStore", "clearInterval", "clearTimeout",
        "async " + extractFn(appSrc, "endDeletedSession") + "\nreturn endDeletedSession;")(
        state, el, id => hidden.push(id), id => shown.push(id), () => calls.push("forgetSession"), () => calls.push("resetTestChrome"), Attempts, AttemptStore,
        id => cleared.intervals.push(id), id => cleared.timeouts.push(id));
      await fn();
      check(state.sessionGen === 4 && JSON.stringify(cleared.intervals) === "[7,8]" && JSON.stringify(cleared.timeouts) === "[9]" && state.timerRunning === false && state.readyTimer === null,
        "executed: the generation is retired and both clocks and the ready timer are cleared with their real ids", JSON.stringify(cleared));
      check(sawAtCall === true && sawAfterTick === true && state.currentTest === null,
        "executed: the recorder is detached (and awaited) BEFORE currentTest is dropped");
      check(calls.indexOf("resetTestChrome") !== -1 && calls.indexOf("forgetSession") !== -1 && calls.indexOf("clearRefused") !== -1 && calls.indexOf("resetTestChrome") < calls.indexOf("forgetSession"),
        "executed: the test chrome is reset, the device session forgotten, the pill cleared", calls.join(","));
      check(state.userName === "Student" && state.assignments === null && state.pastAttempts.length === 0 && Object.keys(state.tombstoned).length === 0 && state.reviewMode === null && state.pendingStart === null
        && shown[shown.length - 1] === "screen-signin" && /removed by your tutor/.test(el("signinError").textContent),
        "executed: every piece of student state is dropped and the sign-in screen carries the message");
    }
    check(/state\.readyTimer = setTimeout\(/.test(extractFn(appSrc, "startTestFlowLoaded")) && /state\.readyTimer = setTimeout\(/.test(extractFn(appSrc, "resumeTestFlowLoaded")),
      "both loading→ready beats (start and resume) are stored so an ended session can cancel them");
    check(/state\.sessionGen\+\+;/.test(appSrc.slice(appSrc.indexOf('el("homeSignoutBtn")'), appSrc.indexOf('el("homeSignoutBtn")') + 400)), "sign-out retires the session generation too");
    /* the session fence: content that arrives after the session ended lands nowhere */
    {
      let resolveLoad, onReadyCalls = 0; const shown = [];
      const state = { sessionGen: 1 };
      const w = new Function("state", "showOnly", "el", "loadTest", "LOADING_DEFAULT_MSG", "showTestLoadError",
        "async " + extractFn(appSrc, "withTestContent") + "\nreturn withTestContent;")(
        state, id => shown.push(id), () => ({ textContent: "" }), () => new Promise(r => { resolveLoad = r; }), "msg", () => shown.push("screen-loaderror"));
      const p = w({ testName: "T1" }, () => onReadyCalls++, "home");
      state.sessionGen++;                                   // the session ended while the fetch was in flight
      resolveLoad({ testId: "t1", modules: [{}] });
      await p;
      check(onReadyCalls === 0 && shown.join() === "screen-loading", "withTestContent: content resolving after the session ended calls nothing and paints nothing");
      const state2 = { sessionGen: 1 };
      let calls2 = 0;
      const w2 = new Function("state", "showOnly", "el", "loadTest", "LOADING_DEFAULT_MSG", "showTestLoadError",
        "async " + extractFn(appSrc, "withTestContent") + "\nreturn withTestContent;")(
        state2, () => {}, () => ({ textContent: "" }), async () => ({ testId: "t1" }), "msg", () => {});
      await w2({ testName: "T1" }, () => calls2++, "home");
      check(calls2 === 1, "control: with the session intact the content reaches onReady");
      for(const fn of ["startSetFlow", "resumeSetFlow", "openSetReview", "openReviewMode"]){
        const src = extractFn(appSrc, fn);
        check(/const gen = state\.sessionGen;/.test(src) && (src.match(/if\(gen !== state\.sessionGen\) return;/g) || []).length >= 1,
          fn + " captures the session generation and bails after its awaits");
      }
    }
  });

  /* =================== the paged tutor pull =================== */
  await run("selectAllRows: the tutor pull pages past PostgREST's response cap", async () => {
    const table = [];
    for(let i = 0; i < 1001; i++) table.push({ key: (i < 900 ? "attempt:t1:" + String(100000 + i) + ":x" : "tomb:attempt:t1:" + String(100000 + i) + ":x"), owner_code: CODE, value: { i } });
    table.sort((a, b) => a.key < b.key ? -1 : 1);
    const serve = rows => async (url, o) => {
      const range = o && o.headers && o.headers["Range"];
      const m = /^(\d+)-(\d+)$/.exec(range || "");
      if(!m) return { status: 500, body: { message: "no Range header" } };
      const from = parseInt(m[1], 10), to = parseInt(m[2], 10);
      return { status: 206, body: rows.slice(from, to + 1) };
    };
    const w = loadAttempts({ config: REAL_CFG, fetch: serve(table) });
    const all = await w.AS.adminSelectAll();
    const tombs = all.filter(r => r.key.indexOf("tomb:") === 0).length;
    check(all.length === 1001 && tombs === 101 && new Set(all.map(r => r.key)).size === 1001 && w.fetches.length === 4,
      "1001 rows come back complete (every tomb row included, no duplicates); the pull ends on the EMPTY page", all.length + " rows, " + tombs + " tombs, " + w.fetches.length + " fetches");
    const exact = table.slice(0, 1000);
    const w2 = loadAttempts({ config: REAL_CFG, fetch: serve(exact) });
    const all2 = await w2.AS.adminSelectAll();
    check(all2.length === 1000 && w2.fetches.length === 3, "an exact multiple of the page size: two full pages, then the empty one", all2.length + "/" + w2.fetches.length);
    /* a server whose max-rows is BELOW the page size clamps every page and
       says nothing — the pull must keep going by what came back */
    const capped = rows => async (url, o) => { const r = await serve(rows)(url, o); return { status: r.status, body: r.body.slice(0, 100) }; };
    const w2b = loadAttempts({ config: REAL_CFG, fetch: capped(table) });
    const all2b = await w2b.AS.adminSelectAll();
    check(all2b.length === 1001 && new Set(all2b.map(r => r.key)).size === 1001 && w2b.fetches.length === 12,
      "a server capped at 100 rows per response still yields all 1001 rows (11 pages + the empty one)", all2b.length + "/" + w2b.fetches.length);
    const w3 = loadAttempts({ config: REAL_CFG, fetch: async (url, o) => { const r = /^(\d+)-/.exec(o.headers["Range"]); return parseInt(r[1], 10) >= 500 ? { status: 500, body: { message: "boom" } } : (await serve(table)(url, o)); } });
    let threw = false;
    try{ await w3.AS.adminSelectAll(); }catch(e){ threw = true; }
    check(threw, "a failing later page REJECTS the whole pull — never a silently partial mirror");
    /* a server that ignores the offset must not spin the tutor's load */
    const w3b = loadAttempts({ config: REAL_CFG, fetch: async () => ({ status: 206, body: table.slice(0, 500) }) });
    let threw2 = false;
    try{ await w3b.AS.adminSelectAll(); }catch(e){ threw2 = /no progress/.test(e.message); }
    check(threw2 && w3b.fetches.length === 2, "a server that ignores Range (same rows again) is detected on the second page and rejected", w3b.fetches.length + " fetches");
    /* the mirror it feeds: every row, tomb rows included */
    const w4 = loadAttempts({ config: REAL_CFG, fetch: serve(table) });
    const n = await w4.AS.pullAllForTutor();
    check(n === 1001 && !!w4.ls.getItem("devstore:" + table[table.length - 1].key), "pullAllForTutor mirrors all 1001 rows");
  });
  await run("dashboard: the marker loader keeps only well-formed rows whose key matches their target", async () => {
    const store = new Map();
    const AS = { async list(p){ return [...store.keys()].filter(k => k.indexOf(p) === 0).sort(); }, async get(k){ return store.has(k) ? JSON.parse(JSON.stringify(store.get(k))) : null; } };
    const body = "let assigns = [], bugs = [], profiles = {}, tombs = {}, sets = [];\nasync function loadSets(){}\nasync " + extractFn(dashSrc, "loadAssignsAndBugs") +
      "\nreturn async () => { await loadAssignsAndBugs(); return { tombs, profiles, assigns, bugs }; };";
    const load = new Function("AttemptStore", body)(AS);
    const A = "attempt:t1:100:aaaa";
    store.set("tomb:" + A, tomb(A));                                       // well-formed
    store.set("tomb:attempt:t1:200:bbbb", tomb(A));                        // target disagrees with the key
    store.set("tomb:student:" + CODE, studentTomb(OTHER));                 // student target disagrees
    store.set("tomb:student:" + OTHER, studentTomb(OTHER));                // well-formed
    store.set("tomb:attempt:t1:300:cccc", { kind: "tombstone", target: "attempt:t1:300:cccc" });   // no targetKind
    store.set("tomb:attempt:t1:400:dddd", "not an object");
    const r = await load();
    check(Object.keys(r.tombs).sort().join() === ["tomb:" + A, "tomb:student:" + OTHER].join(), "only the two well-formed, key-matching markers are kept", Object.keys(r.tombs).join(","));
  });
  await run("dashboard: the release toggle refuses a deleted record; the tombstone helper refuses a malformed server answer", async () => {
    /* built like tests/tutor-writes.test.js's closure, minimal */
    const calls = [];
    const AS = { isRemote: () => true, async adminUpsert(k){ calls.push(["adminUpsert", k]); return null; }, async setLocal(k, v){ calls.push(["setLocal", k]); return true; },
      async adminRpc(fn, a){ calls.push(["adminRpc", fn]); return AS.answer; }, async get(){ return null; }, tutorIdentity: () => "t" };
    const els = {}; const $ = id => els[id] || (els[id] = { textContent: "" });
    const NAMES = ["tombFor", "isDeletedStudent", "isTombstoned", "describeRow", "rejectedText", "tombstoneRejectedText", "isTombValue", "localTombstone", "assignmentsAtDeletion", "sameTest", "tutorTombstone", "toggleRelease", "releaseCell"];
    const src = NAMES.map(n => (n === "tutorTombstone" || n === "toggleRelease" ? "async " : "") + extractFn(dashSrc, n)).join("\n\n");
    const d = new Function("AttemptStore", "$", "escAttr", "esc", "let tombs = {}, recs = [], assigns = [], profiles = {}, source = 'storage';\nconst testsById = {};\nfunction render(){}\nasync function tutorPut(k, o, v){ return { ok: (await AttemptStore.adminUpsert(k, o, v), true) }; }\n" + src +
      "\nreturn { seed(o){ Object.assign({}, o); if(o.tombs) tombs = o.tombs; if(o.recs) recs = o.recs; }, toggleRelease, tutorTombstone };")(AS, $, s => String(s), s => String(s));
    const A = "attempt:t1:100:aaaa";
    const r = rec(A, { released: false });
    d.seed({ recs: [r], tombs: { ["tomb:" + A]: tomb(A) } });
    await d.toggleRelease(A);
    check(r.released === false && !calls.some(c => c[0] === "adminUpsert") && /deleted record is never released/.test($("dashStatus").textContent),
      "toggleRelease on a deleted record: no write, the flag untouched, a message that says why");
    d.seed({ recs: [r], tombs: {} });
    await d.toggleRelease(A);
    check(r.released === true && calls.some(c => c[0] === "adminUpsert" && c[1] === A), "control: the same record undeleted releases through the tutor write");
    /* the helper trusts nothing but a marker */
    for(const [answer, label] of [[null, "null"], [{ kind: "tombstone" }, "no target"], [{ target: A }, "no kind"], ["str", "a string"]]){
      calls.length = 0; AS.answer = answer;
      const res = await d.tutorTombstone("attempt", A);
      check(res.ok === false && /without a deletion marker/.test(res.message) && !calls.some(c => c[0] === "setLocal"), "server answered " + label + ": refused, nothing mirrored", res.message);
    }
    calls.length = 0; AS.answer = { student: { kind: "tombstone", targetKind: "student", target: CODE }, attempts: [{ key: "attempt:x", value: tomb("attempt:x") }] };
    const res = await d.tutorTombstone("student", CODE);
    check(res.ok === false && !calls.some(c => c[0] === "setLocal"), "a student answer with a non-tomb: row key is refused whole, nothing mirrored");
    /* the RPC's own refusals get their own wording; a 401 keeps the sign-in advice */
    AS.adminRpc = async () => { const e = new Error("attempt is in progress"); e.status = 400; throw e; };
    const r1 = await d.tutorTombstone("attempt", A);
    check(/^Not deleted — the deletion marker for attempt attempt:t1:100:aaaa: the server is still on the older migration, which only allowed finished attempts — re-apply supabase\/migrations\/2026-09-18_tombstones\.sql/.test(r1.message) && !/Sign in again/.test(r1.message),
      "a 400 'attempt is in progress' names the deploy window it really means (app live, migration not re-applied), without 'sign in again'", r1.message);
    AS.adminRpc = async () => { const e = new Error("JWT expired"); e.status = 401; throw e; };
    const r2 = await d.tutorTombstone("attempt", A);
    check(/the tutor sign-in has expired/.test(r2.message) && /Sign in again and retry/.test(r2.message), "a 401 keeps the generic expired-session wording", r2.message);
    AS.adminRpc = async () => { const e = new Error("<img src=x onerror=1> weird"); e.status = 400; throw e; };
    const r3 = await d.tutorTombstone("attempt", A);
    check(/the server refused it \(HTTP 400\)/.test(r3.message) && r3.message.indexOf("<img") === -1, "an unknown 4xx message is never echoed", r3.message);
    AS.adminRpc = async () => { const e = new Error("Could not find the function public.fn_tombstone_attempt(p_key) in the schema cache"); e.status = 404; throw e; };
    const r4 = await d.tutorTombstone("attempt", A);
    check(/^Not deleted — the deletion marker for attempt attempt:t1:100:aaaa: the server has no delete function yet — the 2026-09-18 migration has not been applied\. This browser's copy is unchanged\.$/.test(r4.message) && !/Sign in again/.test(r4.message),
      "a PostgREST 404 (migration not applied) names the migration, without 'sign in again'", r4.message);
    AS.adminRpc = async () => { const e = new Error("HTTP 404"); e.status = 404; throw e; };
    check(/migration has not been applied/.test((await d.tutorTombstone("attempt", A)).message), "a bare 404 reaches the same branch");
  });

  /* =================== the Students tab and the confirmation panel, executed =================== */
  await run("dashboard: the Students tab renders deleted students and markers; the panel names and gates", async () => {
    const esc = s => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const escAttr = s => esc(s).replace(/"/g, "&quot;").replace(/'/g, "&#39;");
    const StudentCode = { valid: c => /^AS-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/.test(String(c || "").trim().toUpperCase()),
      normalize: c => String(c || "").trim().toUpperCase().replace(/\s+/g, "") };
    /* element stubs with the little DOM the panel touches */
    const els = {};
    const mkEl = () => { const e = { value: "", textContent: "", innerHTML: "", disabled: false, handlers: {}, classList: { add(){}, remove(){}, toggle(){} },
      addEventListener(ev, fn){ (this.handlers[ev] = this.handlers[ev] || []).push(fn); }, focus(){},
      fire(ev, arg){ (this.handlers[ev] || []).forEach(fn => fn(arg || {})); }, click(){ this.fire("click"); } }; return e; };
    const $ = id => els[id] || (els[id] = mkEl());
    const NAMES = ["tombFor", "isDeletedStudent", "isTombstoned", "orphanStubs", "deleteGateOk", "statusBadge", "nameFor", "studentCell", "codeOptionLabel",
      "isFinishedAttempt", "isInProgressAttempt", "isDeletableAttempt", "fmtDate", "num", "cnt", "countPair", "scoreStr", "timingLabel", "timingBadgeHtml", "viewStudents",
      "renderConfirmPanel", "confirmDeleteAttempt", "confirmDeleteStudent"];
    const body = "const testsById = {};\n" + NAMES.map(n => extractFn(dashSrc, n)).join("\n\n") +
      "\nconst calls = [];\nasync function deleteAttempt(r){ calls.push(['attempt', r.attemptId]); return { ok: true }; }\nasync function deleteStudent(c){ calls.push(['student', c]); return { ok: true }; }" +
      "\nreturn { viewStudents, confirmDeleteAttempt, confirmDeleteStudent, isDeletableAttempt, isInProgressAttempt, calls, get openAttemptId(){ return openAttemptId; }, setOpen(id){ openAttemptId = id; }, set(o){ Object.assign(S, o); tombs = S.tombs; recs = S.recs; assigns = S.assigns; profiles = S.profiles; source = S.source; } };";
    const S = { tombs: {}, recs: [], assigns: [], profiles: {}, source: "storage" };
    const d = new Function("S", "esc", "escAttr", "StudentCode", "$", "Date",
      "let tombs = S.tombs, recs = S.recs, assigns = S.assigns, profiles = S.profiles, source = S.source, openAttemptId = null;\n" + body)(S, esc, escAttr, StudentCode, $, Date);
    const A = "attempt:t1:100:aaaa", B = "attempt:t1:200:bbbb", O = "attempt:t1:300:cccc";
    $("dashFilterTest").value = ""; $("dashFilterStudent").value = "";
    d.set({ recs: [rec(A), rec(B, { assignmentId: "a2" }), rec("attempt:t1:900:zzzz", { student: { code: OTHER, key: OTHER } })],
      tombs: { ["tomb:" + A]: tomb(A), ["tomb:" + O]: tomb(O), ["tomb:student:" + OTHER]: studentTomb(OTHER) },
      profiles: { [CODE]: "Erin K" }, assigns: [] });
    const html = d.viewStudents(S.recs);
    const cards = html.split('<div class="dcard').slice(1);
    const live = cards.find(c => c.indexOf(CODE) !== -1), dead = cards.find(c => c.indexOf(OTHER) !== -1);
    check(!!live && /2 attempt\(s\), 1 deleted, 1 deleted marker\(s\) whose record was archived away/.test(live) && /student-del/.test(live) && /copy-link/.test(live) && /class="tomb"/.test(live),
      "live student card: counts deleted rows and orphan markers, keeps both buttons, marks the deleted row", live && live.slice(0, 300));
    check(!!dead && dead.indexOf(' deleted">') === 0 && />deleted</.test(dead) && !/student-del/.test(dead) && !/copy-link/.test(dead),
      "deleted student card: dashed, badged, no sign-in link, no Delete button", dead && dead.slice(0, 300));
    const d2html = (() => { d.set({ recs: [], tombs: { ["tomb:student:" + OTHER]: studentTomb(OTHER) }, profiles: {}, assigns: [] }); return d.viewStudents([]); })();
    check(/AS-JKLMNPQR/.test(d2html) && /Deleted student — no attempts on record/.test(d2html), "a deleted student with no rows at all is still listed (from the marker key)");
    /* the confirmation panel, executed */
    d.set({ recs: [rec(A), rec(B, { assignmentId: "a2", status: "in-progress", submittedAt: null }), rec(O, { assignmentId: "a3" })], tombs: { ["tomb:" + O]: tomb(O) }, profiles: { [CODE]: "Erin <K>" }, assigns: [{ code: CODE, list: [{ assignmentId: "a1" }] }] });
    /* the stubs cannot parse markup, so the panel's INITIAL state is read
       from the HTML it wrote (the `disabled` attribute on the button); the
       handlers then drive the stub's property, as the browser would */
    const fresh = () => { delete els.dtcGo; delete els.dtcInput; delete els.dtcCancel; delete els.dtcMsg; };
    fresh();
    d.setOpen(A);                                          // a detail pane was open for A
    d.confirmDeleteStudent(CODE);
    check(d.openAttemptId === null, "the student panel clears openAttemptId — a lazy load settling can never replace it with openDetail()");
    const p = $("dashDetailBody").innerHTML;
    check(/Delete this student\?/.test(p) && /Erin &lt;K&gt;/.test(p) && new RegExp(CODE).test(p) && /3 on record — 1 finished, 1 in progress, 1 already deleted/.test(p) && /Assignments:<\/b> 1/.test(p),
      "student panel names the (escaped) display name, the code, and counts each attempt ONCE (an already-marked one is not also counted as finished)", p.slice(0, 400));
    check(!/<option|multiple|checkbox/.test(p) && /there is no bulk delete/.test(p), "student panel: one target, says so");
    const go = $("dtcGo"), input = $("dtcInput");
    check(/id="dtcGo" disabled>/.test(p), "panel opens with Delete disabled");
    go.disabled = true;
    input.value = OTHER; input.fire("input"); check(go.disabled === true, "another student's code keeps it disabled");
    input.value = CODE.slice(0, -1); input.fire("input"); check(go.disabled === true, "a truncated code keeps it disabled");
    input.value = " as-7k4m 9pxr "; input.fire("input"); check(go.disabled === false, "the student's own code (any case, stray spaces) enables it");
    input.value = ""; input.fire("input"); check(go.disabled === true, "clearing the field disables it again");
    /* the click re-checks the gate: a stale enabled button with a wrong value does nothing */
    input.value = OTHER; go.disabled = false; go.click(); await new Promise(r => setImmediate(r));
    check(d.calls.length === 0, "a click with the wrong code typed runs NOTHING even if the button were somehow enabled");
    input.value = CODE; input.fire("input"); go.click(); await new Promise(r => setImmediate(r));
    check(d.calls.length === 1 && d.calls[0][0] === "student" && d.calls[0][1] === CODE, "a click with the right code runs deleteStudent for exactly that code", JSON.stringify(d.calls));
    /* the attempt panel */
    d.calls.length = 0;
    fresh();
    d.setOpen(A);
    d.confirmDeleteAttempt(rec(A));
    check(d.openAttemptId === null, "the attempt panel clears openAttemptId");
    d.setOpen(A); $("dtcCancel").click();
    check(d.openAttemptId === null, "Cancel leaves no stale id behind the hidden pane");
    const q = $("dashDetailBody").innerHTML;
    check(/Delete this attempt\?/.test(q) && /Erin &lt;K&gt;/.test(q) && /T1/.test(q) && /assignment for it stays <b>Completed<\/b>/.test(q),
      "attempt panel names the student, the test and says the assignment stays Completed (tagged attempt)", q.slice(0, 400));
    fresh();
    d.confirmDeleteAttempt(rec(B, { assignmentId: null }));
    check(/may become startable again/.test($("dashDetailBody").innerHTML), "an untagged attempt's panel says its assignment may become startable");
    check(/id="dtcGo" disabled>/.test($("dashDetailBody").innerHTML), "attempt panel opens disabled");
    /* IN PROGRESS (2026-09-21): offered, and the panel says in plain words
       that the sitting ends, that answers from now on are not saved, and
       that the assignment becomes startable again */
    fresh();
    const liveRec = rec(B, { status: "in-progress", submittedAt: null, assignmentId: "a2" });
    check(d.isDeletableAttempt(liveRec) === true, "an in-progress sitting is offered for deletion");
    d.confirmDeleteAttempt(liveRec);
    const ip = $("dashDetailBody").innerHTML;
    check(/Delete this sitting in progress\?/.test(ip) && /This sitting is IN PROGRESS/.test(ip) && /<b>ends it<\/b>/.test(ip)
      && /<b>not counted<\/b>/.test(ip) && /startable again/.test(ip) && /never be resumed/.test(ip)
      && /as soon as it sees the marker/.test(ip),
      "the in-progress panel names the sitting, the loss and the re-sit before the code is typed", ip.slice(0, 500));
    check(/not erased or edited <b>by this deletion<\/b>/.test(ip) && /may write one last checkpoint/.test(ip),
      "…and the audit promise is exact: the deletion edits nothing, but a sitting still open on the device may write one last checkpoint before it stops");
    check(/id="dtcGo" disabled>/.test(ip) && /Type the student code/.test(ip), "the in-progress panel is gated like any other");
    check(!/their assignment for it stays <b>Completed<\/b>/.test(ip), "the in-progress panel never claims the assignment stays Completed");
    /* still not offered for an already-deleted record or one without a real code */
    const before = $("dashDetailBody").innerHTML;
    d.calls.length = 0;
    d.confirmDeleteAttempt(rec(O)); d.confirmDeleteAttempt(rec(A, { student: { code: "?", key: "?" } }));
    check($("dashDetailBody").innerHTML === before && d.calls.length === 0, "the panel still refuses an already-deleted and a code-less record");
  });

  /* =================== (h) the gate, and no bulk / no hard delete =================== */
  await run("(h) the confirmation gate and the no-bulk, no-hard-delete sweeps", async () => {
    const d = dashWorld({});
    check(d.deleteGateOk("as-7k4m 9pxr", CODE) && !d.deleteGateOk("", CODE) && !d.deleteGateOk(OTHER, CODE) && !d.deleteGateOk(CODE.slice(0, -1), CODE),
      "deleteGateOk: only the student's own code, typed back, opens the gate");
    const panel = extractFn(dashSrc, "renderConfirmPanel");
    check(/dtcInput/.test(panel) && /deleteGateOk\(input\.value, p\.code\)/.test(panel) && (panel.match(/deleteGateOk\(/g) || []).length >= 2,
      "the panel gates the button AND re-checks the gate at the click");
    check(!/select[^>]*multiple/.test(panel) && !/forEach|\.map\(/.test(panel), "the panel handles exactly one target — no list, no multi-select");
    /* the sweeps read CODE, not prose: comments are stripped first so a
       sentence like "there is no bulk delete" cannot trip (or hide) anything */
    const stripComments = s => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1");
    const code = stripComments(dashSrc);
    const students = extractFn(dashSrc, "viewStudents");
    const od = stripComments(extractFn(dashSrc, "openDetail"));
    check((students.match(/student-del/g) || []).length === 1 && (code.match(/Delete student…/g) || []).length === 1
      && (code.match(/Delete this attempt…/g) || []).length === 1 && (code.match(/Delete this sitting…/g) || []).length === 1
      && (od.match(/Delete this attempt…/g) || []).length === 1 && (od.match(/Delete this sitting…/g) || []).length === 1,
      "exactly one 'Delete student…' per card, and ONE attempt button per detail pane — its finished and in-progress labels are the two branches of a single emitter inside openDetail");
    check(!/deleteAll|deleteStudents\(|deleteAttempts\(|tombstoneAll|tombstoneStudents|Delete all|delete all|Delete selected/i.test(code)
      && !/type="checkbox"[^>]*(att|student|del|tomb)/i.test(code),
      "no bulk affordance anywhere in dashboard.js code (no *All/*Students/*Attempts deleter, no 'Delete all/selected', no per-row delete checkboxes)");
    const callers = name => (code.match(new RegExp("\\b" + name + "\\(", "g")) || []).length;
    check(callers("deleteStudent") === 2 && /onGo: \(\) => deleteStudent\(c\)/.test(code), "deleteStudent is called from exactly one place: the confirmation panel");
    check(callers("deleteAttempt") === 2 && /onGo: \(\) => deleteAttempt\(r\)/.test(code), "deleteAttempt is called from exactly one place: the confirmation panel");
    check((code.match(/adminRpc\(/g) || []).length === 2 && (stripComments(extractFn(dashSrc, "tutorTombstone")).match(/adminRpc\(/g) || []).length === 2,
      "adminRpc (the tutor-only server call) is used only inside tutorTombstone");
    check(!/fn_tombstone/.test(stripComments(dashSrc.replace(extractFn(dashSrc, "tutorTombstone"), ""))), "no other code names a tombstone function");
    const tt = extractFn(dashSrc, "tutorTombstone");
    check(!/adminDelete|adminUpsert|\.remove\(|tutorDelete|tutorPut/.test(tt), "tutorTombstone never deletes, never upserts a record — it mirrors marker rows only");
    check(!/tomb:/.test(extractFn(dashSrc, "migrateLocalToServer").match(/for\(const prefix of \[[^\]]*\]\)/)[0]),
      "the upload button does not carry tomb: rows (a marker is written only through the confirmed flow)");
    check(/retiredOnServer\[ownerUp\] \|\| isDeletedStudent\(ownerUp\)/.test(extractFn(dashSrc, "migrateLocalToServer")) && /markedOnServer\[k\] \|\| tombFor\(k\)/.test(extractFn(dashSrc, "migrateLocalToServer")),
      "the upload button skips rows of deleted students and marked attempts, by the server's markers and this browser's");
    check(!/tutorDelete\(|adminDelete\(/.test(extractFn(dashSrc, "deleteAttempt")) && !/tutorDelete\(|adminDelete\(/.test(extractFn(dashSrc, "deleteStudent")),
      "neither deletion action calls a hard-delete helper");
    const wire = stripComments(extractFn(dashSrc, "wire"));
    check(/if\(e\.target\.id === "dashDetail"\)\{\s*openAttemptId = null;\s*\$\("dashDetail"\)\.classList\.add\("hidden"\);/.test(wire),
      "clicking the overlay backdrop clears openAttemptId before hiding the pane");
    check(/^\s*openAttemptId = null;/m.test(stripComments(extractFn(dashSrc, "renderConfirmPanel"))), "renderConfirmPanel clears openAttemptId (the text guard behind the executed check)");
  });

  console.log(`\n${fail ? "FAIL" : "ALL PASS"} — ${pass} passed, ${fail} failed`);
  if(failures.length){ console.log("Failures:"); failures.forEach(f => console.log("  - " + f)); }
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error("HARNESS ERROR:", e && e.stack || e); process.exit(2); });
