/*
 * Circus of Chaos — the table: a live session everyone sits in at once.
 *
 * One tab instead of three. The map, the tokens, the dice, the turn order and your own character
 * sheet are all here, and every one of them is shared through CocLive (see live.js) so a token
 * dragged on a phone moves on the DM's laptop as it moves.
 *
 * TWO CODES, and they are not the same thing:
 *   room code  — six digits, the address of the session. Anyone who has it can walk in.
 *   DM key     — six digits the DM chooses when creating the table. Typing it turns THIS browser
 *                into the DM. It is stored only as a hash, and it locks the interface, not the data:
 *                the database rules cannot check it without real accounts, so a determined player
 *                could get round it. Same trade as a character code, said out loud in the UI.
 *
 * WHY THIS FILE DOES NOT USE paint(). The sheet repaints its whole view on every change, which is
 * right for a document and fatal for a board: a repaint mid-drag drops the token you are holding.
 * So the shell is rendered once and the live pieces are patched in place — tokens are diffed against
 * the DOM, the log is appended to. Every render function here says which of the two it is.
 */

/* ---------------------------------------------------------------- keys, codes and identity */

const TBL_RECENT = "coc:table:recent";
const tblDmKey = (code) => "coc:table:dm:" + code;
const tblMeKey = (code) => "coc:table:me:" + code;

/* A six-digit room code, suggested rather than demanded — the same shape as a character code, since
   players already know how to type one of those. */
function tblSuggestCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

/* The DM key is stored hashed, never in the clear, because anyone with the room code can read the
   table's data. The algorithm is written into the stored value ("sha256:...") so a browser that
   verifies later computes the same one the creator used — otherwise a device without WebCrypto would
   compute a different hash and lock the real DM out of their own table. */
async function tblHashKey(key) {
  const text = "coc-dm:" + String(key);
  const subtle = (typeof crypto !== "undefined" && crypto.subtle) ? crypto.subtle : null;
  if (subtle) {
    const bytes = new TextEncoder().encode(text);
    const digest = await subtle.digest("SHA-256", bytes);
    const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
    return "sha256:" + hex;
  }
  // No WebCrypto (http:// on an old browser, or a bare test environment). A weak hash is still
  // better than storing the digits, and the prefix keeps the two kinds from being compared.
  let h1 = 0x811c9dc5, h2 = 0x01000193;
  for (let i = 0; i < text.length; i++) {
    h1 = (h1 ^ text.charCodeAt(i)) >>> 0; h1 = (h1 * 0x01000193) >>> 0;
    h2 = (h2 + text.charCodeAt(i) * (i + 7)) >>> 0;
  }
  return "fnv:" + h1.toString(16) + h2.toString(16);
}
async function tblKeyMatches(key, stored) {
  if (!stored) return false;
  const algo = String(stored).split(":")[0];
  const mine = await tblHashKey(key);
  if (mine.split(":")[0] === algo) return mine === stored;
  // Stored with an algorithm this browser cannot compute: refuse rather than guess.
  return false;
}

/* Who this browser is at this table. Kept locally: a name and a character code are not secrets, and
   re-typing them every time you refresh mid-fight would be its own kind of insult. */
function tblMe(code) {
  try {
    const raw = JSON.parse(localStorage.getItem(tblMeKey(code)) || "null");
    if (raw && raw.clientId) return raw;
  } catch { /* fall through */ }
  return { clientId: "c" + Math.random().toString(36).slice(2, 9), name: "", charCode: "" };
}
function tblSaveMe(code, me) {
  localStorage.setItem(tblMeKey(code), JSON.stringify(me));
}
function tblIsDm(code) { return localStorage.getItem(tblDmKey(code)) === "1"; }

function tblRecent() {
  try { return JSON.parse(localStorage.getItem(TBL_RECENT) || "[]"); } catch { return []; }
}
function tblRemember(code, name) {
  const list = tblRecent().filter((r) => r.code !== code);
  list.unshift({ code, name: name || "", at: Date.now() });
  localStorage.setItem(TBL_RECENT, JSON.stringify(list.slice(0, 6)));
}

/* ---------------------------------------------------------------- session state */

/* Everything about the table currently open. `data` mirrors the database; `view` is where the camera
   is; `drag` is what a finger is currently doing. None of it is saved: it is either derived from the
   live data or it belongs to this screen alone. */
let tbl = null;

const TBL_DEFAULT_SCENE = { name: "Blank grid", image: "", cols: 30, rows: 20, cell: 70 };

function tblFresh(code, role) {
  return {
    code, role,
    me: tblMe(code),
    data: { meta: null, scenes: null, tokens: null, log: null, presence: null, handouts: null, dm: null, notes: null },
    view: { x: 0, y: 0, z: 1 },
    drag: null,
    offs: [],          // live subscriptions, closed on teardown
    beat: null,        // presence heartbeat
    pointers: new Map(),
    centredOnMe: false,     // the camera has been aimed at this player's own figure, once
    cameraIsYours: false,   // …and after that, only you move it
    ui: { panel: "", error: "" },
  };
}

const tblPath = (rest) => "tables/" + tbl.code + (rest ? "/" + rest : "");
function tblScene() {
  const meta = tbl.data.meta || {};
  const scenes = tbl.data.scenes || {};
  return scenes[meta.activeScene] || scenes[Object.keys(scenes)[0]] || TBL_DEFAULT_SCENE;
}
function tblSceneId() {
  const meta = tbl.data.meta || {};
  const scenes = tbl.data.scenes || {};
  return scenes[meta.activeScene] ? meta.activeScene : Object.keys(scenes)[0] || "";
}
function tblTokens() { return tbl.data.tokens || {}; }
/* The DM moves anything. A player moves the token their own character code owns, and nothing else. */
function tblCanMove(token) {
  if (!token) return false;
  if (tbl.role === "dm") return true;
  return tblIsMine(token);
}
/* Whose figure this is. A Circus of Chaos player is identified by their character code; anyone playing
   another system has no code, so the browser that placed the figure owns it. Both, because one table
   can hold both kinds of player. */
function tblIsMine(token) {
  if (!token) return false;
  if (token.charCode && tbl.me.charCode) return token.charCode === tbl.me.charCode;
  return !!token.owner && token.owner === tbl.me.clientId;
}

/* ---------------------------------------------------------------- routing */

function routeTable(arg) {
  const code = String(arg || "").replace(/\D/g, "").slice(0, 6);
  if (!CocStore.validCode(code)) { tblTeardown(); renderTableLanding(); return; }
  if (tbl && tbl.code === code) { return; }   // already sitting at this table; nothing to redo
  tblTeardown();
  tblOpen(code);
}

/* Leaving the table has to close the streams and stop the heartbeat. Nothing tells a route function
   that it is being left, so the hash is watched directly. */
function tblTeardown() {
  if (!tbl) return;
  for (const off of tbl.offs) { try { off(); } catch { /* already closed */ } }
  if (tbl.beat) clearInterval(tbl.beat);
  // Announce the exit so the others do not stare at a ghost for a minute.
  if (tbl.me && tbl.me.clientId) CocLive.del(tblPath("presence/" + tbl.me.clientId)).catch(() => {});
  CocLive.flush();
  if (typeof closeSheetPanel === "function" && tbl.ui && tbl.ui.panel === "sheet") closeSheetPanel();
  tbl = null;
}
if (typeof window !== "undefined") {
  // A phone turning sideways, or a flex layout settling a frame after the markup is written, are the
  // same event as far as the camera is concerned: the window is a different shape, so fit again.
  let refitTimer = null;
  window.addEventListener("resize", () => {
    if (!tbl) return;
    clearTimeout(refitTimer);
    refitTimer = setTimeout(() => {
      if (!tbl) return;
      // Crossing the width where the dice change homes has to move them, or they end up in neither.
      paintDock();
      if (tbl.ui.panel === "dice" && tblWide()) { tbl.ui.panel = ""; paintSide(); }
      if (!tbl.cameraIsYours) tblFit();
    }, 120);
  });
  window.addEventListener("hashchange", () => {
    if (!tbl) return;
    if (!/^#\/table\/\d{6}/.test(location.hash)) tblTeardown();
  });
}

/* ---------------------------------------------------------------- the landing page */

/* This one DOES use paint(): it is a form, not a board. */
function renderTableLanding() {
  const recent = tblRecent();
  const suggested = tblSuggestCode();
  paint(`
    <div class="tool-head">
      <a class="back" href="#/">&larr; Menu</a>
      <h1>Play at a table</h1>
      <p class="muted">${esc(CocLive.describe())}</p>
    </div>
    <section class="panel">
      <h2>Join a session</h2>
      <p class="muted">The room code your DM gives you (six digits), and a name to be known by. A
        Circus of Chaos character code — also six digits — is optional: with one, your sheet comes with
        you and every number on it is a die you can throw. Without one you get a figure, the dice and
        the map, which is all you need to play anything else.</p>
      <div class="join-row">
        <label class="field"><span>Room code</span>
          <input id="tbl-room" class="text code-input" type="text" inputmode="numeric"
            maxlength="6" placeholder="482910" autocomplete="off" /></label>
        <label class="field"><span>Your name</span>
          <input id="tbl-name-in" class="text" type="text" maxlength="30" placeholder="Kayki" autocomplete="off" /></label>
        <label class="field"><span>Character code <span class="muted">optional</span></span>
          <input id="tbl-char" class="text code-input" type="text" inputmode="numeric"
            maxlength="6" placeholder="123456" autocomplete="off" /></label>
        <button class="btn" data-tbl="join">Sit down</button>
      </div>
      <p id="tbl-msg" class="save-msg"></p>
    </section>
    <section class="panel">
      <h2>Run a session</h2>
      <p class="muted">You are the DM: you own the maps, you move anything, and you hand the room
        code to your players. Pick a room code and a DM key — the key is what makes a browser the
        DM, so keep it to yourself and do not lose it.</p>
      <p class="muted">It works for any system. Players with a Circus of Chaos character code bring
        their sheet and can roll every number on it; players without one get a figure they keep their
        own name and hit points on. Nothing here assumes which you are.</p>
      <div class="join-row">
        <label class="field"><span>Table name</span>
          <input id="tbl-name" class="text" type="text" maxlength="60" placeholder="The Big Top" /></label>
        <label class="field"><span>Room code</span>
          <input id="tbl-newroom" class="text code-input" type="text" inputmode="numeric"
            maxlength="6" value="${esc(suggested)}" autocomplete="off" /></label>
        <label class="field"><span>DM key</span>
          <input id="tbl-dmkey" class="text code-input" type="text" inputmode="numeric"
            maxlength="6" placeholder="six digits" autocomplete="off" /></label>
        <button class="btn" data-tbl="create">Open the tent</button>
      </div>
      <p class="muted">The DM key locks the controls, not the data — anyone holding the room code
        could get round it if they went looking. Fine for your table; worth knowing.</p>
    </section>
    ${recent.length ? `<section class="panel"><h2>Tables you have sat at</h2>
      <div class="recent">${recent.map((r) => `<div class="recent-row">
        <a class="recent-open" href="#/table/${esc(r.code)}">
          <strong>${esc(r.code)}</strong>
          <span class="muted">${esc(r.name || "unnamed table")}</span>
          ${tblIsDm(r.code) ? `<span class="role-badge">DM</span>` : ""}
        </a>
        <button class="btn-quiet" data-tbl="forget" data-val="${esc(r.code)}">Forget</button>
        </div>`).join("")}</div>
      <p class="muted">Forget takes a table off this device's list. To delete a room for everybody, open
        it as the DM and close it there.</p></section>` : ""}
  `);
}

async function tblCreate() {
  const msg = $("#tbl-msg");
  const name = ($("#tbl-name") || {}).value || "";
  const room = String(($("#tbl-newroom") || {}).value || "").replace(/\D/g, "");
  const key = String(($("#tbl-dmkey") || {}).value || "").replace(/\D/g, "");
  const say = (text, bad) => { if (msg) { msg.textContent = text; msg.className = "save-msg" + (bad ? " bad" : ""); } };
  if (!CocStore.validCode(room)) return say("A room code is exactly six digits.", true);
  if (!CocStore.validCode(key)) return say("A DM key is exactly six digits.", true);
  say("Opening…");
  try {
    const existing = await CocLive.get("tables/" + room + "/meta");
    if (existing) return say("Room " + room + " is already in use — pick another code.", true);
    const sceneId = CocLive.newId();
    await CocLive.put("tables/" + room, {
      meta: {
        name: name.slice(0, 60) || "Untitled table",
        createdAt: Date.now(),
        dmHash: await tblHashKey(key),
        activeScene: sceneId,
      },
      scenes: { [sceneId]: Object.assign({ createdAt: Date.now() }, TBL_DEFAULT_SCENE) },
    });
    localStorage.setItem(tblDmKey(room), "1");
    tblRemember(room, name);
    location.hash = "#/table/" + room;
  } catch (err) {
    say("Could not open the table: " + err.message, true);
  }
}

async function tblJoin() {
  const msg = $("#tbl-msg");
  const room = String(($("#tbl-room") || {}).value || "").replace(/\D/g, "");
  const char = String(($("#tbl-char") || {}).value || "").replace(/\D/g, "");
  const typedName = String(($("#tbl-name-in") || {}).value || "").trim().slice(0, 30);
  const say = (text, bad) => { if (msg) { msg.textContent = text; msg.className = "save-msg" + (bad ? " bad" : ""); } };
  if (!CocStore.validCode(room)) return say("A room code is exactly six digits.", true);
  // A character code is OPTIONAL, so that a table can be played with any system's sheets — or none.
  // Six digits or nothing; half a code is a typo, and joining as a guest by accident is worse than
  // being told.
  if (char && !CocStore.validCode(char)) return say("A character code is six digits, or leave it empty to join without one.", true);
  if (!char && !typedName) return say("Type a name, so the table knows who you are.", true);
  say("Knocking…");
  try {
    const meta = await CocLive.get("tables/" + room + "/meta");
    if (!meta) return say("No table is open under " + room + ". Check the code with your DM.", true);
    let ch = null;
    if (char) {
      ch = await CocStore.load(char);
      if (!ch) return say("No character is saved under " + char + ".", true);
    }
    const me = tblMe(room);
    me.charCode = char || "";
    me.name = (ch && ch.name) || typedName || "Someone";
    tblSaveMe(room, me);
    tblRemember(room, meta.name);
    location.hash = "#/table/" + room;
  } catch (err) {
    say("Could not join: " + err.message, true);
  }
}

/* Taking the DM chair on a device that is not the one the table was made on — a new laptop, a phone,
   a cleared browser. This is the only reason the key is stored at all: without it, losing your browser
   would mean losing the ability to run your own table. */
async function tblClaimDm(code, key) {
  const meta = await CocLive.get("tables/" + code + "/meta");
  if (!meta) throw new Error("No table is open under " + code + ".");
  if (!(await tblKeyMatches(key, meta.dmHash))) throw new Error("That is not the DM key for this table.");
  localStorage.setItem(tblDmKey(code), "1");
  return true;
}

async function tblClaimFromPanel() {
  const msg = $("#claim-msg");
  const say = (t, bad) => { if (msg) { msg.textContent = t; msg.className = "save-msg" + (bad ? " bad" : ""); } };
  const key = String(($("#claim-key") || {}).value || "").replace(/\D/g, "");
  if (!CocStore.validCode(key)) return say("A DM key is six digits.", true);
  try {
    await tblClaimDm(tbl.code, key);
    // Reopen rather than patch the role in place: the shell, the panels and every permission check
    // read the role, and half of them are only rendered once.
    const code = tbl.code;
    tblTeardown();
    tblOpen(code);
  } catch (err) { say(err.message, true); }
}

function claimPanelHTML() {
  return `<section class="panel">
    <h2>Take the DM chair</h2>
    <p class="muted">If this table is yours, type the DM key you chose when you opened it. It works on
      any device — that is what it is for.</p>
    <div class="join-row">
      <label class="field"><span>DM key</span>
        <input id="claim-key" class="text code-input" type="text" inputmode="numeric" maxlength="6"
          placeholder="six digits" autocomplete="off" /></label>
      <button class="btn" data-tbl="claim">Claim it</button>
    </div>
    <p id="claim-msg" class="save-msg"></p>
  </section>`;
}

/* ---------------------------------------------------------------- opening a table */

function tblOpen(code) {
  tbl = tblFresh(code, tblIsDm(code) ? "dm" : "player");
  renderTableShell();
  /* ONE stream for the whole table, not one per branch. This is not a preference — the database is
     served over HTTP/1.1, and a browser allows about SIX connections per host. Seven open streams
     (meta, scenes, tokens, log, presence, handouts, dm) used every one of them and left nothing for
     writes: on the live site a player joined, and then their token write and their presence write
     hung forever. Nothing on screen said so; they were simply invisible to the rest of the table.
     One stream also sends LESS, because the database streams diffs — only the first event carries the
     map image, and a token moving one square is a two-line patch either way. */
  tbl.offs.push(CocLive.watch(tblPath(""), (all) => {
    if (!tbl) return;
    tbl.data = all || {};
    const first = !tbl.gotData;
    tbl.gotData = true;
    try { paintEverything(); } catch (err) { tblFail(err); }
    // Placing a figure has to wait until the board's contents are known, or a second device places a
    // second figure. But waiting for the next heartbeat meant sitting down and appearing to the table
    // up to twenty seconds later, which is how it behaved live. Try the moment the data lands.
    if (first) { tblEnsureToken(); tblStraightenTokens(); tblMigrateDmNotes(); }
  }));
  tblAnnounce();
  tbl.beat = setInterval(tblAnnounce, 20000);
}

/* Figures left between squares by a drag that was interrupted before this was fixed. The DM's browser
   straightens them once on opening the table — one client only, so two of them cannot fight over it. */
function tblStraightenTokens() {
  if (!tbl || tbl.role !== "dm") return;
  for (const [id, t] of Object.entries(tblTokens())) {
    if (!t) continue;
    const x = Math.round(Number(t.x) || 0), y = Math.round(Number(t.y) || 0);
    if (x !== t.x || y !== t.y) CocLive.patch(tblPath("tokens/" + id), { x, y }).catch(() => {});
  }
}

/* Presence is a heartbeat, not a connection: without the Firebase SDK there is no onDisconnect, so
   everyone writes "I am still here" every twenty seconds and anyone silent for a minute is gone. */
function tblAnnounce() {
  if (!tbl) return;
  CocLive.put(tblPath("presence/" + tbl.me.clientId), {
    name: tbl.me.name || (tbl.role === "dm" ? "DM" : "Player"),
    role: tbl.role,
    charCode: tbl.me.charCode || "",
    at: Date.now(),
  }).catch(() => {});
  tblEnsureToken();
}

/* Every figure at this table that is mine, oldest first — the ids sort by creation time. */
function tblMyTokens() {
  return Object.entries(tblTokens())
    .filter(([, t]) => t && tblIsMine(t))
    .map(([id]) => id)
    .sort();
}
/* Two devices joining at the same moment can each place a figure before either sees the other's. The
   owner clears up after itself: keep the oldest, drop the rest. Only the owner does this, so two
   clients cannot fight over it. */
function tblPruneMyTokens() {
  const mine = tblMyTokens();
  if (mine.length < 2) return;
  for (const id of mine.slice(1)) CocLive.del(tblPath("tokens/" + id)).catch(() => {});
  tbl.me.tokenId = mine[0];
}

/* A player who sits down gets a token, once. It carries their portrait and their character code —
   the code is what proves ownership later, so nobody else can drag them around. */
async function tblEnsureToken() {
  if (!tbl || tbl.role === "dm") return;
  if (!tbl.me.charCode && !tbl.me.name) return;   // nothing to name a figure after yet
  // NEVER place before the table's data has arrived. Sitting down on a second device placed a second
  // figure, because at that moment this client believed the board was empty.
  if (!tbl.gotData) return;
  const mineNow = tblMyTokens();
  if (mineNow.length) { tbl.me.tokenId = mineNow[0]; tblPruneMyTokens(); return; }
  if (tbl.me._placing) return;
  tbl.me._placing = true;
  try {
    // A guest has no sheet to read: their figure is their name, and they keep their own hit points on it.
    const ch = tbl.me.charCode ? await CocStore.load(tbl.me.charCode) : null;
    if (tbl.me.charCode && !ch) return;
    // The stream may well have delivered while that was loading.
    if (tblMyTokens().length) { tbl.me.tokenId = tblMyTokens()[0]; return; }
    const tokens = tblTokens();
    const d = (ch && typeof derive === "function") ? derive(ch) : null;
    const id = CocLive.newId();
    // Dropped on the first free square of the top row, so two players joining at once do not land
    // on top of each other.
    const spot = tblFreeSquare("", 1, 1, 1, 1, 1);
    const x = spot.x, y0 = spot.y;
    await CocLive.put(tblPath("tokens/" + id), {
      name: ((ch && ch.name) || tbl.me.name || "Someone").slice(0, 40),
      charCode: tbl.me.charCode || "",
      owner: tbl.me.clientId,        // what proves a guest's figure is theirs, having no character code
      image: (ch && ch.photo) || "",
      x, y: y0, size: 1,
      kind: "pc",
      shape: "square",
      initMod: d ? (d.mods.Dexterity || 0) : 0,
      hp: d ? (ch.play && ch.play.hp != null ? ch.play.hp : d.hpMax) : 0,
      hpMax: d ? d.hpMax : 0,
      speed: 30,
      color: "#c9a54e",
    });
    tbl.me.tokenId = id;
    tblSaveMe(tbl.code, { clientId: tbl.me.clientId, name: tbl.me.name, charCode: tbl.me.charCode });
  } catch { /* a failed placement is retried on the next heartbeat */ }
  finally { tbl.me._placing = false; }
}

function tblFail(err) {
  const bar = $("#vtt-error");
  if (bar) { bar.textContent = String(err && err.message ? err.message : err); bar.classList.remove("hidden"); }
}

/* ---------------------------------------------------------------- the shell (rendered once) */

function renderTableShell() {
  const host = toolEl();
  host.innerHTML = `
    <div class="vtt" data-role="${esc(tbl.role)}">
      <div class="vtt-bar">
        <a class="back vtt-exit" href="#/table">&larr; Leave</a>
        <span id="vtt-title" class="vtt-title"></span>
        <span id="vtt-who" class="vtt-who"></span>
        <span class="vtt-acts">
          <button class="btn-quiet" data-tbl="panel" data-val="dice">Dice</button>
          <button class="btn-quiet" data-tbl="panel" data-val="notes">Notes</button>
          ${tbl.role === "dm" || tbl.me.charCode
            ? `<button class="btn-quiet" data-tbl="panel" data-val="sheet">My sheet</button>`
            : `<button class="btn-quiet" data-tbl="panel" data-val="mine">My figure</button>`}
          ${tbl.role === "dm"
            ? `<button class="btn-quiet" data-tbl="panel" data-val="dm">DM</button>`
            : `<button class="btn-quiet" data-tbl="panel" data-val="claim">I'm the DM</button>`}
        </span>
      </div>
      <p id="vtt-error" class="warn hidden"></p>
      <p id="vtt-lastroll" class="last-roll hidden"></p>
      <div id="vtt-turn" class="vtt-turn hidden"></div>
      <div id="vtt-handout" class="vtt-handout hidden"></div>
      <div class="vtt-body">
        <aside id="vtt-dock" class="vtt-dock hidden"></aside>
        <div id="vtt-stage" class="vtt-stage">
          <div id="vtt-world" class="vtt-world">
            <img id="vtt-map" class="vtt-map hidden" alt="" />
            <div id="vtt-grid" class="vtt-grid"></div>
            <div id="vtt-tokens" class="vtt-tokens"></div>
            <svg id="vtt-ruler" class="vtt-ruler" aria-hidden="true"></svg>
          </div>
          <div id="vtt-measure" class="vtt-measure hidden"></div>
          <div class="vtt-zoom">
            <button class="btn-quiet" data-tbl="zoom" data-val="-1">&minus;</button>
            <button class="btn-quiet" data-tbl="zoom" data-val="0">Fit</button>
            <button class="btn-quiet" data-tbl="zoom" data-val="1">+</button>
          </div>
        </div>
        <aside id="vtt-side" class="vtt-side hidden"></aside>
      </div>
    </div>`;
  paintHeader();
  paintBoard();
  bindStage();
  // The stage takes its height from flex, which is not settled in the tick the markup is written in.
  if (typeof requestAnimationFrame === "function") {
    requestAnimationFrame(() => { if (tbl && !tbl.cameraIsYours) tblFit(); });
  }
}

/* Everything the stream can have changed, in one pass. Repainting the lot on every event is affordable
   because the expensive part — the tokens — is a diff, and the map is only touched when its source
   actually changes. The alternative (working out which branch moved) was seven streams, and that cost
   the app every connection the browser had. */
function paintEverything() {
  // The DM closed the room while people were in it — or somebody opened a code from their list that no
  // longer exists. Either way there is no table, and showing an empty board is the one answer that
  // explains nothing. (It is also why this cannot simply be ignored: the heartbeat would go on writing
  // presence into a deleted room and recreate it as a husk.)
  if (tbl.gotData && !(tbl.data && tbl.data.meta)) { tblTableGone(); return; }
  paintDock();
  paintHeader();
  paintBoard();      // paintTokens is called from here
  paintTurnBar();
  paintLog();
  paintWho();
  paintHandout();
  paintDmPanel();
}

/* Nothing here any more. Say so, take it off this device's list, and stop talking to it. */
function tblTableGone() {
  const code = tbl.code;
  const wasDm = tbl.role === "dm";
  tblTeardown();
  tblForgetTable(code);
  localStorage.removeItem(tblDmKey(code));
  localStorage.removeItem(tblMeKey(code));
  paint(`<div class="tool-head">
      <a class="back" href="#/table">&larr; Tables</a>
      <h1>This table is closed</h1>
      <p class="muted">Room ${esc(code)} no longer exists${wasDm ? "" : " — the DM closed it"}. It has been
        taken off this device's list; the code is free for anyone to reuse.</p>
    </div>
    <section class="panel"><p class="muted">If you were in the middle of a session, ask your DM for the
      new room code. Your character is untouched — a table holds no part of it.</p>
      <a class="btn" href="#/table">Find a table</a></section>`);
}

/* Header, who-is-here, error bar: small nodes, replaced whole. */
function paintHeader() {
  const meta = tbl.data.meta || {};
  const el = $("#vtt-title");
  if (!el) return;
  el.innerHTML = `<strong>${esc(meta.name || "Table")}</strong>
    <span class="muted">room ${esc(tbl.code)}</span>
    <span class="role-badge">${tbl.role === "dm" ? "DM" : esc(tbl.me.name || "Player")}</span>`;
}

function paintWho() {
  const host = $("#vtt-who");
  if (!host) return;
  const now = Date.now();
  // Everyone EXCEPT you: the badge beside the table's name already says who you are, and seeing your
  // own name twice in a row of four chips is how a phone header runs out of room.
  const here = Object.entries(tbl.data.presence || {})
    .filter(([id, p]) => p && id !== tbl.me.clientId && now - (p.at || 0) < 60000)
    .sort((a, b) => (a[1].role === "dm" ? -1 : 1));
  host.innerHTML = here.map(([, p]) =>
    `<span class="who ${p.role === "dm" ? "who-dm" : ""}">${esc(p.name || "Player")}</span>`).join("")
    || `<span class="muted">nobody else here yet</span>`;
}

/* ---------------------------------------------------------------- the board */

/* The map, the grid and the camera. Called when the scene changes, not when a token moves. */
function paintBoard() {
  const scene = tblScene();
  const world = $("#vtt-world"), img = $("#vtt-map"), grid = $("#vtt-grid");
  if (!world) return;
  const cell = Number(scene.cell) || 70;
  const w = (Number(scene.cols) || 30) * cell;
  const h = (Number(scene.rows) || 20) * cell;
  // Which scene is on screen, readable from the DOM: the DM's scene list highlights it and the
  // tests assert on it rather than reaching into module state.
  world.dataset.scene = tblSceneId();
  world.style.width = w + "px";
  world.style.height = h + "px";
  grid.style.backgroundSize = `${cell}px ${cell}px`;
  // Only when it has actually changed: re-assigning the same src re-decodes a half-megabyte data URI,
  // and this now runs on every stream event.
  if (scene.image) {
    if (img.getAttribute("src") !== scene.image) img.src = scene.image;
    img.classList.remove("hidden");
  } else if (img.hasAttribute("src")) {
    img.removeAttribute("src");
    img.classList.add("hidden");
  } else {
    img.classList.add("hidden");
  }
  // Only fit once there is a REAL scene to fit to. The shell paints before any data has arrived, and
  // fitting to the placeholder 30x20 then marking the view "fitted" left the camera pointed at the
  // middle of a map that does not exist — on a phone, that put the whole board off-screen.
  if (!tbl.view.fitted && tblSceneId()) tblFit();
  applyView();
  paintTokens();
}

/* Camera. Everything is one CSS transform on the world, so panning and zooming never touch a token:
   the browser composites the whole board, which is why this stays smooth on a phone. */
/* The only thing the camera must not do is lose the board. The first version of this was far stricter —
   it pinned the map's edges to the window — and on a map smaller than the screen that left almost
   nowhere to pan: it moved an inch and stopped dead, snapping back on release. So the rule is loose and
   states only what matters: a quarter of the window always has map in it. Everything else is allowed.

   Whole pixels, too. A camera sitting on x = -418.79 puts the grid's 1px lines between device pixels,
   and the browser renders them unevenly — which is what "the grid isn't symmetrical" was. */
const TBL_KEEP_ON_SCREEN = 0.25;
function tblClampView() {
  const stage = $("#vtt-stage"), scene = tblScene();
  if (!stage) return;
  const box = stage.getBoundingClientRect();
  if (box.width < 40) return;
  const cell = Number(scene.cell) || 70;
  const w = (Number(scene.cols) || 30) * cell * tbl.view.z;
  const h = (Number(scene.rows) || 20) * cell * tbl.view.z;
  const bound = (v, size, stageSize) => Math.max(
    stageSize * TBL_KEEP_ON_SCREEN - size,          // its right/bottom edge cannot come further in
    Math.min(stageSize * (1 - TBL_KEEP_ON_SCREEN), v));  // nor can its left/top edge
  tbl.view.x = Math.round(bound(tbl.view.x, w, box.width));
  tbl.view.y = Math.round(bound(tbl.view.y, h, box.height));
}

/* A zoom where a square is 40.7 pixels wide draws some grid lines 1px and some 2px, and the squares stop
   looking like squares. Snapping the zoom so a square is a whole number of pixels costs nothing and the
   grid comes out even at every level. */
function tblSnapZoom(z, cell) {
  const px = Math.max(6, Math.round(cell * z));
  return px / cell;
}

function applyView() {
  const world = $("#vtt-world");
  if (!world) return;
  world.style.transform = `translate(${tbl.view.x}px, ${tbl.view.y}px) scale(${tbl.view.z})`;
}
/* "Fit" does not mean "show the whole map at any cost". Fitting a 20x14 map into a 390px phone makes
   a figure eleven pixels wide — unreadable, and impossible to hit with a finger. So the fit has a
   FLOOR: a square never shrinks below something you can tap, and the map simply becomes pannable,
   which is what every map on a phone is anyway. */
/* A square must be big enough to hit with a FINGER, which is why this floor exists — and on a mouse it
   is only ever harmful: it zoomed a map past the edges of a desktop window that could have shown all of
   it. So it applies to touch devices only. */
const TBL_MIN_CELL_PX = 40;
function tblMinCell() {
  const coarse = typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;
  return coarse ? TBL_MIN_CELL_PX : 0;
}
function tblFit() {
  const stage = $("#vtt-stage"), scene = tblScene();
  if (!stage) return;
  const cell = Number(scene.cell) || 70;
  const w = (Number(scene.cols) || 30) * cell, h = (Number(scene.rows) || 20) * cell;
  const box = stage.getBoundingClientRect();
  // No layout yet (the stage has just been inserted): fitting to a zero-sized window would compute
  // nonsense and, worse, latch it. Leave it unfitted and the next paint will do it properly.
  if (box.width < 40 || box.height < 40) return;
  const pad = 16;
  const whole = Math.min((box.width - pad) / w, (box.height - pad) / h, 1.6) || 1;
  const z = tblSnapZoom(Math.max(0.12, whole, Math.min(1, tblMinCell() / cell)), cell);
  tbl.view.z = z;
  // Centred on YOUR figure when you have one: opening a table should show you where you are, not the
  // top-left corner of a map you then have to go looking through.
  const mine = Object.values(tblTokens()).find((t) => t && t.charCode && t.charCode === tbl.me.charCode);
  const focusX = mine ? (Number(mine.x) + 0.5) * cell : w / 2;
  const focusY = mine ? (Number(mine.y) + 0.5) * cell : h / 2;
  const clamp = (v, size, stageSize) => size * z <= stageSize
    ? (stageSize - size * z) / 2                       // it all fits: centre it
    : Math.max(stageSize - size * z, Math.min(0, v));  // it does not: keep the map covering the stage
  tbl.view.x = Math.round(clamp(box.width / 2 - focusX * z, w, box.width));
  tbl.view.y = Math.round(clamp(box.height / 2 - focusY * z, h, box.height));
  tbl.view.fitted = true;
  // Whether the centring found your figure. Recorded on the SESSION, not on the camera: it is a fact
  // about whether the once-only aim has happened, and anything that replaces the view object (a reset,
  // a test, a future "reset camera" button) must not re-arm it.
  if (mine) tbl.centredOnMe = true;
  applyView();
}
/* Once you have moved the camera it is YOURS: nothing re-frames it after that, which is the difference
   between a helpful auto-fit and an app that keeps snatching the map back. */
function tblZoomBy(factor, cx, cy) {
  tbl.cameraIsYours = true;
  const stage = $("#vtt-stage");
  const box = stage.getBoundingClientRect();
  const px = (cx == null ? box.width / 2 : cx - box.left);
  const py = (cy == null ? box.height / 2 : cy - box.top);
  const z0 = tbl.view.z;
  const cell = Number(tblScene().cell) || 70;
  const z1 = tblSnapZoom(Math.max(0.12, Math.min(4, z0 * factor)), cell);
  // Keep the point under the cursor still: that is what makes zooming feel like a camera rather
  // than a slider.
  tbl.view.x = px - ((px - tbl.view.x) / z0) * z1;
  tbl.view.y = py - ((py - tbl.view.y) / z0) * z1;
  tbl.view.z = z1;
  tblClampView();
  applyView();
  /* Zooming WHILE dragging used to break the drag: the grab offset was worked out in the old view, and
     the clamp then moved the camera under the finger, so the figure leapt away and followed at an
     offset that never came back — Kayki's "hold to drag and zoom out at the same time". Re-anchoring to
     the finger's current position keeps whatever is being held exactly where it is. */
  if (tbl.drag && tbl.lastPoint) {
    const at = toSquares(tbl.lastPoint.sx, tbl.lastPoint.sy);
    if (tbl.drag.pan) {
      tbl.drag.sx = tbl.lastPoint.sx; tbl.drag.sy = tbl.lastPoint.sy;
      tbl.drag.ox = tbl.view.x; tbl.drag.oy = tbl.view.y;
    } else {
      tbl.drag.grabX = at.x - tbl.drag.x;
      tbl.drag.grabY = at.y - tbl.drag.y;
    }
  }
}

/* Tokens are DIFFED, never rebuilt: rebuilding drops the one under your finger and restarts every
   image download. Each token owns one node, keyed by its id. */
function paintTokens() {
  const host = $("#vtt-tokens");
  if (!host) return;
  const scene = tblScene();
  const cell = Number(scene.cell) || 70;
  const tokens = tblTokens();
  const activeScene = tblSceneId();
  const seen = new Set();
  for (const [id, t] of Object.entries(tokens)) {
    if (!t) continue;
    // The party is on every map; a monster belongs to the map it was put on. That is how a table
    // actually plays — the DM changes scene and the players are simply there, while the goblins of
    // the last room do not follow them into the next one.
    if (t.kind === "npc" && t.scene && t.scene !== activeScene) continue;
    seen.add(id);
    let node = host.querySelector(`[data-token="${id}"]`);
    if (!node) {
      node = document.createElement("div");
      node.className = "tok";
      node.dataset.token = id;
      node.innerHTML = `<span class="tok-art"></span><span class="tok-name"></span>` +
        `<span class="tok-hp"></span><span class="tok-cond"></span>`;
      host.appendChild(node);
    }
    // The token being dragged on THIS screen is not moved by incoming data: the drag is the truth
    // until it ends, and fighting it makes the token stutter under the finger.
    const dragging = tbl.drag && tbl.drag.id === id;
    if (!dragging) {
      node.style.left = (t.x * cell) + "px";
      node.style.top = (t.y * cell) + "px";
    }
    const size = Math.max(1, Number(t.size) || 1);
    node.style.width = (size * cell) + "px";
    node.style.height = (size * cell) + "px";
    node.classList.toggle("mine", !!t.charCode && t.charCode === tbl.me.charCode);
    node.classList.toggle("movable", tblCanMove(t));
    node.classList.toggle("npc", t.kind === "npc");
    const art = node.querySelector(".tok-art");
    art.className = "tok-art shape-" + tblShapeOf(t);
    if (t.image) {
      if (art.dataset.src !== t.image) { art.dataset.src = t.image; art.style.backgroundImage = `url("${t.image}")`; }
      art.textContent = "";
    } else {
      art.style.backgroundImage = "";
      art.textContent = (t.name || "?").slice(0, 1).toUpperCase();
    }
    node.querySelector(".tok-name").textContent = t.name || "";
    /* Hit points on the board are the DM's ONLY. A player reads their own on their sheet (or on their
       figure, without one); a table of bars visible to everybody turns the scene into a dashboard and
       tells the players exactly how close the fight is. But the DM runs the fight, and opening a panel
       per goblin to see who is nearly down is slower than the fight is — so the DM gets the bar, with
       the numbers, and nobody else sees anything. */
    const hp = node.querySelector(".tok-hp");
    if (tbl.role === "dm" && t.hpMax) {
      const pct = Math.max(0, Math.min(100, Math.round((Number(t.hp) || 0) / t.hpMax * 100)));
      const hurt = pct <= 25 ? " low" : pct <= 60 ? " half" : "";
      hp.innerHTML = `<span class="tok-bar${hurt}"><span style="width:${pct}%"></span></span>` +
        `<span class="tok-num">${esc(t.hp)}/${esc(t.hpMax)}</span>`;
    } else if (hp.innerHTML) hp.innerHTML = "";
    // Conditions are different: they change what a figure can DO, so they stay visible to everyone.
    const cond = node.querySelector(".tok-cond");
    // Conditions, set by the DM, read by everybody — the second half of "what is going on with that
    // thing". Two letters each, because a token is 40px wide on a phone.
    const list = Array.isArray(t.conditions) ? t.conditions : [];
    cond.innerHTML = list.map((c) =>
      `<span class="tok-flag" title="${esc(TBL_CONDITION_NAMES[c] || c)}">${esc((TBL_CONDITION_NAMES[c] || c).slice(0, 2))}</span>`).join("");
  }
  for (const node of [...host.children]) {
    if (!seen.has(node.dataset.token)) node.remove();
  }
  // Your own figure arriving is the first moment the camera can be aimed at it. Once only, and only
  // if the fit had nothing to aim at before — re-framing a board somebody has already panned would be
  // its own kind of rude.
  if (tbl.view.fitted && !tbl.centredOnMe && !tbl.drag
      && Object.values(tokens).some((t) => t && t.charCode && t.charCode === tbl.me.charCode)) {
    tblFit();
  }
  paintRuler();
}

/* ---------------------------------------------------------------- dragging, panning, pinching */

/* Pointer events, not mouse and touch separately: a stylus, a finger and a mouse all arrive here as
   the same three events, which is the only reason the board works on a phone without a second
   implementation to keep in step. */
let tblGesturesBound = false;
function bindStage() {
  const stage = $("#vtt-stage");
  if (!stage) return;
  stage.addEventListener("pointerdown", onPointerDown);
  /* move / up / cancel are bound to the WINDOW, not to the board, and this is the whole of the
     "zoom, then dragging stops working until I leave the room" bug. A finger or a mouse released
     OUTSIDE the board — which is most of a phone screen, and is where a pinch usually ends — never
     sends its pointerup to the board. The pointer was then never deleted, so the next touch counted as
     a SECOND finger and every drag was read as a pinch: nothing moved, and only reopening the table
     (which rebuilt the state) fixed it.
     Bound once, on the window, because the shell is re-rendered and stacking listeners on every render
     would fire each handler as many times as the table had been repainted. */
  if (!tblGesturesBound) {
    tblGesturesBound = true;
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerUp);
    // The other ways a gesture can end without telling you: switching app, rotating, alt-tabbing.
    window.addEventListener("blur", tblResetGestures);
    document.addEventListener("visibilitychange", () => { if (document.hidden) tblResetGestures(); });
  }
  stage.addEventListener("wheel", (e) => {
    e.preventDefault();
    tblZoomBy(e.deltaY < 0 ? 1.12 : 1 / 1.12, e.clientX, e.clientY);
  }, { passive: false });
  // A double tap on a token is the shortest path to "what is this thing" — for the DM, its editor.
  stage.addEventListener("dblclick", (e) => {
    const node = e.target.closest("[data-token]");
    if (node) tblOpenToken(node.dataset.token);
  });
}

function stagePoint(e) {
  const stage = $("#vtt-stage").getBoundingClientRect();
  // Remembered so a zoom in the middle of a drag can re-anchor to where the finger actually is.
  if (tbl) tbl.lastPoint = { sx: e.clientX - stage.left, sy: e.clientY - stage.top };
  return {
    // World coordinates in squares: undo the camera, then divide by the cell size.
    sx: e.clientX - stage.left, sy: e.clientY - stage.top,
  };
}
function toSquares(sx, sy) {
  const scene = tblScene();
  const cell = Number(scene.cell) || 70;
  return { x: ((sx - tbl.view.x) / tbl.view.z) / cell, y: ((sy - tbl.view.y) / tbl.view.z) / cell };
}

/* Every finger is up and nothing is being dragged. Called whenever the browser tells us a gesture
   ended in a way we cannot track, so a lost event can never leave the board deaf. */
function tblResetGestures() {
  if (!tbl) return;
  tbl.pointers.clear();
  tbl.pinch = null;
  if (tbl.drag && !tbl.drag.pan) {
    const node = $("#vtt-tokens") && $("#vtt-tokens").querySelector(`[data-token="${tbl.drag.id}"]`);
    if (node) node.classList.remove("dragging");
    // A drag that is cut short still has to LAND on a square. Without this the last throttled write
    // stood — a position like x = 10.34 — and the figure sat straddling four grid lines for good.
    tblLandDrag(tbl.drag);
  }
  tbl.drag = null;
  paintTokens();
  paintRuler();
}

function onPointerDown(e) {
  if (!tbl) return;
  const stage = $("#vtt-stage");
  if (!stage || !stage.contains(e.target)) return;   // the window hears everything; the board owns only itself
  // A primary pointerdown is by definition the FIRST finger of a gesture, so anything still recorded
  // is a ghost from an event we never received. Self-healing beats hoping.
  if (e.isPrimary !== false && tbl.pointers.size) { tbl.pointers.clear(); tbl.pinch = null; tbl.drag = null; }
  tbl.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  // Two fingers down: this is a pinch, and whatever the first finger had started is abandoned.
  if (tbl.pointers.size === 2) { tbl.drag = null; tbl.pinch = tblPinchState(); return; }
  const node = e.target.closest("[data-token]");
  const id = node && node.dataset.token;
  const token = id ? tblTokens()[id] : null;
  const p = stagePoint(e);
  if (token && tblCanMove(token)) {
    const at = toSquares(p.sx, p.sy);
    tbl.drag = {
      id, token,
      grabX: at.x - token.x, grabY: at.y - token.y,     // where inside the token you grabbed it
      fromX: token.x, fromY: token.y,
      x: token.x, y: token.y,
    };
    node.classList.add("dragging");
  } else {
    tbl.drag = { pan: true, sx: p.sx, sy: p.sy, ox: tbl.view.x, oy: tbl.view.y };
  }
  if (stage.setPointerCapture) { try { stage.setPointerCapture(e.pointerId); } catch { /* fine */ } }
}

function tblPinchState() {
  const pts = [...tbl.pointers.values()];
  const dx = pts[0].x - pts[1].x, dy = pts[0].y - pts[1].y;
  return { dist: Math.hypot(dx, dy) || 1, cx: (pts[0].x + pts[1].x) / 2, cy: (pts[0].y + pts[1].y) / 2 };
}

function onPointerMove(e) {
  if (!tbl) return;
  if (tbl.pointers.has(e.pointerId)) tbl.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (tbl.pointers.size === 2 && tbl.pinch) {
    const next = tblPinchState();
    tblZoomBy(next.dist / tbl.pinch.dist, next.cx, next.cy);
    tbl.pinch = next;
    return;
  }
  const d = tbl.drag;
  if (!d) return;
  const p = stagePoint(e);
  if (d.pan) {
    tbl.cameraIsYours = true;
    tbl.view.x = d.ox + (p.sx - d.sx);
    tbl.view.y = d.oy + (p.sy - d.sy);
    tblClampView();
    applyView();
    return;
  }
  const at = toSquares(p.sx, p.sy);
  d.x = at.x - d.grabX;
  d.y = at.y - d.grabY;
  const scene = tblScene();
  const cell = Number(scene.cell) || 70;
  const node = $("#vtt-tokens").querySelector(`[data-token="${d.id}"]`);
  if (node) {
    // Follow the finger freely and snap only on release: snapping live makes a token feel like it is
    // fighting you, and the ruler needs the real distance, not the rounded one.
    node.style.left = (d.x * cell) + "px";
    node.style.top = (d.y * cell) + "px";
  }
  // Everyone else sees the move as it happens, at a rate the database is happy with.
  CocLive.throttled(tblPath("tokens/" + d.id + "/x"), Math.round(d.x * 100) / 100, 110);
  CocLive.throttled(tblPath("tokens/" + d.id + "/y"), Math.round(d.y * 100) / 100, 110);
  paintRuler();
}

function onPointerUp(e) {
  if (!tbl) return;
  tbl.pointers.delete(e.pointerId);
  if (tbl.pointers.size < 2) tbl.pinch = null;
  // Lifting one finger of a pinch leaves the other one down. Hand it the map rather than ignoring it
  // until it lifts too — otherwise the board feels stuck for as long as that finger rests on it.
  if (tbl.pointers.size === 1 && !tbl.drag) {
    const [only] = [...tbl.pointers.values()];
    const stage = $("#vtt-stage").getBoundingClientRect();
    tbl.drag = { pan: true, sx: only.x - stage.left, sy: only.y - stage.top, ox: tbl.view.x, oy: tbl.view.y };
    return;
  }
  const d = tbl.drag;
  if (!d) return;
  tbl.drag = null;
  if (d.pan) return;
  const node = $("#vtt-tokens").querySelector(`[data-token="${d.id}"]`);
  if (node) node.classList.remove("dragging");
  tblLandDrag(d);
  paintTokens();
  paintRuler();
}

/* Does a figure of this size, at this square, land on top of another one? Rectangles, not centres,
   because a four-square creature occupies four squares and standing "inside" it is the thing being
   prevented.
   Scenery does not block: a figure with no hit points at all is a marker — a pit, a rune, a zone — and
   standing in one is usually the whole point of it. (The Illusionist's areas will be these.) */
function tblBlocks(t) {
  return !(t.kind === "npc" && !(Number(t.hpMax) > 0));
}
function tblSquareTaken(id, x, y, size) {
  const activeScene = tblSceneId();
  for (const [other, t] of Object.entries(tblTokens())) {
    if (!t || other === id || !tblBlocks(t)) continue;
    if (t.kind === "npc" && t.scene && t.scene !== activeScene) continue;
    const os = Math.max(1, Number(t.size) || 1);
    const ox = Math.round(Number(t.x) || 0), oy = Math.round(Number(t.y) || 0);
    if (x < ox + os && ox < x + size && y < oy + os && oy < y + size) return true;
  }
  return false;
}
/* The square asked for if it is free, else the nearest one that is — so a figure dropped on a goblin
   slides to its side rather than either vanishing into it or refusing to move at all. */
function tblFreeSquare(id, x, y, size, fallbackX, fallbackY) {
  const scene = tblScene();
  const maxX = (Number(scene.cols) || 30) - size, maxY = (Number(scene.rows) || 20) - size;
  const fit = (v, max) => Math.max(0, Math.min(Math.max(0, max), v));
  if (!tblSquareTaken(id, fit(x, maxX), fit(y, maxY), size)) return { x: fit(x, maxX), y: fit(y, maxY) };
  for (let r = 1; r <= 5; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;   // this ring only
        const nx = fit(x + dx, maxX), ny = fit(y + dy, maxY);
        if (!tblSquareTaken(id, nx, ny, size)) return { x: nx, y: ny };
      }
    }
  }
  // Boxed in entirely: stay where you were rather than land on somebody.
  return { x: fit(Math.round(fallbackX), maxX), y: fit(Math.round(fallbackY), maxY) };
}

/* Where a dragged figure comes to rest. Squares are integers — a figure between two of them is the thing
   that makes a board unreadable — so this rounds, clamps to the map and charges the distance. Shared by
   a normal release and by a gesture that was interrupted. */
function tblLandDrag(d) {
  const size = Math.max(1, Number(d.token.size) || 1);
  const spot = tblFreeSquare(d.id, Math.round(d.x), Math.round(d.y), size, d.fromX, d.fromY);
  CocLive.put(tblPath("tokens/" + d.id + "/x"), spot.x).catch(tblFail);
  CocLive.put(tblPath("tokens/" + d.id + "/y"), spot.y).catch(tblFail);
  tblCountMove(d, spot.x, spot.y);
}

/* ---------------------------------------------------------------- the side panel */

/* Is there room for a column of its own? The dice live in a dock on the LEFT of the board on a desktop,
   where the roll history can simply stay open; on a phone there is no such room, so they use the same
   slide-over panel as everything else. This is the only place the two layouts differ in BEHAVIOUR. */
function tblWide() {
  return typeof matchMedia === "function" ? matchMedia("(min-width: 761px)").matches : true;
}
function paintDock() {
  const dock = $("#vtt-dock");
  if (!dock) return;
  const show = tblWide() && tbl.ui.dock !== false;
  dock.classList.toggle("hidden", !show);
  if (!show) { dock.innerHTML = ""; return; }
  dock.innerHTML = dicePanelHTML();   // the tray AND the history: two #vtt-log would be one too many
  paintLog();
}
/* Wherever the dice currently live. */
function paintDice() {
  if (tblWide()) paintDock(); else paintSide();
}

/* One column beside the board on a desktop, the lower half of the screen on a phone. It holds the
   things you dip into rather than watch: the dice, your own sheet, the DM's tools. Rendered whole
   each time, which is safe because nothing in it is mid-drag. */
function tblPanel(which) {
  // On a desktop the dice are a dock of their own, so the Dice button opens and closes THAT rather than
  // taking over the panel the sheet and the DM's tools use.
  if (which === "dice" && tblWide()) {
    tbl.ui.dock = tbl.ui.dock === false;
    paintDock();
    document.querySelectorAll("[data-tbl='panel']").forEach((b) =>
      b.classList.toggle("on", b.dataset.val === "dice" ? tbl.ui.dock !== false : b.dataset.val === tbl.ui.panel));
    return;
  }
  const wasSheet = tbl.ui.panel === "sheet";
  tbl.ui.panel = tbl.ui.panel === which ? "" : which;
  if (wasSheet && tbl.ui.panel !== "sheet") closeSheetPanel();
  paintSide();
}
function paintSide() {
  const side = $("#vtt-side");
  if (!side) return;
  const which = tbl.ui.panel;
  side.classList.toggle("hidden", !which);
  document.querySelectorAll("[data-tbl='panel']").forEach((b) =>
    b.classList.toggle("on", b.dataset.val === which));
  if (!which) { side.innerHTML = ""; return; }
  if (which === "dm") { const html = dmPanelHTML(); side.innerHTML = html; side.dataset.rendered = html; }
  else if (which === "dice") {
    side.innerHTML = dicePanelHTML();
    // The log lives in this panel and is filled by the stream, so a freshly opened panel would sit
    // empty until the next roll — showing "nothing rolled yet" under four rolls.
    paintLog();
  }
  else if (which === "claim") side.innerHTML = claimPanelHTML();
  else if (which === "figure") side.innerHTML = figureInfoHTML(tbl.ui.lookAt);
  else if (which === "notes") side.innerHTML = notesPanelHTML();
  else if (which === "mine") side.innerHTML = figureInfoHTML(tblMyTokens()[0] || "");
  else if (which === "sheet") { side.innerHTML = `<p class="muted">Opening your sheet…</p>`; paintSheetPanel(); }
}
/* Re-render the DM's panel, keeping what is half-typed in it.
 *
 * The first version simply SKIPPED the re-render whenever the cursor was inside the panel, to avoid
 * eating half-typed notes. That was much worse than the problem: click into any field and the panel
 * froze, so deleting a scene appeared to do nothing (the row it deleted stayed on screen), which looked
 * like a ten-second lag and led to thirty scenes being added by someone reasonably assuming the button
 * was broken.
 *
 * So: build the new markup, and if it is identical, touch nothing at all — which is the common case and
 * costs one string compare. Otherwise swap it and put back the values, the focus and the caret, exactly
 * as paint() does for the sheet. */
function paintDmPanel() {
  if (tbl.ui.panel !== "dm") return;
  const side = $("#vtt-side");
  if (!side) return;
  // A chosen file cannot be restored into a file input, so while one is waiting to be uploaded the
  // panel is left alone — a few seconds, and losing the file would be worse than a stale list.
  const file = side.querySelector('input[type="file"]');
  if (file && file.files && file.files.length) return;
  const next = dmPanelHTML();
  if (next === side.dataset.rendered) return;
  const active = document.activeElement;
  const focusId = active && side.contains(active) && active.id ? active.id : "";
  let caret = null;
  if (focusId) { try { caret = active.selectionStart; } catch { caret = null; } }
  const kept = {};
  side.querySelectorAll("input[id], textarea[id]").forEach((n) => {
    if (n.type !== "file") kept[n.id] = n.value;
  });
  side.innerHTML = next;
  side.dataset.rendered = next;
  side.querySelectorAll("input[id], textarea[id]").forEach((n) => {
    if (n.type !== "file" && kept[n.id] !== undefined) n.value = kept[n.id];
  });
  if (focusId) {
    const back = side.querySelector("#" + focusId);
    if (back) {
      back.focus();
      if (caret != null && back.setSelectionRange) { try { back.setSelectionRange(caret, caret); } catch { /* number inputs refuse */ } }
    }
  }
}

/* ---------------------------------------------------------------- maps and scenes (DM only) */

/* Four ways to get a map onto the board, because they fail in different directions: a URL costs
   nothing but breaks if the host goes away; an upload always works but is stored in the database, so
   it is downscaled and capped; a file committed to maps/ is free and permanent but needs a push; and
   a blank grid needs nothing at all, which is what you want for a fight in an unmapped room. */
const TBL_MAP_SOURCES = [
  ["blank", "Blank grid", "squares and nothing else"],
  ["repo", "From the repo", "files committed to maps/"],
  ["url", "Image URL", "hosted anywhere"],
  ["upload", "Upload", "stored in the database, downscaled"],
];

let tblRepoMaps = null;   // cached listing of maps/index.json

function dmPanelHTML() {
  // An open figure comes first: it is what you just double-tapped, and hunting for it under the map
  // list would be its own small insult.
  const editing = tbl.ui.editToken && tblTokens()[tbl.ui.editToken] ? tokenEditorHTML(tbl.ui.editToken) : "";
  return editing + dmMapsHTML() + dmFiguresHTML() + dmScreenHTML() + closeTableHTML();
}

function dmMapsHTML() {
  const scenes = tbl.data.scenes || {};
  const active = tblScene();
  const activeId = tblSceneId();
  const src = tbl.ui.mapSource || "blank";
  const ids = Object.keys(scenes).sort((a, b) => (scenes[a].createdAt || 0) - (scenes[b].createdAt || 0));
  const list = ids.map((id) => {
    const s = scenes[id];
    return `<div class="scene-row ${id === activeId ? "on" : ""}">
      <button class="scene-pick" data-tbl="scene" data-val="${esc(id)}">
        <strong>${esc(s.name || "Scene")}</strong>
        <span class="muted">${esc(s.cols || 30)}&times;${esc(s.rows || 20)}${s.image ? "" : " · blank"}</span>
      </button>
      ${ids.length > 1 ? `<button class="btn-quiet" data-tbl="scene-del" data-val="${esc(id)}">Delete</button>` : ""}
    </div>`;
  }).join("");
  return `<section class="panel" id="dm-maps">
      <h2>Maps</h2>
      <p class="panel-sub">Scenes <span class="muted">— tap one to put it on everyone's screen</span></p>
      <div class="scene-list">${list}</div>
    </section>
    <section class="panel">
      <p class="panel-sub">Add a scene</p>
      <div class="chips">${TBL_MAP_SOURCES.map(([k, label, note]) => chipTip(
        `<button class="chip ${src === k ? "on" : ""}" data-tbl="map-source" data-val="${k}">${esc(label)}</button>`,
        esc(note))).join("")}</div>
      <label class="field"><span>Name</span>
        <input id="tbl-scene-name" class="text" type="text" maxlength="60" placeholder="The big top" /></label>
      ${src === "url" ? `<label class="field"><span>Image URL</span>
        <input id="tbl-scene-url" class="text" type="url" placeholder="https://…" /></label>` : ""}
      ${src === "upload" ? `<label class="field"><span>Image file</span>
        <input id="tbl-scene-file" class="text" type="file" accept="image/*" /></label>
        <p class="muted" id="tbl-upload-msg">Anything large is shrunk to fit the database — a map is
          stored as data, so it is capped at about half a megabyte.</p>` : ""}
      ${src === "repo" ? repoMapsHTML() : ""}
      <div class="grid-row">
        <label class="field"><span>Squares across</span>
          <input id="tbl-scene-cols" class="num" type="number" min="4" max="120" value="30" /></label>
        ${src === "blank" ? `<label class="field"><span>Squares down</span>
          <input id="tbl-scene-rows" class="num" type="number" min="4" max="120" value="20" /></label>`
          : `<p class="muted">How many squares down is worked out from the image's shape, so nothing
            gets stretched.</p>`}
      </div>
      <button class="btn" data-tbl="scene-add">Add the scene</button>
      <p id="tbl-scene-msg" class="save-msg"></p>
    </section>
    <section class="panel" id="dm-grid">
      <p class="panel-sub">This scene's grid</p>
      <p class="grid-now"><strong>${esc(active.cols || 30)}</strong> across
        <span class="sep">&times;</span> <strong>${esc(active.rows || 20)}</strong> down
        <span class="muted">= ${esc((active.cols || 30) * 5)} ft by ${esc((active.rows || 20) * 5)} ft</span></p>
      <div class="grid-row">
        <label class="field"><span>Across</span>
          <span class="stepper">
            <button class="step-btn" data-tbl="grid-cols" data-val="-1">&minus;</button>
            <span class="step-val">${esc(active.cols || 30)}</span>
            <button class="step-btn" data-tbl="grid-cols" data-val="1">+</button>
          </span></label>
        <label class="field"><span>Down</span>
          <span class="stepper">
            <button class="step-btn" data-tbl="grid-rows" data-val="-1">&minus;</button>
            <span class="step-val">${esc(active.rows || 20)}</span>
            <button class="step-btn" data-tbl="grid-rows" data-val="1">+</button>
          </span></label>
      </div>
      <p class="muted">More squares across makes each one smaller: change it until the grid matches the
        picture. Five feet a square, so ${esc(active.cols || 30)} across is a room
        ${esc((active.cols || 30) * 5)} feet wide.</p>
    </section>`;
}

/* Every figure on this scene, so the DM can reach one without finding it on the map first. */
function dmFiguresHTML() {
  const activeScene = tblSceneId();
  const rows = Object.entries(tblTokens())
    .filter(([, t]) => t && !(t.kind === "npc" && t.scene && t.scene !== activeScene))
    .sort((a, b) => (a[1].kind === "pc" ? -1 : 1) - (b[1].kind === "pc" ? -1 : 1)
      || String(a[1].name || "").localeCompare(String(b[1].name || "")))
    .map(([id, t]) => `<div class="scene-row">
      <button class="scene-pick" data-tbl="ed-open" data-val="${esc(id)}">
        <strong>${esc(t.name || "Figure")}</strong>
        <span class="muted">${t.hpMax ? esc(t.hp) + "/" + esc(t.hpMax) + " hp" : "no hp"}${
          t.kind === "pc" ? " · player" : ""}</span>
      </button>
      <button class="btn-quiet" data-tbl="ed-dup" data-val="${esc(id)}">Copy</button>
    </div>`).join("");
  return `<section class="panel" id="dm-figures">
      <p class="panel-sub">Figures on this map</p>
      <div class="scene-list">${rows || `<p class="muted">Nothing on the board.</p>`}</div>
      <p class="panel-sub">Drop a figure</p>
      <div class="grid-row">
        <label class="field"><span>Name</span>
          <input id="tbl-npc-name" class="text" type="text" maxlength="40" placeholder="Goblin" /></label>
        <label class="field"><span>Hit points</span>
          <input id="tbl-npc-hp" class="num" type="number" min="0" value="7" /></label>
        <label class="field"><span>Squares</span>
          <input id="tbl-npc-size" class="num" type="number" min="1" max="4" value="1" /></label>
      </div>
      <p class="panel-sub">Shape <span class="muted">— players are always squares; yours need not be</span></p>
      <div class="chips">${TBL_SHAPES.map(([k, label]) =>
        `<button class="chip ${(tbl.ui.npcShape || "square") === k ? "on" : ""}" data-tbl="npc-shape"
          data-val="${k}"><span class="shape-dot shape-${k}"></span>${esc(label)}</button>`).join("")}</div>
      <label class="field"><span>Picture (URL, optional)</span>
        <input id="tbl-npc-img" class="text" type="text" placeholder="https://… or maps/…" /></label>
      <button class="btn" data-tbl="spawn">Drop it on the board</button>
      <p id="tbl-spawn-msg" class="save-msg"></p>
      <p class="muted">Names, hit points and a picture — no stat blocks. Enemies as real content, with
        attacks and saves of their own, is the next thing being built; this is what runs a fight until
        then.</p>
    </section>`;
}

function repoMapsHTML() {
  if (tblRepoMaps === null) {
    tblLoadRepoMaps();
    return `<p class="muted">Looking in maps/…</p>`;
  }
  if (!tblRepoMaps.length) {
    return `<p class="muted">Nothing in <strong>maps/</strong> yet. Commit image files into that
      folder, push, and they appear here for every device — free to host and nothing stored in the
      database.</p>`;
  }
  return `<div class="chips">${tblRepoMaps.map((f) =>
    `<button class="chip ${tbl.ui.repoPick === f ? "on" : ""}" data-tbl="repo-pick" data-val="${esc(f)}">${esc(f)}</button>`).join("")}</div>`;
}
async function tblLoadRepoMaps() {
  try {
    const res = await fetch("maps/index.json?cb=" + Date.now());
    tblRepoMaps = res.ok ? (await res.json()) : [];
  } catch { tblRepoMaps = []; }
  if (tbl) paintDmPanel();
}

/* An uploaded map is stored in the database as a data URI, so it has to be made small enough to
   belong there: shrink the longest side, then trade quality away, and give up rather than write
   something that the rules would reject anyway. */
const TBL_IMAGE_CAP = 680000;
function tblShrinkImage(file, done, fail) {
  const reader = new FileReader();
  reader.onerror = () => fail("That file could not be read.");
  reader.onload = () => {
    const img = new Image();
    img.onerror = () => fail("That does not look like an image.");
    img.onload = () => {
      const canvas = document.createElement("canvas");
      if (!canvas.getContext) return fail("This browser cannot resize images.");
      for (const maxSide of [1600, 1200, 900, 700]) {
        const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
        canvas.width = Math.max(1, Math.round(img.width * scale));
        canvas.height = Math.max(1, Math.round(img.height * scale));
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        for (const q of [0.72, 0.6, 0.48, 0.38]) {
          const out = canvas.toDataURL("image/jpeg", q);
          if (out.length <= TBL_IMAGE_CAP) return done(out, img.width, img.height);
        }
      }
      fail("Even shrunk, that image is too big to store. Commit it into maps/ instead.");
    };
    img.src = reader.result;
  };
  reader.readAsDataURL(file);
}

/* Rows from the image's own shape: a map stretched to a grid it does not match is worse than no grid,
   and asking the DM to work the number out by hand is the kind of arithmetic this app exists to do. */
function tblRowsFor(cols, w, h) {
  if (!w || !h) return Math.max(4, Math.round(cols * 0.66));
  return Math.max(4, Math.min(120, Math.round(cols * (h / w))));
}

async function tblAddScene() {
  const msg = $("#tbl-scene-msg");
  // Anything that ENDS the attempt — a refusal or a success — hands the button back. A refusal that
  // left it locked for four seconds was the first version of this, and it is its own small insult.
  const say = (t, bad) => {
    tbl.ui.adding = false;
    const b = $('[data-tbl="scene-add"]');
    if (b) b.disabled = false;
    if (msg) { msg.textContent = t; msg.className = "save-msg" + (bad ? " bad" : ""); }
  };
  // One scene per press. A URL or an upload has to be measured before it can be written, and during
  // that wait the button looked dead — which is how thirty identical blank grids got added.
  if (tbl.ui.adding) return;
  tbl.ui.adding = true;
  const btn = $('[data-tbl="scene-add"]');
  // The timeout is a safety net for a measurement that never comes back at all (a URL that hangs).
  if (btn) { btn.disabled = true; setTimeout(() => { if (btn) btn.disabled = false; }, 8000); }
  const src = tbl.ui.mapSource || "blank";
  const name = String(($("#tbl-scene-name") || {}).value || "").slice(0, 60);
  const cols = Math.max(4, Math.min(120, Number(($("#tbl-scene-cols") || {}).value) || 30));
  const write = async (image, w, h, label) => {
    const rows = src === "blank"
      ? Math.max(4, Math.min(120, Number(($("#tbl-scene-rows") || {}).value) || 20))
      : tblRowsFor(cols, w, h);
    const id = CocLive.newId();
    await CocLive.put(tblPath("scenes/" + id), {
      name: name || label, image: image || "", cols, rows, cell: 70, createdAt: Date.now(),
    });
    tbl.ui.adding = false;
    // A new scene becomes the one on screen: the DM added it to use it.
    await CocLive.put(tblPath("meta/activeScene"), id);
    tbl.view.fitted = false;
    say("Added.");
  };
  try {
    if (src === "blank") return void await write("", 0, 0, "Blank grid");
    if (src === "url") {
      const url = String(($("#tbl-scene-url") || {}).value || "").trim();
      if (!/^https?:\/\//i.test(url)) return say("That needs to be an http or https image address.", true);
      // Measured, not assumed: the grid has to match the picture's shape.
      const img = new Image();
      img.onload = () => write(url, img.width, img.height, "Map").catch((e) => say(e.message, true));
      img.onerror = () => say("Nothing loaded from that address. Is it a direct link to an image?", true);
      img.src = url;
      return;
    }
    if (src === "repo") {
      const file = tbl.ui.repoPick;
      if (!file) return say("Pick one of the files in maps/ first.", true);
      const url = "maps/" + file;
      const img = new Image();
      img.onload = () => write(url, img.width, img.height, file.replace(/\.[a-z]+$/i, ""))
        .catch((e) => say(e.message, true));
      img.onerror = () => say("That file did not load. Has it been pushed?", true);
      img.src = url;
      return;
    }
    if (src === "upload") {
      const input = $("#tbl-scene-file");
      const file = input && input.files && input.files[0];
      if (!file) return say("Choose an image file first.", true);
      say("Shrinking it to fit…");
      tblShrinkImage(file, (data, w, h) => {
        write(data, w, h, file.name.replace(/\.[a-z]+$/i, "")).catch((e) => say(e.message, true));
      }, (why) => say(why, true));
    }
  } catch (err) { say(err.message, true); }
}

async function tblDeleteScene(id) {
  const scenes = tbl.data.scenes || {};
  if (Object.keys(scenes).length <= 1) return;   // a table always has a board
  await CocLive.del(tblPath("scenes/" + id));
  if (tblSceneId() === id || (tbl.data.meta || {}).activeScene === id) {
    const next = Object.keys(scenes).find((k) => k !== id);
    if (next) await CocLive.put(tblPath("meta/activeScene"), next);
  }
  // Monsters belong to the map they were put on; the party does not.
  for (const [tid, t] of Object.entries(tblTokens())) {
    if (t && t.kind === "npc" && t.scene === id) CocLive.del(tblPath("tokens/" + tid)).catch(() => {});
  }
}

/* Nudging the grid. Kept as buttons rather than a number box because it is a "does that look square
   yet" adjustment, made while looking at the map, not a value anybody knows in advance. */
async function tblNudgeGrid(which, delta) {
  const id = tblSceneId();
  if (!id) return;
  const scene = tblScene();
  const key = which === "cols" ? "cols" : "rows";
  const next = Math.max(4, Math.min(120, (Number(scene[key]) || (key === "cols" ? 30 : 20)) + delta));
  await CocLive.put(tblPath("scenes/" + id + "/" + key), next);
}

/* ---------------------------------------------------------------- dice */

/* The dice are deliberately not a chat product. Kayki's table talks out loud or on Discord; what it
   needs from an app is the one line nobody can argue with — "Kayki rolled a d8 → 5" — in front of
   everyone at the same moment. So: a roller, a shared log of results, and nothing else.
 *
 * The roller who clicks computes the numbers and posts the result. That trusts the client, which is
 * the same trust the whole app runs on (a six-digit code IS the credential), and it is what makes a
 * roll appear instantly rather than after a round trip. */

/* "2d6+3", "d20", "1d20-1" — the shape people already write. */
/* "2d6+1d8+d4+3" — one roll made of several KINDS of die, which is how half the game's damage works: a
   smite is a d8 weapon plus 2d8 radiant plus a d4 if it is on fire, and rolling those separately then
   adding them up by hand is exactly the sort of arithmetic this app exists to remove.
   Returns a list of TERMS plus a flat modifier; a single-die roll is just a list of one. */
function tblParseRoll(spec) {
  const text = String(spec || "").replace(/\s+/g, "");
  if (!text || !/d\d/i.test(text)) return null;
  const terms = [];
  let mod = 0, seen = 0;
  const re = /([+-]?)(\d*)d(\d+)|([+-]?\d+)/gi;
  let m;
  while ((m = re.exec(text))) {
    seen += m[0].length;
    if (m[3]) {
      const sign = m[1] === "-" ? -1 : 1;          // "-1d4" is a real thing (a bane, a penalty die)
      terms.push({
        count: Math.max(1, Math.min(40, Number(m[2] || 1))),
        sides: Math.max(2, Math.min(1000, Number(m[3]))),
        sign,
      });
    } else {
      mod += Number(m[4]);
    }
  }
  // Every character has to belong to a term or a modifier, or this was not an expression at all.
  if (!terms.length || seen !== text.length) return null;
  return { terms, mod };
}

/* Old callers and old log entries speak in { count, sides, mod }; everything inside speaks in terms. */
function tblNormaliseSpec(spec) {
  if (!spec) return null;
  if (Array.isArray(spec.terms)) return spec;
  if (spec.sides) return { terms: [{ count: spec.count || 1, sides: spec.sides, sign: 1 }], mod: spec.mod || 0 };
  return null;
}

function d(sides) { return 1 + Math.floor(Math.random() * sides); }

/* Advantage and disadvantage are a property of the ROLL, not of the die: two d20s, keep one. Applying
   them to "4d6" would be a house rule nobody asked for, so they are ignored unless a single die is
   being thrown. */
/* Every die of the roll, in order, each carrying the size it came off so a mixed handful can be read:
   [{s:8,v:5},{s:6,v:3},{s:6,v:1}]. Advantage still means two dice and keep one, and still only applies
   to a roll that IS one die — applying it to a fistful would be a house rule nobody asked for. */
function tblDoRoll(spec, mode) {
  const norm = tblNormaliseSpec(spec);
  if (!norm) return null;
  const single = norm.terms.length === 1 && norm.terms[0].count === 1 && norm.terms[0].sign === 1;
  const twin = (mode === "adv" || mode === "dis") && single;
  const dice = [];
  if (twin) {
    const sides = norm.terms[0].sides;
    dice.push({ s: sides, v: d(sides) }, { s: sides, v: d(sides) });
  } else {
    for (const t of norm.terms) {
      for (let i = 0; i < t.count; i++) dice.push({ s: t.sides, v: d(t.sides), sign: t.sign });
    }
  }
  // WHICH die was kept, not just its value: with two 14s the value cannot tell you, and every screen
  // has to dim the same one.
  const keptIdx = twin
    ? (mode === "adv" ? (dice[0].v >= dice[1].v ? 0 : 1) : (dice[0].v <= dice[1].v ? 0 : 1))
    : -1;
  const sum = twin ? dice[keptIdx].v
    : dice.reduce((n, x) => n + x.v * (x.sign === -1 ? -1 : 1), 0);
  return {
    dice, keptIdx, mode: twin ? mode : "normal", spec: norm,
    total: sum + norm.mod,
    natural: single && dice[twin ? keptIdx : 0].s === 20 ? dice[twin ? keptIdx : 0].v : 0,
  };
}

/* How a roll is written out: "2d6 + 1d8 + 3". Used on the button, in the overlay and in the log, so all
   three agree about what was thrown. */
function tblSpecText(spec) {
  const norm = tblNormaliseSpec(spec);
  if (!norm) return "";
  const parts = norm.terms.map((t, i) => {
    const die = `${t.count === 1 ? "" : t.count}d${t.sides}`;
    if (i === 0) return (t.sign === -1 ? "−" : "") + die;
    return (t.sign === -1 ? " − " : " + ") + die;
  });
  if (norm.mod) parts.push((norm.mod > 0 ? " + " : " − ") + Math.abs(norm.mod));
  return parts.join("");
}

/* One line, readable at a glance from across a table, with the working shown because "18" on its own
   is exactly the number people query. */
function tblRollLine(who, label, res) {
  who = esc(who || "Someone");
  label = label ? esc(label) : "";
  const faces = res.dice.map((x) => x.v);
  const many = res.dice.length > 1;
  const shown = many
    ? `[${faces.join(", ")}]${res.mode === "adv" ? " keep high" : res.mode === "dis" ? " keep low" : ""}`
    : String(faces[0]);
  const spec = tblSpecText(res.spec);
  // Named rolls say what they were for; a bare handful of dice does not need "rolled 2d8: 2d8".
  const head = label ? `${who} rolled ${label}: ${spec}` : `${who} rolled ${spec}`;
  // A single straight die IS its own total: "d20 → 18 = 18" is how an app ends up printing "18 18".
  return `${head} → ${shown}${many || res.spec.mod !== 0 ? " = " + res.total : ""}`;
}

/* Roll, and put it where the table can see it. Away from a table the same click still works — it just
   answers on your own screen, because a sheet is useful on its own. */
function tblRollAndPost(spec, label, mode, whoOverride) {
  const parsed = typeof spec === "string" ? tblParseRoll(spec) : spec;
  if (!parsed) return null;
  const res = tblDoRoll(parsed, mode || "normal");
  // A roll thrown off an open sheet belongs to that CHARACTER, whoever is holding the device — which
  // is what makes the log readable when the DM is running an NPC from a real sheet.
  const who = whoOverride || (tbl ? (tbl.me.name || (tbl.role === "dm" ? "DM" : "Player")) : "You");
  const text = tblRollLine(who, label, res);
  const entry = {
    t: Date.now(), who, kind: "roll", text,
    nat: res.natural === 20 ? 20 : res.natural === 1 ? 1 : 0,
    // The numbers, not just the sentence: every screen at the table renders the roll itself from these,
    // and a sentence cannot be animated or laid out.
    label: label || "",
    // `dice` is the roll: every die with the size it came off, so a mixed handful reads properly on every
    // screen. `spec` is what was asked for, written out.
    dice: res.dice, keptIdx: res.keptIdx, mod: res.spec.mod, mode: res.mode, total: res.total,
    spec: tblSpecText(res.spec),
  };
  if (tbl) {
    // Shown here at once, and marked as seen so the stream's echo does not roll it a second time.
    tbl.lastRollAt = entry.t;
    tblShowRoll(entry);
    CocLive.push(tblPath("log"), entry).catch(() => {});
  } else {
    tblShowRoll(entry);
  }
  return res;
}

/* A roll you can WATCH. "17" appearing in a list is information; a die tumbling and landing on 17 is
   the moment everyone looks up for, and it costs one element and no library. The same overlay is used
   on a sheet away from a table, because a roll is a roll.
   Built in JS rather than in index.html because every page can roll, and none of them should have to
   carry the markup for it. */
let tblRollTimers = [];
function tblRollStage() {
  let node = document.getElementById("roll-stage");
  if (!node) {
    node = document.createElement("div");
    node.id = "roll-stage";
    node.className = "roll-stage";
    node.addEventListener("click", () => node.classList.remove("on"));
    document.body.appendChild(node);
  }
  return node;
}

function tblShowRoll(entry) {
  if (!entry) return;
  const node = tblRollStage();
  for (const t of tblRollTimers) clearTimeout(t);
  tblRollTimers = [];
  const dice = tblEntryDice(entry);
  const mod = Number(entry.mod) || 0;
  const nat = entry.nat === 20 ? "nat20" : entry.nat === 1 ? "nat1" : "";
  // Each die gets a face that will tumble, and carries the size it came off — so a mixed handful reads
  // as "d8 d6 d6" rather than as three anonymous numbers. The discarded one of an advantage pair stays
  // visible and dimmed, because "which one did I keep" is the first question anyone asks.
  const keptIdx = entry.keptIdx == null ? -1 : Number(entry.keptIdx);
  const faces = dice.map((x, i) => {
    const dropped = keptIdx >= 0 && i !== keptIdx ? " dropped" : "";
    return `<span class="die${dropped}" data-final="${esc(x.v)}" data-sides="${esc(x.s)}">` +
      `<b>${esc(x.v)}</b><em>d${esc(x.s)}</em></span>`;
  }).join("");
  const spec = entry.spec
    || tblSpecText({ terms: dice.map((x) => ({ count: 1, sides: x.s, sign: 1 })), mod });
  node.className = "roll-stage on rolling " + nat;
  node.innerHTML = `<div class="roll-box">
    <p class="roll-head"><strong>${esc(entry.who || "Someone")}</strong>${
      entry.label ? ` &middot; ${esc(entry.label)}` : ""}</p>
    <div class="roll-dice">${faces}</div>
    <p class="roll-sum">
      <span class="roll-spec">${esc(spec)}${
        entry.mode === "adv" ? " · advantage" : entry.mode === "dis" ? " · disadvantage" : ""}</span>
      ${dice.length > 1 || mod ? `<span class="roll-total">${esc(entry.total)}</span>` : ""}
    </p>
  </div>`;
  // The tumble: real dice do not fade in, they clatter. Each settles within its OWN range, so a d4 in a
  // mixed handful never flashes a 17 on its way to landing.
  const shown = [...node.querySelectorAll(".die")];
  let ticks = 0;
  const spin = setInterval(() => {
    ticks += 1;
    for (const die of shown) {
      const sides = Number(die.dataset.sides) || 20;
      die.querySelector("b").textContent = String(1 + Math.floor(Math.random() * sides));
    }
    if (ticks > 9) {
      clearInterval(spin);
      for (const die of shown) die.querySelector("b").textContent = die.dataset.final;
      node.classList.remove("rolling");
      node.classList.add("landed");
    }
  }, 55);
  tblRollTimers.push(setTimeout(() => node.classList.remove("on"), 3200));
}

const TBL_DICE = [4, 6, 8, 10, 12, 20, 100];

function tblDicePool() {
  if (!tbl.ui.dice || !tbl.ui.dice.pool) tbl.ui.dice = { pool: { 20: 1 }, mod: 0, mode: "normal" };
  return tbl.ui.dice;
}
/* The pool as a roll: biggest die first, which is how everyone writes damage. */
function tblPoolSpec() {
  const t = tblDicePool();
  const terms = Object.keys(t.pool)
    .map(Number)
    .filter((sides) => t.pool[sides] > 0)
    .sort((a, b) => b - a)
    .map((sides) => ({ count: t.pool[sides], sides, sign: 1 }));
  return { terms, mod: t.mod || 0 };
}

function dicePanelHTML() {
  const t = tblDicePool();
  const spec = tblPoolSpec();
  const text = tblSpecText(spec);
  const inPool = spec.terms.length;
  const oneDie = inPool === 1 && spec.terms[0].count === 1;
  return `<section class="panel">
      <h2>Dice</h2>
      <div class="chips">${TBL_DICE.map((sides) =>
        `<button class="chip ${t.pool[sides] ? "on" : ""}" data-tbl="die" data-val="${sides}">d${sides}</button>`).join("")}</div>
      ${inPool ? `<p class="panel-sub">Throwing <span class="muted">— tap one to take it back out</span></p>
        <div class="chips">${spec.terms.map((term) =>
          `<button class="chip on" data-tbl="die-less" data-val="${term.sides}">${
            term.count === 1 ? "" : term.count}d${term.sides} &minus;</button>`).join("")}
          <button class="chip" data-tbl="dice-clear">Clear</button></div>`
        : `<p class="muted">Tap the dice you want. Several kinds at once is the point: a smite is a d8 and
           2d6 and a d4 if it is on fire, thrown together and added up for you.</p>`}
      <div class="dice-row">
        <span class="stepper"><span class="ab-name">Modifier</span>
          <button class="step-btn" data-tbl="dice-mod" data-val="-1">&minus;</button>
          <span class="step-val">${esc(t.mod > 0 ? "+" + t.mod : t.mod)}</span>
          <button class="step-btn" data-tbl="dice-mod" data-val="1">+</button></span>
      </div>
      <div class="chips">${[["normal", "Straight"], ["adv", "Advantage"], ["dis", "Disadvantage"]].map(([k, label]) =>
        `<button class="chip ${t.mode === k ? "on" : ""}" data-tbl="dice-mode" data-val="${k}">${esc(label)}</button>`).join("")}
      </div>
      ${!oneDie && t.mode !== "normal" ? `<p class="muted">Advantage needs a single die — with a handful
        it is ignored.</p>` : ""}
      <button class="btn" data-tbl="roll-pool" ${inPool ? "" : "disabled"}>Roll ${esc(text || "…")}</button>
    </section>
    <section class="panel">
      <p class="panel-sub">Rolls at this table</p>
      <div id="vtt-log" class="roll-log"></div>
    </section>`;
}

/* Old entries carry `rolls: [11]` with a single `sides`; new ones carry `dice: [{s,v}]`. One shape from
   here on, so no renderer has to know there were ever two. */
function tblEntryDice(e) {
  if (Array.isArray(e.dice)) return e.dice;
  if (Array.isArray(e.rolls)) return e.rolls.map((v) => ({ s: Number(e.sides) || 20, v }));
  return [];
}
/* A single straight die needs no dice-AND-total: printing both is how you get "DM 18 18". */
function tblRollBits(e) {
  const dice = tblEntryDice(e);
  const mod = Number(e.mod) || 0;
  const keptIdx = e.keptIdx == null ? -1 : Number(e.keptIdx);
  const bare = dice.length === 1 && !mod && keptIdx < 0;
  return {
    pips: bare ? "" : dice.map((x, i) =>
      `<span class="pip-die${keptIdx >= 0 && i !== keptIdx ? " dropped" : ""}">${esc(x.v)}</span>`).join(""),
    mod: mod ? `<span class="roll-card-mod">${mod > 0 ? "+" : "−"}${esc(Math.abs(mod))}</span>` : "",
    total: dice.length ? String(e.total) : "",
  };
}

/* The newest roll, in one line, for the bar that is visible whatever panel is open. */
function lastRollHTML(e) {
  if (e.kind !== "roll" || !tblEntryDice(e).length) return esc(e.text || "");
  const bits = tblRollBits(e);
  return `<strong>${esc(e.who || "Someone")}</strong>${e.label ? " " + esc(e.label) : ""} ${bits.pips}` +
    `${bits.mod}<span class="roll-card-total">${esc(bits.total)}</span>`;
}

/* One line of the log. Laid out rather than written as a sentence: who, what for, the dice as dice, and
   the total big enough to read from across a table. Entries from before this existed, and the DM's
   system lines, still have their sentence and fall back to it. */
function rollLineHTML(e) {
  const nat = e.nat === 20 ? " nat20" : e.nat === 1 ? " nat1" : "";
  if (e.kind !== "roll" || !tblEntryDice(e).length) {
    return `<p class="roll-line${nat}">${esc(e.text || "")}</p>`;
  }
  const bits = tblRollBits(e);
  return `<div class="roll-line roll-card${nat}">
    <span class="roll-card-who">${esc(e.who || "Someone")}${e.label ? ` <span class="muted">${esc(e.label)}</span>` : ""}</span>
    <span class="roll-card-dice">${bits.pips}${bits.mod}</span>
    <span class="roll-card-total">${esc(bits.total)}</span>
  </div>`;
}

/* The log is newest-first: a side panel on a phone has no room to auto-scroll, and the roll you care
   about is the one that just happened. */
function paintLog() {
  const last = $("#vtt-lastroll");
  const entries = Object.entries(tbl.data.log || {}).sort((a, b) => (b[1].t || 0) - (a[1].t || 0));
  // Somebody else's roll is rolled on your screen too — that is the point of everyone being here. The
  // first paint only records where the log had got to, or joining would replay the whole session.
  const newest = entries.length ? entries[0][1] : null;
  if (tbl.lastRollAt == null) tbl.lastRollAt = newest ? (newest.t || 0) : 0;
  else if (newest && (newest.t || 0) > tbl.lastRollAt) {
    tbl.lastRollAt = newest.t;
    if (newest.kind === "roll") tblShowRoll(newest);
  }
  if (last) {
    const top = entries[0];
    // Built from the numbers, not from the stored sentence: the sentence is a fallback for old entries
    // and for the DM's system lines, and a bar that reads whatever prose was saved cannot be relied on.
    last.innerHTML = top ? lastRollHTML(top[1]) : "";
    last.classList.toggle("hidden", !top);
    last.classList.toggle("nat20", !!(top && top[1].nat === 20));
    last.classList.toggle("nat1", !!(top && top[1].nat === 1));
  }
  const host = $("#vtt-log");
  if (host) {
    host.innerHTML = entries.slice(0, 60).map(([, e]) => rollLineHTML(e)).join("")
      || `<p class="muted">Nothing rolled yet.</p>`;
  }
  // A log nobody prunes grows for as long as the table exists. The DM's browser does it, once it is
  // clearly long, and only ever to the oldest entries.
  if (tbl.role === "dm" && entries.length > 150) {
    for (const [id] of entries.slice(120)) CocLive.del(tblPath("log/" + id)).catch(() => {});
  }
}

/* ---------------------------------------------------------------- distance, and the ruler */

/* Five feet a square, and a diagonal costs the same as a straight line — the ordinary grid rule. It
   lives in one function because the ruler you watch while dragging and the total that is charged to
   your movement when you let go MUST be the same number, or the app is lying to you. */
const TBL_FEET_PER_SQUARE = 5;
function tblFeetBetween(x0, y0, x1, y1) {
  const dx = Math.abs(Math.round(x1) - Math.round(x0));
  const dy = Math.abs(Math.round(y1) - Math.round(y0));
  return Math.max(dx, dy) * TBL_FEET_PER_SQUARE;
}

/* The line you see while dragging, with the distance at the end of it. The line is drawn in the
   world (so it sits on the map, under the camera); the label is drawn in the stage (so it stays
   readable however far you are zoomed out). */
function paintRuler() {
  const svg = $("#vtt-ruler"), label = $("#vtt-measure");
  if (!svg || !label) return;
  const drag = tbl.drag;
  if (!drag || drag.pan) { svg.innerHTML = ""; label.classList.add("hidden"); return; }
  const scene = tblScene();
  const cell = Number(scene.cell) || 70;
  const size = Math.max(1, Number(drag.token.size) || 1);
  const half = (size * cell) / 2;
  const x0 = drag.fromX * cell + half, y0 = drag.fromY * cell + half;
  const x1 = drag.x * cell + half, y1 = drag.y * cell + half;
  svg.innerHTML = `<line x1="${x0}" y1="${y0}" x2="${x1}" y2="${y1}" class="ruler-line" />
    <circle cx="${x0}" cy="${y0}" r="${Math.max(4, cell * 0.08)}" class="ruler-dot" />`;
  const feet = tblFeetBetween(drag.fromX, drag.fromY, drag.x, drag.y);
  const budget = tblBudgetFor(drag.id, drag.token);
  label.classList.remove("hidden");
  label.style.left = (tbl.view.x + x1 * tbl.view.z) + "px";
  label.style.top = (tbl.view.y + y1 * tbl.view.z) + "px";
  // The budget is only shown when it means something: it is your turn, and this is your figure.
  const over = budget && feet > budget.left;
  label.className = "vtt-measure" + (over ? " over" : "");
  label.textContent = budget
    ? `${feet} ft — ${Math.max(0, budget.left - feet)} of ${budget.speed} left`
    : `${feet} ft`;
}

/* What this token has left to walk this turn, or null when the question does not apply. Nothing is
   ever BLOCKED: difficult terrain, dashing and every other reason to go further are settled out loud
   at the table (Kayki's call), so the app's job is to tell you the number, not to police it. */
function tblBudgetFor(id, token) {
  const turn = (tbl.data.meta || {}).turn;
  if (!turn || !Array.isArray(turn.order) || turn.order[turn.idx] !== id) return null;
  const speed = Math.max(0, Number(token.speed) || 30);
  const used = Math.max(0, Number(token.moved) || 0);
  return { speed, used, left: Math.max(0, speed - used) };
}

/* Charged on release, from the same function the ruler used. */
function tblCountMove(drag, x, y) {
  const feet = tblFeetBetween(drag.fromX, drag.fromY, x, y);
  if (!feet) return;
  const used = Math.max(0, Number(drag.token.moved) || 0) + feet;
  CocLive.put(tblPath("tokens/" + drag.id + "/moved"), used).catch(() => {});
}

/* ---------------------------------------------------------------- turn order */

/* Initiative is rolled for everyone at once, by the DM, because that is how it happens at a table:
   somebody says "roll initiative" and then reads the order out. Each token carries the modifier its
   character sheet works out, so this is the same number the player would have added by hand. */
async function tblRollInitiative() {
  const activeScene = tblSceneId();
  const rolled = [];
  for (const [id, t] of Object.entries(tblTokens())) {
    if (!t) continue;
    if (t.kind === "npc" && t.scene && t.scene !== activeScene) continue;
    const mod = Number(t.initMod) || 0;
    const res = tblDoRoll({ count: 1, sides: 20, mod }, "normal");
    rolled.push({ id, name: t.name || "Someone", total: res.total, mod });
    await CocLive.put(tblPath("tokens/" + id + "/init"), res.total);
    await CocLive.put(tblPath("tokens/" + id + "/moved"), 0);
  }
  // Highest first; a tie is broken by the modifier, then by name, so the order is at least stable
  // rather than whatever key order the database happens to return.
  rolled.sort((a, b) => b.total - a.total || b.mod - a.mod || a.name.localeCompare(b.name));
  await CocLive.put(tblPath("meta/turn"), {
    order: rolled.map((r) => r.id), idx: 0, round: 1, startedAt: Date.now(),
  });
  await CocLive.push(tblPath("log"), {
    t: Date.now(), who: "DM", kind: "system",
    text: "Initiative — " + rolled.map((r) => `${r.name} ${r.total}`).join(", "),
  });
}

async function tblTurnStep(delta) {
  const turn = (tbl.data.meta || {}).turn;
  if (!turn || !Array.isArray(turn.order) || !turn.order.length) return;
  const n = turn.order.length;
  let idx = turn.idx + delta;
  let round = turn.round || 1;
  if (idx >= n) { idx = 0; round += 1; }
  if (idx < 0) { idx = n - 1; round = Math.max(1, round - 1); }
  await CocLive.patch(tblPath("meta/turn"), { idx, round });
  // A turn starts with your movement unspent. Reset on ARRIVAL rather than on departure, so someone
  // who steps back through the order does not find a spent budget waiting for them.
  const id = turn.order[idx];
  if (id) await CocLive.put(tblPath("tokens/" + id + "/moved"), 0);
}

async function tblTurnEnd() {
  await CocLive.put(tblPath("meta/turn"), null);
}

/* The bar above the board: whose turn it is, what round, and what they have left to walk. Everyone
   sees it; the DM can move it along, and so can whoever's turn it is — pressing "Done" on your own
   turn is the one piece of the tracker a player should not have to ask for. */
function paintTurnBar() {
  const bar = $("#vtt-turn");
  if (!bar) return;
  const turn = (tbl.data.meta || {}).turn;
  const tokens = tblTokens();
  const order = turn && Array.isArray(turn.order) ? turn.order.filter((id) => tokens[id]) : [];
  // Highlight has to be cleared even when the tracker is off, or a stale ring stays on a token.
  const currentId = order.length ? order[Math.min(turn.idx || 0, order.length - 1)] : "";
  document.querySelectorAll("#vtt-tokens .tok").forEach((n) =>
    n.classList.toggle("turn", n.dataset.token === currentId));
  if (!order.length) {
    bar.classList.toggle("hidden", tbl.role !== "dm");
    if (tbl.role === "dm") {
      bar.innerHTML = `<span class="muted">No turn order.</span>
        <button class="btn-quiet" data-tbl="init-roll">Roll initiative</button>`;
    }
    return;
  }
  bar.classList.remove("hidden");
  const t = tokens[currentId] || {};
  const budget = tblBudgetFor(currentId, t);
  const mine = !!t.charCode && t.charCode === tbl.me.charCode;
  const canStep = tbl.role === "dm" || mine;
  const upNext = order[(order.indexOf(currentId) + 1) % order.length];
  bar.innerHTML = `<span class="turn-round">Round ${esc(turn.round || 1)}</span>
    <strong class="turn-who">${esc(t.name || "?")}${mine ? " — you" : ""}</strong>
    ${budget ? `<span class="turn-move ${budget.left ? "" : "spent"}">${esc(budget.left)} of ${esc(budget.speed)} ft left</span>` : ""}
    ${upNext && upNext !== currentId ? `<span class="muted">next: ${esc((tokens[upNext] || {}).name || "?")}</span>` : ""}
    <span class="turn-acts">
      ${canStep ? `<button class="btn-quiet" data-tbl="turn" data-val="1">${mine && tbl.role !== "dm" ? "Done" : "Next"} &rarr;</button>` : ""}
      ${tbl.role === "dm" ? `<button class="btn-quiet" data-tbl="turn" data-val="-1">&larr; Back</button>
        <button class="btn-quiet" data-tbl="init-roll">Reroll</button>
        <button class="btn-quiet" data-tbl="turn-end">End</button>` : ""}
    </span>`;
}
/* ---------------------------------------------------------------- your sheet, over the board */

/* The whole point of the exercise: the sheet you already have, in the same tab as the map, without
   losing your place on either. It is the REAL sheet — same renderer, same buttons, same live saving —
   rendered into the drawer instead of into the page (see openSheetIn in creator.js). Nothing here is
   a cut-down copy, because a cut-down copy is the thing that sends people back to the other app. */
function paintSheetPanel() {
  const side = $("#vtt-side");
  if (!side) return;
  const code = tbl.me.charCode;
  // The DM has no character of their own, but often wants one open — an NPC with a real sheet, or a
  // player's, read out over their shoulder. So they get a box instead of a refusal.
  if (!code || tbl.role === "dm") {
    side.innerHTML = `<section class="panel">
        <h2>Open a sheet</h2>
        <p class="muted">${tbl.role === "dm"
          ? "Any character, by code — an NPC you run from a real sheet, or a player's while you talk them through it."
          : "You joined without a character code. Type one and it opens here, beside the board."}</p>
        <div class="join-row">
          <label class="field"><span>Character code</span>
            <input id="vtt-sheet-code" class="text code-input" type="text" inputmode="numeric"
              maxlength="6" placeholder="123456" autocomplete="off" /></label>
          <button class="btn" data-tbl="sheet-open">Open</button>
        </div>
        <p id="vtt-sheet-msg" class="save-msg"></p>
      </section>
      <div id="vtt-sheet"></div>`;
    return;
  }
  tblShowSheet(code);
}

function tblShowSheet(code) {
  const side = $("#vtt-side");
  side.innerHTML = `<div class="sheet-drawer-bar">
      <span class="muted">Sheet</span>
      <button class="btn-quiet" data-tbl="sheet-close">Close</button>
    </div>
    <div id="vtt-sheet"><p class="muted">Loading…</p></div>`;
  openSheetIn("#vtt-sheet", code).catch((err) => {
    const host = $("#vtt-sheet");
    if (host) host.innerHTML = `<p class="warn">${esc(err.message)}</p>`;
  });
}

async function tblOpenSheetByCode() {
  const box = $("#vtt-sheet-code");
  const msg = $("#vtt-sheet-msg");
  const code = String(box ? box.value : "").replace(/\D/g, "");
  if (!CocStore.validCode(code)) {
    if (msg) { msg.textContent = "Six digits."; msg.className = "save-msg bad"; }
    return;
  }
  tblShowSheet(code);
}

/* Hit points changed on a sheet, reflected under the figure on the board — for everyone. Called by
   the sheet's own save path (creator.js), so it fires on damage, healing and a level-up alike, and
   only ever touches the token that carries that character code. */
function tblSyncTokenFromSheet(code, ch) {
  if (!tbl || !code || !ch) return;
  const d = (typeof derive === "function") ? derive(ch) : null;
  const hp = ch.play && ch.play.hp != null ? Number(ch.play.hp) : null;
  const hpMax = d ? d.hpMax : null;
  for (const [id, t] of Object.entries(tblTokens())) {
    if (!t || t.charCode !== code) continue;
    const patch = {};
    if (hp != null && Number(t.hp) !== hp) patch.hp = hp;
    if (hpMax != null && Number(t.hpMax) !== hpMax) patch.hpMax = hpMax;
    // A name or a portrait can change between sessions; the figure should not be the last one to know.
    if (ch.name && t.name !== String(ch.name).slice(0, 40)) patch.name = String(ch.name).slice(0, 40);
    if (Object.keys(patch).length) CocLive.patch(tblPath("tokens/" + id), patch).catch(() => {});
  }
}

/* ---------------------------------------------------------------- figures on the board */

/* The BARE minimum, deliberately. Kayki's next project is enemies as real content — a bestiary with
   stat blocks — so anything invented here would be thrown away or, worse, become the thing the real
   version has to stay compatible with. A figure is therefore a name, hit points, a size and a
   picture: enough to run a fight tonight, and a clean seam for a monster id to be added later. */
async function tblSpawn() {
  const msg = $("#tbl-spawn-msg");
  const say = (t, bad) => { if (msg) { msg.textContent = t; msg.className = "save-msg" + (bad ? " bad" : ""); } };
  const name = String(($("#tbl-npc-name") || {}).value || "").trim().slice(0, 40);
  const hp = Math.max(0, Number(($("#tbl-npc-hp") || {}).value) || 0);
  const size = Math.max(1, Math.min(4, Number(($("#tbl-npc-size") || {}).value) || 1));
  const image = String(($("#tbl-npc-img") || {}).value || "").trim();
  if (!name) return say("Give it a name — a board of unnamed markers is unreadable.", true);
  await tblPlaceNpc({ name, hp, hpMax: hp, size, image, shape: tbl.ui.npcShape || "square" });
  say("Dropped " + name + " on the board.");
}

/* Placed in the middle of what the DM is currently looking at, not at a fixed corner: a monster that
   appears off-screen has to be hunted for before it can be used. */
function tblCentreSquare() {
  const stage = $("#vtt-stage");
  const scene = tblScene();
  const cell = Number(scene.cell) || 70;
  const box = stage ? stage.getBoundingClientRect() : { width: 0, height: 0 };
  const cx = ((box.width / 2) - tbl.view.x) / tbl.view.z / cell;
  const cy = ((box.height / 2) - tbl.view.y) / tbl.view.z / cell;
  const cols = Number(scene.cols) || 30, rows = Number(scene.rows) || 20;
  return {
    x: Math.max(0, Math.min(cols - 1, Math.round(cx) || 1)),
    y: Math.max(0, Math.min(rows - 1, Math.round(cy) || 1)),
  };
}

async function tblPlaceNpc(fields) {
  const at = tblCentreSquare();
  // Nudged along until it lands on an empty square, so a duplicate never hides underneath its twin.
  const size = Math.max(1, Number(fields && fields.size) || 1);
  const spot = tblFreeSquare("", at.x, at.y, size, at.x, at.y);
  const x = spot.x, y = spot.y;
  const id = CocLive.newId();
  await CocLive.put(tblPath("tokens/" + id), Object.assign({
    name: "Figure", hp: 0, hpMax: 0, size: 1, image: "", speed: 30, initMod: 0, shape: "square",
  }, fields, {
    kind: "npc",
    scene: tblSceneId(),      // monsters belong to the map they were put on
    x, y,
  }));
  return id;
}

/* "Goblin" then "Goblin 2", "Goblin 3" — the naming a DM does out loud anyway. */
async function tblDuplicate(id) {
  const t = tblTokens()[id];
  if (!t) return;
  const base = String(t.name || "Figure").replace(/\s+\d+$/, "");
  const used = Object.values(tblTokens())
    .filter((o) => o && String(o.name || "").replace(/\s+\d+$/, "") === base).length;
  const copy = Object.assign({}, t, { name: (base + " " + (used + 1)).slice(0, 40), moved: 0, init: null });
  delete copy.init;
  await tblPlaceNpc(copy);
}

/* Double-tapping a figure opens it. For a player that is a look at their own numbers; for the DM it is
   the editor, which is the only place a monster's hit points can be changed. */
/* Conditions a figure can be under. The same words the sheet uses for a player, so the table has one
   vocabulary; the DM sets them on a monster and everyone can read them. */
/* A player's figure is a SQUARE — it stands on a square, and a circle among squares reads as an area
   rather than a person. The DM chooses per figure, because building a scene means marking things that
   are not people: a pit, a rune, a zone. (The Illusionist's areas will want this too, which is why the
   list is data rather than two hard-coded cases.) */
const TBL_SHAPES = [["square", "Square"], ["circle", "Circle"], ["triangle", "Triangle"], ["diamond", "Diamond"]];
const TBL_SHAPE_IDS = TBL_SHAPES.map(([k]) => k);
function tblShapeOf(t) {
  // A player's figure is always a square, whatever is stored — one less thing to get wrong at a table.
  if (t.kind !== "npc") return "square";
  return TBL_SHAPE_IDS.includes(t.shape) ? t.shape : "square";
}

const TBL_CONDITION_NAMES = {
  prone: "Prone", grappled: "Grappled", restrained: "Restrained", frightened: "Frightened",
  blinded: "Blinded", stunned: "Stunned", poisoned: "Poisoned", concentrating: "Concentrating",
  bloodied: "Bloodied", down: "Down",
};

function tblOpenToken(id) {
  const t = tblTokens()[id];
  if (!t) return;
  if (tbl.role === "dm") {
    tbl.ui.editToken = id;
    tbl.ui.panel = "dm";
    paintSide();
    return;
  }
  // A player gets their own sheet for their own figure, and a read-only look at anything else. Being
  // told nothing at all about the thing about to eat you was the wrong answer.
  if (t.charCode && t.charCode === tbl.me.charCode) { tbl.ui.panel = "sheet"; paintSide(); return; }
  tbl.ui.lookAt = id;
  tbl.ui.panel = "figure";
  paintSide();
}

/* What a player can see about a figure: what it is, how hurt it is, what it is suffering from, and how
   far it moves. Read-only — only the DM changes any of it. */
function figureInfoHTML(id) {
  const t = tblTokens()[id];
  if (!t) {
    return `<section class="panel"><p class="muted">No figure yet. It appears a moment after you sit
      down — if it does not, leave and come back in.</p></section>`;
  }
  // Your own figure, in a game with no Circus of Chaos sheet behind it: this IS your sheet, so it is
  // yours to change. Somebody else's is read-only.
  if (tblIsMine(t) && !tbl.me.charCode) return myFigureHTML(id, t);
  const pct = t.hpMax ? Math.max(0, Math.min(100, Math.round((Number(t.hp) || 0) / t.hpMax * 100))) : 0;
  const showHp = tbl.role === "dm" || tblIsMine(t);
  const conds = Array.isArray(t.conditions) ? t.conditions : [];
  return `<section class="panel">
    <h2>${esc(t.name || "Figure")}</h2>
    ${t.image ? `<img class="figure-art" src="${esc(t.image)}" alt="" />` : ""}
    ${showHp && t.hpMax ? `<div class="hp-head"><span class="panel-sub">Hit points</span>
        <div class="hp-num ${pct <= 25 ? "hurt" : ""}"><strong>${esc(t.hp)}</strong><span>/ ${esc(t.hpMax)}</span></div></div>
      <div class="hp-bar"><div class="hp-fill ${pct <= 25 ? "hurt" : ""}" style="width:${pct}%"></div></div>`
      : showHp ? `<p class="muted">No hit points recorded for this one.</p>`
      : `<p class="muted">How badly hurt it is, is the DM's to know.</p>`}
    <p class="panel-sub">Conditions</p>
    <div class="chips">${conds.length
      ? conds.map((c) => `<span class="chip on">${esc(TBL_CONDITION_NAMES[c] || c)}</span>`).join("")
      : `<span class="muted">None.</span>`}</div>
    <p class="panel-sub">Speed</p>
    <p>${esc(Number(t.speed) || 30)} ft${t.size > 1 ? ` <span class="muted">· ${esc(t.size)} squares across</span>` : ""}</p>
    <p class="muted">Read-only: the DM owns this figure. Double-tap any figure to look at it.</p>
  </section>`;
}

function tokenEditorHTML(id) {
  const t = tblTokens()[id];
  if (!t) return "";
  return `<section class="panel">
    <h2>${esc(t.name || "Figure")}</h2>
    <div class="grid-row">
      <label class="field"><span>Name</span>
        <input id="ed-name" class="text" type="text" maxlength="40" value="${esc(t.name || "")}" /></label>
    </div>
    <div class="grid-row">
      <label class="field"><span>Hit points</span>
        <input id="ed-hp" class="num" type="number" min="0" value="${esc(Number(t.hp) || 0)}" /></label>
      <label class="field"><span>Out of</span>
        <input id="ed-hpmax" class="num" type="number" min="0" value="${esc(Number(t.hpMax) || 0)}" /></label>
      <label class="field"><span>Squares</span>
        <input id="ed-size" class="num" type="number" min="1" max="4" value="${esc(Number(t.size) || 1)}" /></label>
    </div>
    <div class="grid-row">
      <label class="field"><span>Speed (ft)</span>
        <input id="ed-speed" class="num" type="number" min="0" max="200" value="${esc(Number(t.speed) || 30)}" /></label>
      <label class="field"><span>Initiative bonus</span>
        <input id="ed-init" class="num" type="number" min="-5" max="20" value="${esc(Number(t.initMod) || 0)}" /></label>
    </div>
    <label class="field"><span>Picture (URL, or maps/… )</span>
      <input id="ed-img" class="text" type="text" value="${esc(t.image || "")}" /></label>
    ${t.kind === "npc" ? `<p class="panel-sub">Shape</p>
      <div class="chips">${TBL_SHAPES.map(([k, label]) =>
        `<button class="chip ${tblShapeOf(t) === k ? "on" : ""}" data-tbl="ed-shape"
          data-val="${esc(id)}|${k}"><span class="shape-dot shape-${k}"></span>${esc(label)}</button>`).join("")}</div>`
      : `<p class="muted">A player's figure is always a square.</p>`}
    <p class="panel-sub">Conditions <span class="muted">— every player can read these</span></p>
    <div class="chips">${Object.entries(TBL_CONDITION_NAMES).map(([k, label]) => {
      const on = Array.isArray(t.conditions) && t.conditions.includes(k);
      return `<button class="chip ${on ? "on" : ""}" data-tbl="ed-cond" data-val="${esc(id)}|${k}">${esc(label)}</button>`;
    }).join("")}</div>
    <div class="hp-controls">
      <button class="btn" data-tbl="ed-save" data-val="${esc(id)}">Save</button>
      <button class="btn-quiet" data-tbl="ed-dup" data-val="${esc(id)}">Duplicate</button>
      ${t.kind === "npc" ? `<button class="btn-quiet" data-tbl="ed-del" data-val="${esc(id)}">Remove</button>` : ""}
      <button class="btn-quiet" data-tbl="ed-close">Close</button>
    </div>
    ${t.charCode ? `<p class="muted">This is a player's figure — its hit points follow their sheet, so
      changing them here is a stopgap, not the record.</p>` : ""}
  </section>`;
}

async function tblSaveToken(id) {
  const patch = {
    name: String(($("#ed-name") || {}).value || "Figure").slice(0, 40),
    hp: Math.max(0, Number(($("#ed-hp") || {}).value) || 0),
    hpMax: Math.max(0, Number(($("#ed-hpmax") || {}).value) || 0),
    size: Math.max(1, Math.min(4, Number(($("#ed-size") || {}).value) || 1)),
    speed: Math.max(0, Math.min(200, Number(($("#ed-speed") || {}).value) || 0)),
    initMod: Math.max(-5, Math.min(20, Number(($("#ed-init") || {}).value) || 0)),
    image: String(($("#ed-img") || {}).value || "").trim(),
  };
  await CocLive.patch(tblPath("tokens/" + id), patch);
}

/* A guest's figure is the only record they have here, so they keep it themselves: their name, their hit
   points, their picture, and the conditions they are under. Any system, no sheet required. */
function myFigureHTML(id, t) {
  const conds = Array.isArray(t.conditions) ? t.conditions : [];
  return `<section class="panel">
    <h2>Your figure</h2>
    <label class="field"><span>Name</span>
      <input id="mine-name" class="text" type="text" maxlength="40" value="${esc(t.name || "")}" /></label>
    <div class="grid-row">
      <label class="field"><span>Hit points</span>
        <input id="mine-hp" class="num" type="number" min="0" value="${esc(Number(t.hp) || 0)}" /></label>
      <label class="field"><span>Out of</span>
        <input id="mine-hpmax" class="num" type="number" min="0" value="${esc(Number(t.hpMax) || 0)}" /></label>
      <label class="field"><span>Speed (ft)</span>
        <input id="mine-speed" class="num" type="number" min="0" max="200" value="${esc(Number(t.speed) || 30)}" /></label>
    </div>
    <label class="field"><span>Picture (URL, optional)</span>
      <input id="mine-img" class="text" type="text" value="${esc(t.image || "")}" /></label>
    <div class="hp-controls">
      <button class="btn" data-tbl="mine-save" data-val="${esc(id)}">Save</button>
      <input id="mine-amt" class="num" type="number" min="1" value="1" />
      <button class="btn-quiet" data-tbl="mine-hp" data-val="${esc(id)}|-1">Damage</button>
      <button class="btn-quiet" data-tbl="mine-hp" data-val="${esc(id)}|1">Heal</button>
    </div>
    <p class="panel-sub">What you are under</p>
    <div class="chips">${Object.entries(TBL_CONDITION_NAMES).map(([k, label]) =>
      `<button class="chip ${conds.includes(k) ? "on" : ""}" data-tbl="mine-cond"
        data-val="${esc(id)}|${k}">${esc(label)}</button>`).join("")}</div>
    <p class="muted">Everyone at the table can read these, which is the point — the DM should not have
      to ask how you are doing.</p>
  </section>`;
}

/* Closing a table. A room is not a document somebody owns a copy of — it is the session everyone is
   sitting in, so deleting it ends the game for every device at once and cannot be undone. Hence the
   same shape as deleting a character: nothing happens on one tap, and the confirmation is the ROOM
   CODE, typed out, because "which table am I closing" is the mistake worth preventing. */
function closeTableHTML() {
  if (!tbl.ui.closeArmed) {
    return `<section class="panel danger" id="dm-close">
      <h2>Close this table</h2>
      <p class="muted">Deletes the room, its maps, its figures and its log — for everyone, on every
        device, with no undo. The room code becomes free for reuse.</p>
      <button class="btn-quiet" data-tbl="close-arm">Close the table…</button>
    </section>`;
  }
  return `<section class="panel danger armed" id="dm-close">
    <h2>Close this table</h2>
    <p class="muted">Type the room code — <strong>${esc(tbl.code)}</strong> — to unlock it. Everyone
      still in the room will be dropped out.</p>
    <div class="danger-row">
      <input id="close-confirm" class="text code-input" type="text" inputmode="numeric" maxlength="6"
        autocomplete="off" value="${esc(tbl.ui.closeText || "")}" />
      <button class="btn btn-hot" data-tbl="close-go" ${tbl.ui.closeText === tbl.code ? "" : "disabled"}>Close it</button>
      <button class="btn-quiet" data-tbl="close-cancel">Cancel</button>
    </div>
    <p id="close-msg" class="save-msg"></p>
  </section>`;
}

async function tblCloseTable() {
  if (tbl.role !== "dm" || tbl.ui.closeText !== tbl.code) return;
  const msg = $("#close-msg");
  const code = tbl.code;
  if (msg) { msg.textContent = "Closing…"; msg.className = "save-msg"; }
  try {
    await CocLive.del("tables/" + code);
    localStorage.removeItem(tblDmKey(code));
    localStorage.removeItem(tblMeKey(code));
    tblForgetTable(code);
    tblTeardown();
    location.hash = "#/table";
  } catch (err) {
    if (msg) { msg.textContent = "Could not close it: " + err.message; msg.className = "save-msg bad"; }
  }
}

/* Off this device's list, without touching the room itself — for a player who is done with a table
   somebody else owns. */
function tblForgetTable(code) {
  localStorage.setItem(TBL_RECENT, JSON.stringify(tblRecent().filter((r) => r.code !== code)));
}

/* ---------------------------------------------------------------- notes
 *
 * A notepad in the app, so a session does not need a text editor open beside it. Several notes, each with
 * a title, kept per person: the DM's follow the DM chair (so they are there on another device with the
 * key), a player's follow their character code, and a guest's follow their browser.
 *
 * They are stored in the table, which is what makes them survive a refresh and reach another device —
 * and which means anyone holding the room code could read them if they went digging. Said in the panel,
 * because a private-looking box that is not private is worse than no box. */
function tblNoteOwner() {
  if (tbl.role === "dm") return "dm";
  return tbl.me.charCode ? "pc:" + tbl.me.charCode : "browser:" + tbl.me.clientId;
}
function tblMyNotes() {
  const mine = tblNoteOwner();
  return Object.entries(tbl.data.notes || {})
    .filter(([, n]) => n && n.by === mine)
    .sort((a, b) => (a[1].at || 0) - (b[1].at || 0));
}

function notesPanelHTML() {
  const notes = tblMyNotes();
  const openId = tbl.ui.note && notes.some(([id]) => id === tbl.ui.note) ? tbl.ui.note : "";
  const open = openId ? (tbl.data.notes || {})[openId] : null;
  const list = notes.map(([id, n]) => `<div class="scene-row ${id === openId ? "on" : ""}">
      <button class="scene-pick" data-tbl="note-open" data-val="${esc(id)}">
        <strong>${esc(n.title || "Untitled")}</strong>
        <span class="muted">${esc(String(n.body || "").replace(/\s+/g, " ").slice(0, 40))}</span>
      </button>
      <button class="btn-quiet" data-tbl="note-del" data-val="${esc(id)}">Delete</button>
    </div>`).join("");
  return `<section class="panel" id="notes-panel">
      <h2>Notes</h2>
      <div class="scene-list">${list || `<p class="muted">Nothing written yet.</p>`}</div>
      <button class="btn-quiet" data-tbl="note-new">New note</button>
    </section>
    ${open ? `<section class="panel">
      <label class="field"><span>Title</span>
        <input id="note-title" class="text" type="text" maxlength="60" value="${esc(open.title || "")}" /></label>
      <label class="field"><span>Note</span>
        <textarea id="note-body" class="text notes-body" rows="12" maxlength="8000">${esc(open.body || "")}</textarea></label>
      <p class="muted">Saved as you type. Kept with the table, so it is here on your next device — and
        not secret: anyone with the room code could read it if they went looking.</p>
    </section>` : `<p class="muted">Open a note to write in it.</p>`}`;
}

async function tblNewNote() {
  const id = await CocLive.push(tblPath("notes"), {
    title: "New note", body: "", by: tblNoteOwner(), at: Date.now(),
  });
  tbl.ui.note = id;
  paintSide();
}

/* The DM used to have a single unnamed notes box. Anything already in it becomes the first note rather
   than being stranded somewhere the interface no longer shows. */
function tblMigrateDmNotes() {
  if (!tbl || tbl.role !== "dm") return;
  const old = (tbl.data.dm || {}).notes;
  if (!old || !String(old).trim()) return;
  CocLive.push(tblPath("notes"), { title: "Notes", body: String(old).slice(0, 8000), by: "dm", at: 1 })
    .then(() => CocLive.put(tblPath("dm/notes"), null))
    .catch(() => {});
}

/* ---------------------------------------------------------------- the DM's screen and handouts */

/* Notes that survive a refresh and follow the DM to another device — which means they live in the
   table, which means anyone holding the room code could read them if they went looking. Said out loud
   rather than implied, because the alternative (keeping them in this browser only) loses them the
   moment the DM picks up a different device mid-session. */
function dmScreenHTML() {
  const handouts = tbl.data.handouts || {};
  const showing = (tbl.data.meta || {}).handout || "";
  const rows = Object.entries(handouts)
    .sort((a, b) => (a[1].at || 0) - (b[1].at || 0))
    .map(([id, h]) => `<div class="scene-row ${showing === id ? "on" : ""}">
      <button class="scene-pick" data-tbl="hand-show" data-val="${esc(id)}">
        <strong>${esc(h.title || "Handout")}</strong>
        <span class="muted">${showing === id ? "on everyone's screen" : "show"}</span>
      </button>
      <button class="btn-quiet" data-tbl="hand-del" data-val="${esc(id)}">Delete</button>
    </div>`).join("");
  return `<section class="panel" id="dm-handouts">
      <p class="panel-sub">Handouts</p>
      <div class="scene-list">${rows || `<p class="muted">Nothing yet.</p>`}</div>
      ${showing ? `<button class="btn-quiet" data-tbl="hand-hide">Take it off their screens</button>` : ""}
      <p class="panel-sub">New handout</p>
      <label class="field"><span>Title</span>
        <input id="hand-title" class="text" type="text" maxlength="60" placeholder="The letter" /></label>
      <label class="field"><span>Text</span>
        <textarea id="hand-body" class="text" rows="3" maxlength="1200"></textarea></label>
      <label class="field"><span>Picture (URL, optional)</span>
        <input id="hand-img" class="text" type="text" placeholder="https://… or maps/…" /></label>
      <button class="btn" data-tbl="hand-add">Add it</button>
      <p id="hand-msg" class="save-msg"></p>
    </section>`;
}

async function tblAddHandout() {
  const msg = $("#hand-msg");
  const say = (t, bad) => { if (msg) { msg.textContent = t; msg.className = "save-msg" + (bad ? " bad" : ""); } };
  const title = String(($("#hand-title") || {}).value || "").trim().slice(0, 60);
  const body = String(($("#hand-body") || {}).value || "").slice(0, 1200);
  const image = String(($("#hand-img") || {}).value || "").trim();
  if (!title && !body && !image) return say("A handout needs a title, some text or a picture.", true);
  await CocLive.push(tblPath("handouts"), { title: title || "Handout", body, image, at: Date.now() });
  say("Added. Tap it to put it on everyone's screen.");
}

/* Shown to everyone at once, and dismissible by each person for themselves — a handout you cannot put
   away is a handout covering the map. */
function paintHandout() {
  const host = $("#vtt-handout");
  if (!host) return;
  const id = (tbl.data.meta || {}).handout || "";
  const h = id ? (tbl.data.handouts || {})[id] : null;
  if (!h || tbl.ui.dismissed === id) { host.classList.add("hidden"); host.innerHTML = ""; return; }
  host.classList.remove("hidden");
  host.innerHTML = `<div class="handout-card">
    <div class="handout-head">
      <strong>${esc(h.title || "Handout")}</strong>
      <button class="btn-quiet" data-tbl="hand-dismiss" data-val="${esc(id)}">Close</button>
    </div>
    ${h.image ? `<img class="handout-img" src="${esc(h.image)}" alt="" />` : ""}
    ${h.body ? `<p class="handout-body">${esc(h.body)}</p>` : ""}
  </div>`;
}

/* ---------------------------------------------------------------- wiring */

COC_ROUTES.table = routeTable;

/* The DM's notes save as they are typed, coalesced so a paragraph is a handful of writes rather than
   one per keystroke. */
document.addEventListener("input", (e) => {
  if (!tbl) return;
  if (e.target.id === "close-confirm") {
    tbl.ui.closeText = String(e.target.value || "").replace(/\D/g, "").slice(0, 6);
    // Only the button's state changes, so the panel is not rebuilt — that would take the focus out of
    // the box you are typing in.
    const go = $('[data-tbl="close-go"]');
    if (go) go.disabled = tbl.ui.closeText !== tbl.code;
    return;
  }
  // A notepad saves itself. Coalesced, so a paragraph is a handful of writes rather than one per letter.
  if ((e.target.id === "note-title" || e.target.id === "note-body") && tbl.ui.note) {
    const field = e.target.id === "note-title" ? "title" : "body";
    const cap = field === "title" ? 60 : 8000;
    CocLive.throttled(tblPath("notes/" + tbl.ui.note + "/" + field),
      String(e.target.value || "").slice(0, cap), 700);
  }
});

/* Rolling from a sheet. Listened for here rather than in creator.js because the dice belong to the
   table, and the sheet is the same sheet whether it is open at a table or on its own. */
document.addEventListener("click", (e) => {
  const roller = e.target.closest("[data-roll]");
  if (roller && !roller.disabled) {
    const onSheet = roller.closest("#vtt-sheet") && typeof sheet !== "undefined" && sheet && sheet.ch;
    tblRollAndPost(roller.dataset.roll, roller.dataset.label || "",
      e.shiftKey ? "adv" : (e.altKey ? "dis" : "normal"),
      onSheet ? sheet.ch.name : null);
    return;
  }
  const btn = e.target.closest("[data-tbl]");
  if (!btn || btn.disabled) return;
  const { tbl: act, val } = btn.dataset;
  if (act === "create") return tblCreate();
  if (act === "join") return tblJoin();
  if (act === "forget") { tblForgetTable(val); renderTableLanding(); return; }
  if (!tbl) return;
  if (act === "zoom") {
    if (val === "0") tblFit(); else tblZoomBy(val === "1" ? 1.25 : 1 / 1.25);
  } else if (act === "panel") tblPanel(val);
  else if (act === "die") {
    const pool = tblDicePool().pool;
    const sides = Number(val);
    pool[sides] = Math.min(20, (pool[sides] || 0) + 1);
    paintDice();
  } else if (act === "die-less") {
    const pool = tblDicePool().pool;
    const sides = Number(val);
    if (pool[sides] > 1) pool[sides] -= 1; else delete pool[sides];
    paintDice();
  } else if (act === "dice-clear") { tblDicePool().pool = {}; paintDice(); }
  else if (act === "dice-mod") {
    const t = tblDicePool();
    t.mod = Math.max(-20, Math.min(20, t.mod + Number(val)));
    paintDice();
  } else if (act === "dice-mode") { tblDicePool().mode = val; paintDice(); }
  else if (act === "roll-pool") {
    const spec = tblPoolSpec();
    if (spec.terms.length) tblRollAndPost(spec, "", tblDicePool().mode);
  }
  else if (act === "roll") tblRollAndPost(val, btn.dataset.label || "", "normal");
  // Stepping the turn is the DM's — or yours, on your own turn. paintTurnBar only renders the button
  // for those two, and this is the only way in, so it sits above the DM-only guard below.
  else if (act === "turn") tblTurnStep(Number(val)).catch(tblFail);
  else if (act === "sheet-open") tblOpenSheetByCode();
  else if (act === "claim") tblClaimFromPanel();
  // Dismissing a handout is each person's own business, so it is not a DM-only action.
  else if (act === "hand-dismiss") { tbl.ui.dismissed = val; paintHandout(); }
  // Your own figure: yours to keep, whether or not there is a sheet behind it. Guarded by ownership,
  // not by which buttons happen to be rendered.
  else if (act === "mine-save" || act === "mine-hp" || act === "mine-cond") {
    const [id, arg] = String(val).split("|");
    const t = tblTokens()[id];
    if (!t || !(tbl.role === "dm" || tblIsMine(t))) return;
    if (act === "mine-save") {
      CocLive.patch(tblPath("tokens/" + id), {
        name: String(($("#mine-name") || {}).value || "Someone").slice(0, 40),
        hp: Math.max(0, Number(($("#mine-hp") || {}).value) || 0),
        hpMax: Math.max(0, Number(($("#mine-hpmax") || {}).value) || 0),
        speed: Math.max(0, Math.min(200, Number(($("#mine-speed") || {}).value) || 0)),
        image: String(($("#mine-img") || {}).value || "").trim(),
      }).catch(tblFail);
    } else if (act === "mine-hp") {
      const amt = Math.max(1, Number(($("#mine-amt") || {}).value) || 1);
      const next = Math.max(0, (Number(t.hp) || 0) + amt * Number(arg));
      CocLive.put(tblPath("tokens/" + id + "/hp"), t.hpMax ? Math.min(Number(t.hpMax), next) : next).catch(tblFail);
    } else {
      const list = Array.isArray(t.conditions) ? t.conditions.slice() : [];
      const next = list.includes(arg) ? list.filter((c) => c !== arg) : list.concat(arg);
      CocLive.put(tblPath("tokens/" + id + "/conditions"), next.length ? next : null).catch(tblFail);
    }
  }
  // Closing the drawer hands paint() back to the page. Leaving it pointed here would mean the next
  // sheet you opened anywhere painted into a node that no longer exists.
  else if (act === "sheet-close") { closeSheetPanel(); tbl.ui.panel = ""; paintSide(); }
  // Everything below changes the board itself, which is the DM's alone. The buttons are not rendered
  // for a player, and the check is here as well because a rendered-away control is not a locked one.
  else if (tbl.role !== "dm") return;
  else if (act === "init-roll") tblRollInitiative().catch(tblFail);
  else if (act === "turn-end") tblTurnEnd().catch(tblFail);
  else if (act === "map-source") { tbl.ui.mapSource = val; paintSide(); }
  else if (act === "repo-pick") { tbl.ui.repoPick = val; paintSide(); }
  else if (act === "scene") { CocLive.put(tblPath("meta/activeScene"), val).catch(tblFail); tbl.view.fitted = false; }
  else if (act === "scene-del") tblDeleteScene(val).catch(tblFail);
  else if (act === "scene-add") tblAddScene().catch(tblFail);
  else if (act === "grid-cols") tblNudgeGrid("cols", Number(val)).catch(tblFail);
  else if (act === "grid-rows") tblNudgeGrid("rows", Number(val)).catch(tblFail);
  else if (act === "spawn") tblSpawn().catch(tblFail);
  else if (act === "ed-open") tblOpenToken(val);
  else if (act === "ed-close") { tbl.ui.editToken = ""; paintSide(); }
  else if (act === "ed-save") tblSaveToken(val).catch(tblFail);
  else if (act === "ed-dup") tblDuplicate(val).catch(tblFail);
  else if (act === "npc-shape") { tbl.ui.npcShape = val; paintSide(); }
  else if (act === "ed-shape") {
    const [id, shape] = String(val).split("|");
    if (TBL_SHAPE_IDS.includes(shape)) CocLive.put(tblPath("tokens/" + id + "/shape"), shape).catch(tblFail);
  }
  else if (act === "ed-cond") {
    const [id, cond] = String(val).split("|");
    const t = tblTokens()[id];
    if (t) {
      const list = Array.isArray(t.conditions) ? t.conditions.slice() : [];
      const next = list.includes(cond) ? list.filter((c) => c !== cond) : list.concat(cond);
      CocLive.put(tblPath("tokens/" + id + "/conditions"), next.length ? next : null).catch(tblFail);
    }
  }
  else if (act === "ed-del") {
    CocLive.del(tblPath("tokens/" + val)).catch(tblFail);
    tbl.ui.editToken = ""; paintSide();
  }
  else if (act === "note-new") tblNewNote().catch(tblFail);
  else if (act === "note-open") { tbl.ui.note = tbl.ui.note === val ? "" : val; paintSide(); }
  else if (act === "note-del") {
    const n = (tbl.data.notes || {})[val];
    if (n && n.by === tblNoteOwner()) {
      CocLive.del(tblPath("notes/" + val)).catch(tblFail);
      if (tbl.ui.note === val) tbl.ui.note = "";
      paintSide();
    }
  }
  else if (act === "close-arm") { tbl.ui.closeArmed = true; tbl.ui.closeText = ""; paintSide(); }
  else if (act === "close-cancel") { tbl.ui.closeArmed = false; tbl.ui.closeText = ""; paintSide(); }
  else if (act === "close-go") tblCloseTable();
  else if (act === "hand-add") tblAddHandout().catch(tblFail);
  else if (act === "hand-show") CocLive.put(tblPath("meta/handout"), val).catch(tblFail);
  else if (act === "hand-hide") CocLive.put(tblPath("meta/handout"), null).catch(tblFail);
  else if (act === "hand-del") {
    CocLive.del(tblPath("handouts/" + val)).catch(tblFail);
    if ((tbl.data.meta || {}).handout === val) CocLive.put(tblPath("meta/handout"), null).catch(tblFail);
  }
});
