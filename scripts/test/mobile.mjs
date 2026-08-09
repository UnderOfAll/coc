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
    // than itself — that is what makes it swipeable. So is the table's board: it is a window onto a
    // map deliberately bigger than the screen, clipped by overflow:hidden. Neither can push the PAGE
    // wider, which is the only thing being tested, so both are skipped.
    const inScroller = (el) => {
      for (let n = el.parentElement; n && n !== document.body; n = n.parentElement) {
        const ox = getComputedStyle(n).overflowX;
        if (ox === "auto" || ox === "scroll" || ox === "hidden" || ox === "clip") return true;
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

// Real phone widths, not two round numbers. 390/412/430 are the common ones and they are WIDER
// than 360 — which matters because a wider screen turns on multi-column grids that a narrow one
// never reaches, so testing only the narrowest width misses every two-column bug.
for (const width of [430, 412, 393, 360, 320]) {
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
  const tap = async (sel, optional) => {
    const found = await page.evaluate((s) => { const n = document.querySelector(s); if (n) n.click(); return !!n; }, sel);
    if (!found && !optional) { fails++; console.log(`  FAIL nothing to tap: ${sel}`); }
    return found;
  };

  await go("#/");                      await audit(page, "landing menu");
  await go("#/classes");               await audit(page, "class list");
  await go("#/classes/joker");         await audit(page, "class page");
  await go("#/tricks");                await audit(page, "trick list");
  await go("#/tricks/wild-card");      await audit(page, "trick page");
  await go("#/armor");                 await audit(page, "armour list");
  await go("#/create");                await audit(page, "creator, step 1");
  // Picking a class is what UNFOLDS the rest of the form. Auditing #/create without doing it only
  // ever looked at the class picker, which is how the ability-score rows shipped broken.
  await tap('[data-pick="class"][data-val="puppeteer"]');
  await audit(page, "creator, class chosen");
  await tap('[data-pick="method"][data-val="buy"]');   await audit(page, "creator, point buy");
  await tap('[data-pick="method"][data-val="array"]'); await audit(page, "creator, standard array");
  await tap('[data-pick="method"][data-val="manual"]'); await audit(page, "creator, manual");
  await tap('[data-pick="level"][data-val="1"]');
  await tap('[data-pick="level"][data-val="1"]');      await audit(page, "creator, disciplines shown");
  // The live summary must come AFTER the form on a phone, or every change costs a scroll to the top.
  const sideBelow = await page.evaluate(() => {
    const main = document.querySelector(".creator-main"), side = document.querySelector(".creator-side");
    return !!(main && side && side.getBoundingClientRect().top > main.getBoundingClientRect().top);
  });
  if (!sideBelow) { fails++; console.log("  FAIL the live summary sits above the form"); }
  else console.log("  ok   the live summary sits below the form");
  await go("#/manage");                await audit(page, "my characters");
  await go("#/roster", 700);           await audit(page, "recovery roster");
  await go("#/sheet/123456", 800);     await audit(page, "character sheet");
  await tap('[data-act="combat"]');    await audit(page, "sheet in combat");
  // The strip of fields must scroll sideways rather than wrap onto a second row: wrapping moves the
  // whole sheet down as you tab along it, and the audit above only proves it does not escape the page.
  const strip = await page.evaluate(() => {
    const n = document.querySelector(".tab-strip");
    if (!n) return null;
    return { rows: n.scrollHeight > n.clientHeight + 2, swipeable: n.scrollWidth > n.clientWidth,
             tabs: n.querySelectorAll(".tab").length };
  });
  if (!strip || strip.rows) { fails++; console.log("  FAIL the field strip wrapped onto two rows"); }
  else console.log(`  ok   ${strip.tabs} fields on one ${strip.swipeable ? "swipeable" : "fitting"} row`);
  // Each field has to be audited while it is the one on screen: a hidden pane is display:none and
  // measures zero, so auditing the sheet once only ever checked whichever field happened to be open.
  for (const field of ["attacks", "tricks", "features", "gear", "inventory", "progress", "status"]) {
    if (await tap(`.tab[data-val="${field}"]`, true)) await audit(page, `field: ${field}`);
  }
  await tap('.tab[data-val="features"]');
  await tap('[data-act="open-opts"]'); await audit(page, "feature options open");
  await tap('[data-act="combat"]');
  await tap('.tab[data-val="progress"]');
  await tap('[data-act="levelup"]');   await audit(page, "level-up panel");

  // The table. Offline mode and a seeded room, so this stays a layout test and touches no network.
  await page.evaluate(async () => {
    CocLive.setMode("local");
    localStorage.setItem("coc:live", "{}");
    localStorage.setItem("coc:table:dm:482910", "1");
    localStorage.setItem("coc:table:me:482910", JSON.stringify({ clientId: "cme", name: "Bartholomew", charCode: "123456" }));
    await CocLive.put("tables/482910", {
      meta: { name: "A table with a fairly long name", createdAt: 1, dmHash: "fnv:x", activeScene: "s1" },
      scenes: { s1: { name: "Blank", image: "", cols: 24, rows: 16, cell: 70, createdAt: 1 } },
      tokens: { t1: { name: "Bartholomew Quicksilver", charCode: "123456", owner: "cme", x: 3, y: 3, size: 1, kind: "pc", hp: 20, hpMax: 44, speed: 30 },
                t2: { name: "Goblin 2", kind: "npc", scene: "s1", x: 9, y: 6, size: 2, hp: 7, hpMax: 7, speed: 30 } },
      log: { l1: { t: 1, who: "DM", kind: "roll", text: "DM rolled Goblin 2 to hit: d20 + 4 → 17 = 21" } },
    });
  });
  await go("#/table");                 await audit(page, "table: the front door");
  await go("#/table/482910", 800);     await audit(page, "table: the board");
  await tap('[data-tbl="panel"][data-val="dice"]');  await audit(page, "table: dice");
  await tap('[data-tbl="panel"][data-val="dice"]');
  await tap('[data-tbl="panel"][data-val="dm"]');    await audit(page, "table: the DM panel");
  await tap('[data-tbl="map-source"][data-val="url"]'); await audit(page, "table: adding a map");
  await tap('[data-tbl="init-roll"]');               await audit(page, "table: a turn running");
  await tap('[data-tbl="hand-add"]');
  await tap('[data-tbl="panel"][data-val="dm"]');
  await tap('[data-tbl="panel"][data-val="sheet"]', true);
  await tap('[data-tbl="panel"][data-val="mine"]', true);
  await new Promise((r) => setTimeout(r, 600));
  await audit(page, "table: a sheet in the drawer");
  if (await tap('[data-act="sub-open"]', true)) await audit(page, "discipline card open");
  await page.close();
}

await browser.close();
server.close();
console.log(fails ? `\nFAILURES: ${fails}` : "\nNo horizontal overflow at any phone width.");
process.exit(fails ? 1 : 0);
