/* tests/viewer-proof-mutants.js — run: node tests/viewer-proof-mutants.js
   (from the repo root). Not a suite: it BUILDS the targets the browser proof
   (tests/viewer-proof.js) is run against, under dist/viewer-mutants/<name>/
   (dist/ is gitignored, so nothing here can ship).

   "local" is the REAL app with no config.js — the split build in true local
   mode, where the full walk + recorder leg runs over the network path.
   Every other target is that build with ONE guard taken away; the proof run
   against it must go RED on the check named below (a proof that cannot fail
   proves nothing). Serve the repo root (launch.json "repo-preview", :8930)
   and open http://localhost:8930/dist/viewer-mutants/<name>/<query>; a second
   origin for parallel runs is http://127.0.0.1:8930/... (its own storage).

     target     query          must turn red
     local      ?devstorage=1  (nothing — this is the real build)
     cache      ?devstorage=1  "ZERO storage write calls" (the viewer loads
                               through the sitting's caching loadTest)
     nodetach   ?devstorage=1  "...let go before the viewer opened", "ZERO
                               storage write calls", "byte-identical" (the
                               student's record rebuilt from the viewer's
                               state by the forced tab-hide). Both detaches
                               are removed — the tutor's entry and the
                               viewer's open — since either alone holds.
     dashopen   (none: remote) "ZERO storage write calls", "not one server
                               call" (leaving reloads the dashboard: a pull)
     bugreport  ?devstorage=1  the walk: "header tools" (Report a bug shown)
     keyleak    ?devstorage=1  the walk: "a key leaked with answers OFF"
     authopen   ?devstorage=1  "Opening is authorised exactly when ..." (a
                               server deployment's password-free local
                               dashboard opens the viewer)
     handlers   ?devstorage=1  the walk: "a click selected, flagged, ..." (the
                               sitting's controls the viewer shows get their
                               handlers — the inertness probe must see it)
     noforget   ?devstorage=1  not the proof: the reload demonstration — a
                               remembered student code with a crash
                               checkpoint, tutor sign-in, viewer, reload:
                               the real build lands on sign-in, this one
                               crash-resumes the student's sitting.

   Each replacement must match exactly once, or the build stops and names
   the needle: a control whose guard moved must be re-aimed, not skipped. */
"use strict";
const fs = require("fs");
const path = require("path");
const repo = path.join(__dirname, "..");
const out = path.join(repo, "dist", "viewer-mutants");
const app = fs.readFileSync(path.join(repo, "app.js"), "utf8");
const NL = app.indexOf("\r\n") !== -1 ? "\r\n" : "\n";
const L = s => s.split("\n").join(NL);

const TARGETS = {
  local: { edits: [] },
  cache: { edits: [["      test = await loadTestReadOnly(entry);", "      test = await loadTest(entry);"]] },
  /* both detaches go: the tutor's entry now lets the recorder go first, and
     the viewer's own detach is the second layer — removing either alone
     leaves the other holding, so the control removes the pair */
  nodetach: { edits: [[L("    await Attempts.detach();\n    if(gen !== state.sessionGen){ restoreMemory(memo, test); return; }\n    const standIn"),
                       L("    const standIn")],
                      ["    try{ await Attempts.detach(); }catch(e){}    // while currentTest is still set, as endDeletedSession does", ""]] },
  dashopen: { config: true, edits: [[L("    showOnly(\"screen-dashboard\");\n    // the Tests tab picks up where it left off"),
                                     L("    Dashboard.open(showOnly);\n    // the Tests tab picks up where it left off")]] },
  bugreport: { edits: [[L("      el(\"miBugReport\").classList.add(\"hidden\");\n"), ""]] },
  keyleak: { edits: [["    const keyShown = !viewer || viewerShowAnswers;", "    const keyShown = true;"]] },
  noforget: { edits: [[L("    try{ if(localStorage.getItem(SESSION_KEY) !== null) forgetSession(); }catch(e){}\n"), ""]] },
  /* review's second layer gone: the sitting's controls the viewer shows get
     their handlers, so a click flags or marks an answer */
  handlers: { edits: [[L("       it do anything. */\n    if(state.reviewMode) return;\n"), L("       it do anything. */\n")]] },
  authopen: { config: true, edits: [["    return !AttemptStore.remoteConfigured() || AttemptStore.hasAuthToken();", "    return true;"]] }
};

const COPY = ["index.html", "404.html", "styles.css", "render.js", "grading.js", "attempts.js", "dashboard.js", "skilldomains.js"];
if(Object.values(TARGETS).some(t => t.config) && !fs.existsSync(path.join(repo, "config.js")))
  throw new Error("the remote targets need the repo-root config.js (gitignored; any non-production stub will do)");
for(const [name, t] of Object.entries(TARGETS)){
  const dir = path.join(out, name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, "testdata", "archive"), { recursive: true });
  COPY.forEach(f => fs.copyFileSync(path.join(repo, f), path.join(dir, f)));
  if(t.config) fs.copyFileSync(path.join(repo, "config.js"), path.join(dir, "config.js"));
  fs.readdirSync(path.join(repo, "testdata")).filter(f => f.endsWith(".js"))
    .forEach(f => fs.copyFileSync(path.join(repo, "testdata", f), path.join(dir, "testdata", f)));
  fs.copyFileSync(path.join(repo, "testdata", "archive", "index.js"), path.join(dir, "testdata", "archive", "index.js"));
  let src = app;
  for(const [a, b] of t.edits){
    const n = src.split(a).length - 1;
    if(n !== 1) throw new Error(name + ": needle occurs " + n + " times: " + a.slice(0, 70));
    src = src.replace(a, b);
  }
  fs.writeFileSync(path.join(dir, "app.js"), src);
  console.log("built", name, t.config ? "(with config.js)" : "(no config.js)");
}
