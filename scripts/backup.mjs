// Take everything out of the live database and put it in a file. Run: npm run backup
//
// Kayki's one hard condition on changing anything: the data survives. So this exists before any of it —
// every character and every table, as JSON, timestamped, on his disk. It reads through the same REST API the
// app uses, so it needs no credentials beyond the database URL being public-by-code, and it deliberately
// reads the COLLECTIONS, which the security rules forbid... so it walks the codes it knows instead: the
// recent lists cannot be seen from here, so it sweeps every six-digit code that answers.
//
// A sweep of a million codes is not sensible, so it takes the codes it is given plus anything in
// backups/known-codes.json, and records what it could not reach.
import fs from "fs";
import path from "path";

const REPO = path.resolve(new URL(".", import.meta.url).pathname, "..");
const cfg = fs.readFileSync(path.join(REPO, "assets/js/config.js"), "utf8");
const url = (cfg.match(/firebaseUrl:\s*"([^"]+)"/) || [])[1];
if (!url) { console.error("No firebaseUrl in assets/js/config.js — nothing to back up."); process.exit(1); }
const base = url.replace(/\/$/, "");

const knownPath = path.join(REPO, "backups/known-codes.json");
const known = fs.existsSync(knownPath) ? JSON.parse(fs.readFileSync(knownPath, "utf8")) : { characters: [], tables: [] };
const args = process.argv.slice(2).filter((a) => /^\d{6}$/.test(a));
const codes = {
  characters: [...new Set([...(known.characters || []), ...args])],
  tables: [...new Set([...(known.tables || []), ...args])],
};

async function grab(kind, code) {
  const res = await fetch(`${base}/${kind}/${code}.json?cb=${Date.now()}`);
  if (!res.ok) return { error: res.status };
  return res.json();
}

const out = { takenAt: new Date().toISOString(), database: base, characters: {}, tables: {}, missing: [] };
for (const kind of ["characters", "tables"]) {
  for (const code of codes[kind]) {
    try {
      const data = await grab(kind, code);
      if (data && !data.error) out[kind][code] = data;
      else out.missing.push(`${kind}/${code}${data && data.error ? " (" + data.error + ")" : ""}`);
    } catch (err) { out.missing.push(`${kind}/${code} (${err.message})`); }
  }
}

fs.mkdirSync(path.join(REPO, "backups"), { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const file = path.join(REPO, `backups/backup-${stamp}.json`);
fs.writeFileSync(file, JSON.stringify(out, null, 1));
// And a copy that is always the newest, so a restore never has to pick.
fs.writeFileSync(path.join(REPO, "backups/latest.json"), JSON.stringify(out, null, 1));
const n = (o) => Object.keys(o).length;
console.log(`Backed up ${n(out.characters)} character(s) and ${n(out.tables)} table(s) to backups/`);
if (out.missing.length) console.log("Not found: " + out.missing.join(", "));
if (!codes.characters.length) {
  console.log("\nNo codes known yet. Add them to backups/known-codes.json, or pass them:  npm run backup -- 123456 482910");
}
