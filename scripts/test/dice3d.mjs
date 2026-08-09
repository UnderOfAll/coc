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
/* The same numbers, in whatever order. Dice on a table have no order — a mixed handful is thrown in
   groups, so the d8 lands before the d6s whatever order the roll listed them in. */
const same = (a, b) => a.length === b.length
  && [...a].sort((x, y) => x - y).join(",") === [...b].sort((x, y) => x - y).join(",");
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
    landed: typeof dice3dLanded !== "undefined" ? dice3dLanded : { t: 0, faces: [] },
    rolled: (() => {
      const log = Object.values(tbl.data.log || {}).sort((a, b) => (a.t || 0) - (b.t || 0));
      const last = log[log.length - 1] || {};
      return { dice: (last.dice || []).map((d) => Number(d.v)), total: last.total, t: last.t };
    })(),
  }));
  console.log(`\n— ${label} —`);
  ok(air.held && /rolling/.test(air.bar), "the number is held back while they are in the air");
  ok(done.solid, "they landed on what was rolled, so the real dice stayed");
  ok(!done.held && !/rolling/.test(done.bar),
    "and it arrives when they stop: " + done.bar.trim().replace(/\s+/g, " "));
  // The faces are only evidence if they belong to THIS roll.
  ok(done.landed.t === done.rolled.t, "and the faces on the table are this roll's, not an earlier one's");
  done.faces = done.landed.faces;
  return done;
}

console.log("\n— the library arrives —");
/* Fetched when the TABLE OPENS, not on the first roll. It used to wait, and the price was that the first
   roll of every session fell back to the flat overlay while the library arrived — which reads, correctly,
   as the 3D dice being broken: you roll, you get the old animation, you roll again and there are real
   dice. So no click here: opening the table above should already have started it. */
ok(await page.evaluate(() => !!dice3dBox || !!dice3dLoading), "starts fetching the moment a table opens");
ok(await ready(25000), "and is ready without anything having been rolled");

// Which means THE FIRST ROLL is a real one.
const first = await thrown({ 20: 1 }, "the very first roll of the session");
ok(same(first.faces, first.rolled.dice), "the first roll of a session is real dice, not the flat overlay");

const four = await thrown({ 4: 3 }, "three d4 — the die the library reports wrongly");
ok(four.faces.length === 3 && same(four.faces, four.rolled.dice),
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
ok(many.faces.length === 30 && same(many.faces, many.rolled.dice),
  "all thirty landed on the roll they were given");

// A handful of DIFFERENT dice, which the library's notation cannot express in one throw: the first group
// is thrown and the rest are added to the table beside it.
const mixed = await thrown({ 8: 1, 6: 2, 4: 1 }, "a smite — a d8, two d6 and a d4, together");
ok(mixed.faces.length === 4 && same(mixed.faces, mixed.rolled.dice),
  `all four kinds landed on the roll (${mixed.faces.join(",")} for ${mixed.rolled.dice.join(",")})`);

console.log("\n— your own dice —");
await page.evaluate(() => document.querySelector('[data-tbl="dice-design"][data-val="dragon"]').click());
await wait(400);
await page.evaluate(() => document.querySelector('[data-tbl="dice-colour"][data-val="#d94f43"]').click());
await wait(400);
ok(await page.evaluate(() => dice3dLook().design === "dragon" && dice3dLook().colour === "#d94f43"),
  "a design and a colour are remembered on this device");
// Restyled in place rather than rebuilt. Building a second world while the first is still animating —
// which is exactly when somebody changes a colour — is what used to leave a table with no dice at all.
ok(await ready(25000), "and the dice take them on without the world being rebuilt around them");
const dragon = await thrown({ 20: 4 }, "four dragon-scaled d20");
ok(same(dragon.faces, dragon.rolled.dice), "still landing on the truth after the rebuild");

ok(errs.length === 0, "no page errors" + (errs.length ? ": " + errs.slice(0, 3).join(" | ") : ""));

await browser.close();
stop();
console.log(fails ? `\nFAILURES: ${fails}` : "\nThe dice are the roll.");
process.exit(fails ? 1 : 0);
