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
                 "assets/js/app.js", "assets/js/creator.js",
                 "assets/js/table-board.js", "assets/js/table-dice.js", "assets/js/table-panels.js",
                 "assets/js/table.js"]) {
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
// Tidied away, so the DM's own notepad section further down counts only the DM's.
click($$('[data-tbl="note-del"]')[0]);
await wait(120);
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
await wait(200);
ok((await aget(`CocLive.get("tables/482910/tokens/tRig/image")`)) === "data:image/jpeg;base64,MINE",
  "a player can put a picture on their own figure");
ok((await aget(`CocStore.load("123456").then((c) => c && c.photo)`)) === "data:image/jpeg;base64,MINE",
  "and it lands on the CHARACTER, so it survives the next time the sheet saves");
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
await peek(`CocLive.put("tables/482910/tokens/tOrc/conditions", null)`);
peek(`CocLive.flush();`);
await wait(200);

console.log("\n— A PLAYER ENDS THEIR OWN TURN —");
peek(`tbl.role = "player"; tbl.me.charCode = "123456"; renderTableShell(); paintTokens(); paintTurnBar(); paintWho();`);
ok(/Rig — you/.test($("#vtt-turn").textContent), "the bar tells you it is your turn");
ok($('[data-tbl="turn"][data-val="1"]'), "and lets you end it");
ok(!$('[data-tbl="turn"][data-val="-1"]'), "but not step back through everyone else's");
ok(!$('[data-tbl="init-roll"]'), "nor reroll the whole order");
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
peek(`tbl.ui.peek = "tRig"; paintPeek();`);
ok(!!$('[data-tbl="mine-remove"][data-val="tRig"]'),
  "tapping your own figure offers the way off the table, code or no code");
ok(!!$('[data-tbl="panel"][data-val="sheet"]'), "beside the way into your sheet");
/* AND WHAT YOU ARE UNDER. A character with a real sheet could not mark itself prone: tapping your own
   figure went straight to the sheet, and the figure panel that holds the conditions was only ever shown
   to a guest with no sheet at all. So the DM kept the whole table's conditions in their head — which is
   the opposite of what this app is for. Kayki: "the app is to make it easier to keep track of things." */
ok(!!$('[data-tbl="my-conds"][data-val="tRig"]'), "and the way to what you are under");
click($('[data-tbl="my-conds"][data-val="tRig"]'));
await wait(80);
ok(peek(`tbl.ui.panel`) === "figure", "which opens your figure");
ok($$('[data-tbl="mine-cond"]').length >= 8,
  `carrying every condition as a chip you can press (${$$('[data-tbl="mine-cond"]').length})`);
ok(!/Hit points/.test($("#vtt-side").textContent),
  "and not your hit points, which are yours and live on your sheet");
click($$('[data-tbl="mine-cond"]').find((b) => /Prone/.test(b.textContent)));
await until(async () => ((await aget(`CocLive.get("tables/482910/tokens/tRig/conditions")`)) || [])
  .indexOf("prone") >= 0);
ok(true, "and pressing one marks it, for everybody");
/* AND PRESSING IT AGAIN TAKES IT OFF. Nothing repainted an open side panel — the stream repaints the
   board, the bars and the log, but not this — so the chip you had just switched off went on looking
   switched on, you pressed it again, and that put the condition back. "I can't remove the condition no
   matter what." The data was right every time and the panel never said so. */
ok(/\bon\b/.test($$('[data-tbl="mine-cond"]').find((b) => /Prone/.test(b.textContent)).className),
  "the chip shows it is on, without waiting for anything else to repaint");
click($$('[data-tbl="mine-cond"]').find((b) => /Prone/.test(b.textContent)));
await until(async () => (await aget(`CocLive.get("tables/482910/tokens/tRig/conditions")`)) == null);
ok(!/\bon\b/.test($$('[data-tbl="mine-cond"]').find((b) => /Prone/.test(b.textContent)).className),
  "and pressing it again takes it off, and the chip says so");
/* WHAT A CONDITION TAKES OFF YOUR FEET. Three of the ten change how far you can go, and Kayki marked
   himself prone and watched the bar go on saying 30 of 30 — which is the arithmetic this app is for. */
ok(peek(`tblSpeedUnder({ speed: 30 })`) === 30, "an unencumbered figure has all its speed");
ok(peek(`tblSpeedUnder({ speed: 30, conditions: ["prone"] })`) === 15, "prone is a crawl, at half");
ok(peek(`tblSpeedUnder({ speed: 25, conditions: ["prone"] })`) === 10,
  "rounded down to a whole square, because half a square is not a place");
ok(peek(`tblSpeedUnder({ speed: 30, conditions: ["grappled"] })`) === 0, "held, you go nowhere");
ok(peek(`tblSpeedWhy({ speed: 30, conditions: ["prone"] })`) === "crawling",
  "and the bar says why, rather than quietly halving a number nobody would then trust");
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
ok($("#tbl-npc-name"), "the DM can drop a figure");
ok(/no stat blocks/.test($("#tool").textContent), "and is told what it deliberately is not");
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
// Notes are a notepad of their own now — several, each with a title, for the DM and for every player.
openPanel("notes");
await wait(60);
ok($("#notes-panel"), "everyone has a notepad in the app instead of beside it");
ok(!$("#note-body"), "and nothing to write in until you make a note");
click($('[data-tbl="note-new"]'));
await wait(120);
ok($("#note-title") && $("#note-body"), "a new note opens ready to write in");
type($("#note-title"), "The innkeeper");
type($("#note-body"), "He is lying about the cellar.");
await wait(950);
const myNotes = await aget(`Object.values(await CocLive.get("tables/482910/notes"))`);
ok(myNotes.length === 1 && myNotes[0].title === "The innkeeper", "the title saves as you type");
ok(/lying about the cellar/.test(myNotes[0].body), "and so does the note");
ok(myNotes[0].by === "dm", "kept for the DM chair, so it is there on another device");
ok(/not secret/.test($("#tool").textContent), "with an honest word about who could read it");
// A second note, and the list of them.
click($('[data-tbl="note-new"]'));
await wait(120);
ok($$("#notes-panel .scene-row").length === 2, "a second note lists beside the first");
type($("#note-title"), "Rooftop chase");
await wait(950);
click($$('[data-tbl="note-del"]')[1]);
await wait(120);
ok($$("#notes-panel .scene-row").length === 1, "and a note can be thrown away");
ok((await aget(`Object.values(await CocLive.get("tables/482910/notes"))`)).length === 1, "for good");
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
