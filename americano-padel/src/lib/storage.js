// Standalone replacement for the `window.storage` API that Claude.ai
// artifacts provide automatically. This shim uses the browser's
// localStorage so the app works out-of-the-box once deployed on your own
// (e.g. Vercel).
//
// IMPORTANT LIMITATION:
// localStorage is per-browser, per-device. It does NOT sync between
// different phones/players in real time like it did inside Claude.ai
// (which used a real shared backend). Every device that opens this app
// will have its own separate lobby/session data.
//
// If you want genuine multi-device real-time sync (so everyone sees the
// same lobby, schedule, and scores update live), you'll need to swap this
// file for a real backend, e.g. Firebase Realtime Database / Firestore,
// Supabase, or a small custom API. The three functions below (get/set/
// delete) are the only integration points used by the app, so you can
// replace their internals without touching App.jsx at all.

const NAMESPACE = "americano-padel:";

function fullKey(key) {
  return `${NAMESPACE}${key}`;
}

async function get(key /*, shared */) {
  try {
    const raw = window.localStorage.getItem(fullKey(key));
    if (raw === null) return null;
    return { key, value: raw, shared: false };
  } catch (e) {
    throw new Error("storage.get failed: " + e.message);
  }
}

async function set(key, value /*, shared */) {
  try {
    window.localStorage.setItem(fullKey(key), value);
    return { key, value, shared: false };
  } catch (e) {
    throw new Error("storage.set failed: " + e.message);
  }
}

async function del(key /*, shared */) {
  try {
    window.localStorage.removeItem(fullKey(key));
    return { key, deleted: true, shared: false };
  } catch (e) {
    throw new Error("storage.delete failed: " + e.message);
  }
}

async function list(prefix = "" /*, shared */) {
  try {
    const keys = [];
    const full = fullKey(prefix);
    for (let i = 0; i < window.localStorage.length; i++) {
      const k = window.localStorage.key(i);
      if (k && k.startsWith(NAMESPACE) && k.startsWith(full)) {
        keys.push(k.slice(NAMESPACE.length));
      }
    }
    return { keys, prefix, shared: false };
  } catch (e) {
    throw new Error("storage.list failed: " + e.message);
  }
}

export function installStorageShim() {
  if (!window.storage) {
    window.storage = { get, set, delete: del, list };
  }
}
