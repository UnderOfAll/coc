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
/* How long a track is protected from being declared finished. A player handed a new video reports the
   OLD one's state for a moment, and believing it walks the whole queue in seconds without a sound. Three
   is comfortably longer than any load and far shorter than any track. */
const TBL_MUSIC_START = 3;
/* How far past a track's own length the wall clock must run before a device with NO player will call it
   finished. Generous, because an advert in front of the music leaves the player behind the clock. */
const TBL_MUSIC_LATE = 25;

/* The YouTube library hangs itself off the window and the type checker has never heard of it, so this is
   the one door it comes through: everything else in this file reads `ytWin` rather than `window`. */
const ytWin = /** @type {any} */ (window);

const mus = {
  audio: null,      // the <audio> element, for a link or a file
  yt: null,         // the YouTube player, once its API has loaded
  ytOn: false,      // …and whether it is ready to be told anything
  ytWant: null,     // what to play the moment it is
  key: "",          // what this device currently has loaded, so it reloads only on a real change
  advancing: false, // a queue advance is in flight; the tick and the `ended` event must not race
  blocked: false,   // the browser refused to start — it needs a gesture
  msg: "",
};

/* ---------------------------------------------------------------- what is playing, and what is saved */

function tblMusicData() { return (tbl && tbl.data && tbl.data.music) || {}; }
function tblMusicNow() { return tblMusicData().now || null; }
/* UP NEXT, AND IT IS THE DM'S ALONE. Kayki: "only dm has access to the queued musics, the players can
   see what is playing." So the queue lives in the table (it has to — the DM may run the session from a
   different device tomorrow) but nothing renders it for anybody else. It is a list of TRACK IDS, and the
   database hands an array back as an object the moment it has a hole in it, so it is normalised here
   rather than at every call site. */
function tblMusicQueue() {
  const q = tblMusicData().queue;
  const list = Array.isArray(q) ? q : Object.values(q || {});
  const shelf = tblMusicData().tracks || {};
  // A track deleted off the shelf must not sit in the queue as an id that plays nothing.
  return list.filter((id) => id && shelf[id]);
}
function tblMusicTracks() {
  return Object.entries(tblMusicData().tracks || {})
    .sort((a, b) => (a[1].at || 0) - (b[1].at || 0));
}
/* A file's bytes are kept apart from the list that points at them, so reading the playlist is cheap and
   the same track being re-saved does not duplicate four megabytes. */
function tblMusicSrc(t) {
  if (!t) return "";
  if (t.kind === "file") return (tblMusicData().blobs || {})[t.src] || "";
  /* A committed track is named by its path under music/ and resolved against the page, so it works the
     same on the live site and on a local server. Each SEGMENT is encoded rather than the whole string:
     a folder called "main stage" needs its space escaped, and the slashes between folders must not be. */
  if (t.kind === "repo") {
    return "music/" + String(t.src || "").split("/").map(encodeURIComponent).join("/");
  }
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

/* HALF, UNLESS THIS DEVICE HAS SAID OTHERWISE — and "has said" has to be tested before the number is,
   because `localStorage.getItem` answers null when nothing is stored and `Number(null)` is 0, which
   passed the range check and handed every device that had never touched the slider a volume of ZERO.
   Nobody at a table full of first-time devices would have heard a thing, and the panel would have said
   0% while looking like it was working. */
function tblMusicVol() {
  const raw = localStorage.getItem(TBL_MUSIC_VOL);
  if (raw == null || raw === "") return 0.5;
  const v = Number(raw);
  return Number.isFinite(v) && v >= 0 && v <= 1 ? v : 0.5;
}
/* SILENT IS SILENT. Nothing plays when the slider is at the bottom or the mute is on — one question with
   one answer, rather than two states that mostly agree. */
function tblMusicSilent() { return tblMusicMuted() || tblMusicVol() <= 0; }
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
  const off = tblMusicSilent();
  const v = off ? 0 : tblMusicVol();
  try {
    // The element's own `muted` as well as a zero volume: one of them is belt and the other braces, and
    // it costs nothing to be certain the thing is quiet.
    if (mus.audio) { mus.audio.volume = v; mus.audio.muted = off; }
    if (mus.yt && mus.ytOn) {
      /* YOUTUBE WILL NOT GO TO ZERO. Asked for setVolume(0) it reports back 5 — measured, not assumed —
         so the slider at the bottom left the room with a faint hiss instead of silence, which is exactly
         what Kayki heard. Its `mute()` is the only thing that actually silences it.
         And unMute BEFORE setVolume, never after: unMute restores the level from before the mute, so
         calling it second throws away the number just set. */
      if (off) { mus.yt.mute(); } else { mus.yt.unMute(); mus.yt.setVolume(Math.round(v * 100)); }
    }
  } catch { /* a player that has gone away is not an error worth showing anybody */ }
}

/* THE FOLDER A COMMITTED FILE SITS IN ON DISK. This is only about the Add list — what music/ is laid out
   like. Where a track lives once it is ON the shelf is a separate thing the DM decides in the app. */
function tblMusicDiskFolder(pathOrTrack) {
  const src = typeof pathOrTrack === "string" ? pathOrTrack
    : (pathOrTrack && pathOrTrack.kind === "repo" ? pathOrTrack.src : "");
  const at = String(src || "").lastIndexOf("/");
  return at > 0 ? String(src).slice(0, at) : "";
}

/* ---------------------------------------------------------------- folders, made in the app
 *
 * Kayki: "in the app itself, I create folders for the musics, drag and drop them in there, also I can
 * reorganize the order at will." So a folder is a thing the DM MAKES, not a mirror of what is on disk —
 * a track from YouTube and a track off the repo belong in "Main Stage" together, and neither of them
 * lives in a directory called that.
 *
 * A track carries `folder` (a folder id, or nothing for loose) and `order` (its place inside that
 * folder). Both are written by ONE function, `tblMusicPlace`, whether the DM dragged the row or pressed
 * an arrow — so there is a single description of what "put this there" means and the two cannot drift.
 */
function tblMusicFolders() {
  return Object.entries(tblMusicData().folders || {})
    .sort((a, b) => (Number(a[1].order) || 0) - (Number(b[1].order) || 0) || (a[1].at || 0) - (b[1].at || 0));
}
/* Every track in one folder, in its own order. A track pointing at a folder that has been deleted is
   loose rather than invisible — losing a folder must never lose the music in it. */
function tblMusicGroup(folder) {
  const want = folder || "";
  const folders = tblMusicData().folders || {};
  return tblMusicTracks()
    .filter(([, t]) => {
      const f = t.folder && folders[t.folder] ? t.folder : "";
      return f === want;
    })
    .sort((a, b) => {
      const ao = a[1].order == null ? Infinity : Number(a[1].order);
      const bo = b[1].order == null ? Infinity : Number(b[1].order);
      return (ao - bo) || ((a[1].at || 0) - (b[1].at || 0));
    });
}
/* The name a DISK folder goes by. The top level is "In music/" and not "Loose", which is what the shelf
   calls its own unfoldered tracks: two lists one above the other, both headed "Loose", read as one list —
   and a repo track taken off the shelf reappears in this one, which then looks exactly like a delete that
   moved the track instead of removing it. */
function tblMusicDiskName(f) {
  return f ? f.split("/").map((x) => x.replace(/[-_]+/g, " ")).join(" · ") : "In music/";
}
/* Grouped, folders first in the order they are met, "Loose" last — a scene's set is what a DM reaches
   for, and the odds and ends at the top level are what they scroll past. */
function tblMusicByFolder(items, folderOf) {
  const groups = new Map();
  for (const it of items) {
    const f = folderOf(it);
    if (!groups.has(f)) groups.set(f, []);
    groups.get(f).push(it);
  }
  return [...groups.entries()].sort((a, b) => (a[0] ? 0 : 1) - (b[0] ? 0 : 1));
}

/* WHAT IS COMMITTED IN music/. The app cannot list a directory over HTTP, so the build writes the
   listing and this reads it — exactly as the repo maps work. Fetched once per session, lazily. */
let tblRepoMusic = null;
async function tblLoadRepoMusic() {
  try {
    const res = await fetch("music/index.json?cb=" + Date.now());
    tblRepoMusic = res.ok ? (await res.json()) : [];
  } catch { tblRepoMusic = []; }
  if (tbl && tbl.ui.panel === "music") paintSide();
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
        onStateChange: (e) => {
          // 0 is ENDED, and it is the fast path only — the tick asks the same question every 2.5s in
          // case this never arrives. The chair advances; nobody else.
          if (e && e.data === 0 && tbl && tbl.role === "dm") tblMusicEnded().catch(() => {});
        },
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
    const state = Number(mus.yt.getPlayerState && mus.yt.getPlayerState());
    // A FINISHED PLAYER IS NEVER SEEKED. `seekTo` on a player in ENDED restarts it, so a correction meant
    // to nudge it into line replays the tail instead. Caller-side this is already handled; this is the
    // second lock on the same door, because the cost of getting it wrong is a track that never stops.
    if (state === 0 && !play) return;
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
    /* HOW LONG IS *THIS* TRACK — asked only of a player that is actually showing it. Kayki: "the musics
       now isnt waiting to finish to start the next ones." A player handed a new video goes on reporting
       the PREVIOUS one's duration for a moment, and a 2-minute answer published for a 5-minute track
       ends it three minutes early, on every device, for good. Same fault as the ENDED state reporting
       about the wrong song; this is the other half of it. */
    let ytDur = 0;
    try {
      const holding = (mus.yt && mus.ytOn && mus.yt.getVideoData && mus.yt.getVideoData().video_id) || "";
      if (mus.yt && mus.ytOn && (!holding || holding === now.src)) {
        ytDur = Number(mus.yt.getDuration && mus.yt.getDuration()) || 0;
      }
    } catch { ytDur = 0; }
    // Published once, so a device with no player of its own can still tell when this ends.
    if (ytDur > 5) tblMusicPublishDuration(ytDur);
    if (!ytDur) ytDur = Number(now.dur) || 0;
    /* THE CLOCK IS CLAMPED TO THE END OF THE TRACK, not left to run past it. Kayki: "when it finishes the
       queue it just keep repeating the last 5sec of the last music infinitely." A finished track keeps
       `playing: true` with nothing queued to replace it, so the wall clock walks on — 3:20, 3:22, 3:25 —
       while the player sits at 3:20, and every tick the two are further apart than TBL_MUSIC_SLIP. The
       drift correction then seeked a player that had ENDED, and seeking an ended YouTube player does not
       just move it, it starts it again. That is the loop, once every 2.5 seconds, for ever. A loop still
       wraps; anything else stops at its own end. */
    const spot = tblMusicAt(now, ytDur);
    const over = spot.over || tblMusicOver();
    if (over) { try { mus.yt && mus.ytOn && mus.yt.pauseVideo(); } catch { /* mid-load */ } return; }
    tblMusicDriveYT(now.src, spot.at, allowed);
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
    /* THE END OF A TRACK IS THE QUEUE'S CUE, and the DM's browser is the only one that acts on it —
       everybody else finds out the ordinary way, by `now` changing under them. */
    mus.audio.addEventListener("ended", () => {
      if (tbl && tbl.role === "dm") tblMusicEnded().catch(() => {});
    });
    mus.audio.addEventListener("loadedmetadata", () => {
      const state = tblMusicNow();
      if (!state) return;
      // Same rule for a file: an element still holding the previous track knows the previous length.
      {
        const el = mus.audio, src = tblMusicSrc(state);
        const mine = !el.src || !src || el.src === src || String(el.src).endsWith(String(src));
        if (mine) tblMusicPublishDuration(el.duration);
      }
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

/* HAS THIS TRACK FINISHED? Asked of the PLAYER, never of the clock.
 *
 * The wall clock — `pos + elapsed` — is what keeps five devices together, and it is the wrong thing to
 * end a track on. YouTube may put a twenty-second advert in front of the music, and then the player is
 * twenty seconds behind the clock: ending on the clock cuts the last twenty seconds off the track, on
 * that device only, and skips ahead of everybody else. So this reads the player's own position, and
 * takes its state machine's word for it when it has one.
 *
 * It is also the answer to the failure Kayki hit: the backstop only ever looked at `mus.audio`, so a
 * YouTube track had no safety net at all and rode entirely on one event firing. */
/* HOW LONG THE TRACK IS, PUBLISHED ONCE BY WHOEVER CAN SEE IT.
 *
 * The end of a track was only ever noticed by a LOCAL player — the audio element's `ended`, or a YouTube
 * player reporting state 0 — so a DM with no player of their own (sound never enabled on that device,
 * a tab the browser put to sleep, a YouTube frame that failed to load) could never advance the room's
 * queue, and the music simply stopped. Kayki, twice: "queueing music isnt working."
 *
 * A duration is the one fact that makes the end knowable WITHOUT a player: the room already agrees on
 * when the track started, so anybody holding the number can work out that it is over. The first device
 * that has a player and a finite duration writes it to `now`, and from then on every device — the DM's
 * included — can end the track off the wall clock alone. */
function tblMusicPublishDuration(dur) {
  const now = tblMusicNow();
  if (!now || !tbl || Number(now.dur) > 0) return;
  const d = Number(dur);
  if (!d || !isFinite(d) || d <= 5) return;      // a "duration" of nothing is a player mid-load
  const gen = Number(now.gen) || 0;
  // The track may have changed between learning the number and writing it; a duration on the wrong
  // track would end the next one early, which is worse than not having one at all.
  CocLive.put(tblPath("music/now/dur"), Math.round(d * 10) / 10).then(() => {
    const after = tblMusicNow();
    if (after && (Number(after.gen) || 0) !== gen) CocLive.put(tblPath("music/now/dur"), null).catch(() => {});
  }).catch(() => {});
}

function tblMusicOver() {
  const now = tblMusicNow();
  if (!now || now.loop) return false;
  /* NOTHING IS OVER IN ITS FIRST SECONDS, and this is the guard the whole thing turns on.
     Kayki: "queue is going one after another instead of playing in queue, not playing anything at all."
     A YouTube player that has just been handed a new video goes on reporting the PREVIOUS one's ENDED
     state for a moment — so the 2.5s tick saw "over", advanced, saw "over" again, and walked the whole
     queue in a few seconds without a note being played. It was always latent; it only became visible
     when the end of a track stopped meaning silence and started meaning "play the next one". */
  const played = tblMusicWhere(now);
  if (played < TBL_MUSIC_START) return false;

  /* THE PLAYER ANSWERS FIRST, AND ITS ANSWER IS FINAL. YouTube may put an advert in front of the music,
     which leaves the player twenty seconds behind the wall clock: ending on the clock would cut the last
     twenty seconds off on one device and skip ahead of everybody else. */
  if (now.kind === "youtube") {
    if (mus.yt && mus.ytOn) {
      try {
        /* ONLY A PLAYER SHOWING THIS TRACK MAY DECLARE IT FINISHED. Asked of a player still holding the
           last video, "have you ended?" is a question about the wrong song. A player that cannot say
           which video it holds is taken at its word, as it always was. */
        const loaded = (mus.yt.getVideoData && mus.yt.getVideoData().video_id) || "";
        if (!loaded || loaded === now.src) {
          if (mus.yt.getPlayerState && mus.yt.getPlayerState() === 0) return true;   // 0 is ENDED
          const dur = Number(mus.yt.getDuration && mus.yt.getDuration()) || 0;
          const at = Number(mus.yt.getCurrentTime && mus.yt.getCurrentTime()) || 0;
          if (dur > 0 && at > 0 && at >= dur - 0.6) return true;
        }
      } catch { /* mid-load: fall through to the clock */ }
    }
  } else if (mus.audio) {
    const el = mus.audio;
    const mine = !el.src || !now.src || el.src === now.src || String(el.src).endsWith(String(now.src));
    if (mine) {
      if (el.ended) return true;
      const dur = Number(el.duration);
      if (dur && isFinite(dur) && el.currentTime >= dur - 0.25) return true;
    }
  }

  /* AND THE CLOCK IS THE BACKSTOP, for the device that has no player to ask — a DM who never enabled
     sound here, a tab the browser put to sleep, a YouTube frame that failed to load. Without it the
     room's queue depended on the DM being able to HEAR it, which is how the music kept stopping.
     Deliberately LATE: `dur` was published by a device that could see it, and an advert can leave a
     player well behind the wall clock, so nothing is cut short by this — it only catches the track that
     is properly, unarguably finished. */
  if (Number(now.dur) > 0 && now.playing && played >= Number(now.dur) + TBL_MUSIC_LATE) return true;
  return false;
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
    if (!now || !now.playing) return;
    /* THE TICK RUNS WHETHER OR NOT THIS DEVICE CAN MAKE A SOUND, and that turned out to be the whole
       bug. Kayki: "if i dont have the music option open as dm it doesnt go to the next on queue."
       `tblMusicApply` is what builds the player, learns how long the track is and publishes that length
       for everybody — and it sat behind an allowed-check here, so a DM who had not enabled sound on that
       device only ever ran it when something ELSE repainted the table. Opening the music panel repaints;
       a quiet table with the panel closed does not. So the room's queue depended on the DM LOOKING at
       it. Apply is safe when sound is not allowed — it cues the player rather than playing it, which is
       exactly what a stream event has always made it do in that state. */
    try { tblMusicApply(); } catch { /* the next tick will try again */ }
    /* THE BACKSTOP, and for YouTube it is the only thing there is that this app controls. The events are
       the fast path; this catches every case they miss — a tab that was asleep, a player rebuilt
       mid-track, a stream that stopped without saying so, an event that simply never came. It runs after
       apply, so it is asking a player that has just been brought up to date. */
    if (tbl.role === "dm") tblMusicEnded().catch(() => {});
  }, 2500);
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
  const was = tblMusicNow() || {};
  const now = Object.assign({}, was, patch);
  now.gen = (Number(was.gen) || 0) + 1;
  /* A DURATION BELONGS TO THE TRACK IT WAS MEASURED ON, and this is a MERGE — so `dur` survived into the
     next track and ended it at the wrong length. Kayki: "the musics now isnt waiting to finish to start
     the next ones." A five-minute song following a two-minute one inherited 120 seconds and was cut off
     at two minutes, on every device, for good. Cleared here rather than in tblMusicPlay so no future
     caller can reintroduce it: change what is playing and the old length goes with it. */
  if ((patch.src != null && patch.src !== was.src)
    || (patch.trackId != null && patch.trackId !== was.trackId)) now.dur = null;
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
/* SET, not toggle: the panel offers two buttons and one of them is always the one that is already on,
   so pressing it must be a no-op rather than flipping the room into the other mode. */
async function tblMusicWhenEnds(mode) {
  const now = tblMusicNow();
  if (!now) return;
  const loop = mode === "repeat";
  if (!!now.loop === loop) return;
  await tblMusicSet({ loop, pos: tblMusicWhere(now), at: Date.now() });
}
/* PUT ONE AT THE BACK OF THE QUEUE. Playing something does not touch the queue and queueing something
   does not interrupt what is playing — they are two different questions and the panel asks both. */
async function tblMusicQueueAdd(id) {
  if (tbl.role !== "dm") return;
  if (!(tblMusicData().tracks || {})[id]) return;
  await CocLive.put(tblPath("music/queue"), tblMusicQueue().concat(id));
  paintSide();
}
/* PUT THIS TRACK THERE — the only function that writes `folder` and `order`, whether the row was dragged
   or an arrow was pressed. Both groups are renumbered whole, so a move can never leave a hole in the one
   it came from or two tracks fighting over the same place in the one it went to. */
async function tblMusicPlace(id, folder, index) {
  if (tbl.role !== "dm") return;
  const shelf = tblMusicData().tracks || {};
  if (!shelf[id]) return;
  const folders = tblMusicData().folders || {};
  const from = shelf[id].folder && folders[shelf[id].folder] ? shelf[id].folder : "";
  const to = folder && folders[folder] ? folder : "";
  const dest = tblMusicGroup(to).map(([tid]) => tid).filter((tid) => tid !== id);
  const at = Math.max(0, Math.min(dest.length, Number(index) == null ? dest.length : Number(index)));
  dest.splice(at, 0, id);
  const patch = {};
  dest.forEach((tid, i) => { patch[tid + "/order"] = i; patch[tid + "/folder"] = to || null; });
  if (from !== to) {
    tblMusicGroup(from).map(([tid]) => tid).filter((tid) => tid !== id)
      .forEach((tid, i) => { patch[tid + "/order"] = i; });
  }
  await CocLive.patch(tblPath("music/tracks"), patch);
  paintSide();
}
async function tblMusicFolderAdd(name) {
  if (tbl.role !== "dm") return;
  const title = String(name || "").trim().slice(0, 40);
  if (!title) return tblMusicSay("Give the folder a name.", " bad");
  const order = tblMusicFolders().length;
  await CocLive.push(tblPath("music/folders"), { name: title, order, at: Date.now() });
  tblMusicSay("");
  const box = $("#music-folder");
  if (box) box.value = "";
  paintSide();
}
async function tblMusicFolderRename(id) {
  if (tbl.role !== "dm") return;
  const box = $("#music-rename-" + id);
  const name = String((box && box.value) || "").trim().slice(0, 40);
  if (!name) return;
  await CocLive.patch(tblPath("music/folders/" + id), { name });
  tbl.ui.musicRename = "";
  paintSide();
}
/* DELETING A FOLDER NEVER DELETES MUSIC. Its tracks come out loose — a folder is a way of arranging the
   shelf, and losing an evening's playlist to a mis-tap on the wrong row is not a trade worth making. */
async function tblMusicFolderDrop(id) {
  if (tbl.role !== "dm") return;
  const inside = tblMusicGroup(id).map(([tid]) => tid);
  const loose = tblMusicGroup("").length;
  const patch = {};
  inside.forEach((tid, i) => { patch[tid + "/folder"] = null; patch[tid + "/order"] = loose + i; });
  if (inside.length) await CocLive.patch(tblPath("music/tracks"), patch);
  await CocLive.del(tblPath("music/folders/" + id));
  paintSide();
}
async function tblMusicFolderMove(id, by) {
  if (tbl.role !== "dm") return;
  const ids = tblMusicFolders().map(([fid]) => fid);
  const at = ids.indexOf(id);
  const to = at + Number(by);
  if (at < 0 || to < 0 || to >= ids.length) return;
  ids.splice(to, 0, ids.splice(at, 1)[0]);
  const patch = {};
  ids.forEach((fid, i) => { patch[fid + "/order"] = i; });
  await CocLive.patch(tblPath("music/folders"), patch);
  paintSide();
}
/* Used when a whole disk folder is added: the app folder is made to match, so somebody who organises on
   disk gets the same arrangement in the app without doing it twice. */
async function tblMusicFolderFor(name) {
  const want = String(name || "").trim();
  if (!want) return "";
  const found = tblMusicFolders().find(([, f]) => (f.name || "").toLowerCase() === want.toLowerCase());
  if (found) return found[0];
  return await CocLive.push(tblPath("music/folders"),
    { name: want.slice(0, 40), order: tblMusicFolders().length, at: Date.now() });
}

/* A WHOLE FOLDER, QUEUED IN ONE PRESS. This is the thing the folders are FOR: the backstage set goes in
   as a set, in the order it is listed, and the DM does not touch the panel again for that scene. */
async function tblMusicQueueFolder(folder) {
  if (tbl.role !== "dm") return;
  const ids = tblMusicGroup(folder).map(([id]) => id);
  if (!ids.length) return;
  await CocLive.put(tblPath("music/queue"), tblMusicQueue().concat(ids));
  paintSide();
}
async function tblMusicQueueMove(id, by) {
  if (tbl.role !== "dm") return;
  const q = tblMusicQueue();
  const at = q.indexOf(id);
  const to = at + Number(by);
  if (at < 0 || to < 0 || to >= q.length) return;
  q.splice(to, 0, q.splice(at, 1)[0]);
  await CocLive.put(tblPath("music/queue"), q);
  paintSide();
}
/* By POSITION, not by id: the same track may sit in the queue twice, and removing "the third one"
   should remove the third one rather than the first that happens to match. */
async function tblMusicQueueDrop(at) {
  if (tbl.role !== "dm") return;
  const q = tblMusicQueue();
  const i = Number(at);
  if (!(i >= 0 && i < q.length)) return;
  q.splice(i, 1);
  await CocLive.put(tblPath("music/queue"), q.length ? q : null);
  paintSide();
}
async function tblMusicQueueClear() {
  if (tbl.role !== "dm") return;
  await CocLive.put(tblPath("music/queue"), null);
  paintSide();
}

/* THE NEXT ONE, and only the DM's browser ever calls it. Five devices all noticing the end of a track
   and all writing the next one is five different tracks starting at once; the chair decides, everybody
   else follows `now` as they already do. Skips ids whose track has since been deleted rather than
   stalling the room on one. */
/* WHAT THE END OF A TRACK MEANS, in one place. There is a next one, or the room goes quiet — and the
   quiet has to be WRITTEN. Leaving a finished track in `now` with `playing: true` says "playing" in the
   panel under a title nobody can hear, and leaves every device's clock walking past the end of a track
   that stopped minutes ago; on YouTube that was a tail replayed for ever. The three ways in (`ended`,
   YouTube's state change, the tick) all come through here. */
/* WHAT PLAYS AFTER THIS ONE WHEN THE QUEUE IS EMPTY. Kayki, mid-session: "the musics isnt working the
   queue, once it finishs it stops fully… just put it working."
   It was doing what it was told — an empty queue meant silence — and that is not what a folder called
   "Main Stage" is for. A track that ends now hands over to the NEXT TRACK IN ITS OWN GROUP: the folder
   it sits in, in the order the DM arranged, wrapping round to the top so a scene keeps its music for as
   long as the scene lasts. The queue still wins when there is one; this is only what happens after it.
   A group of ONE does not wrap — repeating a single track for ever is a thing to ask for (the loop
   switch on the row), not a thing to be given. */
function tblMusicFollowOn(id) {
  const shelf = tblMusicData().tracks || {};
  const t = shelf[id];
  if (!t) return "";
  const folders = tblMusicData().folders || {};
  const group = tblMusicGroup(t.folder && folders[t.folder] ? t.folder : "").map(([tid]) => tid);
  if (group.length < 2) return "";
  const at = group.indexOf(id);
  if (at < 0) return "";
  return group[(at + 1) % group.length];
}

async function tblMusicEnded() {
  if (tbl.role !== "dm" || mus.advancing || !tblMusicOver()) return;
  if (tblMusicQueue().length) return tblMusicNext();
  const now = tblMusicNow();
  const after = now && now.trackId ? tblMusicFollowOn(now.trackId) : "";
  if (after) {
    mus.advancing = true;
    try { await tblMusicPlay(after); } finally { mus.advancing = false; }
    return;
  }
  mus.advancing = true;
  try { await tblMusicStop(); } finally { mus.advancing = false; }
}

async function tblMusicNext() {
  if (tbl.role !== "dm" || mus.advancing) return;
  mus.advancing = true;
  try {
    const q = tblMusicQueue();
    if (!q.length) { await tblMusicStop(); return; }
    const [head, ...rest] = q;
    await CocLive.put(tblPath("music/queue"), rest.length ? rest : null);
    await tblMusicPlay(head);
  } finally { mus.advancing = false; }
}

async function tblMusicDropTrack(id) {
  if (tbl.role !== "dm") return;
  const t = (tblMusicData().tracks || {})[id];
  const now = tblMusicNow();
  if (now && now.trackId === id) await tblMusicStop();
  await CocLive.del(tblPath("music/tracks/" + id));
  /* And out of the queue. Reading it already filters ids with no track behind them, so this is not
     correctness — it is not leaving dead ids in the database to accumulate for the life of the room. */
  const left = tblMusicQueue().filter((q) => q !== id);
  if (left.length !== tblMusicQueue().length) await CocLive.put(tblPath("music/queue"), left.length ? left : null);
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

/* A COMMITTED TRACK NEEDS NO FORM. There is nothing to validate — the build listed it, so it exists —
   and the filename is the name, which is why the README asks for filenames a DM can pick from. */
async function tblMusicAddRepo(file) {
  if (tbl.role !== "dm" || !file) return;
  await tblMusicSaveTrack({ kind: "repo", src: file, title: file.split("/").pop().replace(/\.[^.]+$/, "") });
}
/* Every file in one folder, or — with no folder named — everything that is not on the shelf yet. */
async function tblMusicAddAllRepo(folder) {
  if (tbl.role !== "dm") return;
  const want = tblRepoMusicLeft().filter((f) => !folder || tblMusicDiskFolder(f) === folder);
  // A disk folder becomes an app folder of the same name, so organising in music/ and organising in the
  // app give the same answer rather than two arrangements to keep in step.
  const into = folder ? await tblMusicFolderFor(tblMusicDiskName(folder)) : "";
  let n = tblMusicGroup(into).length;
  for (const f of want) {
    await CocLive.push(tblPath("music/tracks"), { at: Date.now(), kind: "repo", src: f,
      title: f.split("/").pop().replace(/\.[^.]+$/, ""), folder: into || null, order: n++ });
  }
  tblMusicSay("Added.", " good");
  paintSide();
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
  ["repo", "From the repo", "a file committed into music/ — no cap, loads fast"],
  ["youtube", "YouTube", "a link — the audio only, no video on screen"],
  ["link", "A direct link", "an address ending .mp3, .ogg or .m4a"],
  ["device", "From this device", `a file, up to ${TBL_MUSIC_MAX / 1048576} MB — everyone downloads it`],
];
const TBL_MUSIC_WORDS = { repo: "in the repo", youtube: "YouTube", link: "a link", file: "the DM's file" };

/* What is committed in music/ and not already on this table's shelf. */
function tblRepoMusicLeft() {
  const have = new Set(Object.values(tblMusicData().tracks || {})
    .filter((t) => t.kind === "repo").map((t) => t.src));
  return (tblRepoMusic || []).filter((f) => !have.has(f));
}

function repoMusicHTML() {
  if (tblRepoMusic === null) {
    tblLoadRepoMusic();
    return `<p class="muted">Looking in music/…</p>`;
  }
  if (!tblRepoMusic.length) {
    return `<p class="muted">Nothing in <strong>music/</strong> yet. Commit audio files into that folder
      at the root of the repo, push, and they appear here for every device — no cap, nothing stored in
      the database, and they keep working once a browser has them.</p>`;
  }
  const left = tblRepoMusicLeft();
  if (!left.length) return `<p class="muted">Everything in <strong>music/</strong> is already on the
    shelf above.</p>`;
  /* WHY A DELETED TRACK TURNS UP HERE AGAIN, said on the screen where it happens. Kayki: "when i delete
     something from the track, it just go back to the loose." Delete takes a track off THIS TABLE; the mp3
     is committed in the repo and no browser can remove it, so it rejoins the list of files not yet on the
     shelf. Nothing was moved and nothing was kept — but from the panel it looks like both. */
  const why = `<p class="muted">These are files committed in <strong>music/</strong>. Deleting one from
    the shelf above only takes it off this table — the file stays in the repo and comes back to this
    list, ready to be added again.</p>`;
  return why + tblMusicByFolder(left, tblMusicDiskFolder).map(([folder, files]) => `
    <p class="panel-sub">${esc(tblMusicDiskName(folder))}
      <span class="muted">— ${esc(files.length)} track${files.length === 1 ? "" : "s"}</span></p>
    <div class="scene-list">${files.map((f) => `<div class="scene-row">
      <span class="scene-static"><strong>${esc(f.split("/").pop().replace(/\.[^.]+$/, ""))}</strong>
        <span class="muted">${esc(f)}</span></span>
      <button class="btn-quiet" data-tbl="music-repo-add" data-val="${esc(f)}">Add</button>
    </div>`).join("")}</div>
    ${files.length > 1
      ? `<button class="btn-quiet" data-tbl="music-repo-all" data-val="${esc(folder)}">Add all ${files.length}</button>`
      : ""}`).join("");
}

function musicPanelHTML() {
  const now = tblMusicNow();
  const vol = Math.round(tblMusicVol() * 100);
  const muted = tblMusicMuted();
  const silent = tblMusicSilent();
  const kind = tbl.ui.musicKind || "repo";
  const tracks = tblMusicTracks();
  const shelf = tblMusicData().tracks || {};
  const queue = tbl.role === "dm" ? tblMusicQueue() : [];

  const nowLine = now
    ? `<p class="music-now"><strong>${esc(now.title || "Untitled")}</strong>
        <span class="muted">${esc(now.playing ? "playing" : "paused")}${now.loop ? " · on a loop" : ""}
        · ${esc(TBL_MUSIC_WORDS[now.kind] || now.kind)}</span></p>`
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
        <span class="music-pct">${silent ? "silent" : esc(vol) + "%"}</span>
      </div>
    </section>`;

  /* A PLAYER IS TOLD WHAT IS PLAYING AND NOTHING ELSE — not the shelf, and not what is coming. Kayki:
     "only dm has access to the queued musics, the players can see what is playing." Knowing the next
     three tracks is knowing there are three fights left. */
  if (tbl.role !== "dm") {
    return `<section class="panel"><h2>Music</h2>${nowLine}
      <p class="muted">The DM chooses what plays. How loud it is, is yours.</p></section>${gate}${mine}`;
  }

  const upNext = queue.length
    ? `<div class="scene-list">${queue.map((id, i) => `<div class="scene-row">
        <span class="stepper">
          <button class="step-btn" data-tbl="music-q-up" data-val="${esc(id)}" title="Sooner"
            ${i === 0 ? "disabled" : ""}>&uarr;</button>
          <button class="step-btn" data-tbl="music-q-down" data-val="${esc(id)}" title="Later"
            ${i === queue.length - 1 ? "disabled" : ""}>&darr;</button>
        </span>
        <span class="scene-static"><strong>${esc(i + 1)}. ${esc((shelf[id] || {}).title || "Untitled")}</strong>
          <span class="muted">${esc(TBL_MUSIC_WORDS[(shelf[id] || {}).kind] || "")}</span></span>
        <button class="btn-quiet" data-tbl="music-q-drop" data-val="${esc(i)}">Remove</button>
      </div>`).join("")}</div>
      <button class="btn-quiet" data-tbl="music-q-clear">Empty the queue</button>`
    : `<p class="muted">Nothing queued. Add tracks below and they play one after another, without you
        touching anything mid-fight.</p>`;

  /* A ROW IS DRAGGABLE BY ITS HANDLE AND BY NOTHING ELSE. Dragging from the name would fight the press
     that plays it, and dragging from anywhere would fight the panel's own scroll — which on a phone is
     the gesture people actually make. What the handle cannot reach, the Move list can: drag is the quick
     way, never the only way.

     NO UP/DOWN ARROWS ON A TRACK ROW. Kayki: "remove the arrows up and down, its overwriting the music
     name which is bad." The row already carries a handle, the title, Queue, Move and Delete; a stepper on
     top of that leaves the title too little room and it runs under the buttons on a narrow panel. The
     title is the one thing on the row that has to stay readable — it is what the DM picks from — so the
     stepper is what goes. Reordering stays on the handle and the Move list. */
  const folders = tblMusicFolders();
  const moveOptions = (t) => `<select class="text mus-move" data-mus-move="${esc(t.id)}"
      aria-label="Move to a folder">
      <option value="">Move to…</option>
      ${folders.filter(([fid]) => fid !== t.folder).map(([fid, f]) =>
        `<option value="${esc(fid)}">${esc(f.name)}</option>`).join("")}
      ${t.folder ? `<option value="~loose">Out of the folder</option>` : ""}
    </select>`;
  const row = ([id, t], folder) => `<div class="scene-row mus-row ${now && now.trackId === id ? "on" : ""}"
      data-mus-row="${esc(id)}" data-mus-in="${esc(folder || "")}">
      <button class="mus-handle" data-mus-drag="${esc(id)}" title="Drag to reorder or to another folder"
        aria-label="Move ${esc(t.title || "track")}">&#8942;&#8942;</button>
      <button class="scene-pick" data-tbl="music-play" data-val="${esc(id)}">
        <strong>${esc(t.title || "Untitled")}</strong>
        <span class="muted">${esc(TBL_MUSIC_WORDS[t.kind] || t.kind)}</span>
      </button>
      <span class="mus-acts">
        <button class="btn-quiet" data-tbl="music-queue" data-val="${esc(id)}">Queue</button>
        ${folders.length ? moveOptions({ id, folder: folder || "" }) : ""}
        <button class="btn-quiet" data-tbl="music-drop" data-val="${esc(id)}">Delete</button>
      </span>
    </div>`;

  /* DELETING A TRACK ASKS FOR THE WORD, the same as deleting a creature or a character or a table. It
     sits one button from Queue on a crowded row, and for a track uploaded from a device it is the only
     copy there is — the bytes go with it.

     AND IT SAYS WHETHER THE TRACK CAN BE GOT BACK. Only a `repo` track returns to the Add list below,
     because only that one is a file in music/ that this app did not put there and cannot remove. A link
     or an upload is gone with the row — which is what Kayki met head-on: a deleted track "just
     dissapeared" instead of turning up in the list to be picked again. */
  const dropWhere = {
    repo: " It stays in <strong>music/</strong> and comes back to the Add list below.",
    file: " Its bytes go with it — this table holds the only copy.",
    youtube: " The link goes with it; it is not in <strong>music/</strong>, so it does not come back.",
    link: " The address goes with it; it is not in <strong>music/</strong>, so it does not come back.",
  };
  const dropRow = ([id, t]) => `<div class="scene-row danger armed">
      <span class="muted">Delete <strong>${esc(t.title || "Untitled")}</strong> from this table.
        ${dropWhere[t.kind] || ""} Type <strong>CONFIRM</strong>.</span>
      <div class="danger-row">
        <input id="music-drop-confirm" class="text" type="text" autocomplete="off" spellcheck="false"
          autocapitalize="characters" autocorrect="off" placeholder="CONFIRM"
          value="${esc(tbl.ui.musicDropText || "")}" />
        <button class="btn btn-hot" data-tbl="music-drop-go" data-val="${esc(id)}"
          ${tbl.ui.musicDropText === "CONFIRM" ? "" : "disabled"}>Delete permanently</button>
        <button class="btn-quiet" data-tbl="music-drop-cancel">Cancel</button>
      </div>
    </div>`;

  /* `extra` sits inside the heading line; `below` comes after it, because a rename box and a delete
     question are rows of their own — a <div> inside the heading's <p> is markup a browser closes early
     and then draws somewhere the code did not ask for. */
  const group = (fid, name, extra, below) => {
    const rows = tblMusicGroup(fid);
    /* THE FOLDER SAYS ITS OWN NAME. Kayki: "the title of the folder in the dm page need to be properly
       stated." It was the name and the count run together in the panel's small uppercase — "MAIN STAGE
       2 TRACKS" reads as one phrase, and a folder called after a scene stopped looking like a title at
       all. The name is set in the ordinary text size, in the ordinary case the DM typed it in, and the
       count is a separate clause behind a dash. */
    return `<div class="mus-folder" data-mus-folder="${esc(fid)}">
      <p class="panel-sub mus-folder-head"><span class="mus-folder-name">${esc(name)}</span>
        <span class="muted">&mdash; ${esc(rows.length)} track${rows.length === 1 ? "" : "s"}</span>${extra || ""}</p>
      ${below || ""}
      <div class="scene-list">${rows.length
        ? rows.map((r) => (tbl.ui.musicDropArm === r[0] ? dropRow(r) : row(r, fid))).join("")
        : `<p class="muted mus-empty">Empty — drag a track onto this heading, or use its Move list.</p>`}</div>
      ${rows.length ? `<button class="btn-quiet" data-tbl="music-q-folder" data-val="${esc(fid)}">Queue all ${rows.length}</button>` : ""}
    </div>`;
  };

  /* DELETING A FOLDER ASKS FIRST. It is one button along from Rename in a heading a thumb reaches for,
     and until now it went through on the first press. It does not ask for the typed word the way a track
     does — a folder holds no bytes and its music comes out loose rather than dying with it — but it does
     have to be answered, and the question says where the tracks go so the answer is an informed one. */
  const folderDropRow = (fid, name, n) => `<div class="danger-row armed">
      <span class="muted">Delete the folder <strong>${esc(name)}</strong>?${n
        ? ` Its ${n} track${n === 1 ? "" : "s"} move to <strong>Not in a folder</strong> — no music is lost.`
        : ""}</span>
      <button class="btn btn-hot" data-tbl="music-f-drop-go" data-val="${esc(fid)}">Delete the folder</button>
      <button class="btn-quiet" data-tbl="music-f-drop-cancel">Cancel</button>
    </div>`;

  const folderBlocks = folders.map(([fid, f], i) => group(fid, f.name || "Untitled",
    `<span class="mus-folder-acts">
      <span class="stepper">
        <button class="step-btn" data-tbl="music-f-up" data-val="${esc(fid)}" ${i === 0 ? "disabled" : ""}>&uarr;</button>
        <button class="step-btn" data-tbl="music-f-down" data-val="${esc(fid)}" ${i === folders.length - 1 ? "disabled" : ""}>&darr;</button>
      </span>
      <button class="btn-quiet" data-tbl="music-f-rename" data-val="${esc(fid)}">Rename</button>
      <button class="btn-quiet" data-tbl="music-f-drop" data-val="${esc(fid)}">Delete folder</button>
    </span>`,
    (tbl.ui.musicRename === fid ? `<div class="danger-row">
        <input id="music-rename-${esc(fid)}" class="text" type="text" maxlength="40" value="${esc(f.name || "")}" />
        <button class="btn" data-tbl="music-f-save" data-val="${esc(fid)}">Save the name</button>
        <button class="btn-quiet" data-tbl="music-f-cancel">Cancel</button>
      </div>` : "")
    + (tbl.ui.musicFolderArm === fid
      ? folderDropRow(fid, f.name || "Untitled", tblMusicGroup(fid).length) : ""))).join("");

  const list = tracks.length || folders.length
    ? folderBlocks + group("", "Not in a folder", "")
      + `<div class="save-row">
          <input id="music-folder" class="text" type="text" maxlength="40" placeholder="Main Stage" />
          <button class="btn-quiet" data-tbl="music-f-add">New folder</button>
        </div>
        <p class="muted">Drag a track by its <strong>&#8942;&#8942;</strong> handle to reorder it, or onto
          another folder's heading to move it there. The Move list does the same thing without dragging.
          Deleting a folder never deletes its music — those tracks move to <strong>Not in a
          folder</strong>.</p>`
    : `<p class="muted">Nothing saved yet. Add one below and it stays on this table.</p>`;

  return `<section class="panel"><h2>Music</h2>
      ${nowLine}
      <div class="hp-controls">
        ${now ? (now.playing
          ? `<button class="btn" data-tbl="music-pause">Pause</button>`
          : `<button class="btn" data-tbl="music-resume">Play</button>`) : ""}
        ${queue.length ? `<button class="btn-quiet" data-tbl="music-next">Next &rarr;</button>` : ""}
        ${now ? `<button class="btn-quiet" data-tbl="music-stop">Stop</button>` : ""}
      </div>
      ${/* WHAT HAPPENS AT THE END, said as two buttons rather than left to be inferred from a Loop chip.
            It is the same one bit of data; what changed is that both answers are now on screen and one
            of them is always lit, so there is never a question of which the room is in. */""}
      ${now ? `<p class="panel-sub">When it ends</p>
      <div class="chips">
        <button class="chip ${now.loop ? "on" : ""}" data-tbl="music-end" data-val="repeat">Keep repeating it</button>
        <button class="chip ${now.loop ? "" : "on"}" data-tbl="music-end" data-val="next">Play the next one</button>
      </div>
      <p class="muted">${now.loop
        ? "It will go round for ever. The queue waits — a track on repeat never ends, so nothing follows it."
        : (queue.length
          ? `When it finishes, <strong>${esc((shelf[queue[0]] || {}).title || "the next one")}</strong> starts by itself.`
          : "Nothing is queued, so when it finishes the room goes quiet.")}</p>` : ""}
      <p class="muted">Everyone hears it at once. Each device plays its own copy from the source, so
        somebody joining halfway comes in where the room is.</p>
    </section>
    ${gate}${mine}
    <section class="panel">
      <p class="panel-sub">Up next <span class="muted">— yours, nobody else sees it</span></p>
      ${upNext}
    </section>
    <section class="panel">
      <p class="panel-sub">This table's tracks</p>
      ${list}
    </section>
    <section class="panel">
      <p class="panel-sub">Add one</p>
      <div class="chips">${TBL_MUSIC_KINDS.map(([k, label, note]) => chipTip(
        `<button class="chip ${kind === k ? "on" : ""}" data-tbl="music-kind" data-val="${k}">${esc(label)}</button>`,
        esc(note))).join("")}</div>
      ${kind === "repo" ? repoMusicHTML() : `
      <label class="field"><span>Name it <span class="muted">— what you will look for mid-fight</span></span>
        <input id="music-title" class="text" type="text" maxlength="60" placeholder="The Midway" /></label>
      ${kind === "device"
        ? `<label class="field"><span>Audio file</span>
            <input id="music-file" class="text" type="file" accept="audio/*" /></label>
           <p class="muted">Up to ${TBL_MUSIC_MAX / 1048576} MB, because it is kept in the table itself and
             every device downloads it on the way in. For anything longer, commit it into
             <strong>music/</strong> instead — there is no cap on those.</p>`
        : `<label class="field"><span>${kind === "youtube" ? "YouTube address" : "Direct address"}</span>
            <input id="music-url" class="text" type="url"
              placeholder="${kind === "youtube" ? "https://www.youtube.com/watch?v=…" : "https://…/track.mp3"}" /></label>
           ${kind === "youtube"
             ? `<p class="muted">Only the sound is used — the player is one pixel and off-screen. A video
                 whose owner has blocked embedding will refuse, and YouTube may play an ad first; neither
                 is something this app can do anything about.</p>`
             : `<p class="muted">It has to be the file itself, not a page with a player on it — an address
                 that ends .mp3, .ogg or .m4a.</p>`}`}
      <button class="btn" data-tbl="music-add">Add it</button>`}
      <p id="music-msg" class="save-msg">${esc(mus.msg)}</p>
    </section>`;
}


/* ---------------------------------------------------------------- dragging a row
 *
 * POINTER EVENTS, NOT HTML5 DRAG-AND-DROP. `draggable` does not exist under a finger at all, and half
 * this table is played on a phone — the board learned that lesson the hard way and it is written down in
 * RULES.md. So this is the same shape as the board's own drag: pointerdown on a HANDLE (never on the
 * row, which would fight the press that plays a track and the swipe that scrolls the panel), a few
 * pixels of slop before anything counts as a drag, and handlers on the window so a release outside the
 * panel is still a release.
 *
 * The drop target is read with `elementFromPoint` rather than tracked with enter/leave events, because
 * a pointer that is CAPTURED sends every move to the handle and to nothing else — enter and leave never
 * fire on the rows at all.
 */
const TBL_MUS_SLOP = 6;         // pixels before a press becomes a drag
let musDrag = null;             // { id, from, x, y, live, ghost, over }

function musDragClear() {
  musEdgeStop();
  document.querySelectorAll(".drop-into, .drop-before").forEach((n) =>
    n.classList.remove("drop-into", "drop-before"));
  if (musDrag && musDrag.ghost) musDrag.ghost.remove();
  musDrag = null;
}

/* Where a release would put it: a folder heading means "into that folder, at the end"; a row means
   "in that row's folder, at its place". */
function musDropTarget(x, y) {
  const el = document.elementFromPoint(x, y);
  if (!el || !el.closest) return null;
  const row = asEl(el.closest("[data-mus-row]"));
  if (row && row.dataset && row.dataset.musRow !== musDrag.id) {
    const box = row.getBoundingClientRect();
    const rows = [...row.parentElement.querySelectorAll("[data-mus-row]")];
    let at = rows.indexOf(row);
    if (y > box.top + box.height / 2) at += 1;              // dropped on the lower half: after it
    return { node: row, folder: row.dataset.musIn || "", index: at, how: "before" };
  }
  const folder = asEl(el.closest("[data-mus-folder]"));
  if (folder && folder.dataset) {
    const head = folder.querySelector(".mus-folder-head") || folder;
    return { node: head, folder: folder.dataset.musFolder || "", index: null, how: "into" };
  }
  return null;
}

window.addEventListener("pointerdown", (e) => {
  const handle = evTarget(e).closest ? evTarget(e).closest("[data-mus-drag]") : null;
  if (!handle || !tbl || tbl.role !== "dm") return;
  e.preventDefault();               // or the browser starts its own selection/scroll gesture
  musDrag = { id: handle.dataset.musDrag, x: e.clientX, y: e.clientY, live: false, ghost: null, over: null };
  try { handle.setPointerCapture(e.pointerId); } catch { /* not all engines, and it still works */ }
});

window.addEventListener("pointermove", (e) => {
  if (!musDrag) return;
  if (!musDrag.live) {
    if (Math.hypot(e.clientX - musDrag.x, e.clientY - musDrag.y) < TBL_MUS_SLOP) return;
    musDrag.live = true;
    const src = document.querySelector(`[data-mus-row="${musDrag.id}"] .scene-pick strong`);
    const ghost = document.createElement("div");
    ghost.className = "mus-ghost";
    ghost.textContent = (src && src.textContent) || "Track";
    document.body.appendChild(ghost);
    musDrag.ghost = ghost;
  }
  musDrag.ghost.style.transform = `translate(${e.clientX + 12}px, ${e.clientY - 10}px)`;
  document.querySelectorAll(".drop-into, .drop-before").forEach((n) =>
    n.classList.remove("drop-into", "drop-before"));
  const hit = musDropTarget(e.clientX, e.clientY);
  musDrag.over = hit;
  if (hit) hit.node.classList.add(hit.how === "into" ? "drop-into" : "drop-before");
  musEdgeScroll(e.clientY);
});

/* THE PANEL SCROLLS, AND THE FOLDER YOU WANT IS OFTEN BELOW THE FOLD. Found by measuring rather than by
   thinking: with two folders open the second one's heading sat at y=1042 in an 850px window, so there was
   no way to reach it at all — you cannot drop onto something that is not on screen.
 *
 * On a TIMER, not on pointermove. The first version crept 12px per move event, which meant it only
 * scrolled while your hand was still travelling: park at the edge and hold, which is exactly what
 * everyone does, and it sat there. Held near an edge it now keeps going until you leave it or let go. */
let musScroll = null;
function musEdgeScroll(y) {
  const side = document.querySelector("#vtt-side");
  if (!side) return;
  const box = side.getBoundingClientRect();
  const near = 70;
  const dir = y < box.top + near ? -1 : y > box.bottom - near ? 1 : 0;
  if (!dir) { musEdgeStop(); return; }
  if (musScroll && musScroll.dir === dir) return;
  musEdgeStop();
  musScroll = { dir, id: setInterval(() => {
    if (!musDrag) { musEdgeStop(); return; }
    side.scrollTop += dir * 14;
  }, 16) };
}
function musEdgeStop() {
  if (musScroll) { clearInterval(musScroll.id); musScroll = null; }
}

window.addEventListener("pointerup", () => {
  if (!musDrag) return;
  const { id, live, over } = musDrag;
  musDragClear();
  // A press that never became a drag is just a press; it must not move anything.
  if (!live || !over) return;
  tblMusicPlace(id, over.folder, over.index == null ? tblMusicGroup(over.folder).length : over.index)
    .catch(tblFail);
});
window.addEventListener("pointercancel", () => musDragClear());

/* The Move list, which is the same write without the gesture. */
document.addEventListener("change", (e) => {
  const t = evTarget(e).closest ? evTarget(e).closest("[data-mus-move]") : null;
  if (!t || !tbl || tbl.role !== "dm") return;
  const id = t.dataset.musMove;
  const to = t.value;
  t.value = "";
  if (!to) return;
  tblMusicPlace(id, to === "~loose" ? "" : to, tblMusicGroup(to === "~loose" ? "" : to).length)
    .catch(tblFail);
});
