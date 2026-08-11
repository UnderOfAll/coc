// Take a table out of the live database, having first written it to disk.
//
//   node scripts/prune_tables.mjs 402444 707180          # back up, show, and delete
//   node scripts/prune_tables.mjs --dry 402444           # back up and show, delete nothing
//
// WHY THIS EXISTS. A table is created by anybody who types a room code, and the app deliberately cannot
// LIST them (the security model is that the six-digit code IS the credential — see storage-security-model),
// so a table nobody remembers the code for is invisible to the app and still sitting in the database.
// Kayki found three: rooms that exist in the data and on no device's list. Lost children.
//
// NOTHING IS DELETED THAT HAS NOT BEEN SAVED FIRST. The backup is written, re-read and checked before a
// single delete goes out; if the write fails, the run stops. Kayki's one condition on this whole project
// is that the data survives, and "I deleted it and the backup was empty" is exactly how that promise gets
// broken.
import fs from "fs";
import path from "path";

const REPO = path.resolve(new URL(".", import.meta.url).pathname, "..");
const cfg = fs.readFileSync(path.join(REPO, "assets/js/config.js"), "utf8");
const base = ((cfg.match(/firebaseUrl:\s*"([^"]+)"/) || [])[1] || "").replace(/\/$/, "");
if (!base) { console.error("No firebaseUrl in assets/js/config.js."); process.exit(1); }

const args = process.argv.slice(2);
const dry = args.includes("--dry");
const codes = args.filter((a) => /^\d{6}$/.test(a));
if (!codes.length) { console.error("Give me one or more six-digit room codes."); process.exit(1); }

const grabbed = {};
for (const code of codes) {
  const res = await fetch(`${base}/tables/${code}.json?cb=${Date.now()}`);
  if (!res.ok) { console.log(`  ${code}  unreachable (${res.status})`); continue; }
  const data = await res.json();
  if (data == null) { console.log(`  ${code}  already empty — nothing to remove`); continue; }
  grabbed[code] = data;
  const meta = data.meta || {};
  const n = (o) => Object.keys(o || {}).length;
  console.log(`  ${code}  "${meta.name || "(unnamed)"}"  ${n(data.tokens)} figures · ${n(data.scenes)} scenes · `
    + `${n(data.log)} rolls · ${n(data.draw)} strokes · ${n(data.presence)} devices seen · `
    + `${(JSON.stringify(data).length / 1024).toFixed(0)} KB`);
}

const found = Object.keys(grabbed);
if (!found.length) { console.log("Nothing to do."); process.exit(0); }

const dir = path.join(REPO, "backups");
fs.mkdirSync(dir, { recursive: true });
const file = path.join(dir, `tables-removed-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.json`);
fs.writeFileSync(file, JSON.stringify({ takenAt: new Date().toISOString(), database: base, tables: grabbed }, null, 2));

// Read it back. A backup nobody has opened is a hope, not a backup.
const check = JSON.parse(fs.readFileSync(file, "utf8"));
for (const code of found) {
  if (JSON.stringify(check.tables[code]) !== JSON.stringify(grabbed[code])) {
    console.error(`Backup of ${code} did not round-trip — stopping before anything is deleted.`);
    process.exit(1);
  }
}
console.log(`\nSaved to ${path.relative(REPO, file)} (${(fs.statSync(file).size / 1024).toFixed(0)} KB), and read back clean.`);

if (dry) { console.log("--dry: nothing deleted."); process.exit(0); }

for (const code of found) {
  const res = await fetch(`${base}/tables/${code}.json`, { method: "DELETE" });
  console.log(res.ok ? `  removed ${code}` : `  FAILED to remove ${code} (${res.status})`);
}
// And prove it: a table that still answers was not removed.
for (const code of found) {
  const res = await fetch(`${base}/tables/${code}.json?cb=${Date.now()}`);
  const still = res.ok ? await res.json() : null;
  console.log(still == null ? `  ${code} is gone` : `  ${code} IS STILL THERE`);
}
