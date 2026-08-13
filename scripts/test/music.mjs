// Music in REAL Chromium, with two devices.
//
//   npm run test:music
//
// WHY THIS CANNOT BE A JSDOM TEST. jsdom has no media clock: `currentTime` never advances, `play()` is
// not implemented, and `readyState` is always 0 — so every assertion below would pass on a build where
// nothing plays at all. Both bugs this file was written for were invisible in table.mjs and obvious in
// two seconds here:
//   · a device joining halfway started the track from the beginning, because `currentTime` set in the
//     same breath as `src` is silently ignored — there is nothing to seek in until the metadata lands;
//   · a track that had finished was started again from the top by the drift check, forever.
//
// The tone is generated rather than committed: a fixture nobody can hear is a fixture nobody maintains.
import puppeteer from "puppeteer";
import http from "http";
import path from "path";
import fs from "fs";

const REPO = path.resolve(new URL(".", import.meta.url).pathname, "../..");
const ROOM = "990099";

/* A 90-second sine as a WAV, in memory. Long enough that "where the room is" is a real question. */
function tone(seconds = 90, rate = 8000, hz = 220) {
  const n = seconds * rate;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write("RIFF", 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write("WAVE", 8);
  buf.write("fmt ", 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34); buf.write("data", 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(3000 * Math.sin(2 * Math.PI * hz * i / rate)), 44 + i * 2);
  return buf;
}
const WAV = tone();

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
                ".json": "application/json", ".jpg": "image/jpeg", ".wav": "audio/wav" };
const server = http.createServer((req, res) => {
  const u = decodeURIComponent(req.url.split("?")[0]);
  if (u === "/tone.wav") {
    /* RANGE REQUESTS, because seeking is the whole thing being tested. A browser asked to jump to 0:07
       fetches those bytes with a Range header; a server that answers 200 with the whole file has told it
       "I cannot do that", and the player stays at the beginning — which looked exactly like the app
       failing to sync and was the harness all along. Every real host does this. */
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || "");
    if (range) {
      const start = range[1] ? Number(range[1]) : 0;
      const end = range[2] ? Math.min(Number(range[2]), WAV.length - 1) : WAV.length - 1;
      res.writeHead(206, {
        "Content-Type": "audio/wav", "Accept-Ranges": "bytes",
        "Content-Range": `bytes ${start}-${end}/${WAV.length}`, "Content-Length": end - start + 1,
      });
      return res.end(WAV.subarray(start, end + 1));
    }
    res.writeHead(200, { "Content-Type": "audio/wav", "Accept-Ranges": "bytes", "Content-Length": WAV.length });
    return res.end(WAV);
  }
  const f = path.join(REPO, u);
  if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { "Content-Type": TYPES[path.extname(f)] || "application/octet-stream" });
  fs.createReadStream(f).pipe(res);
});
await new Promise((r) => server.listen(0, r));
const base = `http://localhost:${server.address().port}`;

let fails = 0;
const ok = (c, m) => { if (!c) { fails++; console.log("  FAIL " + m); } else console.log("  ok   " + m); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// `--autoplay-policy` is the ONE thing this test lies about: a real browser needs a gesture, which the
// panel asks for with its own button (covered in table.mjs). Everything else here is the real thing.
const browser = await puppeteer.launch({
  args: ["--no-sandbox", "--autoplay-policy=no-user-gesture-required", "--mute-audio"],
});

async function device(asDm) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  page.on("pageerror", (e) => { fails++; console.log("  FAIL page error: " + e.message); });
  await page.setViewport({ width: 1200, height: 850 });
  await page.goto(base + "/index.html#/table", { waitUntil: "networkidle0" });
  await page.evaluate((r, dm) => {
    localStorage.setItem("coc:tbl:music:ok", "1");
    localStorage.setItem("coc:tbl:music:vol", "0.5");
    localStorage.removeItem("coc:tbl:music:mute");
    if (dm) localStorage.setItem("coc:table:dm:" + r, "1");
  }, ROOM, asDm);
  return page;
}
async function enter(page, asDm) {
  await page.evaluate((r) => { location.hash = "#/table/" + r; dispatchEvent(new HashChangeEvent("hashchange")); }, ROOM);
  await wait(1600);
  await page.evaluate((dm) => { tbl.role = dm ? "dm" : "player"; renderTableShell(); paintEverything(); }, asDm);
  await wait(400);
}
const state = (page) => page.evaluate(() => {
  const a = document.querySelector("#vtt-audio");
  return a ? { src: !!a.src, paused: a.paused, t: +a.currentTime.toFixed(2), vol: +a.volume.toFixed(2),
               ready: a.readyState } : null;
});

console.log("\n— MUSIC IN A REAL BROWSER —");
const dm = await device(true);
await dm.evaluate((r) => CocLive.put("tables/" + r, {
  meta: { name: "Music", createdAt: 1, dmHash: "fnv:none", activeScene: "s1", dmSeat: "cme" },
  scenes: { s1: { name: "Blank", image: "", cols: 12, rows: 8, cell: 70, createdAt: 1 } },
}), ROOM);
await enter(dm, true);

await dm.evaluate((u, r) => CocLive.push(`tables/${r}/music/tracks`,
  { kind: "link", src: u, title: "Tone", at: Date.now() }), base + "/tone.wav", ROOM);
await wait(600);
await dm.evaluate(() => { tbl.ui.panel = "music"; paintSide(); });
await wait(300);
await dm.evaluate(() => document.querySelector('[data-tbl="music-play"]').click());
await wait(2500);

const d1 = await state(dm);
ok(d1 && d1.src && d1.ready >= 2, "the DM's browser really loads the audio");
ok(d1 && d1.paused === false, "and really plays it");
ok(d1 && d1.t > 0.5, `and the clock is running (${d1 && d1.t}s)`);
// The panel is driven by the stream like everything else: Play must have become Pause.
ok(await dm.evaluate(() => !!document.querySelector('[data-tbl="music-pause"]')),
  "and the panel followed it without being reopened");

/* SOMEBODY JOINING HALFWAY COMES IN WHERE THE ROOM IS. This is the whole point of sending a position and
   a timestamp instead of streaming audio, and it is the bug jsdom could not see. */
const pl = await device(false);
await enter(pl, false);
await wait(1800);
const d2 = await state(pl);
ok(d2 && d2.paused === false, "a player who joins halfway is playing too");
const dmAt = (await state(dm)).t;
ok(d2 && Math.abs(d2.t - dmAt) < 2.5, `and lands where the room is (dm ${dmAt}s, player ${d2 && d2.t}s)`);

/* THE VOLUME IS EACH DEVICE'S OWN. A table where the DM's slider moved everybody's is a table where
   nobody can hear their own game. */
await pl.evaluate(() => { tbl.ui.panel = "music"; paintSide(); tblMusicSetVol(0.11); });
await wait(400);
ok((await state(pl)).vol < 0.2, "a player's volume applies to their own audio");
ok((await state(dm)).vol > 0.4, "and does not touch anybody else's");

await dm.evaluate(() => document.querySelector('[data-tbl="music-pause"]').click());
await wait(1200);
ok((await state(dm)).paused === true && (await state(pl)).paused === true, "pause reaches every device");

/* A FINISHED TRACK STAYS FINISHED. The drift check used to read "you are behind" and start it again from
   the top, every five seconds, forever. */
await dm.evaluate((r) => CocLive.put(`tables/${r}/music/now`, {
  kind: "link", src: location.origin + "/tone.wav", title: "Tone", playing: true,
  pos: 89.5, at: Date.now() - 60000, loop: false, gen: 42 }), ROOM);
await wait(1500);
const ended = await state(dm);
ok(ended && ended.paused === true, `a track whose time is up is not restarted (${ended && ended.t}s, paused ${ended && ended.paused})`);

/* AND A LOOP WRAPS. Two minutes into a ninety-second loop is thirty seconds in, not a seek past the end
   that no player will honour. */
await dm.evaluate((r) => CocLive.put(`tables/${r}/music/now`, {
  kind: "link", src: location.origin + "/tone.wav", title: "Tone", playing: true,
  pos: 0, at: Date.now() - 120000, loop: true, gen: 43 }), ROOM);
await wait(2000);
const looped = await state(dm);
ok(looped && looped.paused === false && looped.t > 25 && looped.t < 45,
  `a loop wraps rather than seeking past the end (${looped && looped.t}s)`);

/* YOUTUBE BUILDS ITS PLAYER, AND NOBODY SEES A VIDEO. */
await dm.evaluate((r) => CocLive.put(`tables/${r}/music/now`, {
  kind: "youtube", src: "dQw4w9WgXcQ", title: "YT", playing: false, pos: 0, at: Date.now(), gen: 44 }), ROOM);
await wait(4000);
const yt = await dm.evaluate(() => ({
  frame: !!document.querySelector("#vtt-music iframe"),
  wide: (document.querySelector("#vtt-music") || {}).clientWidth,
  audioPaused: (document.querySelector("#vtt-audio") || {}).paused,
}));
ok(yt.frame, "a YouTube track builds its player");
ok(yt.wide <= 1, "off-screen and one pixel, so nobody sees a video");
ok(yt.audioPaused !== false, "and the other player is stopped rather than left singing under it");

await browser.close();
server.close();
console.log(fails ? `\nFAILURES: ${fails}` : "\nThe music plays, syncs across devices, and the volume is each device's own.");
process.exit(fails ? 1 : 0);
