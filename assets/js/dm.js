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

/* WHOSE THE SYSTEM'S NINE ARE. The authored bestiary is a CAMPAIGN, not a rulebook: a player who reads
 * Grinsel's card knows how the fight ends before it starts. Kayki: "I don't want other people to create a
 * DM and see the enemies from the bestiary that I have or created, for spoiler reasons… they will need to
 * create their own enemies." So the shipped enemies belong to the DM CODES listed here and to nobody
 * else — every other code sees only what that code has built.
 *
 * TO LEND THEM TO SOMEBODY: add their six-digit DM code to this line and publish. Taking it out again
 * takes the bestiary back, and touches nothing they built of their own.
 *
 * THE SAME HONEST LIMIT AS EVER: this is a static site, so `data/bundle.json` is a URL anybody can type.
 * This decides what the APP hands a DM, not what somebody with the developer tools open can dig out. */
const COC_BESTIARY_CODES = ["130820"];

/* It follows the CODE, not the browser and not the chair: open Kayki's code and the bestiary is there,
   open a friend's on the same laptop and it is not. With no code open there is none at all — the safe
   answer, rather than "everyone who never made a code gets everything". */
function dmHasBestiary(code) {
  const c = String(code == null ? dmCode() : (code || ""));
  return !!c && COC_BESTIARY_CODES.includes(c);
}

/* AND ON THOSE CODES THEY ARE NOT "THE SYSTEM'S" — THEY ARE YOURS. Kayki: "the created enemies, put them
 * on my own list, not from 'the system' list, so I can alter and modify them at will." A per-creature
 * "Copy to yours" already existed and was the wrong shape for this: it is his campaign, so the nine land
 * on his record ONCE, by themselves, and from that moment they are ordinary built enemies — rename, re-arm,
 * delete.
 *
 * THEY KEEP THEIR IDS. A figure on a board stores only `enemyId`, so a copy under a new id would leave
 * every Sawdust Hound already standing on a table pointing at a creature the code no longer lists.
 *
 * `rec.adopted` remembers what has ever been taken, so deleting one is a decision that STICKS rather than
 * being undone by the next visit. What is not on the code any more goes back to being offered as a copy.
 * Returns whether the record changed, so the caller only writes when there is something to write. */
function dmAdoptShipped(code, rec) {
  if (!dmHasBestiary(code)) return false;
  const shipped = (typeof store !== "undefined" && Array.isArray(store.enemies)) ? store.enemies : [];
  if (!shipped.length) return false;    // the bundle has not landed yet; the next visit does it
  const have = new Set((rec.enemies || []).map((e) => e.id));
  const ever = new Set(rec.adopted || []);
  const take = shipped.filter((e) => e && e.id && !have.has(e.id) && !ever.has(e.id));
  if (!take.length) return false;
  rec.enemies = (rec.enemies || []).concat(take.map((e) =>
    Object.assign(JSON.parse(JSON.stringify(e)), { custom: true, source: "The system's, now yours" })));
  rec.adopted = (rec.adopted || []).concat(take.map((e) => e.id));
  return true;
}

let dm = null;                          // { code, rec } while a DM record is open
const dmUi = { tab: "enemies", editing: null, draft: null, msg: "", pick: "", pickFrom: "", shareOpen: "",
  dropArm: "", dropText: "",     // which creature is armed for deletion, and the word typed so far
  noteArm: -1, noteText: "" };   // and the same pair for a note, which is text nobody else has a copy of

/* TWO SIDES OF ONE ARRANGEMENT, and they are stored on DIFFERENT records on purpose.
 *   rec.sharesTo — codes I have lent creatures to, and which ones. Mine, so I can change or revoke it.
 *   rec.shared   — what other DMs have lent ME, keyed by their code. Written INTO my record by them.
 * The alternative — keeping the lent creatures on the LENDER's record and letting the borrower read it —
 * would mean handing the borrower the lender's code, and a code is the whole credential here
 * (storage-security-model): they would then have every enemy, note and table on it. So a share is
 * PUSHED, never pulled, and nobody ever learns a code they were not already given. */
function dmBlank() {
  return { v: 1, name: "", tables: [], notes: [], enemies: [], sharesTo: {}, shared: {}, adopted: [] };
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
let dmPendingSave = null;               // { code, rec } waiting out the debounce
/* THE PENDING WRITE MUST SURVIVE LEAVING THE RECORD. There is one timer, and opening a second DM code
   within the 400ms — which lending does constantly, hopping between your screen and theirs — used to
   `clearTimeout` the first record's save and lose the edit silently. Anything still owed is written
   BEFORE the next record is touched. */
async function dmFlushSave() {
  if (!dmPendingSave) return;
  const { code, rec } = dmPendingSave;
  dmPendingSave = null;
  clearTimeout(dmSaveTimer);
  try {
    await CocDm.save(code, rec);
    dmCacheEnemies(code, rec.enemies || []);
    dmCacheShared(code, rec.shared || {});
    dmCacheNotes(code, rec.notes || []);
  } catch (err) { dmSetMsg("not saved — " + dmWhy(err), true); }
}
function dmPersist() {
  if (!dm) return;
  if (dmPendingSave && dmPendingSave.code !== dm.code) dmFlushSave();
  clearTimeout(dmSaveTimer);
  dmPendingSave = { code: dm.code, rec: dm.rec };
  dmSetMsg("saving…");
  dmSaveTimer = setTimeout(async () => {
    await dmFlushSave();
    dmSetMsg(dmUi.msg === "saving…" ? "saved" : dmUi.msg);
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
/* The same copy, for what other DMs have lent this code. Kept apart from the built ones so the table can
   say which is which, and so revoking a share can never take one of your own with it. */
function dmCacheShared(code, byCode) {
  const flat = [];
  for (const [from, entry] of Object.entries(byCode || {}))
    for (const e of ((entry || {}).enemies || [])) flat.push(Object.assign({}, e, { sharedFrom: from }));
  try { localStorage.setItem("coc:dm:shared:" + code, JSON.stringify(flat)); } catch { /* full */ }
}
function dmCachedShared() {
  const code = dmCode();
  if (!code) return [];
  try { return JSON.parse(localStorage.getItem("coc:dm:shared:" + code) || "[]"); } catch { return []; }
}

/* ---------------------------------------------------------------- the notes, which are ONE store
 *
 * There used to be two notepads with nothing between them: a campaign one on the DM CODE (#/dm) and a
 * per-room one in the table. Kayki: "the notes of the dm dont appear on the table, it should all be the
 * same data, not 2 separate." So the code's `notes` array is the truth and BOTH surfaces edit it — the
 * screen writes it through the open record, the table writes it through the read-change-write below, and
 * a room's own DM notes are moved onto the code the first time that DM sits down.
 *
 * A PLAYER's notepad is untouched and stays in the room: theirs follows a character code, and there is no
 * DM record to put it on. */
/* ---------------------------------------------------------------- notes in folders
 *
 * Kayki, after the campaign notes grew past a dozen: "right now its a mess to find what is what."
 *
 * A FOLDER IS A NAME ON THE NOTE, not a record of its own. Music needed real folder records because a
 * track is a keyed map entry that can be dragged between them; a note has no id at all — it is its
 * position in an array — so a string is the only thing that survives a splice. It also means there is no
 * such thing as an empty folder to clean up: the last note leaving takes the folder with it, and a new
 * one is made by typing a name that is not there yet.
 *
 * Both surfaces group the same way: folders in the order they are first met, unfoldered notes last, and
 * nothing reordered underneath — the array is still the order, grouping is only how it is drawn. */
function cocNoteFolders(notes) {
  const seen = [];
  for (const n of notes || []) {
    const f = String((n && n.folder) || "").trim();
    if (f && !seen.includes(f)) seen.push(f);
  }
  return seen;
}
/* [folder, [[note, index], …]] — the index travels with the note because every write addresses a note by
   its place in the array, and grouping must not change what "the third note" means. */
function cocNoteGroups(notes) {
  const groups = new Map();
  (notes || []).forEach((n, i) => {
    const f = String((n && n.folder) || "").trim();
    if (!groups.has(f)) groups.set(f, []);
    groups.get(f).push([n, i]);
  });
  const loose = groups.get("");
  groups.delete("");
  const out = [...groups.entries()];
  if (loose) out.push(["", loose]);
  return out;
}

function dmCacheNotes(code, notes) {
  try { localStorage.setItem("coc:dm:notes:" + code, JSON.stringify(notes || [])); } catch { /* full */ }
}
function dmCachedNotes(code) {
  const c = String(code || dmCode() || "");
  if (!c) return [];
  try { return JSON.parse(localStorage.getItem("coc:dm:notes:" + c) || "[]"); } catch { return []; }
}
/* What to draw right now: the open record if it is this code — that is the truth while the DM screen is
   up — and otherwise this device's copy, so a table never waits on a fetch to show a note. */
function dmNotesOf(code) {
  const c = String(code || dmCode() || "");
  if (!c) return [];
  if (dm && dm.code === c) return dm.rec.notes || [];
  return dmCachedNotes(c);
}
/* Refreshed from the record when a surface that is not the DM screen opens them, so a note written on the
   phone is on the laptop. Returns whether anything actually changed, so the caller can skip a repaint. */
async function dmNotesLoad(code) {
  const c = String(code || "");
  if (!CocDm.validCode(c)) return false;
  const rec = await CocDm.load(c);
  if (!rec) return false;
  const notes = rec.notes || [];
  if (dm && dm.code === c) dm.rec.notes = notes;
  const changed = JSON.stringify(dmCachedNotes(c)) !== JSON.stringify(notes);
  dmCacheNotes(c, notes);
  return changed;
}

let dmNotesTimer = null;
let dmNotesPend = null;                 // { code, notes } waiting out the debounce
/* WRITTEN THE WAY A SHARE IS: read the record, change ONE key, write it back. The table has no open
   record, and saving a whole one assembled here would take that code's enemies with it. Refused when
   nothing answers on the code, because a write to an unopened one CREATES it
   (rtdb-field-write-creates-parent). A failure keeps the payload and tries again rather than dropping a
   note on the floor — the data surviving is the one condition on this whole project. */
async function dmNotesFlush() {
  if (!dmNotesPend) return;
  const { code, notes } = dmNotesPend;
  dmNotesPend = null;
  clearTimeout(dmNotesTimer);
  try {
    const rec = await CocDm.load(code);
    if (!rec) return;
    rec.notes = notes;
    await CocDm.save(code, rec);
  } catch {
    if (!dmNotesPend) {
      dmNotesPend = { code, notes };
      dmNotesTimer = setTimeout(() => { dmNotesFlush().catch(() => {}); }, 2000);
    }
  }
}
function dmNotesPut(code, notes) {
  const c = String(code || "");
  if (!CocDm.validCode(c)) return;
  /* THE MAPPER IS THE SCHEMA. Every write to a note goes through here, so a field this does not name is a
     field that survives exactly until the next keystroke — which is how `folder` would have silently
     undone itself on every note the moment somebody typed in one. */
  const list = (notes || []).map((n) => {
    const one = { title: String((n && n.title) || "").slice(0, 60), body: String((n && n.body) || "").slice(0, 8000) };
    const folder = String((n && n.folder) || "").trim().slice(0, 40);
    if (folder) one.folder = folder;      // omitted rather than empty: a note with no folder has no key
    return one;
  });
  dmCacheNotes(c, list);
  // One saver per record: with the DM screen open, its own debounce owns the write.
  if (dm && dm.code === c) { dm.rec.notes = list; dmPersist(); return; }
  if (dmNotesPend && dmNotesPend.code !== c) dmNotesFlush();
  clearTimeout(dmNotesTimer);
  dmNotesPend = { code: c, notes: list };
  dmNotesTimer = setTimeout(() => { dmNotesFlush().catch(() => {}); }, 600);
}

/* ---------------------------------------------------------------- routes */

async function routeDm(arg) {
  const code = String(arg || "").replace(/\D/g, "").slice(0, 6);
  await dmFlushSave();          // whatever the last record still owed, before opening another
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
  if (dmAdoptShipped(code, dm.rec)) dmPersist();
  dmCacheEnemies(code, dm.rec.enemies || []);
  dmCacheShared(code, dm.rec.shared || {});
  dmCacheNotes(code, dm.rec.notes || []);
  dmUi.editing = null; dmUi.shareOpen = "";
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
                ["sharing", "Sharing", Object.keys(rec.sharesTo || {}).length + Object.keys(rec.shared || {}).length],
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
      : dmUi.tab === "sharing" ? dmSharingPane()
      : dmUi.tab === "tables" ? dmTablesPane()
      : dmNotesPane()}</div>
  `);
}

/* ---------------------------------------------------------------- the three panes */

/* DELETING A CREATURE, THE SAME WAY EVERYTHING ELSE IS DELETED. One tap used to be the whole of it, on a
   button sitting a centimetre from Copy — and an enemy is not recoverable: it is on this code and nowhere
   else, so a mis-tap loses a stat block somebody spent an evening on. Kayki: "the delete button has to
   have the CONFIRM window to delete the enemies as everything." So it arms, and the confirmation is the
   word typed out, exactly as a character and a table already ask for. */
function dmDropRowHTML(e) {
  return `<div class="scene-row danger armed">
    <span class="muted">Delete <strong>${esc(e.name || "Unnamed")}</strong> — it is on this code and
      nowhere else, and there is no undo. Type <strong>CONFIRM</strong>.</span>
    <div class="danger-row">
      <input id="dm-drop-confirm" class="text" type="text" autocomplete="off" spellcheck="false"
        autocapitalize="characters" autocorrect="off" placeholder="CONFIRM" value="${esc(dmUi.dropText)}" />
      <button class="btn btn-hot" data-dm="drop-go" data-val="${esc(e.id)}"
        ${dmUi.dropText === "CONFIRM" ? "" : "disabled"}>Delete permanently</button>
      <button class="btn-quiet" data-dm="drop-cancel">Cancel</button>
    </div>
  </div>`;
}

function dmEnemiesPane() {
  const list = dm.rec.enemies || [];
  const byTier = DM_TIERS.map(([tier, label, note]) => {
    const inTier = list.filter((e) => (e.tier || "normal") === tier);
    if (!inTier.length) return "";
    return `<p class="panel-sub">${esc(label)} <span class="muted">— ${esc(note)}</span></p>
      <div class="scene-list">${inTier.map((e) => dmUi.dropArm === e.id ? dmDropRowHTML(e)
        : `<div class="scene-row">
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
    ${list.length ? `<section class="panel"><p class="panel-sub">Yours</p>${byTier}</section>`
      : `<section class="panel"><p class="panel-sub">Yours</p><p class="muted">Nothing built yet. What you
         build here is this code's own — it appears in the bestiary at every table you run, and at nobody
         else's.</p></section>`}
    ${/* SAID OUT LOUD, because "why can my friend not see my Sawdust Hound" is a question that otherwise
          costs an evening. Enemies belong to the code that built them; the system's nine belong to the
          codes named in COC_BESTIARY_CODES. */""}
    <section class="panel">
      <p class="panel-sub">Who sees these</p>
      ${dmHasBestiary(dm.code) ? `<p class="muted">The <strong>authored creatures are on this code as
        your own</strong> — they were put in the list above the first time you opened it, keeping their
        names and their numbers, and from there they are yours: rename them, re-arm them, delete them.
        The files they came from are never written to, so nothing here can break another campaign.</p>`
        : `<p class="muted">The system's authored creatures are <strong>not</strong> on this code: they are
          one campaign's, and a stat block read early is a fight spoiled. Build your own here — the form
          gives you everything an authored one has.</p>`}
      <p class="muted">Enemies live on the code that built them: no other DM sees these unless you lend
        them, which is what <strong>Sharing</strong> is for — their code, the creatures you pick, and Stop
        whenever you like.</p>
    </section>
    ${dmShippedPane()}`;
}

/* THE AUTHORED ONES, TAKEN AS YOUR OWN. Kayki: "the creatures the DM creates can be at any time cloned or
   edited by himself — that applies to those prefab creatures too." They live in `data/enemies/` as files,
   which is what keeps one description of a creature for the whole system, so nothing here writes to them:
   a copy lands on YOUR code with a new id, and from that moment it is an ordinary built enemy — rename it,
   re-arm it, delete it. The original stays exactly as it is, for you and for every table you run.
   Shown only to a code the bestiary belongs to; there is nothing to copy for anybody else. */
function dmShippedPane() {
  const all = (dmHasBestiary(dm.code) && typeof store !== "undefined" && Array.isArray(store.enemies))
    ? store.enemies : [];
  /* Only what this code does NOT already hold. On a code the bestiary belongs to, dmAdoptShipped has
     already moved all nine into Yours, so this whole pane is gone — it comes back for exactly the ones
     that have been deleted, which is the only time "take a copy" still means anything. */
  const have = new Set((dm.rec.enemies || []).map((e) => e.id));
  const shipped = all.filter((e) => !have.has(e.id));
  if (!shipped.length) return "";
  return `<section class="panel">
    <p class="panel-sub">Deleted from yours <span class="muted">— take another copy</span></p>
    <div class="scene-list">${shipped.map((e) => `<div class="scene-row">
      <span class="scene-static">
        <strong>${esc(e.name || "Unnamed")}</strong>
        <span class="muted">${esc(cap(e.tier || "normal"))} · AC ${esc(e.ac)} · ${esc(e.hp)} hp${
          e.parryDC != null ? " · Parry " + esc(e.parryDC) : ""}</span>
      </span>
      <button class="btn-quiet" data-dm="clone" data-val="${esc(e.id)}">Copy to yours</button>
    </div>`).join("")}</div>
    <p class="muted">A copy is yours to change; the original is untouched and still in the bestiary at
      every table you run.</p>
  </section>`;
}

/* ---------------------------------------------------------------- sharing */

/* EVERYTHING THIS CODE COULD LEND: what it built, and — for a code the authored bestiary is on — the
   system's nine as well, since lending one of those is exactly what "I'll let you run my monsters" means.
   Deduped by id, because a code can hold a copy of an authored one under an id of its own. */
function dmLendable() {
  const mine = (dm.rec.enemies || []).map((e) => Object.assign({}, e, { own: true }));
  const have = new Set(mine.map((e) => e.id));
  const shipped = (dmHasBestiary(dm.code) && typeof store !== "undefined" && Array.isArray(store.enemies))
    ? store.enemies.filter((e) => !have.has(e.id)).map((e) => Object.assign({}, e, { own: false })) : [];
  return mine.concat(shipped);
}
function dmShareIds(code) {
  const entry = (dm.rec.sharesTo || {})[code];
  return (entry && Array.isArray(entry.ids)) ? entry.ids : [];
}
/* Ids to creatures, at the moment of writing. The share stores the CREATURES rather than their ids
   because the other DM cannot look up what they have never been given — an id means nothing on a record
   that does not hold the thing. Editing a lent creature re-pushes it, so their copy keeps up. */
function dmResolveShare(ids) {
  const all = dmLendable();
  return ids.map((id) => all.find((e) => e.id === id)).filter(Boolean)
    .map((e) => { const c = JSON.parse(JSON.stringify(e)); delete c.own; return c; });
}

function dmSharingPane() {
  const to = dm.rec.sharesTo || {};
  const from = dm.rec.shared || {};
  const lendable = dmLendable();
  const rows = Object.entries(to).map(([code, entry]) => {
    const ids = (entry.ids || []).filter((id) => lendable.some((e) => e.id === id));
    const open = dmUi.shareOpen === code;
    return `<div class="scene-row">
        <span class="scene-static"><strong>code ${esc(code)}</strong>
          <span class="muted">${esc(entry.name || "a DM")} · ${esc(ids.length)} creature${ids.length === 1 ? "" : "s"}</span></span>
        <button class="btn-quiet" data-dm="share-open" data-val="${esc(code)}">${open ? "Done" : "Choose"}</button>
        <button class="btn-quiet" data-dm="share-stop" data-val="${esc(code)}">Stop</button>
      </div>
      ${open ? `<div class="figure-open">
        <p class="muted">Press a creature to lend it or take it back. They see it at once — well, the next
          time they open their screen or a table.</p>
        ${/* Above the creatures, not below: at the end of the row they read as two more creatures. */""}
        <div class="hp-controls">
          <button class="btn-quiet" data-dm="share-all" data-val="${esc(code)}">Lend everything</button>
          <button class="btn-quiet" data-dm="share-none" data-val="${esc(code)}">Take it all back</button>
        </div>
        <div class="chips">${lendable.map((e) => `<button class="chip ${ids.includes(e.id) ? "on" : ""}"
          data-dm="share-pick" data-val="${esc(code)}|${esc(e.id)}">${esc(e.name)}${
            e.own ? "" : ` <span class="muted">system</span>`}</button>`).join("")}</div>
      </div>` : ""}`;
  }).join("");
  const mine = Object.entries(from).map(([code, entry]) => {
    const list = (entry || {}).enemies || [];
    return `<p class="panel-sub">From code ${esc(code)} <span class="muted">— ${esc((entry || {}).name || "a DM")}</span></p>
      ${list.length ? `<div class="scene-list">${list.map((e) => `<div class="scene-row">
        <span class="scene-static"><strong>${esc(e.name || "Unnamed")}</strong>
          <span class="muted">${esc(cap(e.tier || "normal"))} · AC ${esc(e.ac)} · ${esc(e.hp)} hp</span></span>
        <button class="btn-quiet" data-dm="share-keep" data-val="${esc(code)}|${esc(e.id)}">Keep a copy</button>
      </div>`).join("")}</div>`
        : `<p class="muted">Nothing right now — they have taken it all back.</p>`}`;
  }).join("");
  return `<section class="panel">
      ${/* PUSHED, NOT PULLED. To lend somebody a creature you need their code, which is the thing they had
            to give you; they never need yours, so nothing of yours is reachable from their end. */""}
      <p class="panel-sub">Lend to a DM code</p>
      <div class="save-row">
        <input id="dm-share" class="code-input" inputmode="numeric" maxlength="6" placeholder="000000" />
        <button class="btn" data-dm="share-add">Add them</button>
      </div>
      <p id="dm-share-msg" class="save-msg"></p>
      <p class="muted">You need <strong>their</strong> six-digit DM code. They never need yours — what you
        lend is written onto their screen, so nothing else of yours is reachable from their end.</p>
    </section>
    <section class="panel">
      <p class="panel-sub">You lend to</p>
      ${rows ? `<div class="scene-list">${rows}</div>`
        : `<p class="muted">Nobody yet. A creature you lend stays yours: edit it and their copy follows,
           press Stop and it is gone from their bestiary.</p>`}
    </section>
    <section class="panel">
      <p class="panel-sub">Lent to you</p>
      ${mine || `<p class="muted">Nothing. A creature another DM lends you appears here and in the bestiary
        at every table you run, marked as theirs. <strong>Keep a copy</strong> makes it yours for good —
        after that, taking it back does not reach it.</p>`}
    </section>`;
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
  const groups = cocNoteGroups(notes);
  const one = ([n, i]) => `<div class="note-edit">
        <input class="text" data-dm-note="t${i}" type="text" maxlength="60" value="${esc(n.title || "")}"
          placeholder="What this is" />
        <textarea class="text notes-body" rows="5" data-dm-note="b${i}" maxlength="8000">${esc(n.body || "")}</textarea>
        <label class="field note-folder"><span>Folder</span>
          <input class="text" data-dm-note="f${i}" type="text" maxlength="40" list="dm-note-folders"
            value="${esc(n.folder || "")}" placeholder="No folder" /></label>
        ${dmUi.noteArm === i ? `<div class="danger-row">
          <span class="muted">There is no undo, and this is the only copy of what is in it.
            Type <strong>CONFIRM</strong>.</span>
          <input id="dm-note-confirm" class="text" type="text" autocomplete="off" spellcheck="false"
            autocapitalize="characters" autocorrect="off" placeholder="CONFIRM" value="${esc(dmUi.noteText)}" />
          <button class="btn btn-hot" data-dm="note-drop-go" data-val="${i}"
            ${dmUi.noteText === "CONFIRM" ? "" : "disabled"}>Delete permanently</button>
          <button class="btn-quiet" data-dm="note-drop-cancel">Cancel</button>
        </div>`
        : `<button class="btn-quiet" data-dm="note-drop" data-val="${i}">Delete this note</button>`}
      </div>`;
  return `<section class="panel">
      <p class="panel-sub">Notes</p>
      <datalist id="dm-note-folders">${cocNoteFolders(notes)
        .map((f) => `<option value="${esc(f)}"></option>`).join("")}</datalist>
      ${groups.map(([folder, rows]) => `
        <p class="panel-sub note-grp"><span class="note-grp-name">${esc(folder || "No folder")}</span>
          <span class="muted">&mdash; ${rows.length} note${rows.length === 1 ? "" : "s"}</span></p>
        ${rows.map(one).join("")}`).join("")}
      <button class="btn-quiet" data-dm="note-add">Add a note</button>
      <p class="muted">These live on your code, not in a room, so closing a table does not take them with
        it — and they are the same notes the <strong>Notes</strong> panel shows when you are in the DM's
        chair at a table. One set, written from either end.</p>
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

/* A ONE-LINE BOX THAT IS NOT AN INPUT. The creature's description was a single-line `<input>` sitting
   between two proper text boxes — Kayki: "the description of creatures need to be the same as the notes
   or the last text on the creature, that one line makes it weird. Start as 1 line but once it fills the
   line it expands to 2." So it is the same textarea as the notes, styled the same, opening at one row and
   growing a row at a time as it fills (see `.auto-grow` and `cocGrow`). */
function dmArea(id, label, value, opts) {
  const o = opts || {};
  return `<label class="field"><span>${label}${o.hint ? ` <span class="muted">${esc(o.hint)}</span>` : ""}</span>
    <textarea id="${esc(id)}" class="text notes-body auto-grow" rows="${o.rows || 1}"
      ${o.maxlength ? `maxlength="${o.maxlength}"` : ""}
      placeholder="${esc(o.placeholder || "")}">${esc(value == null ? "" : value)}</textarea></label>`;
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
      ${dmArea("en-flavor", "Description", e.flavor, { maxlength: 200,
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
      ${/* A POOL THE TABLE CAN COUNT. A boss that wears a class wears its engine, and until this existed
            the only record of one was a sentence inside a feature — so the DM counted Grinsel's Mayhem on
            their fingers. Name it and cap it here and its figure grows a meter at the table. Specials and
            bosses only: a normal is an AC, some hit points and two attacks. */""}
      ${isNormal ? "" : `<p class="panel-sub">Its engine <span class="muted">— leave the name empty for none</span></p>
      <div class="grid-row">
        ${dmField("en-engname", "Pool", (e.engine || {}).name || "",
          { maxlength: 24, placeholder: "Mayhem" })}
        ${dmField("en-engcap", "Cap", (e.engine || {}).cap == null ? "" : e.engine.cap,
          { num: true, min: 1, max: 20, hint: "starts a fight at 0" })}
      </div>
      ${dmField("en-engnote", "How it is gained and spent", (e.engine || {}).note || "",
        { maxlength: 200, placeholder: "+1 the first time each turn it deals damage…" })}`}
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
    ${/* The form does not ASK a normal enemy for features — that is what keeps the plain ones plain — but
          it must still show the ones it has, or a copy of an authored Hound would lose its pack tactics
          the moment it was saved. */""}
    ${isNormal && !(e.features || []).length ? "" : dmFeaturesSection(e)}

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
            ${w.range ? `<p class="muted wep-note">${rangeTermHTML(w.range)}</p>` : ""}
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
  /* THE NAME IS WHAT SAYS THERE IS ONE. Clearing it takes the meter off the creature; a cap with no name
     is a number with nothing to call it, and a name with no cap gets 1 rather than a pool of nothing. */
  const engName = dmVal("en-engname");
  if (engName !== undefined) {
    const nm = String(engName).trim().slice(0, 24);
    if (!nm || e.tier === "normal") delete e.engine;
    else {
      const capRaw = dmVal("en-engcap");
      const note = dmVal("en-engnote");
      e.engine = {
        name: nm,
        cap: Math.max(1, Math.min(20, Number(capRaw === undefined ? (e.engine || {}).cap : capRaw) || 1)),
      };
      const n = String(note === undefined ? (e.engine || {}).note || "" : note).trim();
      if (n) e.engine.note = n.slice(0, 200);
    }
  }
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
  /* THE CAP IS ON WHAT THE FORM ASKS FOR, NOT ON WHAT A CREATURE HAS. Slicing here was harmless while
     bosses could only be built through the form; the moment the authored ones became editable it meant
     opening Grinsel — who carries seven — and pressing Save would silently take two features off him.
     Same rule as a normal enemy's features: kept, and shown once they exist. */
  /* A NORMAL ENEMY DOES NOT PARRY — that is the rule, and it is enforced here whatever wrote the draft.
     Its FEATURES are a different matter: the form does not ask for them, but half the authored normals
     have one (a Sawdust Hound runs in a pack), so emptying the list would quietly gut every copy taken of
     one and would break this pane's own promise that changing the weight keeps what the new weight does
     not use. They are kept, and the form shows them once they exist. */
  if (out.tier === "normal") out.parryDC = null;
  /* An engine belongs to the upper two weights, the same call the Parry gets: a normal is an AC, some hit
     points and two attacks. Dropped to normal, the pool goes with the Parry — and a half-filled one (a
     name with no cap, or a cap with no name) is not a pool, so it goes too. */
  if (out.tier === "normal" || !out.engine || !out.engine.name) delete out.engine;
  else out.engine = Object.assign({}, out.engine, { cap: Math.max(1, Math.min(20, Number(out.engine.cap) || 1)) });
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
  /* AN AUTHORED ONE, TAKEN AS YOURS. The file in `data/enemies/` is never written to — this is a copy with
     a new id, on your code, which the very next press can edit. It opens in the builder straight away,
     because "copy it" almost always means "copy it and change something". */
  if (act === "clone") {
    const src = ((typeof store !== "undefined" && store.enemies) || []).find((e) => e.id === val);
    if (!src) return;
    const copy = dmTidyEnemy(Object.assign({}, JSON.parse(JSON.stringify(src)),
      { id: "", custom: true, name: (src.name || "Enemy") + " (yours)" }));
    dm.rec.enemies = (dm.rec.enemies || []).concat(copy);
    dmPersist();
    dmUi.draft = JSON.parse(JSON.stringify(copy));
    dmUi.editing = copy.id; dmUi.pick = "";
    renderDmEnemyForm();
    return;
  }
  if (act === "drop") { dmUi.dropArm = val; dmUi.dropText = ""; renderDm(); return; }
  if (act === "drop-cancel") { dmUi.dropArm = ""; dmUi.dropText = ""; renderDm(); return; }
  if (act === "drop-go") {
    if (dmUi.dropText !== "CONFIRM" || dmUi.dropArm !== val) return;
    dm.rec.enemies = (dm.rec.enemies || []).filter((e) => e.id !== val);
    dmUi.dropArm = ""; dmUi.dropText = "";
    dmPersist(); renderDm();
    // Deleted here means gone from anybody it was lent to: dmResolveShare finds nothing to send.
    dmPushSharesWith(val);
    return;
  }
  if (act === "close") { dmUi.editing = null; dmUi.draft = null; renderDm(); return; }
  if (act === "share-add") { dmAddShareCode(); return; }
  if (act === "share-open") { dmUi.shareOpen = dmUi.shareOpen === val ? "" : val; renderDm(); return; }
  if (act === "share-pick" || act === "share-all" || act === "share-none") {
    const code = act === "share-pick" ? val.split("|")[0] : val;
    const entry = (dm.rec.sharesTo || {})[code];
    if (!entry) return;
    if (act === "share-all") entry.ids = dmLendable().map((e) => e.id);
    else if (act === "share-none") entry.ids = [];
    else {
      const id = val.split("|")[1];
      const ids = entry.ids || [];
      entry.ids = ids.includes(id) ? ids.filter((x) => x !== id) : ids.concat(id);
    }
    dmPersist();
    renderDm();
    dmPushShare(code).catch((err) => dmSetMsg("lending failed — " + dmWhy(err), true));
    return;
  }
  /* STOP means STOP: the entry is deleted off their record, not merely emptied on mine, or their browser
     would go on showing the last thing it cached. What they have already KEPT a copy of is theirs. */
  if (act === "share-stop") {
    const to = Object.assign({}, dm.rec.sharesTo);
    delete to[val];
    dm.rec.sharesTo = to;
    if (dmUi.shareOpen === val) dmUi.shareOpen = "";
    dmPersist();
    renderDm();
    dmWriteShare(val, null).catch((err) => dmSetMsg("could not take it back — " + dmWhy(err), true));
    return;
  }
  /* A LENT CREATURE, MADE YOURS FOR GOOD. It becomes an ordinary built enemy on this code — a new id, no
     lender — so taking the loan back afterwards cannot reach it. */
  if (act === "share-keep") {
    const [from, id] = val.split("|");
    const src = (((dm.rec.shared || {})[from] || {}).enemies || []).find((e) => e.id === id);
    if (!src) return;
    const copy = dmTidyEnemy(Object.assign({}, JSON.parse(JSON.stringify(src)),
      { id: "", custom: true, sharedFrom: undefined }));
    delete copy.sharedFrom;
    dm.rec.enemies = (dm.rec.enemies || []).concat(copy);
    dmPersist();
    dmUi.tab = "enemies";
    renderDm();
    return;
  }
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
  if (act === "note-drop") { dmReadNotes(); dmUi.noteArm = Number(val); dmUi.noteText = ""; renderDm(); return; }
  if (act === "note-drop-cancel") { dmUi.noteArm = -1; dmUi.noteText = ""; renderDm(); return; }
  if (act === "note-drop-go") {
    if (dmUi.noteText !== "CONFIRM" || dmUi.noteArm !== Number(val)) return;
    dmReadNotes();
    dm.rec.notes.splice(Number(val), 1);
    dmUi.noteArm = -1; dmUi.noteText = "";
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
  const FIELD = { t: "title", b: "body", f: "folder" };
  for (const node of document.querySelectorAll("[data-dm-note]")) {
    const n = asEl(node);
    const k = n.dataset.dmNote;
    const i = Number(k.slice(1));
    const note = (dm.rec.notes || [])[i];
    if (note && FIELD[k[0]]) note[FIELD[k[0]]] = n.value;
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

/* ---------------------------------------------------------------- lending, written onto their record */

/* READ, CHANGE ONE KEY, WRITE. Their record is theirs — their notes, their tables, their own enemies —
   so this must never write a whole record built here. `shared` is keyed by MY code, so two DMs lending to
   the same person cannot overwrite each other. */
async function dmWriteShare(theirCode, entryOrNull) {
  const rec = Object.assign(dmBlank(), (await CocDm.load(theirCode)) || {});
  rec.shared = rec.shared || {};
  if (entryOrNull) rec.shared[dm.code] = entryOrNull;
  else delete rec.shared[dm.code];
  await CocDm.save(theirCode, rec);
}

/* Everything currently lent to one code, pushed. Called whenever the list changes AND whenever a lent
   creature is edited, so their copy is never a stale stat block. */
async function dmPushShare(theirCode) {
  const ids = dmShareIds(theirCode);
  await dmWriteShare(theirCode, {
    name: dm.rec.name || "", at: Date.now(), enemies: dmResolveShare(ids),
  });
}
/* After an enemy is saved or deleted: only the codes that actually hold it are written to. */
async function dmPushSharesWith(id) {
  for (const [code, entry] of Object.entries(dm.rec.sharesTo || {}))
    if ((entry.ids || []).includes(id)) {
      try { await dmPushShare(code); } catch (err) { dmSetMsg("lending to " + code + " failed — " + dmWhy(err), true); }
    }
}

async function dmAddShareCode() {
  const msg = document.querySelector("#dm-share-msg");
  const say = (t, bad) => { if (msg) { msg.textContent = t; msg.className = "save-msg" + (bad ? " bad" : ""); } };
  const code = String((dmVal("dm-share") || "")).replace(/\D/g, "");
  if (!CocDm.validCode(code)) return say("Six digits.", true);
  if (code === dm.code) return say("That is this code. You already have these.", true);
  if ((dm.rec.sharesTo || {})[code]) return say("Already on the list — press Choose to change what they get.");
  say("Looking for them…");
  let theirs = null;
  try { theirs = await CocDm.load(code); } catch (err) { return say(dmWhy(err), true); }
  /* REFUSED IF NOBODY IS THERE. Writing a share onto a code that has never been opened would CREATE that
     record — the same shape of bug as a figure creating a table that was closed (rtdb-field-write-creates-
     parent) — and a mistyped digit would quietly lend your bestiary to a stranger. */
  if (!theirs) return say("No DM screen answers on " + code + ". Check the code with them — this must be "
    + "their DM code, not a room's key.", true);
  dm.rec.sharesTo = Object.assign({}, dm.rec.sharesTo, { [code]: { name: String(theirs.name || ""), at: Date.now(), ids: [] } });
  dmUi.shareOpen = code;
  dmPersist();
  try { await dmPushShare(code); } catch (err) { return say(dmWhy(err), true); }
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
  // Anybody it is lent to gets the new numbers, so a borrowed card is never a stale one.
  dmPushSharesWith(tidy.id);
}

/* Typing anywhere in the DM's own fields saves; the same debounce the sheet uses. */
document.addEventListener("input", (ev) => {
  if (!dm) return;
  const t = evTarget(ev);
  if (!t || !t.id && !t.dataset) return;
  if (t.id === "dm-name") { dm.rec.name = String(t.value).slice(0, 40); dmRemember(dm.code, dm.rec.name); dmPersist(); return; }
  if (t.dataset && t.dataset.dmNote) { dmReadNotes(); dmPersist(); return; }
  /* NO REPAINT WHILE YOU ARE TYPING IN IT. Redrawing the pane replaces this very input, and a phone
     keyboard that has had its element swapped out drops back to lowercase — so typing CONFIRM in capitals
     becomes shift, C, shift, O, shift, N. Kayki hit that on the character sheet, on every letter. The only
     thing that changes as you type is whether the button is live, so that is the only thing touched. */
  if (t.id === "dm-drop-confirm") {
    dmUi.dropText = String(t.value);
    const go = document.querySelector('[data-dm="drop-go"]');
    if (go) asEl(go).disabled = dmUi.dropText !== "CONFIRM";
    return;
  }
  if (t.id === "dm-note-confirm") {
    dmUi.noteText = String(t.value);
    const go = document.querySelector('[data-dm="note-drop-go"]');
    if (go) asEl(go).disabled = dmUi.noteText !== "CONFIRM";
    return;
  }
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
