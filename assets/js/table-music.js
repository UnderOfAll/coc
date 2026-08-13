/*
 * Circus of Chaos — music at the table.
 *
 * THE DM CHOOSES, EVERY DEVICE PLAYS ITS OWN COPY, AND THE VOLUME IS YOURS. Nothing is streamed from one
 * browser to another — there is no server here to stream it through. What travels is a few dozen bytes
 * saying WHAT is playing, whether it is running, and how far in it was at a moment on the clock; each
 * device fetches the track itself and works out where it should be. That is what makes this cost nothing
 * and keep working when somebody joins late.
 *
 * THREE WAYS IN, and they are genuinely different trades:
 *   youtube — a link. Costs nothing to host, plays the AUDIO only (the player is 1px and off-screen),
 *             and is the one to reach for. YouTube may show an ad; nobody can do anything about that.
 *   link    — a direct address ending in .mp3/.ogg/.m4a. The cheapest of all and the least convenient:
 *             it has to be a file on the open web, not a page with a player on it.
 *   device  — a file off the DM's machine, base64'd into the table so the others can hear it. CAPPED,
 *             and the cap is not arbitrary: the whole table is one document that every device downloads
 *             when it joins, so a fat track is paid for by everybody, every session, forever.
 *
 * A BROWSER WILL NOT MAKE A SOUND UNTIL YOU HAVE TOUCHED IT. That is policy in every engine and there is
 * no way round it, so the panel says so and offers one button. Once pressed, that device stays unlocked.
 *
 * SYNC IS DELIBERATELY LOOSE. Position is `pos + (now - at)`, in seconds, off each device's own clock —
 * so two machines whose clocks differ by a second are a second apart. For background music under a fight
 * that is invisible, and the alternative (a clock handshake) is a great deal of machinery for a problem
 * nobody at the table can hear. A device only re-seeks when it has drifted more than TBL_MUSIC_SLIP.
 */

const TBL_MUSIC_VOL = "coc:tbl:music:vol";      // this device's volume, 0-1
const TBL_MUSIC_MUTE = "coc:tbl:music:mute";    // …and whether it is muted, both per DEVICE not per table
const TBL_MUSIC_OK = "coc:tbl:music:ok";        // this browser has been touched, so it is allowed to play
/* A file becomes a base64 string a third bigger again, and it lands in the one document every device
   downloads on the way in. Four megabytes is about four minutes at a sane bitrate and is as far as this
   should ever be pushed — a link costs nothing and has no cap at all, which the panel says. */
const TBL_MUSIC_MAX = 4 * 1024 * 1024;
const TBL_MUSIC_SLIP = 2.5;                     // seconds of drift tolerated before a device re-seeks

/* The YouTube library hangs itself off the window and the type checker has never heard of it, so this is
   the one door it comes through: everything else in this file reads `ytWin` rather than `window`. */
const ytWin = /** @type {any} */ (window);

const mus = {
  audio: null,      // the <audio> element, for a link or a file
  yt: null,         // the YouTube player, once its API has loaded
  ytOn: false,      // …and whether it is ready to be told anything
  ytWant: null,     // what to play the moment it is
  key: "",          // what this device currently has loaded, so it reloads only on a real change
  blocked: false,   // the browser refused to start — it needs a gesture
  msg: "",
};

/* ---------------------------------------------------------------- what is playing, and what is saved */

function tblMusicData() { return (tbl && tbl.data && tbl.data.music) || {}; }
function tblMusicNow() { return tblMusicData().now || null; }
function tblMusicTracks() {
  return Object.entries(tblMusicData().tracks || {})
    .sort((a, b) => (a[1].at || 0) - (b[1].at || 0));
}
/* A file's bytes are kept apart from the list that points at them, so reading the playlist is cheap and
   the same track being re-saved does not duplicate four megabytes. */
function tblMusicSrc(t) {
  if (!t) return "";
  if (t.kind === "file") return (tblMusicData().blobs || {})[t.src] || "";
  return t.src || "";
}

/* WHERE IT SHOULD BE, RIGHT NOW. Everything about synchronising the table is this one line. */
function tblMusicWhere(now) {
  if (!now) return 0;
  const base = Number(now.pos) || 0;
  if (!now.playing) return base;
  return base + Math.max(0, (Date.now() - (Number(now.at) || Date.now())) / 1000);
}
/* …and where it should be ON A TRACK OF A KNOWN LENGTH, which is a different question once the clock has
   run past the end. A loop wraps — somebody joining two minutes into a thirty-second loop belongs four
   seconds in, not two minutes in, which no player will seek to. Anything else has simply finished, and
   that is what `over` says: the drift check must not treat a finished track as "behind" and start it
   again from the top, which is exactly what it did. */
function tblMusicAt(now, duration) {
  const raw = tblMusicWhere(now);
  const dur = Number(duration) || 0;
  if (!dur || !isFinite(dur)) return { at: raw, over: false };
  if (now && now.loop) return { at: raw % dur, over: false };
  return raw >= dur - 0.05 ? { at: Math.max(0, dur - 0.05), over: true } : { at: raw, over: false };
}

/* ---------------------------------------------------------------- this device's own settings */

function tblMusicVol() {
  const v = Number(localStorage.getItem(TBL_MUSIC_VOL));
  return Number.isFinite(v) && v >= 0 && v <= 1 ? v : 0.5;
}
function tblMusicMuted() { return localStorage.getItem(TBL_MUSIC_MUTE) === "1"; }
function tblMusicAllowed() { return localStorage.getItem(TBL_MUSIC_OK) === "1"; }

function tblMusicSetVol(v) {
  const n = Math.max(0, Math.min(1, Number(v) || 0));
  localStorage.setItem(TBL_MUSIC_VOL, String(n));
  tblMusicPushVolume();
}
function tblMusicToggleMute() {
  localStorage.setItem(TBL_MUSIC_MUTE, tblMusicMuted() ? "0" : "1");
  tblMusicPushVolume();
  paintSide();
}
/* Volume is the one thing that never goes near the database: it is yours, on this device, and a table
   where the DM's slider moved everybody's is a table where nobody can hear their own game. */
function tblMusicPushVolume() {
  const v = tblMusicMuted() ? 0 : tblMusicVol();
  try {
    if (mus.audio) { mus.audio.volume = v; mus.audio.muted = tblMusicMuted(); }
    if (mus.yt && mus.ytOn) { mus.yt.setVolume(Math.round(v * 100)); if (tblMusicMuted()) mus.yt.mute(); else mus.yt.unMute(); }
  } catch { /* a player that has gone away is not an error worth showing anybody */ }
}

/* ---------------------------------------------------------------- YouTube, audio only */

/* THE ELEVEN CHARACTERS, out of any of the six shapes a YouTube address comes in. Returns "" for anything
   that is not one, which is what makes the field able to say so instead of failing silently later. */
function tblYouTubeId(url) {
  const s = String(url || "").trim();
  if (/^[\w-]{11}$/.test(s)) return s;
  const m = s.match(/(?:youtube\.com\/(?:watch\?(?:.*&)?v=|embed\/|v\/|shorts\/|live\/)|youtu\.be\/)([\w-]{11})/);
  return m ? m[1] : "";
}

/* The IFrame API, fetched once and only when a YouTube track is actually asked for — a table that never
   plays one never talks to Google. `onYouTubeIframeAPIReady` is a global the library insists on. */
let tblYtLoading = false;
function tblMusicLoadYT() {
  if (tblYtLoading || (ytWin.YT && ytWin.YT.Player)) return;
  tblYtLoading = true;
  ytWin.onYouTubeIframeAPIReady = () => { tblMusicMakeYT(); };
  const s = document.createElement("script");
  s.src = "https://www.youtube.com/iframe_api";
  s.onerror = () => { mus.msg = "YouTube could not be reached from this device."; paintSide(); };
  document.head.appendChild(s);
}

function tblMusicHost() {
  let host = document.getElementById("vtt-music");
  if (!host) {
    host = document.createElement("div");
    host.id = "vtt-music";
    host.className = "music-host";
    // On the BODY, not in the tool view: the tool view is replaced whole by paint(), and a player that
    // is torn out and rebuilt restarts the track from nothing every time a panel is opened.
    document.body.appendChild(host);
  }
  return host;
}

function tblMusicMakeYT() {
  if (mus.yt || !ytWin.YT || !ytWin.YT.Player) return;
  const host = tblMusicHost();
  let slot = document.getElementById("vtt-yt");
  if (!slot) {
    slot = document.createElement("div");
    slot.id = "vtt-yt";
    host.appendChild(slot);
  }
  try {
    mus.yt = new ytWin.YT.Player("vtt-yt", {
      height: "1", width: "1",
      playerVars: { autoplay: 0, controls: 0, disablekb: 1, playsinline: 1, rel: 0 },
      events: {
        onReady: () => {
          mus.ytOn = true;
          tblMusicPushVolume();
          if (mus.ytWant) { const w = mus.ytWant; mus.ytWant = null; tblMusicDriveYT(w.id, w.at, w.play); }
        },
        onError: () => { mus.msg = "That video will not play — it may be blocked from being embedded."; paintSide(); },
      },
    });
  } catch { mus.yt = null; }
}

function tblMusicDriveYT(id, at, play) {
  if (!mus.yt || !mus.ytOn) { mus.ytWant = { id, at, play }; tblMusicLoadYT(); return; }
  try {
    const loaded = (mus.yt.getVideoData && mus.yt.getVideoData().video_id) || "";
    if (loaded !== id) {
      if (play) mus.yt.loadVideoById({ videoId: id, startSeconds: at });
      else mus.yt.cueVideoById({ videoId: id, startSeconds: at });
      tblMusicPushVolume();
      return;
    }
    // Already the right track: only correct the position if it has genuinely drifted.
    const cur = Number(mus.yt.getCurrentTime && mus.yt.getCurrentTime()) || 0;
    if (Math.abs(cur - at) > TBL_MUSIC_SLIP) mus.yt.seekTo(at, true);
    if (play) mus.yt.playVideo(); else mus.yt.pauseVideo();
  } catch { /* the player is mid-load; the next paint will catch it */ }
}

/* ---------------------------------------------------------------- driving whatever is playing */

/* Called from paintEverything, so every stream event re-checks. It must be cheap and it must be a no-op
   when nothing has changed — reloading a track on every event would restart it several times a second. */
function tblMusicApply() {
  if (!tbl) return;
  tblMusicWatch();
  const now = tblMusicNow();
  if (!now || !now.kind) { tblMusicSilence(); return; }
  const key = [now.kind, now.src, now.gen || 0].join("|");
  const allowed = !!now.playing && tblMusicAllowed();

  if (now.kind === "youtube") {
    if (mus.audio) { try { mus.audio.pause(); } catch { /* already gone */ } }
    if (mus.key !== key) mus.key = key;
    let ytDur = 0;
    try { ytDur = (mus.yt && mus.ytOn && mus.yt.getDuration && mus.yt.getDuration()) || 0; } catch { ytDur = 0; }
    const spot = tblMusicAt(now, ytDur);
    tblMusicDriveYT(now.src, spot.at, allowed && !spot.over);
    return;
  }

  // A link or a file: one <audio>, kept alive across every repaint.
  if (mus.yt && mus.ytOn) { try { mus.yt.pauseVideo(); } catch { /* fine */ } }
  const src = tblMusicSrc(now);
  if (!src) return;
  if (!mus.audio) {
    mus.audio = document.createElement("audio");
    mus.audio.id = "vtt-audio";
    mus.audio.preload = "auto";
    /* A TRACK CANNOT BE SEEKED BEFORE IT KNOWS HOW LONG IT IS. Setting `currentTime` in the same breath
       as `src` is silently ignored — readyState is 0 and there is nothing to seek in yet — so somebody
       who joined ten minutes into a track started at the beginning while everyone else was ten minutes
       ahead. Found in a real browser; jsdom has no media clock and cannot see it. The seek waits for the
       metadata, and reads the position AGAIN at that moment rather than using the stale one. */
    mus.audio.addEventListener("loadedmetadata", () => {
      const state = tblMusicNow();
      if (!state) return;
      try { mus.audio.currentTime = tblMusicAt(state, mus.audio.duration).at; }
      catch { /* unseekable stream: it plays from wherever it can, which is the best there is */ }
    });
    tblMusicHost().appendChild(mus.audio);
  }
  mus.audio.loop = !!now.loop;
  const spot = tblMusicAt(now, mus.audio.duration);
  if (mus.key !== key) {
    mus.key = key;
    mus.audio.src = src;
  } else if (mus.audio.readyState > 0 && !spot.over
      && Math.abs((Number(mus.audio.currentTime) || 0) - spot.at) > TBL_MUSIC_SLIP) {
    try { mus.audio.currentTime = spot.at; } catch { /* ditto */ }
  }
  tblMusicPushVolume();
  if (allowed && !spot.over) {
    const p = mus.audio.play();
    // EVERY ENGINE REFUSES until the page has been touched, and it refuses by REJECTING rather than by
    // throwing — so this cannot be caught with try/catch around the call.
    if (p && p.catch) p.catch(() => { if (!mus.blocked) { mus.blocked = true; paintSide(); } });
  } else {
    try { mus.audio.pause(); } catch { /* fine */ }
  }
}

/* A TICK, BECAUSE NOTHING ELSE FIRES. Everything else in this app is driven by the table's stream, and a
   track playing quietly for nine minutes produces no events at all — so a device that drifted, or that
   was asleep, would never be corrected. Five seconds is far below anything a room can hear and costs one
   comparison. Cleared with the table. */
let tblMusicTick = null;
function tblMusicWatch() {
  if (tblMusicTick) return;
  tblMusicTick = setInterval(() => {
    if (!tbl) { clearInterval(tblMusicTick); tblMusicTick = null; return; }
    const now = tblMusicNow();
    if (!now || !now.playing || !tblMusicAllowed()) return;
    try { tblMusicApply(); } catch { /* the next tick will try again */ }
  }, 5000);
}

function tblMusicSilence() {
  mus.key = "";
  try { if (mus.audio) { mus.audio.pause(); mus.audio.removeAttribute("src"); } } catch { /* fine */ }
  try { if (mus.yt && mus.ytOn) mus.yt.stopVideo(); } catch { /* fine */ }
}

/* Torn down with the table, or a player goes on singing over the menu. */
function tblMusicTeardown() {
  if (tblMusicTick) { clearInterval(tblMusicTick); tblMusicTick = null; }
  tblMusicSilence();
  const host = document.getElementById("vtt-music");
  if (host) host.remove();
  mus.audio = null; mus.yt = null; mus.ytOn = false; mus.ytWant = null; mus.blocked = false; mus.msg = "";
}

/* The one gesture a browser wants. Pressing it is the interaction, so playback is allowed from here on
   — and it is remembered, because being asked at every session is the sort of thing nobody forgives. */
function tblMusicEnable() {
  localStorage.setItem(TBL_MUSIC_OK, "1");
  mus.blocked = false;
  tblMusicApply();
  paintSide();
}

/* ---------------------------------------------------------------- the DM's controls */

async function tblMusicSet(patch) {
  if (tbl.role !== "dm") return;
  const now = Object.assign({}, tblMusicNow() || {}, patch);
  now.gen = (Number((tblMusicNow() || {}).gen) || 0) + 1;
  await CocLive.put(tblPath("music/now"), now);
}

/* Play one from the list: from its start, now. */
async function tblMusicPlay(id) {
  const t = (tblMusicData().tracks || {})[id];
  if (!t) return;
  await tblMusicSet({ kind: t.kind, src: t.src, title: t.title || "", trackId: id,
    playing: true, pos: 0, at: Date.now(), loop: !!t.loop });
}
/* Pause freezes the position, so resuming picks up where the room actually was rather than where the
   clock would have carried it to while nobody was listening. */
async function tblMusicPause() {
  const now = tblMusicNow();
  if (!now) return;
  await tblMusicSet({ playing: false, pos: tblMusicWhere(now), at: Date.now() });
}
async function tblMusicResume() {
  const now = tblMusicNow();
  if (!now) return;
  await tblMusicSet({ playing: true, at: Date.now() });
}
async function tblMusicStop() {
  if (tbl.role !== "dm") return;
  await CocLive.put(tblPath("music/now"), null);
}
async function tblMusicToggleLoop() {
  const now = tblMusicNow();
  if (!now) return;
  await tblMusicSet({ loop: !now.loop, pos: tblMusicWhere(now), at: Date.now() });
}
async function tblMusicDropTrack(id) {
  if (tbl.role !== "dm") return;
  const t = (tblMusicData().tracks || {})[id];
  const now = tblMusicNow();
  if (now && now.trackId === id) await tblMusicStop();
  await CocLive.del(tblPath("music/tracks/" + id));
  // And its bytes, if nothing else points at them.
  if (t && t.kind === "file" && t.src) {
    const stillUsed = Object.entries(tblMusicData().tracks || {})
      .some(([tid, other]) => tid !== id && other.kind === "file" && other.src === t.src);
    if (!stillUsed) await CocLive.del(tblPath("music/blobs/" + t.src)).catch(() => {});
  }
  paintSide();
}

function tblMusicSay(t, cls) {
  mus.msg = t || "";
  const n = document.querySelector("#music-msg");
  if (n) { n.textContent = mus.msg; n.className = "save-msg" + (cls || ""); }
}

/* Adding one. The three kinds are validated where they differ and nowhere else. */
async function tblMusicAdd() {
  if (tbl.role !== "dm") return;
  const kind = tbl.ui.musicKind || "youtube";
  const title = String((($("#music-title") || {}).value) || "").trim().slice(0, 60);
  const link = String((($("#music-url") || {}).value) || "").trim();
  const file = ($("#music-file") || {}).files && $("#music-file").files[0];

  if (kind === "youtube") {
    const id = tblYouTubeId(link);
    if (!id) return tblMusicSay("That is not a YouTube address. Paste the one from the address bar.", " bad");
    await tblMusicSaveTrack({ kind: "youtube", src: id, title: title || "YouTube track" });
    return;
  }
  if (kind === "link") {
    if (!/^https?:\/\//i.test(link)) return tblMusicSay("That needs to be a web address starting http.", " bad");
    await tblMusicSaveTrack({ kind: "link", src: link.slice(0, 900), title: title || "Track" });
    return;
  }
  if (!file) return tblMusicSay("Choose a file first.", " bad");
  if (!/^audio\//.test(file.type || "")) return tblMusicSay("That is not an audio file.", " bad");
  if (file.size > TBL_MUSIC_MAX) {
    return tblMusicSay(`That is ${(file.size / 1048576).toFixed(1)} MB and the cap is `
      + `${TBL_MUSIC_MAX / 1048576} MB — everyone at the table downloads it. A link has no cap at all.`, " bad");
  }
  tblMusicSay("Reading it…");
  const data = await new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result || ""));
    r.onerror = () => rej(new Error("could not read that file"));
    r.readAsDataURL(file);
  }).catch((err) => { tblMusicSay(err.message, " bad"); return ""; });
  if (!data) return;
  // Keyed by its own contents, exactly as a figure's picture is: the same track added twice is one copy.
  const key = tblArtKey(data);
  if (!(tblMusicData().blobs || {})[key]) await CocLive.put(tblPath("music/blobs/" + key), data);
  await tblMusicSaveTrack({ kind: "file", src: key, title: title || file.name.replace(/\.[^.]+$/, "") });
}

async function tblMusicSaveTrack(track) {
  await CocLive.push(tblPath("music/tracks"), Object.assign({ at: Date.now() }, track));
  tblMusicSay("Added.", " good");
  const t = $("#music-title"), u = $("#music-url"), f = $("#music-file");
  if (t) t.value = ""; if (u) u.value = ""; if (f) f.value = "";
  paintSide();
}

/* ---------------------------------------------------------------- the panel */

const TBL_MUSIC_KINDS = [
  ["youtube", "YouTube", "a link — the audio only, no video on screen"],
  ["link", "A direct link", "an address ending .mp3, .ogg or .m4a"],
  ["device", "From this device", `a file, up to ${TBL_MUSIC_MAX / 1048576} MB — everyone downloads it`],
];

function musicPanelHTML() {
  const now = tblMusicNow();
  const vol = Math.round(tblMusicVol() * 100);
  const muted = tblMusicMuted();
  const kind = tbl.ui.musicKind || "youtube";
  const tracks = tblMusicTracks();

  const nowLine = now
    ? `<p class="music-now"><strong>${esc(now.title || "Untitled")}</strong>
        <span class="muted">${esc(now.playing ? "playing" : "paused")}${now.loop ? " · on a loop" : ""}
        · ${esc(TBL_MUSIC_KINDS.find(([k]) => k === now.kind) ? (now.kind === "youtube" ? "YouTube"
          : now.kind === "link" ? "a link" : "the DM's file") : now.kind)}</span></p>`
    : `<p class="muted">Nothing playing.</p>`;

  /* THE ONE THING A BROWSER WILL NOT DO WITHOUT BEING ASKED. Shown to everybody who has not yet let this
     device make a sound, and to anybody whose engine refused anyway. */
  const gate = (!tblMusicAllowed() || mus.blocked)
    ? `<section class="panel">
        <p class="panel-sub">Sound is off on this device</p>
        <p class="muted">A browser will not play anything until you have touched the page — that is the
          rule everywhere and there is no way around it. One press and this device stays unlocked.</p>
        <button class="btn" data-tbl="music-enable">Turn the sound on</button>
      </section>` : "";

  const mine = `<section class="panel">
      <p class="panel-sub">Yours alone <span class="muted">— nobody else hears your setting</span></p>
      <div class="music-vol">
        <button class="btn-quiet ${muted ? "on" : ""}" data-tbl="music-mute">${muted ? "Unmute" : "Mute"}</button>
        <input id="music-vol" class="music-slider" type="range" min="0" max="100" step="1"
          value="${esc(vol)}" aria-label="Volume" />
        <span class="music-pct">${muted ? "muted" : esc(vol) + "%"}</span>
      </div>
    </section>`;

  if (tbl.role !== "dm") {
    return `<section class="panel"><h2>Music</h2>${nowLine}
      <p class="muted">The DM chooses what plays. How loud it is, is yours.</p></section>${gate}${mine}`;
  }

  const list = tracks.length ? `<div class="scene-list">${tracks.map(([id, t]) => `
      <div class="scene-row ${now && now.trackId === id ? "on" : ""}">
        <button class="scene-pick" data-tbl="music-play" data-val="${esc(id)}">
          <strong>${esc(t.title || "Untitled")}</strong>
          <span class="muted">${esc(t.kind === "youtube" ? "YouTube" : t.kind === "link" ? "a link" : "a file")}</span>
        </button>
        <button class="btn-quiet" data-tbl="music-drop" data-val="${esc(id)}">Delete</button>
      </div>`).join("")}</div>`
    : `<p class="muted">Nothing saved yet. Add one below and it stays on this table.</p>`;

  return `<section class="panel"><h2>Music</h2>
      ${nowLine}
      <div class="hp-controls">
        ${now ? (now.playing
          ? `<button class="btn" data-tbl="music-pause">Pause</button>`
          : `<button class="btn" data-tbl="music-resume">Play</button>`) : ""}
        ${now ? `<button class="btn-quiet" data-tbl="music-stop">Stop</button>` : ""}
        ${now ? `<button class="chip ${now.loop ? "on" : ""}" data-tbl="music-loop">Loop</button>` : ""}
      </div>
      <p class="muted">Everyone hears it at once. Each device plays its own copy from the source, so
        somebody joining halfway comes in where the room is.</p>
    </section>
    ${gate}${mine}
    <section class="panel">
      <p class="panel-sub">This table's tracks</p>
      ${list}
    </section>
    <section class="panel">
      <p class="panel-sub">Add one</p>
      <div class="chips">${TBL_MUSIC_KINDS.map(([k, label, note]) => chipTip(
        `<button class="chip ${kind === k ? "on" : ""}" data-tbl="music-kind" data-val="${k}">${esc(label)}</button>`,
        esc(note))).join("")}</div>
      <label class="field"><span>Name it <span class="muted">— what you will look for mid-fight</span></span>
        <input id="music-title" class="text" type="text" maxlength="60" placeholder="The Midway" /></label>
      ${kind === "device"
        ? `<label class="field"><span>Audio file</span>
            <input id="music-file" class="text" type="file" accept="audio/*" /></label>
           <p class="muted">Up to ${TBL_MUSIC_MAX / 1048576} MB, because it is kept in the table itself and
             every device downloads it on the way in. For anything longer, put it somewhere with an address
             and use a link — there is no cap on those.</p>`
        : `<label class="field"><span>${kind === "youtube" ? "YouTube address" : "Direct address"}</span>
            <input id="music-url" class="text" type="url"
              placeholder="${kind === "youtube" ? "https://www.youtube.com/watch?v=…" : "https://…/track.mp3"}" /></label>
           ${kind === "youtube"
             ? `<p class="muted">Only the sound is used — the player is one pixel and off-screen. A video
                 whose owner has blocked embedding will refuse, and YouTube may play an ad first; neither
                 is something this app can do anything about.</p>`
             : `<p class="muted">It has to be the file itself, not a page with a player on it — an address
                 that ends .mp3, .ogg or .m4a.</p>`}`}
      <button class="btn" data-tbl="music-add">Add it</button>
      <p id="music-msg" class="save-msg">${esc(mus.msg)}</p>
    </section>`;
}
