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
