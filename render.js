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
  function renderKatex(tex, display, bigInline){
    if(typeof katex === "undefined"){
      return '<span class="katex-fallback">' + escapeHtml(tex) + '</span>';
    }
    try{
      const src = (!display && bigInline) ? "\\displaystyle " + tex : tex;
      return katex.renderToString(src, { throwOnError:false, displayMode:!!display });
    }catch(e){
      return '<span class="katex-fallback">' + escapeHtml(tex) + '</span>';
    }
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
      if(p.t === "text"){ out += fmtText(p.s); }
      else if(p.t === "void"){ if(p.n === "br") out += "<br>"; }  // {{row}} outside a table: drop
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

  function fmtRenderMath(parts, ptr, name, opts){
    let buf = "";
    while(ptr.i < parts.length){
      const p = parts[ptr.i++];
      if(p.t === "close" && p.n === name) break;
      if(p.t === "text") buf += p.s;
      else buf += "{{" + (p.t === "close" ? "/" : "") + p.n + "}}";  // defensive: keep strays literal
    }
    return renderKatex(buf, name === "mm", !!(opts && opts.bigInline));
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
