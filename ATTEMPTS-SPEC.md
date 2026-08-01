# Attempt Recording & Tutor Dashboard — spec

*Drop this in the `ace-stem-platform` repo root. Companion to `SCHEMA-v1.2.md`:
that one defines the **questions**, this one defines the **attempts**.*

Backports the last two fork features into the platform, but with a record
shape built for keeping records over time rather than just showing a score
once.

---

## 1. Storage model

Artifact shared storage (`window.storage`), the same mechanism the fork uses.

**One key per attempt.** `attempt:<testId>:<startedAt-epoch>:<rand4>`
— e.g. `attempt:2024-march-c:1753300000:a7f3`.

Never keep a single "all attempts" index key. Storage is last-write-wins, so
two students finishing at the same time would silently clobber each other's
entry. The dashboard enumerates with `storage.list("attempt:")` instead.

**All attempt data is `shared: true`** — it has to be, or the tutor can't see
what students did.

**Per-key limits:** 5MB, keys under 200 chars. A full 98-question attempt is
a few tens of KB, so one key per attempt is comfortable. Writes are rate
limited, hence the checkpoint schedule in §3 rather than a write per click.

## 2. The attempt record

```jsonc
{
  "recordVersion": 1,
  "attemptId": "attempt:2024-march-c:1753300000:a7f3",

  "student": {
    "displayName": "Erin K",        // exactly as typed at sign-in
    "key": "erin k"                 // lowercased/collapsed, for grouping only
  },

  "testId": "2024-march-c",
  "testName": "2024 March C",
  "testVersion": "2026-07-20-a",    // which build of the test data was served
  "conditions": "proctored",        // "proctored" | "self-administered" | "unknown"

  "startedAt": "2026-07-23T18:02:11.000Z",
  "lastSavedAt": "2026-07-23T19:44:52.000Z",
  "submittedAt": "2026-07-23T19:44:52.000Z",   // null until final submit
  "status": "completed",            // "in-progress" | "completed" | "timed-out"

  "modules": [
    {
      "moduleId": "2024-march-c-rw1",
      "section": "Reading and Writing",
      "moduleLabel": "Module 1",
      "timeLimitMinutes": 32,
      "startedAt": "...",
      "endedAt": "...",
      "timeSpentSeconds": 1811,
      "endedBy": "submitted"        // "submitted" | "timer-expired" | "abandoned"
    }
  ],

  "answers": {
    "re1-q1": {
      "given": 1,                   // MCQ index | SPR string | null if blank
      "firstGiven": 2,              // first answer they committed to, ever
      "correct": true,              // null when the question has no key
      "markedForReview": false,
      "eliminated": [0, 3],
      "timeSpentSeconds": 47,
      "visitCount": 2,              // how many times they landed on it
      "changeCount": 1,             // how many times they switched answers
      "blankReason": null           // null | "never-answered" | "cleared"
    }
  },

  "score": {
    "correct": 71, "graded": 96, "noKey": 2,
    "bySection": { "Reading and Writing": { "correct": 40, "graded": 52 } },
    "byModule":  { "2024-march-c-rw1": { "correct": 21, "graded": 27 } }
  },

  "client": { "userAgent": "...", "screen": "1512x982" }
}
```

Scoring uses the existing `answerMatches` / `hasKey` in `grading.js` — no
second implementation. Keyless questions stay out of denominators, same as
the results screen already does.

## 3. When to write

- On sign-in + test start → create the record, `status: "in-progress"`.
- At every **module boundary** → update (this is the important one).
- On a **debounced timer, ~every 45s** while a module is in progress.
- On final submit → `status: "completed"`, `submittedAt` set.
- On `visibilitychange`/`beforeunload` → best-effort flush.

The point: a student who closes the tab, loses wifi, or has a laptop die
mid-test loses at most the current module, not the whole sitting. Partial
attempts stay visible in the dashboard marked in-progress — those are real
records too (an abandoned Module 2 tells you something).

## 4. Identity

No accounts, so the sign-in name is the identity. Two consequences:

- **Group by `student.key`** (lowercased, whitespace-collapsed) so "erin k"
  and "Erin K" land together; always *display* `displayName`.
- The dashboard needs a **merge** affordance — mapping several keys onto one
  student — because "Erin", "Erin K" and "erin kim" will happen. Simplest
  version: a `studentAliases` storage key mapping variant → canonical.

The hidden admin name (`acestem-admin`) opens the dashboard and must never
create an attempt record.

## 5. Dashboard

Backport the fork's views, plus what record-keeping needs:

- **Attempts list** — student, test, date, score, status. Sortable; filter by
  test and by student.
- **Student view** — every attempt by one student across tests, oldest to
  newest, so improvement over time is visible at a glance.
- **Attempt detail** — full question review (reuse the results-screen
  renderer), including what they eliminated and what they marked.
- **Item analysis** — per question across attempts: % correct, most-chosen
  wrong answer, median time. Hardest-first. This is the view that tells you
  what to teach next.
- **Pacing** — per module, time spent vs limit; flag questions where time
  spent is way above that student's median (where they actually lost time).
- **Confidence quadrants** — cross `markedForReview` against `correct`, per
  student. Four buckets, each meaning something different:
  - *flagged + wrong* → knows what they don't know. Teachable, low priority.
  - *not flagged + wrong* → **blind spots.** They were confident and wrong.
    This is the highest-value list on the whole dashboard; lead with it.
  - *flagged + right* → anxiety, not knowledge gaps. Costs them time.
  - *not flagged + right* → solid.
- **Answer changes** — using `firstGiven` vs `given`: right→wrong,
  wrong→right, wrong→wrong. A student with a bad right→wrong ratio should be
  told to stop second-guessing; one with a good wrong→right ratio shouldn't.
  Opposite advice, indistinguishable without this field.
- **Fast-and-wrong** — very short `timeSpentSeconds` plus incorrect, relative
  to that student's median. Distinguishes guessing from genuine errors.

## 6. Export — do not skip this

A **Download all attempts (JSON)** button in the dashboard, plus the fork's
per-student **Download Results JSON** fallback for students when storage
writes fail (e.g. running the file locally rather than from the published
artifact).

Storage lives and dies with the published artifact. Unpublishing or losing
that artifact takes every record with it, and there's no export-after-the-
fact. Treat the downloaded JSON as the real archive and pull one after each
test day.

## 7. Privacy

Shared artifact storage is readable by anyone who can run the artifact and
knows how to query it. The hidden admin name is *obscurity, not security*.
That was acceptable for a two-student demo; it is not the standing plan.
Three mitigations, in order of effort:

**(a) Pseudonymize — do this now.** Attempt records store a **student code**,
never a name. At sign-in the student types the code you gave them (e.g.
`AS-4F2A`); the record holds only that. The code→name mapping lives in a
private file on David's machine, never in storage. A leaked record then reads
"AS-4F2A scored 1210", which is meaningfully less exposed than a name and
score. `displayName` in §2 becomes `studentCode`; §4's alias-merging problem
mostly disappears, since codes don't have spelling variants.

*Amended 2026-08-01 — display names, without weakening the above.* Students
now see their own name rather than a bare code, but **attempt records are
unchanged: they still carry `student.code` and never a name.** The name lives
in a separate row —

```jsonc
// key: "student:AS-7K4M9PXR", owner_code: "AS-7K4M9PXR"
{ "displayName": "Erin K" }
```

— so code→name is a *join*, not a field, and every archive, export and
attempt stays code-keyed. Performing that join requires either the student's
own code (`fn_get_profile(code)`, which returns only that one code's row and
cannot enumerate) or tutor auth. A leaked attempt record therefore still reads
"AS-7K4M9PXR scored 1210"; an attacker needs a *second* thing to attach a name
to it. Writing a profile is tutor-only, through the authenticated table path —
there is deliberately no anon write RPC, or a student could rename themselves
or anyone else, and anyone holding a code could plant strings into the tutor's
dashboard. Display names are untrusted input on the render surfaces and are
escaped like every other record-derived value (see CLAUDE.md's escaping
contract).

**(b) Minimize data at rest — also now.** After each test day: download the
JSON archive, verify it, then delete those keys from storage. The archive on
David's machine is the record of account; the artifact holds only recent,
un-archived attempts. Small exposure window, no extra infrastructure. The
dashboard should have a **"Delete archived attempts"** action so this is one
click, and it must require an explicit confirmation naming what's being
deleted.

**(c) Real backend — the actual fix, when it's worth the effort.**
`davidsatprep.com` already exists on Netlify with GitHub deploy. Hosting the
simulator there instead of as a claude.ai artifact, with something like
Supabase behind it, gets real auth on the tutor dashboard and row-level
security on the data — students write anonymously, only an authenticated
tutor reads. This is the version that's actually private rather than
merely unlisted.

⚠️ **Verify before designing around it:** it is not established here whether
a published claude.ai artifact can make network calls to an arbitrary
external domain (CSP restrictions may block it). If it can't, path (c)
implies moving off artifact hosting entirely, which is a larger change than
it sounds. Check this before committing to it.

Regardless of path: keep anything evaluative out of the records. Answers,
timings and codes only — no notes, no comments about a student.

## 8. New instrumentation needed

Already tracked in `state.moduleState`: `answers`, `flags` (marked for
review), `eliminated`. Those map straight across.

New, small additions to `app.js`:
- per-question elapsed time (accumulate while a question is on screen)
- `changeCount` per question
- module start/end timestamps and how the module ended

## 9. Question-ID stability — the long-run trap

Attempt records key answers by question id (`ma1-q7`), and the converter
**generates those ids positionally** from module + question number. So if a
test is re-extracted and the numbering shifts by one — a review row gets
fixed and inserted, a phantom module is corrected — every historical attempt
silently starts pointing at the wrong questions. Nothing errors; the data
just quietly becomes wrong.

Rules that prevent this:

1. **Freeze a test once a student has taken it.** Corrections after that
   produce a *new* `testVersion`, and old attempts stay bound to the version
   they were served.
2. **Ship `testVersion` in `test-data.js`** per test (a date-stamp or content
   hash) and copy it into every attempt record.
3. **Never renumber.** If a question is fixed in place, keep its id.
4. Because raw answers are stored (not just correctness), any attempt can be
   **re-scored** later if a key was wrong — relevant to the known-bad
   June Asia m2-q11 key. Re-scoring is only safe when ids and version line up,
   which is the whole point of the above.

## 10. Notes / decisions

- The platform, published as its own artifact, gets its **own** storage. The
  fork's July 11 attempts stay in the fork — don't migrate. Keep that chat
  and artifact alive as the archive for those.
- `recordVersion` is in the record so a later shape change can be handled
  rather than guessed at.
- Keep writes tolerant: every storage call in try/catch, and a failed write
  must never interrupt a student mid-test. Silent retry, then fall back to
  offering the JSON download at the end.
- `conditions` should be set at sign-in (a small proctored/self-administered
  toggle, or inferred from the admin starting the session). A 1210 taken
  unsupervised at home and a 1210 taken proctored are not the same number,
  and parent-facing reports shouldn't treat them as such.
