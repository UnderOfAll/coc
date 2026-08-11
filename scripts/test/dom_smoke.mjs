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

// Load the real script set the page loads, in the same order — config, storage, compendium,
// character tools. Loading only app.js meant a missing sibling never showed up here.
for (const f of ["assets/js/config.js", "assets/js/storage.js", "assets/js/app.js", "assets/js/creator.js", "assets/js/dm.js"]) {
  const p = path.join(REPO, f);
  if (!fs.existsSync(p)) continue;
  const s = window.document.createElement("script");
  s.textContent = fs.readFileSync(p, "utf8");
  window.document.body.appendChild(s);
}

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

// The page loads four scripts; assert the storage layer is present and which backend it picked,
// so a missing sibling file or a wiped config is a test failure rather than a surprise in the browser.
check(peek("typeof CocStore") === "object", "storage layer loaded");
check(peek("CocStore.mode") === "firebase",
  `storage backend is the cloud, not localStorage (got "${peek("CocStore.mode")}")`);

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
    check(!h.includes("could not be rendered"), `${key}/${id}: renderer THREW (guard fallback shown)`);
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
// Every LIST view, not just detail pages: selectCategory() is a separate render path and was
// never exercised. A deleted grouper emptied the Skills and Subclasses tabs while the gate stayed
// green, because nothing here ever opened a list.
for (const cat of peek("CATEGORIES.map(c => c.key)")) {
  const n = peek(`store[${JSON.stringify(cat)}].length`);
  if (!n) continue;
  window.selectCategory(cat);
  const listHTML = $("#list").innerHTML;
  const cards = $("#list").querySelectorAll(".card, .class-field").length;
  checked++;
  check(cards > 0, `${cat} list: rendered ${cards} entries for ${n} items`);
  check(!listHTML.includes("{{") && !listHTML.includes("[["), `${cat} list: raw token leaked`);
}

check(totalScalingDice > 0, `a [[XdY]] scaling die renders somewhere (found ${totalScalingDice})`);
check(totalTipTerms > 0, `a {{Label|formula}} tooltip renders somewhere (found ${totalTipTerms})`);
check(totalAbilityMods > 0, `an [[XdY+Abil]] ability-modifier tooltip renders somewhere (found ${totalAbilityMods})`);

console.log(`\nRendered ${checked} pages. jsdomErrors: ${consoleErrors.length}. failed checks: ${fails}.`);
consoleErrors.forEach((e) => console.log("  " + e));
process.exit(fails || consoleErrors.length ? 1 : 0);
