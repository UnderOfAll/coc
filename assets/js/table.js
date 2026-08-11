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
async function tblHashKey(key, literal) {
  // `literal` lets the same hashing serve a different purpose (the diagnostics phrase) without a DM key and
  // a debug phrase ever colliding.
  const text = literal || ("coc-dm:" + String(key));
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
    data: { meta: null, scenes: null, tokens: null, log: null, presence: null, handouts: null, dm: null,
            notes: null, draw: null, sheets: null },
    view: { x: 0, y: 0, z: 1 },
    drag: null,
    offs: [],          // live subscriptions, closed on teardown
    beat: null,        // presence heartbeat
    deadman: false,    // the database has promised to take our presence away when the socket drops
    pointers: new Map(),
    inkPending: null,       // a rub that has been sent but not yet echoed back
    inkNew: new Set(),      // the pieces it created, so they are not drawn twice on the way
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
  if (tbl.role === "dm") return true;   // the referee moves anything, including to fix a misplacement
  /* A SPAWNED FIGURE DOES NOT MOVE. You position it as you put it down and that is the last time — the
     class says a Clone does not move on its own once placed, and Kayki asked for that honoured rather
     than merely drawn. It is the one place the board refuses a drag instead of counting it. */
  if (token.spawn) return false;
  return tblIsMine(token);
}
/* Whose figure this is. A Circus of Chaos player is identified by their character code; anyone playing
   another system has no code, so the browser that placed the figure owns it. Both, because one table
   can hold both kinds of player. */
/* ONE FIELD OF A FIGURE, and only if the figure is still there.
 *
 * The database has no schema and no foreign keys: writing `tokens/<id>/moved` for an id that no longer
 * exists does not fail, it CREATES `tokens/<id> = { moved: 0 }`. That is a figure with no name, no
 * picture and no square — and it is exactly the "Figure with a ? on it" that appeared out of nowhere on
 * Kayki's board after he stepped the turn onto a creature that had left. It then could not be dragged
 * either, because a token with no `x` makes the drag arithmetic NaN and the database refuses every write
 * for it ("value argument contains NaN in property tokens/…/y").
 *
 * So every write of a SINGLE FIELD goes through here. Writing a whole token still uses CocLive directly —
 * that is the call that is supposed to bring one into existence, and there is exactly one of those per
 * kind of figure. The guard reads this browser's own copy of the table, which is the same copy every
 * caller here has just decided to act on.
 */
function tblTokenField(id, field, value) {
  if (!id || !tblTokens()[id]) return Promise.resolve(null);
  return CocLive.put(tblPath("tokens/" + id + "/" + field), value);
}

/* WHAT A FIGURE IS UNDER — INCLUDING WHAT YOU HAVE JUST PRESSED.
 *
 * A chip has to answer the instant it is pressed, and until now it waited for the write to be ACKNOWLEDGED
 * by the database: press Prone and it lit up straight away on a good moment and five to ten seconds later
 * on a bad one, and every press in between read the stored list — which still said the old thing — and so
 * computed the same change again. Kayki: "if I click it again to remove it doesn't do so, if I click on
 * grapple afterwards it does nothing, and after 5-10 sec the condition gets updated out of nowhere."
 *
 * So the pressed state is held here, on screen, until the stored table AGREES with it — the same shape as
 * the eraser's local rub, and it retires itself with no timers. The fifteen seconds is not a delay, it is
 * giving up: a write that never lands must not leave the board lying about a figure for good. */
function tblConds(id, token) {
  const t = token || (id ? tblTokens()[id] : null) || {};
  const have = Array.isArray(t.conditions) ? t.conditions : [];
  const wish = id && tbl && tbl.ui && tbl.ui.condWish ? tbl.ui.condWish[id] : null;
  if (!wish) return have;
  const agreed = wish.list.length === have.length && wish.list.every((c) => have.includes(c));
  if (agreed || Date.now() - wish.at > 15000) { delete tbl.ui.condWish[id]; return have; }
  return wish.list;
}

/* Switching one on or off. Computed from what is ON SCREEN, not from what is stored — otherwise a second
   press inside the same write reads the old list and asks for the very same change a second time. */
function tblToggleCond(id, cond) {
  const list = tblConds(id);
  // Advantage and disadvantage cancel: switching one on switches the other off rather than leaving a
  // figure marked with both, which is a state nobody at the table could act on.
  const drop = TBL_EXCLUSIVE[cond];
  const next = list.includes(cond)
    ? list.filter((c) => c !== cond)
    : list.filter((c) => c !== drop).concat(cond);
  if (!tbl.ui.condWish) tbl.ui.condWish = {};
  tbl.ui.condWish[id] = { list: next, at: Date.now() };
  return tblTokenField(id, "conditions", next.length ? next : null);
}

function tblIsMine(token) {
  /* Ownership is simply the browser HOLDING it — nothing else. A character-code fallback was tried and is
     wrong: letting go of a figure could not then be expressed, since the code still matched and the figure
     stayed "mine" forever. A figure from an older table has no holder, which the seat panel shows as free
     to take, and taking it writes the holder. */
  return !!token && !!token.owner && token.owner === tbl.me.clientId;
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
      // The turn bar says less on a narrow screen, and which it is, is decided when it is written.
      paintTurnBar();
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
  // Rooms on this list may have been closed by their DM since. Checked in the background rather than
  // before the page appears, and the dead ones simply drop off — a list that offers you a door to
  // nowhere is worse than a short list.
  tblVerifyRecent(recent);
  paint(`
    <div class="tool-head">
      <a class="back" href="#/">&larr; Menu</a>
      <h1>Play at a table</h1>
      <p class="muted">${esc(CocLive.describe())}</p>
    </div>
    <section class="panel">
      <h2>Join a session</h2>
      <p class="muted">The room code your DM gives you (six digits), and nothing else. Once you are in you
        pick which character you are playing, or add a new one — so leaving and coming back is just the code
        again.</p>
      <div class="join-row">
        <label class="field"><span>Room code</span>
          <input id="tbl-room" class="text code-input" type="text" inputmode="numeric"
            maxlength="6" placeholder="482910" autocomplete="off" /></label>
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

/* Which of the remembered tables still exist. Anything gone is taken off the list and the page is drawn
   again; anything unreachable (no network) is LEFT ALONE, because "I cannot check" is not "it is gone". */
async function tblVerifyRecent(recent) {
  if (!recent.length) return;
  let changed = false;
  for (const row of recent) {
    try {
      if ((await CocLive.get("tables/" + row.code + "/meta")) == null) {
        tblForgetTable(row.code);
        localStorage.removeItem(tblDmKey(row.code));
        changed = true;
      }
    } catch { /* unreachable: leave it on the list */ }
  }
  // Only if the page is still the one that asked, or this would paint over a table being opened.
  if (changed && /^#\/table\/?$/.test(location.hash)) renderTableLanding();
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
        dmSeat: tblMe(room).clientId,     // the chair holds one, and this is who is in it
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
  const say = (text, bad) => { if (msg) { msg.textContent = text; msg.className = "save-msg" + (bad ? " bad" : ""); } };
  if (!CocStore.validCode(room)) return say("A room code is exactly six digits.", true);
  say("Knocking…");
  try {
    const meta = await CocLive.get("tables/" + room + "/meta");
    if (!meta) return say("No table is open under " + room + ". Check the code with your DM.", true);
    tblRemember(room, meta.name);
    location.hash = "#/table/" + room;
  } catch (err) {
    say("Could not join: " + err.message, true);
  }
}

/* Taking the DM chair on a device that is not the one the table was made on — a new laptop, a phone,
   a cleared browser. This is the only reason the key is stored at all: without it, losing your browser
   would mean losing the ability to run your own table. */
/* Is somebody sitting in the DM chair right now? The seat records WHICH device holds it, and presence says
   whether that device is still in the room — a DM who closed their laptop should not lock the table
   forever, and a DM who is right there should not be quietly replaced. */
async function tblSeatHolder(code) {
  const meta = await CocLive.get("tables/" + code + "/meta");
  const seat = meta && meta.dmSeat;
  if (!seat) return null;
  const who = await CocLive.get("tables/" + code + "/presence/" + seat);
  const fresh = who && Date.now() - (Number(who.at) || 0) < 60000;
  return fresh ? { id: seat, name: (who && who.name) || "Someone" } : null;
}

/* The key gets you the chair only if the chair is empty. Kayki's table ended up with two DMs at once
   because the key was all it took, and the second one then had no way back to being a player. */
async function tblClaimDm(code, key, myClientId) {
  const meta = await CocLive.get("tables/" + code + "/meta");
  if (!meta) throw new Error("No table is open under " + code + ".");
  if (!(await tblKeyMatches(key, meta.dmHash))) throw new Error("That is not the DM key for this table.");
  const held = await tblSeatHolder(code);
  if (held && held.id !== myClientId) {
    throw new Error(held.name + " is running this table from another device. They can hand it over with "
      + "Step down, or leave the room, and then the chair is yours.");
  }
  localStorage.setItem(tblDmKey(code), "1");
  if (myClientId) await CocLive.patch("tables/" + code + "/meta", { dmSeat: myClientId });
  return true;
}

/* Giving the chair back. The DM becomes an ordinary player at the same table — which is the other half of
   what was missing: the accidental second DM could not get out of it. */
async function tblStepDown() {
  const code = tbl.code;
  const mine = (tbl.data.meta || {}).dmSeat === tbl.me.clientId;
  localStorage.removeItem(tblDmKey(code));
  if (mine) await CocLive.put("tables/" + code + "/meta/dmSeat", null).catch(() => {});
  tblTeardown();
  tblOpen(code);
}

async function tblClaimFromPanel() {
  const msg = $("#claim-msg");
  const say = (t, bad) => { if (msg) { msg.textContent = t; msg.className = "save-msg" + (bad ? " bad" : ""); } };
  const key = String(($("#claim-key") || {}).value || "").replace(/\D/g, "");
  if (!CocStore.validCode(key)) return say("A DM key is six digits.", true);
  try {
    await tblClaimDm(tbl.code, key, tbl.me.clientId);
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
    if (first) { tblSettleSeat(); tblEnsureToken(); tblStraightenTokens(); tblMigrateDmNotes(); }
  }));
  tblAnnounce();
  tbl.beat = setInterval(tblAnnounce, 20000);
  // Opening a table is a clear enough statement that dice are about to be thrown, so the physics arrives
  // now rather than on the first roll — which used to mean the first roll of every session was the flat
  // overlay, and read as the 3D dice being broken.
  if (typeof dice3dPreload === "function") dice3dPreload();
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

/* Who is actually the DM here, settled once the table's data has arrived.
   Two devices can each believe they are the DM — one created the table, the other typed the key while the
   first was away — and the answer has to be the same on both screens. The SEAT decides: hold it and you
   are the DM, and if somebody else holds it and is still in the room, you are a player, told plainly. */
async function tblSettleSeat() {
  if (!tbl || tbl.role !== "dm") return;
  const seat = (tbl.data.meta || {}).dmSeat || "";
  if (!seat || seat === tbl.me.clientId) {
    if (seat !== tbl.me.clientId) CocLive.patch(tblPath("meta"), { dmSeat: tbl.me.clientId }).catch(() => {});
    return;
  }
  const held = await tblSeatHolder(tbl.code);
  if (!held || held.id === tbl.me.clientId) {
    CocLive.patch(tblPath("meta"), { dmSeat: tbl.me.clientId }).catch(() => {});
    return;
  }
  // Somebody else is in the chair and still at the table: stand down, and say why.
  localStorage.removeItem(tblDmKey(tbl.code));
  const code = tbl.code;
  tblTeardown();
  tblOpen(code);
  tbl.ui.seatNote = held.name + " is running this table, so you are here as a player. If they step down, "
    + "the chair is yours with the DM key.";
  tblFail({ message: tbl.ui.seatNote });
}

/* Presence is said twice, because a browser can leave two ways.
   - Politely: it says so, and `tblTeardown` deletes it.
   - By vanishing: a closed laptop, a phone in a pocket, a lost network. Nothing gets to run then, so
     the DATABASE is asked in advance to take the entry away the moment the socket drops. That is what
     `onGone` is, and it is the reason for the transport swap: a DM who closes their laptop used to
     hold the chair for a full minute afterwards, with everyone else locked out of it.
   The twenty-second beat stays as the backstop — it refreshes `at`, which is what tells the others
   somebody is still here when the dead-man's switch is not available (the REST transport has none). */
function tblAnnounce() {
  if (!tbl) return;
  const mine = tblPath("presence/" + tbl.me.clientId);
  CocLive.put(mine, {
    name: tbl.me.name || (tbl.role === "dm" ? "DM" : "Player"),
    role: tbl.role,
    charCode: tbl.me.charCode || "",
    at: Date.now(),
  }).catch(() => {});
  // Armed once per table. The library re-arms it itself after a reconnection, so the beat must not
  // keep asking — that would be a write every twenty seconds for a promise already made.
  if (!tbl.deadman) {
    tbl.deadman = true;
    CocLive.onGone(mine).catch(() => { if (tbl) tbl.deadman = false; });
  }
  tblEnsureToken();
}

/* Every figure at this table that is mine, oldest first — the ids sort by creation time. */
function tblMyTokens() {
  return Object.entries(tblTokens())
    .filter(([, t]) => t && tblIsMine(t))
    .map(([id]) => id)
    .sort();
}
/* You play ONE figure at a time. Holding several happens easily — you take one, then add another — and the
   answer is to let the others GO, not to delete them: a figure you are no longer holding is exactly what
   the next player is looking for. The one you last took is the one you keep. */
function tblPruneMyTokens() {
  const mine = tblMyTokens();
  if (mine.length < 2) return;
  const keep = mine.includes(tbl.me.tokenId) ? tbl.me.tokenId : mine[0];
  for (const id of mine) {
    if (id !== keep) tblTokenField(id, "owner", null).catch(() => {});
  }
  tbl.me.tokenId = keep;
}

/* A player who sits down gets a token, once. It carries their portrait and their character code —
   the code is what proves ownership later, so nobody else can drag them around. */
/* Nothing is placed on your behalf any more: a room code gets you in, and you SAY who you are. What is left
   here is the tidying — noticing which figure is yours, and offering the choice when none is. */
/* Nothing is placed on your behalf any more: a room code gets you in, and you SAY who you are. What is left
   here is the tidying — noticing which figure is yours, and offering the choice when none is. */
async function tblEnsureToken() {
  if (!tbl || tbl.role === "dm" || !tbl.gotData) return;
  const mine = tblMyTokens();
  if (mine.length) {
    // Do not overwrite the figure you just took with the oldest one you happen to own — that is how the
    // figure a player had only this second chosen got quietly swapped for an older one.
    if (!mine.includes(tbl.me.tokenId)) tbl.me.tokenId = mine[0];
    tblPruneMyTokens();
    return;
  }
  if (tbl.me.left) return;          // you took your figure off on purpose; it does not come back by itself
  /* NOT OVER SOMETHING YOU ARE ALREADY LOOKING AT. This runs on the heartbeat, so "once" is not once at a
     predictable moment — it is once at whatever moment the beat happens to land, and if that is while
     your sheet is open, your sheet vanishes and a form you did not ask for takes its place. Wait for a
     quiet screen; "Choose a character" is sitting in the bar the whole time either way. */
  if (tbl.ui.panel) return;
  // Asked ONCE, because reopening it every twenty seconds would shove aside whatever they had opened
  // instead. It is not a trap any more: while you hold no figure, "Choose a character" sits in the bar.
  if (!tbl.ui.askedSeat) {
    tbl.ui.askedSeat = true;
    tbl.ui.panel = "seat";
    paintSide();
  }
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
          ${tbl.role !== "dm" && !tblMyTokens().length
            ? `<button class="btn-quiet on" data-tbl="panel" data-val="seat">Choose a character</button>` : ""}
          <button class="btn-quiet" data-tbl="panel" data-val="notes">Notes</button>
          <button class="btn-quiet" data-tbl="panel" data-val="draw">Draw</button>
          ${tblDebugOn() ? `<button class="btn-quiet" data-tbl="panel" data-val="debug">Debug</button>` : ""}
          ${tbl.role === "dm" || (tbl.me.charCode && tblMyTokens().length)
            ? `<button class="btn-quiet" data-tbl="panel" data-val="sheet">My sheet</button>` : ""}
          <button class="btn-quiet" data-tbl="panel" data-val="mine">Character</button>
          ${tbl.role === "dm"
            ? `<button class="btn-quiet" data-tbl="panel" data-val="dm">DM</button>`
            : `<button class="btn-quiet" data-tbl="panel" data-val="claim">I'm the DM</button>`}
        </span>
      </div>
      <p id="vtt-error" class="warn hidden"></p>
      <div id="vtt-placing" class="vtt-placing hidden"></div>
      <div id="vtt-turn" class="vtt-turn hidden"></div>
      <div id="vtt-handout" class="vtt-handout hidden"></div>
      <div class="vtt-body">
        <aside id="vtt-dock" class="vtt-dock hidden"></aside>
        <div id="vtt-stage" class="vtt-stage">
          <div id="vtt-world" class="vtt-world">
            <img id="vtt-map" class="vtt-map hidden" alt="" draggable="false" />
            <div id="vtt-grid" class="vtt-grid"></div>
            <svg id="vtt-ink" class="vtt-ink" aria-hidden="true"></svg>
            <!-- Areas sit UNDER the figures: a cloud a goblin is standing in must not hide the goblin.
                 Their names are a layer of their own, drawn as HTML so they are the very same label a
                 figure gets rather than a second thing that has to be kept looking like it. -->
            <svg id="vtt-areas" class="vtt-areas"></svg>
            <div id="vtt-area-tags" class="vtt-area-tags"></div>
            <div id="vtt-tokens" class="vtt-tokens"></div>
            <svg id="vtt-ruler" class="vtt-ruler" aria-hidden="true"></svg>
          </div>
          <div id="vtt-measure" class="vtt-measure hidden"></div>
          <div id="vtt-peek" class="vtt-peek hidden"></div>
          <!-- The last roll lives ON the board and for five seconds only. Standing in the column above
               it, permanently, it pushed everything else down far enough that the page grew a scrollbar
               of its own on top of the panel's — two scrolls to fight at once. Anybody who wants it back
               opens the Dice panel, where every roll is kept. -->
          <p id="vtt-lastroll" class="last-roll hidden"></p>
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
  // The shell replaces the side panel with an empty one, so whatever was open has to be drawn again —
  // otherwise anything that re-renders the shell (claiming the DM chair, stepping down, a role settling)
  // leaves you looking at a blank panel with no way to tell it is not just empty.
  paintSide();
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
  paintBar();
  // The DM closed the room while people were in it — or somebody opened a code from their list that no
  // longer exists. Either way there is no table, and showing an empty board is the one answer that
  // explains nothing. (It is also why this cannot simply be ignored: the heartbeat would go on writing
  // presence into a deleted room and recreate it as a husk.)
  if (tbl.gotData && !(tbl.data && tbl.data.meta)) { tblTableGone(); return; }
  paintDrawings();
  paintAreas();
  tblAreasSettle();
  tblSpawnsSettle();
  tblArtSettle();
  paintPlacing();
  // The list of what you have out there follows the board, so an area that expires leaves it by itself.
  if (tbl.ui.panel === "field") paintSide();
  paintDock();
  paintHeader();
  paintBoard();      // paintTokens is called from here
  paintTurnBar();
  // The DM's fight is the fight: an open sheet follows the order bar in or out of combat.
  tblSyncSheetCombat();
  paintPeek();
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
/* The bar carries a button that only exists while you have no figure, so it has to be re-rendered when
   that changes — otherwise "Choose a character" hangs around after you have, or stays missing after you let
   a figure go. Cheap: the bar is four spans and some buttons. */
function paintBar() {
  const acts = document.querySelector(".vtt-acts");
  if (!acts || !tbl) return;
  /* Two buttons come and go with what you are holding, and BOTH have to be maintained here rather than only
     in the shell: taking a seat with a character code used to leave a player with no way to open the sheet it
     had just fetched, because only a shell re-render would have added the button. */
  const want = (val, label, cls) => {
    const has = acts.querySelector(`[data-val="${val}"]`);
    if (!has) acts.insertAdjacentHTML("afterbegin",
      `<button class="btn-quiet${cls || ""}" data-tbl="panel" data-val="${val}">${label}</button>`);
  };
  const drop = (val) => { const n = acts.querySelector(`[data-val="${val}"]`); if (n) n.remove(); };
  const holding = tblMyTokens().length;
  if (tbl.role !== "dm" && !holding) want("seat", "Choose a character", " on"); else drop("seat");
  /* AND "MY SHEET" GOES WHILE YOU ARE NOT ON THE TABLE. It used to stay, still holding the sheet of a
     character that had just been taken off — so the panel showed a full sheet for somebody who was not
     in the room, beside a "Choose a character" button, which is two buttons and one of them lying. */
  if (tbl.role === "dm" || (tbl.me.charCode && holding)) want("sheet", "My sheet"); else drop("sheet");
  /* "Character" is the tracker — a place to keep a character this app does not understand. Beside "My
     sheet" it is two buttons for one thing, and the wrong one is the one that looks like it holds your
     character. So a player with a real Circus of Chaos code does not get it; everybody else still does,
     because for them it IS their sheet. */
  if (tbl.role !== "dm" && tbl.me.charCode) drop("mine"); else want("mine", "Character");
  /* "On the field" arrives only when there IS something of yours on it, and goes when there is not. A
     button for an empty list is clutter on a phone, and this row is already the tightest thing there. */
  const out = tblMyAreas().length;
  if (out) want("field", "On the field (" + out + ")"); else drop("field");
}

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
      asEl(b).classList.toggle("on", asEl(b).dataset.val === "dice" ? tbl.ui.dock !== false : asEl(b).dataset.val === tbl.ui.panel));
    return;
  }
  const wasSheet = tbl.ui.panel === "sheet";
  tbl.ui.panel = tbl.ui.panel === which ? "" : which;
  if (wasSheet && tbl.ui.panel !== "sheet") closeSheetPanel();
  paintSide();
}
/* What each panel is called, for the phone's back bar. A panel that fills the screen has to say what it
   is: on a desktop the board beside it answers that, and on a phone there is nothing else on screen. */
const TBL_PANEL_NAMES = {
  dm: "DM screen", dice: "Dice", claim: "The DM's chair", figure: "Figure", notes: "Notes",
  draw: "Draw", mine: "Your character", seat: "Choose a character", debug: "Debug", sheet: "Your sheet",
  field: "On the field", enemy: "Its card",
};

/* The way back to the board, and the name of what you are in. Rendered always and shown only on a phone,
   where the panel covers the board — pressing it toggles the panel that is already open, which is the
   same thing pressing its button in the bar does. */
/* THE WAY OUT, and it has to be on every panel at every width. This row was shown only on a phone, where
   the panel covers the board — on a desktop the way out of a panel was pressing its button in the bar
   again, which works for the panels that HAVE one. A figure's card and an enemy's card do not, so once
   either was open there was no control on screen that closed it. Kayki, on the enemy card: "it doesn't
   have a return or exit button to go back to where it was before."
   `backTo` is where the arrow leads: the panel this one was opened FROM, so reading a creature's card and
   coming back lands you on the DM screen rather than staring at the board. */
function sideHeadHTML(which, backTo) {
  const to = backTo == null ? which : backTo;
  return `<div class="side-head">
    <button class="btn-quiet side-back" data-tbl="panel" data-val="${esc(to)}">&larr; Back</button>
    <strong>${esc(TBL_PANEL_NAMES[which] || "Panel")}</strong>
  </div>`;
}

/* Shut whatever is open, properly. There is exactly one right way to close the sheet drawer — the sheet
   has to be told, or it goes on holding a selector for a node that no longer exists — and anything that
   closes a panel for its own reasons (casting a trick, for one) has to come through here rather than
   setting the field and hoping. */
function tblClosePanel() {
  if (!tbl || !tbl.ui.panel) return;
  if (tbl.ui.panel === "sheet" && typeof closeSheetPanel === "function") closeSheetPanel();
  tbl.ui.panel = "";
  paintSide();
}

function paintSide() {
  const side = $("#vtt-side");
  if (!side) return;
  const which = tbl.ui.panel;
  side.classList.toggle("hidden", !which);
  document.querySelectorAll("[data-tbl='panel']").forEach((b) =>
    b.classList.toggle("on", asEl(b).dataset.val === which));
  if (!which) { side.innerHTML = ""; return; }
  let body = "";
  if (which === "dm") body = dmPanelHTML();
  else if (which === "dice") body = dicePanelHTML();
  else if (which === "claim") body = claimPanelHTML();
  else if (which === "figure") body = figureInfoHTML(tbl.ui.lookAt);
  else if (which === "notes") body = notesPanelHTML();
  else if (which === "draw") body = drawPanelHTML();
  else if (which === "mine") body = trackerHTML();
  else if (which === "seat") body = seatPanelHTML();
  else if (which === "debug") body = tblDebugOn() ? debugPanelHTML() : "";
  else if (which === "field") body = fieldPanelHTML();
  // The DM's alone: the whole stat block, in the panel, without leaving the table.
  else if (which === "enemy") body = tbl.role === "dm" ? enemySheetHTML(tbl.ui.enemyId) : "";
  else if (which === "sheet") body = `<p class="muted">Opening your sheet…</p>`;
  side.innerHTML = sideHeadHTML(which, which === "enemy" ? (tbl.ui.enemyFrom || "") : which) + body;
  // The DM's panel is re-rendered on every stream event and compared against what is on screen, so what
  // is stored has to be the whole thing, header and all.
  if (which === "dm") side.dataset.rendered = side.innerHTML;
  // The log lives in the dice panel and is filled by the stream, so a freshly opened panel would sit
  // empty until the next roll — showing "nothing rolled yet" under four rolls.
  else if (which === "dice") paintLog();
  else if (which === "sheet") paintSheetPanel();
}
/* Repaint whatever is open, the cheap way. The sheet is the exception and has to be: paintSide() for the
   sheet panel throws the drawer away and FETCHES the character again, which for a condition chip means a
   round trip, a lost scroll position and whichever field was open closing itself. renderSheet() redraws
   the same live sheet in place, which is what everything else that touches it uses. */
function tblRepaintPanel() {
  if (!tbl || !tbl.ui.panel) return;
  if (tbl.ui.panel === "sheet") {
    if (typeof renderSheet === "function" && typeof sheet !== "undefined" && sheet && sheet.ch) renderSheet();
    return;
  }
  paintSide();
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
  const next = sideHeadHTML("dm") + dmPanelHTML();
  if (next === side.dataset.rendered) return;
  const active = document.activeElement;
  const focusId = active && side.contains(active) && asEl(active).id ? asEl(active).id : "";
  let caret = null;
  if (focusId) { try { caret = asEl(active).selectionStart; } catch { caret = null; } }
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


/* ---------------------------------------------------------------- wiring */

COC_ROUTES.table = routeTable;
COC_ROUTES.debug = routeDebug;

/* The DM's notes save as they are typed, coalesced so a paragraph is a handful of writes rather than
   one per keystroke. */
/* Choosing a file is a `change`, not a click: the picture is applied the moment it is picked, because a
   two-step "choose then save" is one more thing to forget. */
document.addEventListener("change", (e) => {
  if (!tbl) return;
  if (evTarget(e).id === "seat-file") {
    // Shrunk and held until the character is created, since there is no figure to hang it on yet.
    const file = evTarget(e).files && evTarget(e).files[0];
    const say = (t, cls) => { const m = $("#seat-pic-msg"); if (m) { m.textContent = t; m.className = "save-msg" + cls; } };
    if (file) {
      say("Shrinking it…", "");
      tblShrinkImage(file, (data) => { tbl.ui.seatPic = data; say("Picture ready.", " good"); },
        (why) => say(why, " bad"), TBL_TOKEN_IMAGE);
    }
    return;
  }
  if (evTarget(e).id === "ed-file") tblUploadTokenImage(tbl.ui.editToken, evTarget(e), "ed-imgmsg");
  else if (evTarget(e).id === "mine-file") {
    tblUploadTokenImage(tblMyTokens()[0] || tbl.ui.lookAt, e.target, "mine-imgmsg");
  }
});

/* A number typed off your own dice. Committed on ENTER or when the box loses focus, never per
   keystroke: "17" passes through "1" on its way, and a table watching you roll a 1 and then a 17 is
   a table asking what happened. */
document.addEventListener("keydown", (e) => {
  if (!tbl || e.key !== "Enter") return;
  const box = evTarget(e).closest("[data-init-for]");
  if (!box) return;
  e.preventDefault();
  if (String(box.value).trim() !== "") tblInitApply(box.dataset.initFor, box.value).catch(tblFail);
});
document.addEventListener("focusout", (e) => {
  if (!tbl) return;
  const box = evTarget(e).closest("[data-init-for]");
  if (!box || String(box.value).trim() === "") return;
  tblInitApply(box.dataset.initFor, box.value).catch(tblFail);
});

document.addEventListener("input", (e) => {
  if (!tbl) return;
  /* Typing a character code folds away the picture picker, because the sheet's photo is the picture and
     two answers to one question is how you get a figure whose face does not match its sheet. Toggled
     rather than repainted: repainting the panel would take the focus out of the box being typed in. */
  if (evTarget(e).id === "seat-code") {
    const has = String(evTarget(e).value || "").replace(/\D/g, "").length > 0;
    const block = $("#seat-pic-block"), note = $("#seat-pic-note");
    if (block) block.classList.toggle("hidden", has);
    if (note) note.classList.toggle("hidden", !has);
  }
  if (evTarget(e).id === "close-confirm") {
    tbl.ui.closeText = String(evTarget(e).value || "").replace(/\D/g, "").slice(0, 6);
    // Only the button's state changes, so the panel is not rebuilt — that would take the focus out of
    // the box you are typing in.
    const go = $('[data-tbl="close-go"]');
    if (go) go.disabled = tbl.ui.closeText !== tbl.code;
    return;
  }
  // The tracker saves itself, and the figure on the board follows the two things it can show.
  if (/^trk-/.test(evTarget(e).id || "")) { tblTrackerInput(e.target); return; }
  // A notepad saves itself. Coalesced, so a paragraph is a handful of writes rather than one per letter.
  if ((evTarget(e).id === "note-title" || evTarget(e).id === "note-body") && tbl.ui.note) {
    const field = evTarget(e).id === "note-title" ? "title" : "body";
    const cap = field === "title" ? 60 : 8000;
    CocLive.throttled(tblPath("notes/" + tbl.ui.note + "/" + field),
      String(evTarget(e).value || "").slice(0, cap), 700);
  }
});

/* One field of the tracker, coalesced. Custom rows are written as a whole array, because they are a list
   and half a list is not a thing. */
function tblTrackerInput(el) {
  const key = tblNoteOwner();
  const id = el.id;
  const simple = { "trk-name": "name", "trk-line": "line", "trk-hp": "hp", "trk-hpmax": "hpMax",
                   "trk-ac": "ac", "trk-init": "init", "trk-speed": "speed", "trk-notes": "notes" };
  if (simple[id]) {
    const numeric = ["hp", "hpMax", "ac", "init", "speed"].includes(simple[id]);
    const value = numeric
      ? (el.value === "" ? null : Number(el.value))
      : String(el.value || "").slice(0, id === "trk-notes" ? 4000 : 60);
    CocLive.throttled(tblPath("sheets/" + key + "/" + simple[id]), value, 600);
    // The board shows a name and hit points, so those two follow — the rest is nobody else's business.
    const mine = tblMyTokens()[0];
    if (mine && (simple[id] === "hp" || simple[id] === "hpMax" || simple[id] === "name")) {
      const patch = {};
      if (simple[id] === "name" && value) patch.name = String(value).slice(0, 40);
      if (simple[id] === "hp" && value != null) patch.hp = Math.max(0, Number(value));
      if (simple[id] === "hpMax" && value != null) patch.hpMax = Math.max(0, Number(value));
      if (Object.keys(patch).length) CocLive.patch(tblPath("tokens/" + mine), patch).catch(() => {});
    }
    return;
  }
  const m = /^trk-([kv])-(\d+)$/.exec(id);
  if (!m) return;
  const rows = tblTrackerFields(tblTracker()).slice();
  const i = Number(m[2]);
  while (rows.length <= i) rows.push({ k: "", v: "" });
  rows[i] = Object.assign({}, rows[i], { [m[1]]: String(el.value || "").slice(0, 24) });
  CocLive.throttled(tblPath("sheets/" + key + "/fields"), rows, 600);
}

/* Ctrl+Z, the one keyboard shortcut in the app. It takes back your own last mark or your own last sweep of
   the eraser, never anybody else's — and it keeps its hands off Ctrl+Z inside a text box, where the browser's
   own undo is the right one. */
document.addEventListener("keydown", (e) => {
  if (!tbl) return;
  const z = (e.key === "z" || e.key === "Z") && (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey;
  if (!z) return;
  const inText = evTarget(e).closest && evTarget(e).closest("input, textarea, [contenteditable]");
  if (inText) return;
  e.preventDefault();
  tblUndoInk().then((did) => {
    if (did) tblTrace("undo");
    else if ($("#vtt-error")) tblFail({ message: "Nothing of yours left to undo." });
  });
});

/* Rolling from a sheet. Listened for here rather than in creator.js because the dice belong to the
   table, and the sheet is the same sheet whether it is open at a table or on its own. */
document.addEventListener("click", (e) => {
  const roller = evTarget(e).closest("[data-roll]");
  if (roller && !roller.disabled) {
    const onSheet = roller.closest("#vtt-sheet") && typeof sheet !== "undefined" && sheet && sheet.ch;
    tblRollAndPost(roller.dataset.roll, roller.dataset.label || "",
      e.shiftKey ? "adv" : (e.altKey ? "dis" : "normal"),
      onSheet ? sheet.ch.name : null);
    return;
  }
  const btn = evTarget(e).closest("[data-tbl]");
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
  else if (act === "dice-3d") { dice3dToggle(); paintDice(); }
  // Both of these restyle the dice where they stand, which is why they go through the same door.
  else if (act === "dice-colour") { dice3dRelook({ colour: val }); paintDice(); }
  else if (act === "dice-design") { dice3dRelook({ design: val }); paintDice(); }
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
  else if (act === "stand") {
    tblStandUp(val).catch(tblFail);
    paintTokens();
    paintTurnBar();
    tblRepaintPanel();
  }
  /* Rolling for a figure you hold is YOURS, not the DM's — which is the whole point of the gather — so
     these sit above the DM-only guard with the other player-facing actions. */
  else if (act === "init-roll-one") tblInitRoll(val).catch(tblFail);
  else if (act === "init-roll-mine") tblInitRollMine().catch(tblFail);
  else if (act === "sheet-open") tblOpenSheetByCode();
  else if (act === "init-go") tblInitSettle(true).catch(tblFail);
  // Calling off the gather. Not turn-end: there is no turn yet, and clearing one that does not exist is
  // what made this button do nothing at all.
  else if (act === "init-cancel") CocLive.put(tblPath("meta/init"), null).catch(tblFail);
  // Not everything dropped on the board mid-fight belongs in the order. The DM's call, and only theirs.
  else if (act === "init-out") tblJoinOut(val).catch(tblFail);
  // Placing an area: anybody may cancel their own, and the DM may clear one that has landed.
  else if (act === "place-cancel") tblPlaceCancel();
  else if (act === "pick-cancel") tblPickCancel();
  else if (act === "place-go") {
    const p = tbl.placing;
    if (p && p.aimed) tblPlaceAt(p.x, p.y).catch(tblFail);
  }
  else if (act === "area-clear") {
    tbl.ui.peekArea = "";
    paintPeek();
    // Repainted after, so the list you removed it from stops showing it and the button's count follows.
    tblAreaClear(val).then(() => { paintSide(); paintBar(); }).catch(tblFail);
  }
  else if (act === "claim") tblClaimFromPanel();
  // Dismissing a handout is each person's own business, so it is not a DM-only action.
  else if (act === "hand-dismiss") { tbl.ui.dismissed = val; paintHandout(); }
  // Your own figure: yours to keep, whether or not there is a sheet behind it. Guarded by ownership,
  // not by which buttons happen to be rendered.
  else if (act === "ed-repo" || act === "mine-repo") {
    const id = act === "ed-repo" ? tbl.ui.editToken : (tblMyTokens()[0] || tbl.ui.lookAt);
    tblSetTokenImage(id, "maps/" + val);
  }
  else if (act === "dbg-copy") tblCopyDiagnostics();
  else if (act === "dbg-backup") tblDownloadBackup();
  else if (act === "seat-pic") { tbl.ui.seatPic = "maps/" + val; paintSide(); }
  else if (act === "seat-take") tblTakeSeat(val).catch(tblFail);
  else if (act === "seat-new") tblNewSeat().catch(tblFail);
  else if (act === "seat-return") tblReturnSeat().catch(tblFail);
  else if (act === "trk-add") {
    const rows = tblTrackerFields(tblTracker()).concat({ k: "", v: "" });
    CocLive.put(tblPath("sheets/" + tblNoteOwner() + "/fields"), rows).then(() => paintSide()).catch(tblFail);
  }
  else if (act === "trk-drop") {
    const rows = tblTrackerFields(tblTracker()).filter((_, i) => i !== Number(val));
    CocLive.put(tblPath("sheets/" + tblNoteOwner() + "/fields"), rows.length ? rows : null)
      .then(() => paintSide()).catch(tblFail);
  }
  else if (act === "trk-hp") {
    const sheet = tblTracker();
    const amt = Math.max(1, Number(($("#trk-amt") || {}).value) || 1);
    const next = Math.max(0, (Number(sheet.hp) || 0) + amt * Number(val));
    const capped = sheet.hpMax ? Math.min(Number(sheet.hpMax), next) : next;
    CocLive.put(tblPath("sheets/" + tblNoteOwner() + "/hp"), capped).catch(tblFail);
    const mine = tblMyTokens()[0];
    if (mine) CocLive.patch(tblPath("tokens/" + mine), { hp: capped }).catch(() => {});
    paintSide();
  }
  else if (act === "mine-remove") {
    const t = tblTokens()[val];
    if (t && (tbl.role === "dm" || tblIsMine(t))) {
      // Remembered, so the heartbeat does not helpfully put it straight back.
      tbl.me.left = true;
      CocLive.del(tblPath("tokens/" + val)).catch(tblFail);
      /* AND THE WAY BACK IN, IMMEDIATELY. This used to close everything and leave you looking at a board
         you were no longer on, with your old sheet still open in the panel behind it — a sheet for a
         character that was not at the table. Kayki took his off by accident and could not put it back.
         So: the choosing panel opens on the spot, and it knows the code you were just playing. */
      if (tbl.ui.panel === "sheet" && typeof closeSheetPanel === "function") closeSheetPanel();
      tbl.ui.peek = "";
      tbl.ui.panel = "seat";
      paintSide();
      paintPeek();
      paintBar();   // "Choose a character" comes back the moment you are holding nothing
      if (typeof tblRevealPanel === "function") tblRevealPanel();
    }
  }
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
      tblTokenField(id, "hp", t.hpMax ? Math.min(Number(t.hpMax), next) : next).catch(tblFail);
    } else {
      /* AND REPAINT AT ONCE. Nothing else does: the stream repaints the board, the bars and the log, but
         not an open side panel — so the chip you had just switched off went on looking switched on, you
         pressed it again, and that put the condition back. Press, press, press: "I can't remove the
         condition no matter what." The data was right every time and the panel never said so.
         Repainting when the write RESOLVED fixed the display and not the wait; the chip, the flags on the
         figure and the turn bar's speed all read tblConds now, so they change on the press. */
      tblToggleCond(id, arg).catch(tblFail);
      tblRepaintPanel();
      paintTokens();
      paintPeek();
      paintTurnBar();
    }
  }
  // Closing the drawer hands paint() back to the page. Leaving it pointed here would mean the next
  // sheet you opened anywhere painted into a node that no longer exists.
  else if (act === "sheet-close") { closeSheetPanel(); tbl.ui.panel = ""; paintSide(); }

  else if (act === "ed-open") tblOpenToken(val);
  else if (act === "ink-pen" || act === "ink-erase" || act === "ink-bucket" || act === "ink-off") {
    const ink = tblInkState();
    ink.on = act !== "ink-off";
    if (act === "ink-pen") ink.mode = "pen";
    if (act === "ink-erase") ink.mode = "erase";
    if (act === "ink-bucket") ink.mode = "fill";
    // The board's cursor says which tool is in your hand, since the pen changes what a drag does.
    const stage = $("#vtt-stage");
    if (stage) stage.classList.toggle("inking", ink.on);
    paintSide();
  }
  else if (act === "ink-shape") { tblInkState().shape = val; paintSide(); }
  else if (act === "ink-fill") { tblInkState().fill = val || false; paintSide(); }
  else if (act === "ink-undo") tblUndoInk().catch(tblFail);
  else if (act === "peek-close") { tbl.ui.peek = ""; tbl.ui.peekArea = ""; paintPeek(); }
  else if (act === "peek-edit") { tbl.ui.peek = ""; tbl.ui.peekArea = ""; paintPeek(); tblOpenToken(val); }
  // An area's card, opened from its label — the one part of it that takes a press, because a corner
  // handle is under a figure half the time.
  else if (act === "area-peek") { tbl.ui.peek = ""; tbl.ui.peekArea = val; paintPeek(); }
  else if (act === "ink-color") { tblInkState().color = val; paintSide(); }
  else if (act === "ink-width") { tblInkState().width = Number(val); paintSide(); }
  else if (act === "ink-clear-mine") {
    for (const [id] of tblMyStrokes()) CocLive.del(tblPath("draw/" + id)).catch(() => {});
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
  /* Everything BELOW this line changes the board, which is the DM's alone.
     Everything ABOVE it is anyone's: the pen, the notepad, the tracker, choosing which character you are
     playing, and opening a figure to look at it. They were all below it, which meant that for a player
     every one of those buttons did precisely nothing — Kayki reported the drawing "not working", and the
     notepad, the tracker and the seat picker were dead in the same way for the same reason.
     The guard stays (a control that is merely unrendered is not a locked one); what changed is that the
     things it was never meant to cover are now on the right side of it. */
  else if (tbl.role !== "dm") return;
  else if (act === "init-roll") tblInitOpen().catch(tblFail);
  else if (act === "turn-end") tblTurnEnd().catch(tblFail);
  else if (act === "map-source") { tbl.ui.mapSource = val; paintSide(); }
  else if (act === "repo-pick") { tbl.ui.repoPick = val; paintSide(); }
  else if (act === "scene") { CocLive.put(tblPath("meta/activeScene"), val).catch(tblFail); tbl.view.fitted = false; }
  else if (act === "scene-del") tblDeleteScene(val).catch(tblFail);
  else if (act === "scene-add") tblAddScene().catch(tblFail);
  else if (act === "grid-cols") tblNudgeGrid("cols", Number(val)).catch(tblFail);
  else if (act === "grid-rows") tblNudgeGrid("rows", Number(val)).catch(tblFail);
  else if (act === "grid-on" || act === "grid-dark" || act === "grid-bold") {
    const id = tblSceneId();
    const scene = tblScene();
    const field = act === "grid-on" ? "gridOn" : act === "grid-dark" ? "gridDark" : "gridBold";
    const now = field === "gridOn" ? scene.gridOn !== false : !!scene[field];
    if (id) CocLive.put(tblPath("scenes/" + id + "/" + field), !now).catch(tblFail);
  }
  // A preset is "how many squares across"; how many down follows the picture, so squares stay square.
  else if (act === "grid-guess") {
    const [cols, rows] = String(val).split("|").map(Number);
    const id = tblSceneId();
    if (id) CocLive.patch(tblPath("scenes/" + id), { cols, rows }).catch(tblFail);
  }
  else if (act === "grid-preset") tblSquareUpGrid(Number(val)).catch(tblFail);
  else if (act === "grid-fit") tblSquareUpGrid().catch(tblFail);
  else if (act === "grid-off") {
    const id = tblSceneId();
    const scene = tblScene();
    if (!id) return;
    if (val === "reset") {
      CocLive.patch(tblPath("scenes/" + id), { gridOffX: 0, gridOffY: 0 }).catch(tblFail);
    } else {
      const [axis, step] = String(val).split("|");
      const field = axis === "x" ? "gridOffX" : "gridOffY";
      // Wraps at a whole square, because ten tenths of a square along is the same grid again.
      const next = (((Number(scene[field]) || 0) + Number(step)) % 10 + 10) % 10;
      CocLive.put(tblPath("scenes/" + id + "/" + field), next).catch(tblFail);
    }
  }
  // DM only, from here down.
  else if (act === "ink-clear-all") {
    const sceneId = tblSceneId();
    for (const [id, k] of Object.entries(tbl.data.draw || {})) {
      if (k && k.scene === sceneId) CocLive.del(tblPath("draw/" + id)).catch(() => {});
    }
  }
  else if (act === "ink-lock") {
    const id = tblSceneId();
    if (id) CocLive.put(tblPath("scenes/" + id + "/drawLocked"), tblScene().drawLocked !== true).catch(tblFail);
  }
  else if (act === "spawn") tblSpawn().catch(tblFail);
  else if (act === "ed-close") { tbl.ui.editToken = ""; paintSide(); }
  else if (act === "ed-save") tblSaveToken(val).catch(tblFail);
  else if (act === "ed-dup") tblDuplicate(val).catch(tblFail);
  else if (act === "npc-shape") { tbl.ui.npcShape = val; paintSide(); }
  else if (act === "bestiary") tblDropEnemy(val).catch(tblFail);
  else if (act === "keep-table") tblKeepTableOnDm().catch(tblFail);
  else if (act === "enemy-card") {
    tbl.ui.enemyId = val;
    // Where to come back to: the panel it was opened from, or the board if it was opened off a figure.
    tbl.ui.enemyFrom = tbl.ui.panel === "enemy" ? tbl.ui.enemyFrom : (tbl.ui.panel || "");
    tbl.ui.panel = "enemy";
    tbl.ui.peek = "";
    paintPeek();
    paintSide();
    if (typeof tblRevealPanel === "function") tblRevealPanel();
  }
  else if (act === "ed-shape") {
    const [id, shape] = String(val).split("|");
    if (TBL_SHAPE_IDS.includes(shape)) tblTokenField(id, "shape", shape).catch(tblFail);
  }
  else if (act === "ed-cond") {
    const [id, cond] = String(val).split("|");
    const t = tblTokens()[id];
    if (t) {
      tblToggleCond(id, cond).catch(tblFail);
      paintSide();
      paintTokens();
      paintTurnBar();
    }
  }
  else if (act === "ed-del") {
    CocLive.del(tblPath("tokens/" + val)).catch(tblFail);
    tbl.ui.editToken = ""; paintSide();
  }
  else if (act === "step-down") tblStepDown().catch(tblFail);
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


/* ---------------------------------------------------------------- diagnostics (Kayki's only)
 *
 * Five rounds went into one drag bug because I was guessing at what a browser I cannot run was doing. This
 * is the fix for that: a HUD that says what the board thinks is happening, and a button that copies the
 * whole picture — browser, gestures, camera, live data, recent events — so a report becomes evidence.
 *
 * Reachable only by visiting #/debug/<phrase> once per device (see config.js). Nothing about it appears for
 * anyone else, which is the point: it is a tool for the person building the thing, not a feature.
 */
const TBL_DEBUG_KEY = "coc:debug";
function tblDebugOn() { return localStorage.getItem(TBL_DEBUG_KEY) === "1"; }

/* A ring of the last few things that happened, which is what turns "it stopped working" into a sequence. */
const TBL_TRACE = [];
function tblTrace(what, detail) {
  if (!tblDebugOn()) return;
  TBL_TRACE.push({ t: Date.now(), what, detail: detail == null ? "" : String(detail).slice(0, 120) });
  if (TBL_TRACE.length > 60) TBL_TRACE.shift();
}

async function routeDebug(arg) {
  const phrase = String(arg || "");
  const cfg = (typeof COC_CONFIG !== "undefined") ? COC_CONFIG : {};
  if (phrase === "off") {
    localStorage.removeItem(TBL_DEBUG_KEY);
    paint(`<div class="tool-head"><a class="back" href="#/">&larr; Menu</a><h1>Diagnostics off</h1>
      <p class="muted">This device is back to normal.</p></div>`);
    return;
  }
  const ok = cfg.debugHash && (await tblHashKey("", "coc-debug:" + phrase)) === cfg.debugHash;
  if (!ok) {
    // Deliberately the same answer as any other unknown route: no hint that there was something to find.
    location.hash = "#/";
    return;
  }
  localStorage.setItem(TBL_DEBUG_KEY, "1");
  paint(`<div class="tool-head"><a class="back" href="#/">&larr; Menu</a><h1>Diagnostics on</h1>
    <p class="muted">This browser will show the diagnostics panel at a table, and only this one.
      <strong>#/debug/off</strong> turns it off again.</p></div>
    <section class="panel"><p class="muted">At a table you get a <strong>Debug</strong> button. It shows what
      the board believes about your gestures and the camera, and <strong>Copy diagnostics</strong> puts the
      lot on the clipboard — browser and all — so a bug report can be evidence rather than a description.</p>
    </section>`);
}

/* What the board thinks is going on, right now. */
function tblDiagnostics() {
  const scene = tbl ? tblScene() : {};
  const nav = typeof navigator !== "undefined" ? navigator : {};
  return {
    when: new Date().toISOString(),
    browser: {
      ua: String(nav.userAgent || "").slice(0, 200),
      brands: (nav.userAgentData && nav.userAgentData.brands || []).map((b) => b.brand + " " + b.version).join(", "),
      touch: typeof matchMedia === "function" ? matchMedia("(pointer: coarse)").matches : null,
      dpr: typeof devicePixelRatio === "number" ? devicePixelRatio : null,
      screen: typeof innerWidth === "number" ? innerWidth + "x" + innerHeight : "",
    },
    live: { mode: CocLive.mode, transport: CocLive.transport + " (" + CocLive.transportState + ")",
            code: tbl ? tbl.code : "", role: tbl ? tbl.role : "" },
    me: tbl ? { id: tbl.me.clientId, name: tbl.me.name, char: tbl.me.charCode, token: tbl.me.tokenId || "" } : null,
    gesture: tbl ? {
      pointers: [...tbl.pointers.keys()],
      drag: tbl.drag ? (tbl.drag.pan ? "panning" : "figure " + tbl.drag.id) : null,
      pinch: !!tbl.pinch,
      inking: !!tbl.inking,
      pen: tbl.ui.ink ? tbl.ui.ink.on + "/" + tbl.ui.ink.mode : "away",
    } : null,
    camera: tbl ? { x: tbl.view.x, y: tbl.view.y, z: Number(tbl.view.z.toFixed(3)), yours: !!tbl.cameraIsYours } : null,
    scene: { id: tbl ? tblSceneId() : "", cols: scene.cols, rows: scene.rows, cell: scene.cell,
             image: scene.image ? (scene.image.slice(0, 12) + "…" + scene.image.length + " chars") : "none",
             grid: scene.gridOn !== false, locked: !!scene.drawLocked },
    counts: tbl ? {
      figures: Object.keys(tblTokens()).length,
      strokes: Object.keys(tbl.data.draw || {}).length,
      rolls: Object.keys(tbl.data.log || {}).length,
      here: Object.keys(tbl.data.presence || {}).length,
    } : null,
    trace: TBL_TRACE.slice(-25),
  };
}

function debugPanelHTML() {
  const d = tblDiagnostics();
  const row = (k, v) => `<div class="dbg-row"><span>${esc(k)}</span><code>${esc(v)}</code></div>`;
  const g = d.gesture || /** @type {any} */ ({});
  return `<section class="panel">
      <h2>Diagnostics</h2>
      <p class="muted">Yours alone. If something misbehaves, press Copy and paste it to me — it beats
        describing it.</p>
      <button class="btn" data-tbl="dbg-copy">Copy diagnostics</button>
      <button class="btn-quiet" data-tbl="dbg-backup">Download a backup</button>
      <p id="dbg-msg" class="save-msg"></p>
      <p class="muted">The backup is every character and table THIS device knows the code for — the database
        cannot be listed, by design, so nothing else can find them.</p>
    </section>
    <section class="panel">
      <p class="panel-sub">Gestures</p>
      ${row("pointers down", (g.pointers || []).join(", ") || "none")}
      ${row("dragging", g.drag || "no")}
      ${row("pinching", g.pinch ? "yes" : "no")}
      ${row("pen", g.pen)}
      <p class="panel-sub">Camera</p>
      ${row("x, y, zoom", d.camera ? `${d.camera.x}, ${d.camera.y}, ${d.camera.z}` : "")}
      ${row("yours", d.camera && d.camera.yours ? "yes" : "no (auto-fits)")}
      <p class="panel-sub">Scene</p>
      ${row("grid", `${d.scene.cols}x${d.scene.rows} @ ${d.scene.cell}px${d.scene.grid ? "" : " (off)"}`)}
      ${row("map", d.scene.image)}
      <p class="panel-sub">This table</p>
      ${row("figures / strokes / rolls / here",
        d.counts ? `${d.counts.figures} / ${d.counts.strokes} / ${d.counts.rolls} / ${d.counts.here}` : "")}
      ${row("live", `${d.live.mode} as ${d.live.role || "?"}`)}
      ${row("transport", d.live.transport)}
      <p class="panel-sub">Browser</p>
      ${row("engine", d.browser.brands || d.browser.ua.slice(0, 60))}
      ${row("screen", `${d.browser.screen} @${d.browser.dpr}${d.browser.touch ? " touch" : ""}`)}
    </section>
    <section class="panel">
      <p class="panel-sub">Last events</p>
      <div class="dbg-trace">${(d.trace || []).slice().reverse().map((e) =>
        `<code>${esc(new Date(e.t).toLocaleTimeString())} ${esc(e.what)} ${esc(e.detail)}</code>`).join("")
        || `<span class="muted">nothing yet</span>`}</div>
    </section>`;
}

async function tblCopyDiagnostics() {
  const msg = $("#dbg-msg");
  const text = JSON.stringify(tblDiagnostics(), null, 1);
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) await navigator.clipboard.writeText(text);
    else throw new Error("no clipboard");
    if (msg) { msg.textContent = "Copied — paste it to me."; msg.className = "save-msg good"; }
  } catch {
    // No clipboard permission (or an http page): show it instead, so it can still be selected by hand.
    const host = $("#vtt-side");
    if (host) host.insertAdjacentHTML("afterbegin", `<textarea class="text" rows="12">${esc(text)}</textarea>`);
    if (msg) { msg.textContent = "Could not reach the clipboard — copy it out of the box above."; msg.className = "save-msg"; }
  }
}

/* Everything this device knows, as a file.
 *
 * The database cannot be listed — that is the security model, not an oversight — so nothing can discover
 * which codes exist. What CAN: this browser, which remembers the characters and tables it has opened. So the
 * backup is made here, where the knowledge is, rather than by a script that would have to be told.
 * Kayki's condition for changing anything was that the data survives; this is how it survives. */
async function tblDownloadBackup() {
  const msg = $("#dbg-msg");
  const say = (t, bad) => { if (msg) { msg.textContent = t; msg.className = "save-msg" + (bad ? " bad" : ""); } };
  say("Gathering…");
  const out = { takenAt: new Date().toISOString(), mode: CocLive.mode, characters: {}, tables: {}, missing: [] };
  const charCodes = new Set();
  try {
    for (const r of JSON.parse(localStorage.getItem("coc:recent") || "[]")) if (r && r.code) charCodes.add(r.code);
  } catch { /* nothing remembered */ }
  const tableCodes = new Set();
  for (const r of tblRecent()) if (r && r.code) tableCodes.add(r.code);
  if (tbl) tableCodes.add(tbl.code);
  // Anybody's character standing on a table this device knows is worth keeping too.
  for (const code of tableCodes) {
    try {
      const t = await CocLive.get("tables/" + code);
      if (t) {
        out.tables[code] = t;
        for (const tok of Object.values(t.tokens || {})) if (tok && tok.charCode) charCodes.add(tok.charCode);
      } else out.missing.push("table " + code);
    } catch (err) { out.missing.push("table " + code + " (" + err.message + ")"); }
  }
  for (const code of charCodes) {
    try {
      const ch = await CocStore.load(code);
      if (ch) out.characters[code] = ch; else out.missing.push("character " + code);
    } catch (err) { out.missing.push("character " + code + " (" + err.message + ")"); }
  }
  const text = JSON.stringify(out, null, 1);
  const stamp = out.takenAt.replace(/[:.]/g, "-").slice(0, 19);
  try {
    const blob = new Blob([text], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `circus-backup-${stamp}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    const n = (o) => Object.keys(o).length;
    say(`Saved ${n(out.characters)} character(s) and ${n(out.tables)} table(s).`);
  } catch (err) {
    say("Could not save a file here: " + err.message, true);
  }
}

