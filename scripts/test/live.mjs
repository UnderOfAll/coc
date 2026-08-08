// Transport test for CocLive — the live layer a table runs on. Nothing here draws anything: it
// proves that a write lands, that a watcher hears about it, that a flood of drag events collapses
// into few writes with the LAST position winning, and that the database's streaming events are
// applied to the local mirror correctly (a `patch` that overwrites a sibling is a token that jumps
// to the wrong square on someone else's screen). Run: npm run test:live
import { JSDOM, VirtualConsole } from "jsdom";
import fs from "fs";
import path from "path";
const REPO = path.resolve(new URL(".", import.meta.url).pathname, "../..");
const vc = new VirtualConsole();
const errs = []; vc.on("jsdomError", (e) => errs.push(String(e.detail || e.message)));
["error", "warn"].forEach((m) => vc.on(m, (...a) => errs.push("[" + m + "] " + a.join(" "))));
const dom = new JSDOM("<!doctype html><html><body></body></html>",
  { runScripts: "dangerously", virtualConsole: vc, url: "http://localhost/" });
const { window } = dom;

// A fake EventSource, so the streaming half can be tested without a network: the test holds the
// instance and hands it events exactly as the database would.
window.eval(`
  window.__sources = [];
  window.EventSource = class {
    constructor(url) { this.url = url; this.listeners = {}; this.closed = false; window.__sources.push(this); }
    addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); }
    close() { this.closed = true; }
    emit(type, data) { for (const fn of (this.listeners[type] || [])) fn({ data: JSON.stringify(data) }); }
  };
  window.__fetches = [];
  window.fetch = async (url, opts) => {
    window.__fetches.push({ url: String(url), method: (opts && opts.method) || "GET", body: opts && opts.body });
    return { ok: true, status: 200, json: async () => ({ name: "generated-key" }) };
  };
  window.COC_CONFIG = { firebaseUrl: "https://example-rtdb.firebasedatabase.app" };
`);
// config.js declares `const COC_CONFIG`, which would shadow the stub above, so live.js is given the
// stub instead: this test is about the transport, not about which project it points at.
// Injected as a <script>, not eval'd: a top-level `const` inside eval stays inside the eval.
const src = fs.readFileSync(path.join(REPO, "assets/js/live.js"), "utf8")
  .replace("const cfg = (typeof COC_CONFIG !== \"undefined\") ? COC_CONFIG : {};",
           "const cfg = window.COC_CONFIG;");
const tag = window.document.createElement("script");
tag.textContent = src;
window.document.body.appendChild(tag);

const peek = (e) => window.eval(e);
let fails = 0;
const ok = (c, m) => { if (!c) { fails++; console.log("  FAIL " + m); } else console.log("  ok   " + m); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

console.log("\n— LOCAL TREE —");
peek(`CocLive.setMode("local"); localStorage.clear();`);
ok(peek(`CocLive.mode`) === "local", "can be forced offline for a single browser");
await peek(`CocLive.put("tables/482910/meta", { name: "The Big Top", createdAt: 1 })`);
ok((await peek(`CocLive.get("tables/482910/meta")`)) != null, "a write is readable back");
ok((await peek(`CocLive.get("tables/482910/meta/name")`)) === "The Big Top", "a deep path reads a single field");
await peek(`CocLive.patch("tables/482910/meta", { name: "Renamed", activeScene: "s1" })`);
ok((await peek(`CocLive.get("tables/482910/meta/name")`)) === "Renamed", "patch overwrites the field it names");
ok((await peek(`CocLive.get("tables/482910/meta/createdAt")`)) === 1, "and leaves the ones it does not");
const key = await peek(`CocLive.push("tables/482910/log", { text: "rolled a d8" })`);
ok(typeof key === "string" && key.length > 4, "push mints a key (" + key + ")");
ok((await peek(`CocLive.get("tables/482910/log/${key}/text")`)) === "rolled a d8", "and stores under it");
const k2 = await peek(`CocLive.push("tables/482910/log", { text: "second" })`);
ok(k2 > key, "keys sort in the order they were made, so a log needs no index");
// Firebase deletes a key rather than storing null, and local mode has to agree or "gone" means two
// different things depending on the backend.
await peek(`CocLive.put("tables/482910/meta/activeScene", null)`);
ok((await peek(`CocLive.get("tables/482910/meta/activeScene")`)) === null, "writing null removes the key");
await peek(`CocLive.del("tables/482910/log/${key}")`);
ok((await peek(`CocLive.get("tables/482910/log/${key}")`)) === null, "delete removes a node");

console.log("\n— WATCHERS —");
peek(`window.__seen = []; window.__off = CocLive.watch("tables/482910/tokens", (v) => window.__seen.push(v));`);
await wait(20);
ok(peek(`window.__seen.length`) === 1, "a watcher hears the current value at once, not only changes");
// This is the multiplayer case: a write that did not come from this screen must reach it.
await peek(`CocLive.put("tables/482910/tokens/t1", { name: "Rig", x: 3, y: 4 })`);
await wait(20);
ok(peek(`window.__seen.length`) === 2, "and hears a write it did not make");
ok(peek(`window.__seen[1].t1.x`) === 3, "with the new value");
await peek(`CocLive.put("tables/482910/tokens/t1/x", 9)`);
await wait(20);
ok(peek(`window.__seen[window.__seen.length-1].t1.x`) === 9, "a change inside the watched path counts too");
ok(peek(`window.__seen[window.__seen.length-1].t1.name`) === "Rig", "and does not wipe its siblings");
peek(`window.__off();`);
await peek(`CocLive.put("tables/482910/tokens/t1/x", 11)`);
await wait(20);
ok(peek(`window.__seen[window.__seen.length-1].t1.x`) === 9, "unsubscribing stops it");

console.log("\n— DRAGGING DOES NOT FLOOD —");
// 40 pointer moves in a row is an ordinary drag. What must arrive is FEW writes ending at the last
// position — and the last position specifically, since an out-of-order write is a token that snaps
// back to where it was a moment ago.
// Counted through a watcher rather than by wrapping put: throttled() writes through the backend it
// closed over, so a wrapper on the public method would see nothing — as the first version of this
// test proved by reporting zero writes for a drag that plainly worked.
peek(`window.__beats = 0;
  window.__offBeat = CocLive.watch("tables/482910/tokens/t1", () => window.__beats++);`);
await wait(20);
peek(`window.__beats = 0;`);
peek(`for (let i = 1; i <= 40; i++) CocLive.throttled("tables/482910/tokens/t1", { name: "Rig", x: i, y: 0 }, 60);`);
await wait(250);
const writes = peek(`window.__beats`);
ok(writes > 0 && writes <= 4, "40 drag events became " + writes + " writes");
ok((await peek(`CocLive.get("tables/482910/tokens/t1/x")`)) === 40, "and the final position is the one stored");
peek(`window.__offBeat();`);

console.log("\n— STREAMING (the cloud half) —");
peek(`CocLive.setMode("firebase"); window.__streamed = [];
  window.__offStream = CocLive.watch("tables/482910", (v) => window.__streamed.push(v));`);
ok(peek(`window.__sources.length`) === 1, "watching opens one stream");
ok(/tables\/482910\.json$/.test(peek(`window.__sources[0].url`)), "at the right URL: " + peek(`window.__sources[0].url`));
// The database's first event is always the whole path…
peek(`window.__sources[0].emit("put", { path: "/", data: { tokens: { t1: { name: "Rig", x: 1, y: 1 } } } });`);
ok(peek(`window.__streamed[0].tokens.t1.name`) === "Rig", "the opening put seeds everything");
// …then a put at a sub-path replaces just that…
peek(`window.__sources[0].emit("put", { path: "/tokens/t1/x", data: 7 });`);
ok(peek(`window.__streamed[1].tokens.t1.x`) === 7, "a put at a sub-path lands there");
ok(peek(`window.__streamed[1].tokens.t1.name`) === "Rig", "without touching its siblings");
// …and a patch merges rather than replacing, which is the event that is easy to get wrong.
peek(`window.__sources[0].emit("patch", { path: "/tokens/t1", data: { y: 5 } });`);
ok(peek(`window.__streamed[2].tokens.t1.y`) === 5, "a patch merges its keys");
ok(peek(`window.__streamed[2].tokens.t1.x`) === 7, "and leaves everything it did not mention");
// A deletion arrives as a put of null.
peek(`window.__sources[0].emit("put", { path: "/tokens/t1", data: null });`);
ok(peek(`window.__streamed[3].tokens.t1`) === undefined, "a null put removes the node");
peek(`window.__offStream();`);
ok(peek(`window.__sources[0].closed`) === true, "unsubscribing closes the stream");

console.log("\n— REST VERBS —");
peek(`window.__fetches = [];`);
await peek(`CocLive.put("tables/482910/meta/name", "Cloud")`);
await peek(`CocLive.patch("tables/482910/meta", { activeScene: "s2" })`);
await peek(`CocLive.del("tables/482910/tokens/t9")`);
const calls = JSON.parse(peek(`JSON.stringify(window.__fetches)`));
ok(calls[0].method === "PUT" && calls[0].url.endsWith("tables/482910/meta/name.json"), "put -> PUT on the path");
ok(calls[0].body === '"Cloud"', "with the value as the body");
ok(calls[1].method === "PATCH", "patch -> PATCH");
ok(calls[2].method === "DELETE", "del -> DELETE");
const pushed = await peek(`CocLive.push("tables/482910/log", { text: "hi" })`);
ok(pushed === "generated-key", "push uses the key the database mints");

console.log("\njsdom errors: " + errs.length); errs.slice(0, 6).forEach((e) => console.log("  " + e));
console.log(fails || errs.length ? "\nFAILURES: " + fails : "\nALL GREEN");
process.exit(fails || errs.length ? 1 : 0);
