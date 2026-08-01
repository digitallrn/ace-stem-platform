# PHASE-H-SPEC.md — Remote backend (Supabase)

*Drop in the `ace-stem-platform` repo root. Goal: remote assigning and
releasing, and results that reach David without a file handoff. Everything
in Phases A–G stays as-is; this adds a third storage backend behind the
existing adapter interface.*

---

## 1. Principle: local-first, sync second

The remote store is **never** the primary writer. Order of operations for
every write:

1. Write to localStorage (today's local-mode path, unchanged).
2. Enqueue the same write for remote sync.
3. A background syncer drains the queue when online; failures retry with
   backoff and survive reload (queue lives in localStorage).

Consequences to preserve exactly:
- A network failure at any point never blocks, delays, or interrupts a
  student. No await on the network in the test loop.
- A student who goes offline mid-module finishes normally; records land
  when connectivity returns.
- Reads during a sitting come from local. Remote reads happen at sign-in
  (fetch assignments), on dashboard load, and on explicit refresh.

A small sync indicator (e.g. "Synced" / "Syncing…" / "Offline — will sync")
belongs on the home screen and dashboard, replacing the local-mode pill
when a remote backend is configured.

## 2. Backend selection

`attempts.js` gains a third mode alongside artifact-shared and local:

- **remote** — active when Supabase config is present (§6) AND the app is
  not running as a claude.ai artifact.
- Precedence: `?devstorage=1` forces local (unchanged) → artifact
  `window.storage` if present → remote if configured → local otherwise.
- Keep the existing `getResult()` semantics (missing / error / nostorage);
  add `offline` so callers can distinguish "not there" from "can't reach".
  The Phase F fix that refuses to downgrade a proctored test on a failed
  read must remain correct in remote mode — an unreachable server must
  never present a gated test as ungated practice.

## 3. Data model — keep the KV shape

Do **not** normalize into per-field tables in this phase. One table
preserves the adapter interface and therefore every verified behavior from
Phases C–G:

```sql
create table records (
  key         text primary key,       -- 'attempt:...', 'assign:AS-...', 'bug:...'
  owner_code  text,                   -- student code the row belongs to; null for tutor-global
  value       jsonb not null,
  updated_at  timestamptz not null default now()
);
```

Normalizing into real `attempts`/`assignments` tables is a later
optimization, worth doing only if dashboard queries get slow.

**Concurrency win, free:** this is also the moment to fix the
known-limitation clobber from Phase F — write assignments as one row per
assignment (`assign:<CODE>:<assignmentId>`) rather than one array per
student, and have the app list-and-filter by prefix. Update CLAUDE.md's
known-limitations entry when it lands.

## 4. Auth model — be precise about what this does and doesn't protect

**Tutor:** real Supabase Auth (email + password), David only. The dashboard
requires an authenticated session; `acestem-admin` as a magic name goes
away entirely on remote deployments. RLS grants the authenticated role full
read/write on `records`.

**Students:** no accounts (unchanged design). The student code acts as a
bearer secret — the "unguessable link" model. This requires two changes:

- **Codes get real entropy.** `AS-` + 8 random characters from an
  unambiguous alphabet (no O/0/I/1), e.g. `AS-7K4M9PXR`. Update the §7
  sign-in validation. Display in groups if it helps students type it.
- **Students never query the table directly.** All student access goes
  through Postgres RPC functions that take the code as an argument:
  `fn_get_assignments(code)`, `fn_upsert_attempt(code, key, value)`,
  `fn_get_own_attempts(code)`, `fn_insert_bug(code, value)`. The anon role
  gets EXECUTE on those functions and **no table privileges at all**. RLS
  on, no anon policies.

Honest limits to write into CLAUDE.md: a leaked code exposes that one
student's records; codes are typed by students so they can be shared;
there is no rate limiting in this phase. The upgrade path if it ever
matters is per-student magic-link auth.

## 5. Remote assigning and releasing (the point of this phase)

- Dashboard assignment creation writes to remote; a student's device picks
  it up at next sign-in. The Assign panel shows sync state per row.
- The `released` flag moves remote. Releasing from the dashboard makes
  Score Details appear on the student's device at next sign-in or refresh —
  no file exchange anywhere in the flow.
- Bug reports sync remotely so the dashboard inbox works across devices.
- **Local mode's Download Results JSON stays** as a fallback for offline or
  unconfigured deployments; it just stops being the primary path. Archive
  export and the download-before-delete rule are unchanged and still the
  backup of record.

## 6. Configuration and secrets

- A `config.js` (gitignored) or Netlify environment injection supplies
  `SUPABASE_URL` and `SUPABASE_ANON_KEY`. The anon key is public by design —
  that is safe *only* because §4 gives anon no table privileges.
- The **service role key must never appear in the repo, the build, or the
  browser.** Nowhere in this codebase.
- Ship `config.example.js` and document setup in SETUP.md so a fresh clone
  is reproducible.

## 7. Migration

A one-time dashboard action: "Upload local records to server" — reads this
device's localStorage records and syncs them, skipping keys that already
exist remotely. Needed so nothing recorded during local-mode use is
stranded.

## 8. Verification requirements

Beyond the usual dist pass and per-file `node --check`:

- **Offline resilience:** complete a full module with the network blocked;
  confirm zero interruption, then restore the network and confirm the queue
  drains and the record appears remotely.
- **Cross-device:** assign on device A, sign in on device B, take the test,
  release from A, confirm Score Details appears on B.
- **Anon privilege:** confirm from the browser console that the anon key
  cannot select, insert, update, or delete `records` directly — only the
  RPCs work.
- **Cross-student read:** confirm one student's code cannot fetch another's
  attempts through any RPC.
- Re-run `tests/injection-proof.js` — remote values reach the same render
  surfaces and the escaping contract must still hold.
- Re-run `tests/local-mode.test.js` and add remote/offline permutations.
