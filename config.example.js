/* config.example.js — copy to config.js and fill in (config.js is gitignored).
 *
 * Supplies the Supabase project this deployment talks to. Without a config.js
 * the app simply runs in local mode, exactly as it did before Phase H — so a
 * fresh clone works with no setup at all.
 *
 * The ANON key is public by design: it is safe to ship to the browser ONLY
 * because supabase/schema.sql gives the anon role no table privileges, just
 * EXECUTE on four functions that scope every row to the student code passed
 * in. See PHASE-H-SPEC §4.
 *
 * NEVER put the service_role key here (or anywhere else in this repo). It
 * bypasses RLS entirely.
 */
window.ACESTEM_CONFIG = {
  SUPABASE_URL: "https://YOUR-PROJECT-REF.supabase.co",
  SUPABASE_ANON_KEY: "YOUR-ANON-KEY"
};
