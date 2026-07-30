/*
 * Circus of Chaos — character storage, behind one interface.
 *
 * A character is saved under a six-digit CODE the player chooses. The code is the whole credential:
 * anyone who knows it can open and overwrite that character. That is by design (no accounts, no
 * passwords, no email) and it is fine for a table of friends — but it is worth knowing that a code
 * is guessable, so this is not a place for anything private.
 *
 * Two backends, chosen automatically by what is filled in in config.js:
 *   cloud  — Firebase Realtime Database or Supabase. Codes work from any device.
 *   local  — this browser's localStorage. Works with zero setup; one device only.
 *
 * Everything here returns a Promise, so the calling code is identical either way and swapping
 * backends never touches the UI.
 */
const CocStore = (() => {
  const cfg = (typeof COC_CONFIG !== "undefined") ? COC_CONFIG : {};
  const LOCAL_PREFIX = "coc:character:";
  const LOCAL_INDEX = "coc:codes";

  const mode = cfg.firebaseUrl ? "firebase"
    : (cfg.supabaseUrl && cfg.supabaseAnonKey) ? "supabase"
    : "local";

  /* ---------- local ---------- */
  const local = {
    async all() {
      const out = {};
      for (const code of await local.list()) out[code] = await local.load(code);
      return out;
    },
    async list() {
      try { return JSON.parse(localStorage.getItem(LOCAL_INDEX) || "[]"); }
      catch { return []; }
    },
    async load(code) {
      const raw = localStorage.getItem(LOCAL_PREFIX + code);
      return raw ? JSON.parse(raw) : null;
    },
    async save(code, character) {
      localStorage.setItem(LOCAL_PREFIX + code, JSON.stringify(character));
      const codes = await local.list();
      if (!codes.includes(code)) {
        codes.push(code);
        localStorage.setItem(LOCAL_INDEX, JSON.stringify(codes.sort()));
      }
      return true;
    },
    async remove(code) {
      localStorage.removeItem(LOCAL_PREFIX + code);
      const codes = (await local.list()).filter((c) => c !== code);
      localStorage.setItem(LOCAL_INDEX, JSON.stringify(codes));
      return true;
    },
  };

  /* ---------- firebase realtime database (REST, no SDK) ---------- */
  const firebase = {
    url(code) { return `${cfg.firebaseUrl.replace(/\/$/, "")}/characters/${code}.json`; },
    async all() {
      const res = await fetch(`${cfg.firebaseUrl.replace(/\/$/, "")}/characters.json`);
      if (!res.ok) throw new Error("cloud read failed: " + res.status);
      return (await res.json()) || {};
    },
    async list() {
      const res = await fetch(`${cfg.firebaseUrl.replace(/\/$/, "")}/characters.json?shallow=true`);
      if (!res.ok) throw new Error("cloud list failed: " + res.status);
      const obj = await res.json();
      return obj ? Object.keys(obj).sort() : [];
    },
    async load(code) {
      const res = await fetch(firebase.url(code) + "?cb=" + Date.now());
      if (!res.ok) throw new Error("cloud load failed: " + res.status);
      return await res.json();
    },
    async save(code, character) {
      const res = await fetch(firebase.url(code), {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(character),
      });
      if (!res.ok) throw new Error("cloud save failed: " + res.status);
      return true;
    },
    async remove(code) {
      const res = await fetch(firebase.url(code), { method: "DELETE" });
      if (!res.ok) throw new Error("cloud delete failed: " + res.status);
      return true;
    },
  };

  /* ---------- supabase (REST) ---------- */
  const supabase = {
    base() { return `${cfg.supabaseUrl.replace(/\/$/, "")}/rest/v1/${cfg.supabaseTable || "characters"}`; },
    headers(extra) {
      return Object.assign({
        "apikey": cfg.supabaseAnonKey,
        "Authorization": "Bearer " + cfg.supabaseAnonKey,
        "Content-Type": "application/json",
      }, extra || {});
    },
    async list() {
      const res = await fetch(`${supabase.base()}?select=code`, { headers: supabase.headers() });
      if (!res.ok) throw new Error("cloud list failed: " + res.status);
      return (await res.json()).map((r) => r.code).sort();
    },
    async load(code) {
      const res = await fetch(`${supabase.base()}?code=eq.${encodeURIComponent(code)}&select=data`,
        { headers: supabase.headers() });
      if (!res.ok) throw new Error("cloud load failed: " + res.status);
      const rows = await res.json();
      return rows.length ? rows[0].data : null;
    },
    async save(code, character) {
      const res = await fetch(supabase.base(), {
        method: "POST",
        headers: supabase.headers({ "Prefer": "resolution=merge-duplicates" }),
        body: JSON.stringify([{ code, data: character }]),
      });
      if (!res.ok) throw new Error("cloud save failed: " + res.status);
      return true;
    },
    async remove(code) {
      const res = await fetch(`${supabase.base()}?code=eq.${encodeURIComponent(code)}`,
        { method: "DELETE", headers: supabase.headers() });
      if (!res.ok) throw new Error("cloud delete failed: " + res.status);
      return true;
    },
  };

  const backend = mode === "firebase" ? firebase : mode === "supabase" ? supabase : local;

  return {
    mode,
    isCloud: mode !== "local",
    /* A code is exactly six digits. Leading zeros are meaningful, so it stays a string. */
    validCode(code) { return /^\d{6}$/.test(String(code || "")); },
    async list() { return backend.list(); },
    async load(code) { return backend.load(code); },
    async save(code, character) { return backend.save(code, character); },
    async remove(code) { return backend.remove(code); },
    /* Every saved character in one call. Used only by the recovery roster. */
    async all() {
      if (backend.all) return backend.all();
      const out = {};
      for (const code of await backend.list()) out[code] = await backend.load(code);
      return out;
    },
    /* True if the code is already taken — the creator refuses to overwrite silently. */
    async taken(code) {
      try { return (await backend.load(code)) != null; }
      catch { return false; }
    },
    describe() {
      return mode === "local"
        ? "Saving to this browser only — add a cloud key in assets/js/config.js to reach your characters from any device."
        : `Saving to the cloud (${mode}) — your code works from any device.`;
    },
  };
})();
