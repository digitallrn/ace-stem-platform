# Mission brief: Ace STEM Bluebook Simulator — the PLATFORM repo
*Read automatically at the start of every Claude Code session in this folder.*

**A push is a deploy — hold it for the review (2026-08-01).** Real students
are about to exist, and `git push` on this repo builds and publishes
sat.davidsatprep.com. So for any change touching **attempt records, timing,
scoring, sync, resume, or a security surface**: run the adversarial review of
the diff, and **do not push until it has completed and every confirmed finding
is either fixed or explicitly rejected with a stated reason**. Committing while
the review runs is fine; pushing is not. Cosmetic and content-rendering changes
(copy, CSS, tokens, test-data regens) may push without waiting. The rule exists
because a review that lands after the push has already failed at its job — this
happened on 49cddb7, where the review found a crash between modules that lost a
student's whole sitting, minutes after it went live.

Two clarifications learned the hard way on 7467039, which was pushed early:
**"the review completed" means the completion notification arrived** — a
partial count of verdicts in the journal is not that signal, and reading one as
if it were is how a 49-agent review gets mistaken for a finished one. And
**a review that confirms findings after the push is not a pass**; the fix goes
out as its own commit, and the miss gets said out loud rather than folded
quietly into the next message.

**A test that needs propping up is a broken test (2026-08-01).** The moment a
check requires a workaround to go green — hand-feeding it a global, setting up
state it should establish itself, skipping the build it is supposed to cover —
**stop and treat the check itself as the defect**. Fix the check first, then
re-run it; a green obtained by scaffolding proves nothing and actively hides
the thing it was built to catch. Two instances, both mine, both in the same
change: `tests/injection-proof.js` still read the removed `window.TEST_DATA`
and threw on its first line, and I kept it "passing" for several runs by
assigning that global by hand — my only XSS regression gate, dead, while
reporting 25/25. And `dist/index-live.html` went unopened for the whole test-
library restructure, so a boot-order bug that broke resume in the published
artifact survived every check I did run. Corollary: when a check is awkward to
run, that awkwardness is information about the check, not an obstacle to route
around.

**Assignments are the only source of student-visible material (2026-08-01).**
A student code with no assignments sees **nothing** — both Your Tests and
Practice and Prepare render their empty states. Absent and explicitly-empty are
equivalent. This **reverses the Phase D / Phase F "zero-config" default** (no
`assign:` key ⇒ every published test as practice); the reason is that all
material should be explicitly granted, so a never-configured code can't
silently carry the whole bank. Don't reintroduce an "if nothing assigned, show
everything" branch — the empty state is the correct outcome. A read *failure*
stays distinct and still returns `"unavailable"` (sign-in shows a retry), since
answering "nothing assigned" from a failed read would hide a proctored sitting.
See ATTEMPTS-SPEC §10.

**Product name (2026-08-01): the simulator brands itself "Ace SAT"** on every
user-facing surface — sign-in logo/note/footer, page title, 404, printed
score-report wordmark — with no ™. "Ace STEM" remains the name of the tutoring
business (and of internal identifiers: `ACESTEM_CONFIG`, `acestem-admin`,
`acestem:code`, the archive schema string — never rename those). New
user-facing copy says Ace SAT; never show a real or issuable student code as
an example (use `AS-XXXXXXXX`).

**Deletion is a tombstone, never an edit or a hard delete (2026-09-18;
in-progress attempts added 2026-09-21).**
The tutor can delete one attempt — finished **or in progress** — or one
student from the dashboard; both
write a SEPARATE marker row — `tomb:<attemptKey>` / `tomb:student:<CODE>`,
owner_code the student, value `{kind:"tombstone", target, deletedAt,
deletedBy, …}` plus a server-copied identity summary (testId, assignmentId,
status — never answers, score or a name). The record and profile rows stay
byte-identical, so an audit can always tell "removed" (row + marker) from
"never existed". Server side (`supabase/migrations/2026-09-18_tombstones.sql`):
`fn_tombstone_attempt` / `fn_tombstone_student` are SECURITY DEFINER, EXECUTE
for `authenticated` only, and re-check the JWT role; a trigger makes `tomb:`
rows permanent (no UPDATE/DELETE by anyone); every student RPC raises
`student deleted` for a retired code and `fn_upsert_attempt` raises `attempt
deleted` for a marked key — the client treats exactly those two messages as
terminal (the queued write is dropped with a console warning; everything
else keeps its backoff). Student side: `Attempts.loadStudentRecords()`
returns `{live, tombstones}`; a deleted attempt is on NO student surface, and
its stub feeds `buildAssignmentIndex` only through its explicit assignmentId
so the assignment stays Completed (25ef8f7) — an untagged deleted sitting
never closes a later one. **The marker's `status` is the only thing that
tells the two cases apart**: a FINISHED one keeps its assignment Completed, an
IN-PROGRESS one leaves it **startable** (nothing was submitted), because
`attemptCompleted` is false for the stub and `attemptResumable` needs a
resume/checkpoint blob a stub never carries. So never let a marker reach a
surface with a missing or invented status, never let the untagged fallback
open for an assignment that has an explicit record, and never write a
`completedAttemptId` hint that names no real attempt. A sitting deleted while
it is LIVE ends honestly: the queue's terminal refusal (or, with no server,
the recorder finding its own marker on the next checkpoint) reaches
`AttemptStore.onDeleted`, and app.js abandons the recorder **without
writing** and lands on a plain "This sitting was ended" screen. `Attempts.assignments()` answers `"deleted"` for a
retired code (every entry fails closed; nothing on the device is removed —
not even a deleted attempt's local copy, which the marker's key keeps off
every surface). An untagged deleted sitting keeps closed only an assignment
that existed when it was deleted (the marker's `assignmentsAtDeletion`,
recorded by the server at one instant — never a clock comparison).
Dashboard: present-but-marked everywhere, excluded from analysis and the seen
set, retired codes never re-issued or re-assigned; the confirmation names the
student/attempt and requires the code typed back; one target per action, no
bulk path. `deleteArchived` (export-gated archive rotation, §7b) is
unchanged and never touches `tomb:` rows. Proofs: `tests/tombstone.test.js`,
`tests/tombstone-live-proof.js` (anon against the live project), and the
tombstone cases in `tests/tutor-writes.test.js`; the SPR audit skips marked
records and prints how many. **Do not add a hard-delete, an un-delete, or any
multi-target delete to the dashboard.** Two honest limits: the tutor-only and
permanence guarantees are REMOTE-mode properties — in local/artifact mode a
marker is a row like any other (same posture as the unauthenticated local
dashboard); and a device that never comes online after a deletion keeps
working from its cache — including a sitting deleted while that device was
offline, which it will still resume. **Deploy order: app first, then the
migration** (the HEAD client reads `student deleted` as an outage and signs
in from cache). **The migration changed on 2026-09-21 and must be re-applied
after that deploy** — same order, same file, `create or replace` throughout.
The one thing no test can reach is the authenticated tutor call itself — the
migration header names the non-destructive human probes (A: the tutor call is
permitted; B: markers are permanent; D: the untagged-record rule runs as
written; E: an in-progress sitting can be marked and is then refused its own
writes) and an optional full run C. Async flows (a content fetch, a set
resolve or resume, a review open) capture `state.sessionGen` and bail if the
session ended under them — keep that fence on any new await in a start path.

**The tutor test viewer writes NOTHING (2026-10-21).** Dashboard → **Tests**
lists every manifest form (assigned or not) and opens any of them read-only —
the replacement for assigning a form to a code and sitting it to look at it,
which wrote real attempt records (the AS-DAVDTEST junk that had to be
tombstoned; a tutor's unfinished sitting blocking a form's bump in
bump_impact.py). It is Review Mode's replay with nobody's work in it:
`openTestViewer` (app.js) sets `state.reviewMode = {…, viewer:true}` with a
frozen in-memory stand-in record keyed `viewer:<testId>` (never an `attempt:`
key; handed to `buildModuleStateFromRecord` and nothing else — never to
Attempts, AttemptStore or the queue). Every viewer branch in a shared function
is keyed on `state.reviewMode.viewer === true`, so live sittings and both
review flows evaluate exactly as before. Rules: content comes through
`loadTestReadOnly` (memory → cache READ → script-tag GET; **never**
`loadTest`/`AppTestLoader.load`/`ensureTestLoaded`, which write the offline
cache — 20-plus forms through it is the c8a2740 quota blowup); a form the
viewer or the Tests tab's per-module counts loaded is taken back OUT of
memory when they are done (`restoreMemory`), because Past cards and the Score
Calculator read what is loaded and a student may sit next on that page;
`Attempts.detach()` is awaited before any state change (a sitting earlier on
the page can leave the recorder attached to `state`, and its tab-hide flush
would rebuild that student's record from the viewer's empty answers — the
tutor's entry detaches it first, this is the second layer); Report a bug is
hidden in the viewer (it writes), with a second-layer refusal in the bug send
handler, and the Calculator is shown but never wired (Desmos is unvouched
third-party code whose expressions would outlive the viewer); exit is `showOnly
("screen-dashboard")`, **never** `Dashboard.open` (its reload pulls and writes
the mirror in remote mode). Tutor-only: the bridge `AppTestViewer.open`
refuses unless `#screen-dashboard` is the screen showing and, on any
deployment WITH a server (`AttemptStore.remoteConfigured()` — the live site),
a real tutor token is held — so `?devstorage=1` + `acestem-admin` on the live
site lists the forms and opens none (that dashboard has no password; the
viewer must not be a student-reachable view of every key). Builds with no
server (single-file, Stage-3 preview, file://) keep the local dashboard as
the tutor's way in. Its one caller is the Tests tab; no URL, hash or magic
link reaches it (a source sweep pins the seven pre-existing URL reads). Tutor
entry (`enterTutorSession`, both routes) forgets a remembered student code,
drops the student identity and bumps `sessionGen`, and `signInWithCode`
bails after each of its awaits when the generation moved (boot then leaves
the screen alone), so a boot-time restore the tutor overtakes lands nowhere
and a reload from the dashboard or viewer lands on sign-in — never in that
student's crash-resumed sitting. `refreshStudentState` has the same fence
and answers `"deleted"` (session over — never `false`, "carry on") when the
generation moved, so Save and Exit / Back to home stop instead of painting
home over whatever ended the session (a deletion landing included), and Save
and Exit fences its own save too (a landing that arrives during `suspend()`
keeps the screen: no refresh, no home, no clock restarted) and runs one exit
at a time (`saveExitGen` / `exitInFlight()`: while an exit saves or reads,
a second press does nothing and `submitModule` refuses — the review page's
Next — since either used to leave a module clock running under home, which
also kept `sittingInFlight` true; the hold is the session generation the
exit runs for, so an exit stranded behind a slow save whose session a
deletion ended never swallows the next sitting's exit or Next, and it is
released in a `finally`); `suspend()` answers only for the recorder
hand-over it began in (`recEpoch`, bumped by begin / resume / detach /
abandonDeleted — not an object comparison, since `resume()` adopts the
caller's record object), so a stale exit can never stop the recorder of a
sitting begun or re-resumed after a deletion landed; a "student deleted"
refusal never ends a page that holds a tutor token (the dashboard's student
views borrow that student's code as `state.userName`, and its deletion must
not drop the dashboard or the viewer to the student sign-in) — which is
only sound because a student session never carries one: `signInWithCode`
and the home Sign out drop any tutor token first; a TYPED
student code also bumps `sessionGen`, so it supersedes a boot restore in
flight. A sitting RUNNING or (re)starting on the page
(`sittingInFlight`: module clock, the Ready/resume beat, module-over, break —
on screen until Resume Testing, which nulls `breakInterval`, so a finished
sitting leaves all four off; reachable only when a crash-resume landed
behind the sign-in form or the tutor dialog) makes
both tutor entries REFUSE with a message: tearing it down there would save
the record mid-resume without its checkpoint (`Attempts.resume` consumed it;
`beginModule` had not written the next) and the student could never resume.
Otherwise the entry detaches a recorder a finished or backed-out sitting
left attached (its last save drained) before any dashboard surface touches
`state`. A tutor sign-in Cancelled while in flight opens nothing when it
answers, even if the dialog was reopened (an attempt counter, not the
dialog's visibility). (Trades, stated: a student remembered in ANOTHER tab on this device
re-types their code after a reload, and their sitting then resumes as
normal; and the memory restore is best-effort — a fetch that times out at
20 s and lands later stays loaded, which changes only display: a Past card
then shows the scaled total, the Score Calculator may default to that form.) Nothing persists, so "reload lands on the dashboard" is NOT met: the
tutor session is memory-only by design and persisting it would be a write.
Go-to takes `rw1-q7`/`re1-q7`, `m2-q21`/`ma2-q21`, `m1-q08`, `m2-07`; the
Tests-tab box also takes a test id or its start ("202606 ma2-q21" lists the
matches, never guesses). Proofs: `tests/test-viewer.test.js` (node; every
guard has a control that removes it and goes red) and `tests/viewer-proof.js`
(browser: walks every question of every form, answers on/off, a forced
tab-hide inside each, and diffs storage write CALLS, localStorage bytes, the
queue and every request; remote with a stubbed network, local split build,
single file; red against each target `node tests/viewer-proof-mutants.js`
builds — that file says which check each one must turn red); the viewer's
surfaces are in `tests/injection-proof.js`. In the viewer a sitting's own
controls (Mark for Review, ABC, Show Keypad, Calculator, Highlights & Notes)
render as a student sees them and are inert — review attaches no question
handler, and the two header tools are never wired (Desmos never loads);
only the key marks differ between Show answers on and off. Report a bug is
hidden (it writes). Keep the test-bank's Stage-3
anchor `state.assignments = assigns;` appearing exactly once in app.js
(build_stage3_preview.py replaces its first occurrence).

**Partial sittings (2026-11-02): a scope on the assignment and the record.**
An assignment row may carry `scopePolicy: {mode:"fixed", modules:[…]} |
{mode:"student-choice", allowed:[preset names]}` (absent ⇒ fixed full) and
`rowVersion` (absent ⇒ 1; the dashboard stamps 2 on every row it writes; a
client refuses to BEGIN a row above `AssignmentRules.ROW_VERSION` with the
card's "Reload this page to start this assignment" line — never a full
sitting under a rule it cannot read; it cannot protect a tab loaded before
the field existed). The record gains ONE optional top-level field, `scope:
{modules, selectedByStudent}` (ATTEMPTS-SPEC §2), stamped at begin and never
touched; absent ⇒ full, so a tutor-fixed full sitting is byte-identical to
before (`tests/partial-sittings-golden.json` pins that against 21b6855's
recorder). **The vocabulary is four SLOTS, `re1 re2 ma1 ma2` — the
question-id prefixes, NOT `modules[].moduleId`** (that is a per-form string
like `2026-june-asia-v2-math1`); a slot is resolved to a module by SECTION
and ORDINAL within the section, and `build-site.js` fails the deploy on a
form whose modules do not map onto the four in order with every question id
under its slot (`AttemptScope.formProblems`, lifted from attempts.js; the
self-check and the plants are in `tests/build-site-drift.test.js`). The
seven presets — full, rw, math, re1, re2, ma1, ma2 — are the only scopes;
anything else reads as full. **Everything reads through
`window.AttemptScope`** (attempts.js, beside `AssignmentRules`): `scopeOf`
(untrusted input; `selectedByStudent` counts only as the literal true),
`testFor` — THE SEAM: the form with `modules` filtered to the record's
scope, the very object for a full scope — `label` / `scoreLabel` (closed
tables), `openedSlots`. The sitting RUNS on the scoped copy (`startTestFlow
Loaded`), so the recorder has no scope branch: `modules[]`, `answers`,
`score`, both blobs hold only the scoped modules; an out-of-scope module is
ABSENT from `answers` (never sat), an in-scope unreached one BLANK
(never-answered), as always — never conflate the two. `testFor` is called in
exactly four places in app.js (start, `resumeTestFlowLoaded` BEFORE the
clamp — a Math-only checkpoint at index 1 is the second Math module, never
RW Module 2 — `openScoreDetailsLoaded` before `buildScoreRows`, and
`storedModuleRaw`); hand it the WHOLE form, never an already-scoped copy (a
copy loses its section ordinals). `crashResumeCandidate` range-checks
against the scope; `scPrefillSource` skips partial records. Scoring: full
unchanged; a section ⇒ that section's EXACT scaled score from the same
per-module table (`scaledScores(…, scope)`: `{rw|math, total:null}`),
"Section only", the total "—"; a module ⇒ null, raw count only, "Single
module"; never a total from a part. The hero carries the words (the printed
report is that DOM) and the scope badge beside the timing badge, with
"(student-selected)" on the literal true; the Past card, the Attempts row,
the Students card (RW "—" for a Math-only record, via `countPair`), the
detail line and the Assignments table's Scope column the same. The
pre-flight screen (`openTimingChoice`, `#screen-timing`) now has a block per
student choice — timing, part of the test — and states the fixed one;
Continue needs a pick in every block shown; `state.pendingScope` has
`pendingTiming`'s exact lifecycle (cleared at the same sites). The assign
form's Part-of-the-test control defaults to fixed full; `createAssignment`
writes `scopePolicy` + `rowVersion` on every row; the overlap block gains
"has sat <form>: RW Module 1 (completed …)" per chosen student
(`exposureHtml`). Server: `supabase/migrations/2026-11-02_one_release_per_
assignment.sql` restates `fn_upsert_attempt` and adds ONE guard to the form
auto-release branch — no OTHER completed or timed-out attempt of this code
may already name the assignmentId (deleted records included, since their
rows stay) — so an assignment releases at most one sitting and a forged
assignmentId naming a consumed auto row grants nothing; the stamped-id
binding was already there. `scope` is never read server-side. Deploy order:
apply the migration FIRST, then push (either is safe; it is restrictive
only). Limits: archive-then-delete removes the consuming record, after which
the guard cannot see it; the set branch is unchanged. Proofs:
`tests/partial-sittings.test.js` (readers, every shipped form and archived
build, the recorder for real with the golden, the start path, crash-resume,
the hero/print DOM and review bounds, the Past card, the dashboard, the SPR
audit over a partial export, source pins — every check with a control),
`tests/tutor-writes.test.js` §14, `tests/build-site-drift.test.js`'s scope
cases, `tests/assignment-options.test.js` §3's forged-id case (red against
the 2026-11-02 assignment-options text); the viewer and injection proofs
carry the new surfaces.

**Assignment options (2026-11-02): auto score release, the student's timing
choice, bulk assign.** Two ADDITIVE fields on the assignment row —
`releaseMode: "manual" | "auto"` (absent ⇒ manual, today's behaviour) and
`timingPolicy: {mode:"fixed", timing} | {mode:"student-choice", allowed:[…]}`
(absent ⇒ fixed at the row's Phase G `timing`; a student-choice row carries
`timing: null`) — read ONLY through `window.AssignmentRules` (attempts.js;
app.js and dashboard.js both call it, so the two sides cannot disagree). An
`allowed` list with nothing valid in it falls back to FIXED at the row's
timing, never to a free pick. Rows without the fields behave exactly as
before. **Auto release is decided SERVER-SIDE**: `fn_upsert_attempt`
(`supabase/migrations/2026-11-02_assignment_options.sql`, a `create or
replace` restatement of the 2026-09-21 body plus one branch) releases a FORM
attempt at its in-progress → completed/timed-out transition when the
assignment row it names is this code's, says `auto`, and names the test in
the attempt's KEY; the client's own `released` is discarded on every write
as it always was, an in-progress write never releases, and a row already
completed on the server is never re-released by rewriting it. The recorder
mirrors the rule at `finalize` (app.js passes the active assignment's mode
and id; honoured only when the id is the record's own) — the local /
artifact / `?devstorage=1` rule and a display convenience in remote mode.
The dashboard's Attempts cell reads **Released · auto** with no Release
button once an auto row's attempt is released — a statement about the
assignment, not about who flipped the record, which the client cannot know —
plus a small **Hide** button, because un-releasing is a real action and
that cell is its only path; an unreleased attempt under an auto row keeps
the manual Release button (the migration not yet applied, a legacy-id
mismatch the server refused). The recorder's mirror carries the server's
testId equality too (`opts.testId === rec.testId`, raw strings), so a row
that still names a legacy id is held on both sides. **Deploy order: apply
the migration FIRST** (inert until an auto row exists). App-first is not
wrong but it flickers: the student's device mirrors the release locally,
and the next pull brings the old function's released=false until the file
lands — a score shown, then withdrawn, not held. Stated limit: a student holding an auto row for test X can get
the early release of any attempt of X they sit — the server cannot tell
which of their assignments a sitting belongs to beyond the client-stamped
assignmentId; the bulk form's duplicate refusal keeps an auto and a manual
assignment of one test from being active together. **The timing choice**:
`startAssignment` sends a student-choice row to `screen-timing` first (both
categories); the pick lives in `state.pendingTiming`, keyed to the
assignment, and `startTestFlowLoaded` REFUSES to begin without a valid pick
for that very assignment (it shows the screen instead — the second layer
behind the Continue button's own check). Continue (`continueTimingChoice`)
re-runs `assignmentState` before dispatching — the student can sit on that
screen past the assignment's expiry, and for a practice row it is the last
gate — and reads the radio through `exactTiming` (junk is "no pick", never
Standard); both pending fields are cleared by every session reset
(tutor entry, the deletion landings, Sign out). `Attempts.begin` stamps the pick
as `rec.timing` plus `rec.timingSelectedByStudent: true` — **the only new
record field, top-level** (the brief asked for `conditions.…`, but
`conditions` is a string enum every bucketing rule compares, so it cannot
grow a key) — omitted otherwise, so every other record is byte-for-byte as
before and the v1 archive reads both. Resume, crash-resume and Review Mode
read `record.timing`, never the assignment. Surfaces: the Score Details hero
line (which the printed report keeps), the Past card and the dashboard's
rows and detail show the timing with an Est.-style "(student-selected)"
mark when the flag is the literal `true`; "Standard time" appears only in
that case. Old-tab limit: a tab loaded before this deploy starts a
student-choice row at standard timing (`timing` null → 1) with no choice —
reload open tabs. **Bulk assign**: the Assign form's Test control is a
multi-select over the whole manifest (never truncated), with Select all and
Select all not yet sat (per CHOSEN student: no live completed, timed-out or
in-progress form attempt; deleted attempts do not count as sat); one shared
set of options; every (code × test) pair becomes its own row with its own
assignmentId (`newAssignmentId`: eight hex digits plus a counter, unique
among the submit's ids AND the code's existing rows — the id is the row's
key, and a bulk submit mints many per second), written one at a time, each
READ BACK through `freshAssignmentRow` (the server's copy in remote mode)
and compared by `canonJson` — keys sorted, because jsonb reorders them and
a plain stringify compare called every correct remote row "different" —
and the status line says "N of M … written, V verified", names every
refused and failed row, and leads with "Not saved" when nothing landed;
while a run is in flight (`createInFlight`) the button is disabled and a
second press is refused in the form, since it would plan from the pre-run
`assigns` and double every row; a submit where every pair is refused stays
in the form (no profile write, no reload). "Not yet sat" also counts a test
whose assignment row reads Completed or In progress (the archived-away
sitting's hint, a tagged deleted sitting's marker). A pair whose test already has an ACTIVE assignment
(pending or in-progress — not completed, not expired-and-unsat; a legacy
bare-id entry counts) for that code is refused by name, because the student
app's crash-resume slot `state.resumeRecords` is still keyed by canonical
testId (unchanged in this batch — the per-assignment card resume is not).
Every control and the plan are read before the first await. The student
home sorts both sections by display name (`sortAssignmentsForHome`: forms by
testName, sets by setName, ties by assignedAt then id); the flipped
default — nothing assigned, nothing shown — is unchanged. Proofs:
`tests/assignment-options.test.js` (the readers, the recorder for real, a
model and a textual gate of the SQL branch with every guard removed in turn,
the start path for real with a mutant control, the sort, the labels, the
cells, the screen) and `tests/tutor-writes.test.js` §13 (the real
`createAssignment`: three rows for three tests, a fourth refused for an
active duplicate, a named failure, the read-back, student-choice rows,
the Auto-released cell); each file's header says how to run it against the
pre-change sources to watch it go red. `tests/tombstone.test.js` and
`tests/set-release-rule.test.js` now check the NEWEST file defining
`fn_upsert_attempt` (tombstone's `RESTATED` list sanctions this one and
re-applies its gates to it). Human checks F and G are in the migration
header.

## Read first
`SCHEMA-v1.2.md` — the data contract. It's authoritative over instinct,
including for anything below.

## What this repo is
The reusable Bluebook-style SAT simulator (the "platform" track — see
`EMULATOR-HANDOFF.md` if present for the fuller history; the file keeps
its historical name). Split into files
for real editing/version control:

```
index.html    — dev shell: markup + KaTeX CDN tags + local <script>/<link>
styles.css    — all app styling (incl. tutor-dashboard section at the end)
render.js     — fmt() token/LaTeX renderer (schema §2)
grading.js    — answerMatches, toFraction, hasKey, sprValueMatches
attempts.js   — AttemptStore (shared-storage adapter, ?devstorage=1 local
                shim) + Attempts (recording per ATTEMPTS-SPEC.md)
app.js        — state machine, screens, event handlers, results
dashboard.js  — tutor dashboard (hidden admin sign-in acestem-admin)
testdata/     — the test library: manifest.js (loaded at startup) plus
                one lazy-loaded <testId>.js per test. See "The test
                library" below.
assemble.py   — inlines the local files above into dist/index-live.html,
                the single-file preview used in the claude.ai panel
tsv_to_bluebook_json.py — the extraction→JSON converter
```

## The test library (`testdata/`)
One file per test, so the library can grow without growing the startup cost.

```
testdata/manifest.js      window.TEST_MANIFEST — one small entry per test:
                          testId, testName, testVersion, moduleCount,
                          questionCount, sections[], legacyIds[].
testdata/archive/index.js window.TEST_ARCHIVE_INDEX — {testId: [versions]}:
                          which superseded builds are archived. Generated by
                          archive-testdata.js, never hand-edited. Together
                          with the manifest, the ONLY test files loaded at
                          startup (it is a few hundred bytes).
testdata/<testId>.js      the full test; registers itself into
                          window.__TESTDATA__[testId]. Lazy — fetched only
                          when a sitting starts or resumes (or Score Details
                          opens, or the dashboard needs item analysis).
testdata/archive/<testId>@<testVersion>.js
                          a superseded build, byte-identical to the committed
                          file it once was. Lazy exactly like current tests,
                          and never inlined into dist/ — assemble.py inlines
                          an EMPTY archive index instead, so the single-file
                          build honestly reports superseded versions as
                          unavailable rather than advertising builds it has
                          no origin to fetch. Review Mode and resume load
                          these so an attempt opens on the EXACT build it was
                          sat on; see ARCHIVE.md there for the per-file
                          source commits.
```

- **`testId` is internal.** It follows the source-PDF convention
  `YYYYMM + region + v#` (e.g. `202606asiav1`). Students only ever see
  `testName`. Attempt keys embed the testId (`attempt:<testId>:…`), so a
  rename would orphan records — that is what `legacyIds` is for: list the old
  id there and resolution, resume-lookup and the dashboard all still find it.
- **Adding a test:** convert in the test-bank repo, drop
  `testdata/<testId>.js` in (registering into `window.__TESTDATA__`), add its
  manifest entry, done. `build-site.js` reads the manifest and ships every test
  it lists — a manifest entry with no file **fails the build** rather than
  404ing mid-sitting. Nothing else needs touching.
- **Never hand-edit a test file** — regenerate from the test-bank JSON and bump
  `testVersion` on any content change after students have taken it
  (ATTEMPTS-SPEC §9). Version-gating is per test. **After any bump, run
  `node archive-testdata.js` before committing** — it pins the replaced build
  into `testdata/archive/` (idempotent, safe to re-run; the build it replaces
  is still at HEAD, and stays recoverable from history even if you forget —
  a later run heals a missed archive retroactively). Two nets behind the
  procedure: the deploy runs `node archive-testdata.js --verify`
  (netlify.toml), which fails the build on a superseded committed build with
  no archive or a stale index — provided the deploy checkout can see the
  history; and `build-site.js` fails on index-vs-files drift (hand-edits of
  `testdata/archive/`). Because completed attempts review — and in-progress
  sittings resume — against their pinned build, **a bump no longer revokes
  review**, so release-before-bump ordering is no longer load-bearing for
  review (the release flow itself is unchanged).
- **Offline:** content is cached in `localStorage` under
  `acestem:testcache:<testId>:<testVersion>` the moment it loads, so a student
  who drops connectivity mid-sitting keeps answering, and a reload restores
  from cache rather than the network. The version is in the key, so a bumped
  test can never be served from a stale cache. Precisely: **no test-content
  fetch is on the critical path once a sitting has begun** — the sitting holds
  the full test in `state.currentTest`, and module boundaries never re-fetch.
  What this does NOT provide is offline delivery of the *app itself*: there is
  no service worker, so a hard reload with no connection fails at `index.html`
  before any of this runs. Closing that needs a service worker; the cache here
  only protects a sitting whose page is already loaded or reloadable.
- **`assemble.py` inlines every test** into `dist/index-live.html`, because a
  single-file artifact has no origin to fetch from. The loader checks memory
  before cache before network, so the artifact simply never fetches.

Load order matters (index.html is the source of truth): `config.js`,
`testdata/manifest.js`, `testdata/archive/index.js`,
`testdata/bank-manifest.js`, `testdata/bank-index.js`, `skilldomains.js`,
`render.js`, `grading.js`, `attempts.js`, `app.js`, `dashboard.js` — plain (non-module) scripts, so
top-level declarations are globals used across files. Don't wrap
`render.js`/`grading.js` in IIFEs, and don't redefine `escapeHtml`,
`fmt`, `answerMatches`, etc. inside `app.js`.

## Absolutely do not touch
`sat-2026-june-asia-v1.html` and anything about its publish state — that's
the frozen fork, self-contained, published as its own claude.ai artifact
in a separate original chat with live student attempt data. This repo has
no relationship to it and should never generate or overwrite it.
`assemble.py` builds `dist/index-live.html` only — a preview file, not
that fork.

## Deployment modes
The app detects at runtime which storage it has and adapts. Nothing to
configure, no build flag, no query parameter.

| | **Shared mode** | **Remote mode** | **Local mode** |
|---|---|---|---|
| Where | published claude.ai artifact | static host **with** `config.js` (Supabase) | static host without config, or a `file://` copy |
| Trigger | `window.storage` exists | Supabase config present, no `window.storage` | neither (auto fallback) |
| How config gets there | n/a | Netlify build runs `node gen-config.js`, which writes `config.js` from the `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY` env vars (or `SUPABASE_ANON_KEY` for a legacy key) | n/a |
| Records | shared artifact storage | localStorage first, synced to Supabase in the background | localStorage, this browser only |
| Release flow | works | works across devices — the point of Phase H | not reachable; the JSON download is the handoff |
| Tutor access | `acestem-admin` magic name | **real Supabase Auth** (the magic name is gone) | `acestem-admin` magic name |
| Student sees | normal home screen | a "Synced / Syncing… / Offline — will sync" pill | a "Local mode — results save on this device" pill |

Precedence is `?devstorage=1` → artifact → remote → local, so the artifact
build never accidentally talks to Supabase and the forced-local switch always
wins. **Remote mode is local-first and never blocks a student:** every write
goes to localStorage and is then queued; the queue lives in localStorage,
survives reload, retries with backoff, and drains on `online`. Nothing on the
write path is awaited by the test loop.

Consequences worth remembering for local mode: each device is its own
island (a student on two laptops has two separate histories), clearing
site data destroys the records, and the tutor dashboard opened on that
device only shows attempts taken on it. `?devstorage=1` still forces
local mode but is no longer needed for local testing.

## Workflow
1. Edit the split files directly.
2. `python3 assemble.py` to produce `dist/index-live.html` whenever you
   want to preview in the claude.ai panel or hand David a single file.
3. Commit dev files; `dist/` can be gitignored (it's a build output) or
   committed for convenience — David's call, either is fine at this scale.
4. No test runner is wired up yet. Until then: syntax-check every JS file
   before committing (`node --check <file>`), and if you touch `render.js`
   or `grading.js`, sanity-check `fmt()` and `answerMatches()` behavior
   with a throwaway Node snippet before moving on — these two files are the
   part of the app with the least margin for silent breakage, since a bad
   regex or an off-by-one in the tokenizer fails quietly (wrong rendering)
   rather than loudly (a thrown error).

## Escaping contract (read before adding any render surface)
Attempt records live in artifact shared storage, which ATTEMPTS-SPEC §7 says
is writable by anyone who can run the artifact. **Every value read back out
of a record is untrusted** — SPR answer strings, student codes, testName —
even though `sanitizeSpr()` limits what a student can type through the UI.
Three rules:
1. Record- or test-data-derived text goes through `escapeHtml()`; prose that
   may carry `{{tokens}}` goes through `fmt()` (escape-first: it escapes
   prose, then substitutes known tokens, and KaTeX escapes its own output).
2. `escapeHtml()` escapes quotes, so it is safe in a quoted attribute.
   `dashboard.js` also has `escAttr()` as defense-in-depth; keep both.
3. Never interpolate a raw record value into markup. Numbers computed from a
   record (counts, indices) are fine.
4. **Image choices (2026-10-07)** render from TEST DATA only — `choiceBodyHtml`
   in app.js, never through `fmt()` (so fmt() still emits no `<img>`, the
   reason IMG is in DROP_ELEMENTS), never inside `.ctext` (so they are never
   an annotation region), and a record's saved `choiceHtml` slot is never read
   for one. The source must match `CHOICE_IMAGE_RE` (a `data:image/…;base64`
   URI, which can fetch nothing), and since 2026-10-18 its decoded bytes must
   be the type it declares (`imageSourceOk`: PNG signature, JPEG `FF D8 FF`;
   an SVG must be valid UTF-8 throughout, with no character XML forbids,
   and XML 1.0's productions are applied up to its root start tag, which
   must be `<svg>` in the SVG namespace. That is because Chrome draws an
   `<img>` SVG only if it decodes (as UTF-8, or as UTF-16 only behind a
   BOM; the declared encoding is ignored) and is well-formed. UTF-16 is a
   stated refusal; it and the other stated refusals and unchecked parts are
   in IMAGE-CHOICES-SPEC §2.4. `figureSrc` runs the same
   guard). Anything
   else renders a placeholder, never a throw. `tests/image-choice.test.js`
   pins the seam, the bytes check at both sites (with mutants) and every
   shipped image; keep-classes audits every shipped image choice through the
   renderer's own `choiceImageSrc`, with planted controls; and
   **`build-site.js` fails the deploy on any current or bank image the guard
   refuses** (an archived build's refusal is a warning), because the
   test-bank converter checks figure bytes not at all — keep that gate if
   the guard changes, and keep `function choiceImageSrc(` and the grammar
   literal verbatim (the test-bank exporters' `platform_supports()` reads
   both).
5. **Math modules replay no annotations (2026-10-07).** Annotations are
   created in Reading and Writing only, and `replaysAnnotations(mod)` now
   gates every replay site (passage pane, stacked stimulus, stem, the
   choices' saved map), so a record's `passageHtml` / `stemHtml` /
   `choiceHtml` for a Math question has no render site; the sanitizer is the
   second net there. Keep that gate on any new replay site —
   `tests/image-choice.test.js` §8 sweeps all of app.js, prefix-blind, and
   fails on any mention of the three fields outside the initialisers,
   `restoreAnnotations`, `saveAnnotation` and the five gated lines, and on
   any `sanitizeSavedHtml(…)` call beyond the four known sinks (a fifth site,
   an alias, a new helper, an ungated sink each fail it).

`tests/injection-proof.js` is a paste-into-the-console regression proof —
run it against `dist/index-live.html` after touching any render surface.
`tests/keep-classes.test.js` is its annotation-allowlist gate in node: every
fmt-* class named anywhere in render.js (exactly eight, pinned), and every
class fmt() emits over the shipped RW library, must survive the sanitizer's
KEEP_CLASSES; math in an RW field is allowed only in the pinned
202608intv1 re2-q10. fmt-credit was missing until 2026-09-30, so the credit
line lost its styling on every re-render of a highlighted passage — resume,
revisit, flag — and highlights SAVED before that deploy can hold the passage
without the class for good: the fix is not retroactive.
`tests/local-mode.test.js` (`node tests/local-mode.test.js`) covers the
storage-adapter mode resolution; the preview pane strips query strings, so
the `?devstorage=1` cases can only be checked there.
`tests/spr-grading.test.js` (`node tests/spr-grading.test.js`) covers SPR
answer matching: the directions' Acceptable/Unacceptable table, and an
EXHAUSTIVE old-rule-vs-new comparison over every enterable string for every
shipped SPR key. Pass a dashboard export as an argument
(`node tests/spr-grading.test.js export.json`) to audit real stored attempts
— that is the only way to check live records, since they live in the backend
and never in this repo.

## Student names vs. records (ATTEMPTS-SPEC §7a)
Students see a display name, but **records stay pseudonymous**. The name is a
separate row — key `student:<CODE>`, `owner_code` that code, value
`{"displayName":"Erin K"}` — and is **never copied into an attempt**, an
archive or an export. Code→name is a join, not a field, and doing it needs
either that student's own code (`fn_get_profile`, one row, no enumeration) or
tutor auth. Writes are tutor-only via the authenticated table path; there is
no anon write RPC by design, so a student can't rename themselves or anyone
else. A missing profile silently falls back to the code. Display names are
untrusted strings on the render surfaces — escape them like any other
record-derived value.

## Known limitations (accepted for launch)
- **Student codes are bearer secrets (remote mode).** There are no student
  accounts by design. The `AS-` + 8-character code (unambiguous alphabet, no
  O/0/I/1) is the only thing standing between someone and that student's
  records — the "unguessable link" model. Honest limits: a leaked code exposes
  **that one student's** records and nothing else; students type codes, so
  they can be shared or shoulder-surfed; and there is **no rate limiting** in
  this phase, so the codes' entropy (32^8 ≈ 1.1e12) is the whole defence.
  Anon has zero table privileges — all student access goes through four
  `SECURITY DEFINER` RPCs that scope every row to the code passed in, and
  `fn_upsert_attempt` refuses cross-student writes *and* ignores a
  client-supplied `released` flag so a student can't release their own scores.
  Upgrade path if it ever matters: per-student magic-link auth.
- ~~**Concurrent `assign:<CODE>` writes can clobber.**~~ **FIXED in Phase H**
  by moving to one row per assignment (`assign:<CODE>:<assignmentId>`), listed
  and filtered by prefix. There is no longer a read-modify-write of a shared
  array, so concurrent writers touch different keys. An explicit
  `assign:<CODE>:__none` sentinel preserved the "assigned nothing" vs "never
  configured" distinction — **vestigial since 2026-08-01**, since those two are
  now the same state (see the assignment-default note above); it is still read
  so old rows behave, but nothing writes new ones. Historical description kept
  below for context:
- **(historical) Concurrent `assign:<CODE>` writes can clobber.** Each student's
  assignments live in ONE storage key holding an array, mutated by
  unguarded read-modify-write from two sides: the tutor dashboard
  (create/delete) and the student app (`Attempts.completeAssignment` on
  finalize). Storage is last-write-wins, so a tutor editing assignments
  at the same moment a student finishes can silently drop one write.
  Reads are already hardened against the more dangerous failure
  (a *failed* read no longer overwrites with `[]` — see
  `AttemptStore.getResult`); this remaining item is the concurrent-
  *success* race, whose window is small at tutoring scale.
  **Queued post-launch fix:** move to per-assignment keys
  (`assign:<CODE>:<assignmentId>`), enumerated with `storage.list`, the
  same one-key-per-record pattern ATTEMPTS-SPEC §1 chose for attempts to
  avoid exactly this clobber. Accepted as-is for launch 2026-07-31.
- **The tutor dashboard is reachable in local mode, unauthenticated.** The
  hidden `acestem-admin` sign-in works on a static deployment too, so anyone
  on that machine who knows the name can open the dashboard. **Kept
  deliberately** — it's load-bearing for single-machine proctoring (David
  runs a sitting and reviews it on the same laptop), and the exposure is
  bounded: local mode reads only that device's own localStorage, so it can
  never surface another student's records. Deliberately **no PIN** — a
  client-side gate on a file anyone can read is theatre, and it would add a
  credential to lose. Real auth arrives with the backend in ATTEMPTS-SPEC
  §7c, which is also what makes the dashboard worth protecting. Same
  "obscurity, not security" posture as §7, now stated for local mode too.
  Accepted for launch 2026-07-31.
- **The live site is an allowlist, not the repo root.** `netlify.toml` builds
  `_site/` via `build-site.js` and publishes that; only the files the
  running app needs are copied in — `ALLOW` in `build-site.js` is the source
  of truth: `index.html`, `404.html`, `styles.css`, the six app scripts
  (`render.js`, `grading.js`, `attempts.js`, `app.js`, `dashboard.js`,
  `skilldomains.js`), `testdata/manifest.js` plus every test the manifest
  lists, `testdata/archive/index.js` plus every archived build it lists,
  `testdata/bank-manifest.js` plus every bank it lists, `testdata/bank-index.js`,
  `testdata/dedup-index.js`, `config.js`, `_headers`. Everything
  else — design docs, specs, `assemble.py`, the build scripts, `reference/`
  (real College Board PDFs), `supabase/`, `tests/` — is simply not deployed.
  **Adding a file the app needs means adding it to `ALLOW` in
  `build-site.js`;** the build fails if `index.html` references something
  unlisted, so a miss is a red build rather than a 404 for a student.
  `_headers` only works inside the publish directory, so it is copied in too.
  **Why an allowlist and not redirect rules:** measured against the live site,
  Netlify matches redirect `from` paths case-SENSITIVELY but serves files
  case-INSENSITIVELY — `/tests/injection-proof.js` 404'd while
  `/TESTS/injection-proof.js` returned 200 and served the file. Every
  blocklist rule is therefore bypassable by changing capitalisation, and an
  n-character path has 2^n variants. Deny-by-default is the only mechanism
  that actually holds.

## Set builder rules (2026-09-30)
- **Bank questions group by canonical id exactly as form questions do** —
  one entry per canonical item across forms AND banks (`builderHeldAs`),
  with provenance and seen marks on bank rows. The 2026-09-07 exclusion was
  v1 scope only, not a reason; its one real constraint (9f84669: the outcome
  must not depend on click order) holds because the rule is symmetric.
- **A retired bank item never enters a set**: no Add in the picker, `pushRef`
  refuses one the page knows is retired, and `saveSetFromBuilder` judges
  every bank ref against the set **as stored now** (re-read, never the page's
  `sets`) and the bank index **re-read** (cache bypassed, 8 s deadline). A
  retired or unknown ref the stored set doesn't hold is refused; if the
  re-read fails on a page that loaded the index over http(s), the save is
  refused too (the single-file build, whose index is inlined, and a file://
  copy, which can't fetch, trust their own copy — no re-read is tried). A
  set whose stored row is gone is never recreated by such a save: the
  builder becomes an unsaved NEW set keeping its questions. A successful
  re-read is kept, so the picker then drops the Add. The builder (name
  included) is read-only while a save runs, the save writes the exact
  snapshot it checked, and a PAGE-wide lock (`setSaveInFlight`) keeps the
  Sets list's Edit / Delete / New set off until the save — and its reload
  of `sets` — has settled, even if the tutor pressed Cancel. The lock works
  BOTH ways for exactly these five controls — Save set, set Delete, Assign
  set, Clear all assignments, an assignment Delete: each refuses while it is
  held AND takes it for its own writes (and its reload of `sets`/`assigns`,
  before releasing), so none of them interleaves with another (a save's
  card patch would write a just-deleted card back, Assign set would stamp a
  pre-save name/count, a Save during an Assign would miss the new cards). A
  builder open on a set that a Delete removes becomes an unsaved NEW set (as
  with a set gone elsewhere). Assign set resets its form afterwards (codes
  cleared; the set picker, limit and Hold go back to their defaults, as they
  always have), so a second press can't duplicate cards that landed. Deliberately OUTSIDE the
  lock: Create assignment (test cards — no set card patch touches them),
  Save name only, and the Phase H upload. Create can still interleave with a
  Clear all on the same student (pre-existing): the table, reloaded after
  both, is the truth, not the last status line. A new control that writes a
  `pset:` row or a set card, or deletes `assign:` rows, must join the lock in
  its function AND its button — the tutor-writes suite runs the dashboard's
  REAL `loadSets`/`loadAssignsAndBugs` (a gated case can't hang it silently:
  a drained event loop reports HARNESS HUNG and exits 2), so these checks
  can't lean on hand-seeded state.
  FIXED 2026-10-06 (a stated limit since sets shipped, true of EVERY tutor
  write, not only sets): a Refresh whose server snapshot was taken before a
  write used to land after it and put the old row back in this browser's
  mirror (`pullAllForTutor` overwrites and never prunes) — until the next
  Refresh the page could show, assign or re-save the pre-write copy. Now
  each in-flight pull keeps its own Set of keys (`pullsInFlight` in
  dashboard.js; `loadFromStorage` registers one before the pull and
  releases it in a finally), `tutorPut`/`tutorDelete` add the key the
  moment the SERVER accepts (a rejected write adds nothing, so the pull's
  row still lands there — it is the truth), the set save's mirror heal (a
  card the server no longer has) notes its key the same way, and
  `AttemptStore.pullAllForTutor(skip)` asks the predicate per row at the
  moment of its write and leaves those keys alone. Only two orderings exist
  on the page (the mirror is localStorage, so a pull's tail and a write's
  tail each run whole inside their own response's macrotask): the snapshot
  predates the write and its rows land after it — the Set's job; or the
  rows land before the server accepts — the write's mirror step wins and
  the action's own reload repairs the page (`toggleRelease` and
  `deleteAttempt` are the two actions with no reload: the first re-applies
  its flip to the record the page holds now, the second writes its marker
  into the `tombs` map the page holds now; `createAssignment` reads its
  whole form before its first await, since a Refresh landing meanwhile
  re-renders the form with defaults). The helpers note the key before their
  mirror write by convention; the order is not load-bearing.
  `tutorTombstone` takes no part: a `tomb:` row is new and permanent, the
  pull never prunes, and the record it marks is not edited, so nothing stale
  can undo a deletion. Trades, stated: a key written while a pull runs is
  skipped even when that pull's page was fresh — harmless when the mirror
  write succeeded; when a mirror PUT failed the key stays stale until the
  next Refresh re-lands the server's row (the warning asks for one), while a
  failed mirror REMOVE is not healed by any Refresh (the pull never prunes;
  the row stays until it is deleted again, or the set save's heal drops it)
  — unreachable in remote mode, where the mirror delete is a bare
  localStorage.removeItem; a write to the same key from another device
  inside the pull's window is missed until the next Refresh — never "fix"
  that by comparing values; "Pulled n row(s)" excludes skipped rows.
  Residual limits: the registry is per TAB — a second
  dashboard tab in the same browser shares the mirror and its stale pull is
  not told about this tab's writes (one dashboard tab per browser); the
  mirror still never prunes a row deleted from ANOTHER browser
  (`freshAssignmentRow` re-reads the server before a card patch for exactly
  that reason); and student-side writes are not tutor writes and are not
  noted — a sitting in another tab on the same device writes its attempt
  locally and queues it, and a pull can still write the server's older copy
  over it until the queue drains (its own item, not built; see the
  2026-10-06 batch notes). `tests/tutor-writes.test.js` §12 runs the REAL
  `loadFromStorage` and the REAL attempts.js loop with the snapshot held
  until after the write, in both orderings (Save set with its card patch, an
  Edit-then-Save, Assign set after a rename, set Delete, assignment Delete,
  Clear all, a release and an un-release, createAssignment under a Refresh,
  the heal, a tombstone, a rejected write, a throwing predicate, two pulls,
  a failed pull); every case proves
  the pull itself landed a server-only control row, and the store fails any
  pull write the server did not hold with that value at that moment. The
  §11 sweep sanctions only the predicate-carrying pull line. A failed pull
  now stays in the FINAL status line, and the upload button's summary stays
  in front of its reload's line (both used to be overwritten).
  Limits: a tab loaded BEFORE this code shipped runs the
  old picker (reload open dashboards after a deploy), and the server does not
  check set contents. A set that already holds a retired item — saved before
  the retirement, or built on the old picker — keeps it; the Sets tab reports
  how many and which, and nothing changes it.
- `tests/canonical-index.test.js` pins canonical pairs BY HAND on purpose:
  re-pin (and say which export) when an export legitimately moves one.
  `DEDUP_INDEX_SRC=<file>` runs it against a planted index.
  `tests/build-site-drift.test.js` runs the real build on a copy of the tree
  to prove the index-drift warning fires (and stays quiet when clean).

## Known open items
- ✅ 2026-07-23: Attempt recording + tutor dashboard implemented per
  ATTEMPTS-SPEC.md (students sign in with a CODE, records are
  pseudonymous; dashboard has export + archive-then-delete). Read that
  spec before touching attempts.js/dashboard.js.
- ✅ 2026-08-02: the Results-page rework landed as the Score Details
  redesign + Review Mode. `renderResults()`, `screen-results` and the Phase G
  question-review popup are DELETED — the one review surface is Review Mode
  (read-only replay in the real test UI, entered from Score Details).
  Numbering is module-local on every student-facing surface. `finalize()` now
  keeps the sitting's annotations on the completed record (ATTEMPTS-SPEC §2)
  so review can replay highlights/notes; `Attempts.detach()` is called on
  entering review so the recorder can never write from a replay.
- `testdata/202606asiav1.js` holds "2026 June Asia v1" (98 questions);
  `testdata/202606asiav2.js` holds "2026 June Asia v2". Regenerate from the
  test-bank repo's JSON — never hand-edit — bump `testVersion` on any content
  change after students have taken it (ATTEMPTS-SPEC §9), and run
  `node archive-testdata.js` before committing so the replaced build is
  pinned into `testdata/archive/` and every attempt keeps reviewing (and
  resuming) against the build it was sat on.
