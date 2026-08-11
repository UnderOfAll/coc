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
    // `owner` is what makes a figure yours now — the browser holding it, matching the clientId seeded into
    // localStorage below. A character code alone no longer grants control of anything.
    t1: { name: "Rig", charCode: "123456", owner: "cme", x: 2, y: 2, size: 1, kind: "pc", hp: 20, hpMax: 44, speed: 30, initMod: 3 },
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

  // THE reported bug: zoom, then try to move things. Both gestures, both orders, because "it works
  // until I zoom" was the whole complaint and neither a pinch nor a wheel may leave the board deaf.
  await page.evaluate(() => { tblFit(); tbl.cameraIsYours = false; });
  for (const zoomBy of ["pinch", "wheel"]) {
    if (zoomBy === "pinch") {
      const cdp2 = await page.target().createCDPSession();
      const c = { x: 200, y: 380 };
      await cdp2.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [
        { x: c.x - 40, y: c.y, id: 11 }, { x: c.x + 40, y: c.y, id: 12 }] });
      await cdp2.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [
        { x: c.x - 90, y: c.y, id: 11 }, { x: c.x + 90, y: c.y, id: 12 }] });
      // One finger lifts before the other — the awkward case, and the usual one.
      await cdp2.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [{ x: c.x + 90, y: c.y, id: 12 }] });
      await cdp2.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    } else {
      await page.mouse.move(200, 380);
      await page.mouse.wheel({ deltaY: -120 });
    }
    await new Promise((r) => setTimeout(r, 200));
    const ghosts = await page.evaluate(() => ({ ptrs: tbl.pointers.size, drag: !!tbl.drag, pinch: !!tbl.pinch }));
    ok(ghosts.ptrs === 0 && !ghosts.drag && !ghosts.pinch,
      `after a ${zoomBy} nothing is left held down (${JSON.stringify(ghosts)})`);
    const at = await tokenAt(page, "t1");
    const bx = await tokenBox(page, "t1");
    const cellPx = await page.evaluate(() => tblScene().cell * tbl.view.z);
    await touchDrag(page, bx, { x: bx.x + cellPx, y: bx.y });
    const moved = await tokenAt(page, "t1");
    ok(moved.x === at.x + 1, `and a figure still drags after a ${zoomBy} (${at.x} -> ${moved.x})`);
    const viewBefore = await page.evaluate(() => tbl.view.x);
    await touchDrag(page, { x: 300, y: 600 }, { x: 180, y: 600 });
    const viewAfter = await page.evaluate(() => tbl.view.x);
    ok(viewAfter !== viewBefore, `and the map still pans after a ${zoomBy} (${Math.round(viewBefore)} -> ${Math.round(viewAfter)})`);
  }

  // The sheet drawer, on a phone, over the board.
  await page.evaluate(() => { document.querySelector('[data-tbl="panel"][data-val="sheet"]').click(); });
  await new Promise((r) => setTimeout(r, 600));
  const drawer = await page.evaluate(() => {
    const side = document.querySelector("#vtt-side"), stage = document.querySelector(".vtt-stage");
    const sb = side.getBoundingClientRect(), st = stage.getBoundingClientRect();
    return {
      hasSheet: !!side.querySelector(".ab-box"),
      // On a phone a panel is a SCREEN, not a share of one: it covers the board top to bottom and the
      // board keeps its own size behind it, so coming back does not move the camera.
      covers: sb.top <= st.top + 0.5 && sb.bottom >= st.bottom - 0.5,
      boardKept: st.height > 200,
      back: !!side.querySelector(".side-back") &&
        getComputedStyle(side.querySelector(".side-head")).display !== "none",
      fits: sb.right <= document.documentElement.clientWidth + 0.5,
      scrolls: getComputedStyle(side).overflowY,
    };
  });
  ok(drawer.hasSheet, "your sheet opens in the drawer");
  ok(drawer.covers, "which on a phone is the whole screen, not a squeezed column");
  ok(drawer.boardKept, "the board keeps its size behind it, so coming back moves nothing");
  ok(drawer.back, "with a way back to the board at the top of it");
  ok(drawer.fits && drawer.scrolls === "auto", "it fits the width and scrolls on its own");
  // Back to the board: a panel over it means the finger belongs to the panel, so everything below here
  // would be dragging the sheet.
  await page.evaluate(() => { document.querySelector(".side-back").click(); });
  await new Promise((r) => setTimeout(r, 400));
  ok(await page.evaluate(() => document.querySelector("#vtt-side").classList.contains("hidden")),
    "and pressing it puts the board back");

  // Panning has to actually go somewhere. The first clamp pinned the map's edges to the window, and on a
  // map smaller than the screen that left an inch of travel before it stopped dead.
  await page.evaluate(() => { tbl.view.z = 0.6; tbl.cameraIsYours = true; tblClampView(); applyView(); });
  const panFrom = await page.evaluate(() => tbl.view.x);
  await touchDrag(page, { x: 60, y: 500 }, { x: 300, y: 500 });
  const panTo = await page.evaluate(() => tbl.view.x);
  ok(Math.abs(panTo - panFrom) > 150, `a 240px drag of the map moves it (${Math.round(panFrom)} -> ${Math.round(panTo)})`);
  // …and it must stay where it was put, rather than snapping back the moment the finger lifts.
  await new Promise((r) => setTimeout(r, 200));
  ok((await page.evaluate(() => tbl.view.x)) === panTo, "and it stays there when you let go");
  // Whole pixels, or the grid's 1px lines land between device pixels and come out uneven.
  const whole = await page.evaluate(() => ({
    x: tbl.view.x, y: tbl.view.y, cellPx: tblScene().cell * tbl.view.z,
  }));
  ok(Number.isInteger(whole.x) && Number.isInteger(whole.y), "the camera sits on whole pixels");
  ok(Number.isInteger(whole.cellPx), `and a square is a whole number of them (${whole.cellPx}px)`);
  // It still cannot be lost: shoved hard in one direction, there is map on screen.
  for (let i = 0; i < 6; i++) await touchDrag(page, { x: 320, y: 300 }, { x: 60, y: 300 }, 3);
  const stillThere = await page.evaluate(() => {
    const s = document.querySelector("#vtt-stage").getBoundingClientRect();
    const w = document.querySelector("#vtt-world").getBoundingClientRect();
    const overlap = Math.min(s.right, w.right) - Math.max(s.left, w.left);
    return overlap / s.width;
  });
  ok(stillThere >= 0.2, `and however hard you shove it, the board is still on screen (${Math.round(stillThere * 100)}% of the window)`);
  await page.evaluate(() => { tblFit(); });

  const wide = await page.evaluate(() => {
    const de = document.documentElement;
    return { doc: de.scrollWidth, vw: de.clientWidth };
  });
  ok(wide.doc <= wide.vw, `nothing pushes the page wider than the phone (${wide.doc} in ${wide.vw})`);

  /* A CARD MUST STAY ON THE BOARD. It is pinned beside the thing it describes and the stage clips
     whatever leaves it, so a figure near the right-hand edge got a card with its right half cut off —
     which on a phone is most of the figures. Kayki photographed it twice. There is no layout in jsdom,
     so this can only be asserted here. */
  const fits = async (what) => {
    await new Promise((r) => setTimeout(r, 120));
    return page.evaluate(() => {
      const host = document.querySelector("#vtt-peek"), stage = document.querySelector("#vtt-stage");
      if (!host || host.classList.contains("hidden")) return { open: false };
      const c = host.getBoundingClientRect(), s = stage.getBoundingClientRect();
      return { open: true, w: Math.round(c.width),
        inside: c.left >= s.left - 0.5 && c.right <= s.right + 0.5 &&
                c.top >= s.top - 0.5 && c.bottom <= s.bottom + 0.5 };
    });
  };
  /* Hard against the right-hand edge: the case that was clipped. Somebody ELSE's figure — your own opens
     no card at all any more, because everything it said about you is on your sheet. Your own goes to the
     same edge on another row, because tblFit centres the camera on YOUR figure: leave it behind and the
     right-hand edge, card and area alike, is simply off screen. */
  await page.evaluate(async () => {
    const all = await CocLive.get("tables/482910/tokens");
    const col = tblScene().cols - 1;
    const mine = Object.keys(all).find((k) => tblIsMine(all[k]));
    const other = Object.keys(all).find((k) => !tblIsMine(all[k]));
    if (mine) await CocLive.patch("tables/482910/tokens/" + mine, { x: col, y: 6 });
    await CocLive.patch("tables/482910/tokens/" + other, { x: col, y: 0 });
    tbl.ui.peek = other; tbl.ui.peekArea = ""; tblFit(); paintPeek();
  });
  const edge = await fits();
  ok(edge.open && edge.inside, `a figure's card at the right-hand edge stays on the board (${edge.w}px)`);
  // And an area's card, opened from its label — the handle that replaced the corner ×.
  await page.evaluate(async () => {
    await CocLive.put("tables/482910/areas/a1",
      { scene: tblSceneId(), x: tblScene().cols - 1.5, y: 2.5, shape: "cube", size: 5,
        name: "Idle Image", by: tbl.me.clientId, left: 10 });
  });
  await new Promise((r) => setTimeout(r, 200));
  // Named the way a figure is: the same label element, in a layer of its own.
  const label = await page.evaluate(() => {
    const t = document.querySelector("#vtt-area-tags .area-tok .tok-name");
    if (!t) return null;
    const r = t.getBoundingClientRect();
    return { w: Math.round(r.width), text: t.textContent.trim() };
  });
  ok(!!label && label.w > 10, `an area is named the way a figure is ("${label ? label.text : ""}")`);
  /* TAPPED IN THE MIDDLE OF IT, with a real mouse. The whole shape opens the card — no handle to find —
     and it is worked out on the way up so that DRAGGING from inside a big area still pans the map. */
  const centre = await page.evaluate(() => {
    const s = document.querySelector("#vtt-stage").getBoundingClientRect();
    const a = Object.values(tbl.data.areas)[0], cell = tblScene().cell;
    return { x: s.left + tbl.view.x + a.x * cell * tbl.view.z,
             y: s.top + tbl.view.y + a.y * cell * tbl.view.z };
  });
  await page.mouse.click(centre.x, centre.y);
  await new Promise((r) => setTimeout(r, 200));
  ok(await page.evaluate(() => !!document.querySelector('[data-tbl="area-clear"]')),
    "tapping anywhere inside an area opens its card");
  const areaCard = await fits();
  ok(areaCard.open && areaCard.inside, "and that card stays on the board too");
  ok(await page.evaluate(() => /Remove it/.test(document.querySelector("#vtt-peek").textContent)),
    "carrying the way to take it away");
  // And a DRAG from inside the same area still moves the camera rather than opening anything.
  await page.evaluate(() => { document.querySelector('[data-tbl="peek-close"]').click(); });
  const panFrom2 = await page.evaluate(() => tbl.view.x);
  await page.mouse.move(centre.x, centre.y);
  await page.mouse.down();
  for (let i = 1; i <= 6; i++) await page.mouse.move(centre.x + i * 15, centre.y);
  await page.mouse.up();
  await new Promise((r) => setTimeout(r, 200));
  const panned = await page.evaluate(() => ({ x: tbl.view.x,
    card: !!document.querySelector('[data-tbl="area-clear"]') }));
  ok(panned.x !== panFrom2 && !panned.card,
    `and dragging from inside it pans the map instead (${panFrom2} -> ${panned.x})`);

  /* THE DM'S FIGHT IS THE FIGHT. A sheet used to keep its own private idea of whether combat was on,
     behind a button on itself — so the engine sat dead and every pip greyed while the order bar ran at
     the top of the same screen, and Kayki reported the engine as broken. It was gated, not broken. */
  await page.evaluate(() => { document.querySelector('[data-tbl="panel"][data-val="sheet"]').click(); });
  await new Promise((r) => setTimeout(r, 1200));
  const gated = await page.evaluate(() => ({
    inCombat: !!(sheet && sheet.ch && sheet.ch.play.inCombat),
    pips: [...document.querySelectorAll('#vtt-side [data-act="engine-set"]')].filter((b) => !b.disabled).length,
    button: !!document.querySelector('#vtt-side [data-act="combat"]'),
  }));
  ok(!gated.inCombat && !gated.button,
    "at a table the sheet does not offer its own Start combat button");
  await page.evaluate(async () => {
    await CocLive.put("tables/482910/meta/turn", { order: ["t1"], idx: 0, round: 1, startedAt: Date.now() });
  });
  await new Promise((r) => setTimeout(r, 700));
  const fighting = await page.evaluate(() => ({
    inCombat: !!(sheet && sheet.ch && sheet.ch.play.inCombat),
    pips: [...document.querySelectorAll('#vtt-side [data-act="engine-set"]')].filter((b) => !b.disabled).length,
  }));
  ok(fighting.inCombat && fighting.pips > gated.pips,
    `the DM starting a fight wakes the sheet's engine (${gated.pips} pips live -> ${fighting.pips})`);
  await page.evaluate(async () => {
    sheet.ch.play.engine = 2; sheet.ch.play.cooldowns = { x: 2 };
    await CocLive.put("tables/482910/meta/turn", null);
  });
  await new Promise((r) => setTimeout(r, 700));
  const done = await page.evaluate(() => ({
    inCombat: !!(sheet && sheet.ch && sheet.ch.play.inCombat),
    engine: sheet.ch.play.engine, cds: Object.keys(sheet.ch.play.cooldowns || {}).length,
  }));
  ok(!done.inCombat && done.engine === 0 && done.cds === 0,
    "and ending it clears the engine and the cooldowns with it");

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

  /* PLACING AN AREA WITH A REAL MOUSE. jsdom cannot see this one at all: it is about where a pointer
     travels between two clicks. "Place it here" sits in a bar ABOVE the board, so an outline that went on
     following the pointer was re-aimed by the walk up to the button — Kayki aimed at his square, moved to
     press Place, and it landed off the top of the map. */
  await page.evaluate(() => {
    tbl.cameraIsYours = true; tbl.view = { x: 300, y: 300, z: 0.686, fitted: true }; applyView();
    tblCastOnBoard({ name: "Idle Image",
      board: { verb: "shape", anchor: "point", range: 30, shape: "cube", size: 5, rounds: 10 } });
  });
  await new Promise((r) => setTimeout(r, 200));
  const square = await page.evaluate(() => {
    const s = document.querySelector("#vtt-stage").getBoundingClientRect();
    const cell = tblScene().cell;
    return { x: s.left + tbl.view.x + 3.5 * cell * tbl.view.z,
             y: s.top + tbl.view.y + 2.5 * cell * tbl.view.z };
  });
  await page.mouse.move(square.x, square.y);
  await page.mouse.down(); await page.mouse.up();
  await new Promise((r) => setTimeout(r, 150));
  const aimed = await page.evaluate(() => ({ x: tbl.placing.x, y: tbl.placing.y }));
  ok(aimed.x === 3.5 && aimed.y === 2.5,
    `a tap aims it at the middle of the square under it (${aimed.x},${aimed.y})`);
  const btn = await page.evaluate(() => {
    const b = document.querySelector('[data-tbl="place-go"]');
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  ok(!!btn, "with a button to commit it");
  for (let i = 1; i <= 10 && btn; i++) {
    await page.mouse.move(square.x + (btn.x - square.x) * i / 10, square.y + (btn.y - square.y) * i / 10);
  }
  const held = await page.evaluate(() => ({ x: tbl.placing.x, y: tbl.placing.y }));
  ok(held.x === 3.5 && held.y === 2.5,
    `and walking the mouse up to it does not drag the outline along (${held.x},${held.y})`);
  if (btn) await page.mouse.click(btn.x, btn.y);
  await new Promise((r) => setTimeout(r, 400));
  const put = await page.evaluate(async () => {
    const areas = await CocLive.get("tables/482910/areas") || {};
    const a = areas[Object.keys(areas)[0]];
    const r = document.querySelector("#vtt-areas rect");
    return { a, rect: r ? { x: +r.getAttribute("x"), y: +r.getAttribute("y"), w: +r.getAttribute("width") } : null };
  });
  ok(put.a && put.a.x === 3.5 && put.a.y === 2.5, "it lands where it was aimed");
  ok(put.rect && put.rect.x === 210 && put.rect.y === 140 && put.rect.w === 70,
    `and is drawn exactly over that square, not between four (${JSON.stringify(put.rect)})`);

  /* A PANEL WITH NO BUTTON IN THE BAR MUST STILL CLOSE. The back row was phone-only, on the reasoning
     that a desktop closes a panel by pressing its own button again — true for the panels that have one,
     and a dead end for a figure's card and an enemy's, which do not. Measured, because jsdom has no
     layout and `display: none` is exactly what it cannot see. */
  const wayOut = await page.evaluate(() => {
    tbl.ui.enemyId = "sawdust-hound"; tbl.ui.enemyFrom = "dm"; tbl.ui.panel = "enemy";
    paintSide();
    const b = document.querySelector("#vtt-side .side-back");
    if (!b) return { there: false };
    const r = b.getBoundingClientRect();
    return { there: true, shown: getComputedStyle(b).display !== "none" && r.width > 20 && r.height > 10,
      back: b.dataset.val };
  });
  ok(wayOut.there && wayOut.shown, "an enemy's card carries a visible way out on a desktop too");
  ok(wayOut.back === "dm", "and it leads back to the panel it was opened from");
  await page.evaluate(() => { tbl.ui.panel = ""; paintSide(); });

  ok(errs.length === 0, "no errors on the console" + (errs.length ? ": " + errs[0] : ""));
  await page.close();
}

await browser.close();
server.close();
console.log(fails ? `\nFAILURES: ${fails}` : "\nThe board works under a finger and under a mouse.");
process.exit(fails ? 1 : 0);
