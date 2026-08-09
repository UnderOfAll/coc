// TWO REAL DEVICES against the LIVE site and the LIVE DATABASE. Run: npm run test:2dev
//
// NOT part of scripts/check.sh, on purpose: it needs the network, it needs the site to be deployed,
// and it writes to the real Firebase project (a throwaway room and character, both deleted at the
// end). Run it after a push when the live half matters.
//
// It exists because it found something no local test could: seven EventSource streams took every
// connection a browser will open to one host over HTTP/1.1, so a player joined and their token and
// presence writes hung forever with nothing on screen to say so. Local mode has no connection limit,
// which is exactly why it could not see it.
//
// It runs against EITHER cloud transport, so the swap can be proved rather than argued about:
//   npm run test:2dev            however the deployed site is configured
//   npm run test:2dev:sdk        the same session, same database, through Firebase's own library
//   npm run test:2dev:rest       the same again over the hand-rolled REST layer
// Every assertion below reads the REAL database over REST whatever the browsers are using, so a pass
// means the data genuinely arrived and not merely that the page believes it did.
import puppeteer from "puppeteer";
const TRANSPORT = ["sdk", "rest"].includes(process.env.TRANSPORT || "") ? process.env.TRANSPORT : "";
const SITE = "https://underofall.github.io/coc/index.html" + (TRANSPORT ? "?transport=" + TRANSPORT : "");
const DB = "https://circus-of-chaos-78122-default-rtdb.europe-west1.firebasedatabase.app";
const ROOM = "999123", CHAR = "999321", DMKEY = "987654";
let fails = 0;
const ok = (c, m) => { if (!c) { fails++; console.log("  FAIL " + m); } else console.log("  ok   " + m); };
const db = async (path, method, body) => {
  const res = await fetch(`${DB}/${path}.json`, method === "GET" ? {} :
    { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return res.json().catch(() => null);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// A real character for the player to join with.
await db(`characters/${CHAR}`, "PUT", {
  v: 1, name: "Live Test", classId: "joker", subclassId: "", level: 3, size: "Medium", method: "array",
  scores: { Strength: 10, Dexterity: 14, Constitution: 12, Intelligence: 10, Wisdom: 10, Charisma: 15 },
  origin: { Charisma: 2, Dexterity: 1 }, skills: [], armorId: "", shieldId: "", weapons: [], photo: "", notes: "",
});
await db(`tables/${ROOM}`, "DELETE");

const browser = await puppeteer.launch({ args: ["--no-sandbox"] });
const open = async (label, w, h) => {
  const ctx = await browser.createBrowserContext();       // its own localStorage: a separate DEVICE
  const page = await ctx.newPage();
  await page.setViewport({ width: w, height: h, hasTouch: w < 700, isMobile: w < 700 });
  const errs = [];
  page.on("pageerror", (e) => errs.push(label + ": " + e.message));
  await page.goto(SITE, { waitUntil: "networkidle0" });
  return { ctx, page, errs };
};

console.log("\n— the DM opens a table on the live site —");
const dm = await open("dm", 1280, 900);
ok(await dm.page.evaluate(() => CocLive.isCloud), "the deployed site is in cloud mode, not offline");
// With nothing asked for, whatever the deployed config.js says is the answer — that is the point of
// running it that way: it tests what the players will actually get.
const wanted = TRANSPORT || await dm.page.evaluate(() => CocLive.transport);
ok(await dm.page.evaluate((t) => CocLive.transport === t, wanted),
  `over the ${wanted} transport${TRANSPORT ? "" : ", which is what the site is set to"}`);
await dm.page.evaluate(() => { location.hash = "#/table"; });
await wait(600);
await dm.page.evaluate((r, k) => {
  document.querySelector("#tbl-name").value = "Live check";
  document.querySelector("#tbl-newroom").value = r;
  document.querySelector("#tbl-dmkey").value = k;
  document.querySelector('[data-tbl="create"]').click();
}, ROOM, DMKEY);
await wait(2500);
const meta = await db(`tables/${ROOM}/meta`, "GET");
ok(meta && meta.name === "Live check", "the table is in the real database");
ok(meta && /^sha256:/.test(meta.dmHash || ""), "with the DM key hashed by WebCrypto over https (" + (meta && String(meta.dmHash).slice(0, 12)) + "…)");
ok(await dm.page.evaluate(() => !!document.querySelector(".vtt-stage")), "and the DM is looking at the board");

console.log("\n— a second device joins as a player —");
const pl = await open("player", 393, 850);
await pl.page.evaluate(() => { location.hash = "#/table"; });
await wait(600);
// Joining is the room code and nothing else now; WHO you are is chosen inside.
await pl.page.evaluate((r) => {
  document.querySelector("#tbl-room").value = r;
  document.querySelector('[data-tbl="join"]').click();
}, ROOM);
await wait(2500);
// The room asks who they are playing. Nobody is on the board yet, so they add themselves — with a Circus of
// Chaos code, which is what pulls the real sheet across.
const asked = await pl.page.evaluate(() => !!document.querySelector("#seat-name"));
ok(asked, "the room asks who they are playing");
await pl.page.evaluate((c) => {
  document.querySelector("#seat-code").value = c;
  document.querySelector('[data-tbl="seat-new"]').click();
}, CHAR);
await wait(3500);
ok(await pl.page.evaluate(() => !!(typeof tbl !== "undefined" && tbl && tbl.role === "player")), "the phone is in as a player");
if (pl.errs.length) console.log("       [player errors] " + pl.errs.join(" | "));
const tokens = await db(`tables/${ROOM}/tokens`, "GET");
const mine = Object.entries(tokens || {}).find(([, t]) => t.charCode === CHAR);
ok(!!mine, "their figure is on the board in the database");
ok(mine && mine[1].name === "Live Test", "named from the character the code opened");
// The whole point: the DM's screen learns about it without being told.
const seenByDm = await dm.page.evaluate((id) => !!document.querySelector(`[data-token="${id}"]`), mine ? mine[0] : "x");
ok(seenByDm, "and it appeared on the DM's screen, pushed not polled");
const whoOnDm = await dm.page.evaluate(() => document.querySelector("#vtt-who").textContent);
ok(/Live Test/.test(whoOnDm), "who is at the table reached the DM too (" + whoOnDm.trim() + ")");

console.log("\n— the phone moves its figure; the DM watches —");
await pl.page.evaluate(() => { tbl.cameraIsYours = true; tbl.view.x = 0; tbl.view.y = 0; tbl.view.z = 1; applyView(); });
await wait(200);
const box = await pl.page.evaluate((id) => {
  const b = document.querySelector(`[data-token="${id}"]`).getBoundingClientRect();
  return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
}, mine[0]);
await pl.page.touchscreen.touchStart(box.x, box.y);
for (let i = 1; i <= 5; i++) { await pl.page.touchscreen.touchMove(box.x + 70 * i * 0.6, box.y); await wait(20); }
await pl.page.touchscreen.touchEnd();
await wait(2500);
const moved = await db(`tables/${ROOM}/tokens/${mine[0]}`, "GET");
ok(moved.x === mine[1].x + 3, `the move reached the database (${mine[1].x} -> ${moved.x})`);
const dmSees = await dm.page.evaluate((id) => document.querySelector(`[data-token="${id}"]`).style.left, mine[0]);
ok(dmSees === (moved.x * 70) + "px", "and the DM's board moved with it (" + dmSees + ")");

console.log("\n— the DM drops a monster; the phone sees it —");
await dm.page.evaluate(() => {
  document.querySelector('[data-tbl="panel"][data-val="dm"]').click();
});
await wait(400);
await dm.page.evaluate(() => {
  document.querySelector("#tbl-npc-name").value = "Live Goblin";
  document.querySelector("#tbl-npc-hp").value = "7";
  document.querySelector('[data-tbl="spawn"]').click();
});
await wait(2500);
const onPhone = await pl.page.evaluate(() => [...document.querySelectorAll(".tok-name")].map((n) => n.textContent));
ok(onPhone.some((n) => /Live Goblin/.test(n)), "the monster arrived on the phone (" + onPhone.join(", ") + ")");

console.log("\n— a roll on the phone, read on the DM's screen —");
await pl.page.evaluate(() => {
  document.querySelector('[data-tbl="panel"][data-val="sheet"]').click();
});
await wait(2500);
const rolled = await pl.page.evaluate(() => {
  const b = document.querySelector("#vtt-sheet .roll");
  if (!b) return null;
  b.click();
  return b.dataset.label || b.dataset.roll;
});
ok(rolled, "a number on the sheet in the drawer is a button (" + rolled + ")");
await wait(2500);
const dmLog = await dm.page.evaluate(() => document.querySelector("#vtt-lastroll").textContent);
// The bar lays the roll out (who / dice / total) rather than writing a sentence, so this asserts the parts.
ok(/^Live Test/.test(dmLog.trim()) && /\d/.test(dmLog), "and the DM read the result: " + dmLog.trim().replace(/\s+/g, " "));

console.log("\n— the DM rubs out part of a line; it stays rubbed out —");
// This one is here for the SDK specifically. The eraser cuts a line into two and holds the result on
// screen "until the stored data agrees with it" — and the library raises an event for your OWN write
// the instant you make it, before the database has confirmed anything, which is a different moment than
// the REST streams ever gave. So: draw across the board, rub the middle out, and check that both the
// database and the OTHER device end up with two pieces — and that the whole line does not come back a
// few seconds later, which is exactly how this failed once before.
await dm.page.evaluate(() => {
  CocLive.push("tables/" + tbl.code + "/draw", {
    by: tblNoteOwner(), scene: tblSceneId(), color: "#ffffff", width: 3, kind: "free", at: Date.now(),
    pts: Array.from({ length: 41 }, (_, i) => (0.05 + i * 0.022).toFixed(4) + ",0.3000").join(" "),
  });
});
await wait(2500);
const drawn = await db(`tables/${ROOM}/draw`, "GET");
const strokeId = Object.keys(drawn || {})[0];
ok(!!strokeId, "the line is in the database");
ok(await pl.page.evaluate(() => document.querySelectorAll("#vtt-ink path, #vtt-ink polyline").length > 0),
  "and the phone is showing it");
// Rub through the middle of it, with a real mouse, on the board as it is actually laid out. The panel
// is opened FIRST and the layer measured after, because opening it resizes the board.
await dm.page.evaluate(() => document.querySelector('[data-tbl="panel"][data-val="draw"]').click());
await wait(600);
const ink = await dm.page.evaluate(() => {
  document.querySelector('[data-tbl="ink-erase"]').click();
  // Fitted, so the WHOLE board is on screen and a normalised point is a screen point. Measured after
  // fitting and after the panel opened, both of which move it: at 1:1 the board is four times the width
  // of the stage, and the first version of this rubbed past the right-hand edge and called the eraser
  // broken.
  tbl.cameraIsYours = false; tbl.view.fitted = false; tblFit(); applyView();
  const b = document.querySelector("#vtt-ink").getBoundingClientRect();
  const s = document.querySelector("#vtt-stage").getBoundingClientRect();
  return { x: b.left, y: b.top, w: b.width, h: b.height, on: tblInkState().on, mode: tblInkState().mode,
           right: s.right, bottom: s.bottom };
});
ok(ink.on && ink.mode === "erase", "the eraser is out");
const atInk = (nx, ny) => ({ x: ink.x + nx * ink.w, y: ink.y + ny * ink.h });
// Somewhere in the MIDDLE of the line, not near either end: rubbing the first inch of it leaves a stub too
// short to be a stroke, and that is one piece rather than two.
const cutFrom = 0.42, cutTo = 0.52;
ok(atInk(cutTo, 0.3).x < ink.right && atInk(cutTo, 0.3).y < ink.bottom,
  "and the stretch being rubbed is on screen");
const from = atInk(cutFrom, 0.3), to = atInk(cutTo, 0.3);
await dm.page.mouse.move(from.x, from.y);
await dm.page.mouse.down();
for (let i = 1; i <= 12; i++) {
  await dm.page.mouse.move(from.x + ((to.x - from.x) / 12) * i, from.y);
  await wait(20);
}
await dm.page.mouse.up();
await wait(3000);
const cut = await db(`tables/${ROOM}/draw`, "GET");
ok(!(cut || {})[strokeId], "the whole line is gone from the database");
ok(Object.keys(cut || {}).length === 2, `and left two pieces where it was cut (${Object.keys(cut || {}).length})`);
ok(await pl.page.evaluate(() => document.querySelectorAll("#vtt-ink path, #vtt-ink polyline").length === 2),
  "the phone shows the gap too, pushed to it");
ok(await dm.page.evaluate(() => !tbl.inkPending), "and the DM's board has let go of its own overlay");
// The failure this is really watching for: the rub retiring on a local echo, and the stored line
// reappearing once the database has its say.
await wait(4000);
const still = await db(`tables/${ROOM}/draw`, "GET");
ok(!(still || {})[strokeId] && Object.keys(still || {}).length === 2, "and four seconds later it has not come back");
await dm.page.evaluate(() => document.querySelector('[data-tbl="ink-off"]').click());

// A silent fall back to REST must not pass as a run of the library: everything above would still be
// green, and the swap would be "proved" by the transport it was meant to replace.
const running = await Promise.all([dm.page.evaluate(() => CocLive.transportState),
                                   pl.page.evaluate(() => CocLive.transportState)]);
ok(running.every((s) => s === wanted), `both devices really ran on ${wanted} (${running.join(", ")})`);

ok(dm.errs.length === 0 && pl.errs.length === 0, "no page errors on either device" +
  ([...dm.errs, ...pl.errs].length ? ": " + [...dm.errs, ...pl.errs][0] : ""));

await browser.close();
// Leave the real database as it was found.
await db(`tables/${ROOM}`, "DELETE");
await db(`characters/${CHAR}`, "DELETE");
const left = await db(`tables/${ROOM}`, "GET");
ok(left === null, "test data cleaned out of the live database");
console.log(fails ? `\nFAILURES: ${fails}` : "\nTwo devices, one live table.");
process.exit(fails ? 1 : 0);
