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
      `${tblDieFace(x.s)}<b>${esc(x.v)}</b><em>d${esc(x.s)}</em></span>`;
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

