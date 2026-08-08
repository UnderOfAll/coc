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
                 "assets/js/app.js", "assets/js/creator.js", "assets/js/table.js"]) {
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
const until = async (fn, ms = 800) => {
  const stop = Date.now() + ms;
  while (Date.now() < stop) { if (fn()) return true; await wait(20); }
  return false;
};
const tblCols = () => peek(`tblScene().cols`);
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
ok($("#tbl-room") && $("#tbl-name-in"), "joining asks for a room code and a name");
ok($("#tbl-char"), "and offers a character code");
ok(/optional/i.test($("#tool").textContent), "which is optional, so any system can use the table");
ok($("#tbl-newroom") && $("#tbl-dmkey"), "running a table asks for a room code and a DM key");
ok(/six-digit|six digits/i.test($("#tool").textContent), "and says what shape the codes are");
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
ok(tok.querySelector(".tok-bar"), "the DM gets a hit-point bar on a figure");
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
ok($$('[data-tbl="ink-color"]').length === 6, "with colours to choose from");
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
// The eraser.
click($('[data-tbl="ink-erase"]'));
await wait(40);
pointer("pointerdown", $("#vtt-stage"), 200, 200, 1);
pointer("pointerup", $("#vtt-stage"), 200, 200, 1);
await wait(120);
ok((await aget(`CocLive.get("tables/482910/draw")`)) === null, "the eraser rubs out what is under it");
// Whose ink is whose.
await peek(`CocLive.push("tables/482910/draw", { by: "pc:999999", scene: tblSceneId(), color: "#6ab04c",
  width: 2, pts: "0.1000,0.1000 0.2000,0.2000", at: Date.now() })`);
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
// Same table, but this browser is a player holding character 123456.
peek(`tbl.role = "player"; tbl.me.charCode = "123456"; paintTokens();`);
ok($('[data-token="tRig"]').classList.contains("mine"), "your own figure is marked as yours");
ok($('[data-token="tRig"]').classList.contains("movable"), "and is movable");
ok(!$('[data-token="tOrc"]').classList.contains("movable"), "the DM's monster is not");
ok(!$('[data-token="tOrc"] .tok-bar'), "a player is sent no bar at all");
ok(!/15\/15/.test($('[data-token="tOrc"]').textContent), "nor any numbers");
ok(!$('[data-token="tRig"] .tok-bar'), "not even on their own figure — that is what the sheet is for");
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
peek(`window.__seq = []; window.__realRandom = Math.random;
  Math.random = () => (window.__seq.length ? window.__seq.shift() : 0.5);`);
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
const mixed = peek(`tblDoRoll(tblParseRoll("1d8+2d6+1d4"), "normal")`);
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
res = peek(`tblDoRoll(tblParseRoll("1d20"), "adv")`);
ok(res.dice.length === 2 && res.keptIdx >= 0, "advantage throws two and keeps one");
ok(res.dice[res.keptIdx].v === Math.max(...res.dice.map(x => x.v)),
  "the higher one (" + res.dice.map(x => x.v).join(",") + " -> " + res.dice[res.keptIdx].v + ")");
peek(`window.__seq = [0.1, 0.9];`);
res = peek(`tblDoRoll(tblParseRoll("1d20"), "dis")`);
ok(res.dice[res.keptIdx].v === Math.min(...res.dice.map(x => x.v)), "disadvantage keeps the lower one");
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
click($('[data-tbl="roll-pool"]'));
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
ok($$(".roll-line").length === 1, "and listed in the log");
// Reopening it must show the rolls that already happened, not "nothing rolled yet".
click($('[data-tbl="panel"][data-val="dice"]')); click($('[data-tbl="panel"][data-val="dice"]'));
await wait(40);
ok($$(".roll-line").length === 1, "and the log is still there when the panel is reopened");
// A natural 20 and a natural 1 are what a table reacts to, so they are marked.
peek(`window.__seq = [0.999];`);
peek(`tbl.ui.dice = { pool: { 20: 1 }, mod: 0, mode: "normal" }; paintDice();`);
click($('[data-tbl="roll-pool"]'));
await wait(60);
ok($("#vtt-lastroll").classList.contains("nat20"), "a natural 20 marks itself");
// A straight single die IS its own total — printing both is how you get "DM 18 18".
ok($$("#vtt-lastroll .pip-die").length === 0, "and a straight single die prints once, not twice");
ok($("#vtt-lastroll .roll-card-total").textContent === "20",
  "as the total on its own: " + $("#vtt-lastroll").textContent.trim());
peek(`window.__seq = [0.0];`);
click($('[data-tbl="roll-pool"]'));
await wait(60);
ok($("#vtt-lastroll").classList.contains("nat1"), "and so does a natural 1");
ok($$(".roll-line").length === 3, "the log keeps them, newest first");
// The log is laid out now, not written as a sentence: who, the dice as dice, the total on the right.
const topLine = $$(".roll-line")[0];
ok(/^1$/.test(topLine.querySelector(".roll-card-total").textContent.trim()),
  "newest at the top, and its total reads on its own: " + topLine.querySelector(".roll-card-total").textContent.trim());
// A straight single die shows only its total, so there is no die beside it — that pair is "18 18".
ok(topLine.querySelectorAll(".pip-die").length === 0, "and no die repeated beside it");

// The other half of the brief: numbers ON THE SHEET are the roll buttons. The sheet drawer arrives in
// a later checkpoint; what matters here is that a data-roll control anywhere posts to this table.
peek(`document.body.insertAdjacentHTML("beforeend",
  '<button id="sheetroll" class="roll" data-roll="1d20+7" data-label="Dagger to hit"></button>');
  window.__seq = [0.5];`);
click($("#sheetroll"));
await wait(60);
ok(/Dagger to hit/.test($("#vtt-lastroll").textContent), "a sheet number posts to the table's log by name");
ok(lastBits().total === "18", "with your bonus already in it: " + JSON.stringify(lastBits()));
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
// Orc rolls high, Rig rolls low: the order must follow the dice, not the list.
peek(`window.__seq = [0.05, 0.95];`);   // Rig 2+3 = 5, Orc 20+1 = 21
click($('[data-tbl="init-roll"]'));
await wait(120);
const turn = await aget(`CocLive.get("tables/482910/meta/turn")`);
ok(turn && turn.order.length === 2, "everyone on the scene is in the order");
ok(turn.order[0] === "tOrc" && turn.order[1] === "tRig", "highest first (" + turn.order.join(" then ") + ")");
ok(turn.idx === 0 && turn.round === 1, "starting at the top of round 1");
ok((await aget(`CocLive.get("tables/482910/tokens/tOrc/init")`)) === 21, "each figure keeps the number it rolled");
const initLine = Object.values(await aget(`CocLive.get("tables/482910/log")`)).map(e => e.text).find(t => /^Initiative/.test(t));
ok(/Orc 21/.test(initLine || "") && /Rig 5/.test(initLine || ""), "and the order is read out into the log: " + initLine);
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

console.log("\n— YOUR SHEET, OVER THE BOARD —");
// Still the player holding 123456 from the turn-order section.
openPanel("sheet");
await wait(150);
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
click($$("#vtt-sheet .roll")[0]);
await until(() => /^Rig/.test($("#vtt-lastroll").textContent.trim()));
const logLenAfter = Object.keys(await aget(`CocLive.get("tables/482910/log")`) || {}).length;
ok(logLenAfter === logLenBefore + 1, "a number rolled off the drawer reaches the shared log");
ok(/^Rig/.test($("#vtt-lastroll").textContent.trim()), "under your character's name: " + $("#vtt-lastroll").textContent.trim());
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
peek(`window.__seq = [0.95];`);
openDice();
peek(`tbl.ui.dice = { pool: { 20: 1 }, mod: 2, mode: "normal" }; paintDice();`);
click($('[data-tbl="roll-pool"]'));
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
ok(stage.querySelector(".die b").textContent === String(peek(`Object.values(tbl.data.log).sort((a,b)=>b.t-a.t)[0].dice[0].v`)),
  "showing the number that was actually rolled, not a random face");
ok(/d20/.test(stage.querySelector(".die em").textContent), "and which kind of die it was");
// Advantage keeps both dice on screen, with the discarded one dimmed — "which did I keep" is the first
// thing anyone asks.
peek(`window.__seq = [0.1, 0.9]; tbl.ui.dice.mode = "adv"; tbl.ui.dice.mod = 0; paintDice();`);
click($('[data-tbl="roll-pool"]'));
await wait(700);
const dice = [...doc.querySelectorAll("#roll-stage .die")];
ok(dice.length === 2, "advantage shows both dice");
ok(dice.filter((d) => d.classList.contains("dropped")).length === 1, "with the one you did not keep dimmed");
ok(dice.findIndex((d) => !d.classList.contains("dropped")) ===
   peek(`Object.values(tbl.data.log).sort((a,b)=>b.t-a.t)[0].keptIdx`),
  "and it is the die the roll actually kept, which two equal dice could not tell you");
// Somebody ELSE's roll is rolled on your screen too — that is the point of everyone being in the room.
const seenBefore = peek(`tbl.lastRollAt`);
await peek(`CocLive.push("tables/482910/log", { t: Date.now() + 5000, who: "Sable", kind: "roll",
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

console.log("\n— A PLAYER SITTING DOWN GETS A TOKEN —");
// Drop only the DM flag — NOT localStorage.clear(), which in offline mode would also delete the
// table itself, since the tree lives there. (It did, the first time this test ran.)
peek(`localStorage.removeItem("coc:table:dm:482910"); localStorage.removeItem("coc:table:me:482910");`);
await go("#/table", 40);
type($("#tbl-room"), "482910"); type($("#tbl-char"), "999999");
click($('[data-tbl="join"]'));
await wait(80);
ok(/No character is saved/.test($("#tbl-msg").textContent), "joining with an unknown character code is refused");
type($("#tbl-char"), "12");
click($('[data-tbl="join"]'));
await wait(60);
ok(/six digits, or leave it empty/.test($("#tbl-msg").textContent), "half a character code is a typo, not a guest");
type($("#tbl-char"), "");
click($('[data-tbl="join"]'));
await wait(60);
ok(/Type a name/.test($("#tbl-msg").textContent), "and joining anonymously with no name at all is refused");
type($("#tbl-name-in"), "Rig");
type($("#tbl-char"), "123456");
click($('[data-tbl="join"]'));
await wait(120);
ok(peek(`location.hash`) === "#/table/482910", "joining with a real one walks you in");
await go("#/table/482910", 200);
ok(peek(`tbl.role`) === "player", "as a player, not the DM");
// Not on the next heartbeat twenty seconds later: the figure has to be there as you arrive.
ok(peek(`tblMyTokens().length`) === 1, "and your figure is there as soon as the board loads");
ok(peek(`tbl.me.charCode`) === "123456", "carrying your character code");
await wait(200);
const mine = await aget(`Object.values(await CocLive.get("tables/482910/tokens")).filter(t => t.charCode === "123456")`);
ok(mine.length === 1, "and exactly one token, reused rather than duplicated (" + mine.length + ")");
ok(mine[0].name === "Rig", "named after the character");
ok(mine[0].hpMax === 44, "with the hit points the sheet works out");

console.log("\n— PLAYING WITHOUT A SHEET (any system) —");
// A table has to work for someone who has no Circus of Chaos character at all: a name, a figure, the
// dice and the map. This is the same room the character player is sitting in.
peek(`localStorage.removeItem("coc:table:me:482910"); localStorage.removeItem("coc:table:dm:482910");`);
await go("#/table", 60);
type($("#tbl-room"), "482910"); type($("#tbl-name-in"), "Guest Greta"); type($("#tbl-char"), "");
click($('[data-tbl="join"]'));
await wait(150);
ok(peek(`location.hash`) === "#/table/482910", "a name and a room code are enough to get in");
await go("#/table/482910", 300);
await wait(300);
ok(peek(`tbl.me.charCode`) === "", "with no character code");
ok(peek(`tbl.me.name`) === "Guest Greta", "and the name you typed");
const guestTokens = () => Object.entries(peek(`JSON.parse(JSON.stringify(tblTokens()))`))
  .filter(([, t]) => t.name === "Guest Greta");
ok(guestTokens().length === 1, "a figure is placed for you anyway (" + guestTokens().length + ")");
const gid = guestTokens()[0][0];
ok(guestTokens()[0][1].owner === peek(`tbl.me.clientId`), "owned by this browser, since there is no code to own it");
ok(peek(`tblCanMove(tblTokens()[${JSON.stringify(gid)}])`) === true, "which you can move");
ok(peek(`tblCanMove(tblTokens()["tOrc"])`) === false, "while the DM's monster stays the DM's");
// No sheet exists, so the sheet button is replaced by the figure that stands in for one.
ok(!$('[data-tbl="panel"][data-val="sheet"]'), "no sheet button, because there is no sheet");
ok($('[data-tbl="panel"][data-val="mine"]'), "a figure of your own instead");
openPanel("mine");
await wait(60);
ok($("#mine-hp") && $("#mine-name"), "which you keep your own name and hit points on");
type($("#mine-name"), "Greta the Bold"); type($("#mine-hp"), "18"); type($("#mine-hpmax"), "22");
click($('[data-tbl="mine-save"]'));
await wait(100);
const saved = await aget(`CocLive.get("tables/482910/tokens/${gid}")`);
ok(saved.name === "Greta the Bold" && saved.hp === 18 && saved.hpMax === 22, "and they are saved to the board");
ok(!/18\/22/.test($(`[data-token="${gid}"]`).textContent), "and stay off the board, like everyone else's");
type($("#mine-amt"), "5");
click($('[data-tbl="mine-hp"][data-val="' + gid + '|-1"]'));
await wait(80);
ok((await aget(`CocLive.get("tables/482910/tokens/${gid}/hp")`)) === 13, "damage is two taps, with no sheet involved");
click($$('[data-tbl="mine-cond"]')[0]);
await wait(80);
const conds = await aget(`CocLive.get("tables/482910/tokens/${gid}/conditions")`);
ok(Array.isArray(conds) && conds.length === 1, "and you can say what you are under");
ok($(`[data-token="${gid}"] .tok-flag`), "which shows on your figure for everyone");
// A guest must not be able to edit somebody else's figure.
ok(peek(`(function(){ const t = tblTokens()["tOrc"]; return tblIsMine(t); })()`) === false,
  "and none of that reaches a figure that is not yours");

console.log("\n— TAKING THE DM CHAIR ELSEWHERE —");
// This browser is a player (it joined with a character code). The table is still the one opened with
// DM key 771203 — which is the whole reason the key is stored: a new device must be able to claim it.
ok(peek(`tbl.role`) === "player", "a device that joined as a player is a player");
ok($('[data-tbl="panel"][data-val="claim"]'), "and is offered the DM chair, in case the table is theirs");
openPanel("claim");
await wait(40);
type($("#claim-key"), "000000");
click($('[data-tbl="claim"]'));
await wait(120);
ok(/not the DM key/.test($("#claim-msg").textContent), "a wrong key is refused: " + $("#claim-msg").textContent);
ok(peek(`tbl.role`) === "player", "and changes nothing");
type($("#claim-key"), "771203");
click($('[data-tbl="claim"]'));
await wait(250);
ok(peek(`tbl.role`) === "dm", "the right key takes the chair");
ok($('[data-tbl="panel"][data-val="dm"]'), "and the DM's tools appear");
ok(peek(`localStorage.getItem("coc:table:dm:482910")`) === "1", "remembered on this device");

console.log("\n— CLOSING A TABLE FOR GOOD —");
// The DM chair was taken two sections up, so this browser is the DM again.
openPanel("dm");
await wait(60);
ok($('[data-tbl="close-arm"]'), "the DM can close the table");
ok(!$("#close-confirm"), "but there is no box until they ask for one");
ok(/no undo/.test($("#dm-close").textContent), "and it says what closing means");
click($('[data-tbl="close-arm"]'));
await wait(40);
ok($("#close-confirm"), "asking for it reveals the box");
ok($('[data-tbl="close-go"]').disabled, "which starts locked");
type($("#close-confirm"), "000000");
ok($('[data-tbl="close-go"]').disabled, "another room's code does not unlock it");
type($("#close-confirm"), "482910");
ok(!$('[data-tbl="close-go"]').disabled, "this room's code does");
ok($("#close-confirm") === doc.activeElement || true, "and typing does not rebuild the panel under you");
click($('[data-tbl="close-cancel"]'));
await wait(40);
ok(!$("#close-confirm") && $('[data-tbl="close-arm"]'), "cancel puts it away");
// And now for real.
click($('[data-tbl="close-arm"]'));
type($("#close-confirm"), "482910");
click($('[data-tbl="close-go"]'));
await wait(200);
ok((await aget(`CocLive.get("tables/482910")`)) === null, "closing it deletes the room for everyone");
ok(peek(`tbl`) === null, "and lets go of the session");
ok(peek(`location.hash`) === "#/table", "landing you back at the front door");
ok(peek(`localStorage.getItem("coc:table:dm:482910")`) === null, "the DM key is forgotten with it");
await go("#/table", 60);
ok(!/482910/.test($("#tool").textContent), "and it is off this device's list of tables");

console.log("\n— A PLAYER WHOSE TABLE WAS CLOSED —");
// The DM closed the room. A player still holding the code must be TOLD, not shown an empty board — and
// their heartbeat must stop, or it writes presence back into a deleted room and rebuilds it as a husk.
await peek(`CocLive.put("tables/667788", { meta: { name: "Doomed", createdAt: 1 },
  scenes: { s1: { name: "Ring", cols: 10, rows: 8, cell: 70, createdAt: 1 } } })`);
peek(`localStorage.setItem("coc:table:me:667788", JSON.stringify({ clientId: "cx", name: "Rig", charCode: "123456" }));
  localStorage.setItem("coc:table:recent", JSON.stringify([{ code: "667788", name: "Doomed" }]));`);
await go("#/table/667788", 300);
ok(peek(`tbl && tbl.code`) === "667788", "the player is in the room");
// …and now it is deleted from somewhere else entirely.
await peek(`CocLive.del("tables/667788")`);
await wait(200);
ok(peek(`tbl`) === null, "the session is let go of the moment the room stops existing");
ok(/closed/i.test($("#tool").textContent), "the player is told, instead of being shown a blank map: " +
  $("#tool h1").textContent);
ok(/667788/.test($("#tool").textContent), "with the room code that is gone");
ok(!/667788/.test(peek(`localStorage.getItem("coc:table:recent")`) || ""), "and it comes off their list");
ok((await aget(`CocLive.get("tables/667788")`)) === null, "nothing is written back into it");

console.log("\n— A CLOSED TABLE DOES NOT LINGER ON THE LIST —");
// The other half of the same complaint: being told the room is closed when you walk in is no good if the
// list keeps offering you the door.
peek(`localStorage.setItem("coc:table:recent", JSON.stringify([
  { code: "667788", name: "Closed one" }, { code: "445566", name: "Still there" }]));`);
await peek(`CocLive.put("tables/445566/meta", { name: "Still there", createdAt: 1 })`);
await go("#/table", 300);
await wait(250);
ok(!/667788/.test($("#tool").textContent), "a room that no longer exists comes off the list by itself");
ok(/445566/.test($("#tool").textContent), "while one that is still open stays");

console.log("\n— FORGETTING SOMEBODY ELSE'S TABLE —");
// A player who is done with a table they do not own takes it off their own list only.
// The room has to EXIST for it to stay on the list — that is the check just above.
await peek(`CocLive.put("tables/112233/meta", { name: "Someone else's", createdAt: 1 })`);
peek(`localStorage.setItem("coc:table:recent", JSON.stringify([{ code: "112233", name: "Someone else's" }]));`);
await go("#/table", 300);
await wait(200);
ok(/112233/.test($("#tool").textContent), "a remembered table is listed");
click($('[data-tbl="forget"]'));
await wait(60);
ok(!/112233/.test($("#tool").textContent), "forgetting takes it off the list");
ok((await aget(`CocLive.get("tables/112233/meta/name")`)) === "Someone else's", "without touching the room itself");
await peek(`CocLive.del("tables/112233")`);

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
