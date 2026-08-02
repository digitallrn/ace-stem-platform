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
                          The ONLY test file loaded at startup.
testdata/<testId>.js      the full test; registers itself into
                          window.__TESTDATA__[testId]. Lazy — fetched only
                          when a sitting starts or resumes (or Score Details
                          opens, or the dashboard needs item analysis).
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
  (ATTEMPTS-SPEC §9). Version-gating is per test.
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

Load order matters: `testdata/manifest.js`, `render.js`, `grading.js`,
`attempts.js`, `app.js`, `dashboard.js` — plain (non-module) scripts, so
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

`tests/injection-proof.js` is a paste-into-the-console regression proof —
run it against `dist/index-live.html` after touching any render surface.
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
  running app needs are copied in (`index.html`, `404.html`, `styles.css`,
  the five app JS files, `testdata/manifest.js` plus every test the manifest
  lists, `config.js`, `_headers`). Everything
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
- `testdata/202606asiav1.js` holds "2026 June Asia v1" (98 questions) at
  testVersion 2026-08-01-c; `testdata/202606asiav2.js` holds "2026 June Asia
  v2". Regenerate from the test-bank repo's JSON — never hand-edit — and bump
  `testVersion` on any content change after students have taken it
  (ATTEMPTS-SPEC §9).
