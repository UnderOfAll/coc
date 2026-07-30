// Mobile layout test: opens the real site in headless Chromium at phone widths and asserts that
// NOTHING makes the document wider than the screen. A page one pixel too wide is not a cosmetic
// bug on a phone — the browser lets you zoom out to reach the overflow, and everything sized to the
// layout viewport (the top bar) then ends short of everything that overflowed, which is what Kayki
// kept seeing as "deformatted". jsdom cannot catch this: it has no layout engine.
// Run: npm run test:mobile
import puppeteer from "puppeteer";
import http from "http";
import fs from "fs";
import path from "path";

const REPO = path.resolve(new URL(".", import.meta.url).pathname, "../..");
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json" };
const server = http.createServer((req, res) => {
  const file = path.join(REPO, decodeURIComponent(req.url.split("?")[0]));
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream" });
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, r));
const base = `http://localhost:${server.address().port}`;

// A character with a deliberately long name and a full kit — the widest realistic sheet.
const CH = {
  v: 1, name: "Bartholomew Quicksilver", classId: "joker", subclassId: "anarchist", level: 5, size: "Medium",
  method: "array", scores: { Strength: 12, Dexterity: 15, Constitution: 14, Intelligence: 10, Wisdom: 8, Charisma: 16 },
  skills: ["Acrobatics", "Deception"], armorId: "serpent-scale-mail", shieldId: "",
  weapons: ["Razor Cards", "Harlequin's Cane", "Dagger"], photo: "", notes: "",
};

const browser = await puppeteer.launch({ args: ["--no-sandbox"] });
let fails = 0;

async function audit(page, label) {
  const r = await page.evaluate(() => {
    const de = document.documentElement, vw = de.clientWidth;
    const seen = new Set(), offenders = [];
    // A horizontally scrollable strip (the mobile category bar) is SUPPOSED to hold content wider
    // than itself — that is what makes it swipeable. Only content that escapes the page counts.
    const inScroller = (el) => {
      for (let n = el.parentElement; n && n !== document.body; n = n.parentElement) {
        const ox = getComputedStyle(n).overflowX;
        if (ox === "auto" || ox === "scroll") return true;
      }
      return false;
    };
    for (const el of document.querySelectorAll("body *")) {
      const b = el.getBoundingClientRect();
      if (!b.width || (b.right <= vw + 0.5 && b.left >= -0.5)) continue;
      if (inScroller(el)) continue;
      const sig = el.tagName + "." + String(el.className || "").slice(0, 40);
      if (seen.has(sig)) continue;
      seen.add(sig);
      offenders.push(`${sig} [${b.left.toFixed(0)}…${b.right.toFixed(0)}] "${(el.textContent || "").trim().slice(0, 30)}"`);
    }
    return { vw, doc: de.scrollWidth, offenders };
  });
  const ok = r.doc <= r.vw && !r.offenders.length;
  if (!ok) {
    fails++;
    console.log(`  FAIL ${label}: document ${r.doc}px in a ${r.vw}px screen`);
    r.offenders.slice(0, 6).forEach((o) => console.log("         " + o));
  } else {
    console.log(`  ok   ${label}`);
  }
}

for (const width of [360, 320]) {
  console.log(`\n— ${width}px —`);
  const page = await browser.newPage();
  await page.setViewport({ width, height: 800, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await page.goto(base + "/index.html", { waitUntil: "networkidle0" });
  await page.evaluate((ch) => {
    CocStore.load = async () => JSON.parse(JSON.stringify(ch));
    CocStore.save = async () => {};
    CocStore.all = async () => ({ "123456": ch, "998877": { name: "Second", classId: "the-sandow", level: 3 } });
  }, CH);

  const go = async (hash, ms = 500) => {
    await page.evaluate((h) => { location.hash = h; }, hash);
    await new Promise((r) => setTimeout(r, ms));
  };
  const tap = async (sel) => {
    await page.evaluate((s) => { const n = document.querySelector(s); if (n) n.click(); }, sel);
    await new Promise((r) => setTimeout(r, 250));
  };

  await go("#/");                      await audit(page, "landing menu");
  await go("#/classes");               await audit(page, "class list");
  await go("#/classes/joker");         await audit(page, "class page");
  await go("#/tricks");                await audit(page, "trick list");
  await go("#/tricks/wild-card");      await audit(page, "trick page");
  await go("#/armor");                 await audit(page, "armour list");
  await go("#/create");                await audit(page, "creator");
  await go("#/manage");                await audit(page, "my characters");
  await go("#/roster", 700);           await audit(page, "recovery roster");
  await go("#/sheet/123456", 800);     await audit(page, "character sheet");
  await tap('[data-act="combat"]');    await audit(page, "sheet in combat");
  await tap('[data-act="open-opts"]'); await audit(page, "feature options open");
  await tap('[data-act="combat"]');
  await tap('[data-act="levelup"]');   await audit(page, "level-up panel");
  await tap('[data-act="sub-open"]');  await audit(page, "discipline card open");
  await page.close();
}

await browser.close();
server.close();
console.log(fails ? `\nFAILURES: ${fails}` : "\nNo horizontal overflow at any phone width.");
process.exit(fails ? 1 : 0);
