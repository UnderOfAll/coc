/*
 * Circus of Chaos — the ONE file you edit to turn on cloud saves.
 *
 * Right now this is empty, so characters save into this browser's localStorage: they work, but they
 * live on one device. Fill in ONE of the blocks below and every six-digit code becomes reachable
 * from any phone or computer, with no other change to the app.
 *
 * See docs/CLOUD_SETUP.md for click-by-click instructions (about three minutes, no coding).
 */
const COC_CONFIG = {
  // --- Option A: Firebase Realtime Database (simplest — no tables, no SQL) ---
  // Paste the database URL you are given, e.g. "https://my-circus-default-rtdb.firebaseio.com"
  firebaseUrl: "https://circus-of-chaos-78122-default-rtdb.europe-west1.firebasedatabase.app",

  /* HOW that database is reached — the same data either way.
       "rest" — hand-rolled: one HTTP stream per watcher, and a browser allows about six per host.
       "sdk"  — Firebase's own library, fetched as a module from gstatic.com: one WebSocket for
                everything, reconnection handled for us, writes queued while the network is away.
     `?transport=sdk` (or `=rest`) on the address overrides this for one visit, which is how the swap
     is proved on the live site before it is made permanent. */
  transport: "rest",

  /* The diagnostics overlay is Kayki's, not a feature. Visiting #/debug/<phrase> once on a device turns it
     on for that browser forever; nothing appears in the interface for anyone who has not. Only the HASH of
     the phrase is here, so reading this file does not hand it over — and it is a "do not bother anybody
     else with it" switch rather than a security boundary, which is all it needs to be. */
  debugHash: "sha256:469afc5e555c62c69610ca20354eda414571c1acdd1f9d7a684a13746f7b04b0",

  // --- Option B: Supabase (if you would rather use it) ---
  supabaseUrl: "",
  supabaseAnonKey: "",
  supabaseTable: "characters",
};
