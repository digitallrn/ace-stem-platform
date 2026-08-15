# BLUEBOOK-PARITY.md — UI parity work from real Bluebook screenshots

*Drop this in the `ace-stem-platform` repo root. Source: David ran the real
College Board Bluebook app (build VSN-0.9.688, July 2026) and screenshotted
it. Put those screenshots in `reference/bluebook-screenshots/` in this repo —
numbered 01–14 in the order referenced below — and LOOK AT THEM while
implementing. This file tells you what each shows and what to build; the
pixels (colors, spacing, iconography) come from the images, not from prose.*

Content fixes (LaTeX pass, m2-q11) are tracked in the test-bank repo — not
part of this spec.

Implement phase by phase, **stopping after each phase for David's review**.

---

## Phase A — quick parity fixes

**A1. Eliminate strikethrough spans the full choice row.** (Screenshot 10.)
When a choice is eliminated in real Bluebook, the horizontal line runs edge
to edge across the entire choice container — through the letter badge circle
and the full box width — not just through the answer text. The small
letter-eliminate icon on that row is replaced by an "Undo" text link at the
right. We already have eliminate + Undo; the delta is the line's extent.
Match the screenshot.

**A2. Verify the underline/highlight menu matches.** (Screenshots 6–9.)
Selection toolbar: three color swatches (yellow, blue, pink), an underline
dropdown, trash, and a note button. The underline dropdown offers three
underline styles (solid, dashed, dotted — confirm against screenshot 8) plus
"None". Applying a style renders highlight + underline together on the
selected span (screenshot 9). The handoff says we built 3 colors + underline
styles already — this item is *verify against the screenshots and fix
divergences*, not build from scratch.

## Phase B — sticky notes (previously deferred; now requested)

(Screenshots 6, 13, 14.) The rightmost toolbar button on a text selection
creates a **note** attached to that highlighted span:

- The noted span's highlight renders in a stronger, fully saturated yellow
  than an ordinary highlight (screenshot 13 shows both in one passage).
- A notes rail appears between the passage pane and the question pane. Each
  note card shows: the highlighted snippet as its truncated title, a trash
  icon to delete the note, and an editable body with placeholder text
  "Notes are saved automatically" (auto-save on input, no save button).
- The rail collapses/expands via a chevron at its bottom edge (screenshot 13
  open with ">" chevron; screenshot 14 collapsed to a thin rail with "<").
- Notes persist per question alongside the existing highlight persistence,
  and must survive Back/Next navigation exactly as highlights do.
- Scope: Reading & Writing modules only — Math headers don't have
  Highlights & Notes in real Bluebook, and ours already match that.
- Deleting a note removes the note but should downgrade the span back to a
  normal highlight, not strip the highlight entirely (verify against real
  app behavior if David can; otherwise this is the sensible default).

## Phase C — Save and Exit + Resume

(Screenshots 3 and 12.) Real Bluebook's More (⋮) menu has **Save and Exit**;
an exited practice test shows on the home screen as an in-progress card with
a **Resume** button.

- Add the More menu (see Phase E for its other items). "Save and Exit":
  flush the attempt record immediately, then return to the home screen.
- Extend the attempt record with a `resume` blob:
  `{ moduleIndex, questionIndex, timeRemainingSeconds, annotations }` where
  `annotations` serializes per-question highlights + notes (currently these
  live only in in-memory moduleState — they must be persisted for resume to
  restore them).
- Timer pauses while exited (practice-mode behavior); resume restores the
  exact remaining time, module, question, answers, flags, eliminations,
  highlights, and notes.
- On sign-in, an in-progress attempt for this code + test surfaces as the
  Resume card (Phase D) rather than starting a fresh attempt. Starting fresh
  anyway is a tutor-dashboard action, not a student one.
- **Deliberate deviation:** real Bluebook shows a trash icon on in-progress
  and past practice cards (screenshots 2, 3) letting the student delete
  them. We do NOT give students delete. Attempts are records; deletion
  happens only in the tutor dashboard. Omit the trash icon entirely.
- Recorder interaction: `status` stays "in-progress" for saved-and-exited
  attempts; the dashboard already displays that correctly.

## Phase D — home screen restructure

(Screenshots 1–5.) Real Bluebook's home has two sections; ours needs only
one of them.

- **Skip "Your Tests" entirely** (screenshot 1) — that's real
  administrations (submitted answers, score release dates). Not applicable.
- Build the **Practice** section (screenshots 2, 3) with an
  **Active | Past** toggle:
  - *Active:* cards for each test available to this student code, plus any
    in-progress attempt as a Resume card (Phase C). Card: test name, status,
    primary action (Start / Resume).
  - *Past:* one card per completed attempt — test name, "✓ Completed", and
    **View My Responses**: a read-only, student-facing review of their own
    attempt (reuse the results-screen renderer, loading the stored attempt
    for this code). Which content it shows depends on the score-visibility
    decision below.
- **Skip the Test Type dropdown flow** (screenshots 4, 5) — real Bluebook
  asks SAT vs PSAT then a practice-test picker. We have one test type and
  code-based sign-in; go straight from sign-in to the Active list.
- **Assignment model:** which tests a code sees comes from an assignment
  map in storage (`assign:<code>` → [testIds]). **Default when absent: all
  published tests.** That makes it zero-config today (one test exists) and
  gives the tutor per-student control later without schema changes. A
  dashboard UI for editing assignments can wait until a second test exists.
- Keep Ace STEM branding — this is UI-behavior parity, not logo cloning.

### Open decision (David) — score visibility at submit
Currently: student submits → sees the full results dashboard immediately.
Real Bluebook (screenshot 1) defers real-test scores ("answers submitted,
see score release dates"), while practice shows responses. Options:
  (a) keep instant full results;
  (b) submit → confirmation only; results appear in "Past → View My
      Responses" only after the tutor releases them (a per-attempt flag
      set from the dashboard).
Implement whichever David picks; (b) adds a small `released` flag to the
attempt record and a release toggle in the dashboard.

## Phase E — More menu completion

(Screenshot 12.) Real menu: Help, Shortcuts, Assistive Technology,
Line Reader, Save and Exit.

- **Save and Exit** — Phase C.
- **Line Reader** — implement: a draggable horizontal reading mask that
  dims all but a band of text (College Board's focus tool). Keyboard: drag
  by mouse; Esc or re-click to dismiss.
- **Help** — optional small modal; fine to omit for now.
- **Shortcuts / Assistive Technology** — omit for now. Hide menu items that
  aren't implemented rather than shipping dead entries.

## Deliberate deviations (documented so they're decisions, not oversights)

1. No student-facing deletion of attempts (trash icons omitted).
2. No Test Type / practice-picker dropdowns — code sign-in replaces them.
3. No "Your Tests" real-administration section.
4. Branding stays Ace STEM.
5. "THIS IS A PRACTICE TEST" banner: the real app shows it (screenshots
   6–14); we removed it early on at David's request. Keeping it removed
   unless David reverses — one line to restore if he does.

## Measured call: inline fractions in stem prose stay text-style (2026-08-04)

Revisited d814cb0's deliberate split (choices/lead-ins displaystyle, prose
text-style) with measurements, because prose fractions "read too small".
The reference set DOES contain a real-Bluebook inline fraction in running
prose: screenshot 35's mixed-number bullet ("such as 3½"). Pixel-scanned:

|                          | real Bluebook (ref 35)   | ours (q-text, 17.5px)     |
|--------------------------|--------------------------|---------------------------|
| numerator ÷ full digit   | 11px ÷ 15px = **0.73**   | 13.23px ÷ 18.9px = **0.70** |
| line pitch, fraction line| 29px, same as neighbours | 28px, same as neighbours  |
| stack leading overflow   | ~2px into leading        | fits within 28px line     |

Real Bluebook renders prose fractions at TeX text-style proportions — the
numerator is ~0.7 of full size and the line does NOT grow. Ours already
matches within PNG antialiasing error (0.70 vs 0.73 ≈ 0.4px of glyph ink at
this size), on the three paths of the 202511 ma2-q18 comparison fraction
({{mm}} lead-in: full-size numerator at 20.65px; prose {{m}}: 13.23px
numerator, pitch unchanged; choice bigInline: full-size 18.9px numerator) and
on every shipped v1/v2 inline-prose fraction (ma1-q5/q7/q17/q20,
ma2-q6/q13/q16; v2 ma1-q12, ma2-q5 — all 0.70, all uniform 28px pitch).

**No change shipped.** Scaling prose fractions up would diverge from the
measured reference, and the reference confirms the original call: "too
small" is how real Bluebook typesets them too. If this is revisited again,
start from these numbers.

**Re-measured 2026-08-04 across three tests and RULED — closed.** The same
flag came back after 202511asiav1 landed. Measured: fractions render
identically across 202511asiav1 / 202606asiav1 / 202606asiav2 on all three
paths (prose numerator 13.23px = 0.70 script; choices full-size 18.9px;
lead-in full-size 20.65px). David ruled: no change — parity holds and the
tests match each other. Do not re-litigate without new reference material.

**A third confirmation, of a different kind (2026-08-12).** 202509asiav4's
Stage-3 read flagged fraction sizing three times on ONE form, in BOTH
directions: m1-q17 as "slightly big", m2-q11 and m2-q14 as "a bit small".
Measured live in `window.fmt` at the shipped 17.5px stem size, all three render
at **13.23px over a full digit of 18.9px = 0.70** — the same value, the same
path, no difference between them.

A single measured value drawing opposite complaints from the same reader on the
same form is evidence that the value is at the neutral point. Reader reports
that disagree with each other cannot both be describing the render; they are
describing context — a fraction next to a long integer reads small, one in a
short choice reads large. That is exactly what the reference measurement
already said, and it is the strongest argument yet for leaving it alone: there
is no setting that satisfies both flags, and 0.70 is the one that satisfies
neither more than the other.


## Measured call: lead-in display equations stay at 1.18em (2026-08-04)

Flag was "a touch too big". Measured the other way: reference 35's display
equation digits are **1.21×** its stem cap height; ours are **1.15×** (KaTeX
digits at 20.65px over Georgia caps at 17.5px — Georgia's tall old-style
figures make the 1.18em bump read bigger than it measures). We are slightly
UNDER parity; matching the reference would mean raising toward ~1.24em, not
lowering. Ruled: no change. Start here if revisited.

## Ruled: fractions inside superscripts render \textstyle (2026-08-04)

The one genuinely illegible case: a fraction inside a superscript lands in
scriptscript style, numerals at 0.5 = **9.45px** (v1 ma1-q7's p^(17/4)
choice set). Ruled: force `\textstyle` for exactly that shape —
`liftSupFractions()` in render.js — so the numerals reach script size
**13.23px**, the same as a plain exponent. Plain exponents stay at script
0.7 (standard TeX, matches the real app). Fires on 9 tokens across 4
questions (v1 ma1-q7 stem + 4 choices, v1 ma1-q20 c1/c3, v2 ma2-q13 c2/c3);
no subscript-fraction exists in the library; nothing in 202511asiav1 fires.

- Annotations (highlights/notes) are currently innerHTML-per-question in
  moduleState; serializing them into the attempt record for resume must not
  break the fmt()/KaTeX-rendered content they sit on top of.
- Any content change from the test-bank side (LaTeX pass, m2-q11) means a
  regenerated test-data.js with a bumped testVersion — coordinate so the
  parity work is tested against the final content, not the plain-text math.
- After Phase D, the sign-in → home → test → results flow is different
  enough that the full end-to-end verification (real clicks, then dashboard
  reconciliation) should be re-run the way the attempts build was verified.

## CORRECTION: highlighting covers stem and choices, not just the passage (2026-08-08)

**A conclusion recorded earlier was wrong, and so was the method that produced
it. Read this before re-deriving anything about annotation scope from the
screenshots.**

An earlier analysis concluded that real Bluebook confines highlighting to the
passage, and that our passage-only behaviour was therefore correct parity. It
was drawn entirely from the reference screenshots: every highlight in
06–14/31/35 sits in the left pane, and screenshot 12 shows text *selected*
inside choice D with no highlight toolbar visible. A per-pane pixel scan of
all eleven images agreed.

**David then tested the live Bluebook app directly: selecting text in the
question stem or inside an answer choice DOES pop the highlight toolbar.**
Highlighting is available there. The screenshots were never evidence of a
restriction.

Why the method failed, so it is not repeated: the toolbar is a **transient
popup — it appears on selection and dismisses on click**. A screenshot is one
frame, and every frame in the set was captured either before it appeared or
after it dismissed. Screenshot 12, the one that looked decisive, shows a live
selection in a choice with no toolbar; that reads as a refusal but is equally
consistent with a frame taken after dismissal. **Absence of a transient
control in a static frame is not evidence that the control does not exist.**
For any affordance that is transient — popups, hover states, drag handles,
toasts — the screenshots can confirm presence but never absence. Confirm
absence by driving the real app.

Implemented accordingly. Highlightable in Reading and Writing:
- the passage,
- the question stem,
- the text of a **single** answer choice.

Not highlightable: a selection spanning two choices, a selection straddling
stem and choice, and the header band (Mark for Review / ABC). Math stays
annotation-free — unchanged and separately established.

Behaviours confirmed live and matched here: a drag inside a choice also
selects that choice as the answer, so the click-after-drag is correct and
carries **no** suppression guard; and clicking a crossed-out choice un-crosses
it (we previously did nothing on that click — now fixed). Composed, dragging
inside a crossed-out choice highlights the text and un-crosses the choice.
A highlight inside a crossed-out choice restores full ink inside the
highlight: the choice greys its text to #999, which over a pastel fill falls
to ~2.3:1, while the strikethrough still carries the crossed-out meaning.

Scope boundary kept deliberately: **notes stay passage-only.** The notes rail
is keyed per passage question and only renders when the question has one, and
deleteNote resolves its span inside #passageText, so a note on a stem or
choice highlight could never be shown or deleted. The note button is withheld
on those selections; highlighting there is otherwise complete. Extending notes
is a separate piece of work.

### The interaction ordering this exposed (2026-08-08, second pass)

Widening the highlightable region collided with how the choice list is
repainted, and the collision is worth recording because it is invisible in any
static comparison.

A real drag inside a choice emits `mousedown → mousemove → mouseup → click`.
Our selection handler ran on a `setTimeout(0)` after `mouseup`, so the `click`
landed first, and picking an answer rebuilt the whole question pane via
`innerHTML`. Replacing the markup **collapses the live selection**, so the
deferred handler found nothing and refused. The net effect was the worst
possible one: a student trying to highlight a choice silently changed their
recorded answer and got no highlight. Real Bluebook does not have this problem
because selecting an answer there does not rebuild the text the selection
lives in.

Two rules taken from it:
1. **An answer pick only changes which choice carries `.selected`.** It now
   updates that class in place. Un-crossing does the same, since it is
   reachable by dragging inside a crossed-out choice. Crossing *out* keeps the
   full rebuild — it is reached from the ABC button, never from a drag.
2. **In highlight mode the span is created synchronously on `mouseup`**, before
   the click can reach anything, so the markup is already in `moduleState` and
   survives any later rebuild.
3. **A gesture that became a highlight is spent.** Creating the span calls
   `removeAllRanges()`, which is exactly what the click-to-edit handlers used as
   their "a selection is live, stand down" signal — so the drag's trailing click
   started reading as a request to EDIT whichever highlight sat under the
   pointer. Dragging inside an existing highlight would then open the popup on
   the enclosing span, and the next swatch recoloured the whole thing, or the
   trash unwrapped it and took its note with it. A flag set when the highlight
   is created, and cleared on the next `mousedown` (capture phase), scopes the
   suppression to that one gesture — no timers, and a drag that ends without a
   click cannot leave it stuck on.

`tests/drag-harness.js` holds these as runnable cases. It is validated the only
way a check like this can be: it fails on `4e55c36` for the choice-highlight
case and on `80b051e` for the nested-drag case, and passes only on the build
that fixes both.

Verification note, since this is exactly what the first pass got wrong:
dispatching `mouseup` alone reproduces neither the bug nor the fix. The `click`
is the whole mechanism. A drag harness must emit the full sequence **and
resolve each event's target at dispatch time** — resolving it up front hands
the click a node the new highlight span has since detached, which silently
swallows the answer-selection half and looks like a regression that isn't one.

## Fraction size: prose matches, choices over-shoot by ~13% (2026-08-09)

`d814cb0` promoted fractions in answer choices to `\displaystyle`, taking the
numerator from 13.23px to 18.9px inside a 17.5px choice. That number was
measured, but only against ourselves — no reference capture was consulted,
because none showed a fraction in a choice. Measured now against
`reference/bluebook-screenshots/35.png`, the SPR directions panel, which
contains a fraction in **two different contexts**.

The comparable quantity is scale-free: the height of a fraction's numerator
digit divided by the height of a full-size digit **in the same context**.

| context | Bluebook (35.png) | ours | verdict |
|---|---|---|---|
| inline in prose | 11px / 16px = **0.688** | text style, 13.23/18.9 = **0.700** | **match** (1.7% apart) |
| standalone value | 11.5px / 13px = **0.885** | choice, displaystyle, 18.9/18.9 = **1.000** | **over-shoot, ~13%** |

**Bluebook uses different proportions by context.** Its inline prose fraction
is set noticeably smaller than its standalone one — 0.688 against 0.885 — which
is the thing `d814cb0` intuited without evidence. **The direction of that split
is vindicated: prose and choices should NOT share a fraction size.** Only the
magnitude is wrong. We went to 1.000 where the reference sits at 0.885, so a
choice fraction reads about 13% larger than Bluebook's.

**Caveat, and it is a real one.** 0.885 is measured from a **table cell** in the
Examples table, not from an answer choice. **No capture in the reference set
contains a choice-level fraction** — 42.png is Reading and Writing (prose
choices), 35.png is an SPR question (no choices at all), and a fraction-bar scan
of all 37 captures returns only two right-pane candidates, both false positives
(12.png's Assistive Technology icon, 42.png's dashed rule under Mark for
Review). So "standalone value" is the nearest available proxy for "answer
choice", and the 13% figure rests on that proxy. **Settling it properly needs a
new capture: a Math multiple-choice question with a fraction in its choices.**
Until then this is evidence of an over-shoot, not proof of its exact size, and
no change has been made on the strength of it.

**A wrong number was published here first — do not re-derive it.** The initial
figure for the prose case was 0.846, and it was wrong: it divided the prose
fraction's numerator (11px) by the **Examples table's** plain digit (13px). Those
are two different contexts at two different text sizes — the prose digit is
16px, the table's is 13px. Comparing a fraction in one context against a
reference digit from another inflates the ratio and made prose look like an
under-shoot when it matches. **Always take the full-size reference digit from
the same line as the fraction being measured**; in 35.png that is the whole
number "3" of the mixed number "3 1/2", which sits immediately before it.

### Table cells: the third context, and the one measured against a like-for-like reference (2026-08-09)

Prose and choices had been measured; table cells had not, and they turned out to
be wrong in **two** directions at once.

A fraction in a `{{table}}` cell went through the inline path at **0.704** of the
cell's own text — a 20% under-shoot against ref 35's **0.885**. And because
`fmtRenderTable` passed the caller's `opts` straight into cell rendering, a cell
inherited `bigInline` from whatever field the table sat in: the *same table*
rendered its fractions at 0.704 inside a passage and **1.005** inside an answer
choice. Both live: `202603asiav1` `ma1-q13/passage` and `ma2-q3/c1`,`c2`.

Fixed in two places. `render.js` pins a cell's math style at the cell boundary —
a cell is its own context and does not inherit from its enclosing field.
`styles.css` carries the measured number, `.fmt-table .mfrac{font-size:0.88em}`.
Measured after: both contexts **0.884**, against a target of 0.885.

This is the one context with a genuine like-for-like reference. Our plain digit
in a table cell inks at 13px and ref 35's does too, so the numerator heights
compare head-on — **ours 9px before, Bluebook's 11.5px** — with no scaling
assumption in between. Contrast the choice case, where the nearest reference is
this same table cell standing in for an answer choice.

**CONFIDENCE — read this before treating 0.88em as exact.** 0.885 is **one
fraction**, the `2/3` in ref 35's Examples table, measured at ±0.5px on an
11.5/13 ink ratio. That puts the defensible band at roughly **0.85–0.92**, and
every value from 0.86em to 0.90em lands inside it (measured: 0.864, 0.884,
0.905). **0.88em is the midpoint of that band, not a precise target.** One
sample is thin for a number that now shapes two files.

**So the next reference screenshot has a job:** a capture containing a
table-cell fraction — ideally a second, independent one — would firm this up or
move it. Until then, do not tighten this number on reasoning alone; it needs
another measurement, not another argument.

Side effects, measured across all 52 math occurrences in table cells in the
seven shipped tests. Only **25 distinct expressions** appear there and the only
style-sensitive constructs among them are the 3 fractions — no `\sum`, `\int`,
`\lim` or `\binom` — so pinning to display style changes glyph rendering for
those 3 and nothing else. Ten further fields shift by 2px of header-row height
(33 → 35) purely from KaTeX's taller display-mode strut, with identical font
sizes; three tables also widen by 1–6px. Prose (13.23px, 0.700) and choices
(18.9px, 1.000) are untouched — neither is inside `.fmt-table`.

**Open alternative worth a decision.** Pinning cells to TEXT style instead would
reach the same 0.885 with `1.26em`, and would disturb less: the nine
passage-side tables would not move at all, and the only fields changing would be
the choice-embedded ones — which would then render identically to the same table
in a passage. It is also the better pin for content this library does not yet
contain: a `\sum` or `\lim` in a cell renders compactly in text style and tall
in display style, and a table cell is a place where tall is wrong. Display style
was chosen here on the reasoning that a cell holds a standalone value like a
choice does; with the size now set explicitly by CSS in either case, that
reasoning no longer carries much weight. Switching is a two-character change in
`render.js` plus the CSS number.

### The stem-versus-choice fraction contrast, and what closing it would cost (2026-08-15)

"Stems look small" has now been reported several times. It is worth stating
plainly that **the stem is not the end that is wrong**, so the next report can be
answered without re-measuring.

A fraction in inline prose — including inside function notation, which is how it
usually reaches a stem — renders at **0.700** of the surrounding math. That is
the value BLUEBOOK-PARITY already records as MATCHING: Bluebook's inline prose
fraction measures 0.688. Verified across every instance in the library: all
**15** inline-prose fractions in function notation sit at exactly 0.700, no
outliers (`f(x) = \frac{1}{8x}`, `f(x) = \frac{1}{2}(x + 11)`,
`y=\left(\frac{1}{6}\right)^x+1`, and so on).

The same construct renders at **1.000** in an answer choice and **1.000** in a
`{{mm}}` lead-in. So a student reads a 0.700 fraction in the stem directly above
a 1.000 fraction in the answers, and the stem looks shrunken by comparison. The
contrast is real; the diagnosis "the stem is too small" is not.

| context | ours | Bluebook | |
|---|---|---|---|
| inline prose (stems) | **0.700** | 0.688 | matches |
| answer choice | **1.000** | 0.885 (table-cell proxy) | **over-shoot ~13%** |
| table cell | 0.884 | 0.885 | matches (set 2026-08-09) |

**Closing the contrast means bringing CHOICES down, not stems up.** Moving
choices to 0.885 would both correct the recorded over-shoot and shrink the gap
against stems from 0.300 to 0.185.

Measured cost of doing that, across every choice in the library that contains a
fraction — **167 of them** — with `.ctext .mfrac{ font-size:0.885em }` layered
over the existing display-style promotion:

- **153 of 167 fractions shrink**, mean rendered height 20.9px → 18.0px (~14%).
- **Zero choice rows change height.** All 167 deltas are 0px.
- **Zero reflow, zero clipping, zero overflow**, before or after. The `.katex`
  line box stays 21px and `.ctext` height is unchanged, because the row is sized
  by the choice's line box rather than by the fraction, which has headroom.

So the layout cost is nil; the change is purely typographic. It has NOT been
applied — the 0.885 target still rests on a single table-cell fraction in
reference 35 standing in for an answer choice, and the same caveat recorded
there applies here with one more step of inference. A reference capture of a
Math multiple-choice question with a fraction in its choices would settle both
at once, and remains the most valuable single screenshot to add.
