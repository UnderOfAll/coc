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

  // --- Option B: Supabase (if you would rather use it) ---
  supabaseUrl: "",
  supabaseAnonKey: "",
  supabaseTable: "characters",
};
