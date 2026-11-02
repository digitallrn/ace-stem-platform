# Partial sittings — Stage 1 reconnaissance

*Platform repo, 2026-11-02. No code was changed. Line numbers are against
HEAD `21b6855`. Companion to ATTEMPTS-SPEC.md §2 and the assignment-options
note in CLAUDE.md. Stage 2 does not start until David has replied to §8.*

---

## 0. What the reconnaissance found that the design decisions did not anticipate

Seven findings. Two correct a decision's premise (0.1, 0.2); the rest are
facts the implementation should rest on.

**0.1 `re1 / re2 / ma1 / ma2` are question-id prefixes, not module ids.**
Loading every file under `testdata/` (33 current forms) and
`testdata/archive/` (52 superseded builds) shows the same structure on all
85: `modules[].moduleId` is `<slug>-rw1`, `<slug>-rw2`, `<slug>-math1`,
`<slug>-math2` in that order (e.g. `2026-june-asia-v2-math1`); sections are
"Reading and Writing" twice, then "Math" twice; and each module's question
ids carry exactly one prefix, `re1-`, `re2-`, `ma1-`, `ma2-` respectively.
The slug differs per form, so the record's `modules[].moduleId` cannot be the
cross-form scope vocabulary. Per-module question counts vary (RW 25–27, Math
21–22), so nothing may assume 27/27/22/22 either.

Proposal: the scope names four **slots** `re1 re2 ma1 ma2` — the brief's
vocabulary, which is the question-id prefix — and one helper resolves a slot
to a module by (section, ordinal within the section): the first RW module is
`re1`, the second Math module is `ma2`, cross-checked against the id prefix of
that module's questions. `build-site.js` gets a gate that fails the deploy
when a form's modules do not map one-to-one onto the four slots in that
order, so the vocabulary is a checked invariant, not an assumption.

**0.2 The server's form auto-release branch already binds to the stamped
`assignmentId`.** `supabase/migrations/2026-11-02_assignment_options.sql`
lines 160-176 look the assignment up by
`a.key = 'assign:' || p_code || ':' || (p_value ->> 'assignmentId')`, require
`a.value ->> 'releaseMode' = 'auto'`, and additionally require
`a.value ->> 'testId' = split_part(p_key, ':', 2)`. A genuine later manual
sitting of test X stamps its own manual row's id, finds a manual row, and is
**not** released today; that case is green and must stay green.

The gap is the one the migration's own header states as a limit: a payload
can stamp the id of a **completed auto row** (a forged `assignmentId`), and
nothing checks that the auto row has not already released a sitting. So the
decision stands with its premise corrected. The new migration adds a
**one-release-per-assignment** guard: refuse the release when any other
`attempt:` row of this code, with status completed or timed-out, already
names that `assignmentId` (a tombstoned record included — markers never
remove the record, and a finished deleted sitting keeps its assignment
Completed). The same-key rewrite is already covered by the transition guard.
The test that goes red against the 2026-11-02 text is therefore "a second
completed attempt naming an already-consumed auto row is not released", not
"a manual sitting after a completed auto row". A forged id still moves the
attempt visibly into that assignment's bucket — `assignmentOf`
(dashboard.js:806) and `attemptsForAssignment` (1550) bucket by the stamped
id — and grants nothing else.

Stated limit: archive-then-delete (ATTEMPTS-SPEC §7b) removes the consuming
record from the server, after which a forged id naming that row would release
again; the `completedAttemptId` hint cannot stand in because students never
write assignment rows in remote mode.

**0.3 Absent vs blank, as the recorder writes it today.** `startTestFlowLoaded`
(app.js:2516) creates `state.moduleState` for **every** module of
`state.currentTest` at start, and `buildAnswers` (attempts.js:747) writes an
entry for every question of every module that has a moduleState. So the
**first** checkpoint of a full sitting already holds all 98 answer entries;
the unreached modules' entries are `given:null, blankReason:"never-answered"`.
`record.modules[]` is different: `moduleStart` (attempts.js:1111) pushes an
entry only when a module is opened. Hence, today and after this change:

- `answers` = *in scope* (every question of every module the sitting ran on);
- `modules[]` = *opened* (a module the student reached);
- a module is **absent** from `answers` only if it was never in
  `state.currentTest.modules`.

That makes the clean implementation of "absent modules must be absent" the
one practice sets already use: run the sitting on a test object whose
`modules` array holds only the scoped modules (sets run on a synthetic
one-module test, app.js:1509). No recorder function needs a scope branch —
`buildScore` (728), `buildAnswers` (747), `positionBlob` (778), the live
checkpoint (842), the boundary checkpoint (1159-1168) and `finalize` (1174)
all iterate `appState.currentTest.modules`.

**0.4 Consumers conflate absent with blank through one seam.**
`buildModuleStateFromRecord(test, record)` (app.js:2664) creates a blank
moduleState for every module of the **test it is handed**, and
`buildScoreRows` (5091) reads a missing `st.answers[q.id]` as "omitted".
Every reporting surface hands it the full form — Score Details (5211), Review
Mode via `sdCtx.test` (5456), the Past card's `storedModuleRaw` (2325), the
calculator prefill (5901), `AppScoreView.open` (6050) — so a Math-only record
rendered on today's code shows 54 "omitted" RW questions and an RW scaled
score of 200. One helper, `AttemptScope.testFor(fullTest, record)`, returning
the form with `modules` filtered to the record's scope, applied at each of
those entry points, is the whole fix: the scope-blind code below the seam
then reads the same for a set, a partial form and a full form.

**0.5 The curve is per-module and additive per section.** Every shipped form
carries `scoring: {model:"per-module", base:200, rwM1[28], rwM2[28],
mathM1[23], mathM2[23], scoringSource:"estimated", …}`, and `scaledScores`
(app.js:5066) computes `rw = base + rwM1[raw1] + rwM2[raw2]`, `math`
likewise, returning null unless all **four** module raws are numbers (5076).
A section-only scaled score is therefore **exact** from the existing table
(no estimate) and needs only a scope-aware variant of `scaledScores`. A single
module cannot be converted — M1 and M2 tables are distinct terms of a sum —
which is why "raw only" for one module is the only honest output.

**0.6 There is no Past partition by section.** The student home partitions
Past by `conditions` (`renderYourTests` 2284 keeps proctored records,
`renderHome` 2182 keeps the rest); a record lands in exactly one. The
dashboard's Students table (1278) has RW and Math **columns** read from
`score.bySection` (1329-1334), and `countPair` (702) already prints "—" for an
absent section. Because `buildScore` only writes `bySection` for modules the
sitting ran, a Math-only record will show "—" under RW with no change. So
"neither bucket nor both" holds by construction; what is missing on every
surface is the **label**.

**0.7 The review popup no longer exists** (deleted 2026-08-02 — CLAUDE.md).
The printable report is the Score Details DOM under `@media print`
(styles.css:1441-1465): the module strips and the actions are hidden, the
hero, Knowledge and Skills and the Questions table print. The label and the
"—" total come for free once the hero has them; there is no second print
surface. The `h1::before` "Ace SAT — " wordmark is unchanged.

---

## 1. Every place that assumes four modules, two sections or 98 items

Last column: **auto** = correct by construction once the sitting runs on, and
consumers read through, the scoped test; **change** = Stage 2 code.

### 1a. Sitting engine (app.js)

| Where | Assumes today | For a section-only or single-module record |
|---|---|---|
| `startTestFlowLoaded` 2488-2528 | `state.currentTest = test` (the full form); moduleState for every module (2516-2518); `Attempts.begin(test, …)` (2523) | **change**: resolve the scope (fixed from the row, or the student's pick) before this; `state.currentTest = AttemptScope.testFor(test, scope)`; pass the scope to `begin` so it is stamped. Second layer: a student-choice scope row with no valid pick for *this* assignment shows the choice screen instead, exactly as timing does at 2499-2505. |
| `assignmentCard` 2199, status line 2220 | "`testModuleCount` modules · `totalQ` questions" from the manifest (4 · 98) | **change**: a fixed section scope can say "Math · 2 modules · 44 questions" (`manifest.sections[]` carries 54/44); a fixed single module can say "RW Module 1 · 1 module" but **not** its question count — the manifest has per-section counts only. Student-choice: "Full test or a part — you choose". |
| `showReady(true)` 2750 | "Practice Test" copy with nothing about scope | **change**: one ready item naming the scope with exact module count and minutes (content is loaded here). |
| `showReady(false)` 2764 | "Up next" from `currentTest.modules[moduleIndex]` | auto |
| `beginModule` 2813 | per-module limit via `accommodatedLimitSec` (2792); five-minute alert armed per module | auto — accommodations are already per module |
| `startTimer` 2876, `tickCountdownTimer` 2894 (alert 2907), `resyncTimerOnReturn` 2923 | per module | auto |
| `submitModule` 3916: `nextIdx < currentTest.modules.length` (3927); break iff `next.section !== cur.section` (3930); else module-over; else finalize (3938) | sequencing over `currentTest.modules` | auto: `[re1,re2]` → module-over, then finalize; `[ma1]` → finalize at once; full → unchanged. The break is shown only on a section change, so a single-section sitting has no break and a single-module sitting has neither a break nor a second module. |
| `showBreak` 4018, `brkResumeBtn` 4053 | reached only from `submitModule` | auto |
| `showModuleOver(true)` 3966 → `showSubmitted` 3991 | scope-neutral copy | auto |
| `renderQuestionView` 3173-3178 | Back/Next hidden at module edges using `modules.length` | auto |
| `reviewStep` 3784 | crosses modules over `currentTest.modules` | auto |
| `sectionTitle` 2780, `sectionNumber` 2778, `moduleNumber` 2779 | "Section N, Module M" from the module's own `section` / `moduleLabel` | auto — the form's own labels; a Math-only sitting reads "Section 2, Module 1: Math", which is true of the form |
| `saveAndExitNow` 4146 → `Attempts.suspend(positionBlob())` | moduleIndex into `currentTest.modules` | auto |
| `sittingInFlight` 146 | module clock, ready beat, module-over, break | auto |
| Session resets at 163-164, 550-551, 593-594, 819-820, 2502, 2509, 2554, 2577-2578, 2597-2598, 2604, 2642 | clear `pendingChoice` / `pendingTiming` | **change**: the pre-flight pick must be cleared at every one of these sites; holding timing and scope in **one** pending object keeps the count at eleven |

### 1b. Pre-flight (the choice screen)

| Where | Assumes today | For a partial record |
|---|---|---|
| `openTimingChoice` 2544, `pickedTimingChoice` 2569, `continueTimingChoice` 2587; `#screen-timing` index.html:156-172; `.tc-opt` styles.css:406-416 | one choice (timing), shown only when `timingPolicy.mode === "student-choice"`; `state.pendingChoice {test, assignment, allowed}`; `state.pendingTiming {assignmentId, timing}`; radios read through `exactTiming` (junk = no pick, never Standard) | **change**: a "Before you start" screen with up to two blocks (timing, scope), shown when **either** policy is student-choice; the fixed value of the other block is stated, not asked; Continue needs a valid pick for every block shown; scope radios read through a closed `exactScope` table (junk = no pick, never Full); the pending pick becomes `{assignmentId, timing, scope}`; `startAssignment` 2247 and the defensive branch at 2546 dispatch on either policy. Order stays: choice → start code (proctored) → `startTestFlow` → `startTestFlowLoaded` re-checks. |
| `openStartCode` 2612 / `scStartBtn` 2645 | the code gates after the choice | auto |

### 1c. Record, checkpoint, crash-resume (attempts.js, app.js)

| Where | Assumes today | For a partial record |
|---|---|---|
| `Attempts.begin` attempts.js:1045 | stamps testId / testName / testVersion / timing / conditions; `timingSelectedByStudent` top-level (1097) | **change**: stamp `scope` from `opts`, top-level, **omitted** for a full sitting so every full record is byte-identical to today (the golden-keys pins in two suites stay green) |
| `buildScore` 728, `buildAnswers` 747 | iterate `test.modules` and skip modules without moduleState | auto once `currentTest` is scoped: `answers`, `score.bySection`, `score.byModule` hold only scoped modules; `score.correct / graded / noKey` are totals over the scope |
| `moduleStart` 1111 / `moduleEnd` 1133 | `modules[]` entry per opened module | auto: a partial record's `modules[]` has one or two entries |
| boundary checkpoint 1159-1168 | `next < appState.currentTest.modules.length` | auto — `moduleIndex` indexes the **scoped** array, so after `re1` of `[re1,re2]` the checkpoint points at index 1 = `re2` |
| live checkpoint 842, `positionBlob` 778 | moduleIndex; annotations keyed by moduleState | auto (scope-relative) |
| `finalize` 1174 | annotations from `positionBlob`; the auto-release mirror | auto |
| `resume` 1359 | rebuilds `qMeta` from `record.answers` | auto |
| `crashResumeCandidate` app.js:767; range check 790 `cp.moduleIndex >= testModuleCount(test)` | the manifest's 4 | **change**: check against the record's scope length (1, 2 or 4); a checkpoint at moduleIndex 2 on a Math-only record is corrupt and must fall back to the card, not be clamped into a wrong module |
| `resumeTestFlow` 2692 → `withTestContent` → `resumeTestFlowLoaded` 2716: `state.currentTest = test` (the full pinned build); `idx = Math.min(resume.moduleIndex, test.modules.length-1)` (2730) | the full form | **change**: `state.currentTest = AttemptScope.testFor(full, record)` before the clamp and before `buildModuleStateFromRecord`. This is the brief's "crash-resume restores the stored scope": without it a Math-only checkpoint at moduleIndex 1 reopens **RW Module 2**. Reads the record's scope, never the assignment. |
| `buildAssignmentIndex` 2000; `resumeRecords` 2085-2110 | one crash-resume slot per canonical testId | unchanged — the reason the active-assignment refusal stays |
| `resumableVersionsFor` 1092 | pins builds by the record's testVersion | auto |
| `attemptResumable` 1971, `attemptCompleted` 1964 | status, blob, servable version | auto |
| ATTEMPTS-SPEC §2 | the record shape | **change**: document `scope` |

### 1d. Scoring and Score Details (app.js)

| Where | Assumes today | For a partial record |
|---|---|---|
| `scaledScores` 5066 | all four module raws, else null (5076) | **change**: a scope-aware variant — full as today; section → that section's scaled number, `total: null`; module → null. The legacy per-section `sc.rw[]` branch stays for the old model. |
| `storedModuleRaw` 2325 | every module of the test it is given must have a `byModule` entry, else null | **change**: iterate the scoped test; a scoped module without an entry stays "corrupt" (null), an out-of-scope one is simply not asked for |
| `buildScoreRows` 5091 | `test.modules` → tally over both sections; `moduleRaw {rw:[0,0], math:[0,0]}` | auto when handed the scoped test; an absent section's tally is 0/0 and the hero must not print it |
| `openScoreDetailsLoaded` 5211 | `buildScoreRows(test, record)` with the full form | **change**: scope the test here (one line). `sdCtx.test` is what the strips, Review Mode, the calculator button and `exitReviewMode` read, so this one seam scopes them all. |
| `renderScoreDetails` hero 5240-5263 | TOTAL plus two section numbers; the raw fallback sums both sections | **change**: full → unchanged; section → that section's scaled number only, TOTAL shows "—" and "Section only" where "400–1600" sits; module → the "CORRECT n / m" hero with "Single module", no scaled number anywhere; the sub-line gains the scope label (closed table, escaped) beside the timing badge |
| module strips 5271 | `test.modules.map` | auto with the scoped test |
| Knowledge and Skills 5297 | `["Reading and Writing","Math"].forEach` guarded by `domains[section]` | auto — an absent section renders no block |
| Questions overview tabs 5407 (`renderQuestionsOverview` 5376) | All / RW / Math always | **change**: hide the tab of a section not in scope (an empty tab says "No questions" for the wrong reason) |
| `sdDownloadBtn` → `window.print()`; styles.css:1441 | prints the hero DOM | auto once the hero is right |

### 1e. Past card, Review Mode, Score Calculator (app.js)

| Where | Assumes today | For a partial record |
|---|---|---|
| `renderPastCards` 2350; scaled line 2426-2440; badge 2447 | `scaledScores(loadedTest, rw, math, storedModuleRaw(…))` → the total over "400–1600"; raw fallback "c / g correct" | **change**: section → the section's number over "200–800" with "Section only"; module → "n / m correct · Single module"; the badge line gains the scope label beside the timing badge |
| `openReviewMode` 5456 | `sdCtx.test` | auto (scoped at 5211): strips, chips, `reviewStep` boundaries and the navigator walk the scoped modules, so review shows only the sat modules |
| `exitReviewMode` 5529 | re-renders from `sdCtx` | auto |
| `AppScoreView.open` 6050 (dashboard → student view) | `openScoreDetails(test, record, "dashboard")` | auto (same seam) |
| `scPrefillSource` 5880 / `openScoreCalc` 5901 | the newest released completed attempt on the current build prefills all four sliders via `buildScoreRows(full, src)` | **change**: skip partial records — a Math-only record would prefill RW at 0/27 and mark "your most recent result" there. The calculator stays a full-form what-if. |
| `scMaxes` 5844, `renderScoreCalc` 5967 | per-module maxima from the loaded form | unchanged (reads the form, never a record) |
| `openTestViewer` 5637, `AppTestViewer.counts` 5797 | the whole form | unchanged (no record involved) |

### 1f. Dashboard (dashboard.js)

| Where | Assumes today | For a partial record |
|---|---|---|
| `viewAttempts` 1243 | Test cell = testName (+ `set` badge at 1259); Score = `scoreStr` (correct/graded over the record) | **change**: a scope badge in the Test cell, from the closed table; Score stays the record's own correct/graded, already scope-relative |
| `sortVal` 1268 (`score` → `scorePct` 709) | a percentage across records | unchanged (a Math-only 40/44 sorts by its own percentage — a stated limit) |
| `viewStudents` 1278; RW / Math columns 1330-1335 | `bySection` | auto ("—" for an absent section via `countPair`); **change**: the scope badge in the Test cell |
| `viewItems` 1356 | iterates `r.answers` | auto: absent → no row at all; blank → `times` only, never `answered` — exactly the distinction the brief draws |
| `viewInsights` 1416; pacing 1461 | iterates `r.answers` and `r.modules` | auto |
| `openDetail` 3510 | `Object.entries(r.answers)`; `r.modules` chips | auto; **change**: the scope label in the header line |
| `releaseCell` 1179, `toggleRelease` 1200 | — | unchanged |
| `assignRowStatus` 1582, `attemptsForAssignment` 1550 | completed or timed-out ⇒ Completed | auto — a partial sitting completes its assignment |
| `activeAssignmentFor` 1865; `createAssignment` plan 2211-2222 | one active assignment per (code, test) | unchanged, deliberately |
| `unsatTestIds` 1837 ("Select all not yet sat", button title at 1689) | any finished or in-progress form attempt ⇒ sat | rule unchanged (a Math-only sitting makes the test "sat"); **change** the button's title to say "sat in any part" |
| `viewAssign` rows 1630-1660 | Timing / Release columns from the row | **change**: a Scope column (`assignScopeText`, beside `assignTimingText` 793) |
| `viewAssign` form 1666-1720; `createAssignment` row 2240-2250 | `timingPolicy`, `releaseMode` controls and fields | **change**: a Scope control (Full / Reading & Writing / Math / one module / Student chooses + preset ticks) writing `scopePolicy` on every row of the bulk plan; the `canonJson` read-back (1892) covers the new key as is |
| `assignOverlapHtml` 517 / `overlapFor` 491 (one block per selected test, per code) | canonical-id overlap only | **change**: the exposure line the brief asks for — "Modules already sat on this form: RW M1, RW M2 (completed 1 Oct 2026); Math M1 (in progress)". Source: that code's live form records of the canonical test; a slot counts as sat when any `answers` entry with that id prefix has `visitCount > 0` (true of every opened module, old or new record, any status, without loading content), and a completed record's declared `scope` adds its slots; deleted records and sets never count; a row Completed by hint alone (record archived away) reads "sat — modules unknown" |
| `attemptRefs` 343 (the seen set) | comment: "a completed or timed-out sitting opened every module" | auto in code (answer keys = scoped refs); **change** the comment |
| `exportAll` 1050; `adoptArchive` 1022 | records raw; schema `acestem-attempt-archive-v1` | unchanged |
| `deleteArchived` 1090 | finished records | unchanged |
| `qIndex` 662 | the whole form (a lookup table) | unchanged |

### 1g. Server (supabase/migrations)

| Where | Assumes today | Change |
|---|---|---|
| `fn_upsert_attempt`, 2026-11-02 lines 150-176 | see 0.2 | **new migration** restating the function with the one-release guard; `scope` is never read server-side — a client-written label and filter, never a grant |
| `fn_tombstone_attempt`, 2026-09-18 lines 309-323 | copies testId / assignmentId / status / attemptKind / setId / conditions into the marker | unchanged — the stub feeds only `buildAssignmentIndex`; the dashboard shows the record itself present-but-marked, so its label comes from the record |
| `fn_get_own_attempts`, `fn_get_assignments`, `fn_get_set` | row shapes opaque | unchanged |

### 1h. Tests, proofs and scripts

| File | What it holds | Partial-sitting impact |
|---|---|---|
| `tests/assignment-options.test.js` | `GOLDEN_FORM_KEYS` 130-131 (a full form record's keys; 192, 201); §3 `decide()` model of the SQL branch 295-330; **line 336 pins the newest `fn_upsert_attempt` migration as `2026-11-02_assignment_options.sql`**; GUARDS 348-360 with a removal control each | the key pin stays green (full records unchanged); line 336 is a pre-existing assertion that must change to the new file (before/after to be listed in Stage 2); the GUARDS list is re-applied to the new text plus the new guard with its own removal control; the model gains the forged-id case |
| `tests/tombstone.test.js` | `RESTATED` 334 sanctions restatements of covered functions; `restatementProbs` 340-350 re-applies the gates | add the new migration to `RESTATED` (a changed pre-existing assertion) |
| `tests/set-release-rule.test.js` 149-176 | newest-defining ≥ tombstones; isolates the first `if coalesce(v_released` branch (the set rule) | stays green if the set branch is restated verbatim and first |
| `tests/set-flow.test.js` 113-128 | golden form keys; set extras exactly six | green (full form; sets untouched) |
| `tests/attempts-recording.test.js`, `tests/timer-drift.test.js` | one-module fixtures; per-module timers | green, unchanged |
| `tests/tutor-writes.test.js` §13 2526-2660 | the real `createAssignment`; row fields checked property-wise at 2545 / 2569 / 2652; `canonJson` read-back | an added `scopePolicy` key does not red the property checks; the read-back compares the whole row on both sides; new cases: a scoped row written and read back, student-choice presets |
| `tests/canonical-index.test.js` 236-242, 271-306 | `formRec` fixture with 98 answers; "exposes the 98 questions its answers map holds" | green; add a Math-only fixture exposing 44 refs and marking nothing of RW seen |
| `tests/injection-proof.js` 140-160, 384-400 | a planted full record through Past card → Score Details → print DOM; 116 surfaces | add: a crafted `scope` (markup, wrong type, unknown slot, empty) renders the closed-table label or nothing, never record text; a planted Math-only record's hero prints no total |
| `tests/spr-grading.test.js` §5 596-740 | walks `r.answers` of every record; `sprSeen > 0` | green over every existing record (no module assumption); a partial record contributes only its own answers |
| `tests/set-audit.test.js`, `tests/verify-attemptid-key.js` | the audit as a subprocess; key = attemptId | green |
| `tests/test-viewer.test.js`, `tests/viewer-proof.js`, `viewer-proof-mutants.js` | the viewer walks forms; stand-in `{attemptId, answers:{}}` | green (no record scope) |
| `tests/keep-classes.test.js`, `tests/image-choice.test.js` §8 | the sanitizer has exactly four sinks | the new choice block and labels are `escapeHtml` over closed-table strings — no new `sanitizeSavedHtml` sink, §8 stays at four |
| `tests/build-site-drift.test.js` | runs the real build on a copy | gains the slot-mapping gate's control (a form with modules out of order reds the build) |
| `archive-testdata.js`, `build-site.js:259`, `backfill-skill-tags.js`, `skill-patch.js`, `assemble.py` | walk test content only | unchanged, except the new gate in `build-site.js` |
| test-bank repo's `build_stage3_preview.py` | replaces the first `state.assignments = assigns;` in app.js | that anchor must stay exactly once (CLAUDE.md) |

---

## 2. How practice sets represent partial content, and how a partial form sitting shares it

A set sitting never runs on a form. `syntheticSetTest` (app.js:1509) builds a
one-module test — `modules: [{moduleId: "<setId>-m1", section, questions}]`
— and the recorder runs on it exactly as on a form: `record.modules[]` has
that one entry, `record.answers` holds only its questions, `score.bySection`
has one section. The set's extra fields are `kind:"set"`, `setId`, `setName`,
`subject`, `releaseOnSubmit` and `setQuestions[]` — the **provenance
snapshot** (which source and build each question came from), needed because a
set's content is composed from several sources and the set object is mutable
in storage. Review rebuilds the synthetic test from `setQuestions`
(`buildSetTestFromRecord` 1592); resume pins each source to its recorded
version (1651).

A partial form sitting shares the **mechanism**, not the fields:

- it runs on a **scoped copy** of the form — same `testId`, `testName`,
  `testVersion`, `scoring`, with `modules` filtered to the scope — so
  `modules[]`, `answers`, `score`, `annotations` and both blobs hold only the
  scoped modules, the way a set's hold only its one module;
- its provenance is `testId + testVersion + scope` (which part of which
  pinned build): `scope` is the form analogue of `setQuestions`, and it is
  enough because a form is immutable per version and the scope names
  modules, not questions;
- `kind` stays absent (a form), so `isSetKeyed` / `isValidSetRecord`
  (app.js:1502-1507), the key-prefix routing in `renderPastCards`, the
  server's set branch and the marker's `attemptKind` are untouched.

Every consumer then reads **one** contract for all three shapes — "which
modules did this record sit": `AttemptScope.modulesOf(record)` gives a set's
one synthetic module, a form's scoped slots, or all four when `scope` is
absent — and pairs a loaded form with a record **only** through
`AttemptScope.testFor(test, record)`. No third shape: a partial record *is* a
form record (today's keys plus `scope`); a set record is unchanged.

---

## 3. Proposed record and assignment shape

```jsonc
// attempt record — top-level, OPTIONAL, stamped by Attempts.begin, never changed.
// Absent ⇒ full sitting: every existing record is unchanged and reads as full.
"scope": {
  "modules": ["ma1", "ma2"],      // 1, 2 or 4 slots from re1 re2 ma1 ma2, in form order,
                                  //   equal to one of the seven presets (below)
  "selectedByStudent": true       // present (true) only when the assignment let the
                                  //   student choose and they did; omitted otherwise
}
```

Why one object rather than a bare array plus a `scopeSelectedByStudent` flag
(the timing precedent): `timingSelectedByStudent` is separate because
`timing` was already a scalar on every record; `scope` is new, and one object
keeps the pick and who made it together. Both are additive. **This is the one
shape choice I want a word on (§8.1).**

Reader rules — `window.AttemptScope` in attempts.js beside `AssignmentRules`,
so app.js and dashboard.js cannot disagree:

- `SLOTS = ["re1","re2","ma1","ma2"]`; `PRESETS`: `full` = all four, `rw` =
  `[re1,re2]`, `math` = `[ma1,ma2]`, and `re1`, `re2`, `ma1`, `ma2` as the
  four single-module presets. Nothing else is a scope.
- `scopeOf(record)` → `{kind: "full"|"section"|"module", modules: […],
  section: "Reading and Writing"|"Math"|null, selected: bool}`. Untrusted
  input (ATTEMPTS-SPEC §7): anything that is not a distinct, in-order subset
  equal to a preset reads as **full** — a crafted scope can only mislabel the
  student's own record, since the answers decide every count. `selected`
  counts only as the literal `true`, like the timing flag.
- `testFor(test, record)` → the test with `modules` filtered to the scope by
  slot. A module's slot is its section's ordinal (`re`+n for Reading and
  Writing, `ma`+n for Math), cross-checked against its questions' id prefix.
  A form on which the mapping fails is refused at build time
  (`build-site.js` gate), so at run time the mapping is total.
- `label(record)` → `""` (full) / `"Reading and Writing only"` /
  `"Math only"` / `"Single module · RW Module 1"` etc., from a closed table;
  every surface escapes it like the timing label. Student-facing score
  surfaces use the brief's words: **"Section only"**, **"Single module"**.
- `scaled(test, record, moduleRaw)` → the scope-aware curve: full as today;
  section → `{rw|math, total: null}`; module → null.

```jsonc
// assignment row — ADDITIVE, read only through AssignmentRules.scopePolicyOf(a)
"scopePolicy": { "mode": "fixed", "modules": ["re1","re2","ma1","ma2"] }
// or
"scopePolicy": { "mode": "student-choice", "allowed": ["full", "rw", "math"] }   // preset names
```

Absent ⇒ fixed full (today's behaviour). A malformed `modules` list ⇒ fixed
full; a student-choice row whose `allowed` holds nothing valid ⇒ **fixed
full, never a free pick** (the `timingPolicyOf` discipline, attempts.js:652).
`allowed` lists **preset names** rather than module arrays so the form, the
choice screen and the record's `modules` cannot drift on what a preset means;
`fixed` carries the module list because that is what the brief specified and
what the record stamps.

---

## 4. Consumers that change — the Stage 2 sweep list

1. attempts.js — `window.AttemptScope` (new, beside `AssignmentRules`);
   `AssignmentRules.scopePolicyOf`; `Attempts.begin` stamps `scope` from
   `opts` (1045).
2. app.js `startTestFlowLoaded` 2488 — resolve scope, scope `currentTest`,
   pass to `begin`, second-layer refusal.
3. app.js pre-flight 2537-2609 + index.html 156-172 — the two-block screen,
   `exactScope`, the combined pending pick; `startAssignment` 2247.
4. app.js session resets (eleven sites, 1a) — clear the pending pick.
5. app.js `assignmentCard` 2215, `showReady(true)` 2750 — scope copy.
6. app.js `crashResumeCandidate` 790 — range-check against the scope.
7. app.js `resumeTestFlowLoaded` 2716 — scope the loaded build.
8. app.js `scaledScores` 5066 (+ `AttemptScope.scaled`), `storedModuleRaw`
   2325, `openScoreDetailsLoaded` 5211, `renderScoreDetails` hero 5240-5263,
   `renderQuestionsOverview` tabs 5407, `renderPastCards` 2426-2447,
   `scPrefillSource` 5880.
9. dashboard.js `viewAttempts` 1259, `viewStudents` 1332, `openDetail` 3562
   — the scope badge/label; `viewAssign` 1630-1720 — Scope column and
   control; `createAssignment` 2240 — `scopePolicy` on every row;
   `assignOverlapHtml` 517 — the exposure line; the "not yet sat" button
   title 1689; `attemptRefs` comment 343.
10. supabase/migrations — a new `fn_upsert_attempt` restatement with the
    one-release guard.
11. build-site.js — the slot-mapping gate.
12. ATTEMPTS-SPEC.md §2, §10; CLAUDE.md — the note for this batch.
13. Tests: the new checks in §6; the three changed pre-existing assertions
    (assignment-options 336, tombstone `RESTATED` 334, injection-proof's
    surface count); new fixtures in canonical-index and injection-proof.

Everything else in §1 is **auto** and gets a check, not a change.

---

## 5. The design decisions, checked against the code

| Decision | Verdict |
|---|---|
| `scopePolicy: {mode:"fixed", modules} \| {mode:"student-choice", allowed}` | Stands, with `allowed` as preset names (§3) and "module ids" meaning the four slots (0.1). |
| The seven presets, no other combinations | Stands; the closed preset table is what makes a crafted scope harmless. |
| Student choice on the pre-flight screen, required, stamped at begin, immutable; resume / crash-resume / Review Mode read the record | Stands; the screen generalises from one block to two (1b); the record-only readers are 1c/1d. |
| Form order; one section ⇒ no break; one module ⇒ no break and no second module | Stands **by construction** of `submitModule` once `currentTest` is scoped (1a). |
| Checkpointing and timing per module | Stands by construction (1c); the one thing that must be done by hand is re-scoping the build on resume (1c, `resumeTestFlowLoaded`). |
| Scoring: full unchanged; section = the section's scaled number, total "—", "Section only"; module = raw + skills, "Single module"; never estimate a total | Stands, and the section score is **exact**, not an estimate (0.5). |
| The printable report carries the labels and no total | Stands (0.7). |
| Dashboard rows and student cards show the scope; the Past partition places a partial record once | Stands; there is no section partition to fix (0.6), only labels to add. |
| A partial sitting completes its assignment; keep the active-assignment refusal; show sat modules on the assign form | Stands; completion is automatic (1f), the refusal is untouched, the exposure line goes in the per-test overlap block (1f). |
| Auto-release binds to the stamped assignmentId and requires auto; a forged id only moves the bucket; new migration; the old binding's test goes red | Stands with the premise corrected (0.2): the binding already exists; the new guard is one release per auto assignment, and the red test is the forged-id case. |
| Additive record change; archive schema name unchanged; every existing record reads unchanged | Stands (§3): `scope` is omitted on full sittings, the export is raw, and absent reads as full everywhere. |

---

## 6. The Stage 2 checks the brief names, and where each lives

| Check | Where, and the mutant that reds it |
|---|---|
| A Math-only record has exactly two modules, no RW answers, a Math section score and `total: null` | A node suite driving the **real** attempts.js (as assignment-options §2 does) on the **real** `202606asiav2` form through `AttemptScope.testFor`: begin → moduleStart/End twice → finalize; assert `modules.length === 2`, no `re` key in `answers`, `bySection` has only Math, `AttemptScope.scaled` gives `{math, total:null}`. Mutant: skip the filter → 4 modules, 98 answers. |
| A single-module record has no scaled score anywhere | The same suite plus the rendered strings: the hero HTML, the Past card HTML and `viewAttempts` / `viewStudents` rows for an `re1` record contain no "400–1600", no "200–800", no scaled number; the tutor-writes dashboard harness already renders those views in node. Mutant: a `scaled()` that converts one module. |
| A full-scope record is identical in shape to today's | The existing golden-key pins (assignment-options 192, set-flow 116) **plus** a byte compare of a full record from the new recorder against one from the pre-change attempts.js (`git show 21b6855:attempts.js`), both driven by the same script with a fixed clock. |
| Crash-resume of a partial sitting restores the stored scope | `resumeTestFlowLoaded` extracted by text (extract-helper, as test-viewer.test.js does) with a Math-only record whose checkpoint has `moduleIndex: 1`; assert `state.currentTest.modules` are the two Math modules and `beginModule` receives index 1 = `math2`. Mutant: the un-scoped line → RW Module 2. Plus `crashResumeCandidate` refusing `moduleIndex: 2` on that record. |
| Review Mode on a partial record shows only the sat modules | `openScoreDetailsLoaded` + the strips + `reviewStep` in the same harness: two strips, and stepping forward from the last Math question does not cross into anything. Mutant: hand the full form to `buildScoreRows`. |
| The printable report prints no total for a partial record | injection-proof's existing "Print output (same DOM as Score Details)" audit, run with a planted Math-only record: the hero has "—" and "Section only" and no `400–1600`; the node string check above covers the same DOM text. |
| The SPR audit still passes over every existing record | `node tests/spr-grading.test.js <newest export>` (Downloads, `attempts-archive-<date>.json`), then the same with a synthesised partial record appended through the set-audit subprocess pattern, which must count it and not skip it. |
| A manual sitting of a test with a completed auto row stays unreleased | assignment-options §3 `decide()` extended with the one-release rule, pinned to the new migration text with a removal control; the case "a second completed attempt stamping the consumed auto row" is the one that reds the 2026-11-02 text (0.2). The genuine manual case stays green on both. |

Also in Stage 2, under the standing rules: the adversarial review runs before
the push and the completion notification is the only done signal; no propped
tests; every new innerHTML site renders closed-table strings through
`escapeHtml` and adds no sanitizer sink; the changed pre-existing assertions
are listed with before and after.

---

## 7. Limits to state up front

- **Old tabs.** A tab loaded before the deploy starts a scoped assignment as a
  **full** sitting and writes a full record under a scoped row — a content
  exposure, not just a timing slip as in the 2026-11-02 batch. Nothing on the
  server can refuse it (scope is client-side). Reload open student tabs
  before assigning any partial scope.
- **Archive-then-delete and the one-release guard** (0.2): once the consuming
  record is rotated off the server, a forged id naming that auto row can
  release again. Stated, not fixed.
- **Local and artifact mode** have no server: the `finalize` mirror decides
  release there, as today; the one-release guard is a remote-mode property.
- **"Select all not yet sat"** counts a test sat in any part as sat; the
  exposure line is the finer view.
- **Dashboard Score sort** compares percentages across scopes.
- A single-module record's Knowledge and Skills shows only that module's
  domains — honest but thin.
- A fixed single-module **home card** cannot show the question count without
  loading the form (1a).
- The `sectionTitle` header keeps the form's own numbering ("Section 2,
  Module 1: Math" for a Math-only sitting).
- Deploy order for the new migration: apply it **first**, then push. It is
  purely restrictive (it refuses one forged case) and restates every earlier
  gate, so it also serves as the re-apply the tombstone migration still
  needed; re-applying is harmless.

---

## 8. Questions before Stage 2

1. **Record shape:** `scope: {modules, selectedByStudent}` (proposed) or a
   bare `scope: [...]` plus a top-level `scopeSelectedByStudent` flag, the
   timing precedent?
2. **Server guard:** confirm the premise correction in 0.2 and the rule — one
   release per auto assignment; a second completed attempt naming the row
   (deleted records included) is refused release; the genuine manual case is
   already green.
3. **Score Calculator:** skip partial records for the prefill (proposed), or
   prefill the sat modules only?
4. **Exposure line's home:** inside the existing per-test overlap block on the
   Assign form (proposed — it is already per selected test, per code), or a
   column in the Assignments table?
5. **Home card for a fixed single module:** "RW Module 1 · 1 module" without
   a question count — acceptable?
