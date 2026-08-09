// REAL 3D DICE, in a real browser, on real physics. Run: npm run test:dice
//
// NOT part of scripts/check.sh, on purpose, and for the same two reasons as the two-device test: it needs
// the NETWORK (the physics library and its textures come from a CDN on first use) and it needs a GPU —
// jsdom has no canvas at all and the gate's headless browsers have no hardware, so this one asks Chromium
// for software WebGL explicitly.
//
// What it is really guarding is one sentence: THE DICE ON SCREEN MUST BE THE ROLL IN THE LOG. The roll is
// made by the app, written to a shared log and rendered on every device, so the dice are told what to land
// on — and this reads the faces off the dice afterwards and holds them against the log. The three awkward
// cases each have their own throw here, because each of them was wrong at some point:
//   - a d4 is turned correctly and then REPORTED wrong by the library, so the check reads the geometry;
//   - a d100 has no hundred-sided die behind it at all, and is thrown as a real percentile pair;
//   - thirty dice at once is the top of the range the panel allows.
import puppeteer from "puppeteer";
import { spawn } from "child_process";
import path from "path";

const REPO = path.resolve(new URL(".", import.meta.url).pathname, "../..");
const PORT = 8791;
let fails = 0;
const ok = (c, m) => { if (!c) { fails++; console.log("  FAIL " + m); } else console.log("  ok   " + m); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
/* Polled rather than slept through: building the world takes a few seconds and rather longer on a machine
   with no GPU, and a fixed sleep here is a test that fails on somebody else's laptop. */
async function ready(within) {
  const until = Date.now() + within;
  while (Date.now() < until) {
    if (await page.evaluate(() => !!dice3dBox)) return true;
    await wait(500);
  }
  return false;
}

const server = spawn("python3", [path.join(REPO, "scripts/serve.py"), String(PORT)],
  { cwd: REPO, stdio: "ignore" });
const stop = () => { try { server.kill(); } catch { /* already */ } };
process.on("exit", stop);
await wait(1200);

// Software WebGL: there is no GPU here. A real phone brings its own; this is only how the test gets to
// see what a phone would see.
const browser = await puppeteer.launch({ args: ["--no-sandbox", "--enable-unsafe-swiftshader"] });
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 860 });
const errs = [];
page.on("pageerror", (e) => errs.push(e.message));
page.on("console", (m) => {
  const from = (m.location() || {}).url || "";
  if (m.type() === "error" && !/favicon\.ico$/.test(from)) errs.push(m.text());
});
await page.goto(`http://localhost:${PORT}/index.html`, { waitUntil: "networkidle0" });
await page.evaluate(() => { CocLive.setMode("local"); localStorage.clear(); location.hash = "#/table"; });
await wait(700);
await page.evaluate(() => {
  document.querySelector("#tbl-name").value = "Dice";
  document.querySelector("#tbl-newroom").value = "424242";
  document.querySelector("#tbl-dmkey").value = "987654";
  document.querySelector('[data-tbl="create"]').click();
});
await wait(1600);

console.log("\n— the library arrives —");
// The first roll of a session is deliberately flat: it starts the fetch and does not wait for it, because
// no roll should ever wait on a network.
await page.evaluate(() => document.querySelector('[data-tbl="roll-pool"]').click());
ok(await ready(25000), "fetched on the first roll, without that roll waiting for it");

/* One throw, watched from the moment the button is pressed to a couple of seconds after it lands. */
async function thrown(pool, label) {
  await page.evaluate((p) => { tblDicePool().pool = p; tblDicePool().mode = "normal"; paintDice(); }, pool);
  await wait(300);
  await page.evaluate(() => document.querySelector('[data-tbl="roll-pool"]').click());
  await wait(900);
  const air = await page.evaluate(() => ({
    held: document.querySelector("#roll-stage").classList.contains("waiting"),
    bar: (document.querySelector("#vtt-lastroll") || {}).textContent || "",
  }));
  await wait(8000);
  const done = await page.evaluate(() => ({
    solid: document.querySelector("#roll-stage").classList.contains("with-3d"),
    held: document.querySelector("#roll-stage").classList.contains("waiting"),
    bar: (document.querySelector("#vtt-lastroll") || {}).textContent || "",
    faces: (typeof dice3dLanded !== "undefined" ? dice3dLanded : []).slice(),
    rolled: (() => {
      const log = Object.values(tbl.data.log || {}).sort((a, b) => (a.t || 0) - (b.t || 0));
      const last = log[log.length - 1] || {};
      return { dice: (last.dice || []).map((d) => Number(d.v)), total: last.total };
    })(),
  }));
  console.log(`\n— ${label} —`);
  ok(air.held && /rolling/.test(air.bar), "the number is held back while they are in the air");
  ok(done.solid, "they landed on what was rolled, so the real dice stayed");
  ok(!done.held && !/rolling/.test(done.bar),
    "and it arrives when they stop: " + done.bar.trim().replace(/\s+/g, " "));
  return done;
}

const four = await thrown({ 4: 3 }, "three d4 — the die the library reports wrongly");
ok(four.faces.length === 3 && four.faces.join(",") === four.rolled.dice.join(","),
  `every face is the roll (dice ${four.faces.join(",")} = log ${four.rolled.dice.join(",")})`);

const hundred = await thrown({ 100: 1 }, "a percentile roll — two dice, not one");
ok(hundred.faces.length === 2, `thrown as a tens die and a units die (${hundred.faces.join(", ")})`);
{
  const [tens, units] = hundred.faces;
  const reads = (tens === 100 ? 0 : tens) + (units === 10 ? 0 : units);
  const rolled = hundred.rolled.dice[0];
  ok(reads === rolled % 100 || (reads === 0 && rolled === 100),
    `and they read ${String(tens === 100 ? 0 : tens).padStart(2, "0")}|${units === 10 ? 0 : units} for a roll of ${rolled}`);
}

const many = await thrown({ 6: 30 }, "thirty at once — the top of the range");
ok(many.faces.length === 30 && many.faces.join(",") === many.rolled.dice.join(","),
  "all thirty landed on the roll they were given");

console.log("\n— your own dice —");
await page.evaluate(() => document.querySelector('[data-tbl="dice-design"][data-val="dragon"]').click());
await wait(400);
await page.evaluate(() => document.querySelector('[data-tbl="dice-colour"][data-val="#d94f43"]').click());
await wait(400);
ok(await page.evaluate(() => dice3dLook().design === "dragon" && dice3dLook().colour === "#d94f43"),
  "a design and a colour are remembered on this device");
// Rebuilding while the last throw is still settling is exactly what used to leave a table with no dice at
// all — so it starts the moment the colour is chosen, rather than making the next roll wait for it.
ok(await ready(25000), "and the dice world is rebuilt for them, without being rolled first");
const dragon = await thrown({ 20: 4 }, "four dragon-scaled d20");
ok(dragon.faces.join(",") === dragon.rolled.dice.join(","), "still landing on the truth after the rebuild");

ok(errs.length === 0, "no page errors" + (errs.length ? ": " + errs.slice(0, 3).join(" | ") : ""));

await browser.close();
stop();
console.log(fails ? `\nFAILURES: ${fails}` : "\nThe dice are the roll.");
process.exit(fails ? 1 : 0);
