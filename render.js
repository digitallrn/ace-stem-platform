function escapeHtml(str){
    /* Escapes quotes as well as &<> — callers interpolate into attribute
       values (dashboard data-* hooks), where the DOM textContent trick's
       unescaped quotes let storage-controlled strings break out of the
       attribute and plant handlers. */
    return String(str == null ? "" : str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  /* ============ v1.1 rich-text renderer (SCHEMA-v1.2.md §2) ============
     Tokens: {{br}} {{u}}…{{/u}} {{i}}…{{/i}} {{m}}…{{/m}} {{mm}}…{{/mm}}
             {{table}} cells | cells {{row}} … {{/table}}
             {{bullets}} item {{item}} item {{/bullets}}   (reference 34)
             {{quote}}…{{/quote}}  {{credit}}…{{/credit}}  (reference 31)
             {{tnote}}…{{/tnote}}  — a source/units note that belongs to the
             table immediately above it: smaller, tucked close, no gap.
     Escape-first design: prose is escapeHtml'd, math goes raw to KaTeX
     (KaTeX escapes its own output), tokens become markup. v1.0 data with
     no tokens takes the fast path and renders exactly as before.
     {{bullets}}/{{item}} deliberately mirror the {{table}}/{{row}} grammar:
     a paired container with a void separator, so the tokenizer and the
     converter's validation rules need no new shape. A name this table does
     not list stays literal text and is escaped — old data is unaffected. */
  const FMT_TOKEN_RE = /\{\{(\/?)(br|u|i|m|mm|table|row|bullets|item|quote|credit|tnote)\}\}/g;

  /* `bigInline` renders inline math in display STYLE without turning it into a
     block: KaTeX's text style shrinks a \frac's numerator and denominator, so a
     stacked fraction in an answer choice came out visibly squashed next to the
     same fraction in the stem. \displaystyle restores full height and leaves it
     inline. Opt-in per call site — prose keeps text style, or every fraction in
     a sentence would blow the line height apart. */
  /* Inline math immediately before punctuation ("…{{m}}x{{/m}},") showed a
     visible gap — "x ," instead of "x,". It is NOT a space in the data (audited:
     zero literal spaces between {{/m}} and punctuation); it is KaTeX's italic
     correction, a `margin-right` it bakes onto the trailing italic glyph so a
     slanted letter doesn't collide with what follows. That overhang reads as an
     unwanted gap before an upright comma/period. When `hugRight` is set we strip
     that one trailing margin so the punctuation hugs the letter. Display math
     ({{mm}}) is never hugged — it sits on its own line. */
  function stripTrailingItalicCorrection(html){
    if(typeof document === "undefined") return html;   // node/fallback: no DOM
    try{
      const tpl = document.createElement("template");
      tpl.innerHTML = html;
      const htmlPart = tpl.content.querySelector(".katex-html");
      if(htmlPart){
        const bases = htmlPart.querySelectorAll(".base");
        const lastBase = bases[bases.length - 1];
        const last = lastBase && lastBase.lastElementChild;
        if(last && last.style && parseFloat(last.style.marginRight)) last.style.marginRight = "0px";
      }
      return tpl.innerHTML;
    }catch(e){ return html; }
  }

  function renderKatex(tex, display, bigInline, hugRight){
    if(typeof katex === "undefined"){
      return '<span class="katex-fallback">' + escapeHtml(tex) + '</span>';
    }
    try{
      const src = (!display && bigInline) ? "\\displaystyle " + tex : tex;
      let html = katex.renderToString(src, { throwOnError:false, displayMode:!!display });
      if(hugRight && !display) html = stripTrailingItalicCorrection(html);
      return html;
    }catch(e){
      return '<span class="katex-fallback">' + escapeHtml(tex) + '</span>';
    }
  }

  /* ---- caption / paired-passage detection (reference: real Bluebook) ----
     Both are recognised generically from the token stream, so they apply
     retroactively to every shipped table and paired passage, not a hardcoded
     list. */

  /* A short title-case run immediately before {{table}} is the table's caption
     (styled bold + centred above it), NOT body prose. The discriminators, in
     the order they reject: a trailing sentence mark (a period-ended run is an
     intro sentence — "…types of blocks in each set." — not a title), excessive
     length, and a failing title-case ratio (a running-prose lead-in like "the
     table below shows the results" has almost no capitalised significant
     words). Live captions this accepts: "Average DOC and TDN Concentrations in
     Rainwater Samples", "Estimated Annual Costs and Profits for Biofuel Profit
     Models (in dollars)", "Number of Days to Construct Modular Retail
     Facilities". */
  const CAP_SMALL = /^(a|an|and|the|of|to|in|on|for|per|by|or|vs|with|from|at|as)$/i;
  function isTableCaption(raw){
    const s = String(raw == null ? "" : raw).trim();
    if(!s || s.length > 120) return false;
    if(/[.!?:]$/.test(s)) return false;                       // ends like a sentence/intro
    const words = s.split(/\s+/).filter(w => /[A-Za-z]/.test(w));
    const sig = words.filter(w => !CAP_SMALL.test(w.replace(/[^A-Za-z]/g, "")));
    if(!sig.length) return false;
    const capped = sig.filter(w => /^[^A-Za-z]*[A-Z0-9]/.test(w)).length;
    return capped / sig.length >= 0.6;                        // "generally title case"
  }

  /* "Text 1" / "Text 2" paired-passage labels — styled as headers with clear
     vertical separation, matching Bluebook's paired-passage layout. */
  function isPassageLabel(raw){ return /^Text\s+\d+$/.test(String(raw == null ? "" : raw).trim()); }
  /* skipping only {{br}} voids from index i, is the next part a passage label? */
  function labelFollows(parts, i){
    while(i < parts.length && parts[i].t === "void" && parts[i].n === "br") i++;
    return i < parts.length && parts[i].t === "text" && isPassageLabel(parts[i].s);
  }
  /* Is this text run a caption — i.e. does a {{table}} follow it across only
     {{br}}s, and does the run read as a title? */
  function labelIsCaptionBeforeTable(parts, i, raw){
    let j = i;
    while(j < parts.length && parts[j].t === "void" && parts[j].n === "br") j++;
    return j < parts.length && parts[j].t === "open" && parts[j].n === "table" && isTableCaption(raw);
  }

  function fmtTokenize(text){
    const parts = [];
    let last = 0, m;
    FMT_TOKEN_RE.lastIndex = 0;
    while((m = FMT_TOKEN_RE.exec(text)) !== null){
      if(m.index > last) parts.push({ t:"text", s:text.slice(last, m.index) });
      const name = m[2];
      const kind = m[1] ? "close"
        : ((name === "br" || name === "row" || name === "item") ? "void" : "open");
      parts.push({ t:kind, n:name });
      last = FMT_TOKEN_RE.lastIndex;
    }
    if(last < text.length) parts.push({ t:"text", s:text.slice(last) });
    return parts;
  }

  /* Fill-in blanks. Source data writes them as a run of underscores, and how
     many varies question to question, so the printed blank used to be a
     different length on every item. Any run of 3+ becomes one fixed-width
     rule (52px, measured from reference/bluebook-screenshots/33), which is
     what the real app shows regardless of the underlying text.
     Escape FIRST, substitute after: the input is already-escaped text, and
     "_" is not an HTML metacharacter, so no payload can reach the markup
     through this path. Two underscores or fewer are left alone — those are
     ordinary text (snake_case in a formula, say), not a blank.
     Never applied inside {{m}}/{{mm}}: math text is collected by
     fmtRenderMath and handed to KaTeX raw, where "_" means a subscript. */
  const BLANK_RE = /_{3,}/g;
  const BLANK_HTML = '<span class="fmt-blank" aria-label="blank"></span>';
  function fmtText(s){ return escapeHtml(s).replace(BLANK_RE, BLANK_HTML); }

  /* opts.bigInline — render inline {{m}} in display style. Callers that show
     math on its own line (answer choices) pass it; prose does not. */
  function fmt(text, opts){
    if(text == null) return "";
    text = String(text);
    if(text.indexOf("{{") === -1) return fmtText(text);      // fast path, incl. all v1.0 data
    return fmtRenderParts(fmtTokenize(text), { i:0 }, null, opts || {});
  }

  function fmtRenderParts(parts, ptr, stopName, opts){
    opts = opts || {};
    let out = "";
    while(ptr.i < parts.length){
      const p = parts[ptr.i];
      if(p.t === "close"){
        ptr.i++;
        if(p.n === stopName) return out;
        continue;                                            // stray close: ignore
      }
      ptr.i++;
      if(p.t === "text"){
        // paired-passage label: render as a header and swallow the {{br}}s that
        // follow it, so the header sits directly above its passage body
        if(isPassageLabel(p.s)){
          out += '<div class="fmt-passage-label">' + fmtText(p.s.trim()) + '</div>';
          while(ptr.i < parts.length && parts[ptr.i].t === "void" && parts[ptr.i].n === "br") ptr.i++;
          continue;
        }
        // table caption: a title-case run right before {{table}} — style it and
        // swallow the intervening {{br}}s so it sits as the table's title
        if(labelIsCaptionBeforeTable(parts, ptr.i, p.s)){
          out += '<div class="fmt-caption">' + fmtText(p.s.trim()) + '</div>';
          while(ptr.i < parts.length && parts[ptr.i].t === "void" && parts[ptr.i].n === "br") ptr.i++;
          continue;
        }
        out += fmtText(p.s);
      }
      else if(p.t === "void"){
        // {{row}} outside a table: drop. A {{br}} that only leads into a passage
        // label is dropped too — the label's own margin is the separator, so we
        // don't stack blank lines before it as well.
        if(p.n === "br" && !labelFollows(parts, ptr.i)) out += "<br>";
      }
      else if(p.n === "u"){ out += "<u>" + fmtRenderParts(parts, ptr, "u", opts) + "</u>"; }
      else if(p.n === "i"){ out += "<i>" + fmtRenderParts(parts, ptr, "i", opts) + "</i>"; }
      else if(p.n === "m" || p.n === "mm"){ out += fmtRenderMath(parts, ptr, p.n, opts); }
      else if(p.n === "table"){ out += fmtRenderTable(parts, ptr, opts); }
      else if(p.n === "bullets"){ out += fmtRenderBullets(parts, ptr, opts); }
      else if(p.n === "quote"){ out += '<div class="fmt-quote">' + fmtRenderParts(parts, ptr, "quote", opts) + "</div>"; }
      else if(p.n === "credit"){ out += '<div class="fmt-credit">' + fmtRenderParts(parts, ptr, "credit", opts) + "</div>"; }
      else if(p.n === "tnote"){ out += '<div class="fmt-tnote">' + fmtRenderParts(parts, ptr, "tnote", opts) + "</div>"; }
    }
    return out;
  }

  // inline math whose next part begins with punctuation should hug it (strip
  // KaTeX's trailing italic correction). No LEADING space in the next part — a
  // space there is intentional and must be preserved.
  const HUG_PUNCT_RE = /^[,.;:!?)\]]/;
  function fmtRenderMath(parts, ptr, name, opts){
    let buf = "";
    while(ptr.i < parts.length){
      const p = parts[ptr.i++];
      if(p.t === "close" && p.n === name) break;
      if(p.t === "text") buf += p.s;
      else buf += "{{" + (p.t === "close" ? "/" : "") + p.n + "}}";  // defensive: keep strays literal
    }
    let hug = false;
    if(name === "m"){                                         // inline only
      const nx = parts[ptr.i];                               // part just after {{/m}}
      if(nx && nx.t === "text" && HUG_PUNCT_RE.test(nx.s)) hug = true;
    }
    return renderKatex(buf, name === "mm", !!(opts && opts.bigInline), hug);
  }

  /* {{bullets}} a {{item}} b {{/bullets}} — same shape as fmtRenderTable, one
     level simpler: {{item}} splits, everything else flows through so u/i/math
     render inside a bullet. Unlike the table there is no '|' cell delimiter,
     so math needs no special-casing here. Empty items are dropped, which is
     what makes a trailing "{{item}}{{/bullets}}" harmless. */
  function fmtRenderBullets(parts, ptr, opts){
    const items = [[]];
    while(ptr.i < parts.length){
      const p = parts[ptr.i];
      if(p.t === "close" && p.n === "bullets"){ ptr.i++; break; }
      ptr.i++;
      if(p.t === "void" && p.n === "item"){ items.push([]); continue; }
      items[items.length - 1].push(p);
    }
    const lis = items
      .map(ip => fmtRenderParts(ip, { i:0 }, null, opts).trim())
      .filter(s => s !== "");
    if(!lis.length) return "";
    return '<ul class="fmt-bullets"><li>' + lis.join("</li><li>") + "</li></ul>";
  }

  function fmtRenderTable(parts, ptr, opts){
    const rows = [[[]]];                                     // rows → cells → part arrays
    const curRow = () => rows[rows.length - 1];
    const curCell = () => { const r = curRow(); return r[r.length - 1]; };
    while(ptr.i < parts.length){
      const p = parts[ptr.i];
      if(p.t === "close" && p.n === "table"){ ptr.i++; break; }
      ptr.i++;
      if(p.t === "void" && p.n === "row"){ rows.push([[]]); continue; }
      if(p.t === "text"){
        const frags = p.s.split("|");                        // '|' splits cells…
        curCell().push({ t:"text", s:frags[0] });
        for(let k = 1; k < frags.length; k++) curRow().push([{ t:"text", s:frags[k] }]);
        continue;
      }
      if(p.t === "open" && (p.n === "m" || p.n === "mm")){   // …but never inside math (|x|)
        const cellArr = curCell();
        cellArr.push(p);
        while(ptr.i < parts.length){
          const q2 = parts[ptr.i++];
          cellArr.push(q2);
          if(q2.t === "close" && q2.n === p.n) break;
        }
        continue;
      }
      curCell().push(p);                                     // u/i opens & closes flow through
    }
    let html = '<table class="fmt-table">';
    for(let r = 0; r < rows.length; r++){
      const tag = r === 0 ? "th" : "td";
      html += "<tr>" + rows[r].map(cellParts =>
        "<" + tag + ">" + fmtRenderParts(cellParts, { i:0 }, null, opts).trim() + "</" + tag + ">"
      ).join("") + "</tr>";
    }
    return html + "</table>";
  }
