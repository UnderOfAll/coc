/*
 * Circus of Chaos — the DM's own record, and the enemy builder.
 *
 * WHY A SECOND KIND OF CODE. The DM KEY that opens a room's chair is a DOOR: it belongs to that room, it
 * stops a player claiming the chair, and it dies with the table. This is an IDENTITY: a six-digit code
 * that belongs to the PERSON, carrying the tables they run, their notes and the enemies they have built,
 * between devices and past any one room being closed. Kayki: "even if the table is deleted one day, the
 * [enemies] maintain there."
 *
 * They are deliberately not merged. One leaked code would otherwise hand over every room he has ever run,
 * and the two are named differently on screen so nobody has to wonder which one they are typing.
 *
 * WHAT THE BUILDER IS FOR. The nine authored enemies are one-shots to test the system; a DM needs to make
 * their own, and the form changes with the tier because the tiers are genuinely different animals:
 *   normal  — a picture, HP, AC, resistances, and one to three attacks. Nothing else.
 *   special — that, plus a Parry DC and features it can use.
 *   boss    — that, plus a class it wears and up to five features.
 * Nothing here resolves anything: a built enemy is a card a DM reads out, the same as an authored one.
 */

const DM_LAST = "coc:dm:last";          // the code this browser last opened, so it opens itself
const DM_RECENT = "coc:dm:recent";      // codes seen on this device

let dm = null;                          // { code, rec } while a DM record is open
const dmUi = { tab: "enemies", editing: null, draft: null, msg: "", pick: "", pickFrom: "" };

function dmBlank() {
  return { v: 1, name: "", tables: [], notes: [], enemies: [] };
}

/* A built enemy starts as the plainest thing that is still a creature: the tier decides what the form
   then asks for. Ids carry a suffix so a built "Sawdust Hound" can never collide with the authored one. */
function dmBlankEnemy(tier) {
  return {
    id: "", custom: true, name: "", flavor: "", tier: tier || "normal", size: "Medium", kind: "",
    partyLevel: "", ac: 12, hp: 10, speed: 30,
    image: "", parryDC: null, resist: [], immune: [], vulnerable: [], senses: "",
    abilities: {}, saveProf: [], prof: 2, initMod: null,
    multiattack: "", attacks: [{ name: "Attack", kind: "melee", toHit: 3, reach: "5 ft", damage: "1d6+1", damageType: "bludgeoning", note: "" }],
    features: [], tactics: "", narration: "",
  };
}

const DM_DAMAGE_TYPES = ["bludgeoning", "piercing", "slashing", "psychic", "fire", "cold", "lightning",
  "thunder", "acid", "poison", "necrotic", "radiant", "force"];
/* Conditions come from the ONE list the whole app uses (creator.js), so a built enemy can only be immune
   to something the board can actually show. */
function dmConditionNames() {
  return (typeof UNIVERSAL_STATES !== "undefined" ? UNIVERSAL_STATES : []).map(([, label]) => label);
}
const DM_TIERS = [
  ["normal", "Normal", "an AC, hit points and one to three attacks — several at once"],
  ["special", "Special", "a Parry, and features it can actually use"],
  ["boss", "Boss", "a class it wears, and up to five features"],
];
const DM_MAX_BOSS_FEATURES = 5;

/* ---------------------------------------------------------------- storage */

function dmRecent() {
  try { return JSON.parse(localStorage.getItem(DM_RECENT) || "[]"); } catch { return []; }
}
function dmRemember(code, name) {
  const list = dmRecent().filter((r) => r.code !== code);
  list.unshift({ code, name: name || "", at: Date.now() });
  localStorage.setItem(DM_RECENT, JSON.stringify(list.slice(0, 6)));
  localStorage.setItem(DM_LAST, code);
}
function dmForget(code) {
  localStorage.setItem(DM_RECENT, JSON.stringify(dmRecent().filter((r) => r.code !== code)));
  if (localStorage.getItem(DM_LAST) === code) localStorage.removeItem(DM_LAST);
}
/* The code this browser is signed in as, for the table to read. */
function dmCode() { return localStorage.getItem(DM_LAST) || ""; }

let dmSaveTimer = null;
function dmPersist() {
  clearTimeout(dmSaveTimer);
  if (!dm) return;
  const code = dm.code, rec = dm.rec;
  dmSetMsg("saving…");
  dmSaveTimer = setTimeout(async () => {
    try {
      await CocDm.save(code, rec);
      dmCacheEnemies(code, rec.enemies || []);
      dmSetMsg("saved");
    } catch (err) { dmSetMsg("not saved — " + dmWhy(err), true); }
  }, 400);
}
/* A 401 HERE MEANS ONE THING, so it should say it. The `dms` branch is newer than most databases this
   has been pointed at, and until its rules are published every read and write is refused — while the page
   cheerfully reports "saving to the cloud", which is about config.js and not about permission. Guessing
   that from "401" costs an evening; it cost one. */
function dmWhy(err) {
  const m = String((err && err.message) || err);
  if (!/401|403|permission/i.test(m)) return m;
  return m + " — the database is refusing this. The `dms` rules have probably not been published yet: "
    + "see docs/CLOUD_SETUP.md, paste the whole rules block into the Firebase console and Publish.";
}

function dmSetMsg(t, bad) {
  dmUi.msg = t;
  const n = document.querySelector("#dm-state");
  if (n) { n.textContent = t; n.className = bad ? "bad" : ""; }
}

/* A COPY ON THIS DEVICE, so the table does not have to fetch the record before it can draw a card. The
   record is the truth; this is what the board reads while a fight is running. */
function dmCacheEnemies(code, list) {
  try { localStorage.setItem("coc:dm:enemies:" + code, JSON.stringify(list || [])); } catch { /* full */ }
}
function dmCachedEnemies() {
  const code = dmCode();
  if (!code) return [];
  try { return JSON.parse(localStorage.getItem("coc:dm:enemies:" + code) || "[]"); } catch { return []; }
}

/* ---------------------------------------------------------------- routes */

async function routeDm(arg) {
  const code = String(arg || "").replace(/\D/g, "").slice(0, 6);
  if (!CocDm.validCode(code)) { dm = null; renderDmDoor(); return; }
  paint(`<div class="tool-head"><h1>Opening…</h1></div>`);
  let rec = null;
  try { rec = await CocDm.load(code); } catch (err) {
    paint(`<div class="tool-head"><a class="back" href="#/dm">&larr; Back</a><h1>Could not open ${esc(code)}</h1>
      <p class="warn">${esc(dmWhy(err))}</p></div>`);
    return;
  }
  if (!rec) { dm = null; renderDmDoor(`Nothing is saved under ${code}. Start a new one below.`); return; }
  dm = { code, rec: Object.assign(dmBlank(), rec) };
  dmRemember(code, dm.rec.name);
  dmCacheEnemies(code, dm.rec.enemies || []);
  dmUi.editing = null;
  renderDm();
}

function renderDmDoor(msg) {
  const recent = dmRecent();
  paint(`
    <div class="tool-head">
      <a class="back" href="#/">&larr; Menu</a>
      <h1>The DM's screen</h1>
      <p class="muted">A six-digit code of your own. It carries the tables you run, your notes and the
        enemies you have built — between devices, and past any one table being closed.</p>
    </div>
    ${/* Said plainly, because two codes is exactly the sort of thing that gets confused once and then
          costs an evening. */""}
    <section class="step">
      <p class="muted"><strong>This is not the key to a room.</strong> A table still has its own DM key,
        which is what stops a player taking the chair. This is who you are; that is a door.</p>
    </section>
    <section class="step">
      <label class="field-label">Open your screen</label>
      <div class="save-row">
        <input id="dm-open" class="code-input" inputmode="numeric" maxlength="6" placeholder="000000" />
        <button class="btn" data-dm="open">Open</button>
      </div>
      <p id="dm-msg" class="save-msg${msg ? " bad" : ""}">${esc(msg || "")}</p>
    </section>
    <section class="step">
      <label class="field-label">Or start one</label>
      <div class="save-row">
        <input id="dm-new" class="code-input" inputmode="numeric" maxlength="6" placeholder="pick six digits" />
        <button class="btn" data-dm="new">Start</button>
      </div>
      <p class="muted">${esc(CocDm.describe())}</p>
    </section>
    ${recent.length ? `<section class="step"><h2>On this device</h2>
      <div class="recent">${recent.map((r) => `
        <div class="recent-row">
          <a class="recent-open" href="#/dm/${esc(r.code)}">
            <strong>${esc(r.name || "Unnamed DM")}</strong><span class="muted">code ${esc(r.code)}</span>
          </a>
          <button class="btn-quiet" data-dm="forget" data-val="${esc(r.code)}">Forget</button>
        </div>`).join("")}</div></section>` : ""}
  `);
}

function renderDm() {
  if (!dm) { renderDmDoor(); return; }
  if (dmUi.editing) { renderDmEnemyForm(); return; }
  const rec = dm.rec;
  const tabs = [["enemies", "Enemies", (rec.enemies || []).length],
                ["tables", "Tables", (rec.tables || []).length],
                ["notes", "Notes", (rec.notes || []).length]];
  paint(`
    <div class="tool-head sheet-head">
      <a class="back" href="#/dm">&larr; DM codes</a>
      <div class="sheet-id">
        <div class="sheet-titles">
          <h1>${esc(rec.name || "The DM's screen")}</h1>
          <p class="sheet-code">code <strong>${esc(dm.code)}</strong>
            <span class="sep">&middot;</span> <span id="dm-state">${esc(dmUi.msg || "saved")}</span></p>
        </div>
      </div>
    </div>
    <section class="panel">
      <label class="field"><span>What to call you</span>
        <input id="dm-name" class="text" type="text" maxlength="40" value="${esc(rec.name || "")}"
          placeholder="The management" /></label>
    </section>
    <div class="tab-strip" role="tablist">${tabs.map(([id, label, n]) =>
      `<button class="tab ${dmUi.tab === id ? "on" : ""}" data-dm="tab" data-val="${id}"
        role="tab" aria-selected="${dmUi.tab === id}">${esc(label)}${n ? ` <span class="tab-n">${esc(n)}</span>` : ""}</button>`).join("")}</div>
    <div class="panes">${
      dmUi.tab === "enemies" ? dmEnemiesPane()
      : dmUi.tab === "tables" ? dmTablesPane()
      : dmNotesPane()}</div>
  `);
}

/* ---------------------------------------------------------------- the three panes */

function dmEnemiesPane() {
  const list = dm.rec.enemies || [];
  const byTier = DM_TIERS.map(([tier, label, note]) => {
    const inTier = list.filter((e) => (e.tier || "normal") === tier);
    if (!inTier.length) return "";
    return `<p class="panel-sub">${esc(label)} <span class="muted">— ${esc(note)}</span></p>
      <div class="scene-list">${inTier.map((e) => `<div class="scene-row">
        <button class="scene-pick" data-dm="edit" data-val="${esc(e.id)}">
          <strong>${esc(e.name || "Unnamed")}</strong>
          <span class="muted">AC ${esc(e.ac)} · ${esc(e.hp)} hp${
            e.parryDC != null ? " · Parry " + esc(e.parryDC) : ""}</span>
        </button>
        <button class="btn-quiet" data-dm="copy" data-val="${esc(e.id)}">Copy</button>
        <button class="btn-quiet" data-dm="drop" data-val="${esc(e.id)}">Delete</button>
      </div>`).join("")}</div>`;
  }).join("");
  return `<section class="panel">
      <p class="panel-sub">Build one</p>
      <div class="chips">${DM_TIERS.map(([tier, label, note]) =>
        `<button class="chip" data-dm="add" data-val="${tier}" title="${esc(note)}">${esc(label)}</button>`).join("")}</div>
      <p class="muted">The form asks for what that weight needs and nothing else. You can change the
        weight later; anything the new weight does not use is kept, not thrown away.</p>
    </section>
    ${list.length ? `<section class="panel">${byTier}</section>`
      : `<section class="panel"><p class="muted">Nothing built yet. They appear in your bestiary at any
         table you run, beside the ones that come with the system.</p></section>`}`;
}

function dmTablesPane() {
  const mine = dm.rec.tables || [];
  const here = (typeof tblRecent === "function" ? tblRecent() : [])
    .filter((r) => !mine.some((m) => m.code === r.code));
  return `<section class="panel">
      ${/* BY ITS CODE, because a room somebody else runs is invisible to this browser. The recent list is
            localStorage — rooms THIS device has opened — and the database cannot be listed (the code is
            the credential, storage-security-model). So a table your friend runs on his machine could
            never be added here, which is exactly what Kayki hit opening a shared DM code. */""}
      <p class="panel-sub">Add a room by its code</p>
      <div class="save-row">
        <input id="dm-room" class="code-input" inputmode="numeric" maxlength="6" placeholder="000000" />
        <button class="btn" data-dm="addcode">Add it</button>
      </div>
      <p id="dm-room-msg" class="save-msg"></p>
      <p class="panel-sub">Your tables</p>
      ${mine.length ? `<div class="recent">${mine.map((t) => `<div class="recent-row">
        <a class="recent-open" href="#/table/${esc(t.code)}">
          <strong>${esc(t.name || "Table")}</strong><span class="muted">room ${esc(t.code)}</span></a>
        <button class="btn-quiet" data-dm="untable" data-val="${esc(t.code)}">Forget</button>
      </div>`).join("")}</div>`
        : `<p class="muted">None yet. A room you run is added below.</p>`}
      <p class="muted">Kept on your code, so they are here on your next device. Forgetting one only takes
        it off this list — the room itself is untouched, and its own DM key still opens the chair.</p>
    </section>
    ${here.length ? `<section class="panel">
      <p class="panel-sub">Rooms this browser knows</p>
      <div class="recent">${here.map((r) => `<div class="recent-row">
        <a class="recent-open" href="#/table/${esc(r.code)}">
          <strong>${esc(r.name || "Table")}</strong><span class="muted">room ${esc(r.code)}</span></a>
        <button class="btn-quiet" data-dm="addtable" data-val="${esc(r.code)}|${esc(r.name || "")}">Keep it</button>
      </div>`).join("")}</div></section>` : ""}`;
}

function dmNotesPane() {
  const notes = dm.rec.notes || [];
  return `<section class="panel">
      <p class="panel-sub">Notes</p>
      ${notes.map((n, i) => `<div class="note-edit">
        <input class="text" data-dm-note="t${i}" type="text" maxlength="60" value="${esc(n.title || "")}"
          placeholder="What this is" />
        <textarea class="text notes-body" rows="5" data-dm-note="b${i}" maxlength="8000">${esc(n.body || "")}</textarea>
        <button class="btn-quiet" data-dm="note-drop" data-val="${i}">Delete this note</button>
      </div>`).join("")}
      <button class="btn-quiet" data-dm="note-add">Add a note</button>
      <p class="muted">These live on your code, not in a room, so closing a table does not take them with
        it. A table's own notepad is still there and still per-room — this is the campaign, that is the
        session.</p>
    </section>`;
}

/* ---------------------------------------------------------------- the builder */

function dmField(id, label, value, opts) {
  const o = opts || {};
  return `<label class="field"><span>${label}${o.hint ? ` <span class="muted">${esc(o.hint)}</span>` : ""}</span>
    <input id="${esc(id)}" class="${o.num ? "num" : "text"}" type="${o.num ? "number" : "text"}"
      ${o.min != null ? `min="${o.min}"` : ""} ${o.max != null ? `max="${o.max}"` : ""}
      ${o.maxlength ? `maxlength="${o.maxlength}"` : ""}
      placeholder="${esc(o.placeholder || "")}" value="${esc(value == null ? "" : value)}" /></label>`;
}

/* WHAT IS CHOSEN, PLUS ONE PICKER. This was three walls of thirteen chips each — thirty-nine buttons, of
   which a normal enemy presses none — and Kayki: "the resistances page needs redesign, it's ugly and
   weird." Now the row holds only what you have actually said, each with a way off, and everything else
   lives behind one small list. Nothing to scan past to reach the next question. */
function dmPickRow(act, all, chosen, label) {
  const on = (chosen || []);
  const left = all.filter((v) => !on.includes(v));
  return `<div class="pick-row">
    ${on.length ? `<div class="chips">${on.map((v) =>
      `<button class="chip on" data-dm="${act}" data-val="${esc(v)}" title="Remove">${esc(v)} &times;</button>`).join("")}</div>`
      : `<span class="muted">nothing</span>`}
    ${left.length ? `<select class="text pick-add" data-dm-add="${act}">
      <option value="">${esc(label)}</option>
      ${left.map((v) => `<option value="${esc(v)}">${esc(v)}</option>`).join("")}
    </select>` : ""}
  </div>`;
}

function renderDmEnemyForm() {
  const e = dmUi.draft;
  const tier = e.tier || "normal";
  const isNormal = tier === "normal";
  paint(`
    <div class="tool-head">
      <a class="back" href="#" data-dm="close">&larr; Back to your screen</a>
      <h1>${esc(e.name || "New enemy")}</h1>
      <p class="muted">${esc((DM_TIERS.find(([t]) => t === tier) || [])[2] || "")}</p>
    </div>

    <section class="panel">
      <p class="panel-sub">Weight</p>
      <div class="chips">${DM_TIERS.map(([t, label]) =>
        `<button class="chip ${tier === t ? "on" : ""}" data-dm="tier" data-val="${t}">${esc(label)}</button>`).join("")}</div>
      ${isNormal ? `<p class="muted">A normal enemy does not Parry — it simply takes the hit, which is what
        keeps a room of six moving.</p>` : ""}
    </section>

    <section class="panel">
      ${dmField("en-name", "Name", e.name, { maxlength: 40, placeholder: "Sawdust Hound" })}
      ${dmField("en-flavor", "One line", e.flavor, { maxlength: 200,
        placeholder: "A ring dog gone feral, ribs like tent poles." })}
      <div class="grid-row">
        ${dmField("en-ac", "Armour class", e.ac, { num: true, min: 5, max: 25 })}
        ${dmField("en-hp", "Hit points", e.hp, { num: true, min: 1 })}
        ${dmField("en-speed", "Speed (ft)", e.speed, { num: true, min: 0, max: 200 })}
      </div>
      <div class="grid-row">
        ${dmField("en-kind", "Sort of thing", e.kind, { maxlength: 30, placeholder: "beast" })}
      </div>
      <div class="grid-row">
        <label class="field"><span>Size <span class="muted">— Large is 2 squares</span></span>
          <select id="en-size" class="text">${["Tiny", "Small", "Medium", "Large", "Huge"].map((s) =>
            `<option ${e.size === s ? "selected" : ""}>${s}</option>`).join("")}</select></label>
        ${dmField("en-levels", "For levels", e.partyLevel, { maxlength: 10, placeholder: "1-3" })}
      </div>
      ${isNormal ? "" : `<div class="grid-row">
        ${dmField("en-parry", "Parry DC", e.parryDC == null ? "" : e.parryDC,
          { num: true, min: 3, max: 20, hint: "lower is better" })}
        ${dmField("en-senses", "Senses", e.senses, { maxlength: 60, placeholder: "blindsight 30 ft" })}
      </div>`}
    </section>

    <section class="panel">
      <p class="panel-sub">Picture</p>
      ${e.image ? `<img class="figure-art figure-thumb" src="${esc(e.image)}" alt="" />` : ""}
      <label class="field"><span>From this device</span>
        <input id="en-file" class="text" type="file" accept="image/*" /></label>
      <p id="en-imgmsg" class="save-msg"></p>
      <label class="field"><span>Or a link</span>
        <input id="en-img" class="text" type="text" value="${esc(String(e.image || "").startsWith("data:") ? "" : (e.image || ""))}"
          placeholder="https://… or maps/…" /></label>
    </section>

    <section class="panel">
      <p class="panel-sub">Damage</p>
      <div class="dmg-rules">
        <div class="dmg-rule"><span class="dmg-k">Takes half from</span>
          ${dmPickRow("resist", DM_DAMAGE_TYPES, e.resist, "add a damage type…")}</div>
        <div class="dmg-rule"><span class="dmg-k">Takes double from</span>
          ${dmPickRow("vulnerable", DM_DAMAGE_TYPES, e.vulnerable, "add a damage type…")}</div>
        <div class="dmg-rule"><span class="dmg-k">Ignores</span>
          ${dmPickRow("immune", DM_DAMAGE_TYPES.concat(dmConditionNames()), e.immune, "add damage or a condition…")}</div>
      </div>
      <p class="muted">Most enemies need none of this. It is the lever that makes a party's odd trick
        suddenly the right answer.</p>
    </section>

    ${dmAbilitiesSection(e)}
    ${dmAttacksSection(e)}
    ${isNormal ? "" : dmFeaturesSection(e)}

    <section class="panel">
      <label class="field"><span>How to play it <span class="muted">— what it opens with, what it does when hurt</span></span>
        <textarea id="en-tactics" class="text notes-body" rows="4" maxlength="1200">${esc(e.tactics || "")}</textarea></label>
      <label class="field"><span>In play <span class="muted">— what the table sees</span></span>
        <textarea id="en-narration" class="text notes-body" rows="3" maxlength="600">${esc(e.narration || "")}</textarea></label>
    </section>

    <section class="panel">
      <div class="hp-controls">
        <button class="btn" data-dm="save-enemy">Save it</button>
        <button class="btn-quiet" data-dm="close">Back without saving</button>
      </div>
      <p id="en-msg" class="save-msg"></p>
    </section>
  `);
}

/* THE SIX, AS STEPPERS. They were six number boxes with a "save" caption and a separate chip row called
   "Good at these saves" and a field called "That bonus" — three controls for one idea, and Kayki read all
   three as noise: "the abilities modifier is the most confusing thing I've ever seen… good at saves, I
   don't even know what that is for."
 *
 * So: one row per ability, a minus and a plus like point buy, and the ONE extra thing said in words a DM
 * uses — "hard to X" — because that is what a proficient save actually means at the table: the creature
 * shrugs that off. The number it rolls is printed at the end of the row, so nothing is added up mid-fight.
 *
 * A player's best is about +3 at these levels, and the row says so once rather than in a paragraph. */
const DM_SAVE_WORDS = {
  Strength: "hard to shove", Dexterity: "hard to catch", Constitution: "hard to wear down",
  Intelligence: "hard to fool", Wisdom: "hard to charm", Charisma: "hard to rattle",
};
function dmAbilitiesSection(e) {
  const ab = e.abilities || {};
  const good = new Set(e.saveProf || []);
  return `<section class="panel">
    <p class="panel-sub">Abilities <span class="muted">— a player's best is about +3</span></p>
    <div class="abil-rows">${ENEMY_ABILITIES.map((a) => {
      const m = Number(ab[a] || 0);
      const isGood = good.has(a);
      return `<div class="abil-row ${isGood ? "on" : ""}">
        <span class="abil-name">${esc(a)}</span>
        <span class="stepper">
          <button class="btn-quiet" data-dm="abil" data-val="${esc(a)}|-1" ${m <= -5 ? "disabled" : ""}>&minus;</button>
          <span class="abil-val">${esc(sign(m))}</span>
          <button class="btn-quiet" data-dm="abil" data-val="${esc(a)}|1" ${m >= 10 ? "disabled" : ""}>+</button>
        </span>
        <button class="chip ${isGood ? "on" : ""}" data-dm="saveprof" data-val="${esc(a)}"
          title="It shrugs this off: +2 when something forces it to save">${esc(DM_SAVE_WORDS[a])}</button>
        <span class="abil-save muted">rolls ${esc(sign(m + (isGood ? 2 : 0)))}</span>
      </div>`;
    }).join("")}</div>
    <p class="muted">The number on the right is what it rolls when one of you forces a save on it.
      Initiative is its Dexterity.</p>
  </section>`;
}

function dmAttacksSection(e) {
  const atks = e.attacks || [];
  const weapons = (typeof store !== "undefined" && Array.isArray(store.weapons)) ? store.weapons : [];
  return `<section class="panel">
    <p class="panel-sub">Attacks <span class="muted">— one to three</span></p>
    ${atks.map((a, i) => `<div class="atk-edit">
      <div class="grid-row">
        <label class="field"><span>Name</span>
          <input class="text" data-atk="name|${i}" type="text" maxlength="30" value="${esc(a.name || "")}" /></label>
        <label class="field"><span>Melee or ranged</span>
          <select class="text" data-atk="kind|${i}">
            <option value="melee" ${a.kind !== "ranged" ? "selected" : ""}>Melee</option>
            <option value="ranged" ${a.kind === "ranged" ? "selected" : ""}>Ranged</option>
          </select></label>
        <label class="field"><span>To hit</span>
          <input class="num" data-atk="toHit|${i}" type="number" min="-5" max="20" value="${esc(a.toHit ?? 3)}" /></label>
      </div>
      <div class="grid-row">
        <label class="field"><span>Reach or range</span>
          <input class="text" data-atk="reach|${i}" type="text" maxlength="20" value="${esc(a.reach || "")}"
            placeholder="${a.kind === "ranged" ? "20/60 ft" : "5 ft"}" /></label>
        <label class="field"><span>Damage</span>
          <input class="text" data-atk="damage|${i}" type="text" maxlength="20" value="${esc(a.damage || "")}"
            placeholder="1d6+2" /></label>
        <label class="field"><span>Type</span>
          <select class="text" data-atk="damageType|${i}">${DM_DAMAGE_TYPES.map((t) =>
            `<option ${a.damageType === t ? "selected" : ""}>${t}</option>`).join("")}</select></label>
      </div>
      <label class="field"><span>Then <span class="muted">— the rider, if any</span></span>
        <input class="text" data-atk="note|${i}" type="text" maxlength="200" value="${esc(a.note || "")}"
          placeholder="DC 12 Strength save or knocked prone." /></label>
      ${atks.length > 1 ? `<button class="btn-quiet" data-dm="atk-drop" data-val="${i}">Remove this attack</button>` : ""}
    </div>`).join("")}
    ${atks.length < 3 ? `<button class="btn-quiet" data-dm="atk-add">Add an attack</button>` : ""}
    ${/* THE PRE-MADE ONES. Every weapon in the system already carries a damage die, a type, properties and
          a mastery — Cleave, Vex, Push. Picking one fills the row rather than making the DM look it up. */""}
    ${/* A DROPDOWN CANNOT SHOW WHAT A WEAPON DOES. Nineteen names, then nineteen names with a die glued
          on, and neither said what Vex or Cleave or Topple actually IS — which is the thing you are
          choosing between. Kayki: "the pick a weapon dropdown needs a design to show better the weapons
          and what they do, Vex, Cleave, etc." So: a card each, the mastery named and explained, and one
          button that fills the row. Melee and ranged split, because that is the first cut a DM makes. */""}
    ${weapons.length ? `<p class="panel-sub">Or take one off a weapon</p>
      <p class="muted">Fills the last row above with its damage, type and mastery. The to-hit stays
        yours — that is the creature's, not the weapon's.</p>
      ${[["melee", "In the hand"], ["ranged", "At range"]].map(([kind, label]) => {
        const inKind = weapons.filter((w) => (w.range ? "ranged" : "melee") === kind);
        if (!inKind.length) return "";
        return `<p class="panel-sub">${esc(label)}</p>
          <div class="wep-grid">${inKind.map((w) => `<div class="wep-card">
            <div class="wep-head">
              <strong>${esc(w.name)}</strong>
              <span class="wep-dmg">${esc(w.damage.die)} <span class="muted">${esc(w.damage.type)}</span></span>
            </div>
            ${w.range ? `<p class="muted wep-note">${esc(w.range.normal)}/${esc(w.range.long)} ft</p>` : ""}
            ${(w.properties || []).length ? `<p class="wep-note">${propsHTML(w.properties)}</p>` : ""}
            ${w.mastery ? `<p class="wep-note"><span class="dmg-k">Mastery</span> ${masteryHTML(w.mastery)}</p>` : ""}
            <button class="btn-quiet" data-dm="atk-from" data-val="${esc(w.name)}">Use this one</button>
          </div>`).join("")}</div>`;
      }).join("")}` : ""}
    ${(e.attacks || []).length > 1 ? `<label class="field"><span>Multiattack <span class="muted">— how many a turn</span></span>
      <input id="en-multi" class="text" type="text" maxlength="160" value="${esc(e.multiattack || "")}"
        placeholder="It throws two knives on its turn." /></label>` : ""}
  </section>`;
}

/* Everything the system already describes, offered as a starting point. A feature copied in is a COPY —
   editing it here never touches the class it came from, which is the whole point of a boss borrowing. */
function dmSourceFeatures() {
  const out = [];
  const push = (name, uses, description, from) => {
    if (name && description) out.push({ name, uses: uses || "", description, from: from || "" });
  };
  const s = (typeof store !== "undefined") ? store : {};
  for (const c of (s.classes || [])) {
    for (const f of (c.features || [])) push(f.name, (f.meta || {}).uses, f.sheetSummary || f.description, c.name);
  }
  for (const sub of (s.subclasses || [])) {
    for (const f of (sub.features || [])) push(f.name, (f.meta || {}).uses, f.sheetSummary || f.description, sub.name);
  }
  for (const t of (s.tricks || [])) push(t.name, t.tier === "prestige" ? "1 / combat" : "", t.sheetSummary || t.description, "trick");
  return out;
}

/* PICKING ONE OUT OF WHAT ALREADY EXISTS. A search box over every class feature, every subclass feature
   and every trick is four hundred things behind one word, and Kayki: "it's nice the search tool but it's
   a lot to search from like that — could just search by fields like Acrobat, features, or anything."
   So the source comes first and the search narrows it: pick the Acrobat and you are looking at the
   Acrobat, with no typing at all. The result is a real card with its text rendered the way every other
   feature in the app is, rather than a grey line. */
function dmFeatureSources() {
  const s = (typeof store !== "undefined") ? store : {};
  const out = [["", "Everything"]];
  for (const c of (s.classes || [])) out.push(["class:" + c.name, c.name]);
  out.push(["trick", "Tricks"]);
  return out;
}

function dmFeaturesSection(e) {
  const feats = e.features || [];
  const cap = e.tier === "boss" ? DM_MAX_BOSS_FEATURES : 99;
  const from = dmUi.pickFrom || "";
  const q = String(dmUi.pick || "").toLowerCase();
  let found = dmSourceFeatures();
  if (from === "trick") found = found.filter((f) => f.from === "trick");
  else if (from.startsWith("class:")) {
    const want = from.slice(6);
    // A subclass's features are that class's too — its name is the subclass, so match the parent.
    const subs = new Set(((typeof store !== "undefined" && store.subclasses) || [])
      .filter((x) => className(x.parentClass) === want).map((x) => x.name));
    found = found.filter((f) => f.from === want || subs.has(f.from));
  }
  if (q.length >= 2) found = found.filter((f) => f.name.toLowerCase().includes(q));
  const show = (from || q.length >= 2) ? found.slice(0, 15) : [];
  return `<section class="panel">
    <p class="panel-sub">Features${e.tier === "boss"
      ? ` <span class="muted">— up to ${DM_MAX_BOSS_FEATURES}</span>` : ""}</p>
    ${feats.map((f, i) => `<div class="atk-edit">
      <div class="grid-row">
        <label class="field"><span>Name</span>
          <input class="text" data-feat="name|${i}" type="text" maxlength="40" value="${esc(f.name || "")}" /></label>
        <label class="field"><span>How often</span>
          <input class="text" data-feat="uses|${i}" type="text" maxlength="40" value="${esc(f.uses || "")}"
            placeholder="1 / combat" /></label>
      </div>
      <label class="field"><span>What it does</span>
        <textarea class="text notes-body" rows="3" data-feat="description|${i}" maxlength="1200">${esc(f.description || "")}</textarea></label>
      ${f.from ? `<p class="muted">Borrowed from ${esc(f.from)} — this is a copy, and editing it here
        changes nothing anywhere else.</p>` : ""}
      <button class="btn-quiet" data-dm="feat-drop" data-val="${i}">Remove this feature</button>
    </div>`).join("")}
    ${feats.length >= cap ? `<p class="muted">That is ${DM_MAX_BOSS_FEATURES}, which is as many as a boss
        should be reading off a card mid-fight. Remove one to add another.</p>`
      : `<button class="btn-quiet" data-dm="feat-add">Write a new one</button>
      <p class="panel-sub">Or take one that already exists</p>
      <div class="grid-row">
        <label class="field"><span>From</span>
          <select id="dm-from" class="text">${dmFeatureSources().map(([v, label]) =>
            `<option value="${esc(v)}" ${from === v ? "selected" : ""}>${esc(label)}</option>`).join("")}</select></label>
        <label class="field"><span>Name contains</span>
          <input id="dm-pick" class="text" type="text" value="${esc(dmUi.pick || "")}" placeholder="mirror, wall…" /></label>
      </div>
      ${show.length ? `<div class="feat-grid">${show.map((f) => `<div class="feat-card">
          <div class="feat-title"><span class="feat-name">${esc(f.name)}</span>
            ${f.uses ? `<span class="role-badge">${esc(f.uses)}</span>` : ""}</div>
          <p class="feat-from">${esc(f.from === "trick" ? "Trick" : f.from)}</p>
          <div class="feat-text">${fmtDesc(f.description || "")}</div>
          <div class="feat-ctl"><button class="btn-quiet" data-dm="feat-from" data-val="${esc(f.name)}">Use this one</button></div>
        </div>`).join("")}${found.length > show.length
          ? `<p class="muted">${esc(found.length - show.length)} more — narrow it with a name.</p>` : ""}</div>`
        : `<p class="muted">${from || q.length >= 2 ? "Nothing by that name." : "Pick where to look."}</p>`}`}
  </section>`;
}

/* ---------------------------------------------------------------- reading the form back */

function dmVal(id) { const n = asEl(document.getElementById(id)); return n ? n.value : undefined; }

function dmReadForm() {
  const e = dmUi.draft;
  if (!e) return;
  const str = (id, cur) => { const v = dmVal(id); return v === undefined ? cur : String(v).trim(); };
  const num = (id, cur) => { const v = dmVal(id); return v === undefined || v === "" ? cur : Number(v); };
  e.name = str("en-name", e.name).slice(0, 40);
  e.flavor = str("en-flavor", e.flavor);
  e.ac = Math.max(5, Math.min(25, num("en-ac", e.ac) || 12));
  e.hp = Math.max(1, num("en-hp", e.hp) || 1);
  e.speed = Math.max(0, Math.min(200, num("en-speed", e.speed) ?? 30));
  e.size = str("en-size", e.size) || "Medium";
  e.kind = str("en-kind", e.kind);
  e.partyLevel = str("en-levels", e.partyLevel);
  e.senses = str("en-senses", e.senses);
  e.tactics = str("en-tactics", e.tactics);
  e.narration = str("en-narration", e.narration);
  e.multiattack = str("en-multi", e.multiattack);
  const link = dmVal("en-img");
  if (link !== undefined && !String(e.image || "").startsWith("data:")) e.image = String(link).trim();
  const parry = dmVal("en-parry");
  e.parryDC = (e.tier === "normal" || parry === undefined || parry === "") ? null
    : Math.max(3, Math.min(20, Number(parry) || 10));
  for (const node of document.querySelectorAll("[data-atk]")) {
    const n = asEl(node);
    const [field, i] = n.dataset.atk.split("|");
    const a = e.attacks[Number(i)];
    if (!a) continue;
    a[field] = field === "toHit" ? Number(n.value) || 0 : String(n.value).trim();
  }
  for (const node of document.querySelectorAll("[data-feat]")) {
    const n = asEl(node);
    const [field, i] = n.dataset.feat.split("|");
    const f = e.features[Number(i)];
    if (f) f[field] = String(n.value).trim();
  }
  const pick = dmVal("dm-pick");
  if (pick !== undefined) dmUi.pick = pick;
  const from = dmVal("dm-from");
  if (from !== undefined) dmUi.pickFrom = from;
}

/* Everything a built enemy needs before it can be shown as a card. Kept separate from the form so the
   same rules apply whatever wrote it. */
function dmTidyEnemy(e) {
  const out = Object.assign({}, e);
  out.custom = true;
  out.source = "Built by the DM";
  out.attacks = (out.attacks || []).filter((a) => a && a.name && a.damage).slice(0, 3);
  if (!out.attacks.length) out.attacks = [{ name: "Attack", kind: "melee", toHit: 3, reach: "5 ft", damage: "1d4", damageType: "bludgeoning" }];
  out.features = (out.features || []).filter((f) => f && f.name && f.description);
  if (out.tier === "boss") out.features = out.features.slice(0, DM_MAX_BOSS_FEATURES);
  if (out.tier === "normal") { out.parryDC = null; out.features = []; }
  for (const k of ["resist", "immune", "vulnerable"]) out[k] = (out[k] || []).filter(Boolean);
  // A +0 is the default, so it is not written down: a plain enemy stores nothing it does not use.
  const ab = {};
  for (const a of ENEMY_ABILITIES) if (Number((out.abilities || {})[a])) ab[a] = Number(out.abilities[a]);
  out.abilities = ab;
  out.saveProf = (out.saveProf || []).filter((a) => ENEMY_ABILITIES.includes(a));
  out.prof = Math.max(0, Math.min(6, Number(out.prof ?? 2)));
  if (out.initMod == null) delete out.initMod;
  if (!out.id) {
    const base = (out.name || "enemy").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "enemy";
    out.id = base + "-" + Math.random().toString(36).slice(2, 6);
  }
  return out;
}

/* ---------------------------------------------------------------- actions */

document.addEventListener("click", (ev) => {
  const b = evTarget(ev).closest ? evTarget(ev).closest("[data-dm]") : null;
  if (!b || b.disabled) return;
  const act = b.dataset.dm, val = b.dataset.val || "";
  if (act === "open") {
    const code = String((dmVal("dm-open") || "")).replace(/\D/g, "");
    if (!CocDm.validCode(code)) { const m = document.querySelector("#dm-msg"); if (m) { m.textContent = "Six digits."; m.className = "save-msg bad"; } return; }
    location.hash = "#/dm/" + code;
    return;
  }
  if (act === "new") { dmStartNew(); return; }
  if (act === "forget") { dmForget(val); renderDmDoor(); return; }
  if (!dm) return;
  ev.preventDefault();
  if (act === "tab") { dmReadForm(); dmUi.tab = val; renderDm(); return; }
  if (act === "add") { dmUi.draft = dmBlankEnemy(val); dmUi.editing = "new"; dmUi.pick = ""; renderDmEnemyForm(); return; }
  if (act === "edit") {
    const found = (dm.rec.enemies || []).find((e) => e.id === val);
    if (!found) return;
    dmUi.draft = JSON.parse(JSON.stringify(found));
    dmUi.editing = val; dmUi.pick = "";
    renderDmEnemyForm();
    return;
  }
  if (act === "copy") {
    const found = (dm.rec.enemies || []).find((e) => e.id === val);
    if (!found) return;
    const copy = dmTidyEnemy(Object.assign({}, JSON.parse(JSON.stringify(found)),
      { id: "", name: (found.name || "Enemy") + " (copy)" }));
    dm.rec.enemies.push(copy);
    dmPersist(); renderDm();
    return;
  }
  if (act === "drop") {
    dm.rec.enemies = (dm.rec.enemies || []).filter((e) => e.id !== val);
    dmPersist(); renderDm();
    return;
  }
  if (act === "close") { dmUi.editing = null; dmUi.draft = null; renderDm(); return; }
  if (act === "tier") { dmReadForm(); dmUi.draft.tier = val; renderDmEnemyForm(); return; }
  if (act === "abil") {
    dmReadForm();
    const [a, by] = val.split("|");
    const now = Number((dmUi.draft.abilities || {})[a] || 0);
    dmUi.draft.abilities = Object.assign({}, dmUi.draft.abilities, { [a]: Math.max(-5, Math.min(10, now + Number(by))) });
    renderDmEnemyForm();
    return;
  }
  if (act === "resist" || act === "immune" || act === "vulnerable" || act === "saveprof") {
    dmReadForm();
    const key = act === "saveprof" ? "saveProf" : act;
    const list = dmUi.draft[key] || [];
    dmUi.draft[key] = list.includes(val) ? list.filter((x) => x !== val) : list.concat(val);
    renderDmEnemyForm();
    return;
  }
  if (act === "atk-from") { dmReadForm(); dmAttackFromWeapon(val); return; }
  if (act === "atk-add") {
    dmReadForm();
    if (dmUi.draft.attacks.length < 3) dmUi.draft.attacks.push({ name: "Attack", kind: "melee", toHit: 3, reach: "5 ft", damage: "1d6", damageType: "bludgeoning", note: "" });
    renderDmEnemyForm();
    return;
  }
  if (act === "atk-drop") {
    dmReadForm();
    dmUi.draft.attacks.splice(Number(val), 1);
    renderDmEnemyForm();
    return;
  }

  if (act === "feat-add") {
    dmReadForm();
    dmUi.draft.features = (dmUi.draft.features || []).concat({ name: "", uses: "", description: "" });
    renderDmEnemyForm();
    return;
  }
  if (act === "feat-drop") {
    dmReadForm();
    dmUi.draft.features.splice(Number(val), 1);
    renderDmEnemyForm();
    return;
  }
  if (act === "feat-from") {
    dmReadForm();
    const f = dmSourceFeatures().find((x) => x.name === val);
    if (f) dmUi.draft.features = (dmUi.draft.features || []).concat(JSON.parse(JSON.stringify(f)));
    dmUi.pick = "";
    renderDmEnemyForm();
    return;
  }
  if (act === "save-enemy") { dmSaveEnemy(); return; }
  if (act === "note-add") {
    dmReadNotes();
    dm.rec.notes = (dm.rec.notes || []).concat({ title: "", body: "" });
    dmPersist(); renderDm();
    return;
  }
  if (act === "note-drop") {
    dmReadNotes();
    dm.rec.notes.splice(Number(val), 1);
    dmPersist(); renderDm();
    return;
  }
  if (act === "addcode") { dmAddRoomByCode(); return; }
  if (act === "addtable") {
    const [code, name] = val.split("|");
    dm.rec.tables = (dm.rec.tables || []).filter((t) => t.code !== code).concat({ code, name: name || "", at: Date.now() });
    dmPersist(); renderDm();
    return;
  }
  if (act === "untable") {
    dm.rec.tables = (dm.rec.tables || []).filter((t) => t.code !== val);
    dmPersist(); renderDm();
    return;
  }
});

function dmReadNotes() {
  if (!dm) return;
  for (const node of document.querySelectorAll("[data-dm-note]")) {
    const n = asEl(node);
    const k = n.dataset.dmNote;
    const i = Number(k.slice(1));
    const note = (dm.rec.notes || [])[i];
    if (note) note[k[0] === "t" ? "title" : "body"] = n.value;
  }
}

/* A room, added by typing its code. It is looked up first — a table you cannot reach is a row that will
   never open, and telling you now is better than a dead link on the list forever. */
function dmAttackFromWeapon(name) {
  const w = ((typeof store !== "undefined" && store.weapons) || []).find((x) => x.name === name);
  if (!w) return;
  const a = dmUi.draft.attacks[dmUi.draft.attacks.length - 1];
  a.name = w.name;
  a.damage = w.damage.die;
  a.damageType = w.damage.type;
  a.kind = w.range ? "ranged" : "melee";
  a.reach = w.range ? `${w.range.normal}/${w.range.long} ft` : "5 ft";
  if (w.mastery) a.note = w.mastery + " — see the weapon's mastery.";
  renderDmEnemyForm();
}

async function dmAddRoomByCode() {
  const msg = document.querySelector("#dm-room-msg");
  const say = (t, bad) => { if (msg) { msg.textContent = t; msg.className = "save-msg" + (bad ? " bad" : ""); } };
  const code = String((dmVal("dm-room") || "")).replace(/\D/g, "");
  if (!CocDm.validCode(code)) return say("Six digits.", true);
  if ((dm.rec.tables || []).some((t) => t.code === code)) return say("That one is already on your list.");
  say("Looking for it…");
  let name = "";
  try {
    const meta = typeof CocLive !== "undefined" ? await CocLive.get("tables/" + code + "/meta") : null;
    if (!meta) return say("No table answers on " + code + ". Check the room code with whoever runs it.", true);
    name = String(meta.name || "");
  } catch (err) { return say(err.message, true); }
  dm.rec.tables = (dm.rec.tables || []).concat({ code, name, at: Date.now() });
  dmPersist();
  renderDm();
}

async function dmStartNew() {
  const msg = document.querySelector("#dm-msg");
  const say = (t, bad) => { if (msg) { msg.textContent = t; msg.className = "save-msg" + (bad ? " bad" : ""); } };
  const code = String((dmVal("dm-new") || "")).replace(/\D/g, "");
  if (!CocDm.validCode(code)) return say("Six digits — and pick something you will remember.", true);
  try {
    if (await CocDm.taken(code)) return say("That code is already in use. Open it, or pick another.", true);
    await CocDm.save(code, dmBlank());
  } catch (err) { return say(dmWhy(err), true); }
  dmRemember(code, "");
  location.hash = "#/dm/" + code;
}

function dmSaveEnemy() {
  dmReadForm();
  const msg = document.querySelector("#en-msg");
  const say = (t, bad) => { if (msg) { msg.textContent = t; msg.className = "save-msg" + (bad ? " bad" : ""); } };
  if (!dmUi.draft.name) return say("Give it a name — a board of unnamed markers is unreadable.", true);
  const tidy = dmTidyEnemy(dmUi.draft);
  const list = dm.rec.enemies || [];
  const at = list.findIndex((e) => e.id === tidy.id);
  if (at >= 0) list[at] = tidy; else list.push(tidy);
  dm.rec.enemies = list;
  dmPersist();
  dmUi.editing = null; dmUi.draft = null;
  renderDm();
}

/* Typing anywhere in the DM's own fields saves; the same debounce the sheet uses. */
document.addEventListener("input", (ev) => {
  if (!dm) return;
  const t = evTarget(ev);
  if (!t || !t.id && !t.dataset) return;
  if (t.id === "dm-name") { dm.rec.name = String(t.value).slice(0, 40); dmRemember(dm.code, dm.rec.name); dmPersist(); return; }
  if (t.dataset && t.dataset.dmNote) { dmReadNotes(); dmPersist(); return; }
  if (t.id === "dm-pick") { dmUi.pick = t.value; if (dmUi.editing) renderDmEnemyForm(); return; }
  if (t.id === "dm-from") { dmReadForm(); dmUi.pickFrom = t.value; renderDmEnemyForm(); return; }
});

/* The small "add one" lists beside a damage rule and beside the weapons. A select is a list you open, not
   thirty-nine buttons you read past. */
document.addEventListener("change", (ev) => {
  const t = evTarget(ev);
  if (!t || !t.dataset || !t.dataset.dmAdd || !dmUi.draft) return;
  const act = t.dataset.dmAdd, val = t.value;
  t.value = "";
  if (!val) return;
  dmReadForm();
  if (act === "weapon") { dmAttackFromWeapon(val); return; }
  const key = act === "saveprof" ? "saveProf" : act;
  const list = dmUi.draft[key] || [];
  if (!list.includes(val)) dmUi.draft[key] = list.concat(val);
  renderDmEnemyForm();
});

/* A picture off the phone, shrunk the same way a figure's is. */
document.addEventListener("change", (ev) => {
  const t = evTarget(ev);
  if (!t || t.id !== "en-file" || !dmUi.draft) return;
  const file = t.files && t.files[0];
  const msg = document.querySelector("#en-imgmsg");
  const say = (s, cls) => { if (msg) { msg.textContent = s; msg.className = "save-msg" + (cls || ""); } };
  if (!file) return;
  if (typeof tblShrinkImage !== "function") return say("Cannot read pictures here.", " bad");
  say("Reading…");
  dmReadForm();
  tblShrinkImage(file, (data) => {
    dmUi.draft.image = data;
    renderDmEnemyForm();
    const m2 = document.querySelector("#en-imgmsg");
    if (m2) { m2.textContent = "Picture ready — it is saved with the enemy."; m2.className = "save-msg good"; }
    // A figure-sized picture, shrunk the same way a token's is — the budget is an OBJECT, and passing a
    // bare number here silently used the MAP budget (680,000 characters) for a 40px token.
  }, (err) => say(err, " bad"), TBL_TOKEN_IMAGE);
});

COC_ROUTES.dm = routeDm;
