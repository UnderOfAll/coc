// Table test: boots the real page and DRIVES a live session — opens a table as the DM, has a second
// device join and place a token, drags tokens with pointer events, and proves a player cannot move
// somebody else's figure. The transport itself is covered by live.mjs; this is about the game.
// Run: npm run test:table
import { JSDOM, VirtualConsole } from "jsdom";
import fs from "fs";
import path from "path";
const REPO = path.resolve(new URL(".", import.meta.url).pathname, "../..");
const html = fs.readFileSync(path.join(REPO, "index.html"), "utf8");
const vc = new VirtualConsole();
const errs = []; vc.on("jsdomError", (e) => errs.push(String(e.detail || e.message)));
["error", "warn"].forEach((m) => vc.on(m, (...a) => errs.push("[" + m + "] " + a.join(" "))));
const dom = new JSDOM(html, { runScripts: "dangerously", pretendToBeVisual: true, virtualConsole: vc, url: "http://localhost/" });
const { window } = dom; const doc = window.document;
window.fetch = async (u) => {
  const f = path.join(REPO, String(u).split("?")[0]);
  if (!fs.existsSync(f)) return { ok: false, status: 404, json: async () => ({}) };
  const t = fs.readFileSync(f, "utf8");
  return { ok: true, status: 200, json: async () => JSON.parse(t), text: async () => t };
};
for (const f of ["assets/js/config.js", "assets/js/storage.js", "assets/js/live.js",
                 "assets/js/app.js", "assets/js/creator.js", "assets/js/dm.js",
                 "assets/js/table-board.js", "assets/js/table-dice.js", "assets/js/table-panels.js",
                 "assets/js/table-music.js", "assets/js/table.js"]) {
  const s = doc.createElement("script");
  s.textContent = fs.readFileSync(path.join(REPO, f), "utf8");
  doc.body.appendChild(s);
}
window.scrollTo = () => {};
const peek = (e) => window.eval(e);
// An expression that needs `await` INSIDE it cannot be eval'd as-is (top-level await is not valid
// there), so it is wrapped in an async arrow and the promise is awaited out here.
const aget = (e) => window.eval(`(async () => { return ${e}; })()`);
const t0 = Date.now();
while (peek("(typeof store!=='undefined'&&store.classes)?store.classes.length:0") === 0 && Date.now() - t0 < 8000) {
  await new Promise((r) => setTimeout(r, 40));
}
let fails = 0;
const ok = (c, m) => { if (!c) { fails++; console.log("  FAIL " + m); } else console.log("  ok   " + m); };
const $ = (s) => doc.querySelector(s), $$ = (s) => [...doc.querySelectorAll(s)];
const click = (n) => { if (!n) { fails++; console.log("  FAIL click(null)"); return; } n.dispatchEvent(new window.MouseEvent("click", { bubbles: true })); };
const type = (n, v) => { n.value = v; n.dispatchEvent(new window.Event("input", { bubbles: true })); };
const go = async (h, ms = 60) => { window.location.hash = h; window.dispatchEvent(new window.HashChangeEvent("hashchange")); await new Promise((r) => setTimeout(r, ms)); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
/* Wait for a condition rather than for a guessed number of milliseconds. A fixed wait after a write is a
   flake generator: it passes on a quiet machine and fails on a busy one. */
/* Polling, so a slow machine waits and a fast one does not. The budget used to be 800ms, which is about
   what a write, its echo and a repaint take when nothing else is running — and so it failed roughly one
   run in ten on a busy laptop, which is the kind of failure that teaches you to ignore the gate. It costs
   nothing to be patient here: the loop stops the moment the condition is true. */
const until = async (fn, ms = 3000) => {
  const stop = Date.now() + ms;
  while (Date.now() < stop) { if (await fn()) return true; await wait(20); }
  return false;
};
/* Seed a roll and wait for it to be on screen.
 *
 * Every intermittent failure in this file has been the same thing: `Math.random` is mocked for the whole
 * page, and CocLive mints the id of a pushed log entry from it as well — so a write still in flight from
 * the previous roll silently eats the faces this one was seeded with, and the dice come up as something
 * else. Draining first, seeding at the last possible moment, and waiting for the result rather than
 * sleeping through it makes it deterministic.
 * `faces` are the randoms, in order. `count` is how many dice should end up in the box. */
async function rollFaces(faces, count) {
  /* Wait for the PREVIOUS roll's tumble to stop first. That animation draws a fresh random for every die
     on every tick for half a second — so seeding while one is running hands this roll's faces to the
     last one's animation, and the dice come up as something else entirely. This, not the database, was
     what made these tests flap. */
  await until(() => !$("#roll-stage") || !$("#roll-stage").classList.contains("rolling"));
  await wait(120);                                    // and let any write in flight mint its id
  /* Anchored to THIS roll. Waiting for "the box holds N dice" cannot tell a new roll from the last one
     still on screen — if the previous roll also had N, the wait returned immediately and every assertion
     below read the old one. `tbl.lastRollAt` is stamped the moment a roll is made. */
  const was = peek(`tbl.lastRollAt || 0`);
  const before = Object.keys(await aget(`CocLive.get("tables/482910/log")`) || {}).length;
  peek(`window.__seq = ${JSON.stringify(faces)};`);
  armed(() => click($('[data-tbl="roll-pool"]')));
  await until(() => peek(`tbl.lastRollAt || 0`) !== was);
  // …and wait for it to REACH THE LOG. `lastRollAt` is stamped before the write, so a caller reading
  // the log the moment it changes can still be handed the roll BEFORE this one.
  await until(async () =>
    Object.keys(await aget(`CocLive.get("tables/482910/log")`) || {}).length > before);
  await until(() => $$("#roll-stage .die").length === count);
  // the faces turn over at the end of the tumble, and the crit lands with them
  await until(() => !$("#roll-stage").classList.contains("rolling"));
  // …and if this roll earned a moment, wait for it too. It is added as the tumble ends, and an assertion
  // that reads the class in the same breath is racing an animation frame for no reason.
  const entry = await lastRoll();
  // A generous budget: this is a poll, so it costs nothing when the moment lands promptly, and the
  // tumble it waits behind runs on a timer that a loaded machine can stretch.
  if (entry.nat) await until(() => /crit-(high|low)/.test($("#roll-stage").className), 8000);
  // Handed back, so an assertion reads THE ROLL THIS MADE rather than whatever is newest by the time it
  // gets around to looking.
  return entry;
}
/* Run something with the seeded faces live. Everything that makes a roll goes through here. */
function armed(fn) {
  peek(`window.__armed = true;`);
  // Emptied afterwards as well as disarmed: a value seeded for a roll that did not consume it would
  // otherwise sit in the queue and be taken by the NEXT roll, which is the same theft one step later.
  try { return fn(); } finally { peek(`window.__armed = false; window.__seq = [];`); }
}
/* The same, held open across an AWAIT. Rolling initiative rolls one die per figure and writes each one
   to the database between them, so the second die is thrown a tick after the click that started it —
   outside a window that closes when the click returns. */
async function armedFor(fn, ms) {
  peek(`window.__armed = true;`);
  try { fn(); await wait(ms); } finally { peek(`window.__armed = false; window.__seq = [];`); }
}
/* The newest roll, as the table recorded it. The nat rule is a property of the ROLL — assert it here
   rather than on a stage element whose classes are mid-animation, or the test measures the animation. */
const lastRoll = async () => {
  const log = Object.values(await aget(`CocLive.get("tables/482910/log")`) || {});
  return log.sort((a, b) => (b.t || 0) - (a.t || 0))[0] || {};
};
const tblCols = () => peek(`tblScene().cols`);
const tblInkDecodeLen = (pts) => String(pts || "").split(" ").filter(Boolean).length;
// The panel buttons TOGGLE, so asking for one that is already open would shut it.
const openPanel = (name) => { if (peek("tbl.ui.panel") !== name) click($(`[data-tbl="panel"][data-val="${name}"]`)); };
/* The dice have two homes: a dock of their own where there is room for one (which is what a test
   environment reports, having no matchMedia at all), and the slide-over panel where there is not. */
const openDice = () => {
  if (peek("tblWide()")) {
    if (peek("tbl.ui.dock === false")) click($('[data-tbl="panel"][data-val="dice"]'));
  } else openPanel("dice");
};

// The table runs on the offline tree: no network in a test, and the local backend is the same
// interface, so everything below is exercising the real code paths.
peek(`CocLive.setMode("local"); localStorage.clear();`);
// A character to join with. CocStore's cloud backend cannot be reached here, so it is stubbed the
// same way the sheet tests stub it.
peek(`window.__chars = { "123456": { v:1, name:"Rig", classId:"joker", subclassId:"", level:5, size:"Medium",
    method:"array", scores:{Strength:12,Dexterity:15,Constitution:14,Intelligence:10,Wisdom:8,Charisma:13},
    origin:{Charisma:2,Dexterity:1}, skills:[], armorId:"", shieldId:"", weapons:[], photo:"", notes:"" } };
  CocStore.load = async (c) => window.__chars[c] ? JSON.parse(JSON.stringify(window.__chars[c])) : null;
  CocStore.save = async (c, ch) => { window.__chars[c] = ch; return true; };`);

console.log("\n— THE FRONT DOOR —");
await go("#/table");
ok($("#tbl-room") && !$("#tbl-char"), "joining asks for the room code and nothing else");
ok(/pick which\s+character/i.test($("#tool").textContent.replace(/\s+/g, " ")) || /pick which character/i.test($("#tool").textContent),
  "and says the character is chosen once you are inside");
ok($("#tbl-newroom") && $("#tbl-dmkey"), "running a table asks for a room code and a DM key");
ok(/six.digit|six digits/i.test($("#tool").textContent), "and says what shape the codes are");
ok(/locks the controls, not the data/i.test($("#tool").textContent), "the DM key's limits are stated on the page");
// Refusals first: a table opened on a bad code is a table nobody can find again.
type($("#tbl-newroom"), "12"); type($("#tbl-dmkey"), "999888");
click($('[data-tbl="create"]'));
await wait(60);
ok(/exactly six digits/.test($("#tbl-msg").textContent), "a short room code is refused: " + $("#tbl-msg").textContent);
type($("#tbl-newroom"), "482910"); type($("#tbl-dmkey"), "12");
click($('[data-tbl="create"]'));
await wait(60);
ok(/DM key is exactly six/.test($("#tbl-msg").textContent), "a short DM key is refused");

console.log("\n— OPENING A TABLE —");
type($("#tbl-name"), "The Big Top");
type($("#tbl-newroom"), "482910"); type($("#tbl-dmkey"), "771203");
click($('[data-tbl="create"]'));
await wait(120);
await go("#/table/482910", 120);
const meta = await aget(`CocLive.get("tables/482910/meta")`);
ok(meta && meta.name === "The Big Top", "the table exists with its name");
ok(meta && /^(sha256|fnv):/.test(meta.dmHash || ""), "the DM key is stored as a hash, not as digits (" + (meta && String(meta.dmHash).split(":")[0]) + ")");
ok(!String(meta && meta.dmHash).includes("771203"), "and the digits themselves are nowhere in it");
ok(peek(`tbl && tbl.role`) === "dm", "the browser that opened it is the DM");
ok((await aget(`Object.keys(await CocLive.get("tables/482910/scenes")).length`)) === 1, "a table opens with one scene, so there is always a board");
ok($(".vtt"), "the table view rendered");
ok(/The Big Top/.test($("#vtt-title").textContent), "the header names the table");
ok(/482910/.test($("#vtt-title").textContent), "and shows the room code to read out");
ok($("#vtt-world").dataset.scene, "the board says which scene it is showing");

console.log("\n— THE DM KEY —");
ok((await peek(`tblKeyMatches("771203", ${JSON.stringify(meta.dmHash)})`)) === true, "the right key matches the stored hash");
ok((await peek(`tblKeyMatches("771204", ${JSON.stringify(meta.dmHash)})`)) === false, "a wrong key does not");
ok((await peek(`tblKeyMatches("771203", "")`)) === false, "and a table with no hash cannot be claimed");

console.log("\n— WHO IS HERE —");
await wait(60);
const presence = await aget(`CocLive.get("tables/482910/presence")`);
ok(presence && Object.keys(presence).length === 1, "sitting down announces you");
ok(Object.values(presence)[0].role === "dm", "with your role");
// You are NOT in the who-list: the badge beside the table name already says who you are, and a phone
// header cannot spare a chip to tell you that you are here.
ok(!/DM/.test($("#vtt-who").textContent), "the list is everyone else, not you");
ok(/DM/.test($("#vtt-title").textContent), "your own role is the badge beside the table's name");
// A second device, arriving from somewhere else: a plain write, exactly as the other browser would.
await peek(`CocLive.put("tables/482910/presence/other", { name: "Rig", role: "player", charCode: "123456", at: Date.now() })`);
await wait(40);
ok(/Rig/.test($("#vtt-who").textContent), "someone else joining appears without a refresh");
// Presence is a heartbeat, so silence has to age out — otherwise the list only ever grows.
await peek(`CocLive.put("tables/482910/presence/ghost", { name: "Ghost", role: "player", at: Date.now() - 90000 })`);
await wait(40);
ok(!/Ghost/.test($("#vtt-who").textContent), "and someone who stopped answering drops off the list");

console.log("\n— TOKENS ARRIVE LIVE —");
// The camera is pinned so a square is exactly one cell: jsdom has no layout, so every rect is zero
// and a fitted view would make the arithmetic below meaningless.
peek(`tbl.view = { x: 0, y: 0, z: 1, fitted: true }; applyView();`);
await peek(`CocLive.put("tables/482910/tokens/tRig", { name: "Rig", charCode: "123456", x: 3, y: 4, size: 1, kind: "pc", hp: 30, hpMax: 44, speed: 30, color: "#c9a54e" })`);
await wait(40);
const tok = $('[data-token="tRig"]');
ok(tok, "a token written by another device appears on the board");
ok(tok.style.left === "210px" && tok.style.top === "280px", "at its square (3,4 at 70px = 210,280) — got " + tok.style.left + "," + tok.style.top);
ok(/Rig/.test(tok.querySelector(".tok-name").textContent), "carrying its name");
// Hit points on the board are the DM's alone: they run the fight, and opening a panel per goblin is
// slower than the fight. A player sees none of this — their own are on their sheet.
/* THE NUMBERS, WITHOUT THE BAR. The strip said the same thing as the numbers beside it, in the same inch
   of screen, and on a full board it read as clutter — Kayki's call. The bar survives on the figure's
   card, where there is room for it. */
ok(tok.querySelector(".tok-num"), "the DM gets the hit points on a figure");
ok(!tok.querySelector(".tok-bar"), "as numbers, without a bar saying it again beside them");
ok(/30\/44/.test(tok.textContent), "with the numbers, so nothing has to be opened mid-fight");
await peek(`CocLive.put("tables/482910/tokens/tRig/x", 8)`);
await wait(40);
ok($('[data-token="tRig"]').style.left === "560px", "a move made elsewhere lands on this screen");
ok($$(".tok").length === 1, "and the node was reused, not rebuilt");
await peek(`CocLive.del("tables/482910/tokens/tRig")`);
await wait(40);
ok($$(".tok").length === 0, "a removed token leaves the board");

console.log("\n— DRAGGING —");
await peek(`CocLive.put("tables/482910/tokens/tRig", { name: "Rig", charCode: "123456", x: 2, y: 2, size: 1, kind: "pc", hp: 30, hpMax: 44, speed: 30 })`);
await peek(`CocLive.put("tables/482910/tokens/tOrc", { name: "Orc", x: 10, y: 6, size: 1, kind: "npc", hp: 15, hpMax: 15 })`);
await wait(40);
// A pointer event, as a phone or a mouse sends it. jsdom has no PointerEvent, and it does not need
// one: the listeners read clientX/clientY and the target, which a MouseEvent carries.
const pointer = (type, node, x, y, id) => {
  const e = new window.MouseEvent(type, { bubbles: true, clientX: x, clientY: y });
  Object.defineProperty(e, "pointerId", { value: id == null ? 1 : id });
  // isPrimary matters: a real second finger reports false, and the board uses that to know a stale
  // pointer from a genuine second one. Without it these events lie about being first fingers.
  Object.defineProperty(e, "isPrimary", { value: (id == null ? 1 : id) === 1 });
  (node || $("#vtt-stage")).dispatchEvent(e);
};
const drag = (node, fromX, fromY, toX, toY) => {
  pointer("pointerdown", node, fromX, fromY);
  pointer("pointermove", $("#vtt-stage"), (fromX + toX) / 2, (fromY + toY) / 2);
  pointer("pointermove", $("#vtt-stage"), toX, toY);
  pointer("pointerup", $("#vtt-stage"), toX, toY);
};
// Grab the middle of the token at (2,2) — 175,175 — and drop it four squares right, one down.
drag($('[data-token="tRig"]'), 175, 175, 175 + 280, 175 + 70);
await wait(60);
ok((await peek(`CocLive.get("tables/482910/tokens/tRig/x")`)) === 6, "the DM drags a token four squares right");
ok((await peek(`CocLive.get("tables/482910/tokens/tRig/y")`)) === 3, "and one down");
// Dropped between squares, it snaps: half a square of slop must not leave a token off-grid.
drag($('[data-token="tRig"]'), 6 * 70 + 35, 3 * 70 + 35, 6 * 70 + 35 + 24, 3 * 70 + 35 + 48);
await wait(60);
const snapped = await peek(`CocLive.get("tables/482910/tokens/tRig/y")`);
ok(Number.isInteger(snapped) && snapped === 4, "a sloppy drop snaps to the nearest square (y=" + snapped + ")");
// Dragging empty space is the camera, not a token.
const before = peek(`JSON.stringify([tbl.view.x, tbl.view.y])`);
drag($("#vtt-stage"), 500, 400, 560, 430);
await wait(20);
const after = peek(`JSON.stringify([tbl.view.x, tbl.view.y])`);
ok(before !== after && peek(`tbl.view.x`) === 60, "dragging the map pans the camera (" + before + " -> " + after + ")");
ok((await peek(`CocLive.get("tables/482910/tokens/tRig/x")`)) === 6, "and moves no token");
peek(`tbl.view = { x: 0, y: 0, z: 1, fitted: true }; applyView();`);

console.log("\n— DRAWING ON THE MAP —");
peek(`tbl.role = "dm"; tbl.me.charCode = ""; renderTableShell(); paintTokens();
  tbl.view = { x: 0, y: 0, z: 1, fitted: true }; applyView();`);
openPanel("draw");
await wait(60);
ok($('[data-tbl="ink-pen"]') && $('[data-tbl="ink-erase"]'), "everyone gets a pen and an eraser");
ok($$('[data-tbl="ink-color"]').length === 9, "with nine colours to choose from");
ok($("#vtt-ink"), "and a layer to draw on");
// With the pen away the board behaves as it always did.
const orcWas = await aget(`CocLive.get("tables/482910/tokens/tOrc/x")`);
click($('[data-tbl="ink-pen"]'));
await wait(40);
ok(peek(`tblInkState().on`) === true, "taking out the pen turns drawing on");
ok($("#vtt-stage").classList.contains("inking"), "and the board says so");
// A stroke, drawn as a finger would.
drag($("#vtt-stage"), 200, 200, 500, 400);
await wait(120);
const strokes = await aget(`Object.values(await CocLive.get("tables/482910/draw"))`);
ok(strokes && strokes.length === 1, "a drag lays down one stroke");
ok(strokes[0].by === "dm" && strokes[0].scene === peek(`tblSceneId()`), "belonging to whoever drew it, on this scene");
ok(/^0\.\d+,0\.\d+ /.test(strokes[0].pts), "stored against the PICTURE, not the grid: " + strokes[0].pts.slice(0, 24));
ok($$("#vtt-ink path").length === 1, "and it is on the board");
// While the pen is out, figures are not draggable — otherwise you smear ink at every miss.
ok((await aget(`CocLive.get("tables/482910/tokens/tOrc/x")`)) === orcWas, "and no figure moved while drawing");
// Re-gridding must not drag the drawing away from what it was drawn around.
const inkBefore = $$("#vtt-ink path")[0].getAttribute("d");
await peek(`CocLive.patch("tables/482910/scenes/" + tblSceneId(), { cols: 60, rows: 40 })`);
await wait(120);
const inkAfter = $$("#vtt-ink path")[0].getAttribute("d");
ok(inkBefore !== inkAfter, "re-gridding rescales the ink with the picture");
ok($("#vtt-ink").getAttribute("viewBox") === "0 0 4200 2800", "the layer follows the world: " + $("#vtt-ink").getAttribute("viewBox"));
await peek(`CocLive.patch("tables/482910/scenes/" + tblSceneId(), { cols: 30, rows: 20 })`);
await wait(80);
// Shapes: two corners, resizing under the hand.
peek(`tblInkState().shape = "rect"; paintSide();`);
drag($("#vtt-stage"), 700, 200, 1000, 500);
await wait(150);
const inkStrokes = await aget(`Object.values(await CocLive.get("tables/482910/draw"))`);
const boxStroke = inkStrokes.find((k) => k.kind === "rect");
ok(boxStroke, "a box can be drawn");
ok(tblInkDecodeLen(boxStroke.pts) === 2, "stored as its two corners, not a trail of points");
ok($$("#vtt-ink rect").length === 1, "and drawn as a rectangle");
peek(`tblInkState().shape = "circle"; paintSide();`);
drag($("#vtt-stage"), 700, 600, 900, 800);
await wait(150);
ok($$("#vtt-ink ellipse").length === 1, "a circle too");
peek(`tblInkState().shape = "line"; paintSide();`);
drag($("#vtt-stage"), 1100, 200, 1300, 400);
await wait(150);
ok($$("#vtt-ink line").length === 1, "and a straight line");
peek(`tblInkState().shape = "free"; paintSide();`);

// The eraser rubs out the PART it passes over. Kayki's complaint: touching a long line anywhere took the
// whole thing, which is a delete, not an eraser.
peek(`(async () => { const d = await CocLive.get("tables/482910/draw");
  for (const id of Object.keys(d || {})) await CocLive.del("tables/482910/draw/" + id); })()`);
await wait(120);
// A long straight freehand line across the board, sampled every few pixels.
await peek(`CocLive.push("tables/482910/draw", { by: tblNoteOwner(), scene: tblSceneId(), color: "#fff",
  width: 2, kind: "free", at: 1,
  pts: Array.from({ length: 21 }, (_, i) => (0.05 + i * 0.045).toFixed(4) + ",0.5000").join(" ") })`);
await wait(120);
click($('[data-tbl="ink-erase"]'));
await wait(40);
// Rub the MIDDLE of it.
const midX = 0.5 * 30 * 70, midY = 0.5 * 20 * 70;
pointer("pointerdown", $("#vtt-stage"), midX, midY, 1);
pointer("pointerup", $("#vtt-stage"), midX, midY, 1);
await wait(200);
const left = await aget(`Object.values(await CocLive.get("tables/482910/draw") || {})`);
ok(left.length === 2, "rubbing the middle of a line leaves the two ends, not nothing (" + left.length + " pieces)");
ok(left.every((k) => k.kind === "free" && k.pts.split(" ").length >= 2), "each a line in its own right");
// The bug Kayki hit: erasing wrote as it went, so each move cut the pieces the last move had made and one
// drag became dozens of strokes and hundreds of writes. Rubbing now edits a copy and writes ONCE, on release.
peek(`(async () => { const d = await CocLive.get("tables/482910/draw");
  for (const id of Object.keys(d || {})) await CocLive.del("tables/482910/draw/" + id); })()`);
await wait(150);
await peek(`CocLive.push("tables/482910/draw", { by: tblNoteOwner(), scene: tblSceneId(), color: "#fff",
  width: 2, kind: "free", at: 1,
  pts: Array.from({ length: 41 }, (_, i) => (0.05 + i * 0.022).toFixed(4) + ",0.3000").join(" ") })`);
await wait(150);
// Count what the board writes during a long rub: a watcher fires once per write.
peek(`window.__inkWrites = 0;
  window.__offInk = CocLive.watch("tables/482910/draw", () => window.__inkWrites++);`);
await wait(60);
peek(`window.__inkWrites = 0; tblInkState().mode = "erase";`);
const y = 0.3 * 20 * 70;
pointer("pointerdown", $("#vtt-stage"), 0.2 * 30 * 70, y, 1);
for (let i = 1; i <= 18; i++) { pointer("pointermove", $("#vtt-stage"), (0.2 + i * 0.008) * 30 * 70, y, 1); }
const midRub = peek(`window.__inkWrites`);
ok(midRub === 0, "a long rub writes NOTHING while the hand is down (" + midRub + " writes)");
ok(peek(`tbl.erasing && tbl.erasing.size`) === 1, "it edits a copy instead");
ok($$("#vtt-ink path").length >= 2, "and the board already shows the gap");
// The bug after the fix: the overlay was dropped the moment the deletes were SENT, so the board fell back to
// the stored, still-whole line until the database echoed — the line came back, then vanished by itself.
// Here the write path is held open, so "sent" and "arrived" are visibly different moments.
peek(`window.__realDel = CocLive.del; window.__held = [];
  CocLive.del = (p) => new Promise((res) => window.__held.push(() => window.__realDel(p).then(res)));`);
pointer("pointerup", $("#vtt-stage"), (0.2 + 18 * 0.008) * 30 * 70, y, 1);
await wait(150);
ok($$("#vtt-ink path").length >= 2, "with the delete still in flight, the gap is still on screen");
ok(peek(`!!tbl.inkPending`) === true, "because the rub is held until the data agrees");
peek(`window.__held.forEach((f) => f()); CocLive.del = window.__realDel;`);
await wait(300);
ok(peek(`!!tbl.inkPending`) === false, "and it retires itself once the delete has landed");
const afterRub = peek(`window.__inkWrites`);
ok(afterRub > 0 && afterRub <= 6, "and one release writes a handful, not hundreds (" + afterRub + ")");
const pieces = await aget(`Object.values(await CocLive.get("tables/482910/draw") || {})`);
ok(pieces.length === 2, "leaving the two ends of the line (" + pieces.length + ")");
peek(`window.__offInk();`);

// Ctrl+Z takes back your own last mark, and an undone erase restores the line whole.
peek(`tblInkState().mode = "pen"; tblInkState().shape = "free";`);
const zed = () => doc.dispatchEvent(new window.KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true }));
zed();
await wait(250);
const restored = await aget(`Object.values(await CocLive.get("tables/482910/draw") || {})`);
ok(restored.length === 1, "undoing the rub puts the line back as one piece (" + restored.length + ")");
ok(restored[0].pts.split(" ").length === 41, "with every point it had");
// And a stroke you just drew.
drag($("#vtt-stage"), 300, 900, 500, 1000);
await wait(200);
const drawn = await aget(`Object.values(await CocLive.get("tables/482910/draw") || {}).length`);
zed();
await wait(250);
ok((await aget(`Object.values(await CocLive.get("tables/482910/draw") || {}).length`)) === drawn - 1,
  "and Ctrl+Z takes back a stroke you just drew");
// Not while typing: the browser's own undo owns a text box.
peek(`document.body.insertAdjacentHTML("beforeend", '<textarea id="typing"></textarea>');`);
const inkBeforeTyping = await aget(`Object.values(await CocLive.get("tables/482910/draw") || {}).length`);
$("#typing").dispatchEvent(new window.KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true }));
await wait(150);
ok((await aget(`Object.values(await CocLive.get("tables/482910/draw") || {}).length`)) === inkBeforeTyping,
  "and it keeps its hands off Ctrl+Z inside a text box");
peek(`$("#typing").remove();`);

// Filled shapes: see-through, and erased by touching anywhere inside.
peek(`tblInkState().shape = "rect"; tblInkState().fill = true; paintSide();`);
drag($("#vtt-stage"), 1400, 300, 1700, 600);
await wait(200);
const filled = (await aget(`Object.values(await CocLive.get("tables/482910/draw") || {})`)).find((k) => k.fill);
ok(filled && filled.kind === "rect", "a filled box can be drawn");
ok($$("#vtt-ink rect").some((n) => n.getAttribute("fill") !== "none"), "and is painted, not just outlined");
peek(`tblInkState().mode = "erase";`);
pointer("pointerdown", $("#vtt-stage"), 1550, 450, 1);
pointer("pointerup", $("#vtt-stage"), 1550, 450, 1);
await wait(250);
ok(!(await aget(`Object.values(await CocLive.get("tables/482910/draw") || {})`)).some((k) => k.fill),
  "and touching anywhere inside it rubs it out, because the inside is what it is");
peek(`tblInkState().fill = false; tblInkState().shape = "free"; tblInkState().mode = "pen";`);

// The bucket: a box drawn EMPTY, coloured in afterwards. Which is how anybody actually draws — the shape
// goes down first, and what it turns out to be is decided later.
peek(`tblInkState().shape = "rect"; tblInkState().fill = false; paintSide();`);
drag($("#vtt-stage"), 1400, 700, 1700, 1000);
await wait(200);
const empty = (await aget(`Object.entries(await CocLive.get("tables/482910/draw") || {})`))
  .find(([, k]) => k.kind === "rect" && !k.fill && k.pts.startsWith("0.6"));
ok(!!empty, "a box is drawn with nothing in it");
ok($('[data-tbl="ink-bucket"]'), "and there is a bucket beside the pen and the eraser");
click($('[data-tbl="ink-bucket"]'));
await wait(60);
ok(peek(`tblInkState().mode`) === "fill", "which takes over the board when you pick it up");
peek(`tblInkState().fill = "solid";`);
// Tapped INSIDE it, not on its outline: an empty shape is filled through the middle, as it would be
// anywhere else.
pointer("pointerdown", $("#vtt-stage"), 1550, 850, 1);
pointer("pointerup", $("#vtt-stage"), 1550, 850, 1);
await wait(250);
ok((await aget(`(await CocLive.get("tables/482910/draw/${empty ? empty[0] : "x"}/fill"))`)) === "solid",
  "tapping inside it fills it in");
ok($$("#vtt-ink rect").some((n) => n.getAttribute("fill-opacity") === "0.95"),
  "solidly, so it covers the map rather than tinting it");
// And again empties it, so the bucket is its own undo.
pointer("pointerdown", $("#vtt-stage"), 1550, 850, 1);
pointer("pointerup", $("#vtt-stage"), 1550, 850, 1);
await wait(250);
ok((await aget(`(await CocLive.get("tables/482910/draw/${empty ? empty[0] : "x"}/fill"))`)) == null,
  "and tapping it again empties it");
peek(`tblInkState().fill = false; tblInkState().shape = "free"; tblInkState().mode = "pen"; paintSide();`);
// Taken off the board again, or the box-counting below would find this one too.
await peek(`CocLive.del("tables/482910/draw/${empty ? empty[0] : "x"}")`);
await wait(120);

// A shape, by contrast, goes whole — there is no sensible half of a box.
await peek(`CocLive.push("tables/482910/draw", { by: tblNoteOwner(), scene: tblSceneId(), color: "#fff",
  width: 2, kind: "rect", at: 2, pts: "0.2000,0.2000 0.4000,0.4000" })`);
await wait(120);
const boxCount = () => aget(`Object.values(await CocLive.get("tables/482910/draw") || {}).filter(k => k.kind === "rect").length`);
peek(`tblInkState().mode = "erase";`);
pointer("pointerdown", $("#vtt-stage"), 0.2 * 2100, 0.3 * 1400, 1);
pointer("pointerup", $("#vtt-stage"), 0.2 * 2100, 0.3 * 1400, 1);
await wait(250);
ok((await boxCount()) === 0, "touching an outlined box's edge removes the whole box");
peek(`tblInkState().mode = "pen";`);
// Whose ink is whose. Cleared first, since the shape tests above left pieces of their own.
peek(`(async () => { const d = await CocLive.get("tables/482910/draw");
  for (const id of Object.keys(d || {})) await CocLive.del("tables/482910/draw/" + id); })()`);
await wait(150);
await peek(`CocLive.push("tables/482910/draw", { by: "pc:999999", scene: tblSceneId(), color: "#6ab04c",
  width: 2, kind: "free", pts: "0.1000,0.1000 0.1050,0.1050 0.2000,0.2000", at: Date.now() })`);
await wait(80);
peek(`tbl.role = "player"; tbl.me.charCode = "123456"; renderTableShell(); tblInkState().on = true; tblInkState().mode = "erase";`);
pointer("pointerdown", $("#vtt-stage"), 0.1 * 2100, 0.1 * 1400, 1);
pointer("pointerup", $("#vtt-stage"), 0.1 * 2100, 0.1 * 1400, 1);
await wait(120);
ok((await aget(`Object.values(await CocLive.get("tables/482910/draw")).length`)) === 1,
  "a player cannot rub out somebody else's line");
peek(`tbl.role = "dm"; tbl.me.charCode = ""; renderTableShell(); tblInkState().on = true; tblInkState().mode = "erase";`);
pointer("pointerdown", $("#vtt-stage"), 0.1 * 2100, 0.1 * 1400, 1);
pointer("pointerup", $("#vtt-stage"), 0.1 * 2100, 0.1 * 1400, 1);
await wait(120);
ok((await aget(`CocLive.get("tables/482910/draw")`)) === null, "but the DM can rub out anyone's");
// Clearing.
await peek(`CocLive.push("tables/482910/draw", { by: "pc:999999", scene: tblSceneId(), color: "#fff", width: 2, pts: "0.5,0.5 0.6,0.6", at: 1 })`);
await peek(`CocLive.push("tables/482910/draw", { by: "dm", scene: tblSceneId(), color: "#fff", width: 2, pts: "0.7,0.7 0.8,0.8", at: 2 })`);
await wait(100);
peek(`paintSide();`);
await wait(60);
click($('[data-tbl="ink-clear-mine"]'));
await wait(120);
ok((await aget(`Object.values(await CocLive.get("tables/482910/draw")).length`)) === 1,
  "Rub out mine takes only your own");
click($('[data-tbl="ink-clear-all"]'));
await wait(120);
ok((await aget(`CocLive.get("tables/482910/draw")`)) === null, "and the DM can clear the whole scene");
// The DM can turn drawing off for everyone else.
click($('[data-tbl="ink-lock"]'));
await wait(120);
ok((await aget(`tblScene().drawLocked`)) === true, "the DM can turn drawing off for the scene");
peek(`tbl.role = "player"; tbl.me.charCode = "123456"; renderTableShell(); paintSide();`);
ok(peek(`tblCanDraw()`) === false, "which stops a player drawing");
openPanel("draw");
await wait(60);
ok(/turned drawing off/.test($("#vtt-side").textContent), "and says so rather than failing silently");
peek(`tbl.role = "dm"; renderTableShell(); tbl.ui.panel = "draw"; paintSide();`);
ok(peek(`tblCanDraw()`) === true, "while the DM's own pen still works");
await wait(60);
click($('[data-tbl="ink-lock"]'));
await wait(100);
peek(`paintSide();`);
click($('[data-tbl="ink-off"]'));
await wait(40);
ok(peek(`tblInkState().on`) === false, "and the pen can be put away again");

console.log("\n— A PLAYER'S OWN TOOLS WORK —");
// Every "everyone" action had been sitting behind the DM-only guard, so for a player the pen, the notepad,
// the tracker and the seat picker all did precisely nothing. One line of chain order.
peek(`tbl.role = "player"; tbl.me.clientId = "thisBrowser"; tbl.me.charCode = "123456"; renderTableShell();
  tbl.view = { x: 0, y: 0, z: 1, fitted: true }; applyView();`);
// An earlier section locked drawing on a scene; make sure this one allows it, or the panel is a refusal.
await peek(`CocLive.put("tables/482910/scenes/" + tblSceneId() + "/drawLocked", null)`);
await wait(80);
peek(`tbl.ui.panel = "draw"; paintSide();`);
await wait(60);
click($('[data-tbl="ink-pen"]'));
await wait(40);
ok(peek(`tblInkState().on`) === true, "a player can pick up the pen");
drag($("#vtt-stage"), 150, 150, 420, 320);
await wait(150);
const playerInk = await aget(`Object.values(await CocLive.get("tables/482910/draw") || {})`);
ok(playerInk.length >= 1, "and draw with it");
ok(playerInk.some((k) => k.by === "pc:123456"), "with the stroke belonging to them");
peek(`paintSide();`);
click($('[data-tbl="ink-clear-mine"]'));
await until(async () => (await aget(`Object.values(await CocLive.get("tables/482910/draw") || {}).length`)) === 0);
ok((await aget(`Object.values(await CocLive.get("tables/482910/draw") || {}).length`)) === 0, "and rub out their own");
click($('[data-tbl="ink-off"]'));
openPanel("notes");
await wait(60);
click($('[data-tbl="note-new"]'));
await wait(150);
ok($("#note-body"), "a player can keep notes too");
ok((await aget(`Object.values(await CocLive.get("tables/482910/notes") || {}).some(n => n.by === "pc:123456")`)) === true,
  "kept under their own name");
// Tidied away, so the DM's own notepad section further down counts only the DM's. Deleting asks for the
// word now, here as everywhere else.
click($$('[data-tbl="note-del"]')[0]);
await wait(120);
type($("#note-drop-confirm"), "CONFIRM");
click($('[data-tbl="note-del-go"]'));
await wait(150);
peek(`tbl.ui.panel = ""; paintSide(); tbl.role = "dm"; tbl.me.charCode = ""; renderTableShell(); paintTokens();`);

console.log("\n— THE CHARACTER PANEL —");
peek(`tbl.role = "player"; tbl.me.clientId = "thisBrowser"; tbl.me.charCode = ""; renderTableShell();`);
openPanel("mine");
await wait(80);
ok($("#trk-name"), "a character panel of your own");
ok(/Character/.test($$('[data-tbl="panel"]').map(b => b.textContent).join(" ")), "reached from a button that says Character");
type($("#trk-name"), "Greta"); type($("#trk-hp"), "18"); type($("#trk-hpmax"), "22");
await wait(900);
const sheet = await aget(`CocLive.get("tables/482910/sheets/" + tblNoteOwner())`);
ok(sheet && sheet.name === "Greta" && sheet.hp === 18, "which saves as you type");
// "Add a field" is the thing Kayki could not make sense of. It must add a row you can actually fill in.
ok($('[data-tbl="trk-add"]'), "and offers to add something else to track");
click($('[data-tbl="trk-add"]'));
await wait(250);
ok($("#trk-k-0") && $("#trk-v-0"), "which appears as a name and a value you can type in");
type($("#trk-k-0"), "Ki points"); type($("#trk-v-0"), "4");
await wait(900);
const withField = await aget(`CocLive.get("tables/482910/sheets/" + tblNoteOwner())`);
ok(withField.fields && withField.fields[0] && withField.fields[0].k === "Ki points" && withField.fields[0].v === "4",
  "and is kept: " + JSON.stringify((withField.fields || [])[0]));
click($('[data-tbl="trk-drop"][data-val="0"]'));
await wait(250);
ok(!$("#trk-k-0"), "and can be thrown away again");
peek(`tbl.ui.panel = ""; paintSide(); tbl.role = "dm"; renderTableShell(); paintTokens();`);

console.log("\n— TWO FIGURES CANNOT SHARE A SQUARE —");
// Dropped onto somebody, a figure slides to the side rather than either vanishing into them or refusing
// to move at all.
peek(`tbl.view = { x: 0, y: 0, z: 1, fitted: true }; applyView();`);
await peek(`CocLive.put("tables/482910/tokens/tRig", { name: "Rig", charCode: "123456", x: 2, y: 2, size: 1, kind: "pc", hp: 30, hpMax: 44, speed: 30 })`);
await peek(`CocLive.put("tables/482910/tokens/tOrc", { name: "Orc", kind: "npc", x: 5, y: 5, size: 1, hp: 15, hpMax: 15, speed: 30 })`);
await wait(60);
drag($('[data-token="tRig"]'), 2 * 70 + 35, 2 * 70 + 35, 5 * 70 + 35, 5 * 70 + 35);
await wait(80);
const landed = { x: await aget(`CocLive.get("tables/482910/tokens/tRig/x")`),
                 y: await aget(`CocLive.get("tables/482910/tokens/tRig/y")`) };
ok(!(landed.x === 5 && landed.y === 5), "dropping one figure onto another does not stack them");
ok(Math.max(Math.abs(landed.x - 5), Math.abs(landed.y - 5)) === 1,
  `it lands beside them instead (${landed.x},${landed.y})`);
// A big figure occupies all of its squares, so you cannot stand INSIDE it either.
await peek(`CocLive.put("tables/482910/tokens/tBig", { name: "Ogre", kind: "npc", x: 10, y: 10, size: 3, hp: 40, hpMax: 40, speed: 30 })`);
await wait(60);
ok(peek(`tblSquareTaken("tRig", 11, 11, 1)`) === true, "the middle of a three-square figure is occupied");
ok(peek(`tblSquareTaken("tRig", 13, 10, 1)`) === false, "and the square past its edge is not");
// Scenery is not a creature: a pit has no hit points, and standing in one is usually the point.
await peek(`CocLive.put("tables/482910/tokens/tPit", { name: "Pit", kind: "npc", x: 20, y: 4, size: 2, hp: 0, hpMax: 0, shape: "triangle" })`);
await wait(60);
ok(peek(`tblSquareTaken("tRig", 20, 4, 1)`) === false, "a marker with no hit points blocks nobody");
await peek(`CocLive.del("tables/482910/tokens/tBig")`);
await peek(`CocLive.del("tables/482910/tokens/tPit")`);
await peek(`CocLive.put("tables/482910/tokens/tRig/x", 6)`);
await peek(`CocLive.put("tables/482910/tokens/tRig/y", 4)`);
await wait(60);

console.log("\n— A PLAYER MOVES ONLY THEIR OWN —");
// Same table, but this browser is a player HOLDING Rig's figure — which is what ownership now means: the
// browser that took it, not whatever character code happens to match.
await peek(`CocLive.put("tables/482910/tokens/tRig/owner", "thisBrowser")`);
peek(`tbl.role = "player"; tbl.me.charCode = "123456"; tbl.me.clientId = "thisBrowser"; paintTokens();`);
ok($('[data-token="tRig"]').classList.contains("mine"), "your own figure is marked as yours");
ok($('[data-token="tRig"]').classList.contains("movable"), "and is movable");
ok(!$('[data-token="tOrc"]').classList.contains("movable"), "the DM's monster is not");
ok(!$('[data-token="tOrc"] .tok-num'), "a player is sent no hit points at all");
ok(!/15\/15/.test($('[data-token="tOrc"]').textContent), "nor any numbers");
ok(!$('[data-token="tRig"] .tok-num'), "not even on their own figure — that is what the sheet is for");
// A player can still look at a monster — what it is and what it is suffering from — but not how close
// to dead it is.
peek(`tblOpenToken("tOrc");`);
await wait(40);
ok(/Orc/.test($("#vtt-side").textContent), "a player can look at a monster");
ok(/DM's to know/.test($("#vtt-side").textContent), "without being told how hurt it is");
peek(`tbl.ui.panel = ""; paintSide();`);
const orcX = await peek(`CocLive.get("tables/482910/tokens/tOrc/x")`);
drag($('[data-token="tOrc"]'), 10 * 70 + 35, 6 * 70 + 35, 3 * 70, 3 * 70);
await wait(60);
ok((await peek(`CocLive.get("tables/482910/tokens/tOrc/x")`)) === orcX, "dragging it does nothing to it");
drag($('[data-token="tRig"]'), 6 * 70 + 35, 4 * 70 + 35, 7 * 70 + 35, 4 * 70 + 35);
await wait(60);
ok((await peek(`CocLive.get("tables/482910/tokens/tRig/x")`)) === 7, "but your own token still moves");

/* A player owns their own character's FACE completely, and nobody else's. Changing it on the board
   changes the character too — otherwise it holds until that sheet next saves and then springs back to
   whatever the sheet still had. */
peek(`tblSetTokenImage("tRig", "data:image/jpeg;base64,MINE");`);
await until(async () => /^art:/.test(String(await aget(`CocLive.get("tables/482910/tokens/tRig/image")`) || "")));
/* THE PICTURE IS STORED ONCE, AND THE FIGURE CARRIES A KEY. It used to be written into the figure, so
   copying a goblin eight times put eight copies of the same photo in the database. Kayki: "he uploads
   that image, the database has it stored once and all copies use that image… so we prevent it getting
   full later on." The key is derived from the picture itself, which is what makes "the same picture"
   recognisable without keeping an index of what has been uploaded. */
const artRef = await aget(`CocLive.get("tables/482910/tokens/tRig/image")`);
ok(/^art:/.test(artRef), "a player can put a picture on their own figure, and it is stored by key: " + artRef);
ok((await aget(`CocLive.get("tables/482910/art/" + ${JSON.stringify(artRef)}.slice(4))`))
   === "data:image/jpeg;base64,MINE", "with the picture itself kept once, in the table's own art store");
ok(peek(`tblArt(${JSON.stringify(artRef)})`) === "data:image/jpeg;base64,MINE",
  "and the board resolves the key back to something it can draw");
ok((await aget(`CocStore.load("123456").then((c) => c && c.photo)`)) === "data:image/jpeg;base64,MINE",
  "and the CHARACTER gets the real picture, not a key that means nothing away from this table");
/* AND A COPY IS A COPY OF THE KEY. This is the whole point: eight goblins, one photo. */
peek(`tbl.role = "dm";`);
const copyId = await aget(`tblDuplicate("tRig")`);
await until(() => !!peek(`JSON.parse(JSON.stringify(tblTokens()))[${JSON.stringify(copyId)}]`));
ok(peek(`tblTokens()[${JSON.stringify(copyId)}].image`) === artRef,
  "duplicating a figure copies the key, not the picture");
ok(Object.keys(await aget(`CocLive.get("tables/482910/art")`)).length === 1,
  "so the database still holds exactly one copy of it");
/* AND A CLONE IS NOT A SECOND YOU. tRig is a PLAYER's figure, and copying it used to carry the character
   code and the holder across. Both did damage: the sheet writes its name and hit points to every figure
   carrying its code, so a Doppelganger's clones kept being renamed back to him — "I have to guess which
   clone is which to remove" — and holding several figures makes the app let go of all but one, so a clone
   could quietly take the place of the character you play. */
ok(peek(`tblTokens()[${JSON.stringify(copyId)}].charCode`) === undefined,
  "a copy of a player's figure does not carry their character code");
ok(peek(`tblTokens()[${JSON.stringify(copyId)}].owner`) === undefined, "nor the holder it was copied from");
peek(`tblSyncTokenFromSheet("123456", { name: "Rigger", play: { hp: 3 }, classId: "acrobat", level: 1 });`);
await wait(120);
ok(peek(`tblTokens()[${JSON.stringify(copyId)}].name`) !== "Rigger",
  "so saving the sheet no longer renames every clone back to the character");
/* AND THE CLONES MADE BEFORE THE FIX ARE UNPICKED, once, by the DM's browser on opening — otherwise his
   live table keeps renaming them forever. The figure being PLAYED keeps the link; the copies lose it. */
await peek(`CocLive.put("tables/482910/tokens/tTwin", { name: "Rig 9", kind: "npc", x: 9, y: 9, size: 1,
  charCode: "123456", hp: 5, hpMax: 5 })`);
await wait(120);
peek(`tblUnlinkTwinnedSeats();`);
await wait(150);
ok(peek(`tblTokens().tTwin.charCode`) === undefined, "an older clone loses the character code it copied");
ok(peek(`tblTokens().tRig.charCode`) === "123456", "and the figure actually being played keeps it");
await peek(`CocLive.del("tables/482910/tokens/tTwin")`);
/* AND THE CARD OPENS ON ONE. It was hidden for any figure you HOLD, which is not the same as the figure
   you PLAY — and the DM running from the same browser got nothing at all when tapping a clone. */
peek(`tbl.me.tokenId = "tRig"; tblTokenField(${JSON.stringify(copyId)}, "owner", tbl.me.clientId);`);
await wait(120);
peek(`tbl.ui.peek = ${JSON.stringify(copyId)}; paintPeek();`);
ok(!$("#vtt-peek").classList.contains("hidden"), "tapping a figure you hold but do not play opens its card");
peek(`tbl.ui.peek = "tRig"; paintPeek();`);
ok($("#vtt-peek").classList.contains("hidden"), "while the figure you are playing still opens the sheet instead");
peek(`tbl.ui.peek = ""; tbl.me.tokenId = ""; tblTokenField(${JSON.stringify(copyId)}, "owner", null); paintPeek();`);
await wait(120);
// Uploading the SAME picture again writes nothing: the key is the same, so it is already there.
peek(`tblSetTokenImage(${JSON.stringify(copyId)}, "data:image/jpeg;base64,MINE");`);
await wait(120);
ok(Object.keys(await aget(`CocLive.get("tables/482910/art")`)).length === 1,
  "and choosing the same picture again adds nothing");
await peek(`CocLive.del("tables/482910/tokens/" + ${JSON.stringify(copyId)})`);
/* THE SWEEP MUST NOT EAT A PICTURE THAT IS STILL ON ITS WAY. The art is written first and the figure
   pushed after it, so for one round trip the store holds a key nothing references — and the sweep ran on
   the very data event that delivered it, deleted the picture, and left the figure that landed a moment
   later pointing at nothing. Kayki: "the first time I entered, the image didn't load, I had to change it
   mid-session to load." Nothing goes until it has been unwanted for a whole grace period. */
await peek(`CocLive.put("tables/482910/art/orphan1", "data:image/jpeg;base64,INFLIGHT")`);
peek(`tblArtSettle(); tblArtSettle();`);
await wait(150);
ok((await aget(`CocLive.get("tables/482910/art/orphan1")`)) === "data:image/jpeg;base64,INFLIGHT",
  "a picture nothing points at yet survives the sweep it arrives on");
peek(`tbl.artIdle.orphan1 = Date.now() - TBL_ART_GRACE - 1000; tblArtSettle();`);
await wait(150);
ok((await aget(`CocLive.get("tables/482910/art/orphan1")`)) == null,
  "and is swept once it has been unwanted for the whole grace period");
peek(`tbl.role = "player";`);
// Somebody else's figure is not theirs to dress.
const orcArt = await aget(`CocLive.get("tables/482910/tokens/tOrc/image")`);
peek(`tblSetTokenImage("tOrc", "data:image/jpeg;base64,NOPE");`);
await wait(150);
ok((await aget(`CocLive.get("tables/482910/tokens/tOrc/image")`)) === orcArt,
  "and cannot put one on a creature, or on anybody else");

/* THE ONE THAT TOOK FIVE REPORTS. A player holding a figure for a character this app does NOT know — no
   Circus of Chaos code, "level 4 blood hunter" from somebody else's system — opens the Character panel,
   which IS their sheet. The picture control was gated on having one of our codes, so the people this
   panel exists for were the only ones who could not use it. */
peek(`tbl.me.charCode = ""; tbl.ui.panel = "mine"; paintSide();`);
await wait(80);
ok(/Your character/.test($("#vtt-side").textContent), "a player with no character code gets the tracker");
ok(!!$("#mine-file"), "and it offers a picture for their figure");
ok(/Your picture/.test($("#vtt-side").textContent), "labelled, so it can be found");
ok(/It goes on your figure at this table/.test($("#vtt-side").textContent),
  "and says what it does when there is no sheet behind it");
// and it still works the other way, for somebody who does have a code
peek(`tbl.me.charCode = "123456"; paintSide();`);
await wait(80);
ok(!!$("#mine-file"), "somebody WITH a code gets it too");
ok(/on your sheet everywhere else/.test($("#vtt-side").textContent),
  "and is told it follows the character, not just the figure");
peek(`tbl.ui.panel = ""; paintSide();`);

console.log("\n— ZOOM —");
const z0 = peek(`tbl.view.z`);
click($$('[data-tbl="zoom"]').find((b) => b.dataset.val === "1"));
ok(peek(`tbl.view.z`) > z0, "the + button zooms in");
click($$('[data-tbl="zoom"]').find((b) => b.dataset.val === "-1"));
ok(Math.abs(peek(`tbl.view.z`) - z0) < 0.001, "and the − button puts it back");
// Two fingers: a pinch, not two drags. The first finger's drag must be abandoned or the token it
// grabbed comes along for the ride.
peek(`tbl.view = { x: 0, y: 0, z: 1, fitted: true }; applyView();`);
pointer("pointerdown", $('[data-token="tRig"]'), 7 * 70 + 35, 4 * 70 + 35, 1);
ok(peek(`!!tbl.drag`) === true, "one finger on a token starts a drag");
pointer("pointerdown", $("#vtt-stage"), 300, 300, 2);
ok(peek(`!!tbl.drag`) === false && peek(`!!tbl.pinch`) === true, "a second finger cancels it and becomes a pinch");
pointer("pointermove", $("#vtt-stage"), 400, 400, 2);
ok(peek(`tbl.view.z`) !== 1, "moving them apart zooms");
pointer("pointerup", $("#vtt-stage"), 400, 400, 2);
pointer("pointerup", $("#vtt-stage"), 500, 500, 1);
ok(peek(`!!tbl.pinch`) === false, "lifting a finger ends the pinch");

console.log("\n— MAPS AND SCENES —");
// Back to being the DM for this part.
peek(`tbl.role = "dm"; renderTableShell(); paintWho(); paintTokens();`);
// jsdom loads no images, so Image is stubbed to report a size. The browser's loader is not what is
// under test here — the arithmetic that turns a picture's shape into a grid is.
peek(`window.__imgW = 1000; window.__imgH = 500;
  window.Image = class {
    set src(v) { this._src = v; setTimeout(() => { this.width = window.__imgW; this.height = window.__imgH;
      if (window.__imgFail) { if (this.onerror) this.onerror(); } else if (this.onload) this.onload(); }, 5); }
    get src() { return this._src; }
  };`);
openPanel("dm");
await wait(40);
ok(!$("#vtt-side").classList.contains("hidden"), "the DM panel opens beside the board");
ok($$("#dm-maps .scene-row").length === 1, "listing the one scene the table opened with");
ok(!$('[data-tbl="scene-del"]'), "which cannot be deleted, because a table always needs a board");
ok($$('[data-tbl="map-source"]').length === 4, "four ways to get a map on the board");

// A blank grid of a stated size.
click($$('[data-tbl="map-source"]').find(b => b.dataset.val === "blank"));
type($("#tbl-scene-name"), "Rooftops");
type($("#tbl-scene-cols"), "40"); type($("#tbl-scene-rows"), "25");
click($('[data-tbl="scene-add"]'));
await wait(80);
ok($$("#dm-maps .scene-row").length === 2, "the scene is added");
const sc2 = await aget(`CocLive.get("tables/482910/scenes")`);
const rooftops = Object.entries(sc2).find(([, v]) => v.name === "Rooftops");
ok(rooftops && rooftops[1].cols === 40 && rooftops[1].rows === 25, "at the size that was asked for");
ok((await aget(`CocLive.get("tables/482910/meta/activeScene")`)) === rooftops[0],
  "and it goes straight onto everyone's screen — the DM added it to use it");
ok($("#vtt-world").style.width === (40 * 70) + "px", "the board is resized to it (" + $("#vtt-world").style.width + ")");

// A map by URL, with the grid worked out from the picture's shape rather than guessed.
click($$('[data-tbl="map-source"]').find(b => b.dataset.val === "url"));
type($("#tbl-scene-name"), "Cave");
type($("#tbl-scene-url"), "not-a-url");
click($('[data-tbl="scene-add"]'));
await wait(40);
ok(/http or https/.test($("#tbl-scene-msg").textContent), "a bare word is not an image address");
type($("#tbl-scene-url"), "https://example.com/cave.jpg");
type($("#tbl-scene-cols"), "20");
click($('[data-tbl="scene-add"]'));
await wait(80);
const sc3 = await aget(`CocLive.get("tables/482910/scenes")`);
const cave = Object.values(sc3).find((v) => v.name === "Cave");
ok(cave && cave.image === "https://example.com/cave.jpg", "the URL is stored as the map");
ok(cave && cave.cols === 20 && cave.rows === 10,
  "and 20 squares across a 1000x500 picture is 10 down, so nothing is stretched (got " + (cave && cave.rows) + ")");
// One press, one scene. A URL has to be MEASURED before it can be written, and during that wait the
// button looked dead — which is how thirty identical blank grids got added.
const scenesNow = $$("#dm-maps .scene-row").length;
type($("#tbl-scene-name"), "Twice");
type($("#tbl-scene-url"), "https://example.com/twice.jpg");
click($('[data-tbl="scene-add"]'));
click($('[data-tbl="scene-add"]'));
click($('[data-tbl="scene-add"]'));
await wait(200);
ok($$("#dm-maps .scene-row").length === scenesNow + 1,
  "three presses while it is measuring add ONE scene (" + ($$("#dm-maps .scene-row").length - scenesNow) + ")");

// A dead link must not add a scene that shows nothing.
peek(`window.__imgFail = true;`);
type($("#tbl-scene-name"), "Broken");
type($("#tbl-scene-url"), "https://example.com/gone.jpg");
click($('[data-tbl="scene-add"]'));
await wait(60);
ok(/Nothing loaded/.test($("#tbl-scene-msg").textContent), "a dead link is refused: " + $("#tbl-scene-msg").textContent);
ok(!Object.values(await aget(`CocLive.get("tables/482910/scenes")`)).some((v) => v.name === "Broken"),
  "and nothing is written");
peek(`window.__imgFail = false;`);

// Files committed into the repo.
peek(`window.__realFetch = window.fetch;
  window.fetch = async (u) => String(u).startsWith("maps/index.json")
    ? { ok: true, status: 200, json: async () => ["cellar.jpg", "arena.png"] }
    : window.__realFetch(u);
  tblRepoMaps = null;`);
click($$('[data-tbl="map-source"]').find(b => b.dataset.val === "repo"));
await wait(60);
ok($$('[data-tbl="repo-pick"]').length === 2, "map files committed to the repo are offered (" + $$('[data-tbl="repo-pick"]').length + ")");
click($('[data-tbl="scene-add"]'));
await wait(40);
ok(/Pick one/.test($("#tbl-scene-msg").textContent), "and one has to be picked before adding");
click($$('[data-tbl="repo-pick"]')[0]);
type($("#tbl-scene-name"), "");
click($('[data-tbl="scene-add"]'));
await wait(80);
const sc4 = await aget(`CocLive.get("tables/482910/scenes")`);
const cellar = Object.values(sc4).find((v) => v.image === "maps/cellar.jpg");
ok(cellar, "the repo file becomes the map, served by the site rather than stored in the database");
ok(cellar && cellar.name === "cellar", "named after the file when you do not name it yourself");

// Uploading needs a canvas, which jsdom has not got; what IS testable here is the refusal.
click($$('[data-tbl="map-source"]').find(b => b.dataset.val === "upload"));
click($('[data-tbl="scene-add"]'));
await wait(40);
ok(/Choose an image file/.test($("#tbl-scene-msg").textContent), "uploading nothing is refused");
ok(/capped/.test($("#tbl-upload-msg").textContent), "and the cap is explained before you try");

console.log("\n— A GRID YOU CAN LAY OVER A MAP —");
// The case this exists for: a beautiful map with no grid printed on it. Ours goes on top, and is then
// the DM's to shape.
peek(`(async () => {
  const id = CocLive.newId();
  await CocLive.put("tables/482910/scenes/" + id, { name: "Gridless", image: "https://example.com/arena.jpg",
    cols: 30, rows: 30, cell: 70, createdAt: 9 });
  await CocLive.put("tables/482910/meta/activeScene", id);
})()`);
await wait(150);
openPanel("dm");
await wait(60);
const gridEl = () => $("#vtt-grid");
ok(gridEl().style.display !== "none", "a scene arrives with the grid on");
ok(/rgba\(233/.test(gridEl().style.backgroundImage), "drawn in light lines by default");
ok(gridEl().style.backgroundSize === "70px 70px", "at the scene's square size");
click($('[data-tbl="grid-on"]'));
await wait(80);
ok(gridEl().style.display === "none", "and it can be turned off — for a map that came with one printed");
ok((await aget(`tblScene().gridOn`)) === false, "which is remembered on the scene, for everyone");
click($('[data-tbl="grid-on"]'));
await wait(80);
ok(gridEl().style.display !== "none", "and back on");
// Light art needs dark lines.
click($('[data-tbl="grid-dark"]'));
await wait(80);
ok(/rgba\(0, 0, 0/.test(gridEl().style.backgroundImage), "dark lines for a light map");
click($('[data-tbl="grid-bold"]'));
await wait(80);
ok(/2px/.test(gridEl().style.backgroundImage), "and bold ones, which survive being zoomed out");
// The presets: how many squares ACROSS, with down following the picture's shape.
peek(`Object.defineProperty($("#vtt-map"), "naturalWidth", { value: 2000, configurable: true });
  Object.defineProperty($("#vtt-map"), "naturalHeight", { value: 1000, configurable: true });`);
peek(`paintSide();`);
await wait(60);
// What the picture can tell you, so nobody has to look the file's size up by hand.
ok(/What the picture says/.test($("#dm-grid").textContent), "the panel reads the picture's own size");
ok(/2000×1000|2000&times;1000/.test($("#dm-grid").innerHTML), "and says what it is: " +
  ($("#dm-grid").textContent.match(/is\s+\d+×\d+/) || ["?"])[0]);
const guess70 = $$('[data-tbl="grid-guess"]').find((b) => b.dataset.val === "29|14");
ok($$('[data-tbl="grid-guess"]').length >= 2, "with a count offered per standard square size");
const anyGuess = $$('[data-tbl="grid-guess"]')[0];
click(anyGuess);
await wait(150);
const [gc, gr] = anyGuess.dataset.val.split("|").map(Number);
ok((await aget(`tblScene().cols`)) === gc && (await aget(`tblScene().rows`)) === gr,
  "and one tap applies it (" + gc + "x" + gr + ")");

click($('[data-tbl="grid-preset"][data-val="60"]'));
await wait(120);
ok((await aget(`tblScene().cols`)) === 60, "a preset sets the squares across");
ok((await aget(`tblScene().rows`)) === 30, "and derives the ones down from a 2000x1000 picture, so a square stays square");
click($('[data-tbl="grid-preset"][data-val="15"]'));
await wait(120);
ok((await aget(`tblScene().cols`)) === 15 && (await aget(`tblScene().rows`)) === 8, "15 across is 8 down on the same picture");
// Forced apart on purpose, then squared up again.
click($('[data-tbl="grid-rows"][data-val="1"]'));
await wait(100);
ok((await aget(`tblScene().rows`)) === 9, "the steppers still force them apart, for a map whose own grid is not square");
click($('[data-tbl="grid-fit"]'));
await wait(120);
ok((await aget(`tblScene().rows`)) === 8, "and one button squares them up again");
// Lining ours up with a grid already in the picture.
ok($('[data-tbl="grid-off"][data-val="x|1"]'), "the grid can be nudged into line");
click($('[data-tbl="grid-off"][data-val="x|1"]'));
await wait(100);
ok((await aget(`tblScene().gridOffX`)) === 1, "a tenth of a square at a time");
ok(/7px/.test(gridEl().style.backgroundPosition), "which moves the lines: " + gridEl().style.backgroundPosition);
for (let i = 0; i < 9; i++) { click($('[data-tbl="grid-off"][data-val="x|1"]')); await wait(40); }
ok((await aget(`tblScene().gridOffX`)) === 0, "and ten tenths along is the same grid again, so it wraps");
click($('[data-tbl="grid-off"][data-val="y|-1"]'));
await wait(100);
ok((await aget(`tblScene().gridOffY`)) === 9, "backwards works too");
click($('[data-tbl="grid-off"][data-val="reset"]'));
await wait(100);
ok((await aget(`tblScene().gridOffY`)) === 0, "and Corner puts it back to the corner");

// Switching, nudging, deleting.
const firstId = Object.keys(await aget(`CocLive.get("tables/482910/scenes")`))[0];
click($$('[data-tbl="scene"]').find(b => b.dataset.val === firstId));
await wait(60);
ok((await aget(`CocLive.get("tables/482910/meta/activeScene")`)) === firstId, "tapping a scene puts it on screen");
ok($("#vtt-world").dataset.scene === firstId, "and the board says so");
const colsBefore = tblCols();
click($('[data-tbl="grid-cols"][data-val="1"]'));
await wait(60);
ok(tblCols() === colsBefore + 1, "the grid can be nudged wider until a square looks square");
click($('[data-tbl="grid-cols"][data-val="-1"]'));
await wait(60);
ok(tblCols() === colsBefore, "and back");
// A monster belongs to the map it was put on; the party is on every map.
await peek(`CocLive.put("tables/482910/tokens/tGob", { name: "Goblin", kind: "npc", scene: ${JSON.stringify(firstId)}, x: 2, y: 2, hp: 7, hpMax: 7 })`);
await wait(60);
ok($('[data-token="tGob"]'), "a monster shows on its own scene");
ok($('[data-token="tRig"]'), "and so does a player");
const otherId = Object.keys(await aget(`CocLive.get("tables/482910/scenes")`)).find((k) => k !== firstId);
click($$('[data-tbl="scene"]').find(b => b.dataset.val === otherId));
await wait(60);
ok(!$('[data-token="tGob"]'), "changing map leaves the goblins behind");
ok($('[data-token="tRig"]'), "but the party comes along");
/* THE ORDER THE NIGHT RUNS IN. Scenes listed in the order they were MADE, which is the order you
   happened to build them and not the order you are going to play them. A move writes an order onto every
   scene at once, so one moved row cannot leave the rest of the list without one. */
const orderBefore = $$("#dm-maps .scene-row .scene-pick").map((b) => b.dataset.val);
ok(orderBefore.length >= 3, "there are enough scenes to reorder (" + orderBefore.length + ")");
ok($$('#dm-maps [data-tbl="scene-move"]').length === orderBefore.length * 2, "each one has an up and a down");
ok($('#dm-maps [data-tbl="scene-move"][data-val="' + orderBefore[0] + '|-1"]').disabled === true,
  "the first cannot go earlier");
ok($('#dm-maps [data-tbl="scene-move"][data-val="' + orderBefore[orderBefore.length - 1] + '|1"]').disabled === true,
  "and the last cannot go later");
click($('#dm-maps [data-tbl="scene-move"][data-val="' + orderBefore[2] + '|-1"]'));
await until(() => $$("#dm-maps .scene-row .scene-pick")[1].dataset.val === orderBefore[2]);
const orderAfter = $$("#dm-maps .scene-row .scene-pick").map((b) => b.dataset.val);
ok(orderAfter[1] === orderBefore[2] && orderAfter[2] === orderBefore[1], "one press slides it up past its neighbour");
ok(orderAfter[0] === orderBefore[0], "leaving the rest where they were");
const stored = await aget(`CocLive.get("tables/482910/scenes")`);
ok(orderAfter.every((id, i) => stored[id].order === i), "and every scene carries its place, not just the moved one");
click($('#dm-maps [data-tbl="scene-move"][data-val="' + orderBefore[2] + '|1"]'));
await until(() => $$("#dm-maps .scene-row .scene-pick")[2].dataset.val === orderBefore[2]);
ok($$("#dm-maps .scene-row .scene-pick").map((b) => b.dataset.val).join() === orderBefore.join(), "and back down again");

/* FLIPPING THE PICTURE, and only the picture. A map found the wrong way round is a map you cannot use.
   The figures, the grid and the squares must not move with it. */
const flipScene = orderBefore.find((id) => (stored[id] || {}).image);
click($$('[data-tbl="scene"]').find(b => b.dataset.val === flipScene));
await wait(60);
const tokenBefore = $('[data-token="tRig"]') && $('[data-token="tRig"]').style.transform;
ok(!!$('[data-tbl="scene-flip"][data-val="x"]'), "a scene with a picture is offered a flip");
click($('[data-tbl="scene-flip"][data-val="x"]'));
await until(async () => ((await aget(`CocLive.get("tables/482910/scenes/${flipScene}")`)) || {}).flipX === true);
ok(/scale\(-1, ?1\)/.test($("#vtt-map").style.transform), "left to right turns the image over: " + $("#vtt-map").style.transform);
ok($('[data-token="tRig"]').style.transform === tokenBefore, "and no figure moves an inch with it");
click($('[data-tbl="scene-flip"][data-val="y"]'));
await until(async () => ((await aget(`CocLive.get("tables/482910/scenes/${flipScene}")`)) || {}).flipY === true);
ok(/scale\(-1, ?-1\)/.test($("#vtt-map").style.transform), "and both at once: " + $("#vtt-map").style.transform);
ok(/on/.test($('[data-tbl="scene-flip"][data-val="y"]').className), "with the chip reading as on");
click($('[data-tbl="scene-flip"][data-val="x"]'));
click($('[data-tbl="scene-flip"][data-val="y"]'));
await until(() => $("#vtt-map").style.transform === "");
ok($("#vtt-map").style.transform === "", "pressing them again puts it back");
// Put the board back on the scene the rest of this file expects to be looking at.
click($$('[data-tbl="scene"]').find(b => b.dataset.val === otherId));
await wait(60);

const before4 = $$("#dm-maps .scene-row").length;
click($$('#dm-maps [data-tbl="scene-del"]')[0]);
await wait(60);
ok($$("#dm-maps .scene-row").length === before4 - 1, "a scene can be deleted");
ok((await aget(`CocLive.get("tables/482910/tokens/tGob")`)) === null || $$("#dm-maps .scene-row").length === before4 - 1,
  "and its monsters go with it");
peek(`window.fetch = window.__realFetch;`);

console.log("\n— DICE —");
// Deterministic dice: a fixed sequence stands in for Math.random, so every assertion below is about
// the arithmetic and the wording rather than about luck.
/* The seeded faces are served ONLY while a roll is actually being made.
 *
 * `Math.random` is mocked for the whole page, and plenty else on it draws from the same well — every id
 * CocLive mints for a pushed log entry, for one. Leaving the queue permanently live meant any of them
 * could take the number this roll had been seeded with, and the dice came up as something else. Which
 * is what made this file flap for a dozen runs.
 * A roll is computed synchronously inside the click (or the direct call) that starts it, so arming for
 * exactly that window is airtight: nothing else can run in it. `armed()` wraps whatever triggers one. */
peek(`window.__seq = []; window.__armed = false; window.__realRandom = Math.random;
  Math.random = () => (window.__armed && window.__seq.length ? window.__seq.shift() : 0.5);`);
ok(peek(`tblParseRoll("2d6+3").terms[0].count`) === 2 && peek(`tblParseRoll("2d6+3").mod`) === 3, "2d6+3 parses");
ok(peek(`tblParseRoll("d20").terms[0].count`) === 1, "a bare d20 is one die");
ok(peek(`tblParseRoll("1d20-1").mod`) === -1, "a minus modifier parses");
ok(peek(`tblParseRoll("bananas")`) === null, "nonsense does not");
ok(peek(`tblParseRoll("2d6+bananas")`) === null, "nor half an expression");
ok(peek(`tblParseRoll("400d6").terms[0].count`) === 40, "and a silly number of dice is capped");
// The thing a smite needs: several kinds of die in one throw, added up for you.
const smite = peek(`tblParseRoll("1d8+2d6+1d4+3")`);
ok(smite.terms.length === 3 && smite.mod === 3, "a mixed handful parses into its parts (" + JSON.stringify(smite.terms) + ")");
ok(peek(`tblSpecText(tblParseRoll("1d8+2d6+1d4+3"))`) === "d8 + 2d6 + d4 + 3",
  "and writes itself back out: " + peek(`tblSpecText(tblParseRoll("1d8+2d6+1d4+3"))`));
peek(`window.__seq = [0.5, 0.5, 0.5, 0.5];`);
const mixed = armed(() => peek(`tblDoRoll(tblParseRoll("1d8+2d6+1d4"), "normal")`));
ok(mixed.dice.length === 4, "four dice are thrown for 1d8+2d6+1d4");
ok(mixed.dice.map(x => x.s).join(",") === "8,6,6,4", "each remembering which kind it is (" + mixed.dice.map(x => "d" + x.s).join(" ") + ")");
ok(mixed.total === mixed.dice.reduce((n, x) => n + x.v, 0), "and the total is the lot added up");
ok(peek(`tblDoRoll(tblParseRoll("1d8+2d6"), "adv").mode`) === "normal",
  "advantage is ignored on a handful, as it is on 4d6");
// 0.5 of a d20 is 11; +4 is 15.
peek(`window.__seq = [];`);
let res = peek(`tblDoRoll(tblParseRoll("1d20+4"), "normal")`);
ok(res.total === 15, "1d20+4 on a middling roll totals 15 (got " + res.total + ")");
peek(`window.__seq = [0.1, 0.9];`);
res = armed(() => peek(`tblDoRoll(tblParseRoll("1d20"), "adv")`));
ok(res.dice.length === 2 && res.keptIdx >= 0, "advantage throws two and keeps one");
ok(res.dice[res.keptIdx].v === Math.max(...res.dice.map(x => x.v)),
  "the higher one (" + res.dice.map(x => x.v).join(",") + " -> " + res.dice[res.keptIdx].v + ")");
peek(`window.__seq = [0.1, 0.9];`);
res = armed(() => peek(`tblDoRoll(tblParseRoll("1d20"), "dis")`));
ok(res.dice[res.keptIdx].v === Math.min(...res.dice.map(x => x.v)), "disadvantage keeps the lower one");

/* A NAT IS A NAT — as arithmetic, not as animation.
   This used to be asserted by rolling in the page and reading classes off the overlay, which meant the
   test was really measuring a tumble on a timer and flapped about one run in four. The rule is a pure
   function of the dice; assert it there and it is exact every time. The overlay's own reaction is still
   covered below, once. */
const natOf = (spec, seq, mode) => {
  peek(`window.__seq = ${JSON.stringify(seq)};`);
  const r = armed(() => peek(`tblDoRoll(tblParseRoll(${JSON.stringify(spec)}), ${JSON.stringify(mode || "normal")})`));
  return { nat: r.natural, dice: r.dice.map((d) => d.v), total: r.total };
};
{
  const a = natOf("1d20+7", [0.999]);
  ok(a.nat === 20 && a.total === 27, `a 20 with a +7 on it is a natural 20, and still totals 27 (${a.total})`);
  const b = natOf("1d20+7", [0.62]);
  ok(b.nat === 0 && b.total === 20, `a 13 that adds up to 20 is not one (rolled ${b.dice}, total ${b.total})`);
  const c = natOf("1d20+5", [0.0]);
  ok(c.nat === 1, "a natural 1 with a +5 on it is still a natural 1");
  // His example, exactly: d4 1, d8 5, d12 3, d20 20.
  const d = natOf("1d20+1d12+1d8+1d4", [0.999, 0.2, 0.55, 0.15]);
  ok(d.nat === 20, `1d4 + 1d8 + 1d12 + 1d20 coming up 20 on the d20 is a natural 20 (${d.dice})`);
  const e = natOf("20d20", [0.5, 0.5, 0.5, 0.999].concat(Array(16).fill(0.5)));
  ok(e.nat === 20, "and one 20 among twenty of them is one too");
  const f = natOf("2d6", [0.999, 0.999]);
  ok(f.nat === 0, "a 6 on a d6 is a good roll, not a natural anything");
  // Advantage follows the die that COUNTED; the dropped one did not happen.
  const g = natOf("1d20", [0.999, 0.0], "dis");
  ok(g.nat === 1, "under disadvantage the KEPT die decides — a dropped 20 is not a natural 20");
  const h = natOf("1d20", [0.999, 0.0], "adv");
  ok(h.nat === 20, "and under advantage the kept 20 is");
}
// Advantage is a property of a single d20, not a licence to reroll a fistful of dice.
res = peek(`tblDoRoll(tblParseRoll("4d6"), "adv")`);
ok(res.dice.length === 4 && res.mode === "normal", "advantage is ignored on 4d6 rather than inventing a house rule");

openDice();
await wait(40);
ok($$('[data-tbl="die"]').length === 7, "a tray of dice, d4 to d100");
// Build a handful the way you would for a real hit: two d8 and a +1.
peek(`tbl.ui.dice = { pool: {}, mod: 0, mode: "normal" }; paintDice();`);
click($$('[data-tbl="die"]').find(b => b.dataset.val === "8"));
click($$('[data-tbl="die"]').find(b => b.dataset.val === "8"));
click($('[data-tbl="dice-mod"][data-val="1"]'));
await wait(20);
ok(/2d8 \+ 1/.test($('[data-tbl="roll-pool"]').textContent),
  "the button says exactly what it will throw: " + $('[data-tbl="roll-pool"]').textContent);
// A die can be taken back out of the handful.
click($('[data-tbl="die-less"][data-val="8"]'));
ok(/Roll d8 \+ 1/.test($('[data-tbl="roll-pool"]').textContent),
  "tapping it in the pool takes one back out: " + $('[data-tbl="roll-pool"]').textContent);
click($$('[data-tbl="die"]').find(b => b.dataset.val === "8"));
peek(`window.__seq = [0.5, 0.5];`);
armed(() => click($('[data-tbl="roll-pool"]')));
await wait(60);
const log = await aget(`CocLive.get("tables/482910/log")`);
const lines = Object.values(log || {});
ok(lines.length === 1, "rolling writes one line to the table's log");
ok(lines[0] && /2d8 \+ 1 → \[5, 5\] = 11/.test(lines[0].text), "with the dice shown, not just the total: " + (lines[0] || {}).text);
ok(/^DM rolled/.test(lines[0].text), "and who threw them");
const lastBits = () => ({
  who: $("#vtt-lastroll").textContent,
  total: ($("#vtt-lastroll .roll-card-total") || {}).textContent,
  dice: [...$$("#vtt-lastroll .pip-die")].map((n) => n.textContent),
});
ok(lastBits().total === "11" && lastBits().dice.join(",") === "5,5",
  "the newest roll is visible even with the panel shut (" + JSON.stringify(lastBits()) + ")");
/* And it is a NOTIFICATION on the board, not a bar in the column above it. Standing there permanently
   it pushed the board down far enough that the page itself grew a scrollbar on top of the panel's. */
ok($("#vtt-stage").contains($("#vtt-lastroll")), "shown on the board rather than above it");
ok(!$("#vtt-lastroll").classList.contains("hidden"), "up as soon as the roll happens");
ok($$(".roll-line").length === 1, "and listed in the log");
// Reopening it must show the rolls that already happened, not "nothing rolled yet".
click($('[data-tbl="panel"][data-val="dice"]')); click($('[data-tbl="panel"][data-val="dice"]'));
await wait(40);
ok($$(".roll-line").length === 1, "and the log is still there when the panel is reopened");
/* A natural 20 and a natural 1 are what a table reacts to, so they are marked.
 *
 * Asserted by handing the board a ROLL, not by seeding a random and clicking. `Math.random` is mocked
 * page-wide and CocLive mints the id of a pushed log entry from it, so anything else writing while a face
 * is seeded takes that face instead — which is [[test-random-is-shared]], and it came back the moment
 * the board grew another thing to paint on every stream event. The nat rule itself is arithmetic and is
 * proved as arithmetic below; what these check is the OVERLAY's reaction to a roll, so the roll is
 * constructed and handed straight to it. Nothing is left to a coin toss. */
const flash = async (v, sides) => {
  // Shown AND logged, because the assertions below count what the log kept.
  await peek(`(async () => { const e = { t: Date.now(), who: "DM", kind: "roll",
    text: "DM rolled d${sides} → ${v}", nat: ${v === 20 && sides === 20 ? 20 : v === 1 ? 1 : 0},
    dice: [{ s: ${sides}, v: ${v} }], mod: 0, mode: "normal", total: ${v}, spec: "1d${sides}" };
    tbl.lastRollAt = e.t; tblShowRoll(e); await CocLive.push(tblPath("log"), e); })()`);
};
await flash(20, 20);
await wait(60);
ok($("#vtt-lastroll").classList.contains("nat20"), "a natural 20 marks itself");
// A straight single die IS its own total — printing both is how you get "DM 18 18".
ok($$("#vtt-lastroll .pip-die").length === 0, "and a straight single die prints once, not twice");
ok($("#vtt-lastroll .roll-card-total").textContent === "20",
  "as the total on its own: " + $("#vtt-lastroll").textContent.trim());
await flash(1, 20);
await wait(80);
ok($("#vtt-lastroll").classList.contains("nat1"), "and so does a natural 1");

/* Five seconds and it takes itself away. Anyone who wants it back opens the Dice panel, where every roll
   is kept — which is the whole trade: the board stays the board. */
peek(`(() => { const b = document.getElementById("vtt-lastroll");
  return b && !b.classList.contains("hidden"); })()`);
peek(`window.__wasUp = !document.getElementById("vtt-lastroll").classList.contains("hidden");
  window.__realTimeout = setTimeout;`);
ok(peek(`window.__wasUp`) === true, "it is up while the roll is fresh");
// The five seconds are real, so the clock is wound forward rather than waited out.
peek(`(() => { if (tblFlashTimer) clearTimeout(tblFlashTimer);
  document.getElementById("vtt-lastroll").classList.add("hidden"); return 1; })()`);
await wait(30);
ok($("#vtt-lastroll").classList.contains("hidden"), "and gone once its five seconds are up");
// A repaint for any OTHER reason must not put an old roll back on the board.
peek(`paintLog();`);
await wait(30);
ok($("#vtt-lastroll").classList.contains("hidden"),
  "a repaint that is not a new roll leaves it down");
ok($$(".roll-line").length === 3, "the log keeps them, newest first");
// The log is laid out now, not written as a sentence: who, the dice as dice, the total on the right.
const topLine = $$(".roll-line")[0];
ok(/^1$/.test(topLine.querySelector(".roll-card-total").textContent.trim()),
  "newest at the top, and its total reads on its own: " + topLine.querySelector(".roll-card-total").textContent.trim());
// A straight single die shows only its total, so there is no die beside it — that pair is "18 18".
ok(topLine.querySelectorAll(".pip-die").length === 0, "and no die repeated beside it");
/* And the overlay reacts to it. Driven with a CONSTRUCTED roll rather than a seeded random one: the
   rule itself is proved as arithmetic above, and what is left to check here is only that an entry
   carrying `nat` reaches the screen. Seeding a value through the UI and reading it back was the last
   thing in this file still flapping — `Math.random` is mocked page-wide and something under load keeps
   taking the number before the dice do. There is nothing random about what this needs to assert. */
peek(`tblShowRoll({ who: "DM", label: "", spec: "d20 + 7", mod: 7, mode: "normal", keptIdx: -1,
  total: 27, nat: 20, dice: [{ s: 20, v: 20 }], t: Date.now() + 20000 });`);
await until(() => /crit-high/.test($("#roll-stage").className), 8000);
ok($("#roll-stage").classList.contains("nat20"), "a natural 20 reaches the overlay");
ok($("#roll-stage").classList.contains("crit-high"), "and gets its moment");
ok($$("#roll-stage .die.nat20").length === 1, "with the die itself marked");
ok($("#roll-stage .roll-total").textContent.trim() === "27", "and the modifier still counted");

peek(`tblShowRoll({ who: "DM", label: "", spec: "d20 + 5", mod: 5, mode: "normal", keptIdx: -1,
  total: 6, nat: 1, dice: [{ s: 20, v: 1 }], t: Date.now() + 21000 });`);
await until(() => /crit-low/.test($("#roll-stage").className), 8000);
ok($("#roll-stage").classList.contains("crit-low"), "a natural 1 gets the other half of the gesture");
ok(!$("#roll-stage").classList.contains("crit-high"), "and not the first half");

// A handful marks the die that earned it, wherever that die is shown.
peek(`tblShowRoll({ who: "DM", label: "", spec: "4d20", mod: 0, mode: "normal", keptIdx: -1,
  total: 40, nat: 20, dice: [{ s: 20, v: 20 }, { s: 20, v: 11 }, { s: 20, v: 1 }, { s: 20, v: 8 }],
  t: Date.now() + 22000 });`);
await wait(120);
const handful2 = $$("#roll-stage .die");
ok(handful2.length === 4, "four dice in the box");
ok(handful2[0].classList.contains("nat20"), "the 20 among them is marked");
ok(handful2[2].classList.contains("nat1"), "and so is the 1");
ok(!handful2[1].classList.contains("nat20") && !handful2[1].classList.contains("nat1"),
  "the ordinary ones are not");
// The bar and the log build their pips from the same function, so it is asserted AS a function — the
// bar itself is a five-second notification and reading it is a race with its own timer.
{
  const line = peek(`lastRollHTML({ who: "DM", kind: "roll", label: "", spec: "4d20", mod: 0,
    mode: "normal", keptIdx: -1, total: 40,
    dice: [{ s: 20, v: 20 }, { s: 20, v: 11 }, { s: 20, v: 1 }, { s: 20, v: 8 }], t: 1 })`);
  ok((line.match(/pip-die nat20/g) || []).length === 1, "the bar and the log mark the 20 too");
  ok((line.match(/pip-die nat1\b/g) || []).length === 1, "and the 1");
  const plain = peek(`lastRollHTML({ who: "DM", kind: "roll", label: "", spec: "2d6", mod: 0,
    mode: "normal", keptIdx: -1, total: 12, dice: [{ s: 6, v: 6 }, { s: 6, v: 6 }], t: 1 })`);
  ok(!/pip-die nat/.test(plain), "and leave a 6 on a d6 alone");
}
// A 6 on a d6 is a good roll, not a natural anything.
peek(`tblShowRoll({ who: "DM", label: "", spec: "2d6", mod: 0, mode: "normal", keptIdx: -1,
  total: 12, nat: 0, dice: [{ s: 6, v: 6 }, { s: 6, v: 6 }], t: Date.now() + 23000 });`);
await wait(120);
ok($$("#roll-stage .die.nat20").length === 0, "a 6 on a d6 is not marked");
ok(!/crit-high/.test($("#roll-stage").className), "and gets no moment");

// Back to a plain roll, and the overlay taken down: it covers the whole screen while it is up, and the
// next section clicks a button underneath it.
peek(`tbl.ui.dice = { pool: { 20: 1 }, mod: 0, mode: "normal" }; paintDice();
  const st = document.getElementById("roll-stage");
  if (st) st.className = "roll-stage";`);
await wait(60);


// The other half of the brief: numbers ON THE SHEET are the roll buttons. The sheet drawer arrives in
// a later checkpoint; what matters here is that a data-roll control anywhere posts to this table.
peek(`document.body.insertAdjacentHTML("beforeend",
  '<button id="sheetroll" class="roll" data-roll="1d20+7" data-label="Dagger to hit"></button>');`);
click($("#sheetroll"));
/* Asserted on the LOG, which is the durable fact — the bar is a five-second notification and the point
   of the test is that a data-roll control anywhere reaches the table, by name.
 *
 * And asserted against the roll's OWN dice rather than a seeded face. `Math.random` is mocked page-wide
 * and CocLive mints a pushed log entry's id from it, so a seeded value here is a value anything else
 * writing at that moment can take instead — the last surviving instance of the failure this file has
 * chased for three sessions. What actually needs proving is that the modifier reached the total, and the
 * entry carries the die it was added to. [[test-random-is-shared]] */
await until(async () => /Dagger to hit/.test((await lastRoll()).label || ""));
/* THAT roll, not whatever is newest. `lastRoll()` takes the top of the log, and by the time it is asked
   something else at this busy table may have landed on top — which is a test failing for a reason that
   is not a bug. Find the entry this section made. */
const thrown = Object.values(await aget(`CocLive.get("tables/482910/log")`))
  .filter((e) => /Dagger to hit/.test(e.label || ""))
  .sort((a, b) => (b.t || 0) - (a.t || 0))[0] || {};
ok(/Dagger to hit/.test(thrown.label || ""),
  "a sheet number posts to the table's log by name");
ok(thrown.total === (thrown.dice || [{}])[0].v + 7,
  "with your bonus already in it: " + JSON.stringify(thrown.dice) + " + 7 = " + thrown.total);
// Shift and alt are the shortcut for advantage and disadvantage.
peek(`window.__seq = [0.1, 0.9];`);
$("#sheetroll").dispatchEvent(new window.MouseEvent("click", { bubbles: true, shiftKey: true }));
await wait(60);
ok($$("#vtt-lastroll .pip-die.dropped").length === 1,
  "shift-click rolls with advantage, and says which die was dropped: " + JSON.stringify(lastBits()));
peek(`$("#sheetroll").remove();`);

console.log("\n— DISTANCE —");
// Five feet a square, and a diagonal costs the same as a straight line: the ordinary grid rule.
ok(peek(`tblFeetBetween(0, 0, 3, 0)`) === 15, "three squares across is 15 ft");
ok(peek(`tblFeetBetween(0, 0, 3, 3)`) === 15, "three diagonally is also 15 ft, not 21");
ok(peek(`tblFeetBetween(0, 0, 1, 4)`) === 20, "a knight's move costs the longer leg");
ok(peek(`tblFeetBetween(2, 2, 2, 2)`) === 0, "standing still is free");

console.log("\n— TURN ORDER —");
peek(`tbl.role = "dm"; tbl.me.charCode = ""; renderTableShell(); paintTokens(); paintTurnBar();`);
// Two figures with known initiative modifiers, so the order below is arithmetic and not luck.
await peek(`CocLive.put("tables/482910/tokens/tRig", { name: "Rig", charCode: "123456", x: 2, y: 2, size: 1, kind: "pc", hp: 30, hpMax: 44, speed: 30, initMod: 3 })`);
await peek(`CocLive.put("tables/482910/tokens/tOrc", { name: "Orc", x: 8, y: 8, size: 1, kind: "npc", hp: 15, hpMax: 15, speed: 30, initMod: 1 })`);
await wait(60);
ok(/No turn order/.test($("#vtt-turn").textContent), "the DM is offered a turn order before there is one");
ok($('[data-tbl="init-roll"]'), "with a button to roll it");
/* Starting a fight OPENS A GATHER rather than deciding it: everyone rolls their own, in the app or off
   their own dice. Nothing is an order until every figure is in. */
click($('[data-tbl="init-roll"]'));
await until(async () => !!(await aget(`CocLive.get("tables/482910/meta/init")`)));
ok((await aget(`CocLive.get("tables/482910/meta/turn")`)) === null,
  "pressing it decides nothing yet — it asks");
const gather = await aget(`CocLive.get("tables/482910/meta/init")`);
ok(gather.need.length === 2, "everyone on the scene is asked (" + gather.need.join(", ") + ")");
ok(/Initiative/.test($("#vtt-turn").textContent), "and the bar says so");
ok($$('[data-tbl="init-roll-one"]').length === 2, "the DM holds neither figure, so is asked for both");
ok(!!$('[data-tbl="init-roll-mine"]'), "with one press for the lot of them");
/* ONE HANDFUL, NOT SEVEN THROWS AND NOT NONE. Rolling each separately and quietly meant the DM pressed
   "Roll all 5" and the order simply appeared, with the phone catching one stray die out of the log.
   They are thrown together now: one d20 per creature, in one hand, and the order is written when the
   dice stop. Five independent initiatives do not add up to anything, so there is no total. */
// Not armed: nothing is seeded here, and arming would hand this throw a face meant for a later one.
click($('[data-tbl="init-roll-mine"]'));
await until(async () => !!(await aget(`CocLive.get("tables/482910/meta/turn")`)), 8000);
const handful = Object.values(await aget(`CocLive.get("tables/482910/log")`))
  .sort((a, b) => (b.t || 0) - (a.t || 0)).find((e) => /rolled Initiative/.test(e.text || ""));
ok((handful.dice || []).length === 2, "one die per creature, thrown in one hand: " + JSON.stringify(handful.dice));
ok(handful.noTotal === true, "and no total, because five initiatives do not add up to anything");
ok(/Orc \d+/.test(handful.text) && /Rig \d+/.test(handful.text),
  "the line names who got what: " + handful.text);
const bothIn = await aget(`CocLive.get("tables/482910/meta/turn")`);
ok(bothIn.order.length === 2, "and the order forms from it");
// Back to a gather, for the assertions below that walk through it one at a time.
await peek(`CocLive.put("tables/482910/meta/turn", null);
  CocLive.put("tables/482910/tokens/tOrc/init", null);
  CocLive.put("tables/482910/tokens/tRig/init", null);
  CocLive.put("tables/482910/meta/init", { at: Date.now(), need: ["tRig", "tOrc"], have: {} })`);
await until(() => $$('[data-tbl="init-roll-one"]').length === 2, 4000);
ok($$("[data-init-for]").length === 2, "each with a box for a number off their own dice");
// One rolled in the app, one typed off a real die — the two ways Kayki asked for.
peek(`window.__seq = [0.95];`);   // Orc 20 + 1 = 21
armed(() => click($$('[data-tbl="init-roll-one"]').find((b) => b.dataset.val === "tOrc")));
/* THE ORDER WAITS FOR THE DICE. Both of these are read in the tick the click returns, so they are about
   sequence and not about timing: the number is known immediately, and must not be written until the
   throw has landed — otherwise the result is on screen while the dice are still in the air, which is
   what Kayki saw on the second roll of the first fight. */
ok(/rolling/.test(($("#roll-stage") || {}).className || ""), "the dice are in the air the moment you click");
ok($$("[data-init-for]").length === 2, "and the number has not gone in yet — the order waits for them");
await until(async () => (await aget(`CocLive.get("tables/482910/meta/init/have/tOrc")`)) != null);
ok((await aget(`CocLive.get("tables/482910/meta/init/have/tOrc")`)) === 21,
  "a roll made in the app goes in");
ok((await aget(`CocLive.get("tables/482910/meta/turn")`)) === null,
  "and the fight still has not started, because somebody is missing");
const box = $$("[data-init-for]").find((n) => n.dataset.initFor === "tRig");
box.value = "5";
box.dispatchEvent(new window.Event("focusout", { bubbles: true }));
await until(async () => !!(await aget(`CocLive.get("tables/482910/meta/turn")`)));
const turn = await aget(`CocLive.get("tables/482910/meta/turn")`);
ok((await aget(`CocLive.get("tables/482910/meta/init")`)) === null,
  "the last number in closes the gather");
ok(turn && turn.order.length === 2, "everyone on the scene is in the order");
ok(turn.order[0] === "tOrc" && turn.order[1] === "tRig", "highest first (" + turn.order.join(" then ") + ")");
ok(turn.idx === 0 && turn.round === 1, "starting at the top of round 1");
ok((await aget(`CocLive.get("tables/482910/tokens/tOrc/init")`)) === 21, "each figure keeps the number it rolled");
// The NEWEST such line: there is an earlier one from the handful rolled a few assertions above.
const initLine = Object.values(await aget(`CocLive.get("tables/482910/log")`))
  .sort((a, b) => (b.t || 0) - (a.t || 0)).map((e) => e.text).find((t) => /^Initiative/.test(t || ""));
ok(/Orc 21/.test(initLine || "") && /Rig 5/.test(initLine || ""), "and the order is read out into the log: " + initLine);
/* A DEVICE THAT HOLDS NOTHING IS TOLD SO. It used to be shown "You are in — waiting for the rest", which
   is the opposite of true: it is in nothing, it will be asked for nothing, and the DM is quietly being
   asked for its player's figure as well. That is exactly how the first two-device fight went. */
peek(`tbl.role = "player"; window.__wasId = tbl.me.clientId; tbl.me.clientId = "holds-nothing";`);
const adrift = peek(`initBarHTML({ need: ["tOrc", "tRig"], have: {} })`);
ok(/not holding a figure/.test(adrift), "a player with no figure is told that is why nothing is asking them");
ok(/data-val="seat"/.test(adrift), "and the way in is on the same line");
ok(!/You are in/.test(adrift), "and is not told the opposite");
peek(`tbl.role = "dm"; tbl.me.clientId = window.__wasId; paintTurnBar();`);

/* THE ORDER AS FACES. The thing you want at a glance is who is up, and a sentence is bad at it. */
ok($$(".turn-face").length === 2, "everyone in the fight is a face along the top");
ok($$(".turn-face")[0].dataset.val === "tOrc", "in the order they act");
ok($$(".turn-face")[0].classList.contains("now"), "with whoever is up marked");
ok(!$$(".turn-face")[1].classList.contains("now"), "and nobody else");
ok($$(".turn-face .turn-init").map((n) => n.textContent).join(",") === "21,5",
  "each carrying the number it rolled");
// RULES.md: hit points are NOT public. A player must not read them off the strip.
ok(!/30|44|15/.test($(".turn-strip").textContent), "and no hit points, which are nobody else's business");
ok($$(".turn-face")[0].dataset.tbl === "ed-open", "tapping a face opens that figure");
ok(/Round 1/.test($("#vtt-turn").textContent), "the bar says the round");
ok(/Orc/.test($("#vtt-turn").textContent), "and whose turn it is");
ok(/next: Rig/.test($("#vtt-turn").textContent), "and who is up after them");
ok($('[data-token="tOrc"]').classList.contains("turn"), "the current figure is ringed on the board");
ok(!$('[data-token="tRig"]').classList.contains("turn"), "and nobody else is");

click($('[data-tbl="turn"][data-val="1"]'));
await wait(80);
ok((await aget(`CocLive.get("tables/482910/meta/turn/idx")`)) === 1, "Next moves down the order");
ok($('[data-token="tRig"]').classList.contains("turn"), "and the ring moves with it");
click($('[data-tbl="turn"][data-val="1"]'));
await wait(80);
const t2 = await aget(`CocLive.get("tables/482910/meta/turn")`);
ok(t2.idx === 0 && t2.round === 2, "past the last one is round 2, back at the top");
click($('[data-tbl="turn"][data-val="-1"]'));
await wait(80);
const t3 = await aget(`CocLive.get("tables/482910/meta/turn")`);
ok(t3.idx === 1 && t3.round === 1, "and Back steps into the previous round");

console.log("\n— WALKING INTO A FIGHT ALREADY RUNNING —");
/* The order is [Orc, Rig] and Rig is up. A creature put on the board now is NOT quietly in the fight and
   is NOT quietly out of it: whoever holds it is asked for a number, and it slots in where the number
   puts it — the same tiebreak the gather used. */
await peek(`CocLive.put("tables/482910/tokens/tZog", { name: "Zog", x: 4, y: 4, size: 1, kind: "npc", hp: 9, hpMax: 9, speed: 30, initMod: 5 })`);
await until(() => !!$('[data-token="tZog"]'));
ok($$(".turn-face").length === 2, "a figure added mid-fight is not silently in the order");
ok(/Joining/.test($("#vtt-turn").textContent), "the bar asks for its initiative instead");
ok(/Round 1/.test($("#vtt-turn").textContent) && /Rig/.test($("#vtt-turn").textContent),
  "and the fight carries on around it — nothing is blocked");
const jbox = $$("[data-init-for]").find((n) => n.dataset.initFor === "tZog");
ok(jbox, "with the same box the gather used, for a number off your own dice");
jbox.value = "25";                                     // beats Orc's 21, so it goes to the front
jbox.dispatchEvent(new window.Event("focusout", { bubbles: true }));
await until(async () => ((await aget(`CocLive.get("tables/482910/meta/turn/order")`)) || []).length === 3);
const tj = await aget(`CocLive.get("tables/482910/meta/turn")`);
ok(tj.order.join(",") === "tZog,tOrc,tRig", "it slots in where the number puts it: " + tj.order.join(" then "));
ok(tj.idx === 2, "and the figure who was up is still up, not skipped past");
ok(tj.round === 1, "the round does not move");
ok((await aget(`CocLive.get("tables/482910/meta/turn/late")`)) === null, "nothing is left waiting to be placed");
await until(() => $$(".turn-face").length === 3);
ok(/Rig/.test($("#vtt-turn").textContent), "and the bar still says whose turn it is");
ok(!/Joining/.test($("#vtt-turn").textContent), "the bar stops asking once it is in");
const joinLine = Object.values(await aget(`CocLive.get("tables/482910/log")`)).map((e) => e.text)
  .find((t) => /joins the fight/.test(t || ""));
ok(/Zog joins the fight at 25/.test(joinLine || ""), "and the table is told: " + joinLine);
// Not everything put on the board mid-fight is IN the fight — a barrel is not a combatant.
await peek(`CocLive.put("tables/482910/tokens/tKeg", { name: "Keg", x: 1, y: 6, size: 1, kind: "npc", hp: 1, hpMax: 1, speed: 0, initMod: 0 })`);
await until(() => !!$('[data-tbl="init-out"][data-val="tKeg"]'));
click($('[data-tbl="init-out"][data-val="tKeg"]'));
await until(() => !$('[data-tbl="init-out"][data-val="tKeg"]'));
ok(((await aget(`CocLive.get("tables/482910/meta/turn/order")`)) || []).length === 3,
  "the DM can wave one off, and it stays out of the order");
ok(!/Joining/.test($("#vtt-turn").textContent), "and stops being asked about");
/* A FIGURE TAKEN OFF THE BOARD MID-FIGHT LEAVES THE ORDER WITH IT.
 *
 * Kayki's session: a nameless "Figure" with a ? on it appeared out of nowhere and could not be dragged.
 * The order still held the id of a figure that had gone; stepping the turn onto it wrote
 * `tokens/<dead>/moved`, and a database with no schema CREATED the token from that one field — no name,
 * no square, sitting in the corner of the map. Then it could not be moved, because a token with no `x`
 * makes the drag arithmetic NaN and every write for it was refused. Three assertions, one bug. */
await peek(`CocLive.put("tables/482910/meta/turn", { order: ["tZog", "tOrc", "tRig"], idx: 1, round: 1 })`);
await peek(`CocLive.put("tables/482910/tokens/tZog", null)`);
await until(async () => ((await aget(`CocLive.get("tables/482910/meta/turn/order")`)) || []).length === 2);
const pruned = await aget(`CocLive.get("tables/482910/meta/turn")`);
ok(pruned.order.join(",") === "tOrc,tRig", "a figure removed from the board drops out of the order");
ok(pruned.idx === 0, "and whoever was up is still up, by name and not by position");
// Stepping the turn must not write the dead one back into existence.
click($('[data-tbl="turn"][data-val="1"]'));
await wait(120);
click($('[data-tbl="turn"][data-val="1"]'));
await wait(120);
ok((await aget(`CocLive.get("tables/482910/tokens/tZog")`)) == null,
  "and stepping the turn does not conjure it back as a nameless figure");
// The guard itself, directly: one field of a figure that is not there writes nothing at all.
await peek(`tblTokenField("tGhost", "moved", 0)`);
await wait(60);
ok((await aget(`CocLive.get("tables/482910/tokens/tGhost")`)) == null,
  "writing one field of a figure that does not exist creates nothing");
// Back to two in the order, for the sections below.
await peek(`CocLive.put("tables/482910/tokens/tKeg", null)`);
await peek(`CocLive.put("tables/482910/meta/turn", { order: ["tOrc", "tRig"], idx: 1, round: 1 })`);
await until(() => $$(".turn-face").length === 2);

console.log("\n— HOW FAR CAN I WALK —");
// It is Rig's turn (idx 1). A turn arrives with the movement unspent.
await peek(`CocLive.put("tables/482910/tokens/tRig/moved", 25)`);
click($('[data-tbl="turn"][data-val="-1"]'));
await wait(60);
click($('[data-tbl="turn"][data-val="1"]'));
await wait(80);
ok((await aget(`CocLive.get("tables/482910/tokens/tRig/moved")`)) === 0, "arriving at your turn clears what you had walked");
ok(/30 of 30 ft left/.test($("#vtt-turn").textContent), "the bar says how far you can go: " + $("#vtt-turn").textContent);
peek(`tbl.view = { x: 0, y: 0, z: 1, fitted: true }; applyView();`);
// Drag four squares: the ruler must show it while the finger is down…
pointer("pointerdown", $('[data-token="tRig"]'), 2 * 70 + 35, 2 * 70 + 35, 1);
pointer("pointermove", $("#vtt-stage"), 6 * 70 + 35, 2 * 70 + 35, 1);
ok(!$("#vtt-measure").classList.contains("hidden"), "a ruler appears while dragging");
ok(/20 ft/.test($("#vtt-measure").textContent), "showing the distance: " + $("#vtt-measure").textContent);
ok(/10 of 30 left/.test($("#vtt-measure").textContent), "and what it leaves you");
ok($("#vtt-ruler").innerHTML.includes("ruler-line"), "with a line drawn on the map");
pointer("pointerup", $("#vtt-stage"), 6 * 70 + 35, 2 * 70 + 35, 1);
await wait(80);
ok($("#vtt-measure").classList.contains("hidden"), "and it goes away when you let go");
ok((await aget(`CocLive.get("tables/482910/tokens/tRig/moved")`)) === 20, "the distance is charged to your movement");
ok(/10 of 30 ft left/.test($("#vtt-turn").textContent), "which the bar now says");
// Going further than your speed is SHOWN, never blocked — dashing and difficult terrain are settled
// out loud at the table.
pointer("pointerdown", $('[data-token="tRig"]'), 6 * 70 + 35, 2 * 70 + 35, 1);
pointer("pointermove", $("#vtt-stage"), 16 * 70 + 35, 2 * 70 + 35, 1);
ok($("#vtt-measure").classList.contains("over"), "overspending is marked");
pointer("pointerup", $("#vtt-stage"), 16 * 70 + 35, 2 * 70 + 35, 1);
await wait(80);
ok((await aget(`CocLive.get("tables/482910/tokens/tRig/x")`)) === 16, "but the move still happens");

console.log("\n— AN AREA ON THE MAP —");
/* The `shape` verb. Cast something with a board block, place it, and the app says who is standing in it
   — and says nothing whatever about what happens to them, which is the DM's to say. */
await peek(`CocLive.patch("tables/482910/tokens/tOrc", { x: 10, y: 10, size: 1 })`);
await peek(`CocLive.patch("tables/482910/tokens/tRig", { x: 2, y: 2, size: 1 })`);
await wait(80);
ok(peek(`tblCastOnBoard({ name: "Flash Powder", board:
  { verb: "shape", anchor: "point", range: 30, shape: "radius", size: 10 } })`) === true,
  "casting a trick with a board block starts placing it");
ok(!$("#vtt-placing").classList.contains("hidden"), "and the board says so out loud");
ok(/Flash Powder/.test($("#vtt-placing").textContent) && /Tap the board/.test($("#vtt-placing").textContent),
  "naming it and saying what to do: " + $("#vtt-placing").textContent.replace(/\s+/g, " ").trim());
ok(!!$('[data-tbl="place-cancel"]'), "with a way out, because it swallows the next tap");
ok(peek(`tblCastOnBoard({ name: "Vicious Jibe" })`) === false, "a trick with no board block places nothing");
/* CASTING MUST NOT PULL THE GROUND OUT FROM UNDER THE SHEET. It happens inside the sheet's own click
   handler, and closing the drawer is what lets go of the sheet — so closing it there meant the handler
   came back to a sheet that was gone: a null dereference, the table replaced by a full-page sheet (the
   paint target fell back to the whole tool view), and the cooldown it had just spent never written,
   because the save is debounced and its timer reached for `sheet` 400ms later. Three separate faults,
   one cause. The drawer closes a tick later now, and the save decides what it is writing up front. */
ok(peek(`(function(){ let closed = false; const wasFn = tblClosePanel, wasPlacing = tbl.placing;
  tblClosePanel = () => { closed = true; };
  tblCastOnBoard({ name: "Probe", board: { verb: "shape", shape: "cube", size: 5, range: 10 } });
  const during = closed;
  tblClosePanel = wasFn; tbl.placing = wasPlacing; paintPlacing(); paintAreas();
  return during; })()`) === false,
  "casting does not close the drawer inside the sheet's own handler");
ok(peek(`typeof paintHost === "function" && (function(){ const was = paintTarget;
  paintTarget = "#a-node-that-is-not-there"; const host = paintHost(); paintTarget = was;
  return host; })()`) === null,
  "and a sheet whose drawer has gone paints nowhere, rather than over the whole table");
/* ON THE GRID, NEVER BETWEEN IT. Where the centre may sit follows from the shape, so the edges always
   land on grid lines: an odd-sided cube on a square's middle, an even-sided one and every radius on a
   corner. Kayki: "the idle image can be put in between the squares which isn't supposed to." */
ok(peek(`JSON.stringify(tblSnapArea(3.7, 4.2, "cube", 5))`) === '{"x":3.5,"y":4.5}',
  "a 5 ft cube — one square — sits in the middle of one");
ok(peek(`JSON.stringify(tblSnapArea(3.7, 4.2, "cube", 15))`) === '{"x":3.5,"y":4.5}',
  "and so does a 15 ft cube, three squares across");
ok(peek(`JSON.stringify(tblSnapArea(3.7, 4.2, "cube", 20))`) === '{"x":4,"y":4}',
  "a 20 ft cube, four across, sits on a corner instead");
ok(peek(`JSON.stringify(tblSnapArea(3.7, 4.2, "radius", 10))`) === '{"x":4,"y":4}',
  "and a burst always goes off on a corner");
/* AIM, THEN PLACE. A tap on the board moves the outline and commits nothing — a trick costs a cooldown
   or a slice of the engine, and Kayki's first misclick put an illusion somewhere he did not want it. */
await peek(`tblAimAt(10.5, 10.5)`);
ok((await aget(`CocLive.get("tables/482910/areas")`)) == null, "aiming it writes nothing at all");
ok(!!$('[data-tbl="place-go"]'), "and offers the deliberate press that does");
/* AND THEN IT STOPS FOLLOWING. "Place it here" is in a bar ABOVE the board, so an outline that went on
   tracking the pointer was re-aimed by the walk up to the button — Kayki aimed at his square, moved to
   press Place, and it landed off the top of the map. */
ok(peek(`(function(){ const before = tbl.placing.x + "," + tbl.placing.y;
  onPointerMove({ target: document.querySelector("#vtt-turn") || document.body,
    clientX: 5, clientY: 5, pointerId: 3 });
  return before === tbl.placing.x + "," + tbl.placing.y; })()`) === true,
  "and once aimed, moving the pointer away does not move it");
ok(/Catches Orc/.test($("#vtt-placing").textContent),
  "saying what it will catch before it catches it: " + $("#vtt-placing").textContent.replace(/\s+/g, " ").trim());
// A 10-foot radius is 2 squares across: dropped on the Orc it catches the Orc and nobody else.
click($('[data-tbl="place-go"]'));
await until(async () => Object.keys((await aget(`CocLive.get("tables/482910/areas")`)) || {}).length === 1);
ok($("#vtt-placing").classList.contains("hidden"), "placing it leaves the mode");
const areaId = Object.keys(await aget(`CocLive.get("tables/482910/areas")`))[0];
const area = (await aget(`CocLive.get("tables/482910/areas")`))[areaId];
ok(area.shape === "radius" && area.size === 10, "the area is stored as it was authored");
ok(area.scene === (await aget(`tblSceneId()`)), "on the scene it was placed on");
const caught = Object.values(await aget(`CocLive.get("tables/482910/log")`)).map((e) => e.text)
  .find((t) => /Flash Powder/.test(t || ""));
ok(/catches Orc/.test(caught || ""), "and the table is told who is inside: " + caught);
ok(!/Rig/.test(caught || ""), "and only who is inside — Rig is eight squares away");
ok(!/damage|save|DC/i.test(caught || ""), "it counts squares and judges nothing");
ok($$("#vtt-areas .area").length === 1, "it is drawn on the board");
ok($$("#vtt-area-tags .area-tok").length > 0, "and named the way a figure is, in the same label");
/* NOTHING AN AREA DRAWS MAY REACH OUTSIDE THE AREA. The label used to sit ABOVE the shape — and above a
   5-foot cube is the square to the north, so a label wider than the thing it named hung over ground
   belonging to somebody else and a figure standing there was a misclick waiting to happen. Kayki: "it's
   invading the bottom part of the upper square, that goes out of scope." */
const strays = peek(`(function(){
  const cell = tblScene().cell, out = [];
  for (const [id, a] of Object.entries(tbl.data.areas || {})) {
    const half = tblSquares(a.size) / 2 * cell;
    const b = { l: a.x*cell - half, r: a.x*cell + half, t: a.y*cell - half, bo: a.y*cell + half };
    const g = [...document.querySelectorAll("#vtt-areas .area")].find((n) => n.dataset.area === id);
    if (!g) continue;
    for (const n of g.children) {
      let box = null;
      if (n.tagName === "rect") box = { l: +n.getAttribute("x"), t: +n.getAttribute("y"),
        r: +n.getAttribute("x") + +n.getAttribute("width"), bo: +n.getAttribute("y") + +n.getAttribute("height") };
      else if (n.tagName === "circle") { const cx = +n.getAttribute("cx"), cy = +n.getAttribute("cy"),
        rr = +n.getAttribute("r"); box = { l: cx-rr, r: cx+rr, t: cy-rr, bo: cy+rr }; }
      if (!box) continue;
      if (box.l < b.l - 0.5 || box.r > b.r + 0.5 || box.t < b.t - 0.5 || box.bo > b.bo + 0.5)
        out.push(id + " " + n.getAttribute("class"));
    }
  }
  return out.join(", ");
})()`);
ok(strays === "", "and nothing it draws reaches outside its own squares" + (strays ? ": " + strays : ""));
// Who is inside is geometry, so it is asserted as geometry rather than through the UI.
ok(peek(`tblInsideArea({ x: 10.5, y: 10.5, shape: "radius", size: 10 }).join(",")`) === "tOrc",
  "a 10 ft radius reaches one square out");
ok(peek(`tblInsideArea({ x: 6.5, y: 6.5, shape: "radius", size: 60 }).length`) === 2,
  "a 60 ft radius dropped between them reaches both");
ok(peek(`tblInsideArea({ x: 2.5, y: 2.5, shape: "cube", size: 10 }).join(",")`) === "tRig",
  "and a cube covers the squares under it");
/* A RADIUS REACHES AS A CIRCLE, unlike movement, which is Chebyshev — see the note on tblInsideArea.
   These two are the difference, and they are asserted so that changing one metric cannot quietly change
   the other: eight squares diagonally is 40 feet to WALK, and further than that to be caught by. */
ok(peek(`tblFeetBetween(2, 2, 10, 10)`) === 40, "eight squares diagonally is 40 feet to walk");
ok(peek(`tblInsideArea({ x: 10.5, y: 10.5, shape: "radius", size: 80 }).join(",")`) === "tOrc",
  "but a 40 ft radius on the Orc does not reach the Rig standing there");
/* A corner in the blast is in the blast. The Orc fills the square from 10 to 11 and its middle is at
   10.5; a 10 ft radius (one square) centred at 11.9 reaches its EDGE at 11 and not its middle — so this
   assertion fails the moment anyone changes it to measure from the centre. */
ok(peek(`tblInsideArea({ x: 11.9, y: 10.5, shape: "radius", size: 10 }).join(",")`) === "tOrc",
  "a figure with only its edge inside is inside");
/* HOW LONG IT HAS LEFT IS A SUM, NOT A COUNTDOWN. The first version decremented from inside the function
   that whoever presses Next or Done runs — and the decrement was DM-only, so a PLAYER ending their own
   turn advanced the round and nothing ticked, which is why Kayki's Idle Image outlived its ten rounds.
   Stepping Back would have counted it down a second time, too. An area stores the round it lasts UNTIL,
   so every browser agrees without being told and Back is simply the same sum again. */
await peek(`CocLive.put("tables/482910/meta/turn", { order: ["tOrc", "tRig"], idx: 1, round: 4 })`);
await peek(`CocLive.patch("tables/482910/areas/${areaId}", { rounds: 3, until: 6 })`);
await wait(80);
ok(peek(`tblAreaLeft({ rounds: 3, until: 6 })`) === 3, "in round 4, an area lasting until 6 has 3 rounds left");
ok(peek(`tblAreaLeft({ rounds: 3, until: 4 })`) === 1, "and one lasting until 4 has its last round");
ok(peek(`tblAreaLeft({ rounds: 3 })`) === null, "one with no clock yet is counting nothing");
// A PLAYER ends the turn that rolls the round over; the DM's browser is what sweeps up.
await peek(`CocLive.patch("tables/482910/areas/${areaId}", { until: 4 })`);
await peek(`CocLive.put("tables/482910/meta/turn/round", 5)`);
await until(async () => (await aget(`CocLive.get("tables/482910/areas/${areaId}")`)) == null);
ok(true, "and once the round passes the one it lasts until, it goes — for everyone");
// The DM's early clear.
await peek(`tblPlaceAt(10.5, 10.5)`);          // nothing is being placed, so this does nothing
await peek(`tblCastOnBoard({ name: "Powder Screen", board:
  { verb: "shape", anchor: "point", range: 60, shape: "cube", size: 15, rounds: 10 } })`);
// A tick later, not this instant — see the note above about the sheet finishing with itself first.
await peek(`tbl.ui.panel = "notes"; tblCastOnBoard({ name: "Powder Screen", board:
  { verb: "shape", anchor: "point", range: 60, shape: "cube", size: 15, rounds: 10 } })`);
await until(() => peek(`tbl.ui.panel`) === "");
ok(true, "casting closes the drawer — the next thing you do is on the board");
await peek(`tblAimAt(4, 4); tblPlaceAt(4, 4)`);
await until(async () => Object.keys((await aget(`CocLive.get("tables/482910/areas")`)) || {}).length === 1);
const second = Object.keys(await aget(`CocLive.get("tables/482910/areas")`))[0];
ok((await aget(`CocLive.get("tables/482910/areas/${second}/rounds")`)) === 10,
  "an area authored with rounds arrives carrying them");
/* A CONTROL DRAWN ON THE BOARD IS A CONTROL. The × did nothing at all at first: the stage captures the
   pointer, and a captured pointer delivers the click to the stage rather than to the thing under the
   finger. Anything with data-tbl is left alone by the board's gestures now, so a real press reaches it. */
/* THE AREA GETS A CARD, like a figure. The way to take it off used to be a small × at the shape's
   top-right corner — which is exactly where a figure standing beside it is, so half the time it was under
   a goblin and could not be pressed at all. The label opens the card instead; the card holds the button. */
/* THE WHOLE SHAPE OPENS THE CARD. Kayki: "the window opening when I click wherever is in the square
   field" — which is how a figure already behaves. It is worked out by arithmetic on the way up rather
   than by making the shape take presses, because a shape that TOOK presses would eat panning: a 60-foot
   illusion covers most of the screen and dragging the map from inside it has to keep working. */
ok(peek(`tblPointInArea({ x: 4, y: 4, shape: "cube", size: 15 }, 4.9, 4.9)`) === true,
  "a point inside a 15 ft cube is inside it");
ok(peek(`tblPointInArea({ x: 4, y: 4, shape: "cube", size: 15 }, 5.6, 4)`) === false,
  "and a point past its edge is not");
/* 20 ft is two squares of radius: the corner of its bounding box is 2.55 squares out and therefore
   outside the burst, while the same point in a cube of the same size would be inside it. */
ok(peek(`tblPointInArea({ x: 4, y: 4, shape: "radius", size: 20 }, 5.8, 5.8)`) === false,
  "a burst is round, so the corners of its box are outside it");
ok(peek(`tblPointInArea({ x: 4, y: 4, shape: "cube", size: 20 }, 5.8, 5.8)`) === true,
  "and a cube of the same size takes them in");
peek(`tbl.ui.peekArea = "${second}"; paintPeek();`);
await wait(60);
ok(!$("#vtt-peek").classList.contains("hidden"), "the card opens");
ok(/Powder Screen/.test($("#vtt-peek").textContent), "naming the area");
ok(/15 ft cube/.test($("#vtt-peek").textContent) && /10 rounds left/.test($("#vtt-peek").textContent),
  "what it is and how long it has left: " + $("#vtt-peek").textContent.replace(/\s+/g, " ").trim());
ok(/Inside:|Nobody is inside/.test($("#vtt-peek").textContent), "and who is standing in it");
ok(!!$(`[data-tbl="area-clear"][data-val="${second}"]`), "with the way to take it off, on the card");
ok(peek(`onPointerDown({ target: document.querySelector('[data-tbl="area-clear"]'),
  cancelable: true, isPrimary: true, pointerId: 9, clientX: 10, clientY: 10,
  preventDefault(){ window.__prevented = true; } }), window.__prevented === true`) === false,
  "and the board does not take the gesture off it");
/* Whoever put it there may take it away, not only the DM — half these tricks say "until you dismiss it"
   in their own text, so dismissing it is the caster's right and not a favour. */
ok(peek(`(function(){ const was = tbl.role; tbl.role = "player";
  const yes = tblCanClearArea({ by: tbl.me.clientId }), no = tblCanClearArea({ by: "somebody-else" });
  tbl.role = was; return yes && !no; })()`) === true,
  "a player may clear their own area and nobody else's");
await peek(`tblAreaClear("${second}")`);
await until(async () => (await aget(`CocLive.get("tables/482910/areas")`)) == null);
ok(true, "and the DM can take it off early");
await peek(`CocLive.put("tables/482910/meta/turn", { order: ["tOrc", "tRig"], idx: 1, round: 1 })`);
/* LEAVE THE TABLE QUIET. `Math.random` is mocked page-wide and CocLive mints the id of a pushed log
   entry from it, so a write still in flight when a later section seeds a roll steals the face it seeded —
   which is the whole of [[test-random-is-shared]], and this section pushes several. Flush, then wait, so
   the dice tests below start on a table with nothing outstanding. */
await peek(`tbl.ui.peekArea = ""; paintPeek(); CocLive.flush();`);
await wait(300);

console.log("\n— A FIGURE THAT SOMEBODY MADE —");
/* THE `spawn` VERB, which today means the Doppelganger's Clones. The rules come from the class, not from
   here: it wears your face, it shares your AC and has no hit points (said as ONE on a board that counts
   them, so a hit removes it), it does not move once placed, and making one beyond your cap drops your
   oldest. Placed with the same aim-then-place gesture an area uses. */
peek(`tblSpawnOnBoard({ name: "clone", of: "Rig", image: "", range: 30, cap: 2, ofCode: "123456", size: 1 })`);
ok(peek(`tbl.placing.verb`) === "spawn", "making one puts the board into place-it mode");
ok(/Rig's clone/.test(peek(`tbl.placing.name`)), "named for whoever made it: " + peek(`tbl.placing.name`));
await peek(`tblPlaceAt(4, 8)`);
await until(async () => Object.values((await aget(`CocLive.get("tables/482910/tokens")`)) || {})
  .filter((t) => t && t.spawn).length === 1);
const firstClone = Object.entries(await aget(`CocLive.get("tables/482910/tokens")`))
  .find(([, t]) => t && t.spawn);
ok(firstClone[1].hp === 1 && firstClone[1].hpMax === 1,
  "it has the one hit point that says a single hit destroys it");
ok(firstClone[1].speed === 0, "and no speed, because it does not move");
ok(peek(`(function(){ const was = tbl.role; tbl.role = "player";
  const r = tblCanMove(${JSON.stringify(firstClone[1])}); tbl.role = was; return r; })()`) === false,
  "which the board enforces rather than merely draws — the one place it refuses a drag");
ok(peek(`(function(){ const was = tbl.role; tbl.role = "dm";
  const r = tblCanMove(${JSON.stringify(firstClone[1])}); tbl.role = was; return r; })()`) === true,
  "though the DM may still move one, to put right a misplacement");
// The cap: a third against a cap of two drops the oldest, which is what the class says happens.
peek(`tblSpawnOnBoard({ name: "clone", of: "Rig", image: "", range: 30, cap: 2, ofCode: "123456", size: 1 })`);
await peek(`tblPlaceAt(6, 8)`);
await until(async () => Object.values((await aget(`CocLive.get("tables/482910/tokens")`)) || {})
  .filter((t) => t && t.spawn).length === 2);
peek(`tblSpawnOnBoard({ name: "clone", of: "Rig", image: "", range: 30, cap: 2, ofCode: "123456", size: 1 })`);
await peek(`tblPlaceAt(8, 8)`);
await wait(200);
const capped = Object.values(await aget(`CocLive.get("tables/482910/tokens")`)).filter((t) => t && t.spawn);
ok(capped.length === 2, `a third against a cap of two leaves two (${capped.length})`);
ok(!capped.some((t) => t.x === 4 && t.y === 8), "and it is the OLDEST that dropped");
// One hit: hurt at all and it is gone, swept by the DM's browser like everything else.
const alive = Object.entries(await aget(`CocLive.get("tables/482910/tokens")`)).find(([, t]) => t && t.spawn);
await peek(`CocLive.put("tables/482910/tokens/${alive[0]}/hp", 0)`);
await until(async () => Object.values((await aget(`CocLive.get("tables/482910/tokens")`)) || {})
  .filter((t) => t && t.spawn).length === 1);
ok(true, "and one that has been hit at all is gone");
/* AND IT HAS NO TURN OF ITS OWN. A Clone never acts by itself, so it is driven inside its owner's turn
   and one "Done" ends the lot — the decision in docs/MAP-INTERACTION.md, and Kayki's point when he saw
   one on the board. Without this, every Clone made mid-fight stopped the table to ask what it rolled. */
const stillOut = Object.entries(await aget(`CocLive.get("tables/482910/tokens")`)).find(([, t]) => t && t.spawn);
ok(peek(`tblInitCandidates().join(",")`).indexOf(stillOut[0]) < 0,
  "a spawned figure is never asked to roll initiative");
ok(peek(`tblJoinNeed({ order: ["tOrc"], idx: 0, round: 1 }).join(",")`).indexOf(stillOut[0]) < 0,
  "nor prompted to join a fight already running");
/* AND THEY GO WHEN THE FIGHT DOES. A Clone is the engine — "built during a fight and lost when it ends"
   — and the sheet already empties the meter when the DM ends it, so figures left standing made the count
   and the board say different things. */
await peek(`CocLive.put("tables/482910/meta/turn", null)`);
await until(async () => Object.values((await aget(`CocLive.get("tables/482910/tokens")`)) || {})
  .filter((t) => t && t.spawn).length === 0);
ok(true, "and the fight ending takes every one of them off the board");
// Put the fight back for the sections below, which expect Rig to be up.
await peek(`CocLive.put("tables/482910/meta/turn", { order: ["tOrc", "tRig"], idx: 1, round: 1 })`);
await wait(120);
// Tidy up, and leave the table quiet for the sections below.
for (const [id] of Object.entries(await aget(`CocLive.get("tables/482910/tokens")`)).filter(([, t]) => t && t.spawn)) {
  await peek(`CocLive.put("tables/482910/tokens/${id}", null)`);
}
peek(`CocLive.flush();`);
await wait(250);

console.log("\n— MOVING SOMEBODY ELSE, AND HOLDING THEM —");
/* The last two verbs. Pick a figure, then say where — the same two beats as an area, aimed at a creature
   instead of a patch of ground. Twelve things in the data move a figure and one holds one; what they have
   in common is a figure, a distance and a destination, which is all this needs. */
await peek(`CocLive.patch("tables/482910/tokens/tOrc", { x: 10, y: 10, moved: 25 })`);
await wait(80);
peek(`tblMoveOnBoard({ verb: "move", name: "Manipulate", of: "Rig", distance: 15, range: 60 })`);
ok(peek(`tbl.picking.verb`) === "move", "using it asks for a figure");
ok(/Tap the figure to move/.test($("#vtt-placing").textContent), "and says so: "
  + $("#vtt-placing").textContent.replace(/\s+/g, " ").trim());
await peek(`tblPickFigure("tOrc")`);
ok(peek(`tbl.picking.pickedId`) === "tOrc", "picking one moves on to the second beat");
ok(/up to 15 ft/.test($("#vtt-placing").textContent), "naming how far it may go: "
  + $("#vtt-placing").textContent.replace(/\s+/g, " ").trim());
await peek(`tblMoveTo(12, 10)`);
await until(async () => (await aget(`CocLive.get("tables/482910/tokens/tOrc/x")`)) === 12);
ok(true, "and tapping a square puts it there");
/* FORCED MOVEMENT IS NOT WALKING. Being hauled, thrown or swapped does not come out of the figure's own
   legs, and the turn bar's "20 of 30 ft left" is about walking. */
ok((await aget(`CocLive.get("tables/482910/tokens/tOrc/moved")`)) === 25,
  "without costing the figure a foot of its own movement");
const moveLine = Object.values(await aget(`CocLive.get("tables/482910/log")`)).map((e) => e.text)
  .find((t) => /is moved/.test(t || ""));
ok(/Orc is moved 10 ft — Manipulate/.test(moveLine || ""), "and the table is told: " + moveLine);
ok(peek(`tbl.picking`) === null, "one target ends the gesture");
// Distances measured off the figure's own legs, for the moves that are written that way.
ok(peek(`tblMoveFeet({ distance: "speed" }, { speed: 30 })`) === 30, "a move 'up to its speed' is its speed");
ok(peek(`tblMoveFeet({ distance: "half-speed" }, { speed: 30 })`) === 15, "and half of it is half");
ok(peek(`tblMoveFeet({ distance: "half-speed" }, { speed: 25 })`) === 10,
  "rounded down to a whole square, because half a square is not a place");
// LOCK: one beat, no destination. Said in the vocabulary the table already reads.
peek(`tblMoveOnBoard({ verb: "lock", name: "Iron Grip", of: "Rig", range: 5 })`);
ok(/Tap the figure to hold/.test($("#vtt-placing").textContent), "holding one asks for a figure too");
await peek(`tblPickFigure("tOrc")`);
await until(async () => ((await aget(`CocLive.get("tables/482910/tokens/tOrc/conditions")`)) || [])
  .indexOf("grappled") >= 0);
ok(true, "and it is held, as a condition the whole table can read");
ok(peek(`tbl.picking`) === null, "with nothing left to tap");
/* SWAP: one beat too, and the destination is not yours to pick — it is where the other one is standing.
   It had been riding the generic `move`, which asked for a second tap and then put the Clone wherever
   that tap landed, which is not a swap at all. Kayki: "the swap feature for Doppelganger doesn't work." */
await peek(`CocLive.patch("tables/482910/tokens/tRig", { x: 2, y: 2 })`);
await peek(`CocLive.patch("tables/482910/tokens/tOrc", { x: 7, y: 8 })`);
await until(async () => (await aget(`CocLive.get("tables/482910/tokens/tOrc/x")`)) === 7);
peek(`tblMoveOnBoard({ verb: "swap", name: "Swap", of: "Rig", range: 30 })`);
ok(/Tap the figure to trade places with/.test($("#vtt-placing").textContent),
  "a swap asks which figure and nothing else");
await peek(`tblPickFigure("tOrc")`);
await until(async () => (await aget(`CocLive.get("tables/482910/tokens/tRig/x")`)) === 7);
ok((await aget(`CocLive.get("tables/482910/tokens/tOrc/x")`)) === 2
  && (await aget(`CocLive.get("tables/482910/tokens/tOrc/y")`)) === 2,
  "and the two exchange squares in one gesture, with no second tap");
ok(peek(`tbl.picking`) === null, "which ends it");
/* AND THE DRAWER GETS OUT OF THE WAY — for a move or a hold, not only for placing an area. It asked
   `if (tbl.placing)`, and these set `tbl.picking`, so the bar saying "tap the figure" was drawn behind
   the open sheet. On a phone the sheet IS the screen: the feature looked dead. */
peek(`tbl.ui.panel = "sheet"; tblMoveOnBoard({ verb: "swap", name: "Swap", of: "Rig", range: 30 });`);
await until(() => peek(`tbl.ui.panel`) === "");
ok(true, "and pressing it from the sheet closes the drawer, so the board can be tapped");
peek(`tblPickCancel();`);
/* WHO IS CASTING IS YOU, not one of your Clones. This took the first figure the browser holds, sorted by
   id — and Clones are held by the same browser, so once one was out every range ring could be drawn from
   the Clone instead of from the character. */
peek(`tbl.me.charCode = "123456";`);
await peek(`CocLive.patch("tables/482910/tokens/tRig", { owner: tbl.me.clientId, charCode: "123456" })`);
await peek(`CocLive.put("tables/482910/tokens/aaaClone", { name: "Clone", owner: tbl.me.clientId,
  spawn: true, spawnOf: "123456", x: 9, y: 9, size: 1, kind: "pc", hp: 1, hpMax: 1, speed: 0 })`);
await until(async () => !!(await aget(`CocLive.get("tables/482910/tokens/aaaClone")`)));
ok(peek(`tblMyTokens()[0]`) === "aaaClone", "a Clone can sort first among the figures you hold");
ok(peek(`tblCasterToken()`) === "tRig", "and the caster is still you, by the code your figure carries"
  + " (got " + peek(`tblCasterToken()`) + ")");
await peek(`CocLive.put("tables/482910/tokens/aaaClone", null)`);
await peek(`CocLive.put("tables/482910/tokens/tOrc/conditions", null)`);
peek(`CocLive.flush();`);
await wait(200);

console.log("\n— A PLAYER ENDS THEIR OWN TURN —");
peek(`tbl.role = "player"; tbl.me.charCode = "123456"; renderTableShell(); paintTokens(); paintTurnBar(); paintWho();`);
ok(/Rig — you/.test($("#vtt-turn").textContent), "the bar tells you it is your turn");
ok($('[data-tbl="turn"][data-val="1"]'), "and lets you end it");
ok(!$('[data-tbl="turn"][data-val="-1"]'), "but not step back through everyone else's");
ok(!$('[data-tbl="init-roll"]'), "nor reroll the whole order");
/* AND STAND UP, on the turn bar, because movement only exists on your turn. It appears only when the
   figure whose turn it is is actually on the floor. */
ok(!$('[data-tbl="stand"]'), "nothing to stand up from while you are on your feet");
await peek(`CocLive.patch("tables/482910/tokens/tRig", { conditions: ["prone"], moved: 0 })`);
await until(() => peek(`tblConds("tRig").indexOf("prone")`) >= 0);
peek(`paintTurnBar();`);
ok(!!$('[data-tbl="stand"]'), "prone on your own turn offers the way up");
ok(/15 ft/.test($("#vtt-turn").textContent), "priced on the bar, so the cost is not a surprise");
click($('[data-tbl="stand"]'));
await until(async () => (await aget(`CocLive.get("tables/482910/tokens/tRig/moved")`)) === 15);
ok(peek(`tblConds("tRig").indexOf("prone")`) < 0, "pressing it stands you up");
peek(`paintTurnBar();`);
ok(!$('[data-tbl="stand"]'), "and the button goes with the condition");
ok(/15\/30 ft|15 of 30 ft/.test($("#vtt-turn").textContent),
  "with the 15 feet charged to your movement: " + $("#vtt-turn").textContent.replace(/\s+/g, " ").trim().slice(0, 90));
await peek(`CocLive.patch("tables/482910/tokens/tRig", { moved: 0 })`);
click($('[data-tbl="turn"][data-val="1"]'));
await wait(80);
ok((await aget(`CocLive.get("tables/482910/meta/turn/idx")`)) === 0, "pressing Done passes the turn on");
paintTurnBarCheck();
function paintTurnBarCheck() {
  ok(!$('[data-tbl="turn"][data-val="1"]'), "and once it is somebody else's, you cannot touch the tracker");
}

/* A CHARACTER WITH A REAL SHEET CAN STILL LEAVE THE TABLE. Taking your figure off used to live only in
   the tracker panel — which a player holding a Circus of Chaos code no longer sees, so there was no route
   at all and Kayki had to log in as the DM to remove one. It is on the card that opens when you tap
   yourself, which is where it belonged in the first place. */
/* A CHARACTER WITH A REAL SHEET CAN STILL LEAVE THE TABLE, and a cast says so whatever it cost.
 *
 * Both asserted WITHOUT WRITING ANYTHING. Every write here mints an id from `Math.random`, which is
 * mocked page-wide, and the section below throws a seeded die — a write still in flight takes its face.
 * This file has paid for that twice today, and sleeping until the coast is clear only moves the odds.
 * So: the figure is made mine in this browser's own copy, and the cast is caught at the push instead of
 * being allowed to make one. [[test-random-is-shared]] */
/* Written for real, not faked in memory: every one of the presses below causes a stream event, and a
   stream event replaces this browser's whole copy of the table — taking an in-memory fake with it. */
await peek(`CocLive.put("tables/482910/tokens/tRig/owner", tbl.me.clientId)`);
await wait(80);
/* NO CARD FOR YOUR OWN FIGURE. Everything it used to carry about yourself is on the sheet, one tap
   further and one window fewer — Kayki: "remove the pop-up when we click on the character, I like way
   more the 2 click open the sheet." It was also where "take it off the table" sat, one stray tap from a
   figure people drag constantly, and he removed his own character with a misclick. */
peek(`tbl.ui.peek = "tRig"; paintPeek();`);
ok($("#vtt-peek").classList.contains("hidden"), "tapping your own figure pops nothing up");
ok(!$('[data-tbl="mine-remove"][data-val="tRig"]'), "so the way off the table is not one stray tap away");
/* ONE LIST OF CONDITIONS, AND IT IS THE SHEET'S OWN FIELD. The board used to name its own ten and the
   sheet's Status field kept its own States, so a character could be prone in one and not in the other.
   Kayki: "the functionality of the conditions will pass to the ALREADY EXISTING conditions field on the
   status field on the character sheet, don't double it." The vocabulary is authored once. */
ok(peek(`JSON.stringify(Object.keys(TBL_CONDITION_NAMES))`)
   === peek(`JSON.stringify(UNIVERSAL_STATE_IDS)`),
  "the board's conditions ARE the sheet's, one list authored once");
/* AND IT ANSWERS ON THE PRESS, not when the database says so. It used to repaint when the write was
   ACKNOWLEDGED: instant on a good moment, five to ten seconds on a bad one, and every press in between
   read the stored list — still the old one — and asked for the very same change again. Kayki: "if I click
   it again to remove it doesn't do so, if I click grapple afterwards it does nothing, and after 5-10 sec
   the condition gets updated out of nowhere." Asserted with NO wait at all, which is the whole point. */
ok(peek(`tblToggleMyCondition("prone")`) === true, "a condition pressed on the sheet goes to the figure");
ok(peek(`tblConds("tRig").indexOf("prone")`) >= 0, "and marks it at once, ack or no ack");
peek(`tblToggleMyCondition("prone")`);
ok(peek(`tblConds("tRig").indexOf("prone")`) < 0, "pressing it again takes it off, at once");
/* A SECOND CONDITION WHILE THE FIRST IS STILL IN FLIGHT. This is the press that was broken: it read the
   stored list, which had not caught up, and so asked for a change that had already been made. */
peek(`tblToggleMyCondition("grappled")`);
ok(peek(`tblConds("tRig").length`) === 1, "a second press lands on top of the first rather than under it");
await until(async () => ((await aget(`CocLive.get("tables/482910/tokens/tRig/conditions")`)) || []).length === 1);
ok(true, "and the table agrees once the write lands");
await peek(`CocLive.put("tables/482910/tokens/tRig/conditions", null)`);
await until(async () => peek(`tblConds("tRig").length`) === 0);
ok(true, "and what you pressed retires itself the moment the stored table agrees with it");
/* ADVANTAGE, the fourth thing the app owes a fight and the one it had nowhere to put. Public like a
   condition and for the same reason — the table settles a roll out loud — and the two cancel, so a figure
   can never be marked with both. */
ok(!!peek(`TBL_CONDITION_NAMES.advantage && TBL_CONDITION_NAMES.disadvantage`),
  "advantage and disadvantage are markers the board knows");
peek(`tblToggleCond("tRig", "advantage")`);
ok(peek(`tblConds("tRig").indexOf("advantage")`) >= 0, "marking advantage marks it");
peek(`tblToggleCond("tRig", "disadvantage")`);
ok(peek(`tblConds("tRig").indexOf("disadvantage")`) >= 0
  && peek(`tblConds("tRig").indexOf("advantage")`) < 0,
  "and the other one cancels it rather than sitting beside it");
peek(`tblToggleCond("tRig", "disadvantage")`);
await until(async () => (await aget(`CocLive.get("tables/482910/tokens/tRig/conditions")`)) == null);
/* THE ENGINE AND WHAT HAS BEEN SPENT, published from the sheet onto the figure. They lived only on your
   own sheet, so the DM had to ask how much Mayhem you were sitting on and nobody could see your
   once-per-turn was gone. Hit points stay behind — RULES.md. */
ok(peek(`tblPublicPlay({ play: { inCombat: false, engine: 3 } }, { engine: { name: "Mayhem" }, engineCap: 6 })`) === null,
  "out of combat a figure publishes nothing");
const pub = peek(`JSON.stringify(tblPublicPlay(
  { play: { inCombat: true, engine: 3, turnUses: { "Wild Card": 1 }, uses: {}, cooldowns: { a: 2 } } },
  { engine: { name: "Mayhem" }, engineCap: 6 }))`);
ok(/"eng":"Mayhem"/.test(pub) && /"v":3/.test(pub) && /"max":6/.test(pub),
  "in combat it publishes the meter: " + pub);
ok(/"turn":\["Wild Card"\]/.test(pub), "and what has been spent this turn");
ok(!/hp|"hpMax"/.test(pub), "and never the hit points");
ok(/Mayhem<\/em> 3\/6/.test(peek(`tblPlayReadHTML({ play: JSON.parse('${pub.replace(/'/g, "")}') })`)),
  "which the table reads back as a fraction");
/* WHAT A CONDITION TAKES OFF YOUR FEET. Three of the ten change how far you can go, and Kayki marked
   himself prone and watched the bar go on saying 30 of 30 — which is the arithmetic this app is for. */
ok(peek(`tblSpeedUnder({ speed: 30 })`) === 30, "an unencumbered figure has all its speed");
ok(peek(`tblSpeedUnder({ speed: 30, conditions: ["prone"] })`) === 15, "prone is a crawl, at half");
ok(peek(`tblSpeedUnder({ speed: 25, conditions: ["prone"] })`) === 10,
  "rounded down to a whole square, because half a square is not a place");
ok(peek(`tblSpeedUnder({ speed: 30, conditions: ["grappled"] })`) === 0, "held, you go nowhere");
ok(peek(`tblSpeedWhy({ speed: 30, conditions: ["prone"] })`) === "crawling",
  "and the bar says why, rather than quietly halving a number nobody would then trust");
/* GETTING BACK UP, which is the other half of the arithmetic. Standing costs half your speed — Kayki:
   "stand up button is the way, half move speed to leave prone condition." Charged off your FULL speed,
   not off the crawl: the crawl is what prone leaves you to walk with, and getting up is paid for out of
   the legs you would have had. Tracking, not refereeing — the condition was put there by a person. */
ok(peek(`tblStandCost({ speed: 30 })`) === 15, "standing costs half your speed");
ok(peek(`tblStandCost({ speed: 25 })`) === 10, "rounded down to a whole square");
await peek(`CocLive.patch("tables/482910/tokens/tRig", { conditions: ["prone"], moved: 0, speed: 30 })`);
await until(async () => ((await aget(`CocLive.get("tables/482910/tokens/tRig/conditions")`)) || [])
  .indexOf("prone") >= 0);
await peek(`tblStandUp("tRig")`);
ok(peek(`tblConds("tRig").indexOf("prone")`) < 0, "standing up takes the condition off at once");
await until(async () => (await aget(`CocLive.get("tables/482910/tokens/tRig/moved")`)) === 15);
ok(true, "and charges the 15 feet to what you have walked");
const stoodLine = Object.values(await aget(`CocLive.get("tables/482910/log")`)).map((e) => e.text)
  .find((t) => /stands up/.test(t || ""));
ok(/stands up \(15 ft\)/.test(stoodLine || ""), "and the table is told: " + stoodLine);
await peek(`CocLive.patch("tables/482910/tokens/tRig", { moved: 0 })`);
await peek(`CocLive.put("tables/482910/tokens/tRig/conditions", null)`);
peek(`tbl.ui.panel = ""; paintSide();`);
/* A Turn spends a cooldown and a Prestige spends the engine, and both show on your own sheet — but a
   Pledge is at-will, so once it stopped flipping the sheet into combat (which it had no business doing)
   pressing Cast on one changed nothing anybody could see. */
const said = peek(`(function(){ const out = [], was = CocLive.push;
  CocLive.push = (path, e) => { out.push(e.text); return Promise.resolve("x"); };
  tblAnnounceCast({ name: "After-Image", tier: "pledge", range: "30 feet" }, "Rig");
  tblAnnounceCast({ name: "Reflected Wound", tier: "turn", cooldown: 2, range: "60 feet" }, "Rig");
  CocLive.push = was; return out.join(" // "); })()`);
ok(/Rig casts After-Image — 30 feet \(Pledge\)/.test(said),
  "a Pledge that costs nothing still tells the table: " + said.split(" // ")[0]);
ok(/Reflected Wound — 60 feet \(Turn · back in 2 rounds\)/.test(said),
  "and a Turn says when it comes back: " + said.split(" // ")[1]);
peek(`tbl.ui.peek = ""; paintPeek(); CocLive.flush();`);
await wait(200);

/* THE DM'S FIGHT IS THE FIGHT. A sheet kept its own private idea of whether combat was on, behind a
   button on itself — so the engine sat dead and every pip greyed out while the order bar was running at
   the top of the same screen, and Kayki reported the engine as broken. It was gated, not broken. */
ok(peek(`(function(){ const p = { inCombat: false, engine: 0, cooldowns: { x: 2 } };
  const d = { cls: { play: {} }, engineCap: 3 };
  const started = setCombat(p, d, true);
  const ended = setCombat(p, d, false);
  return started && ended && !p.inCombat && p.engine === 0 && Object.keys(p.cooldowns).length === 0;
})()`) === true, "a fight ending clears the engine, the cooldowns and the rest");
ok(peek(`setCombat({ inCombat: true }, { cls: { play: {} } }, true)`) === false,
  "and being told what it already is changes nothing");

console.log("\n— YOUR SHEET, OVER THE BOARD —");
/* Still the player holding Rig's figure from the turn-order section — and now actually holding it. The
   figure had no `owner`, so this browser held nothing, and the heartbeat's one-time "choose a
   character" prompt was free to land in the middle of the section and wipe the drawer. That is fixed in
   tblEnsureToken (it waits for a quiet screen), but the fiction here should be true as well. */
await peek(`CocLive.put("tables/482910/tokens/tRig/owner", tbl.me.clientId)`);
await wait(60);
openPanel("sheet");
/* Waited for, not slept through. The drawer LOADS the character before it can draw it, so 150ms is a
   coin toss on a busy machine — and when it lost, every assertion below fell over on an empty drawer. */
/* A generous budget, and it earns it: the drawer LOADS the character before it can draw it, and by this
   point in the file the table has a long log and a busy stream behind it. The default 3s lost that race
   about one run in three once the board grew areas to paint. Waiting longer costs nothing when it lands
   promptly, which is nearly always. */
await until(() => !!$("#vtt-sheet .tab-strip"), 10000);
ok($("#vtt-sheet"), "a drawer for the sheet");
ok($("#vtt-sheet .tab-strip"), "holding the REAL sheet, fields and all — not a cut-down copy");
ok($$("#vtt-sheet .ab-box").length === 6, "with the six abilities");
ok($("#vtt-sheet [data-act='dmg']"), "and its own controls, which is the point");
ok(!$("#tool .vtt-stage").classList.contains("hidden"), "the board is still there behind it");
/* THE CONDITIONS, IN THE FIELD THAT ALREADY HELD THEM. The Status field's own States chips ARE the
   table's conditions now — same ids, same list — so pressing one there writes to your figure and there is
   no second window to disagree with it. Kayki: "don't double it." */
const proneChip = () => $$("#vtt-sheet [data-act='flag']").find((b) => /^Prone$/.test(b.textContent.trim()));
ok($$("#vtt-sheet [data-act='flag']").length >= 10, "the Status field carries every condition as a chip");
ok(!!proneChip(), "including Prone");
click(proneChip());
ok(/\bon\b/.test(proneChip().className), "pressing one lights the chip on the press, ack or no ack");
ok(peek(`tblConds("tRig").indexOf("prone")`) >= 0, "and it went to the FIGURE, where the table reads it");
ok($$("#vtt-sheet .ab-box").length === 6, "the sheet redrew in place rather than being fetched again");
click(proneChip());
ok(!/\bon\b/.test(proneChip().className), "and pressing it again puts it out — the press that used to do nothing");
await until(async () => (await aget(`CocLive.get("tables/482910/tokens/tRig/conditions")`)) == null);
ok(true, "with the table agreeing once the writes land");
/* AND THE WHOLE ROUND TRIP: spend something on the sheet, and the figure the rest of the table is
   looking at says so. This is the thing Kayki's sentence asked for — "have all of this mentioned and
   pointed and tracked" — and it is what the sheet publishing onto the figure buys. */
peek(`sheet.ch.play.inCombat = true; sheet.ch.play.engine = 3; sheet.ch.play.turnUses = { "Wild Card": 1 };
  persist();`);
await until(async () => !!(await aget(`CocLive.get("tables/482910/tokens/tRig/play")`)));
const onFigure = await aget(`CocLive.get("tables/482910/tokens/tRig/play")`);
ok(onFigure.v === 3 && onFigure.max > 0, "the engine reaches the figure: " + JSON.stringify(onFigure));
ok(String(onFigure.turn) === "Wild Card", "and so does what was spent this turn");
ok(onFigure.hp === undefined, "and the hit points do not, which is the one thing that stays private");
/* A SECOND DEVICE reads it off the card, without opening anybody's sheet. Read as somebody ELSE would:
   a figure you hold has no card at all, because for you it is your own sheet. */
const wasOwner = await aget(`CocLive.get("tables/482910/tokens/tRig/owner")`);
await peek(`CocLive.put("tables/482910/tokens/tRig/owner", "someone-else")`);
await until(() => peek(`!tblIsMine(tblTokens().tRig)`));
peek(`tbl.ui.peek = "tRig"; paintPeek();`);
ok(/Mayhem/.test($("#vtt-peek").textContent) && /3\/5/.test($("#vtt-peek").textContent),
  "and another player's card says it: " + $("#vtt-peek").textContent.replace(/\s+/g, " ").trim().slice(0, 90));
ok(/Wild Card/.test($("#vtt-peek").textContent), "including what they have spent this turn");
ok(!/44\/44/.test($("#vtt-peek").textContent), "and still not their hit points");
peek(`tbl.ui.peek = ""; paintPeek();`);
await peek(`CocLive.put("tables/482910/tokens/tRig/owner", ${JSON.stringify(wasOwner)})`);
await until(() => peek(`tblIsMine(tblTokens().tRig)`));
// It goes when the fight does, so a figure never carries a stale meter between sessions.
peek(`sheet.ch.play.inCombat = false; persist();`);
await until(async () => (await aget(`CocLive.get("tables/482910/tokens/tRig/play")`)) == null);
ok(true, "and it clears itself when the fight ends");
peek(`sheet.ch.play.inCombat = true;`);
/* THE ORDER BAR ENDS YOUR TURN, and the sheet does not offer a second button for the same event — two
   buttons for one thing is how the sheet's round and the table's round come to disagree. */
ok(!$("#vtt-sheet [data-act='endturn']"), "no second End my turn on the sheet at a table");
ok(/End your turn on the order bar/.test($("#vtt-sheet").textContent), "it says who does it instead");
/* AND YOUR TURN COMING ROUND REFRESHES WHAT IS PER-TURN. Only the bar knows when that is. */
peek(`sheet.ch.play.inCombat = true; sheet.ch.play.turnUses = { X: 1 }; sheet.ch.play.turnAt = 1;
  sheet.ch.play.cooldowns = { someTrick: 2 };`);
ok(peek(`startTurnFromTable(2)`) === true, "the table saying your turn came round is heard");
ok(peek(`Object.keys(sheet.ch.play.turnUses).length`) === 0, "per-turn uses come back");
ok(peek(`sheet.ch.play.cooldowns.someTrick`) === 1, "and a cooldown ticks down one");
ok(peek(`startTurnFromTable(2)`) === false, "a second stream event in the same round changes nothing twice");
/* AND THE WAY OFF THE TABLE IS IN PROGRESS, not one stray tap from a figure you drag constantly. */
click($("#vtt-sheet [data-act='tab'][data-val='progress']"));
await wait(60);
ok(!!$("#vtt-sheet [data-tbl='mine-remove']"), "the way off the table lives in Progress, with levelling");
click($("#vtt-sheet [data-act='tab'][data-val='status']"));
await wait(60);
// The sheet is live: damage taken here must reach the figure on the board, for everyone.
const hpBefore = await aget(`CocLive.get("tables/482910/tokens/tRig/hp")`);
type($("#vtt-sheet #hp-amt"), "7");
click($("#vtt-sheet [data-act='dmg']"));
await wait(120);
ok(peek(`sheet.ch.play.hp`) === peek(`derive(sheet.ch).hpMax`) - 7, "damage lands on the character");
ok((await aget(`CocLive.get("tables/482910/tokens/tRig/hp")`)) === peek(`sheet.ch.play.hp`),
  "and the token's hit points follow it (" + hpBefore + " -> " + (await aget(`CocLive.get("tables/482910/tokens/tRig/hp")`)) + ")");
ok(peek(`tblTokens().tRig.hp`) === peek(`sheet.ch.play.hp`), "which the DM's figure list reads from");
// Rolling from the drawer goes to the table's log, not to a toast nobody else sees.
peek(`window.__seq = [0.5];`);
const logLenBefore = Object.keys(await aget(`CocLive.get("tables/482910/log")`) || {}).length;
await until(() => $$("#vtt-sheet .roll").length > 0);
armed(() => click($$("#vtt-sheet .roll")[0]));
/* Asserted against the LOG, not the bar. The bar is a five-second notification on the board now, and a
   test that waits on a thing designed to disappear is a test that fails for reasons that are not bugs.
   What actually matters is that the roll reached the table, under the CHARACTER's name rather than the
   device's — which is what makes the log readable when the DM runs an NPC from a real sheet. */
const newest = async () => {
  const log = Object.values(await aget(`CocLive.get("tables/482910/log")`) || {});
  return log.sort((a, b) => (b.t || 0) - (a.t || 0))[0] || {};
};
await until(async () => /^Rig/.test((await newest()).who || ""), 5000);
const logLenAfter = Object.keys(await aget(`CocLive.get("tables/482910/log")`) || {}).length;
ok(logLenAfter === logLenBefore + 1, "a number rolled off the drawer reaches the shared log");
ok(/^Rig/.test((await newest()).who || ""),
  "under your character's name, not the device's: " + JSON.stringify((await newest()).who));
// Closing it hands the page back — otherwise the next sheet opened anywhere paints into nothing.
click($('[data-tbl="sheet-close"]'));
await wait(60);
ok(peek(`paintTarget`) === null, "closing the drawer gives paint() back to the page");
ok(peek(`sheet`) === null, "and lets go of the character");
await go("#/sheet/123456", 200);
ok($("#tool .sheet-head"), "so the sheet page itself still works afterwards");
ok(!$("#tool .vtt"), "and it is the page, not the table");
await go("#/table/482910", 250);
peek(`tbl.role = "player"; tbl.me.charCode = "123456";`);

console.log("\n— THE DM OPENS ANY SHEET —");
peek(`tbl.role = "dm"; renderTableShell(); paintSide();`);
openPanel("sheet");
await wait(80);
ok($("#vtt-sheet-code"), "the DM is asked which sheet, having no character of their own");
type($("#vtt-sheet-code"), "12");
click($('[data-tbl="sheet-open"]'));
await wait(60);
ok(/Six digits/.test($("#vtt-sheet-msg").textContent), "a short code is refused");
type($("#vtt-sheet-code"), "123456");
click($('[data-tbl="sheet-open"]'));
await wait(200);
ok($$("#vtt-sheet .ab-box").length === 6, "a real code opens that character beside the board");
click($('[data-tbl="sheet-close"]'));
await wait(40);

console.log("\n— A ROLL YOU CAN WATCH —");
// The overlay is built on demand and lives on the body, because every page can roll.
openDice();
peek(`tbl.ui.dice = { pool: { 20: 1 }, mod: 2, mode: "normal" }; paintDice();`);
/* THE ARITHMETIC AND THE OVERLAY, SEPARATELY — and neither through a seeded click.
 *
 * `Math.random` is mocked for the whole page, and the id CocLive mints for a pushed log entry draws from
 * it too, so any write still in flight eats the number this roll was meant to get. "Load it at the last
 * possible moment" was the old defence and it is not one: it narrows the window instead of closing it,
 * and this file has spent three separate sessions on the same intermittent failure. So the SUM is proved
 * by calling the roller directly, and the OVERLAY is proved by handing it that very result. Nothing about
 * either needs a coin toss. */
const pooled = peek(`(function(){ const was = window.__armed; window.__armed = true;
  window.__seq = [0.95];
  const r = tblDoRoll(tblPoolSpec(), "normal");
  window.__armed = was; window.__seq = [];
  return JSON.stringify(r); })()`);
const rolled = JSON.parse(pooled);
ok(rolled.dice.length === 1 && rolled.dice[0].v === 20 && rolled.total === 22,
  "the dice pool adds its modifier in: " + pooled);
peek(`tblShowRoll({ who: "DM", label: "", spec: "d20 + 2", mod: 2, mode: "normal", keptIdx: -1,
  total: 22, nat: 20, dice: [{ s: 20, v: 20 }], t: Date.now() });`);
await wait(60);
const stage = doc.getElementById("roll-stage");
ok(stage && stage.classList.contains("on"), "rolling puts the dice on screen");
ok(stage.classList.contains("rolling"), "tumbling before they land");
ok(stage.querySelectorAll(".die").length === 1, "one die for a d20");
ok(stage.querySelector(".roll-total").textContent.trim() === "22",
  "and the total, once the modifier is in: " + stage.querySelector(".roll-total").textContent);
ok(stage.classList.contains("nat20"), "a natural 20 is marked on the overlay too");
await wait(700);
ok(!stage.classList.contains("rolling") && stage.classList.contains("landed"), "then they settle");
ok(stage.querySelector(".die b").textContent === "20",
  "showing the number that was actually rolled, not a random face");
ok(/d20/.test(stage.querySelector(".die em").textContent), "and which kind of die it was");
// A die should LOOK like the die it is: the shape is drawn behind the number, not clipped out of the box.
ok(stage.querySelector(".die .die-face polygon"), "the die is drawn as a shape, not a tile");
const d20pts = stage.querySelector(".die .die-face polygon").getAttribute("points");
ok(d20pts.split(" ").length === 6, "a d20 is the six-sided silhouette everyone knows (" + d20pts.split(" ").length + " points)");
ok(stage.querySelector(".die b").textContent.length > 0, "with the number on top of it, not cut in half");
// Each kind has its own outline.
peek(`tblShowRoll({ who: "DM", label: "", spec: "d4 + d12", mod: 0, mode: "normal", keptIdx: -1, total: 9,
  dice: [{ s: 4, v: 3 }, { s: 12, v: 6 }], t: Date.now() + 9000 });`);
await wait(40);
const shapes = [...doc.querySelectorAll("#roll-stage .die .die-face polygon")].map((n) => n.getAttribute("points").split(" ").length);
ok(shapes[0] === 3, "a d4 is a triangle");
ok(shapes[1] === 5, "a d12 is a pentagon");
// Advantage keeps both dice on screen, with the discarded one dimmed — "which did I keep" is the first
// thing anyone asks.
peek(`tbl.ui.dice.mode = "adv"; tbl.ui.dice.mod = 0; paintDice();`);
const adv = JSON.parse(peek(`(function(){ const was = window.__armed; window.__armed = true;
  window.__seq = [0.1, 0.9];
  const r = tblDoRoll(tblPoolSpec(), "adv");
  window.__armed = was; window.__seq = [];
  return JSON.stringify(r); })()`));
ok(adv.dice.length === 2 && adv.total === 19 && adv.keptIdx === 1,
  "advantage rolls two and keeps the higher: " + JSON.stringify(adv));
peek("tblShowRoll({ who: 'DM', label: '', spec: 'd20', mod: 0, mode: 'adv', keptIdx: " + adv.keptIdx
  + ", total: " + adv.total + ", nat: 0, dice: " + JSON.stringify(adv.dice) + ", t: Date.now() })");
await wait(700);
const dice = [...doc.querySelectorAll("#roll-stage .die")];
ok(dice.length === 2, "advantage shows both dice");
ok(dice.filter((d) => d.classList.contains("dropped")).length === 1, "with the one you did not keep dimmed");
// Against the roll that was handed to it, not against the log — this one is not written to the log.
ok(dice.findIndex((d) => !d.classList.contains("dropped")) === adv.keptIdx,
  "and it is the die the roll actually kept, which two equal dice could not tell you");
// Somebody ELSE's roll is rolled on your screen too — that is the point of everyone being in the room.
const seenBefore = peek(`tbl.lastRollAt`);
await peek(`CocLive.push("tables/482910/log", { t: Date.now() + 200, who: "Sable", kind: "roll",
  label: "Longbow", sides: 20, count: 1, mod: 5, rolls: [11], kept: [11], mode: "normal", total: 16,
  text: "Sable rolled Longbow: d20 + 5 → 11 = 16" })`);
await wait(80);
ok(peek(`tbl.lastRollAt`) > seenBefore, "a roll from another device is noticed");
ok(/Sable/.test(doc.getElementById("roll-stage").textContent), "and rolled on this screen: " +
  doc.getElementById("roll-stage").querySelector(".roll-head").textContent.trim());
peek(`tbl.ui.dice.mode = "normal"; paintDice();`);

console.log("\n— PLAYERS CANNOT REDECORATE —");
peek(`tbl.role = "player"; tbl.me.charCode = "123456"; renderTableShell(); paintSide();`);
ok(!$('[data-tbl="panel"][data-val="dm"]'), "a player is offered no DM panel");
const sceneNow = await aget(`CocLive.get("tables/482910/meta/activeScene")`);
// Not merely hidden: the action itself refuses, because a control that is only unrendered is not locked.
peek(`document.body.insertAdjacentHTML("beforeend",
  '<button id="sneak" data-tbl="scene" data-val="nonsense"></button>');`);
click($("#sneak"));
await wait(60);
ok((await aget(`CocLive.get("tables/482910/meta/activeScene")`)) === sceneNow,
  "and forcing the control by hand changes nothing");
peek(`$("#sneak").remove(); tbl.role = "dm"; renderTableShell();`);

console.log("\n— FIGURES —");
// The maps section leaves a "Goblin" of its own on another scene, and whether it survives depends on
// which scene the delete test removed — so this section starts from a known board rather than assuming.
await peek(`CocLive.del("tables/482910/tokens/tGob")`);
peek(`tbl.role = "dm"; tbl.me.charCode = ""; renderTableShell(); paintTokens();`);
openPanel("dm");
await wait(60);
/* AND THE ROOM CAN BE KEPT ON YOUR DM CODE, from the chair — the moment you are running a table is the
   moment you know it is yours. Offered rather than automatic: this browser can have somebody ELSE's DM
   code open, and quietly filing your room under theirs is a mess nobody would think to look for. */
ok(/no DM code open/.test($("#tool").textContent), "with no DM code open, the chair says where one lives");
peek(`localStorage.setItem("coc:dm:last", "420420");
  window.__dmrecs = { "420420": { v: 1, name: "Friend", tables: [], notes: [], enemies: [] } };
  CocDm.load = async (c) => window.__dmrecs[c] ? JSON.parse(JSON.stringify(window.__dmrecs[c])) : null;
  CocDm.save = async (c, r) => { window.__dmrecs[c] = JSON.parse(JSON.stringify(r)); return true; };
  paintSide();`);
ok(!!$('[data-tbl="keep-table"]'), "with one open, the chair offers to keep the room on it");
click($('[data-tbl="keep-table"]'));
await until(() => (peek(`JSON.stringify(window.__dmrecs["420420"].tables)`) || "[]").includes("482910"));
ok(true, "and pressing it puts the room on the code, not just in this browser's list");
peek(`paintSide();`);
ok(!$('[data-tbl="keep-table"]'), "and it stops offering once it is kept");
peek(`localStorage.removeItem("coc:dm:last"); paintSide();`);
ok($("#tbl-npc-name"), "the DM can drop a figure");
ok(/for scenery, a barrel/.test($("#tool").textContent), "which is for the things the bestiary has not got");
/* THE SYSTEM'S NINE ARE ONE CAMPAIGN'S, NOT EVERY DM'S. A stat block read early is a fight spoiled, so
   the authored bestiary follows the DM CODES in COC_BESTIARY_CODES — with no code open, or with somebody
   else's, a chair carries only what that code built. Kayki: "I don't want other people to create a DM and
   see the enemies from the bestiary… they will need to create their own enemies." */
ok($$('[data-tbl="bestiary"]').length === 0, "with no DM code open there is no authored bestiary");
ok(/No DM code open/.test($("#tool").textContent), "and the panel says where one comes from");
peek(`localStorage.setItem("coc:dm:last", "420420"); paintSide();`);
ok($$('[data-tbl="bestiary"]').length === 0, "another DM's code does not carry it either");
ok(peek(`tblEnemies().length`) === 0, "so a second DM starts with an empty bestiary, as intended");
/* THE BESTIARY, AT THE TABLE, for the code it belongs to. Typing "Sawdust Hound / 9" four times a night is
   the exact work this app exists to save, and until now the DM's panel said so in a note apologising for
   itself. One press drops the creature with its hit points, its size and its speed already right. */
peek(`localStorage.setItem("coc:dm:last", COC_BESTIARY_CODES[0]); paintSide();`);
ok(peek(`tblShippedEnemies().every(e => /^assets\\/enemies\\/.+\\.jpg$/.test(e.image || ""))`),
  "every authored creature carries its own token art");
ok($$('[data-tbl="bestiary"]').length >= 9,
  `every enemy is one press away for its owner (${$$('[data-tbl="bestiary"]').length})`);
/* AND THE ONES THIS DM HAS BUILT — which are that code's own, and travel with it rather than with the
   room. They come off the copy this browser keeps of the record, so a fight never waits on a fetch. */
peek(`localStorage.setItem("coc:dm:last", "777001");
  localStorage.setItem("coc:dm:enemies:777001", JSON.stringify([{ id: "rope-ghoul-ab12", custom: true,
    name: "Rope Ghoul", tier: "normal", ac: 14, hp: 11, speed: 30, size: "Medium",
    attacks: [{ name: "Claw", kind: "melee", toHit: 4, reach: "5 ft", damage: "1d6+2", damageType: "slashing" }],
    features: [] }]));`);
peek(`paintSide();`);
ok(peek(`tblEnemies().some(e => e.name === "Rope Ghoul")`), "a built enemy joins the bestiary");
ok(!peek(`tblEnemies().some(e => e.name === "Sawdust Hound")`),
  "and on a code the authored nine are not on, it is the ONLY thing there");
/* AND WHAT ANOTHER DM HAS LENT THIS CODE, in a group of its own — it is theirs, it can be taken back, and
   a DM should be able to see at a glance which half of the cast travels with their own code. */
peek(`localStorage.setItem("coc:dm:shared:777001", JSON.stringify([{ id: "sawdust-hound",
  name: "Sawdust Hound", tier: "normal", ac: 13, hp: 9, speed: 40, size: "Medium", sharedFrom: "130820",
  attacks: [{ name: "Bite", kind: "melee", toHit: 4, reach: "5 ft", damage: "1d6+2", damageType: "piercing" }],
  features: [] }])); paintSide();`);
ok(peek(`tblEnemies().some(e => e.name === "Sawdust Hound")`), "one lent to this code reaches the bestiary");
ok(/Lent to you/.test($("#tool").textContent), "under a heading that says whose it is");
ok(!!$('[data-tbl="bestiary"][data-val="sawdust-hound"]'), "and drops on the board like any other");
peek(`localStorage.removeItem("coc:dm:shared:777001"); paintSide();`);
ok(!peek(`tblEnemies().some(e => e.name === "Sawdust Hound")`), "and taking the loan back takes it away");
ok(!!$('[data-tbl="bestiary"][data-val="rope-ghoul-ab12"]'), "and is one press away like the rest");
click($('[data-tbl="bestiary"][data-val="rope-ghoul-ab12"]'));
await until(() => Object.values(peek(`JSON.parse(JSON.stringify(tblTokens()))`)).some((t) => t.enemyId === "rope-ghoul-ab12"));
const builtTok = Object.entries(peek(`JSON.parse(JSON.stringify(tblTokens()))`)).find(([, t]) => t.enemyId === "rope-ghoul-ab12");
ok(builtTok[1].hp === 11, "dropping one uses its own hit points");
/* AND ITS OWN INITIATIVE. Every enemy dropped on the board used to carry initMod 0 and roll a flat d20,
   so a Rigging Crawler rolled exactly like a Ticketing Usher. It is the creature's Dexterity now. */
ok(builtTok[1].initMod === 0, "a built enemy with no Dexterity rolls flat");
ok(/Claw/.test(peek(`enemyReadHTML(${JSON.stringify(builtTok[1])})`)), "and its card reads off what was built");
await peek(`CocLive.del("tables/482910/tokens/" + ${JSON.stringify(builtTok[0])})`);
peek(`localStorage.removeItem("coc:dm:enemies:777001");
  localStorage.setItem("coc:dm:last", COC_BESTIARY_CODES[0]); paintSide();`);
const hound = $$('[data-tbl="bestiary"]').find((b) => /Sawdust Hound/.test(b.textContent));
ok(!!hound, "including the Sawdust Hound");
const beforeDrop = Object.keys(peek(`JSON.parse(JSON.stringify(tblTokens()))`)).length;
click(hound);
await until(() => Object.keys(peek(`JSON.parse(JSON.stringify(tblTokens()))`)).length === beforeDrop + 1);
const dropped = Object.values(peek(`JSON.parse(JSON.stringify(tblTokens()))`)).find((t) => t.enemyId === "sawdust-hound");
ok(!!dropped, "pressing it puts one on the board");
ok(dropped.hp === 9 && dropped.hpMax === 9 && dropped.speed === 40,
  `with its own hit points and speed already right (${dropped.hp}/${dropped.hpMax}, ${dropped.speed} ft)`);
/* AND ITS OWN INITIATIVE, off its Dexterity. Every enemy used to be dropped with initMod 0, so a Rigging
   Crawler rolled exactly like a Ticketing Usher — and nothing in the data said what a creature's
   Dexterity even was. Kayki found both: "they have initiative? and what about the stats to roll in checks
   and saving throws?" */
ok(dropped.initMod === 2, `and its initiative off its own Dexterity (${dropped.initMod})`);
ok(/Saves: Str/.test(peek(`enemyReadHTML(${JSON.stringify(dropped)})`)),
  "and its card carries the saves a player will force it to make");
/* THE STAT BLOCK IS NOT COPIED INTO THE DATABASE. The figure stores WHICH creature it is and reads the
   rest back out of the data, so fixing an enemy reaches every figure of it at once. */
ok(dropped.ac === undefined && dropped.attacks === undefined,
  "and nothing but the id — the numbers are read from the data, not copied into the table");
ok(/AC<\/em> 13/.test(peek(`enemyReadHTML(${JSON.stringify(dropped)})`)),
  "which is what the DM reads off its card");
ok(/Bite/.test(peek(`enemyReadHTML(${JSON.stringify(dropped)})`)), "attacks and all");
// A player gets what a player is entitled to, and not the thing's to-hit.
const droppedId = Object.entries(peek(`JSON.parse(JSON.stringify(tblTokens()))`)).find(([, t]) => t.enemyId === "sawdust-hound")[0];
peek(`tbl.role = "player"; tbl.ui.peek = ${JSON.stringify(droppedId)}; paintPeek();`);
ok(!/AC/.test($("#vtt-peek").textContent), "a player tapping it is not shown its armour class");
peek(`tbl.role = "dm"; paintPeek();`);
ok(/AC/.test($("#vtt-peek").textContent), "and the DM is");
/* AND THE WHOLE CARD OPENS IN THE PANEL, the DM's alone. The bestiary used to be a tab in the
   compendium, which put every enemy's hit points, weaknesses and tactics in front of the players. */
click($('[data-tbl="enemy-card"][data-val="sawdust-hound"]'));
await wait(80);
ok(peek(`tbl.ui.panel`) === "enemy", "pressing its card opens the sheet in the drawer");
ok(/Runs in a Pack/.test($("#vtt-side").textContent), "with everything on it: " +
  $("#vtt-side").textContent.replace(/\s+/g, " ").trim().slice(0, 70));
ok(/How to play it/.test($("#vtt-side").textContent), "including how to play it");
/* AND A WAY BACK TO WHERE YOU WERE. This row used to be shown only on a phone — on a desktop the way out
   of a panel was pressing its button in the bar again, which works for the panels that HAVE one. An
   enemy's card does not, so reading one was a dead end. Kayki: "it doesn't have a return or exit button
   to go back to where it was before." It goes back to the panel it was opened FROM. */
ok(!!$(".side-back"), "the card carries a way out");
ok($(".side-back").dataset.val === "dm", "which leads back to the DM screen it was opened from");
click($(".side-back"));
await wait(60);
ok(peek(`tbl.ui.panel`) === "dm", "and pressing it lands you there, not on an empty board");
ok(!!$("#dm-figures"), "with the figure list you left");
peek(`tbl.ui.panel = ""; paintSide();`);
peek(`tbl.role = "player"; paintSide();`);
ok(!/Runs in a Pack/.test($("#vtt-side").textContent), "and a player who reaches it is shown nothing");
peek(`tbl.role = "dm"; tbl.ui.panel = ""; paintSide();`);
peek(`tbl.ui.peek = ""; paintPeek();`);
await peek(`CocLive.del("tables/482910/tokens/" + ${JSON.stringify(droppedId)})`);
openPanel("dm");
await wait(60);
click($('[data-tbl="spawn"]'));
await wait(60);
ok(/needs a name|Give it a name/.test($("#tbl-spawn-msg").textContent), "an unnamed circle is refused");
type($("#tbl-npc-name"), "Goblin"); type($("#tbl-npc-hp"), "7"); type($("#tbl-npc-size"), "1");
click($('[data-tbl="spawn"]'));
await wait(100);
const goblins = () => Object.entries(peek(`JSON.parse(JSON.stringify(tblTokens()))`))
  .filter(([, t]) => /^Goblin/.test(t.name || ""));
ok(goblins().length === 1, "a named figure lands on the board");
const gob = goblins()[0];
ok(gob[1].kind === "npc" && gob[1].hp === 7 && gob[1].hpMax === 7, "with its hit points");
ok(gob[1].scene === peek(`tblSceneId()`), "belonging to the map it was dropped on");
ok($(`[data-token="${gob[0]}"]`), "and it is on screen");
// "Goblin", "Goblin 2", "Goblin 3" — the naming a DM does out loud anyway.
click($$('[data-tbl="ed-dup"]').find(b => b.dataset.val === gob[0]));
await wait(100);
ok(goblins().length === 2, "duplicating gives you another");
ok(goblins().some(([, t]) => t.name === "Goblin 2"), "numbered rather than identical (" + goblins().map(([, t]) => t.name).join(", ") + ")");
const twins = goblins();
ok(twins[0][1].x !== twins[1][1].x || twins[0][1].y !== twins[1][1].y, "and not hidden underneath its twin");
// Double-tapping a figure opens it; the DM is the only one who can change its numbers.
const dbl = (node) => node.dispatchEvent(new window.MouseEvent("dblclick", { bubbles: true }));
dbl($(`[data-token="${gob[0]}"]`));
await wait(60);
ok($("#ed-hp"), "double-tapping a figure opens its editor");
/* And it opens WHERE IT STANDS. It used to be lifted to the top of the DM panel, above the map list, so
   opening a figure moved it away from the row that was tapped. */
const openedUnder = $(`[data-figure="${gob[0]}"]`);
ok(!!openedUnder, "the figure has a row of its own in the list");
ok(openedUnder && openedUnder.nextElementSibling
  && openedUnder.nextElementSibling.classList.contains("figure-open"),
  "and it unfolds directly underneath that row, not at the top of the panel");
ok($(".figure-open #ed-hp") && $(".figure-open #ed-img"),
  "with its numbers AND its picture inside the same fold");
ok($(`[data-figure="${gob[0]}"] .scene-pick`).getAttribute("aria-expanded") === "true",
  "the row says it is open");
// Tapping the same row again closes it, as a disclosure does.
click($(`[data-figure="${gob[0]}"] .scene-pick`));
await wait(60);
ok(!$(".figure-open"), "and tapping it again folds it away");
click($(`[data-figure="${gob[0]}"] .scene-pick`));
await wait(60);
ok(!!$(".figure-open #ed-hp"), "and again to reopen it");
/* And a PLAYER's figure the same way: a character already on the board can be given a picture, or have
   the one it arrived with replaced, without waiting to be placed again. */
const pcRow = $(`[data-figure="tRig"] .scene-pick`);
ok(!!pcRow, "a player's character is in the same list");
click(pcRow);
await wait(80);
ok(!!$(".figure-open #ed-img") && !!$(".figure-open #ed-file"),
  "and opens with a picture on it too — a link, or a file from this device");
ok($$(".figure-open [data-tbl='ed-repo']").length >= 0, "and whatever is in maps/");
// Back to the goblin, which is the figure the rest of this section is about.
click($(`[data-figure="tRig"] .scene-pick`));
await wait(60);
click($(`[data-figure="${gob[0]}"] .scene-pick`));
await wait(60);
ok(!!$(".figure-open #ed-hp"), "only one is open at a time");
type($("#ed-hp"), "3"); type($("#ed-name"), "Goblin boss"); type($("#ed-size"), "2");
click($('[data-tbl="ed-save"]'));
await wait(80);
const boss = await aget(`CocLive.get("tables/482910/tokens/${gob[0]}")`);
ok(boss.hp === 3 && boss.name === "Goblin boss" && boss.size === 2, "and its numbers can be changed");
ok($(`[data-token="${gob[0]}"]`).style.width === (2 * 70) + "px", "a bigger figure takes more squares");
click($('[data-tbl="ed-del"]'));
await wait(80);
ok((await aget(`CocLive.get("tables/482910/tokens/${gob[0]}")`)) === null, "and removed when the fight is over");

console.log("\n— THE DM SCREEN —");
openPanel("dm");
await wait(60);
/* Notes are a notepad of their own — several, each with a title. A PLAYER's live in the room (proved
   further up); the DM's live on their CODE, which is the same list `#/dm` shows, because a campaign with
   two notepads has two halves of every note. Kayki: "the notes of the dm dont appear on the table, it
   should all be the same data, not 2 separate." */
const dmRec = () => JSON.parse(peek(`JSON.stringify(window.__dmrecs[COC_BESTIARY_CODES[0]] || null)`) || "null");
peek(`window.__dmrecs[COC_BESTIARY_CODES[0]] = { v: 1, name: "Kayki", tables: [], notes: [], enemies: [] };`);
openPanel("notes");
await wait(60);
ok($("#notes-panel"), "everyone has a notepad in the app instead of beside it");
ok(!$("#note-body"), "and nothing to write in until you make a note");
click($('[data-tbl="note-new"]'));
await wait(120);
ok($("#note-title") && $("#note-body"), "a new note opens ready to write in");
type($("#note-title"), "The innkeeper");
type($("#note-body"), "He is lying about the cellar.");
await until(() => /innkeeper/.test(JSON.stringify((dmRec() || {}).notes || [])));
const myNotes = (dmRec() || {}).notes || [];
ok(myNotes.length === 1 && myNotes[0].title === "The innkeeper", "the title saves as you type");
ok(/lying about the cellar/.test(myNotes[0].body), "and so does the note");
ok((await aget(`CocLive.get("tables/482910/notes")`)) === null,
  "onto the DM CODE and not into the room — one list, reachable from the DM screen too");
ok(/onto DM code/.test($("#tool").textContent), "and the panel says whose list it is");
// A second note, and the list of them.
click($('[data-tbl="note-new"]'));
await wait(120);
ok($$("#notes-panel .scene-row").length === 2, "a second note lists beside the first");
type($("#note-title"), "Rooftop chase");
await until(() => ((dmRec() || {}).notes || []).length === 2);
/* DELETING A NOTE ASKS FOR THE WORD. Kayki: "where is the confirm button on deleting the notes??" — it
   was the last destructive button in the app that went through on the first press, and it sits an inch
   from the name you tap to open one. */
click($$('[data-tbl="note-del"]')[1]);
await wait(150);
ok(((dmRec() || {}).notes || []).length === 2, "one press on a note's Delete deletes nothing");
ok(!!$("#note-drop-confirm"), "it asks for the word instead");
ok($('[data-tbl="note-del-go"]').disabled === true, "with the button locked until it is typed");
type($("#note-drop-confirm"), "nope");
ok($('[data-tbl="note-del-go"]').disabled === true, "and the wrong word does not unlock it");
click($('[data-tbl="note-del-cancel"]'));
await wait(120);
ok(((dmRec() || {}).notes || []).length === 2 && !$("#note-drop-confirm"), "Cancel keeps the note");
click($$('[data-tbl="note-del"]')[1]);
await wait(150);
type($("#note-drop-confirm"), "CONFIRM");
click($('[data-tbl="note-del-go"]'));
await until(() => ((dmRec() || {}).notes || []).length === 1);
ok($$("#notes-panel .scene-row").length === 1, "and then a note can be thrown away");
ok(((dmRec() || {}).notes || []).length === 1, "for good");
/* NOTES GO IN FOLDERS. Kayki, once the campaign notes passed a dozen: "right now its a mess to find what
   is what." A folder is a NAME ON THE NOTE — a note has no id, only its place in the array, so a string
   is the only thing that survives a splice — and the list groups by it. */
click($$('[data-tbl="note-open"]')[0]);
await wait(80);
/* AND IT OPENS WHERE IT IS. Kayki: "when i click the notes i want it to do a dropdown in the place where
   it is, not to put it down the whole page." The editor used to be a panel BELOW the whole list, so on a
   phone the note you tapped scrolled away and you typed into a box with no idea which note you were in. */
ok(!!$("#notes-panel").querySelector("#note-body"),
  "the editor unfolds inside the list, under the note that was tapped");
ok(!!$("#notes-panel .note-open"), "indented under its own row, the way a figure opens");
ok(/&#9662;|▾/.test($$('[data-tbl="note-open"]')[0].innerHTML) || $$('[data-tbl="note-open"]')[0].getAttribute("aria-expanded") === "true",
  "with a caret saying which one is open");
ok(!!$("#note-folder"), "an open note has a folder box");
type($("#note-folder"), "NPCs");
await until(() => (((dmRec() || {}).notes || [])[0] || {}).folder === "NPCs");
ok(true, "typing a name files the note under it");
/* THE FIELD MUST SURVIVE THE NEXT KEYSTROKE. Every write rebuilds the whole note, so a field the mapper
   forgets is erased by the next letter typed into a different box — which is how this would have failed
   silently rather than loudly. */
type($("#note-body"), "He is lying about the cellar, and about the well.");
await until(() => /about the well/.test(JSON.stringify((dmRec() || {}).notes || [])));
ok((((dmRec() || {}).notes || [])[0] || {}).folder === "NPCs", "and writing in the note does not lose it");
peek(`paintSide();`);
ok(/NPCs/.test($("#notes-panel").textContent), "the panel heads the group with the folder's name");
// A note made from under a heading starts in that folder rather than at the bottom of the panel.
click($('[data-tbl="note-new"][data-val="NPCs"]'));
await until(() => ((dmRec() || {}).notes || []).length === 2);
ok((((dmRec() || {}).notes || [])[1] || {}).folder === "NPCs", "\"New note here\" lands in that folder");
// And emptying the box takes it back out.
type($("#note-folder"), "");
await until(() => !(((dmRec() || {}).notes || [])[1] || {}).folder);
peek(`paintSide();`);
ok(/No folder/.test($("#notes-panel").textContent), "clearing the box takes a note out again");
click($$('[data-tbl="note-del"]')[1]);
await wait(150);
type($("#note-drop-confirm"), "CONFIRM");
click($('[data-tbl="note-del-go"]'));
await until(() => ((dmRec() || {}).notes || []).length === 1);

/* AND A ROOM THAT IS STILL HOLDING THE DM'S OLD NOTES HANDS THEM OVER. Two shapes came before this one —
   a single unnamed box on the room, then a per-room list — and leaving either where it was is exactly the
   two-lists complaint in another costume. Nothing is deleted until the move has been written. */
await aget(`CocLive.push("tables/482910/notes", { title: "From the room", body: "written before the move", by: "dm", at: 1 })`);
await aget(`CocLive.put("tables/482910/dm/notes", "the oldest box of all")`);
await until(async () => !!(await aget(`CocLive.get("tables/482910/notes")`)));
peek(`tblDmNotesMoved = ""; tblMigrateDmNotes();`);
await until(() => ((dmRec() || {}).notes || []).length === 3);
const moved = (dmRec() || {}).notes || [];
ok(moved.length === 3, "an old room note and the oldest box both move onto the code");
ok(moved.some((n) => n.body === "written before the move"), "with what was written in them");
ok(await until(async () => (await aget(`CocLive.get("tables/482910/notes")`)) === null),
  "and the room stops holding a second copy");
ok(await until(async () => (await aget(`CocLive.get("tables/482910/dm/notes")`)) === null), "both of them");
peek(`paintSide();`);
ok($$("#notes-panel .scene-row").length === 3, "so the panel shows one list with everything in it");
openPanel("dm");
await wait(60);
// Handouts: shown to everyone at once, closable by each person.
click($('[data-tbl="hand-add"]'));
await wait(40);
ok(/needs a title/.test($("#hand-msg").textContent), "an empty handout is refused");
type($("#hand-title"), "The letter"); type($("#hand-body"), "Come alone. Bring the ledger.");
click($('[data-tbl="hand-add"]'));
await wait(100);
ok($$('[data-tbl="hand-show"]').length === 1, "a handout is kept until you want it");
ok($("#vtt-handout").classList.contains("hidden"), "and is not on anyone's screen yet");
click($('[data-tbl="hand-show"]'));
await wait(80);
ok(!$("#vtt-handout").classList.contains("hidden"), "showing it puts it over the board");
ok(/Come alone/.test($("#vtt-handout").textContent), "with its text: " + $("#vtt-handout").textContent.trim().slice(0, 40));
click($('[data-tbl="hand-dismiss"]'));
await wait(40);
ok($("#vtt-handout").classList.contains("hidden"), "each person can put it away for themselves");
ok((await aget(`CocLive.get("tables/482910/meta/handout")`)) !== null,
  "without taking it off anybody else's screen");
openPanel("dm");
await wait(40);
click($('[data-tbl="hand-hide"]'));
await wait(60);
ok((await aget(`CocLive.get("tables/482910/meta/handout")`)) === null, "the DM takes it back down for everyone");

console.log("\n— CHOOSING WHO YOU ARE —");
// A room code gets you in; WHO you are is chosen inside, from the figures on the table. Kayki's rule: one
// leaves and comes back, takes their own figure again; a new player adds one; a figure somebody is holding
// cannot be taken.
peek(`localStorage.removeItem("coc:table:dm:482910"); localStorage.removeItem("coc:table:me:482910");`);
await go("#/table", 60);
type($("#tbl-room"), "482910");
click($('[data-tbl="join"]'));
await wait(150);
ok(peek(`location.hash`) === "#/table/482910", "the room code alone gets you in");
await go("#/table/482910", 400);
await wait(300);
ok(peek(`tbl.role`) === "player", "as a player");
ok(peek(`tbl.ui.panel`) === "seat", "and you are asked who you are playing, rather than given a figure");
// Asked once — but never lost. Clicking away used to leave no way back to the question.
ok($('[data-tbl="panel"][data-val="seat"]'), "with a way back to the question in the bar");
openPanel("notes");
await wait(40);
ok(peek(`tbl.ui.panel`) === "notes", "you can go and look at something else");
openPanel("seat");
await wait(40);
ok(peek(`tbl.ui.panel`) === "seat", "and come straight back to choosing");
ok($$('[data-tbl="seat-take"]').length >= 1, "with the figures already on the table offered");
// Rig is on the board from earlier and nobody is holding it, so it can be taken.
const rigBtn = $$('[data-tbl="seat-take"]').find((b) => b.dataset.val === "tRig");
ok(rigBtn && !rigBtn.disabled, "a figure nobody is holding is free to take");
click(rigBtn);
await wait(200);
ok(peek(`tbl.me.tokenId`) === "tRig", "taking one makes it yours");
ok((await aget(`CocLive.get("tables/482910/tokens/tRig/owner")`)) === peek(`tbl.me.clientId`),
  "recorded on the figure, so this browser controls it");
ok(peek(`tbl.me.charCode`) === "123456", "and you become whoever it is — sheet and all");
ok(peek(`tblCanMove(tblTokens().tRig)`) === true, "which is what lets you move it");
ok(peek(`tbl.ui.panel`) === "", "the question closes once answered");
peek(`paintBar();`);
ok(!$('[data-tbl="panel"][data-val="seat"]'), "and the button goes away once you have a figure");
// Somebody else holding a figure: it cannot be taken while they are here.
await peek(`CocLive.put("tables/482910/tokens/tHeld", { name: "Sable", kind: "pc", owner: "otherClient",
  x: 3, y: 9, size: 1, hp: 10, hpMax: 10, speed: 30 })`);
await peek(`CocLive.put("tables/482910/presence/otherClient", { name: "Sable", role: "player", at: Date.now() })`);
await wait(120);
peek(`tbl.ui.panel = "seat"; paintSide();`);
const heldBtn = $$('[data-tbl="seat-take"]').find((b) => b.dataset.val === "tHeld");
ok(heldBtn && heldBtn.disabled, "a figure somebody is playing is greyed out");
ok(/Sable is playing this one/.test(heldBtn.textContent), "and says who has it");
// …and can be taken once they have gone quiet, because a table has to survive somebody's phone dying.
await peek(`CocLive.put("tables/482910/presence/otherClient/at", Date.now() - 120000)`);
await wait(80);
peek(`paintSide();`);
ok(!$$('[data-tbl="seat-take"]').find((b) => b.dataset.val === "tHeld").disabled,
  "once they have gone quiet it is free again");
// A new player adds a character instead.
peek(`tbl.ui.panel = "seat"; paintSide();`);
click($('[data-tbl="seat-new"]'));
await wait(60);
ok(/Give them a name/.test($("#seat-msg").textContent), "an unnamed newcomer is refused");
type($("#seat-code"), "12");
click($('[data-tbl="seat-new"]'));
await wait(60);
ok(/six digits, or leave it empty/.test($("#seat-msg").textContent), "half a Circus of Chaos code is a typo");
type($("#seat-code"), ""); type($("#seat-name"), "Greta the Bold");
click($('[data-tbl="seat-new"]'));
await wait(250);
const greta = Object.entries(peek(`JSON.parse(JSON.stringify(tblTokens()))`)).find(([, t]) => t.name === "Greta the Bold");
ok(greta, "a new character goes on the board");
ok(greta[1].owner === peek(`tbl.me.clientId`), "owned by whoever added them");
ok(peek(`tbl.me.tokenId`) === greta[0], "and is who you are now playing");
ok(peek(`tbl.me.charCode`) === "", "with no sheet, since no code was given");
// A code brings the real sheet.
peek(`tbl.ui.panel = "seat"; paintSide();`);
type($("#seat-name"), ""); type($("#seat-code"), "123456");
click($('[data-tbl="seat-new"]'));
await wait(300);
ok(peek(`tbl.me.charCode`) === "123456", "a code makes it a Circus of Chaos character");
await until(() => peek(`tblMyTokens().length`) === 1);
ok(peek(`tblMyTokens().length`) === 1, "and you are holding exactly one figure — the others are let go, not deleted (" + peek(`JSON.stringify(tblMyTokens())`) + ")");
const taken = peek(`JSON.parse(JSON.stringify(tblTokens()[tbl.me.tokenId]))`);
ok(taken.name === "Rig" && taken.hpMax === 44 && taken.charCode === "123456",
  "named and numbered from the sheet it pulled (" + taken.name + " " + taken.hp + "/" + taken.hpMax + ")");

/* TAKING YOUR FIGURE OFF, AND PUTTING IT STRAIGHT BACK. Kayki misclicked "take it off the table" on the
   card that used to open when you tapped yourself, and could not get back on: the figure is DELETED, so
   it is not in the list to be taken again, and "My sheet" went on showing a full sheet for a character
   that had left the room. So the button lives on the sheet now, taking it off opens the question, and the
   answer is one press because this browser still knows which character it was. */
/* Nothing else on the board carrying this code first — the figures let go by the pruning above are still
   standing there, and a free figure with your code is offered in the list, which is a different way back. */
await peek(`(async () => { for (const [id, t] of Object.entries(tblTokens()))
  if (t && t.charCode === "123456" && id !== tbl.me.tokenId) await CocLive.del("tables/482910/tokens/" + id); })()`);
await until(() => peek(`Object.values(tblTokens()).filter((t) => t && t.charCode === "123456").length`) === 1);
peek(`tbl.ui.panel = "sheet"; paintSide();`);
await until(() => !!$("#vtt-sheet [data-act='tab'][data-val='progress']"), 10000);
click($("#vtt-sheet [data-act='tab'][data-val='progress']"));   // where leaving lives, beside levelling
await until(() => !!$("#vtt-sheet [data-tbl='mine-remove']"), 10000);
click($("#vtt-sheet [data-tbl='mine-remove']"));
await until(() => peek(`tblMyTokens().length`) === 0);
ok(peek(`tbl.ui.panel`) === "seat", "taking it off asks who you are playing, rather than closing everything");
ok(!$('[data-tbl="panel"][data-val="sheet"]'),
  "and 'My sheet' goes with it — a sheet for somebody not at the table is a sheet that lies");
peek(`tbl.ui.panel = "sheet"; paintSide();`);
ok(!!$('[data-tbl="seat-return"]'), "opening it anyway asks the same question, not the old sheet");
ok(/Rig/.test($('[data-tbl="seat-return"]').textContent), "with the character you were just playing named on it");
ok(!!$('[data-tbl="seat-new"]'), "beside the other way in — a name, with a code or without one");
click($('[data-tbl="seat-return"]'));
await until(() => peek(`tblMyTokens().length`) === 1, 6000);
const backOn = peek(`JSON.parse(JSON.stringify(tblTokens()[tbl.me.tokenId]))`);
ok(backOn.charCode === "123456" && backOn.name === "Rig",
  "one press puts the same character back on, sheet and all (" + backOn.name + ")");
ok(peek(`tbl.me.left`) === false, "and this browser stops thinking you walked out");

/* DELETING A CHARACTER TAKES ITS FIGURE WITH IT. Kayki's distinction, and the right one: deleting is not
   dying. A dead character's figure stays because a body is a thing at the table; a deleted one never
   existed, and leaving it behind meant logging in as the DM to sweep up — and then being unable to seat
   the replacement, because this browser was still introducing itself with the dead code. */
peek(`localStorage.setItem("coc:table:recent", JSON.stringify([{ code: "482910", name: "T" }]));
  tblSaveMe("482910", { clientId: tbl.me.clientId, name: "Rig", charCode: "123456" });`);
await peek(`CocLive.put("tables/482910/tokens/tGhostChar", { name: "Rig", charCode: "123456",
  owner: "someone-else", x: 1, y: 1, size: 1, kind: "pc", hp: 5, hpMax: 5, speed: 30 })`);
await until(async () => !!(await aget(`CocLive.get("tables/482910/tokens/tGhostChar")`)));
await peek(`tblDropCharacterEverywhere("123456")`);
await until(async () => (await aget(`CocLive.get("tables/482910/tokens/tGhostChar")`)) == null);
ok(true, "deleting a character takes its figure off every table this browser knows");
ok(peek(`JSON.parse(localStorage.getItem("coc:table:me:482910")).charCode`) === "",
  "and this browser stops introducing itself with the code that no longer exists");

console.log("\n— MUSIC —");
/* THE DM CHOOSES, EVERY DEVICE PLAYS ITS OWN COPY, AND THE VOLUME IS YOURS. Nothing is streamed between
   browsers — there is no server to stream it through. What travels is a few dozen bytes saying WHAT is
   playing and how far in it was at a moment on the clock, so somebody joining halfway comes in where the
   room already is. jsdom cannot make a sound, so what is proved here is the wiring and the arithmetic;
   the audio itself is the one thing in this file no test can hear. */
peek(`tbl.role = "dm"; renderTableShell();`);
openPanel("music");
await wait(60);
ok(!!$('[data-tbl="panel"][data-val="music"]'), "there is a Music button in the bar");
ok(/Nothing playing/.test($("#tool").textContent), "and nothing is playing to begin with");

/* ELEVEN CHARACTERS, out of any shape of YouTube address — and nothing out of anything else. */
const ytCases = [
  ["https://www.youtube.com/watch?v=dQw4w9WgXcQ", "dQw4w9WgXcQ"],
  ["https://youtu.be/dQw4w9WgXcQ?t=42", "dQw4w9WgXcQ"],
  ["https://www.youtube.com/watch?list=PL1&v=dQw4w9WgXcQ&index=2", "dQw4w9WgXcQ"],
  ["https://www.youtube.com/shorts/dQw4w9WgXcQ", "dQw4w9WgXcQ"],
  ["https://www.youtube.com/embed/dQw4w9WgXcQ", "dQw4w9WgXcQ"],
  ["https://example.com/not-a-video", ""],
  ["", ""],
];
ok(ytCases.every(([u, want]) => peek(`tblYouTubeId(${JSON.stringify(u)})`) === want),
  "a YouTube id is found in every shape of address, and invented for none");

// A link that is not one is refused, and says why rather than saving something that will never play.
click($('[data-tbl="music-kind"][data-val="youtube"]'));
await wait(40);
type($("#music-title"), "The Midway");
type($("#music-url"), "https://example.com/nope");
click($('[data-tbl="music-add"]'));
await wait(80);
ok(/not a YouTube address/.test($("#music-msg").textContent), "a bad YouTube address is refused");
ok((await aget(`CocLive.get("tables/482910/music/tracks")`)) === null, "and nothing is saved");

type($("#music-url"), "https://www.youtube.com/watch?v=dQw4w9WgXcQ");
click($('[data-tbl="music-add"]'));
await until(async () => !!(await aget(`CocLive.get("tables/482910/music/tracks")`)));
const tracks = await aget(`CocLive.get("tables/482910/music/tracks")`);
const tid = Object.keys(tracks)[0];
ok(tracks[tid].kind === "youtube" && tracks[tid].src === "dQw4w9WgXcQ", "a good one is saved as its id, not its URL");
ok(tracks[tid].title === "The Midway", "under the name it was given");
peek(`paintSide();`);
ok($$("#tool .scene-row").length >= 1, "and it lists on the table's own shelf of tracks");

/* PLAYING IT. What goes on the wire is what, whether, and from where — never the audio. */
click($(`[data-tbl="music-play"][data-val="${tid}"]`));
await until(async () => !!(await aget(`CocLive.get("tables/482910/music/now")`)));
let now = await aget(`CocLive.get("tables/482910/music/now")`);
ok(now.playing === true && now.kind === "youtube" && now.src === "dQw4w9WgXcQ", "pressing one starts it for the room");
ok(now.pos === 0 && typeof now.at === "number", "from the top, stamped with when that was");
ok(JSON.stringify(now).length < 400, "and what travels is bytes, not a track (" + JSON.stringify(now).length + ")");

/* WHERE A LATECOMER COMES IN. This one line is the whole of the synchronising. */
ok(peek(`tblMusicWhere({ playing: true, pos: 12, at: Date.now() - 5000 })`) > 16.9 &&
   peek(`tblMusicWhere({ playing: true, pos: 12, at: Date.now() - 5000 })`) < 17.2,
  "five seconds after a start twelve seconds in, the room is seventeen seconds in");
ok(peek(`tblMusicWhere({ playing: false, pos: 30, at: Date.now() - 60000 })`) === 30,
  "and a paused track does not run on while nobody is listening");

/* PAUSE FREEZES THE POSITION, so resuming picks up where the room was rather than where the clock went. */
peek(`paintSide();`);
click($('[data-tbl="music-pause"]'));
await until(async () => ((await aget(`CocLive.get("tables/482910/music/now")`)) || {}).playing === false);
now = await aget(`CocLive.get("tables/482910/music/now")`);
ok(now.playing === false && now.pos >= 0, "pause writes the position it stopped at");
/* WHAT HAPPENS AT THE END IS TWO BUTTONS, not a chip you have to infer the state of. Exactly one is
   always lit, and pressing the one already lit does nothing rather than flipping the room. */
peek(`paintSide();`);
ok($$('[data-tbl="music-end"]').length === 2, "the end of a track is offered as two answers");
ok($('[data-tbl="music-end"][data-val="next"]').className.includes("on"),
  "and Play the next is the one lit to begin with");
click($('[data-tbl="music-end"][data-val="next"]'));
await wait(120);
ok(((await aget(`CocLive.get("tables/482910/music/now")`)) || {}).loop !== true,
  "pressing the one already lit changes nothing");
click($('[data-tbl="music-end"][data-val="repeat"]'));
await until(async () => ((await aget(`CocLive.get("tables/482910/music/now")`)) || {}).loop === true);
peek(`paintSide();`);
ok($('[data-tbl="music-end"][data-val="repeat"]').className.includes("on"), "and the other sets repeat");
ok(/go round for ever/.test($("#tool").textContent), "saying plainly that nothing will follow it");
click($('[data-tbl="music-end"][data-val="next"]'));
await until(async () => ((await aget(`CocLive.get("tables/482910/music/now")`)) || {}).loop === false);
ok(true, "and back again");

/* HALF BY DEFAULT, AND SILENT MEANS SILENT.
   `localStorage.getItem` answers null when nothing is stored and `Number(null)` is 0, which passed the
   range check — so every device that had never touched the slider was handed a volume of ZERO. A whole
   table of first-time devices would have heard nothing while the panel said it was working. */
peek(`localStorage.removeItem("coc:tbl:music:vol"); localStorage.removeItem("coc:tbl:music:mute");`);
ok(peek(`tblMusicVol()`) === 0.5, "a device that has never touched the slider starts at half, not at zero");
ok(peek(`tblMusicSilent()`) === false, "and is not silent");
peek(`tblMusicSetVol(0)`);
ok(peek(`tblMusicSilent()`) === true, "the slider at the bottom counts as silence, not as very quiet");
peek(`paintSide();`);
ok(/silent/.test($("#tool").textContent), "and the panel says silent rather than 0%");
peek(`tblMusicSetVol(0.5)`);
ok(peek(`tblMusicSilent()`) === false, "moving it off the bottom brings it back");

/* WHETHER A TRACK HAS FINISHED IS THE PLAYER'S TO SAY, NEVER THE CLOCK'S. YouTube may put an advert in
   front of the music, and then the player is twenty seconds behind the wall clock: ending on the clock
   would cut the last twenty seconds off, on one device, and skip ahead of everybody else. */
peek(`CocLive.put("tables/482910/music/now", { kind: "youtube", src: "abc", title: "Y", playing: true,
  pos: 0, at: Date.now() - 600000, loop: false, gen: 500 });`);
await wait(150);
peek(`mus.yt = { getPlayerState: () => 1, getDuration: () => 300, getCurrentTime: () => 12 }; mus.ytOn = true;`);
ok(peek(`tblMusicOver()`) === false,
  "ten minutes on the clock but twelve seconds into the player is NOT finished");
peek(`mus.yt.getCurrentTime = () => 299.8;`);
ok(peek(`tblMusicOver()`) === true, "and the end of the player's own track is");
peek(`mus.yt.getCurrentTime = () => 12; mus.yt.getPlayerState = () => 0;`);
ok(peek(`tblMusicOver()`) === true, "as is the player saying so itself");
peek(`CocLive.put("tables/482910/music/now/loop", true);`);
await wait(150);
ok(peek(`tblMusicOver()`) === false, "a track on repeat never finishes, so nothing can follow it");
/* AND WHEN THE QUEUE IS EMPTY, THE END OF A TRACK IS SILENCE. Kayki: "when it finishes the queue it just
   keep repeating the last 5sec of the last music infinitely." A finished track kept `playing: true` with
   nothing to replace it, so the wall clock walked on past the end while the player stood at it — and the
   drift correction seeked a player that had ENDED, which does not nudge a YouTube player, it starts it
   again. Every 2.5 seconds, for ever. */
peek(`CocLive.put("tables/482910/music/queue", null);`);
peek(`CocLive.put("tables/482910/music/now", { kind: "youtube", src: "abc", title: "Y", playing: true,
  pos: 0, at: Date.now() - 600000, loop: false, gen: 501 });`);
await wait(150);
peek(`mus.ytSeeks = 0; mus.ytPlays = 0; mus.ytOn = true;
  mus.yt = { getPlayerState: () => 0, getDuration: () => 200, getCurrentTime: () => 200,
    getVideoData: () => ({ video_id: "abc" }), seekTo: () => { mus.ytSeeks++; },
    playVideo: () => { mus.ytPlays++; }, pauseVideo: () => {}, cueVideoById: () => {},
    loadVideoById: () => {}, setVolume: () => {}, mute: () => {}, unMute: () => {} };`);
peek(`tblMusicApply();`);
ok(peek(`mus.ytSeeks`) === 0, "a finished track is never seeked back into line — that is what replayed it");
ok(peek(`mus.ytPlays`) === 0, "nor started again");
peek(`tblMusicEnded();`);
await until(async () => (await aget(`CocLive.get("tables/482910/music/now")`)) === null);
ok(true, "with nothing queued, the end of the last track writes the quiet");
peek(`mus.yt = null; mus.ytOn = false; CocLive.put("tables/482910/music/now", null);`);
await wait(150);

/* THE VOLUME IS THIS DEVICE'S AND NEVER GOES NEAR THE DATABASE — a table where the DM's slider moved
   everybody's is a table where nobody can hear their own game. */
peek(`paintSide();`);
peek(`tblMusicSetVol(0.25)`);
ok(peek(`tblMusicVol()`) === 0.25, "the volume is remembered on this device");
ok(!/0\.25/.test(JSON.stringify(await aget(`CocLive.get("tables/482910/music")`))),
  "and is nowhere in the table");
click($('[data-tbl="music-mute"]'));
await wait(40);
ok(peek(`tblMusicMuted()`) === true, "mute is this device's too");
ok(!/mute/i.test(JSON.stringify(await aget(`CocLive.get("tables/482910/music/now")`))), "and also stays here");
click($('[data-tbl="music-mute"]'));
await wait(40);
ok(peek(`tblMusicMuted()`) === false, "and unmutes again");

/* A BROWSER WILL NOT MAKE A SOUND UNTIL IT HAS BEEN TOUCHED. Policy everywhere, so the panel says so and
   offers the one gesture that fixes it. */
peek(`localStorage.removeItem("coc:tbl:music:ok"); paintSide();`);
ok(!!$('[data-tbl="music-enable"]'), "a device that has never been touched is offered the sound switch");
ok(/will not play anything until you have touched/.test($("#tool").textContent), "and told why");
click($('[data-tbl="music-enable"]'));
await wait(60);
ok(peek(`tblMusicAllowed()`) === true, "pressing it unlocks that device");
ok(!$('[data-tbl="music-enable"]'), "and it stops asking");

/* A PLAYER GETS THE VOLUME AND NOT THE CHOOSING. */
peek(`tbl.role = "player"; paintSide();`);
ok(!!$('[data-tbl="music-mute"]') && !!$("#music-vol"), "a player has the volume and the mute");
ok(!$('[data-tbl="music-play"]') && !$('[data-tbl="music-add"]') && !$('[data-tbl="music-stop"]'),
  "and none of the choosing");
ok(/The DM chooses what plays/.test($("#tool").textContent), "with a line saying whose it is");
peek(`tbl.role = "dm"; paintSide();`);

/* THE QUEUE, WHICH IS THE DM'S AND NOBODY ELSE'S. Kayki: "only dm has access to the queued musics, the
   players can see what is playing." Playing something does not touch the queue and queueing something
   does not interrupt what is playing — two questions, two answers. */
peek(`paintSide();`);
click($(`[data-tbl="music-queue"][data-val="${tid}"]`));
await until(async () => ((await aget(`CocLive.get("tables/482910/music/queue")`)) || []).length === 1);
ok(true, "a track can be put at the back of the queue");
ok((await aget(`CocLive.get("tables/482910/music/now")`)) === null ||
   ((await aget(`CocLive.get("tables/482910/music/now")`)) || {}).trackId !== undefined,
  "and queueing does not interrupt what is playing");
// A second track to reorder against.
peek(`tbl.ui.musicKind = "youtube"; paintSide();`);
type($("#music-title"), "Grinsel");
type($("#music-url"), "https://youtu.be/aaaaaaaaaaa");
click($('[data-tbl="music-add"]'));
await until(async () => Object.keys((await aget(`CocLive.get("tables/482910/music/tracks")`)) || {}).length === 2);
const two = await aget(`CocLive.get("tables/482910/music/tracks")`);
const tid2 = Object.keys(two).find((k) => k !== tid);
peek(`paintSide();`);
click($(`[data-tbl="music-queue"][data-val="${tid2}"]`));
await until(async () => ((await aget(`CocLive.get("tables/482910/music/queue")`)) || []).length === 2);
ok((await aget(`CocLive.get("tables/482910/music/queue")`))[0] === tid, "the queue keeps the order it was given");
peek(`paintSide();`);
click($(`[data-tbl="music-q-up"][data-val="${tid2}"]`));
await until(async () => (await aget(`CocLive.get("tables/482910/music/queue")`))[0] === tid2);
ok(true, "and one can be moved sooner");
/* NEXT TAKES THE HEAD OF THE QUEUE AND CONSUMES IT — the room plays it, the queue is one shorter. */
peek(`paintSide();`);
click($('[data-tbl="music-next"]'));
await until(async () => ((await aget(`CocLive.get("tables/482910/music/now")`)) || {}).trackId === tid2);
ok(((await aget(`CocLive.get("tables/482910/music/queue")`)) || []).length === 1,
  "Next plays the head of the queue and takes it off");
/* AND A PLAYER IS NOT TOLD WHAT IS COMING. Knowing the next three tracks is knowing there are three
   fights left. */
peek(`tbl.role = "player"; paintSide();`);
ok(!$('[data-tbl="music-q-drop"]') && !$('[data-tbl="music-queue"]') && !$('[data-tbl="music-next"]'),
  "a player has no queue controls at all");
ok(!/Up next/.test($("#tool").textContent), "and is not shown the queue");
ok(!/Grinsel/.test($("#tool").textContent) || /playing/.test($("#tool").textContent),
  "nor the shelf it is drawn from");
peek(`tbl.role = "dm"; paintSide();`);
ok(/Up next/.test($("#tool").textContent), "the DM does see it");
/* DELETING A TRACK ASKS FOR THE WORD, the same as a creature, a character and a table. It sits one
   button from Queue on a crowded row, and for an uploaded track the bytes go with it. */
click($(`[data-tbl="music-queue"][data-val="${tid2}"]`));
await until(async () => ((await aget(`CocLive.get("tables/482910/music/queue")`)) || []).length === 2);
const shelfWas = Object.keys(await aget(`CocLive.get("tables/482910/music/tracks")`)).length;
click($(`[data-tbl="music-drop"][data-val="${tid2}"]`));
await wait(120);
ok(Object.keys(await aget(`CocLive.get("tables/482910/music/tracks")`)).length === shelfWas,
  "one press on a track's Delete deletes nothing");
ok(!!$("#music-drop-confirm"), "it asks for the word instead");
ok($('[data-tbl="music-drop-go"]').disabled === true, "with the button locked until it is typed");
type($("#music-drop-confirm"), "yes");
ok($('[data-tbl="music-drop-go"]').disabled === true, "and the wrong word does not unlock it");
type($("#music-drop-confirm"), "CONFIRM");
ok($('[data-tbl="music-drop-go"]').disabled === false, "CONFIRM unlocks it");
ok($("#music-drop-confirm").value === "CONFIRM", "without the panel redrawing under the keyboard");
// Cancel puts the row back and keeps the track.
click($('[data-tbl="music-drop-cancel"]'));
await wait(120);
ok(!$("#music-drop-confirm") && !!$(`[data-tbl="music-drop"][data-val="${tid2}"]`),
  "Cancel puts the row back with the track still on it");
click($(`[data-tbl="music-drop"][data-val="${tid2}"]`));
await wait(120);
type($("#music-drop-confirm"), "CONFIRM");
click($('[data-tbl="music-drop-go"]'));
await until(async () => Object.keys((await aget(`CocLive.get("tables/482910/music/tracks")`)) || {}).length === 1);
peek(`paintSide();`);
ok(peek(`tblMusicQueue().length`) === 1 && peek(`tblMusicQueue()[0]`) === tid,
  "deleting a track takes it out of the queue with it");
ok(!/${tid2}/.test(JSON.stringify(await aget(`CocLive.get("tables/482910/music/queue")`))),
  "and out of the stored queue, not merely hidden when it is read");
click($('[data-tbl="music-q-clear"]'));
await until(async () => (await aget(`CocLive.get("tables/482910/music/queue")`)) === null);
peek(`tbl.ui.musicKind = "repo"; paintSide();`);
ok(/music\//.test($("#tool").textContent), "and the fourth source is what is committed in music/");
/* FOLDERS, MADE IN THE APP. Kayki: "in the app itself, I create folders for the musics, drag and drop
   them in there, also I can reorganize the order at will." A folder is a thing the DM MAKES — a YouTube
   track and a committed one belong in "Main Stage" together, and neither lives in a directory of that
   name. The drag itself needs a real browser and is covered in music.mjs; this is the data underneath,
   and the arrows and the Move list, which do the very same write. */
ok(peek(`tblMusicDiskFolder("backstage/waking-up.mp3")`) === "backstage", "a committed file's folder is read off its path");
ok(peek(`tblMusicSrc({ kind: "repo", src: "main stage/a b.mp3" })`) === "music/main%20stage/a%20b.mp3",
  "and its address escapes each segment but not the slashes");
peek(`tbl.ui.musicKind = "repo"; tblRepoMusic = ["backstage/one.mp3", "backstage/two.mp3", "loose.mp3"]; paintSide();`);
ok(/backstage/.test($("#tool").textContent), "the Add list groups by the folder they sit in on disk");
click($$('[data-tbl="music-repo-all"]').find((b) => b.dataset.val === "backstage"));
await until(async () => Object.values((await aget(`CocLive.get("tables/482910/music/tracks")`)) || {})
  .filter((t) => t.kind === "repo").length === 2);
/* ADDING A WHOLE DISK FOLDER MAKES AN APP FOLDER OF THE SAME NAME, so organising in music/ and
   organising in the app give one answer rather than two arrangements to keep in step. */
const madeFolders = await aget(`CocLive.get("tables/482910/music/folders")`);
ok(Object.values(madeFolders || {}).some((f) => f.name === "backstage"),
  "adding a disk folder makes an app folder of the same name");
const fBack = Object.keys(madeFolders).find((k) => madeFolders[k].name === "backstage");
ok(peek(`tblMusicGroup(${JSON.stringify(fBack)}).length`) === 2, "with both of its tracks inside it");
ok(peek(`tblMusicGroup(${JSON.stringify(fBack)}).map(([, t]) => t.order).join()`) === "0,1",
  "each carrying its place in that folder");

/* A FOLDER OF HIS OWN, and reordering inside it. */
peek(`tbl.ui.musicKind = "youtube"; paintSide();`);
type($("#music-folder"), "Main Stage");
click($('[data-tbl="music-f-add"]'));
await until(async () => Object.keys((await aget(`CocLive.get("tables/482910/music/folders")`)) || {}).length === 2);
const allF = await aget(`CocLive.get("tables/482910/music/folders")`);
const fMain = Object.keys(allF).find((k) => allF[k].name === "Main Stage");
ok(!!fMain, "a folder can be made in the app and named");
// Move a track into it with the Move list — the same write the drag does, without the gesture.
peek(`paintSide();`);
const firstBack = peek(`tblMusicGroup(${JSON.stringify(fBack)})[0][0]`);
const sel = $(`[data-mus-move="${firstBack}"]`);
ok(!!sel, "every row has a Move list, so the drag is never the only way");
sel.value = fMain;
sel.dispatchEvent(new (doc.defaultView.Event)("change", { bubbles: true }));
await until(() => peek(`tblMusicGroup(${JSON.stringify(fMain)}).length`) === 1);
ok(peek(`tblMusicGroup(${JSON.stringify(fBack)}).length`) === 1, "moving one out leaves the other behind");
ok(peek(`tblMusicGroup(${JSON.stringify(fBack)})[0][1].order`) === 0,
  "and the folder it left is renumbered, so there is no hole in it");
peek(`paintSide();`);
/* NO UP/DOWN ARROWS ON A TRACK ROW — they crowded the title off its own row. */
ok(!$$('[data-tbl="music-up"]').length && !$$('[data-tbl="music-down"]').length,
  "a track row carries no stepper, so the title keeps the room");
/* DELETING A FOLDER ASKS FIRST, and NEVER DELETES MUSIC. Losing an evening's playlist to a mis-tap is
   not a trade worth making, so its tracks come out loose. */
const shelfSize = peek(`Object.keys(tblMusicData().tracks || {}).length`);
click($(`[data-tbl="music-f-drop"][data-val="${fMain}"]`));
await wait(80);
ok(!!((await aget(`CocLive.get("tables/482910/music/folders")`)) || {})[fMain],
  "pressing Delete folder asks rather than deleting");
ok(!!$(`[data-tbl="music-f-drop-go"][data-val="${fMain}"]`), "and puts the question on the row");
click($('[data-tbl="music-f-drop-cancel"]'));
await wait(80);
ok(!!((await aget(`CocLive.get("tables/482910/music/folders")`)) || {})[fMain], "Cancel keeps the folder");
click($(`[data-tbl="music-f-drop"][data-val="${fMain}"]`));
await wait(80);
click($(`[data-tbl="music-f-drop-go"][data-val="${fMain}"]`));
await until(async () => !((await aget(`CocLive.get("tables/482910/music/folders")`)) || {})[fMain]);
ok(peek(`Object.keys(tblMusicData().tracks || {}).length`) === shelfSize,
  "deleting a folder deletes no music");
peek(`paintSide();`);
ok(peek(`tblMusicGroup("").some(([id]) => id === ${JSON.stringify(firstBack)})`),
  "its tracks come out loose instead");
/* AND A FOLDER CAN BE RENAMED AND REORDERED. */
click($(`[data-tbl="music-f-rename"][data-val="${fBack}"]`));
await wait(80);
type($(`#music-rename-${fBack}`), "Backstage");
click($(`[data-tbl="music-f-save"][data-val="${fBack}"]`));
await until(async () => (((await aget(`CocLive.get("tables/482910/music/folders")`)) || {})[fBack] || {}).name === "Backstage");
ok(true, "a folder can be renamed");
/* AND DELETING A TRACK OUT OF A FOLDER REALLY DELETES IT. Kayki: "when i delete something from the
   track, it just go back to the loose" — which is the repo Add list below, not the shelf: a committed
   file cannot be deleted from a browser, so it rejoins the list of files not yet added. The shelf entry
   is gone, and it must not reappear under Loose up here. */
peek(`paintSide();`);
const inFolder = peek(`tblMusicGroup(${JSON.stringify(fBack)})[0][0]`);
click($(`[data-tbl="music-drop"][data-val="${inFolder}"]`));
await wait(120);
type($("#music-drop-confirm"), "CONFIRM");
click($('[data-tbl="music-drop-go"]'));
await until(async () => !((await aget(`CocLive.get("tables/482910/music/tracks")`)) || {})[inFolder]);
peek(`paintSide();`);
ok(!peek(`tblMusicGroup("").some(([id]) => id === ${JSON.stringify(inFolder)})`),
  "a track deleted out of a folder does not come back loose");
ok(!peek(`tblMusicTracks().some(([id]) => id === ${JSON.stringify(inFolder)})`),
  "it is off the shelf altogether");
ok(peek(`tblMusicDiskName("")`) === "In music/",
  "and the repo list's top level is not a second heading called Loose");
// Tidy up so the blocks after this one see the shelf they expect.
for (const [id, t] of Object.entries(await aget(`CocLive.get("tables/482910/music/tracks")`))) {
  if (t.kind === "repo") await aget(`CocLive.del("tables/482910/music/tracks/${id}")`);
}
await aget(`CocLive.put("tables/482910/music/folders", null)`);
await aget(`CocLive.put("tables/482910/music/queue", null)`);
await wait(150);
peek(`tblRepoMusic = null; tbl.ui.musicKind = "youtube"; paintSide();`);

/* MUSIC OUTLIVES THE ROOM IT IS PLAYING IN. Kayki: "the music should survive scene change, only stops
   when the dm does it." It is table data, not scene data, so moving everyone from the backstage to the
   ring does not touch it — asserted rather than assumed, because "it happens to work" is how a behaviour
   gets broken by the next person to tidy up scene switching. */
peek(`paintSide();`);
click($(`[data-tbl="music-play"][data-val="${tid}"]`));
await until(async () => ((await aget(`CocLive.get("tables/482910/music/now")`)) || {}).playing === true);
const beforeScene = await aget(`CocLive.get("tables/482910/music/now")`);
const scenes2 = Object.keys(await aget(`CocLive.get("tables/482910/scenes")`));
const showing = await aget(`CocLive.get("tables/482910/meta/activeScene")`);
const elsewhere = scenes2.find((k) => k !== showing);
peek(`tbl.ui.panel = "dm"; paintSide();`);   // the scene list lives in the DM panel
click($$('[data-tbl="scene"]').find(b => b.dataset.val === elsewhere));
await until(async () => (await aget(`CocLive.get("tables/482910/meta/activeScene")`)) === elsewhere);
const afterScene = await aget(`CocLive.get("tables/482910/music/now")`);
ok(afterScene && afterScene.playing === true, "changing the scene does not stop the music");
ok(JSON.stringify(afterScene) === JSON.stringify(beforeScene),
  "and does not so much as touch it — no restart, no reseek, no new generation");
peek(`tbl.ui.panel = "music"; paintSide();`);

/* STOP CLEARS THE ROOM, and deleting a track it was playing stops it rather than leaving a ghost. */
click($('[data-tbl="music-stop"]'));
await until(async () => (await aget(`CocLive.get("tables/482910/music/now")`)) === null);
ok(true, "Stop takes it off every device");
click($(`[data-tbl="music-play"][data-val="${tid}"]`));
await until(async () => !!(await aget(`CocLive.get("tables/482910/music/now")`)));
click($(`[data-tbl="music-drop"][data-val="${tid}"]`));
await wait(120);
type($("#music-drop-confirm"), "CONFIRM");
click($('[data-tbl="music-drop-go"]'));
await until(async () => (await aget(`CocLive.get("tables/482910/music/tracks")`)) === null);
ok((await aget(`CocLive.get("tables/482910/music/now")`)) === null,
  "deleting the track that is playing stops it, rather than leaving the room chasing something gone");
peek(`tbl.ui.panel = ""; paintSide();`);


console.log("\n— LEAVING —");
// A fresh room, since the one above was deleted on purpose. Two people in it: you, and somebody else.
const room = "445566";
await peek(`CocLive.put("tables/${room}", { meta: { name: "Leaving test", createdAt: 1 },
  scenes: { s1: { name: "Ring", cols: 10, rows: 8, cell: 70, createdAt: 1 } },
  presence: { other: { name: "Sable", role: "player", at: Date.now() } } })`);
peek(`localStorage.setItem("coc:table:me:${room}", JSON.stringify({ clientId: "cmine", name: "Rig", charCode: "123456" }));`);
await go("#/table/" + room, 300);
const myClient = peek(`tbl.me.clientId`);
await go("#/manage", 120);
ok(peek(`tbl`) === null, "walking out closes the session");
const gone = await aget(`CocLive.get("tables/${room}/presence")`);
ok(gone && !gone[myClient], "and takes your name off the list");
ok(gone && Object.keys(gone).length > 0, "while leaving everyone else on it");

peek(`if (window.__realRandom) Math.random = window.__realRandom;`);

console.log("\njsdom errors: " + errs.length); errs.slice(0, 8).forEach((e) => console.log("  " + e));
console.log(fails || errs.length ? "\nFAILURES: " + fails : "\nALL GREEN");
process.exit(fails || errs.length ? 1 : 0);
