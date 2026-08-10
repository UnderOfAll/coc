/*
 * Circus of Chaos — the panels beside the board
 *
 * Everything you dip into rather than watch: maps and scenes, figures and their editor, the turn order, the
 * sheet drawer, the tracker, the notepad, and the DM's screen. Rendered whole each time, because none of it
 * is ever mid-drag.
 *
 * Part of the table. These files are plain scripts sharing one global scope on purpose: there is no bundler
 * and no build step, so `table.js` loads last and everything it calls is already defined. Split by what a
 * change tends to touch — see RULES.md.
 */

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
  /* An open figure used to be lifted to the TOP of this panel, above the maps — which meant that opening
     one moved it away from where you tapped it, and the list you were reading jumped. It opens where it
     stands now, inside the list, like every other disclosure in this app. */
  return dmMapsHTML() + dmFiguresHTML() + dmScreenHTML() + stepDownHTML() + closeTableHTML();
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
      <div class="chips">
        <button class="chip ${active.gridOn !== false ? "on" : ""}" data-tbl="grid-on">${
          active.gridOn !== false ? "Grid on" : "Grid off"}</button>
        <button class="chip ${active.gridDark ? "on" : ""}" data-tbl="grid-dark">Dark lines</button>
        <button class="chip ${active.gridBold ? "on" : ""}" data-tbl="grid-bold">Bold</button>
      </div>
      ${tblGridSuggestHTML(active)}
      <p class="panel-sub">How many squares across</p>
      <div class="chips">${[10, 15, 20, 24, 30, 40, 60].map((n) =>
        `<button class="chip ${(active.cols || 30) === n ? "on" : ""}" data-tbl="grid-preset" data-val="${n}">${n}</button>`).join("")}</div>
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
      <p class="panel-sub">Line it up <span class="muted">— tenths of a square</span></p>
      <div class="hp-controls">
        <button class="btn-quiet" data-tbl="grid-off" data-val="x|-1">&larr;</button>
        <button class="btn-quiet" data-tbl="grid-off" data-val="x|1">&rarr;</button>
        <button class="btn-quiet" data-tbl="grid-off" data-val="y|-1">&uarr;</button>
        <button class="btn-quiet" data-tbl="grid-off" data-val="y|1">&darr;</button>
        <button class="btn-quiet" data-tbl="grid-off" data-val="reset">Corner</button>
      </div>
      ${active.image ? `<button class="btn-quiet" data-tbl="grid-fit">Make the squares square</button>` : ""}
      <p class="muted">A preset sets how many squares fit ACROSS the picture; how many fit down follows
        the picture's shape, so a square stays a square. Force them apart with the steppers if the map's
        own grid is not square. Five feet a square, so ${esc(active.cols || 30)} across is
        ${esc((active.cols || 30) * 5)} feet wide.</p>
    </section>`;
}

/* Rows from the picture's own shape, for the number of columns now chosen — the button that undoes a
   deliberate override, and what a preset does automatically. Uses the image AS LOADED, so it is the real
   aspect ratio rather than anything remembered. */
function tblSquareUpGrid(cols) {
  const id = tblSceneId();
  if (!id) return Promise.resolve();
  const scene = tblScene();
  const img = $("#vtt-map");
  const nw = img && img.naturalWidth, nh = img && img.naturalHeight;
  const across = Math.max(4, Math.min(120, Number(cols) || Number(scene.cols) || 30));
  const rows = (nw && nh) ? tblRowsFor(across, nw, nh) : (Number(scene.rows) || 20);
  return CocLive.patch(tblPath("scenes/" + id), { cols: across, rows });
}

/* Every figure on this scene, so the DM can reach one without finding it on the map first. */
/* What the picture itself can tell you about its grid.
 *
 * Kayki had to look up his map's pixel size in a file browser and work the arithmetic out by hand before the
 * grid would line up. The app is already holding the image: it knows how many pixels across it is, and battle
 * maps are drawn at a handful of standard squares — 70px is the common one, 100 and 140 for larger prints.
 * So it says the size and offers the counts, and each one is a button. */
function tblGridSuggestHTML(scene) {
  if (!scene.image) return "";
  const img = $("#vtt-map");
  const nw = img && img.naturalWidth, nh = img && img.naturalHeight;
  if (!nw || !nh) return "";
  const guesses = [70, 100, 140, 50].map((px) => ({
    px,
    cols: Math.round(nw / px),
    rows: Math.round(nh / px),
  })).filter((g) => g.cols >= 4 && g.cols <= 120 && g.rows >= 4);
  if (!guesses.length) return "";
  return `<p class="panel-sub">What the picture says</p>
    <p class="muted">This one is <strong>${esc(nw)}&times;${esc(nh)}</strong> pixels. Most battle maps are
      drawn at 70 pixels a square, so if yours came with a grid printed on it, one of these should line up
      exactly:</p>
    <div class="chips">${guesses.map((g) =>
      `<button class="chip ${(scene.cols || 0) === g.cols && (scene.rows || 0) === g.rows ? "on" : ""}"
        data-tbl="grid-guess" data-val="${g.cols}|${g.rows}">${g.cols}&times;${g.rows}
        <span class="muted">${g.px}px</span></button>`).join("")}</div>`;
}

function dmFiguresHTML() {
  const activeScene = tblSceneId();
  const rows = Object.entries(tblTokens())
    .filter(([, t]) => t && !(t.kind === "npc" && t.scene && t.scene !== activeScene))
    .sort((a, b) => (a[1].kind === "pc" ? -1 : 1) - (b[1].kind === "pc" ? -1 : 1)
      || String(a[1].name || "").localeCompare(String(b[1].name || "")))
    .map(([id, t]) => {
      // Open, and therefore expanded in place: everything about this figure — its picture, its hit
      // points, its conditions — unfolds under its own name rather than somewhere else on the page.
      const open = tbl.ui.editToken === id;
      return `<div class="scene-row ${open ? "on" : ""}" data-figure="${esc(id)}">
      <button class="scene-pick" data-tbl="ed-open" data-val="${esc(id)}" aria-expanded="${open}">
        <strong><span class="caret">${open ? "&#9662;" : "&#9656;"}</span> ${esc(t.name || "Figure")}</strong>
        <span class="muted">${t.hpMax ? esc(t.hp) + "/" + esc(t.hpMax) + " hp" : "no hp"}${
          t.kind === "pc" ? " · player" : ""}</span>
      </button>
      <button class="btn-quiet" data-tbl="ed-dup" data-val="${esc(id)}">Copy</button>
    </div>${open ? `<div class="figure-open">${tokenEditorHTML(id)}</div>` : ""}`;
    }).join("");
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
      <label class="field"><span>Picture <span class="muted">a link, or maps/… — a photo can be added
        once it is on the board</span></span>
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
/* A figure's picture is not a map: it is shown at forty pixels across, so it is shrunk far harder and
   capped far lower — the database's own limit for a token image is a sixth of a map's. */
const TBL_TOKEN_IMAGE = { sides: [256, 192, 128], cap: 110000 };
function tblShrinkImage(file, done, fail, budget) {
  const reader = new FileReader();
  reader.onerror = () => fail("That file could not be read.");
  reader.onload = () => {
    const img = new Image();
    img.onerror = () => fail("That does not look like an image.");
    img.onload = () => {
      const canvas = document.createElement("canvas");
      if (!canvas.getContext) return fail("This browser cannot resize images.");
      const sides = (budget && budget.sides) || [1600, 1200, 900, 700];
      const cap = (budget && budget.cap) || TBL_IMAGE_CAP;
      for (const maxSide of sides) {
        const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
        canvas.width = Math.max(1, Math.round(img.width * scale));
        canvas.height = Math.max(1, Math.round(img.height * scale));
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        for (const q of [0.72, 0.6, 0.48, 0.38]) {
          const out = canvas.toDataURL("image/jpeg", q);
          if (out.length <= cap) return done(out, img.width, img.height);
        }
      }
      fail("Even shrunk, that image is too big to store. Commit it into maps/ instead.");
    };
    img.src = /** @type {string} */ (reader.result);
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


/* ---------------------------------------------------------------- turn order */

/* ---------------------------------------------------------------- initiative
 *
 * Everyone rolls their own. The DM used to press one button and the whole table's initiative was
 * decided for them, which is not how anybody plays: you roll your own die, and half the table rolls a
 * real one on a real table and reads the number out. So starting a fight OPENS a gather — every figure
 * on the scene is listed, and whoever holds it puts a number in, either with the dice in the app or by
 * typing what their own dice said. The order forms when everyone is in.
 *
 * `meta/init` exists only while gathering: { at, need: [ids], have: { id: number } }. It is deleted the
 * moment the order is written, so `meta/turn` remains the single answer to "is there a fight on". */

/* Everything that should be in this fight: the figures on the active scene. A creature parked on
   another map is not in this one. */
function tblInitCandidates() {
  const activeScene = tblSceneId();
  return Object.entries(tblTokens())
    .filter(([, t]) => t && !(t.kind === "npc" && t.scene && t.scene !== activeScene))
    /* A SPAWNED FIGURE HAS NO TURN OF ITS OWN. A Clone never acts by itself — it is a body double, an
       eye, or somewhere for your own attacks to come from — so it is driven inside its owner's turn and
       one "Done" ends the lot. Kayki's point, and the decision recorded in docs/MAP-INTERACTION.md.
       Without this, every Clone made mid-fight stopped the table to ask what it rolled, and four of them
       would have put four faces in the order bar with nothing to do on any of their turns. */
    .filter(([, t]) => !t.spawn)
    .map(([id]) => id);
}

/* Which of them THIS device is expected to roll for. You roll for what you hold; the DM rolls for
   everything nobody is holding, which is the creatures and any player figure whose owner has gone. */
function tblInitMine(need) {
  const tokens = tblTokens();
  return need.filter((id) => {
    const t = tokens[id];
    if (!t) return false;
    return tblIsMine(t) || (tbl.role === "dm" && !tblHolderPresent(t));
  });
}

/* Is the browser that holds this figure still at the table? Presence answers it, the same way the DM
   chair does — otherwise a player who closed their laptop mid-fight would stall the whole gather. */
function tblHolderPresent(t) {
  if (!t || !t.owner) return false;
  const who = (tbl.data.presence || {})[t.owner];
  return !!who && Date.now() - (Number(who.at) || 0) < 60000;
}

/* The DM opens the gather. Any previous order goes: a fight that is starting is not the old one. */
async function tblInitOpen() {
  const need = tblInitCandidates();
  if (!need.length) { tblFail({ message: "Nothing on this map to put in an order." }); return; }
  await CocLive.put(tblPath("meta/turn"), null);
  await CocLive.put(tblPath("meta/init"), { at: Date.now(), need, have: {} });
  await CocLive.push(tblPath("log"), {
    t: Date.now(), who: "DM", kind: "system", text: "Roll for initiative.",
  });
}

/* One figure's number, however it was arrived at. Written to the gather AND onto the figure, so the
   board can show it without reading the gather. */
async function tblInitSet(id, value) {
  const n = tblInitNumber(value);
  await CocLive.put(tblPath("meta/init/have/" + id), n);
  await tblTokenField(id, "init", n);
  tblSettleSoon();
}

function tblInitNumber(value) {
  return Math.max(-20, Math.min(99, Math.round(Number(value) || 0)));
}

/* A number arrives through the same button and the same box at two different moments: the gather before
   a fight, and a latecomer walking into one that is already running. Which one it is decides where the
   number goes, and nothing above this line has to care. */
function tblInitApply(id, value) {
  return (tbl.data.meta || {}).init ? tblInitSet(id, value) : tblJoinSet(id, value);
}

/* Roll it here, with the dice everybody else can see. The modifier is the figure's own, so what goes in
   is the total — the same number a player reading their own dice would type. */
async function tblInitRoll(id, quiet) {
  const t = tblTokens()[id];
  if (!t) return;
  const mod = Number(t.initMod) || 0;
  const res = tblRollAndPost({ terms: [{ count: 1, sides: 20, sign: 1 }], mod },
    "Initiative", "normal", t.name || "Someone", quiet);
  if (!res) return;
  /* WAIT FOR THE DICE. The number is decided the instant you click, and writing it straight in put the
     whole order on the screen while the dice were still in the air — Kayki watched it happen on the
     second roll of the first fight. The roll is not a secret from the table (the log has it), but the
     ORDER is the result of it, and a result that arrives before its own dice have landed makes the throw
     pointless. A quiet roll threw no dice and does not wait. */
  await res.settled;
  await tblInitApply(id, res.total);
}

/* Everyone in? Then the order forms. Only the DM's browser builds it — two clients racing to write the
   same order is how you get two different fights. */
async function tblInitSettle(force) {
  if (tbl.role !== "dm") return;
  const init = (tbl.data.meta || {}).init;
  if (!init) return;
  const have = init.have || {};
  const need = (init.need || []).filter((id) => tblTokens()[id]);
  const inOrder = need.filter((id) => have[id] != null);
  if (!inOrder.length) return;
  if (!force && inOrder.length < need.length) return;
  const tokens = tblTokens();
  const rolled = inOrder.map((id) => ({
    id, name: (tokens[id] || {}).name || "Someone",
    total: Number(have[id]), mod: Number((tokens[id] || {}).initMod) || 0,
  }));
  // Highest first; a tie is broken by the modifier, then by name, so the order is at least stable
  // rather than whatever key order the database happens to return.
  rolled.sort((a, b) => b.total - a.total || b.mod - a.mod || a.name.localeCompare(b.name));
  await CocLive.put(tblPath("meta/turn"), {
    order: rolled.map((r) => r.id), idx: 0, round: 1, startedAt: Date.now(),
  });
  await CocLive.put(tblPath("meta/init"), null);
  for (const r of rolled) await tblTokenField(r.id, "moved", 0);
  await CocLive.push(tblPath("log"), {
    t: Date.now(), who: "DM", kind: "system",
    text: "Initiative — " + rolled.map((r) => `${r.name} ${r.total}`).join(", "),
  });
}

/* Everything this device still owes, rolled at once. The DM has a screenful of creatures and should not
   have to press a button per goblin. Works for both moments — the gather, and a handful of reinforcements
   walking into a fight together. */
async function tblInitRollMine() {
  const owed = tblInitOwed();
  // Quiet: the log gets every roll, the screen does not get seven throws in a row.
  for (const id of owed) await tblInitRoll(id, owed.length > 1);
}

/* What THIS device is still being asked for, in whichever of the two moments the table is in. */
function tblInitOwed() {
  const meta = tbl.data.meta || {};
  if (meta.init) {
    const have = meta.init.have || {};
    return tblInitMine(meta.init.need || []).filter((id) => have[id] == null);
  }
  return tblInitMine(tblJoinNeed(meta.turn));
}

/* ---------------------------------------------------------------- joining a fight in progress
 *
 * A creature that walks in halfway through does not wait for the next fight. It rolls, and it slots into
 * the order where the number puts it — the same way BG3 does it, and the same way a table does.
 *
 * It reuses the gather's machinery rather than repeating it: the same row, the same button, the same box,
 * the same "you roll for what you hold". Only the destination differs. `meta/turn/late` holds a number
 * that has been rolled but not yet placed (only the DM's browser rewrites the order); `meta/turn/out`
 * holds the figures the DM has said are not in this fight, so a prop dropped on the board mid-combat
 * stops asking. Both go when the fight does, because both live inside `meta/turn`. */

/* Who is being asked to join: on this scene, not in the order, not already rolled, not waved off. */
function tblJoinNeed(turn) {
  if (!turn || !Array.isArray(turn.order) || !turn.order.length) return [];
  const inOrder = new Set(turn.order);
  const late = turn.late || {}, out = turn.out || {};
  return tblInitCandidates().filter((id) => !inOrder.has(id) && late[id] == null && !out[id]);
}

async function tblJoinSet(id, value) {
  const turn = (tbl.data.meta || {}).turn;
  if (!turn || !Array.isArray(turn.order) || !turn.order.length) return;
  const n = tblInitNumber(value);
  await tblTokenField(id, "init", n);
  await CocLive.put(tblPath("meta/turn/late/" + id), n);
  tblSettleSoon();
}

/* Not everything put on the board mid-fight is IN the fight. */
async function tblJoinOut(id) {
  if (tbl.role !== "dm") return;
  await CocLive.put(tblPath("meta/turn/out/" + id), true);
}

/* Place whoever has rolled. The DM's browser only, for the same reason the gather settles there: two
   clients splicing the same array is two different orders. */
async function tblJoinSettle() {
  if (tbl.role !== "dm") return;
  const turn = (tbl.data.meta || {}).turn;
  if (!turn || !Array.isArray(turn.order) || !turn.order.length) return;
  const late = turn.late || {};
  const tokens = tblTokens();
  const waiting = Object.keys(late).filter((id) => tokens[id] && turn.order.indexOf(id) < 0);
  if (!waiting.length) {
    if (Object.keys(late).length) await CocLive.put(tblPath("meta/turn/late"), null);
    return;
  }
  const order = turn.order.slice();
  let idx = Math.min(Math.max(0, turn.idx || 0), order.length - 1);
  // The number for someone already in the order is on their figure; for the ones arriving it is in
  // `late`, which the local copy of the figure may not have caught up with yet.
  const rank = (id) => {
    const t = tokens[id] || {};
    return [late[id] != null ? Number(late[id]) : Number(t.init) || 0,
      Number(t.initMod) || 0, String(t.name || "")];
  };
  // Ahead of somebody: higher total, then higher modifier, then the name — the gather's tiebreak, so a
  // latecomer lands exactly where they would have landed had they been there from the start.
  const ahead = (a, b) => (a[0] !== b[0] ? a[0] > b[0]
    : a[1] !== b[1] ? a[1] > b[1] : a[2].localeCompare(b[2]) < 0);
  for (const id of waiting) {
    const mine = rank(id);
    let at = order.findIndex((other) => ahead(mine, rank(other)));
    if (at < 0) at = order.length;
    order.splice(at, 0, id);
    // Whoever was up stays up: an insertion at or before them shifts them one to the right.
    if (at <= idx) idx += 1;
    await tblTokenField(id, "moved", 0);
  }
  await CocLive.patch(tblPath("meta/turn"), { order, idx });
  await CocLive.put(tblPath("meta/turn/late"), null);
  await CocLive.push(tblPath("log"), {
    t: Date.now(), who: "DM", kind: "system",
    text: waiting.map((id) => `${(tokens[id] || {}).name || "Someone"} joins the fight at ${late[id]}`)
      .join(", "),
  });
}

/* The one place either kind of settle is asked for.
 *
 * The last number in may have been typed on somebody else's device, and only the DM's browser is allowed
 * to build the order — so the check belongs on every stream event, not only on the roll this device made.
 * Without it, a fight where the DM rolls before the players never starts: the bar sits at "you are in",
 * waiting for a settle nobody will run.
 *
 * Deferred and serialised, and both for the same reason: a write does not land in this browser's own copy
 * until the stream brings it back, so the settle has to read the freshest state it can rather than the
 * state at the moment it was asked for — and two of them running at once would splice the same order
 * twice.
 *
 * A call that arrives while one is running is QUEUED, not dropped. Dropping it was the first version and
 * it was wrong: the reasoning was that settling writes, and a write brings the event that lands back
 * here, so a skipped call always gets another chance. That only holds when the settle actually writes
 * something. The pass that runs on a quiet moment writes nothing, brings no event, and takes the next
 * call — the one that had real work — down with it. The figure Kayki watched fail to leave the order was
 * exactly this: the pass that mattered arrived one tick inside the pass that did not. */
let tblSettlePending = false;
let tblSettleAgain = false;
function tblSettleSoon() {
  if (tbl.role !== "dm") return;
  if (tblSettlePending) { tblSettleAgain = true; return; }
  tblSettlePending = true;
  Promise.resolve().then(() => {
    const meta = tbl.data.meta || {};
    const late = (meta.turn || {}).late;
    if (meta.init) return tblInitSettle();
    if (late && Object.keys(late).length) return tblJoinSettle();
    return tblPruneOrder();
  }).catch(tblFail).then(() => {
    tblSettlePending = false;
    if (tblSettleAgain) { tblSettleAgain = false; tblSettleSoon(); }
  });
}

/* A FIGURE THAT HAS LEFT THE BOARD LEAVES THE FIGHT WITH IT.
 *
 * The order is a list of ids, and nothing was removing an id when its figure was removed. Three things
 * went wrong with a dead id sitting in it, and Kayki hit all three in one session:
 *
 *   - `idx` counts through the RAW order while the bar draws the FILTERED one, so with a dead id early in
 *     the list the wrong figure was shown as up.
 *   - stepping onto it wrote `tokens/<dead>/moved`, and the database has no schema — so the figure came
 *     BACK, nameless, with no square, sitting at the top-left corner of the map. That is the "Figure with
 *     a ? on it" that appeared out of nowhere. (Guarded at the write now too, in `tblTokenField` — a
 *     thing this wrong deserves stopping twice.)
 *   - and it could not be dragged away, because a figure with no `x` makes the drag NaN.
 *
 * Whoever was up stays up, by id and not by index. If it was the one who left, the turn passes to
 * whoever took its place in the line, which is what happens at a table when someone's miniature is
 * knocked off it. */
async function tblPruneOrder() {
  if (tbl.role !== "dm") return;
  const turn = (tbl.data.meta || {}).turn;
  if (!turn || !Array.isArray(turn.order) || !turn.order.length) return;
  const tokens = tblTokens();
  const kept = turn.order.filter((id) => tokens[id]);
  if (kept.length === turn.order.length) return;
  if (!kept.length) { await CocLive.put(tblPath("meta/turn"), null); return; }
  const wasIdx = Math.min(Math.max(0, Number(turn.idx) || 0), turn.order.length - 1);
  const wasUp = turn.order[wasIdx];
  const at = kept.indexOf(wasUp);
  await CocLive.patch(tblPath("meta/turn"),
    { order: kept, idx: at >= 0 ? at : Math.min(wasIdx, kept.length - 1) });
  await CocLive.push(tblPath("log"), {
    t: Date.now(), who: "DM", kind: "system",
    text: (turn.order.length - kept.length) + " figure(s) left the fight",
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
  if (id) await tblTokenField(id, "moved", 0);
}

async function tblTurnEnd() {
  await CocLive.put(tblPath("meta/turn"), null);
}

/* A player with no figure of their own is not in the fight, and the bar used to tell them the opposite.
 * "You are in — waiting for the rest" is what a phone showed all through a gather it was never part of,
 * while the DM was quietly asked for that player's figure as well as the creatures — which is exactly
 * what happened the first time this was played on two devices. The distinction the code makes is between
 * "asked for nothing because everyone else is still rolling" and "asked for nothing because you hold
 * nothing", and the bar has to make it too, with the way out attached. */
function tblHoldingNothing() {
  return tbl.role !== "dm" && !tblMyTokens().length;
}

function seatNudgeHTML(why) {
  return `<strong class="turn-who">${esc(why)}</strong>
    <button class="btn-quiet on" data-tbl="panel" data-val="seat">Choose a character</button>`;
}

/* One figure being asked for a number: roll it here, or type what the dice on your table said. The same
   row serves the gather and a latecomer — only the DM's "not in it" is particular to joining, because
   only mid-fight can something land on the board that was never meant to be in the order. */
function initAskHTML(id, tokens, joining) {
  const t = tokens[id] || {};
  return `<span class="init-ask">
    <span class="init-name">${esc(t.name || "Figure")}</span>
    <button class="btn-quiet" data-tbl="init-roll-one" data-val="${esc(id)}">Roll ${
      Number(t.initMod) ? (Number(t.initMod) > 0 ? "+" + esc(t.initMod) : esc(t.initMod)) : "d20"}</button>
    <input class="num init-num" data-init-for="${esc(id)}" type="number" inputmode="numeric"
      placeholder="or type it" aria-label="Initiative for ${esc(t.name || "figure")}" />
    ${joining && tbl.role === "dm" ? `<button class="btn-quiet" data-tbl="init-out" data-val="${esc(id)}"
      title="Keep ${esc(t.name || "this figure")} out of this fight">Out</button>` : ""}
  </span>`;
}

/* The gather, on every screen at once. You are shown what YOU owe; everyone else's is a tally, so the
   table can see who it is waiting for without anybody having to ask. */
function initBarHTML(init) {
  const tokens = tblTokens();
  const need = (init.need || []).filter((id) => tokens[id]);
  const have = init.have || {};
  const mine = tblInitMine(need).filter((id) => have[id] == null);
  const waiting = need.filter((id) => have[id] == null);
  const row = (id) => initAskHTML(id, tokens, false);
  return `<span class="turn-round">Initiative</span>
    ${mine.length ? `<span class="init-rows">${mine.map(row).join("")}</span>
      ${mine.length > 1 ? `<button class="btn-quiet" data-tbl="init-roll-mine">Roll all ${mine.length}</button>` : ""}`
      : tblHoldingNothing() ? seatNudgeHTML("You are not holding a figure, so nothing is asking you to roll")
      : `<strong class="turn-who">You are in${waiting.length ? " — waiting for the rest" : ""}</strong>`}
    <span class="muted">${esc(need.length - waiting.length)} of ${esc(need.length)} in${
      waiting.length && !mine.length ? ": " + esc(waiting.map((id) => (tokens[id] || {}).name || "?").slice(0, 4).join(", ")) : ""}</span>
    <span class="turn-acts">
      ${tbl.role === "dm" ? `<button class="btn-quiet" data-tbl="init-go" ${waiting.length ? "" : "disabled"}>Start without them</button>
        <button class="btn-quiet" data-tbl="turn-end">Cancel</button>` : ""}
    </span>`;
}

/* Somebody walked in. A line under the running fight, on its own row so the turn above it does not move
   when a creature is dropped on the board: what THIS device is asked to roll, and a note about anyone
   else the order is waiting on. It is not a modal and it blocks nothing — the fight carries on around
   whoever is still finding their dice. */
function joinLineHTML(turn, tokens) {
  const need = tblJoinNeed(turn);
  const mine = tblInitMine(need);
  const others = need.filter((id) => mine.indexOf(id) < 0);
  const placing = Object.keys(turn.late || {}).filter((id) => tokens[id]);
  // Watching a fight you are not in is a legitimate thing to be doing, but not knowing WHY you are not
  // in it is not — so the same row carries the way in.
  const adrift = tblHoldingNothing();
  if (!adrift && !mine.length && !others.length && !placing.length) return "";
  const nameOf = (id) => (tokens[id] || {}).name || "?";
  return `<div class="turn-joining">
    ${adrift ? seatNudgeHTML("No figure of yours is in this fight") : `<span class="turn-round">Joining</span>`}
    ${mine.length ? `<span class="init-rows">${
      mine.map((id) => initAskHTML(id, tokens, true)).join("")}</span>` : ""}
    ${mine.length > 1 ? `<button class="btn-quiet" data-tbl="init-roll-mine">Roll all ${mine.length}</button>` : ""}
    ${others.length ? `<span class="muted">waiting for ${
      esc(others.slice(0, 4).map(nameOf).join(", "))}${others.length > 4 ? "…" : ""}</span>` : ""}
    ${placing.length ? `<span class="muted">placing ${esc(placing.map(nameOf).join(", "))}</span>` : ""}
  </div>`;
}

/* THE ORDER, AS FACES. Everyone in the fight along the top, in the order they act, with the figure
 * whose turn it is raised out of the line — which is the one thing you want to know at a glance and the
 * one thing a sentence is bad at.
 *
 * What it may show is decided by RULES.md and not by what would look good: **hit points are not public**,
 * so no bar and no numbers here — a player reads their own on their sheet and the DM reads them on the
 * figure. **Conditions ARE public**, because they change what a figure can do, so they are marked.
 * The initiative each one rolled is public too — it is the reason the order is what it is.
 *
 * Tapping a face opens that figure, which is the same thing tapping it on the board does. */
function turnStripHTML(order, tokens, currentId) {
  if (order.length < 2) return "";
  return `<div class="turn-strip" role="list">${order.map((id) => {
    const t = tokens[id] || {};
    const now = id === currentId;
    const conds = Array.isArray(t.conditions) ? t.conditions : [];
    const initials = String(t.name || "?").trim().slice(0, 1).toUpperCase();
    return `<button class="turn-face ${now ? "now" : ""} ${t.kind === "npc" ? "npc" : "pc"}"
      role="listitem" data-tbl="ed-open" data-val="${esc(id)}"
      title="${esc(t.name || "Figure")}${conds.length ? " — " + conds.map((c) => esc(TBL_CONDITION_NAMES[c] || c)).join(", ") : ""}"
      aria-current="${now}">
      <span class="turn-art"${t.image ? ` style="background-image:url('${esc(t.image)}')"` : ""}>${
        t.image ? "" : esc(initials)}</span>
      <span class="turn-init">${t.init == null ? "" : esc(t.init)}</span>
      ${conds.length ? `<span class="turn-cond" aria-hidden="true">${esc(conds.length)}</span>` : ""}
      <span class="turn-label">${esc(t.name || "Figure")}</span>
    </button>`;
  }).join("")}</div>`;
}

/* The bar above the board: whose turn it is, what round, and what they have left to walk. Everyone
   sees it; the DM can move it along, and so can whoever's turn it is — pressing "Done" on your own
   turn is the one piece of the tracker a player should not have to ask for. */
function paintTurnBar() {
  const bar = $("#vtt-turn");
  if (!bar) return;
  tblSettleSoon();
  const init = (tbl.data.meta || {}).init;
  if (init) {
    // Nothing is anybody's turn yet, so no figure wears the ring.
    document.querySelectorAll("#vtt-tokens .tok").forEach((n) => n.classList.remove("turn"));
    bar.classList.remove("hidden");
    bar.innerHTML = initBarHTML(init);
    return;
  }
  const turn = (tbl.data.meta || {}).turn;
  const tokens = tblTokens();
  /* `idx` counts through the order AS STORED, so whose turn it is has to be read from that and not from
     the filtered list drawn below — reading the filtered one meant that a figure removed from the board
     early in the order silently shifted the gold ring onto the wrong person for as long as the dead id
     was still in the list. The DM's browser takes it out within the tick (tblPruneOrder); every other
     browser has to be right in the meantime. */
  const raw = turn && Array.isArray(turn.order) ? turn.order : [];
  const currentId = raw.length ? raw[Math.min(Math.max(0, Number(turn.idx) || 0), raw.length - 1)] : "";
  const order = raw.filter((id) => tokens[id]);
  // Highlight has to be cleared even when the tracker is off, or a stale ring stays on a token.
  document.querySelectorAll("#vtt-tokens .tok").forEach((n) =>
    n.classList.toggle("turn", asEl(n).dataset.token === currentId));
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
  const stripWas = bar.querySelector(".turn-strip");
  const scrollWas = stripWas ? stripWas.scrollLeft : 0;
  /* A phone says the same things in fewer words. The line has to hold the round, whose turn it is, what
     they have left to walk AND the button that ends the turn — and on 393px the long forms of the first
     three push the button onto a row of its own, which costs 50px of map for one word. So: "R1", and
     "30/30 ft" instead of "30 of 30 ft left". Nothing is dropped; the same four things are there. */
  const tight = !tblWide();
  bar.innerHTML = `${turnStripHTML(order, tokens, currentId)}
    <span class="turn-round">${tight ? "R" : "Round "}${esc(turn.round || 1)}</span>
    <strong class="turn-who">${esc(t.name || "?")}${mine ? " — you" : ""}</strong>
    ${budget ? `<span class="turn-move ${budget.left ? "" : "spent"}">${esc(budget.left)}${
      tight ? "/" + esc(budget.speed) + " ft" : " of " + esc(budget.speed) + " ft left"}</span>` : ""}
    ${upNext && upNext !== currentId ? `<span class="muted turn-next">next: ${esc((tokens[upNext] || {}).name || "?")}</span>` : ""}
    <span class="turn-acts">
      ${canStep ? `<button class="btn-quiet" data-tbl="turn" data-val="1">${mine && tbl.role !== "dm" ? "Done" : "Next"} &rarr;</button>` : ""}
      ${tbl.role === "dm" ? `<button class="btn-quiet" data-tbl="turn" data-val="-1">&larr; Back</button>
        <button class="btn-quiet" data-tbl="init-roll">Reroll</button>
        <button class="btn-quiet" data-tbl="turn-end">End</button>` : ""}
    </span>
    ${joinLineHTML(turn, tokens)}`;
  /* Keep the line where it was through a repaint — the bar is rebuilt on every stream event, and a
     strip that jumps back to the start each time is unusable with eight figures in it. Then bring
     whoever is up into view, which is the only reason to move it at all. */
  const strip = bar.querySelector(".turn-strip");
  if (!strip) return;
  strip.scrollLeft = scrollWas;
  const face = strip.querySelector(".turn-face.now");
  if (face && face.scrollIntoView) {
    const r = face.getBoundingClientRect(), s = strip.getBoundingClientRect();
    if (r.left < s.left || r.right > s.right) {
      try { face.scrollIntoView({ inline: "center", block: "nearest", behavior: "smooth" }); }
      catch { face.scrollIntoView(); }
    }
  }
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
    side.innerHTML = sideHeadHTML("sheet") + `<section class="panel">
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
  // Two bars, one for each shape the panel takes: the drawer's own head beside the board on a desktop,
  // and the phone's back bar when the panel IS the screen. Each is hidden where the other applies.
  side.innerHTML = sideHeadHTML("sheet") + `<div class="sheet-drawer-bar">
      <span class="muted">Sheet</span>
      <button class="btn-quiet" data-tbl="sheet-close">Close</button>
    </div>
    <div id="vtt-sheet"><p class="muted">Loading…</p></div>`;
  openSheetIn("#vtt-sheet", code).then(() => {
    /* AND CATCH UP WITH THE FIGHT. The sync runs on stream events, and opening the drawer is not one —
       so a sheet opened in the middle of a fight sat out of combat with a dead engine until somebody
       happened to move a figure. It asks as it arrives. */
    tblSyncSheetCombat();
  }).catch((err) => {
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
    /* The picture. A player owns their OWN character completely — its face is theirs to change whenever
       they like, and the figure on the board is a view of that character rather than a thing with a life
       of its own. So the sheet's photo simply wins here. (It only ever reaches figures carrying this
       character's code, which is why nobody can touch anybody else's, or a creature's, this way.) */
    if (ch.photo && t.image !== ch.photo) patch.image = ch.photo;
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

/* Opening a figure has to bring its details INTO VIEW. The panel is beside the board on a desktop and
   below it on a phone, so "it opened" and "you can see that it opened" were two different things — Kayki
   double-tapped a creature and the page stayed where it was. */
function tblRevealPanel() {
  const side = $("#vtt-side");
  if (side && side.scrollIntoView) {
    try { side.scrollIntoView({ block: "nearest", behavior: "smooth" }); } catch { side.scrollIntoView(); }
  }
}

/* Put an opened figure where its owner can see it. After the next frame, because the row it is scrolling
   to has only just been written into the page. */
function tblScrollToFigure(id) {
  requestAnimationFrame(() => {
    // Not CSS.escape: it does not exist everywhere this runs, and these ids are minted from base 36 and
    // a dash, so there is nothing in one to escape.
    const row = document.querySelector(`[data-figure="${String(id).replace(/["\\]/g, "")}"]`);
    if (!row || !row.scrollIntoView) return;
    try { row.scrollIntoView({ block: "nearest", behavior: "smooth" }); }
    catch { row.scrollIntoView(); }
  });
}

function tblOpenToken(id) {
  const t = tblTokens()[id];
  if (!t) return;
  if (tbl.role === "dm") {
    // Tapping the one that is already open closes it, which is what a disclosure does.
    tbl.ui.editToken = tbl.ui.editToken === id ? "" : id;
    tbl.ui.panel = "dm";
    paintSide();
    tblRevealPanel();
    // …and bring it into view. Opening a figure at the bottom of a long list used to unfold it off the
    // end of the panel, with nothing on screen to say anything had happened.
    if (tbl.ui.editToken) tblScrollToFigure(id);
    return;
  }
  // A player gets their own sheet for their own figure, and a read-only look at anything else. Being
  // told nothing at all about the thing about to eat you was the wrong answer.
  if (t.charCode && t.charCode === tbl.me.charCode) { tbl.ui.panel = "sheet"; paintSide(); tblRevealPanel(); return; }
  tbl.ui.lookAt = id;
  tbl.ui.panel = "figure";
  paintSide();
  tblRevealPanel();
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
  // Your own figure, with a sheet behind it: the sheet is where its numbers live, so all this needs to
  // offer is the thing that was missing — getting a character you are not playing off the board. A friend
  // of Kayki's ended up with three of his characters standing on the map at once.
  if (tblIsMine(t)) {
    return `<section class="panel"><h2>${esc(t.name || "Your figure")}</h2>
      <p class="muted">Your own figure. Its hit points and everything else live on your sheet — open
        <strong>My sheet</strong> for those.</p>
      <p class="panel-sub">Leaving</p>
      <button class="btn-quiet" data-tbl="mine-remove" data-val="${esc(id)}">Take my figure off the table</button>
      <p class="muted">Nothing about the character is touched; you can walk back in whenever.</p>
    </section>`;
  }
  const pct = t.hpMax ? Math.max(0, Math.min(100, Math.round((Number(t.hp) || 0) / t.hpMax * 100))) : 0;
  const showHp = tbl.role === "dm" || tblIsMine(t);
  const conds = Array.isArray(t.conditions) ? t.conditions : [];
  return `<section class="panel">
    <h2>${esc(t.name || "Figure")}</h2>
    ${t.image ? `<img class="figure-art" src="${esc(t.image)}" alt="" />` : ""}
    ${showHp && t.hpMax ? `<div class="hp-head"><span class="panel-sub">Hit points</span>
        <div class="hp-num ${pct <= 25 ? "hurt" : ""}"><strong>${esc(t.hp)}</strong><span>/ ${esc(t.hpMax)}</span></div></div>
      <div class="hp-bar"><div class="hp-fill ${pct <= 25 ? "hurt" : ""}" style="transform:scaleX(${pct / 100})"></div></div>`
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
    ${tokenImageHTML("ed", t.image)}
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
      <button class="btn-quiet" data-tbl="ed-del" data-val="${esc(id)}">Remove</button>
      <button class="btn-quiet" data-tbl="ed-close">Close</button>
    </div>
    ${trackerReadHTML(tblTrackerKeyFor(t))}
    ${t.charCode || t.owner ? `<p class="muted">This is a player's figure — its hit points follow their
      sheet, so changing them here is a stopgap rather than the record. Removing it takes them off the
      board; if they are still in the room they can walk back in.</p>` : ""}
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
    ${tokenImageHTML("mine", t.image)}
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
    <p class="panel-sub">Leaving</p>
    <button class="btn-quiet" data-tbl="mine-remove" data-val="${esc(id)}">Take my figure off the table</button>
    <p class="muted">For a character you are not playing tonight. Nothing about the character itself is
      touched, and you can walk back in whenever.</p>
  </section>`;
}

/* Closing a table. A room is not a document somebody owns a copy of — it is the session everyone is
   sitting in, so deleting it ends the game for every device at once and cannot be undone. Hence the
   same shape as deleting a character: nothing happens on one tap, and the confirmation is the ROOM
   CODE, typed out, because "which table am I closing" is the mistake worth preventing. */
/* The DM's own exit. Kept beside Close the table because they are the two ways a DM stops being one, and
   only one of them destroys anything. */
function stepDownHTML() {
  const meta = tbl.data.meta || {};
  const mine = meta.dmSeat === tbl.me.clientId;
  return `<section class="panel">
    <p class="panel-sub">The DM chair</p>
    <p class="muted">${mine ? "You are in it." : "Held by another device — yours will take it when they leave."}
      Only one person can be the DM at a time; the key opens the chair only when it is empty.</p>
    <button class="btn-quiet" data-tbl="step-down">Step down and play as a player</button>
  </section>`;
}

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

/* The pen tray. Everyone gets one; what differs is whose ink you may rub out and whether the DM has
   allowed drawing on this scene at all. */
function drawPanelHTML() {
  const ink = tblInkState();
  const scene = tblScene();
  const locked = scene.drawLocked === true;
  const mine = tblMyStrokes().length;
  const all = Object.values(tbl.data.draw || {}).filter((k) => k && k.scene === tblSceneId()).length;
  if (locked && tbl.role !== "dm") {
    return `<section class="panel"><h2>Drawing</h2>
      <p class="muted">The DM has turned drawing off for this scene.</p></section>`;
  }
  return `<section class="panel">
      <h2>Drawing</h2>
      <div class="chips">
        <button class="chip ${ink.on && ink.mode === "pen" ? "on" : ""}" data-tbl="ink-pen">Pen</button>
        <button class="chip ${ink.on && ink.mode === "erase" ? "on" : ""}" data-tbl="ink-erase">Eraser</button>
        <button class="chip ${ink.on && ink.mode === "fill" ? "on" : ""}" data-tbl="ink-bucket">Fill</button>
        <button class="chip ${ink.on ? "" : "on"}" data-tbl="ink-off">Put it away</button>
      </div>
      ${ink.on ? `<p class="muted">${ink.mode === "erase"
        ? (tbl.role === "dm" ? "Drag over anything to rub it out — as the DM you can rub out anyone's."
          : "Drag over your own lines to rub them out. Other people's are theirs.")
        : ink.mode === "fill"
        ? `Tap inside a shape you have already drawn to colour it in, and tap it again to empty it. It keeps
           its own colour${tbl.role === "dm" ? " — as the DM you can fill anyone's" : ""}.`
        : "Draw on the board with a finger or the mouse. While the pen is out, figures cannot be dragged."}</p>`
        : `<p class="muted">The pen is away, so the board drags and pans as usual.</p>`}
      ${ink.on && (ink.mode === "pen" || ink.mode === "fill") ? `
        ${ink.mode === "pen" ? `<p class="panel-sub">What to draw</p>
          <div class="chips">${TBL_INK_SHAPES.map(([k, label]) =>
            `<button class="chip ${(ink.shape || "free") === k ? "on" : ""}" data-tbl="ink-shape"
              data-val="${k}">${esc(label)}</button>`).join("")}</div>` : ""}
        ${ink.mode === "fill" || (ink.shape || "free") !== "free" ? `
          <p class="panel-sub">Inside</p>
          <div class="chips">${[["", "Empty"], ["soft", "Shaded"], ["solid", "Filled"]].map(([k, label]) =>
            `<button class="chip ${(ink.fill || "") === k ? "on" : ""}" data-tbl="ink-fill"
              data-val="${k}">${esc(label)}</button>`).join("")}</div>
          <p class="muted">Shaded lets the map read through it, for ground or a spell's reach. Filled covers
            it, for a wall or a pit.${ink.mode === "pen"
              ? " Drag from one corner to the other — it resizes under your hand and lands when you let go."
              : ""}</p>` : ""}` : ""}
      <p class="panel-sub">Colour</p>
      <div class="chips">${TBL_INK_COLOURS.map(([hex, name]) =>
        `<button class="chip ${ink.color === hex ? "on" : ""}" data-tbl="ink-color" data-val="${esc(hex)}"
          title="${esc(name)}"><span class="ink-dot" style="background:${esc(hex)}"></span>${esc(name)}</button>`).join("")}</div>
      <p class="panel-sub">Thickness</p>
      <div class="chips">${[[1, "Thin"], [2, "Medium"], [4, "Thick"]].map(([n, label]) =>
        `<button class="chip ${ink.width === n ? "on" : ""}" data-tbl="ink-width" data-val="${n}">${esc(label)}</button>`).join("")}</div>
      <div class="hp-controls">
        <button class="btn-quiet" data-tbl="ink-undo">Undo <span class="muted">Ctrl+Z</span></button>
        <button class="btn-quiet" data-tbl="ink-clear-mine" ${mine ? "" : "disabled"}>Rub out mine (${esc(mine)})</button>
        ${tbl.role === "dm" ? `<button class="btn-quiet" data-tbl="ink-clear-all" ${all ? "" : "disabled"}>Clear the scene (${esc(all)})</button>` : ""}
      </div>
      ${tbl.role === "dm" ? `<p class="panel-sub">For everyone else</p>
        <div class="chips"><button class="chip ${locked ? "on" : ""}" data-tbl="ink-lock">${
          locked ? "Drawing is off" : "Drawing is on"}</button></div>
        <p class="muted">Turning it off leaves what is already drawn; only your own pen still works.</p>` : ""}
    </section>`;
}


/* ---------------------------------------------------------------- who am I playing?
 *
 * A room code gets you in; WHO you are is chosen inside, from the figures already on the table. That is how
 * a table actually behaves: three people play, one leaves, they come back an hour later and take their own
 * figure again — no codes to keep, nothing to type twice. A figure somebody is currently holding cannot be
 * taken; one whose holder has gone quiet can.
 *
 * "Holding" is presence, not ownership on paper: a figure belongs to the browser that claimed it, and a
 * browser that is not answering has plainly left. */
function tblHeldBy(token) {
  const owner = token && token.owner;
  if (!owner) return null;
  const who = (tbl.data.presence || {})[owner];
  const fresh = who && Date.now() - (Number(who.at) || 0) < 60000;
  return fresh ? { id: owner, name: who.name || "someone" } : null;
}

function seatPanelHTML() {
  const scene = tblSceneId();
  if (tblRepoMaps === null) tblLoadRepoMaps();   // so "one from the repo" can appear without a second visit
  const rows = Object.entries(tblTokens())
    .filter(([, t]) => t && t.kind !== "npc")
    .sort((a, b) => String(a[1].name || "").localeCompare(String(b[1].name || "")))
    .map(([id, t]) => {
      const held = tblHeldBy(t);
      const mine = tblIsMine(t);
      return `<div class="scene-row ${mine ? "on" : ""}">
        <button class="scene-pick" data-tbl="seat-take" data-val="${esc(id)}" ${held && !mine ? "disabled" : ""}>
          <strong>${esc(t.name || "Someone")}</strong>
          <span class="muted">${mine ? "yours" : held ? held.name + " is playing this one" : "free to take"}</span>
        </button>
      </div>`;
    }).join("");
  return `<section class="panel">
      <h2>Who are you playing?</h2>
      ${rows ? `<p class="muted">Take one of these, or add a new one below. Somebody else's is greyed out
        while they are here.</p><div class="scene-list">${rows}</div>`
        : `<p class="muted">Nobody is on the board yet. Add yourself.</p>`}
    </section>
    <section class="panel">
      <p class="panel-sub">Add a new character</p>
      <label class="field"><span>Name</span>
        <input id="seat-name" class="text" type="text" maxlength="40" placeholder="Greta the Bold" /></label>
      <label class="field"><span>Circus of Chaos code <span class="muted">optional</span></span>
        <input id="seat-code" class="text code-input" type="text" inputmode="numeric" maxlength="6"
          placeholder="123456" autocomplete="off" /></label>
      <!-- A Circus of Chaos character already HAS a picture: the one on its sheet, which is the one that
           follows it everywhere. Offering a second one here is offering to disagree with the sheet, so
           the whole block folds away the moment a code is typed. -->
      <div id="seat-pic-block">
        <label class="field"><span>Their picture <span class="muted">from this device, optional</span></span>
          <input id="seat-file" class="text" type="file" accept="image/*" /></label>
        ${tblRepoMaps && tblRepoMaps.length ? `<p class="panel-sub">Or one from the repo</p>
          <div class="chips">${tblRepoMaps.map((f) =>
            `<button class="chip ${tbl.ui.seatPic === "maps/" + f ? "on" : ""}" data-tbl="seat-pic"
              data-val="${esc(f)}">${esc(f)}</button>`).join("")}</div>` : ""}
      </div>
      <p id="seat-pic-note" class="muted hidden">Their picture comes from the sheet.</p>
      <p id="seat-pic-msg" class="save-msg"></p>
      <button class="btn" data-tbl="seat-new">Put them on the board</button>
      <p id="seat-msg" class="save-msg"></p>
      <p class="muted">With a code you get the real sheet and every number on it becomes a die you can
        throw. Without one you get a figure and the tracker, which is all you need for any other system.
        ${esc(scene ? "" : "")}</p>
    </section>`;
}

/* Taking a figure: it becomes mine, and I become whoever it is. */
async function tblTakeSeat(id) {
  const t = tblTokens()[id];
  if (!t) return;
  const held = tblHeldBy(t);
  if (held && held.id !== tbl.me.clientId) return;
  tbl.me.charCode = t.charCode || "";
  tbl.me.name = t.name || "Someone";
  tbl.me.tokenId = id;
  tbl.me.left = false;
  tblSaveMe(tbl.code, { clientId: tbl.me.clientId, name: tbl.me.name, charCode: tbl.me.charCode });
  await CocLive.patch(tblPath("tokens/" + id), { owner: tbl.me.clientId });
  tblAnnounce();
  tbl.ui.panel = "";
  paintSide();
  paintHeader();
  paintBar();     // "Choose a character" goes, "My sheet" arrives if the code brought one
}

async function tblNewSeat() {
  const msg = $("#seat-msg");
  const say = (t, bad) => { if (msg) { msg.textContent = t; msg.className = "save-msg" + (bad ? " bad" : ""); } };
  const name = String(($("#seat-name") || {}).value || "").trim().slice(0, 40);
  const code = String(($("#seat-code") || {}).value || "").replace(/\D/g, "");
  if (code && !CocStore.validCode(code)) return say("A Circus of Chaos code is six digits, or leave it empty.", true);
  let ch = null;
  if (code) {
    say("Fetching the sheet…");
    try { ch = await CocStore.load(code); } catch (err) { return say(err.message, true); }
    if (!ch) return say("No character is saved under " + code + ".", true);
  }
  const finalName = (ch && ch.name) || name;
  if (!finalName) return say("Give them a name.", true);
  const d = (ch && typeof derive === "function") ? derive(ch) : null;
  const spot = tblFreeSquare("", 1, 1, 1, 1, 1);
  const id = CocLive.newId();
  // A picture chosen on this form, a portrait from the sheet, or nothing — in that order, because the one
  // just chosen is the more deliberate.
  await CocLive.put(tblPath("tokens/" + id), {
    name: String(finalName).slice(0, 40),
    charCode: code || "",
    owner: tbl.me.clientId,
    image: tbl.ui.seatPic || (ch && ch.photo) || "",
    x: spot.x, y: spot.y, size: 1, kind: "pc", shape: "square",
    initMod: d ? (d.mods.Dexterity || 0) : 0,
    hp: d ? (ch.play && ch.play.hp != null ? ch.play.hp : d.hpMax) : 0,
    hpMax: d ? d.hpMax : 0,
    speed: 30, color: "#c9a54e",
  });
  tbl.ui.seatPic = "";
  await tblTakeSeat(id);
}


/* ---------------------------------------------------------------- the tracker
 *
 * A place to keep a character that is not one of ours. Everything in Circus of Chaos has a real sheet the
 * app understands; a D&D player, or somebody playing a system this app has never heard of, has numbers they
 * still need in front of them — and until now the only thing they could keep at the table was a figure with
 * hit points on it.
 *
 * So: a name, a line to say what they are, the four numbers everybody has, and then AS MANY named fields as
 * they like. Deliberately not a schema — the whole point is that it does not know what game you are playing,
 * so "Ki points 4" and "Sorcery 3" are the same kind of thing to it. Notes at the bottom.
 *
 * Kept per person, keyed the same way notes are, so it follows a character code between devices and a
 * browser for a guest. The DM can read a player's, because the DM asking "how many hit points have you got"
 * is the question this is meant to save. */
function tblTrackerKeyFor(t) {
  if (!t) return "";
  if (t.charCode) return "pc:" + t.charCode;
  return t.owner ? "browser:" + t.owner : "";
}
function tblTracker(key) {
  return (tbl.data.sheets || {})[key || tblNoteOwner()] || {};
}
/* ALL the rows, including the empty one you just asked for. The first version filtered empties out here,
   which is why "Add a field" appeared to do nothing at all: it wrote a blank row and the renderer
   immediately hid it again. Empties are dropped when they are READ BY SOMEBODY ELSE (see trackerReadHTML),
   not when their owner is halfway through typing one. */
function tblTrackerFields(sheet) {
  return Array.isArray(sheet.fields) ? sheet.fields.filter((f) => f && typeof f === "object") : [];
}

function trackerHTML() {
  const sheet = tblTracker();
  const fields = tblTrackerFields(sheet);
  const myToken = tblMyTokens()[0] || "";
  const num = (id, label, value) => `<label class="field"><span>${esc(label)}</span>
    <input id="${id}" class="num" type="number" value="${esc(value == null ? "" : value)}" /></label>`;
  return `<section class="panel">
      <h2>Your character</h2>
      <p class="muted">For a character this app does not know — any system, or none. Saved as you type and
        kept with the table, so it is here on your next device. If you have a Circus of Chaos character
        instead, <strong>My sheet</strong> is the real thing and this is just somewhere to jot extras.</p>
      <label class="field"><span>Name</span>
        <input id="trk-name" class="text" type="text" maxlength="40" value="${esc(sheet.name || "")}" /></label>
      <label class="field"><span>What you are</span>
        <input id="trk-line" class="text" type="text" maxlength="60" placeholder="Level 4 half-orc barbarian"
          value="${esc(sheet.line || "")}" /></label>
      <div class="grid-row">
        ${num("trk-hp", "Hit points", sheet.hp)}
        ${num("trk-hpmax", "Out of", sheet.hpMax)}
        ${num("trk-ac", "AC", sheet.ac)}
      </div>
      <div class="grid-row">
        ${num("trk-init", "Initiative", sheet.init)}
        ${num("trk-speed", "Speed (ft)", sheet.speed)}
      </div>
      ${/* ANY figure you are holding, with or without a Circus of Chaos code behind it. This panel IS
            the sheet for a character the app does not know — a level 4 blood hunter from somebody
            else's system — and gating its picture on having one of OUR codes meant the people who need
            this panel most were the only ones who could not use it. That was the whole bug, five
            reports long: the control was there for players with a code, and this panel is for players
            without one. */""}
      ${myToken ? `<p class="panel-sub">Your picture</p>
        ${tokenImageHTML("mine", (tblTokens()[myToken] || {}).image)}
        <p class="muted">${tbl.me.charCode
          ? "It goes on your character, so it is on your figure here and on your sheet everywhere else."
          : "It goes on your figure at this table."} Yours alone — nobody else can change it.</p>` : ""}
      ${myToken ? `<div class="hp-controls">
        <input id="trk-amt" class="num" type="number" min="1" value="1" />
        <button class="btn-quiet" data-tbl="trk-hp" data-val="-1">Damage</button>
        <button class="btn-quiet" data-tbl="trk-hp" data-val="1">Heal</button>
        <span class="muted">your figure follows these</span>
      </div>` : ""}
    </section>
    <section class="panel">
      <p class="panel-sub">Anything else you track</p>
      <div class="trk-fields">${fields.map((f, i) => `<div class="trk-row">
        <input id="trk-k-${i}" class="text" type="text" maxlength="24" placeholder="Ki points" value="${esc(f.k || "")}" />
        <input id="trk-v-${i}" class="text trk-val" type="text" maxlength="24" placeholder="4" value="${esc(f.v || "")}" />
        <button class="btn-quiet" data-tbl="trk-drop" data-val="${i}">&times;</button>
      </div>`).join("")}</div>
      <button class="btn-quiet" data-tbl="trk-add">Add something to track</button>
      <p class="muted">A name and a number, whatever they are: <em>Ki points 4</em>, <em>Rage 2</em>,
        <em>Arrows 17</em>, <em>Owed to Vex 300gp</em>. This app has no idea what game you are playing, which
        is the point — anything you would otherwise write on your hand goes here, and the DM can read it.</p>
    </section>
    <section class="panel">
      <p class="panel-sub">Notes on your character</p>
      <textarea id="trk-notes" class="text notes-body" rows="6" maxlength="4000">${esc(sheet.notes || "")}</textarea>
      ${myToken ? `<p class="panel-sub">Leaving</p>
        <button class="btn-quiet" data-tbl="mine-remove" data-val="${esc(myToken)}">Take my figure off the table</button>`
        : `<p class="muted">You have no figure on the board — the DM can place one, or rejoin to get one.</p>`}
    </section>`;
}

/* What the DM sees of a player's tracker: read-only, because it is theirs. */
function trackerReadHTML(key) {
  const sheet = tblTracker(key);
  if (!sheet || !Object.keys(sheet).length) return "";
  // Somebody else's view skips the blanks — a half-typed row is nobody's business but its owner's.
  const fields = tblTrackerFields(sheet).filter((f) => f.k || f.v);
  const bit = (label, v) => (v === "" || v == null) ? "" : `<span class="trk-read"><em>${esc(label)}</em> ${esc(v)}</span>`;
  return `<p class="panel-sub">What they are tracking</p>
    <p class="trk-reads">
      ${bit("HP", sheet.hpMax ? `${sheet.hp == null ? "?" : sheet.hp}/${sheet.hpMax}` : sheet.hp)}
      ${bit("AC", sheet.ac)}${bit("Init", sheet.init)}${bit("Speed", sheet.speed)}
      ${fields.map((f) => bit(f.k || "—", f.v)).join("")}
    </p>
    ${sheet.line ? `<p class="muted">${esc(sheet.line)}</p>` : ""}`;
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

/* Getting a picture onto a FIGURE. Three ways for the same reason the maps have four: Kayki's players
   could only paste a direct link, and half the links people find are not direct — they are a page with an
   image on it, or a host that refuses to be hotlinked. A photo off the phone always works.
   `who` is the field id prefix, so the DM's editor and a player's own figure share all of this. */
function tokenImageHTML(who, current) {
  const repo = tblRepoMaps;
  if (repo === null) tblLoadRepoMaps();
  return `<p class="panel-sub">Picture</p>
    ${current ? `<img class="figure-art figure-thumb" src="${esc(current)}" alt="" />` : ""}
    <label class="field"><span>From this device</span>
      <input id="${who}-file" class="text" type="file" accept="image/*" /></label>
    <p id="${who}-imgmsg" class="save-msg"></p>
    ${repo && repo.length ? `<p class="panel-sub">Or from the repo</p>
      <div class="chips">${repo.map((f) =>
        `<button class="chip" data-tbl="${who}-repo" data-val="${esc(f)}">${esc(f)}</button>`).join("")}</div>` : ""}
    <label class="field"><span>Or a link</span>
      <input id="${who}-img" class="text" type="text" value="${esc(current || "")}" /></label>`;
}

/* One place that writes a figure's picture, whoever asked. */
function tblSetTokenImage(id, image) {
  const t = tblTokens()[id];
  if (!t) return;
  if (tbl.role !== "dm" && !tblIsMine(t)) return;
  tblTokenField(id, "image", image || "").catch(tblFail);
  /* If this figure IS a character, the character is where its face belongs — otherwise the picture holds
     until the next time that sheet saves and then reverts to whatever the sheet still has. A player owns
     their own character completely, so changing it here changes it everywhere: on the board, on the
     sheet, and in the next session. Only ever their own — `tblIsMine` above is the whole guard, and a
     creature has no code to write to. */
  if (t.charCode && (tblIsMine(t) || tbl.role === "dm")) tblSetCharacterPhoto(t.charCode, image || "");
}

/* Write a picture onto the CHARACTER behind a figure, wherever that character lives. Read-modify-write,
   because a sheet is one document and this must not clear the rest of it. */
async function tblSetCharacterPhoto(code, image) {
  try {
    // The open sheet is the live copy; writing underneath it would be overwritten by its next save.
    if (typeof sheet !== "undefined" && sheet && sheet.code === code) {
      sheet.ch.photo = image;
      if (typeof renderSheet === "function" && tbl && tbl.ui.panel === "sheet") renderSheet();
    }
    const ch = await CocStore.load(code);
    if (!ch) return;
    ch.photo = image;
    await CocStore.save(code, ch);
  } catch { /* a code that no longer opens anything is not this button's problem */ }
}

/* A photo off the phone, shrunk to something a token can carry. */
function tblUploadTokenImage(id, input, msgId) {
  const msg = document.getElementById(msgId);
  const say = (t, bad) => { if (msg) { msg.textContent = t; msg.className = "save-msg" + (bad ? " bad" : ""); } };
  const file = input && input.files && input.files[0];
  if (!file) return;
  say("Shrinking it…");
  tblShrinkImage(file, (data) => {
    tblSetTokenImage(id, data);
    say("Done.");
  }, (why) => say(why, true), TBL_TOKEN_IMAGE);
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



/* WHAT YOU ARE ABOUT TO PUT DOWN, said out loud. A mode with no visible state is a mode nobody can get
   out of — and this one swallows the next tap on the board, so it has to announce itself and it has to
   offer a way out. [[present-is-not-findable]] */
function paintPlacing() {
  const bar = $("#vtt-placing");
  if (!bar) return;
  const p = tbl.placing;
  bar.classList.toggle("hidden", !p);
  if (!p) { bar.innerHTML = ""; return; }
  // What it will catch, before it catches it — the same count the log gets afterwards, so nobody has to
  // place it to find out.
  const caught = p.aimed
    ? tblInsideArea({ x: p.x, y: p.y, shape: p.shape, size: p.size })
        .map((id) => (tblTokens()[id] || {}).name || "someone")
    : [];
  bar.innerHTML = `<strong>${esc(p.name)}</strong>
    <span class="muted">${esc(p.size)} ft ${p.shape === "cube" ? "cube" : "radius"}${
      p.range ? " · within " + esc(p.range) + " ft" : ""}${
      p.rounds ? " · " + esc(p.rounds) + " rounds" : ""}</span>
    ${p.aimed
      ? `<strong class="turn-who">${caught.length
          ? "Catches " + esc(caught.join(", ")) : "Catches nobody"}</strong>`
      : `<strong class="turn-who">Tap the board to aim it</strong>`}
    <span class="turn-acts">
      ${p.aimed ? `<button class="btn" data-tbl="place-go">Place it here</button>` : ""}
      <button class="btn-quiet" data-tbl="place-cancel">Cancel</button>
    </span>`;
}


/* A DELETED CHARACTER LEAVES THE TABLES IT WAS STANDING ON.
 *
 * Deleting a character is not the character dying — Kayki's distinction, and it is the right one. A dead
 * character's figure stays on the board because a body is a thing at the table; a deleted one never
 * existed, and leaving its figure behind meant he had to log in as the DM to sweep up, and then could not
 * seat the replacement because this browser was still introducing itself with the dead code.
 *
 * Every table this device has sat at is checked — that is the honest limit of what one browser can know.
 * A figure somebody ELSE placed at a table this device has never opened is still the DM's to remove.
 */
async function tblDropCharacterEverywhere(code) {
  if (!code) return;
  for (const row of tblRecent()) {
    const at = "tables/" + row.code;
    try {
      const tokens = await CocLive.get(at + "/tokens");
      for (const [id, t] of Object.entries(tokens || {})) {
        if (t && t.charCode === code) await CocLive.put(at + "/tokens/" + id, null);
      }
    } catch { /* a table that has gone is a table with nothing to clean */ }
    // And stop this browser introducing itself as the character that no longer exists.
    const me = tblMe(row.code);
    if (me && me.charCode === code) {
      tblSaveMe(row.code, { clientId: me.clientId, name: "", charCode: "" });
    }
  }
  // If it is the one on screen, let go of it here too rather than waiting for a reload.
  if (tbl && tbl.me.charCode === code) {
    tbl.me.charCode = "";
    tbl.me.name = "";
    tbl.me.left = false;      // you did not walk out; the character stopped existing
    if (typeof paintBar === "function") { paintBar(); paintHeader(); paintSide(); }
  }
}


/* THE DM'S FIGHT IS THE FIGHT.
 *
 * A sheet used to keep its own private idea of whether combat was on, behind a button on itself — so the
 * engine sat dead and every pip greyed out while the order bar was running at the top of the same screen,
 * and Kayki reasonably reported the engine as broken. It was gated, not broken, on a switch nobody had
 * told him about. The other half of the same fault was a trick flipping that switch on when the DM had
 * not started anything.
 *
 * So at a table it follows the order: the fight starts and every open sheet is in combat, the fight ends
 * and they all clear down — cooldowns, once-per-combat, the engine, the lot, through the same transition
 * the button always used. Away from a table the button is still the only thing that says. */
function tblSyncSheetCombat() {
  if (typeof syncCombatFromTable !== "function") return;
  const turn = (tbl.data.meta || {}).turn;
  const fighting = !!(turn && Array.isArray(turn.order) && turn.order.length);
  if (!syncCombatFromTable(fighting)) return;
  if (typeof renderSheet === "function") renderSheet();
  if (typeof persist === "function") persist();
}
