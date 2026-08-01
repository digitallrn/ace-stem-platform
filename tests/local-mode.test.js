/* tests/local-mode.test.js — run: node tests/local-mode.test.js (from the repo root)
   Proves the storage adapter picks the right backend in every deployment
   permutation, and that remote mode is local-first: a write lands in
   localStorage immediately and is queued for sync rather than awaited.
   The browser preview pane strips query strings, so the ?devstorage=1 cases
   can only be exercised here. */
const fs = require('fs');
const vm = require('vm');
const src = fs.readFileSync('attempts.js', 'utf8');

function load(opts){
  const store = {};                       // stands in for artifact shared storage
  const sandbox = {
    localStorage: {
      _d: {}, setItem(k, v){ this._d[k] = v; },
      getItem(k){ return k in this._d ? this._d[k] : null; },
      removeItem(k){ delete this._d[k]; },
      key(i){ return Object.keys(this._d)[i]; },
      get length(){ return Object.keys(this._d).length; }
    },
    location: { search: opts.search || '' },
    document: { addEventListener(){}, createElement: () => ({}) },
    navigator: { userAgent: 'node', onLine: opts.online !== false },
    screen: { width: 1, height: 1 },
    hasKey: () => false, answerMatches: () => false,
    setInterval: () => 0, clearInterval(){}, setTimeout: () => 0, clearTimeout(){},
    fetch: () => Promise.reject(new Error('network blocked in test'))
  };
  sandbox.window = sandbox;
  sandbox.addEventListener = () => {};
  if(opts.config) sandbox.ACESTEM_CONFIG = opts.config;
  if(opts.sharedStorage){
    sandbox.storage = {
      async set(k, v){ store[k] = v; return true; },
      async get(k){ return k in store ? { value: store[k] } : null; },
      async list(p){ return { keys: Object.keys(store).filter(k => k.startsWith(p)) }; },
      async delete(k){ delete store[k]; return true; }
    };
  }
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  return { AS: sandbox.AttemptStore, sharedStore: store, sandbox };
}

const REAL_CFG = { SUPABASE_URL: 'https://example-ref.supabase.co', SUPABASE_ANON_KEY: 'sb_publishable_testkey' };
const STUB_CFG = { SUPABASE_URL: 'https://YOUR-PROJECT-REF.supabase.co', SUPABASE_ANON_KEY: 'YOUR-ANON-KEY' };
const CODE = 'AS-7K4M9PXR';

(async () => {
  let pass = true;
  const check = (ok, label, detail) => {
    if(!ok) pass = false;
    console.log((ok ? 'PASS' : 'FAIL') + ' | ' + label.padEnd(52) + (detail || ''));
  };

  // ---- mode resolution across every permutation ----
  const modes = [
    ['static host  (no flag, no storage, no config)', {},                                              'local'],
    ['artifact     (window.storage present)',         { sharedStorage: true },                          'artifact'],
    ['forced local (?devstorage=1)',                  { search: '?devstorage=1' },                      'local'],
    ['forced local (?devstorage=1 + storage)',        { search: '?devstorage=1', sharedStorage: true }, 'local'],
    ['remote       (config, no window.storage)',      { config: REAL_CFG },                             'remote'],
    ['artifact wins over remote',                     { config: REAL_CFG, sharedStorage: true },        'artifact'],
    ['forced local wins over remote',                 { search: '?devstorage=1', config: REAL_CFG },    'local'],
    ['unfilled config template is not remote',        { config: STUB_CFG },                             'local'],
  ];
  for(const [label, opts, expect] of modes){
    const { AS } = load(opts);
    check(AS.mode() === expect, label, 'mode=' + AS.mode());
  }

  // ---- backend routing still correct ----
  {
    const { AS, sandbox, sharedStore } = load({ sharedStorage: true });
    await AS.set('attempt:t:0:zzzz', { student: { code: CODE, key: CODE } });
    check(Object.keys(sharedStore).length === 1 &&
          !sandbox.localStorage._d['devstore:attempt:t:0:zzzz'],
      'artifact: writes go to shared storage, not localStorage');
  }

  // ---- local-first write behaviour (spec §1) ----
  {
    const { AS, sandbox } = load({ config: REAL_CFG });
    const rec = { student: { code: CODE, key: CODE }, status: 'in-progress' };
    const ok = await AS.set('attempt:t:1:aaaa', rec);
    const wroteLocal = !!sandbox.localStorage._d['devstore:attempt:t:1:aaaa'];
    const queue = JSON.parse(sandbox.localStorage._d['devstore:__syncqueue'] || '[]');
    check(ok && wroteLocal, 'remote: write lands in localStorage immediately');
    check(queue.length === 1 && queue[0].kind === 'attempt' && queue[0].code === CODE,
      'remote: same write is queued for sync', 'queued=' + queue.length);
    // fetch is hard-rejected in this sandbox and the write still succeeded —
    // that is the whole local-first guarantee
    check(ok === true, 'remote: blocked network does not fail the write');
    const back = await AS.get('attempt:t:1:aaaa');
    check(back && back.status === 'in-progress', 'remote: reads come from local, not the network');
    // setLocal must NOT enqueue (used for rows pulled down from the server)
    await AS.setLocal('attempt:t:2:bbbb', rec);
    const q2 = JSON.parse(sandbox.localStorage._d['devstore:__syncqueue'] || '[]');
    check(q2.length === 1, 'remote: setLocal does not enqueue (no sync loop)', 'queued=' + q2.length);
  }

  // ---- queue is durable + deduped per key ----
  {
    const { AS, sandbox } = load({ config: REAL_CFG });
    await AS.set('attempt:t:3:cccc', { student: { code: CODE, key: CODE }, v: 1 });
    await AS.set('attempt:t:3:cccc', { student: { code: CODE, key: CODE }, v: 2 });
    const q = JSON.parse(sandbox.localStorage._d['devstore:__syncqueue'] || '[]');
    check(q.length === 1 && q[0].value.v === 2,
      'remote: re-writing a key supersedes its queue entry', 'queued=' + q.length);
    check(!!sandbox.localStorage._d['devstore:__syncqueue'],
      'remote: queue persisted in localStorage (survives reload)');
  }

  // ---- offline flag respected ----
  {
    const { AS } = load({ config: REAL_CFG, online: false });
    const s = AS.syncState();
    check(s.online === false, 'remote: syncState reports offline');
  }

  // ---- local mode never queues ----
  {
    const { AS, sandbox } = load({});
    await AS.set('attempt:t:4:dddd', { student: { code: CODE, key: CODE } });
    check(!sandbox.localStorage._d['devstore:__syncqueue'], 'local: nothing is queued for sync');
  }

  // ---- student code entropy (spec §4) ----
  {
    const { sandbox } = load({});
    const SC = sandbox.StudentCode;
    check(SC.valid(CODE), 'code: 8-char code accepted');
    check(!SC.valid('AS-1234'), 'code: old 4-char code rejected');
    check(!SC.valid('AS-7K4M9PX0') && !SC.valid('AS-7K4M9PXO'), 'code: ambiguous 0/O rejected');
    const gen = SC.generate();
    check(SC.valid(gen), 'code: generate() produces a valid code', gen);
  }

  console.log(pass ? '\nALL ADAPTER + SYNC CASES PASS' : '\nFAILURES PRESENT');
  process.exit(pass ? 0 : 1);
})();
