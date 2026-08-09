/*
 * Circus of Chaos — the dice
 *
 * Parsing what was asked for, throwing it, saying what happened, and the overlay everybody watches. The
 * roller computes and posts; the log carries the numbers rather than a sentence, so any screen can render
 * the same roll its own way.
 *
 * Part of the table. These files are plain scripts sharing one global scope on purpose: there is no bundler
 * and no build step, so `table.js` loads last and everything it calls is already defined. Split by what a
 * change tends to touch — see RULES.md.
 */

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

/* ---------------------------------------------------------------- dice that are actually dice */

/* Real dice, in three dimensions, tumbling across the screen and landing on the number that was rolled.
 *
 * The load-bearing word is LANDING. The roll is decided before any of this runs — the roller's own
 * generator makes it, the log carries it, and every other screen at the table renders the same numbers.
 * So these dice are told what to land on, and the library is the one in this space that can be told:
 * `3d6@4,5,6` throws three dice and turns them, once they have settled, to the faces we asked for.
 *
 * Which means the rule for using it at all is simple and absolute: **if the dice cannot be made to show
 * the roll, they do not appear.** A d4 shows 3 while the sheet says 1 would be worse than no dice at all.
 * Two things that library cannot do, both checked here rather than hoped about:
 *   - a d4 cannot be turned at all. It lands where the physics put it and reports that instead.
 *   - its d100 is a TENS die — it has no face for 73 — so a percentile roll has nothing to land on.
 * And after every throw the faces are compared with what was asked for. One disagreement and the whole
 * thing is swept away and the flat overlay takes over, which is what happens on a phone with no WebGL,
 * on a slow network, and for anyone who has turned it off.
 *
 * Fetched from the CDN the first time somebody rolls, never as part of loading the page: it is most of a
 * megabyte of physics engine, and a device that never throws a die never pays for it. */
const DICE3D_SRC = "https://cdn.jsdelivr.net/npm/@3d-dice/dice-box-threejs@0.0.12/dist/dice-box-threejs.es.js";
/* The textures, the surfaces and the sounds live in the library's own repository rather than its npm
   package, pinned to a commit so nothing under us can change. */
const DICE3D_ASSETS = "https://cdn.jsdelivr.net/gh/3d-dice/dice-box-threejs@6945e0068eae27f22acd26debdb70f6ef2fd6063/public/";
const DICE3D_SIDES = [4, 6, 8, 10, 12, 20, 100];
const DICE3D_MOST = 30;   // thirty land and settle in a couple of seconds; past that it is a pile of specks
let dice3dBox = null;      // the loaded box, once
let dice3dLoading = null;  // the load in flight, so two quick rolls load it once
let dice3dOff = false;     // it failed, or it is not wanted: stop asking
let dice3dThrow = 0;       // which throw is the current one, so a stale one cannot un-hide the board
/* The faces the physics last settled on, kept after the scene has been emptied. The library forgets a
   throw the moment its world is cleared, and this is the record of what was actually on the table —
   which is the only thing that can be held against the roll in the log and show they agreed. */
let dice3dLanded = [];
/* Which roll is being watched, by its timestamp, while its dice are still in the air. Nothing shows its
   NUMBERS until they stop — otherwise the total is sitting there before the throw has begun and the
   animation is decoration rather than the moment. It holds on this device only: everyone else at the
   table is watching their own dice, or none. */
let dice3dHolding = 0;
function dice3dHeld(entry) {
  return !!(dice3dHolding && entry && entry.t === dice3dHolding);
}
/* Let the numbers out. Every way a roll can END has to come through here — landing, being tapped away,
   timing out, the library throwing — because a hold that is never released is a table whose rolls have
   stopped showing what they were. */
function dice3dRelease() {
  if (!dice3dHolding) return;
  dice3dHolding = 0;
  const node = document.getElementById("roll-stage");
  if (node) node.classList.remove("waiting");
  if (typeof tbl !== "undefined" && tbl && typeof paintLog === "function") {
    try { paintLog(); } catch { /* left the table mid-roll */ }
  }
}

/* ---------------------------------------------------------------- what they look like

   Your dice, on your device — nobody else sees them, so nobody else has to agree. The colours are the
   pen's nine, deliberately: one set of colours for the whole table rather than two vocabularies.

   The DESIGNS are the library's own, drawn onto the faces from images in its repository. They cost one
   small file each, fetched once, and they are the reason to have 3D dice at all — a dragon-scaled d20 is
   the thing people put on the table in front of them. */
const DICE3D_DESIGNS = [
  ["", "Plain"], ["dragon", "Dragon"], ["skulls", "Skulls"], ["fire", "Fire"], ["ice", "Ice"],
  ["marble", "Marble"], ["stars", "Stars"], ["astral", "Astral"], ["stainedglass", "Stained glass"],
  ["water", "Water"], ["wood", "Woodgrain"], ["speckles", "Speckled"], ["glitter", "Glitter"],
  ["lizard", "Lizard"], ["cloudy", "Cloudy"], ["paper", "Paper"],
];
const DICE3D_FINISHES = [["metal", "Metal"], ["none", "Plastic"], ["glass", "Glass"], ["wood", "Wood"],
  ["perfectmetal", "Mirror"]];
/* What the dice are struck on and what they sound like. The material here is about the SOUND, which is
   why it is separate from the finish above — glass dice on a felt table is a real combination. */
const DICE3D_SOUNDS = [["plastic", "Plastic"], ["metal", "Metal"], ["wood", "Wood"], ["coin", "Coin"]];

const DICE3D_DEFAULT = {
  colour: "#c9a54e", label: "#10100f", design: "", finish: "metal", sound: "plastic", loud: 55, quiet: false,
};
let dice3dSeen = null;   // the chosen look, once read
function dice3dLook() {
  if (!dice3dSeen) {
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem("coc:dice-look") || "null"); } catch { saved = null; }
    dice3dSeen = Object.assign({}, DICE3D_DEFAULT, saved && typeof saved === "object" ? saved : {});
  }
  return dice3dSeen;
}
/* Turned into the shape the library wants. A custom colourset carries the design and the finish with it,
   which is why there is one object rather than three settings. */
function dice3dTheme() {
  const look = dice3dLook();
  return {
    theme_customColorset: {
      background: look.colour, foreground: look.label,
      texture: look.design || "none", material: look.finish || "none",
    },
    sounds: !look.quiet,
    volume: Number(look.loud) || 0,
    sound_dieMaterial: look.sound || "plastic",
  };
}
/* Changing the look rebuilds the box: every one of these is read once, when the world is made. The
   module itself is already in the browser's cache, so the second build is quick. */
function dice3dRelook(change) {
  Object.assign(dice3dLook(), change);
  try { localStorage.setItem("coc:dice-look", JSON.stringify(dice3dSeen)); } catch { /* no storage */ }
  dice3dClear(true);
  dice3dBox = null;
  dice3dLoading = null;
  dice3dOff = false;
  const node = document.getElementById("roll-3d");
  if (node) node.innerHTML = "";
  // Built again NOW, not on the next roll. Choosing a colour is the moment you are willing to wait a
  // second; pressing Roll is not, and a world takes a few seconds to make — longer while the previous
  // one is still settling, which is exactly when you are changing it.
  if (dice3dWanted()) dice3dReady();
}

/* Turned off per device, and remembered. A phone that finds them heavy, or a player who wants the roll
   over with, says so once. Kept in memory as well as in storage, so the switch still works in a browser
   that refuses to store anything — it just forgets by the next visit. */
let dice3dSaid = null;
function dice3dChosen() {
  if (dice3dSaid !== null) return dice3dSaid;
  try { return localStorage.getItem("coc:dice3d") !== "off"; } catch { return true; }
}
function dice3dToggle() {
  dice3dSaid = !dice3dChosen();
  try { localStorage.setItem("coc:dice3d", dice3dSaid ? "on" : "off"); } catch { /* no storage */ }
  if (!dice3dSaid) dice3dClear(true);
}

/* Reduced motion means what it says, and a browser with no WebGL would spend the download to fail. */
function dice3dWanted() {
  if (dice3dOff || !dice3dChosen()) return false;
  try {
    if (typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches) return false;
    // Asked of the WINDOW rather than by making a context: jsdom has no canvas at all and reaching for
    // one there is an error in the test log, every roll, for no information — the type either exists or
    // this browser was never going to draw anything. If it exists and still fails, the load below catches
    // it and turns the whole thing off for the session.
    if (typeof WebGLRenderingContext === "undefined") return false;
  } catch { return false; }
  return true;
}

/* A handful this library can be trusted with: all one kind of die, a kind it can be turned to, and few
   enough to see. Mixed handfuls are the remaining exception — the notation parser reads only the first
   group of them, so `1d20@7+2d6@3,4` silently throws the d20 alone. */
function dice3dCanShow(dice) {
  if (!dice.length || dice.length > DICE3D_MOST) return false;
  const sides = Number(dice[0].s);
  return DICE3D_SIDES.includes(sides) && dice.every((d) => Number(d.s) === sides);
}

/* What to throw, and what every die must be showing afterwards.
 *
 * A percentile roll is the interesting one. This library has no hundred-sided die and never did — what
 * it calls a d100 is the TENS die of a real percentile pair, its faces reading 10, 20 … 90, 00. So a 73
 * is thrown the way it is thrown on a table: the tens die on 70 beside a units die on 3. A 7 is the
 * tens die on 00 beside a 7, and a 100 is 00 beside 0, which is exactly the convention everyone already
 * reads. `want` is in the order the dice end up in, tens first, because that is the order they are
 * checked against afterwards. */
function dice3dPlan(dice) {
  const sides = Number(dice[0].s);
  if (sides !== 100) {
    const want = dice.map((d) => Number(d.v));
    return { notation: dice.length + "d" + sides + "@" + want.join(","), extra: "", want };
  }
  const tens = [], units = [];
  for (const d of dice) {
    const v = Number(d.v);
    const ones = v % 10;
    const ten = Math.floor(v / 10) % 10;
    // The face labelled "00" is worth 100 to the library, and the units face labelled "0" is worth 10.
    tens.push(ten === 0 ? 100 : ten * 10);
    units.push(ones === 0 ? 10 : ones);
  }
  return {
    notation: dice.length + "d100@" + tens.join(","),
    extra: dice.length + "d10@" + units.join(","),
    want: tens.concat(units),
  };
}

function dice3dStage() {
  let node = document.getElementById("roll-3d");
  if (!node) {
    node = document.createElement("div");
    node.id = "roll-3d";
    node.className = "roll-3d";
    document.body.appendChild(node);
  }
  return node;
}

/* The library, loaded once and kept. Any failure at all — no network, a blocked CDN, WebGL that says yes
   and then throws — turns the whole feature off for the session rather than being retried on every roll. */
function dice3dReady() {
  if (dice3dBox) return Promise.resolve(dice3dBox);
  if (dice3dLoading) return dice3dLoading;
  dice3dStage();
  const url = DICE3D_SRC;
  /* A deadline, for the same reason the transport has one: the failure that leaves you with no dice for
     the rest of the session is not the one that throws, it is the one that never answers. Building a
     world while the previous one is still animating can do exactly that. Twenty seconds, then the flat
     dice — and the NEXT roll is free to try again rather than being told no forever. */
  const patience = new Promise((_, no) => setTimeout(() => no(new Error("took too long")), 20000));
  dice3dLoading = Promise.race([patience, (async () => {
    let mod;
    // The library itself being unreachable is different from a world that would not build: no amount of
    // rolling will fetch a blocked CDN, so that one is asked once and then left alone.
    try { mod = await import(/* the CDN, at runtime */ url); }
    catch (err) { dice3dOff = true; throw err; }
    const DiceBox = mod.default;
    const box = new DiceBox("#roll-3d", Object.assign({
      assetPath: DICE3D_ASSETS,
      light_intensity: 1.1, gravity_multiplier: 500, baseScale: 110, strength: 2.2, shadows: true,
    }, dice3dTheme()));
    await box.initialize();
    dice3dBox = box;
    return box;
  })()]).catch((err) => {
    // Not latched off: a world that would not build once — most often because the last one was still
    // animating when it was replaced — is worth one more attempt on the next roll.
    dice3dLoading = null;
    try { console.warn("dice: the 3D dice are not ready, using the flat ones —", err && err.message); }
    catch { /* no console */ }
    return null;
  });
  return dice3dLoading;
}

/* Throw them, and answer with one of three words, because the caller must treat them differently:
     "solid" — every die ended on the face it was asked for. Show them.
     "flat"  — they did not, or the throw failed. The flat dice take over, and the real ones go at once.
     "stale" — a NEWER roll has started since. Say nothing and touch nothing: the screen now belongs to
               that roll, and an old throw finishing must not reach into it. */
async function dice3dShow(dice) {
  const mine = ++dice3dThrow;
  const box = await dice3dReady();
  if (!box) return "flat";
  if (mine !== dice3dThrow) return "stale";
  const plan = dice3dPlan(dice);
  const want = plan.want;
  const stage = dice3dStage();
  stage.classList.add("on");
  let faces = [];
  try {
    await box.roll(plan.notation);
    if (plan.extra) await box.add(plan.extra);
    /* Read the faces THEMSELVES, off the dice standing on the table, rather than the summary the library
       hands back. They are not always the same thing: a d4 is turned correctly and then reported as
       whatever the physics had rolled before the turn, which is why d4s used to be refused. `getFaceValue`
       works out which face is up (down, for a d4) from the geometry — it is what is actually on screen,
       and what is on screen is the only thing worth checking. */
    for (const die of box.diceList || []) faces.push(Number(die.getFaceValue().value));
  } catch { faces = []; }
  if (mine !== dice3dThrow) return "stale";
  dice3dLanded = faces;
  const truthful = faces.length === want.length && faces.every((v, i) => v === want[i]);
  // A settled die is READABLE, so a wrong one has to leave immediately — no fade, no frame of it sitting
  // there being wrong. The fade is for dice that told the truth and are simply done.
  if (!truthful) dice3dClear(true);
  return truthful ? "solid" : "flat";
}

/* Take them off the screen. `now` skips the fade, for the two cases where what is on screen is wrong
   rather than finished. `clearDice` is the library's own name for emptying the scene — it has no
   `clear`, and calling one that does not exist would have left every throw's dice in the world. */
function dice3dClear(now) {
  dice3dThrow++;
  const node = document.getElementById("roll-3d");
  if (node) {
    if (now) node.classList.add("at-once");
    node.classList.remove("on");
    if (now) requestAnimationFrame(() => node.classList.remove("at-once"));
  }
  if (dice3dBox && dice3dBox.clearDice) { try { dice3dBox.clearDice(); } catch { /* mid-throw */ } }
}

/* A roll you can WATCH. "17" appearing in a list is information; a die tumbling and landing on 17 is
   the moment everyone looks up for. In three dimensions when the dice can be made to land on the truth,
   and as the flat overlay below otherwise — which is also what a sheet away from a table shows, because
   a roll is a roll.
   Built in JS rather than in index.html because every page can roll, and none of them should have to
   carry the markup for it. */
let tblRollTimers = [];
function tblRollStage() {
  let node = document.getElementById("roll-stage");
  if (!node) {
    node = document.createElement("div");
    node.id = "roll-stage";
    node.className = "roll-stage";
    // Tapping it away has to take the DICE with it. It did not, once: the box went and a screenful of
    // settled dice stayed behind it, unclickable because they ignore the pointer, until the next roll.
    node.addEventListener("click", () => {
      node.classList.remove("on"); dice3dRelease(); dice3dClear(true);
    });
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
      `${tblDieFace(x.s)}<b>${esc(x.v)}</b><em>d${esc(x.s)}</em></span>`;
  }).join("");
  const spec = entry.spec
    || tblSpecText({ terms: dice.map((x) => ({ count: 1, sides: x.s, sign: 1 })), mod });
  /* The 3D throw runs BESIDE the flat one, not instead of it: the flat dice tumble immediately while the
     library is still being fetched, and are hidden only once real dice are actually on the table. Nothing
     waits on the network to see a roll. */
  const solid = dice3dWanted() && dice3dCanShow(dice);
  node.className = "roll-stage on rolling " + nat;
  node.innerHTML = `<div class="roll-box">
    <p class="roll-head"><strong>${esc(entry.who || "Someone")}</strong>${
      entry.label ? ` &middot; ${esc(entry.label)}` : ""}</p>
    <div class="roll-dice">${faces}</div>
    ${keptIdx >= 0 && dice[keptIdx] ? `<p class="roll-kept only-3d">kept ${esc(dice[keptIdx].v)}${
      dice.filter((_, i) => i !== keptIdx).map((d) => ` &middot; ${esc(d.v)} dropped`).join("")}</p>` : ""}
    <p class="roll-sum">
      <span class="roll-spec">${esc(spec)}${
        entry.mode === "adv" ? " · advantage" : entry.mode === "dis" ? " · disadvantage" : ""}</span>
      ${dice.length > 1 || mod ? `<span class="roll-total">${esc(entry.total)}</span>`
        // With real dice the flat row is hidden, so a lone d20 with no modifier would have no number in
        // the box at all — and that is the commonest roll in the game. It gets one, for the 3D case only.
        : `<span class="roll-total only-3d">${esc(entry.total)}</span>`}
    </p>
  </div>`;
  // The tumble: real dice do not fade in, they clatter. Each settles within its OWN range, so a d4 in a
  // mixed handful never flashes a 17 on its way to landing.
  const shown = [...node.querySelectorAll(".die")];
  let ticks = 0;
  const spin = setInterval(() => {
    ticks += 1;
    for (const die of shown) {
      const sides = Number(asEl(die).dataset.sides) || 20;
      die.querySelector("b").textContent = String(1 + Math.floor(Math.random() * sides));
    }
    if (ticks > 9) {
      clearInterval(spin);
      for (const die of shown) die.querySelector("b").textContent = asEl(die).dataset.final;
      node.classList.remove("rolling");
      node.classList.add("landed");
    }
  }, 55);
  const away = () => { node.classList.remove("on"); dice3dRelease(); dice3dClear(); };
  tblRollTimers.push(setTimeout(away, 3200));

  if (!solid) { dice3dClear(); return; }
  /* NO roll waits on the network. The first one throws the flat dice and starts fetching the library in
     the background; every roll after that is a real one. A device that never rolls never fetches it, and
     nobody ever watches a spinner where a die should be. */
  if (!dice3dBox) { dice3dReady(); dice3dClear(); return; }

  // Real dice from here: the flat row is not drawn at all, the total shows at once exactly as it always
  // has, and the dice land underneath it a couple of seconds later.
  // The numbers go away until the dice stop. This is the point of throwing them at all: a total that is
  // already on screen makes the animation something to sit through rather than something to watch.
  node.classList.add("with-3d", "waiting");
  dice3dHolding = entry.t || 0;
  if (tbl && typeof paintLog === "function") { try { paintLog(); } catch { /* not at a table */ } }
  for (const t of tblRollTimers) clearTimeout(t);
  tblRollTimers = [];
  dice3dShow(dice).then((how) => {
    if (how !== "stale") dice3dRelease();
    // "stale" means a newer roll owns the screen now. Touching anything here would reach into ITS
    // overlay — stripping a class it needs, or scheduling a hide that goes off early.
    if (how === "stale" || !node.classList.contains("on")) return;
    // They could not be made to show the roll: put the flat dice back, which have been tumbling behind
    // the whole time and are already sitting on the right numbers.
    if (how !== "solid") node.classList.remove("with-3d");
    tblRollTimers.push(setTimeout(away, how === "solid" ? 2600 : 2000));
  }).catch(() => {
    // Nothing above is allowed to leave the overlay stuck on screen with no way down — or, worse, to
    // leave the roll's own numbers withheld from the table for good.
    dice3dRelease();
    node.classList.remove("with-3d");
    dice3dClear(true);
    tblRollTimers.push(setTimeout(away, 1600));
  });
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
  const look = dice3dLook();
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
      <p class="panel-sub">Your dice <span class="muted">— on this device, nobody else sees them</span></p>
      <div class="chips">
        <button class="chip ${dice3dChosen() ? "on" : ""}" data-tbl="dice-3d">${
          dice3dChosen() ? "Rolling in 3D" : "Flat dice"}</button>
        ${dice3dChosen() ? `<button class="chip ${look.quiet ? "" : "on"}" data-tbl="dice-sound">${
          look.quiet ? "Silent" : "Sound on"}</button>` : ""}
      </div>
      ${dice3dChosen() ? `
        <p class="panel-sub">Colour</p>
        <div class="chips">${TBL_INK_COLOURS.map(([hex, name]) =>
          `<button class="chip ${look.colour === hex ? "on" : ""}" data-tbl="dice-colour" data-val="${esc(hex)}"
            title="${esc(name)}"><span class="ink-dot" style="background:${esc(hex)}"></span>${esc(name)}</button>`
          ).join("")}</div>
        <p class="panel-sub">Numbers</p>
        <div class="chips">${[["#10100f", "Dark"], ["#f2efe6", "Light"], ["#c9a54e", "Gold"],
            ["#d94f43", "Red"]].map(([hex, name]) =>
          `<button class="chip ${look.label === hex ? "on" : ""}" data-tbl="dice-label" data-val="${esc(hex)}"
            title="${esc(name)}"><span class="ink-dot" style="background:${esc(hex)}"></span>${esc(name)}</button>`
          ).join("")}</div>
        <p class="panel-sub">Design</p>
        <div class="chips">${DICE3D_DESIGNS.map(([id, name]) =>
          `<button class="chip ${look.design === id ? "on" : ""}" data-tbl="dice-design" data-val="${esc(id)}"
            >${esc(name)}</button>`).join("")}</div>
        <p class="panel-sub">Finish</p>
        <div class="chips">${DICE3D_FINISHES.map(([id, name]) =>
          `<button class="chip ${look.finish === id ? "on" : ""}" data-tbl="dice-finish" data-val="${esc(id)}"
            >${esc(name)}</button>`).join("")}</div>
        ${look.quiet ? "" : `<p class="panel-sub">They sound like</p>
          <div class="chips">${DICE3D_SOUNDS.map(([id, name]) =>
            `<button class="chip ${look.sound === id ? "on" : ""}" data-tbl="dice-clack" data-val="${esc(id)}"
              >${esc(name)}</button>`).join("")}</div>`}
        <p class="muted">Real dice, thrown across the screen, landing on the roll that was made — the number
          is held back until they stop. A mixed handful keeps the flat ones, since they cannot all be thrown
          at once.</p>`
      : `<p class="muted">The flat overlay, which is quicker and asks nothing of the device.</p>`}
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
  // Its dice are still rolling on this screen. Saying who is throwing what is the whole of what the bar
  // may give away until they stop.
  if (dice3dHeld(e)) {
    return `<strong>${esc(e.who || "Someone")}</strong>${e.label ? " " + esc(e.label) : ""}` +
      `<span class="roll-waiting">${esc(e.spec || "")} &middot; rolling&hellip;</span>`;
  }
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

