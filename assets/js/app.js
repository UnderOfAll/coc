/*
 * Circus of Chaos — compendium front-end.
 *
 * DATA-DRIVEN BY CONTRACT. Nothing here knows about any specific class, trick or weapon: every
 * category is a folder of JSON validated against data/schema/<category>.schema.json, bundled by
 * scripts/build_manifest.py, and rendered by one function listed in CATEGORIES below.
 *
 * TO ADD CONTENT: drop a JSON file in data/<category>/ and run `bash scripts/check.sh`. No code
 * change. An empty category hides its own sidebar tab until it has an entry.
 *
 * TO ADD A CATEGORY: (1) data/schema/<name>.schema.json, (2) the folder, (3) one line in
 * CATEGORIES here, (4) one render<Name>() function, (5) a `case` in cardMeta(). Add the name to
 * SCHEMA in scripts/validate.py and CATEGORIES in scripts/build_manifest.py. That is the whole
 * surface — see the add-content-type skill.
 *
 * TWO AUTHORING TOKENS, expanded by fmtDesc() and enforced by the build lint:
 *   {{Label|formula}}  a derived number. The LABEL shows; the formula is the tooltip. Never spell
 *                      maths inline — the build fails on it, and fails if the halves are swapped.
 *   [[XdY]] / [[XdY+Abil]]  a Scaling Die (MECHANICS §3). Renders the whole level ladder.
 * Any text that reaches the screen must go through esc() or fmtDesc(). stat(), statHTML(),
 * makeCard() and snippet() escape for you; statHTML() is the one that takes trusted HTML.
 */

const CATEGORIES = [
  { key: "rules",      label: "Rules",       render: renderRule },
  { key: "classes",    label: "Classes",    render: renderClass },
  { key: "subclasses", label: "Subclasses", render: renderSubclass },
  { key: "tricks",     label: "Tricks",     render: renderTrick },
  { key: "skills",     label: "Skills",     render: renderSkill },
  { key: "passives",   label: "Passives",   render: renderPassive },
  { key: "weapons",    label: "Weapons",    render: renderWeapon },
  { key: "armor",      label: "Armor",      render: renderArmor },
];

const store = {};        // key -> array of entries
let current = "classes"; // active category
let manifest = {};
const listScroll = {};   // key -> remembered list scroll position, restored on Back

// Canonical 5e ability order — used to group/sort skills by the stat they scale with.
const ABILITY_ORDER = ["Strength", "Dexterity", "Constitution", "Intelligence", "Wisdom", "Charisma"];

const $ = (sel) => document.querySelector(sel);
/* The whole document scrolls (see the shell note in style.css), so every "where were we" question
   is asked of the page, never of a panel inside it. */
const pageScroller = () => document.scrollingElement || document.documentElement;
const el = (tag, cls, html) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html != null) n.innerHTML = html;
  return n;
};

async function boot() {
  // Fast path: one request pulls every entry from the pre-built bundle.
  let bundle = null;
  try {
    bundle = await fetchJSON("data/bundle.json");
  } catch (e) {
    bundle = null; // fall back to per-file loading below
  }

  if (bundle) {
    for (const cat of CATEGORIES) store[cat.key] = prepareEntries(bundle[cat.key] || []);
  } else {
    // Fallback: read the manifest and load each file (in parallel per category).
    try {
      manifest = await fetchJSON("data/manifest.json");
    } catch (e) {
      setStatus("Could not load data — run scripts/build_manifest.py and serve over http.");
      manifest = {};
    }
    await Promise.all(CATEGORIES.map(async (cat) => {
      store[cat.key] = await loadCategory(manifest[cat.key] || []);
    }));
  }

  buildIndexes();
  buildSidebar();
  wireEvents();
  $("#legend-panel").innerHTML = legendHTML();
  const total = Object.values(store).reduce((n, a) => n + a.length, 0);
  setStatus(total ? `${total} entries loaded across ${CATEGORIES.length} categories.` : "No content yet.");
  routeFromHash();
}

/* Lookup indexes, built once after load. Six render paths used to linear-scan a store array —
   attacksSection did one scan per weapon per class page — which is fine at 141 entries and silly
   at any larger number. Rebuilt by buildIndexes() whenever the store changes. */
const idx = { classes: new Map(), subclasses: new Map(), weaponsByName: new Map(), skillsByName: new Map(), armorById: new Map(), tricksById: new Map() };
function buildIndexes() {
  idx.classes.clear(); idx.subclasses.clear(); idx.weaponsByName.clear(); idx.skillsByName.clear();
  idx.armorById.clear(); idx.tricksById.clear();
  for (const c of store.classes || []) idx.classes.set(c.id || slug(c), c);
  for (const s of store.subclasses || []) idx.subclasses.set(s.id || s.name, s);
  for (const w of store.weapons || []) idx.weaponsByName.set(w.name, w);
  for (const k of store.skills || []) idx.skillsByName.set((k.name || "").toLowerCase(), k);
  for (const a of store.armor || []) idx.armorById.set(a.id || slug(a), a);
  for (const t of store.tricks || []) idx.tricksById.set(t.id || slug(t), t);
}

// Attach the searchable text blob and sort a category's entries by name.
function prepareEntries(items) {
  for (const it of items) it._search = collectText(it, []).join(" · ").toLowerCase();
  items.sort((a, b) => (a.name || "").localeCompare(b.name || ""));
  return items;
}

async function loadCategory(files) {
  const out = [];
  for (const file of files) {
    try {
      const data = await fetchJSON("data/" + file);
      const items = Array.isArray(data) ? data : [data];
      for (const it of items) { it._file = file; out.push(it); }
    } catch (e) {
      console.warn("Failed to load", file, e);
    }
  }
  return prepareEntries(out);
}

async function fetchJSON(url) {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(res.status + " " + url);
  return res.json();
}

function buildSidebar() {
  const nav = $("#sidebar");
  nav.innerHTML = "";
  for (const cat of CATEGORIES) {
    // An empty category is a tab that goes nowhere — hide it until it has content. The app stays
    // fully data-driven: drop a file in and the tab reappears on the next build.
    if (!store[cat.key] || !store[cat.key].length) continue;
    const btn = el("button", "nav-btn");
    btn.dataset.key = cat.key;
    btn.innerHTML = `<span>${cat.label}</span><span class="count">${store[cat.key].length}</span>`;
    btn.addEventListener("click", () => { $("#search").value = ""; listScroll[cat.key] = 0; selectCategory(cat.key); });
    nav.appendChild(btn);
  }
}

/* The sticky sidebar has to start below the sticky top bar, and that bar's height depends on whether
   its row has wrapped — which is a layout fact no CSS length can state. Measure it and publish it. */
function measureTopbar() {
  const bar = $(".topbar");
  if (bar) document.documentElement.style.setProperty("--topbar-h", bar.offsetHeight + "px");
}

function wireEvents() {
  measureTopbar();
  window.addEventListener("resize", measureTopbar, { passive: true });
  $("#back").addEventListener("click", () => { location.hash = "#/" + current; });
  // Landing menu needs the sidebar built even before the compendium is first opened.

  $("#search").addEventListener("input", (e) => {
    const q = e.target.value.trim().toLowerCase();
    if (q) renderSearch(q); else selectCategory(current);
  });
  window.addEventListener("hashchange", routeFromHash);
  $("#legend-btn").addEventListener("click", () => $("#legend-panel").classList.toggle("hidden"));
  $("#legend-panel").addEventListener("click", (e) => {
    if (e.target.id === "legend-close") $("#legend-panel").classList.add("hidden");
  });
  // Tricks tab: the Tier / Class / Level grouping toggle.
  document.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-trick-group]");
    if (!btn) return;
    trickGrouping = btn.dataset.trickGroup;
    renderList("tricks");
  });
  // How it works / In play: flips ONE entry's body, never the whole page.
  document.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-fview]");
    if (!btn) return;
    const box = btn.closest(".tabbed");
    if (!box) return;
    const want = btn.dataset.fview;
    box.querySelectorAll(":scope > .group-toggle > .toggle-btn")
       .forEach((b) => b.classList.toggle("active", b.dataset.fview === want));
    box.querySelectorAll(":scope > [data-body]")
       .forEach((b) => b.classList.toggle("hidden", b.dataset.body !== want));
  });
  // Tap-to-toggle tooltips: touchscreens can't hover, so a tap opens the formula /
  // scaling-die box; tapping the same term again or anywhere else closes it.
  document.addEventListener("click", (e) => {
    const term = e.target.closest(".tip-term, .scaling-die");
    document.querySelectorAll(".tip-open").forEach((n) => { if (n !== term) n.classList.remove("tip-open"); });
    if (term) { term.classList.toggle("tip-open"); clampTip(term); e.stopPropagation(); }
  });
  // A tooltip is centred on its term, which puts it off-screen (or under the sidebar) whenever
  // the term sits near an edge — the tier badge at the top-left of a trick page was half-hidden.
  // Measure on open and nudge it back inside the reading column; the arrow follows the term.
  document.addEventListener("mouseover", (e) => {
    const term = e.target.closest(".tip-term, .scaling-die");
    if (term) clampTip(term);
  });
  // Keyboard parity: these are spans, so Tab focuses them and Enter/Space opens the same box a
  // mouse hover or a tap would. Escape closes it.
  document.addEventListener("keydown", (e) => {
    const term = e.target.closest && e.target.closest(".tip-term, .scaling-die");
    if (term && (e.key === "Enter" || e.key === " ")) {
      e.preventDefault();
      term.classList.toggle("tip-open");
      clampTip(term);
    } else if (e.key === "Escape") {
      document.querySelectorAll(".tip-open").forEach((n) => n.classList.remove("tip-open"));
    }
  });
  document.addEventListener("focusin", (e) => {
    const term = e.target.closest && e.target.closest(".tip-term, .scaling-die");
    if (term) clampTip(term);
  });
}

/* Short, always-available rules reference — summarizes the shared Parry
   engine from data/schema/MECHANICS.md so a player has it on hand without duplicating
   any per-class numbers (those render from each class's own JSON fields). */
function legendHTML() {
  return `
    <button id="legend-close" class="legend-close" aria-label="Close">&times;</button>
    <h2>Parry</h2>
    <p><strong>Parry</strong> replaces passive defense with an active save-like roll. When an attack
      roll would hit you, spend your reaction to roll a flat d20 (no modifier — your bonuses already
      live in the DC) against your effective Parry DC.</p>
    <ul>
      <li>Roll above your DC &mdash; <strong>Full Dodge</strong>, no damage.</li>
      <li>Roll equal to your DC &mdash; <strong>Grazing Parry</strong>, half damage.</li>
      <li>Roll below your DC &mdash; <strong>Overcommitted</strong>, +50% damage.</li>
    </ul>
    <p>Each class lists its own <strong>Parry Base DC</strong> (lower is better) and
      <strong>Defense Ability</strong>, which combine with proficiency and situational modifiers to
      set the effective DC for a given attack. A Full Dodge may trigger a class's Riposte, if it has
      one.</p>`;
}

/* Which top-level view is on screen. The compendium is no longer the whole app: the landing menu
   and the character tools (creator, manager, live sheet) are peers of it. Each tool route is handled
   by creator.js, which registers itself in COC_ROUTES — so app.js never needs to know about them. */
const COC_ROUTES = {};
function showView(which) {
  for (const [id, name] of [["menu-view", "menu"], ["compendium-view", "compendium"], ["tool-view", "tool"]]) {
    const node = document.getElementById(id);
    if (node) node.classList.toggle("hidden", name !== which);
  }
  const search = $("#search");
  if (search) search.classList.toggle("hidden", which !== "compendium");
}

function routeFromHash() {
  const hash = location.hash.replace(/^#\/?/, "");
  const [head, ...rest] = hash.split("/");
  const arg = rest.join("/");

  // Landing menu: the default, and what an empty hash means.
  if (!head) {
    showView("menu");
    setStatus(typeof CocStore !== "undefined" ? CocStore.describe() : "");
    return;
  }

  // Character tools, registered by creator.js.
  if (COC_ROUTES[head]) { showView("tool"); COC_ROUTES[head](decodeURIComponent(arg)); return; }

  // Otherwise the compendium.
  showView("compendium");
  const key = CATEGORIES.some((c) => c.key === head) ? head : "classes";
  if (arg) showDetail(key, decodeURIComponent(arg));
  else selectCategory(key);
}

function selectCategory(key) {
  current = key;
  document.querySelectorAll(".nav-btn").forEach((b) => b.classList.toggle("active", b.dataset.key === key));
  $("#detail-view").classList.add("hidden");
  $("#list-view").classList.remove("hidden");
  $("#list-title").textContent = CATEGORIES.find((c) => c.key === key).label;
  renderList(key);
  if (location.hash !== "#/" + key) history.replaceState(null, "", "#/" + key);
  pageScroller().scrollTop = listScroll[key] || 0;
}

function renderList(key) {
  const list = $("#list");
  list.innerHTML = "";
  list.className = "cards";
  const items = store[key];
  if (!items.length) {
    list.appendChild(el("p", "muted", "Nothing here yet — drop a JSON file in data/" + key + "/."));
    return;
  }
  // Classes: one full-width field each (name, description, open arrow).
  if (key === "classes")    return renderClassList(list, items);
  // Grouped views: skills by the ability they scale with, subclasses by parent class.
  if (key === "skills")     return renderGroupedList(list, key, items, groupBySkillAbility);
  if (key === "subclasses") return renderGroupedList(list, key, items, groupBySubclassParent);
  // Armor: Starter vs Bought, each split again by category — the same nested shape the Tricks
  // tab uses for a class and its disciplines.
  if (key === "armor")      return renderArmorList(list, items);
  // Tricks: three ways to slice the same list — by tier, by class, or by unlock level.
  if (key === "tricks")     return renderTrickList(list, items);
  for (const it of items) list.appendChild(makeCard(key, it));
}

/* Armor tab: two tiers, each split into categories. A flat list made you read the category off
   every card; this way the shape of the catalogue — what exists at each tier, and where the gaps
   are — is visible at a glance. Same nested pattern as the Tricks class view. */
const ARMOR_TIERS = [
  ["starter", "Starter", "owned at character creation"],
  ["bought", "Bought", "premium kit, if the purse allows"],
];
const ARMOR_CATEGORIES = [
  ["clothing", "Clothing", "the full casters' lane; needs no proficiency"],
  ["light", "Light", "adds your full Dexterity modifier"],
  ["medium", "Medium", "adds up to +2 Dexterity"],
  ["heavy", "Heavy", "no Dexterity, and a Strength requirement"],
  ["shield", "Shields", "a flat bonus on top of your armour"],
];
function renderArmorList(list, items) {
  list.className = "grouped";
  for (const [tier, tierLabel, tierNote] of ARMOR_TIERS) {
    const inTier = items.filter((a) => (a.availability || "starter") === tier);
    if (!inTier.length) continue;
    const section = el("section", "group");
    section.appendChild(el("h2", "group-title",
      `${esc(tierLabel)} <span class="sub-note">— ${esc(tierNote)}</span>`));
    for (const [cat, catLabel, catNote] of ARMOR_CATEGORIES) {
      const inCat = inTier.filter((a) => a.category === cat);
      if (!inCat.length) continue;
      const box = el("div", "sub-block");
      box.appendChild(el("h3", "sub-title",
        `${esc(catLabel)} <span class="sub-note">— ${esc(catNote)}</span>`));
      const grid = el("div", "cards");
      for (const a of inCat.sort((x, y) => (x.baseAC || x.acBonus || 0) - (y.baseAC || y.acBonus || 0)))
        grid.appendChild(makeCard("armor", a));
      box.appendChild(grid);
      section.appendChild(box);
    }
    list.appendChild(section);
  }
}

/* Classes tab: a vertical stack of fields, alphabetical, each with the class name on top, a
   brief description below, and an arrow button that opens the class sheet. */
function renderClassList(list, items) {
  list.className = "class-list";
  for (const it of items) {
    const field = el("article", "class-field");
    field.innerHTML = `
      <div class="class-field-main">
        <h3>${esc(it.name)}</h3>
        <div class="class-field-meta">
          <span class="tag">${esc(it.source || "5e")}</span>
          <span class="meta">${esc(cardMeta("classes", it))}</span>
          ${it.parryBaseDC != null ? `<span class="badge badge-sm badge-dc">Parry DC ${esc(it.parryBaseDC)}</span>` : ""}
        </div>
        ${it.flavor ? `<p class="class-field-desc">${esc(it.flavor)}</p>` : ""}
      </div>
      <button class="open-arrow" type="button" aria-label="Open ${esc(it.name)} sheet">&rarr;</button>`;
    field.addEventListener("click", () => { location.hash = "#/classes/" + encodeURIComponent(slug(it)); });
    list.appendChild(field);
  }
}

/* One list card (used by the grid + grouped views; classes have their own field layout). */
function makeCard(key, it) {
  const card = el("div", "card");
  card.innerHTML = `<h3>${esc(it.name)}</h3>
    <div class="meta">${esc(cardMeta(key, it))}</div>
    ${cardTermsHTML(key, it)}
    <div class="card-tags">
      <span class="tag">${esc(it.source || "5e")}</span>
    </div>`;
  card.addEventListener("click", () => { location.hash = "#/" + key + "/" + encodeURIComponent(slug(it)); });
  return card;
}

/* The property a player is actually choosing on, as a hover/tap term ON THE CARD — not only on the
   detail page. Kayki: "all this can have tooltips to explain to the players when they are choosing
   aswell, since if me that is the creator is having troubles understanding it, immagine the players."
   Picking armour or a weapon means comparing traits and masteries, so the explanation has to be in
   the list, not one click away. */
function cardTermsHTML(key, it) {
  if (key === "armor") {
    return `<div class="card-terms">Trait: ${armorTraitHTML(it.trait)}</div>`;
  }
  if (key === "weapons" && it.mastery) {
    return `<div class="card-terms">Mastery: ${masteryHTML(it.mastery)}</div>`;
  }
  return "";
}

/* Render a list split into labelled sections. `grouper` returns [label, items][]. */
function renderGroupedList(list, key, items, grouper) {
  list.className = "grouped";
  for (const [label, arr] of grouper(items)) {
    const section = el("section", "group");
    section.appendChild(el("h2", "group-title", esc(label)));
    const grid = el("div", "cards");
    for (const it of arr) grid.appendChild(makeCard(key, it));
    section.appendChild(grid);
    list.appendChild(section);
  }
}

/* ---- Global search: every category, every field ---- */

/* Recursively gather all string values in an entry into one searchable blob. */
function collectText(obj, acc) {
  if (obj == null) return acc;
  if (typeof obj === "string") { acc.push(obj); return acc; }
  if (Array.isArray(obj)) { for (const v of obj) collectText(v, acc); return acc; }
  if (typeof obj === "object") {
    for (const k in obj) { if (k === "_file" || k === "_search") continue; collectText(obj[k], acc); }
  }
  return acc;
}

/* Search results across ALL categories, grouped by category, matching any field. */
function renderSearch(q) {
  $("#detail-view").classList.add("hidden");
  $("#list-view").classList.remove("hidden");
  document.querySelectorAll(".nav-btn").forEach((b) => b.classList.remove("active"));
  $("#list-title").textContent = `Search: “${q}”`;
  const list = $("#list");
  list.innerHTML = "";
  list.className = "grouped";
  let total = 0;
  for (const cat of CATEGORIES) {
    const hits = store[cat.key].filter((it) => (it._search || "").includes(q));
    if (!hits.length) continue;
    total += hits.length;
    const section = el("section", "group");
    section.appendChild(el("h2", "group-title", `${esc(cat.label)} (${hits.length})`));
    const grid = el("div", "cards");
    for (const it of hits) grid.appendChild(makeSearchCard(cat.key, it, q));
    section.appendChild(grid);
    list.appendChild(section);
  }
  if (!total) list.appendChild(el("p", "muted", `No matches for “${esc(q)}”.`));
  setStatus(total ? `${total} match${total === 1 ? "" : "es"} for “${q}”.` : `No matches for “${q}”.`);
}

/* A result card: name, category meta, and a snippet showing where the term matched. */
function makeSearchCard(key, it, q) {
  const card = el("div", "card");
  const nameHit = (it.name || "").toLowerCase().includes(q);
  const subHTML = nameHit ? esc(it.flavor || it.summary || "") : snippet(it._search || "", q);
  card.innerHTML = `<h3>${esc(it.name)}</h3>
    <div class="meta">${esc(cardMeta(key, it))}</div>
    ${subHTML ? `<p class="card-summary">${subHTML}</p>` : ""}`;
  card.addEventListener("click", () => { location.hash = "#/" + key + "/" + encodeURIComponent(slug(it)); });
  return card;
}


/* Tricks group by tier, in play order (at-will -> cooldown -> engine-gated) rather than
   alphabetically: the tier is the first thing a player needs to know about a trick. */
const TIER_LABELS = {
  pledge: "Pledges — at-will",
  turn: "Turns — on a cooldown",
  prestige: "Prestiges — spend your engine",
};
function groupByTier(items) {
  const order = ["pledge", "turn", "prestige"];
  const groups = new Map(order.map((k) => [k, []]));
  for (const it of items) if (groups.has(it.tier)) groups.get(it.tier).push(it);
  return order.filter((k) => groups.get(k).length).map((k) => [TIER_LABELS[k], groups.get(k)]);
}

/* The two casting grades (MECHANICS §4.9a). A shared trick ability does NOT mean a shared list:
   the Jester and Joker are both Charisma and overlap by exactly one trick. The CLASS owns the
   list, which is why tricks group by class and never by ability. */
const CASTER_GRADE = {
  illusionist:  { grade: "Full caster",  startsAt: 1 },
  jester:       { grade: "Full caster",  startsAt: 1 },
  puppeteer:    { grade: "Half-caster",  startsAt: 2 },
  doppelganger: { grade: "Half-caster",  startsAt: 2 },
  joker:        { grade: "Half-caster",  startsAt: 2 },
};
const TRICK_CLASS_ORDER = ["illusionist", "jester", "puppeteer", "doppelganger", "joker"];

/* Skills tab: grouped by the ability they scale with, in canonical 5e order, so a player looking
   for "what does Dexterity cover" sees it in one block. */
function groupBySkillAbility(items) {
  const groups = new Map();
  for (const it of items) {
    const key = it.ability || "Other";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(it);
  }
  const order = ABILITY_ORDER.filter((a) => groups.has(a)).concat([...groups.keys()].filter((k) => !ABILITY_ORDER.includes(k)));
  return order.map((k) => [k, groups.get(k).sort((a, b) => a.name.localeCompare(b.name))]);
}

/* Subclasses tab: grouped under their parent class, classes in alphabetical order. */
function groupBySubclassParent(items) {
  const groups = new Map();
  for (const it of items) {
    const key = className(it.parentClass) || "Unassigned";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(it);
  }
  return [...groups.keys()].sort((a, b) => a.localeCompare(b))
    .map((k) => [k, groups.get(k).sort((a, b) => a.name.localeCompare(b.name))]);
}

const TIER_ORDER = { pledge: 0, turn: 1, prestige: 2 };
let trickGrouping = "class";  // Class first: a player reads their own repertoire far more often than the tier shelves.

/* Tricks tab: two ways to slice the same list — by tier, or by class (with each class's own
   level ladder nested inside it).

   There is deliberately NO global "Level" grouping. An unlock level only means something
   INSIDE a class: the same trick lands on different levels for different classes, because two
   gates decide when you get it and the later one wins (MECHANICS §4.9b). Sleight is minLevel 1,
   but a Joker is a half-caster who casts nothing at level 1, so his Sleight is level 2. A
   roster-wide "Level 1" shelf would therefore be a lie for three of the five classes — so level
   lives inside the class ladder, where it's unambiguous, and is computed for the player. */
function renderTrickList(list, items) {
  list.className = "trick-list";
  const bar = el("div", "group-toggle");
  for (const [mode, label] of [["class", "Class"], ["tier", "Tier"]]) {
    const b = el("button", "toggle-btn" + (trickGrouping === mode ? " active" : ""), esc(label));
    b.dataset.trickGroup = mode;
    bar.appendChild(b);
  }
  list.appendChild(bar);
  const groups = el("div", "grouped");
  if (trickGrouping === "class") renderTricksByClass(groups, items);
  else {
    for (const [label, arr] of groupByTier(items)) {
      const section = el("section", "group");
      section.appendChild(el("h2", "group-title", esc(label)));
      const grid = el("div", "cards");
      for (const it of arr) grid.appendChild(makeCard("tricks", it));
      section.appendChild(grid);
      groups.appendChild(section);
    }
  }
  list.appendChild(groups);
}

/* One section per class = that class's whole repertoire as a level ladder, which is how a player
   actually reads it ("what do I get at level 3?"). A trick on several lists (only Sleight today)
   appears under each class, at that class's own level for it. */
function renderTricksByClass(container, items) {
  for (const cid of TRICK_CLASS_ORDER) {
    const mine = items.filter((t) => (t.classes || []).includes(cid));
    if (!mine.length) continue;
    const g = CASTER_GRADE[cid];
    const section = el("section", "group");
    section.appendChild(el("h2", "group-title", esc(`${className(cid)} — ${g.grade}`)));

    // The class's own list and its subclasses' granted lists are kept visually apart
    // (MECHANICS §4.9d): everyone of this class has the first set, and only one discipline
    // has each of the others. Mixing them into one ladder implies a repertoire you don't have.
    const base = mine.filter((t) => !(t.subclasses || []).length);
    section.appendChild(levelLadder(base, g.startsAt));

    const bySub = new Map();
    for (const t of mine) {
      for (const sid of t.subclasses || []) {
        if (!bySub.has(sid)) bySub.set(sid, []);
        bySub.get(sid).push(t);
      }
    }
    // A THIRD gate applies here (MECHANICS §4.9d): you do not have the subclass until its own
    // level, so a granted trick can never unlock before then however low its minLevel is.
    const subLv = subclassLevelOf(cid);
    for (const sid of [...bySub.keys()].sort((a, b) => subclassName(a).localeCompare(subclassName(b)))) {
      const box = el("div", "sub-block");
      box.appendChild(el("h3", "sub-title",
        `${esc(subclassName(sid))} <span class="sub-note">— discipline tricks, this subclass only</span>`));
      box.appendChild(levelLadder(bySub.get(sid), Math.max(g.startsAt, subLv)));
      section.appendChild(box);
    }
    container.appendChild(section);
  }
}

/* The level at which a class actually picks a subclass (all 8 are 3 today, but read it). */
function subclassLevelOf(cid) {
  const c = idx.classes.get(cid);
  return (c && c.subclassLevel) || 3;
}

/* A set of tricks as a level ladder. `floor` is the earliest level this reader could have ANY of
   them — the class's casting start level, raised to the subclass level for granted tricks. The
   trick's own minLevel is its power gate; the later gate always wins (MECHANICS §4.9b, §4.9d). */
function levelLadder(list, floor) {
  const wrap = el("div", "ladder");  // hook kept for the Tricks class view
  const byLevel = new Map();
  for (const t of list) {
    const lv = Math.max(t.minLevel || 1, floor);
    if (!byLevel.has(lv)) byLevel.set(lv, []);
    byLevel.get(lv).push(t);
  }
  for (const lv of [...byLevel.keys()].sort((a, b) => a - b)) {
    const block = el("div", "level-block");
    block.appendChild(el("h3", "level-title", esc("Level " + lv)));
    const grid = el("div", "cards");
    const arr = byLevel.get(lv).sort((a, b) =>
      TIER_ORDER[a.tier] - TIER_ORDER[b.tier] || a.name.localeCompare(b.name));
    for (const t of arr) grid.appendChild(makeCard("tricks", t));
    block.appendChild(grid);
    wrap.appendChild(block);
  }
  return wrap;
}

// Display name for a class id (e.g. "the-sandow" -> "The Sandow").
function className(id) {
  const c = idx.classes.get(id);
  return c ? c.name : cap(String(id).replace(/-/g, " "));
}

/* Display name for a subclass id, mirroring className() for classes. */
function subclassName(id) {
  const s = idx.subclasses.get(id);
  return s ? s.name : cap(String(id || "").replace(/-/g, " "));
}

function cardMeta(key, it) {
  switch (key) {
    case "rules":      return it.summary || "";
    case "classes":    return `HP ${it.hitDie || "?"} · ${it.primaryAbility || ""}`;
    case "subclasses": return `${className(it.parentClass) || "?"} subclass`;
    // No level here: it's a heading in the Class view, and a raw minLevel would contradict it
    // (Sleight is minLevel 1 but sits at Level 2 for a half-caster).
    // A subclass-granted trick (MECHANICS §4.9d) is named, or the class ladder would imply
    // every member of the class has it.
    case "tricks":     return `${cap(it.tier || "")} · ${it.discipline || ""}` +
                              (Array.isArray(it.subclasses) && it.subclasses.length
                                ? ` · ${it.subclasses.map(subclassName).join("/")} only` : "");
    case "skills":     return `${it.ability || ""}`;
    case "passives":   return `${it.type || "Feature"}`;
    case "weapons":    return `${it.category ? cap(it.category) : ""} · ${it.damage && it.damage.type ? it.damage.type : ""}`;
    case "armor":      return `${it.category ? cap(it.category) : ""}${it.category === "shield" ? " · +" + (it.acBonus ?? 0) + " AC" : " · AC " + (it.baseAC ?? "?")}${it.availability === "bought" ? " · Bought" : ""}`;
    default:           return "";
  }
}

/* Keep a tooltip inside the visible reading area. It is normally centred on its term via
   translateX(-50%); this measures the box once it is laid out and sets a --nudge offset that
   the CSS adds to that centring (and subtracts from the arrow, so the arrow keeps pointing at
   the term). Runs on hover and on tap — both open the same box. */
function clampTip(term) {
  const tip = term.querySelector(".term-tip, .scale-tip");
  if (!tip) return;
  tip.style.setProperty("--nudge", "0px");
  // The term's OWN scroll container, not the first `.content` on the page. There are two of those
  // now — the compendium's and the character tools' — and the hidden one measures 0×0, which
  // clamped every tooltip on a character sheet against the left edge of the window.
  const area = (term.closest(".content") || document.body).getBoundingClientRect();
  const box = tip.getBoundingClientRect();
  const pad = 10;
  let dx = 0;
  if (box.left < area.left + pad) dx = (area.left + pad) - box.left;
  else if (box.right > area.right - pad) dx = (area.right - pad) - box.right;
  if (dx) tip.style.setProperty("--nudge", Math.round(dx) + "px");
  // Vertical: the box sits above its term by default, which puts it off-screen — or underneath the
  // sticky top bar — for any term near the top of the VIEWPORT. That is a viewport question, not a
  // reading-column one: the column starts far above the screen once the page is scrolled.
  const bar = $(".topbar");
  const ceiling = (bar ? bar.getBoundingClientRect().bottom : 0) + pad;
  term.classList.toggle("tip-below", box.top < ceiling);
}

function showDetail(key, id, keepScroll) {
  const it = store[key].find((x) => slug(x) === id);
  if (!it) { selectCategory(key); return; }
  const page = pageScroller();
  const at = keepScroll ? page.scrollTop : 0;
  // Remember where the list was scrolled so Back can return to that spot.
  if (!$("#list-view").classList.contains("hidden")) listScroll[current] = page.scrollTop;
  current = key;
  $("#list-view").classList.add("hidden");
  $("#detail-view").classList.remove("hidden");
  const entry = CATEGORIES.find((c) => c.key === key);
  try {
    $("#detail").innerHTML = entry.render(it);
  } catch (err) {
    // One malformed entry must not blank the app. Show what failed and keep the shell usable.
    console.error("render failed for", key, id, err);
    $("#detail").innerHTML = `<h1>${esc(it.name || id)}</h1>` +
      `<p class="muted">This entry could not be rendered — its data is probably malformed. ` +
      `Run <code>bash scripts/check.sh</code>. Details are in the browser console.</p>`;
  }
  page.scrollTop = at;
}

/* ---------- renderers (one per category) ---------- */

function head(name, sub) {
  return `<h1>${esc(name)}</h1>${sub ? `<p class="detail-sub">${esc(sub)}</p>` : ""}`;
}
function stat(label, value) {
  return `<div class="stat"><div class="label">${esc(label)}</div><div class="value">${esc(value)}</div></div>`;
}
/* Like stat(), but the value is trusted HTML (already escaped where needed) — for values that
   contain markup such as hover-term tooltips. */
function statHTML(label, html) {
  return `<div class="stat"><div class="label">${esc(label)}</div><div class="value">${html}</div></div>`;
}
/* Every describable thing carries its OWN pair of tabs (MECHANICS §5): "How it works" is the
   numbers — the meta chips, the save, the dice, the conditions — and "In play" is how the thing
   looks when it happens at the table. The old blended description is no longer rendered anywhere:
   mixing the two is what made these pages a wall of text.

   The switch is per-entry, not per-page: flipping Counterflow to "In play" leaves every other
   feature on the sheet exactly as it was. Both bodies are rendered up front and one is hidden, so
   flipping a tab is a class change on one element — no re-render, no lost scroll position, and
   each feature keeps its own state for as long as the page is open. */
const VIEW_TABS = [["rules", "How it works"], ["play", "In play"]];
function tabbed(rulesHTML, playHTML) {
  const btns = VIEW_TABS.map(([mode, label]) =>
    `<button class="toggle-btn${mode === "rules" ? " active" : ""}" data-fview="${mode}">${esc(label)}</button>`
  ).join("");
  return `<div class="tabbed">
    <div class="group-toggle view-toggle">${btns}</div>
    <div data-body="rules">${rulesHTML}</div>
    <div class="hidden" data-body="play">${playHTML}</div>
  </div>`;
}

/* The "In play" body. Falls back to a plain note rather than an empty panel, so an unwritten
   narration reads as missing instead of looking broken. */
function narrationHTML(n) {
  return n
    ? `<p class="narration">${fmtDesc(n)}</p>`
    : `<p class="narration muted">No in-play description written for this yet.</p>`;
}

function features(list) {
  if (!Array.isArray(list) || !list.length) return "";
  return `<h2>Features</h2>` + list.map((f) => {
    const roleBadge = f.role === "roleplay" ? `<span class="role-badge">Roleplay</span>` : "";
    const rules = metaRow(f.meta) + `${fmtDesc(f.sheetSummary || f.description || "")}` +
      (Array.isArray(f.options) && f.options.length ? optionTable(f.options) : "");
    return `<div class="feature"><span class="lvl">Level ${esc(f.level ?? "—")}:</span>
     <strong>${esc(f.name || "")}</strong>${roleBadge}${tabbed(rules, narrationHTML(f.narration))}</div>`;
  }).join("");
}

/* D&D-Beyond-style at-a-glance chips (Action / Cost / Uses / Range / Save) below a feature's
   name, from its structured `meta`. Only present fields render. */
function metaRow(m) {
  if (!m || typeof m !== "object") return "";
  // "Cost" = the action economy plus any resource spent, in one chip.
  const cost = [m.action, m.cost].filter(Boolean).join(" · ");
  const fields = [["Cost", cost], ["Uses", m.uses], ["Range", m.range],
                  ["Cooldown", m.cooldown], ["Save", m.save]];
  // Values run through fmtDesc so a chip can carry a {{Label|formula}} tooltip (the save DC is
  // never spelled out inline) or a [[XdY]] scaling die.
  const chips = fields.filter(([, v]) => v).map(([k, v]) =>
    `<span class="fmeta"><span class="fk">${esc(k)}</span><span class="fv">${fmtDesc(v)}</span></span>`).join("");
  return chips ? `<div class="feature-meta">${chips}</div>` : "";
}

/* A feature's structured `options` (a pick-one menu or a random table) as a table. A `roll`
   on any option makes it a random table (numbered column); otherwise it's a choice menu. */
/* Rows may carry a `group` label; each group becomes its own table under that heading, so
   always-on effects are never listed alongside a menu the player picks from. */
function optionTable(opts, ladder) {
  const groups = [...new Set(opts.map((o) => o.group || ""))];
  if (groups.length > 1 || groups[0]) {
    return groups.map((g) => {
      const rows = opts.filter((o) => (o.group || "") === g);
      return (g ? `<h4 class="option-group">${esc(g)}</h4>` : "") + oneOptionTable(rows, ladder);
    }).join("");
  }
  return oneOptionTable(opts, ladder);
}

function oneOptionTable(opts, ladder) {
  const hasRoll = opts.some((o) => o.roll != null);
  const nameHdr = hasRoll ? "Result" : "Option";
  const headCells = (hasRoll ? "<th>Roll</th>" : "") + `<th>${nameHdr}</th><th>Effect</th>`;
  const rows = opts.map((o) => {
    const rollCell = hasRoll ? `<td class="col-num">${esc(o.roll ?? "")}</td>` : "";
    return `<tr>${rollCell}<td>${fmtDesc(o.name || "", ladder)}</td><td>${fmtDesc(o.effect || "", ladder)}</td></tr>`;
  }).join("");
  return `<table class="data-table option-table">
      <thead><tr>${headCells}</tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

/* A feature whose text embeds a numbered option list — "(1) Name: effect. (2) …" — renders
   that list as a table (e.g. the Joker's Wild Card d8 table). Any feature without the pattern
   renders as plain text, exactly as before. */
/* A description as prose with its tokens expanded. Multi-part features use the structured
   `options` field and render through optionTable() instead — see the author-trick skill. */
function renderFeatureDesc(desc, ladder) {
  return `<br>${fmtDesc(desc || "", ladder)}`;
}

/* Escape description text, expanding any [[XdY]] Scaling Die token (MECHANICS.md §3) into
   its base die plus a marker whose tooltip lists the level progression.

   There are TWO ladders (MECHANICS §3). Everything steps at 5 · 11 · 17, EXCEPT a half-caster's
   Turns, which step at 5 · 11 and then stop — so they end one die size behind a full caster's.
   Which ladder applies is a property of the CLASS (its caster grade), not of the trick, exactly
   like the casting start level in §4.9b; only the trick's own tier is read off the trick. */
const DIE_CHAIN = [4, 6, 8, 10, 12];
const LADDERS = {
  // `levels` includes the level-1 base, so every value shown is labelled with the level it applies
  // from. Listing four dice under "steps up at 5 · 11 · 17" read as four steps for three levels.
  full:     { levels: [1, 5, 11, 17], note: "" },
  halfTurn: { levels: [1, 5, 11],     note: "half-caster Turn: it stops here, one size short" },
  mixed:    { levels: [1, 5, 11, 17], note: "a half-caster stops at level 11" },
};

/* A half-caster's Turns use the short ladder; its Pledges and Prestiges do not, and no full
   caster ever does. `mixed` is a safety net, not a supported state: a damaging Turn shared across
   the two grades is banned by MECHANICS §3.1a and validate.py fails the gate on one, so this path
   should be unreachable — it exists so a bad file degrades into an honest caveat rather than
   silently showing one grade the other's numbers. */
function trickLadder(t) {
  if (!t || t.tier !== "turn") return "full";
  const grades = new Set((t.classes || []).map((c) => (CASTER_GRADE[c] || {}).grade));
  if (!grades.size || grades.has(undefined)) return "full";
  if (grades.size > 1) return "mixed";
  return grades.has("Half-caster") ? "halfTurn" : "full";
}

function fmtDesc(s, ladder) {
  if (s == null) return "";
  const str = String(s);
  // Two inline tokens: [[XdY]] or [[XdY+Abil]] scaling die (Abil = Str/Dex/Con/Int/Wis/Cha,
  // folds "+ your <Ability> modifier" into the die's tooltip), and {{Label|formula}} a hover/tap
  // tooltip (use it for any derived number — a save DC, an attack roll, a uses-count — instead
  // of spelling the math inline; on a real character sheet the token becomes the computed value).
  const re = /\[\[\s*(\d+)d(\d+)\s*(?:\+\s*([A-Za-z]{3}))?\s*\]\]|\{\{\s*([^|{}]+?)\s*\|\s*([^{}]+?)\s*\}\}/g;
  let out = "", last = 0, m;
  while ((m = re.exec(str)) !== null) {
    out += esc(str.slice(last, m.index));
    if (m[1]) out += scalingDieHTML(parseInt(m[1], 10), parseInt(m[2], 10), m[3], ladder);
    else out += tipTermHTML(m[4], m[5]);
    last = re.lastIndex;
  }
  return out + esc(str.slice(last));
}

// Full names for the [[XdY+Abil]] damage token's ability abbreviation.
const ABILITY_NAMES = {
  str: "Strength", dex: "Dexterity", con: "Constitution",
  int: "Intelligence", wis: "Wisdom", cha: "Charisma",
};

// A hover/tap tooltip term for an inline derived number (e.g. a save DC): shows the label + ⓘ,
// reveals the formula on hover/tap. Mirrors the keyStats formula tooltip so descriptions stay clean.
//
// On a CHARACTER SHEET we know the character, so the TOOLTIP can carry the actual number instead of
// the abstract formula. The label never changes: "trick save DC" is what the sentence is about, and
// swapping it for a bare 14 costs the reader the name of the thing they are looking at.
// creator.js installs a resolver while it renders and clears it afterwards; the compendium leaves it
// null and the tooltip shows the formula, because there is no character to compute against. A
// resolver that does not recognise a formula returns null and the token renders exactly as before.
let TOKEN_RESOLVER = null;
function tipTermHTML(label, formula) {
  const hit = TOKEN_RESOLVER ? TOKEN_RESOLVER(label, formula) : null;
  return plainTermHTML(label, hit ? hit.explain : formula, hit ? "resolved" : "");
}

/* The same term markup with NO resolution — for a tooltip the interface wrote itself rather than one
   that came out of a content file. The resolver matches on formula TEXT, so a hand-written
   explanation that happens to mention "at levels 1-4" was being swapped for the scaling-uses ladder:
   the Proficiency box explained itself as a uses counter. Only authored {{Label|formula}} tokens
   should ever be resolved. */
function plainTermHTML(label, tip, cls) {
  return `<span class="tip-term${cls ? " " + cls : ""}" tabindex="0" title="${esc(tip)}">${esc(label)}<sup class="tip-mark">&#9432;</sup>` +
    `<span class="term-tip" role="tooltip">${esc(tip)}</span></span>`;
}

/* Weapon Mastery (data/rules/weapon-mastery.json): the default maneuver any proficient wielder
   gets from a weapon. Short effect text here drives the hover tooltip + weapon page. */
const MASTERIES = {
  Cleave: "On a melee hit, make one attack against a second creature within 5 ft (no ability modifier to that damage). Once per turn.",
  Graze:  "On a miss, still deal damage equal to the ability modifier you attacked with.",
  Nick:   "When holding a Light weapon in each hand (two-weapon fighting), make the off-hand attack as part of your Attack action instead of using your bonus action (once per turn).",
  Push:   "On a hit, push a Large-or-smaller target up to 10 ft straight away from you.",
  Sap:    "On a hit, the target has disadvantage on its next attack roll before your next turn.",
  Slow:   "On a hit that deals damage, reduce the target's speed by 10 ft until the start of your next turn.",
  Topple: "On a hit, the target makes a Constitution save (DC 8 + proficiency bonus + your attacking ability modifier) or is knocked prone.",
  Vex:    "On a hit that deals damage, you have advantage on your next attack against that same target.",
};
function masteryHTML(name) {
  if (!name) return `<span class="muted">—</span>`;
  const def = MASTERIES[name];
  if (!def) return esc(name);
  return `<span class="tip-term">${esc(name)}<span class="term-tip">${esc(def)}</span></span>`;
}

/* Armor traits (data/rules/armor-traits.json). One always-on property per piece — the armour
   equivalent of a weapon's mastery, and the reason two items at the same AC are a real choice.
   The highest-AC piece in each category deliberately has none. */
const ARMOR_TRAITS = {
  "Warded": "Advantage on concentration checks — the flat d20 you roll to keep a trick running when you take damage. The reason a caster wears robes rather than nothing.",
  "Deep Pockets": "A creature spending its action to snatch one of your Props makes that Sleight of Hand check with disadvantage. Hidden pockets, false linings, sleeves that go further than they should.",
  "Supple": "Advantage on every check and save you make to escape a grapple, a restraint, or being tied up. Nothing in the cut of it binds when you twist.",
  "Cushioned": "Halve the bludgeoning damage you take from falling, from colliding with something, and from being thrown — including by a friendly Sandow.",
  "Showpiece": "Advantage on Charisma (Performance) checks: entertaining or holding a crowd with music, dance, acting, storytelling or acrobatics. This is the costume you wear to win the room.",
  "Unbound": "Nothing about it traps your arms. You can perform a Flourish — the hand component a trick needs — even while grappled, or with only one hand free.",
  "Costumed": "Advantage on Charisma (Deception) checks made to pass as somebody else, or to be taken for part of a crowd or troupe you do not belong to.",
  "Anchored": "Advantage on saving throws against being knocked prone and against being moved against your will. Roughly half the roster throws one of those two effects.",
  "Ironclad": "Reduce each instance of slashing, piercing or bludgeoning damage you take by 2. Small per hit, and it adds up over a long fight — which is exactly what heavy armour is for.",
};
function armorTraitHTML(name) {
  if (!name) return `<span class="muted">none — this is the highest AC in its category and tier</span>`;
  const def = ARMOR_TRAITS[name];
  return def ? `<span class="tip-term" tabindex="0">${esc(name)}<span class="term-tip" role="tooltip">${esc(def)}</span></span>` : esc(name);
}

/* Weapon property glossary (data/rules/weapon-properties.json). Drives the hover tooltip so
   "Light", "Finesse", etc. explain themselves in the Attacks / weapon tables. */
const PROPERTIES = {
  finesse: "Use Strength or Dexterity (your choice) for attack and damage rolls with it. A class feature may further change which ability you use (e.g. the Joker uses Charisma).",
  light: "Small and easy to handle. Holding a Light weapon in each hand lets you use a bonus action to make one extra attack with the second (two-weapon fighting).",
  heavy: "Large and unwieldy; Small creatures have disadvantage on attack rolls with it.",
  reach: "Adds 5 ft to your reach when you attack with it, and for opportunity attacks.",
  thrown: "You can throw it for a ranged attack, using the same ability modifier as a melee attack with it.",
  "two-handed": "You need both hands to attack with it.",
  versatile: "Usable one- or two-handed; two-handed it deals the larger 'versatile' damage die shown.",
  ammunition: "Needs ammunition to make a ranged attack; you draw a piece as part of the attack.",
  loading: "You can fire only one piece of ammunition when you attack with it, no matter how many attacks you could make.",
  special: "Has unusual rules described in the weapon's own text.",
};
function propsHTML(list) {
  if (!Array.isArray(list) || !list.length) return `<span class="muted">—</span>`;
  return list.map((p) => {
    const def = PROPERTIES[String(p).toLowerCase()];
    return def ? `<span class="tip-term">${esc(p)}<span class="term-tip">${esc(def)}</span></span>` : esc(p);
  }).join(", ");
}

function scalingDieHTML(count, size, abil, ladder) {
  const rung = LADDERS[ladder] || LADDERS.full;
  const levels = rung.levels;
  const i = DIE_CHAIN.indexOf(size);
  const base = `${count}d${size}`;
  // Optional "+ ability modifier" folded into the tooltip (kept out of the visible prose).
  const ab = abil && ABILITY_NAMES[String(abil).toLowerCase()];
  const modLine = ab ? ` + your ${ab} modifier` : "";
  if (i < 0) return esc(base + (ab ? ` + ${ab} mod` : "")); // non-standard die: no scaling tooltip
  // Past the top of the chain a step can't grow the die, so it adds another d12 instead
  // (MECHANICS §3.1b) — a step is never worth nothing, least of all the level-17 one.
  const seq = levels.map((lv, k) => {
    const idx = i + k;
    const die = idx < DIE_CHAIN.length
      ? count + "d" + DIE_CHAIN[idx]
      : (count + idx - DIE_CHAIN.length + 1) + "d12";
    return { lv, die };
  });
  const plain = seq.map((r) => `L${r.lv} ${r.die}`).join(" · ");
  const title = `Scales: ${plain}${rung.note ? ` (${rung.note})` : ""}${modLine}`;
  return `<span class="scaling-die" tabindex="0" title="${esc(title)}">${esc(base)}<sup class="scale-mark">▲</sup>` +
    `<span class="scale-tip" role="tooltip">
       <span class="scale-tip-title">Scaling die</span>
       <span class="scale-tip-row">${seq.map((r) =>
         `<span class="scale-step"><span class="scale-lv">L${esc(r.lv)}</span>${esc(r.die)}</span>`).join("")}</span>
       ${rung.note ? `<span class="scale-tip-lv">${esc(rung.note)}</span>` : ""}
       ${ab ? `<span class="scale-tip-lv">+ your ${esc(ab)} modifier</span>` : ""}
     </span></span>`;
}

function renderClass(c) {
  return head(c.name, c.flavor) +
    `<div class="detail-grid">
      ${stat("HP", (c.hitDie || "?") + " at level 1")}
      ${stat("Size", Array.isArray(c.sizes) ? c.sizes.join(" or ") : "Small or Medium")}
      ${stat("Primary Ability", c.primaryAbility || "—")}
      ${stat("Saving Throws", (c.savingThrows || []).join(", ") || "—")}
      ${stat("Subclass At", c.subclassLevel ? "Level " + c.subclassLevel : "—")}
    </div>
    ${keyStatsSection(c.keyStats)}
    <div class="detail-body">
      ${c.proficiencies ? `<h2>Proficiencies</h2><p>${esc(profText(c.proficiencies))}</p>` : ""}
      ${skillChoiceSection(c)}
      ${attacksSection(c)}
      ${parrySection(c)}
      ${engineSection(c.engine)}
      ${features(c.features)}
    </div>`;
}

/* The class's headline mechanic numbers (save/effect DC, resource cap, base Parry DC…) shown
   in a prominent stat block up top, like a Monk's Ki save DC. Data-driven via keyStats so every
   class — current and future — surfaces its own mechanic without touching the renderer. */
function keyStatsSection(list) {
  if (!Array.isArray(list) || !list.length) return "";
  return `<h2 class="key-stats-title">Key Numbers</h2>
    <div class="key-stats">` + list.map((s) => {
      // A `formula` turns the value into a hover term: the at-a-glance progression stays
      // visible, the exact calculation lives in the tooltip (like the [[XdY]] scaling die).
      const val = s.formula
        ? `<span class="tip-term" title="${esc(s.formula)}">${esc(s.value || "")}<sup class="tip-mark">&#9432;</sup><span class="term-tip">${esc(s.formula)}</span></span>`
        : esc(s.value || "");
      return `<div class="key-stat">
         <div class="label">${esc(s.label || "")}</div>
         <div class="value">${val}</div>
         ${s.note ? `<div class="note">${esc(s.note)}</div>` : ""}
       </div>`;
    }).join("") + `</div>`;
}

/* A class's weapon attacks, with damage pulled from the loaded weapons data so the
   class page connects "proficient weapons" to the actual attack + damage. */
function attacksSection(c) {
  const names = c.proficiencies && Array.isArray(c.proficiencies.weapons) ? c.proficiencies.weapons : [];
  if (!names.length) return "";
  const rows = names.map((n) => {
    const w = idx.weaponsByName.get(n);
    if (!w || !w.damage) return `<tr><td><strong>${esc(n)}</strong></td><td class="muted" colspan="4">—</td></tr>`;
    const hasVers = Array.isArray(w.properties) && w.properties.includes("versatile");
    const dmg = esc(w.damage.die) +
      (hasVers && w.versatileDamage ? ` <span class="muted">(${esc(w.versatileDamage)} two-handed)</span>` : "");
    const type = esc(w.damage.type || "—");
    const props = propsHTML(w.properties);
    const rng = w.range ? ` <span class="muted">${esc((w.range.normal ?? "?") + "/" + (w.range.long ?? "?") + " ft")}</span>` : "";
    return `<tr><td><strong>${esc(w.name)}</strong>${rng}</td><td>${dmg}</td><td>${type}</td><td>${props}</td><td>${masteryHTML(w.mastery)}</td></tr>`;
  }).join("");
  return `<h2>Attacks</h2>
    <p class="muted">Weapons this class is proficient with, and what each hits for. To attack, take the Attack action: roll d20 + ability modifier + proficiency bonus vs the target's AC. On a hit, damage = the die below <strong>+ your ability modifier</strong>. Any feature that says “weapon attack” or deals “weapon damage” (an extra attack, an area strike, a rider) uses one of these weapons and this damage — class features then add their own bonuses on top. <strong>Mastery</strong> is the default maneuver any proficient wielder gets from that weapon (hover it); see the Rules tab (Weapon Mastery).</p>
    <table class="data-table attack-table">
      <thead><tr><th>Weapon</th><th>Damage</th><th>Type</th><th>Properties</th><th>Mastery</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

/* Skill proficiencies as a table: one row per option, sorted by (and showing) the
   ability it scales with, so the plain "Choose two from …" sentence becomes scannable. */
function skillChoiceSection(c) {
  const raw = c.proficiencies && c.proficiencies.skills;
  const parsed = parseSkillChoice(raw);
  if (!parsed || !parsed.skills.length) {
    return raw ? `<h2>Skill Proficiencies</h2><p>${esc(typeof raw === "string" ? raw : "")}</p>` : "";
  }
  const rows = parsed.skills.map((name) => {
    const s = idx.skillsByName.get(String(name).toLowerCase());
    return { name, ability: s ? s.ability : "—" };
  });
  rows.sort((a, b) =>
    (ABILITY_ORDER.indexOf(a.ability) - ABILITY_ORDER.indexOf(b.ability)) || a.name.localeCompare(b.name));
  const body = rows.map((r) =>
    `<tr><td>${esc(r.name)}</td><td class="col-ability">${esc(r.ability)}</td></tr>`).join("");
  const caption = parsed.count
    ? `Choose <strong>${esc(parsed.count)}</strong> of the following:`
    : "Available skills:";
  return `<h2>Skill Proficiencies</h2>
    <p class="muted">${caption}</p>
    <table class="data-table">
      <thead><tr><th>Skill</th><th>Scales with</th></tr></thead>
      <tbody>${body}</tbody>
    </table>`;
}

/* Parse "Choose two from A, B, and C" -> { count: 2, skills: [A, B, C] }.
   Accepts a plain array too. Falls back to { count: null, skills: [] } if unparseable. */
function parseSkillChoice(raw) {
  if (Array.isArray(raw)) return { count: null, skills: raw };
  if (typeof raw !== "string" || !raw.trim()) return null;
  const m = /choose\s+(\w+)\s+from\s+(.+)/i.exec(raw);
  if (!m) return { count: null, skills: [] };
  const words = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6 };
  const count = words[m[1].toLowerCase()] || parseInt(m[1], 10) || null;
  const skills = m[2].replace(/\.\s*$/, "")
    .split(/\s*,\s*(?:and\s+)?|\s+and\s+/i)
    .map((s) => s.trim())
    .filter(Boolean);
  return { count, skills };
}

/* Circus-system fields (all optional; only render when present — see
   data/schema/class.schema.json and data/schema/MECHANICS.md). */

function parrySection(c) {
  if (c.parryBaseDC == null && !c.defenseAbility && !c.parryReskin && !c.riposte) return "";
  return `<h2>Parry</h2>
    <div class="parry-block">
      ${c.parryBaseDC != null ? `<span class="badge badge-dc">Parry Base DC ${esc(c.parryBaseDC)}</span>` : ""}
      ${c.defenseAbility ? `<p class="muted">Defense Ability: <strong>${esc(c.defenseAbility)}</strong></p>` : ""}
      ${parryFormula(c)}
      ${c.parryReskin ? `<p class="parry-reskin">${fmtDesc(c.parryReskin)}</p>` : ""}
      ${c.riposte ? `<p><strong>Riposte</strong> <span class="muted">(on Full Dodge)</span>: ${fmtDesc(c.riposte)}</p>` : ""}
      <p class="muted">Roll a d20 vs your effective DC: <strong>above</strong> = no damage, <strong>equal</strong> = half, <strong>below</strong> = +50%. See the Rules tab (Parry &amp; Dodging) for the full rule.</p>
    </div>`;
}

/* Spells out that the Parry DC on the sheet is a BASE, and the value you actually roll against
   is modified (proficiency, your defense stat, weapon, situation). See MECHANICS.md §1.5. */
function parryFormula(c) {
  if (c.parryBaseDC == null) return "";
  return `<p class="parry-formula">This Parry DC is <strong>fixed</strong> — it does not scale with your level,
    ability scores, or weapon. The value you roll against is
    <span class="formula">base ${esc(c.parryBaseDC)} &plusmn; situational modifiers</span>,
    never below 3. <strong>Lower is better.</strong></p>`;
}

function engineSection(e) {
  if (!e || typeof e !== "object" || Array.isArray(e)) return "";
  return `<h2>Engine${e.name ? " — " + esc(e.name) : ""}</h2>
    <div class="engine-block">
      ${e.resourceType ? `<span class="badge badge-engine">${esc(cap(e.resourceType))}</span>` : ""}
      ${e.description ? `<p>${fmtDesc(e.description)}</p>` : ""}
      <div class="detail-grid">
        ${e.generation ? stat("Generation", e.generation) : ""}
        ${e.spend ? stat("Spend", e.spend) : ""}
        ${e.cap != null
          ? (e.capFormula
              ? statHTML("Cap", `<span class="tip-term" title="${esc(e.capFormula)}">${esc(e.cap)}<sup class="tip-mark">&#9432;</sup><span class="term-tip">${esc(e.capFormula)}</span></span>`)
              : stat("Cap", e.cap))
          : ""}
      </div>
    </div>`;
}

function renderSubclass(s) {
  return head(s.name, (s.parentClass ? s.parentClass + " subclass" : "")) +
    `<div class="detail-body">${s.flavor ? `<p>${esc(s.flavor)}</p>` : ""}` +
    grantedTricksSection(s) + `${features(s.features)}</div>`;
}

/* Tricks this subclass grants (MECHANICS §4.9d), read straight off the trick files so the list
   has ONE source of truth — it used to be retyped into a feature's prose, which is both a blob
   and a thing that can drift. */
function grantedTricksSection(s) {
  const sid = s.id || s.name;
  const mine = (store.tricks || []).filter((t) => (t.subclasses || []).includes(sid));
  if (!mine.length) return "";
  const lv = subclassLevelOf(s.parentClass);
  const rows = mine
    .sort((a, b) => (a.minLevel || 1) - (b.minLevel || 1) || a.name.localeCompare(b.name))
    .map((t) => `<tr><td>${esc(cap(t.tier || ""))}</td><td><a href="#/tricks/${encodeURIComponent(slug(t))}">${esc(t.name)}</a></td>
      <td>${fmtDesc(t.sheetSummary || "", trickLadder(t))}</td></tr>`).join("");
  return `<h2>Discipline Tricks</h2>
    <p class="muted">Taking this discipline adds these to your trick list, free and permanent, at level ${esc(lv)}. No other member of your class learns them.</p>
    <table class="data-table"><thead><tr><th>Tier</th><th>Trick</th><th>What it does</th></tr></thead><tbody>${rows}</tbody></table>`;
}

/* What each Trick tier means, shown as a hover/tap tooltip on the tier badge so a reader never
   has to leave the trick to remember how the casting system works (MECHANICS.md §4). */
const TIERS = {
  pledge: "At-will. No cost and no cooldown — the basic trick a performer can always do.",
  turn: "The workhorse. Once cast, the crowd has Seen it: you can't cast it again for its cooldown in rounds. Most Turns are free; a full caster also has a few that spend engine on top of the cooldown.",
  prestige: "The showstopper. Spends most of your class engine and works only once per combat, so you must build the meter with Turns first — OP but occasional by design.",
};

/* The Patter/Flourish/Prop reskin of V/S/M. The mechanical hooks are unchanged, so the
   tooltip states what denies each one. */
const COMPONENTS = {
  Patter: "The performer's voice. Denied while gagged, silenced, or unable to speak — a creature grappling you can spend its action to gag you (contested Athletics vs your Athletics or Acrobatics).",
  Flourish: "The hands. Denied only when you have no free hand — bound, restrained, or both hands full. Being grappled does not by itself stop you: a grapple holds you in place, not your wrists.",
  Prop: "A physical object. A creature within 5 ft can spend its action to snatch one (Sleight of Hand vs your passive Perception). You cannot cast a trick whose prop is gone — but you replace it from your kit at the end of the fight.",
};

/* Components render as hover-terms so "Flourish" explains itself; a Prop's parenthetical
   (e.g. "Prop (a deck of cards)") is kept visible outside the term. */
function componentsHTML(list) {
  if (!Array.isArray(list) || !list.length) return "—";
  return list.map((c) => {
    const kind = String(c).split(" (")[0];
    const rest = String(c).slice(kind.length);
    return COMPONENTS[kind] ? tipTermHTML(kind, COMPONENTS[kind]) + esc(rest) : esc(c);
  }).join(", ");
}

/* A trick's limiter is the one number that balances it: a Turn's cooldown or a Prestige's
   engine cost. Pledges have neither by design. */
/* A trick's limiters. A Turn always has a cooldown and MAY also carry an engine price
   (MECHANICS §4.4a) — both must show, or a costed Turn reads as free. */
function limiterHTML(t) {
  const out = [];
  if (t.cooldown) {
    out.push(statHTML("Cooldown", tipTermHTML(`${t.cooldown} round${t.cooldown > 1 ? "s" : ""}`,
      `After casting, this trick is Seen: you can't cast it again for ${t.cooldown} of your turns. Reduce the counter by 1 at the start of each of your turns. Out of combat, it's ready again after about a minute.`)));
  }
  if (t.engineCost) {
    out.push(statHTML("Engine Cost", tipTermHTML(`${t.engineCost}`,
      t.tier === "prestige"
        ? `Spends ${t.engineCost} of your class engine (Phantasm, Mirth, Strings, Clones, or Mayhem). Build the meter with Turns before you can pay for this.`
        : `A costed Turn: spends ${t.engineCost} of your class engine on casting, on top of its cooldown. This is what you bank the meter for before a Prestige is available. Full casters only — the engine is spent whether or not the trick lands.`)));
  }
  if (t.concentration) {
    out.push(statHTML("Concentration", tipTermHTML("Required",
      "You must concentrate to keep this going. You hold one concentration trick at a time unless a feature says otherwise, and whenever you take damage you roll a flat d20 against DC 10, or half the damage taken if that is higher — on a failure the trick ends. See the Tricks and Casting rules page.")));
  }
  return out.length ? out.join("") : stat("Limiter", "At-will");
}

/* Every Prestige is once per combat — a tier-wide rule (MECHANICS §4.5), not a per-trick field,
   so it renders from the tier and a newly authored Prestige inherits it with nothing to set. */
function prestigeUsesHTML(t) {
  if (t.tier !== "prestige") return "";
  return statHTML("Uses", tipTermHTML("1 per combat",
    "Every Prestige is limited to one use per combat, on top of its engine cost. It resets when the fight ends. This is what allows the tier to be as strong as it is."));
}

function renderTrick(t) {
  const tier = t.tier || "";
  const ladder = trickLadder(t);
  const badge = TIERS[tier]
    ? `<span class="tier-badge tier-${esc(tier)}">${tipTermHTML(cap(tier), TIERS[tier])}</span>`
    : "";
  const play = `<div class="detail-body">
      ${t.flavor ? `<p class="detail-flavor">${esc(t.flavor)}</p>` : ""}
      ${narrationHTML(t.narration)}
    </div>`;
  const rules =
    `<div class="detail-grid">
      ${stat("Casting Time", t.castingTime || "—")}
      ${stat("Range", t.range || "—")}
      ${statHTML("Components", componentsHTML(t.components))}
      ${stat("Duration", t.duration || "—")}
      ${limiterHTML(t)}
      ${prestigeUsesHTML(t)}
      ${t.save ? stat("Save", t.save + " saving throw") : ""}
      ${statHTML("Unlocks At", (() => {
        const own = t.minLevel || 1;
        if (Array.isArray(t.subclasses) && t.subclasses.length) {
          const sid = t.subclasses[0];
          const parent = idx.subclasses.get(sid);
          const lv = Math.max(own, subclassLevelOf(parent && parent.parentClass));
          return tipTermHTML("Level " + lv,
            `You gain this with the ${subclassName(sid)} discipline, which you choose at level ${subclassLevelOf(parent && parent.parentClass)}, so it cannot unlock before then whatever its own gate says. Its own power gate is level ${own}; the later of the two applies.`);
        }
        return tipTermHTML("Level " + own,
          "This is the trick's own level gate. A half-caster (Puppeteer, Doppelganger, Joker) casts nothing before level 2, so for them the later of the two applies — see the Class view for your class's actual level.");
      })())}
    </div>
    <div class="detail-body">
      ${renderFeatureDesc(t.sheetSummary || t.description || "", ladder)}
      ${Array.isArray(t.options) && t.options.length ? optionTable(t.options, ladder) : ""}
      ${Array.isArray(t.subclasses) && t.subclasses.length
        ? `<p class="muted">Granted by: ${esc(t.subclasses.map(subclassName).join(", "))} — only that subclass learns this trick.</p>`
        : (Array.isArray(t.classes) && t.classes.length
          ? `<p class="muted">Classes: ${esc(t.classes.map(className).join(", "))}</p>` : "")}
    </div>`;
  return head(t.name, `${t.discipline || ""} trick`) +
    (badge ? `<div class="tier-row">${badge}</div>` : "") +
    tabbed(rules, play);
}

function renderSkill(s) {
  return head(s.name, s.ability ? s.ability + " skill" : "") +
    tabbed(`<div class="detail-body"><p>${fmtDesc(s.description || "")}</p></div>`,
           `<div class="detail-body">${narrationHTML(s.narration)}</div>`);
}

function renderPassive(p) {
  return head(p.name, p.type || "Feature") +
    `<div class="detail-body">
      ${p.prerequisite ? `<p class="muted">Prerequisite: ${esc(p.prerequisite)}</p>` : ""}
      <p>${fmtDesc(p.description || "")}</p>
    </div>`;
}

function renderWeapon(w) {
  const dmg = w.damage ? `${w.damage.die || "?"} ${w.damage.type || ""}`.trim() : "—";
  const hasVersatile = Array.isArray(w.properties) && w.properties.includes("versatile");
  return head(w.name, w.flavor) +
    `<div class="detail-grid">
      ${stat("Damage", dmg)}
      ${stat("Category", w.category ? cap(w.category) : "—")}
      ${statHTML("Properties", propsHTML(w.properties))}
      ${w.range ? stat("Range", `${w.range.normal ?? "?"}/${w.range.long ?? "?"} ft`) : ""}
      ${hasVersatile && w.versatileDamage ? stat("Versatile", w.versatileDamage) : ""}
      ${w.mastery ? stat("Mastery", w.mastery) : ""}
    </div>
    <div class="detail-body">
      ${w.mastery ? `<h2>Weapon Mastery — ${esc(w.mastery)}</h2><p>${esc(MASTERIES[w.mastery] || "")}</p><p class="muted">Any character proficient with this weapon can use its Mastery on their weapon attacks — no class feature needed. See the Rules tab (Weapon Mastery).</p>` : ""}
      ${parryProfileSection(w.parryProfile)}
      ${proficientClassesSection(w.proficientClasses)}
    </div>`;
}

function parryProfileSection(pp) {
  if (!pp || typeof pp !== "object" || Array.isArray(pp)) return "";
  const can = pp.canParry === true;
  return `<h2>Parry Profile</h2>
    <div class="parry-block">
      <span class="badge ${can ? "badge-dc" : "badge-engine"}">Can Parry: ${can ? "Yes" : "No"}</span>
      ${can && pp.parryRange ? `<p class="muted">Parry Range: <strong>${esc(cap(pp.parryRange))}</strong></p>` : ""}
      ${pp.note ? `<p class="parry-reskin">${esc(pp.note)}</p>` : ""}
      <p class="muted">A weapon no longer changes the Parry DC — it only determines whether you can parry, and against what.</p>
    </div>`;
}

function proficientClassesSection(list) {
  const txt = Array.isArray(list) && list.length ? list.join(", ") : "—";
  return `<h2>Proficient Classes</h2>
    <p>${esc(txt)}</p>
    <p class="muted">Informational only — anyone may wield this weapon; proficiency just governs the proficiency bonus (to attacks and to parrying).</p>`;
}

function armorAC(a) {
  if (a.category === "shield") return `+${a.acBonus ?? 0} AC`;
  const base = a.baseAC ?? "?";
  if (a.maxDexBonus == null) return `${base} + Dex`;
  if (a.maxDexBonus === 0) return `${base}`;
  return `${base} + Dex (max ${a.maxDexBonus})`;
}

function renderArmor(a) {
  return head(a.name, a.flavor) +
    `<div class="detail-grid">
      ${stat("Armor Class", armorAC(a))}
      ${stat("Category", a.category ? cap(a.category) : "—")}
      ${stat("Availability", a.availability === "bought" ? "Bought" : "Starter")}
      ${a.strengthRequirement != null ? stat("Strength Req.", "Str " + a.strengthRequirement) : ""}
      ${statHTML("Trait", armorTraitHTML(a.trait))}
      ${stat("Stealth", a.stealthDisadvantage ? "Disadvantage" : "Normal")}
    </div>
    <div class="detail-body">
      <p class="muted">Armor grants AC only — an attack must beat your AC to hit, and only a hit can then be Parried. ${a.category === "clothing"
        ? "Clothing needs <strong>no proficiency</strong> — anyone can wear it, including casters with no armor training. It is the unarmored baseline (10 + full Dex) in wearable form."
        : "Proficiency with an armor's category (Light / Medium / Heavy) comes from your class; wearing armor you aren't proficient with gives disadvantage on Strength- and Dexterity-based checks, attacks, and saves."}</p>
      ${a.trait
        ? `<h2>Armor Trait — ${esc(a.trait)}</h2><p>${esc(ARMOR_TRAITS[a.trait] || "")}</p><p class="muted">Every armour carries one always-on trait, the way every weapon carries a mastery. See the Rules tab (Armor Traits).</p>`
        : `<h2>No Armor Trait</h2><p>This is the highest Armor Class in its category and tier, and it pays for that by carrying no trait at all. See the Rules tab (Armor Traits).</p>`}
      <p class="muted">${a.availability === "bought"
        ? "<strong>Bought</strong> — a premium upgrade acquired by purchase or loot during play, not owned at character creation."
        : "<strong>Starter</strong> — basic gear available at character creation."} Pricing is left to the DM / campaign.</p>
    </div>`;
}

function renderRule(r) {
  const sections = Array.isArray(r.sections) ? r.sections.map((s) => {
    const h = s.heading ? `<h2>${esc(s.heading)}</h2>` : "";
    const paras = Array.isArray(s.paragraphs) ? s.paragraphs.map((p) => `<p>${esc(p)}</p>`).join("") : "";
    const list = Array.isArray(s.list) && s.list.length
      ? `<ul>${s.list.map((li) => `<li>${esc(li)}</li>`).join("")}</ul>` : "";
    return h + paras + list;
  }).join("") : "";
  return head(r.name, r.summary) + `<div class="detail-body">${sections}</div>`;
}

/* ---------- helpers ---------- */

function profText(p) {
  // Skills are rendered separately as a table (skillChoiceSection).
  const parts = [];
  for (const k of ["armor", "weapons", "tools"]) {
    if (p[k]) parts.push(`${cap(k)}: ${Array.isArray(p[k]) ? p[k].join(", ") : p[k]}`);
  }
  return parts.join(" · ");
}
function slug(it) {
  return (it.id || it.name || "").toString().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}
function esc(s) {
  return (s == null ? "" : String(s)).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }
function setStatus(msg) { $("#status").textContent = msg; }

boot();
