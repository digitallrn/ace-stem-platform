/* tests/local-mode.test.js — run: node tests/local-mode.test.js (from the repo root)
   Proves the storage adapter picks the right backend in all four deployment
   permutations. The browser preview pane strips query strings, so the
   ?devstorage=1 cases can only be exercised here. */
const fs = require('fs');
const src = fs.readFileSync('attempts.js','utf8');

function load(search, hasSharedStorage){
  const store = {};
  const sandbox = {
    localStorage: {
      _d:{}, setItem(k,v){this._d[k]=v;}, getItem(k){return k in this._d?this._d[k]:null;},
      removeItem(k){delete this._d[k];}, key(i){return Object.keys(this._d)[i];},
      get length(){return Object.keys(this._d).length;}
    },
    location: { search },
    document: { addEventListener(){}, createElement:()=>({}) },
    navigator: { userAgent:'node' }, screen:{width:1,height:1},
    hasKey:()=>false, answerMatches:()=>false,
    setInterval:()=>0, clearInterval(){}, setTimeout:()=>0,
  };
  sandbox.window = sandbox;
  sandbox.addEventListener = ()=>{};
  if(hasSharedStorage){
    sandbox.storage = {
      async set(k,v){ store[k]=v; return true; },
      async get(k){ return k in store ? {value:store[k]} : null; },
      async list(p){ return {keys:Object.keys(store).filter(k=>k.startsWith(p))}; },
      async delete(k){ delete store[k]; return true; }
    };
  }
  const vm = require('vm');
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  return { AS: sandbox.AttemptStore, sharedStore: store, sandbox };
}

(async () => {
  const cases = [
    ['static host  (no ?flag, no window.storage)', '',               false, true ],
    ['artifact     (no ?flag, window.storage)',    '',               true,  false],
    ['forced local (?devstorage=1, no storage)',   '?devstorage=1',  false, true ],
    ['forced local (?devstorage=1, WITH storage)', '?devstorage=1',  true,  true ],
  ];
  let pass = true;
  for(const [label, search, shared, expectLocal] of cases){
    const { AS, sharedStore, sandbox } = load(search, shared);
    const isLocal = AS.isLocal();
    await AS.set('attempt:probe', {ok:1});
    const readBack = await AS.get('attempt:probe');
    const wentLocal  = Object.keys(sandbox.localStorage._d).some(k=>k.startsWith('devstore:attempt:'));
    const wentShared = Object.keys(sharedStore).length > 0;
    const ok = isLocal === expectLocal && !!readBack &&
               wentLocal === expectLocal && wentShared === !expectLocal;
    if(!ok) pass = false;
    console.log((ok?'PASS':'FAIL'), '|', label.padEnd(44),
      'isLocal='+String(isLocal).padEnd(5),
      'wroteLocal='+String(wentLocal).padEnd(5),
      'wroteShared='+String(wentShared).padEnd(5),
      'readBack='+!!readBack);
  }
  console.log(pass ? '\nALL LOCAL-MODE ADAPTER CASES PASS' : '\nFAILURES PRESENT');
  process.exit(pass?0:1);
})();
