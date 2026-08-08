/*
 * Circus of Chaos — CocLive: the live layer.
 *
 * Characters are documents: you load one, you save one, and CocStore is enough. A TABLE is not a
 * document — it is a room several people are inside at once, and everyone has to see a token move
 * as it moves. That needs a push, not a poll, and this file is the whole of it.
 *
 * Two backends, same interface, chosen by what is in config.js:
 *
 *   firebase — the Realtime Database you already have, over plain REST. Writes are PUT/PATCH/POST/
 *              DELETE; reads that must stay current use the database's STREAMING endpoint: request a
 *              path with `Accept: text/event-stream` and it stays open, sending `put` and `patch`
 *              events as the data changes. EventSource does that natively, so there is no SDK, no
 *              build step, no npm, and the site stays a folder of static files on GitHub Pages.
 *
 *   local    — one browser, no network: the whole tree lives in localStorage and changes are
 *              announced on a BroadcastChannel, so two TABS of the same browser genuinely see each
 *              other. That is what makes this testable without a network, and it is also the honest
 *              fallback for someone who has not filled in config.js.
 *
 * Paths are slash-joined strings ("tables/482910/tokens/abc"), the same shape the database uses, so
 * nothing here has to know what a table is. This file knows about trees; table.js knows about games.
 */
const CocLive = (() => {
  const cfg = (typeof COC_CONFIG !== "undefined") ? COC_CONFIG : {};
  const LOCAL_KEY = "coc:live";
  const LOCAL_CHANNEL = "coc:live";

  let mode = cfg.firebaseUrl ? "firebase" : "local";
  const base = () => String(cfg.firebaseUrl || "").replace(/\/$/, "");
  const url = (path) => `${base()}/${path}.json`;

  /* ------------------------------------------------------------------ a tree, by path */

  /* Both backends need the same three operations on a plain object: read a path, write a path,
     merge into a path. Firebase does them on the server; local mode does them here. */
  function valueAt(tree, path) {
    let node = tree;
    for (const key of String(path).split("/").filter(Boolean)) {
      if (node == null || typeof node !== "object") return null;
      node = node[key];
    }
    return node === undefined ? null : node;
  }
  function setAt(tree, path, value) {
    const keys = String(path).split("/").filter(Boolean);
    if (!keys.length) return value == null ? {} : value;
    let node = tree;
    for (const key of keys.slice(0, -1)) {
      // Deleting must never CREATE the parents on its way down: removing a key from a node that is
      // already gone left `{ presence: {} }` behind where the database would have left nothing, so a
      // deleted table read back as an empty one.
      if (node[key] == null || typeof node[key] !== "object") {
        if (value == null) return tree;
        node[key] = {};
      }
      node = node[key];
    }
    const last = keys[keys.length - 1];
    // Firebase has no concept of an empty container: writing null DELETES the key, and a node whose
    // last child is removed stops existing TOO. Matching that here is not pedantry — it is the only way
    // local mode and cloud mode agree about what "gone" looks like. Erasing the last drawing left
    // `draw: {}` behind, which reads as "there is a drawings node" everywhere that checks.
    if (value == null) {
      delete node[last];
      for (let depth = keys.length - 1; depth > 0; depth--) {
        const parentPath = keys.slice(0, depth);
        let parent = tree;
        for (const key of parentPath.slice(0, -1)) parent = parent[key];
        const name = parentPath[parentPath.length - 1];
        if (parent[name] && typeof parent[name] === "object" && !Object.keys(parent[name]).length) {
          delete parent[name];
        } else break;
      }
    } else node[last] = value;
    return tree;
  }

  /* ------------------------------------------------------------------ local backend */

  const local = (() => {
    let channel = null;
    const watchers = new Set();     // { path, cb }

    function read() {
      try { return JSON.parse(localStorage.getItem(LOCAL_KEY) || "{}") || {}; }
      catch { return {}; }
    }
    function write(tree) {
      localStorage.setItem(LOCAL_KEY, JSON.stringify(tree));
    }
    /* Every watcher is told the current value of ITS path, whatever changed. The data in a table is
       kilobytes, so working out which watchers a change actually touches would cost more than
       re-reading, and getting that wrong is a token that silently stops moving on someone's screen. */
    function announce(local_only) {
      const tree = read();
      for (const w of watchers) {
        try { w.cb(valueAt(tree, w.path)); } catch { /* a broken watcher must not stop the others */ }
      }
      if (!local_only && channel) { try { channel.postMessage(Date.now()); } catch { /* closed */ } }
    }
    function connect() {
      if (channel || typeof BroadcastChannel === "undefined") return;
      channel = new BroadcastChannel(LOCAL_CHANNEL);
      channel.onmessage = () => announce(true);
    }
    // A storage event fires in the OTHER tabs of this browser, which covers the browsers (and the
    // test environments) that have no BroadcastChannel.
    if (typeof window !== "undefined" && window.addEventListener) {
      window.addEventListener("storage", (e) => { if (e.key === LOCAL_KEY) announce(true); });
    }

    return {
      async get(path) { return valueAt(read(), path); },
      async put(path, value) { connect(); write(setAt(read(), path, value)); announce(); return value; },
      async patch(path, obj) {
        connect();
        const tree = read();
        for (const [k, v] of Object.entries(obj)) setAt(tree, path + "/" + k, v);
        write(tree); announce();
        return obj;
      },
      async push(path, value) {
        connect();
        const key = pushId();
        write(setAt(read(), path + "/" + key, value));
        announce();
        return key;
      },
      async del(path) { connect(); write(setAt(read(), path, null)); announce(); return true; },
      watch(path, cb) {
        connect();
        const w = { path, cb };
        watchers.add(w);
        // Fire once immediately: a watcher that only hears about CHANGES shows an empty board to
        // whoever joins second.
        Promise.resolve().then(() => { try { cb(valueAt(read(), path)); } catch { /* ignore */ } });
        return () => watchers.delete(w);
      },
    };
  })();

  /* A key that sorts by creation time, like the database's own POST keys, so a log renders in order
     without carrying an index. Timestamp in base 36 plus randomness for the same-millisecond case. */
  let lastStamp = 0, seq = 0;
  function pushId() {
    const now = Date.now();
    if (now === lastStamp) seq += 1; else { lastStamp = now; seq = 0; }
    return now.toString(36) + "-" + seq.toString(36) + Math.random().toString(36).slice(2, 6);
  }

  /* ------------------------------------------------------------------ firebase backend */

  const firebase = (() => {
    async function send(path, method, body) {
      const opts = { method, headers: { "Content-Type": "application/json" } };
      if (body !== undefined) opts.body = JSON.stringify(body);
      const res = await fetch(url(path), opts);
      if (!res.ok) throw new Error(`live ${method.toLowerCase()} failed: ${res.status}`);
      return res.status === 204 ? null : res.json().catch(() => null);
    }
    return {
      async get(path) {
        const res = await fetch(url(path) + "?cb=" + Date.now());
        if (!res.ok) throw new Error("live read failed: " + res.status);
        return res.json();
      },
      put(path, value) { return send(path, "PUT", value); },
      patch(path, obj) { return send(path, "PATCH", obj); },
      async push(path, value) {
        const out = await send(path, "POST", value);
        return out && out.name ? out.name : pushId();
      },
      del(path) { return send(path, "DELETE"); },

      /* The streaming endpoint. The first event is always a `put` of the whole path, then each
         change arrives as a `put` (replace at a sub-path) or a `patch` (merge at a sub-path), with
         paths RELATIVE to the URL being watched. Keeping a local mirror and handing the whole node
         to the callback means callers never think about diffs — they render what they are given.

         A watchdog recreates the connection if nothing arrives for a while. The database sends a
         keep-alive about every 30 seconds, so silence for two minutes means the connection is dead
         even though the browser has not noticed: a phone that has been in a pocket, most often. */
      watch(path, cb) {
        let mirror = null, src = null, dead = false, timer = null, lastSeen = Date.now();
        const fire = () => { try { cb(mirror); } catch { /* a broken watcher must not kill the stream */ } };

        const open = () => {
          if (dead) return;
          try { src = new EventSource(url(path)); } catch { pollInstead(); return; }
          src.addEventListener("put", (e) => {
            lastSeen = Date.now();
            const msg = JSON.parse(e.data || "{}");
            if (msg.path === "/") mirror = msg.data;
            else mirror = setAt(mirror && typeof mirror === "object" ? mirror : {}, msg.path, msg.data);
            fire();
          });
          src.addEventListener("patch", (e) => {
            lastSeen = Date.now();
            const msg = JSON.parse(e.data || "{}");
            const at = msg.path === "/" ? "" : msg.path;
            mirror = mirror && typeof mirror === "object" ? mirror : {};
            for (const [k, v] of Object.entries(msg.data || {})) setAt(mirror, at + "/" + k, v);
            fire();
          });
          src.addEventListener("keep-alive", () => { lastSeen = Date.now(); });
          // `cancel` and `auth_revoked` are the database saying it will send nothing more — the
          // browser will not reconnect on its own, so the watchdog has to.
          src.addEventListener("cancel", () => { try { src.close(); } catch { /* already */ } src = null; });
          src.onerror = () => { /* EventSource retries by itself; the watchdog covers the rest */ };
          timer = setInterval(() => {
            if (dead) return;
            if (Date.now() - lastSeen < 120000 && src) return;
            try { if (src) src.close(); } catch { /* already */ }
            src = null; lastSeen = Date.now();
            open();
          }, 30000);
        };

        // No EventSource (old browser, or a test environment): fall back to polling. Slower and
        // chattier, but a table that updates every two seconds beats one that never updates.
        const pollInstead = () => {
          timer = setInterval(async () => {
            if (dead) return;
            try {
              const next = await firebase.get(path);
              if (JSON.stringify(next) !== JSON.stringify(mirror)) { mirror = next; fire(); }
            } catch { /* keep trying */ }
          }, 2000);
          firebase.get(path).then((v) => { mirror = v; fire(); }).catch(() => {});
        };

        if (typeof EventSource === "undefined") pollInstead(); else open();
        return () => {
          dead = true;
          if (timer) clearInterval(timer);
          try { if (src) src.close(); } catch { /* already closed */ }
        };
      },
    };
  })();

  let backend = mode === "firebase" ? firebase : local;

  /* ------------------------------------------------------------------ coalesced writes */

  /* Dragging a token across a map is hundreds of pointer events. Sending each one would flood the
     database and, worse, arrive out of order — a token that jitters back a square is this bug. So
     writes to the same path collapse: the first goes at once, and the last one wins after the
     window. Trailing edge is the part that matters, because the last position is the true one. */
  const pending = new Map();     // path -> { value, timer } while a write is being held back
  const lastSentAt = new Map();  // path -> when this path was last actually written
  function throttled(path, value, ms) {
    const wait = ms || 90;
    const now = Date.now();
    const entry = pending.get(path);
    if (entry) { entry.value = value; return; }
    const gap = now - (lastSentAt.get(path) || 0);
    if (gap >= wait) { lastSentAt.set(path, now); backend.put(path, value).catch(() => {}); return; }
    const e = { value };
    pending.set(path, e);
    e.timer = setTimeout(() => {
      pending.delete(path);
      lastSentAt.set(path, Date.now());
      backend.put(path, e.value).catch(() => {});
    }, wait - gap);
  }
  /* A held-back write must be DROPPED the moment the same path is written directly, or the sequence
     "drag, release, snap to the square" ends with the pre-snap position arriving 90ms late and
     putting the token back between two squares. The board test caught exactly that. */
  function cancelPending(path) {
    const e = pending.get(path);
    if (!e) return;
    clearTimeout(e.timer);
    pending.delete(path);
  }
  /* Anything half-sent must land before the page goes away, or you drop a token where it was not. */
  function flush() {
    for (const [path, e] of pending) {
      clearTimeout(e.timer);
      backend.put(path, e.value).catch(() => {});
    }
    pending.clear();
  }

  return {
    get mode() { return mode; },
    get isCloud() { return mode === "firebase"; },
    /* Tests and local play force the offline tree; nothing else should call this. */
    setMode(next) {
      flush();
      mode = next === "firebase" && cfg.firebaseUrl ? "firebase" : "local";
      backend = mode === "firebase" ? firebase : local;
      return mode;
    },
    get(path) { return backend.get(path); },
    put(path, value) { cancelPending(path); return backend.put(path, value); },
    patch(path, obj) { return backend.patch(path, obj); },
    push(path, value) { return backend.push(path, value); },
    del(path) { cancelPending(path); return backend.del(path); },
    watch(path, cb) { return backend.watch(path, cb); },
    throttled,
    flush,
    newId: pushId,
    describe() {
      return mode === "firebase"
        ? "Live — everyone with the room code sees the same board as it changes."
        : "Offline — this browser only. Other tabs of this browser will follow along, other devices will not.";
    },
  };
})();

if (typeof window !== "undefined") {
  // A page being closed mid-drag must not leave a token behind where it no longer is.
  window.addEventListener("pagehide", () => CocLive.flush());
}
