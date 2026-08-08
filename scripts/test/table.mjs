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
ok($("#tbl-room") && $("#tbl-char"), "joining asks for a room code and a character code");
ok($("#tbl-newroom") && $("#tbl-dmkey"), "running a table asks for a room code and a DM key");
ok(/six.digit/i.test($("#tool").textContent), "and says what shape those are");
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
ok(/DM/.test($("#vtt-who").textContent), "and the header lists you");
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
ok(tok.querySelector(".tok-bar"), "and a hit-point bar");
ok(/30\/44/.test(tok.textContent), "the DM sees the numbers on it");
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

console.log("\n— A PLAYER MOVES ONLY THEIR OWN —");
// Same table, but this browser is a player holding character 123456.
peek(`tbl.role = "player"; tbl.me.charCode = "123456"; paintTokens();`);
ok($('[data-token="tRig"]').classList.contains("mine"), "your own figure is marked as yours");
ok($('[data-token="tRig"]').classList.contains("movable"), "and is movable");
ok(!$('[data-token="tOrc"]').classList.contains("movable"), "the DM's monster is not");
ok(!/15\/15/.test($('[data-token="tOrc"]').textContent), "and a player is not shown its hit points");
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

console.log("\n— A PLAYER SITTING DOWN GETS A TOKEN —");
// Drop only the DM flag — NOT localStorage.clear(), which in offline mode would also delete the
// table itself, since the tree lives there. (It did, the first time this test ran.)
peek(`localStorage.removeItem("coc:table:dm:482910"); localStorage.removeItem("coc:table:me:482910");`);
await go("#/table", 40);
type($("#tbl-room"), "482910"); type($("#tbl-char"), "999999");
click($('[data-tbl="join"]'));
await wait(80);
ok(/No character is saved/.test($("#tbl-msg").textContent), "joining with an unknown character code is refused");
type($("#tbl-char"), "123456");
click($('[data-tbl="join"]'));
await wait(120);
ok(peek(`location.hash`) === "#/table/482910", "joining with a real one walks you in");
await go("#/table/482910", 200);
ok(peek(`tbl.role`) === "player", "as a player, not the DM");
ok(peek(`tbl.me.charCode`) === "123456", "carrying your character code");
await wait(200);
const mine = await aget(`Object.values(await CocLive.get("tables/482910/tokens")).filter(t => t.charCode === "123456")`);
ok(mine.length === 1, "and exactly one token, reused rather than duplicated (" + mine.length + ")");
ok(mine[0].name === "Rig", "named after the character");
ok(mine[0].hpMax === 44, "with the hit points the sheet works out");

console.log("\n— LEAVING —");
const room = "482910";
// Whose entry to look for: the fake second device is also a player holding 123456, so the check has
// to be against THIS browser's client id, not against the character.
const myClient = peek(`tbl.me.clientId`);
await go("#/manage", 80);
ok(peek(`tbl`) === null, "walking out closes the session");
const gone = await aget(`CocLive.get("tables/${room}/presence")`);
ok(gone && !gone[myClient], "and takes your name off the list");
ok(gone && Object.keys(gone).length > 0, "while leaving everyone else on it");

console.log("\njsdom errors: " + errs.length); errs.slice(0, 8).forEach((e) => console.log("  " + e));
console.log(fails || errs.length ? "\nFAILURES: " + fails : "\nALL GREEN");
process.exit(fails || errs.length ? 1 : 0);
