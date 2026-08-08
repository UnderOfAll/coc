// Board test in REAL Chromium. The table is the one part of this app that cannot be trusted to jsdom
// at all: it is driven by pointer events on a transformed, zoomed surface, it must work under a
// finger, and it resizes images through a canvas. None of those exist in jsdom — the flood of
// assertions in table.mjs proves the rules of the game, and this proves the thing is touchable.
// Run: npm run test:board
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

const CH = {
  v: 1, name: "Rig", classId: "joker", subclassId: "", level: 5, size: "Medium", method: "array",
  scores: { Strength: 12, Dexterity: 15, Constitution: 14, Intelligence: 10, Wisdom: 8, Charisma: 13 },
  origin: { Charisma: 2, Dexterity: 1 }, skills: ["Acrobatics"], armorId: "", shieldId: "",
  weapons: ["Dagger"], photo: "", notes: "",
};
const TABLE = {
  meta: { name: "Board test", createdAt: 1, dmHash: "fnv:none", activeScene: "s1" },
  scenes: { s1: { name: "Blank", image: "", cols: 20, rows: 14, cell: 70, createdAt: 1 } },
  tokens: {
    t1: { name: "Rig", charCode: "123456", x: 2, y: 2, size: 1, kind: "pc", hp: 20, hpMax: 44, speed: 30, initMod: 3 },
    t2: { name: "Orc", kind: "npc", scene: "s1", x: 8, y: 5, size: 1, hp: 7, hpMax: 7, speed: 30, initMod: 1 },
  },
};

const browser = await puppeteer.launch({ args: ["--no-sandbox"] });
let fails = 0;
const ok = (c, m) => { if (!c) { fails++; console.log("  FAIL " + m); } else console.log("  ok   " + m); };

async function openTable(width, height, asDm) {
  const page = await browser.newPage();
  await page.setViewport({ width, height, deviceScaleFactor: 2, isMobile: width < 700, hasTouch: true });
  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e.message)));
  page.on("console", (m) => {
    const from = (m.location() || {}).url || "";
    if (m.type() === "error" && !/favicon\.ico$/.test(from)) errs.push(m.text());
  });
  // A browser asks for /favicon.ico whether or not the site has one; that 404 is not the app's doing.
  page.on("response", (r) => {
    if (r.status() === 404 && !/favicon\.ico$/.test(r.url())) errs.push("404 " + r.url());
  });
  await page.goto(base + "/index.html", { waitUntil: "networkidle0" });
  await page.evaluate(async (t, ch, dm) => {
    CocStore.load = async (c) => (c === "123456" ? JSON.parse(JSON.stringify(ch)) : null);
    CocStore.save = async () => true;
    CocLive.setMode("local");
    localStorage.setItem("coc:live", "{}");
    // One browser serves both runs, and localStorage is shared across its tabs — so each run has to
    // say what it is NOT as well as what it is, or the DM inherits the player's character code.
    if (dm) {
      localStorage.setItem("coc:table:dm:482910", "1");
      localStorage.removeItem("coc:table:me:482910");
    } else {
      localStorage.removeItem("coc:table:dm:482910");
      localStorage.setItem("coc:table:me:482910", JSON.stringify({ clientId: "cme", name: "Rig", charCode: "123456" }));
    }
    await CocLive.put("tables/482910", t);
  }, TABLE, CH, !!asDm);
  await page.evaluate(() => { location.hash = "#/table/482910"; });
  await new Promise((r) => setTimeout(r, 700));
  return { page, errs };
}

// Where a token actually is on screen, which is the only thing a finger can aim at.
const tokenBox = (page, id) => page.evaluate((i) => {
  const n = document.querySelector(`[data-token="${i}"]`);
  if (!n) return null;
  const b = n.getBoundingClientRect();
  return { x: b.left + b.width / 2, y: b.top + b.height / 2, w: b.width, h: b.height };
}, id);
const tokenAt = (page, id) => page.evaluate((i) => CocLive.get(`tables/482910/tokens/${i}`).then((t) => ({ x: t.x, y: t.y })), id);

async function touchDrag(page, from, to, steps = 6) {
  await page.touchscreen.touchStart(from.x, from.y);
  for (let i = 1; i <= steps; i++) {
    await page.touchscreen.touchMove(from.x + (to.x - from.x) * (i / steps), from.y + (to.y - from.y) * (i / steps));
    await new Promise((r) => setTimeout(r, 16));
  }
  await page.touchscreen.touchEnd();
  await new Promise((r) => setTimeout(r, 250));
}

/* ------------------------------------------------------- a finger on a phone */

console.log("\n— 393px, as a player, by touch —");
{
  const { page, errs } = await openTable(393, 850, false);
  const scene = await page.evaluate(() => ({ z: tbl.view.z, cell: tblScene().cell, cols: tblScene().cols }));
  ok(scene.z > 0 && scene.z <= 1.6, "the board is fitted to the screen, not left at 1:1 (zoom " + scene.z.toFixed(2) + ")");
  // The floor that makes a figure touchable on a phone. Without it a fitted 20x14 map leaves a token
  // eleven pixels wide, which is unreadable and unhittable.
  ok(scene.cell * scene.z >= 40, "a square is never fitted below finger size (" + Math.round(scene.cell * scene.z) + "px)");
  // Not "dead centre" — a figure two squares from the edge cannot be, and the camera is clamped to the
  // map rather than showing empty space beside it. On screen and reachable is the real requirement.
  const onScreen = await page.evaluate(() => {
    const b = document.querySelector('[data-token="t1"]').getBoundingClientRect();
    const s = document.querySelector(".vtt-stage").getBoundingClientRect();
    return b.left >= s.left - 1 && b.right <= s.right + 1 && b.top >= s.top - 1 && b.bottom <= s.bottom + 1;
  });
  ok(onScreen, "and it opens with YOUR figure on screen, not pointed at a corner of the map");
  const stageFits = await page.evaluate(() => {
    const s = document.querySelector(".vtt-stage").getBoundingClientRect();
    return s.width <= document.documentElement.clientWidth + 0.5 && s.height > 200;
  });
  ok(stageFits, "the stage fits the screen and is big enough to play on");
  // The grid is drawn at the scene's square size, which is what makes a square a square.
  const grid = await page.evaluate(() => getComputedStyle(document.querySelector("#vtt-grid")).backgroundSize);
  ok(grid.startsWith("70px 70px"), "the grid is drawn at the scene's square size (" + grid + ")");
  // touch-action: none, or the browser pans the page instead of the token.
  const touchAction = await page.evaluate(() => getComputedStyle(document.querySelector(".vtt-stage")).touchAction);
  ok(touchAction === "none", "the stage claims the gesture rather than letting the page scroll");

  const before = await tokenAt(page, "t1");
  const box = await tokenBox(page, "t1");
  ok(box && box.w >= 34, "your figure is big enough to hit with a finger (" + Math.round(box ? box.w : 0) + "px)");
  // Four squares right, in screen pixels: the world is scaled, so a square is cell * zoom.
  const step = 70 * scene.z;
  const scrollBefore = await page.evaluate(() => window.scrollY);
  await touchDrag(page, box, { x: box.x + step * 2, y: box.y + step });
  const after = await tokenAt(page, "t1");
  ok(after.x === before.x + 2 && after.y === before.y + 1,
    `dragging with a finger moves the figure two across and one down (${before.x},${before.y} -> ${after.x},${after.y})`);
  ok(Number.isInteger(after.x) && Number.isInteger(after.y), "and it lands ON a square");
  ok((await page.evaluate(() => window.scrollY)) === scrollBefore, "without the page scrolling under you");

  // Someone else's figure: the finger pans the map instead.
  const orcBefore = await tokenAt(page, "t2");
  const orcBox = await tokenBox(page, "t2");
  const viewBefore = await page.evaluate(() => ({ x: tbl.view.x, y: tbl.view.y }));
  await touchDrag(page, orcBox, { x: orcBox.x - 60, y: orcBox.y - 40 });
  const orcAfter = await tokenAt(page, "t2");
  ok(orcAfter.x === orcBefore.x && orcAfter.y === orcBefore.y, "a player cannot drag the DM's monster");
  const viewAfter = await page.evaluate(() => ({ x: tbl.view.x, y: tbl.view.y }));
  ok(Math.abs(viewAfter.x - viewBefore.x) > 20, "the same gesture pans the map instead (" +
    Math.round(viewBefore.x) + " -> " + Math.round(viewAfter.x) + ")");

  // Two fingers: a pinch. Only CDP can send a second touch point.
  const cdp = await page.target().createCDPSession();
  const zBefore = await page.evaluate(() => tbl.view.z);
  const c = { x: 200, y: 400 };
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [
    { x: c.x - 40, y: c.y, id: 1 }, { x: c.x + 40, y: c.y, id: 2 }] });
  for (const spread of [70, 110, 150]) {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [
      { x: c.x - spread, y: c.y, id: 1 }, { x: c.x + spread, y: c.y, id: 2 }] });
    await new Promise((r) => setTimeout(r, 30));
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await new Promise((r) => setTimeout(r, 150));
  const zAfter = await page.evaluate(() => tbl.view.z);
  ok(zAfter > zBefore * 1.2, `pinching out zooms in (${zBefore.toFixed(2)} -> ${zAfter.toFixed(2)})`);
  ok((await page.evaluate(() => !!tbl.pinch)) === false, "and lifting the fingers ends it");

  // The sheet drawer, on a phone, over the board.
  await page.evaluate(() => { document.querySelector('[data-tbl="panel"][data-val="sheet"]').click(); });
  await new Promise((r) => setTimeout(r, 600));
  const drawer = await page.evaluate(() => {
    const side = document.querySelector("#vtt-side"), stage = document.querySelector(".vtt-stage");
    const sb = side.getBoundingClientRect(), st = stage.getBoundingClientRect();
    return {
      hasSheet: !!side.querySelector(".ab-box"),
      below: sb.top >= st.top,                 // on a phone it is the lower half, not a column
      fits: sb.right <= document.documentElement.clientWidth + 0.5,
      scrolls: getComputedStyle(side).overflowY,
    };
  });
  ok(drawer.hasSheet, "your sheet opens in the drawer");
  ok(drawer.below, "which on a phone is the lower half of the screen, not a squeezed column");
  ok(drawer.fits && drawer.scrolls === "auto", "it fits the width and scrolls on its own");

  const wide = await page.evaluate(() => {
    const de = document.documentElement;
    return { doc: de.scrollWidth, vw: de.clientWidth };
  });
  ok(wide.doc <= wide.vw, `nothing pushes the page wider than the phone (${wide.doc} in ${wide.vw})`);
  ok(errs.length === 0, "no errors on the console" + (errs.length ? ": " + errs[0] : ""));
  await page.close();
}

/* ------------------------------------------------------- the DM, with a mouse and a big screen */

console.log("\n— 1280px, as the DM, with a mouse —");
{
  const { page, errs } = await openTable(1280, 900, true);
  ok(await page.evaluate(() => tbl.role === "dm"), "the stored key makes this browser the DM");
  // The wheel is a camera, and the point under the cursor must stay put.
  // Zoom in first, so the map is BIGGER than the window: that is the state anchoring has to hold in,
  // and with a map smaller than the window the camera is clamped to keep it fully visible instead.
  await page.evaluate(() => { tbl.view.z = 1.2; tbl.cameraIsYours = true; tblClampView(); applyView(); });
  const at = { x: 500, y: 400 };
  const worldBefore = await page.evaluate((p) => toSquares(p.x - document.querySelector("#vtt-stage").getBoundingClientRect().left,
    p.y - document.querySelector("#vtt-stage").getBoundingClientRect().top), at);
  await page.mouse.move(at.x, at.y);
  await page.mouse.wheel({ deltaY: -240 });
  await new Promise((r) => setTimeout(r, 120));
  const zoomed = await page.evaluate(() => tbl.view.z);
  const worldAfter = await page.evaluate((p) => toSquares(p.x - document.querySelector("#vtt-stage").getBoundingClientRect().left,
    p.y - document.querySelector("#vtt-stage").getBoundingClientRect().top), at);
  ok(zoomed > 0, "the wheel zooms");
  ok(Math.abs(worldAfter.x - worldBefore.x) < 0.05 && Math.abs(worldAfter.y - worldBefore.y) < 0.05,
    "and the square under the cursor stays under the cursor");

  // A mouse drag of a monster, which the DM is allowed to do.
  // Pin the camera at 1:1 so a square is exactly 70px below. Fields are assigned rather than the
  // object replaced: the view carries state the board relies on.
  await page.evaluate(() => { tbl.view.x = 40; tbl.view.y = 40; tbl.view.z = 1; applyView(); });
  const orcBox = await tokenBox(page, "t2");
  const orcBefore = await tokenAt(page, "t2");
  await page.mouse.move(orcBox.x, orcBox.y);
  await page.mouse.down();
  for (let i = 1; i <= 5; i++) { await page.mouse.move(orcBox.x - 70 * (i / 5) * 3, orcBox.y); await new Promise((r) => setTimeout(r, 16)); }
  await page.mouse.up();
  await new Promise((r) => setTimeout(r, 250));
  const orcAfter = await tokenAt(page, "t2");
  ok(orcAfter.x === orcBefore.x - 3, `the DM drags a monster three squares left (${orcBefore.x} -> ${orcAfter.x})`);

  // The ruler, drawn while the button is down. Aimed at where the monster is NOW — it has just been
  // moved, and the earlier rect is three squares out of date.
  const orcNow = await tokenBox(page, "t2");
  await page.mouse.move(orcNow.x, orcNow.y);
  await page.mouse.down();
  await page.mouse.move(orcNow.x + 280, orcNow.y + 70);
  const ruler = await page.evaluate(() => ({
    line: !!document.querySelector("#vtt-ruler .ruler-line"),
    label: document.querySelector("#vtt-measure").textContent,
    hidden: document.querySelector("#vtt-measure").classList.contains("hidden"),
  }));
  ok(ruler.line && !ruler.hidden, "a ruler is drawn while dragging");
  ok(/20 ft/.test(ruler.label), "reading the distance in feet (" + ruler.label + ")");
  await page.mouse.up();
  await new Promise((r) => setTimeout(r, 150));

  // Resizing an image through a canvas — the one piece of the map pipeline jsdom cannot run at all.
  const shrunk = await page.evaluate(async () => {
    // A deliberately big, noisy picture: flat colour would compress to nothing and prove nothing.
    const c = document.createElement("canvas");
    c.width = 3000; c.height = 2000;
    const ctx = c.getContext("2d");
    const img = ctx.createImageData(c.width, c.height);
    for (let i = 0; i < img.data.length; i += 4) {
      img.data[i] = (i * 7) % 255; img.data[i + 1] = (i * 13) % 255;
      img.data[i + 2] = (i * 29) % 255; img.data[i + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    const blob = await new Promise((r) => c.toBlob(r, "image/png"));
    const file = new File([blob], "big.png", { type: "image/png" });
    return await new Promise((done) => {
      tblShrinkImage(file, (data, w, h) => done({ ok: true, len: data.length, head: data.slice(0, 22), w, h }),
        (why) => done({ ok: false, why }));
    });
  });
  ok(shrunk.ok, "a 3000x2000 upload is resized rather than refused" + (shrunk.ok ? "" : ": " + shrunk.why));
  ok(shrunk.ok && shrunk.head.startsWith("data:image/jpeg"), "into a JPEG data URI");
  ok(shrunk.ok && shrunk.len <= 680000, "small enough for the database's cap (" + (shrunk.ok ? shrunk.len : "?") + " chars)");
  ok(shrunk.ok && shrunk.w === 3000, "and the original's real size is reported, so the grid can match its shape");

  ok(errs.length === 0, "no errors on the console" + (errs.length ? ": " + errs[0] : ""));
  await page.close();
}

await browser.close();
server.close();
console.log(fails ? `\nFAILURES: ${fails}` : "\nThe board works under a finger and under a mouse.");
process.exit(fails ? 1 : 0);
