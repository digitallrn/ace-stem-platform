function escapeHtml(str){
    const d = document.createElement("div");
    d.textContent = str == null ? "" : String(str);
    return d.innerHTML;
  }

  /* ============ v1.1 rich-text renderer (SCHEMA-v1.1.md §2) ============
     Tokens: {{br}} {{u}}…{{/u}} {{i}}…{{/i}} {{m}}…{{/m}} {{mm}}…{{/mm}}
             {{table}} cells | cells {{row}} … {{/table}}
     Escape-first design: prose is escapeHtml'd, math goes raw to KaTeX
     (KaTeX escapes its own output), tokens become markup. v1.0 data with
     no tokens takes the fast path and renders exactly as before.       */
  const FMT_TOKEN_RE = /\{\{(\/?)(br|u|i|m|mm|table|row)\}\}/g;

  function renderKatex(tex, display){
    if(typeof katex === "undefined"){
      return '<span class="katex-fallback">' + escapeHtml(tex) + '</span>';
    }
    try{
      return katex.renderToString(tex, { throwOnError:false, displayMode:!!display });
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
      const kind = m[1] ? "close" : ((name === "br" || name === "row") ? "void" : "open");
      parts.push({ t:kind, n:name });
      last = FMT_TOKEN_RE.lastIndex;
    }
    if(last < text.length) parts.push({ t:"text", s:text.slice(last) });
    return parts;
  }

  function fmt(text){
    if(text == null) return "";
    text = String(text);
    if(text.indexOf("{{") === -1) return escapeHtml(text);   // fast path, incl. all v1.0 data
    return fmtRenderParts(fmtTokenize(text), { i:0 }, null);
  }

  function fmtRenderParts(parts, ptr, stopName){
    let out = "";
    while(ptr.i < parts.length){
      const p = parts[ptr.i];
      if(p.t === "close"){
        ptr.i++;
        if(p.n === stopName) return out;
        continue;                                            // stray close: ignore
      }
      ptr.i++;
      if(p.t === "text"){ out += escapeHtml(p.s); }
      else if(p.t === "void"){ if(p.n === "br") out += "<br>"; }  // {{row}} outside a table: drop
      else if(p.n === "u"){ out += "<u>" + fmtRenderParts(parts, ptr, "u") + "</u>"; }
      else if(p.n === "i"){ out += "<i>" + fmtRenderParts(parts, ptr, "i") + "</i>"; }
      else if(p.n === "m" || p.n === "mm"){ out += fmtRenderMath(parts, ptr, p.n); }
      else if(p.n === "table"){ out += fmtRenderTable(parts, ptr); }
    }
    return out;
  }

  function fmtRenderMath(parts, ptr, name){
    let buf = "";
    while(ptr.i < parts.length){
      const p = parts[ptr.i++];
      if(p.t === "close" && p.n === name) break;
      if(p.t === "text") buf += p.s;
      else buf += "{{" + (p.t === "close" ? "/" : "") + p.n + "}}";  // defensive: keep strays literal
    }
    return renderKatex(buf, name === "mm");
  }

  function fmtRenderTable(parts, ptr){
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
        "<" + tag + ">" + fmtRenderParts(cellParts, { i:0 }, null).trim() + "</" + tag + ">"
      ).join("") + "</tr>";
    }
    return html + "</table>";
  }
