# Image answer choices — the contract (ruled 2026-10-07; renderer built)

*Status: David ruled on every open decision on 2026-10-07 (§9) and the
renderer side is built in app.js / styles.css with its tests. The test-bank
converter does NOT emit the shape yet: §5 is the exact contract it must meet,
and the un-hold bumps are test-bank work that waits on the scoring decision
(§9.6). Three independent designs were drawn up and judged against the code;
this is the winner with the best of the other two grafted in.*

## Why

Three live forms hold an item out because its four answer choices are graph
IMAGES the renderer could not show (the test-bank repo's "Platform-feature
queue #1"): **202406intv1 m2-q1**, **202510usv1 m2-q1**, **202609asiav1 m2-q4**.
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
  whitespace or percent-encoding. gif/webp are out: nothing shipped uses them.
- `alt` is **reserved, optional**: a plain string the renderer uses as the
  image's alt text when present and non-blank; the converter emits none
  (ruling 9.2) and the app labels the image "Choice B (image)".
- `correctAnswer` is still an index 0–3. `figure`/`figureCaption` are
  independent: a stem figure and image choices can coexist.
- v1 is **all-or-nothing per item** at the converter; the renderer handles
  a mixed item per choice anyway.
- An element that is neither a string nor a valid image object (null, a
  number, an array, `{}`, `{image: 5}`, a bad grammar) renders a visible
  "Image unavailable" placeholder for that choice — never a throw, never a
  blank box. The converter never emits one.
- Bank items (SCHEMA-BANKS-v1 §3) take the same grammar; they reach the same
  renderer through `buildSetTestFromRecord` with the objects intact
  (pinned in tests/set-flow.test.js §6).

**TSV lane (converter's side):** the image rides in four NEW columns
`choice_a_img … choice_d_img`, not in `choice_a..d`. Those columns sit outside
`TEXT_FIELDS` and outside every prose gate's `FIELDS` tuple (katex_strict,
token_convention, math_marking, question_choice_overlap), so none of them ever
scans base64 as prose; the converter alone maps column → object. The current
`[IMAGE]` placeholder / `IMAGE_CHOICE_ROWS` build-script convention is
replaced by filling the column.

**Why an object, not a parallel array or a token.** A `{{img}}` token would
make `fmt()` emit `<img>`, voiding the stated reason IMG is in
`DROP_ELEMENTS` (app.js, the sanitizer's comment) and forcing the sanitizer to
admit the one element it most wants out of saved markup. A parallel
`choiceImages` array with `""` in `choices` breaks both four-non-empty-choices
gates, leaves an empty `.ctext` as an annotatable region, makes every
per-choice branch read two arrays, and FAILS SILENTLY on an old client (four
blank tiles). The object fails LOUDLY in any unaware consumer
(`[object Object]` through `fmt`, a TypeError in dedup) — this codebase's
stated preference — is already skipped by every existing
`typeof v === "string"` guard, and cannot be confused with prose.

## 2. Sanitizer — unchanged, by construction

Nothing changes in `sanitizeOnce` / `sanitizeSavedHtml` / `DROP_ELEMENTS` /
`DROP_ATTRS` / `KEEP_CLASSES` / `STYLE_*` / `restoreAnnotations`. Four
invariants, each pinned by a test:

1. **`fmt()` still emits no `<img>`.** render.js is untouched; an image
   choice never reaches `fmt()` because `choiceBodyHtml` branches on the
   choice's TYPE before calling it (image-choice.test.js §5 greps render.js
   for `img`).
2. **An `<img>` still cannot enter saved annotation HTML.** `saveAnnotation`
   stores `host.el.innerHTML` and a choice's host is `closest(".ctext")`. An
   image choice renders NO `.ctext`: its `<img>` lives in `<span class="cimg">`,
   which `annotationHost` cannot resolve, so the selection is refused like a
   cross-choice selection and nothing can serialise the image into
   `choiceHtml`. The sanitizer's IMG comment carries the clause;
   `annotationHost` is exposed read-only on `window.AppSanitize` so the proof
   asks the real function.
3. **A crafted record cannot replace or blank an image choice through
   `choiceHtml`.** The replay substitutes a saved blob for `fmt(c)` on a TEXT
   choice; for an image choice the kind is decided from TEST DATA first and
   the slot is simply never read — there is no render site for the blob, so
   there is nothing to sanitize (image-choice.test.js §2: the output is
   byte-identical with and without a hostile blob; the proof plants one in all
   four slots).
4. **The source** is test-data-derived, never record-derived. It goes through
   `escapeHtml()` into `src` as `q.figure` does — and STRICTER:
   `choiceImageSrc(c)` returns the string only if it matches the grammar,
   else null → placeholder, no `<img>`. A `data:` URI cannot make a network
   request, so whatever path content arrives by (the single-file build, a
   bank file, the device-writable localStorage test cache that the loader
   restores BEFORE the network) an image choice can never beacon or leak an
   IP. SVG is in the grammar only because the render path is `<img>` (no
   script, no external fetch); the helper's comment stays tied to `<img>`.
   Ruling 9.4: `q.figure` is routed through the same `data:`-only guard as a
   separate small commit, proving all 258 shipped figures still pass.

`alt` is app-generated unless the reserved field is present; the new classes
(`choice-img`, `cimg`, `choice-image`, `cimg-missing`) are NOT in
`KEEP_CLASSES` and none is a hook `annotationHost` resolves on.

Companion hardening, its own reviewed commit after the renderer lands (ruling
9.7): Math is annotation-free on every creation path but every replay site
honours planted blobs on a Math module; skipping
`passageHtml/stemHtml/choiceHtml` when `mod.section === "Math"` closes the
same crafted-record exposure for TEXT choices.

## 3. Renderer (built)

One pure function, the unit-test seam, factored out of `buildQuestionHtml`:

```js
const CHOICE_IMAGE_RE = /^data:image\/(png|jpeg|svg\+xml);base64,[A-Za-z0-9+\/]+=*$/;
function isImageChoice(c){ return !!c && typeof c === "object" && !Array.isArray(c); }
function choiceImageSrc(c){
  return (isImageChoice(c) && typeof c.image === "string" && CHOICE_IMAGE_RE.test(c.image)) ? c.image : null;
}
/* `saved` is the record's per-question map of highlighted-choice markup
   (ms.choiceHtml[q.id]) — record-derived, untrusted. It is handed in whole
   and indexed HERE, on the text path only, so the caller never holds a
   blob and an image choice's slot is never read at all. */
function choiceBodyHtml(c, idx, saved){
  const letter = String.fromCharCode(65 + idx);
  if(typeof c !== "string"){
    const src = choiceImageSrc(c);
    const alt = (isImageChoice(c) && typeof c.alt === "string" && c.alt.trim()) ? c.alt.trim() : "Choice " + letter + " (image)";
    return src
      ? `<span class="cimg"><img class="choice-image" src="${escapeHtml(src)}" alt="${escapeHtml(alt)}" draggable="false"></span>`
      : `<span class="cimg cimg-missing" role="img" aria-label="Choice ${letter} image unavailable">Image unavailable</span>`;
  }
  const savedC = (saved && typeof saved === "object") ? saved[idx] : undefined;
  /* only a non-empty STRING is a blob: an empty slot is "no blob", never a blanked choice */
  const inner = (typeof savedC === "string" && savedC !== "") ? sanitizeSavedHtml(savedC) : fmt(c, {bigInline:true});
  return `<span class="ctext">${inner}</span>`;
}
```

- `buildQuestionHtml` looks the per-question `choiceHtml` map up ONCE, by
  question id, and hands it whole to `choiceBodyHtml` for every choice; the
  branch itself never indexes the map or interpolates anything but the
  seam's `${body}` (pinned by an exact-set check on its interpolations). It
  adds `choice-img` to an image choice's `.choice`; the `clabel`, the review
  marks and the row's `elim-btn` / `elim-undo` are unchanged. No
  `id="figImg"` and no `.fig-imgwrap` on a choice image — those are the stem
  figure's singletons.
- CSS: `.choice .cimg{flex:0 1 auto;min-width:0;position:relative;display:inline-flex}`,
  `.choice .cimg img{display:block;width:auto;max-width:min(100%,320px);max-height:220px;-webkit-user-drag:none;user-select:none}`,
  `.choice.eliminated .cimg img{opacity:.35}` (the edge-to-edge strike still
  runs across it), `.cimg-missing` dashed placeholder. One choice per row,
  stacked (ruling 9.1, provisional until a real Bluebook capture); the 2×2
  grid is held ready as a commented `.choices:has(.choice-img)` rule beside
  them — literally CSS-only, keyed on the class the renderer already emits.
  The cap buys a predictable per-choice height and never-wider-than-the-
  column, not a no-scroll fit: four capped choices still scroll the pane.
- **Click to select**: unchanged — the handler is on `.choice` and the click
  bubbles from the image; `draggable="false"` keeps a native image drag from
  eating the mousedown. Un-cross by clicking a crossed-out choice unchanged.
- **Cross out**: unchanged — buttons sit outside `.choice`; `toggleEliminate`
  keys on the index.
- **No expand control** (ruling 9.3): add the hover ⛶ reusing `#figOverlay`
  only if the first live graphs prove hard to read.
- **Single-file build**: `assemble.py` inlines the test file verbatim; data
  URIs already ship for figures (≈300 KB per image item).

## 4. Review Mode, the printed report, the dashboard, grading

- **Review Mode**: the same body inside the same `.choice rv …` div with
  `rv-key` / `rv-wrong` borders and the ✓/✕ `.rv-mark` to the right of the
  image; a crossed-out image keeps its strike and fade; nothing mutates, and
  a hostile record's `choiceHtml` for the item has no render site (proof).
- **Printed report**: unchanged and correct as-is — `window.print()` of
  Score Details, whose Questions Overview prints LETTERS from the stored
  index (`answerLetter` / `correctLabel`), which is what College Board's own
  report prints for every MCQ.
- **Dashboard**: letters everywhere (`givenLabel`; the `wrongLbl` block in
  `viewItems`; the `correctLbl` / `givenLabel` lines of the attempt detail
  pane); it renders no choice content.
- **Grading**: untouched. `answerMatches` for `mcq` is index equality;
  records store `given: idx`; nothing on the scoring path reads choice
  content — which is also why the renderer ships first and the converter
  later without any record changing.

## 5. What the converter must emit and guarantee (the contract)

Also recorded as SCHEMA-v1.2.md §3 (shape) and §5 rule 8.

1. Source columns: `choice_a_img … choice_d_img` (new), one data URI each;
   `choice_a..d` text cells stay EMPTY for an image item. No prose gate
   (`TEXT_FIELDS`, katex_strict, token_convention, math_marking,
   question_choice_overlap) ever lists the `_img` columns.
2. Emit `{"image": s}` per choice, `s` matching EXACTLY
   `^data:image\/(png|jpeg|svg\+xml);base64,[A-Za-z0-9+/]+=*$` — no
   whitespace, no `charset`, no percent-encoding, no other scheme. Emit no
   other key (`alt` is reserved; emit it only when an authored description is
   ruled in).
3. The base64 decodes and the bytes' magic matches the subtype (PNG
   `\x89PNG`, JPEG `\xFF\xD8`; svg+xml parses as XML with root `<svg>`, no
   `<script`, no `on*=`, no `<foreignObject`, no external `href`/`xlink:href`).
   The precedent is `bank_gate._png_width`, which reads a PNG IHDR only; the
   JPEG SOF / SVG parse checks and the pass over the choice columns are to be
   written. (The renderer checks the grammar only: a grammar-valid payload
   that does not decode shows the browser's broken-image glyph beside the
   label, not the placeholder — decodability is the converter's gate.)
4. Longest side ≤ 600 px — checked as max(width, height) after decode (PIL
   size, or IHDR / SOF / svg viewBox), independent of `encode_figure`, which
   caps WIDTH only (≈2× the 320 px display width keeps a 2× DPR render
   sharp); grayscale unless colour carries meaning for that form, which the
   build records.
5. Size: each image ≤ 96 KB as a URI, the four together ≤ 320 KB — measured
   against the first exported form's file and its test-cache footprint before
   the numbers are set in stone.
6. Rule 3 ("MCQ ⇒ all 4 choices present") becomes: all four choices are
   non-empty strings, OR all four are valid image objects; a mixed item fails
   the row with reason `mixed text/image choices`. Every gate that counts
   choices learns the rule: the converter's four-choice gate,
   `bank_lib.mcq_answerability_problems`, `is_mcq_row` /
   `bank_row_to_question`, AND `bank_lib.validate_payload_shape` — the
   payload-level gate `load_bank` runs, today strings-only, which must change
   BEFORE the first image item is minted (a minted image ledger line is
   append-only, and every later `load_bank`, `bank_gate`, `export_bank` and
   mint would abort on it). `bank_gate.payload_texts` already skips
   non-strings and needs nothing.
6b. The stem figure takes the SAME grammar: `figure` is a data URI matching
   rule 2's regex (no URLs); the converter's rule 7 refuses what the renderer
   now refuses (`figureSrc`: a figure outside the grammar renders a "Figure
   unavailable" frame). Every shipped figure already matches.
7. The key is still a letter A–D selecting an index; nothing about the bytes
   participates in keying. `choices` remains an ARRAY of length 4; `type`
   stays `"mcq"`.
8. An item is never held FOR being an image item once the shape exists; a
   row with fewer than four decodable images still fails rule 6 (this keeps
   202406intv1 m2-q1 held — its choice C is absent from the source).
9. Dedup: `norm_choice` maps an image choice to the opaque token
   `[image:<sha256 of the DECODED bytes, 16 hex>]` so `choice_key` stays a
   tuple of strings; identical graph bytes across forms compare exact; never
   compare the base64 text (a re-encode changes it). Today a dict crashes
   `norm_text` and would block `dedup-index.js` regeneration — rule 9 lands
   before any image item is exported.
10. Export stays byte-deterministic (`json.dumps` serialises the one-key
    object in insertion order), so `--check` identity and
    `archive-testdata.js --verify` hold.
11. The exporter REFUSES to emit a form or bank containing an image object
    unless the platform checkout's app.js carries `choiceImageSrc` — the
    cross-repo posture `bank_lib.py` already takes by running the platform's
    grading.js. "App first, then export" becomes a check.
12. Un-holding is a content change on a live form: testVersion bump + `node
    archive-testdata.js`; manifest `questionCount`/`sections` change
    (202609asiav1 95→96, Math M2 raw max 21→22); attempts on the old build
    stay pinned.

## 6. Consumers (platform repo) — done

| Where | Change |
|---|---|
| app.js `choiceBodyHtml` + `buildQuestionHtml` choice branch | the seam above; `choice-img`; the per-question `choiceHtml` map is looked up once in the branch and handed whole to the seam, which indexes it only for a text choice |
| app.js `annotationHost` | NO change; exposed on `window.AppSanitize` for the proof |
| app.js DROP_ELEMENTS comment | one clause |
| styles.css after `.choice.eliminated .hl` | the `.cimg` rules; the 2×2 grid commented beside them |
| render.js, grading.js, attempts.js, dashboard.js, assemble.py, build-site.js, archive-testdata.js | NO change |
| tests/image-choice-fixture.js | NEW — the shared four-image item (four distinct 4×3 PNGs) |
| tests/image-choice.test.js | NEW — the seam, the grammar, the placeholder, the fixture, the proof's copy of it, and (0792fe7) the stem-figure guard with every shipped figure |
| tests/keep-classes.test.js | explicit image-choice audit over every form and bank against `CHOICE_IMAGE_RE`, with a planted-fixture control |
| tests/injection-proof.js | synthesises the item in memory, plants the blob in all four slots, asserts the surfaces in §7 |
| tests/set-flow.test.js §6 | a bank item with image choices resolves intact |
| tests/extract-helper.js | `extractConst` steps over a leading regex literal (the grammar carries `;base64`) |
| SCHEMA-v1.2.md §3/§5, CLAUDE.md escaping contract | the shape and the rule |

## 7. Tests

- `node tests/image-choice.test.js`: 60 checks — text path byte-for-byte
  (the saved map indexed only on the text path, only at this choice's slot;
  an empty or non-string slot is "no blob");
  image path with the exact source, no `.ctext`, identical output with a
  hostile blob in every slot, and a trapping Proxy proving the map is never
  even indexed; the reserved alt; the grammar (13 rejections); ten
  malformed entries → placeholder, no throw (including an array holding a
  valid URI, which only the typeof guard keeps out); the seam is the one
  render site and the branch's interpolations are pinned as an EXACT SET of
  its eleven literals (the tripwire for the branch; a prefix test would let
  a `${sel ? blob : ""}` through, and the proof's hostile slots can sit on
  an unselected choice — so the proof now also selects a hostile slot on
  the image item); render.js emits no `img`; the proof embeds the fixture
  verbatim; and (0792fe7) the stem-figure guard — `figureSrc` accepts a
  data URI and refuses the rest, `figureFrameHtml` renders the guarded
  source or the placeholder frame without toolbar, the handlers and the
  overlay use it, and every shipped figure passes unchanged: 585 across
  current builds (195), banks (63) and archived builds (327); ruling 9.4's
  "258" is the student-servable subset, current forms plus banks.
  Mutants that fail it (sixteen): the typeof guard dropped; the regex
  loosened to `^data:`; the saved slot read before the type branch; `<img>`
  inside `.ctext`; `draggable` dropped; alt unescaped; the branch rendering
  text choices itself; the branch interpolating a blob itself; the branch
  looking a slot up by index; a `sel`-gated blob before `${body}`; a
  comma-expression blob after it; the map's values appended to the body,
  unconditionally and `sel`-gated; a blob folded into `${letter}`; a slot
  re-wrapped as a one-entry map; an empty slot treated as a blob; and three
  that reach the markup by CONCATENATION through an alias declared above
  the branch (appended to the body, folded into the class attribute, folded
  into the review mark) — caught because the whole function may name the
  map and the record field exactly twice each.
- `node tests/keep-classes.test.js`: every image choice in every form and
  bank (Math included) matches the renderer's grammar inside a 4-entry MCQ,
  and no choices array anywhere holds a null, number or array entry; the
  control passes the fixture and fails nine planted defects.
- `tests/injection-proof.js` against `dist/index-live.html`: the synthetic
  item is counted among the surfaces; one `<img>` per choice with the EXACT
  fixture source and no `.ctext`; the hostile blob has no render site;
  review marks render; `annotationHost` (the real function) refuses the
  image and resolves a text choice (control); https / javascript: /
  data:text/html / whitespace sources render the placeholder with no `<img>`
  and no request to evil.example; a scripted SVG renders through `<img>`
  and executes nothing; five bad stem-figure sources render the "Figure
  unavailable" frame with review still entered, no `#figImg`, no toolbar and
  no request, and a grammar-valid figure renders with its toolbar.
- Regression: local-mode, tutor-writes, set-flow, tombstone, spr-grading
  green; `archive-testdata.js --verify` clean (no testdata changed).

## 8. Risks and scope, stated

- **The renderer unblocks ONE item cleanly today: 202609asiav1 m2-q4** (key
  D, both sealed passes). 202510usv1 m2-q1 ships once the test-bank carries
  ruling 9.5 (key B). 202406intv1 m2-q1 stays held (choice C absent).
  `build_202406intv1.py` lists FOUR image-choice sets (m1-q12, m1-q17,
  m1-q20, m2-q1) with only m2-q1 held — David to confirm how the other three
  ship today and whether any should become image choices.
- **Versioning**: see §5.12; interacts with the pro-rating decision (9.6).
- **Layout unverified**: none of the 40 reference captures shows graph
  choices; stacked column and the 320×220 cap are provisional (9.1).
- `dist/index-live.html` is already 22 MB (above the 16 MB artifact
  ceiling); image items add ≈300 KB each.
- Mixed items forbidden in v1 (renderer tolerates them); relax rule 5.6
  later if a "graph plus equation" item appears.
- Accessibility stays weak: choices are divs with click handlers and the
  default alt is neutral (9.2).
- **Undecodable payload**: the renderer checks the grammar only; a
  grammar-valid payload that does not decode shows the browser's
  broken-image glyph (visible, labelled, but not the loud placeholder).
  Decodability is the converter's gate (§5.3); keep-classes' audit is
  grammar-only today — extend it with a magic-bytes check when the first
  image item is exported.
- **Narrow review panes**: `.cimg` is the only flexible item in a review
  choice, so under ~515 px the image yields to the nowrap `.rv-mark`
  (unreachable on target devices for Math-only v1); fold into the
  capture-driven layout pass (9.1).
- **Canonical schema copies**: the test-bank repo's SCHEMA-v1.2.md and
  SCHEMA-BANKS-v1.md §3 still read `[4 strings]`; §5 here is authoritative
  for the converter until that commit mirrors the shape and rules.

## 9. Rulings (David, 2026-10-07)

1. **Layout and size**: stacked column at 320×220, provisional until a real
   Bluebook graph-choice capture settles it; the 2×2 grid stays one CSS rule
   away.
2. **Alt text**: app-generated "Choice B (image)" now; `alt` reserved for
   authored descriptions later.
3. **Expand control**: none for now; add the hover ⛶ only if the first live
   graphs prove hard to read.
4. **Grammar**: png + jpeg + svg+xml; and `q.figure` goes through the same
   `data:`-only guard as a separate small commit, proving all 258 shipped
   figures still pass.
5. **Which items ship first**: 202609asiav1 m2-q4 first. **202510usv1
   m2-q1's key is B, with the stem as printed** — "y > −36" is answerable as
   printed and both blind passes derived B from it; printed C fits only a
   stem with an x the print does not show, and no dropped-variable defect
   class is confirmed on that form, so the key is the outlier. Recorded here
   so the test-bank bump carries it. 202406intv1 m2-q1 stays held (missing
   choice C).
6. **Sequencing with the scoring decision**: un-holds wait for the
   pro-rating decision; nothing on the platform side.
7. **The Math-wide annotation-replay skip**: yes, as its own reviewed commit
   after the renderer lands.
