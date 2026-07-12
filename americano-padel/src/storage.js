// Real shared backend for the app, using Firebase Realtime Database.
// Implements the same get/set/delete/list shape the app already expects
// (matching Claude.ai's built-in window.storage API), so App.jsx did not
// need any changes — only this file was swapped out.
//
// Because this is a REAL shared database (not localStorage), data written
// from one phone is visible to every other phone/browser that opens the
// app or the view-only link — exactly like it behaved inside Claude.ai.

import { initializeApp, getApps } from "firebase/app";
import {
  getDatabase,
  ref,
  get as dbGet,
  set as dbSet,
  remove as dbRemove,
} from "firebase/database";

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  databaseURL: import.meta.env.VITE_FIREBASE_DATABASE_URL,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
};

const app = getApps().length ? getApps()[0] : initializeApp(firebaseConfig);
const db = getDatabase(app);

// Realtime Database keys can't contain . # $ [ ] /  — our own keys never
// do, but this keeps things safe regardless.
function safeKey(key) {
  return String(key).replace(/[.#$[\]/]/g, "_");
}

function path(key) {
  return `kv/${safeKey(key)}`;
}

async function get(key /*, shared */) {
  try {
    const snap = await dbGet(ref(db, path(key)));
    if (!snap.exists()) return null;
    const data = snap.val();
    return { key, value: data.value, shared: true };
  } catch (e) {
    throw new Error("storage.get failed: " + e.message);
  }
}

async function set(key, value /*, shared */) {
  try {
    await dbSet(ref(db, path(key)), { value, updatedAt: Date.now() });
    return { key, value, shared: true };
  } catch (e) {
    throw new Error("storage.set failed: " + e.message);
  }
}

async function del(key /*, shared */) {
  try {
    await dbRemove(ref(db, path(key)));
    return { key, deleted: true, shared: true };
  } catch (e) {
    throw new Error("storage.delete failed: " + e.message);
  }
}

async function list(prefix = "" /*, shared */) {
  try {
    const snap = await dbGet(ref(db, "kv"));
    if (!snap.exists()) return { keys: [], prefix, shared: true };
    const all = Object.keys(snap.val());
    const p = safeKey(prefix);
    const keys = all.filter((k) => k.startsWith(p));
    return { keys, prefix, shared: true };
  } catch (e) {
    throw new Error("storage.list failed: " + e.message);
  }
}

export function installStorageShim() {
  if (!window.storage) {
    window.storage = { get, set, delete: del, list };
  }
}
