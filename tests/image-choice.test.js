/* tests/image-choice.test.js — run: node tests/image-choice.test.js (repo root)

   Image answer choices (2026-10-07, IMAGE-CHOICES-SPEC.md): a choice is a
   string (today) or {image: data URI, alt?}. This pins the renderer seam,
   choiceBodyHtml (extracted from app.js by source text with the real
   render.js fmt()/escapeHtml beside it), on the four things the contract
   rests on:
     1. a TEXT choice renders byte-for-byte as before — fmt(c) in .ctext, or
        the sanitized saved blob when one exists;
     2. an IMAGE choice renders an <img> with the EXACT source, outside any
        .ctext, and its output is IDENTICAL whether or not a hostile blob sits
        in its saved slot — the slot is never read for it;
     3. the grammar admits exactly data:image/(png|jpeg|svg+xml);base64,… and
        nothing else (http(s), javascript:, data:text/html, a charset param,
        whitespace, an empty payload, gif);
     4. every malformed entry renders the visible placeholder and never throws;
     5. (§9, 2026-10-18) the decoded bytes must be the declared type —
        imageSourceOk, run by BOTH acceptance sites (choiceImageSrc and
        figureSrc): a payload atob cannot decode, PNG bytes declared jpeg or
        svg+xml, SVG bytes declared png, an SVG that is not valid UTF-8, not
        well-formed XML up to its root tag, or whose root is not <svg> in
        the SVG namespace — each refused at both sites and rendered as the
        placeholder; every shipped image, choices and figures in every
        current, archived and bank build, still passes (§7).
   Plus: the shared fixture passes the grammar and escapeHtml leaves it
   untouched; the browser proof embeds the fixture's four URIs verbatim; and
   buildQuestionHtml's choice branch no longer calls fmt() or writes .ctext
   itself (both live only in the seam), while annotationHost still resolves
   choices by .ctext.

   Mutants that must fail it (APP_SRC=<file> points at a scratch copy):
     drop the `typeof c.image === "string"` check (an array whose String()
     is a valid URI would then render); loosen the regex to ^data:; read the
     saved slot before the type branch; put the <img> inside .ctext; have
     buildQuestionHtml's branch index the saved map or interpolate a blob
     itself (the map is handed to the seam whole; only the seam's text path
     indexes it). §9 runs its own thirty-three bytes mutants in-process, each built
     from the real source by an exact replacement that must apply.

   To watch the bytes check fail without it (the commit before it, b67d3a7):
     git show b67d3a7:app.js > <scratch>/app-pre.js
     APP_SRC=<scratch>/app-pre.js node tests/image-choice.test.js
   §9's battery FAILS at both sites there (every mismatch is accepted). That
   is why imageSourceOk is extracted when present rather than required: the
   old file has none, and the run must reach the battery and report what it
   accepts. Requiring it would only crash. The pin that the function exists
   and both sites call it is a check of its own (§9).                        */
"use strict";
const fs = require("fs");
const vm = require("vm");
const { extractFn, extractConst } = require("./extract-helper");
const F = require("./image-choice-fixture");

const APP_PATH = process.env.APP_SRC || "app.js";
const appSrc = fs.readFileSync(APP_PATH, "utf8");
const renderSrc = fs.readFileSync("render.js", "utf8");

let pass = 0, fail = 0;
const failures = [];
function check(ok, label, detail){
  if(ok){ pass++; console.log("PASS | " + label); }
  else { fail++; failures.push(label + (detail ? " — " + detail : ""));
         console.log("FAIL | " + label + (detail ? " — " + detail : "")); }
}

/* the real render.js (fmt, escapeHtml) in a bare context — no KaTeX, so math
   takes its fallback span; no DOM, so no italic-correction pass */
const rctx = { window: {} };
vm.createContext(rctx);
vm.runInContext(renderSrc, rctx);
const fmt = rctx.fmt, escapeHtml = rctx.escapeHtml;
check(typeof fmt === "function" && typeof escapeHtml === "function", "render.js provides fmt() and escapeHtml()");

/* the image-source guard both acceptance sites share: the grammar and the
   bytes check. imageSourceOk is taken when the file has it (see the header:
   a pre-check app.js must still reach §9's battery and FAIL there); a file
   that calls it without defining it throws a ReferenceError at the first
   call, so leaving it out can never pass. */
function optFn(src, name){ try{ return extractFn(src, name); }catch(e){ return ""; } }
const GUARD_SRC = extractConst(appSrc, "CHOICE_IMAGE_RE") + "\n" + optFn(appSrc, "imageSourceOk");

/* the seam, with a sanitizer stub that MARKS its output so the test can see
   which path ran (the real one needs a DOM) */
const SEAM_SRC = [GUARD_SRC, extractFn(appSrc, "isImageChoice"),
  extractFn(appSrc, "choiceImageSrc"), extractFn(appSrc, "choiceBodyHtml")].join("\n");
const seam = new Function("fmt", "escapeHtml", "sanitizeSavedHtml",
  SEAM_SRC + "\nreturn { CHOICE_IMAGE_RE, isImageChoice, choiceImageSrc, choiceBodyHtml };")(
  fmt, escapeHtml, s => "<sanitized>" + String(s) + "</sanitized>");
const { CHOICE_IMAGE_RE, isImageChoice, choiceImageSrc, choiceBodyHtml } = seam;
const HOSTILE = '"><img src=x onerror="window.__XSS_FIRED=true"><b data-x=\'y\'>PWN</b>';

console.log("--- 1. text choices render as before ---");
{
  const plain = choiceBodyHtml("the {{i}}only{{/i}} answer", 1);
  check(plain === '<span class="ctext">' + fmt("the {{i}}only{{/i}} answer", { bigInline: true }) + "</span>",
    "a text choice is fmt(c, {bigInline:true}) inside .ctext", plain);
  const saved = choiceBodyHtml("text", 1, { 1: HOSTILE });
  check(saved === '<span class="ctext"><sanitized>' + HOSTILE + "</sanitized></span>",
    "a text choice with a saved blob in ITS slot renders the SANITIZED blob instead (today's replay path)", saved);
  const plainText = '<span class="ctext">' + fmt("text", { bigInline: true }) + "</span>";
  check(choiceBodyHtml("text", 1, { 1: null }) === plainText, "a null saved slot means 'no blob' for a text choice");
  check(choiceBodyHtml("text", 1, { 0: HOSTILE, 2: HOSTILE }) === plainText, "a blob in ANOTHER choice's slot is not this choice's");
  check(choiceBodyHtml("text", 1, { 1: "" }) === plainText && choiceBodyHtml("text", 1, { 1: 7 }) === plainText,
    "an EMPTY or non-string saved slot is 'no blob': it falls back to fmt(c) rather than rendering an empty .ctext (a non-empty blob still replaces the text by design — the student's own record)");
  check(choiceBodyHtml("text", 1, undefined) === plainText && choiceBodyHtml("text", 1, null) === plainText && choiceBodyHtml("text", 1, "nope") === plainText,
    "no map, a null map, or a non-object map all mean 'no blob'");
}

console.log("--- 2. image choices render from test data only ---");
{
  const q = F.question();
  const out = q.choices.map((c, i) => choiceBodyHtml(c, i));
  check(out.every((h, i) => h === `<span class="cimg"><img class="choice-image" src="${F.URIS[i]}" alt="Choice ${String.fromCharCode(65 + i)} (image)" draggable="false"></span>`),
    "an image choice is one <img> with the EXACT fixture source, the app's neutral alt, draggable off, inside .cimg", out[0]);
  check(out.every(h => h.indexOf("ctext") === -1), "…and no .ctext anywhere in it (so it is never an annotation region)");
  const hostileMap = { 0: HOSTILE, 1: HOSTILE, 2: HOSTILE, 3: HOSTILE };
  const withBlob = q.choices.map((c, i) => choiceBodyHtml(c, i, hostileMap));
  check(withBlob.every((h, i) => h === out[i]), "a hostile blob in every saved slot changes NOTHING: the slot is never read for an image choice");
  /* a map that TRAPS reads proves the slot is never touched, not merely ignored */
  let touched = 0;
  const trap = new Proxy({}, { get(){ touched++; return HOSTILE; }, has(){ touched++; return true; } });
  q.choices.forEach((c, i) => choiceBodyHtml(c, i, trap));
  check(touched === 0, "…and the map is never even indexed for an image choice (a trapping Proxy sees no read)", String(touched));
  check(withBlob.every(h => h.indexOf("PWN") === -1 && h.indexOf("onerror") === -1 && h.indexOf("sanitized") === -1),
    "…no payload, and not even the sanitizer runs for it");
  const alt = choiceBodyHtml({ image: F.URIS[0], alt: ' a <rising> "line" ' }, 0);
  check(alt.indexOf('alt="a &lt;rising&gt; &quot;line&quot;"') !== -1, "the reserved alt, when a non-empty string, is used — escaped, trimmed", alt);
  check(choiceBodyHtml({ image: F.URIS[0], alt: "   " }, 2).indexOf('alt="Choice C (image)"') !== -1, "a blank alt falls back to the app's label");
  check(choiceBodyHtml({ image: F.URIS[0], alt: 7 }, 2).indexOf('alt="Choice C (image)"') !== -1, "a non-string alt falls back to the app's label");
  check(F.URIS.every(u => escapeHtml(u) === u), "escapeHtml is a no-op on every fixture URI (the grammar admits no metacharacter)");
  check(F.URIS.every(u => CHOICE_IMAGE_RE.test(u)) && new Set(F.URIS).size === 4, "the fixture's four URIs pass the grammar and are distinct");
}

console.log("--- 3. the grammar ---");
{
  /* the smallest payloads that are also the type they declare (§9): the PNG
     signature alone, a JPEG's first six bytes, an empty namespaced <svg/>.
     The svg vector was "PHN2Zy8+" (<svg/>, no namespace) until 2026-10-18:
     a browser shows that as a broken image, and §9 now refuses it. */
  const ok = ["data:image/png;base64,iVBORw0KGgo=", "data:image/jpeg;base64,/9j/4AAQ",
    "data:image/svg+xml;base64," + Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>').toString("base64")];
  ok.forEach(s => check(choiceImageSrc({ image: s }) === s, "accepts " + s.slice(0, 24) + "…"));
  const bad = {
    "https URL": "https://evil.example/x.png",
    "javascript:": "javascript:alert(1)",
    "data:text/html": "data:text/html;base64,PHNjcmlwdD4=",
    "charset param": "data:image/png;charset=utf-8;base64,iVBORw0KGgo=",
    "leading whitespace": " data:image/png;base64,iVBORw0KGgo=",
    "inner whitespace": "data:image/png;base64, iVBORw0KGgo=",
    "trailing newline": "data:image/png;base64,iVBORw0KGgo=\n",
    "'<' in the payload": "data:image/png;base64,iVBOR<w0KGgo=",
    "empty payload": "data:image/png;base64,",
    "gif (no shipped precedent)": "data:image/gif;base64,R0lGODlh",
    "percent-encoded": "data:image/png;base64,iVBOR%20w0KGgo=",
    "blob:": "blob:https://sat.davidsatprep.com/abc",
    "uppercase scheme": "DATA:image/png;base64,iVBORw0KGgo="
  };
  Object.keys(bad).forEach(k => check(choiceImageSrc({ image: bad[k] }) === null, "rejects " + k, bad[k]));
}

console.log("--- 4. malformed entries: placeholder, never a throw ---");
{
  const junk = { "null": null, "number": 5, "array": ["data:image/png;base64,iVBORw0KGgo="], "empty object": {}, "image not a string": { image: 5 },
    "image fails the grammar": { image: "https://evil.example/x.png" }, "undefined": undefined, "boolean": true,
    /* an array whose String() is a grammar-valid URI: RegExp.test coerces, so
       only the typeof guard keeps this from rendering a real <img> */
    "image is an array holding a valid URI": { image: [F.URIS[0]] },
    "image is a String object": { image: new String(F.URIS[0]) } };
  Object.keys(junk).forEach(k => {
    let html = null, threw = null;
    try{ html = choiceBodyHtml(junk[k], 1); }catch(e){ threw = e; }
    check(!threw && typeof html === "string" && html.indexOf("cimg-missing") !== -1 && html.indexOf("<img") === -1 &&
          html.indexOf('role="img"') !== -1 && html.indexOf('aria-label="Choice B image unavailable"') !== -1,
      "malformed (" + k + ") renders the placeholder with no <img> and does not throw", threw ? String(threw) : html);
  });
}

console.log("--- 5. the seam is where the choice markup lives ---");
{
  const bq = extractFn(appSrc, "buildQuestionHtml");
  const branch = bq.slice(bq.indexOf("q.choices.map("), bq.indexOf("}).join(\"\") + '</div>'"));
  check(branch.indexOf("choiceBodyHtml(c, idx, savedMap)") !== -1, "buildQuestionHtml's choice branch renders every choice through choiceBodyHtml, handing it the whole saved map");
  check(branch.indexOf("fmt(") === -1 && branch.indexOf('class="ctext"') === -1 && branch.indexOf("sanitizeSavedHtml(") === -1,
    "…and no longer calls fmt(), sanitizeSavedHtml() or writes .ctext itself (one render site, one rule)");
  /* the branch must never HOLD a blob. An EXACT-SET pin, not a prefix test:
     every `${…}` the branch interpolates must be one of the eleven literal
     strings it uses today (a `${sel ? blob : ""}` or `${letter + blob}`
     would pass a prefix check and would never render in the browser proof,
     whose hostile slots can sit on an unselected choice); the map name
     appears exactly once (the call), and neither choiceHtml nor savedC is
     named anywhere in it. Seam-level mutants are the seam checks' business. */
  const ALLOWED = ['${idx}', '${letter}', '${body}', '${mark}', '${kind}',
    '${elim ? " is-elim" : ""}', '${isKey ? "rv-key" : ""}', '${sel && !isKey ? "rv-wrong" : ""}',
    '${elim ? "eliminated" : ""}', '${sel?"selected":""}', '${elim?"eliminated":""}'];
  const interps = branch.match(/\$\{[^}]*\}/g) || [];
  const stray = interps.filter(s => ALLOWED.indexOf(s) === -1);
  check(interps.length >= 11 && stray.length === 0, "no interpolation other than the branch's eleven known literals reaches the markup", stray.join(" | "));
  check(ALLOWED.every(s => interps.indexOf(s) !== -1), "…and the branch still uses each of the eleven (the pin is not stale)", ALLOWED.filter(s => interps.indexOf(s) === -1).join(" | "));
  /* the whole function, not only the branch slice: a blob could also arrive
     by concatenation through an alias declared above the branch, so the map
     and the record field may each be named exactly where they belong — the
     map twice (its declaration and the one call, pinned as a full statement),
     the field twice (both on the declaration line) — and nowhere else */
  check((bq.match(/\bsavedMap\b/g) || []).length === 2 && bq.indexOf("const body = choiceBodyHtml(c, idx, savedMap);") !== -1,
    "in all of buildQuestionHtml the saved map is named exactly twice: its declaration and the full `const body = choiceBodyHtml(c, idx, savedMap);` statement");
  const chLines = bq.split("\n").filter(l => /\bchoiceHtml\b/.test(l));
  check((bq.match(/\bchoiceHtml\b/g) || []).length === 2 && chLines.length === 1 && /const savedMap = \(replaysAnnotations\(mod\) && ms\.choiceHtml && ms\.choiceHtml\[q\.id\]\) \|\| undefined;/.test(chLines[0]) && !/\bsavedC\b/.test(bq),
    "…and the record's choiceHtml field is named only on that declaration line, behind the Math gate (no alias, no second lookup, no savedC anywhere in the function)", chLines.join(" || "));
  const bqHead = bq.slice(0, bq.indexOf("q.choices.map("));
  check(/const savedMap = \(replaysAnnotations\(mod\) && ms\.choiceHtml && ms\.choiceHtml\[q\.id\]\) \|\| undefined;/.test(bqHead), "the saved map is looked up once per question, by question id only, behind the Math gate");
  check(/choice-img/.test(branch), "an image choice's .choice carries choice-img");
  const ah = extractFn(appSrc, "annotationHost");
  check(ah.indexOf('closest(".ctext")') !== -1 && ah.indexOf("cimg") === -1, "annotationHost resolves a choice by .ctext and knows nothing of .cimg — an image choice is no region");
  check(/window\.AppSanitize\.annotationHost = annotationHost;/.test(appSrc), "annotationHost is exposed for the browser proof");
  check(!/\bimg\b/.test(fs.readFileSync("render.js", "utf8").replace(/\/\*[\s\S]*?\*\//g, "")), "render.js still emits no <img> (grep, comments stripped)");
}

console.log("--- 6. the browser proof carries the same fixture ---");
{
  const proof = fs.readFileSync("tests/injection-proof.js", "utf8");
  check(F.URIS.every(u => proof.indexOf(u) !== -1), "tests/injection-proof.js embeds all four fixture URIs verbatim (it is pasted into a console and cannot require this file)");
}

console.log("--- 7. the stem figure goes through the same guard (ruling 2026-10-07) ---");
{
  const figureSrc = new Function(GUARD_SRC + "\n" + extractFn(appSrc, "figureSrc") + "\nreturn figureSrc;")();
  check(figureSrc({ figure: F.URIS[0] }) === F.URIS[0], "figureSrc returns a data:image/png figure unchanged");
  check(figureSrc({ figure: "https://evil.example/f.png" }) === null && figureSrc({ figure: "javascript:1" }) === null &&
        figureSrc({ figure: "" }) === null && figureSrc({}) === null && figureSrc({ figure: 5 }) === null && figureSrc(null) === null,
    "figureSrc refuses http(s), javascript:, an empty string, a missing or non-string figure, a null question");
  const frame = extractFn(appSrc, "figureFrameHtml");
  check(frame.indexOf("const src = figureSrc(q);") !== -1 && frame.indexOf('src="${escapeHtml(src)}"') !== -1 && frame.indexOf("escapeHtml(q.figure)") === -1,
    "figureFrameHtml renders the GUARDED source into the attribute, never q.figure directly");
  check(frame.indexOf("fig-missing") !== -1 && /\$\{src \? `<div class="fig-toolbar">/.test(frame), "a figure outside the grammar renders the placeholder with no toolbar");
  const handlers = extractFn(appSrc, "attachFigureHandlers");
  check(handlers.indexOf("if(!figureSrc(q)) return;") !== -1 && handlers.indexOf('el("figOverlayImg").src = figureSrc(q);') !== -1 && handlers.indexOf("= q.figure") === -1,
    "attachFigureHandlers and the expand overlay use the guarded source too");
  /* every shipped image passes, through the guard it is rendered by: every
     figure through figureSrc, every image choice through choiceImageSrc, in
     current builds, archived builds and banks. Grammar AND bytes since
     2026-10-18 (§9); the choices floor is the first two image items' eight
     (an archived build keeps an item, so the count can only grow). */
  function loadData(file){ const c = { window: { __TESTDATA__: {}, __BANKDATA__: {} } }; vm.createContext(c); vm.runInContext(fs.readFileSync(file, "utf8"), c); return c.window; }
  const manifest = loadData("testdata/manifest.js").TEST_MANIFEST;
  const banks = loadData("testdata/bank-manifest.js").BANK_MANIFEST;
  let figures = 0, choices = 0; const rejected = [], byType = {};
  const tally = u => { const t = /^data:image\/([a-z+]+);/.exec(String(u)); const k = t ? t[1] : "other"; byType[k] = (byType[k] || 0) + 1; };
  const sweep = (where, qs) => qs.forEach(q => {
    if(!q) return;
    if(q.figure !== undefined){ figures++; tally(q.figure); if(figureSrc(q) !== q.figure) rejected.push(where + ":" + (q.id || q.qid)); }
    (Array.isArray(q.choices) ? q.choices : []).forEach((c, i) => {
      if(!isImageChoice(c)) return;
      choices++; tally(c.image);
      if(choiceImageSrc(c) !== c.image) rejected.push(where + ":" + (q.id || q.qid) + "#" + i);
    });
  });
  manifest.forEach(e => { const t = loadData("testdata/" + e.testId + ".js").__TESTDATA__[e.testId]; t.modules.forEach(m => sweep(e.testId, m.questions)); });
  fs.readdirSync("testdata/archive").filter(f => f.indexOf("@") !== -1 && /\.js$/.test(f)).forEach(f => {
    const id = f.split("@")[0]; const t = loadData("testdata/archive/" + f).__TESTDATA__[id]; t.modules.forEach(m => sweep(f, m.questions)); });
  banks.forEach(b => { const bank = loadData("testdata/" + b.bankId + ".js").__BANKDATA__[b.bankId]; sweep(b.bankId, bank.questions || []); });
  check(figures >= 500 && choices >= 8 && rejected.length === 0,
    "LIBRARY: every shipped image (" + figures + " figures and " + choices + " image choices across current builds, archived builds and banks; " +
    Object.keys(byType).sort().map(k => k + " " + byType[k]).join(", ") + ") passes the guard it renders through, grammar and bytes, unchanged",
    rejected.slice(0, 8).join(", "));
}

console.log("--- 8. Math modules replay no annotations (ruling 2026-10-07 §9.7) ---");
{
  const replaysAnnotations = new Function(extractFn(appSrc, "replaysAnnotations") + "\nreturn replaysAnnotations;")();
  check(replaysAnnotations({ section: "Reading and Writing" }) === true, "a Reading and Writing module replays its saved highlights");
  check(replaysAnnotations({ section: "Math" }) === false && replaysAnnotations(null) === false && replaysAnnotations(undefined) === false && replaysAnnotations({}) === true,
    "a Math module replays none; a missing module replays none; a module with no section is treated as annotatable (the pre-existing RW default)");
  /* every replay site asks the gate before reading a saved blob */
  const rqv = extractFn(appSrc, "renderQuestionView");
  check(/const saved = replaysAnnotations\(mod\) \? ms\.passageHtml\[q\.id\] : undefined;/.test(rqv), "the passage pane reads passageHtml only behind the gate");
  check(/\(replaysAnnotations\(mod\) && ms\.passageHtml\[q\.id\] !== undefined\)/.test(bqAll()), "the stacked Math stimulus reads passageHtml only behind the gate");
  check(/stemHtml\(q\.questionText, \(replaysAnnotations\(mod\) && ms\.stemHtml\) \? ms\.stemHtml\[q\.id\] : undefined\)/.test(bqAll()), "the stem reads stemHtml only behind the gate");
  /* every mention of a saved-markup field in buildQuestionHtml sits on one of
     the three gated statements — two mentions each (the test and the read);
     the stimulus statement wraps onto a second line, whose read is inside
     the gated ternary */
  const mentions = bqAll().split("\n").filter(l => /ms\.(passageHtml|stemHtml|choiceHtml)\b/.test(l));
  const gatedLines = mentions.filter(l => /replaysAnnotations\(mod\)/.test(l));
  const stimulusRead = mentions.filter(l => /^\s*\? sanitizeSavedHtml\(ms\.passageHtml\[q\.id\]\) : fmt\(q\.passage\)\)/.test(l));
  check(mentions.length === 4 && gatedLines.length === 3 && stimulusRead.length === 1 && (bqAll().match(/ms\.(passageHtml|stemHtml|choiceHtml)\b/g) || []).length === 6,
    "buildQuestionHtml mentions the three saved-markup fields six times on four lines: three gated statements plus the stimulus ternary's read line (nothing ungated)", mentions.map(l => l.trim().slice(0, 80)).join(" || "));
  check((rqv.match(/ms\.(passageHtml|stemHtml|choiceHtml)\b/g) || []).length === 1, "renderQuestionView reads a saved-markup field at exactly its one gated place");
  function bqAll(){ return extractFn(appSrc, "buildQuestionHtml"); }

  /* FILE-WIDE SWEEP, prefix-blind: every line of app.js (comments stripped)
     that names passageHtml, stemHtml or choiceHtml — through `ms.`, an
     alias, or anything else — must be one of: the moduleState initialisers,
     a line inside restoreAnnotations (the record → state shape filter), a
     line inside saveAnnotation (state ← DOM), or one of the five gated
     replay lines pinned above. A new replay site anywhere in the file — a
     fifth function, an alias, a helper — lands outside that set and fails
     here. The same for the sanitizer's sinks: every sanitizeSavedHtml(…)
     call is one of the four known expressions, each fed only by a gated
     value. attempts.js names the fields only where the recorder packs them
     onto the record (a write, not a render). */
  const stripped = appSrc.replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, " ")).replace(/(^|[^:])\/\/[^\n]*/g, "$1");
  const restoreBody = extractFn(stripped, "restoreAnnotations"), saveBody = extractFn(stripped, "saveAnnotation");
  const inBody = (line, body) => body.split("\n").some(b => b.trim() === line.trim() && line.trim() !== "");
  const INIT_RE = /\{ answers:\{\}, flags:new Set\(\), eliminated:\{\}, passageHtml:\{\}, stemHtml:\{\}, choiceHtml:\{\}, notes:\{\} \}/;
  const GATED = [
    /* the stem helper's own declaration carries the field's name; its `saved`
       argument is fed only by the gated stem line below (pinned above) */
    "function stemHtml(questionText, saved){",
    "const saved = replaysAnnotations(mod) ? ms.passageHtml[q.id] : undefined;",
    "((replaysAnnotations(mod) && ms.passageHtml[q.id] !== undefined)",
    "? sanitizeSavedHtml(ms.passageHtml[q.id]) : fmt(q.passage)) + '</div></div>'",
    "const savedMap = (replaysAnnotations(mod) && ms.choiceHtml && ms.choiceHtml[q.id]) || undefined;",
    "${stemHtml(q.questionText, (replaysAnnotations(mod) && ms.stemHtml) ? ms.stemHtml[q.id] : undefined)}"
  ];
  const fieldLines = stripped.split("\n").map((l, i) => ({ n: i + 1, t: l })).filter(x => /\b(passageHtml|stemHtml|choiceHtml)\b/.test(x.t));
  const unexplained = fieldLines.filter(x => !INIT_RE.test(x.t) && !inBody(x.t, restoreBody) && !inBody(x.t, saveBody) && GATED.indexOf(x.t.trim()) === -1);
  check(fieldLines.length >= 15 && unexplained.length === 0,
    "SWEEP: every mention of passageHtml/stemHtml/choiceHtml in app.js is an initialiser, restoreAnnotations, saveAnnotation, or one of the five gated replay lines (" + fieldLines.length + " lines)",
    unexplained.map(x => x.n + ": " + x.t.trim().slice(0, 90)).join(" || "));
  check(GATED.every(g => fieldLines.some(x => x.t.trim() === g)), "SWEEP: all five gated lines are present verbatim (the pin is not stale)");
  const sinks = (stripped.match(/sanitizeSavedHtml\([^)]*\)/g) || []).filter(s => s !== "sanitizeSavedHtml(html)");
  const KNOWN_SINKS = ["sanitizeSavedHtml(saved)", "sanitizeSavedHtml(savedC)", "sanitizeSavedHtml(ms.passageHtml[q.id])"];
  const strayS = sinks.filter(s => KNOWN_SINKS.indexOf(s) === -1);
  check(sinks.length === 4 && strayS.length === 0, "SWEEP: the sanitizer has exactly four call sites, each fed only by a gated value (passage pane, stem helper, seam text path, stacked stimulus)", sinks.join(" | "));
  const attemptsSrc = fs.readFileSync("attempts.js", "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
  const aMentions = attemptsSrc.split("\n").map((l, i) => ({ n: i + 1, t: l })).filter(x => /\b(passageHtml|stemHtml|choiceHtml)\b/.test(x.t));
  const span = aMentions.length ? aMentions[aMentions.length - 1].n - aMentions[0].n : 0;
  check(aMentions.length === 5 && span <= 8 && aMentions.some(x => /annotations\[mid\] = \{ passageHtml: ms\.passageHtml/.test(x.t)),
    "SWEEP: attempts.js names the fields only where the recorder packs them onto the record (five lines, one block) — no replay there", aMentions.map(x => x.n).join(","));
  check(!/\b(passageHtml|stemHtml|choiceHtml)\b/.test(fs.readFileSync("dashboard.js", "utf8")) && !/\b(passageHtml|stemHtml|choiceHtml)\b/.test(fs.readFileSync("render.js", "utf8")),
    "SWEEP: dashboard.js and render.js never name the fields (no replay surface outside app.js)");
}

console.log("--- 9. magic bytes: the decoded bytes must be the declared type (2026-10-18) ---");
{
  const b64 = s => Buffer.from(s, "latin1").toString("base64");
  const uri = (type, payload) => "data:image/" + type + ";base64," + payload;
  const NS = "http://www.w3.org/2000/svg";
  const PNG = F.URIS[0].slice("data:image/png;base64,".length);             // a whole 4×3 PNG
  const PNG_CORE = PNG.replace(/=+$/, "");                                 // its payload without padding
  const JPEG = b64("\xFF\xD8\xFF\xE0\x00\x10JFIF\x00\x01\x01\x00");         // a JPEG's head: SOI, then APP0
  const SVG = b64('<svg xmlns="' + NS + '" width="4" height="3"><rect width="4" height="3"/></svg>');
  const ACCEPT = {
    "a PNG (fixture A)": F.URIS[0], "a PNG (fixture B)": F.URIS[1], "a PNG (fixture C)": F.URIS[2], "a PNG (fixture D)": F.URIS[3],
    "a PNG signature with nothing after it": "data:image/png;base64,iVBORw0KGgo=",
    "a JPEG head declared jpeg": uri("jpeg", JPEG),
    "an SVG declared svg+xml": uri("svg+xml", SVG),
    "an SVG after a BOM, an XML declaration, a comment and newlines, its single-quoted xmlns not the first attribute":
      uri("svg+xml", b64("\xEF\xBB\xBF<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<!-- drawn - by hand -->\n<svg width='4'\r\n\txmlns = '" + NS + "'><rect/></svg>")),
    "a prefixed SVG root bound by its own xmlns:prefix": uri("svg+xml", b64('<s:svg xmlns:s="' + NS + '"><s:rect/></s:svg>')),
    "an SVG with UTF-8 text in an attribute": uri("svg+xml", Buffer.from('<svg xmlns="' + NS + '" aria-label="−2 → x à"/>', "utf8").toString("base64")),
    /* XML's own prolog (review 2026-10-18): the browser draws each of these,
       so the bytes ARE an SVG, whatever the converter's choice rules make of
       a DOCTYPE. Refusing them made a figure from a standard tool show
       "Figure unavailable" where the build before this check drew it. */
    "a matplotlib-style SVG (XML declaration, DOCTYPE PUBLIC, xmlns last)":
      uri("svg+xml", b64('<?xml version="1.0" encoding="utf-8" standalone="no"?>\n<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN"\n  "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">\n' +
        '<svg xmlns:xlink="http://www.w3.org/1999/xlink" width="460.8pt" height="345.6pt" viewBox="0 0 460.8 345.6" xmlns="' + NS + '" version="1.1">\n <metadata/></svg>')),
    "an Illustrator-style SVG (declaration, generator comment, DOCTYPE)":
      uri("svg+xml", b64('<?xml version="1.0" encoding="utf-8"?>\n<!-- Generator: Adobe Illustrator 24.0.0, SVG Export Plug-In . SVG Version: 6.00 Build 0)  -->\n' +
        '<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">\n<svg version="1.1" id="Layer_1" xmlns="' + NS + '" x="0px" y="0px"\n\t viewBox="0 0 40 30"><rect/></svg>')),
    "a bare <!DOCTYPE svg>": uri("svg+xml", b64('<!DOCTYPE svg><svg xmlns="' + NS + '"/>')),
    "a DOCTYPE whose internal subset holds a comment with ] and a quote, an entity, a PI, an ATTLIST and a %ref;":
      uri("svg+xml", b64("<!DOCTYPE svg [ <!-- it's ] here --> <!ENTITY a \"x]y\"> <?pi ]? ?> <!ATTLIST svg w CDATA '1'> %pe; ]>\n<svg xmlns=\"" + NS + "\"/>")),
    "a Graphviz-style SVG (comments AFTER the DOCTYPE)":
      uri("svg+xml", b64('<?xml version="1.0" encoding="UTF-8" standalone="no"?>\n<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN"\n "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">\n' +
        '<!-- Generated by graphviz version 2.43.0 (0)\n -->\n<!-- Title: G Pages: 1 -->\n<svg width="8pt" xmlns="' + NS + '" xmlns:xlink="http://www.w3.org/1999/xlink"/>')),
    "a PI after the DOCTYPE": uri("svg+xml", b64('<!DOCTYPE svg><?foo bar?><svg xmlns="' + NS + '"/>')),
    "a DOCTYPE with a SYSTEM literal": uri("svg+xml", b64('<!DOCTYPE svg SYSTEM "x.dtd"><svg xmlns="' + NS + '"/>')),
    "entity and character references in another root attribute": uri("svg+xml", b64('<svg xmlns="' + NS + '" aria-label="a &amp; b &#233;"/>')),
    /* the third review (2026-10-18), each measured in Chrome 152 as DRAWN */
    "lxml's single-quoted declaration": uri("svg+xml", b64("<?xml version='1.0' encoding='UTF-8'?><svg xmlns=\"" + NS + "\"/>")),
    "spaces around = in the declaration": uri("svg+xml", b64('<?xml version = "1.0" encoding = "UTF-8" ?><svg xmlns="' + NS + '"/>')),
    "standalone='no', and version 1.1, and an unknown encoding name": uri("svg+xml", b64("<?xml version='1.1' encoding='foo' standalone='no'?><svg xmlns=\"" + NS + "\"/>")),
    "ELEMENT (ANY and a content model) and NOTATION declarations": uri("svg+xml", b64('<!DOCTYPE svg [ <!ELEMENT svg ANY> <!ELEMENT g (#PCDATA|g)*> <!NOTATION n SYSTEM "x"> ]><svg xmlns="' + NS + '"/>')),
    "an ENTITY literal holding >, a parameter entity, an unparsed entity": uri("svg+xml", b64('<!DOCTYPE svg [ <!ENTITY a "x>y"> <!ENTITY % pe "x"> <!NOTATION n SYSTEM "x"> <!ENTITY e SYSTEM "y" NDATA n> ]><svg xmlns="' + NS + '"/>')),
    "a defined entity in a root attribute": uri("svg+xml", b64('<!DOCTYPE svg [ <!ENTITY foo "bar"> ]><svg xmlns="' + NS + '" data-a="&foo;"/>')),
    "a > in a root attribute value": uri("svg+xml", b64('<svg xmlns="' + NS + '" aria-label="x > 2"/>')),
    "a doubled UTF-8 BOM (Chrome strips two)": uri("svg+xml", b64('\xEF\xBB\xBF\xEF\xBB\xBF<?xml version="1.0"?><svg xmlns="' + NS + '"/>')),
    "TAB, CR, LF and DEL in a comment, &#9; in an attribute": uri("svg+xml", b64('<!-- a\tb\r\nc\x7F --><svg xmlns="' + NS + '" data-a="a&#9;b"/>')),
    "an ATTLIST with any body (Chrome draws it)": uri("svg+xml", b64('<!DOCTYPE svg [ <!ATTLIST junk> ]><svg xmlns="' + NS + '"/>')),
    "an astral-plane NameStartChar in an attribute name": uri("svg+xml", Buffer.from('<svg xmlns="' + NS + '" \u{10000}a="1"/>', "utf8").toString("base64")),
    "a prefixed attribute bound on the root (xmlns:a, a:b)": uri("svg+xml", b64('<svg xmlns="' + NS + '" xmlns:a="urn:x" a:b="1"/>')),
    "UTF-8 text in the body": uri("svg+xml", Buffer.from('<svg xmlns="' + NS + '"><title>30° − 2</title></svg>', "utf8").toString("base64")),
    "an xml-stylesheet processing instruction": uri("svg+xml", b64('<?xml version="1.0"?><?xml-stylesheet href="s.css" type="text/css"?><svg xmlns="' + NS + '"/>')),
    "the namespace written with a decimal character reference": uri("svg+xml", b64('<svg xmlns="http&#58;//www.w3.org/2000/svg"/>')),
    "the namespace written with a hex character reference": uri("svg+xml", b64('<svg xmlns="http&#x3A;//www.w3.org/2000/svg"/>')),
    "a non-ASCII prefix": uri("svg+xml", Buffer.from('<é:svg xmlns:é="' + NS + '"/>', "utf8").toString("base64")),
    "Inkscape's attribute order (xmlns:svg, then xmlns)": uri("svg+xml", b64('<svg xmlns:svg="' + NS + '" xmlns="' + NS + '" xmlns:xlink="http://www.w3.org/1999/xlink"/>')),
    /* the bytes ARE an SVG: what one contains is not this check's business —
       <img> runs no script (the browser proof renders this one and asserts it) */
    "a scripted SVG": uri("svg+xml", b64('<svg xmlns="' + NS + '"><script>window.__XSS_FIRED=true</script></svg>'))
  };
  const REFUSE = {
    "PNG bytes declared jpeg": uri("jpeg", PNG), "PNG bytes declared svg+xml": uri("svg+xml", PNG),
    "JPEG bytes declared png": uri("png", JPEG), "JPEG bytes declared svg+xml": uri("svg+xml", JPEG),
    "SVG bytes declared png": uri("png", SVG), "SVG bytes declared jpeg": uri("jpeg", SVG),
    "GIF bytes declared png": uri("png", b64("GIF89a\x01\x00\x01\x00\x00\x00\x00")),
    "HTML declared svg+xml": uri("svg+xml", b64("<html><body><script>window.__XSS_FIRED=true</script></body></html>")),
    "zero bytes declared png": uri("png", "AAAAAAAAAAAA"),
    "a PNG signature with one byte wrong": uri("png", b64("\x89PNg\r\n\x1A\n\x00\x00\x00\x0D")),
    "a PNG signature one byte late": uri("png", b64("\x00\x89PNG\r\n\x1A\n\x00\x00\x00")),
    "half a PNG signature": uri("png", b64("\x89PNG")),
    /* the signature's back half (review 2026-10-18): a 4-byte compare passed
       every case above */
    "a PNG signature whose CRLF became LF (a text-mode transfer)": uri("png", b64("\x89PNG\n\x1A\n\x00\x00\x00\x0DIHDR")),
    "a PNG signature with byte 7 wrong": uri("png", b64("\x89PNG\r\n\x00\n\x00\x00\x00\x0D")),
    /* every byte pinned by a case of its own (review 2026-10-18): the final
       LF, and the first byte, alone; JPEG's middle byte alone */
    "a PNG signature whose final LF became CRLF": uri("png", b64("\x89PNG\r\n\x1A\r\n\x00\x00\x00\x0D")),
    "a PNG signature whose first byte is 0x09": uri("png", b64("\x09PNG\r\n\x1A\n\x00\x00\x00\x0D")),
    "a JPEG start-of-image with no marker after it": uri("jpeg", b64("\xFF\xD8")),
    "a JPEG start-of-image followed by a non-marker byte": uri("jpeg", b64("\xFF\xD8\x00\xE0\x00\x10JFIF")),
    "a JPEG whose second byte is not D8": uri("jpeg", b64("\xFF\x00\xFF\xE0\x00\x10JFIF")),
    "a JPEG whose first byte is not FF": uri("jpeg", b64("\x00\xD8\xFF\xE0\x00\x10JFIF")),
    "a PNG signature with only byte 2 wrong": uri("png", b64("\x89QNG\r\n\x1A\n\x00\x00\x00\x0D")),
    "a PNG signature with only byte 3 wrong": uri("png", b64("\x89POG\r\n\x1A\n\x00\x00\x00\x0D")),
    "a PNG signature with only byte 5 wrong": uri("png", b64("\x89PNG\x00\n\x1A\n\x00\x00\x00\x0D")),
    "a PNG signature with only byte 6 wrong": uri("png", b64("\x89PNG\r\x00\x1A\n\x00\x00\x00\x0D")),
    "an SVG with no namespace (<svg/>)": "data:image/svg+xml;base64,PHN2Zy8+",
    "an SVG root in the XHTML namespace": uri("svg+xml", b64('<svg xmlns="http://www.w3.org/1999/xhtml"/>')),
    "an SVG namespace with a trailing slash": uri("svg+xml", b64('<svg xmlns="' + NS + '/"/>')),
    "the SVG namespace only on a child": uri("svg+xml", b64('<svg><g xmlns="' + NS + '"/></svg>')),
    "xmlns inside another attribute's VALUE": uri("svg+xml", b64("<svg data-x='xmlns=\"" + NS + "\"'/>")),
    "a root named svgx": uri("svg+xml", b64('<svgx xmlns="' + NS + '"/>')),
    "an html root carrying the SVG namespace": uri("svg+xml", b64('<html xmlns="' + NS + '"/>')),
    "an <svg> only inside a comment": uri("svg+xml", b64('<!-- <svg xmlns="' + NS + '"/> -->')),
    "a prefixed root whose prefix is unbound": uri("svg+xml", b64('<s:svg xmlns="' + NS + '"/>')),
    "an unprefixed root with only xmlns:svg declared (the root is in no namespace)": uri("svg+xml", b64('<svg xmlns:svg="' + NS + '"><rect/></svg>')),
    "a root named SVG (XML names are case-sensitive)": uri("svg+xml", b64('<SVG xmlns="' + NS + '"/>')),
    "an unquoted attribute on the root (not XML)": uri("svg+xml", b64('<svg xmlns="' + NS + '" width=4/>')),
    "two DOCTYPEs": uri("svg+xml", b64('<!DOCTYPE svg><!DOCTYPE svg><svg xmlns="' + NS + '"/>')),
    "an internal subset left open": uri("svg+xml", b64('<!DOCTYPE svg [ <!ENTITY a "b"> <svg xmlns="' + NS + '"/>')),
    /* the one form the check does not expand, stated in app.js: an xmlns
       written through an entity the internal subset declares */
    "the namespace written through an internal-subset entity (old Illustrator)":
      uri("svg+xml", b64('<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "x.dtd" [\n\t<!ENTITY ns_svg "' + NS + '">\n]>\n<svg xmlns="&ns_svg;"/>')),
    "a character reference past U+10FFFF in the namespace": uri("svg+xml", b64('<svg xmlns="http&#x110000;//www.w3.org/2000/svg"/>')),
    "the namespace supplied as an ATTLIST default (stated refusal)": uri("svg+xml", b64('<!DOCTYPE svg [ <!ATTLIST svg xmlns CDATA #FIXED "' + NS + '"> ]><svg width="10"/>')),
    /* XML 1.0 exactly (review 2026-10-18): each of these is a document Chrome
       shows as BROKEN, and each passed e92a2bd's looser prolog. The XML
       declaration only at the very start, with a version; a PI target is a
       Name and never "xml"; a DOCTYPE has a Name, then SYSTEM "lit" or
       PUBLIC "pubid" "lit", then a subset of declarations; a comment holds
       no "--"; root attributes are whitespace-separated Names with values
       holding no "<" and no bare "&" */
    "a newline before the XML declaration": uri("svg+xml", b64('\n<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="' + NS + '"/>')),
    "a space before the XML declaration": uri("svg+xml", b64(' <?xml version="1.0"?><svg xmlns="' + NS + '"/>')),
    "a comment before the XML declaration": uri("svg+xml", b64('<!-- c --><?xml version="1.0"?><svg xmlns="' + NS + '"/>')),
    "a BOM, a newline, then the XML declaration": uri("svg+xml", b64('\xEF\xBB\xBF\n<?xml version="1.0"?><svg xmlns="' + NS + '"/>')),
    "two XML declarations": uri("svg+xml", b64('<?xml version="1.0"?><?xml version="1.0"?><svg xmlns="' + NS + '"/>')),
    "an XML declaration after the DOCTYPE": uri("svg+xml", b64('<!DOCTYPE svg><?xml version="1.0"?><svg xmlns="' + NS + '"/>')),
    "<?xml?> (no version)": uri("svg+xml", b64('<?xml?><svg xmlns="' + NS + '"/>')),
    "<?xml foo=\"1\"?>": uri("svg+xml", b64('<?xml foo="1"?><svg xmlns="' + NS + '"/>')),
    "an XML declaration with version 2.0": uri("svg+xml", b64('<?xml version="2.0"?><svg xmlns="' + NS + '"/>')),
    "a PI with no target (<? ?>)": uri("svg+xml", b64('<? ?><svg xmlns="' + NS + '"/>')),
    "a PI targeted XML (<?XML ...?>)": uri("svg+xml", b64('<?XML version="1.0"?><svg xmlns="' + NS + '"/>')),
    "a PI target that is not a Name (<?123 x?>)": uri("svg+xml", b64('<?123 x?><svg xmlns="' + NS + '"/>')),
    "a DOCTYPE with junk after its name": uri("svg+xml", b64('<!DOCTYPE svg junk><svg xmlns="' + NS + '"/>')),
    "a DOCTYPE with SYSTEM and no literal": uri("svg+xml", b64('<!DOCTYPE svg SYSTEM><svg xmlns="' + NS + '"/>')),
    "a DOCTYPE PUBLIC with one literal": uri("svg+xml", b64('<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN"><svg xmlns="' + NS + '"/>')),
    "a public id holding [": uri("svg+xml", b64('<!DOCTYPE svg PUBLIC "a[b" "c"><svg xmlns="' + NS + '"/>')),
    "a DOCTYPE with no name": uri("svg+xml", b64('<!DOCTYPE ><svg xmlns="' + NS + '"/>')),
    "junk in the internal subset": uri("svg+xml", b64('<!DOCTYPE svg [ junk ]><svg xmlns="' + NS + '"/>')),
    "an unclosed ENTITY in the internal subset": uri("svg+xml", b64('<!DOCTYPE svg [ <!ENTITY a "b" ]><svg xmlns="' + NS + '"/>')),
    "junk between the subset and >": uri("svg+xml", b64('<!DOCTYPE svg [ ] junk><svg xmlns="' + NS + '"/>')),
    "a lowercase <!doctype>": uri("svg+xml", b64('<!doctype svg><svg xmlns="' + NS + '"/>')),
    "<!DOCTYPEsvg> (no space)": uri("svg+xml", b64('<!DOCTYPEsvg><svg xmlns="' + NS + '"/>')),
    "a comment holding --": uri("svg+xml", b64('<!-- a -- b --><svg xmlns="' + NS + '"/>')),
    "root attributes with no space between them": uri("svg+xml", b64('<svg xmlns="' + NS + '"width="4"/>')),
    "a character reference with no ; in the namespace": uri("svg+xml", b64('<svg xmlns="http&#58//www.w3.org/2000/svg"/>')),
    "a wrong xmlns before the right one (the first decides)": uri("svg+xml", b64('<svg xmlns="x" xmlns="' + NS + '"/>')),
    "a < in a root attribute value": uri("svg+xml", b64('<svg xmlns="' + NS + '" a="<"/>')),
    "a bare & in a root attribute value": uri("svg+xml", b64('<svg xmlns="' + NS + '" a="a & b"/>')),
    "a root attribute named 1a (not a Name)": uri("svg+xml", b64('<svg xmlns="' + NS + '" 1a="x"/>')),
    "a prefix that is not a Name (<1:svg>)": uri("svg+xml", b64('<1:svg xmlns:1="' + NS + '"/>')),
    /* the third review (2026-10-18), each measured in Chrome 152 as BROKEN.
       Encoding: Chrome decodes an <img> SVG as UTF-8 whatever it declares */
    "a cp1252 degree sign (Windows ANSI re-save)": uri("svg+xml", b64('<svg xmlns="' + NS + '"><title>30\xB0</title></svg>')),
    "a declared windows-1252 document with a non-ASCII byte": uri("svg+xml", b64('<?xml version="1.0" encoding="windows-1252"?><svg xmlns="' + NS + '"><title>30\xB0</title></svg>')),
    "a declared ISO-8859-1 attribute byte": uri("svg+xml", b64('<?xml version="1.0" encoding="ISO-8859-1"?><svg xmlns="' + NS + '" data-x="caf\xE9"/>')),
    "invalid UTF-8 (FF) in a root attribute": uri("svg+xml", b64('<svg xmlns="' + NS + '" data-x="\xFF"/>')),
    "an overlong UTF-8 sequence": uri("svg+xml", b64('<svg xmlns="' + NS + '" data-x="\xC0\xAF"/>')),
    "a UTF-8-encoded surrogate": uri("svg+xml", b64('<svg xmlns="' + NS + '" data-x="\xED\xA0\x80"/>')),
    "three UTF-8 BOMs": uri("svg+xml", b64('\xEF\xBB\xBF\xEF\xBB\xBF\xEF\xBB\xBF<svg xmlns="' + NS + '"/>')),
    /* characters XML forbids, and references to them */
    "a form feed in a comment": uri("svg+xml", b64('<!-- a\fb --><svg xmlns="' + NS + '"/>')),
    "a \\x01 in the XML declaration": uri("svg+xml", b64('<?xml version="1.0"\x01?><svg xmlns="' + NS + '"/>')),
    "an ESC in a PI": uri("svg+xml", b64('<?foo a\x1Bb?><svg xmlns="' + NS + '"/>')),
    "a NUL in a root attribute": uri("svg+xml", b64('<svg xmlns="' + NS + '" data-a="a\x00b"/>')),
    "U+FFFE in a comment": uri("svg+xml", Buffer.from('<!-- a￾b --><svg xmlns="' + NS + '"/>', "utf8").toString("base64")),
    "&#0; in a root attribute": uri("svg+xml", b64('<svg xmlns="' + NS + '" data-a="&#0;"/>')),
    "&#x1; in a root attribute": uri("svg+xml", b64('<svg xmlns="' + NS + '" data-a="&#x1;"/>')),
    /* the XML declaration's own production */
    "an unquoted encoding": uri("svg+xml", b64('<?xml version="1.0" encoding=UTF-8?><svg xmlns="' + NS + '"/>')),
    "an unquoted standalone": uri("svg+xml", b64('<?xml version="1.0" standalone=no?><svg xmlns="' + NS + '"/>')),
    "standalone before encoding": uri("svg+xml", b64('<?xml version="1.0" standalone="no" encoding="UTF-8"?><svg xmlns="' + NS + '"/>')),
    "Encoding= (capital)": uri("svg+xml", b64('<?xml version="1.0" Encoding="UTF-8"?><svg xmlns="' + NS + '"/>')),
    "version twice": uri("svg+xml", b64('<?xml version="1.0" version="1.0"?><svg xmlns="' + NS + '"/>')),
    'standalone="maybe"': uri("svg+xml", b64('<?xml version="1.0" standalone="maybe"?><svg xmlns="' + NS + '"/>')),
    "junk in the declaration": uri("svg+xml", b64('<?xml version="1.0" junk?><svg xmlns="' + NS + '"/>')),
    "no space before encoding": uri("svg+xml", b64('<?xml version="1.0"encoding="UTF-8"?><svg xmlns="' + NS + '"/>')),
    'encoding=""': uri("svg+xml", b64('<?xml version="1.0" encoding=""?><svg xmlns="' + NS + '"/>')),
    "a declaration left open, running on to a later PI": uri("svg+xml", b64('<?xml version="1.0"><?foo bar?><svg xmlns="' + NS + '"/>')),
    "<?xmlversion=...?>": uri("svg+xml", b64('<?xmlversion="1.0"?><svg xmlns="' + NS + '"/>')),
    "mismatched version quotes": uri("svg+xml", b64("<?xml version=\"1.0'?><svg xmlns=\"" + NS + "\"/>")),
    'version="1." (no digit; stated refusal, Chrome draws it)': uri("svg+xml", b64('<?xml version="1."?><svg xmlns="' + NS + '"/>')),
    /* PIs, declarations, DOCTYPE spacing, Names and references */
    "a PI target holding a colon": uri("svg+xml", b64('<?a:b x?><svg xmlns="' + NS + '"/>')),
    "a PI target :x": uri("svg+xml", b64('<?:x?><svg xmlns="' + NS + '"/>')),
    "a PI with no space before its data": uri("svg+xml", b64('<?foo"bar?><svg xmlns="' + NS + '"/>')),
    "<!ENTITY a>": uri("svg+xml", b64('<!DOCTYPE svg [ <!ENTITY a> ]><svg xmlns="' + NS + '"/>')),
    "<!ENTITY junk junk junk>": uri("svg+xml", b64('<!DOCTYPE svg [ <!ENTITY junk junk junk> ]><svg xmlns="' + NS + '"/>')),
    "<!ELEMENT svg JUNK>": uri("svg+xml", b64('<!DOCTYPE svg [ <!ELEMENT svg JUNK> ]><svg xmlns="' + NS + '"/>')),
    "<!NOTATION n> (no id)": uri("svg+xml", b64('<!DOCTYPE svg [ <!NOTATION n> ]><svg xmlns="' + NS + '"/>')),
    "<!FOO bar> in the subset": uri("svg+xml", b64('<!DOCTYPE svg [ <!FOO bar> ]><svg xmlns="' + NS + '"/>')),
    "<!ENTITYa ...> (no space)": uri("svg+xml", b64('<!DOCTYPE svg [ <!ENTITYa "b"> ]><svg xmlns="' + NS + '"/>')),
    "%pe with no ;": uri("svg+xml", b64('<!DOCTYPE svg [ %pe ]><svg xmlns="' + NS + '"/>')),
    'SYSTEM"x" (no space)': uri("svg+xml", b64('<!DOCTYPE svg SYSTEM"x"><svg xmlns="' + NS + '"/>')),
    'PUBLIC"id" "x" (no space)': uri("svg+xml", b64('<!DOCTYPE svg PUBLIC"-//W3C//DTD SVG 1.1//EN" "x"><svg xmlns="' + NS + '"/>')),
    "the public and system literals run together": uri("svg+xml", b64('<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN""x"><svg xmlns="' + NS + '"/>')),
    "a DOCTYPE name that is not a Name": uri("svg+xml", b64('<!DOCTYPE 1svg><svg xmlns="' + NS + '"/>')),
    "an attribute name starting with ×": uri("svg+xml", Buffer.from('<svg xmlns="' + NS + '" ×x="1"/>', "utf8").toString("base64")),
    "an attribute named :x (not a QName)": uri("svg+xml", b64('<svg xmlns="' + NS + '" :x="1"/>')),
    "an attribute named a:b:c (not a QName)": uri("svg+xml", b64('<svg xmlns="' + NS + '" a:b:c="1"/>')),
    "<a:b:svg> (not a QName)": uri("svg+xml", b64('<a:b:svg xmlns:a:b="' + NS + '"/>')),
    "a form feed between the root name and an attribute": uri("svg+xml", b64('<svg\fxmlns="' + NS + '"/>')),
    "&#xZZ;": uri("svg+xml", b64('<svg xmlns="' + NS + '" data-a="&#xZZ;"/>')),
    "& ; (a bare & then a space)": uri("svg+xml", b64('<svg xmlns="' + NS + '" data-a="& ;"/>')),
    "&#X3A; (an upper-case X)": uri("svg+xml", b64('<svg xmlns="http&#X3A;//www.w3.org/2000/svg"/>')),
    "&#; (no digits)": uri("svg+xml", b64('<svg xmlns="' + NS + '" data-a="&#;"/>')),
    "//> to close the root": uri("svg+xml", b64('<svg xmlns="' + NS + '"//>')),
    "a comment ending --->": uri("svg+xml", b64('<!-- a ---><svg xmlns="' + NS + '"/>')),
    "text before the root": uri("svg+xml", b64('x<svg xmlns="' + NS + '"/>')),
    "a UTF-16 SVG": uri("svg+xml", Buffer.from("﻿<svg xmlns=\"" + NS + "\"/>", "utf16le").toString("base64")),
    "a PNG payload with three '='": uri("png", PNG_CORE + "==="),
    "a PNG payload of length 1 mod 4": uri("png", PNG_CORE + "AAA"),
    "a PNG payload padded on a length that is not a multiple of 4": uri("png", PNG_CORE + "=")
  };
  /* decodability, against atob itself: for a grammar-valid payload the
     verdict depends only on its length mod 4 and its run of trailing "=", so
     every core length 12..27 with 0..4 "=" covers every case. Each payload
     opens with the PNG signature, so only decodability decides it. */
  const atobOk = p => { try{ atob(p); return true; }catch(e){ return false; } };
  const DECODE = [];
  for(let core = 12; core <= 27; core++) for(let pad = 0; pad <= 4; pad++){
    const p = "iVBORw0KGgoA" + "A".repeat(core - 12) + "=".repeat(pad);
    DECODE.push([p, atobOk(p)]);
  }
  check(DECODE.some(d => d[1]) && DECODE.some(d => !d[1]), "the decodability cases include payloads atob accepts and payloads it refuses (" + DECODE.length + " cases)");
  check(Object.keys(ACCEPT).every(k => CHOICE_IMAGE_RE.test(ACCEPT[k])) && Object.keys(REFUSE).every(k => CHOICE_IMAGE_RE.test(REFUSE[k])) && DECODE.every(d => CHOICE_IMAGE_RE.test(uri("png", d[0]))),
    "every case passes the GRAMMAR, so only the bytes check can refuse one");
  /* a throw is a failure the battery NAMES, not a crash of the suite: the
     render must never throw (a refusal is the placeholder) */
  function battery(guard){
    const bad = [];
    const accepts = (u, k) => { try{ return guard(u); }catch(e){ bad.push("THREW " + e.name + " on " + k); return null; } };
    Object.keys(ACCEPT).forEach(k => { if(accepts(ACCEPT[k], k) !== true) bad.push("refused " + k); });
    Object.keys(REFUSE).forEach(k => { if(accepts(REFUSE[k], k) !== false) bad.push("accepted " + k); });
    DECODE.forEach(([p, ok]) => { if(accepts(uri("png", p), p.length + "-char payload") !== ok) bad.push((ok ? "refused" : "accepted") + " a " + p.length + "-char payload atob " + (ok ? "decodes" : "refuses")); });
    return bad;
  }
  /* both acceptance sites, evaluated from a source text (so the mutants
     below run through exactly the same harness) */
  function build(src){
    return new Function([extractConst(src, "CHOICE_IMAGE_RE"), optFn(src, "imageSourceOk"), extractFn(src, "isImageChoice"),
      extractFn(src, "choiceImageSrc"), extractFn(src, "figureSrc")].join("\n") +
      "\nreturn { choice: u => choiceImageSrc({ image: u }) === u, figure: u => figureSrc({ figure: u }) === u };")();
  }
  const real = build(appSrc);
  const realChoice = battery(real.choice), realFigure = battery(real.figure);
  check(realChoice.length === 0, "choiceImageSrc: " + Object.keys(ACCEPT).length + " true-type sources accepted, " + Object.keys(REFUSE).length +
    " mismatched or undecodable sources refused, decodability agrees with atob in all " + DECODE.length + " cases", realChoice.slice(0, 6).join("; "));
  check(realFigure.length === 0, "figureSrc: the same battery, the same verdicts (one guard for both sites)", realFigure.slice(0, 6).join("; "));
  /* NEVER A THROW (review 2026-10-18): a 16 MB comment before the root
     overflows V8's regex backtracking stack (a RangeError). Unreachable
     through the stated input paths, but the render must not depend on that:
     the check fails closed. A merely LARGE well-formed prolog (a million
     root attributes, 8 MB) does not overflow and is accepted. */
  {
    const overflow = uri("svg+xml", b64("<!--" + "x".repeat(16000000) + '--><svg xmlns="' + NS + '"/>'));
    const large = uri("svg+xml", b64("<svg" + ' a="b"'.repeat(1000000) + ' xmlns="' + NS + '">'));
    let threw = null, verdicts = null;
    try{ verdicts = [real.choice(overflow), real.figure(overflow), real.choice(large), real.figure(large)]; }catch(e){ threw = e; }
    check(!threw && verdicts[0] === false && verdicts[1] === false && verdicts[2] === true && verdicts[3] === true,
      "a 21 MB SVG whose prolog overflows the regex stack is refused at both sites and never throws; an 8 MB well-formed root tag is accepted",
      threw ? String(threw) : JSON.stringify(verdicts));
  }

  /* the RENDER, not only the predicate: a mismatched choice is the
     placeholder, a mismatched figure the "Figure unavailable" frame */
  const safe = f => { try{ return f(); }catch(e){ return "THREW " + e.name + " <img"; } };   // a throw fails the checks below by name
  const refused = Object.keys(REFUSE).map(k => safe(() => choiceBodyHtml({ image: REFUSE[k] }, 2)));
  check(refused.every(h => h.indexOf("cimg-missing") !== -1 && h.indexOf("<img") === -1 && h.indexOf('aria-label="Choice C image unavailable"') !== -1),
    "choiceBodyHtml renders every refused source as the placeholder, no <img>", refused.find(h => h.indexOf("<img") !== -1) || "");
  const frameHtml = new Function("fmt", "escapeHtml", GUARD_SRC + "\n" + extractFn(appSrc, "figureSrc") + "\n" + extractFn(appSrc, "figureFrameHtml") +
    "\nreturn figureFrameHtml;")(fmt, escapeHtml);
  const frames = Object.keys(REFUSE).map(k => safe(() => frameHtml({ figure: REFUSE[k] })));
  check(frames.every(h => h.indexOf("fig-missing") !== -1 && h.indexOf("<img") === -1 && h.indexOf("fig-toolbar") === -1),
    "figureFrameHtml renders every refused figure as the placeholder frame: no <img>, no toolbar", frames.find(h => h.indexOf("<img") !== -1) || "");
  const goodFrame = frameHtml({ figure: F.URIS[0] });
  check(goodFrame.indexOf('<img id="figImg" src="' + F.URIS[0] + '"') !== -1 && goodFrame.indexOf("fig-toolbar") !== -1 && goodFrame.indexOf("fig-missing") === -1,
    "…and a true-type figure still renders #figImg with the exact source and its toolbar (control)");

  /* WHERE the renderer accepts an image: exactly these sites, all guarded */
  const code = appSrc.replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, " ")).replace(/(^|[^:])\/\/[^\n]*/g, "$1");
  check(optFn(appSrc, "imageSourceOk") !== "", "app.js defines imageSourceOk");
  const cis = extractFn(appSrc, "choiceImageSrc"), fsrc = extractFn(appSrc, "figureSrc");
  check(cis.indexOf("imageSourceOk(c.image)") !== -1 && fsrc.indexOf("imageSourceOk(q.figure)") !== -1 && !/CHOICE_IMAGE_RE/.test(cis + fsrc),
    "choiceImageSrc and figureSrc both accept through imageSourceOk, and neither runs the bare grammar itself");
  const greUses = code.split("\n").filter(l => /CHOICE_IMAGE_RE/.test(l)).map(l => l.trim());
  check(greUses.length === 2 && /^const CHOICE_IMAGE_RE = /.test(greUses[0]) && greUses[1] === 'const m = typeof s === "string" ? CHOICE_IMAGE_RE.exec(s) : null;',
    "the grammar is named in app.js's code only at its declaration and inside imageSourceOk (no third acceptance site runs it alone)", greUses.join(" || "));
  const imgLines = code.split("\n").filter(l => /<img\b/i.test(l)).map(l => l.trim());
  check(imgLines.length === 2 && imgLines.some(l => l.indexOf('<img id="figImg" src="${escapeHtml(src)}"') !== -1) &&
        imgLines.some(l => l.indexOf('<img class="choice-image" src="${escapeHtml(src)}"') !== -1),
    "app.js writes exactly two <img> elements, the stem figure's and the image choice's, each from the guarded `src`", imgLines.join(" || "));
  check(extractFn(appSrc, "figureFrameHtml").indexOf("const src = figureSrc(q);") !== -1 && extractFn(appSrc, "choiceBodyHtml").indexOf("const src = choiceImageSrc(c);") !== -1,
    "…where `src` is figureSrc(q) in the frame and choiceImageSrc(c) in the seam");
  /* an EXACT list, not a pattern (review 2026-10-18): `s.src =` as a
     prefix let an alias named `s` re-source the overlay unguarded. The four
     script loaders, verbatim, and the overlay; nothing else, in any form —
     dotted, bracketed, srcset, setAttribute, new Image, createElement */
  const SRC_SETS = ['el("figOverlayImg").src = figureSrc(q);', "s.src = src;", "s.src = archiveVersion",
    's.src = "testdata/" + encodeURIComponent(bankId) + ".js";',
    's.src = "https://www.desmos.com/api/v1.11/calculator.js?apiKey=dcb31709b452b1cf9dc26972add0fda6";'].sort();
  const srcSets = code.split("\n").filter(l => /\.src\s*=(?!=)/.test(l)).map(l => l.trim()).sort();
  check(JSON.stringify(srcSets) === JSON.stringify(SRC_SETS) &&
        !/\[\s*["'`]src(?:set)?["'`]\s*\]\s*=(?!=)|setAttribute\(\s*["'`]src|\.srcset\b|srcset\s*=|new Image\b|createElement\(\s*["'`]img/i.test(code),
    "the .src assignments in app.js are exactly the four <script> loaders and the overlay (from figureSrc(q)); nothing else creates or sources an image", srcSets.join(" || "));
  check(appSrc.indexOf("/^data:image\\/(png|jpeg|svg\\+xml);base64,[A-Za-z0-9+\\/]+=*$/") !== -1 && /function\s+choiceImageSrc\s*\(/.test(appSrc),
    "the grammar literal and `function choiceImageSrc(` stay verbatim (the test-bank exporters' platform_supports() reads both)");

  /* MUTANTS: each removes one part of the check from the REAL source by an
     exact replacement that must apply once (a stale needle fails here, so
     the list cannot rot into passing), and the battery must then FAIL at
     the named site(s). A check whose removal no case notices is not
     tested. */
  const MUTANTS = [
    ["choiceImageSrc runs the bare grammar", ["choice"], "&& imageSourceOk(c.image)) ? c.image", "&& CHOICE_IMAGE_RE.test(c.image)) ? c.image"],
    ["figureSrc runs the bare grammar", ["figure"], "&& imageSourceOk(q.figure)) ? q.figure", "&& CHOICE_IMAGE_RE.test(q.figure)) ? q.figure"],
    ["the decodability rule dropped", ["choice", "figure"], "if(pad ? (pad > 2 || n % 4 !== 0) : n % 4 === 1) return false;", ""],
    ["the PNG signature not compared", ["choice", "figure"], 'return b.slice(0, 8) === "\\x89PNG\\r\\n\\x1A\\n";', "return true;"],
    ["the JPEG signature not compared", ["choice", "figure"], 'return b.slice(0, 3) === "\\xFF\\xD8\\xFF";', "return true;"],
    ["the JPEG signature cut to FF D8", ["choice", "figure"], 'return b.slice(0, 3) === "\\xFF\\xD8\\xFF";', 'return b.slice(0, 2) === "\\xFF\\xD8";'],
    ["any SVG root admitted", ["choice", "figure"], "if(!r) return false;", "if(!r) return true;"],
    ["the SVG namespace's value not compared", ["choice", "figure"], 'return v === "http://www.w3.org/2000/svg";', 'return v !== "-";'],
    ["an SVG decoded only as far as a raster's head", ["choice", "figure"], 'type === "svg+xml" ? s.length : off + 12', "off + 12"],
    ["a prefixed root not bound to its own xmlns:prefix", ["choice", "figure"], 'r[1] ? "xmlns:" + r[1] : "xmlns"', '"xmlns"'],
    /* added with the review's fixes (2026-10-18) */
    ["the PNG signature cut to its first 4 bytes", ["choice", "figure"], 'b.slice(0, 8) === "\\x89PNG\\r\\n\\x1A\\n"', 'b.slice(0, 4) === "\\x89PNG"'],
    ["no DOCTYPE admitted", ["choice", "figure"], '"<!DOCTYPE" + S', '"<!NOTYPE" + S'],
    ["no processing instruction admitted", ["choice", "figure"], String.raw`const MISC = "(?:" + S + "|" + COMMENT + "|" + PI + ")*";`, String.raw`const MISC = "(?:" + S + "|" + COMMENT + ")*";`],
    ["character references in the namespace not expanded", ["choice", "figure"], "const v = (a[2] !== undefined ? a[2] : a[3]).replace(", "const v = (a[2] !== undefined ? a[2] : a[3]); void ("],
    /* XML 1.0 exactly (the second review, 2026-10-18): each rule the grammar
       enforces, loosened one at a time, must turn the battery red */
    ["the XML declaration admitted anywhere in the prolog", ["choice", "figure"], String.raw`const MISC = "(?:" + S + "|" + COMMENT + "|" + PI + ")*";`,
      String.raw`const MISC = "(?:" + S + "|" + COMMENT + "|" + PI + "|<\\?xml" + S + "(?:[^?]|\\?(?!>))*\\?>)*";`],
    ["the XML declaration's version not required", ["choice", "figure"], String.raw`"+version" + EQ + "(?:\"1\\.[0-9]+\"|'1\\.[0-9]+')" +`, String.raw`"*" + "(?:[^?]|\\?(?!>))*" +`],
    ["a PI targeted xml (any case) admitted", ["choice", "figure"], "(?![Xx][Mm][Ll](?:", "(?!XML(?:"],
    ["the DOCTYPE's external id not checked", ["choice", "figure"], String.raw`"(?:" + S + "+" + EXTID + ")?"`, String.raw`"(?:[^\\[>\"']|" + LIT + ")*"`],
    ["the internal subset's content not checked", ["choice", "figure"], String.raw`"|%" + NAME + ";|" + DECL + ")*\\]"`, String.raw`"|%" + NAME + ";|" + DECL + "|[^\\]]" + ")*\\]"`],
    ["a comment allowed to hold --", ["choice", "figure"], 'const COMMENT = "<!--(?:[^-]|-[^-])*-->";', String.raw`const COMMENT = "<!--[\\s\\S]*?-->";`],
    ["the prolog and root read case-insensitively", ["choice", "figure"], String.raw`S + "*\\/?>").exec(t);`, String.raw`S + "*\\/?>", "i").exec(t);`],
    ["root attribute values not checked for < and bare &", ["choice", "figure"], String.raw`const VALUE = "(?:\"(?:[^\"<&]|" + REF + ")*\"|'(?:[^'<&]|" + REF + ")*')";`, "const VALUE = LIT;"],
    ["root attribute names not required to be Names", ["choice", "figure"], '"+" + QNAME + EQ + VALUE', String.raw`"+[^ \\t\\r\\n=\\/>\"']+" + EQ + VALUE`],
    ["root attributes need no whitespace between them", ["choice", "figure"], '"):)?svg((?:" + S + "+" + QNAME', '"):)?svg((?:" + S + "*" + QNAME'],
    ["the first xmlns no longer decides", ["choice", "figure"], "if(a[1] !== want) continue;",
      'if(a[1] !== want || (a[2] !== undefined ? a[2] : a[3]) !== "http://www.w3.org/2000/svg") continue;'],
    /* the third review (2026-10-18) */
    ["invalid UTF-8 admitted (a non-fatal decoder)", ["choice", "figure"], 'new TextDecoder("utf-8", { fatal: true })', 'new TextDecoder("utf-8", { fatal: false })'],
    ["characters XML forbids admitted", ["choice", "figure"], String.raw`if(/[\x00-\x08\x0B\x0C\x0E-\x1F￾￿]/.test(t)) return false;`, ""],
    ["numeric references on the root not checked", ["choice", "figure"], "if(!(cp === 9 ||", "if(false && !(cp === 9 ||"],
    ["the declaration's encoding and standalone not checked", ["choice", "figure"],
      String.raw`"(?:" + S + "+standalone" + EQ + "(?:\"(?:yes|no)\"|'(?:yes|no)'))?" + S + "*\\?>"`, String.raw`"(?:[^?]|\\?(?!>))*\\?>"`],
    ["a PI target allowed a colon", ["choice", "figure"], String.raw`"|\\?>))" + NCNAME + "(?:"`, String.raw`"|\\?>))" + NAME + "(?:"`],
    ["root attribute names Names, not QNames", ["choice", "figure"], '"+" + QNAME + EQ + VALUE', '"+" + NAME + EQ + VALUE'],
    ["the declarations' shapes not checked", ["choice", "figure"], 'const DECL = "<!ENTITY" + S + "+(?:%" + S + "+)?" + NAME',
      String.raw`const DECL = "<!(?:ENTITY|ATTLIST|ELEMENT|NOTATION)" + S + "(?:[^>\"']|" + LIT + ")*>|(?!)" + S + "+(?:%" + S + "+)?" + NAME`],
    ["Name classes widened to any non-ASCII", ["choice", "figure"], String.raw`const NCSTART = "A-Za-z_\\u00C0-\\u00D6`, String.raw`const NCSTART = "A-Za-z_\\u0080-\\uFFFF\\u00C0-\\u00D6`]
  ];
  MUTANTS.forEach(([name, sites, needle, repl, count]) => {
    const want = count || 1;
    const fits = appSrc.split(needle).length === want + 1;
    let caught = [];
    if(fits){
      const m = build(appSrc.split(needle).join(repl));
      caught = sites.map(site => battery(m[site]).length);
    }
    check(fits && caught.every(n => n > 0), "MUTANT (" + name + ") fails the battery at " + sites.join(" and "),
      fits ? "battery failures per site: " + caught.join(", ") : "stale mutant: the needle does not occur exactly " + want + " time(s) in " + APP_PATH);
  });
}

console.log(`\n${fail ? "FAIL" : "ALL PASS"} — ${pass} passed, ${fail} failed`);
if(failures.length){ console.log("Failures:"); failures.forEach(f => console.log("  - " + f)); }
process.exit(fail ? 1 : 0);
