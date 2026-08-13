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
const SHORT = tone(3);        // short enough to end while the test is watching

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
                ".json": "application/json", ".jpg": "image/jpeg", ".wav": "audio/wav" };
const server = http.createServer((req, res) => {
  const u = decodeURIComponent(req.url.split("?")[0]);
  if (u === "/short.wav") {
    res.writeHead(200, { "Content-Type": "audio/wav", "Accept-Ranges": "bytes", "Content-Length": SHORT.length });
    return res.end(SHORT);
  }
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
               muted: a.muted, ready: a.readyState } : null;
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

/* THE BOTTOM OF THE SLIDER IS SILENCE, not "very quiet". Kayki: "putting the sound on 0% doesnt put it
   mute, just really low sound." Measured on both players, because they fail differently and only one of
   them was at fault. */
await pl.evaluate(() => tblMusicSetVol(0));
await wait(300);
const hushed = await state(pl);
ok(hushed.vol === 0 && hushed.muted === true, "at the bottom the audio element is muted, not merely quiet");
await pl.evaluate(() => tblMusicSetVol(0.5));
await wait(200);
ok((await state(pl)).muted === false, "and comes back off the bottom");

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

/* THE QUEUE ADVANCES BY ITSELF WHEN A TRACK ENDS — and only the DM's browser does the advancing. Five
   devices all noticing the end and all writing the next one is five different tracks starting at once.
   This is the other thing jsdom cannot see: nothing there ever reaches the end of anything. */
const ids = await dm.evaluate(async (r, host) => {
  await CocLive.put(`tables/${r}/music/tracks`, null);
  const a = await CocLive.push(`tables/${r}/music/tracks`, { kind: "link", src: host + "/short.wav", title: "Short", at: 1 });
  const b = await CocLive.push(`tables/${r}/music/tracks`, { kind: "link", src: host + "/tone.wav", title: "Long", at: 2 });
  await CocLive.put(`tables/${r}/music/queue`, [b]);
  await CocLive.put(`tables/${r}/music/now`, { kind: "link", src: host + "/short.wav", title: "Short",
    trackId: a, playing: true, pos: 0, at: Date.now(), loop: false, gen: 70 });
  return { a, b };
}, ROOM, base);
await wait(6000);
const after = await dm.evaluate((r) => CocLive.get(`tables/${r}/music/now`), ROOM);
ok(after && after.trackId === ids.b, `a finished track hands over to the next in the queue (${after && after.title})`);
ok((await dm.evaluate((r) => CocLive.get(`tables/${r}/music/queue`), ROOM)) === null,
  "and the queue is one shorter, not replayed forever");
const playerHeard = await pl.evaluate((r) => CocLive.get(`tables/${r}/music/now`), ROOM);
ok(playerHeard && playerHeard.trackId === ids.b, "the player's device followed it without doing the advancing");

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
/* AND YOUTUBE WILL NOT GO TO ZERO IF YOU ASK IT NICELY. Asked for setVolume(0) it reports back 5 — this
   is the actual bug Kayki heard, and the only thing that silences it is its own mute(). */
const ytVol = async (v) => {
  await dm.evaluate((x) => tblMusicSetVol(x), v);
  await wait(400);
  return dm.evaluate(() => { try { return { vol: mus.yt.getVolume(), muted: mus.yt.isMuted() }; }
    catch { return null; } });
};
const loud = await ytVol(1);
ok(loud && loud.vol === 100 && loud.muted === false, "YouTube takes a volume");
const off = await ytVol(0);
ok(off && off.muted === true, `and the bottom of the slider genuinely mutes it (it reports vol ${off && off.vol})`);
const back = await ytVol(0.5);
ok(back && back.muted === false && back.vol === 50,
  "and coming off the bottom unmutes it AND restores the level — unMute must run before setVolume, or it puts the old one back");

/* DRAGGING A TRACK INTO A FOLDER. Pointer events, because HTML5 drag-and-drop does not exist under a
   finger and half this table is played on a phone — the board learned that the hard way. jsdom has no
   `elementFromPoint` worth the name and no layout to read a drop target out of, so this is the only
   place the gesture can be shown to work at all. */
await dm.evaluate(async (r) => {
  await CocLive.put(`tables/${r}/music/now`, null);
  await CocLive.put(`tables/${r}/music/queue`, null);
  await CocLive.put(`tables/${r}/music/tracks`, null);
  await CocLive.put(`tables/${r}/music/folders`, null);
  const a = await CocLive.push(`tables/${r}/music/folders`, { name: "Backstage", order: 0, at: 1 });
  const b = await CocLive.push(`tables/${r}/music/folders`, { name: "Main Stage", order: 1, at: 2 });
  await CocLive.push(`tables/${r}/music/tracks`,
    { kind: "link", src: "/tone.wav", title: "Dragged", at: 1, folder: a, order: 0 });
  window.__f = { a, b };
}, ROOM);
await wait(600);
await dm.evaluate(() => { tbl.ui.panel = "music"; paintSide(); });
await wait(400);

/* HELD AT THE EDGE, THE PANEL SCROLLS. Measured before anything else, because without it the folder you
   are dragging to is often simply not on screen — with two folders open the second heading sat a couple
   of hundred pixels below the window, and you cannot drop onto what is not there. */
const sideBox = await dm.evaluate(() => {
  const s = document.querySelector("#vtt-side");
  const b = s.getBoundingClientRect();
  return { x: b.x + b.width / 2, bottom: b.bottom, top: b.top, scroll: s.scrollTop,
    scrollable: s.scrollHeight > s.clientHeight + 10 };
});
ok(sideBox.scrollable, "the music panel is long enough to scroll, which is why the edge matters");
const h0 = await dm.evaluate(() => {
  const b = document.querySelector("[data-mus-drag]").getBoundingClientRect();
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
});
await dm.mouse.move(h0.x, h0.y);
await dm.mouse.down();
await dm.mouse.move(h0.x + 14, h0.y + 14, { steps: 4 });
await dm.mouse.move(sideBox.x, sideBox.bottom - 20, { steps: 8 });
await wait(700);                        // held still at the edge — no further movement at all
const scrolled = await dm.evaluate(() => document.querySelector("#vtt-side").scrollTop);
ok(scrolled > sideBox.scroll + 40, `holding at the bottom edge keeps scrolling (${sideBox.scroll} -> ${scrolled})`);
await dm.mouse.up();
await wait(300);

const boxes = await dm.evaluate(() => {
  const handle = document.querySelector("[data-mus-drag]");
  const target = document.querySelector(`[data-mus-folder="${window.__f.b}"] .mus-folder-head`);
  if (!handle || !target) return null;
  target.scrollIntoView({ block: "center" });
  const h = handle.getBoundingClientRect(), t = target.getBoundingClientRect();
  if (h.height < 1 || t.height < 1) return null;
  return { hx: h.x + h.width / 2, hy: h.y + h.height / 2, tx: t.x + t.width / 2, ty: t.y + t.height / 2 };
});
ok(!!boxes, "a track row has a drag handle and a folder has a heading to drop it on");
if (boxes) {
  await dm.mouse.move(boxes.hx, boxes.hy);
  await dm.mouse.down();
  // Past the slop first, then to the target, in steps — one jump is not a drag anywhere.
  await dm.mouse.move(boxes.hx + 12, boxes.hy + 12, { steps: 4 });
  await wait(120);
  const lit = await dm.evaluate(() => !!document.querySelector(".mus-ghost"));
  ok(lit, "moving past the slop starts a drag, with something following the pointer");
  await dm.mouse.move(boxes.tx, boxes.ty, { steps: 12 });
  await wait(150);
  const marked = await dm.evaluate(() => !!document.querySelector(".drop-into"));
  ok(marked, "and the folder under the pointer says it is the one that would take it");
  await dm.mouse.up();
  await wait(700);
  const landed = await dm.evaluate((r) => CocLive.get(`tables/${r}/music/tracks`), ROOM);
  const t = Object.values(landed)[0];
  const want = await dm.evaluate(() => window.__f.b);
  ok(t.folder === want, `releasing puts it in that folder (folder=${t.folder === want ? "Main Stage" : t.folder})`);
  ok(!(await dm.evaluate(() => !!document.querySelector(".mus-ghost"))), "and the ghost is cleared up after it");
}
/* A PRESS THAT NEVER BECAME A DRAG MUST NOT MOVE ANYTHING — the handle is a hair from the play button. */
const before = await dm.evaluate((r) => CocLive.get(`tables/${r}/music/tracks`), ROOM);
const h2 = await dm.evaluate(() => {
  const n = document.querySelector("[data-mus-drag]");
  const b = n.getBoundingClientRect();
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
});
await dm.mouse.move(h2.x, h2.y); await dm.mouse.down(); await dm.mouse.move(h2.x + 2, h2.y + 1); await dm.mouse.up();
await wait(400);
ok(JSON.stringify(await dm.evaluate((r) => CocLive.get(`tables/${r}/music/tracks`), ROOM)) === JSON.stringify(before),
  "a press that never travelled is a press, and moves nothing");

await browser.close();
server.close();
console.log(fails ? `\nFAILURES: ${fails}` : "\nThe music plays, syncs across devices, and the volume is each device's own.");
process.exit(fails ? 1 : 0);
