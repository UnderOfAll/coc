/*
 * Circus of Chaos — character creation, management, and the live play sheet.
 *
 * Loaded after app.js, so every helper there (esc, fmtDesc, tabbed, narrationHTML, optionTable,
 * metaRow, masteryHTML, propsHTML, armorTraitHTML, tipTermHTML, el, $, store, idx, …) is available.
 * This file owns three routes, registered into COC_ROUTES at the bottom:
 *   #/create        the builder
 *   #/manage        open or delete a character by its six-digit code
 *   #/sheet/<code>  the live sheet, including combat tracking and levelling up
 *
 * A CHARACTER is plain JSON — no classes, no methods — so it can be stringified into localStorage or
 * a cloud row unchanged, and so an old save never breaks when this file grows. Everything derived
 * (HP, AC, save DC, engine cap, the trick list, the feature ladder, every attack) is COMPUTED from
 * the class data at render time by derive(), never stored. That way a balance change to a class
 * immediately reaches every existing character instead of leaving stale numbers on old sheets.
 *
 * The ONLY things written into a character are the choices a player made: level, subclass, ability
 * scores, skills, armour, weapons carried, and the per-combat play state.
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
/* A signed number reads as a bonus; an unsigned one reads as a total. Every modifier on the sheet
   is something you ADD to a roll, so they all carry their sign. */
function sign(n) { return (n >= 0 ? "+" : "") + n; }

/* Uses per combat on the scaling ladder (MECHANICS §2.2). */
function scalingUses(level) { return level >= 17 ? 4 : level >= 11 ? 3 : level >= 5 ? 2 : 1; }

/* Which ability a WEAPON attack uses. Not the same thing as the class's primary ability — that one
   is the TRICK ability (a Doppelganger casts off Constitution and would be swinging a dagger with
   it). The default is the 5e rule; a class may override it in data (`attackAbility`) when a feature
   says so, which is how the Joker's Charisma reaches the sheet without anything parsing his prose. */
function attackAbilityFor(cls, w, mods) {
  const props = (w.properties || []).map((p) => String(p).toLowerCase());
  const ov = cls.attackAbility;
  if (ov && (!ov.property || props.includes(String(ov.property).toLowerCase()))) {
    return { ability: ov.ability, why: ov.note || `${cls.name} uses ${ov.ability} for this` };
  }
  if (props.includes("finesse")) {
    const a = (mods.Dexterity ?? 0) >= (mods.Strength ?? 0) ? "Dexterity" : "Strength";
    return { ability: a, why: `Finesse: the better of your Strength and Dexterity — right now that is ${a}.` };
  }
  return { ability: "Strength", why: "No finesse and not a ranged weapon, so this attack uses Strength." };
}

/* Everything the sheet shows, computed fresh from the class data every time. */
function derive(ch) {
  const cls = idx.classes.get(ch.classId);
  if (!cls) return null;
  const level = Math.max(1, Math.min(20, Number(ch.level) || 1));
  // The creation bonus is stored apart from the scores you bought, never folded into them: point
  // buy must not see it (it is not paid for out of the 27), and the level-up ASI log rewinds
  // `scores` on an undo — a bonus mixed in there would be rewound with it.
  const scores = ch.scores || {};
  const origin = ch.origin || {};
  const mods = {};
  for (const a of ABILITIES) mods[a] = abilMod((scores[a] ?? 10) + (origin[a] || 0));

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

  // Every weapon the class is proficient with, and — separately — the ones this character actually
  // carries. A character saved before weapons were choosable has none recorded, so it falls back to
  // the full proficiency list rather than showing an empty Attacks table.
  const proficient = (cls.proficiencies?.weapons || []).map((n) => idx.weaponsByName.get(n)).filter(Boolean);
  const picked = Array.isArray(ch.weapons) && ch.weapons.length
    ? proficient.filter((w) => ch.weapons.includes(w.name)) : proficient;
  const carried = picked.map((w) => {
    const { ability, why } = attackAbilityFor(cls, w, mods);
    const mod = mods[ability] || 0;
    return { w, ability, why, hit: prof + mod, mod };
  });

  // The class's own named DCs, worked out for this character. Caps live in the Engine panel and
  // Parry has its own box, so both are left out rather than duplicated.
  const resolve = tokenResolver({ prof, mods, level, primary, scalingUses: scalingUses(level) });
  const classStats = (cls.keyStats || [])
    .filter((k) => k.formula && !/parry|cap$|set size/i.test(k.label || ""))
    .map((k) => ({ label: k.label, note: k.note, hit: resolve(k.label, k.formula) }))
    .filter((k) => k.hit);

  return {
    cls, subclass, level, prof, mods, hpMax, ac, acNote, features, tricks, engine, engineCap, classStats,
    weapons: proficient, carried, armor, shield,
    saveDC: 8 + prof + (mods[primary] ?? 0),
    attackBonus: prof + (mods[primary] ?? 0),
    parryDC: cls.parryBaseDC,
    primary,
    saves: cls.savingThrows || [],
    asiCount: ASI_LEVELS.filter((l) => l <= level).length,
    scalingUses: scalingUses(level),
  };
}

/* ---------------------------------------------------------------- resolving formulas */

/* A {{Label|formula}} token exists because a class page cannot know whose sheet it will be read on.
   A character sheet CAN: it knows the level, the proficiency bonus and every modifier, so the token
   should show the number and keep the working in the tooltip. That is what the token was always for
   — the compendium half was only ever the fallback.
   This reads the FORMULA, never the label. The formula is the machine-readable half of the pair by
   construction (the build lint enforces which half is which), and labels are free prose that drift:
   "trick save DC", "control DC", "gambit DC" and "Trick Shot DC" are four names for one calculation.
   Anything unrecognised returns null and renders as it always did. */
const ABIL_RE = "(Strength|Dexterity|Constitution|Intelligence|Wisdom|Charisma|your trick ability)";
function tokenResolver(d) {
  const modOf = (name) => {
    const a = /trick ability/i.test(name) ? d.primary
      : ABILITIES.find((x) => x.toLowerCase() === String(name).toLowerCase());
    return a ? { name: a, mod: d.mods[a] || 0 } : null;
  };
  const rules = [
    // "8 + proficiency bonus + Charisma modifier" — every DC in the game, whatever it is called.
    [new RegExp(`^(\\d+)\\s*\\+\\s*proficiency bonus\\s*\\+\\s*${ABIL_RE} modifier`, "i"), (m) => {
      const a = modOf(m[2]); if (!a) return null;
      const v = Number(m[1]) + d.prof + a.mod;
      return { value: v, explain: `${v} for you — ${m[1]} + proficiency ${sign(d.prof)} + ${a.name} ${sign(a.mod)}` };
    }],
    // "d20 + proficiency bonus + Intelligence modifier" (either order) — a to-hit.
    [new RegExp(`^d20\\s*\\+\\s*(?:proficiency bonus\\s*\\+\\s*${ABIL_RE} modifier|${ABIL_RE} modifier\\s*\\+\\s*proficiency bonus)`, "i"), (m) => {
      const a = modOf(m[1] || m[2]); if (!a) return null;
      const v = d.prof + a.mod;
      return { value: sign(v), explain: `roll d20 ${sign(v)} — proficiency ${sign(d.prof)} + ${a.name} ${sign(a.mod)}` };
    }],
    // The Scaling Uses ladder (MECHANICS §2.2).
    [/at levels 1-4/i, () => ({
      value: d.scalingUses,
      explain: `${d.scalingUses} for you at level ${d.level} — the ladder is 1 at levels 1-4, 2 at 5-10, 3 at 11-16, 4 at 17+`,
    })],
    // "proficiency bonus + Constitution modifier" with nothing in front of it.
    [new RegExp(`^proficiency bonus\\s*\\+\\s*${ABIL_RE} modifier`, "i"), (m) => {
      const a = modOf(m[1]); if (!a) return null;
      const v = d.prof + a.mod;
      return { value: v, explain: `${v} for you — proficiency ${sign(d.prof)} + ${a.name} ${sign(a.mod)}` };
    }],
    // "2 + your Sandow level"
    [/^(\d+)\s*\+\s*your \w[\w-]* level/i, (m) => {
      const v = Number(m[1]) + d.level;
      return { value: v, explain: `${v} for you — ${m[1]} + your level (${d.level})` };
    }],
    // "set from your stats on your character sheet" — the ability is named in the label, and the
    // formula sometimes carries a floor ("minimum 1").
    [/set from your stats|equal to your/i, (_m, label, formula) => {
      const named = new RegExp(ABIL_RE, "i").exec(label) || new RegExp(ABIL_RE, "i").exec(formula);
      const a = named && modOf(named[1]); if (!a) return null;
      const floor = /min(?:imum)?\s*(\d+)/i.exec(label + " " + formula);
      const raw = a.mod;
      const v = floor ? Math.max(Number(floor[1]), raw) : raw;
      return {
        value: v,
        explain: `${v} for you — your ${a.name} modifier ${sign(raw)}${floor && v !== raw ? `, raised to the minimum of ${floor[1]}` : ""}`,
      };
    }],
  ];
  return (label, formula) => {
    for (const [rx, fn] of rules) {
      const m = rx.exec(formula);
      if (m) { const out = fn(m, label, formula); if (out) return out; }
    }
    return null;
  };
}

/* How the thing LOOKS when it happens, as a tooltip on the end of the rules text. The sheet has no
   room for a second paragraph per trick, but a player still needs to know what they are describing
   to the table — that is the whole reason the two halves are authored separately (MECHANICS §5). */
function inPlayTip(narration) {
  if (!narration) return "";
  return plainTermHTML("In play", narration, "inplay-tip");
}

/* Render `fn`'s HTML with every formula token resolved against this character, then put the
   resolver back so the compendium is untouched. */
function withTokens(d, fn) {
  TOKEN_RESOLVER = d ? tokenResolver(d) : null;
  try { return fn(); } finally { TOKEN_RESOLVER = null; }
}

/* ---------------------------------------------------------------- shared UI helpers */

/* The draft being built, and the character being played. Both are plain JSON. */
let draft = null;
let sheet = null;      // { code, ch } while a sheet is open
/* Pure interface state: what is expanded, what number is sitting in the damage box, whether a
   level-up is being previewed. Never saved — none of it is part of the character. */
const ui = {
  openSubs: new Set(), openOpts: new Set(),
  hpAmt: 1, levelUp: null, deleteArmed: false, deleteText: "", sheetScroll: 0, scrollTop: false,
  tab: "status",   // which field of the sheet is open; interface state, never part of the character
  scrollToFields: false,
};

function toolEl() { return $("#tool"); }

/* Repaint the tool view, keeping the things a full innerHTML swap would throw away: where the page
   was scrolled, which field had focus, and where the caret was inside it. Without this, typing a
   digit into any field that re-derives the sheet bounced you to the top of the page and dropped
   focus after every keystroke — which is exactly why the level box could not be cleared. */
function paint(html) {
  const host = toolEl();
  const page = pageScroller();
  const top = page.scrollTop;
  const active = document.activeElement;
  let key = null, caret = null;
  if (active && host.contains(active)) {
    if (active.id) key = "#" + active.id;
    else if (active.dataset && active.dataset.abil) key = `[data-abil="${active.dataset.abil}"]`;
    if (key) { try { caret = active.selectionStart; } catch { caret = null; } }
  }
  host.innerHTML = html;
  page.scrollTop = top;
  if (key) {
    const next = host.querySelector(key);
    if (next) {
      next.focus();
      if (caret != null && next.setSelectionRange) { try { next.setSelectionRange(caret, caret); } catch { /* number inputs refuse */ } }
    }
  }
}

/* A chip that needs explaining gets its explanation as a SEPARATE ⓘ beside it, not as a tooltip on
   itself. The chip is a control: tapping it picks the armour or toggles the condition. On a phone
   there is no hover at all, so without its own tap target the description would be unreachable. */
function chipTip(chipHTML, tipHTML) {
  if (!tipHTML) return chipHTML;
  return `<span class="chip-tip">${chipHTML}<span class="tip-term info-dot" tabindex="0" role="button"
    aria-label="What this does">&#9432;<span class="term-tip" role="tooltip">${tipHTML}</span></span></span>`;
}

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
    v: 1, name: "", classId: "", subclassId: "", level: 1, levelText: "1", size: "",
    method: "array", scores: {}, origin: {},
    skills: [], armorId: "", shieldId: "", weapons: [], photo: "", notes: "",
    // Filled in from the sheet, not the form: a bag starts empty and what goes in it is a table
    // decision, not a creation one.
    items: [], coins: 0,
  };
}

/* Every arrival at #/create starts a NEW character. routeCreate only runs on an actual navigation
   (boot or hashchange), never on the creator's own re-renders, so nothing in-progress is lost by
   this — while keeping the old draft meant coming back later handed you the previous character's
   name, scores and portrait to edit by accident. */
function routeCreate() {
  draft = blankDraft();
  ui.openSubs.clear();
  renderCreator();
}

function renderCreator() {
  const cls = draft.classId ? idx.classes.get(draft.classId) : null;
  paint(withTokens(derive(draft), () => `
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
  `));
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
  const subPick = draft.level >= subLv
    ? `<label class="field-label">${esc(cls.features.find((f) => /Discipline|Repertoire|Act|Archetype/i.test(f.name))?.name || "Subclass")}</label>
       <p class="muted">Open each one to read what it gives you — this choice is permanent.</p>
       ${disciplineCards(cls, draft.subclassId, draft.level, "pick")}`
    : `<p class="muted">You choose a subclass at level ${esc(subLv)}.</p>`;
  return `<section class="step"><h2>2 · Level &amp; size</h2>
    <label class="field-label">Level <span class="muted">(features are written up to 5 for now)</span></label>
    <div class="stepper">
      <button class="step-btn" data-pick="level" data-val="-1" ${draft.level <= 1 ? "disabled" : ""} aria-label="Lower">&minus;</button>
      <input id="lvl" class="num step-val" type="text" inputmode="numeric" maxlength="2" value="${esc(draft.levelText ?? draft.level)}" />
      <button class="step-btn" data-pick="level" data-val="1" ${draft.level >= 20 ? "disabled" : ""} aria-label="Raise">+</button>
    </div>
    <label class="field-label">Size</label><div class="chips">${sizes}</div>
    ${subPick}</section>`;
}

function stepAbilities(cls) {
  const m = draft.method;
  const tabs = [["array", "Standard array"], ["buy", "Point buy"], ["manual", "Manual"]].map(([k, l]) =>
    `<button class="toggle-btn ${m === k ? "active" : ""}" data-pick="method" data-val="${k}">${l}</button>`).join("");
  const spent = ABILITIES.reduce((n, a) => n + (POINT_COST[draft.scores[a]] ?? 0), 0);
  const left = POINT_BUDGET - spent;
  const rows = ABILITIES.map((a) => {
    const v = draft.scores[a] ?? "";
    const isPrimary = a === cls.primaryAbility;
    const gift = draft.origin[a] || 0;
    const total = v === "" ? "" : Number(v) + gift;
    const mod = v === "" ? "" : sign(abilMod(total));
    let control;
    if (m === "array") {
      const used = ABILITIES.filter((x) => x !== a).map((x) => draft.scores[x]);
      const opts = ["", ...STANDARD_ARRAY].map((n) => {
        const taken = n !== "" && used.filter((u) => u === n).length >= STANDARD_ARRAY.filter((s) => s === n).length;
        return `<option value="${n}" ${String(draft.scores[a]) === String(n) ? "selected" : ""} ${taken ? "disabled" : ""}>${n === "" ? "—" : n}</option>`;
      }).join("");
      control = `<select class="num" data-abil="${a}">${opts}</select>`;
    } else if (m === "buy") {
      // The + disables the instant the NEXT point costs more than is left, so the budget is
      // enforced by the control rather than explained after the fact.
      const cur = Number(v) || 8;
      const step = cur < 15 ? POINT_COST[cur + 1] - POINT_COST[cur] : null;
      const canRaise = step != null && step <= left;
      control = `<span class="stepper">
        <button class="step-btn" data-pick="abil" data-val="${a}|-1" ${cur <= 8 ? "disabled" : ""} aria-label="Lower ${a}">&minus;</button>
        <span class="step-val">${esc(cur + gift)}</span>
        <button class="step-btn" data-pick="abil" data-val="${a}|1" ${canRaise ? "" : "disabled"} aria-label="Raise ${a}">+</button>
        <span class="step-cost">${step == null ? "max" : `next ${step}p`}</span>
      </span>`;
    } else {
      control = `<input class="num" type="text" inputmode="numeric" maxlength="2" data-abil="${a}" value="${esc(v)}" />`;
    }
    return `<div class="abil ${isPrimary ? "primary" : ""}">
      <span class="abil-name">${esc(ABIL_SHORT[a])}${isPrimary ? ' <span class="tag">primary</span>' : ""}</span>
      ${control}
      ${gift ? `<span class="gift">${esc((Number(v) || (m === "buy" ? 8 : 0)))} + ${esc(gift)}</span>` : ""}
      ${m !== "buy" && v !== "" ? `<span class="abil-total">${esc(total)}</span>` : ""}
      <span class="abil-mod">${esc(mod)}</span></div>`;
  }).join("");
  return `<section class="step"><h2>3 · Ability scores</h2>
    <div class="group-toggle">${tabs}</div>
    ${m === "buy" ? `<p class="muted"><span class="budget ${left < 0 ? "over" : ""}">${esc(left)}</span>
      of ${POINT_BUDGET} points left. Costs rise past 13, and nothing starts above 15 — there are no
      races to raise it.</p>` : ""}
    ${m === "array" ? `<p class="muted">Assign 15, 14, 13, 12, 10 and 8 in any order.</p>` : ""}
    ${m === "manual" ? `<p class="muted">Type what your table rolled. Nothing is validated beyond 3–20.</p>` : ""}
    <div class="abils ${m === "buy" ? "wide" : ""}">${rows}</div>
    ${stepOrigin()}</section>`;
}

/* The +2/+1 every 5e character gets at creation. In 2014 it came from a race and in 2024 from a
   background; this system has neither (MECHANICS §2.3), and cutting races quietly cut this with them
   — leaving every class advertising a level-1 DC of ~13 that a 15-point ceiling cannot produce.
   It is tied to nothing here: no race, no background, no traits, so it adds no balance surface at
   all. Three points with a cap of 2 on any one ability IS the rule, exactly: it can only ever come
   out as +2/+1 or +1/+1/+1. */
const ORIGIN_POINTS = 3;
function originSpent() { return ABILITIES.reduce((n, a) => n + (draft.origin[a] || 0), 0); }
function stepOrigin() {
  const left = ORIGIN_POINTS - originSpent();
  const cells = ABILITIES.map((a) => {
    const at = draft.origin[a] || 0;
    return `<span class="stepper">
      <span class="ab-name">${esc(ABIL_SHORT[a])}</span>
      <button class="step-btn" data-pick="origin" data-val="${a}|-1" ${at ? "" : "disabled"} aria-label="Lower ${a}">&minus;</button>
      <span class="step-val">+${esc(at)}</span>
      <button class="step-btn" data-pick="origin" data-val="${a}|1" ${left > 0 && at < 2 ? "" : "disabled"} aria-label="Raise ${a}">+</button>
    </span>`;
  }).join("");
  return `<div class="sub-block"><h3 class="sub-title">Starting bonus
      <span class="sub-note">— <span class="budget ${left ? "" : "spent"}">${esc(left)}</span> of ${ORIGIN_POINTS} points left</span></h3>
    <p class="muted">Everyone gets these, and they are not paid for out of point buy. Spread them as
      <strong>+2 and +1</strong>, or <strong>+1 to three</strong> — no single ability may take more than +2.</p>
    <div class="lu-asi">${cells}</div></div>`;
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
    return chipTip(
      `<button class="chip ${on ? "on" : ""}" ${full ? "disabled" : ""} data-pick="skill" data-val="${esc(s)}">${esc(s)}${abil}</button>`,
      sk ? fmtDesc(sk.description || "") : "");
  }).join("");
  return `<section class="step"><h2>4 · Skills</h2>
    <p class="muted">Choose ${need}. <strong>${draft.skills.length}/${need}</strong> chosen.</p>
    <div class="chips">${chips}</div></section>`;
}

/* What an armour's ⓘ says: the AC it gives THIS character with THIS Dexterity, what caps that, and
   what its always-on trait does. Comparing two pieces at the same AC is the whole point of the
   trait, so the trait has to be readable at the moment of choosing. */
function armorTipHTML(a, dex) {
  const capNote = a.maxDexBonus == null ? "your full Dexterity"
    : a.maxDexBonus === 0 ? "no Dexterity at all"
    : `at most +${a.maxDexBonus} Dexterity`;
  return `<strong>AC ${esc(acOf(a, dex))}</strong> — base ${esc(a.baseAC)} plus ${esc(capNote)}.`
    + (a.strengthRequirement != null ? ` Needs Strength ${esc(a.strengthRequirement)}.` : "")
    + (a.stealthDisadvantage ? " Disadvantage on Stealth." : "")
    + `<br>${a.trait ? `<strong>${esc(a.trait)}:</strong> ${esc(ARMOR_TRAITS[a.trait] || "")}`
        : "No trait — this is the highest AC in its category and tier, and that is what it pays with."}`;
}

function weaponTipHTML(w, d) {
  const row = d.carried.find((c) => c.w.name === w.name)
    || (() => { const { ability, why } = attackAbilityFor(d.cls, w, d.mods); return { ability, why, hit: d.prof + (d.mods[ability] || 0), mod: d.mods[ability] || 0 }; })();
  return `<strong>${esc(sign(row.hit))} to hit</strong>, damage ${esc(w.damage.die)} ${esc(sign(row.mod))} ${esc(w.damage.type)}.`
    + `<br>${esc(row.why)}`
    + (w.mastery ? `<br><strong>${esc(w.mastery)}:</strong> ${esc(MASTERIES[w.mastery] || "")}` : "");
}

function stepGear(cls) {
  const { wearable, shields } = armorFor(cls);
  const dex = abilMod(draft.scores.Dexterity ?? 10);
  const byCat = {};
  for (const a of wearable.filter((a) => a.availability !== "bought")) (byCat[a.category] ||= []).push(a);
  const blocks = ["clothing", "light", "medium", "heavy"].filter((c) => byCat[c]).map((c) => {
    const items = byCat[c].sort((x, y) => x.baseAC - y.baseAC).map((a) => chipTip(
      `<button class="chip ${draft.armorId === a.id ? "on" : ""}" data-pick="armor" data-val="${esc(a.id)}">
        ${esc(a.name)} <span class="muted">AC ${acOf(a, dex)}</span></button>`,
      armorTipHTML(a, dex))).join("");
    return `<div class="sub-block"><h3 class="sub-title">${esc(cap(c))}</h3><div class="chips">${items}</div></div>`;
  }).join("");
  const shieldBlock = shields.length ? `<div class="sub-block"><h3 class="sub-title">Shield</h3><div class="chips">
      ${shields.filter((s) => s.availability !== "bought").map((s) => chipTip(
        `<button class="chip ${draft.shieldId === s.id ? "on" : ""}" data-pick="shield" data-val="${esc(s.id)}">${esc(s.name)} <span class="muted">+${esc(s.acBonus)}</span></button>`,
        armorTipHTML(s, dex))).join("")}
      </div></div>` : "";

  // Proficiency is what the CLASS grants; carrying is a choice. Previously every proficient weapon
  // turned up on the sheet as though the character had all three in hand at once.
  const d = derive(draft);
  const weps = (cls.proficiencies?.weapons || []).map((n) => {
    const w = idx.weaponsByName.get(n);
    if (!w) return "";
    const on = draft.weapons.includes(w.name);
    return chipTip(
      `<button class="chip ${on ? "on" : ""}" data-pick="weapon" data-val="${esc(w.name)}">
        ${esc(w.name)} <span class="muted">${esc(w.damage.die)}</span></button>`,
      d ? weaponTipHTML(w, d) : "");
  }).join("");

  return `<section class="step"><h2>5 · Gear</h2>
    <p class="muted">Starter gear is free. The bought tier exists but your DM awards it in play — there is no money yet.
      Hover or tap the <span class="tip-term info-dot">&#9432;</span> beside anything to see what it does.</p>
    ${blocks}${shieldBlock}
    <div class="sub-block"><h3 class="sub-title">Starting weapon
        <span class="sub-note">— your class is proficient with all three; you begin with <strong>one</strong></span></h3>
      <div class="chips">${weps}</div></div></section>`;
}

function stepIdentity() {
  return `<section class="step"><h2>6 · Identity</h2>
    <label class="field-label">Name</label>
    <input id="cname" class="text" type="text" maxlength="40" value="${esc(draft.name)}" placeholder="Who are you?" />
    <label class="field-label">Portrait <span class="muted">(optional — stored with the character)</span></label>
    <div class="portrait-row">
      ${draft.photo ? `<img class="portrait" src="${esc(draft.photo)}" alt="" />` : `<div class="portrait empty caption">No image yet</div>`}
      <div class="portrait-actions"><input id="photo" type="file" accept="image/*" />
      ${draft.photo ? `<button class="btn-quiet" data-pick="clearphoto" data-val="1">Remove</button>` : ""}</div>
    </div>
    <label class="field-label">Notes <span class="muted">(appearance, background — anything you like)</span></label>
    <textarea id="notes" class="text" rows="3" maxlength="2000" placeholder="Free text. No mechanical weight.">${esc(draft.notes)}</textarea>
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
    ${row("Proficiency", sign(d.prof))}
    ${d.classStats.map((k) => row(k.label, k.hit.value)).join("")}
    ${d.tricks.length ? row("Trick attack", sign(d.attackBonus), "prof + " + ABIL_SHORT[d.primary]) : ""}
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
  const originLeft = ORIGIN_POINTS - originSpent();
  if (originLeft > 0) out.push(`Assign ${originLeft} more starting bonus point${originLeft === 1 ? "" : "s"}.`);
  if (draft.method === "buy") {
    const spent = ABILITIES.reduce((n, a) => n + (POINT_COST[draft.scores[a]] ?? 0), 0);
    if (spent > POINT_BUDGET) out.push(`Point buy is over budget by ${spent - POINT_BUDGET}.`);
  }
  const parsed = cls ? parseSkillChoice(cls.proficiencies?.skills) : null;
  const need = parsed?.count || 2;
  if (parsed && parsed.skills.length && draft.skills.length < need) out.push(`Choose ${need - draft.skills.length} more skill${need - draft.skills.length === 1 ? "" : "s"}.`);
  if (!draft.armorId) out.push("Choose an armour (or clothing).");
  if (!draft.weapons.length) out.push("Choose your starting weapon.");
  if (!String(draft.name).trim()) out.push("Give yourself a name.");
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
    draft.subclassId = ""; draft.armorId = ""; draft.shieldId = ""; draft.skills = []; draft.weapons = [];
    const cls = idx.classes.get(draft.classId);
    if (cls && (cls.sizes || []).length === 1) draft.size = cls.sizes[0];
    else if (cls && !(cls.sizes || []).includes(draft.size)) draft.size = "";
  } else if (pick === "size") draft.size = val;
  else if (pick === "subclass") draft.subclassId = draft.subclassId === val ? "" : val;
  else if (pick === "sub-open") { ui.openSubs.has(val) ? ui.openSubs.delete(val) : ui.openSubs.add(val); }
  else if (pick === "level") {
    draft.level = Math.max(1, Math.min(20, draft.level + Number(val)));
    draft.levelText = String(draft.level);
    if (draft.level < (idx.classes.get(draft.classId)?.subclassLevel || 3)) draft.subclassId = "";
  } else if (pick === "abil") {
    const [a, delta] = val.split("|");
    const next = (Number(draft.scores[a]) || 8) + Number(delta);
    if (next >= 8 && next <= 15) draft.scores[a] = next;
  } else if (pick === "origin") {
    const [a, delta] = val.split("|");
    const next = (draft.origin[a] || 0) + Number(delta);
    if (next >= 0 && next <= 2 && originSpent() - (draft.origin[a] || 0) + next <= ORIGIN_POINTS) {
      if (next === 0) delete draft.origin[a]; else draft.origin[a] = next;
    }
  } else if (pick === "method") {
    draft.method = val;
    draft.scores = val === "buy" ? Object.fromEntries(ABILITIES.map((a) => [a, 8])) : {};
  } else if (pick === "skill") {
    draft.skills = draft.skills.includes(val) ? draft.skills.filter((s) => s !== val) : draft.skills.concat(val);
  } else if (pick === "armor") draft.armorId = draft.armorId === val ? "" : val;
  else if (pick === "shield") draft.shieldId = draft.shieldId === val ? "" : val;
  else if (pick === "weapon") {
    // ONE starting weapon. Proficiency is what the class grants; the kit you begin with is a single
    // weapon, so picking another replaces it rather than adding to a rack.
    draft.weapons = draft.weapons.includes(val) ? [] : [val];
  } else if (pick === "clearphoto") draft.photo = "";
  else if (pick === "reroll") draft._code = suggestCode();
  renderCreator();
}

function creatorInput(e) {
  const t = e.target;
  if (t.id === "lvl") {
    // An empty box is a legal thing to be holding mid-edit: you have to be able to clear "12"
    // before typing "3". The TEXT is what you typed; the LEVEL only follows once it is a number.
    let raw = t.value.replace(/[^0-9]/g, "").slice(0, 2);
    if (raw !== "" && Number(raw) > 20) raw = "20";
    draft.levelText = raw;
    if (raw !== "") {
      draft.level = Math.max(1, Number(raw));
      if (draft.level < (idx.classes.get(draft.classId)?.subclassLevel || 3)) draft.subclassId = "";
    }
    renderCreator();
  } else if (t.dataset.abil) {
    const raw = String(t.value).replace(/[^0-9]/g, "").slice(0, 2);
    if (t.tagName === "INPUT") t.value = raw;
    if (raw === "") delete draft.scores[t.dataset.abil]; else draft.scores[t.dataset.abil] = Number(raw);
    renderCreator();
  } else if (t.id === "cname") { draft.name = t.value; toolEl().querySelector(".creator-side").innerHTML = sidePreview(); }
  else if (t.id === "notes") draft.notes = t.value;
  else if (t.id === "code") { draft._code = t.value.replace(/\D/g, "").slice(0, 6); delete draft._overwrite; }
  else if (t.id === "hp-amt") ui.hpAmt = Math.max(1, Number(t.value) || 1);
  else if (t.id === "del-confirm" && sheet) { ui.deleteText = t.value; renderSheet(); }
}

/* Leaving a half-typed box puts it back to something legal, so an abandoned edit can never leave
   the form showing a value the character does not have. */
function creatorBlur(e) {
  if (!draft) return;
  const t = e.target;
  if (t.id === "lvl" && draft.levelText !== String(draft.level)) { draft.levelText = String(draft.level); renderCreator(); }
  else if (t.dataset && t.dataset.abil && t.tagName === "INPUT" && draft.method === "manual") {
    const v = Number(draft.scores[t.dataset.abil]);
    if (v && (v < 3 || v > 20)) { draft.scores[t.dataset.abil] = Math.max(3, Math.min(20, v)); renderCreator(); }
  }
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
    delete ch._code; delete ch._overwrite; delete ch.levelText;
    ch.savedAt = Date.now();
    ch.play = freshPlay(ch);
    await CocStore.save(code, ch);
    rememberCode(code, ch.name);
    draft = null;                         // the next visit to #/create starts clean
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

/* ---------------------------------------------------------------- recovery roster */

/* Recovering a lost code.
 *
 * The database rules grant read on a single character path and NOT on the collection above it, so
 * nothing here can list what exists — which is the point: a stranger with the URL cannot browse the
 * table. That leaves two honest sources, and this page shows both:
 *   1. the codes THIS browser has opened, which it remembers locally; and
 *   2. the Firebase console, where the owner is signed in and the rules do not apply.
 * If a database is configured permissively enough to list (the local backend always is), the full
 * table is shown instead — so this page is useful either way rather than assuming one setup. */
function routeRoster() {
  const head = `<div class="tool-head"><a class="back" href="#/">&larr; Menu</a>
    <h1>Find a lost code</h1></div>`;
  const local = () => {
    const rows = recentCodes();
    return `<section class="step"><h2>Opened on this device</h2>
      ${rows.length ? `<div class="recent">${rows.map((r) => `
        <div class="recent-row">
          <a class="recent-open" href="#/sheet/${esc(r.code)}">
            <strong>${esc(r.name || "Unnamed")}</strong><span class="muted">code ${esc(r.code)}</span>
          </a>
        </div>`).join("")}</div>`
        : `<p class="muted">This browser has not opened a character yet.</p>`}
      </section>
      <section class="step"><h2>Every character</h2>
      <p class="muted">Not listable from here, by design: the storage rules grant access to one
        character at a time, so nobody with the site's address can browse your table. To see them all,
        open your Firebase console &rarr; <strong>Realtime Database</strong> &rarr; <strong>Data</strong>
        &rarr; <code>characters</code>. You are signed in there, so the restriction does not apply to
        you — and that is the only place it does not.</p></section>`;
  };
  paint(head + `<section class="step"><p class="muted">Checking…</p></section>`);
  CocStore.all().then((rows) => {
    const codes = Object.keys(rows).filter((c) => rows[c]).sort();
    if (!codes.length) { paint(head + local()); return; }
    const body = codes.map((code) => {
      const ch = rows[code] || {};
      const cls = idx.classes.get(ch.classId);
      const sub = ch.subclassId ? idx.subclasses.get(ch.subclassId) : null;
      return `<tr>
        <td><a href="#/sheet/${esc(code)}"><strong>${esc(code)}</strong></a></td>
        <td>${esc(ch.name || "Unnamed")}</td>
        <td>${esc(cls ? cls.name : ch.classId || "—")}${sub ? ` <span class="muted">${esc(sub.name)}</span>` : ""}</td>
        <td class="col-num">${esc(ch.level ?? "—")}</td>
      </tr>`;
    }).join("");
    paint(head + `<p class="muted">${esc(codes.length)} saved. This storage allows listing, so the
        whole table is readable by anyone with the site's address — see docs/CLOUD_SETUP.md.</p>
      <section class="panel"><table class="data-table">
        <thead><tr><th>Code</th><th>Name</th><th>Class</th><th>Level</th></tr></thead>
        <tbody>${body}</tbody></table></section>`);
  }).catch(() => paint(head + local()));
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
  // Already holding this character? Show it straight back, exactly as it was — same open features,
  // same scroll position, same everything. Re-fetching would also be WRONG, not just slow: a save
  // may still be sitting in the 400ms debounce, so the copy in memory is the freshest one there is.
  // This is the path taken every time you follow a trick link and come back.
  if (sheet && sheet.code === code) {
    renderSheet();
    pageScroller().scrollTop = ui.sheetScroll || 0;
    return;
  }
  ui.openSubs.clear(); ui.openOpts.clear();
  ui.levelUp = null; ui.hpAmt = 1; ui.deleteArmed = false; ui.deleteText = ""; ui.sheetScroll = 0;
  ui.tab = "status";
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
  paint(withTokens(d, () => `
    <div class="tool-head sheet-head">
      <a class="back" href="#/manage">&larr; My characters</a>
      <div class="sheet-id">
        ${ch.photo ? `<img class="portrait" src="${esc(ch.photo)}" alt="" />` : `<div class="portrait empty">${esc((ch.name || "?")[0])}</div>`}
        <div class="sheet-titles">
          <h1>${esc(ch.name || "Unnamed")}</h1>
          <p class="sheet-class">${esc(d.cls.name)}${d.subclass ? ` <span class="sep">&middot;</span> ${esc(d.subclass.name)}` : ""}${ch.size ? ` <span class="sep">&middot;</span> ${esc(ch.size)}` : ""}</p>
          <p class="sheet-code">code <strong>${esc(code)}</strong> <span class="sep">&middot;</span> <span id="save-state">saved</span></p>
        </div>
        <div class="sheet-level"><span class="lv-k">Level</span><span class="lv-v">${esc(d.level)}</span></div>
      </div>
      <button class="btn ${p.inCombat ? "btn-hot" : ""}" data-act="combat">${p.inCombat ? "End combat" : "Start combat"}</button>
    </div>
    ${ui.levelUp ? levelUpPanel(d) : ""}
    ${vitals(d, p)}
    ${p.inCombat ? combatBar(d, p) : idleLine(d)}
    ${p.prompt ? promptBar(p.prompt) : ""}
    ${p.inCombat && d.engine ? enginePanel(d, p) : ""}
    ${sheetFields(d, p, ch)}
  `));
}

/* The sheet is a stack of fields, one open at a time, because a phone cannot show a Joker's twelve
   tricks, nine features, six abilities and his gear at once without becoming a mile of scroll where
   nothing is findable. What stays OUTSIDE the fields is what you need no matter which one is open:
   who you are, your hit points and defences, whether a fight is running, and your engine — the
   resource every field spends. Everything else is a field.
   Every field is rendered and the inactive ones are hidden rather than dropped, so browser find,
   focus and the whole-sheet read all still work; switching is a repaint away either way. */
function sheetFields(d, p, ch) {
  const items = invItems(ch);
  const fields = [
    ["status", "Status", "", statusPanel(d) + statePanel(d, p)],
    ["attacks", "Attacks", d.carried.length, attacksPanel(d)],
    ...(d.tricks.length ? [["tricks", "Tricks", d.tricks.length, tricksPanel(d, p)]] : []),
    ["features", "Features", d.features.length, featuresPanel(d, p)],
    ["gear", "Gear", "", gearPanel(d, ch)],
    ["inventory", "Inventory", items.length || "", inventoryPanel(ch, items)],
    // Levelling and deleting are not play: they are things you do between sessions, and a level-up
    // button under the trick you are about to cast is a mis-tap with permanent consequences.
    ["progress", "Progress", "", ui.levelUp ? "" : progressPanel(d) + dangerPanel()],
  ];
  // A Juggler has no Tricks field at all, so a sheet reopened on one must not land on nothing.
  if (!fields.some(([id]) => id === ui.tab)) ui.tab = "status";
  const tabs = fields.map(([id, label, count]) => `<button class="tab ${ui.tab === id ? "on" : ""}"
      data-act="tab" data-val="${esc(id)}" role="tab" aria-selected="${ui.tab === id}">${esc(label)}${
      count ? ` <span class="tab-n">${esc(count)}</span>` : ""}</button>`).join("");
  const panes = fields.map(([id, , , html]) =>
    `<div class="pane" data-pane="${esc(id)}" role="tabpanel"${ui.tab === id ? "" : " hidden"}>${html}</div>`).join("");
  return `<div class="tab-strip" role="tablist">${tabs}</div><div class="panes">${panes}</div>`;
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

/* One number in a box: the value leads, the label sits under it, the working-out is one tap away.
   A defence at the top of the sheet and a class DC inside the Status field are the same object, so
   they are the same markup — the vitals bar only sizes them down through its own container.

   `roll` turns the NOTE into the button that throws the dice, rather than the value: a Parry DC of 11
   is not a thing you roll, "roll a flat d20" is, and a number that silently rolls when tapped is a
   number nobody trusts. At a table the result goes to the shared log; away from one it answers on
   your own screen (see tblRollAndPost). */
function numBox(label, value, note, tip, roll) {
  const noteHTML = !note ? ""
    : roll ? `<span class="kn-n">${rollBtn(roll.spec, roll.label, note)}</span>`
    : `<span class="kn-n">${esc(note)}</span>`;
  return `<div class="kn"><span class="kn-v">${esc(value)}</span>
    <span class="kn-l">${tip ? plainTermHTML(label, tip) : esc(label)}</span>
    ${noteHTML}</div>`;
}

/* Every rollable thing on the sheet is one of these, so there is exactly one place that knows what a
   roll button looks like and what it carries. Shift-click for advantage, alt-click for disadvantage —
   the dice tray has proper buttons for both; this is the shortcut for the common case. */
function rollBtn(spec, label, text) {
  return `<button class="roll" type="button" data-roll="${esc(spec)}" data-label="${esc(label)}"
    title="Roll ${esc(spec)} — hold Shift for advantage, Alt for disadvantage">${esc(text == null ? spec : text)}</button>`;
}

/* Hit points and the three numbers that answer "did that hit me, and what do I do about it" — they
   live above the fields because they are needed whichever field is open, and they are the numbers
   you are asked for most often at the table. */
function vitals(d, p) {
  const pct = Math.max(0, Math.min(100, Math.round((p.hp / d.hpMax) * 100)));
  const state = p.hp <= 0 ? "down" : p.hp <= d.hpMax / 4 ? "hurt" : "";
  return `<section class="panel vitals">
    <div class="vital-row">
      <div class="hp-block">
        <div class="hp-head"><h2>Hit points</h2>
          <div class="hp-num ${state}"><strong>${esc(p.hp)}</strong><span>/ ${esc(d.hpMax)}</span>
            ${p.tempHp ? `<em>+${esc(p.tempHp)} temp</em>` : ""}</div></div>
        <div class="hp-bar"><div class="hp-fill ${state}" style="width:${pct}%"></div></div>
        <div class="hp-controls">
          <input id="hp-amt" class="num" type="number" min="1" value="${esc(ui.hpAmt)}" />
          <button class="btn-quiet" data-act="dmg">Damage</button>
          <button class="btn-quiet" data-act="heal">Heal</button>
          <button class="btn-quiet" data-act="temp">Temp HP</button>
          <button class="btn-quiet" data-act="full">Full</button>
        </div>
      </div>
      <div class="vital-set">
        ${numBox("Armour Class", d.ac, d.acNote, "An attack roll must equal or beat this to hit you. Only a hit can then be Parried.")}
        ${numBox("Parry DC", d.parryDC, "roll a flat d20", "When a hit lands, spend your reaction and roll a flat d20 — no modifiers. Above this DC: no damage. Equal: half. Below: half again on top. Lower is better, and it never scales with level.", { spec: "1d20", label: "Parry (needs over " + d.parryDC + ")" })}
        ${numBox("Initiative", sign(d.mods.Dexterity), "roll initiative", "Roll d20 and add this at the start of a fight to see who goes when.", { spec: "1d20" + sign(d.mods.Dexterity), label: "Initiative" })}
      </div>
    </div>
    ${p.hp <= 0 ? `<p class="warn">Down. In this system that is the DM's call — the sheet just stops counting.</p>` : ""}
  </section>`;
}

/* Status: who this character IS as a set of numbers — the DCs their own class names, their six
   abilities and saves, and the skills they are trained in. Defences moved up to the vitals bar, so
   what is left here is everything you are asked to roll or that others roll against.
   The trick numbers are labelled as trick numbers: they come off the class's primary ability, which
   for half the roster is NOT the stat they swing a weapon with — those live in Attacks, per weapon. */
function statusPanel(d) {
  // plainTermHTML, not tipTermHTML: these tooltips are written here, not authored in a content file,
  // so they must never be run through the formula resolver.
  const n = numBox;
  const abils = ABILITIES.map((a) => {
    const isProf = d.saves.includes(a);
    const save = d.mods[a] + (isProf ? d.prof : 0);
    // Both numbers here ARE rolls — an ability check and a saving throw — so both are buttons. The
    // score is not: nothing is ever rolled against your raw 16.
    return `<div class="ab-box ${isProf ? "prof" : ""}">
      <span class="ab-name">${esc(ABIL_SHORT[a])}</span>
      <span class="ab-mod">${rollBtn("1d20" + sign(d.mods[a]), ABIL_SHORT[a] + " check", sign(d.mods[a]))}</span>
      <span class="ab-score">score ${esc(sheet.ch.scores[a] == null ? "—" : sheet.ch.scores[a] + ((sheet.ch.origin || {})[a] || 0))}</span>
      <span class="ab-save">save ${rollBtn("1d20" + sign(save), ABIL_SHORT[a] + " save", sign(save))}</span></div>`;
  }).join("");
  const ch = sheet.ch;
  const stats = d.classStats.map((k) => n(k.label, k.hit.value, "", k.hit.explain + (k.note ? " — " + k.note : ""))).join("")
    + (d.tricks.length ? n("Trick attack", sign(d.attackBonus), "roll a trick attack", "Your proficiency bonus + your " + ABIL_SHORT[d.primary] + " modifier, for the tricks that make an attack roll instead of forcing a save. Weapon attacks are worked out per weapon under Attacks.", { spec: "1d20" + sign(d.attackBonus), label: "Trick attack" }) : "");
  return `<section class="panel"><h2>Your numbers</h2>
  ${stats ? `<div class="kn-grid">${stats}</div>` : ""}
  <p class="panel-sub">Abilities — the modifier is what you add; a gold box is a saving throw your class is proficient in${d.prof ? `, which already includes your ${plainTermHTML("proficiency bonus " + sign(d.prof), `Not an ability score: it comes from LEVEL alone and is the same for every class — +2 at levels 1-4, +3 at 5-8, +4 at 9-12, +5 at 13-16, +6 at 17+. You are level ${d.level}, so ${sign(d.prof)}. It is already added into every number on this sheet that needs it: your saving throws, your to-hit, your DC, and your skills below.`)}` : ""}</p>
  <div class="ab-grid">${abils}</div>
  ${ch.skills?.length ? `<p class="panel-sub">Skills you are trained in</p>
    <div class="skill-row">${ch.skills.map((name) => {
      const sk = idx.skillsByName.get(String(name).toLowerCase());
      const ab = sk && sk.ability;
      const bonus = (ab ? (d.mods[ab] || 0) : 0) + d.prof;
      return `<span class="skill-chip"><strong>${esc(name)}</strong>
        <em>${rollBtn("1d20" + sign(bonus), name, sign(bonus))}</em>${ab ? `<span class="muted">${esc(ABIL_SHORT[ab])}</span>` : ""}</span>`;
    }).join("")}</div>` : ""}
  </section>`;
}

/* One row per weapon actually carried, with the to-hit and the damage already worked out — the
   sheet knows the proficiency bonus and the modifier, so the player should never be adding them up
   at the table. */
function attacksPanel(d) {
  if (!d.carried.length) {
    return `<section class="panel"><h2>Attacks</h2>
      <p class="muted">Nothing to swing. Pick up a weapon under Gear and its to-hit and damage appear here.</p>
    </section>`;
  }
  const rows = d.carried.map(({ w, ability, why, hit, mod }) => {
    const vers = (w.properties || []).includes("versatile") && w.versatileDamage
      ? ` <span class="muted">(${esc(w.versatileDamage)} ${esc(sign(mod))} two-handed)</span>` : "";
    const rng = w.range ? `<span class="muted">${esc(w.range.normal)}/${esc(w.range.long)} ft</span>` : "";
    // data-label drives the stacked layout on a phone, where five columns cannot fit and a
    // horizontal scroller would clip the mastery tooltips.
    // The to-hit and the damage are the two things you do with a weapon, so they are the two buttons.
    // chipTip keeps the explanation on its own ⓘ rather than on the control — tapping a control on a
    // phone must do the thing, not explain it.
    const hitBtn = chipTip(rollBtn("1d20" + sign(hit), w.name + " to hit", sign(hit)),
      `${why} Proficiency ${sign(d.prof)} + ${ability} ${sign(mod)}.`);
    const dmgSpec = w.damage.die + (mod ? sign(mod) : "");
    return `<tr>
      <td data-label="Weapon"><strong>${esc(w.name)}</strong> ${rng}</td>
      <td data-label="To hit" class="atk-hit">${hitBtn}</td>
      <td data-label="Damage" class="atk-dmg">${rollBtn(dmgSpec, w.name + " damage", w.damage.die + " " + sign(mod))}${vers} <span class="muted">${esc(w.damage.type)}</span></td>
      <td data-label="Properties">${propsHTML(w.properties)}</td>
      <td data-label="Mastery">${masteryHTML(w.mastery)}</td></tr>`;
  }).join("");
  return `<section class="panel"><h2>Attacks</h2>
    <table class="data-table attack-table">
      <thead><tr><th>Weapon</th><th>To hit</th><th>Damage</th><th>Properties</th><th>Mastery</th></tr></thead>
      <tbody>${rows}</tbody></table>
    <p class="muted">Roll d20 and add the to-hit against the target's AC. On a hit, roll the damage die and add the same modifier.</p>
  </section>`;
}

/* Out of combat there is nothing to operate: no round to end, the engine is forced to 0 with every
   trigger disabled, and the only useful control is Start combat, directly above. So the whole strip
   between the vitals and the fields collapses to the one sentence that says so — a full engine panel
   here spent most of a phone screen saying that it could not be used. */
function idleLine(d) {
  const cap = d.engineCap ?? 0;
  return `<p class="muted out-of-combat">Out of combat. Cooldowns and once-per-combat uses are clear.${
    d.engine ? ` <span class="engine-panel engine-idle"><strong>${esc(d.engine.name)}</strong>
      <span>0 / ${esc(cap)}</span> — built during a fight, never banked before one.</span>` : ""}</p>`;
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
    const why = spent ? "used this combat" : cd > 0 ? `Ready in ${cd} round${cd === 1 ? "" : "s"}` : tooPoor ? `needs ${cost}` : "";
    return `<div class="trick-row ${blocked ? "blocked" : ""}">
      <div class="trick-main">
        <div class="trick-head">
          <a class="trick-name" href="#/tricks/${encodeURIComponent(id)}">${esc(t.name)}</a>
          <span class="tier-badge tier-${esc(t.tier)}">${esc(cap(t.tier))}</span>
          ${trickMetaRow(t, d)}
        </div>
        <div class="trick-sum">${fmtDesc(t.sheetSummary || "", trickLadder(t))} ${inPlayTip(t.narration)}</div>
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

/* The same at-a-glance chips a feature gets, built from a trick's own fields. Cost folds the action
   economy together with the engine price exactly as metaRow does for features, so the two read the
   same way down the page. Once-per-combat is a property of the Prestige TIER, not a field on the
   trick (MECHANICS §4.5), which is why it is derived here rather than looked up. */
function trickMetaRow(t, d) {
  const price = t.engineCost ? `${t.engineCost} ${d.engine ? d.engine.name : "engine"}` : "";
  return metaRow({
    action: t.castingTime,
    cost: price,
    uses: t.tier === "prestige" ? "1 per combat" : (t.concentration ? "concentration" : ""),
    range: t.range,
    save: t.save ? t.save + " save" : "",
    cooldown: t.cooldown ? `${t.cooldown} round${t.cooldown > 1 ? "s" : ""}` : "",
    duration: /^instantaneous$/i.test(t.duration || "") ? "" : t.duration,
  });
}

/* Features that cost something to use get a counter; the rest are reference text. A feature is
   "limited" if its own text says so — the sheet reads the meta rather than a hand-kept list. */
function limitOf(f) {
  const uses = String(f.meta?.uses || "");
  if (/1 \/ combat|once per combat|1 Mimic \/ combat/i.test(uses)) return { kind: "combat", n: 1 };
  if (/scaling/i.test(uses) || /uses per combat/i.test(f.sheetSummary || "")) return { kind: "scaling" };
  return null;
}

/* One card per feature, each showing the whole thing: level, name, where it came from, its
   at-a-glance chips, its rules text and any options table, with the in-play description on a
   tooltip at the end — the same shape a trick row uses, so the page reads one way throughout.
   There is no expander. A card that hides its own content is a click to read one sentence, and it
   made the grid ragged: cards changed size as you opened them. */
function featuresPanel(d, p) {
  // A feature marked `panel` only announces a subsystem this sheet already shows live — "You gain
  // the Grit pool, see the engine", "Full caster from level 1, you know the whole list". It belongs
  // on the class page, where it explains what the class IS; here it would sit two inches from the
  // Engine or Tricks panel saying that panel exists.
  const shown = d.features.filter((f) => !(f.panel === "engine" ? d.engine : f.panel === "tricks" ? d.tricks.length : false));
  const cards = shown.map((f) => {
    const lim = limitOf(f);
    const key = f.name;
    let ctl = "";
    if (lim) {
      const max = lim.kind === "combat" ? 1 : d.scalingUses;
      const used = p.uses[key] || 0;
      const leftN = Math.max(0, max - used);
      ctl = `<div class="uses">
        <span class="${leftN ? "" : "spent"}">${esc(leftN)} / ${esc(max)} left</span>
        <button class="btn-quiet" data-act="use" data-val="${esc(key)}" ${leftN ? "" : "disabled"}>Use</button>
        ${used ? `<button class="btn-quiet" data-act="unuse" data-val="${esc(key)}">Undo</button>` : ""}
      </div>`;
    }
    return `<div class="feat-card">
      <div class="feat-title">
        <span class="lvl">L${esc(f.level)}</span>
        <span class="feat-name">${esc(f.name)}</span>
        ${f.role === "roleplay" ? `<span class="role-badge">Roleplay</span>` : ""}
      </div>
      <p class="feat-from">${esc(f._from)}</p>
      ${metaRow(f.meta)}
      <div class="feat-text">${fmtDesc(f.sheetSummary || f.description || "")} ${inPlayTip(f.narration)}</div>
      ${optionsBlock(f, key)}
      ${ctl}
    </div>`;
  }).join("");
  return `<section class="panel"><h2>Features</h2><div class="feat-grid">${cards}</div></section>`;
}

/* A feature whose menu is eight rows long buries the sentence that says what the feature IS. The
   table is what you read once, when you pick; the sentence is what you read every round. So the
   table folds away, and says how many rows it is hiding — a toggle with no count is a gamble.
   Wording comes from the data: a `roll` on any row makes it a random table, not a menu. */
function optionsBlock(f, key) {
  const opts = Array.isArray(f.options) ? f.options : [];
  if (!opts.length) return "";
  const open = ui.openOpts.has(key);
  const noun = opts.some((o) => o.roll != null) ? "result" : "option";
  return `<button class="btn-quiet opts-toggle" data-act="open-opts" data-val="${esc(key)}"
      aria-expanded="${open}">${open ? "Hide" : "Show"} the ${esc(opts.length)} ${esc(noun)}${opts.length === 1 ? "" : "s"}
      <span class="opts-mark">${open ? "&minus;" : "+"}</span></button>
    ${open ? optionTable(opts) : ""}`;
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
    <div class="chips">${all.map(([k, label, why]) => chipTip(
      `<button class="chip ${p.flags[k] ? "on" : ""}" data-act="flag" data-val="${esc(k)}">${esc(label)}</button>`,
      esc(why))).join("")}</div>
    <p class="muted">Toggle these yourself — the app never sees your dice, so it never guesses. All of
      them clear when the fight ends.</p>
  </section>`;
}

function gearPanel(d, ch) {
  // What you are HOLDING is a thing that changes at the table — you drop a weapon, you pick a
  // different one up — so it is editable here rather than frozen at creation. It is also the only
  // way a character saved before weapons were choosable can stop listing all three at once.
  const carried = Array.isArray(ch.weapons) ? ch.weapons : [];
  const weps = d.weapons.map((w) => chipTip(
    `<button class="chip ${carried.includes(w.name) ? "on" : ""}" data-act="carry" data-val="${esc(w.name)}">${esc(w.name)}</button>`,
    weaponTipHTML(w, d))).join("");
  return `<section class="panel"><h2>Gear</h2>
    <p class="gear-line"><strong>${esc(d.armor ? d.armor.name : "No armour")}</strong>
      ${d.armor ? `<span class="muted">AC ${esc(d.armor.baseAC)}</span> ${d.armor.trait ? armorTraitHTML(d.armor.trait) : ""}` : ""}
      ${d.shield ? `<strong>${esc(d.shield.name)}</strong> <span class="muted">+${esc(d.shield.acBonus)}</span>` : ""}</p>
    <p class="panel-sub">Carrying <span class="muted">— your class is proficient with all of these</span></p>
    <div class="chips">${weps}</div>
    ${carried.length ? "" : `<p class="muted">Nothing chosen, so every weapon you are proficient with is listed under Attacks.</p>`}
  </section>`;
}

/* Anything that is not a weapon, a suit of armour or a class feature. Firebase drops an empty array
   entirely, so an absent list and an empty one have to mean the same thing here. */
function invItems(ch) {
  return Array.isArray(ch.items) ? ch.items.filter((it) => it && it.name) : [];
}

/* The bag: free text with a count beside it, because no item in this system has mechanical weight
   yet — there is nothing to look an entry up against, and pretending otherwise would mean inventing
   an item list the rules do not have. Coins are one number for the same reason: denominations are
   the economy's business, and the economy is not designed yet. */
function inventoryPanel(ch, items) {
  const rows = items.map((it, i) => `<div class="inv-row">
      <span class="inv-name">${esc(it.name)}</span>
      <span class="stepper">
        <button class="step-btn" data-act="inv-qty" data-val="${i}|-1">&minus;</button>
        <span class="step-val">${esc(it.qty || 1)}</span>
        <button class="step-btn" data-act="inv-qty" data-val="${i}|1">+</button>
      </span>
      <button class="btn-quiet" data-act="inv-del" data-val="${i}">Drop</button>
    </div>`).join("");
  return `<section class="panel"><h2>Inventory</h2>
    ${rows ? `<div class="inv-list">${rows}</div>`
      : `<p class="muted">Empty. Whatever the DM hands you goes in here — rope, a lantern, someone's stolen ledger.</p>`}
    <div class="inv-add">
      <input id="inv-new" class="text" type="text" maxlength="60" autocomplete="off"
        placeholder="Rope, 50 ft" value="" />
      <button class="btn-quiet" data-act="inv-add">Add</button>
    </div>
    <p class="panel-sub">Coins</p>
    <div class="hp-controls">
      <span class="coin-total">${esc(Number(ch.coins) || 0)}</span>
      <input id="coin-amt" class="num" type="number" min="1" value="1" />
      <button class="btn-quiet" data-act="coin" data-val="1">Gain</button>
      <button class="btn-quiet" data-act="coin" data-val="-1">Spend</button>
    </div>
    ${ch.notes ? `<p class="panel-sub">Notes</p><p class="notes">${esc(ch.notes)}</p>` : ""}
  </section>`;
}

/* ---------------------------------------------------------------- levelling up */

/* The next level's ability-score bump, applied on top of the stored scores without touching them
   until the level-up is confirmed. */
function withAsi(scores, asi) {
  const out = Object.assign({}, scores);
  for (const a of Object.keys(asi || {})) out[a] = Math.min(20, (Number(out[a]) || 10) + asi[a]);
  return out;
}
function asiSpent(asi) { return Object.values(asi || {}).reduce((n, v) => n + v, 0); }

function progressPanel(d) {
  const nextLv = d.level + 1;
  const atMax = d.level >= 20;
  return `<section class="panel"><h2>Progress</h2>
    <p class="muted">Level ${esc(d.level)} · proficiency ${esc(sign(d.prof))} ·
      ${esc(d.features.length)} feature${d.features.length === 1 ? "" : "s"}${d.tricks.length ? ` · ${esc(d.tricks.length)} tricks` : ""}.
      ${atMax ? "This is the ceiling." : `Level ${esc(nextLv)} is next${ASI_LEVELS.includes(nextLv) ? " — and it carries an ability score increase" : ""}.`}</p>
    <div class="hp-controls">
      <button class="btn" data-act="levelup" ${atMax ? "disabled" : ""}>Level up to ${esc(Math.min(20, nextLv))}</button>
      ${d.level > 1 ? `<button class="btn-quiet" data-act="leveldown">Undo a level</button>` : ""}
    </div>
  </section>`;
}

/* Choosing a discipline is permanent and it is the single biggest decision on the ladder, so it is
   not a row of chips with a flavour line. Each one opens to show every feature it will ever give —
   with the rules text, the meta chips and any options table — plus the tricks it grants, marking
   which of them are still out of reach at this level.

   Shared by the creator and the level-up panel: it is the same decision either way, and it was the
   creator's version that was a row of chips. `attr` is which event channel the caller listens on
   ("pick" for the creator, "act" for the sheet) — the only thing that differs between them. */
function disciplineCards(cls, selectedId, level, attr) {
  const subs = (store.subclasses || []).filter((s) => s.parentClass === cls.id);
  return `<div class="sub-choice">${subs.map((s) => {
    const on = selectedId === s.id;
    const open = ui.openSubs.has(s.id);
    const feats = (s.features || []).slice().sort((a, b) => (a.level || 1) - (b.level || 1));
    const gts = (store.tricks || []).filter((t) => (t.subclasses || []).includes(s.id || s.name));
    return `<div class="sub-card ${on ? "on" : ""}">
      <button class="feat-toggle" data-${attr}="sub-open" data-val="${esc(s.id)}">
        <span class="feat-name">${esc(s.name)}</span>
        <span class="muted">${esc(feats.length)} features${gts.length ? ` · ${esc(gts.length)} tricks` : ""}</span>
        <span class="chev">${open ? "&minus;" : "+"}</span>
      </button>
      ${s.flavor ? `<p class="muted">${esc(s.flavor)}</p>` : ""}
      ${open ? `<div class="feat-body">
        <ul class="lu-list">${feats.map((f) => `<li>
          <span class="lvl">L${esc(f.level)}</span> <strong>${esc(f.name)}</strong>
          ${f.role === "roleplay" ? `<span class="role-badge">Roleplay</span>` : ""}
          ${(f.level || 1) > level ? `<span class="why">not until level ${esc(f.level)}</span>` : ""}
          <span class="lu-sum">${metaRow(f.meta)}${fmtDesc(f.sheetSummary || f.description || "")}
            ${Array.isArray(f.options) && f.options.length ? optionTable(f.options) : ""}</span>
        </li>`).join("")}
        ${gts.map((t) => `<li>
          <span class="lvl">L${esc(Math.max(t.minLevel || 1, cls.subclassLevel || 3))}</span>
          <strong>${esc(t.name)}</strong> <span class="tier-badge tier-${esc(t.tier)}">${esc(cap(t.tier))}</span>
          <span class="lu-sum">${fmtDesc(t.sheetSummary || "", trickLadder(t))}</span>
        </li>`).join("")}</ul></div>` : ""}
      <button class="${on ? "btn" : "btn-quiet"}" data-${attr}="${attr === "act" ? "lu-sub" : "subclass"}" data-val="${esc(s.id)}">${on ? "Chosen" : "Choose this"}</button>
    </div>`;
  }).join("")}</div>`;
}

/* A preview, not a mutation. Level is one of the few things actually STORED on a character, and
   every number on the sheet hangs off it, so the panel shows exactly what the level would add —
   hit points, features, tricks — and writes nothing until Confirm. */
function levelUpPanel(dNow) {
  const lu = ui.levelUp, ch = sheet.ch;
  const cls = dNow.cls;
  const subLv = cls.subclassLevel || 3;
  const needsSub = lu.to >= subLv && !ch.subclassId;
  const isAsi = ASI_LEVELS.includes(lu.to);
  const preview = Object.assign({}, ch, {
    level: lu.to,
    subclassId: ch.subclassId || lu.subclassId,
    scores: withAsi(ch.scores, lu.asi),
  });
  const dNext = derive(preview);
  const before = new Set(dNow.features.map((f) => f._from + "|" + f.name));
  const gainedF = dNext.features.filter((f) => !before.has(f._from + "|" + f.name));
  const beforeT = new Set(dNow.tricks.map((t) => t.id || slug(t)));
  const gainedT = dNext.tricks.filter((t) => !beforeT.has(t.id || slug(t)));
  const hpGain = dNext.hpMax - dNow.hpMax;

  const subBlock = needsSub ? `<div class="lu-block lu-full"><h3>Choose a discipline</h3>
    <p class="muted">This is permanent. Open each one and read what it actually gives you before you pick.</p>
    ${disciplineCards(cls, lu.subclassId, lu.to, "act")}</div>` : "";

  const spent = asiSpent(lu.asi);
  const asiBlock = isAsi ? `<div class="lu-block"><h3>Ability score increase
      <span class="budget">${esc(2 - spent)}</span> left</h3>
    <div class="lu-asi">${ABILITIES.map((a) => {
      const at = (Number(ch.scores[a]) || 10) + (lu.asi[a] || 0);
      const canUp = spent < 2 && at < 20 && (lu.asi[a] || 0) < 2;
      return `<span class="stepper">
        <span class="ab-name">${esc(ABIL_SHORT[a])}</span>
        <button class="step-btn" data-act="lu-asi" data-val="${a}|-1" ${lu.asi[a] ? "" : "disabled"}>&minus;</button>
        <span class="step-val">${esc(at)}</span>
        <button class="step-btn" data-act="lu-asi" data-val="${a}|1" ${canUp ? "" : "disabled"}>+</button>
      </span>`;
    }).join("")}</div>
    <p class="muted">Two points: +2 to one ability, or +1 to two. Nothing goes past 20.</p></div>` : "";

  const blocked = (needsSub && !lu.subclassId) || (isAsi && spent < 2);
  // A name alone is not enough to decide anything on, which is the whole complaint: what a level
  // gives you has to be readable at the moment you take it, not one navigation away.
  const list = (arr, empty) => arr.length
    ? `<ul class="lu-list">${arr.map((x) => `<li>
        <span class="lvl">L${esc(x.level || x._at)}</span> <strong>${esc(x.name)}</strong>
        ${x._from && x._from !== cls.name ? `<span class="muted">${esc(x._from)}</span>` : ""}
        ${x.role === "roleplay" ? `<span class="role-badge">Roleplay</span>` : ""}
        <span class="lu-sum">${fmtDesc(x.sheetSummary || x.description || "", x.tier ? trickLadder(x) : undefined)}</span>
      </li>`).join("")}</ul>`
    : `<p class="lu-none">${esc(empty)}</p>`;

  return `<section class="panel levelup">
    <h2>Level ${esc(dNow.level)} &rarr; ${esc(lu.to)}</h2>
    <div class="lu-grid">
      <div class="lu-block"><h3>Hit points</h3>
        <p><span class="lu-hp">+${esc(hpGain)}</span> <span class="muted">→ ${esc(dNext.hpMax)} max</span></p>
        <p class="muted">The average of your d${esc(cls.hitDie)}, rounded up, plus your Constitution modifier.</p></div>
      <div class="lu-block"><h3>New features</h3>${list(gainedF, "Nothing new at this level.")}</div>
      ${dNext.tricks.length || gainedT.length ? `<div class="lu-block"><h3>New tricks</h3>${list(gainedT, "No new tricks at this level.")}</div>` : ""}
      ${subBlock}
      ${asiBlock}
    </div>
    <div class="lu-acts">
      <button class="btn" data-act="lu-confirm" ${blocked ? "disabled" : ""}>Confirm level ${esc(lu.to)}</button>
      <button class="btn-quiet" data-act="lu-cancel">Cancel</button>
      ${blocked ? `<span class="why">${esc(needsSub && !lu.subclassId ? "Choose a discipline first." : "Spend both ability points first.")}</span>` : ""}
    </div>
  </section>`;
}

/* ---------------------------------------------------------------- deleting */

/* The six-digit code is the ONLY copy of a character — there is no account it also lives under and
   no backup anywhere — so deleting is genuinely irreversible and is gated behind typing the word,
   not behind a second click that muscle memory sails through. */
function dangerPanel() {
  if (!ui.deleteArmed) {
    return `<section class="panel danger"><h2>Delete this character</h2>
      <p class="muted">Erases it everywhere and frees the code for reuse. The code is the only copy —
        there is no backup and no undo.</p>
      <button class="btn-quiet" data-act="delete-arm">Delete permanently…</button></section>`;
  }
  return `<section class="panel danger armed"><h2>Delete this character</h2>
    <p class="muted">This erases <strong>${esc(sheet.ch.name || "Unnamed")}</strong> from code
      <strong>${esc(sheet.code)}</strong>, for everyone at your table. Type
      <strong>CONFIRM</strong> — capitals and all — to unlock the button.</p>
    <div class="danger-row">
      <input id="del-confirm" class="text" type="text" autocomplete="off" spellcheck="false"
        placeholder="CONFIRM" value="${esc(ui.deleteText)}" />
      <button class="btn btn-hot" data-act="delete-go" ${ui.deleteText === "CONFIRM" ? "" : "disabled"}>Delete permanently</button>
      <button class="btn-quiet" data-act="delete-cancel">Cancel</button>
    </div>
    <p id="del-msg" class="save-msg"></p></section>`;
}

async function deleteCharacter() {
  if (ui.deleteText !== "CONFIRM" || !sheet) return;
  const msg = $("#del-msg");
  const code = sheet.code;
  // A debounced save from the last action would otherwise land AFTER the delete and put the
  // character straight back.
  clearTimeout(saveTimer);
  if (msg) { msg.textContent = "Deleting…"; msg.className = "save-msg"; }
  try {
    await CocStore.remove(code);
    localStorage.setItem(RECENT_KEY, JSON.stringify(recentCodes().filter((r) => r.code !== code)));
    sheet = null;
    ui.deleteArmed = false; ui.deleteText = "";
    location.hash = "#/manage";
  } catch (err) {
    if (msg) { msg.textContent = "Could not delete: " + err.message; msg.className = "save-msg bad"; }
  }
}

/* ---------------------------------------------------------------- sheet actions */

/* Actions that only move the interface around — expanding a feature, opening the level-up preview
   — must not write to storage. Listed here so the difference is declared rather than remembered. */
const UI_ONLY_ACTS = new Set(["levelup", "lu-cancel", "lu-sub", "open-opts",
                              "sub-open", "lu-asi", "delete-arm", "delete-cancel", "tab"]);

function sheetAction(e) {
  const b = e.target.closest("[data-act]");
  if (!b || b.disabled || !sheet) return;
  const { act, val } = b.dataset;
  // The only action that leaves this page entirely, and the only asynchronous one.
  if (act === "delete-go") { deleteCharacter(); return; }
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
  else if (act === "carry") {
    const have = Array.isArray(ch.weapons) ? ch.weapons : [];
    ch.weapons = have.includes(val) ? have.filter((w) => w !== val) : have.concat(val);
  }
  // Opening a field takes you to the top OF THAT FIELD, not to the top of the page: on a phone the
  // vitals fill the first screen, so leaving the scroll alone means tapping Tricks shows you your
  // hit points and scrolling to 0 shows you them from further away.
  else if (act === "tab") { ui.tab = val; ui.scrollToFields = true; }
  else if (act === "inv-add") {
    // Read at the click, not on every keystroke: the sheet repaints on any change, and a field whose
    // value came from state would lose the caret on every letter typed.
    const box = $("#inv-new");
    const name = String(box ? box.value : "").trim();
    if (!name) return;
    ch.items = invItems(ch).concat({ name, qty: 1 });
  } else if (act === "inv-qty") {
    const [i, delta] = String(val).split("|");
    const list = invItems(ch);
    const it = list[Number(i)];
    if (!it) return;
    it.qty = Math.max(1, (Number(it.qty) || 1) + Number(delta));
    ch.items = list;
  } else if (act === "inv-del") {
    ch.items = invItems(ch).filter((_, i) => i !== Number(val));
  } else if (act === "coin") {
    const box = $("#coin-amt");
    const n = Math.max(1, Number(box ? box.value : 1) || 1);
    ch.coins = Math.max(0, (Number(ch.coins) || 0) + n * Number(val));
  }
  else if (act === "levelup") {
    ui.levelUp = { to: Math.min(20, d.level + 1), subclassId: "", asi: {} };
    ui.scrollTop = true;   // the panel opens above the fold; take the reader to it
  }
  else if (act === "lu-cancel") ui.levelUp = null;
  else if (act === "lu-sub") ui.levelUp.subclassId = ui.levelUp.subclassId === val ? "" : val;
  else if (act === "open-opts") { ui.openOpts.has(val) ? ui.openOpts.delete(val) : ui.openOpts.add(val); }
  else if (act === "sub-open") { ui.openSubs.has(val) ? ui.openSubs.delete(val) : ui.openSubs.add(val); }
  else if (act === "delete-arm") { ui.deleteArmed = true; ui.deleteText = ""; }
  else if (act === "delete-cancel") { ui.deleteArmed = false; ui.deleteText = ""; }
  else if (act === "lu-asi") {
    const [a, delta] = val.split("|");
    const asi = ui.levelUp.asi;
    const next = (asi[a] || 0) + Number(delta);
    const at = (Number(ch.scores[a]) || 10) + next;
    if (next >= 0 && next <= 2 && at <= 20 && asiSpent(asi) - (asi[a] || 0) + next <= 2) {
      if (next === 0) delete asi[a]; else asi[a] = next;
    }
  } else if (act === "lu-confirm") {
    const lu = ui.levelUp;
    const before = d.hpMax;
    ch.level = lu.to;
    if (lu.subclassId) ch.subclassId = lu.subclassId;
    if (asiSpent(lu.asi)) {
      // Recorded per level so Undo a level can put the points back exactly.
      ch.asiLog = Object.assign({}, ch.asiLog, { [lu.to]: Object.assign({}, lu.asi) });
      ch.scores = withAsi(ch.scores, lu.asi);
    }
    const after = derive(ch).hpMax;
    p.hp = Math.max(1, Math.min(after, p.hp + (after - before)));
    ui.levelUp = null;
  } else if (act === "leveldown") {
    const from = ch.level;
    const before = d.hpMax;
    ch.level = Math.max(1, from - 1);
    if (ch.asiLog && ch.asiLog[from]) {
      for (const a of Object.keys(ch.asiLog[from])) ch.scores[a] = (Number(ch.scores[a]) || 10) - ch.asiLog[from][a];
      delete ch.asiLog[from];
    }
    if (ch.level < (d.cls.subclassLevel || 3)) ch.subclassId = "";
    const after = derive(ch).hpMax;
    p.hp = Math.max(1, Math.min(after, p.hp - (before - after)));
    ui.levelUp = null;
  } else return;

  renderSheet();
  if (ui.scrollTop) {
    ui.scrollTop = false;
    if (window.scrollTo) window.scrollTo({ top: 0, behavior: "smooth" });
    else pageScroller().scrollTop = 0;
  }
  if (ui.scrollToFields) {
    ui.scrollToFields = false;
    const strip = $(".tab-strip");
    // scroll-margin-top on .tab-strip keeps the sticky top bar from covering it.
    if (strip && strip.scrollIntoView) strip.scrollIntoView({ block: "start", behavior: "smooth" });
  }
  if (!UI_ONLY_ACTS.has(act)) persist();
}

/* ---------------------------------------------------------------- wiring */

COC_ROUTES.create = routeCreate;
COC_ROUTES.manage = routeManage;
COC_ROUTES.sheet = routeSheet;
COC_ROUTES.roster = routeRoster;

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
document.addEventListener("focusout", (e) => {
  if (!toolEl() || $("#tool-view").classList.contains("hidden")) return;
  creatorBlur(e);
});
// Switching views replaces the page's content, so the browser has nothing to restore the scroll
// position from — it has to be remembered on the way out.
window.addEventListener("scroll", () => { if (sheet) ui.sheetScroll = pageScroller().scrollTop; }, { passive: true });

document.addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  if (e.target.id === "open-code") { e.preventDefault(); openByCode(); }
});
