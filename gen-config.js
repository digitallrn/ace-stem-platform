#!/usr/bin/env node
/* gen-config.js — writes config.js at build time from environment variables.
 *
 * WHY THIS EXISTS
 * config.js holds the Supabase URL + publishable key and is gitignored, so a
 * Netlify deploy has no config.js in the checkout. Without this step the live
 * site would come up in LOCAL mode and silently record to each browser instead
 * of syncing — the failure is invisible until someone notices results never
 * reach the dashboard. So: generate it from env vars, and if the env is not
 * set up, FAIL THE BUILD rather than deploy a config-less site.
 *
 * Written in Node (not Python like assemble.py) because this one runs inside
 * Netlify's build image, where Node is guaranteed.
 *
 * Environment variables (set in Netlify → Site settings → Environment):
 *   SUPABASE_URL              https://<ref>.supabase.co
 *   SUPABASE_PUBLISHABLE_KEY  sb_publishable_...   (or SUPABASE_ANON_KEY for a
 *                                                   legacy JWT anon key)
 *
 * Deliberately never prints the key — Netlify build logs are retained.
 *
 * If you WANT a local-mode static deploy, delete the [build] section from
 * netlify.toml. There is no env flag to skip this check, because the whole
 * point is that a misconfigured environment can't quietly ship local mode.
 */
"use strict";
const fs = require("fs");

const URL_ENV = "SUPABASE_URL";
const KEY_ENVS = ["SUPABASE_PUBLISHABLE_KEY", "SUPABASE_ANON_KEY"];

function die(lines){
  console.error("\n=====================================================");
  console.error(" BUILD FAILED — Supabase configuration is not usable");
  console.error("=====================================================");
  lines.forEach(l => console.error(" " + l));
  console.error(
    "\n Fix: Netlify → Site configuration → Environment variables, set" +
    "\n   " + URL_ENV + "              = https://<your-ref>.supabase.co" +
    "\n   " + KEY_ENVS[0] + "  = sb_publishable_..." +
    "\n then redeploy. See SETUP.md → 'Remote backend (Supabase)'." +
    "\n\n Deploying without these would silently run the live site in LOCAL" +
    "\n mode, where results never reach the dashboard.\n");
  process.exit(1);
}

const url = (process.env[URL_ENV] || "").trim();
let key = "", keyEnv = null;
for(const name of KEY_ENVS){
  const v = (process.env[name] || "").trim();
  if(v){ key = v; keyEnv = name; break; }
}

/* --- presence --- */
const missing = [];
if(!url) missing.push(URL_ENV);
if(!key) missing.push(KEY_ENVS.join(" or "));
if(missing.length) die(["Missing environment variable(s): " + missing.join(", ")]);

/* --- not the template placeholders --- */
if(url.indexOf("YOUR-") !== -1 || key.indexOf("YOUR-") !== -1){
  die(["The values still contain the config.example.js placeholder text (\"YOUR-\").",
       "Set the real project URL and key."]);
}

/* --- URL shape: a typo here breaks remote mode in a way that looks like
       'the backend is down' rather than 'the build is wrong' --- */
if(!/^https:\/\/[a-z0-9-]+\.supabase\.co\/?$/i.test(url)){
  die([URL_ENV + " does not look like a Supabase project URL.",
       "Expected: https://<ref>.supabase.co",
       "Got:      " + url]);
}

/* --- refuse to publish a SECRET key to the browser ---
   The publishable/anon key is public by design and safe only because anon has
   no table privileges. A service_role/secret key bypasses RLS entirely, so
   shipping one to the browser would expose every student's records. */
if(/^sb_secret_/i.test(key)){
  die(["That is a Supabase SECRET key (sb_secret_...). It bypasses RLS and must",
       "never reach a browser. Use the PUBLISHABLE key (sb_publishable_...)."]);
}
if(/^eyJ/.test(key)){                       // legacy JWT — check its role claim
  try{
    const part = key.split(".")[1] || "";
    const json = Buffer.from(part.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    if(/"role"\s*:\s*"service_role"/.test(json)){
      die(["That is a service_role key. It bypasses RLS and must never reach a",
           "browser. Use the anon (or publishable) key instead."]);
    }
  }catch(e){ /* unparseable JWT: fall through, the app will surface auth errors */ }
}

/* --- write --- */
const body =
  "/* GENERATED AT BUILD TIME by gen-config.js — do not edit, do not commit. */\n" +
  "window.ACESTEM_CONFIG = " + JSON.stringify({
    SUPABASE_URL: url.replace(/\/+$/, ""),
    SUPABASE_ANON_KEY: key
  }, null, 2) + ";\n";

fs.writeFileSync("config.js", body, "utf8");

const masked = key.length > 12 ? key.slice(0, 8) + "…" + key.slice(-4) : "(short)";
console.log("gen-config.js: wrote config.js");
console.log("  " + URL_ENV + " = " + url);
console.log("  key from " + keyEnv + " = " + masked + " (" + key.length + " chars)");
console.log("  -> the deployed site will run in REMOTE mode.");
