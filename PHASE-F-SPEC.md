# PHASE-F-SPEC.md — Access model, sign-in, and pre-publish polish

*Drop in the `ace-stem-platform` repo root. Reference screenshots 21–24 in
`reference/bluebook-screenshots/`: 21 = real sign-in page (blue field,
illustration band, white card), 22 = timer at 2:09 with no Hide button,
23 = the "5 minutes left" popup, 24 = the real Start Code screen. This phase
supersedes the earlier two-item hardening message (its items are §7–§8 here).
Implement top to bottom; stop for David's review at the end.*

---

## 1. Two-layer access model (the core of this phase)

**Layer 1 — student code (identity).** Unchanged from Phase D: the
persistent `AS-XXXX` code is who the student is. All history, grouping,
release-gating, and analytics key off it. Sign-in still takes only this.

**Layer 2 — start code (access).** A tutor-generated numeric code that
gates *starting* a proctored sitting, mirroring the real proctor ceremony.

## 2. Assignments v2

Replace the bare `assign:<CODE> → [testIds]` map with assignment objects:

```jsonc
// storage key: assign:<STUDENT-CODE>  → array of:
{
  "assignmentId": "a-<epoch>-<rand4>",
  "testId": "202606asiav1",
  "category": "test" | "practice",   // drives which home section
  "startCode": "492776",             // REQUIRED for category "test"; null for "practice"
  "windowOpens": "2026-08-02T00:00:00Z",   // optional
  "expiresAt": "2026-08-02T23:59:00Z",     // gates STARTING only
  "assignedAt": "...", 
  "completedAttemptId": null         // set on finalize; card becomes Completed
}
```

Semantics — get these exact:
- **Expiry gates starting, never resuming.** An in-progress attempt resumes
  and finishes regardless of `expiresAt`.
- **No consumption.** One start code can serve a whole room of students
  sitting together (real proctor-code behavior). Retake = David creates a
  new assignment; a completed assignment's card shows Completed and offers
  nothing else (View My Responses arrives via release, as today).
- ~~**Default when a student code has no `assign:` key:** all published tests
  visible under Practice and Prepare (preserves today's zero-config
  behavior).~~ **REVERSED 2026-08-01** — a code with no assignments now sees
  nothing; both home sections render their empty states. Absent and
  explicitly-empty are equivalent. All student-visible material must be
  explicitly granted by the tutor. See ATTEMPTS-SPEC §10.
- **Conditions auto-set:** attempts started through a start code record
  `conditions: "proctored"`; category "practice" records
  `"self-administered"`. Remove the sign-in toggle — the ceremony is the
  truth now.

## 3. Dashboard: Assign panel + start-code generation

New dashboard section: pick student code(s) (multi-select from codes seen in
storage, plus free entry), pick test, pick category, optional window/expiry
(default expiry: end of the chosen day), and for category "test" generate
the 6-digit numeric start code (display it big — David reads it aloud).
List existing assignments with status (pending / in-progress / completed /
expired) and allow deleting only assignments with no attempt.

## 4. Start Code screen (screenshot 24)

Shown when a student hits Start on a category-"test" card: pale green page,
"Start Code" title, "Enter your start code now to begin testing. Good
luck!", bold "The start code contains **numbers only**.", six single-digit
boxes with auto-advance/backspace, yellow "Start Test" pill, Help (top
left, may reuse the More-menu Help modal or omit), "Return to Home" top
right. Wrong code → inline error; expired → "This start code has expired —
ask your tutor." Practice-category cards skip this screen entirely.

## 5. Sign-in page visual (screenshot 21)

Blue full-bleed background (#2f45c5-ish — sample screenshot 21), centered
white rounded card titled "Sign In" holding the existing code input, and a
decorative illustration band along the bottom in lighter blue line-art.
**Draw original artwork in the same spirit (desks, buildings, calculator,
book, timer silhouettes) — do not reproduce College Board's actual
illustration.** Ace STEM wordmark where Bluebook's logo sits.

Top-right pill: **"Test Your Device"** — repurposed as a real pre-flight
check, shown as a small modal running four checks with pass/fail marks:
internet reachable, KaTeX loaded (render a test fraction), Desmos loads,
storage writable (write+delete a probe key; in devstorage/absent-storage
report which mode). This is the at-home student's "will test day work on
this laptop" button.

## 6. Five-minute alert (screenshots 22–23)

At 5:00 remaining in any module: dark rounded popup below the timer —
"5 minutes left in this part of the test." with an X to dismiss; shows once
per module. If the timer is hidden, force-show it. **Remove/disable the
Hide control for the rest of the module** (screenshot 22 shows no Hide
button in the final minutes). Timer red state unchanged (already built).

## 7. Sign-in hardening (carried from the earlier batch)

Student-code validation at sign-in: accept `AS-` + four letters/digits,
case-insensitive, displayed uppercase; friendly rejection ("Enter the code
your tutor gave you — it looks like AS-1234"); the admin name still passes.

## 8. Save-and-Exit failure guard (carried)

If the resume write fails or storage is absent, keep the student in the
test with a clear warning and offer the Download Results JSON fallback —
never return home to a Start card over unrecoverable progress.

## 9. Report a bug

Small "Report a bug" affordance in the More menu (in-test) and a footer
link on the home screen. Opens a minimal dialog: one textarea + Send.
On send, write `bug:<epoch>-<rand4>` to shared storage with auto-context:
student code, testId + testVersion, attemptId, moduleId + question id if
in-test, timer remaining, userAgent, and the student's text. Dashboard
gains a "Bug reports" section listing them (newest first, dismissable).
If storage is absent/failing, fall back to a mailto: draft containing the
same context. Never block or interrupt the test on failure.

## 10. Out of scope / unchanged

Score-visibility (b), release flow, View My Responses, archive-then-delete,
resume mechanics, all Phase A–E behavior. No student deletion anywhere.
Version-gating rules unchanged.
