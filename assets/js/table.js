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
    data: { meta: null, scenes: null, tokens: null, log: null, presence: null, handouts: null, dm: null },
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
  if (typeof closeSheetPanel === "function" && tbl.ui && tbl.ui.panel === "sheet") closeSheetPanel();
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
  watch("meta", () => { paintHeader(); paintBoard(); paintTurnBar(); paintHandout(); });
  watch("scenes", () => { paintBoard(); paintDmPanel(); });
  watch("tokens", () => { paintTokens(); paintTurnBar(); });
  watch("log", () => { paintLog(); });
  watch("presence", () => { paintWho(); });
  watch("handouts", () => { paintHandout(); paintDmPanel(); });
  watch("dm", () => { paintDmPanel(); });
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
          <button class="btn-quiet" data-tbl="panel" data-val="sheet">My sheet</button>
          ${tbl.role === "dm" ? `<button class="btn-quiet" data-tbl="panel" data-val="dm">DM</button>` : ""}
        </span>
      </div>
      <p id="vtt-error" class="warn hidden"></p>
      <p id="vtt-lastroll" class="last-roll hidden"></p>
      <div id="vtt-turn" class="vtt-turn hidden"></div>
      <div id="vtt-handout" class="vtt-handout hidden"></div>
      <div class="vtt-body">
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

/* ---------------------------------------------------------------- the side panel */

/* One column beside the board on a desktop, the lower half of the screen on a phone. It holds the
   things you dip into rather than watch: the dice, your own sheet, the DM's tools. Rendered whole
   each time, which is safe because nothing in it is mid-drag. */
function tblPanel(which) {
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
  if (which === "dm") side.innerHTML = dmPanelHTML();
  else if (which === "dice") side.innerHTML = dicePanelHTML();
  else if (which === "sheet") { side.innerHTML = `<p class="muted">Opening your sheet…</p>`; paintSheetPanel(); }
}
/* Re-render the DM's panel only if it is the one open — the scenes stream fires for everyone. */
function paintDmPanel() { if (tbl.ui.panel === "dm") paintSide(); }

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
  return editing + dmMapsHTML() + dmFiguresHTML() + dmScreenHTML();
}

function dmMapsHTML() {
  const scenes = tbl.data.scenes || {};
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
    <section class="panel">
      <p class="panel-sub">This scene</p>
      <div class="hp-controls">
        <button class="btn-quiet" data-tbl="grid-cols" data-val="-1">Narrower</button>
        <button class="btn-quiet" data-tbl="grid-cols" data-val="1">Wider</button>
        <button class="btn-quiet" data-tbl="grid-rows" data-val="-1">Shorter</button>
        <button class="btn-quiet" data-tbl="grid-rows" data-val="1">Taller</button>
      </div>
      <p class="muted">Nudge the grid until a square is a square. Five feet per square, as usual.</p>
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
  const say = (t, bad) => { if (msg) { msg.textContent = t; msg.className = "save-msg" + (bad ? " bad" : ""); } };
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
function tblParseRoll(spec) {
  const m = /^\s*(\d*)d(\d+)\s*([+-]\s*\d+)?\s*$/i.exec(String(spec || ""));
  if (!m) return null;
  return {
    count: Math.max(1, Math.min(40, Number(m[1] || 1))),
    sides: Math.max(2, Math.min(1000, Number(m[2]))),
    mod: m[3] ? Number(String(m[3]).replace(/\s+/g, "")) : 0,
  };
}

function d(sides) { return 1 + Math.floor(Math.random() * sides); }

/* Advantage and disadvantage are a property of the ROLL, not of the die: two d20s, keep one. Applying
   them to "4d6" would be a house rule nobody asked for, so they are ignored unless a single die is
   being thrown. */
function tblDoRoll(spec, mode) {
  const twin = (mode === "adv" || mode === "dis") && spec.count === 1;
  const rolls = [];
  const n = twin ? 2 : spec.count;
  for (let i = 0; i < n; i++) rolls.push(d(spec.sides));
  const kept = twin ? [mode === "adv" ? Math.max(...rolls) : Math.min(...rolls)] : rolls.slice();
  const sum = kept.reduce((a, b) => a + b, 0);
  return {
    rolls, kept, mode: twin ? mode : "normal", spec,
    total: sum + spec.mod,
    natural: spec.sides === 20 && kept.length === 1 ? kept[0] : 0,
  };
}

/* One line, readable at a glance from across a table, with the working shown because "18" on its own
   is exactly the number people query. */
function tblRollLine(who, label, res) {
  const s = res.spec;
  who = esc(who || "Someone");
  label = label ? esc(label) : "";
  const dice = `${s.count === 1 ? "" : s.count}d${s.sides}`;
  const shown = res.rolls.length > 1 || res.mode !== "normal"
    ? `[${res.rolls.join(", ")}]${res.mode === "adv" ? " keep high" : res.mode === "dis" ? " keep low" : ""}`
    : String(res.kept[0]);
  const modText = s.mod ? ` ${s.mod > 0 ? "+" : "−"} ${Math.abs(s.mod)}` : "";
  // Named rolls say what they were for; a bare handful of dice does not need "rolled 2d8: 2d8".
  const head = label ? `${who} rolled ${label}: ${dice}${modText}` : `${who} rolled ${dice}${modText}`;
  return `${head} → ${shown}${s.mod || res.rolls.length > 1 ? " = " + res.total : ""}`;
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
  if (tbl) {
    CocLive.push(tblPath("log"), {
      t: Date.now(), who, kind: "roll", text,
      nat: res.natural === 20 ? 20 : res.natural === 1 ? 1 : 0,
    }).catch(() => {});
  } else {
    tblToast(text);
  }
  return res;
}

/* Away from a table a roll has nowhere to appear, so it says itself and fades. Built here rather
   than in the markup because the sheet is not the only page that can roll. */
let tblToastTimer = null;
function tblToast(text) {
  let node = document.getElementById("roll-toast");
  if (!node) {
    node = document.createElement("div");
    node.id = "roll-toast";
    node.className = "roll-toast";
    document.body.appendChild(node);
  }
  node.textContent = text;
  node.classList.add("on");
  clearTimeout(tblToastTimer);
  tblToastTimer = setTimeout(() => node.classList.remove("on"), 4000);
}

const TBL_DICE = [4, 6, 8, 10, 12, 20, 100];

function dicePanelHTML() {
  const t = tbl.ui.dice || (tbl.ui.dice = { sides: 20, count: 1, mod: 0, mode: "normal" });
  const spec = `${t.count}d${t.sides}${t.mod ? (t.mod > 0 ? "+" : "") + t.mod : ""}`;
  return `<section class="panel">
      <h2>Dice</h2>
      <div class="chips">${TBL_DICE.map((s) =>
        `<button class="chip ${t.sides === s ? "on" : ""}" data-tbl="die" data-val="${s}">d${s}</button>`).join("")}</div>
      <div class="dice-row">
        <span class="stepper"><span class="ab-name">How many</span>
          <button class="step-btn" data-tbl="dice-count" data-val="-1">&minus;</button>
          <span class="step-val">${esc(t.count)}</span>
          <button class="step-btn" data-tbl="dice-count" data-val="1">+</button></span>
        <span class="stepper"><span class="ab-name">Modifier</span>
          <button class="step-btn" data-tbl="dice-mod" data-val="-1">&minus;</button>
          <span class="step-val">${esc(t.mod > 0 ? "+" + t.mod : t.mod)}</span>
          <button class="step-btn" data-tbl="dice-mod" data-val="1">+</button></span>
      </div>
      <div class="chips">${[["normal", "Straight"], ["adv", "Advantage"], ["dis", "Disadvantage"]].map(([k, label]) =>
        `<button class="chip ${t.mode === k ? "on" : ""}" data-tbl="dice-mode" data-val="${k}">${esc(label)}</button>`).join("")}
      </div>
      ${t.count > 1 && t.mode !== "normal" ? `<p class="muted">Advantage needs a single die — with
        ${esc(t.count)} of them it is ignored.</p>` : ""}
      <button class="btn" data-tbl="roll" data-val="${esc(spec)}">Roll ${esc(spec)}</button>
    </section>
    <section class="panel">
      <p class="panel-sub">Rolls at this table</p>
      <div id="vtt-log" class="roll-log"></div>
    </section>`;
}

/* The log is newest-first: a side panel on a phone has no room to auto-scroll, and the roll you care
   about is the one that just happened. */
function paintLog() {
  const last = $("#vtt-lastroll");
  const entries = Object.entries(tbl.data.log || {}).sort((a, b) => (b[1].t || 0) - (a[1].t || 0));
  if (last) {
    const top = entries[0];
    last.textContent = top ? top[1].text : "";
    last.classList.toggle("hidden", !top);
    last.classList.toggle("nat20", !!(top && top[1].nat === 20));
    last.classList.toggle("nat1", !!(top && top[1].nat === 1));
  }
  const host = $("#vtt-log");
  if (host) {
    host.innerHTML = entries.slice(0, 60).map(([, e]) =>
      `<p class="roll-line ${e.nat === 20 ? "nat20" : e.nat === 1 ? "nat1" : ""}">${esc(e.text || "")}</p>`).join("")
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
  if (!name) return say("Give it a name — a board of unnamed circles is unreadable.", true);
  await tblPlaceNpc({ name, hp, hpMax: hp, size, image });
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
  const taken = new Set(Object.values(tblTokens()).map((t) => `${Math.round(t.x)},${Math.round(t.y)}`));
  let { x, y } = at;
  for (let i = 0; i < 40 && taken.has(`${x},${y}`); i++) { x += 1; if (x > 40) { x = at.x; y += 1; } }
  const id = CocLive.newId();
  await CocLive.put(tblPath("tokens/" + id), Object.assign({
    name: "Figure", hp: 0, hpMax: 0, size: 1, image: "", speed: 30, initMod: 0,
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
function tblOpenToken(id) {
  const t = tblTokens()[id];
  if (!t) return;
  if (tbl.role !== "dm") {
    if (t.charCode && t.charCode === tbl.me.charCode) { tbl.ui.panel = "sheet"; paintSide(); }
    return;
  }
  tbl.ui.editToken = id;
  tbl.ui.panel = "dm";
  paintSide();
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

/* ---------------------------------------------------------------- the DM's screen and handouts */

/* Notes that survive a refresh and follow the DM to another device — which means they live in the
   table, which means anyone holding the room code could read them if they went looking. Said out loud
   rather than implied, because the alternative (keeping them in this browser only) loses them the
   moment the DM picks up a different device mid-session. */
function dmScreenHTML() {
  const notes = (tbl.data.dm || {}).notes || "";
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
  return `<section class="panel">
      <h2>Your notes</h2>
      <textarea id="dm-notes" class="text" rows="6" maxlength="4000"
        placeholder="Whatever you would have had in the other window.">${esc(notes)}</textarea>
      <p class="muted">Saved as you type, and they follow you to another device. They are not secret:
        anyone with the room code could read them if they went looking.</p>
    </section>
    <section class="panel" id="dm-handouts">
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
  if (!tbl || tbl.role !== "dm") return;
  if (e.target.id !== "dm-notes") return;
  CocLive.throttled(tblPath("dm/notes"), String(e.target.value || "").slice(0, 4000), 600);
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
  if (!tbl) return;
  if (act === "zoom") {
    if (val === "0") tblFit(); else tblZoomBy(val === "1" ? 1.25 : 1 / 1.25);
  } else if (act === "panel") tblPanel(val);
  else if (act === "die") { tbl.ui.dice.sides = Number(val); paintSide(); }
  else if (act === "dice-count") {
    tbl.ui.dice.count = Math.max(1, Math.min(40, tbl.ui.dice.count + Number(val)));
    paintSide();
  } else if (act === "dice-mod") {
    tbl.ui.dice.mod = Math.max(-20, Math.min(20, tbl.ui.dice.mod + Number(val)));
    paintSide();
  } else if (act === "dice-mode") { tbl.ui.dice.mode = val; paintSide(); }
  else if (act === "roll") tblRollAndPost(val, btn.dataset.label || "", tbl.ui.dice ? tbl.ui.dice.mode : "normal");
  // Stepping the turn is the DM's — or yours, on your own turn. paintTurnBar only renders the button
  // for those two, and this is the only way in, so it sits above the DM-only guard below.
  else if (act === "turn") tblTurnStep(Number(val)).catch(tblFail);
  else if (act === "sheet-open") tblOpenSheetByCode();
  // Dismissing a handout is each person's own business, so it is not a DM-only action.
  else if (act === "hand-dismiss") { tbl.ui.dismissed = val; paintHandout(); }
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
  else if (act === "ed-del") {
    CocLive.del(tblPath("tokens/" + val)).catch(tblFail);
    tbl.ui.editToken = ""; paintSide();
  }
  else if (act === "hand-add") tblAddHandout().catch(tblFail);
  else if (act === "hand-show") CocLive.put(tblPath("meta/handout"), val).catch(tblFail);
  else if (act === "hand-hide") CocLive.put(tblPath("meta/handout"), null).catch(tblFail);
  else if (act === "hand-del") {
    CocLive.del(tblPath("handouts/" + val)).catch(tblFail);
    if ((tbl.data.meta || {}).handout === val) CocLive.put(tblPath("meta/handout"), null).catch(tblFail);
  }
});
