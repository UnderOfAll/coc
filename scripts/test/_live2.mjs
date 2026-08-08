// TWO REAL DEVICES against the LIVE site and the LIVE database. Not part of the gate: it needs the
// network and it writes to the real project (cleaned up at the end).
import puppeteer from "puppeteer";
const SITE = "https://underofall.github.io/coc/index.html";
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
await pl.page.evaluate((r, c) => {
  document.querySelector("#tbl-room").value = r;
  document.querySelector("#tbl-char").value = c;
  document.querySelector('[data-tbl="join"]').click();
}, ROOM, CHAR);
await wait(3500);
ok(await pl.page.evaluate(() => !!(typeof tbl !== "undefined" && tbl && tbl.role === "player")), "the phone is in as a player");
console.log("       [diag] player errs: " + JSON.stringify(pl.errs));
console.log("       [diag] player state: " + JSON.stringify(await pl.page.evaluate(() => ({
  hash: location.hash, role: tbl && tbl.role, me: tbl && tbl.me, beat: !!(tbl && tbl.beat),
  err: (document.querySelector("#vtt-error") || {}).textContent,
  msg: (document.querySelector("#tbl-msg") || {}).textContent,
  tokens: tbl && tbl.data.tokens, mode: CocLive.mode,
}))));
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
ok(/Live Test rolled/.test(dmLog), "and the DM read the result: " + dmLog.trim());

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
