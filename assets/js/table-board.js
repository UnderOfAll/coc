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
function tblEraseAt(at) {
  const sceneId = tblSceneId();
  const mine = tblNoteOwner();
  const near = 0.012;
  for (const [id, k] of Object.entries(tbl.data.draw || {})) {
    if (!k || k.scene !== sceneId) continue;
    if (tbl.role !== "dm" && k.by !== mine) continue;
    const pts = tblInkDecode(k.pts);
    const hit = pts.some((p, i) => {
      if (Math.hypot(p.x - at.x, p.y - at.y) < near) return true;
      const q = pts[i + 1];
      if (!q) return false;
      // Distance from the point to this SEGMENT, so a long straight line can be rubbed out anywhere along
      // it rather than only where it happened to be sampled.
      const dx = q.x - p.x, dy = q.y - p.y;
      const len = dx * dx + dy * dy;
      if (!len) return false;
      const t = Math.max(0, Math.min(1, ((at.x - p.x) * dx + (at.y - p.y) * dy) / len));
      return Math.hypot(p.x + t * dx - at.x, p.y + t * dy - at.y) < near;
    });
    if (hit) CocLive.del(tblPath("draw/" + id)).catch(() => {});
  }
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
  paintTokens();
  paintRuler();
  paintDrawings();
}

function onPointerDown(e) {
  if (!tbl) return;
  const stage = $("#vtt-stage");
  if (!stage || !stage.contains(e.target)) return;   // the window hears everything; the board owns only itself
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
  // Drawing takes the gesture entirely: while the pen is out, the board is a sheet of paper. That is also
  // why figures cannot be dragged in this mode — you would smear ink every time you missed one.
  if (tblInkState().on && tblCanDraw()) {
    const at = tblInkPoint(p);
    tbl.drag = null;
    if (tblInkState().mode === "erase") { tblEraseAt(at); return; }
    tblTrace("ink start");
    tbl.inking = { points: [at], color: tblInkState().color, width: tblInkState().width };
    paintDrawings();
    if (stage.setPointerCapture) { try { stage.setPointerCapture(e.pointerId); } catch { /* fine */ } }
    return;
  }
  const node = evTarget(e).closest("[data-token]");
  const id = node && node.dataset.token;
  const token = id ? tblTokens()[id] : null;
  if (token && tblCanMove(token)) {
    const at = toSquares(p.sx, p.sy);
    tbl.drag = {
      id, token,
      grabX: at.x - token.x, grabY: at.y - token.y,     // where inside the token you grabbed it
      fromX: token.x, fromY: token.y,
      x: token.x, y: token.y,
    };
    node.classList.add("dragging");
    tblTrace("drag start", id);
  } else {
    tblTrace("pan start");
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
  if (tbl.inking) {
    const at = tblInkPoint(stagePoint(e));
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
  // Everyone else sees the move as it happens, at a rate the database is happy with.
  CocLive.throttled(tblPath("tokens/" + d.id + "/x"), Math.round(d.x * 100) / 100, 110);
  CocLive.throttled(tblPath("tokens/" + d.id + "/y"), Math.round(d.y * 100) / 100, 110);
  paintRuler();
}

function onPointerUp(e) {
  if (!tbl) return;
  tbl.pointers.delete(e.pointerId);
  if (tbl.inking) {
    const stroke = tbl.inking;
    tbl.inking = null;
    if (stroke.points.length) {
      CocLive.push(tblPath("draw"), {
        by: tblNoteOwner(), scene: tblSceneId(), color: stroke.color, width: stroke.width,
        pts: tblInkEncode(stroke.points), at: Date.now(),
      }).catch(tblFail);
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
  tblTrace("figure landed", d.id);
  const size = Math.max(1, Number(d.token.size) || 1);
  const spot = tblFreeSquare(d.id, Math.round(d.x), Math.round(d.y), size, d.fromX, d.fromY);
  CocLive.put(tblPath("tokens/" + d.id + "/x"), spot.x).catch(tblFail);
  CocLive.put(tblPath("tokens/" + d.id + "/y"), spot.y).catch(tblFail);
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
const TBL_DIE_SHAPES = {
  4:   { pts: "50,6 94,88 6,88", inner: "50,6 50,88 M6,88 L50,58 L94,88" },
  6:   { pts: "14,14 86,14 86,86 14,86", inner: "" },
  8:   { pts: "50,4 92,50 50,96 8,50", inner: "8,50 92,50" },
  10:  { pts: "50,3 92,40 50,97 8,40", inner: "8,40 92,40" },
  12:  { pts: "50,4 95,37 78,92 22,92 5,37", inner: "50,30 22,50 33,80 67,80 78,50 50,30" },
  20:  { pts: "50,4 91,27 91,73 50,96 9,73 9,27", inner: "50,26 20,66 80,66 50,26" },
  100: { pts: "50,3 76,11 94,33 94,67 76,89 50,97 24,89 6,67 6,33 24,11", inner: "" },
};
function tblDieFace(sides) {
  const shape = TBL_DIE_SHAPES[sides] || TBL_DIE_SHAPES[6];
  const inner = shape.inner
    ? `<path d="M${shape.inner.split(" ").join(" L").replace(/L M/g, "M")}" class="die-inner" />`
    : "";
  return `<svg class="die-face" viewBox="0 0 100 100" aria-hidden="true">` +
    `<polygon points="${shape.pts}" /></svg>${inner ? `<svg class="die-face" viewBox="0 0 100 100" aria-hidden="true">${inner}</svg>` : ""}`;
}

const TBL_INK_COLOURS = [
  ["#c9a54e", "Gold"], ["#e07a5f", "Red"], ["#6ab04c", "Green"],
  ["#4a90d9", "Blue"], ["#e9e4da", "White"], ["#1a1917", "Black"],
];
const TBL_INK_MAX_POINTS = 400;

function tblInkState() {
  if (!tbl.ui.ink) tbl.ui.ink = { mode: "pen", color: TBL_INK_COLOURS[0][0], width: 2, on: false };
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
    if (pts.length === 1) {
      // A tap is a dot, not nothing — people mark spots.
      return `<circle cx="${(pts[0].x * w).toFixed(1)}" cy="${(pts[0].y * h).toFixed(1)}"
        r="${(width / 2).toFixed(1)}" fill="${esc(k.color || "#c9a54e")}" data-ink="${esc(id)}" />`;
    }
    const d = pts.map((p, i) => `${i ? "L" : "M"}${(p.x * w).toFixed(1)} ${(p.y * h).toFixed(1)}`).join(" ");
    return `<path d="${d}" fill="none" stroke="${esc(k.color || "#c9a54e")}"
      stroke-width="${width.toFixed(1)}" stroke-linecap="round" stroke-linejoin="round"
      data-ink="${esc(id)}" />`;
  };
  const strokes = Object.entries(tbl.data.draw || {})
    .filter(([, k]) => k && k.scene === sceneId)
    .sort((a, b) => (a[1].at || 0) - (b[1].at || 0))
    .map(([id, k]) => path(k, id)).join("");
  const live = tbl.inking && tbl.inking.points.length
    ? path({ pts: tblInkEncode(tbl.inking.points), color: tbl.inking.color, width: tbl.inking.width }, "live")
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
  CocLive.put(tblPath("tokens/" + drag.id + "/moved"), used).catch(() => {});
}

