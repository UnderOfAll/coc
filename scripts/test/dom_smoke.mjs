// DOM smoke test: boots app.js in jsdom, renders every class/subclass page through the
// real pipeline, and asserts no JS errors + no unrendered [[...]]/{{...}} tokens leak.
// Run:  npm install   (once, pulls jsdom devDep)   then   npm run test:dom

import { JSDOM, VirtualConsole } from "jsdom";
import fs from "fs";
import path from "path";

const REPO = path.resolve(new URL(".", import.meta.url).pathname, "../..");
const html = fs.readFileSync(path.join(REPO, "index.html"), "utf8");
const appjs = fs.readFileSync(path.join(REPO, "assets/js/app.js"), "utf8");

const vc = new VirtualConsole();
const consoleErrors = [];
vc.on("jsdomError", (e) => consoleErrors.push("jsdomError: " + (e.detail || e.message)));
["log","info","warn","error","debug"].forEach((m)=>vc.on(m,(...a)=>console.log("[app]",...a)));

const dom = new JSDOM(html, { runScripts: "dangerously", pretendToBeVisual: true, virtualConsole: vc, url: "http://localhost/" });
const { window } = dom;

window.fetch = async (url) => {
  const file = path.join(REPO, String(url).split("?")[0]);
  if (!fs.existsSync(file)) return { ok: false, status: 404, json: async () => ({}) };
  const txt = fs.readFileSync(file, "utf8");
  return { ok: true, status: 200, json: async () => JSON.parse(txt), text: async () => txt };
};

const s = window.document.createElement("script");
s.textContent = appjs;
window.document.body.appendChild(s);

const peek = (expr) => window.eval(expr);
const deadline = Date.now() + 8000;
while (peek("(typeof store!=='undefined' && store.classes) ? store.classes.length : 0") === 0 && Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 50));
}
const nClasses = peek("store.classes.length");
if (!nClasses) { console.log("FAIL: store.classes empty after boot"); process.exit(1); }

const $ = (sel) => window.document.querySelector(sel);
let checked = 0, fails = 0;
let totalScalingDice = 0, totalTipTerms = 0, totalAbilityMods = 0;
const check = (cond, msg) => { if (!cond) { fails++; console.log("  FAIL: " + msg); } };

// Render every entry in every category through its real renderer. New content types
// (races, backgrounds, spells, …) are picked up automatically from the store.
const allKeys = JSON.parse(peek(`JSON.stringify(CATEGORIES.map(c=>c.key))`));
for (const key of allKeys) {
  const ids = JSON.parse(peek(`JSON.stringify((store["${key}"]||[]).map(x=>slug(x)))`));
  for (const id of ids) {
    try { window.showDetail(key, id); }
    catch (e) { fails++; console.log(`  THREW ${key}/${id}: ${e.message}`); continue; }
    const h = $("#detail").innerHTML;
    checked++;
    check(!h.includes("[["), `${key}/${id}: raw [[ leaked`);
    check(!h.includes("{{"), `${key}/${id}: raw {{ leaked`);
    check(h.length > 80, `${key}/${id}: empty render`);
    totalScalingDice += (h.match(/class="scaling-die"/g) || []).length;
    totalTipTerms    += (h.match(/class="tip-term"/g) || []).length;
    totalAbilityMods += (h.match(/modifier<\/span>/g) || []).length;
  }
}

// These used to assert specific words on one subclass page ("Constitution modifier" on the
// Impersonator), which broke every time that content was legitimately rewritten. They now assert
// the INVARIANT instead: across the whole library, both token types must render as tooltips
// somewhere, and no page may leak a raw token. Content can change freely; the renderer cannot.
check(totalScalingDice > 0, `a [[XdY]] scaling die renders somewhere (found ${totalScalingDice})`);
check(totalTipTerms > 0, `a {{Label|formula}} tooltip renders somewhere (found ${totalTipTerms})`);
check(totalAbilityMods > 0, `an [[XdY+Abil]] ability-modifier tooltip renders somewhere (found ${totalAbilityMods})`);

console.log(`\nRendered ${checked} pages. jsdomErrors: ${consoleErrors.length}. failed checks: ${fails}.`);
consoleErrors.forEach((e) => console.log("  " + e));
process.exit(fails || consoleErrors.length ? 1 : 0);
