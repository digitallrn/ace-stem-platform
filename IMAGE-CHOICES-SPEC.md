# Image answer choices — the contract (PROPOSED 2026-10-06, not built)

*Status: a design for David's review. Nothing in the app, the test data or
the converter implements it. The renderer side is built once the shape is
agreed; the test-bank converter emits the shape later. Three independent
designs were drawn up and judged against the code (a minimal-change one, a
self-describing one, an escaping-contract-first one); this is the winner with
the best of the other two grafted in, and the judges' line-number checks
applied.*

## Why

Three live forms hold an item out because its four answer choices are graph
IMAGES the renderer cannot show (the test-bank repo's "Platform-feature queue
#1"): **202406intv1 m2-q1**, **202510usv1 m2-q1**, **202609asiav1 m2-q4**.
All Math multiple-choice, keyed by letter. Each hold leaves a module one
short, and a short module caps the form's best scaled score (the held-items
measurement of 2026-10-06). The converter already rebuilds image choices that
are really tables as `{{table}}` (202609usv1 m2-q7) and authors image stems
from renders; this contract is only for a choice that IS a picture.

## 1. Shape — an object entry inside `choices`

`choices` stays an array of exactly four. Each element is EITHER a string
(today's shape, `{{tokens}}` intact, rendered by `fmt()`) OR an object:

```json
{
  "id": "m2-q4",
  "type": "mcq",
  "passage": null,
  "questionText": "Which of the following graphs in the {{m}}xy{{/m}}-plane could represent …?",
  "choices": [
    { "image": "data:image/png;base64,iVBORw0KGgo…" },
    { "image": "data:image/png;base64,iVBORw0KGgo…" },
    { "image": "data:image/png;base64,iVBORw0KGgo…" },
    { "image": "data:image/png;base64,iVBORw0KGgo…" }
  ],
  "correctAnswer": 3,
  "difficulty": null, "skill": "Linear inequalities in one or two variables", "tags": []
}
```

- The two kinds are told apart **structurally** (`typeof c === "string"` vs
  an object with a string `image`), never by sniffing a string's prefix.
- `image` is a data URI matching exactly
  `^data:image\/(png|jpeg|svg\+xml);base64,[A-Za-z0-9+/]+=*$` — the
  encoder's existing output (all 258 shipped `figure`s already match; 149
  png, 12 jpeg, 34 svg+xml in forms). No `http(s):`, `blob:`, `charset`,
  whitespace or percent-encoding. (gif/webp are left out: nothing shipped
  uses them; add when needed.)
- `alt` is **reserved, optional**: a plain string the renderer uses as the
  image's alt text if present; the converter emits none in v1 (the app
  generates "Choice B (image)"). Decision 7.2 below.
- `correctAnswer` is still an index 0–3. `figure`/`figureCaption` are
  independent: a stem figure and image choices can coexist.
- v1 is **all-or-nothing per item** at the converter; the renderer handles
  a mixed item per choice anyway.
- An element that is neither a string nor a valid image object (null, a
  number, an array, `{}`, `{image: 5}`, a bad grammar) renders a visible
  "Image unavailable" placeholder for that choice — never a throw, never a
  blank box. The converter never emits one.
- Bank items (SCHEMA-BANKS-v1 §3) take the same grammar; they reach the same
  renderer through `buildSetTestFromRecord`.

**TSV lane (converter's side, grafted from the minimal design):** the image
rides in four NEW columns `choice_a_img … choice_d_img`, not in
`choice_a..d`. Those columns sit outside `TEXT_FIELDS` and outside every
prose gate's `FIELDS` tuple (katex_strict, token_convention, math_marking,
question_choice_overlap), so none of them ever scans base64 as prose; the
converter alone maps column → object. The current `[IMAGE]` placeholder /
`IMAGE_CHOICE_ROWS` build-script convention is replaced by filling the
column.

**Why an object, not a parallel array or a token.** A `{{img}}` token would
make `fmt()` emit `<img>`, voiding the stated reason IMG is in
`DROP_ELEMENTS` (app.js:143-146) and forcing the sanitizer to admit the one
element it most wants out of saved markup. A parallel `choiceImages` array
with `""` in `choices` breaks both four-non-empty-choices gates, leaves an
empty `.ctext` as an annotatable region, makes every per-choice branch read
two arrays, and FAILS SILENTLY on an old client (four blank tiles). The
object fails LOUDLY in any unaware consumer (`[object Object]` through
`fmt`, a TypeError in dedup) — this codebase's stated preference — is already
skipped by every existing `typeof v === "string"` guard
(tests/keep-classes.test.js:105, tests/injection-proof.js:631), and cannot
be confused with prose.

## 2. Sanitizer — unchanged, by construction

Nothing changes in `sanitizeOnce` / `sanitizeSavedHtml` / `DROP_ELEMENTS` /
`DROP_ATTRS` / `KEEP_CLASSES` / `STYLE_*` / `restoreAnnotations`
(app.js:178-347, 359-412). Three invariants, each checked against the code:

1. **`fmt()` still emits no `<img>`.** render.js is untouched; an image
   choice never reaches `fmt()` because the renderer branches on the
   choice's TYPE before calling it.
2. **An `<img>` still cannot enter saved annotation HTML.** `saveAnnotation`
   stores `host.el.innerHTML` (app.js:4242-4247) and a choice's host is
   `closest(".ctext")` (:4225-4229). An image choice renders NO `.ctext`:
   its `<img>` lives in a sibling `<span class="cimg">` that
   `annotationHost` cannot resolve, so the selection is refused exactly like
   a cross-choice selection (:4062-4063) and nothing can serialise the image
   into `choiceHtml`. The DROP_ELEMENTS comment gains one clause saying so.
3. **A crafted record cannot replace or blank an image choice through
   `choiceHtml`.** Today the replay at app.js:2952-2954 substitutes a saved
   blob for `fmt(c)`. For an image choice the kind is decided from TEST
   DATA first and the slot is simply never read — there is no render site
   for the planted blob, so there is nothing to sanitize.
4. **The source** is test-data-derived, never record-derived (set records
   hold refs; every question resolves from a loaded file by qid). It goes
   through `escapeHtml()` into `src` as `q.figure` does at app.js:2777 — and
   STRICTER: `choiceImageSrc(c)` returns the string only if it matches the
   grammar above, else null → placeholder, no `<img>`. A `data:` URI cannot
   make a network request, so whatever path content arrives by (the
   single-file build, a bank file, the device-writable localStorage test
   cache `acestem:testcache:*` that the loader restores BEFORE the network)
   an image choice can never beacon or leak an IP. SVG is in the grammar
   only because the render path is `<img>` (no script, no external fetch);
   the helper's name and comment stay tied to `<img>`.
5. `alt` is app-generated unless the reserved field is present; the new
   classes (`choice-img`, `cimg`, `choice-image`, `cimg-expand`,
   `cimg-missing`) are NOT added to `KEEP_CLASSES` and none is a hook
   `annotationHost` resolves on.

Optional companion hardening, its own reviewed commit, not this contract:
Math is annotation-free on every creation path (app.js:4055, :4109, :4133)
but every replay site honours planted blobs on a Math module; skipping
`passageHtml/stemHtml/choiceHtml` when `mod.section === "Math"` closes the
same crafted-record exposure for TEXT choices.

## 3. Renderer

One pure function (the unit-test seam), factored out of `buildQuestionHtml`:

```js
const CHOICE_IMAGE_RE = /^data:image\/(png|jpeg|svg\+xml);base64,[A-Za-z0-9+\/]+=*$/;
function isImageChoice(c){ return !!c && typeof c === "object" && !Array.isArray(c); }
function choiceImageSrc(c){
  return (isImageChoice(c) && typeof c.image === "string" && CHOICE_IMAGE_RE.test(c.image)) ? c.image : null;
}
function choiceBodyHtml(c, idx, savedC){
  const letter = String.fromCharCode(65 + idx);
  if(typeof c !== "string"){
    const src = choiceImageSrc(c);
    const alt = (isImageChoice(c) && typeof c.alt === "string" && c.alt.trim()) ? c.alt.trim() : "Choice " + letter + " (image)";
    return src
      ? `<span class="cimg"><img class="choice-image" src="${escapeHtml(src)}" alt="${escapeHtml(alt)}" draggable="false"><button type="button" class="cimg-expand" data-expand="${idx}" title="Expand" aria-label="Expand choice ${letter} image">⛶</button></span>`
      : `<span class="cimg cimg-missing" role="img" aria-label="Choice ${letter} image unavailable">Image unavailable</span>`;
  }
  const inner = (savedC !== undefined && savedC !== null) ? sanitizeSavedHtml(savedC) : fmt(c, {bigInline:true});
  return `<span class="ctext">${inner}</span>`;
}
```

- `.choice` gets a `choice-img` class; the `clabel`, the review marks and
  the row's `elim-btn` / `elim-undo` are unchanged. No `id="figImg"` and no
  `.fig-imgwrap` on a choice image — those are the stem figure's singletons.
- CSS (after `.choice.eliminated .hl`, styles.css:542):
  `.choice .cimg{flex:0 1 auto;min-width:0;position:relative;display:inline-flex}`,
  `.choice .cimg img{display:block;width:auto;max-width:min(100%,320px);max-height:220px;-webkit-user-drag:none;user-select:none}`,
  `.choice.eliminated .cimg img{opacity:.35}` (the edge-to-edge strike at
  :533 still runs across it), a small hover-revealed `.cimg-expand`, and a
  `.cimg-missing` dashed placeholder. One choice per row, stacked. The
  320×220 cap is a judgement (decision 7.1).
- **Click to select**: unchanged — the handler is on `.choice`
  (app.js:3126-3150) and the click bubbles from the image;
  `draggable="false"` keeps a native image drag from eating the mousedown.
  Un-cross by clicking a crossed-out choice (:3138) unchanged.
- **Cross out**: unchanged — buttons sit outside `.choice`; `toggleEliminate`
  keys on the index.
- **Expand**: reuse `#figOverlay` (already wired, already hidden on every
  transition). `attachChoiceImageHandlers(q)` is called right after
  `attachFigureHandlers(q)` (:3073), BEFORE the review early-return (:3080),
  with `stopPropagation` so expanding never selects. No per-choice zoom
  toolbar (its ids are the stem figure's singletons).
- **Single-file build**: `assemble.py` inlines the test file verbatim; data
  URIs already ship for figures (≈300 KB per image item).

## 4. Review Mode, the printed report, the dashboard, grading

- **Review Mode**: the same body inside the same `.choice rv …` div with
  `rv-key` / `rv-wrong` borders and the ✓/✕ `.rv-mark` to the right of the
  image; a crossed-out image keeps its strike and fade (the student's
  work); the expand button works read-only; nothing mutates, and a hostile
  record's `choiceHtml` for the item has no render site.
- **Printed report**: unchanged and correct as-is — `window.print()` of
  Score Details, whose Questions Overview prints LETTERS from the stored
  index (`answerLetter` / `correctLabel`, app.js:4543-4550), which is what
  College Board's own report prints for every MCQ.
- **Dashboard**: letters everywhere (`givenLabel`; the `wrongLbl` block in
  `viewItems`; the `correctLbl` / `givenLabel` lines of the attempt detail
  pane); it renders no choice content.
- **Grading**: untouched. `answerMatches` for `mcq` is index equality;
  records store `given: idx`; nothing on the scoring path reads choice
  content — which is also why the renderer can ship first and the converter
  later without any record changing.

## 5. What the converter must guarantee (SCHEMA-v1.2 §5 style)

8. An image choice is `{"image": s}` with `s` matching the grammar in §1
   exactly; optional `alt` is a plain string ≤200 chars with no tokens and
   no key-leaking words (correct/answer/key).
9. The base64 decodes and the bytes' magic matches the subtype (PNG
   `\x89PNG`, JPEG `\xFF\xD8`; svg+xml parses with root `<svg>`, no
   `<script`, no `on*=`, no `<foreignObject`, no external href) —
   bank_gate.py already decodes figure headers this way.
10. Decoded width and height ≤ 600 px (2× the 320×220 display cap), through
    `figure_util.encode_figure(max_width=600)`.
11. Size: each image ≤ 96 KB as a URI, the four together ≤ 320 KB — measured
    against the first exported form's file and its test-cache footprint
    before being set in stone.
12. Rule 3 "MCQ ⇒ all 4 choices present" becomes: all four are non-empty
    strings, OR all four are valid image objects; a mixed item fails the row
    (`mixed text/image choices`). Both counting gates — the converter's
    four-choice gate and `bank_lib.mcq_answerability_problems` — and
    `is_mcq_row` / `bank_row_to_question` count an image column as present.
13. Prose gates never see an image: the image lives in `choice_*_img`, which
    no `FIELDS` tuple lists.
14. The key is still a letter A–D selecting an index; nothing about the
    bytes participates in keying.
15. An item is never held FOR being an image item once the shape exists; a
    row with fewer than four decodable images still fails rule 12 (this
    keeps 202406intv1 m2-q1 held — its choice C is absent from the source).
16. Dedup: `norm_choice` maps an image choice to an opaque token
    `[image:<sha256 of the DECODED bytes, 16 hex>]` so `choice_key` stays a
    tuple of strings; never compare base64 text.
17. Export stays byte-deterministic (`json.dumps` serialises the one-key
    object in insertion order).
18. The exporter REFUSES to emit a form or bank containing an image object
    unless the platform checkout's app.js carries `choiceImageSrc` — the
    cross-repo posture bank_lib.py already takes by running the platform's
    grading.js. "App first, then export" becomes a check.
19. The platform invariant the converter must not break: `choices` remains
    an ARRAY of length 4 and `type` stays `"mcq"`.

## 6. Consumers (platform repo)

| Where | Change |
|---|---|
| app.js:2945-2983 `buildQuestionHtml` | branch per choice via `choiceBodyHtml`; add `choice-img`; the `choiceHtml` lookup stays but is ignored for a non-string |
| app.js:3069-3080 `attachQuestionHandlers` | call `attachChoiceImageHandlers(q)` after `attachFigureHandlers(q)`, before the review return |
| app.js:3126-3150 choice click | no change (bubbling) |
| app.js:4217-4232 `annotationHost` | NO change; pinned by a test |
| app.js:143-146 DROP_ELEMENTS comment | one clause |
| styles.css:506-560 | the `.cimg` rules above |
| index.html `#figOverlay` | reused as-is |
| render.js, grading.js, attempts.js, dashboard.js, assemble.py, build-site.js, archive-testdata.js | NO change |
| tests/keep-classes.test.js:103-117 | make the non-string skip explicit (`filter(c => !isImageChoice(c))` with a counter) and check every image choice in forms and banks against `CHOICE_IMAGE_RE` extracted from app.js — with a PLANTED-FIXTURE control (a good synthetic item passes; a length-3 array, a `javascript:` src, an SPR carrying images each fail) so the gate is not vacuously green before the first export |
| tests/injection-proof.js:629-633 | explicit skip; new surfaces (§7 tests) |
| tests/set-flow.test.js | one bank fixture with image choices through `buildSetTestFromRecord` |
| SCHEMA-v1.2.md §3/§5 (both copies), CLAUDE.md escaping contract | the shape and rules; one line: image choices render from test data only, never from a record, never inside `.ctext` |

Test-bank side: `tsv_to_bluebook_json.py` (`TEXT_FIELDS`, `is_mcq_row`, the
four-choice gate, `row_to_question`, `bank_row_to_question`), `bank_lib.py`
answerability, `dedup_gate.py` (`norm_choice`, `choice_key`, the JSON
readers — today a dict CRASHES `norm_text` and would block
`dedup-index.js` regeneration, hence the next export of ANY form, until rule
16 lands), the three build scripts' HELD/IMAGE_CHOICE_ROWS/`[IMAGE]` sites,
`export_to_platform.py` (rule 18), STATUS.md queue #1.

## 7. Tests (platform)

- NEW `tests/image-choice.test.js` (node, extract-helper): pins the string
  path byte-for-byte (today's behaviour, with and without `savedC`), the
  image path (`.cimg` + img with the EXACT src, no `.ctext`, output
  IDENTICAL for `savedC` undefined vs HOSTILE_HTML), the grammar (accepts
  the three subtypes; rejects http(s), javascript:, data:text/html, charset,
  whitespace, `<` in the payload, empty payload) and the placeholder for
  every malformed entry. Mutants that must fail it: drop the
  `typeof c.image === "string"` check; loosen the regex to `^data:`; read
  `savedC` before the type branch; put the img inside `.ctext`.
- `tests/injection-proof.js`: the library has no image item until the
  converter ships, so the proof SYNTHESISES one in memory (clone a loaded
  Math MCQ with four 1×1 PNG data URIs; no testdata change) and pins (a) a
  planted `choiceHtml` leaves the `<img>` and renders nothing of the
  payload, (b) exactly one IMG, `data:image/` src, no handlers, (c)
  `annotationHost(img)` is null (export it on `window.AppSanitize` so the
  proof exercises THE function), (d) `https:`/`javascript:`/
  `data:text/html`/scripted-SVG sources render the placeholder and
  `performance.getEntriesByType("resource")` shows no request, (e) the
  synthetic item is COUNTED among the surfaces so a refactor that skips it
  fails loudly.
- Manual against `dist/index-live.html` with the synthetic item planted:
  select, cross out, Undo, un-cross, expand without selecting, Review marks,
  print preview letters only, the 860 px breakpoint.
- Regression: `node --check app.js`; local-mode, tutor-writes,
  keep-classes, spr-grading, set-flow green; `archive-testdata.js --verify`
  clean (no testdata changed). Per CLAUDE.md this touches a render surface:
  adversarial review of the diff and the injection proof against dist before
  any push.

## 8. Risks and scope, stated

- **The renderer unblocks ONE item cleanly: 202609asiav1 m2-q4** (key D,
  both sealed passes). **202510usv1 m2-q1**'s key is ruled AMBIGUOUS (B for
  the printed stem `y > −36`; C if the print dropped an `x` — its RULINGS
  defer to "the session that enables image choices") and needs David's
  ruling first. **202406intv1 m2-q1 stays held regardless**: choice C is
  absent from the source (the capture prints 图片缺失). Also:
  `build_202406intv1.py` lists FOUR image-choice sets (m1-q12, m1-q17,
  m1-q20, m2-q1) with only m2-q1 held — David to confirm how the other three
  ship today and whether any should become image choices.
- **Versioning**: un-holding is a content change on a live form — testVersion
  bump + `node archive-testdata.js`; manifest counts change (202609asiav1
  95→96, Math M2 raw max 21→22); attempts on the old build stay pinned, so
  scores across builds of one form are not like-for-like. Interacts with
  batch item 5 (202510usv1's cap would lift; 202609asiav1's stays at 1560
  because rw1-q5 and rw1-q14 remain held).
- **Layout unverified**: none of the 40 reference captures shows graph
  choices. Stacked single column and the 320×220 cap are judgements; a 2×2
  grid is one CSS rule held ready. A capture is needed before the CSS is
  final.
- `dist/index-live.html` is already 22 MB (above the 16 MB artifact
  ceiling); image items add ≈300 KB each — a pre-existing problem made
  slightly worse.
- Mixed items forbidden in v1 (renderer tolerates them); relax rule 12
  later if a "graph plus equation" item appears.
- Accessibility stays weak: choices are divs with click handlers and the
  default alt is neutral.

## 9. Decisions for David

1. **Layout and size**: stacked column at 320×220 (proposed), or a 2×2 grid,
   or a taller cap. A Bluebook capture of a graph-choice item would settle it.
2. **Alt text**: app-generated "Choice B (image)" (proposed; no key leakage,
   no new data field) vs authored descriptions through optional
   `choice_*_alt` columns into the reserved `alt` (better for a screen-reader
   user; a description either leaks the discriminating feature or says
   nothing).
3. **Expand control**: hover-revealed ⛶ inside the tile reusing `#figOverlay`
   (proposed), a permanent button in the row, or none (Bluebook has none).
4. **Grammar**: png + jpeg + svg+xml (proposed) or png + jpeg only; and
   whether `q.figure` (app.js:2777, :3924) should be routed through the same
   `data:`-only guard as a follow-up (all 258 shipped figures already pass).
5. **Which items ship first**: proceed with 202609asiav1 m2-q4 alone, rule
   202510usv1 m2-q1's key now, confirm 202406intv1 m2-q1 stays held.
6. **Sequencing with item 5**: un-hold now (caps move per form) or wait for
   the pro-rating decision.
7. Whether the Math-wide annotation-replay skip (§2, optional) is scheduled
   as its own reviewed commit.
