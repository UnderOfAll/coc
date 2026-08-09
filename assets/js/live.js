/*
 * Circus of Chaos — CocLive: the live layer.
 *
 * Characters are documents: you load one, you save one, and CocStore is enough. A TABLE is not a
 * document — it is a room several people are inside at once, and everyone has to see a token move
 * as it moves. That needs a push, not a poll, and this file is the whole of it.
 *
 * Three backends, same interface, chosen by what is in config.js:
 *
 *   rest     — the Realtime Database over plain REST. Writes are PUT/PATCH/POST/DELETE; reads that
 *              must stay current use the database's STREAMING endpoint: request a path with
 *              `Accept: text/event-stream` and it stays open, sending `put` and `patch` events as the
 *              data changes. EventSource does that natively, so there is no SDK and no build step.
 *              Hand-rolled, and it works — but every stream is an HTTP/1.1 connection, and a browser
 *              allows about six of them per host.
 *
 *   sdk      — the SAME database through Firebase's own library, imported as ESM straight from
 *              gstatic.com. Still no bundler and still a folder of static files: a classic script may
 *              `import()` a module at runtime. What it buys is one WebSocket instead of a connection
 *              per stream, reconnection it handles itself, writes queued while the network is away,
 *              and `onDisconnect` — a real answer to "has this person gone", instead of a heartbeat.
 *              If the CDN cannot be reached it falls back to `rest` rather than leaving a dead table.
 *
 *   local    — one browser, no network: the whole tree lives in localStorage and changes are
 *              announced on a BroadcastChannel, so two TABS of the same browser genuinely see each
 *              other. That is what makes this testable without a network, and it is also the honest
 *              fallback for someone who has not filled in config.js.
 *
 * `mode` says WHERE the data lives (cloud or this browser); `transport` says HOW the cloud is
 * reached (sdk or rest). They are separate because the second is being swapped and the first is not.
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

  /* ------------------------------------------------------------------ firebase, its own SDK */

  /* The same database, reached through the library Google writes for it. The whole of the difference
     is in `watch`: REST opens one HTTP connection per stream and a browser allows about six to a
     host, which is a limit this app has already hit and lost writes to. The SDK multiplexes every
     watcher over ONE WebSocket, reconnects by itself, and queues writes made while the network is
     away — none of which I want to hand-roll a second time.

     It is loaded LAZILY, on the first call, for two reasons: a page that never opens a table should
     never pay for it, and a module fetched from another host is the one thing here that can fail
     without anything else being wrong. If it does fail, every operation quietly uses the REST backend
     instead — a table on a locked-down network still works, it just works the old way. */
  const sdk = (() => {
    const VERSION = "12.17.1";
    const cdn = (part) => `https://www.gstatic.com/firebasejs/${VERSION}/firebase-${part}.js`;
    /* A plain `import(url)` with a variable in it, so nothing tries to resolve gstatic.com at check
       time. Replaceable, because a test cannot reach a CDN and should not need one to prove that the
       choosing and the falling back are right. */
    let bring = (url) => import(/* the CDN, at runtime */ url);
    let loading = null;    // the in-flight load, so ten calls at once load once
    let api = null;        // { db, ref, get, set, update, push, remove, onValue, onDisconnect }
    let broken = "";       // why the CDN could not be reached: everything below goes over REST
    let brokenAt = 0;      // and when, because a network comes back
    let era = 0;           // bumped when a loader is swapped, so a stale load cannot land on top

    /* Eight seconds, then give up and use REST. A timeout rather than a `catch` because the failure
       that matters is not the one that fails: a captive portal or a corporate proxy ACCEPTS the
       connection and then answers nothing, so the import never settles either way. Without this, every
       call in the file — the join, the first read, the table's one watcher — waits on it, and a table
       on a bad network shows "Knocking…" forever instead of quietly working the old way. */
    const GIVE_UP_AFTER = 8000;
    /* And a network comes back. Latching "broken" for the life of the page means one two-second blip
       at load costs the whole session; a minute later it is worth another try, and the browser will
       have the module cached if it ever arrived. */
    const TRY_AGAIN_AFTER = 60000;

    const grumble = (why) => {
      try { console.warn("live: the Firebase SDK could not be loaded, using REST — " + why); }
      catch { /* no console */ }
    };

    function load() {
      if (api) return Promise.resolve(api);
      if (broken && Date.now() - brokenAt < TRY_AGAIN_AFTER) return Promise.resolve(null);
      if (loading) return loading;
      const mine = ++era;
      const fetching = (async () => {
        const [app, database] = await Promise.all([bring(cdn("app")), bring(cdn("database"))]);
        // A named app, so this cannot collide with anything else a page has already initialised, and
        // no API key: the Realtime Database is reached by URL and its rules are what guard it.
        const started = app.initializeApp({ databaseURL: base() }, "circus-of-chaos");
        return Object.assign({ db: database.getDatabase(started, base()) }, database);
      })().catch((err) => new Error((err && err.message) || String(err)));
      const patience = new Promise((done) => setTimeout(() => done(new Error("timed out")), GIVE_UP_AFTER));
      loading = Promise.race([fetching, patience]).then((got) => {
        // A loader swapped underneath us: whatever this one found is no longer anybody's answer.
        if (mine !== era) return api;
        loading = null;
        if (got instanceof Error) { broken = got.message; brokenAt = Date.now(); grumble(got.message); return null; }
        broken = ""; api = got;
        return api;
      });
      return loading;
    }

    const at = (f, path) => f.ref(f.db, path);
    return {
      /* Exposed for the diagnostics panel and for the two-device test: "sdk" only once the module is
         actually running, so a claim on screen is never ahead of the truth. */
      get state() { return api ? "sdk" : broken ? "rest (" + broken + ")" : "loading"; },
      /* Tests hand in their own loader. Nothing else should. Bumping the era is what stops a load
         already in flight from landing on top of the one this starts. */
      useLoader(fn) { bring = fn; era++; loading = null; api = null; broken = ""; brokenAt = 0; },
      async get(path) {
        const f = await load();
        if (!f) return firebase.get(path);
        return (await f.get(at(f, path))).val();
      },
      async put(path, value) {
        const f = await load();
        if (!f) return firebase.put(path, value);
        // The SDK writes null as a deletion too, so "gone" means the same thing in all three backends.
        await f.set(at(f, path), value === undefined ? null : value);
        return value;
      },
      async patch(path, obj) {
        const f = await load();
        if (!f) return firebase.patch(path, obj);
        await f.update(at(f, path), obj);
        return obj;
      },
      async push(path, value) {
        const f = await load();
        if (!f) return firebase.push(path, value);
        const made = f.push(at(f, path), value);
        await made;
        return made.key;
      },
      async del(path) {
        const f = await load();
        if (!f) return firebase.del(path);
        await f.remove(at(f, path));
        return true;
      },
      /* Watching has to hand back a canceller SYNCHRONOUSLY — the caller keeps it in a list and calls
         it when the table closes, possibly before the module has even arrived. So the unsubscribe is a
         box that is filled in later, and a table left in the first second still stops listening. */
      watch(path, cb) {
        let off = null, dropped = false, again = null;
        const listen = () => {
          load().then((f) => {
            if (dropped) return;
            if (!f) { off = firebase.watch(path, cb); return; }
            off = f.onValue(at(f, path), (snap) => {
              try { cb(snap.val()); } catch { /* a broken watcher must not kill the connection */ }
            }, (err) => {
              /* The library reconnects a dropped socket by itself; THIS is the other kind — the read was
                 cancelled outright, and the listener is now dead and will never fire again. The table
                 opens exactly one of these, so a silent one is a board that quietly stops updating and
                 says nothing. The REST watchdog reopened; so does this, at a rate that cannot spin. */
              off = null;
              try { console.warn("live: the table's listener was cancelled — " + (err && err.message)); }
              catch { /* no console */ }
              if (!dropped) again = setTimeout(listen, 30000);
            });
          }).catch(() => { /* load() answers rather than throwing; a bad path must not be an unhandled one */ });
        };
        listen();
        return () => {
          dropped = true;
          if (again) clearTimeout(again);
          if (off) { try { off(); } catch { /* already gone */ } }
          off = null;
        };
      },
      /* The database's own dead-man's switch: it promises to delete this path the moment the socket
         drops, however it drops. REST has no such thing, which is why presence is a heartbeat today.
         Returns false when it is not available, so a caller can keep the heartbeat instead. */
      async onGone(path) {
        const f = await load();
        if (!f || !f.onDisconnect) return false;
        await f.onDisconnect(at(f, path)).remove();
        return true;
      },
    };
  })();

  /* ------------------------------------------------------------------ which cloud transport */

  /* `?transport=sdk` on the address beats config.js, which beats the default. The point of the switch
     is that the swap can be PROVEN on the deployed site — the two-device test runs the whole session
     both ways against the same database — instead of being argued about. */
  function chosenTransport() {
    try {
      // Every shareable address in this app is a HASH one, so "#/table/482910?transport=sdk" is the
      // natural thing to paste and it puts the query inside the hash where `location.search` cannot
      // see it. Both places are read, the hash first, or the switch works only for the test.
      const inHash = location.hash.includes("?") ? location.hash.slice(location.hash.indexOf("?")) : "";
      const asked = new URLSearchParams(inHash).get("transport")
        || new URLSearchParams(location.search).get("transport");
      if (asked === "sdk" || asked === "rest") return asked;
    } catch { /* no location, or no search: a test environment */ }
    return cfg.transport === "sdk" || cfg.transport === "rest" ? cfg.transport : "rest";
  }
  let transport = chosenTransport();
  const cloud = () => (transport === "sdk" ? sdk : firebase);

  let backend = mode === "firebase" ? cloud() : local;

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
    /* Which cloud transport is CHOSEN, and what it is actually doing — they differ for the second or
       two the module takes to arrive, and the diagnostics panel should say which. */
    get transport() { return transport; },
    get transportState() {
      // Offline, no cloud transport is reached at all — saying "sdk (loading)" forever would be a
      // diagnostic that lies, and a lying diagnostic costs a debugging round.
      if (mode !== "firebase") return "local";
      return transport === "sdk" ? sdk.state : "rest";
    },
    /* Tests and local play force the offline tree; nothing else should call this. */
    setMode(next) {
      flush();
      mode = next === "firebase" && cfg.firebaseUrl ? "firebase" : "local";
      backend = mode === "firebase" ? cloud() : local;
      return mode;
    },
    /* Swapping transport mid-session is for the tests and the address bar, not for the app: a table
       already open keeps the watchers it opened. `loader` is a test's stand-in for the CDN. */
    setTransport(next, loader) {
      flush();
      if (loader) sdk.useLoader(loader);
      transport = next === "sdk" ? "sdk" : "rest";
      if (mode === "firebase") backend = cloud();
      return transport;
    },
    get(path) { return backend.get(path); },
    put(path, value) { cancelPending(path); return backend.put(path, value); },
    patch(path, obj) { return backend.patch(path, obj); },
    push(path, value) { return backend.push(path, value); },
    del(path) { cancelPending(path); return backend.del(path); },
    watch(path, cb) { return backend.watch(path, cb); },
    /* "Delete this when I disappear." Only the SDK can promise it — everything else answers false, and
       a caller that gets false keeps saying "I am still here" on a timer instead. */
    onGone(path) { return backend.onGone ? backend.onGone(path) : Promise.resolve(false); },
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
