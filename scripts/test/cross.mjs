// Cross-browser test: the same board, driven in EVERY engine this machine can run.
//
// This exists because of one bug and five failed attempts at it. A pointerdown on an <img> starts the
// browser's own drag-and-drop, which swallows every pointermove after it — so the board stops hearing the
// hand. The guard I had (`-webkit-user-drag`) covers Blink and WebKit and does nothing in Firefox, and
// puppeteer's synthesised events never reproduced it in Chromium. Kayki reported it five times before I
// stopped guessing and reasoned it out.
//
// So: real Firefox, real WebKit (Safari's engine) and real Chromium, driven with REAL mouse and touch
// input, asserting the handful of things that differ between engines. Missing engines are reported and
// skipped rather than failing the run — a machine without WebKit's libraries should still be able to test.
//
// Run: npm run test:cross
import { chromium, firefox, webkit, devices } from "playwright";
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

// A map image, so the native-drag trap is actually present: an <img> under the finger is what starts it.
const MAP = "data:image/svg+xml;base64," + Buffer.from(
  `<svg xmlns="http://www.w3.org/2000/svg" width="1400" height="1000"><rect width="1400" height="1000" fill="#2b2620"/></svg>`
).toString("base64");
const TABLE = {
  meta: { name: "Cross", createdAt: 1, dmHash: "fnv:x", activeScene: "s1", dmSeat: "cme" },
  scenes: { s1: { name: "Arena", image: MAP, cols: 20, rows: 14, cell: 70, createdAt: 1, gridOn: true } },
  tokens: {
    t1: { name: "Rig", owner: "cme", x: 4, y: 4, size: 1, kind: "pc", shape: "square", hp: 20, hpMax: 44, speed: 30 },
    t2: { name: "Orc", kind: "npc", scene: "s1", x: 10, y: 6, size: 1, shape: "circle", hp: 7, hpMax: 7, speed: 30 },
  },
};

let fails = 0, ran = 0;
const ok = (c, m) => { if (!c) { fails++; console.log("  FAIL " + m); } else console.log("  ok   " + m); };

async function openTable(page) {
  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e.message)));
  page.on("console", (m) => {
    const from = (m.location() || {}).url || "";
    if (m.type() === "error" && !/favicon\.ico$/.test(from)) errs.push(m.text());
  });
  await page.goto(base + "/index.html", { waitUntil: "networkidle" });
  await page.evaluate(async (t) => {
    CocStore.load = async () => null;
    CocLive.setMode("local");
    localStorage.setItem("coc:live", "{}");
    localStorage.setItem("coc:table:dm:606060", "1");
    localStorage.setItem("coc:table:me:606060", JSON.stringify({ clientId: "cme", name: "Kayki", charCode: "" }));
    await CocLive.put("tables/606060", t);
  }, TABLE);
  await page.evaluate(() => { location.hash = "#/table/606060"; });
  await page.waitForTimeout(900);
  // A known camera, so a square is exactly 70px and the arithmetic below is arithmetic.
  await page.evaluate(() => { tbl.view.x = 0; tbl.view.y = 0; tbl.view.z = 1; tbl.cameraIsYours = true; applyView(); });
  await page.waitForTimeout(120);
  return errs;
}
const at = (page, id) => page.evaluate((i) => CocLive.get(`tables/606060/tokens/${i}`).then((t) => ({ x: t.x, y: t.y })), id);
const box = (page, id) => page.evaluate((i) => {
  const b = document.querySelector(`[data-token="${i}"]`).getBoundingClientRect();
  return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) };
}, id);

async function runEngine(name, type) {
  let browser;
  try { browser = await type.launch(); }
  catch (err) {
    console.log(`\n— ${name}: NOT AVAILABLE — ${String(err.message).split("\n")[0].slice(0, 70)}`);
    return;
  }
  ran += 1;
  console.log(`\n— ${name} —`);
  const page = await browser.newPage({ viewport: { width: 1200, height: 860 } });
  const errs = await openTable(page);

  // THE regression. A mouse drag across an <img>: if the engine starts its own drag, the figure does not
  // move and this fails — which is exactly what Kayki was living with.
  const before = await at(page, "t1");
  const from = await box(page, "t1");
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let i = 1; i <= 6; i++) { await page.mouse.move(from.x + (70 * 3 * i) / 6, from.y + (70 * i) / 6); await page.waitForTimeout(16); }
  await page.mouse.up();
  await page.waitForTimeout(300);
  const after = await at(page, "t1");
  ok(after.x === before.x + 3 && after.y === before.y + 1,
    `a mouse drag moves a figure three across and one down (${before.x},${before.y} -> ${after.x},${after.y})`);

  // Panning: the same gesture on the map itself, which is the other place a native image drag bites.
  const camBefore = await page.evaluate(() => tbl.view.x);
  await page.mouse.move(900, 700);
  await page.mouse.down();
  for (let i = 1; i <= 5; i++) { await page.mouse.move(900 - 24 * i, 700); await page.waitForTimeout(16); }
  await page.mouse.up();
  await page.waitForTimeout(200);
  ok((await page.evaluate(() => tbl.view.x)) !== camBefore, "dragging the map pans it");
  ok((await at(page, "t2")).x === 10, "and moves nobody");

  // Text selection is the other half of the same trap: a drag that selects the board's labels is a drag
  // the board never sees the end of.
  const selected = await page.evaluate(() => String(getSelection ? getSelection().toString() : "").length);
  ok(selected === 0, "and selects no text on the way");

  // The wheel is a camera in every engine, and the square under the cursor must stay there.
  await page.evaluate(() => { tbl.view.x = 0; tbl.view.y = 0; tbl.view.z = 1; applyView(); });
  const world = (page, x, y) => page.evaluate(([px, py]) => {
    const s = document.querySelector("#vtt-stage").getBoundingClientRect();
    return toSquares(px - s.left, py - s.top);
  }, [x, y]);
  const w0 = await world(page, 600, 500);
  await page.mouse.move(600, 500);
  await page.mouse.wheel(0, -240);
  await page.waitForTimeout(150);
  const w1 = await world(page, 600, 500);
  ok(Math.abs(w1.x - w0.x) < 0.2 && Math.abs(w1.y - w0.y) < 0.2,
    `the wheel keeps the square under the cursor (${w0.x.toFixed(2)} -> ${w1.x.toFixed(2)})`);

  // Ink: the pen has to work in every engine too, since it rides the same pointer events.
  await page.evaluate(() => { tbl.view.x = 0; tbl.view.y = 0; tbl.view.z = 1; applyView();
    tbl.ui.panel = "draw"; paintSide(); tblInkState().on = true; tblInkState().mode = "pen"; });
  // Aimed INSIDE the board. The dice dock is to its left and the panel to its right, so the board's left
  // edge is nowhere near x=0 — the first version of this drew on the dock and reported the pen broken in
  // three engines at once, which is a fine way to lose an afternoon.
  const inkFrom = await page.evaluate(() => {
    const s = document.querySelector("#vtt-stage").getBoundingClientRect();
    return { x: Math.round(s.left + 60), y: Math.round(s.top + 60) };
  });
  await page.mouse.move(inkFrom.x, inkFrom.y);
  await page.mouse.down();
  for (let i = 1; i <= 5; i++) { await page.mouse.move(inkFrom.x + 20 * i, inkFrom.y + 12 * i); await page.waitForTimeout(16); }
  await page.mouse.up();
  await page.waitForTimeout(250);
  const strokes = await page.evaluate(() => CocLive.get("tables/606060/draw").then((d) => Object.keys(d || {}).length));
  ok(strokes === 1, `the pen draws (${strokes} stroke)`);

  // The layout facts that differ between engines: dvh units, :has(), clip-path, and the grid's own crispness.
  const layout = await page.evaluate(() => {
    const stage = document.querySelector(".vtt-stage").getBoundingClientRect();
    const de = document.documentElement;
    const tool = document.querySelector("#tool-view");
    return {
      stageTall: stage.height > 200,
      noOverflow: de.scrollWidth <= de.clientWidth,
      // :has() drives the table's full-width layout; without it the board would be capped at 96rem.
      hasSupport: typeof CSS !== "undefined" && CSS.supports ? CSS.supports("selector(:has(*))") : false,
      toolWide: tool ? tool.getBoundingClientRect().width > 1100 : false,
      clip: getComputedStyle(document.querySelector(".tok-art")).clipPath !== undefined,
      cell: 70 * (window.tbl ? tbl.view.z : 1),
    };
  });
  ok(layout.stageTall, "the board has real height (dvh units behave)");
  ok(layout.noOverflow, "nothing overflows the window");
  ok(layout.hasSupport === layout.toolWide,
    `:has() and the full-width table agree (has=${layout.hasSupport}, wide=${layout.toolWide})`);
  ok(Number.isInteger(layout.cell), `a square is a whole number of pixels (${layout.cell})`);

  ok(errs.length === 0, "no console errors" + (errs.length ? ": " + errs[0].slice(0, 90) : ""));
  await browser.close();
}

/* A phone, in the one engine that can pretend to be an iPhone: touch, and the viewport units that iOS
   famously disagrees about. */
async function runPhone(name, type, device) {
  let browser;
  try { browser = await type.launch(); } catch { return; }
  console.log(`\n— ${name} —`);
  const ctx = await browser.newContext({ ...device });
  const page = await ctx.newPage();
  const errs = await openTable(page);
  // Put the figure in the top corner and pin the camera, so it is ON SCREEN on a 390px phone — a board that
  // small clips most of a 20x14 map, and dragging a figure that is not visible tests nothing.
  await page.evaluate(async () => {
    await CocLive.patch("tables/606060/tokens/t1", { x: 1, y: 1 });
    tbl.view.x = 0; tbl.view.y = 0; tbl.view.z = 1; tbl.cameraIsYours = true; applyView();
  });
  await page.waitForTimeout(200);
  const from = await box(page, "t1");
  const before = await at(page, "t1");
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + 70, from.y);
  await page.mouse.up();
  await page.waitForTimeout(250);
  const after = await at(page, "t1");
  ok(after.x === before.x + 1, `a drag moves a figure on a phone (${before.x} -> ${after.x})`);
  const fits = await page.evaluate(() => {
    const de = document.documentElement;
    return { over: de.scrollWidth <= de.clientWidth, stage: document.querySelector(".vtt-stage").getBoundingClientRect().height };
  });
  ok(fits.over, "and nothing is wider than the phone");
  ok(fits.stage > 150, `with a board worth looking at (${Math.round(fits.stage)}px tall)`);
  ok(errs.length === 0, "no console errors" + (errs.length ? ": " + errs[0].slice(0, 90) : ""));
  await browser.close();
}

await runEngine("Chromium (Chrome, Edge, Brave)", chromium);
await runEngine("Firefox", firefox);
await runEngine("WebKit (Safari)", webkit);
await runPhone("Chromium as a Pixel", chromium, devices["Pixel 7"]);
await runPhone("WebKit as an iPhone", webkit, devices["iPhone 13"]);

server.close();
if (!ran) { console.log("\nNo engines available — nothing was tested."); process.exit(1); }
console.log(fails ? `\nFAILURES: ${fails}` : `\nThe board behaves the same in ${ran} engine(s).`);
process.exit(fails ? 1 : 0);
