/*
 * Circus of Chaos — the board itself
 *
 * The map, the grid, the camera and every gesture that lands on them: dragging a figure, panning, pinching,
 * the ruler, and the ink. This is the half of the table that a hand touches, which is also the half where
 * every hard bug has been — so it lives on its own, and the browser's own gestures are its first suspect.
 *
 * Part of the table. These files are plain scripts sharing one global scope on purpose: there is no bundler
 * and no build step, so `table.js` loads last and everything it calls is already defined. Split by what a
 * change tends to touch — see RULES.md.
 */

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
  /* The grid is drawn from the SCENE, not from a fixed stylesheet rule, because it is a tool now: a map
     that came without one needs a grid laid over it, and a map that came with one printed needs ours
     turned off rather than doubled. Light lines read on dark art, dark lines on parchment; bold survives
     being zoomed out; the offset exists to line ours up with a grid already in the picture. */
  const on = scene.gridOn !== false;
  const wide = scene.gridBold ? 2 : 1;
  const line = scene.gridDark ? "rgba(0,0,0,0.55)" : "rgba(233,228,218,0.30)";
  grid.style.display = on ? "" : "none";
  grid.style.backgroundSize = `${cell}px ${cell}px`;
  grid.style.backgroundImage =
    `linear-gradient(to right, ${line} ${wide}px, transparent ${wide}px),` +
    `linear-gradient(to bottom, ${line} ${wide}px, transparent ${wide}px)`;
  // Tenths of a square, so a nudge is a nudge rather than a jump.
  const offX = ((Number(scene.gridOffX) || 0) / 10) * cell;
  const offY = ((Number(scene.gridOffY) || 0) / 10) * cell;
  grid.style.backgroundPosition = `${offX}px ${offY}px`;
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
  paintPeek();
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
  tblTrace("zoom", factor.toFixed(2) + (tbl.drag ? " during a drag" : ""));
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
  paintPeek();
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
  // Belt and braces for the same bug: if the browser tries to start a drag of the map or a figure anyway,
  // refuse it. One line, and it costs nothing.
  stage.addEventListener("dragstart", (e) => e.preventDefault());
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
    const node = evTarget(e).closest("[data-token]");
    if (node) tblOpenToken(node.dataset.token);
  });
  /* A single tap on a figure opens its card beside it — what the double tap was being used for, without the
     guesswork. A tap on the board itself puts the card away. `click` rather than pointerup, so a drag that
     happens to end on a figure does not open anything. */
  stage.addEventListener("click", (e) => {
    if (!tbl || (tbl.ui.ink && tbl.ui.ink.on)) return;    // the pen owns the board while it is out
    const node = evTarget(e).closest("[data-token]");
    const id = node && node.dataset.token;
    tbl.ui.peek = id && tbl.ui.peek !== id ? id : "";
    paintPeek();
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

/* Tapping a figure opens it WHERE IT IS.
 *
 * The details used to open in the side panel — beside the board on a desktop, below it on a phone — so
 * "it opened" and "you can see that it opened" were two different things, and Kayki tapped a creature and
 * watched nothing happen. This is a small card pinned next to the figure itself: what it is, how hurt it is
 * if you are allowed to know, what it is suffering from, how far it moves. The DM gets one more tap to the
 * full editor; everyone else gets what they are entitled to and nothing more.
 *
 * It lives in the STAGE rather than in the world, so it stays a readable size at any zoom. */
function paintPeek() {
  const host = $("#vtt-peek");
  if (!host) return;
  if (tbl.ui.peekArea) { paintAreaPeek(host); return; }
  const id = tbl.ui.peek;
  const t = id ? tblTokens()[id] : null;
  if (!t) { host.classList.add("hidden"); host.innerHTML = ""; return; }
  const scene = tblScene();
  const cell = Number(scene.cell) || 70;
  const size = Math.max(1, Number(t.size) || 1);
  // Anchored to the figure's own top-right corner, in stage coordinates.
  const sx = tbl.view.x + ((Number(t.x) || 0) + size) * cell * tbl.view.z;
  const sy = tbl.view.y + (Number(t.y) || 0) * cell * tbl.view.z;
  const showHp = tbl.role === "dm" || tblIsMine(t);
  const conds = Array.isArray(t.conditions) ? t.conditions : [];
  const pct = t.hpMax ? Math.max(0, Math.min(100, Math.round((Number(t.hp) || 0) / t.hpMax * 100))) : 0;
  host.classList.remove("hidden");
  host.innerHTML = `<div class="peek-head">
      <strong>${esc(t.name || "Figure")}</strong>
      <button class="btn-quiet" data-tbl="peek-close">&times;</button>
    </div>
    ${showHp && t.hpMax ? `<div class="peek-hp">
        <span class="tok-bar ${pct <= 25 ? "low" : pct <= 60 ? "half" : ""}"><span style="width:${pct}%"></span></span>
        <span>${esc(t.hp)}/${esc(t.hpMax)}</span></div>`
      : t.hpMax ? `<p class="muted">How hurt it is, is the DM's to know.</p>` : ""}
    ${conds.length ? `<div class="chips">${conds.map((c) =>
      `<span class="chip on">${esc(TBL_CONDITION_NAMES[c] || c)}</span>`).join("")}</div>`
      : `<p class="muted">Nothing wrong with it.</p>`}
    <p class="peek-foot">${esc(Number(t.speed) || 30)} ft${size > 1 ? ` &middot; ${esc(size)} squares` : ""}</p>
    ${tbl.role === "dm"
      ? `<button class="btn-quiet" data-tbl="peek-edit" data-val="${esc(id)}">Edit this figure</button>`
      /* Your own figure, both things you can do to it. Taking it off used to live in the tracker panel,
         which a player holding a Circus of Chaos character no longer sees — so a character with a real
         sheet had no way off the board at all, and Kayki had to log in as the DM to remove one. It
         belongs here anyway: this card is what opens when you tap yourself. */
      : tblIsMine(t) ? `<button class="btn-quiet" data-tbl="panel" data-val="${tbl.me.charCode ? "sheet" : "mine"}">Open ${tbl.me.charCode ? "my sheet" : "my character"}</button>
        <button class="btn-quiet" data-tbl="mine-remove" data-val="${esc(id)}">Take it off the table</button>` : ""}`;
  tblFitPeek(host, sx, sy);
}

/* AN AREA'S CARD, the same card a figure gets: what it is, how long it has left, who is standing in it,
   and — for whoever put it there, and for the DM — the way to take it away. */
function paintAreaPeek(host) {
  const id = tbl.ui.peekArea;
  const a = (tbl.data.areas || {})[id];
  if (!a) { tbl.ui.peekArea = ""; host.classList.add("hidden"); host.innerHTML = ""; return; }
  const scene = tblScene();
  const cell = Number(scene.cell) || 70;
  const half = tblSquares(a.size) / 2;
  const sx = tbl.view.x + (a.x + half) * cell * tbl.view.z;
  const sy = tbl.view.y + (a.y - half) * cell * tbl.view.z;
  const inside = tblInsideArea(a).map((tid) => (tblTokens()[tid] || {}).name || "someone");
  host.classList.remove("hidden");
  host.innerHTML = `<div class="peek-head">
      <strong>${esc(a.name || "Area")}</strong>
      <button class="btn-quiet" data-tbl="peek-close">&times;</button>
    </div>
    <p class="peek-foot">${esc(a.size)} ft ${a.shape === "cube" ? "cube" : "radius"}${
      areaLeftText(a)}</p>
    <p class="muted">${inside.length ? "Inside: " + esc(inside.join(", ")) : "Nobody is inside it."}</p>
    ${tblCanClearArea(a)
      ? `<button class="btn-quiet" data-tbl="area-clear" data-val="${esc(id)}">Remove it</button>`
      : `<p class="muted">Whoever cast it can take it away, and so can the DM.</p>`}`;
  tblFitPeek(host, sx, sy);
}

/* KEEP THE CARD ON THE BOARD. It is pinned beside the thing it describes, and the stage clips whatever
   leaves it — so a figure near the right-hand edge got a card with its right half cut off, which on a
   phone is most of the figures. Kayki photographed it twice. Put it on the other side when there is no
   room on this one, and clamp it either way. */
function tblFitPeek(host, sx, sy) {
  const stage = $("#vtt-stage");
  if (!stage || !host.getBoundingClientRect) return;
  const box = stage.getBoundingClientRect();
  if (!box.width) return;
  host.style.left = "0px";
  host.style.top = "0px";
  const card = host.getBoundingClientRect();
  const pad = 8;
  let left = sx + pad;
  if (left + card.width > box.width - pad) left = sx - card.width - pad;   // flip to the other side
  left = Math.max(pad, Math.min(left, box.width - card.width - pad));
  const top = Math.max(pad, Math.min(sy, box.height - card.height - pad));
  host.style.left = Math.round(left) + "px";
  host.style.top = Math.round(top) + "px";
}

/* Where a point on the stage falls on the PICTURE, as a fraction of it. */
function tblInkPoint(p) {
  const scene = tblScene();
  const cell = Number(scene.cell) || 70;
  const w = (Number(scene.cols) || 30) * cell, h = (Number(scene.rows) || 20) * cell;
  const at = toSquares(p.sx, p.sy);
  return { x: Math.max(0, Math.min(1, (at.x * cell) / w)), y: Math.max(0, Math.min(1, (at.y * cell) / h)) };
}

/* The eraser: whatever of MINE is under the point goes. The DM may rub out anybody's, which is the whole
   difference between an eraser and a moderation tool. */
/* The eraser works ON A COPY and writes once, when the hand comes up.
 *
 * The first version wrote as it went: every pointermove deleted the strokes it touched and pushed their
 * surviving pieces, and the next move then cut THOSE — so a single drag multiplied one line into dozens,
 * each cut costing a delete, several pushes and a full repaint. It erased for about two seconds, saturated
 * the browser's handful of connections to the database, and froze the page. Kayki reported exactly that.
 *
 * So: rubbing edits `tbl.erasing`, which the board draws instead of the stored strokes, and only pointerup
 * turns it into writes — at most one delete and a few pushes per stroke, however long the drag. */
const TBL_ERASE_MAX_PIECES = 8;

/* What Ctrl+Z takes back. Only ever MY OWN actions, in this session: drawing a stroke, or one sweep of the
   eraser. Kept in memory rather than in the table — an undo history is a fact about the hand that made the
   marks, not about the board, and the last thing anybody wants is one player undoing another's work. */
const TBL_UNDO = [];
const TBL_UNDO_MAX = 25;
function tblUndoPush(step) {
  TBL_UNDO.push(step);
  while (TBL_UNDO.length > TBL_UNDO_MAX) TBL_UNDO.shift();
}

/* Ctrl+Z / Cmd+Z. An added stroke is deleted; an erase is put back exactly as it was, which means deleting
   the pieces it left and restoring the originals it cut. */
async function tblUndoInk() {
  const step = TBL_UNDO.pop();
  if (!step) return false;
  if (step.kind === "add") {
    await CocLive.del(tblPath("draw/" + step.id)).catch(() => {});
    return true;
  }
  if (step.kind === "erase") {
    for (const id of step.added) await CocLive.del(tblPath("draw/" + id)).catch(() => {});
    for (const [id, stroke] of step.removed) await CocLive.put(tblPath("draw/" + id), stroke).catch(() => {});
    return true;
  }
  return false;
}

function tblEraseAt(at) {
  const sceneId = tblSceneId();
  const mine = tblNoteOwner();
  const near = 0.012;
  if (!tbl.erasing) tbl.erasing = new Map();     // stroke id -> surviving pieces (empty means it is gone)
  let changed = false;
  for (const [id, k] of Object.entries(tbl.data.draw || {})) {
    if (!k || k.scene !== sceneId) continue;
    if (tbl.role !== "dm" && k.by !== mine) continue;

    // Once a stroke is being rubbed, work on what is LEFT of it rather than on the stored original.
    const already = tbl.erasing.has(id);
    const source = already ? tbl.erasing.get(id) : [tblInkDecode(k.pts)];
    if (already && !source.length) continue;       // nothing left to rub
    if (!source.length || !source[0].length) continue;

    /* A SHAPE goes whole. There is no sensible half of a rectangle, and every drawing program agrees: you
       touch it, it goes. A FILLED one counts as touched anywhere inside it, because that is what it is. */
    if (k.kind && k.kind !== "free") {
      if (tblInkTouches(source[0], k.kind, at, near, k.fill)) { tbl.erasing.set(id, []); changed = true; }
      continue;
    }

    /* FREEHAND is rubbed, not deleted — which is what an eraser is. The points under it are dropped and what
       survives stays in pieces, so rubbing through the middle of a line leaves two lines. */
    const pieces = [];
    for (const run of source) {
      let piece = [];
      for (const p of run) {
        if (Math.hypot(p.x - at.x, p.y - at.y) >= near) piece.push(p);
        else if (piece.length) { pieces.push(piece); piece = []; }
      }
      if (piece.length) pieces.push(piece);
    }
    const kept = pieces.filter((p) => p.length >= 2);
    const before = source.reduce((n, r) => n + r.length, 0);
    const after = kept.reduce((n, r) => n + r.length, 0);
    if (after === before) continue;                 // the eraser is not over this stroke
    // Rubbed into confetti: nobody is going to miss the crumbs, and eight pieces is already generous.
    tbl.erasing.set(id, kept.length > TBL_ERASE_MAX_PIECES ? [] : kept);
    changed = true;
  }
  if (changed) paintDrawings();
}

/* The hand came up: turn what was rubbed into writes. One delete per stroke, plus whatever survived. */
function tblEraseCommit() {
  if (!tbl.erasing || !tbl.erasing.size) { tbl.erasing = null; return; }
  const strokes = tbl.data.draw || {};
  const step = { kind: "erase", removed: [], added: [] };
  const writes = [];
  const overlay = tbl.erasing;
  for (const [id, pieces] of overlay) {
    const k = strokes[id];
    if (!k) continue;
    // Kept whole, so Ctrl+Z can put the line back exactly as it was rather than approximately.
    step.removed.push([id, JSON.parse(JSON.stringify(k))]);
    CocLive.del(tblPath("draw/" + id)).catch(() => {});
    for (const piece of pieces) {
      if (piece.length < 2) continue;
      writes.push(CocLive.push(tblPath("draw"), {
        by: k.by, scene: k.scene, color: k.color, width: k.width, kind: "free", fill: k.fill || false,
        pts: tblInkEncode(piece), at: k.at || Date.now(),
      }).then((newId) => { step.added.push(newId); tbl.inkNew.add(newId); }).catch(() => {}));
    }
  }
  /* The rub stops accepting new strokes but KEEPS BEING DRAWN, because sending a delete is not the same as
     the delete having happened. Dropping the overlay here — which is what the first version did — meant the
     board went back to the stored, still-whole line the moment the hand came up, and the erasure only
     reappeared when the database echoed the change back seconds later. Exactly what Kayki saw: it erases, it
     comes back, and then it "magically" vanishes.
     paintDrawings clears this by itself, once the stored data agrees with it. */
  tbl.erasing = null;
  tbl.inkPending = overlay;
  Promise.all(writes).then(() => { if (step.removed.length) tblUndoPush(step); paintDrawings(); });
  paintDrawings();
}

/* The paint bucket: fill in something already on the board, which is how anybody actually draws — the
 * square goes down first and the colour goes in afterwards, once you know what it turned out to be.
 *
 * The topmost shape under the finger wins, newest first, which is the order they are drawn in: with two
 * boxes overlapping you mean the one you can see. Filling obeys the same rule as rubbing out — your own
 * work, or anybody's if you are the DM — and tapping a shape that is ALREADY filled the way you are
 * filling takes the fill back out, so the bucket is its own undo. */
function tblFillAt(at) {
  const sceneId = tblSceneId();
  const mine = tblNoteOwner();
  const near = 0.012;
  const level = tblInkState().fill === "solid" ? "solid" : "soft";
  const hits = Object.entries(tbl.data.draw || {})
    .filter(([, k]) => k && k.scene === sceneId && (tbl.role === "dm" || k.by === mine))
    .sort((a, b) => (b[1].at || 0) - (a[1].at || 0));
  for (const [id, k] of hits) {
    const pts = tblInkDecode(k.pts);
    if (!pts.length) continue;
    // A shape is filled through its INSIDE, so it is hit-tested as though it were already filled — you
    // should not have to find the outline of an empty box to colour it in.
    const kind = k.kind || "free";
    if (kind === "line") continue;                       // a line has no inside to fill
    if (!tblInkTouches(pts, kind, at, near, true)) continue;
    const next = k.fill === level ? null : level;
    CocLive.put(tblPath("draw/" + id + "/fill"), next).catch(tblFail);
    tblTrace("ink fill", id + " " + (next || "emptied"));
    return true;
  }
  return false;
}

/* Is the eraser over this shape's outline (or, for a box, its edge)? */
function tblInkTouches(pts, kind, at, near, filled) {
  const seg = (a, b) => {
    const dx = b.x - a.x, dy = b.y - a.y;
    const len = dx * dx + dy * dy;
    if (!len) return Math.hypot(a.x - at.x, a.y - at.y);
    const t = Math.max(0, Math.min(1, ((at.x - a.x) * dx + (at.y - a.y) * dy) / len));
    return Math.hypot(a.x + t * dx - at.x, a.y + t * dy - at.y);
  };
  const a = pts[0], b = pts[1] || pts[0];
  if (kind === "line") return seg(a, b) < near;
  if (filled) {
    // A filled shape IS its inside, so touching anywhere in it counts. A freehand loop has an inside
    // too — count the times a ray leaving the point crosses the line, and an odd number means in.
    if (kind === "free") {
      let inside = false;
      for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
        const p = pts[i], q = pts[j];
        if ((p.y > at.y) !== (q.y > at.y)
          && at.x < ((q.x - p.x) * (at.y - p.y)) / ((q.y - p.y) || 1e-9) + p.x) inside = !inside;
      }
      return inside;
    }
    const x1 = Math.min(a.x, b.x), x2 = Math.max(a.x, b.x);
    const y1 = Math.min(a.y, b.y), y2 = Math.max(a.y, b.y);
    if (kind === "rect") return at.x >= x1 - near && at.x <= x2 + near && at.y >= y1 - near && at.y <= y2 + near;
    if (kind === "circle") {
      const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
      const rx = Math.abs(b.x - a.x) / 2 || near, ry = Math.abs(b.y - a.y) / 2 || near;
      return Math.hypot((at.x - cx) / rx, (at.y - cy) / ry) <= 1 + near;
    }
  }
  if (kind === "rect") {
    const x1 = Math.min(a.x, b.x), x2 = Math.max(a.x, b.x);
    const y1 = Math.min(a.y, b.y), y2 = Math.max(a.y, b.y);
    const corners = [{ x: x1, y: y1 }, { x: x2, y: y1 }, { x: x2, y: y2 }, { x: x1, y: y2 }];
    return corners.some((c, i) => seg(c, corners[(i + 1) % 4]) < near);
  }
  if (kind === "circle") {
    const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
    const rx = Math.abs(b.x - a.x) / 2, ry = Math.abs(b.y - a.y) / 2;
    if (!rx || !ry) return Math.hypot(cx - at.x, cy - at.y) < near;
    // How far the point is from the ellipse, near enough for an eraser's purposes.
    const d = Math.hypot((at.x - cx) / rx, (at.y - cy) / ry);
    return Math.abs(d - 1) < near / Math.min(rx, ry);
  }
  return false;
}

/* Every finger is up and nothing is being dragged. Called whenever the browser tells us a gesture
   ended in a way we cannot track, so a lost event can never leave the board deaf. */
function tblResetGestures() {
  if (!tbl) return;
  tblTrace("gestures reset", (tbl.drag ? "was dragging" : "") + " ptrs=" + tbl.pointers.size);
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
  tbl.inking = null;
  if (tbl.erasing) tblEraseCommit();   // a gesture cut short still keeps what it rubbed
  paintTokens();
  paintRuler();
  paintDrawings();
}

function onPointerDown(e) {
  if (!tbl) return;
  const stage = $("#vtt-stage");
  if (!stage || !stage.contains(e.target)) return;   // the window hears everything; the board owns only itself
  /* A CONTROL DRAWN ON THE BOARD IS A CONTROL, not a patch of map. Everything below takes the gesture
     over: it preventDefaults, and it calls setPointerCapture on the stage — and a captured pointer
     delivers the eventual `click` to the STAGE rather than to the thing under the finger, so a button
     inside the board can never be pressed. That is why the × on an area did nothing. Anything carrying
     `data-tbl` is left entirely alone here and reaches the ordinary click handler like every other
     button in the app. */
  if (evTarget(e).closest("[data-tbl]")) return;
  /* THE bug behind five reports of "I can't drag until I double-click".
     A pointerdown on an <img> or on text starts the BROWSER's own drag-and-drop — a native gesture that
     swallows every pointermove that follows, so the board simply stops hearing the hand. It is
     browser-dependent (`-webkit-user-drag: none` covers Blink and WebKit and does nothing in Firefox),
     which is why it never reproduced in my Chromium tests, and a double-click "fixed" it only by putting
     the browser into a different interaction state.
     preventDefault on pointerdown stops the native drag AND the text selection that comes with it. It is
     safe here because this listener is not passive and the board handles every gesture itself. */
  if (e.cancelable) e.preventDefault();
  // A primary pointerdown is by definition the FIRST finger of a gesture, so anything still recorded
  // is a ghost from an event we never received. Self-healing beats hoping.
  if (e.isPrimary !== false && tbl.pointers.size) {
    tblTrace("cleared ghost pointers", [...tbl.pointers.keys()].join(","));
    tbl.pointers.clear(); tbl.pinch = null; tbl.drag = null;
  }
  tbl.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  // Two fingers down: this is a pinch, and whatever the first finger had started is abandoned.
  if (tbl.pointers.size === 2) { tbl.drag = null; tbl.pinch = tblPinchState(); return; }
  const p = stagePoint(e);
  /* Placing an area takes the gesture entirely, exactly as the pen does: while something is waiting to be
     put down, the next tap on the board is where it goes and nothing is dragged or panned on the way. */
  if (tbl.placing) {
    const at = toSquares(p.sx, p.sy);
    tblAimAt(at.x, at.y);
    return;
  }
  // Drawing takes the gesture entirely: while the pen is out, the board is a sheet of paper. That is also
  // why figures cannot be dragged in this mode — you would smear ink every time you missed one.
  if (tblInkState().on && tblCanDraw()) {
    const at = tblInkPoint(p);
    tbl.drag = null;
    if (tblInkState().mode === "erase") { tblEraseAt(at); return; }
    // The bucket is a tap, not a stroke: it colours in something that is already there and starts nothing.
    if (tblInkState().mode === "fill") { tblFillAt(at); return; }
    tblTrace("ink start");
    tbl.inking = { points: [at], color: tblInkState().color, width: tblInkState().width,
                   kind: tblInkState().shape || "free", fill: tblInkState().fill || false };
    paintDrawings();
    if (stage.setPointerCapture) { try { stage.setPointerCapture(e.pointerId); } catch { /* fine */ } }
    return;
  }
  const node = evTarget(e).closest("[data-token]");
  const id = node && node.dataset.token;
  const token = id ? tblTokens()[id] : null;
  if (token && tblCanMove(token)) {
    const at = toSquares(p.sx, p.sy);
    /* A figure with no `x` is a figure at zero, not a figure at NaN. Everything below subtracts from
       these, so one missing field poisons the whole drag: `at.x - undefined` is NaN, every move writes
       NaN, and the database refuses the lot with "value argument contains NaN" — which is what a figure
       that would not move under the finger turned out to be. Tokens missing a field are supposed to be
       impossible (see tblTokenField) and this makes them harmless as well. */
    const tx = Number(token.x) || 0, ty = Number(token.y) || 0;
    tbl.drag = {
      id, token,
      grabX: at.x - tx, grabY: at.y - ty,     // where inside the token you grabbed it
      fromX: tx, fromY: ty,
      x: tx, y: ty,
    };
    node.classList.add("dragging");
    tblTrace("drag start", id);
  } else {
    tblTrace("pan start");
    tbl.drag = { pan: true, sx: p.sx, sy: p.sy, ox: tbl.view.x, oy: tbl.view.y };
    tbl.tapFrom = { sx: p.sx, sy: p.sy };   // to tell a tap from a drag when the hand comes up
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
  /* An outline that follows the pointer UNTIL IT IS AIMED, and then stops dead.
   *
   * Both halves of that are load-bearing. It follows so a desktop can see what it is about to cover
   * before committing; it stops because the button that commits it — "Place it here" — is in a bar ABOVE
   * the board, and while it went on following, the walk up to that button dragged the outline with it.
   * Kayki aimed at the square he wanted, moved the mouse to press Place, and watched it land off the top
   * of the map: "it snaps and goes somewhere else completely unrelated out of the grid." Every pointermove
   * on the way to the button was another aim.
   *
   * It also only listens while the pointer is over the BOARD, for the same reason — this listener is on
   * the window and hears the whole page. A tap on the board re-aims, which is how you change your mind. */
  if (tbl.placing && !tbl.placing.aimed) {
    const stage = $("#vtt-stage");
    if (!stage || !stage.contains(e.target)) return;
    const at = toSquares(stagePoint(e).sx, stagePoint(e).sy);
    const spot = tblSnapArea(at.x, at.y, tbl.placing.shape, tbl.placing.size);
    tbl.placing.x = spot.x;
    tbl.placing.y = spot.y;
    paintAreas();
    return;
  }
  if (tbl.inking) {
    const at = tblInkPoint(stagePoint(e));
    // A shape is always exactly two points — where the drag began and where it is now — so it grows and
    // shrinks under the hand instead of leaving a trail.
    if (tbl.inking.kind !== "free") {
      tbl.inking.points[1] = at;
      paintDrawings();
      return;
    }
    const last = tbl.inking.points[tbl.inking.points.length - 1];
    // Only once the hand has actually moved: sampling every event would store hundreds of identical points
    // and make the stroke expensive for everyone else to draw.
    if (Math.hypot(at.x - last.x, at.y - last.y) > 0.002 && tbl.inking.points.length < TBL_INK_MAX_POINTS) {
      tbl.inking.points.push(at);
      paintDrawings();
    }
    return;
  }
  if (tblInkState().on && tblInkState().mode === "erase" && tbl.pointers.size === 1 && tblCanDraw()) {
    tblEraseAt(tblInkPoint(stagePoint(e)));
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
  // Everyone else sees the move as it happens, at a rate the database is happy with. Guarded like every
  // other field write: a figure the DM removes mid-drag must not be written back into existence.
  if (!tblTokens()[d.id]) return;
  CocLive.throttled(tblPath("tokens/" + d.id + "/x"), Math.round(d.x * 100) / 100, 110);
  CocLive.throttled(tblPath("tokens/" + d.id + "/y"), Math.round(d.y * 100) / 100, 110);
  paintRuler();
}

function onPointerUp(e) {
  if (!tbl) return;
  tbl.pointers.delete(e.pointerId);
  // Rubbing writes nothing until the hand comes up; this is that moment.
  if (tbl.erasing) tblEraseCommit();
  if (tbl.inking) {
    const stroke = tbl.inking;
    tbl.inking = null;
    if (stroke.points.length) {
      CocLive.push(tblPath("draw"), {
        by: tblNoteOwner(), scene: tblSceneId(), color: stroke.color, width: stroke.width,
        kind: stroke.kind || "free", fill: stroke.fill || false,
        pts: tblInkEncode(stroke.points), at: Date.now(),
      }).then((id) => tblUndoPush({ kind: "add", id })).catch(tblFail);
    }
    paintDrawings();
    return;
  }
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
  if (d.pan) { tblTapOnBoard(e); return; }
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
  // Nothing that is not a number gets out of here. A square is where a figure IS; there is no useful
  // answer to "which square is NaN", and the one thing it must never do is reach the database.
  const fit = (v, max) => {
    const n = Number(v);
    return Math.max(0, Math.min(Math.max(0, max), Number.isFinite(n) ? n : 0));
  };
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
  tblTrace("figure landed", d.id);
  const size = Math.max(1, Number(d.token.size) || 1);
  const spot = tblFreeSquare(d.id, Math.round(d.x), Math.round(d.y), size, d.fromX, d.fromY);
  tblTokenField(d.id, "x", spot.x).catch(tblFail);
  tblTokenField(d.id, "y", spot.y).catch(tblFail);
  tblCountMove(d, spot.x, spot.y);
}


/* ---------------------------------------------------------------- drawing on the map
 *
 * Strokes are stored NORMALISED to the picture — every point a fraction of the world, 0 to 1 — not in
 * squares. It matters: re-gridding a map (30 squares across to 60) changes how big a square is, and a
 * drawing measured in squares would stretch away from the thing it was drawn around. Measured against the
 * picture, an arrow keeps pointing at the door.
 *
 * A stroke belongs to whoever drew it, by the same key the notepad uses. You may rub out your own; the DM
 * may rub out anybody's, and may turn drawing off for a scene entirely. */
/* A die should look like the die it is. Clipping the box into a polygon cut the number in half, so the
   shape is drawn BEHIND the number instead — an outline the digit sits on top of. Points are the
   silhouettes everyone recognises: the d20's hexagon, the d4's triangle, the d8's rhombus. The inner
   lines on the d20 and d12 are what stops a hexagon reading as a stop sign. */
/* `inner` is a LIST of separate lines, not one string with drawing commands buried in it. The d4 needs
   two — a spine and a V — and writing that as "…50,88 M6,88 L50,58…" produced "LM6,88 LL50,58" when the
   points were joined up, which is not a path at all: the browser rejected it and the d4 has been drawn
   without its inner lines, loudly, ever since. */
const TBL_DIE_SHAPES = {
  4:   { pts: "50,6 94,88 6,88", inner: ["50,6 50,88", "6,88 50,58 94,88"] },
  6:   { pts: "14,14 86,14 86,86 14,86", inner: [] },
  8:   { pts: "50,4 92,50 50,96 8,50", inner: ["8,50 92,50"] },
  10:  { pts: "50,3 92,40 50,97 8,40", inner: ["8,40 92,40"] },
  12:  { pts: "50,4 95,37 78,92 22,92 5,37", inner: ["50,30 22,50 33,80 67,80 78,50 50,30"] },
  20:  { pts: "50,4 91,27 91,73 50,96 9,73 9,27", inner: ["50,26 20,66 80,66 50,26"] },
  100: { pts: "50,3 76,11 94,33 94,67 76,89 50,97 24,89 6,67 6,33 24,11", inner: [] },
};
function tblDieFace(sides) {
  const shape = TBL_DIE_SHAPES[sides] || TBL_DIE_SHAPES[6];
  const lines = shape.inner.map((line) => "M" + line.trim().split(/\s+/).join(" L")).join(" ");
  const inner = lines ? `<path d="${lines}" class="die-inner" />` : "";
  return `<svg class="die-face" viewBox="0 0 100 100" aria-hidden="true">` +
    `<polygon points="${shape.pts}" /></svg>${inner ? `<svg class="die-face" viewBox="0 0 100 100" aria-hidden="true">${inner}</svg>` : ""}`;
}

const TBL_INK_COLOURS = [
  ["#d94f43", "Red"], ["#5cb85c", "Green"], ["#4a90d9", "Blue"],
  ["#f2efe6", "White"], ["#14110f", "Black"], ["#8b8b86", "Grey"],
  ["#e8c341", "Yellow"], ["#e77fb3", "Pink"], ["#8a5a34", "Brown"],
];
const TBL_INK_MAX_POINTS = 400;
/* Freehand, and the three shapes anybody actually draws on a battle map. A shape is TWO points — where the
   drag began and where it is now — so it resizes as you drag and stores as almost nothing. */
const TBL_INK_SHAPES = [["free", "Freehand"], ["line", "Line"], ["rect", "Box"], ["circle", "Circle"]];

function tblInkState() {
  if (!tbl.ui.ink) tbl.ui.ink = { mode: "pen", shape: "free", color: TBL_INK_COLOURS[0][0], width: 2, on: false };
  if (!tbl.ui.ink.shape) tbl.ui.ink.shape = "free";
  return tbl.ui.ink;
}
/* May I draw here? The DM always may; a player may unless the DM has turned it off for this scene. */
function tblCanDraw() {
  if (tbl.role === "dm") return true;
  return tblScene().drawLocked !== true;
}
function tblMyStrokes() {
  const mine = tblNoteOwner();
  const scene = tblSceneId();
  return Object.entries(tbl.data.draw || {})
    .filter(([, k]) => k && k.by === mine && k.scene === scene);
}

/* "0.1234,0.5678 …" — short enough to write on every stroke, precise enough at any zoom. */
function tblInkEncode(points) {
  return points.map((p) => `${p.x.toFixed(4)},${p.y.toFixed(4)}`).join(" ").slice(0, 4000);
}
function tblInkDecode(text) {
  return String(text || "").split(" ").map((pair) => {
    const [x, y] = pair.split(",").map(Number);
    return { x, y };
  }).filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
}

/* Every stroke on this scene, plus whatever is being drawn right now. Rebuilt whole — strokes are few —
   with the one in progress as a separate path, so a repaint from somebody else's move cannot interrupt
   the line under your finger. */
function paintDrawings() {
  const svg = $("#vtt-ink");
  if (!svg) return;
  const scene = tblScene();
  const cell = Number(scene.cell) || 70;
  const w = (Number(scene.cols) || 30) * cell, h = (Number(scene.rows) || 20) * cell;
  const sceneId = tblSceneId();
  const path = (k, id) => {
    const pts = tblInkDecode(k.pts);
    if (!pts.length) return "";
    const width = Math.max(1, (Number(k.width) || 2) * cell / 24);
    const stroke = esc(k.color || "#c9a54e");
    /* Filled, like the paint bucket. Two strengths, because both are wanted for different things: SHADED
       lies over the map so the picture still reads through it — an area of difficult ground, a spell's
       reach — and SOLID actually covers it, for a wall, a pit, a blacked-out room. `fill: true` is what
       the old strokes stored and means shaded. */
    const paint = k.fill
      ? `fill="${stroke}" fill-opacity="${k.fill === "solid" ? "0.95" : "0.32"}"`
      : `fill="none"`;
    const common = `${paint} stroke="${stroke}" stroke-width="${width.toFixed(1)}"
      stroke-linecap="round" stroke-linejoin="round" data-ink="${esc(id)}"`;
    const X = (p) => (p.x * w).toFixed(1), Y = (p) => (p.y * h).toFixed(1);
    // A shape is its two corners; freehand is every point it was drawn through.
    if (k.kind === "line" && pts.length > 1) {
      return `<line x1="${X(pts[0])}" y1="${Y(pts[0])}" x2="${X(pts[1])}" y2="${Y(pts[1])}" ${common} />`;
    }
    if (k.kind === "rect" && pts.length > 1) {
      const x = Math.min(pts[0].x, pts[1].x) * w, y = Math.min(pts[0].y, pts[1].y) * h;
      const bw = Math.abs(pts[1].x - pts[0].x) * w, bh = Math.abs(pts[1].y - pts[0].y) * h;
      return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${bw.toFixed(1)}"
        height="${bh.toFixed(1)}" ${common} />`;
    }
    if (k.kind === "circle" && pts.length > 1) {
      // Corner to corner, like every drawing program: an ellipse inside the box you dragged.
      const cx = ((pts[0].x + pts[1].x) / 2) * w, cy = ((pts[0].y + pts[1].y) / 2) * h;
      const rx = Math.abs(pts[1].x - pts[0].x) * w / 2, ry = Math.abs(pts[1].y - pts[0].y) * h / 2;
      return `<ellipse cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" rx="${rx.toFixed(1)}"
        ry="${ry.toFixed(1)}" ${common} />`;
    }
    if (pts.length === 1) {
      // A tap is a dot, not nothing — people mark spots.
      return `<circle cx="${X(pts[0])}" cy="${Y(pts[0])}" r="${(width / 2).toFixed(1)}"
        fill="${stroke}" data-ink="${esc(id)}" />`;
    }
    const d = pts.map((p, i) => `${i ? "L" : "M"}${X(p)} ${Y(p)}`).join(" ");
    return `<path d="${d}" ${common} />`;
  };
  /* Whatever is being rubbed, or was just rubbed and is still on its way to the database. The pending overlay
     retires itself the moment the stored strokes agree with it — no timers, no guessing at latency. */
  if (tbl.inkPending) {
    const store = tbl.data.draw || {};
    if ([...tbl.inkPending.keys()].every((id) => !store[id])) { tbl.inkPending = null; tbl.inkNew.clear(); }
  }
  const rubbing = tbl.erasing || tbl.inkPending;
  const strokes = Object.entries(tbl.data.draw || {})
    // While a rub is in flight, the pieces it produced are already on screen as part of the overlay; drawing
    // the stored copies as well would double every line for a moment.
    .filter(([id, k]) => k && k.scene === sceneId && !(tbl.inkPending && tbl.inkNew.has(id)))
    .sort((a, b) => (a[1].at || 0) - (b[1].at || 0))
    .map(([id, k]) => {
      // Mid-rub, a stroke is drawn as whatever is left of it — the writes have not happened yet.
      if (rubbing && rubbing.has(id)) {
        return rubbing.get(id).map((piece, i) =>
          path({ ...k, kind: "free", pts: tblInkEncode(piece) }, id + "-" + i)).join("");
      }
      return path(k, id);
    }).join("");
  const live = tbl.inking && tbl.inking.points.length
    ? path({ pts: tblInkEncode(tbl.inking.points), color: tbl.inking.color, width: tbl.inking.width,
             kind: tbl.inking.kind, fill: tbl.inking.fill }, "live")
    : "";
  svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
  svg.innerHTML = strokes + live;
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
  tblTokenField(drag.id, "moved", used).catch(() => {});
}



/* ---------------------------------------------------------------- areas on the map
 *
 * THE `shape` VERB. A trick that says it fills a 10-foot radius now fills one on the board: you cast it,
 * you place it, everyone sees it, and the app works out who is standing in it and hands that list to the
 * DM. See docs/MAP-INTERACTION.md.
 *
 * What it does NOT do is decide anything. It does not roll the save, it does not apply the damage and it
 * does not stop anybody walking through. It counts squares — the one part of this a person is bad at and
 * a program is good at — and then gets out of the way. Kayki's rule for the whole table: the app never
 * sees your dice, so it never guesses.
 *
 * Stored under `areas/<id>`, not on the scene, for the same reason everything else is flat: one stream
 * watches the whole table (see the note in tblOpen) and a nested branch would need its own.
 *   { scene, x, y, shape, size, left, name, by, at }
 * `x`/`y` are the CENTRE in squares, as tokens are. `size` is FEET, as the trick is authored — the
 * conversion lives in one place, below, rather than at every call site. `left` is rounds remaining and is
 * absent for an area that stays until it is cleared.
 *
 * The name `areas` and not `shapes`: a token already has a `shape` (square, circle, triangle, diamond)
 * and two things called shape in one file is how the wrong one gets read.
 */

// Feet to squares, off the same constant the ruler measures with — one scale for the whole board.
const tblSquares = (feet) => Math.max(1, Number(feet) || 5) / TBL_FEET_PER_SQUARE;

function tblAreas() {
  const all = tbl.data.areas || {};
  const scene = tblSceneId();
  return Object.entries(all).filter(([, a]) => a && (!a.scene || a.scene === scene));
}

/* Every figure standing in it. A figure is a square of `size` squares from its top-left corner, so this
   asks whether that square OVERLAPS the area rather than whether its centre is inside — a Large creature
   with one foot in the blast is in the blast, which is how it is ruled at a table.
 *
 * A RADIUS IS MEASURED AS A CIRCLE, which is deliberately NOT how the board measures movement. Walking is
 * Chebyshev — three squares diagonally costs the same 15 feet as three across, the ordinary grid rule —
 * because that is how you walk a grid. A burst is not walked: it is a physical thing with a real edge,
 * and measuring it the same way would make every "radius" a square, which is what the `cube` shape is
 * already for. So the two metrics differ on purpose, and the drawing matches the measurement in each
 * case: a circle is drawn as a circle and reaches as one. */
function tblInsideArea(a) {
  const half = tblSquares(a.size) / 2;
  const scene = tblSceneId();
  return Object.entries(tblTokens()).filter(([, t]) => {
    if (!t || (t.kind === "npc" && t.scene && t.scene !== scene)) return false;
    const s = Math.max(1, Number(t.size) || 1);
    const x = Number(t.x) || 0, y = Number(t.y) || 0;
    if (a.shape === "cube") {
      return x < a.x + half && a.x - half < x + s && y < a.y + half && a.y - half < y + s;
    }
    // Radius: the nearest point of the figure's square to the centre, which is the centre clamped into
    // that square. A circle and a box touch when that point is within the radius.
    const nx = Math.max(x, Math.min(a.x, x + s));
    const ny = Math.max(y, Math.min(a.y, y + s));
    return Math.hypot(a.x - nx, a.y - ny) <= half;
  }).map(([id]) => id);
}

/* Areas, and the one being placed right now. Drawn in world pixels like the ink, so the camera carries
   them for free. */
function paintAreas() {
  const svg = $("#vtt-areas");
  if (!svg) return;
  const scene = tblScene();
  const cell = Number(scene.cell) || 70;
  const w = (Number(scene.cols) || 30) * cell, h = (Number(scene.rows) || 20) * cell;
  svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
  svg.setAttribute("width", w);
  svg.setAttribute("height", h);
  const drawn = tblAreas().map(([id, a]) => areaShapeHTML(a, cell, id)).join("");
  svg.innerHTML = drawn + placingGhostHTML(cell);
  // The names live in their own layer, as HTML, so they are the same element a figure's name is.
  const tags = $("#vtt-area-tags");
  if (tags) tags.innerHTML = tblAreas().map(([id, a]) => areaLabelHTML(id, a, cell)).join("");
}

/* The label is the AREA'S HANDLE, and the only part of it that takes a press.
 *
 * It used to be a small × drawn at the shape's top-right corner, which is exactly where a figure standing
 * beside the area is — so half the time the × was under a goblin and could not be pressed at all. The
 * label sits above the shape where nothing else is, says what the thing is, and opens its card. Kayki's
 * ask, and the right one: "put it with its own sheet like the creatures, with the option to remove it."
 *
 * Its size is divided by the zoom so it stays the same on SCREEN however far the board is pulled back —
 * everything else in the world grows and shrinks with the camera, but a label you cannot read is not a
 * label and a handle you cannot hit is not a handle. */
/* AN AREA IS NAMED THE WAY A FIGURE IS: the same label, in the same place, in the same type.
 *
 * Everything before this was a special case — a chip, then a chip that shrank, then a chip that gave up
 * and became a dot — invented because the label was drawn INTO the shape's SVG and had to be measured
 * against it. Kayki: "why don't you just put the text like all other creatures, and the window opening
 * when I click wherever is in the square field." He is right twice. A figure's name is a small plate
 * along its bottom edge that has read perfectly well since the day it was written, at every zoom and on
 * every screen; an area is a box on the same grid and wants the same thing. So it is the same element,
 * with the same class, positioned the same way — and every rule about fitting, shrinking and degrading
 * goes in the bin.
 *
 * And with the whole shape opening the card, the label does not have to be a target at all. */
function areaLabelHTML(id, a, cell) {
  const half = tblSquares(a.size) / 2;
  const left = tblAreaLeft(a);
  const tag = [a.name || "Area", left != null ? left + (left === 1 ? " round" : " rounds") : ""]
    .filter(Boolean).join(" · ");
  return `<div class="area-tok" data-area-tag="${esc(id)}"
    style="left:${((a.x - half) * cell).toFixed(1)}px; top:${((a.y - half) * cell).toFixed(1)}px;
      width:${(half * 2 * cell).toFixed(1)}px; height:${(half * 2 * cell).toFixed(1)}px">
    <span class="tok-name">${esc(tag)}</span>
  </div>`;
}

function areaShapeHTML(a, cell, id) {
  const r = tblSquares(a.size) / 2 * cell;
  const cx = a.x * cell, cy = a.y * cell;
  // Drawn twice: a dark halo under a gold edge, so the outline reads on a bright map and a dark one
  // without either being loud enough to hide what is standing in it.
  const geom = a.shape === "cube"
    ? `<rect x="${(cx - r).toFixed(1)}" y="${(cy - r).toFixed(1)}" width="${(r * 2).toFixed(1)}"
         height="${(r * 2).toFixed(1)}"`
    : `<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${r.toFixed(1)}"`;
  const body = `${geom} class="area-edge" />${geom} class="area-body" />`;
  // The rounds left are on the label: "how long is that cloud there for" is asked every round, and the
  // alternative is the DM keeping it in their head.
  return `<g class="area${id ? "" : " ghost"}" data-area="${esc(id || "")}">${body}</g>`;
}

/* What you are about to place, following the cursor, plus the reach it is being placed from. The reach is
   DRAWN AND NOT ENFORCED — it turns red outside and lets you do it anyway, the same rule the board
   already holds for movement (RULES.md). */
function placingGhostHTML(cell) {
  const p = tbl.placing;
  if (!p || p.x == null) return "";
  const from = tblTokens()[p.fromId];
  let ring = "";
  if (from && p.range) {
    const fs = Math.max(1, Number(from.size) || 1);
    const fx = (Number(from.x) || 0) + fs / 2, fy = (Number(from.y) || 0) + fs / 2;
    const far = tblFeetBetween(fx, fy, p.x, p.y) > p.range;
    ring = `<circle cx="${(fx * cell).toFixed(1)}" cy="${(fy * cell).toFixed(1)}"
      r="${(tblSquares(p.range * 2) / 2 * cell).toFixed(1)}" class="area-reach ${far ? "far" : ""}" />`;
  }
  return ring + areaShapeHTML({ x: p.x, y: p.y, shape: p.shape, size: p.size, name: p.name }, cell, "");
}

/* ---- placing one ---------------------------------------------------------- */

/* Cast something with a `board` block and the board takes over: the next tap on the map is where it
   goes. Called from the sheet's Cast button, which is in creator.js and knows nothing about tables —
   hence the optional hook rather than a direct call. */
function tblCastOnBoard(trick) {
  if (!tbl || !trick || !trick.board) return false;
  const b = trick.board;
  if (b.verb !== "shape" && b.verb !== "mark") return false;
  tbl.placing = {
    name: trick.name || "Area", shape: b.shape === "cube" ? "cube" : "radius",
    size: Number(b.size) || 5, range: Number(b.range) || 0,
    rounds: b.rounds == null ? null : Number(b.rounds),
    fromId: tblCasterToken(), x: null, y: null, aimed: false,
  };
  /* GET OUT OF THE WAY. You cast it from your sheet, which on a phone IS the screen and on a desktop
     covers a third of the board — and then you are asked to tap a map you cannot see. Casting closes the
     drawer, every time: the next thing you have to do is on the board.
   *
   * AFTERWARDS, though, not now. This runs inside the sheet's own click handler, which still has to
   * redraw itself and SAVE the cooldown or the engine it has just spent — and closing the drawer is what
   * lets go of the sheet, so doing it here pulled the ground out from under the rest of that handler:
   * a null dereference, and the spent cooldown never written. One tick later the sheet has finished with
   * itself and the drawer can go. */
  tblClosePanelSoon();
  paintPlacing();
  paintAreas();
  return true;
}

/* Which figure is casting: yours if you hold one, else whoever is up (the DM running a creature from its
   own sheet). Only used to draw the reach from, so being wrong costs a ring and not a rule. */
function tblCasterToken() {
  const mine = tblMyTokens()[0];
  if (mine) return mine;
  const turn = (tbl.data.meta || {}).turn;
  if (turn && Array.isArray(turn.order)) return turn.order[turn.idx] || "";
  return "";
}

function tblPlaceCancel() {
  tbl.placing = null;
  paintPlacing();
  paintAreas();
}

/* AIM, THEN PLACE. A tap on the board moves the outline; it does not commit anything.
 *
 * The first version placed it on the tap, and Kayki's first misclick put an illusion somewhere he did not
 * want it with no way to take it back. A trick costs a cooldown or a slice of the engine — it is not an
 * action that should be one stray finger away. So the tap aims and a second, deliberate press on "Place
 * it here" commits. It also fixes the phone, where there is no pointer to hover with and the outline had
 * nowhere to appear before it landed. */
function tblAimAt(x, y) {
  const p = tbl.placing;
  if (!p) return;
  const spot = tblSnapArea(x, y, p.shape, p.size);
  p.x = spot.x;
  p.y = spot.y;
  p.aimed = true;
  paintPlacing();
  paintAreas();
}

/* ON THE GRID, NEVER BETWEEN IT. An area that lands half a square out covers seven squares of a map when
 * it should cover four, and no two people reading the board agree about which. Kayki's words: "the idle
 * image can be put in between the squares which isn't supposed to."
 *
 * Where the centre may sit follows from the shape, so the EDGES always land on grid lines:
 *   - a cube of an ODD number of squares (5 ft = 1, 15 ft = 3) is centred on a square's middle;
 *   - a cube of an EVEN number (20 ft = 4) is centred on a corner;
 *   - a radius is always centred on a corner, which is the ordinary rule for a burst — it goes off at a
 *     point between squares and reaches the same distance every way.
 */
function tblSnapArea(x, y, shape, size) {
  const across = tblSquares(size) * (shape === "cube" ? 1 : 2);   // a radius spans twice itself
  const toCentre = shape === "cube" && Math.round(across) % 2 === 1;
  const snap = (v) => (toCentre ? Math.floor(v) + 0.5 : Math.round(v));
  return { x: snap(x), y: snap(y) };
}

/* Down it goes, and the app says who is in it. */
async function tblPlaceAt(x, y) {
  const p = tbl.placing;
  if (!p) return;
  if (p.verb === "spawn") { await tblSpawnAt(x, y); return; }
  const spot = tblSnapArea(x, y, p.shape, p.size);
  const area = {
    scene: tblSceneId(), x: spot.x, y: spot.y,
    shape: p.shape, size: p.size, name: p.name, by: tbl.me.clientId, at: Date.now(),
  };
  if (p.rounds) {
    area.rounds = p.rounds;
    // Cast during a fight, it knows when it ends; cast out of one, it picks up its clock when one starts.
    const round = tblRoundNow();
    if (round) area.until = round + p.rounds - 1;
  }
  tbl.placing = null;
  paintPlacing();
  const inside = tblInsideArea(area).map((id) => (tblTokens()[id] || {}).name || "someone");
  await CocLive.push(tblPath("areas"), area);
  /* The list, to the log, for the DM to roll against. This is the whole point of the verb: the counting
     is done and the judgement is not. */
  await CocLive.push(tblPath("log"), {
    t: Date.now(), who: tbl.me.name || (tbl.role === "dm" ? "DM" : "Player"), kind: "system",
    text: `${p.name} — ${p.size} ft ${p.shape === "cube" ? "cube" : "radius"} — ${
      inside.length ? "catches " + inside.join(", ") : "catches nobody"}`,
  });
}

/* WHOEVER PUT IT THERE CAN TAKE IT AWAY, and so can the DM. The first version was DM-only, which meant a
   player who dropped an illusion had to ask somebody else to tidy it up — and half of these tricks say
   "until you dismiss it (no action required)" in their own text, so dismissing it is the player's right
   and not a favour. */
function tblCanClearArea(a) {
  return tbl.role === "dm" || (!!a && a.by === tbl.me.clientId);
}

async function tblAreaClear(id) {
  const a = (tbl.data.areas || {})[id];
  if (!a || !tblCanClearArea(a)) return;
  await CocLive.put(tblPath("areas/" + id), null);
}

/* HOW LONG IT HAS LEFT IS A SUM, NOT A COUNTDOWN.
 *
 * The first version decremented every area whenever the round changed, from inside `tblTurnStep` — the
 * function that whoever presses Next or Done runs. Two things were wrong with that and Kayki hit both:
 * the decrement was DM-only, so a player ending their own turn advanced the round and nothing ticked, and
 * stepping BACK through the order would have counted an area down a second time.
 *
 * So an area stores the round it lasts UNTIL, and how long it has left is arithmetic against the round
 * showing on the bar. Nobody has to tick anything, every browser agrees without being told, and pressing
 * Back is simply the same sum again. Only the sweeping-up is a write, and only the DM's browser does it.
 */
function tblRoundNow() {
  const turn = (tbl.data.meta || {}).turn;
  return turn && Array.isArray(turn.order) && turn.order.length ? Number(turn.round) || 1 : 0;
}

function tblAreaLeft(a) {
  const round = tblRoundNow();
  if (!a || a.until == null || !round) return null;
  return Number(a.until) - round + 1;
}

/* Areas that have run out go, and one placed before the fight started picks up its clock when it does.
   The DM's browser, on every stream event, alongside the other settling. */
async function tblAreasSettle() {
  if (tbl.role !== "dm") return;
  const round = tblRoundNow();
  for (const [id, a] of tblAreas()) {
    if (!a.rounds) continue;                       // it stays until somebody takes it away
    if (a.until == null) {
      if (round) await CocLive.put(tblPath("areas/" + id + "/until"), round + Number(a.rounds) - 1);
      continue;
    }
    if (round && round > Number(a.until)) await CocLive.put(tblPath("areas/" + id), null);
  }
}


/* How long an area has to run, in words, or nothing at all when it is not counting. */
function areaLeftText(a) {
  const left = tblAreaLeft(a);
  if (left == null) return a.rounds ? ` &middot; ${esc(a.rounds)} rounds, once a fight starts` : "";
  return ` &middot; ${esc(left)} round${left === 1 ? "" : "s"} left`;
}

/* WHAT YOU HAVE ON THE FIELD, in a list, away from the board.
 *
 * Kayki's ask, and the reasoning is his: "that way we don't have to worry about the trick being on top of
 * some other creature or player and us not having access to the trick itself." Hunting for a handle on a
 * crowded board is a bad way to reach something you own — so everything you have put out there is also
 * here, in one place, with the same Remove on each. The board is for seeing; this is for managing.
 *
 * Yours if you are a player, everybody's if you are the DM, because the DM tidies up after the table. */
function tblMyAreas() {
  return tblAreas().filter(([, a]) => tbl.role === "dm" || a.by === tbl.me.clientId);
}

function fieldPanelHTML() {
  const mine = tblMyAreas();
  if (!mine.length) {
    return `<section class="panel"><h2>On the field</h2>
      <p class="muted">Nothing of yours is out there. Cast something that covers ground and it appears
        here, so you never have to go hunting for it on a crowded board.</p></section>`;
  }
  const rows = mine.map(([id, a]) => {
    const inside = tblInsideArea(a).map((tid) => (tblTokens()[tid] || {}).name || "someone");
    return `<div class="scene-row">
      <div class="field-what">
        <strong>${esc(a.name || "Area")}</strong>
        <span class="muted">${esc(a.size)} ft ${a.shape === "cube" ? "cube" : "radius"}${areaLeftText(a)}</span>
        <span class="muted">${inside.length ? "Inside: " + esc(inside.join(", ")) : "Nobody inside"}</span>
      </div>
      <button class="btn-quiet" data-tbl="area-clear" data-val="${esc(id)}">Remove</button>
    </div>`;
  }).join("");
  return `<section class="panel"><h2>On the field</h2>
    <p class="muted">${tbl.role === "dm" ? "Everything the table has put out." : "Everything you have put out."}
      Taking one away here is the same as taking it away on the board.</p>
    <div class="scene-list">${rows}</div></section>`;
}


/* A TAP ON THE BOARD, as opposed to a drag of it.
 *
 * The whole of an area opens its card — "the window opening when I click wherever is in the square
 * field", which is how a figure already behaves and is the obvious thing. It is done here, on the way
 * up, and by arithmetic rather than by hit-testing, for two reasons that both matter:
 *
 *   - a shape that TOOK presses would eat panning. A 60-foot illusion covers most of the screen, and
 *     dragging the map from inside it has to keep working. Down-then-up in the same spot is a tap;
 *     anything further is a drag and belongs to the camera.
 *   - and nothing has to be layered, or made to take pointer events, or kept above or below anything
 *     else. The areas are numbers; asking which one a point is in is a sum.
 *
 * The topmost one wins, the way a stack of things on a table does, so an area dropped on top of another
 * is the one you get. */
const TBL_TAP_SLOP = 6;   // pixels of travel still counted as a tap rather than a drag
function tblTapOnBoard(e) {
  const stage = $("#vtt-stage");
  if (!stage || !stage.contains(e.target) || tbl.placing) return;
  const p = stagePoint(e);
  if (Math.abs(p.sx - d0(e).sx) > TBL_TAP_SLOP || Math.abs(p.sy - d0(e).sy) > TBL_TAP_SLOP) return;
  const at = toSquares(p.sx, p.sy);
  const hit = tblAreas().filter(([, a]) => tblPointInArea(a, at.x, at.y)).pop();
  if (!hit) return;
  tbl.ui.peek = "";
  tbl.ui.peekArea = hit[0];
  paintPeek();
}

/* Where the finger went down, kept by the pan state the gesture started with. */
function d0(e) {
  const box = $("#vtt-stage").getBoundingClientRect();
  const start = tbl.tapFrom || { sx: e.clientX - box.left, sy: e.clientY - box.top };
  return start;
}

function tblPointInArea(a, x, y) {
  const half = tblSquares(a.size) / 2;
  if (a.shape === "cube") {
    return x >= a.x - half && x <= a.x + half && y >= a.y - half && y <= a.y + half;
  }
  return Math.hypot(x - a.x, y - a.y) <= half;
}


/* A CAST SAYS SO, whatever it cost.
 *
 * A Turn spends a cooldown and a Prestige spends the engine, and both of those show on your own sheet —
 * but a Pledge is at-will, so once it stopped flipping the sheet into combat (which it had no business
 * doing) pressing Cast on one changed nothing anybody could see. Kayki: "the cast button on the tricks
 * don't do anything whatsoever." It was doing exactly what it was told and saying nothing about it.
 *
 * So every cast is announced to the table. That is worth having for its own sake: the DM needs to know a
 * trick went off, and until now the only person who could tell was the caster, by looking at their own
 * cooldown pips. */
function tblAnnounceCast(trick, who) {
  if (!tbl || !trick) return;
  const cost = trick.tier === "prestige" ? "Prestige"
    : trick.cooldown ? "Turn · back in " + trick.cooldown + (trick.cooldown === 1 ? " round" : " rounds")
    : "Pledge";
  CocLive.push(tblPath("log"), {
    t: Date.now(), who: who || tbl.me.name || "Someone", kind: "system",
    text: `${who || "Someone"} casts ${trick.name}${trick.range ? " — " + trick.range : ""} (${cost})`,
  }).catch(() => {});
}


/* ---------------------------------------------------------------- the `spawn` verb
 *
 * A figure that appears because somebody made it. Today that is the Doppelganger's Clones, and the rules
 * of the thing come from the class rather than from here (data/classes/doppelganger.json):
 *
 *   - it wears your face and stands in its own space;
 *   - it shares your AC and has NO hit points — a single hit destroys it. On a board that has hit points
 *     in it, "no hit points, one hit kills" is said as ONE hit point. Kayki's call, and it means the
 *     figure behaves like every other figure: hurt it and it is gone;
 *   - it does not move once placed. You position it as you put it down and that is the last time it
 *     moves. This is a deliberate exception to "the app shows and never blocks", asked for by name;
 *   - and you may never have more than your cap, so making one beyond it drops your oldest.
 *
 * It reuses the placing machinery the areas use — aim, then place — because it is the same gesture and
 * the same question: where does this go, and is it within reach.
 */
function tblSpawnOnBoard(spec) {
  if (!tbl || !spec) return false;
  tbl.placing = {
    verb: "spawn",
    name: `${spec.of || "Someone"}'s ${spec.name || "figure"}`,
    of: spec.of || "", image: spec.image || "", ofCode: spec.ofCode || "",
    cap: Math.max(0, Number(spec.cap) || 0),
    size: 5 * Math.max(1, Number(spec.size) || 1),   // drawn as a square of its own size, in feet
    shape: "cube", range: Number(spec.range) || 0, rounds: null,
    fromId: tblCasterToken(), x: null, y: null, aimed: false,
  };
  tblClosePanelSoon();
  paintPlacing();
  paintAreas();
  return true;
}

/* Shared with casting: the drawer gets out of the way a tick later, after the sheet has finished with
   itself. See the long note on tblCastOnBoard. */
function tblClosePanelSoon() {
  setTimeout(() => { if (tbl && tbl.placing) tblClosePanel(); }, 0);
}

/* Down it goes as a figure, not an area. */
async function tblSpawnAt(x, y) {
  const p = tbl.placing;
  if (!p) return;
  const size = Math.max(1, Math.round(tblSquares(p.size)));
  const spot = tblFreeSquare("", Math.round(x - size / 2), Math.round(y - size / 2), size, 0, 0);
  tbl.placing = null;
  paintPlacing();
  // Over the cap: the oldest of yours drops, which is what the class says happens.
  const mine = tblClonesOf(p.ofCode);
  if (p.cap && mine.length >= p.cap) {
    const oldest = mine.sort((a, b) => (Number(a[1].at) || 0) - (Number(b[1].at) || 0))[0];
    if (oldest) await CocLive.put(tblPath("tokens/" + oldest[0]), null);
  }
  const id = CocLive.newId();
  await CocLive.put(tblPath("tokens/" + id), {
    name: p.name, image: p.image || "", x: spot.x, y: spot.y, size, kind: "pc", shape: "square",
    hp: 1, hpMax: 1, speed: 0, initMod: 0, owner: tbl.me.clientId,
    spawn: true, spawnOf: p.ofCode || "", at: Date.now(),
  });
  await CocLive.push(tblPath("log"), {
    t: Date.now(), who: p.of || "Someone", kind: "system",
    text: `${p.name} appears${p.cap ? ` (${Math.min(p.cap, mine.length + 1)} of ${p.cap})` : ""}`,
  });
}

/* Everything one character has standing on this scene. */
function tblClonesOf(code) {
  const scene = tblSceneId();
  return Object.entries(tblTokens())
    .filter(([, t]) => t && t.spawn && t.spawnOf === code && (!t.scene || t.scene === scene));
}

/* A spawned figure that has been hurt at all is a spawned figure that is gone — it only ever had the one
   hit point, which is how "a single hit destroys it" is said on a board. Swept by the DM's browser,
   alongside the areas, so it happens once however many people are looking. */
async function tblSpawnsSettle() {
  if (tbl.role !== "dm") return;
  /* AND THEY GO WHEN THE FIGHT DOES. A Clone is the engine — "built during a fight and lost when it
     ends", in the class's own words — and the sheet already empties the meter the moment the DM ends it,
     so leaving the figures standing on the board left the count and the board saying different things.
     They can only be made during a fight in the first place, so a spawned figure with no fight running is
     one the fight has finished with. */
  const fighting = tblRoundNow() > 0;
  for (const [id, t] of Object.entries(tblTokens())) {
    if (!t || !t.spawn) continue;
    if (!fighting || Number(t.hp) <= 0) await CocLive.put(tblPath("tokens/" + id), null);
  }
}
