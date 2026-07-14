import React, { useState, useEffect, useRef, useCallback } from "react";
import {
  Plus, X, Users, Clock, Trophy, Shuffle, ChevronLeft, ChevronRight,
  RotateCcw, Share2, BarChart3, Settings2, Check, Coffee,
  ArrowLeft, Trash2, CalendarDays, ChevronRightCircle, ClipboardList, Link2, Eye, ListOrdered,
  LogOut, Lock, UserCircle2, Shield, Wallet,
} from "lucide-react";

// ---------------------------------------------------------------------------
// SCHEDULING ENGINE
// ---------------------------------------------------------------------------

function generateSchedule(playerIds, courtsInput, numRounds) {
  const n = playerIds.length;
  const usableCourts = Math.max(0, Math.min(courtsInput, Math.floor(n / 4)));
  const capacity = usableCourts * 4;

  const partner = {};
  const opp = {};
  const playCount = {};
  const restCount = {};
  const lastRested = {};

  playerIds.forEach((id) => {
    playCount[id] = 0;
    restCount[id] = 0;
    lastRested[id] = -99;
    partner[id] = {};
    opp[id] = {};
    playerIds.forEach((o) => {
      if (o !== id) {
        partner[id][o] = 0;
        opp[id][o] = 0;
      }
    });
  });

  const roundsData = [];

  for (let r = 0; r < numRounds; r++) {
    const numResting = n - capacity;
    let resting = [];
    let active = [...playerIds];

    if (numResting > 0) {
      const sorted = [...playerIds].sort((a, b) => {
        if (restCount[a] !== restCount[b]) return restCount[a] - restCount[b];
        const agoA = r - lastRested[a];
        const agoB = r - lastRested[b];
        if (agoA !== agoB) return agoB - agoA;
        return Math.random() - 0.5;
      });
      resting = sorted.slice(0, numResting);
      const restingSet = new Set(resting);
      active = playerIds.filter((id) => !restingSet.has(id));
      resting.forEach((id) => {
        restCount[id]++;
        lastRested[id] = r;
      });
    }

    let bestSplits = null;
    let bestCost = Infinity;
    const trials = active.length <= 8 ? 60 : active.length <= 16 ? 250 : 400;

    for (let t = 0; t < trials; t++) {
      const shuffled = [...active].sort(() => Math.random() - 0.5);
      const groups = [];
      for (let g = 0; g < usableCourts; g++) {
        groups.push(shuffled.slice(g * 4, g * 4 + 4));
      }

      let cost = 0;
      const splits = [];
      for (const grp of groups) {
        const [a, b, c, d] = grp;
        const options = [
          { t1: [a, b], t2: [c, d] },
          { t1: [a, c], t2: [b, d] },
          { t1: [a, d], t2: [b, c] },
        ];
        let bestOpt = null;
        let bestOptCost = Infinity;
        for (const opt of options) {
          const [p1, p2] = opt.t1;
          const [p3, p4] = opt.t2;
          const c1 =
            partner[p1][p2] * 10 +
            partner[p3][p4] * 10 +
            opp[p1][p3] +
            opp[p1][p4] +
            opp[p2][p3] +
            opp[p2][p4];
          if (c1 < bestOptCost) {
            bestOptCost = c1;
            bestOpt = opt;
          }
        }
        cost += bestOptCost;
        splits.push(bestOpt);
      }

      if (cost < bestCost) {
        bestCost = cost;
        bestSplits = splits;
      }
    }

    const courtsResult = (bestSplits || []).map((split) => ({
      team1: split.t1,
      team2: split.t2,
    }));

    courtsResult.forEach(({ team1, team2 }) => {
      const [a, b] = team1;
      const [c, d] = team2;
      partner[a][b]++;
      partner[b][a]++;
      partner[c][d]++;
      partner[d][c]++;
      [a, b].forEach((x) =>
        [c, d].forEach((y) => {
          opp[x][y]++;
          opp[y][x]++;
        })
      );
      [a, b, c, d].forEach((id) => (playCount[id] += 1));
    });

    roundsData.push({ resting, courts: courtsResult });
  }

  return { roundsData, playCount, restCount, partner, opp, usableCourts };
}

// ---------------------------------------------------------------------------
// STORAGE HELPERS
// ---------------------------------------------------------------------------

const lobbyKey = (accountId) => `padel-lobby-index-${accountId}`;
const sessionKey = (id) => `padel-session-${id}`;
const userKey = (usernameLower) => `user:${usernameLower}`;

// SHARED = true → semua orang yang membuka app ini melihat lobby & sesi yang sama.
// Lobby sekarang di-scope per akun, jadi tiap akun cuma lihat history acaranya sendiri.
async function loadLobbyIndex(accountId) {
  if (!accountId) return [];
  try {
    const res = await window.storage.get(lobbyKey(accountId), true);
    return res ? JSON.parse(res.value) : [];
  } catch (e) {
    return [];
  }
}

async function saveLobbyIndex(accountId, list) {
  if (!accountId) return;
  try {
    await window.storage.set(lobbyKey(accountId), JSON.stringify(list), true);
  } catch (e) {
    console.error("Gagal menyimpan lobby:", e);
  }
}

async function loadSessionData(id) {
  try {
    const res = await window.storage.get(sessionKey(id), true);
    return res ? JSON.parse(res.value) : null;
  } catch (e) {
    return null;
  }
}

async function saveSessionData(id, data) {
  try {
    await window.storage.set(sessionKey(id), JSON.stringify(data), true);
  } catch (e) {
    console.error("Gagal menyimpan sesi:", e);
  }
}

async function deleteSessionData(id) {
  try {
    await window.storage.delete(sessionKey(id), true);
  } catch (e) {
    /* no-op */
  }
}

// ---------------------------------------------------------------------------
// ACCOUNTS (username + password)
// ---------------------------------------------------------------------------

const AUTH_SALT = "americano-padel-v1"; // fixed app-level salt (not a secret, just avoids plain rainbow tables)
const REMEMBER_KEY = "americano-padel-auth";

async function hashPassword(usernameLower, password) {
  const enc = new TextEncoder().encode(`${AUTH_SALT}:${usernameLower}:${password}`);
  const digest = await crypto.subtle.digest("SHA-256", enc);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function getUserAccount(usernameLower) {
  try {
    const res = await window.storage.get(userKey(usernameLower), true);
    return res ? JSON.parse(res.value) : null;
  } catch (e) {
    return null;
  }
}

// Case/whitespace-insensitive normalization for security question answers —
// "Jakarta", " jakarta ", "JAKARTA" should all match.
function normalizeAnswer(raw) {
  return String(raw || "").trim().toLowerCase();
}

// Formats a rupiah amount, always rounded UP to a whole number (no decimals),
// with the standard Indonesian thousands-dot grouping — e.g. 57649.2 -> "Rp.57.650".
function formatRupiah(amount) {
  const rounded = Math.ceil(Number(amount) || 0);
  return "Rp." + rounded.toLocaleString("id-ID");
}

const SECURITY_QUESTIONS = [
  { key: "city", label: "Di kota mana Anda lahir?" },
  { key: "sport", label: "Olahraga favorit Anda?" },
  { key: "country", label: "Negara favorit Anda?" },
];

async function createUserAccount(username, passwordHash, securityAnswers) {
  const usernameLower = username.toLowerCase();
  const account = {
    accountId: usernameLower,
    username,
    passwordHash,
    // Legacy accounts (created before this feature) simply won't have this
    // field — handled explicitly wherever it's read.
    securityAnswers: securityAnswers || null,
    createdAt: Date.now(),
  };
  await window.storage.set(userKey(usernameLower), JSON.stringify(account), true);
  return account;
}

async function updateUserPassword(usernameLower, newPasswordHash) {
  const existing = await getUserAccount(usernameLower);
  if (!existing) return null;
  const updated = { ...existing, passwordHash: newPasswordHash };
  await window.storage.set(userKey(usernameLower), JSON.stringify(updated), true);
  return updated;
}

async function updateUserAvatar(usernameLower, avatarDataUrl) {
  const existing = await getUserAccount(usernameLower);
  if (!existing) return null;
  const updated = { ...existing, avatarUrl: avatarDataUrl };
  await window.storage.set(userKey(usernameLower), JSON.stringify(updated), true);
  return updated;
}

// Resizes/crops any uploaded image client-side into a small square JPEG data
// URL before it's ever stored, so profile pictures stay tiny (a few KB) no
// matter what photo someone picks.
function processImageToAvatar(file, size = 160) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Gagal membaca file"));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error("File bukan gambar yang valid"));
      img.onload = () => {
        const canvas = document.createElement("canvas");
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext("2d");
        const side = Math.min(img.width, img.height);
        const sx = (img.width - side) / 2;
        const sy = (img.height - side) / 2;
        ctx.drawImage(img, sx, sy, side, side, 0, 0, size, size);
        resolve(canvas.toDataURL("image/jpeg", 0.85));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

// ---------------------------------------------------------------------------
// FRIENDS (add friend, confirm request, friends list)
// ---------------------------------------------------------------------------

// Sends a friend request to another account. Requests need the recipient's
// confirmation before becoming mutual friends (stored on the recipient's own
// account record as `incomingFriendRequests`).
async function sendFriendRequest(toAccountId, fromAccountId, fromUsername) {
  if (!toAccountId || toAccountId === fromAccountId) return false;
  const toAcc = await getUserAccount(toAccountId);
  if (!toAcc) return false;
  const friends = toAcc.friends || [];
  const incoming = toAcc.incomingFriendRequests || [];
  if (friends.includes(fromAccountId) || incoming.some((r) => r.accountId === fromAccountId)) {
    return false;
  }
  const updated = {
    ...toAcc,
    incomingFriendRequests: [...incoming, { accountId: fromAccountId, username: fromUsername }],
  };
  await window.storage.set(userKey(toAccountId), JSON.stringify(updated), true);
  return true;
}

// Accept or decline an incoming friend request. On accept, both accounts get
// each other added to their `friends` list (mutual).
async function respondFriendRequest(myAccountId, fromAccountId, accept) {
  const me = await getUserAccount(myAccountId);
  if (!me) return;
  const incoming = (me.incomingFriendRequests || []).filter((r) => r.accountId !== fromAccountId);
  let myFriends = me.friends || [];
  if (accept) myFriends = [...new Set([...myFriends, fromAccountId])];
  await window.storage.set(
    userKey(myAccountId),
    JSON.stringify({ ...me, incomingFriendRequests: incoming, friends: myFriends }),
    true
  );
  if (accept) {
    const other = await getUserAccount(fromAccountId);
    if (other) {
      const otherFriends = [...new Set([...(other.friends || []), myAccountId])];
      await window.storage.set(
        userKey(fromAccountId),
        JSON.stringify({ ...other, friends: otherFriends }),
        true
      );
    }
  }
}

// Resolves an account's friend id list into displayable {accountId, username,
// avatarUrl} entries, plus its pending incoming requests.
async function loadFriendsData(accountId) {
  const acc = await getUserAccount(accountId);
  if (!acc) return { friends: [], incoming: [] };
  const friendIds = acc.friends || [];
  const resolved = await Promise.all(
    friendIds.map(async (id) => {
      const f = await getUserAccount(id);
      return f ? { accountId: id, username: f.username, avatarUrl: f.avatarUrl || null } : null;
    })
  );
  return {
    friends: resolved.filter(Boolean),
    incoming: acc.incomingFriendRequests || [],
  };
}

// For the "browse people" screen — lists every registered account (except
// yourself) with your relationship status to each (already friends / request
// already sent by you).
async function listAllAccounts(myAccountId) {
  try {
    const res = await window.storage.list("user:", true);
    if (!res) return [];
    const accounts = await Promise.all(
      res.keys.map(async (k) => {
        const usernameLower = k.replace(/^user:/, "");
        const acc = await getUserAccount(usernameLower);
        if (!acc || acc.accountId === myAccountId) return null;
        return {
          accountId: acc.accountId,
          username: acc.username,
          avatarUrl: acc.avatarUrl || null,
          isFriend: (acc.friends || []).includes(myAccountId),
          requestSentByMe: (acc.incomingFriendRequests || []).some((r) => r.accountId === myAccountId),
        };
      })
    );
    return accounts.filter(Boolean).sort((a, b) => a.username.localeCompare(b.username));
  } catch (e) {
    return [];
  }
}

// Lets you see how many accounts are registered (see chat for where to check this).
async function countRegisteredAccounts() {
  try {
    const res = await window.storage.list("user:", true);
    return res ? res.keys.length : 0;
  } catch (e) {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// PUBLIC EVENTS DISCOVERY (shared list of "public" meetings anyone can browse
// and request to join, subject to host approval)
// ---------------------------------------------------------------------------

const PUBLIC_EVENTS_KEY = "padel-public-events";

async function loadPublicEvents() {
  try {
    const res = await window.storage.get(PUBLIC_EVENTS_KEY, true);
    return res ? JSON.parse(res.value) : [];
  } catch (e) {
    return [];
  }
}

async function savePublicEvents(list) {
  try {
    await window.storage.set(PUBLIC_EVENTS_KEY, JSON.stringify(list), true);
  } catch (e) {
    console.error("Gagal menyimpan daftar acara publik:", e);
  }
}

// Called whenever a session is saved. Keeps the shared public discovery list
// consistent: a "public" meeting still gathering players (status=waiting)
// should be listed; anything else (private, already generated, deleted)
// should not.
async function syncPublicEventEntry(snapshot) {
  const list = await loadPublicEvents();
  const shouldBeListed = snapshot.visibility === "public" && snapshot.status === "waiting";
  const existingIdx = list.findIndex((e) => e.id === snapshot.id);

  if (!shouldBeListed) {
    if (existingIdx !== -1) {
      list.splice(existingIdx, 1);
      await savePublicEvents(list);
    }
    return;
  }

  const entry = {
    id: snapshot.id,
    name: snapshot.name || "Sesi Padel",
    ownerId: snapshot.ownerId,
    ownerUsername: snapshot.ownerUsername || "",
    maxParticipants: snapshot.maxParticipants,
    playerCount: (snapshot.players || []).length,
    courts: snapshot.courts,
    updatedAt: snapshot.updatedAt,
  };
  if (existingIdx !== -1) list[existingIdx] = entry;
  else list.unshift(entry);
  await savePublicEvents(list);
}

async function removePublicEventEntry(id) {
  const list = await loadPublicEvents();
  const next = list.filter((e) => e.id !== id);
  if (next.length !== list.length) await savePublicEvents(next);
}

function rememberLogin(account) {
  try {
    localStorage.setItem(
      REMEMBER_KEY,
      JSON.stringify({ accountId: account.accountId, username: account.username })
    );
  } catch (e) {
    /* no-op */
  }
}

function loadRememberedLogin() {
  try {
    const raw = localStorage.getItem(REMEMBER_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    return null;
  }
}

function forgetLogin() {
  try {
    localStorage.removeItem(REMEMBER_KEY);
  } catch (e) {
    /* no-op */
  }
}

function uid() {
  return Math.random().toString(36).slice(2, 10);
}

function fmtClock(mins) {
  const h = Math.floor(mins / 60);
  const m = Math.round(mins % 60);
  const pad = (x) => String(x).padStart(2, "0");
  return `${pad(h)}:${pad(m)}`;
}

// ---------------------------------------------------------------------------
// UI PRIMITIVES
// ---------------------------------------------------------------------------

function Chip({ children, tone = "slate" }) {
  const tones = {
    slate: "bg-slate-800 text-slate-300 border-slate-700",
    lime: "bg-lime-400/10 text-lime-300 border-lime-400/40",
    cyan: "bg-cyan-400/10 text-cyan-300 border-cyan-400/40",
    amber: "bg-amber-400/10 text-amber-300 border-amber-400/40",
  };
  return (
    <span
      className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full border text-xs font-medium ${tones[tone]}`}
    >
      {children}
    </span>
  );
}

function PrimaryButton({ children, onClick, disabled, className = "", icon: Icon }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`inline-flex items-center justify-center gap-2 px-5 py-3 rounded-xl font-bold tracking-wide
        bg-lime-300 text-slate-950 disabled:bg-slate-700 disabled:text-slate-500
        active:scale-[0.98] transition-transform ${className}`}
    >
      {Icon && <Icon size={18} strokeWidth={2.5} />}
      {children}
    </button>
  );
}

function GhostButton({ children, onClick, disabled, className = "", icon: Icon }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl font-semibold
        bg-slate-900 border border-slate-700 text-slate-200 disabled:opacity-40
        active:scale-[0.98] transition-transform ${className}`}
    >
      {Icon && <Icon size={16} strokeWidth={2.5} />}
      {children}
    </button>
  );
}

// Circular 1:1 avatar. Shows the account's profile picture if it has one,
// otherwise falls back to 1-2 letter initials derived from the name.
function initialsFromName(name) {
  const parts = String(name || "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

function Avatar({ name, avatarUrl, size = 32, className = "" }) {
  const px = `${size}px`;
  if (avatarUrl) {
    return (
      <img
        src={avatarUrl}
        alt={name || "avatar"}
        style={{ width: px, height: px }}
        className={`rounded-full object-cover shrink-0 aspect-square ${className}`}
      />
    );
  }
  return (
    <div
      style={{ width: px, height: px, fontSize: size * 0.38 }}
      className={`rounded-full bg-slate-800 border border-slate-700 text-slate-300 font-bold flex items-center justify-center shrink-0 aspect-square ${className}`}
    >
      {initialsFromName(name)}
    </div>
  );
}

// ---------------------------------------------------------------------------
// AUTH SCREEN (login / daftar — username & password saja)
// ---------------------------------------------------------------------------

function AuthScreen({ onAuthenticated }) {
  const [mode, setMode] = useState("login"); // login | register | forgot
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [secQuestionKey, setSecQuestionKey] = useState(SECURITY_QUESTIONS[0].key);
  const [secAnswer, setSecAnswer] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  // Forgot-password sub-flow
  const [forgotStep, setForgotStep] = useState("username"); // username | questions | reset
  const [forgotAccount, setForgotAccount] = useState(null);
  const [forgotAnswer, setForgotAnswer] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [newPasswordConfirm, setNewPasswordConfirm] = useState("");

  const resetFields = () => {
    setPassword("");
    setConfirmPassword("");
    setSecQuestionKey(SECURITY_QUESTIONS[0].key);
    setSecAnswer("");
    setError("");
  };

  const resetForgotFlow = () => {
    setForgotStep("username");
    setForgotAccount(null);
    setForgotAnswer("");
    setNewPassword("");
    setNewPasswordConfirm("");
    setError("");
  };

  const handleSubmit = async () => {
    setError("");
    const name = username.trim();
    if (name.length < 3) {
      setError("Username minimal 3 karakter.");
      return;
    }
    if (!/^[a-zA-Z0-9_.]+$/.test(name)) {
      setError("Username cuma boleh huruf, angka, titik, dan underscore.");
      return;
    }
    if (password.length < 4) {
      setError("Password minimal 4 karakter.");
      return;
    }
    if (mode === "register") {
      if (password !== confirmPassword) {
        setError("Konfirmasi password tidak sama.");
        return;
      }
      if (!secAnswer.trim()) {
        setError("Jawaban pertanyaan keamanan wajib diisi.");
        return;
      }
    }

    const usernameLower = name.toLowerCase();
    setBusy(true);
    try {
      if (mode === "register") {
        const existing = await getUserAccount(usernameLower);
        if (existing) {
          setError("Username sudah dipakai. Coba nama lain atau masuk (Login).");
          setBusy(false);
          return;
        }
        const passwordHash = await hashPassword(usernameLower, password);
        const securityAnswer = {
          questionKey: secQuestionKey,
          answer: normalizeAnswer(secAnswer),
        };
        const account = await createUserAccount(name, passwordHash, securityAnswer);
        rememberLogin(account);
        onAuthenticated(account);
      } else {
        const existing = await getUserAccount(usernameLower);
        if (!existing) {
          setError("Akun tidak ditemukan. Coba Daftar dulu.");
          setBusy(false);
          return;
        }
        const passwordHash = await hashPassword(usernameLower, password);
        if (passwordHash !== existing.passwordHash) {
          setError("Password salah.");
          setBusy(false);
          return;
        }
        rememberLogin(existing);
        onAuthenticated(existing);
      }
    } catch (e) {
      setError("Terjadi kesalahan. Coba lagi.");
    }
    setBusy(false);
  };

  // --- Forgot password handlers ---

  const handleForgotUsername = async () => {
    setError("");
    const name = username.trim();
    if (!name) {
      setError("Masukkan username kamu.");
      return;
    }
    setBusy(true);
    const account = await getUserAccount(name.toLowerCase());
    setBusy(false);
    if (!account) {
      setError("Akun tidak ditemukan.");
      return;
    }
    setForgotAccount(account);
    if (account.securityAnswers) {
      setForgotStep("questions");
    } else {
      // Legacy account, created before security questions existed —
      // per design, username alone is enough to proceed to reset.
      setForgotStep("reset");
    }
  };

  const handleForgotQuestions = () => {
    setError("");
    const a = forgotAccount.securityAnswers;
    const ok = normalizeAnswer(forgotAnswer) === a.answer;
    if (!ok) {
      setError("Jawaban tidak cocok. Coba lagi.");
      return;
    }
    setForgotStep("reset");
  };

  const handleForgotReset = async () => {
    setError("");
    if (newPassword.length < 4) {
      setError("Password minimal 4 karakter.");
      return;
    }
    if (newPassword !== newPasswordConfirm) {
      setError("Konfirmasi password tidak sama.");
      return;
    }
    setBusy(true);
    const usernameLower = forgotAccount.accountId;
    const passwordHash = await hashPassword(usernameLower, newPassword);
    const updated = await updateUserPassword(usernameLower, passwordHash);
    setBusy(false);
    if (!updated) {
      setError("Terjadi kesalahan. Coba lagi.");
      return;
    }
    rememberLogin(updated);
    onAuthenticated(updated);
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <style>{FONT_STYLE}</style>
      <div className="max-w-md mx-auto flex flex-col justify-center min-h-screen px-6 py-10">
      <div className="mb-8">
        <div className="flex items-center gap-2 mb-2">
          <div className="w-2 h-2 rounded-full bg-lime-300" />
          <span className="text-xs font-semibold tracking-[0.2em] text-cyan-300 uppercase">
            Court Rotation Engine
          </span>
        </div>
        <h1 className="font-display text-6xl leading-[0.85] text-slate-50 tracking-wide">
          AMERICANO
          <br />
          <span className="text-lime-300">SCHEDULER</span>
        </h1>
        <p className="text-slate-400 text-sm mt-3">
          Masuk atau buat akun untuk menyimpan history acara/turnamen kamu.
        </p>
      </div>

      {mode !== "forgot" && (
        <div className="flex gap-2 mb-5">
          <ModeTab
            active={mode === "login"}
            onClick={() => {
              setMode("login");
              resetFields();
            }}
          >
            Masuk
          </ModeTab>
          <ModeTab
            active={mode === "register"}
            onClick={() => {
              setMode("register");
              resetFields();
            }}
          >
            Daftar Akun
          </ModeTab>
        </div>
      )}

      {mode === "forgot" ? (
        <div className="space-y-3">
          <button
            onClick={() => {
              setMode("login");
              resetForgotFlow();
            }}
            className="flex items-center gap-1 text-xs font-semibold text-slate-400 mb-1"
          >
            <ArrowLeft size={13} /> Kembali ke Masuk
          </button>

          {forgotStep === "username" && (
            <>
              <div className="relative">
                <UserCircle2 size={18} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-500" />
                <input
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder="Username"
                  autoCapitalize="none"
                  onKeyDown={(e) => e.key === "Enter" && !busy && handleForgotUsername()}
                  className="w-full bg-slate-900 border border-slate-700 rounded-xl pl-11 pr-4 py-3.5 text-sm placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-lime-400/50"
                />
              </div>
              {error && <p className="text-red-400 text-xs px-1">{error}</p>}
              <PrimaryButton onClick={handleForgotUsername} disabled={busy} className="w-full text-base py-3.5">
                {busy ? "Memeriksa…" : "Lanjut"}
              </PrimaryButton>
            </>
          )}

          {forgotStep === "questions" && (
            <>
              <p className="text-xs text-slate-500 mb-1">Jawab pertanyaan keamananmu:</p>
              <p className="text-sm font-semibold text-slate-200 mb-2">
                {SECURITY_QUESTIONS.find((q) => q.key === forgotAccount?.securityAnswers?.questionKey)
                  ?.label || "Jawaban keamanan"}
              </p>
              <div className="relative">
                <input
                  value={forgotAnswer}
                  onChange={(e) => setForgotAnswer(e.target.value)}
                  placeholder="Jawabanmu"
                  onKeyDown={(e) => e.key === "Enter" && handleForgotQuestions()}
                  className="w-full bg-slate-900 border border-slate-700 rounded-xl px-4 py-3.5 text-sm placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-lime-400/50"
                />
              </div>
              {error && <p className="text-red-400 text-xs px-1">{error}</p>}
              <PrimaryButton onClick={handleForgotQuestions} className="w-full text-base py-3.5">
                Verifikasi
              </PrimaryButton>
            </>
          )}

          {forgotStep === "reset" && (
            <>
              <p className="text-xs text-slate-500 mb-1">Buat password baru:</p>
              <div className="relative">
                <Lock size={18} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-500" />
                <input
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  type="password"
                  placeholder="Password baru"
                  className="w-full bg-slate-900 border border-slate-700 rounded-xl pl-11 pr-4 py-3.5 text-sm placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-lime-400/50"
                />
              </div>
              <div className="relative">
                <Lock size={18} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-500" />
                <input
                  value={newPasswordConfirm}
                  onChange={(e) => setNewPasswordConfirm(e.target.value)}
                  type="password"
                  placeholder="Ulangi password baru"
                  onKeyDown={(e) => e.key === "Enter" && !busy && handleForgotReset()}
                  className="w-full bg-slate-900 border border-slate-700 rounded-xl pl-11 pr-4 py-3.5 text-sm placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-lime-400/50"
                />
              </div>
              {error && <p className="text-red-400 text-xs px-1">{error}</p>}
              <PrimaryButton onClick={handleForgotReset} disabled={busy} className="w-full text-base py-3.5">
                {busy ? "Menyimpan…" : "Simpan Password Baru"}
              </PrimaryButton>
            </>
          )}
        </div>
      ) : (
        <div className="space-y-3">
          <div className="relative">
            <UserCircle2 size={18} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-500" />
            <input
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="Username"
              autoCapitalize="none"
              className="w-full bg-slate-900 border border-slate-700 rounded-xl pl-11 pr-4 py-3.5 text-sm placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-lime-400/50"
            />
          </div>
          <div className="relative">
            <Lock size={18} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-500" />
            <input
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              type="password"
              placeholder="Password"
              onKeyDown={(e) => e.key === "Enter" && !busy && mode !== "register" && handleSubmit()}
              className="w-full bg-slate-900 border border-slate-700 rounded-xl pl-11 pr-4 py-3.5 text-sm placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-lime-400/50"
            />
          </div>
          {mode === "register" && (
            <>
              <div className="relative">
                <Lock size={18} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-500" />
                <input
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  type="password"
                  placeholder="Ulangi password"
                  className="w-full bg-slate-900 border border-slate-700 rounded-xl pl-11 pr-4 py-3.5 text-sm placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-lime-400/50"
                />
              </div>

              <p className="text-xs text-slate-500 pt-2">
                Pilih pertanyaan keamanan (untuk reset password kalau lupa nanti):
              </p>
              <select
                value={secQuestionKey}
                onChange={(e) => setSecQuestionKey(e.target.value)}
                className="w-full bg-slate-900 border border-slate-700 rounded-xl px-4 py-3.5 text-sm text-slate-100 focus:outline-none focus:ring-2 focus:ring-lime-400/50"
              >
                {SECURITY_QUESTIONS.map((q) => (
                  <option key={q.key} value={q.key}>
                    {q.label}
                  </option>
                ))}
              </select>
              <div className="relative">
                <input
                  value={secAnswer}
                  onChange={(e) => setSecAnswer(e.target.value)}
                  placeholder="Jawabanmu"
                  onKeyDown={(e) => e.key === "Enter" && !busy && handleSubmit()}
                  className="w-full bg-slate-900 border border-slate-700 rounded-xl px-4 py-3.5 text-sm placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-lime-400/50"
                />
              </div>
            </>
          )}

          {mode === "login" && (
            <button
              onClick={() => {
                setMode("forgot");
                resetForgotFlow();
              }}
              className="text-xs text-cyan-300 font-semibold px-1"
            >
              Lupa password?
            </button>
          )}

          {error && <p className="text-red-400 text-xs px-1">{error}</p>}

          <PrimaryButton onClick={handleSubmit} disabled={busy} className="w-full text-base py-3.5">
            {busy ? "Memproses…" : mode === "login" ? "Masuk" : "Buat Akun"}
          </PrimaryButton>
        </div>
      )}

      <p className="text-[11px] text-slate-500 text-center mt-6">
        Cukup username & password — tidak perlu email. Password disimpan dalam bentuk terenkripsi
        (hash), bukan teks biasa.
      </p>
      </div>
    </div>
  );
}


function matchAB(s) {
  if (!s) return null;
  if (s.format === "tennis") {
    return { a: s.gamesA, b: s.gamesB };
  }
  const a = Number(s.a);
  const b = Number(s.b);
  return { a: Number.isFinite(a) ? a : undefined, b: Number.isFinite(b) ? b : undefined };
}

// Builds the standings array (points, wins/losses/ties, diff, matches played)
// from a schedule + score map. Shared between the editable app and the
// read-only viewer link.
function buildLeaderboard(engine, playerMap, scores) {
  if (!engine) return [];
  const totals = {};
  Object.keys(playerMap).forEach((id) => {
    totals[id] = {
      id,
      name: playerMap[id],
      points: 0,
      wins: 0,
      losses: 0,
      ties: 0,
      diff: 0,
      matches: 0,
      rests: engine.restCount[id] || 0,
    };
  });
  engine.roundsData.forEach((rd, rIdx) => {
    rd.courts.forEach((match, cIdx) => {
      const s = scores[`${rIdx}-${cIdx}`];
      const ab = matchAB(s);
      if (!ab) return;
      const { a, b } = ab;
      if (!Number.isFinite(a) || !Number.isFinite(b)) return;
      match.team1.forEach((id) => {
        totals[id].points += a;
        totals[id].diff += a - b;
        totals[id].matches += 1;
      });
      match.team2.forEach((id) => {
        totals[id].points += b;
        totals[id].diff += b - a;
        totals[id].matches += 1;
      });
      if (a > b) {
        match.team1.forEach((id) => (totals[id].wins += 1));
        match.team2.forEach((id) => (totals[id].losses += 1));
      } else if (b > a) {
        match.team2.forEach((id) => (totals[id].wins += 1));
        match.team1.forEach((id) => (totals[id].losses += 1));
      } else {
        match.team1.forEach((id) => (totals[id].ties += 1));
        match.team2.forEach((id) => (totals[id].ties += 1));
      }
    });
  });
  return Object.values(totals).map((t) => ({
    ...t,
    winPercent: t.matches > 0 ? (t.wins / t.matches) * 100 : 0,
    ppm: t.matches > 0 ? t.points / t.matches : 0,
  }));
}

// ---------------------------------------------------------------------------
// MAIN APP
// ---------------------------------------------------------------------------

function AmericanoPadel() {
  const [booted, setBooted] = useState(false);
  const [currentUser, setCurrentUser] = useState(null); // {accountId, username} | null
  const [friends, setFriends] = useState([]); // [{accountId, username, avatarUrl}]
  const [friendRequests, setFriendRequests] = useState([]); // [{accountId, username}] incoming
  const [screen, setScreen] = useState("lobby"); // lobby | setup | waiting | session | leaderboard | recap | stats
  const [lobby, setLobby] = useState([]); // [{id, name, updatedAt, playerCount, courts, roundsTotal, currentRound, role, status}]
  const [activeId, setActiveId] = useState(null);
  const [eventName, setEventName] = useState("");
  const [sessionRole, setSessionRole] = useState("owner"); // owner | participant (for the currently open session)
  const [status, setStatus] = useState("waiting"); // waiting | active (for the currently open session)
  const [maxParticipants, setMaxParticipants] = useState(8);
  const [pendingRequests, setPendingRequests] = useState([]); // [{id, name, accountId}]
  const [visibility, setVisibility] = useState("private"); // private | public
  const [courtCost, setCourtCost] = useState(""); // split bill — all optional
  const [adminFee, setAdminFee] = useState("");
  const [ballCost, setBallCost] = useState("");
  const [hostPlaying, setHostPlaying] = useState(false);
  const [coHostIds, setCoHostIds] = useState([]); // accountIds granted co-host (edit) access
  const [ownerId, setOwnerId] = useState(null);
  const [ownerUsername, setOwnerUsername] = useState("");
  const [publicEvents, setPublicEvents] = useState([]);
  const [pendingJoinId] = useState(() => new URLSearchParams(window.location.search).get("join"));
  const [hostInvitations, setHostInvitations] = useState([]); // [{id, accountId, username}] sent by host, awaiting the friend's accept

  // Setup state
  const [players, setPlayers] = useState([]); // [{id, name, accountId?}]
  const [nameInput, setNameInput] = useState("");
  const [bulkInput, setBulkInput] = useState("");
  const [courts, setCourts] = useState(2);
  const [mode, setMode] = useState("duration"); // duration | rounds
  const [totalMinutes, setTotalMinutes] = useState(120);
  const [minutesPerRound, setMinutesPerRound] = useState(7);
  const [breakMinutes, setBreakMinutes] = useState(0);
  const [manualRounds, setManualRounds] = useState(8);
  const [startTime, setStartTime] = useState("19:00");
  const [scoreFormat, setScoreFormat] = useState("points"); // points | tennis
  const [pointTarget, setPointTarget] = useState(21);
  const [tennisTarget, setTennisTarget] = useState(4); // race to N games
  const [ended, setEnded] = useState(false);

  // Session state (post-generate)
  const [engine, setEngine] = useState(null);
  const [playerMap, setPlayerMap] = useState({});
  const [currentRound, setCurrentRound] = useState(0);
  const [scores, setScores] = useState({});

  const clearJoinParam = () => {
    try {
      const url = new URL(window.location.href);
      url.searchParams.delete("join");
      window.history.replaceState({}, "", url.toString());
    } catch (e) {
      /* no-op */
    }
  };

  // Lobby entries for events you JOINED (role: participant) are a snapshot
  // taken at join time. This re-fetches the live session for each of those
  // so status/ended/round progress reflect what the host has actually done
  // (fixes: participant's lobby still showing "waiting" after host ended it).
  // Owner's own entries are always kept fresh by persist(), so they're left
  // as-is here to avoid extra reads.
  const refreshLobbyFor = async (accountId) => {
    const list = await loadLobbyIndex(accountId);
    const refreshed = await Promise.all(
      list.map(async (entry) => {
        if ((entry.role || "owner") === "owner") return entry;
        const data = await loadSessionData(entry.id);
        if (!data) return entry;
        return {
          ...entry,
          name: data.name || entry.name,
          playerCount: (data.players || []).length,
          courts: data.courts,
          roundsTotal: data.engine ? data.engine.roundsData.length : 0,
          currentRound: data.currentRound || 0,
          ended: !!data.ended,
          status: data.status || (data.engine ? "active" : "waiting"),
          ownerUsername: data.ownerUsername || entry.ownerUsername,
          updatedAt: data.updatedAt || entry.updatedAt,
        };
      })
    );
    const sorted = refreshed.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    setLobby(sorted);
    saveLobbyIndex(accountId, sorted);
    return sorted;
  };

  // On mount, auto-login if this device already has a remembered account.
  // If the URL carries an invite (?join=<id>), process it right after login.
  useEffect(() => {
    (async () => {
      const remembered = loadRememberedLogin();
      if (remembered) {
        const fresh = await getUserAccount(remembered.accountId);
        const me = fresh
          ? { accountId: fresh.accountId, username: fresh.username, avatarUrl: fresh.avatarUrl || null }
          : remembered;
        setCurrentUser(me);
        if (pendingJoinId) {
          await handleJoinViaLink(pendingJoinId, me);
          clearJoinParam();
        } else {
          await refreshLobbyFor(me.accountId);
          await refreshFriends(me.accountId);
        }
      }
      setBooted(true);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleAuthenticated = async (account) => {
    const me = { accountId: account.accountId, username: account.username, avatarUrl: account.avatarUrl || null };
    setCurrentUser(me);
    if (pendingJoinId) {
      await handleJoinViaLink(pendingJoinId, me);
      clearJoinParam();
    } else {
      await refreshLobbyFor(me.accountId);
      await refreshFriends(me.accountId);
      setScreen("lobby");
    }
  };

  const handleChangeAvatar = async (file) => {
    if (!currentUser) return;
    try {
      const dataUrl = await processImageToAvatar(file);
      await updateUserAvatar(currentUser.accountId, dataUrl);
      setCurrentUser((u) => (u ? { ...u, avatarUrl: dataUrl } : u));
    } catch (e) {
      alert("Gagal memproses foto. Coba gambar lain.");
    }
  };

  const refreshFriends = async (accountId) => {
    const id = accountId || currentUser?.accountId;
    if (!id) return;
    const { friends: f, incoming } = await loadFriendsData(id);
    setFriends(f);
    setFriendRequests(incoming);
  };

  const handleSendFriendRequest = async (toAccountId) => {
    if (!currentUser) return;
    const ok = await sendFriendRequest(toAccountId, currentUser.accountId, currentUser.username);
    if (!ok) {
      alert("Sudah berteman atau permintaan sudah terkirim sebelumnya.");
    }
    return ok;
  };

  const handleRespondFriendRequest = async (fromAccountId, accept) => {
    if (!currentUser) return;
    await respondFriendRequest(currentUser.accountId, fromAccountId, accept);
    await refreshFriends();
  };

  const handleOpenFriends = async () => {
    await refreshFriends();
    setScreen("friends");
  };

  // Host sends an invitation to a friend — this does NOT add them as a
  // player yet. It creates a pending invitation on the session, and drops a
  // "diundang" entry into the friend's OWN lobby so they see it and can
  // Accept/Decline themselves (see handleRespondInvitation).
  const handleInviteFriendAsPlayer = async (friend) => {
    const alreadyPlayer = players.some((p) => p.accountId === friend.accountId);
    const alreadyInvited = hostInvitations.some((i) => i.accountId === friend.accountId);
    if (alreadyPlayer || alreadyInvited || !activeId) return;

    const newInvitations = [
      ...hostInvitations,
      { id: uid(), accountId: friend.accountId, username: friend.username },
    ];
    setHostInvitations(newInvitations);
    persist({ hostInvitations: newInvitations });

    const theirList = await loadLobbyIndex(friend.accountId);
    const alreadyListed = theirList.some((e) => e.id === activeId);
    if (!alreadyListed) {
      const entry = {
        id: activeId,
        name: eventName || "Sesi Padel",
        updatedAt: Date.now(),
        createdAt: Date.now(),
        playerCount: players.length,
        courts,
        roundsTotal: engine ? engine.roundsData.length : 0,
        currentRound: 0,
        ended: false,
        role: "invited",
        status,
        ownerUsername: ownerUsername || currentUser?.username || "",
      };
      await saveLobbyIndex(friend.accountId, [entry, ...theirList]);
    }
  };

  // Host cancels an invitation that hasn't been accepted/declined yet.
  const handleCancelInvitation = async (accountId) => {
    const newInvitations = hostInvitations.filter((i) => i.accountId !== accountId);
    setHostInvitations(newInvitations);
    persist({ hostInvitations: newInvitations });
    const theirList = await loadLobbyIndex(accountId);
    await saveLobbyIndex(accountId, theirList.filter((e) => e.id !== activeId));
  };

  // Called by the INVITED friend from their own Lobby, to accept or decline
  // a host's invitation to join as a player.
  const handleRespondInvitation = async (sessionId, accept) => {
    if (!currentUser) return;
    const data = await loadSessionData(sessionId);
    if (!data) {
      await refreshLobbyFor(currentUser.accountId);
      return;
    }
    const newInvitations = (data.hostInvitations || []).filter(
      (i) => i.accountId !== currentUser.accountId
    );
    if (accept) {
      const already = (data.players || []).some((p) => p.accountId === currentUser.accountId);
      const newPlayers = already
        ? data.players || []
        : [
            ...(data.players || []),
            { id: uid(), name: currentUser.username, accountId: currentUser.accountId },
          ];
      await saveSessionData(sessionId, {
        ...data,
        players: newPlayers,
        hostInvitations: newInvitations,
        updatedAt: Date.now(),
      });
    } else {
      await saveSessionData(sessionId, {
        ...data,
        hostInvitations: newInvitations,
        updatedAt: Date.now(),
      });
    }

    const myList = await loadLobbyIndex(currentUser.accountId);
    if (accept) {
      const nextList = myList.map((e) =>
        e.id === sessionId ? { ...e, role: "participant" } : e
      );
      await saveLobbyIndex(currentUser.accountId, nextList);
      setLobby(nextList.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)));
    } else {
      const nextList = myList.filter((e) => e.id !== sessionId);
      await saveLobbyIndex(currentUser.accountId, nextList);
      setLobby(nextList.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)));
    }
  };

  const handleLogout = () => {
    if (!window.confirm("Keluar dari akun ini?")) return;
    forgetLogin();
    setCurrentUser(null);
    setLobby([]);
    resetSetupForm();
    setActiveId(null);
    setScreen("lobby");
  };

  // A registered user opened someone else's invite link (?join=<id>). Adds
  // them as a participant (both into the session's player list, if it's
  // still gathering players, and into their own account's lobby/history),
  // then opens the event for them in read-only mode.
  const handleJoinViaLink = async (id, me) => {
    const account = me || currentUser;
    if (!account) return;
    const data = await loadSessionData(id);
    if (!data) {
      alert("Link acara ini tidak valid atau sudah dihapus.");
      setScreen("lobby");
      return;
    }
    const isOwner = data.ownerId === account.accountId;
    let current = data;

    if (!isOwner && (data.status || "waiting") === "waiting") {
      const alreadyPlayer = (data.players || []).some((p) => p.accountId === account.accountId);
      const alreadyPending = (data.pendingRequests || []).some((p) => p.accountId === account.accountId);
      if (!alreadyPlayer && !alreadyPending) {
        const newPending = [
          ...(data.pendingRequests || []),
          { id: uid(), name: account.username, accountId: account.accountId },
        ];
        current = { ...data, pendingRequests: newPending, updatedAt: Date.now() };
        await saveSessionData(id, current);
      }
    }

    if (!isOwner) {
      const myList = await loadLobbyIndex(account.accountId);
      const alreadyListed = myList.some((e) => e.id === id);
      let nextList = myList;
      if (!alreadyListed) {
        const entry = {
          id,
          name: current.name || "Sesi Padel",
          updatedAt: current.updatedAt || Date.now(),
          createdAt: current.updatedAt || Date.now(),
          playerCount: (current.players || []).length,
          courts: current.courts,
          roundsTotal: current.engine ? current.engine.roundsData.length : 0,
          currentRound: current.currentRound || 0,
          ended: !!current.ended,
          role: "participant",
          status: current.status || (current.engine ? "active" : "waiting"),
          ownerUsername: current.ownerUsername || "",
        };
        nextList = [entry, ...myList];
        await saveLobbyIndex(account.accountId, nextList);
      }
      setLobby(nextList.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)));
    } else {
      const myList = await loadLobbyIndex(account.accountId);
      setLobby(myList.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)));
    }

    setEventName(current.name || "Sesi Padel");
    setPlayers(current.players || []);
    setCourts(current.courts || 2);
    setMode(current.mode || "duration");
    setTotalMinutes(current.totalMinutes ?? 120);
    setMinutesPerRound(current.minutesPerRound ?? 7);
    setBreakMinutes(current.breakMinutes ?? 0);
    setManualRounds(current.manualRounds ?? 8);
    setStartTime(current.startTime || "19:00");
    setScoreFormat(current.scoreFormat || "points");
    setPointTarget(current.pointTarget ?? 21);
    setTennisTarget(current.tennisTarget ?? 4);
    setMaxParticipants(current.maxParticipants ?? 8);
    setVisibility(current.visibility || "private");
    setHostPlaying(!!current.hostPlaying);
    setCoHostIds(current.coHostIds || []);
    setOwnerId(current.ownerId || null);
    setOwnerUsername(current.ownerUsername || "");
    setPendingRequests(current.pendingRequests || []);
    setHostInvitations(current.hostInvitations || []);
    setEnded(!!current.ended);
    setEngine(current.engine || null);
    setPlayerMap(current.playerMap || {});
    setCurrentRound(current.currentRound || 0);
    setScores(current.scores || {});
    setStatus(current.status || (current.engine ? "active" : "waiting"));
    setSessionRole(isOwner ? "owner" : "participant");
    lastAppliedRef.current = current.updatedAt || Date.now();
    setActiveId(id);
    setScreen(current.engine ? "session" : "waiting");
  };

  const lastAppliedRef = useRef(0);

  // Poll shared storage every few seconds so everyone watching the app
  // (different phones) stays in sync: lobby list while browsing, or the
  // active session's round/scores while inside one.
  useEffect(() => {
    if (!currentUser) return;
    const interval = setInterval(async () => {
      if (screen === "lobby") {
        const list = await loadLobbyIndex(currentUser.accountId);
        setLobby(list.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)));
      } else if (activeId) {
        const saved = await loadSessionData(activeId);
        if (saved && (saved.updatedAt || 0) > lastAppliedRef.current) {
          lastAppliedRef.current = saved.updatedAt || Date.now();
          setPlayers(saved.players || []);
          setPendingRequests(saved.pendingRequests || []);
          setHostInvitations(saved.hostInvitations || []);
          setStatus(saved.status || (saved.engine ? "active" : "waiting"));
          setMaxParticipants(saved.maxParticipants ?? 8);
          setHostPlaying(!!saved.hostPlaying);
          setCoHostIds(saved.coHostIds || []);
          setEngine(saved.engine || null);
          setPlayerMap(saved.playerMap || {});
          setCurrentRound(saved.currentRound || 0);
          setScores(saved.scores || {});
          setScoreFormat(saved.scoreFormat || "points");
          setPointTarget(saved.pointTarget ?? 21);
          setTennisTarget(saved.tennisTarget ?? 4);
          setEnded(!!saved.ended);
          if (saved.engine && screen === "waiting") {
            setScreen("session");
          }
        }
      }
    }, 4000);
    return () => clearInterval(interval);
  }, [screen, activeId, currentUser]);

  const persist = useCallback(
    (partial, idOverride) => {
      const id = idOverride || activeId;
      if (!id || !currentUser) return;
      const updatedAt = Date.now();
      lastAppliedRef.current = updatedAt;
      const snapshot = {
        id,
        ownerId: ownerId || currentUser.accountId,
        ownerUsername: ownerUsername || currentUser.username,
        name: eventName,
        status,
        visibility,
        hostPlaying,
        coHostIds,
        courtCost,
        adminFee,
        ballCost,
        maxParticipants,
        pendingRequests,
        hostInvitations,
        players,
        courts,
        mode,
        totalMinutes,
        minutesPerRound,
        breakMinutes,
        manualRounds,
        startTime,
        scoreFormat,
        pointTarget,
        tennisTarget,
        ended,
        engine,
        playerMap,
        currentRound,
        scores,
        ...partial,
        updatedAt,
      };
      saveSessionData(id, snapshot);
      syncPublicEventEntry(snapshot);
      const theOwnerId = snapshot.ownerId;
      const entry = {
        id,
        name: snapshot.name || "Sesi Padel",
        updatedAt,
        playerCount: (snapshot.players || []).length,
        courts: snapshot.courts,
        roundsTotal: snapshot.engine ? snapshot.engine.roundsData.length : 0,
        currentRound: snapshot.currentRound || 0,
        ended: !!snapshot.ended,
        status: snapshot.status,
        role: "owner",
      };
      if (currentUser.accountId === theOwnerId) {
        // I'm the true owner — update my own visible lobby state right away.
        setLobby((prev) => {
          const existing = prev.find((e) => e.id === id);
          const merged = { ...entry, createdAt: existing?.createdAt || updatedAt };
          const next = existing ? prev.map((e) => (e.id === id ? merged : e)) : [merged, ...prev];
          saveLobbyIndex(theOwnerId, next);
          return next;
        });
      } else {
        // I'm a co-host editing someone else's event — keep the actual
        // owner's lobby entry fresh too, without touching my own lobby list
        // (my own "participant" entry there is maintained separately).
        (async () => {
          const ownerList = await loadLobbyIndex(theOwnerId);
          const existing = ownerList.find((e) => e.id === id);
          const merged = { ...entry, createdAt: existing?.createdAt || updatedAt };
          const next = existing ? ownerList.map((e) => (e.id === id ? merged : e)) : [merged, ...ownerList];
          await saveLobbyIndex(theOwnerId, next);
        })();
      }
      return;
    },
    [activeId, currentUser, ownerId, ownerUsername, eventName, status, visibility, hostPlaying, coHostIds, courtCost, adminFee, ballCost, maxParticipants, pendingRequests, hostInvitations, players, courts, mode, totalMinutes, minutesPerRound, breakMinutes, manualRounds, startTime, scoreFormat, pointTarget, tennisTarget, ended, engine, playerMap, currentRound, scores]
  );

  const addPlayerFromInput = () => {
    const name = nameInput.trim();
    if (!name) return;
    setPlayers((p) => {
      const next = [...p, { id: uid(), name }];
      persist({ players: next });
      return next;
    });
    setNameInput("");
  };

  const addBulk = () => {
    const names = bulkInput
      .split(/[\n,]/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (!names.length) return;
    setPlayers((p) => {
      const next = [...p, ...names.map((name) => ({ id: uid(), name }))];
      persist({ players: next });
      return next;
    });
    setBulkInput("");
  };

  const removePlayer = (id) =>
    setPlayers((p) => {
      const next = p.filter((x) => x.id !== id);
      persist({ players: next });
      return next;
    });

  const computedRounds =
    mode === "duration"
      ? Math.max(1, Math.floor(totalMinutes / (minutesPerRound + breakMinutes)))
      : Math.max(1, manualRounds);

  // PHASE A — create the meeting "concept" (courts, duration, score format,
  // target participant count) and move to the waiting room to gather players.
  const handleCreateConcept = () => {
    const id = activeId || uid();
    const finalName = eventName.trim() || "Sesi Padel";
    setActiveId(id);
    setEventName(finalName);
    setStatus("waiting");
    setSessionRole("owner");
    setPendingRequests([]);
    setHostInvitations([]);
    setHostPlaying(false);
    setCoHostIds([]);
    setOwnerId(currentUser?.accountId || null);
    setOwnerUsername(currentUser?.username || "");
    setScreen("waiting");
    persist(
      {
        name: finalName,
        status: "waiting",
        visibility,
        hostPlaying: false,
        coHostIds: [],
        courtCost,
        adminFee,
        ballCost,
        maxParticipants,
        pendingRequests: [],
        hostInvitations: [],
        players: [],
        ownerId: currentUser?.accountId || null,
        ownerUsername: currentUser?.username || "",
        engine: null,
        playerMap: {},
        currentRound: 0,
        scores: {},
      },
      id
    );
  };

  // Host toggles whether they're joining as a player themselves. When turned
  // on, their own name is added straight to the player list (tagged with
  // their accountId so it's identifiable); turning it off removes just that
  // auto-added entry, leaving any manually-typed names untouched.
  const handleToggleHostPlaying = () => {
    const next = !hostPlaying;
    setHostPlaying(next);
    let newPlayers;
    if (next) {
      const already = players.some((p) => p.accountId === currentUser?.accountId);
      newPlayers = already
        ? players
        : [...players, { id: uid(), name: currentUser.username, accountId: currentUser.accountId }];
    } else {
      newPlayers = players.filter((p) => p.accountId !== currentUser?.accountId);
    }
    setPlayers(newPlayers);
    persist({ hostPlaying: next, players: newPlayers });
  };

  // PHASE B — once participants are settled (manual names and/or people who
  // joined via invite link and got approved), the host locks it in and the
  // schedule is built.
  const handleFinalizeAndGenerate = () => {
    if (
      pendingRequests.length > 0 &&
      !window.confirm(
        `Masih ada ${pendingRequests.length} permintaan bergabung yang belum diproses. Tetap lanjutkan tanpa mereka?`
      )
    ) {
      return;
    }
    const ids = players.map((p) => p.id);
    const map = {};
    players.forEach((p) => (map[p.id] = p.name));
    const result = generateSchedule(ids, courts, computedRounds);
    setEngine(result);
    setPlayerMap(map);
    setCurrentRound(0);
    setScores({});
    setStatus("active");
    setScreen("session");
    persist({
      status: "active",
      players,
      engine: result,
      playerMap: map,
      currentRound: 0,
      scores: {},
    });
  };

  const handleApproveRequest = (reqId) => {
    const req = pendingRequests.find((r) => r.id === reqId);
    if (!req) return;
    const newPlayers = [...players, { id: req.id, name: req.name, accountId: req.accountId }];
    const newPending = pendingRequests.filter((r) => r.id !== reqId);
    setPlayers(newPlayers);
    setPendingRequests(newPending);
    persist({ players: newPlayers, pendingRequests: newPending });
  };

  const handleRejectRequest = (reqId) => {
    const newPending = pendingRequests.filter((r) => r.id !== reqId);
    setPendingRequests(newPending);
    persist({ pendingRequests: newPending });
  };

  // Owner-only: grant/revoke co-host (same edit access as host) to a
  // participant. Only participants who joined via a registered account
  // (i.e. have an accountId) can be made co-host.
  const handleToggleCoHost = (accountId) => {
    if (!accountId) return;
    const next = coHostIds.includes(accountId)
      ? coHostIds.filter((id) => id !== accountId)
      : [...coHostIds, accountId];
    setCoHostIds(next);
    persist({ coHostIds: next });
  };

  const resetSetupForm = () => {
    setPlayers([]);
    setNameInput("");
    setBulkInput("");
    setCourts(2);
    setMode("duration");
    setTotalMinutes(120);
    setMinutesPerRound(7);
    setBreakMinutes(0);
    setManualRounds(8);
    setStartTime("19:00");
    setScoreFormat("points");
    setPointTarget(21);
    setTennisTarget(4);
    setMaxParticipants(8);
    setPendingRequests([]);
    setHostInvitations([]);
    setVisibility("private");
    setHostPlaying(false);
    setCoHostIds([]);
    setCourtCost("");
    setAdminFee("");
    setBallCost("");
    setOwnerId(null);
    setOwnerUsername("");
    setEngine(null);
    setPlayerMap({});
    setCurrentRound(0);
    setScores({});
    setEventName("");
    setEnded(false);
    setStatus("waiting");
    setSessionRole("owner");
  };

  const handleCreateNew = () => {
    resetSetupForm();
    setActiveId(null);
    setScreen("setup");
  };

  const handleOpenSession = async (id) => {
    const data = await loadSessionData(id);
    if (!data) return;
    setEventName(data.name || "Sesi Padel");
    setPlayers(data.players || []);
    setCourts(data.courts || 2);
    setMode(data.mode || "duration");
    setTotalMinutes(data.totalMinutes ?? 120);
    setMinutesPerRound(data.minutesPerRound ?? 7);
    setBreakMinutes(data.breakMinutes ?? 0);
    setManualRounds(data.manualRounds ?? 8);
    setStartTime(data.startTime || "19:00");
    setScoreFormat(data.scoreFormat || "points");
    setPointTarget(data.pointTarget ?? 21);
    setTennisTarget(data.tennisTarget ?? 4);
    setMaxParticipants(data.maxParticipants ?? 8);
    setPendingRequests(data.pendingRequests || []);
    setHostInvitations(data.hostInvitations || []);
    setVisibility(data.visibility || "private");
    setHostPlaying(!!data.hostPlaying);
    setCoHostIds(data.coHostIds || []);
    setCourtCost(data.courtCost ?? "");
    setAdminFee(data.adminFee ?? "");
    setBallCost(data.ballCost ?? "");
    setOwnerId(data.ownerId || null);
    setOwnerUsername(data.ownerUsername || "");
    setEnded(!!data.ended);
    setEngine(data.engine || null);
    setPlayerMap(data.playerMap || {});
    setCurrentRound(data.currentRound || 0);
    setScores(data.scores || {});
    const st = data.status || (data.engine ? "active" : "waiting");
    setStatus(st);
    setSessionRole(!currentUser || data.ownerId === currentUser.accountId ? "owner" : "participant");
    lastAppliedRef.current = data.updatedAt || Date.now();
    setActiveId(id);
    setScreen(data.engine ? "session" : "waiting");
  };

  const handleRefreshLobby = async () => {
    if (!currentUser) return;
    await refreshLobbyFor(currentUser.accountId);
  };

  const handleOpenDiscover = async () => {
    const list = await loadPublicEvents();
    const filtered = list.filter((e) => e.ownerId !== currentUser?.accountId);
    setPublicEvents(filtered.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)));
    setScreen("discover");
  };

  const handleBackToLobby = async () => {
    setScreen("lobby");
    if (!currentUser) return;
    await refreshLobbyFor(currentUser.accountId);
  };

  const handleDeleteSession = async (id) => {
    if (!window.confirm("Hapus acara ini beserta seluruh jadwal & skornya?")) return;
    await deleteSessionData(id);
    await removePublicEventEntry(id);
    setLobby((prev) => {
      const next = prev.filter((e) => e.id !== id);
      if (currentUser) saveLobbyIndex(currentUser.accountId, next);
      return next;
    });
    if (activeId === id) {
      resetSetupForm();
      setActiveId(null);
      setScreen("lobby");
    }
  };

  // For a session you joined (not own) — only removes it from YOUR OWN lobby
  // list, the actual event/session is untouched for the host and others.
  const handleLeaveEntry = async (id) => {
    if (!window.confirm("Keluar dari daftar acara ini di akunmu? Acara tetap ada untuk host.")) return;
    if (!currentUser) return;
    setLobby((prev) => {
      const next = prev.filter((e) => e.id !== id);
      saveLobbyIndex(currentUser.accountId, next);
      return next;
    });
    if (activeId === id) {
      resetSetupForm();
      setActiveId(null);
      setScreen("lobby");
    }
  };

  const handleEndEvent = () => {
    if (
      !window.confirm(
        "Akhiri acara ini sekarang? Klasemen akan dikunci berdasarkan skor yang sudah diisi, walau belum semua ronde selesai dimainkan."
      )
    )
      return;
    setEnded(true);
    persist({ ended: true });
    const totalCost = (Number(courtCost) || 0) + (Number(adminFee) || 0) + (Number(ballCost) || 0);
    setScreen(totalCost > 0 ? "splitbill" : "leaderboard");
  };

  const goRound = (delta) => {
    if (!engine) return;
    const next = Math.min(Math.max(0, currentRound + delta), engine.roundsData.length - 1);
    setCurrentRound(next);
    persist({ currentRound: next });
  };

  const goToRound = (idx) => {
    if (!engine) return;
    const next = Math.min(Math.max(0, idx), engine.roundsData.length - 1);
    setCurrentRound(next);
    persist({ currentRound: next });
  };

  const setScore = (courtIdx, side, value) => {
    const key = `${currentRound}-${courtIdx}`;
    setScores((prev) => {
      const updated = {
        ...prev,
        [key]: { format: "points", ...(prev[key] || {}), [side]: value },
      };
      persist({ scores: updated });
      return updated;
    });
  };

  // Picks a score for one side (via the number helper) and auto-fills the
  // other side with the remainder, based on the chosen point target.
  const setPointsPair = (courtIdx, side, value) => {
    const key = `${currentRound}-${courtIdx}`;
    const other = Math.max(0, pointTarget - value);
    setScores((prev) => {
      const updated = {
        ...prev,
        [key]: {
          format: "points",
          a: side === "a" ? value : other,
          b: side === "b" ? value : other,
        },
      };
      persist({ scores: updated });
      return updated;
    });
  };

  const resetPointsScore = (courtIdx) => {
    const key = `${currentRound}-${courtIdx}`;
    setScores((prev) => {
      const updated = { ...prev };
      delete updated[key];
      persist({ scores: updated });
      return updated;
    });
  };

  const incrementTennisPoint = (courtIdx, side) => {
    const key = `${currentRound}-${courtIdx}`;
    setScores((prev) => {
      const cur = prev[key] || { format: "tennis", gamesA: 0, gamesB: 0, pointsA: 0, pointsB: 0 };
      let { gamesA, gamesB, pointsA, pointsB } = cur;
      if (side === "a") pointsA++;
      else pointsB++;
      if ((pointsA >= 4 || pointsB >= 4) && Math.abs(pointsA - pointsB) >= 2) {
        if (pointsA > pointsB) gamesA++;
        else gamesB++;
        pointsA = 0;
        pointsB = 0;
      }
      const updated = { ...prev, [key]: { format: "tennis", gamesA, gamesB, pointsA, pointsB } };
      persist({ scores: updated });
      return updated;
    });
  };

  const resetTennisMatch = (courtIdx) => {
    const key = `${currentRound}-${courtIdx}`;
    setScores((prev) => {
      const updated = { ...prev, [key]: { format: "tennis", gamesA: 0, gamesB: 0, pointsA: 0, pointsB: 0 } };
      persist({ scores: updated });
      return updated;
    });
  };

  // Lets the host/co-host directly set the final game tally (e.g. 4-2)
  // without tapping through every point. Resets in-game point progress.
  const setTennisGamesDirect = (courtIdx, side, value) => {
    const key = `${currentRound}-${courtIdx}`;
    setScores((prev) => {
      const cur = prev[key] || { format: "tennis", gamesA: 0, gamesB: 0, pointsA: 0, pointsB: 0 };
      const updated = {
        ...prev,
        [key]: {
          ...cur,
          format: "tennis",
          gamesA: side === "a" ? value : cur.gamesA || 0,
          gamesB: side === "b" ? value : cur.gamesB || 0,
          pointsA: 0,
          pointsB: 0,
        },
      };
      persist({ scores: updated });
      return updated;
    });
  };

  const leaderboard = React.useMemo(
    () => buildLeaderboard(engine, playerMap, scores),
    [engine, playerMap, scores]
  );

  const fairnessStats = React.useMemo(() => {
    if (!engine) return [];
    const idToAccountId = {};
    players.forEach((p) => {
      idToAccountId[p.id] = p.accountId || null;
    });
    const ids = Object.keys(playerMap);
    return ids
      .map((id) => {
        const partners = Object.values(engine.partner[id] || {}).filter((v) => v > 0).length;
        const opps = Object.values(engine.opp[id] || {}).filter((v) => v > 0).length;
        const accId = idToAccountId[id];
        const role = accId && accId === ownerId ? "host" : accId && coHostIds.includes(accId) ? "cohost" : null;
        return {
          id,
          name: playerMap[id],
          matches: engine.playCount[id] || 0,
          rests: engine.restCount[id] || 0,
          partners,
          opps,
          role,
        };
      })
      .sort((a, b) => b.matches - a.matches);
  }, [engine, playerMap, players, ownerId, coHostIds]);

  const handleShare = async () => {
    if (!engine) return;
    let text = `🎾 ${eventName || "JADWAL AMERICANO PADEL"}\n`;
    text += `Pemain: ${players.length} | Lapangan: ${engine.usableCourts} | Ronde: ${engine.roundsData.length}\n\n`;
    engine.roundsData.forEach((rd, rIdx) => {
      const [h, m] = startTime.split(":").map(Number);
      const totalMins = h * 60 + m + rIdx * (minutesPerRound + breakMinutes);
      const t1 = fmtClock(((totalMins % 1440) + 1440) % 1440);
      text += `Ronde ${rIdx + 1} (${t1})\n`;
      rd.courts.forEach((mt, cIdx) => {
        text += `  Lap.${cIdx + 1}: ${mt.team1.map((id) => playerMap[id]).join(" & ")} vs ${mt.team2
          .map((id) => playerMap[id])
          .join(" & ")}\n`;
      });
      if (rd.resting.length) {
        text += `  Istirahat: ${rd.resting.map((id) => playerMap[id]).join(", ")}\n`;
      }
      text += `\n`;
    });
    try {
      await navigator.clipboard.writeText(text);
      alert("Jadwal disalin! Tempel (paste) ke WhatsApp.");
    } catch (e) {
      console.log(text);
      alert("Gagal menyalin otomatis. Buka console untuk salin manual.");
    }
  };

  const handleCopyViewLink = async () => {
    if (!activeId) return;
    const url = new URL(window.location.href);
    url.search = `?s=${activeId}`;
    const link = url.toString();
    try {
      await navigator.clipboard.writeText(link);
      alert("Link pemantau (view only) disalin! Siapa saja yang buka link ini bisa lihat jadwal, klasemen & rekap match tanpa bisa mengubah skor.");
    } catch (e) {
      console.log(link);
      alert("Gagal menyalin otomatis. Buka console untuk salin manual.");
    }
  };

  if (!booted) {
    return (
      <div className="min-h-screen bg-slate-950 flex items-center justify-center">
        <div className="text-slate-500 text-sm font-mono2">memuat sesi…</div>
      </div>
    );
  }

  if (!currentUser) {
    return <AuthScreen onAuthenticated={handleAuthenticated} />;
  }

  const isCoHost = coHostIds.includes(currentUser.accountId);
  const canManage = sessionRole === "owner" || isCoHost;
  const hasSplitBill = (Number(courtCost) || 0) + (Number(adminFee) || 0) + (Number(ballCost) || 0) > 0;

  return (
    <div
      className="min-h-screen bg-slate-950 text-slate-100"
      style={{ fontFamily: "'Inter', ui-sans-serif, system-ui" }}
    >
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Teko:wght@500;600;700&family=Inter:wght@400;500;600;700;800&family=Space+Mono:wght@400;700&display=swap');
        .font-display { font-family: 'Teko', sans-serif; }
        .font-mono2 { font-family: 'Space Mono', monospace; }
      `}</style>

      <div className="max-w-md mx-auto relative">
      {screen === "lobby" && (
        <LobbyScreen
          lobby={lobby}
          onCreateNew={handleCreateNew}
          onOpen={handleOpenSession}
          onDelete={handleDeleteSession}
          onLeave={handleLeaveEntry}
          onDiscover={handleOpenDiscover}
          onRefresh={handleRefreshLobby}
          onChangeAvatar={handleChangeAvatar}
          onOpenFriends={handleOpenFriends}
          friendRequestCount={friendRequests.length}
          onRespondInvitation={handleRespondInvitation}
          currentUser={currentUser}
          onLogout={handleLogout}
        />
      )}

      {screen === "friends" && (
        <FriendsScreen
          friends={friends}
          friendRequests={friendRequests}
          onRespond={handleRespondFriendRequest}
          onBrowse={async () => {
            setScreen("browse-friends");
          }}
          onBackToLobby={handleBackToLobby}
        />
      )}

      {screen === "browse-friends" && (
        <BrowseFriendsScreen
          currentUser={currentUser}
          onSendRequest={handleSendFriendRequest}
          onBack={() => setScreen("friends")}
        />
      )}

      {screen === "discover" && (
        <PublicEventsScreen
          events={publicEvents}
          onJoinRequest={(id) => handleJoinViaLink(id)}
          onBackToLobby={handleBackToLobby}
        />
      )}

      {screen === "setup" && (
        <SetupScreen
          eventName={eventName}
          setEventName={setEventName}
          courts={courts}
          setCourts={setCourts}
          mode={mode}
          setMode={setMode}
          totalMinutes={totalMinutes}
          setTotalMinutes={setTotalMinutes}
          minutesPerRound={minutesPerRound}
          setMinutesPerRound={setMinutesPerRound}
          breakMinutes={breakMinutes}
          setBreakMinutes={setBreakMinutes}
          manualRounds={manualRounds}
          setManualRounds={setManualRounds}
          startTime={startTime}
          setStartTime={setStartTime}
          scoreFormat={scoreFormat}
          setScoreFormat={setScoreFormat}
          pointTarget={pointTarget}
          setPointTarget={setPointTarget}
          tennisTarget={tennisTarget}
          setTennisTarget={setTennisTarget}
          maxParticipants={maxParticipants}
          setMaxParticipants={setMaxParticipants}
          visibility={visibility}
          setVisibility={setVisibility}
          courtCost={courtCost}
          setCourtCost={setCourtCost}
          adminFee={adminFee}
          setAdminFee={setAdminFee}
          ballCost={ballCost}
          setBallCost={setBallCost}
          computedRounds={computedRounds}
          onGenerate={handleCreateConcept}
          onBackToLobby={handleBackToLobby}
        />
      )}

      {screen === "waiting" && (
        <WaitingRoomScreen
          eventName={eventName}
          activeId={activeId}
          isOwner={sessionRole === "owner"}
          canManage={canManage}
          myAccountId={currentUser?.accountId}
          players={players}
          nameInput={nameInput}
          setNameInput={setNameInput}
          bulkInput={bulkInput}
          setBulkInput={setBulkInput}
          addPlayerFromInput={addPlayerFromInput}
          addBulk={addBulk}
          removePlayer={removePlayer}
          maxParticipants={maxParticipants}
          courts={courts}
          computedRounds={computedRounds}
          pendingRequests={pendingRequests}
          onApprove={handleApproveRequest}
          onReject={handleRejectRequest}
          hostPlaying={hostPlaying}
          onToggleHostPlaying={handleToggleHostPlaying}
          coHostIds={coHostIds}
          onToggleCoHost={handleToggleCoHost}
          friends={friends}
          onInviteFriend={handleInviteFriendAsPlayer}
          onSendFriendRequest={handleSendFriendRequest}
          hostInvitations={hostInvitations}
          onCancelInvitation={handleCancelInvitation}
          courtCost={courtCost}
          setCourtCost={setCourtCost}
          adminFee={adminFee}
          setAdminFee={setAdminFee}
          ballCost={ballCost}
          setBallCost={setBallCost}
          onSaveCosts={() => persist({ courtCost, adminFee, ballCost })}
          onFinalize={handleFinalizeAndGenerate}
          onBackToLobby={handleBackToLobby}
          onDelete={() => handleDeleteSession(activeId)}
        />
      )}

      {screen === "session" && engine && (
        <SessionScreen
          eventName={eventName}
          isOwner={sessionRole === "owner"}
          canManage={canManage}
          engine={engine}
          playerMap={playerMap}
          currentRound={currentRound}
          goRound={goRound}
          goToRound={goToRound}
          scores={scores}
          setScore={setScore}
          setPointsPair={setPointsPair}
          resetPointsScore={resetPointsScore}
          scoreFormat={scoreFormat}
          pointTarget={pointTarget}
          tennisTarget={tennisTarget}
          incrementTennisPoint={incrementTennisPoint}
          resetTennisMatch={resetTennisMatch}
          setTennisGamesDirect={setTennisGamesDirect}
          ended={ended}
          hasSplitBill={hasSplitBill}
          onEndEvent={handleEndEvent}
          onNav={setScreen}
          onShare={handleShare}
          onCopyViewLink={handleCopyViewLink}
          onBackToLobby={handleBackToLobby}
          onDelete={() => handleDeleteSession(activeId)}
        />
      )}

      {screen === "leaderboard" && engine && (
        <LeaderboardScreen
          eventName={eventName}
          leaderboard={leaderboard}
          ended={ended}
          hasSplitBill={hasSplitBill}
          onNav={setScreen}
          onBackToLobby={handleBackToLobby}
        />
      )}

      {screen === "splitbill" && (
        <SplitBillScreen
          eventName={eventName}
          players={players}
          courtCost={courtCost}
          adminFee={adminFee}
          ballCost={ballCost}
          onNav={setScreen}
          onBackToLobby={handleBackToLobby}
        />
      )}

      {screen === "recap" && engine && (
        <RecapScreen
          eventName={eventName}
          engine={engine}
          playerMap={playerMap}
          scores={scores}
          scoreFormat={scoreFormat}
          tennisTarget={tennisTarget}
          hasSplitBill={hasSplitBill}
          onNav={setScreen}
          onBackToLobby={handleBackToLobby}
        />
      )}

      {screen === "stats" && engine && (
        <StatsScreen
          eventName={eventName}
          stats={fairnessStats}
          totalPlayers={players.length}
          hasSplitBill={hasSplitBill}
          onNav={setScreen}
          onBackToLobby={handleBackToLobby}
        />
      )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// BOTTOM NAV
// ---------------------------------------------------------------------------

function BottomNav({ active, onNav, showSplitBill }) {
  const items = [
    { key: "session", label: "Jadwal", icon: Clock },
    { key: "leaderboard", label: "Klasemen", icon: Trophy },
    { key: "recap", label: "Rekap", icon: ClipboardList },
    { key: "stats", label: "Statistik", icon: BarChart3 },
    ...(showSplitBill ? [{ key: "splitbill", label: "Split Bill", icon: Wallet }] : []),
  ];
  return (
    <div className="fixed bottom-0 left-0 right-0 bg-slate-950/95 backdrop-blur border-t border-slate-800 flex z-20 max-w-md mx-auto">
      {items.map(({ key, label, icon: Icon }) => (
        <button
          key={key}
          onClick={() => onNav(key)}
          className={`flex-1 py-3 flex flex-col items-center gap-1 ${
            active === key ? "text-lime-300" : "text-slate-500"
          }`}
        >
          <Icon size={20} strokeWidth={active === key ? 2.5 : 2} />
          <span className="text-[11px] font-semibold">{label}</span>
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// LOBBY SCREEN
// ---------------------------------------------------------------------------

function LobbyScreen({ lobby, onCreateNew, onOpen, onDelete, onLeave, onDiscover, onRefresh, onChangeAvatar, onOpenFriends, friendRequestCount, onRespondInvitation, currentUser, onLogout }) {
  const [accountCount, setAccountCount] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [uploadingAvatar, setUploadingAvatar] = useState(false);
  const fileInputRef = useRef(null);

  useEffect(() => {
    (async () => {
      const n = await countRegisteredAccounts();
      setAccountCount(n);
    })();
  }, []);

  const handleRefreshClick = async () => {
    setRefreshing(true);
    await onRefresh();
    setRefreshing(false);
  };

  const handleAvatarFile = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setUploadingAvatar(true);
    await onChangeAvatar(file);
    setUploadingAvatar(false);
  };

  return (
    <div className="pb-10">
      <div className="px-6 pt-14 pb-8 border-b border-slate-800 relative overflow-hidden">
        <div className="absolute -right-10 -top-10 w-40 h-40 rounded-full bg-lime-400/10 blur-2xl pointer-events-none" />
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <div className="w-2 h-2 rounded-full bg-lime-300" />
            <span className="text-xs font-semibold tracking-[0.2em] text-cyan-300 uppercase">
              Court Rotation Engine
            </span>
          </div>
        </div>
        <div className="flex items-center gap-2 mb-2">
          <button
            onClick={handleRefreshClick}
            disabled={refreshing}
            className="inline-flex items-center gap-1.5 text-sm font-semibold text-slate-200 border border-slate-700 rounded-full px-3.5 py-2 active:scale-95 transition-transform"
          >
            <RotateCcw size={15} className={refreshing ? "animate-spin" : ""} />
            {refreshing ? "memuat…" : "refresh"}
          </button>
          <button
            onClick={onLogout}
            className="inline-flex items-center gap-1.5 text-sm font-semibold text-slate-200 border border-slate-700 rounded-full px-3.5 py-2 active:scale-95 transition-transform"
          >
            <LogOut size={15} /> keluar
          </button>
        </div>
        <h1 className="font-display text-6xl leading-[0.85] text-slate-50 tracking-wide">
          AMERICANO
          <br />
          <span className="text-lime-300">SCHEDULER</span>
        </h1>
        {currentUser && (
          <button
            onClick={() => fileInputRef.current?.click()}
            className="flex items-center gap-2.5 mt-3"
          >
            <div className="relative">
              <Avatar name={currentUser.username} avatarUrl={currentUser.avatarUrl} size={36} />
              <div className="absolute -bottom-0.5 -right-0.5 w-4 h-4 rounded-full bg-lime-300 border-2 border-slate-950 flex items-center justify-center">
                {uploadingAvatar ? (
                  <RotateCcw size={8} className="text-slate-950 animate-spin" />
                ) : (
                  <Plus size={8} className="text-slate-950" strokeWidth={3} />
                )}
              </div>
            </div>
            <span className="text-sm text-slate-300 font-semibold">{currentUser.username}</span>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              onChange={handleAvatarFile}
              className="hidden"
            />
          </button>
        )}
        <p className="text-slate-400 text-sm mt-2 max-w-xs">
          Acara yang kamu buat maupun yang kamu ikuti (lewat undangan) muncul di sini.
        </p>
        {accountCount !== null && (
          <p className="text-[11px] text-slate-600 mt-2">{accountCount} akun terdaftar di app ini</p>
        )}
      </div>

      <div className="px-6 pt-6">
        <PrimaryButton onClick={onCreateNew} icon={Plus} className="w-full text-lg py-4">
          Buat Acara Baru
        </PrimaryButton>
      </div>

      <div className="px-6 pt-3">
        <GhostButton onClick={onDiscover} icon={Eye} className="w-full">
          Jelajahi Acara Publik
        </GhostButton>
      </div>

      <div className="px-6 pt-3">
        <button
          onClick={onOpenFriends}
          className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl font-semibold bg-slate-900 border border-slate-700 text-slate-200 active:scale-[0.98] transition-transform relative"
        >
          <Users size={16} strokeWidth={2.5} />
          Teman
          {friendRequestCount > 0 && (
            <span className="absolute -top-1.5 -right-1.5 min-w-[20px] h-5 px-1 rounded-full bg-red-500 text-white text-[11px] font-bold flex items-center justify-center border-2 border-slate-950">
              {friendRequestCount}
            </span>
          )}
        </button>
      </div>

      <div className="px-6 pt-6">
        <h2 className="font-display text-2xl tracking-wide text-slate-100 mb-3 flex items-center gap-2">
          <CalendarDays size={16} className="text-lime-300" /> Acara
        </h2>

        {lobby.length === 0 && (
          <div className="rounded-2xl border border-dashed border-slate-700 p-6 text-center">
            <p className="text-slate-500 text-sm">
              Belum ada acara. Tap "Buat Acara Baru" untuk mulai sesi Americano pertamamu.
            </p>
          </div>
        )}

        <div className="space-y-3">
          {lobby.map((ev) => {
            const started = ev.roundsTotal > 0;
            const isOwnerEntry = (ev.role || "owner") === "owner";
            const isInvited = ev.role === "invited";
            const waiting = ev.status === "waiting";

            if (isInvited) {
              return (
                <div
                  key={ev.id}
                  className="rounded-2xl border border-cyan-400/40 bg-cyan-400/5 overflow-hidden"
                >
                  <div className="px-4 py-4">
                    <div className="flex items-center gap-1.5 mb-1">
                      <Chip tone="cyan">Undangan</Chip>
                    </div>
                    <div className="font-semibold text-slate-100 truncate">{ev.name}</div>
                    <div className="text-[11px] text-slate-300 mt-1">
                      {ev.ownerUsername && `host: ${ev.ownerUsername} · `}
                      {ev.playerCount} pemain · {ev.courts} lapangan
                    </div>
                    <p className="text-xs text-slate-400 mt-2">
                      Kamu diundang untuk ikut jadi peserta acara ini.
                    </p>
                  </div>
                  <div className="flex border-t border-slate-800">
                    <button
                      onClick={() => onRespondInvitation(ev.id, true)}
                      className="flex-1 flex items-center justify-center gap-1.5 py-2.5 text-xs font-semibold text-slate-950 bg-lime-300"
                    >
                      <Check size={13} strokeWidth={3} /> Terima
                    </button>
                    <button
                      onClick={() => onRespondInvitation(ev.id, false)}
                      className="flex-1 flex items-center justify-center gap-1.5 py-2.5 text-xs font-semibold text-red-400 bg-slate-900 border-l border-slate-800"
                    >
                      <X size={13} strokeWidth={3} /> Tolak
                    </button>
                  </div>
                </div>
              );
            }

            return (
              <div
                key={ev.id}
                className="rounded-2xl border border-slate-800 bg-slate-900/50 overflow-hidden"
              >
                <button onClick={() => onOpen(ev.id)} className="w-full text-left px-4 py-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="font-semibold text-slate-100 truncate">{ev.name}</div>
                      <div className="text-[11px] text-slate-300 mt-1">
                        {ev.playerCount} pemain · {ev.courts} lapangan
                        {!isOwnerEntry && ev.ownerUsername && ` · host: ${ev.ownerUsername}`}
                      </div>
                    </div>
                    <ChevronRightCircle size={20} className="text-slate-600 shrink-0 mt-0.5" />
                  </div>
                  <div className="mt-3 flex flex-wrap gap-1.5">
                    <Chip tone={isOwnerEntry ? "cyan" : "slate"}>
                      {isOwnerEntry ? "Host" : "Peserta"}
                    </Chip>
                    {ev.ended ? (
                      <Chip tone="lime">
                        <Trophy size={11} /> Selesai
                      </Chip>
                    ) : waiting ? (
                      <Chip tone="amber">
                        <Clock size={11} /> Menunggu peserta
                      </Chip>
                    ) : started ? (
                      <Chip tone="lime">
                        <Clock size={11} /> Ronde {Math.min(ev.currentRound + 1, ev.roundsTotal)}/
                        {ev.roundsTotal}
                      </Chip>
                    ) : (
                      <Chip tone="slate">Belum dimulai</Chip>
                    )}
                  </div>
                </button>
                {isOwnerEntry ? (
                  <button
                    onClick={() => onDelete(ev.id)}
                    className="w-full flex items-center justify-center gap-1.5 py-2 text-[11px] text-red-400/70 border-t border-slate-800"
                  >
                    <Trash2 size={11} /> hapus acara
                  </button>
                ) : (
                  <button
                    onClick={() => onLeave(ev.id)}
                    className="w-full flex items-center justify-center gap-1.5 py-2 text-[11px] text-slate-500 border-t border-slate-800"
                  >
                    <LogOut size={11} /> keluar dari daftar
                  </button>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// PUBLIC EVENTS DISCOVERY SCREEN
// ---------------------------------------------------------------------------

function PublicEventsScreen({ events, onJoinRequest, onBackToLobby }) {
  return (
    <div className="pb-10">
      <div className="px-6 pt-14 pb-6 border-b border-slate-800">
        <button
          onClick={onBackToLobby}
          className="inline-flex items-center gap-1.5 text-sm font-semibold text-slate-200 border border-slate-700 rounded-full px-3.5 py-2 active:scale-95 transition-transform mb-4"
        >
          <ArrowLeft size={16} /> Lobby
        </button>
        <div className="flex items-center gap-2 mb-1">
          <Eye size={16} className="text-lime-300" />
          <span className="text-xs font-semibold tracking-[0.2em] text-cyan-300 uppercase">
            Discover
          </span>
        </div>
        <h1 className="font-display text-5xl text-slate-50">ACARA PUBLIK</h1>
        <p className="text-slate-500 text-sm mt-2">
          Acara yang dibuka untuk umum oleh host lain. Minta gabung — host akan meninjau
          permintaanmu sebelum kamu resmi jadi peserta.
        </p>
      </div>

      <div className="px-6 pt-4 space-y-3">
        {events.length === 0 && (
          <div className="rounded-2xl border border-dashed border-slate-700 p-6 text-center">
            <p className="text-slate-500 text-sm">Belum ada acara publik yang terbuka saat ini.</p>
          </div>
        )}

        {events.map((ev) => (
          <div
            key={ev.id}
            className="rounded-2xl border border-slate-800 bg-slate-900/50 overflow-hidden"
          >
            <div className="px-4 py-4">
              <div className="font-semibold text-slate-100 truncate">{ev.name}</div>
              <div className="text-[11px] text-slate-300 mt-1">
                host: {ev.ownerUsername || "-"} · {ev.playerCount}/{ev.maxParticipants} peserta ·{" "}
                {ev.courts} lapangan
              </div>
            </div>
            <button
              onClick={() => onJoinRequest(ev.id)}
              className="w-full flex items-center justify-center gap-1.5 py-2.5 text-xs font-semibold text-slate-950 bg-lime-300 border-t border-slate-800"
            >
              <Users size={12} /> Minta Gabung
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// FRIENDS SCREEN — friend list + incoming requests
// ---------------------------------------------------------------------------

function FriendsScreen({ friends, friendRequests, onRespond, onBrowse, onBackToLobby }) {
  return (
    <div className="pb-10">
      <div className="px-6 pt-14 pb-6 border-b border-slate-800">
        <button
          onClick={onBackToLobby}
          className="inline-flex items-center gap-1.5 text-sm font-semibold text-slate-200 border border-slate-700 rounded-full px-3.5 py-2 active:scale-95 transition-transform mb-4"
        >
          <ArrowLeft size={16} /> Lobby
        </button>
        <div className="flex items-center gap-2 mb-1">
          <Users size={16} className="text-lime-300" />
          <span className="text-xs font-semibold tracking-[0.2em] text-cyan-300 uppercase">
            Social
          </span>
        </div>
        <h1 className="font-display text-5xl text-slate-50">TEMAN</h1>
      </div>

      <div className="px-6 pt-6">
        <PrimaryButton onClick={onBrowse} icon={Users} className="w-full">
          Cari Teman
        </PrimaryButton>
      </div>

      {friendRequests.length > 0 && (
        <Section icon={Users} title="Permintaan Pertemanan" subtitle={`${friendRequests.length} baru`}>
          <div className="space-y-2">
            {friendRequests.map((r) => (
              <div
                key={r.accountId}
                className="flex items-center justify-between gap-3 rounded-xl border border-slate-800 bg-slate-900/50 px-4 py-3"
              >
                <span className="flex items-center gap-2 min-w-0">
                  <Avatar name={r.username} size={32} />
                  <span className="font-semibold text-slate-100 truncate">{r.username}</span>
                </span>
                <div className="flex gap-2 shrink-0">
                  <button
                    onClick={() => onRespond(r.accountId, true)}
                    className="w-8 h-8 rounded-lg bg-lime-300 text-slate-950 flex items-center justify-center"
                  >
                    <Check size={15} strokeWidth={3} />
                  </button>
                  <button
                    onClick={() => onRespond(r.accountId, false)}
                    className="w-8 h-8 rounded-lg bg-slate-800 border border-slate-700 text-red-400 flex items-center justify-center"
                  >
                    <X size={15} strokeWidth={3} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        </Section>
      )}

      <Section icon={Users} title="Daftar Teman" subtitle={`${friends.length} teman`}>
        {friends.length === 0 ? (
          <p className="text-slate-500 text-sm">
            Belum ada teman. Tap "Cari Teman" untuk mulai menambahkan.
          </p>
        ) : (
          <div className="grid grid-cols-4 gap-2">
            {friends.map((f) => (
              <div
                key={f.accountId}
                className="flex flex-col items-center gap-1.5 bg-slate-900 border border-slate-700 rounded-2xl px-1.5 pt-3 pb-2"
              >
                <Avatar name={f.username} avatarUrl={f.avatarUrl} size={56} />
                <span className="text-[11px] font-semibold text-slate-100 text-center leading-snug break-words">
                  {f.username}
                </span>
              </div>
            ))}
          </div>
        )}
      </Section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// BROWSE FRIENDS SCREEN — search all registered accounts, send requests
// ---------------------------------------------------------------------------

function BrowseFriendsScreen({ currentUser, onSendRequest, onBack }) {
  const [accounts, setAccounts] = useState(null); // null = loading
  const [query, setQuery] = useState("");
  const [sentTo, setSentTo] = useState({}); // accountId -> true (local optimistic state)

  useEffect(() => {
    (async () => {
      const list = await listAllAccounts(currentUser?.accountId);
      setAccounts(list);
    })();
  }, [currentUser]);

  const filtered = (accounts || []).filter((a) =>
    a.username.toLowerCase().includes(query.trim().toLowerCase())
  );

  const handleAdd = async (acc) => {
    const ok = await onSendRequest(acc.accountId);
    if (ok) setSentTo((s) => ({ ...s, [acc.accountId]: true }));
  };

  return (
    <div className="pb-10">
      <div className="px-6 pt-14 pb-6 border-b border-slate-800">
        <button
          onClick={onBack}
          className="inline-flex items-center gap-1.5 text-sm font-semibold text-slate-200 border border-slate-700 rounded-full px-3.5 py-2 active:scale-95 transition-transform mb-4"
        >
          <ArrowLeft size={16} /> Teman
        </button>
        <h1 className="font-display text-5xl text-slate-50">CARI TEMAN</h1>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Cari username…"
          className="w-full mt-4 bg-slate-900 border border-slate-700 rounded-xl px-4 py-3 text-sm placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-lime-400/50"
        />
      </div>

      <div className="px-6 pt-4 space-y-2">
        {accounts === null && <p className="text-slate-500 text-sm">Memuat…</p>}
        {accounts !== null && filtered.length === 0 && (
          <p className="text-slate-500 text-sm">Tidak ada pengguna yang cocok.</p>
        )}
        {filtered.map((acc) => {
          const requested = sentTo[acc.accountId] || acc.requestSentByMe;
          return (
            <div
              key={acc.accountId}
              className="flex items-center gap-3 rounded-xl border border-slate-800 bg-slate-900/40 px-4 py-3"
            >
              <Avatar name={acc.username} avatarUrl={acc.avatarUrl} size={40} />
              <span className="font-semibold text-slate-100 flex-1 min-w-0 truncate">
                {acc.username}
              </span>
              {acc.isFriend ? (
                <Chip tone="lime">
                  <Check size={11} /> teman
                </Chip>
              ) : requested ? (
                <Chip tone="slate">terkirim</Chip>
              ) : (
                <button
                  onClick={() => handleAdd(acc)}
                  className="px-3 py-1.5 rounded-full text-xs font-semibold bg-lime-300 text-slate-950"
                >
                  Tambah
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// SETUP SCREEN
// ---------------------------------------------------------------------------

function SetupScreen(props) {
  const {
    eventName, setEventName,
    courts, setCourts, mode, setMode,
    totalMinutes, setTotalMinutes, minutesPerRound, setMinutesPerRound,
    breakMinutes, setBreakMinutes, manualRounds, setManualRounds,
    startTime, setStartTime,
    scoreFormat, setScoreFormat, pointTarget, setPointTarget,
    tennisTarget, setTennisTarget,
    maxParticipants, setMaxParticipants,
    visibility, setVisibility,
    courtCost, setCourtCost, adminFee, setAdminFee, ballCost, setBallCost,
    computedRounds, onGenerate,
    onBackToLobby,
  } = props;

  return (
    <div className="pb-10">
      {/* HERO */}
      <div className="px-6 pt-14 pb-8 border-b border-slate-800 relative overflow-hidden">
        <div className="absolute -right-10 -top-10 w-40 h-40 rounded-full bg-lime-400/10 blur-2xl pointer-events-none" />
        <button
          onClick={onBackToLobby}
          className="inline-flex items-center gap-1.5 text-sm font-semibold text-slate-200 border border-slate-700 rounded-full px-3.5 py-2 active:scale-95 transition-transform mb-4"
        >
          <ArrowLeft size={16} /> Lobby
        </button>
        <div className="flex items-center gap-2 mb-2">
          <div className="w-2 h-2 rounded-full bg-lime-300" />
          <span className="text-xs font-semibold tracking-[0.2em] text-cyan-300 uppercase">
            Court Rotation Engine
          </span>
        </div>
        <h1 className="font-display text-6xl leading-[0.85] text-slate-50 tracking-wide">
          AMERICANO
          <br />
          <span className="text-lime-300">SCHEDULER</span>
        </h1>
        <p className="text-slate-400 text-sm mt-3 max-w-xs">
          Rotasi pasangan otomatis, istirahat merata, jadwal mengikuti durasi sewa lapangan —
          bukan target jumlah match.
        </p>
        <p className="text-[11px] text-cyan-300/80 mt-3 max-w-xs">
          🔗 Web based — siapa saja yang membuka link/app ini melihat sesi & skor yang sama secara
          real-time. Cukup bagikan link-nya ke grup.
        </p>
      </div>

      {/* EVENT NAME */}
      <Section icon={CalendarDays} title="Nama Acara">
        <input
          value={eventName}
          onChange={(e) => setEventName(e.target.value)}
          placeholder="mis. Padel Malam Jumat"
          className="w-full bg-slate-900 border border-slate-700 rounded-xl px-4 py-3 text-sm placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-lime-400/50"
        />
      </Section>


      {/* MAX PARTICIPANTS */}
      <Section icon={Users} title="Maks Peserta" subtitle="bisa disesuaikan nanti">
        <div className="flex items-center gap-4">
          <button
            onClick={() => setMaxParticipants((n) => Math.max(4, n - 1))}
            className="w-11 h-11 rounded-xl bg-slate-900 border border-slate-700 text-xl font-bold"
          >
            −
          </button>
          <div className="font-display text-5xl text-lime-300 w-14 text-center">{maxParticipants}</div>
          <button
            onClick={() => setMaxParticipants((n) => n + 1)}
            className="w-11 h-11 rounded-xl bg-slate-900 border border-slate-700 text-xl font-bold"
          >
            +
          </button>
          <div className="text-xs text-slate-400 ml-2 leading-tight">
            Cuma target — di halaman berikutnya jumlah peserta tetap bisa kurang/lebih dari ini.
          </div>
        </div>
      </Section>

      {/* VISIBILITY */}
      <Section icon={Eye} title="Privasi Acara">
        <div className="flex gap-2 mb-2">
          <ModeTab active={visibility === "private"} onClick={() => setVisibility("private")}>
            Private
          </ModeTab>
          <ModeTab active={visibility === "public"} onClick={() => setVisibility("public")}>
            Public
          </ModeTab>
        </div>
        <p className="text-xs text-slate-500">
          {visibility === "private"
            ? "Cuma orang yang kamu kirimi link undangan yang bisa lihat & minta gabung acara ini."
            : "Muncul di halaman \"Jelajahi Acara Publik\" — siapa saja bisa lihat & minta gabung, tetap butuh persetujuanmu."}
        </p>
      </Section>

      {/* SPLIT BILL COSTS (optional) */}
      <Section icon={Wallet} title="Biaya" subtitle="opsional, buat split bill">
        <p className="text-xs text-slate-500 mb-3">
          Kalau diisi, begitu acara di-"selesaikan" nanti otomatis muncul rincian split bill per
          pemain. Boleh dikosongkan.
        </p>
        <div className="space-y-3">
          <FieldRow label="Harga lapangan (Rp)">
            <input
              type="number"
              value={courtCost}
              onChange={(e) => setCourtCost(e.target.value)}
              placeholder="0"
              className="w-28 bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-right font-mono2"
            />
          </FieldRow>
          <FieldRow label="Biaya admin (Rp)">
            <input
              type="number"
              value={adminFee}
              onChange={(e) => setAdminFee(e.target.value)}
              placeholder="0"
              className="w-28 bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-right font-mono2"
            />
          </FieldRow>
          <FieldRow label="Biaya bola (Rp)">
            <input
              type="number"
              value={ballCost}
              onChange={(e) => setBallCost(e.target.value)}
              placeholder="0"
              className="w-28 bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-right font-mono2"
            />
          </FieldRow>
        </div>
      </Section>

      {/* COURTS */}
      <Section icon={Settings2} title="Lapangan" subtitle="Jumlah court yang disewa">
        <div className="flex items-center gap-4">
          <button
            onClick={() => setCourts((c) => Math.max(1, c - 1))}
            className="w-11 h-11 rounded-xl bg-slate-900 border border-slate-700 text-xl font-bold"
          >
            −
          </button>
          <div className="font-display text-5xl text-lime-300 w-14 text-center">{courts}</div>
          <button
            onClick={() => setCourts((c) => c + 1)}
            className="w-11 h-11 rounded-xl bg-slate-900 border border-slate-700 text-xl font-bold"
          >
            +
          </button>
          <div className="text-xs text-slate-400 ml-2 leading-tight">
            Bisa menampung <span className="text-slate-200 font-semibold">{courts * 4}</span> pemain
            main bersamaan
          </div>
        </div>
      </Section>

      {/* SCHEDULE MODE */}
      <Section icon={Clock} title="Durasi Permainan">
        <div className="flex gap-2 mb-4">
          <ModeTab active={mode === "duration"} onClick={() => setMode("duration")}>
            Berdasarkan Durasi
          </ModeTab>
          <ModeTab active={mode === "rounds"} onClick={() => setMode("rounds")}>
            Jumlah Ronde Manual
          </ModeTab>
        </div>

        {mode === "duration" ? (
          <div className="space-y-4">
            <FieldRow label="Total durasi sewa (menit)">
              <input
                type="number"
                value={totalMinutes}
                onChange={(e) => setTotalMinutes(Number(e.target.value))}
                className="w-24 bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-right font-mono2"
              />
            </FieldRow>
            <FieldRow label="Menit per ronde (1 match)">
              <input
                type="number"
                value={minutesPerRound}
                onChange={(e) => setMinutesPerRound(Number(e.target.value))}
                className="w-24 bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-right font-mono2"
              />
            </FieldRow>
            <FieldRow label="Jeda antar ronde (menit)">
              <input
                type="number"
                value={breakMinutes}
                onChange={(e) => setBreakMinutes(Number(e.target.value))}
                className="w-24 bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-right font-mono2"
              />
            </FieldRow>
          </div>
        ) : (
          <FieldRow label="Jumlah ronde">
            <input
              type="number"
              value={manualRounds}
              onChange={(e) => setManualRounds(Number(e.target.value))}
              className="w-24 bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-right font-mono2"
            />
          </FieldRow>
        )}

        <FieldRow label="Jam mulai (opsional)">
          <input
            type="time"
            value={startTime}
            onChange={(e) => setStartTime(e.target.value)}
            className="w-28 bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-right font-mono2"
          />
        </FieldRow>
      </Section>

      {/* SCORE FORMAT */}
      <Section icon={Trophy} title="Format Skor" subtitle="opsional">
        <div className="flex gap-2 mb-4">
          <ModeTab active={scoreFormat === "points"} onClick={() => setScoreFormat("points")}>
            Poin (Americano)
          </ModeTab>
          <ModeTab active={scoreFormat === "tennis"} onClick={() => setScoreFormat("tennis")}>
            Tenis (Game)
          </ModeTab>
        </div>

        {scoreFormat === "points" ? (
          <div className="space-y-3">
            <p className="text-xs text-slate-500">
              Tiap match dimainkan sampai salah satu tim mencapai target poin ini. Kamu tetap input
              skor akhir secara manual di layar sesi.
            </p>
            <div className="flex flex-wrap gap-2">
              {[16, 21, 24, 32].map((v) => (
                <button
                  key={v}
                  onClick={() => setPointTarget(v)}
                  className={`px-4 py-2 rounded-xl text-sm font-semibold border ${
                    pointTarget === v
                      ? "bg-lime-300 text-slate-950 border-lime-300"
                      : "bg-slate-900 text-slate-300 border-slate-700"
                  }`}
                >
                  {v} poin
                </button>
              ))}
              <input
                type="number"
                value={pointTarget}
                onChange={(e) => setPointTarget(Number(e.target.value))}
                className="w-20 bg-slate-900 border border-slate-700 rounded-xl px-3 py-2 text-center font-mono2"
              />
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            <p className="text-xs text-slate-500">
              Skor dicatat seperti tenis (0 – 15 – 30 – 40 – Deuce) lalu terakumulasi jadi game.
              Match selesai setelah salah satu tim mencapai jumlah game ini.
            </p>
            <div className="flex flex-wrap gap-2">
              {[4, 6].map((v) => (
                <button
                  key={v}
                  onClick={() => setTennisTarget(v)}
                  className={`px-4 py-2 rounded-xl text-sm font-semibold border ${
                    tennisTarget === v
                      ? "bg-lime-300 text-slate-950 border-lime-300"
                      : "bg-slate-900 text-slate-300 border-slate-700"
                  }`}
                >
                  Race to {v} game
                </button>
              ))}
              <input
                type="number"
                value={tennisTarget}
                onChange={(e) => setTennisTarget(Number(e.target.value))}
                className="w-20 bg-slate-900 border border-slate-700 rounded-xl px-3 py-2 text-center font-mono2"
              />
            </div>
          </div>
        )}
      </Section>

      {/* PREVIEW */}
      <div className="mx-6 mt-2 mb-6 rounded-2xl border border-slate-800 bg-slate-900/60 p-4">
        <div className="grid grid-cols-2 gap-3 text-center">
          <PreviewStat label="Estimasi ronde" value={computedRounds} />
          <PreviewStat label="Target lapangan" value={Math.max(1, Math.min(courts, Math.floor(maxParticipants / 4))) || 0} />
        </div>
        <p className="text-[11px] text-slate-500 mt-3">
          Jumlah ronde & lapangan aktif akan disesuaikan lagi otomatis begitu peserta fix, mengikuti
          jumlah yang benar-benar bergabung.
        </p>
      </div>

      <div className="px-6">
        <PrimaryButton
          onClick={onGenerate}
          icon={Users}
          className="w-full text-lg py-4"
        >
          Buat Acara & Undang Peserta
        </PrimaryButton>
      </div>
    </div>
  );
}

function Section({ icon: Icon, title, subtitle, children }) {
  return (
    <div className="px-6 py-6 border-b border-slate-800">
      <div className="flex items-baseline justify-between mb-4">
        <div className="flex items-center gap-2">
          <Icon size={16} className="text-lime-300" />
          <h2 className="font-display text-2xl tracking-wide text-slate-100">{title}</h2>
        </div>
        {subtitle && <span className="text-xs text-slate-300 font-mono2">{subtitle}</span>}
      </div>
      {children}
    </div>
  );
}

function ModeTab({ active, onClick, children }) {
  return (
    <button
      onClick={onClick}
      className={`flex-1 py-2.5 rounded-xl text-sm font-semibold border ${
        active
          ? "bg-lime-300 text-slate-950 border-lime-300"
          : "bg-slate-900 text-slate-400 border-slate-700"
      }`}
    >
      {children}
    </button>
  );
}

function FieldRow({ label, children }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-sm text-slate-300">{label}</span>
      {children}
    </div>
  );
}

function PreviewStat({ label, value }) {
  return (
    <div>
      <div className="font-display text-4xl text-cyan-300">{value}</div>
      <div className="text-[11px] text-slate-500 uppercase tracking-wide mt-0.5">{label}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// WAITING ROOM (gather participants before generating the schedule)
// ---------------------------------------------------------------------------

function WaitingRoomScreen(props) {
  const {
    eventName, activeId, isOwner, canManage, myAccountId,
    players, nameInput, setNameInput, bulkInput, setBulkInput,
    addPlayerFromInput, addBulk, removePlayer,
    maxParticipants, courts, computedRounds,
    pendingRequests, onApprove, onReject,
    hostPlaying, onToggleHostPlaying,
    coHostIds, onToggleCoHost,
    friends, onInviteFriend, onSendFriendRequest,
    hostInvitations, onCancelInvitation,
    courtCost, setCourtCost, adminFee, setAdminFee, ballCost, setBallCost, onSaveCosts,
    onFinalize, onBackToLobby, onDelete,
  } = props;

  const [sentFriendReq, setSentFriendReq] = useState({}); // accountId -> true (local feedback)

  const [showBulk, setShowBulk] = useState(false);
  const [avatarCache, setAvatarCache] = useState({}); // accountId -> avatarUrl | null
  const usableCourtsPreview = Math.min(courts, Math.floor(players.length / 4));
  const canFinalize = players.length >= 4 && usableCourtsPreview >= 1;
  const iAmApproved = !canManage && players.some((p) => p.accountId === myAccountId);
  const iAmPending = !canManage && !iAmApproved && pendingRequests.some((r) => r.accountId === myAccountId);

  useEffect(() => {
    const ids = new Set(
      [...players, ...pendingRequests, ...hostInvitations]
        .map((p) => p.accountId)
        .filter((id) => id && !(id in avatarCache))
    );
    if (ids.size === 0) return;
    (async () => {
      const entries = await Promise.all(
        [...ids].map(async (id) => {
          const acc = await getUserAccount(id);
          return [id, acc?.avatarUrl || null];
        })
      );
      setAvatarCache((prev) => ({ ...prev, ...Object.fromEntries(entries) }));
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [players, pendingRequests, hostInvitations]);

  const handleAddFriendClick = async (accountId) => {
    if (!onSendFriendRequest) return;
    const ok = await onSendFriendRequest(accountId);
    if (ok) setSentFriendReq((s) => ({ ...s, [accountId]: true }));
  };

  const handleCopyInvite = async () => {
    const url = new URL(window.location.href);
    url.search = `?join=${activeId}`;
    const link = url.toString();
    try {
      await navigator.clipboard.writeText(link);
      alert(
        "Link undangan disalin! Kirim ke calon peserta — kalau mereka sudah punya akun, tinggal buka link ini dan minta bergabung."
      );
    } catch (e) {
      console.log(link);
      alert("Gagal menyalin otomatis. Buka console untuk salin manual.");
    }
  };

  return (
    <div className="pb-10">
      <div className="px-6 pt-14 pb-6 border-b border-slate-800 relative overflow-hidden">
        <div className="absolute -right-10 -top-10 w-40 h-40 rounded-full bg-lime-400/10 blur-2xl pointer-events-none" />
        <div className="flex items-center justify-between mb-4">
          <button
            onClick={onBackToLobby}
            className="inline-flex items-center gap-1.5 text-sm font-semibold text-slate-200 border border-slate-700 rounded-full px-3.5 py-2 active:scale-95 transition-transform"
          >
            <ArrowLeft size={16} /> Lobby
          </button>
          {canManage ? (
            <div className="flex items-center gap-3">
              {!isOwner && (
                <Chip tone="cyan">co-host</Chip>
              )}
              {isOwner && (
                <button onClick={onDelete} className="text-xs text-red-400/80 flex items-center gap-1">
                  <Trash2 size={12} /> hapus acara
                </button>
              )}
            </div>
          ) : (
            <Chip tone="cyan">
              <Eye size={11} /> view only
            </Chip>
          )}
        </div>
        {eventName && <h1 className="font-display text-4xl text-slate-50 mb-1">{eventName}</h1>}
        <Chip tone="amber">
          <Clock size={11} /> Menunggu peserta
        </Chip>
        <p className="text-slate-400 text-sm mt-3">
          {players.length}/{maxParticipants} peserta target · {courts} lapangan · estimasi{" "}
          {computedRounds} ronde
        </p>
      </div>

      {canManage && (
        <Section icon={Link2} title="Undang Peserta">
          <p className="text-xs text-slate-500 mb-3">
            Bagikan link ini ke calon peserta yang sudah punya akun. Begitu mereka buka & minta
            gabung, permintaannya muncul di bawah untuk kamu setujui.
          </p>
          <PrimaryButton onClick={handleCopyInvite} icon={Link2} className="w-full">
            Salin Link Undangan
          </PrimaryButton>
        </Section>
      )}

      {canManage && (
        <Section icon={Users} title="Undang dari Teman">
          {friends.length === 0 ? (
            <p className="text-slate-500 text-xs">
              Kamu belum punya teman. Buka menu "Teman" di Lobby untuk cari & tambah teman dulu.
            </p>
          ) : (
            <div className="space-y-2">
              {friends
                .filter(
                  (f) =>
                    !players.some((p) => p.accountId === f.accountId) &&
                    !hostInvitations.some((i) => i.accountId === f.accountId)
                )
                .map((f) => (
                  <div
                    key={f.accountId}
                    className="flex items-center gap-3 rounded-xl border border-slate-800 bg-slate-900/50 px-3 py-2"
                  >
                    <Avatar name={f.username} avatarUrl={f.avatarUrl} size={32} />
                    <span className="font-semibold text-slate-100 flex-1 min-w-0 truncate">
                      {f.username}
                    </span>
                    <button
                      onClick={() => onInviteFriend(f)}
                      className="px-3 py-1.5 rounded-full text-xs font-semibold bg-lime-300 text-slate-950 shrink-0"
                    >
                      Undang
                    </button>
                  </div>
                ))}
              {friends.every(
                (f) =>
                  players.some((p) => p.accountId === f.accountId) ||
                  hostInvitations.some((i) => i.accountId === f.accountId)
              ) && <p className="text-slate-500 text-xs">Semua temanmu sudah diundang/jadi peserta.</p>}
            </div>
          )}
          <p className="text-[11px] text-slate-500 mt-3">
            Undangan perlu diterima dulu oleh temanmu sebelum masuk daftar peserta.
          </p>
        </Section>
      )}

      {canManage && hostInvitations.length > 0 && (
        <Section icon={Users} title="Undangan Menunggu Respon" subtitle={`${hostInvitations.length}`}>
          <div className="space-y-2">
            {hostInvitations.map((inv) => (
              <div
                key={inv.accountId}
                className="flex items-center justify-between gap-3 rounded-xl border border-slate-800 bg-slate-900/50 px-4 py-3"
              >
                <span className="flex items-center gap-2 min-w-0">
                  <Avatar name={inv.username} avatarUrl={avatarCache[inv.accountId]} size={32} />
                  <span className="font-semibold text-slate-100 truncate">{inv.username}</span>
                </span>
                <div className="flex items-center gap-2 shrink-0">
                  <Chip tone="amber">menunggu</Chip>
                  <button
                    onClick={() => onCancelInvitation(inv.accountId)}
                    className="w-7 h-7 rounded-full bg-slate-800 border border-slate-700 text-slate-400 hover:text-red-400 flex items-center justify-center"
                  >
                    <X size={13} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        </Section>
      )}

      {canManage && pendingRequests.length > 0 && (
        <Section icon={Users} title="Permintaan Bergabung" subtitle={`${pendingRequests.length} baru`}>
          <div className="space-y-2">
            {pendingRequests.map((r) => (
              <div
                key={r.id}
                className="flex items-center justify-between gap-3 rounded-xl border border-slate-800 bg-slate-900/50 px-4 py-3"
              >
                <span className="flex items-center gap-2 min-w-0">
                  <Avatar name={r.name} avatarUrl={avatarCache[r.accountId]} size={36} />
                  <span className="font-semibold text-slate-100 truncate">{r.name}</span>
                </span>
                <div className="flex gap-2 shrink-0">
                  <button
                    onClick={() => onApprove(r.id)}
                    className="w-8 h-8 rounded-lg bg-lime-300 text-slate-950 flex items-center justify-center"
                  >
                    <Check size={15} strokeWidth={3} />
                  </button>
                  <button
                    onClick={() => onReject(r.id)}
                    className="w-8 h-8 rounded-lg bg-slate-800 border border-slate-700 text-red-400 flex items-center justify-center"
                  >
                    <X size={15} strokeWidth={3} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        </Section>
      )}

      <Section icon={Users} title="Peserta" subtitle={`${players.length} bergabung`}>
        {isOwner && (
          <button
            onClick={onToggleHostPlaying}
            className="w-full flex items-center justify-between gap-3 rounded-xl border border-slate-700 bg-slate-900/60 px-4 py-3 mb-4"
          >
            <div className="text-left">
              <div className="text-sm font-semibold text-slate-100">Saya (host) ikut bermain</div>
              <div className="text-[11px] text-slate-500 mt-0.5">
                Kalau aktif, namamu otomatis masuk ke daftar peserta
              </div>
            </div>
            <div
              className={`w-11 h-6 rounded-full shrink-0 flex items-center px-0.5 transition-colors ${
                hostPlaying ? "bg-lime-300 justify-end" : "bg-slate-700 justify-start"
              }`}
            >
              <div className="w-5 h-5 rounded-full bg-slate-950" />
            </div>
          </button>
        )}

        {canManage && (
          <>
            <div className="flex gap-2 mb-3">
              <input
                value={nameInput}
                onChange={(e) => setNameInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && addPlayerFromInput()}
                placeholder="Nama pemain (manual)"
                className="flex-1 bg-slate-900 border border-slate-700 rounded-xl px-4 py-3 text-sm placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-lime-400/50"
              />
              <button
                onClick={addPlayerFromInput}
                className="bg-lime-300 text-slate-950 rounded-xl px-4 flex items-center justify-center"
              >
                <Plus size={20} strokeWidth={3} />
              </button>
            </div>

            <button
              onClick={() => setShowBulk((s) => !s)}
              className="text-xs font-semibold text-cyan-300 mb-3"
            >
              {showBulk ? "Sembunyikan tempel banyak nama" : "+ Tempel banyak nama sekaligus"}
            </button>

            {showBulk && (
              <div className="mb-3 space-y-2">
                <textarea
                  value={bulkInput}
                  onChange={(e) => setBulkInput(e.target.value)}
                  placeholder={"Satu nama per baris atau pisah koma\nBudi\nAndi\nCitra..."}
                  rows={3}
                  className="w-full bg-slate-900 border border-slate-700 rounded-xl px-4 py-3 text-sm placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-lime-400/50"
                />
                <GhostButton onClick={addBulk}>Tambahkan semua</GhostButton>
              </div>
            )}
          </>
        )}

        {players.length > 0 ? (
          <div className="grid grid-cols-4 gap-2">
            {players.map((p) => {
              const isThisCoHost = p.accountId && coHostIds.includes(p.accountId);
              const canToggleCoHost = isOwner && p.accountId && p.accountId !== myAccountId;
              const isAlreadyFriend = (friends || []).some((f) => f.accountId === p.accountId);
              const alreadySentReq = sentFriendReq[p.accountId];
              const canAddFriend =
                onSendFriendRequest &&
                p.accountId &&
                p.accountId !== myAccountId &&
                !isAlreadyFriend;
              return (
                <div
                  key={p.id}
                  className={`relative flex flex-col items-center gap-1.5 bg-slate-900 border rounded-2xl px-1.5 pt-3 pb-2 ${
                    isThisCoHost ? "border-cyan-400/60" : "border-slate-700"
                  }`}
                >
                  {canManage && (
                    <button
                      onClick={() => removePlayer(p.id)}
                      className="absolute top-1 right-1 w-5 h-5 rounded-full bg-slate-800 border border-slate-700 flex items-center justify-center text-slate-400 hover:text-red-400 z-10"
                    >
                      <X size={11} />
                    </button>
                  )}
                  {canToggleCoHost && (
                    <button
                      onClick={() => onToggleCoHost(p.accountId)}
                      className={`absolute top-1 left-1 w-5 h-5 rounded-full flex items-center justify-center z-10 ${
                        isThisCoHost
                          ? "bg-cyan-400 text-slate-950"
                          : "bg-slate-800 border border-slate-700 text-slate-400"
                      }`}
                    >
                      <Shield size={11} />
                    </button>
                  )}
                  <div className="relative">
                    <Avatar
                      name={p.name}
                      avatarUrl={p.accountId ? avatarCache[p.accountId] : null}
                      size={56}
                    />
                    {canAddFriend && (
                      <button
                        onClick={() => handleAddFriendClick(p.accountId)}
                        disabled={alreadySentReq}
                        className={`absolute -bottom-1 -right-1 w-5 h-5 rounded-full flex items-center justify-center border-2 border-slate-900 z-10 ${
                          alreadySentReq ? "bg-slate-700 text-slate-400" : "bg-lime-300 text-slate-950"
                        }`}
                      >
                        {alreadySentReq ? <Check size={10} /> : <Plus size={10} strokeWidth={3} />}
                      </button>
                    )}
                  </div>
                  <span className="text-[11px] font-semibold text-slate-100 text-center leading-snug break-words">
                    {p.name}
                  </span>
                  {isThisCoHost && <Chip tone="cyan">co-host</Chip>}
                </div>
              );
            })}
          </div>
        ) : (
          <p className="text-slate-500 text-sm">Belum ada peserta.</p>
        )}
        {players.length > 0 && players.length < 4 && (
          <p className="text-amber-400 text-xs mt-3">Minimal 4 peserta untuk membentuk 1 lapangan.</p>
        )}
      </Section>

      {canManage && (
        <Section icon={Wallet} title="Biaya" subtitle="opsional, buat split bill">
          <p className="text-xs text-slate-500 mb-3">
            Kelewat isi biaya waktu bikin acara? Isi di sini juga masih bisa, sebelum atau sesudah
            jadwal digenerate. Boleh dikosongkan.
          </p>
          <div className="space-y-3">
            <FieldRow label="Harga lapangan (Rp)">
              <input
                type="number"
                value={courtCost}
                onChange={(e) => setCourtCost(e.target.value)}
                onBlur={onSaveCosts}
                placeholder="0"
                className="w-28 bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-right font-mono2"
              />
            </FieldRow>
            <FieldRow label="Biaya admin (Rp)">
              <input
                type="number"
                value={adminFee}
                onChange={(e) => setAdminFee(e.target.value)}
                onBlur={onSaveCosts}
                placeholder="0"
                className="w-28 bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-right font-mono2"
              />
            </FieldRow>
            <FieldRow label="Biaya bola (Rp)">
              <input
                type="number"
                value={ballCost}
                onChange={(e) => setBallCost(e.target.value)}
                onBlur={onSaveCosts}
                placeholder="0"
                className="w-28 bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-right font-mono2"
              />
            </FieldRow>
          </div>
        </Section>
      )}

      {canManage ? (
        <div className="px-6">
          <PrimaryButton
            onClick={onFinalize}
            disabled={!canFinalize}
            icon={Shuffle}
            className="w-full text-lg py-4"
          >
            Fix Peserta & Buat Jadwal
          </PrimaryButton>
        </div>
      ) : (
        <div className="px-6">
          <div className="rounded-2xl border border-dashed border-slate-700 p-5 text-center">
            <p className="text-slate-400 text-sm">
              {iAmPending
                ? "Permintaan bergabungmu sudah terkirim, menunggu persetujuan host."
                : iAmApproved
                ? 'Kamu sudah jadi peserta. Menunggu host memulai pertandingan — halaman ini akan otomatis lanjut ke jadwal begitu dimulai.'
                : "Menunggu host memulai pertandingan."}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// SESSION SCREEN (round-by-round court/scoreboard view)
// ---------------------------------------------------------------------------

function SessionScreen(props) {
  const {
    eventName, isOwner, canManage, engine, playerMap, currentRound, goRound, goToRound,
    scores, setScore, setPointsPair, resetPointsScore, scoreFormat, pointTarget, tennisTarget,
    incrementTennisPoint, resetTennisMatch, setTennisGamesDirect,
    ended, hasSplitBill, onEndEvent,
    onNav, onShare, onCopyViewLink, onBackToLobby, onDelete,
  } = props;

  const [scoreModal, setScoreModal] = useState(null); // court index being edited, or null
  const [viewMode, setViewMode] = useState("single"); // single | all

  useEffect(() => {
    setScoreModal(null);
  }, [currentRound]);

  const totalRounds = engine.roundsData.length;
  const round = engine.roundsData[currentRound];
  const isLast = currentRound === totalRounds - 1;
  const pct = totalRounds > 1 ? currentRound / (totalRounds - 1) : 1;

  function winnerOf(s) {
    if (!s) return null;
    if (scoreFormat === "tennis") {
      if ((s.gamesA || 0) >= tennisTarget) return "team1";
      if ((s.gamesB || 0) >= tennisTarget) return "team2";
      return null;
    }
    const a = s.a !== undefined && s.a !== "" ? Number(s.a) : null;
    const b = s.b !== undefined && s.b !== "" ? Number(s.b) : null;
    if (a === null || b === null || a === b) return null;
    return a > b ? "team1" : "team2";
  }

  return (
    <div className="pb-24">
      {/* HEADER */}
      <div className="px-6 pt-12 pb-5 border-b border-slate-800">
        <div className="flex items-center justify-between mb-2">
          <button
            onClick={onBackToLobby}
            className="inline-flex items-center gap-1.5 text-sm font-semibold text-slate-200 border border-slate-700 rounded-full px-3.5 py-2 active:scale-95 transition-transform"
          >
            <ArrowLeft size={16} /> Lobby
          </button>
          {canManage ? (
            <div className="flex items-center gap-3">
              {!isOwner && <Chip tone="cyan">co-host</Chip>}
              {!ended && (
                <button onClick={onEndEvent} className="text-xs text-cyan-300 flex items-center gap-1">
                  <Trophy size={12} /> selesaikan
                </button>
              )}
              {isOwner && (
                <button onClick={onDelete} className="text-xs text-red-400/80 flex items-center gap-1">
                  <Trash2 size={12} /> hapus acara
                </button>
              )}
            </div>
          ) : (
            <Chip tone="cyan">
              <Eye size={11} /> view only
            </Chip>
          )}
        </div>
        {eventName && (
          <div className="text-sm font-semibold text-slate-200 mb-1 truncate">{eventName}</div>
        )}
        <div className="flex items-center justify-between mb-1">
          <span className="text-xs font-semibold tracking-[0.2em] text-cyan-300 uppercase">
            Ronde {currentRound + 1} / {totalRounds}
          </span>
        </div>
        <div className="mb-3 flex gap-2">
          <Chip tone="amber">
            <Trophy size={11} />
            {scoreFormat === "tennis" ? `Race to ${tennisTarget} game` : `Target ${pointTarget} poin`}
          </Chip>
          {ended && <Chip tone="lime">Acara selesai</Chip>}
        </div>
        {hasSplitBill && (
          <button
            onClick={() => onNav("splitbill")}
            className="inline-flex items-center gap-1.5 text-xs font-semibold text-slate-950 bg-lime-300 rounded-full px-3 py-1.5 mb-3"
          >
            <Wallet size={12} /> Lihat Split Bill
          </button>
        )}
        <div className="h-1.5 bg-slate-800 rounded-full overflow-hidden mb-3">
          <div
            className="h-full bg-lime-300 rounded-full transition-all"
            style={{ width: `${pct * 100}%` }}
          />
        </div>
        <button
          onClick={() => setViewMode((v) => (v === "single" ? "all" : "single"))}
          className="flex items-center gap-1.5 text-xs font-semibold text-cyan-300"
        >
          <ListOrdered size={14} />
          {viewMode === "single" ? "Lihat semua ronde" : "Kembali ke tampilan ronde"}
        </button>
      </div>

      {viewMode === "all" ? (
        <AllRoundsList
          engine={engine}
          playerMap={playerMap}
          scores={scores}
          scoreFormat={scoreFormat}
          currentRound={currentRound}
          onJump={(idx) => {
            goToRound(idx);
            setViewMode("single");
          }}
        />
      ) : (
        <>

      {/* COURTS */}
      <div className="px-6 pt-6 space-y-5">
        {round.courts.map((match, cIdx) => {
          const key = `${currentRound}-${cIdx}`;
          const s = scores[key] || {};
          const winner = winnerOf(s);
          const scoreA =
            scoreFormat === "tennis" ? s.gamesA || 0 : s.a !== undefined && s.a !== "" ? s.a : "–";
          const scoreB =
            scoreFormat === "tennis" ? s.gamesB || 0 : s.b !== undefined && s.b !== "" ? s.b : "–";
          const openModal = canManage && scoreFormat === "points" ? () => setScoreModal(cIdx) : undefined;
          return (
            <div key={cIdx} className="rounded-2xl border border-slate-800 overflow-hidden bg-slate-900/40">
              <div className="px-4 py-2 bg-slate-900 border-b border-slate-800">
                <span className="text-xs font-bold tracking-widest text-slate-400 uppercase">
                  Lapangan {cIdx + 1}
                </span>
              </div>
              <div className="grid grid-cols-[1fr_auto_1fr] items-stretch">
                <TeamSide
                  names={match.team1.map((id) => playerMap[id])}
                  align="right"
                  won={winner === "team1"}
                  score={scoreA}
                  onClick={openModal}
                />
                <div className="flex flex-col items-center px-3 py-2">
                  <div className="w-px flex-1 bg-gradient-to-b from-transparent via-lime-300/60 to-transparent" />
                  <span className="font-display text-lg text-lime-300 bg-slate-950 px-1">VS</span>
                  <div className="w-px flex-1 bg-gradient-to-t from-transparent via-lime-300/60 to-transparent" />
                </div>
                <TeamSide
                  names={match.team2.map((id) => playerMap[id])}
                  align="left"
                  won={winner === "team2"}
                  score={scoreB}
                  onClick={openModal}
                />
              </div>

              {scoreFormat === "tennis" && (
                <TennisScoreTracker
                  s={s}
                  target={tennisTarget}
                  readOnly={!canManage}
                  onPoint={(side) => incrementTennisPoint(cIdx, side)}
                  onReset={() => resetTennisMatch(cIdx)}
                  onSetGames={(side, value) => setTennisGamesDirect(cIdx, side, value)}
                />
              )}
            </div>
          );
        })}

        {round.resting.length > 0 && (
          <div className="rounded-2xl border border-dashed border-slate-700 p-4 flex items-center gap-3">
            <Coffee size={18} className="text-amber-300 shrink-0" />
            <div>
              <div className="text-xs font-bold text-amber-300 uppercase tracking-wide">Istirahat</div>
              <div className="text-sm text-slate-300 mt-0.5">
                {round.resting.map((id) => playerMap[id]).join(", ")}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* SCORE MODAL (points format) */}
      {scoreModal !== null && scoreFormat === "points" && (
        <ScoreModal
          roundLabel={`Ronde ${currentRound + 1} – Lapangan ${scoreModal + 1}`}
          team1={round.courts[scoreModal].team1.map((id) => playerMap[id])}
          team2={round.courts[scoreModal].team2.map((id) => playerMap[id])}
          s={scores[`${currentRound}-${scoreModal}`] || {}}
          target={pointTarget}
          onPick={(side, n) => setPointsPair(scoreModal, side, n)}
          onReset={() => resetPointsScore(scoreModal)}
          onClose={() => setScoreModal(null)}
        />
      )}

      {/* NAV */}
      <div className="px-6 pt-6 flex gap-3">
        <GhostButton onClick={() => goRound(-1)} disabled={currentRound === 0} icon={ChevronLeft} className="flex-1">
          Sebelumnya
        </GhostButton>
        <GhostButton
          onClick={() => goRound(1)}
          disabled={isLast}
          icon={ChevronRight}
          className="flex-1 flex-row-reverse"
        >
          Berikutnya
        </GhostButton>
      </div>
        </>
      )}

      {canManage && (
        <div className="px-6 pt-3 space-y-2">
          <GhostButton onClick={onShare} icon={Share2} className="w-full">
            Bagikan jadwal ke WhatsApp
          </GhostButton>
          <PrimaryButton onClick={onCopyViewLink} icon={Link2} className="w-full">
            Salin link pemantau (view only)
          </PrimaryButton>
          <p className="text-[11px] text-slate-500 text-center px-4">
            Siapa saja dengan link ini bisa lihat jadwal, klasemen & rekap match — tanpa bisa
            mengubah skor.
          </p>
        </div>
      )}

      <BottomNav active="session" onNav={onNav} showSplitBill={hasSplitBill} />
    </div>
  );
}

function AllRoundsList({ engine, playerMap, scores, scoreFormat, currentRound, onJump }) {
  return (
    <div className="px-6 pt-6 pb-4 space-y-6">
      {engine.roundsData.map((rd, rIdx) => (
        <div key={rIdx}>
          <div className="flex items-center gap-2 mb-2">
            <span className="font-display text-2xl text-slate-100 tracking-wide">
              Ronde {rIdx + 1}
            </span>
            {rIdx === currentRound && <Chip tone="lime">Sekarang</Chip>}
          </div>
          <div className="space-y-2">
            {rd.courts.map((match, cIdx) => {
              const s = scores[`${rIdx}-${cIdx}`] || {};
              let scoreLabel = "belum ada skor";
              if (scoreFormat === "tennis") {
                if (s.gamesA || s.gamesB) scoreLabel = `${s.gamesA || 0} – ${s.gamesB || 0}`;
              } else if (s.a !== undefined && s.a !== "" && s.b !== undefined && s.b !== "") {
                scoreLabel = `${s.a} – ${s.b}`;
              }
              return (
                <button
                  key={cIdx}
                  onClick={() => onJump(rIdx)}
                  className="w-full text-left rounded-xl border border-slate-800 bg-slate-900/40 px-3 py-2.5 flex items-center justify-between gap-3"
                >
                  <div className="min-w-0">
                    <div className="text-[10px] text-slate-500 uppercase tracking-wide">
                      Lap. {cIdx + 1}
                    </div>
                    <div className="text-sm text-slate-200 truncate">
                      {match.team1.map((id) => playerMap[id]).join(" & ")}{" "}
                      <span className="text-slate-600">vs</span>{" "}
                      {match.team2.map((id) => playerMap[id]).join(" & ")}
                    </div>
                  </div>
                  <div
                    className={`font-mono2 text-sm shrink-0 ${
                      scoreLabel === "belum ada skor" ? "text-slate-600" : "text-lime-300"
                    }`}
                  >
                    {scoreLabel}
                  </div>
                </button>
              );
            })}
          </div>
          {rd.resting.length > 0 && (
            <div className="text-xs text-amber-300/80 mt-1.5 pl-1">
              Istirahat: {rd.resting.map((id) => playerMap[id]).join(", ")}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function TeamSide({ names, align, won, score, onClick }) {
  const isRight = align === "right";
  const Wrapper = onClick ? "button" : "div";

  const scoreBadge =
    score !== null && score !== undefined ? (
      <span
        className={`shrink-0 font-mono2 text-lg px-2.5 py-1 rounded-lg border ${
          won
            ? "bg-lime-300 text-slate-950 border-lime-300"
            : "bg-slate-900 text-slate-400 border-slate-700"
        }`}
      >
        {score}
      </span>
    ) : null;

  const nameBlock = (
    <div className={`min-w-0 ${isRight ? "text-right" : "text-left"}`}>
      {names.map((n, i) => (
        <div
          key={i}
          className={`font-semibold leading-tight truncate ${won ? "text-lime-300" : "text-slate-100"}`}
        >
          {n}
        </div>
      ))}
    </div>
  );

  return (
    <Wrapper
      onClick={onClick}
      className={`w-full flex items-center justify-between gap-2 px-3 py-4 text-left transition-colors ${
        won ? "bg-lime-400/10" : ""
      }`}
    >
      {isRight ? (
        <>
          {scoreBadge}
          {nameBlock}
        </>
      ) : (
        <>
          {nameBlock}
          {scoreBadge}
        </>
      )}
    </Wrapper>
  );
}

function PointsScorePicker({ s, target, onPick, team1Label, team2Label }) {
  const a = s.a !== undefined && s.a !== "" && s.a !== null ? Number(s.a) : null;
  const b = s.b !== undefined && s.b !== "" && s.b !== null ? Number(s.b) : null;
  const t = Math.max(1, Number(target) || 21);
  const nums = Array.from({ length: t + 1 }, (_, i) => i);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-center gap-3">
        <span className="font-mono2 text-3xl text-lime-300 w-10 text-center">{a ?? "–"}</span>
        <span className="text-slate-600 font-mono2">–</span>
        <span className="font-mono2 text-3xl text-lime-300 w-10 text-center">{b ?? "–"}</span>
      </div>

      <div>
        <div className="text-[10px] text-slate-500 uppercase tracking-wide mb-2 truncate">
          Skor {team1Label || "tim kiri"}
        </div>
        <div className="grid grid-cols-6 gap-1.5">
          {nums.map((n) => (
            <button
              key={n}
              onClick={() => onPick("a", n)}
              className={`h-9 rounded-lg text-xs font-bold border ${
                a === n
                  ? "bg-lime-300 text-slate-950 border-lime-300"
                  : "bg-slate-900 text-slate-300 border-slate-700"
              }`}
            >
              {n}
            </button>
          ))}
        </div>
      </div>

      <div>
        <div className="text-[10px] text-slate-500 uppercase tracking-wide mb-2 truncate">
          Skor {team2Label || "tim kanan"}
        </div>
        <div className="grid grid-cols-6 gap-1.5">
          {nums.map((n) => (
            <button
              key={n}
              onClick={() => onPick("b", n)}
              className={`h-9 rounded-lg text-xs font-bold border ${
                b === n
                  ? "bg-lime-300 text-slate-950 border-lime-300"
                  : "bg-slate-900 text-slate-300 border-slate-700"
              }`}
            >
              {n}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function ScoreModal({ roundLabel, team1, team2, s, target, onPick, onReset, onClose }) {
  return (
    <div
      className="fixed inset-0 bg-black/70 z-50 flex items-end sm:items-center justify-center"
      onClick={onClose}
    >
      <div
        className="bg-slate-950 border border-slate-800 rounded-t-3xl sm:rounded-3xl w-full sm:max-w-sm max-h-[85vh] overflow-y-auto p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="text-xs font-semibold tracking-[0.15em] text-cyan-300 uppercase mb-1">
          {roundLabel}
        </div>
        <div className="flex items-center gap-2 text-sm text-slate-300 mb-4">
          <span className="font-semibold text-slate-100">{team1.join(" & ")}</span>
          <span className="text-slate-600">vs</span>
          <span className="font-semibold text-slate-100">{team2.join(" & ")}</span>
        </div>

        <PointsScorePicker
          s={s}
          target={target}
          onPick={onPick}
          team1Label={team1.join(" & ")}
          team2Label={team2.join(" & ")}
        />

        <div className="flex items-center gap-3 mt-5">
          <button
            onClick={onReset}
            className="w-11 h-11 rounded-xl bg-slate-900 border border-slate-700 flex items-center justify-center shrink-0"
          >
            <RotateCcw size={16} className="text-slate-400" />
          </button>
          <PrimaryButton onClick={onClose} className="flex-1">
            Tutup
          </PrimaryButton>
        </div>
      </div>
    </div>
  );
}

function tennisPointLabels(pointsA, pointsB) {
  const labels = ["0", "15", "30", "40"];
  if (pointsA >= 3 && pointsB >= 3) {
    if (pointsA === pointsB) return { a: "40", b: "40", deuce: true };
    if (pointsA - pointsB === 1) return { a: "Ad", b: "40" };
    return { a: "40", b: "Ad" };
  }
  return { a: labels[Math.min(pointsA, 3)], b: labels[Math.min(pointsB, 3)] };
}

function TennisScoreTracker({ s, target, onPoint, onReset, onSetGames, readOnly }) {
  const [showGameEditor, setShowGameEditor] = useState(false);
  const gamesA = s.gamesA || 0;
  const gamesB = s.gamesB || 0;
  const pointsA = s.pointsA || 0;
  const pointsB = s.pointsB || 0;
  const finished = gamesA >= target || gamesB >= target;
  const labels = tennisPointLabels(pointsA, pointsB);
  const gameOptions = Array.from({ length: target + 1 }, (_, i) => i);

  return (
    <div className="border-t border-slate-800">
      <div className="flex items-center justify-center py-3">
        {finished ? (
          <div className="font-display text-xl text-cyan-300">SELESAI</div>
        ) : (
          <div className="font-mono2 text-lg text-slate-300">
            {labels.a} – {labels.b}
            {labels.deuce && <div className="text-[10px] text-amber-300 mt-0.5 text-center">DEUCE</div>}
          </div>
        )}
      </div>
      {!readOnly && (
      <div className="flex items-center gap-2 px-4 pb-3">
        <button
          onClick={() => onPoint("a")}
          disabled={finished}
          className="flex-1 py-2.5 rounded-xl bg-slate-900 border border-slate-700 text-sm font-bold text-slate-100 disabled:opacity-30 active:scale-[0.98] transition-transform"
        >
          +1 poin kiri
        </button>
        <button
          onClick={onReset}
          className="w-10 h-10 rounded-xl bg-slate-900 border border-slate-700 flex items-center justify-center shrink-0"
        >
          <RotateCcw size={14} className="text-slate-400" />
        </button>
        <button
          onClick={() => onPoint("b")}
          disabled={finished}
          className="flex-1 py-2.5 rounded-xl bg-slate-900 border border-slate-700 text-sm font-bold text-slate-100 disabled:opacity-30 active:scale-[0.98] transition-transform"
        >
          +1 poin kanan
        </button>
      </div>
      )}
      {!readOnly && onSetGames && (
        <div className="px-4 pb-3">
          <button
            onClick={() => setShowGameEditor((v) => !v)}
            className="text-[11px] font-semibold text-cyan-300"
          >
            {showGameEditor ? "Sembunyikan set skor langsung" : "Set skor game langsung →"}
          </button>
          {showGameEditor && (
            <div className="mt-3 space-y-3">
              <p className="text-[11px] text-slate-500">
                Langsung tentukan jumlah game akhir tanpa perlu tap poin satu-satu. Progres poin
                (0/15/30/40) akan direset ke 0-0.
              </p>
              <div>
                <div className="text-[10px] text-slate-500 uppercase tracking-wide mb-1.5">
                  Game tim kiri: <span className="text-slate-300">{gamesA}</span>
                </div>
                <div className="grid grid-cols-6 gap-1.5">
                  {gameOptions.map((n) => (
                    <button
                      key={n}
                      onClick={() => onSetGames("a", n)}
                      className={`h-8 rounded-lg text-xs font-bold border ${
                        gamesA === n
                          ? "bg-lime-300 text-slate-950 border-lime-300"
                          : "bg-slate-900 text-slate-300 border-slate-700"
                      }`}
                    >
                      {n}
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <div className="text-[10px] text-slate-500 uppercase tracking-wide mb-1.5">
                  Game tim kanan: <span className="text-slate-300">{gamesB}</span>
                </div>
                <div className="grid grid-cols-6 gap-1.5">
                  {gameOptions.map((n) => (
                    <button
                      key={n}
                      onClick={() => onSetGames("b", n)}
                      className={`h-8 rounded-lg text-xs font-bold border ${
                        gamesB === n
                          ? "bg-lime-300 text-slate-950 border-lime-300"
                          : "bg-slate-900 text-slate-300 border-slate-700"
                      }`}
                    >
                      {n}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// LEADERBOARD / STANDINGS SCREEN
// ---------------------------------------------------------------------------

function LeaderboardScreen({ eventName, leaderboard, ended, hasSplitBill, onNav, onBackToLobby }) {
  const [sortBy, setSortBy] = useState("wins"); // wins | diff | winPercent | ppm

  const sorted = React.useMemo(() => {
    const arr = [...leaderboard];
    if (sortBy === "wins") {
      arr.sort((x, y) => y.wins - x.wins || y.diff - x.diff || y.winPercent - x.winPercent || y.ppm - x.ppm);
    } else if (sortBy === "diff") {
      arr.sort((x, y) => y.diff - x.diff || y.wins - x.wins || y.winPercent - x.winPercent || y.ppm - x.ppm);
    } else if (sortBy === "winPercent") {
      arr.sort((x, y) => y.winPercent - x.winPercent || y.wins - x.wins || y.diff - x.diff);
    } else {
      arr.sort((x, y) => y.ppm - x.ppm || y.wins - x.wins || y.diff - x.diff);
    }
    return arr;
  }, [leaderboard, sortBy]);

  // Column that matches the active sort criterion always renders last (rightmost)
  // and gets highlighted, so it's obvious what the table is currently ordered by.
  const baseColumns = [
    { key: "wlt", sortKey: "wins", label: "W-L-T", render: (p) => `${p.wins}-${p.losses}-${p.ties}` },
    { key: "diff", sortKey: "diff", label: "+/-", render: (p) => (p.diff > 0 ? `+${p.diff}` : `${p.diff}`) },
    { key: "winPercent", sortKey: "winPercent", label: "Win%", render: (p) => `${Math.round(p.winPercent)}%` },
    { key: "ppm", sortKey: "ppm", label: "PPM", render: (p) => p.ppm.toFixed(1) },
  ];
  const activeColKey = sortBy === "wins" ? "wlt" : sortBy;
  const columns = [
    ...baseColumns.filter((c) => c.key !== activeColKey),
    ...baseColumns.filter((c) => c.key === activeColKey),
  ];

  return (
    <div className="pb-24">
      <div className="px-6 pt-14 pb-6 border-b border-slate-800">
        <button
          onClick={onBackToLobby}
          className="inline-flex items-center gap-1.5 text-sm font-semibold text-slate-200 border border-slate-700 rounded-full px-3.5 py-2 active:scale-95 transition-transform mb-4"
        >
          <ArrowLeft size={16} /> Lobby
        </button>
        {eventName && <div className="text-sm font-semibold text-slate-200 mb-1">{eventName}</div>}
        <div className="flex items-center gap-2 mb-1">
          <Trophy size={16} className="text-lime-300" />
          <span className="text-xs font-semibold tracking-[0.2em] text-cyan-300 uppercase">
            {ended ? "Hasil Akhir" : "Standing"}
          </span>
          {ended && <Chip tone="lime">Selesai</Chip>}
        </div>
        <h1 className="font-display text-5xl text-slate-50">KLASEMEN</h1>
        <p className="text-slate-500 text-sm mt-2">Tap salah satu tombol untuk urutkan.</p>

        <div className="flex flex-wrap gap-2 mt-4">
          {[
            { key: "wins", label: "W-L-T" },
            { key: "diff", label: "Selisih Poin" },
            { key: "winPercent", label: "Win%" },
            { key: "ppm", label: "PPM" },
          ].map((opt) => (
            <button
              key={opt.key}
              onClick={() => setSortBy(opt.key)}
              className={`px-3 py-1.5 rounded-full text-xs font-semibold border ${
                sortBy === opt.key
                  ? "bg-lime-300 text-slate-950 border-lime-300"
                  : "bg-slate-900 text-slate-400 border-slate-700"
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      <div className="px-6 pt-4">
        {sorted.length === 0 && <p className="text-slate-500 text-sm">Belum ada pemain.</p>}
        {sorted.length > 0 && (
          <table className="w-full border-collapse table-fixed">
            <colgroup>
              <col style={{ width: "6%" }} />
              <col style={{ width: "34%" }} />
              <col style={{ width: "8%" }} />
              <col style={{ width: "13%" }} />
              <col style={{ width: "13%" }} />
              <col style={{ width: "13%" }} />
              <col style={{ width: "13%" }} />
            </colgroup>
            <thead>
              <tr className="text-[9px] text-slate-500 uppercase tracking-wide">
                <th className="text-center pb-2">#</th>
                <th className="text-left pb-2">Nama</th>
                <th className="text-center pb-2">M</th>
                {columns.map((c) => (
                  <th
                    key={c.key}
                    className={`text-right pb-2 pl-1 whitespace-nowrap ${c.key === activeColKey ? "text-lime-300" : ""}`}
                  >
                    {c.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sorted.map((p, i) => (
                <tr
                  key={p.id}
                  className={`border-t border-slate-800 ${i === 0 ? "bg-lime-400/5" : ""}`}
                >
                  <td
                    className={`py-2.5 text-center font-display text-base ${
                      i === 0 ? "text-lime-300" : i === 1 ? "text-slate-300" : "text-slate-500"
                    }`}
                  >
                    {i + 1}
                  </td>
                  <td className="py-2.5 font-semibold text-slate-100 truncate text-[13px]">
                    {p.name}
                  </td>
                  <td className="py-2.5 text-center font-mono2 text-[11px] text-slate-400">
                    {p.matches}
                  </td>
                  {columns.map((c) => (
                    <td
                      key={c.key}
                      className={`py-2.5 pl-1 text-right font-mono2 text-[11px] whitespace-nowrap ${
                        c.key === activeColKey ? "text-lime-300 font-bold" : "text-slate-400"
                      }`}
                    >
                      {c.render(p)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {sorted.length > 0 && (
          <div className="mt-4 pt-4 border-t border-slate-800 space-y-1 text-[11px] text-slate-500">
            <div><span className="text-slate-300 font-semibold">M</span> — jumlah match dimainkan</div>
            <div><span className="text-slate-300 font-semibold">W-L-T</span> — menang-kalah-seri</div>
            <div><span className="text-slate-300 font-semibold">+/-</span> — selisih poin (poin dapat − poin lawan)</div>
            <div><span className="text-slate-300 font-semibold">Win%</span> — persentase match dimenangkan</div>
            <div><span className="text-slate-300 font-semibold">PPM</span> — rata-rata poin per match</div>
          </div>
        )}
      </div>

      <BottomNav active="leaderboard" onNav={onNav} showSplitBill={hasSplitBill} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// SPLIT BILL SCREEN — court/admin/ball cost divided evenly among players
// ---------------------------------------------------------------------------

function SplitBillScreen({ eventName, players, courtCost, adminFee, ballCost, onNav, onBackToLobby }) {
  const court = Number(courtCost) || 0;
  const admin = Number(adminFee) || 0;
  const ball = Number(ballCost) || 0;
  const total = court + admin + ball;
  const n = players.length || 1;
  const perPerson = Math.ceil(total / n);

  return (
    <div className="pb-24">
      <div className="px-6 pt-14 pb-6 border-b border-slate-800">
        <button
          onClick={onBackToLobby}
          className="inline-flex items-center gap-1.5 text-sm font-semibold text-slate-200 border border-slate-700 rounded-full px-3.5 py-2 active:scale-95 transition-transform mb-4"
        >
          <ArrowLeft size={16} /> Lobby
        </button>
        {eventName && <div className="text-sm font-semibold text-slate-200 mb-1">{eventName}</div>}
        <div className="flex items-center gap-2 mb-1">
          <Wallet size={16} className="text-lime-300" />
          <span className="text-xs font-semibold tracking-[0.2em] text-cyan-300 uppercase">
            Bagi Biaya
          </span>
        </div>
        <h1 className="font-display text-5xl text-slate-50">SPLIT BILL</h1>
      </div>

      <div className="px-6 pt-6">
        <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-4 space-y-2">
          {court > 0 && (
            <div className="flex items-center justify-between text-sm">
              <span className="text-slate-400">Harga lapangan</span>
              <span className="font-mono2 text-slate-200">{formatRupiah(court)}</span>
            </div>
          )}
          {admin > 0 && (
            <div className="flex items-center justify-between text-sm">
              <span className="text-slate-400">Biaya admin</span>
              <span className="font-mono2 text-slate-200">{formatRupiah(admin)}</span>
            </div>
          )}
          {ball > 0 && (
            <div className="flex items-center justify-between text-sm">
              <span className="text-slate-400">Biaya bola</span>
              <span className="font-mono2 text-slate-200">{formatRupiah(ball)}</span>
            </div>
          )}
          <div className="flex items-center justify-between text-sm pt-2 border-t border-slate-800">
            <span className="text-slate-300 font-semibold">Total</span>
            <span className="font-mono2 text-slate-100 font-bold">{formatRupiah(total)}</span>
          </div>
          <div className="flex items-center justify-between text-sm">
            <span className="text-slate-400">Jumlah pemain</span>
            <span className="font-mono2 text-slate-200">{n} orang</span>
          </div>
        </div>

        <div className="mt-4 rounded-2xl border border-lime-400/40 bg-lime-400/5 p-5 text-center">
          <div className="text-[11px] text-slate-400 uppercase tracking-wide mb-1">
            Per orang (dibulatkan ke atas)
          </div>
          <div className="font-display text-5xl text-lime-300">{formatRupiah(perPerson)}</div>
        </div>
      </div>

      <Section icon={Users} title="Rincian per Pemain">
        <div className="space-y-2">
          {players.map((p) => (
            <div
              key={p.id}
              className="flex items-center justify-between gap-3 rounded-xl border border-slate-800 bg-slate-900/50 px-4 py-3"
            >
              <span className="font-semibold text-slate-100 truncate">{p.name}</span>
              <span className="font-mono2 text-lime-300 font-bold shrink-0">
                {formatRupiah(perPerson)}
              </span>
            </div>
          ))}
        </div>
      </Section>

      <BottomNav active="splitbill" onNav={onNav} showSplitBill />
    </div>
  );
}

// ---------------------------------------------------------------------------
// RECAP SCREEN (all scored matches, for monitoring rotation fairness)
// ---------------------------------------------------------------------------

function RecapScreen({ eventName, engine, playerMap, scores, scoreFormat, tennisTarget, hasSplitBill, onNav, onBackToLobby }) {
  const [filterId, setFilterId] = useState("all");

  const allRows = React.useMemo(() => {
    if (!engine) return [];
    const list = [];
    engine.roundsData.forEach((rd, rIdx) => {
      rd.courts.forEach((match, cIdx) => {
        const key = `${rIdx}-${cIdx}`;
        const s = scores[key];
        if (!s) return;

        let a, b;
        if (s.format === "tennis") {
          a = s.gamesA || 0;
          b = s.gamesB || 0;
          const touched = a > 0 || b > 0 || s.pointsA > 0 || s.pointsB > 0;
          if (!touched) return;
        } else {
          a = s.a !== undefined && s.a !== "" ? Number(s.a) : null;
          b = s.b !== undefined && s.b !== "" ? Number(s.b) : null;
          if (a === null || b === null) return;
        }

        list.push({
          id: key,
          round: rIdx + 1,
          court: cIdx + 1,
          team1Ids: match.team1,
          team2Ids: match.team2,
          team1: match.team1.map((id) => playerMap[id]),
          team2: match.team2.map((id) => playerMap[id]),
          a,
          b,
          winner: a === b ? null : a > b ? "team1" : "team2",
        });
      });
    });
    return list;
  }, [engine, playerMap, scores]);

  const players = React.useMemo(
    () =>
      Object.entries(playerMap)
        .map(([id, name]) => ({ id, name }))
        .sort((x, y) => x.name.localeCompare(y.name)),
    [playerMap]
  );

  const rows =
    filterId === "all"
      ? allRows
      : allRows.filter((r) => r.team1Ids.includes(filterId) || r.team2Ids.includes(filterId));

  return (
    <div className="pb-24">
      <div className="px-6 pt-14 pb-6 border-b border-slate-800">
        <button
          onClick={onBackToLobby}
          className="inline-flex items-center gap-1.5 text-sm font-semibold text-slate-200 border border-slate-700 rounded-full px-3.5 py-2 active:scale-95 transition-transform mb-4"
        >
          <ArrowLeft size={16} /> Lobby
        </button>
        {eventName && <div className="text-sm font-semibold text-slate-200 mb-1">{eventName}</div>}
        <div className="flex items-center gap-2 mb-1">
          <ClipboardList size={16} className="text-lime-300" />
          <span className="text-xs font-semibold tracking-[0.2em] text-cyan-300 uppercase">
            Match Log
          </span>
        </div>
        <h1 className="font-display text-5xl text-slate-50">REKAP MATCH</h1>

        {players.length > 0 && (
          <div className="flex gap-1.5 overflow-x-auto pb-1 mt-4 -mx-6 px-6">
            <button
              onClick={() => setFilterId("all")}
              className={`shrink-0 px-3 py-1.5 rounded-full text-xs font-semibold border ${
                filterId === "all"
                  ? "bg-lime-300 text-slate-950 border-lime-300"
                  : "bg-slate-900 text-slate-400 border-slate-700"
              }`}
            >
              Semua
            </button>
            {players.map((p) => (
              <button
                key={p.id}
                onClick={() => setFilterId(p.id)}
                className={`shrink-0 px-3 py-1.5 rounded-full text-xs font-semibold border ${
                  filterId === p.id
                    ? "bg-lime-300 text-slate-950 border-lime-300"
                    : "bg-slate-900 text-slate-400 border-slate-700"
                }`}
              >
                {p.name}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="px-6 pt-4 space-y-3">
        {rows.length === 0 && (
          <div className="rounded-2xl border border-dashed border-slate-700 p-6 text-center">
            <p className="text-slate-500 text-sm">
              {filterId === "all"
                ? "Belum ada match yang diisi skornya."
                : "Pemain ini belum punya match dengan skor terisi."}
            </p>
          </div>
        )}

        {rows.map((r) => (
          <div key={r.id} className="rounded-2xl border border-slate-800 bg-slate-900/40 overflow-hidden">
            <div className="px-4 py-2 bg-slate-900 border-b border-slate-800">
              <span className="text-xs font-bold tracking-widest text-slate-400 uppercase">
                Ronde {r.round} · Lapangan {r.court}
              </span>
            </div>
            <div className="px-4 py-3 space-y-1.5">
              <div className="flex items-center justify-between gap-3">
                <span
                  className={`text-sm truncate ${
                    r.winner === "team1" ? "text-lime-300 font-semibold" : "text-slate-200"
                  }`}
                >
                  {r.team1.join(" & ")}
                </span>
                <span
                  className={`font-mono2 text-lg shrink-0 ${
                    r.winner === "team1" ? "text-lime-300" : "text-slate-400"
                  }`}
                >
                  {r.a}
                </span>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span
                  className={`text-sm truncate ${
                    r.winner === "team2" ? "text-lime-300 font-semibold" : "text-slate-200"
                  }`}
                >
                  {r.team2.join(" & ")}
                </span>
                <span
                  className={`font-mono2 text-lg shrink-0 ${
                    r.winner === "team2" ? "text-lime-300" : "text-slate-400"
                  }`}
                >
                  {r.b}
                </span>
              </div>
            </div>
          </div>
        ))}
      </div>

      <BottomNav active="recap" onNav={onNav} showSplitBill={hasSplitBill} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// STATS SCREEN (fairness proof)
// ---------------------------------------------------------------------------

function StatsScreen({ eventName, stats, totalPlayers, hasSplitBill, onNav, onBackToLobby }) {
  const maxPossible = Math.max(0, totalPlayers - 1);
  return (
    <div className="pb-24">
      <div className="px-6 pt-14 pb-6 border-b border-slate-800">
        <button
          onClick={onBackToLobby}
          className="inline-flex items-center gap-1.5 text-sm font-semibold text-slate-200 border border-slate-700 rounded-full px-3.5 py-2 active:scale-95 transition-transform mb-4"
        >
          <ArrowLeft size={16} /> Lobby
        </button>
        {eventName && <div className="text-sm font-semibold text-slate-200 mb-1">{eventName}</div>}
        <div className="flex items-center gap-2 mb-1">
          <BarChart3 size={16} className="text-lime-300" />
          <span className="text-xs font-semibold tracking-[0.2em] text-cyan-300 uppercase">
            Bukti Keadilan
          </span>
        </div>
        <h1 className="font-display text-5xl text-slate-50">STATISTIK ROTASI</h1>
        <p className="text-slate-500 text-sm mt-2">
          Semakin merata angka "main" &amp; "istirahat", semakin adil rotasinya.
        </p>
      </div>

      <div className="px-6 pt-4 space-y-2">
        {stats.map((p) => (
          <div key={p.id} className="rounded-xl border border-slate-800 bg-slate-900/40 px-4 py-3">
            <div className="flex items-center justify-between mb-2">
              <span className="font-semibold text-slate-100 flex items-center gap-1.5 min-w-0">
                <span className="truncate">{p.name}</span>
                {p.role === "host" && <Chip tone="cyan">host</Chip>}
                {p.role === "cohost" && <Chip tone="cyan">co-host</Chip>}
              </span>
              <div className="flex gap-2 shrink-0">
                <Chip tone="lime">
                  <Check size={11} /> {p.matches} main
                </Chip>
                <Chip tone="amber">
                  <Coffee size={11} /> {p.rests} off
                </Chip>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2 text-xs">
              <div className="flex items-center justify-between bg-slate-950/60 rounded-lg px-3 py-1.5">
                <span className="text-slate-500">Partner unik</span>
                <span className="font-mono2 text-cyan-300">
                  {p.partners}/{maxPossible}
                </span>
              </div>
              <div className="flex items-center justify-between bg-slate-950/60 rounded-lg px-3 py-1.5">
                <span className="text-slate-500">Lawan unik</span>
                <span className="font-mono2 text-cyan-300">
                  {p.opps}/{maxPossible}
                </span>
              </div>
            </div>
          </div>
        ))}
      </div>

      <BottomNav active="stats" onNav={onNav} showSplitBill={hasSplitBill} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// VIEW-ONLY APP (shared read-only link — schedule, standing, recap)
// ---------------------------------------------------------------------------

const FONT_STYLE = `
  @import url('https://fonts.googleapis.com/css2?family=Teko:wght@500;600;700&family=Inter:wght@400;500;600;700;800&family=Space+Mono:wght@400;700&display=swap');
  .font-display { font-family: 'Teko', sans-serif; }
  .font-mono2 { font-family: 'Space Mono', monospace; }
`;

function ViewOnlyApp({ sessionId }) {
  const [data, setData] = useState(null);
  const [notFound, setNotFound] = useState(false);
  const [tab, setTab] = useState("session");
  const [currentRound, setCurrentRound] = useState(0);
  const [recapFilter, setRecapFilter] = useState("all");
  const initializedRound = useRef(false);
  const lastAppliedRef = useRef(0);

  useEffect(() => {
    let mounted = true;
    let attempts = 0;
    let retryTimer = null;

    async function tryLoad() {
      const d = await loadSessionData(sessionId);
      if (!mounted) return;
      if (d) {
        setData(d);
        setNotFound(false);
        lastAppliedRef.current = d.updatedAt || Date.now();
        if (!initializedRound.current) {
          setCurrentRound(d.currentRound || 0);
          initializedRound.current = true;
        }
        return;
      }
      attempts += 1;
      if (attempts >= 4) {
        setNotFound(true);
      } else {
        retryTimer = setTimeout(tryLoad, 1200);
      }
    }
    tryLoad();

    const interval = setInterval(async () => {
      const d = await loadSessionData(sessionId);
      if (d && (d.updatedAt || 0) > lastAppliedRef.current) {
        lastAppliedRef.current = d.updatedAt || Date.now();
        setData(d);
        setNotFound(false);
      }
    }, 4000);
    return () => {
      mounted = false;
      clearInterval(interval);
      clearTimeout(retryTimer);
    };
  }, [sessionId]);

  const leaderboard = React.useMemo(
    () => (data?.engine ? buildLeaderboard(data.engine, data.playerMap, data.scores) : []),
    [data]
  );
  const [lbSortBy, setLbSortBy] = useState("wins"); // wins | diff | winPercent | ppm
  const sortedLeaderboard = React.useMemo(() => {
    const arr = [...leaderboard];
    if (lbSortBy === "wins") {
      arr.sort((x, y) => y.wins - x.wins || y.diff - x.diff || y.winPercent - x.winPercent || y.ppm - x.ppm);
    } else if (lbSortBy === "diff") {
      arr.sort((x, y) => y.diff - x.diff || y.wins - x.wins || y.winPercent - x.winPercent || y.ppm - x.ppm);
    } else if (lbSortBy === "winPercent") {
      arr.sort((x, y) => y.winPercent - x.winPercent || y.wins - x.wins || y.diff - x.diff);
    } else {
      arr.sort((x, y) => y.ppm - x.ppm || y.wins - x.wins || y.diff - x.diff);
    }
    return arr;
  }, [leaderboard, lbSortBy]);
  const lbActiveCol = lbSortBy === "wins" ? "wlt" : lbSortBy;
  const hasSplitBill =
    !!data &&
    (Number(data.courtCost) || 0) + (Number(data.adminFee) || 0) + (Number(data.ballCost) || 0) > 0;

  const recapRows = React.useMemo(() => {
    if (!data?.engine) return [];
    const list = [];
    data.engine.roundsData.forEach((rd, rIdx) => {
      rd.courts.forEach((match, cIdx) => {
        const s = data.scores[`${rIdx}-${cIdx}`];
        if (!s) return;
        let a, b;
        if (s.format === "tennis") {
          a = s.gamesA || 0;
          b = s.gamesB || 0;
          if (!(a > 0 || b > 0 || s.pointsA > 0 || s.pointsB > 0)) return;
        } else {
          a = s.a !== undefined && s.a !== "" ? Number(s.a) : null;
          b = s.b !== undefined && s.b !== "" ? Number(s.b) : null;
          if (a === null || b === null) return;
        }
        list.push({
          id: `${rIdx}-${cIdx}`,
          round: rIdx + 1,
          court: cIdx + 1,
          team1Ids: match.team1,
          team2Ids: match.team2,
          team1: match.team1.map((id) => data.playerMap[id]),
          team2: match.team2.map((id) => data.playerMap[id]),
          a,
          b,
          winner: a === b ? null : a > b ? "team1" : "team2",
        });
      });
    });
    return list;
  }, [data]);

  const filteredRecap =
    recapFilter === "all"
      ? recapRows
      : recapRows.filter((r) => r.team1Ids.includes(recapFilter) || r.team2Ids.includes(recapFilter));

  const players = React.useMemo(
    () =>
      data?.playerMap
        ? Object.entries(data.playerMap)
            .map(([id, name]) => ({ id, name }))
            .sort((x, y) => x.name.localeCompare(y.name))
        : [],
    [data]
  );

  if (!data && notFound) {
    return (
      <div className="min-h-screen bg-slate-950 flex items-center justify-center px-6 text-center">
        <style>{FONT_STYLE}</style>
        <div className="max-w-xs">
          <p className="text-slate-200 text-sm font-semibold mb-2">Sesi tidak ditemukan</p>
          <p className="text-slate-500 text-xs leading-relaxed">
            Link ini kemungkinan dibuka di device/browser yang berbeda dari yang dipakai untuk
            membuat acaranya. Kalau aplikasi ini di-deploy sendiri (bukan lewat Claude.ai),
            penyimpanan datanya masih bersifat lokal per-device, jadi link pemantau hanya jalan
            di device yang sama dengan yang membuat acara — belum bisa diakses lintas HP.
          </p>
        </div>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="min-h-screen bg-slate-950 flex items-center justify-center">
        <style>{FONT_STYLE}</style>
        <div className="text-slate-500 text-sm font-mono2">memuat…</div>
      </div>
    );
  }

  if (!data.engine) {
    return (
      <div className="min-h-screen bg-slate-950 flex items-center justify-center px-6 text-center">
        <style>{FONT_STYLE}</style>
        <p className="text-slate-400 text-sm">Acara ini belum punya jadwal.</p>
      </div>
    );
  }

  const totalRounds = data.engine.roundsData.length;
  const safeRound = Math.min(currentRound, totalRounds - 1);
  const round = data.engine.roundsData[safeRound];

  function winnerOf(s) {
    if (!s) return null;
    if (data.scoreFormat === "tennis") {
      if ((s.gamesA || 0) >= data.tennisTarget) return "team1";
      if ((s.gamesB || 0) >= data.tennisTarget) return "team2";
      return null;
    }
    const a = s.a !== undefined && s.a !== "" ? Number(s.a) : null;
    const b = s.b !== undefined && s.b !== "" ? Number(s.b) : null;
    if (a === null || b === null || a === b) return null;
    return a > b ? "team1" : "team2";
  }

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100" style={{ fontFamily: "'Inter', ui-sans-serif, system-ui" }}>
      <style>{FONT_STYLE}</style>

      <div className="max-w-md mx-auto relative">
      <div className="px-6 pt-12 pb-4 border-b border-slate-800">
        <Chip tone="cyan">
          <Eye size={11} /> View only — pemantau
        </Chip>
        {data.name && <h1 className="font-display text-4xl text-slate-50 mt-2">{data.name}</h1>}
        {data.ended && (
          <div className="mt-2">
            <Chip tone="lime">Acara selesai</Chip>
          </div>
        )}
      </div>

      <div className="pb-24">
        {tab === "session" && (
          <div className="px-6 pt-6">
            <div className="text-xs font-semibold tracking-[0.2em] text-cyan-300 uppercase mb-4">
              Ronde {safeRound + 1} / {totalRounds}
            </div>
            <div className="space-y-5">
              {round.courts.map((match, cIdx) => {
                const key = `${safeRound}-${cIdx}`;
                const s = data.scores[key] || {};
                const winner = winnerOf(s);
                const scoreA =
                  data.scoreFormat === "tennis"
                    ? s.gamesA || 0
                    : s.a !== undefined && s.a !== ""
                    ? s.a
                    : "–";
                const scoreB =
                  data.scoreFormat === "tennis"
                    ? s.gamesB || 0
                    : s.b !== undefined && s.b !== ""
                    ? s.b
                    : "–";
                return (
                  <div key={cIdx} className="rounded-2xl border border-slate-800 overflow-hidden bg-slate-900/40">
                    <div className="px-4 py-2 bg-slate-900 border-b border-slate-800">
                      <span className="text-xs font-bold tracking-widest text-slate-400 uppercase">
                        Lapangan {cIdx + 1}
                      </span>
                    </div>
                    <div className="grid grid-cols-[1fr_auto_1fr] items-stretch">
                      <TeamSide
                        names={match.team1.map((id) => data.playerMap[id])}
                        align="right"
                        won={winner === "team1"}
                        score={scoreA}
                      />
                      <div className="flex flex-col items-center px-3 py-2">
                        <div className="w-px flex-1 bg-gradient-to-b from-transparent via-lime-300/60 to-transparent" />
                        <span className="font-display text-lg text-lime-300 bg-slate-950 px-1">VS</span>
                        <div className="w-px flex-1 bg-gradient-to-t from-transparent via-lime-300/60 to-transparent" />
                      </div>
                      <TeamSide
                        names={match.team2.map((id) => data.playerMap[id])}
                        align="left"
                        won={winner === "team2"}
                        score={scoreB}
                      />
                    </div>
                    {data.scoreFormat === "tennis" && (
                      <TennisScoreTracker s={s} target={data.tennisTarget} readOnly />
                    )}
                  </div>
                );
              })}

              {round.resting.length > 0 && (
                <div className="rounded-2xl border border-dashed border-slate-700 p-4 flex items-center gap-3">
                  <Coffee size={18} className="text-amber-300 shrink-0" />
                  <div>
                    <div className="text-xs font-bold text-amber-300 uppercase tracking-wide">
                      Istirahat
                    </div>
                    <div className="text-sm text-slate-300 mt-0.5">
                      {round.resting.map((id) => data.playerMap[id]).join(", ")}
                    </div>
                  </div>
                </div>
              )}
            </div>

            <div className="flex gap-3 mt-6">
              <GhostButton
                onClick={() => setCurrentRound((r) => Math.max(0, safeRound - 1))}
                disabled={safeRound === 0}
                icon={ChevronLeft}
                className="flex-1"
              >
                Sebelumnya
              </GhostButton>
              <GhostButton
                onClick={() => setCurrentRound((r) => Math.min(totalRounds - 1, safeRound + 1))}
                disabled={safeRound === totalRounds - 1}
                icon={ChevronRight}
                className="flex-1 flex-row-reverse"
              >
                Berikutnya
              </GhostButton>
            </div>
          </div>
        )}

        {tab === "leaderboard" && (
          <div className="px-6 pt-6">
            <h2 className="font-display text-3xl text-slate-50 mb-1">KLASEMEN</h2>
            <p className="text-slate-500 text-xs mb-3">Tap salah satu tombol untuk urutkan.</p>
            <div className="flex flex-wrap gap-2 mb-4">
              {[
                { key: "wins", label: "W-L-T" },
                { key: "diff", label: "Selisih Poin" },
                { key: "winPercent", label: "Win%" },
                { key: "ppm", label: "PPM" },
              ].map((opt) => (
                <button
                  key={opt.key}
                  onClick={() => setLbSortBy(opt.key)}
                  className={`px-3 py-1.5 rounded-full text-xs font-semibold border ${
                    lbSortBy === opt.key
                      ? "bg-lime-300 text-slate-950 border-lime-300"
                      : "bg-slate-900 text-slate-400 border-slate-700"
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
            {sortedLeaderboard.length === 0 ? (
              <p className="text-slate-500 text-sm">Belum ada skor yang diisi.</p>
            ) : (
              <table className="w-full border-collapse table-fixed">
                <colgroup>
                  <col style={{ width: "6%" }} />
                  <col style={{ width: "34%" }} />
                  <col style={{ width: "8%" }} />
                  <col style={{ width: "13%" }} />
                  <col style={{ width: "13%" }} />
                  <col style={{ width: "13%" }} />
                  <col style={{ width: "13%" }} />
                </colgroup>
                <thead>
                  <tr className="text-[9px] text-slate-500 uppercase tracking-wide">
                    <th className="text-center pb-2">#</th>
                    <th className="text-left pb-2">Nama</th>
                    <th className="text-center pb-2">M</th>
                    {["wlt", "diff", "winPercent", "ppm"]
                      .filter((k) => k !== lbActiveCol)
                      .concat([lbActiveCol])
                      .map((k) => (
                        <th
                          key={k}
                          className={`text-right pb-2 pl-1 whitespace-nowrap ${k === lbActiveCol ? "text-lime-300" : ""}`}
                        >
                          {k === "wlt" ? "W-L-T" : k === "diff" ? "+/-" : k === "winPercent" ? "Win%" : "PPM"}
                        </th>
                      ))}
                  </tr>
                </thead>
                <tbody>
                  {sortedLeaderboard.map((p, i) => {
                    const cellVal = (k) =>
                      k === "wlt"
                        ? `${p.wins}-${p.losses}-${p.ties}`
                        : k === "diff"
                        ? p.diff > 0
                          ? `+${p.diff}`
                          : p.diff
                        : k === "winPercent"
                        ? `${Math.round(p.winPercent)}%`
                        : p.ppm.toFixed(1);
                    return (
                      <tr key={p.id} className={`border-t border-slate-800 ${i === 0 ? "bg-lime-400/5" : ""}`}>
                        <td className={`py-2.5 text-center font-display text-base ${i === 0 ? "text-lime-300" : "text-slate-500"}`}>
                          {i + 1}
                        </td>
                        <td className="py-2.5 font-semibold text-slate-100 truncate text-[13px]">{p.name}</td>
                        <td className="py-2.5 text-center font-mono2 text-[11px] text-slate-400">{p.matches}</td>
                        {["wlt", "diff", "winPercent", "ppm"]
                          .filter((k) => k !== lbActiveCol)
                          .concat([lbActiveCol])
                          .map((k) => (
                            <td
                              key={k}
                              className={`py-2.5 pl-1 text-right font-mono2 text-[11px] whitespace-nowrap ${
                                k === lbActiveCol ? "text-lime-300 font-bold" : "text-slate-400"
                              }`}
                            >
                              {cellVal(k)}
                            </td>
                          ))}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}

            {sortedLeaderboard.length > 0 && (
              <div className="mt-4 pt-4 border-t border-slate-800 space-y-1 text-[11px] text-slate-500">
                <div><span className="text-slate-300 font-semibold">M</span> — jumlah match dimainkan</div>
                <div><span className="text-slate-300 font-semibold">W-L-T</span> — menang-kalah-seri</div>
                <div><span className="text-slate-300 font-semibold">+/-</span> — selisih poin (poin dapat − poin lawan)</div>
                <div><span className="text-slate-300 font-semibold">Win%</span> — persentase match dimenangkan</div>
                <div><span className="text-slate-300 font-semibold">PPM</span> — rata-rata poin per match</div>
              </div>
            )}
          </div>
        )}

        {tab === "recap" && (
          <div className="px-6 pt-6">
            <h2 className="font-display text-3xl text-slate-50 mb-4">REKAP MATCH</h2>
            {players.length > 0 && (
              <div className="flex gap-1.5 overflow-x-auto pb-1 mb-4 -mx-6 px-6">
                <button
                  onClick={() => setRecapFilter("all")}
                  className={`shrink-0 px-3 py-1.5 rounded-full text-xs font-semibold border ${
                    recapFilter === "all"
                      ? "bg-lime-300 text-slate-950 border-lime-300"
                      : "bg-slate-900 text-slate-400 border-slate-700"
                  }`}
                >
                  Semua
                </button>
                {players.map((p) => (
                  <button
                    key={p.id}
                    onClick={() => setRecapFilter(p.id)}
                    className={`shrink-0 px-3 py-1.5 rounded-full text-xs font-semibold border ${
                      recapFilter === p.id
                        ? "bg-lime-300 text-slate-950 border-lime-300"
                        : "bg-slate-900 text-slate-400 border-slate-700"
                    }`}
                  >
                    {p.name}
                  </button>
                ))}
              </div>
            )}
            <div className="space-y-3">
              {filteredRecap.length === 0 && (
                <div className="rounded-2xl border border-dashed border-slate-700 p-6 text-center">
                  <p className="text-slate-500 text-sm">Belum ada match yang diisi skornya.</p>
                </div>
              )}
              {filteredRecap.map((r) => (
                <div key={r.id} className="rounded-2xl border border-slate-800 bg-slate-900/40 overflow-hidden">
                  <div className="px-4 py-2 bg-slate-900 border-b border-slate-800">
                    <span className="text-xs font-bold tracking-widest text-slate-400 uppercase">
                      Ronde {r.round} · Lapangan {r.court}
                    </span>
                  </div>
                  <div className="px-4 py-3 space-y-1.5">
                    <div className="flex items-center justify-between gap-3">
                      <span className={`text-sm truncate ${r.winner === "team1" ? "text-lime-300 font-semibold" : "text-slate-200"}`}>
                        {r.team1.join(" & ")}
                      </span>
                      <span className={`font-mono2 text-lg shrink-0 ${r.winner === "team1" ? "text-lime-300" : "text-slate-400"}`}>
                        {r.a}
                      </span>
                    </div>
                    <div className="flex items-center justify-between gap-3">
                      <span className={`text-sm truncate ${r.winner === "team2" ? "text-lime-300 font-semibold" : "text-slate-200"}`}>
                        {r.team2.join(" & ")}
                      </span>
                      <span className={`font-mono2 text-lg shrink-0 ${r.winner === "team2" ? "text-lime-300" : "text-slate-400"}`}>
                        {r.b}
                      </span>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {tab === "splitbill" && hasSplitBill && (
          <div className="px-6 pt-6">
            <h2 className="font-display text-3xl text-slate-50 mb-4">SPLIT BILL</h2>
            {(() => {
              const court = Number(data.courtCost) || 0;
              const admin = Number(data.adminFee) || 0;
              const ball = Number(data.ballCost) || 0;
              const total = court + admin + ball;
              const n = (data.players || []).length || 1;
              const perPerson = Math.ceil(total / n);
              return (
                <>
                  <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-4 space-y-2">
                    {court > 0 && (
                      <div className="flex items-center justify-between text-sm">
                        <span className="text-slate-400">Harga lapangan</span>
                        <span className="font-mono2 text-slate-200">{formatRupiah(court)}</span>
                      </div>
                    )}
                    {admin > 0 && (
                      <div className="flex items-center justify-between text-sm">
                        <span className="text-slate-400">Biaya admin</span>
                        <span className="font-mono2 text-slate-200">{formatRupiah(admin)}</span>
                      </div>
                    )}
                    {ball > 0 && (
                      <div className="flex items-center justify-between text-sm">
                        <span className="text-slate-400">Biaya bola</span>
                        <span className="font-mono2 text-slate-200">{formatRupiah(ball)}</span>
                      </div>
                    )}
                    <div className="flex items-center justify-between text-sm pt-2 border-t border-slate-800">
                      <span className="text-slate-300 font-semibold">Total</span>
                      <span className="font-mono2 text-slate-100 font-bold">{formatRupiah(total)}</span>
                    </div>
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-slate-400">Jumlah pemain</span>
                      <span className="font-mono2 text-slate-200">{n} orang</span>
                    </div>
                  </div>

                  <div className="mt-4 rounded-2xl border border-lime-400/40 bg-lime-400/5 p-5 text-center">
                    <div className="text-[11px] text-slate-400 uppercase tracking-wide mb-1">
                      Per orang (dibulatkan ke atas)
                    </div>
                    <div className="font-display text-5xl text-lime-300">{formatRupiah(perPerson)}</div>
                  </div>

                  <div className="mt-6 space-y-2">
                    {(data.players || []).map((p) => (
                      <div
                        key={p.id}
                        className="flex items-center justify-between gap-3 rounded-xl border border-slate-800 bg-slate-900/50 px-4 py-3"
                      >
                        <span className="font-semibold text-slate-100 truncate">{p.name}</span>
                        <span className="font-mono2 text-lime-300 font-bold shrink-0">
                          {formatRupiah(perPerson)}
                        </span>
                      </div>
                    ))}
                  </div>
                </>
              );
            })()}
          </div>
        )}
      </div>
      </div>

      <div className="fixed bottom-0 left-0 right-0 bg-slate-950/95 backdrop-blur border-t border-slate-800 flex z-20 max-w-md mx-auto">
        {[
          { key: "session", label: "Jadwal", icon: Clock },
          { key: "leaderboard", label: "Klasemen", icon: Trophy },
          { key: "recap", label: "Rekap", icon: ClipboardList },
          ...(hasSplitBill ? [{ key: "splitbill", label: "Split Bill", icon: Wallet }] : []),
        ].map(({ key, label, icon: Icon }) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={`flex-1 py-3 flex flex-col items-center gap-1 ${
              tab === key ? "text-lime-300" : "text-slate-500"
            }`}
          >
            <Icon size={20} strokeWidth={tab === key ? 2.5 : 2} />
            <span className="text-[11px] font-semibold">{label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ROOT — decides between the editable app and the read-only viewer link
// ---------------------------------------------------------------------------

function AppRoot() {
  const params = new URLSearchParams(window.location.search);
  const viewSessionId = params.get("s");
  if (viewSessionId) {
    return <ViewOnlyApp sessionId={viewSessionId} />;
  }
  return <AmericanoPadel />;
}

export default AppRoot;
