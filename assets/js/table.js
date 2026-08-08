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
    data: { meta: null, scenes: null, tokens: null, log: null, presence: null },
    view: { x: 0, y: 0, z: 1 },
    drag: null,
    offs: [],          // live subscriptions, closed on teardown
    beat: null,        // presence heartbeat
    pointers: new Map(),
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
  return !!token.charCode && token.charCode === tbl.me.charCode;
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
  tbl = null;
}
if (typeof window !== "undefined") {
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
      <p class="muted">Two numbers: the room code the DM gives you, and your own character's
        six-digit code so your sheet comes with you.</p>
      <div class="join-row">
        <label class="field"><span>Room code</span>
          <input id="tbl-room" class="text code-input" type="text" inputmode="numeric"
            maxlength="6" placeholder="482910" autocomplete="off" /></label>
        <label class="field"><span>Your character</span>
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
        </a></div>`).join("")}</div></section>` : ""}
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
  const say = (text, bad) => { if (msg) { msg.textContent = text; msg.className = "save-msg" + (bad ? " bad" : ""); } };
  if (!CocStore.validCode(room)) return say("A room code is exactly six digits.", true);
  if (!CocStore.validCode(char)) return say("Your character code is exactly six digits — it is on your sheet.", true);
  say("Knocking…");
  try {
    const meta = await CocLive.get("tables/" + room + "/meta");
    if (!meta) return say("No table is open under " + room + ". Check the code with your DM.", true);
    const ch = await CocStore.load(char);
    if (!ch) return say("No character is saved under " + char + ".", true);
    const me = tblMe(room);
    me.charCode = char;
    me.name = ch.name || "Someone";
    tblSaveMe(room, me);
    tblRemember(room, meta.name);
    location.hash = "#/table/" + room;
  } catch (err) {
    say("Could not join: " + err.message, true);
  }
}

/* ---------------------------------------------------------------- opening a table */

function tblOpen(code) {
  tbl = tblFresh(code, tblIsDm(code) ? "dm" : "player");
  renderTableShell();
  // One stream per branch, not one for the whole table: the map image lives under scenes and can be
  // half a megabyte, and it must not be re-sent every time a token moves one square.
  const watch = (branch, apply) => tbl.offs.push(CocLive.watch(tblPath(branch), (val) => {
    if (!tbl) return;
    tbl.data[branch] = val;
    try { apply(); } catch (err) { tblFail(err); }
  }));
  watch("meta", () => { paintHeader(); paintBoard(); });
  watch("scenes", () => { paintBoard(); paintDmPanel(); });
  watch("tokens", () => { paintTokens(); paintTurnBar(); });
  watch("log", () => { paintLog(); });
  watch("presence", () => { paintWho(); });
  tblAnnounce();
  tbl.beat = setInterval(tblAnnounce, 20000);
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

/* A player who sits down gets a token, once. It carries their portrait and their character code —
   the code is what proves ownership later, so nobody else can drag them around. */
async function tblEnsureToken() {
  if (!tbl || tbl.role === "dm" || !tbl.me.charCode) return;
  const tokens = tblTokens();
  const mine = Object.entries(tokens).find(([, t]) => t && t.charCode === tbl.me.charCode);
  if (mine) { tbl.me.tokenId = mine[0]; return; }
  if (tbl.me._placing) return;
  tbl.me._placing = true;
  try {
    const ch = await CocStore.load(tbl.me.charCode);
    if (!ch) return;
    const d = (typeof derive === "function") ? derive(ch) : null;
    const id = CocLive.newId();
    // Dropped on the first free square of the top row, so two players joining at once do not land
    // on top of each other.
    const taken = new Set(Object.values(tokens).map((t) => `${Math.round(t.x)},${Math.round(t.y)}`));
    let x = 1; while (taken.has(`${x},1`) && x < 20) x++;
    await CocLive.put(tblPath("tokens/" + id), {
      name: (ch.name || "Someone").slice(0, 40),
      charCode: tbl.me.charCode,
      image: ch.photo || "",
      x, y: 1, size: 1,
      kind: "pc",
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
          <button class="btn-quiet" data-tbl="panel" data-val="sheet">My sheet</button>
          ${tbl.role === "dm" ? `<button class="btn-quiet" data-tbl="panel" data-val="dm">DM</button>` : ""}
        </span>
      </div>
      <p id="vtt-error" class="warn hidden"></p>
      <div id="vtt-turn" class="vtt-turn hidden"></div>
      <div class="vtt-body">
        <div id="vtt-stage" class="vtt-stage">
          <div id="vtt-world" class="vtt-world">
            <img id="vtt-map" class="vtt-map hidden" alt="" />
            <div id="vtt-grid" class="vtt-grid"></div>
            <div id="vtt-tokens" class="vtt-tokens"></div>
            <svg id="vtt-ruler" class="vtt-ruler" aria-hidden="true"></svg>
          </div>
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
  const here = Object.entries(tbl.data.presence || {})
    .filter(([, p]) => p && now - (p.at || 0) < 60000)
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
  if (scene.image) {
    img.src = scene.image;
    img.classList.remove("hidden");
  } else {
    img.removeAttribute("src");
    img.classList.add("hidden");
  }
  if (!tbl.view.fitted) tblFit();
  applyView();
  paintTokens();
}

/* Camera. Everything is one CSS transform on the world, so panning and zooming never touch a token:
   the browser composites the whole board, which is why this stays smooth on a phone. */
function applyView() {
  const world = $("#vtt-world");
  if (!world) return;
  world.style.transform = `translate(${tbl.view.x}px, ${tbl.view.y}px) scale(${tbl.view.z})`;
}
function tblFit() {
  const stage = $("#vtt-stage"), scene = tblScene();
  if (!stage) return;
  const cell = Number(scene.cell) || 70;
  const w = (Number(scene.cols) || 30) * cell, h = (Number(scene.rows) || 20) * cell;
  const box = stage.getBoundingClientRect();
  const pad = 16;
  const z = Math.min((box.width - pad) / w, (box.height - pad) / h, 1.6) || 1;
  tbl.view.z = Math.max(0.12, z);
  tbl.view.x = Math.max(0, (box.width - w * tbl.view.z) / 2);
  tbl.view.y = Math.max(0, (box.height - h * tbl.view.z) / 2);
  tbl.view.fitted = true;
  applyView();
}
function tblZoomBy(factor, cx, cy) {
  const stage = $("#vtt-stage");
  const box = stage.getBoundingClientRect();
  const px = (cx == null ? box.width / 2 : cx - box.left);
  const py = (cy == null ? box.height / 2 : cy - box.top);
  const z0 = tbl.view.z;
  const z1 = Math.max(0.12, Math.min(4, z0 * factor));
  // Keep the point under the cursor still: that is what makes zooming feel like a camera rather
  // than a slider.
  tbl.view.x = px - ((px - tbl.view.x) / z0) * z1;
  tbl.view.y = py - ((py - tbl.view.y) / z0) * z1;
  tbl.view.z = z1;
  applyView();
}

/* Tokens are DIFFED, never rebuilt: rebuilding drops the one under your finger and restarts every
   image download. Each token owns one node, keyed by its id. */
function paintTokens() {
  const host = $("#vtt-tokens");
  if (!host) return;
  const scene = tblScene();
  const cell = Number(scene.cell) || 70;
  const tokens = tblTokens();
  const seen = new Set();
  for (const [id, t] of Object.entries(tokens)) {
    if (!t) continue;
    seen.add(id);
    let node = host.querySelector(`[data-token="${id}"]`);
    if (!node) {
      node = document.createElement("div");
      node.className = "tok";
      node.dataset.token = id;
      node.innerHTML = `<span class="tok-art"></span><span class="tok-name"></span><span class="tok-hp"></span>`;
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
    if (t.image) {
      if (art.dataset.src !== t.image) { art.dataset.src = t.image; art.style.backgroundImage = `url("${t.image}")`; }
      art.textContent = "";
    } else {
      art.style.backgroundImage = "";
      art.textContent = (t.name || "?").slice(0, 1).toUpperCase();
    }
    node.querySelector(".tok-name").textContent = t.name || "";
    const hp = node.querySelector(".tok-hp");
    // A player sees their own numbers and the DM sees everything; a monster's remaining hit points
    // are the DM's business, so the bar is there and the digits are not.
    if (t.hpMax) {
      const pct = Math.max(0, Math.min(100, Math.round((Number(t.hp) || 0) / t.hpMax * 100)));
      const show = tbl.role === "dm" || (t.charCode && t.charCode === tbl.me.charCode);
      hp.innerHTML = `<span class="tok-bar"><span style="width:${pct}%"></span></span>${
        show ? `<span class="tok-num">${esc(t.hp)}/${esc(t.hpMax)}</span>` : ""}`;
    } else hp.innerHTML = "";
  }
  for (const node of [...host.children]) {
    if (!seen.has(node.dataset.token)) node.remove();
  }
  paintRuler();
}

/* ---------------------------------------------------------------- dragging, panning, pinching */

/* Pointer events, not mouse and touch separately: a stylus, a finger and a mouse all arrive here as
   the same three events, which is the only reason the board works on a phone without a second
   implementation to keep in step. */
function bindStage() {
  const stage = $("#vtt-stage");
  if (!stage) return;
  stage.addEventListener("pointerdown", onPointerDown);
  stage.addEventListener("pointermove", onPointerMove);
  stage.addEventListener("pointerup", onPointerUp);
  stage.addEventListener("pointercancel", onPointerUp);
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

function onPointerDown(e) {
  if (!tbl) return;
  const stage = $("#vtt-stage");
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
    tbl.view.x = d.ox + (p.sx - d.sx);
    tbl.view.y = d.oy + (p.sy - d.sy);
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
  const d = tbl.drag;
  if (!d) return;
  tbl.drag = null;
  if (d.pan) return;
  const node = $("#vtt-tokens").querySelector(`[data-token="${d.id}"]`);
  if (node) node.classList.remove("dragging");
  // Snap to the grid on release. Squares are integers; a large token still sits on square corners.
  const scene = tblScene();
  const x = Math.max(0, Math.min((Number(scene.cols) || 30) - 1, Math.round(d.x)));
  const y = Math.max(0, Math.min((Number(scene.rows) || 20) - 1, Math.round(d.y)));
  CocLive.put(tblPath("tokens/" + d.id + "/x"), x).catch(tblFail);
  CocLive.put(tblPath("tokens/" + d.id + "/y"), y).catch(tblFail);
  tblCountMove(d, x, y);
  paintTokens();
  paintRuler();
}

/* ---------------------------------------------------------------- filled in by later checkpoints */

function paintRuler() { /* checkpoint: ruler + movement budget */ }
function tblCountMove() { /* checkpoint: ruler + movement budget */ }
function paintTurnBar() { /* checkpoint: turn order */ }
function paintLog() { /* checkpoint: dice + roll log */ }
function paintDmPanel() { /* checkpoint: maps and the DM screen */ }
function tblOpenToken() { /* checkpoint: token editor */ }

/* ---------------------------------------------------------------- wiring */

COC_ROUTES.table = routeTable;

document.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-tbl]");
  if (!btn || btn.disabled) return;
  const { tbl: act, val } = btn.dataset;
  if (act === "create") return tblCreate();
  if (act === "join") return tblJoin();
  if (!tbl) return;
  if (act === "zoom") {
    if (val === "0") tblFit(); else tblZoomBy(val === "1" ? 1.25 : 1 / 1.25);
  }
});
