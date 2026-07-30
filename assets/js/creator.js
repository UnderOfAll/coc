/*
 * Circus of Chaos — character creation, management, and the live play sheet.
 *
 * Loaded after app.js, so every helper there (esc, fmtDesc, el, $, store, idx, className, …) is
 * available. This file owns three routes, registered into COC_ROUTES at the bottom:
 *   #/create        the builder
 *   #/manage        open or delete a character by its six-digit code
 *   #/sheet/<code>  the live sheet, including combat tracking
 *
 * A CHARACTER is plain JSON — no classes, no methods — so it can be stringified into localStorage or
 * a cloud row unchanged, and so an old save never breaks when this file grows. Everything derived
 * (HP, AC, save DC, engine cap, the trick list, the feature ladder) is COMPUTED from the class data
 * at render time by derive(), never stored. That way a balance change to a class immediately reaches
 * every existing character instead of leaving stale numbers on old sheets.
 */

/* ---------------------------------------------------------------- rules maths */

const ABILITIES = ["Strength", "Dexterity", "Constitution", "Intelligence", "Wisdom", "Charisma"];
const ABIL_SHORT = { Strength: "STR", Dexterity: "DEX", Constitution: "CON", Intelligence: "INT", Wisdom: "WIS", Charisma: "CHA" };
const STANDARD_ARRAY = [15, 14, 13, 12, 10, 8];
/* 5e point-buy costs. 27 points, nothing above 15 — and there are no racial bonuses in this system
   (MECHANICS §2.3), so 15 really is the creation ceiling. */
const POINT_COST = { 8: 0, 9: 1, 10: 2, 11: 3, 12: 4, 13: 5, 14: 7, 15: 9 };
const POINT_BUDGET = 27;

function abilMod(score) { return Math.floor((Number(score) - 10) / 2); }
function profBonus(level) { return 2 + Math.floor((Math.max(1, Math.min(20, level)) - 1) / 4); }
/* Average of a die, rounded up: d6→4, d8→5, d10→6, d12→7 (MECHANICS §2.4). */
function dieAverage(die) { return Math.floor(Number(die) / 2) + 1; }
const ASI_LEVELS = [4, 8, 12, 16, 19];

/* Uses per combat on the scaling ladder (MECHANICS §2.2). */
function scalingUses(level) { return level >= 17 ? 4 : level >= 11 ? 3 : level >= 5 ? 2 : 1; }

/* Everything the sheet shows, computed fresh from the class data every time. */
function derive(ch) {
  const cls = idx.classes.get(ch.classId);
  if (!cls) return null;
  const level = Math.max(1, Math.min(20, Number(ch.level) || 1));
  const scores = ch.scores || {};
  const mods = {};
  for (const a of ABILITIES) mods[a] = abilMod(scores[a] ?? 10);

  const prof = profBonus(level);
  const conMod = mods.Constitution;

  // HP: max die + Con at 1st, then average rounded up + Con, minimum 1 per level.
  let hpMax = Number(cls.hitDie) + conMod;
  for (let l = 2; l <= level; l++) hpMax += Math.max(1, dieAverage(cls.hitDie) + conMod);
  hpMax = Math.max(1, hpMax);

  const primary = cls.primaryAbility;
  const armor = ch.armorId ? idx.armorById.get(ch.armorId) : null;
  const shield = ch.shieldId ? idx.armorById.get(ch.shieldId) : null;

  // AC: armour base + capped Dex, or 10 + Dex unarmoured, plus any shield.
  let ac, acNote;
  if (armor) {
    const cap = armor.maxDexBonus;
    const dex = cap == null ? mods.Dexterity : Math.min(mods.Dexterity, cap);
    ac = Number(armor.baseAC) + dex;
    acNote = `${armor.name} ${armor.baseAC} ${dex >= 0 ? "+" : "−"} ${Math.abs(dex)} Dex`;
  } else {
    ac = 10 + mods.Dexterity;
    acNote = `unarmoured 10 ${mods.Dexterity >= 0 ? "+" : "−"} ${Math.abs(mods.Dexterity)} Dex`;
  }
  if (shield) { ac += Number(shield.acBonus || 0); acNote += ` + ${shield.acBonus} ${shield.name}`; }

  const subclass = ch.subclassId ? idx.subclasses.get(ch.subclassId) : null;

  // Features: class features up to this level, plus the chosen subclass's.
  const features = (cls.features || []).filter((f) => (f.level || 1) <= level)
    .map((f) => Object.assign({ _from: cls.name }, f));
  if (subclass) {
    for (const f of subclass.features || []) {
      if ((f.level || 1) <= level) features.push(Object.assign({ _from: subclass.name }, f));
    }
  }
  features.sort((a, b) => (a.level || 1) - (b.level || 1) || String(a.name).localeCompare(b.name));

  // Tricks: the class list plus anything the chosen subclass grants, each gated by the later of
  // its own minLevel and the class's casting start level (and the subclass level for granted ones).
  const grade = (typeof CASTER_GRADE !== "undefined") ? CASTER_GRADE[cls.id] : null;
  const tricks = [];
  if (grade) {
    const subLv = cls.subclassLevel || 3;
    for (const t of store.tricks || []) {
      const onClass = (t.classes || []).includes(cls.id);
      if (!onClass) continue;
      const grantedBy = (t.subclasses || []);
      if (grantedBy.length) {
        if (!subclass || !grantedBy.includes(subclass.id || subclass.name)) continue;
        const at = Math.max(t.minLevel || 1, grade.startsAt, subLv);
        if (at <= level) tricks.push(Object.assign({ _at: at, _granted: true }, t));
      } else {
        const at = Math.max(t.minLevel || 1, grade.startsAt);
        if (at <= level) tricks.push(Object.assign({ _at: at, _granted: false }, t));
      }
    }
    tricks.sort((a, b) => a._at - b._at || TIER_ORDER[a.tier] - TIER_ORDER[b.tier] || a.name.localeCompare(b.name));
  }

  const engine = cls.engine || null;
  let engineCap = null;
  if (engine && engine.capMath) {
    const m = engine.capMath;
    engineCap = (m.base || 0) + (m.prof ? m.prof * prof : 0) + (m.ability ? (mods[m.ability] || 0) : 0);
    if (m.min != null) engineCap = Math.max(m.min, engineCap);
    if (m.bonusAtLevel5 && level >= 5) engineCap += m.bonusAtLevel5;
    engineCap = Math.max(0, engineCap);
  }

  const weapons = (cls.proficiencies?.weapons || []).map((n) => idx.weaponsByName.get(n)).filter(Boolean);

  return {
    cls, subclass, level, prof, mods, hpMax, ac, acNote, features, tricks, engine, engineCap, weapons,
    armor, shield,
    saveDC: 8 + prof + (mods[primary] ?? 0),
    attackBonus: prof + (mods[primary] ?? 0),
    parryDC: cls.parryBaseDC,
    primary,
    asiCount: ASI_LEVELS.filter((l) => l <= level).length,
    scalingUses: scalingUses(level),
  };
}

/* ---------------------------------------------------------------- shared UI helpers */

/* The draft being built, and the character being played. Both are plain JSON. */
let draft = null;
let sheet = null;      // { code, ch } while a sheet is open

function toolEl() { return $("#tool"); }
function paint(html) { toolEl().innerHTML = html; }

function armorFor(cls) {
  const prof = (cls.proficiencies?.armor || []).map((a) => a.toLowerCase());
  const cats = new Set();
  cats.add("clothing");                                   // needs no proficiency, always allowed
  if (prof.some((p) => p.startsWith("light"))) cats.add("light");
  if (prof.some((p) => p.startsWith("medium"))) cats.add("medium");
  if (prof.some((p) => p.startsWith("heavy"))) cats.add("heavy");
  const shields = prof.some((p) => p.startsWith("shield"));
  const wearable = (store.armor || []).filter((a) => a.category !== "shield" && cats.has(a.category));
  return { wearable, shields: shields ? (store.armor || []).filter((a) => a.category === "shield") : [] };
}

function acOf(armor, dexMod) {
  if (!armor) return 10 + dexMod;
  const cap = armor.maxDexBonus;
  return Number(armor.baseAC) + (cap == null ? dexMod : Math.min(dexMod, cap));
}

/* A six-digit code the player did not have to invent. Avoids all-same and sequential runs. */
function suggestCode() {
  let c;
  do { c = String(Math.floor(Math.random() * 1e6)).padStart(6, "0"); }
  while (/^(\d)\1{5}$/.test(c) || "0123456789".includes(c));
  return c;
}

/* Codes this browser has seen, so Manage can offer them without a cloud listing. */
const RECENT_KEY = "coc:recent";
function recentCodes() {
  try { return JSON.parse(localStorage.getItem(RECENT_KEY) || "[]"); } catch { return []; }
}
function rememberCode(code, name) {
  const list = recentCodes().filter((r) => r.code !== code);
  list.unshift({ code, name, at: Date.now() });
  localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, 12)));
}

/* ---------------------------------------------------------------- the creator */

function blankDraft() {
  return {
    v: 1, name: "", classId: "", subclassId: "", level: 1, size: "",
    method: "array", scores: {}, pool: STANDARD_ARRAY.slice(),
    skills: [], armorId: "", shieldId: "", photo: "", notes: "",
  };
}

function routeCreate() {
  if (!draft) draft = blankDraft();
  renderCreator();
}

function renderCreator() {
  const cls = draft.classId ? idx.classes.get(draft.classId) : null;
  paint(`
    <div class="tool-head">
      <a class="back" href="#/">&larr; Menu</a>
      <h1>Create a character</h1>
      <p class="muted">Nothing is saved until you choose a code at the end. Every number on the right
        is worked out from the rules as you go — you never type a total.</p>
    </div>
    <div class="creator">
      <div class="creator-main">
        ${stepClass()}
        ${cls ? stepBasics(cls) : ""}
        ${cls ? stepAbilities(cls) : ""}
        ${cls ? stepSkills(cls) : ""}
        ${cls ? stepGear(cls) : ""}
        ${cls ? stepIdentity() : ""}
      </div>
      <aside class="creator-side">${sidePreview()}</aside>
    </div>
    ${cls ? stepSave() : ""}
  `);
}

function stepClass() {
  const cards = (store.classes || []).map((c) => {
    const on = draft.classId === c.id;
    return `<button class="pick ${on ? "on" : ""}" data-pick="class" data-val="${esc(c.id)}">
      <span class="pick-title">${esc(c.name)}</span>
      <span class="pick-sub">d${esc(c.hitDie)} · ${esc(c.primaryAbility)} · Parry ${esc(c.parryBaseDC)}</span>
      <span class="pick-flavor">${esc((c.flavor || "").slice(0, 90))}</span>
    </button>`;
  }).join("");
  return `<section class="step"><h2>1 · Class</h2><div class="pick-grid">${cards}</div></section>`;
}

function stepBasics(cls) {
  const sizes = (cls.sizes || ["Small", "Medium"]).map((s) =>
    `<button class="chip ${draft.size === s ? "on" : ""}" data-pick="size" data-val="${esc(s)}">${esc(s)}</button>`).join("");
  const subLv = cls.subclassLevel || 3;
  const subs = (store.subclasses || []).filter((s) => s.parentClass === cls.id);
  const subPick = draft.level >= subLv
    ? `<label class="field-label">${esc(cls.features.find((f) => /Discipline|Repertoire|Act|Archetype/i.test(f.name))?.name || "Subclass")}</label>
       <div class="chips">${subs.map((s) =>
         `<button class="chip ${draft.subclassId === s.id ? "on" : ""}" data-pick="subclass" data-val="${esc(s.id)}">${esc(s.name)}</button>`).join("")}</div>`
    : `<p class="muted">You choose a subclass at level ${esc(subLv)}.</p>`;
  return `<section class="step"><h2>2 · Level &amp; size</h2>
    <label class="field-label">Level <span class="muted">(features stop at 5 for now)</span></label>
    <input id="lvl" class="num" type="number" min="1" max="20" value="${esc(draft.level)}" />
    <label class="field-label">Size</label><div class="chips">${sizes}</div>
    ${subPick}</section>`;
}

function stepAbilities(cls) {
  const m = draft.method;
  const tabs = [["array", "Standard array"], ["buy", "Point buy"], ["manual", "Manual"]].map(([k, l]) =>
    `<button class="toggle-btn ${m === k ? "active" : ""}" data-pick="method" data-val="${k}">${l}</button>`).join("");
  const spent = ABILITIES.reduce((n, a) => n + (POINT_COST[draft.scores[a]] ?? 0), 0);
  const rows = ABILITIES.map((a) => {
    const v = draft.scores[a] ?? "";
    const isPrimary = a === cls.primaryAbility;
    const mod = v === "" ? "" : (abilMod(v) >= 0 ? "+" : "") + abilMod(v);
    let control;
    if (m === "array") {
      const used = ABILITIES.filter((x) => x !== a).map((x) => draft.scores[x]);
      const opts = ["", ...STANDARD_ARRAY].map((n) => {
        const taken = n !== "" && used.filter((u) => u === n).length >= STANDARD_ARRAY.filter((s) => s === n).length;
        return `<option value="${n}" ${String(draft.scores[a]) === String(n) ? "selected" : ""} ${taken ? "disabled" : ""}>${n === "" ? "—" : n}</option>`;
      }).join("");
      control = `<select class="num" data-abil="${a}">${opts}</select>`;
    } else if (m === "buy") {
      control = `<select class="num" data-abil="${a}">${Object.keys(POINT_COST).map((n) =>
        `<option value="${n}" ${String(draft.scores[a]) === n ? "selected" : ""}>${n}</option>`).join("")}</select>`;
    } else {
      control = `<input class="num" type="number" min="3" max="20" data-abil="${a}" value="${esc(v)}" />`;
    }
    return `<div class="abil ${isPrimary ? "primary" : ""}">
      <span class="abil-name">${esc(ABIL_SHORT[a])}${isPrimary ? ' <span class="tag">primary</span>' : ""}</span>
      ${control}<span class="abil-mod">${esc(mod)}</span></div>`;
  }).join("");
  return `<section class="step"><h2>3 · Ability scores</h2>
    <div class="group-toggle">${tabs}</div>
    ${m === "buy" ? `<p class="muted">Spent <strong>${spent}</strong> of ${POINT_BUDGET} points. Nothing starts above 15 — there are no races to raise it.</p>` : ""}
    ${m === "array" ? `<p class="muted">Assign 15, 14, 13, 12, 10 and 8 in any order.</p>` : ""}
    ${m === "manual" ? `<p class="muted">Type what your table rolled. Nothing is validated beyond 3–20.</p>` : ""}
    <div class="abils">${rows}</div></section>`;
}

function stepSkills(cls) {
  const parsed = parseSkillChoice(cls.proficiencies?.skills);
  if (!parsed || !parsed.skills.length) return "";
  const need = parsed.count || 2;
  const chips = parsed.skills.map((s) => {
    const on = draft.skills.includes(s);
    const full = draft.skills.length >= need && !on;
    const sk = idx.skillsByName.get(s.toLowerCase());
    const abil = sk ? ` <span class="muted">(${esc(ABIL_SHORT[sk.ability] || sk.ability)})</span>` : "";
    return `<button class="chip ${on ? "on" : ""}" ${full ? "disabled" : ""} data-pick="skill" data-val="${esc(s)}">${esc(s)}${abil}</button>`;
  }).join("");
  return `<section class="step"><h2>4 · Skills</h2>
    <p class="muted">Choose ${need}. <strong>${draft.skills.length}/${need}</strong> chosen.</p>
    <div class="chips">${chips}</div></section>`;
}

function stepGear(cls) {
  const { wearable, shields } = armorFor(cls);
  const dex = abilMod(draft.scores.Dexterity ?? 10);
  const byCat = {};
  for (const a of wearable.filter((a) => a.availability !== "bought")) (byCat[a.category] ||= []).push(a);
  const blocks = ["clothing", "light", "medium", "heavy"].filter((c) => byCat[c]).map((c) => {
    const items = byCat[c].sort((x, y) => x.baseAC - y.baseAC).map((a) =>
      `<button class="chip ${draft.armorId === a.id ? "on" : ""}" data-pick="armor" data-val="${esc(a.id)}">
        ${esc(a.name)} <span class="muted">AC ${acOf(a, dex)}${a.trait ? " · " + esc(a.trait) : ""}</span></button>`).join("");
    return `<div class="sub-block"><h3 class="sub-title">${esc(cap(c))}</h3><div class="chips">${items}</div></div>`;
  }).join("");
  const shieldBlock = shields.length ? `<div class="sub-block"><h3 class="sub-title">Shield</h3><div class="chips">
      ${shields.filter((s) => s.availability !== "bought").map((s) =>
        `<button class="chip ${draft.shieldId === s.id ? "on" : ""}" data-pick="shield" data-val="${esc(s.id)}">${esc(s.name)} <span class="muted">+${esc(s.acBonus)}</span></button>`).join("")}
      </div></div>` : "";
  const weps = (cls.proficiencies?.weapons || []).map((n) => {
    const w = idx.weaponsByName.get(n);
    return w ? `<li>${esc(w.name)} <span class="muted">${esc(w.damage.die)} ${esc(w.damage.type)}${w.mastery ? " · " + esc(w.mastery) : ""}</span></li>` : `<li>${esc(n)}</li>`;
  }).join("");
  return `<section class="step"><h2>5 · Gear</h2>
    <p class="muted">Starter gear is free. The bought tier exists but your DM awards it in play — there is no money yet.</p>
    ${blocks}${shieldBlock}
    <div class="sub-block"><h3 class="sub-title">Weapons <span class="sub-note">— granted by your class</span></h3>
      <ul class="plain">${weps}</ul></div></section>`;
}

function stepIdentity() {
  return `<section class="step"><h2>6 · Identity</h2>
    <label class="field-label">Name</label>
    <input id="cname" class="text" type="text" maxlength="40" value="${esc(draft.name)}" placeholder="Who are they?" />
    <label class="field-label">Portrait <span class="muted">(optional — stored with the character)</span></label>
    <div class="portrait-row">
      ${draft.photo ? `<img class="portrait" src="${esc(draft.photo)}" alt="" />` : `<div class="portrait empty">no image</div>`}
      <div><input id="photo" type="file" accept="image/*" />
      ${draft.photo ? `<button class="btn-quiet" data-pick="clearphoto" data-val="1">Remove</button>` : ""}</div>
    </div>
    <label class="field-label">Notes <span class="muted">(appearance, background — anything you like)</span></label>
    <textarea id="notes" class="text" rows="3" placeholder="Free text. No mechanical weight.">${esc(draft.notes)}</textarea>
  </section>`;
}

/* Live numbers beside the form. Everything here is derived, never typed. */
function sidePreview() {
  const d = derive(draft);
  if (!d) return `<div class="side-card muted">Pick a class to see your numbers.</div>`;
  const row = (l, v, note) => `<div class="side-row"><span>${esc(l)}</span><strong>${esc(v)}</strong>${note ? `<em>${esc(note)}</em>` : ""}</div>`;
  const missing = validateDraft(d);
  return `<div class="side-card">
    <h3>${esc(draft.name || "Unnamed")}</h3>
    <p class="muted">${esc(d.cls.name)}${d.subclass ? " · " + esc(d.subclass.name) : ""} · level ${esc(d.level)}${draft.size ? " · " + esc(draft.size) : ""}</p>
    ${row("Hit points", d.hpMax)}
    ${row("Armour Class", d.ac, d.acNote)}
    ${row("Proficiency", (d.prof >= 0 ? "+" : "") + d.prof)}
    ${row("Save DC", d.saveDC, "8 + prof + " + ABIL_SHORT[d.primary])}
    ${row("Attack bonus", (d.attackBonus >= 0 ? "+" : "") + d.attackBonus, "prof + " + ABIL_SHORT[d.primary])}
    ${row("Parry DC", d.parryDC, "lower is better")}
    ${d.engine ? row(d.engine.name + " cap", d.engineCap) : ""}
    ${d.tricks.length ? row("Tricks known", d.tricks.length) : ""}
    ${row("Features", d.features.length)}
    ${missing.length ? `<div class="side-todo"><strong>Still to do</strong><ul>${missing.map((m) => `<li>${esc(m)}</li>`).join("")}</ul></div>`
      : `<div class="side-ok">Ready to save.</div>`}
  </div>`;
}

/* What is still missing before this can be saved. Returned as plain sentences, not codes. */
function validateDraft(d) {
  const out = [];
  if (!draft.classId) out.push("Choose a class.");
  if (!draft.size) out.push("Choose a size.");
  const cls = d && d.cls;
  if (cls && draft.level >= (cls.subclassLevel || 3) && !draft.subclassId) out.push("Choose a subclass.");
  const unset = ABILITIES.filter((a) => !draft.scores[a]);
  if (unset.length) out.push(`Set ${unset.length} more ability score${unset.length === 1 ? "" : "s"}.`);
  if (draft.method === "buy") {
    const spent = ABILITIES.reduce((n, a) => n + (POINT_COST[draft.scores[a]] ?? 0), 0);
    if (spent > POINT_BUDGET) out.push(`Point buy is over budget by ${spent - POINT_BUDGET}.`);
  }
  const parsed = cls ? parseSkillChoice(cls.proficiencies?.skills) : null;
  const need = parsed?.count || 2;
  if (parsed && parsed.skills.length && draft.skills.length < need) out.push(`Choose ${need - draft.skills.length} more skill${need - draft.skills.length === 1 ? "" : "s"}.`);
  if (!draft.armorId) out.push("Choose an armour (or clothing).");
  if (!String(draft.name).trim()) out.push("Give them a name.");
  return out;
}

function stepSave() {
  const d = derive(draft);
  const missing = d ? validateDraft(d) : ["Choose a class."];
  const code = draft._code || (draft._code = suggestCode());
  return `<section class="step step-save">
    <h2>7 · Save</h2>
    <p class="muted">Pick any six digits you will remember — that code <em>is</em> your character.
      Anyone with it can open the sheet from any device, so keep it to your table.</p>
    <div class="save-row">
      <input id="code" class="code-input" inputmode="numeric" maxlength="6" value="${esc(code)}" />
      <button class="btn-quiet" data-pick="reroll" data-val="1">Suggest another</button>
      <button id="save-btn" class="btn" ${missing.length ? "disabled" : ""}>Save character</button>
    </div>
    ${missing.length ? `<p class="muted">${esc(missing.length)} thing${missing.length === 1 ? "" : "s"} still to do — see the panel.</p>` : ""}
    <p id="save-msg" class="save-msg"></p>
  </section>`;
}

/* ---------------------------------------------------------------- creator events */

function creatorClick(e) {
  const b = e.target.closest("[data-pick]");
  if (!b || b.disabled) return;
  const { pick, val } = b.dataset;
  if (pick === "class") {
    draft.classId = draft.classId === val ? "" : val;
    draft.subclassId = ""; draft.armorId = ""; draft.shieldId = ""; draft.skills = [];
    const cls = idx.classes.get(draft.classId);
    if (cls && (cls.sizes || []).length === 1) draft.size = cls.sizes[0];
    else if (cls && !(cls.sizes || []).includes(draft.size)) draft.size = "";
  } else if (pick === "size") draft.size = val;
  else if (pick === "subclass") draft.subclassId = draft.subclassId === val ? "" : val;
  else if (pick === "method") {
    draft.method = val;
    draft.scores = val === "buy" ? Object.fromEntries(ABILITIES.map((a) => [a, 8])) : {};
  } else if (pick === "skill") {
    draft.skills = draft.skills.includes(val) ? draft.skills.filter((s) => s !== val) : draft.skills.concat(val);
  } else if (pick === "armor") draft.armorId = draft.armorId === val ? "" : val;
  else if (pick === "shield") draft.shieldId = draft.shieldId === val ? "" : val;
  else if (pick === "clearphoto") draft.photo = "";
  else if (pick === "reroll") draft._code = suggestCode();
  renderCreator();
}

function creatorInput(e) {
  const t = e.target;
  if (t.id === "lvl") { draft.level = Math.max(1, Math.min(20, Number(t.value) || 1)); renderCreator(); }
  else if (t.dataset.abil) {
    const v = t.value === "" ? undefined : Number(t.value);
    if (v === undefined) delete draft.scores[t.dataset.abil]; else draft.scores[t.dataset.abil] = v;
    renderCreator();
  } else if (t.id === "cname") { draft.name = t.value; toolEl().querySelector(".creator-side").innerHTML = sidePreview(); }
  else if (t.id === "notes") draft.notes = t.value;
  else if (t.id === "code") { draft._code = t.value.replace(/\D/g, "").slice(0, 6); delete draft._overwrite; }
}

/* Portraits are stored inline with the character, so they must be small. Downscale to 256px and
   re-encode as JPEG before anything touches storage — a phone photo is several megabytes and would
   make every save and load crawl. */
function readPortrait(file, done) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    const img = new Image();
    img.onload = () => {
      const side = 256;
      const c = document.createElement("canvas");
      c.width = c.height = side;
      const ctx = c.getContext("2d");
      const scale = Math.max(side / img.width, side / img.height);
      const w = img.width * scale, h = img.height * scale;
      ctx.drawImage(img, (side - w) / 2, (side - h) / 2, w, h);
      done(c.toDataURL("image/jpeg", 0.75));
    };
    img.onerror = () => done("");
    img.src = reader.result;
  };
  reader.readAsDataURL(file);
}

async function saveDraft() {
  const msg = $("#save-msg");
  const code = String(draft._code || "");
  if (!CocStore.validCode(code)) { msg.textContent = "A code must be exactly six digits."; msg.className = "save-msg bad"; return; }
  const d = derive(draft);
  const missing = d ? validateDraft(d) : ["Choose a class."];
  if (missing.length) {
    msg.textContent = "Not saved — " + missing[0].charAt(0).toLowerCase() + missing[0].slice(1);
    msg.className = "save-msg bad";
    return;
  }
  msg.textContent = "Saving…"; msg.className = "save-msg";
  try {
    const existing = await CocStore.load(code);
    if (existing && existing.name && draft._overwrite !== code) {
      // Two-step rather than confirm(): a native dialog is blocked in some contexts, cannot be
      // styled, and cannot be driven by a test.
      draft._overwrite = code;
      msg.innerHTML = `Code <strong>${esc(code)}</strong> already holds <strong>${esc(existing.name)}</strong>. ` +
        `Press <em>Save character</em> again to overwrite it, or change the code.`;
      msg.className = "save-msg bad";
      return;
    }
    const ch = Object.assign({}, draft);
    delete ch._code; delete ch._overwrite;
    ch.savedAt = Date.now();
    ch.play = freshPlay(ch);
    await CocStore.save(code, ch);
    rememberCode(code, ch.name);
    msg.innerHTML = `Saved. Your code is <strong>${esc(code)}</strong> — opening the sheet…`;
    msg.className = "save-msg good";
    setTimeout(() => { location.hash = "#/sheet/" + code; }, 700);
  } catch (err) {
    console.error(err);
    msg.textContent = "Could not save: " + err.message;
    msg.className = "save-msg bad";
  }
}

/* ---------------------------------------------------------------- manage */

function routeManage() {
  const recent = recentCodes();
  paint(`
    <div class="tool-head">
      <a class="back" href="#/">&larr; Menu</a>
      <h1>My characters</h1>
      <p class="muted">${esc(CocStore.describe())}</p>
    </div>
    <section class="step">
      <label class="field-label">Open by code</label>
      <div class="save-row">
        <input id="open-code" class="code-input" inputmode="numeric" maxlength="6" placeholder="000000" />
        <button id="open-btn" class="btn">Open</button>
      </div>
      <p id="open-msg" class="save-msg"></p>
    </section>
    ${recent.length ? `<section class="step"><h2>Recent on this device</h2>
      <div class="recent">${recent.map((r) => `
        <div class="recent-row">
          <a class="recent-open" href="#/sheet/${esc(r.code)}">
            <strong>${esc(r.name || "Unnamed")}</strong><span class="muted">code ${esc(r.code)}</span>
          </a>
          <button class="btn-quiet" data-forget="${esc(r.code)}">Forget</button>
        </div>`).join("")}</div>
      <p class="muted">“Forget” only removes it from this list — the character stays saved under its code.</p>
      </section>` : ""}
    <section class="step"><a class="btn" href="#/create">Create a new character</a></section>
  `);
}

async function openByCode() {
  const raw = ($("#open-code").value || "").replace(/\D/g, "");
  const msg = $("#open-msg");
  if (!CocStore.validCode(raw)) { msg.textContent = "A code is exactly six digits."; msg.className = "save-msg bad"; return; }
  msg.textContent = "Looking…"; msg.className = "save-msg";
  try {
    const ch = await CocStore.load(raw);
    if (!ch) { msg.textContent = `Nothing saved under ${raw}.`; msg.className = "save-msg bad"; return; }
    rememberCode(raw, ch.name);
    location.hash = "#/sheet/" + raw;
  } catch (err) {
    msg.textContent = "Could not reach storage: " + err.message; msg.className = "save-msg bad";
  }
}

/* ---------------------------------------------------------------- the live sheet */

/* Play state: everything that changes during a session and nothing that does not. Reset by combat,
   not by rest — there are no rests in this system (MECHANICS §2.2). */
function freshPlay(ch) {
  const d = derive(ch);
  return {
    inCombat: false,
    hp: d ? d.hpMax : 1,
    tempHp: 0,
    engine: 0,
    round: 1,
    turnTriggers: {},  // triggerId -> already used this turn
    cooldowns: {},     // trickId -> rounds remaining
    usedOncePerCombat: {},   // trickId / featureName -> true
    uses: {},          // featureName -> uses spent this combat
    flags: {},         // named states the player toggles (grapple, Subject, concentration…)
  };
}

/* Firebase omits empty objects entirely, so a character saved with no cooldowns comes back with
   `cooldowns` undefined and every lookup throws. Never trust the shape that comes off the wire. */
function normalisePlay(ch) {
  const base = freshPlay(ch);
  const p = Object.assign(base, ch.play || {});
  for (const k of ["cooldowns", "usedOncePerCombat", "uses", "flags", "turnTriggers"]) {
    if (!p[k] || typeof p[k] !== "object") p[k] = {};
  }
  for (const k of ["hp", "tempHp", "engine", "round"]) p[k] = Number(p[k]) || (k === "round" ? 1 : 0);
  p.inCombat = !!p.inCombat;
  return p;
}

function routeSheet(code) {
  if (!CocStore.validCode(code)) { location.hash = "#/manage"; return; }
  paint(`<div class="tool-head"><a class="back" href="#/manage">&larr; My characters</a><h1>Loading…</h1></div>`);
  CocStore.load(code).then((ch) => {
    if (!ch) { paint(`<div class="tool-head"><a class="back" href="#/manage">&larr; My characters</a>
      <h1>Not found</h1><p class="muted">Nothing is saved under ${esc(code)}.</p></div>`); return; }
    ch.play = normalisePlay(ch);
    sheet = { code, ch };
    rememberCode(code, ch.name);
    renderSheet();
  }).catch((err) => {
    paint(`<div class="tool-head"><a class="back" href="#/manage">&larr; My characters</a>
      <h1>Could not load</h1><p class="muted">${esc(err.message)}</p></div>`);
  });
}

let saveTimer = null;
function persist() {
  clearTimeout(saveTimer);
  const badge = $("#save-state");
  if (badge) badge.textContent = "saving…";
  saveTimer = setTimeout(async () => {
    try {
      await CocStore.save(sheet.code, sheet.ch);
      if ($("#save-state")) $("#save-state").textContent = "saved";
    } catch (err) {
      if ($("#save-state")) $("#save-state").textContent = "not saved — " + err.message;
    }
  }, 400);
}

function renderSheet() {
  const { code, ch } = sheet;
  const d = derive(ch);
  if (!d) { paint(`<p class="muted">This character's class no longer exists.</p>`); return; }
  const p = ch.play;
  paint(`
    <div class="tool-head sheet-head">
      <a class="back" href="#/manage">&larr; My characters</a>
      <div class="sheet-id">
        ${ch.photo ? `<img class="portrait" src="${esc(ch.photo)}" alt="" />` : `<div class="portrait empty">${esc((ch.name || "?")[0])}</div>`}
        <div>
          <h1>${esc(ch.name || "Unnamed")}</h1>
          <p class="muted">${esc(d.cls.name)}${d.subclass ? " · " + esc(d.subclass.name) : ""} · level ${esc(d.level)}${ch.size ? " · " + esc(ch.size) : ""}
            · code <strong>${esc(code)}</strong> · <span id="save-state">saved</span></p>
        </div>
      </div>
      <button class="btn ${p.inCombat ? "btn-hot" : ""}" data-act="combat">${p.inCombat ? "End combat" : "Start combat"}</button>
    </div>
    ${p.prompt ? promptBar(p.prompt) : ""}
    ${p.inCombat ? combatBar(d, p) :  `<p class="muted out-of-combat">Out of combat. ${esc(d.engine ? d.engine.name + " sits at 0 until a fight starts — it is built during one and lost when it ends." : "Cooldowns and once-per-combat uses are clear.")}</p>`}
    ${vitals(d, p)}
    ${keyNumbers(d)}
    ${d.engine ? enginePanel(d, p) : ""}
    ${d.tricks.length ? tricksPanel(d, p) : ""}
    ${featuresPanel(d, p)}
    ${statePanel(d, p)}
    ${gearPanel(d, ch)}
  `);
}

/* After a cast that forces a save, ask the one question the app cannot answer for itself. */
function promptBar(q) {
  return `<div class="prompt-bar">
    <span><strong>${esc(q.name)}</strong> — did the ${esc(q.save)} save fail?</span>
    <span class="prompt-acts">
      <button class="btn" data-act="prompt" data-val="${esc(q.trick)}|failed">It failed</button>
      <button class="btn-quiet" data-act="prompt" data-val="${esc(q.trick)}|saved">It saved</button>
      <button class="btn-quiet" data-act="dismiss-prompt" data-val="1">Skip</button>
    </span></div>`;
}

function combatBar(d, p) {
  return `<div class="combat-bar">
    <div><span class="combat-round">Round ${esc(p.round)}</span>
      <span class="muted">cooldowns tick down and per-combat uses refresh when the fight ends</span></div>
    <button class="btn" data-act="endturn">End my turn &rarr;</button>
  </div>`;
}

function vitals(d, p) {
  const pct = Math.max(0, Math.min(100, Math.round((p.hp / d.hpMax) * 100)));
  const state = p.hp <= 0 ? "down" : p.hp <= d.hpMax / 4 ? "hurt" : "";
  return `<section class="panel vitals">
    <div class="hp-head"><h2>Hit points</h2>
      <div class="hp-num ${state}"><strong>${esc(p.hp)}</strong><span>/ ${esc(d.hpMax)}</span>
        ${p.tempHp ? `<em>+${esc(p.tempHp)} temp</em>` : ""}</div></div>
    <div class="hp-bar"><div class="hp-fill ${state}" style="width:${pct}%"></div></div>
    <div class="hp-controls">
      <input id="hp-amt" class="num" type="number" min="1" value="1" />
      <button class="btn-quiet" data-act="dmg">Damage</button>
      <button class="btn-quiet" data-act="heal">Heal</button>
      <button class="btn-quiet" data-act="temp">Temp HP</button>
      <button class="btn-quiet" data-act="full">Full</button>
    </div>
    ${p.hp <= 0 ? `<p class="warn">Down. In this system that is the DM's call — the sheet just stops counting.</p>` : ""}
  </section>`;
}

function keyNumbers(d) {
  const n = (l, v, note) => `<div class="kn"><span class="kn-l">${esc(l)}</span><span class="kn-v">${esc(v)}</span>${note ? `<span class="kn-n">${esc(note)}</span>` : ""}</div>`;
  return `<section class="panel"><h2>Key numbers</h2><div class="kn-grid">
    ${n("AC", d.ac, d.acNote)}
    ${n("Parry DC", d.parryDC, "roll d20 over it")}
    ${n("Save DC", d.saveDC, "8 + prof + " + ABIL_SHORT[d.primary])}
    ${n("Attack", (d.attackBonus >= 0 ? "+" : "") + d.attackBonus, "prof + " + ABIL_SHORT[d.primary])}
    ${n("Proficiency", "+" + d.prof)}
    ${ABILITIES.map((a) => n(ABIL_SHORT[a], ((d.mods[a] >= 0 ? "+" : "") + d.mods[a]), String(sheet.ch.scores[a] ?? "—"))).join("")}
  </div></section>`;
}

function enginePanel(d, p) {
  const e = d.engine, cap = d.engineCap ?? 0;
  const pips = Array.from({ length: cap }, (_, i) =>
    `<button class="pip ${i < p.engine ? "on" : ""}" data-act="engine-set" data-val="${i + 1}" title="Set to ${i + 1}"></button>`).join("");
  const play = d.cls.play || {};
  // One button per way this class GAINS engine, worded as the player would say it. Once-per-turn
  // triggers grey out until End my turn, which is the only thing that resets them.
  const trig = (play.triggers || []).map((t) => {
    const spent = t.oncePerTurn && p.turnTriggers?.[t.id];
    return `<button class="btn-quiet trigger ${spent ? "spent" : ""}" data-act="trigger" data-val="${esc(t.id)}"
      ${spent || !p.inCombat ? "disabled" : ""}>+${esc(t.gain)} · ${esc(t.label)}${t.oncePerTurn ? ' <em>1/turn</em>' : ""}</button>`;
  }).join("");
  return `<section class="panel engine-panel">
    <h2>${esc(e.name)} <span class="muted">${esc(p.engine)} / ${esc(cap)}</span></h2>
    <div class="pips">${pips || `<span class="muted">cap 0</span>`}</div>
    ${trig ? `<div class="triggers">${trig}</div>` : ""}
    ${play.autoRefill === "turn" ? `<p class="muted">Refills to ${esc(cap)} at the start of each of your turns — press <strong>End my turn</strong>.</p>` : ""}
    <div class="hp-controls">
      <button class="btn-quiet" data-act="engine" data-val="-1">−1</button>
      <button class="btn-quiet" data-act="engine" data-val="1">+1</button>
      <button class="btn-quiet" data-act="engine-set" data-val="0">Clear</button>
    </div>
    ${!p.inCombat ? `<p class="muted">Out of combat this stays at 0 — it cannot be banked before a fight.</p>` : ""}
  </section>`;
}

/* A trick is castable when its cooldown is clear, a Prestige has not been used this combat, and any
   engine cost is affordable. The sheet shows why it is not, rather than just greying it out. */
function tricksPanel(d, p) {
  const rows = d.tricks.map((t) => {
    const id = t.id || slug(t);
    const cd = p.cooldowns[id] || 0;
    const spent = t.tier === "prestige" && p.usedOncePerCombat[id];
    const cost = t.engineCost || 0;
    const tooPoor = cost > p.engine;
    const blocked = cd > 0 || spent || tooPoor;
    const why = spent ? "used this combat" : cd > 0 ? `Seen — ${cd} round${cd === 1 ? "" : "s"}` : tooPoor ? `needs ${cost}` : "";
    return `<div class="trick-row ${blocked ? "blocked" : ""}">
      <div class="trick-main">
        <a href="#/tricks/${encodeURIComponent(id)}"><strong>${esc(t.name)}</strong></a>
        <span class="tier-badge tier-${esc(t.tier)}">${esc(cap(t.tier))}</span>
        ${cost ? `<span class="cost-badge">${esc(cost)} ${esc(d.engine.name)}</span>` : ""}
        ${t.cooldown ? `<span class="muted">cd ${esc(t.cooldown)}</span>` : ""}
        ${t.concentration ? `<span class="muted">concentration</span>` : ""}
        <div class="trick-sum">${fmtDesc(t.sheetSummary || "", trickLadder(t))}</div>
      </div>
      <div class="trick-act">
        ${why ? `<span class="why">${esc(why)}</span>` : ""}
        <button class="btn-quiet" data-act="cast" data-val="${esc(id)}" ${blocked ? "disabled" : ""}>Cast</button>
        ${cd > 0 ? `<button class="btn-quiet" data-act="clear-cd" data-val="${esc(id)}">Clear</button>` : ""}
      </div>
    </div>`;
  }).join("");
  return `<section class="panel"><h2>Tricks</h2><div class="trick-list-sheet">${rows}</div></section>`;
}

/* Features that cost something to use get a counter; the rest are reference text. A feature is
   "limited" if its own text says so — the sheet reads the meta rather than a hand-kept list. */
function limitOf(f) {
  const uses = String(f.meta?.uses || "");
  if (/1 \/ combat|once per combat|1 Mimic \/ combat/i.test(uses)) return { kind: "combat", n: 1 };
  if (/scaling/i.test(uses) || /uses per combat/i.test(f.sheetSummary || "")) return { kind: "scaling" };
  return null;
}

function featuresPanel(d, p) {
  const rows = d.features.map((f) => {
    const lim = limitOf(f);
    const key = f.name;
    let ctl = "";
    if (lim) {
      const max = lim.kind === "combat" ? 1 : d.scalingUses;
      const used = p.uses[key] || 0;
      const left = Math.max(0, max - used);
      ctl = `<div class="uses">
        <span class="${left ? "" : "spent"}">${esc(left)} / ${esc(max)} left</span>
        <button class="btn-quiet" data-act="use" data-val="${esc(key)}" ${left ? "" : "disabled"}>Use</button>
        ${used ? `<button class="btn-quiet" data-act="unuse" data-val="${esc(key)}">Undo</button>` : ""}
      </div>`;
    }
    return `<details class="feat"><summary>
        <span class="lvl">L${esc(f.level)}</span> <strong>${esc(f.name)}</strong>
        ${f.role === "roleplay" ? `<span class="role-badge">Roleplay</span>` : ""}
        <span class="muted">${esc(f._from)}</span>${ctl}</summary>
      ${metaRow(f.meta)}${fmtDesc(f.sheetSummary || f.description || "")}
      ${Array.isArray(f.options) && f.options.length ? optionTable(f.options) : ""}
    </details>`;
  }).join("");
  return `<section class="panel"><h2>Features</h2>${rows}</section>`;
}

/* Conditions any character can be under, plus whatever the class data declares. Nothing here is
   inferred: the app never sees a die roll, so it only ever remembers what the player tells it. */
const UNIVERSAL_STATES = [
  ["prone", "Prone", "Melee attacks against you have advantage, ranged have disadvantage; standing costs half your speed."],
  ["grappled", "Grappled", "Your speed is 0."],
  ["restrained", "Restrained", "Speed 0, attacks against you have advantage, and you have disadvantage on Dex saves."],
  ["frightened", "Frightened", "Disadvantage while the source is in sight, and you cannot willingly move closer to it."],
  ["blinded", "Blinded", "You automatically fail sight checks; attacks against you have advantage and yours have disadvantage."],
  ["concentrating", "Concentrating", "Take damage → roll a flat d20 against DC 10, or half the damage taken if that is higher."],
  ["incapacitated", "Incapacitated", "No actions and no reactions — and you cannot Parry at all."],
];
function statePanel(d, p) {
  const own = (d.cls.play?.states || []).filter((st) => !st.subclass || (d.subclass && d.subclass.id === st.subclass));
  const all = own.map((st) => [st.id, st.label, st.why || ""]).concat(UNIVERSAL_STATES);
  return `<section class="panel"><h2>States</h2>
    <div class="chips">${all.map(([k, label, why]) =>
      `<button class="chip ${p.flags[k] ? "on" : ""}" data-act="flag" data-val="${esc(k)}">
        ${esc(label)}${why ? `<span class="term-tip" role="tooltip">${esc(why)}</span>` : ""}</button>`).join("")}</div>
    <p class="muted">Toggle these yourself — the app never sees your dice, so it never guesses. All of
      them clear when the fight ends.</p>
  </section>`;
}

function gearPanel(d, ch) {
  const wep = d.weapons.map((w) => `<tr><td><strong>${esc(w.name)}</strong></td>
    <td>${esc(w.damage.die)} ${esc(w.damage.type)}</td><td>${propsHTML(w.properties)}</td>
    <td>${masteryHTML(w.mastery)}</td></tr>`).join("");
  return `<section class="panel"><h2>Gear</h2>
    <p><strong>${esc(d.armor ? d.armor.name : "No armour")}</strong>
      ${d.armor ? `<span class="muted">AC ${esc(d.armor.baseAC)}${d.armor.trait ? " · " : ""}</span>${d.armor.trait ? armorTraitHTML(d.armor.trait) : ""}` : ""}
      ${d.shield ? ` · <strong>${esc(d.shield.name)}</strong> <span class="muted">+${esc(d.shield.acBonus)}</span>` : ""}</p>
    <table class="data-table"><thead><tr><th>Weapon</th><th>Damage</th><th>Properties</th><th>Mastery</th></tr></thead>
      <tbody>${wep}</tbody></table>
    ${ch.skills?.length ? `<p class="muted">Skill proficiencies: ${esc(ch.skills.join(", "))}</p>` : ""}
    ${ch.notes ? `<p class="notes">${esc(ch.notes)}</p>` : ""}
  </section>`;
}

/* ---------------------------------------------------------------- sheet actions */

function sheetAction(e) {
  const b = e.target.closest("[data-act]");
  if (!b || b.disabled || !sheet) return;
  const { act, val } = b.dataset;
  const ch = sheet.ch, p = ch.play, d = derive(ch);
  const amt = () => Math.max(1, Number(($("#hp-amt") || {}).value) || 1);

  if (act === "combat") {
    p.inCombat = !p.inCombat;
    if (p.inCombat && d.cls.play?.autoRefill === "turn") p.engine = d.engineCap ?? 0;
    if (!p.inCombat) {
      // Everything per-combat resets: the engine empties, cooldowns clear, uses refresh.
      p.engine = 0; p.cooldowns = {}; p.usedOncePerCombat = {}; p.uses = {}; p.round = 1;
      p.flags = {}; p.turnTriggers = {}; p.prompt = null;
    }
  } else if (act === "endturn") {
    p.round += 1;
    for (const k of Object.keys(p.cooldowns)) {
      p.cooldowns[k] -= 1;
      if (p.cooldowns[k] <= 0) delete p.cooldowns[k];
    }
    p.turnTriggers = {};                                  // once-per-turn gains come back
    if (d.cls.play?.autoRefill === "turn") p.engine = d.engineCap ?? 0;   // the Juggler's Set
    p.prompt = null;
  } else if (act === "trigger") {
    const t = (d.cls.play?.triggers || []).find((x) => x.id === val);
    if (t) {
      p.engine = Math.max(0, Math.min(d.engineCap ?? 0, p.engine + t.gain));
      if (t.oncePerTurn) p.turnTriggers[t.id] = true;
    }
  } else if (act === "prompt") {
    // Answering the "did it land?" question the sheet asked after a cast.
    const [tid, answer] = String(val).split("|");
    const t = idx.tricksById.get(tid);
    if (answer === "failed" && t) {
      const gain = (d.cls.play?.triggers || []).find((x) => x.id === "failed-save");
      if (gain && !p.turnTriggers[gain.id]) {
        p.engine = Math.max(0, Math.min(d.engineCap ?? 0, p.engine + gain.gain));
        p.turnTriggers[gain.id] = true;
      }
    }
    p.prompt = null;
  } else if (act === "dismiss-prompt") {
    p.prompt = null;
  } else if (act === "dmg") {
    let n = amt();
    const soak = Math.min(p.tempHp, n);
    p.tempHp -= soak; n -= soak;
    p.hp = Math.max(0, p.hp - n);
  } else if (act === "heal") p.hp = Math.min(d.hpMax, p.hp + amt());
  else if (act === "temp") p.tempHp = Math.max(p.tempHp, amt());
  else if (act === "full") { p.hp = d.hpMax; p.tempHp = 0; }
  else if (act === "engine") p.engine = Math.max(0, Math.min(d.engineCap ?? 0, p.engine + Number(val)));
  else if (act === "engine-set") p.engine = Math.max(0, Math.min(d.engineCap ?? 0, Number(val)));
  else if (act === "cast") {
    const t = idx.tricksById.get(val);
    if (t) {
      if (t.engineCost) p.engine = Math.max(0, p.engine - t.engineCost);
      if (t.cooldown) p.cooldowns[val] = t.cooldown;
      if (t.tier === "prestige") p.usedOncePerCombat[val] = true;
      if (!p.inCombat) p.inCombat = true;
      // The app never sees the roll, so it asks. Only worth asking when the answer changes
      // something: a failed save feeds a full caster's engine.
      const asks = t.save && (d.cls.play?.triggers || []).some((x) => x.id === "failed-save");
      p.prompt = asks ? { trick: val, name: t.name, save: t.save } : null;
    }
  } else if (act === "clear-cd") delete p.cooldowns[val];
  else if (act === "use") p.uses[val] = (p.uses[val] || 0) + 1;
  else if (act === "unuse") p.uses[val] = Math.max(0, (p.uses[val] || 0) - 1);
  else if (act === "flag") p.flags[val] = !p.flags[val];
  else return;

  renderSheet();
  persist();
}

/* ---------------------------------------------------------------- wiring */

COC_ROUTES.create = routeCreate;
COC_ROUTES.manage = routeManage;
COC_ROUTES.sheet = routeSheet;

document.addEventListener("click", (e) => {
  if (!toolEl() || $("#tool-view").classList.contains("hidden")) return;
  if (e.target.closest("[data-pick]")) return creatorClick(e);
  if (e.target.closest("[data-act]")) return sheetAction(e);
  if (e.target.closest("#save-btn")) return saveDraft();
  if (e.target.closest("#open-btn")) return openByCode();
  const forget = e.target.closest("[data-forget]");
  if (forget) {
    const code = forget.dataset.forget;
    localStorage.setItem(RECENT_KEY, JSON.stringify(recentCodes().filter((r) => r.code !== code)));
    routeManage();
  }
});
document.addEventListener("input", (e) => {
  if (!toolEl() || $("#tool-view").classList.contains("hidden")) return;
  if (e.target.id === "photo") {
    readPortrait(e.target.files[0], (data) => { draft.photo = data; renderCreator(); });
    return;
  }
  creatorInput(e);
});
document.addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  if (e.target.id === "open-code") { e.preventDefault(); openByCode(); }
});
