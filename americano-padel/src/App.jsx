import React, { useState, useEffect, useRef, useCallback } from "react";
import {
  Plus, X, Users, Clock, Trophy, Shuffle, ChevronLeft, ChevronRight,
  RotateCcw, Share2, BarChart3, Settings2, Check, Coffee,
  ArrowLeft, Trash2, CalendarDays, ChevronRightCircle, ClipboardList, Link2, Eye, ListOrdered,
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

const LOBBY_KEY = "padel-lobby-index";
const sessionKey = (id) => `padel-session-${id}`;

// SHARED = true → semua orang yang membuka app ini melihat lobby & sesi yang sama
async function loadLobbyIndex() {
  try {
    const res = await window.storage.get(LOBBY_KEY, true);
    return res ? JSON.parse(res.value) : [];
  } catch (e) {
    return [];
  }
}

async function saveLobbyIndex(list) {
  try {
    await window.storage.set(LOBBY_KEY, JSON.stringify(list), true);
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

// Normalizes a stored match score (either format) into {a, b} raw numbers
// used as "points" for the leaderboard, regardless of scoring style chosen.
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
  return Object.values(totals);
}

// ---------------------------------------------------------------------------
// MAIN APP
// ---------------------------------------------------------------------------

function AmericanoPadel() {
  const [booted, setBooted] = useState(false);
  const [screen, setScreen] = useState("lobby"); // lobby | setup | session | leaderboard | stats
  const [lobby, setLobby] = useState([]); // [{id, name, updatedAt, playerCount, courts, roundsTotal, currentRound}]
  const [activeId, setActiveId] = useState(null);
  const [eventName, setEventName] = useState("");

  // Setup state
  const [players, setPlayers] = useState([]); // [{id, name}]
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

  useEffect(() => {
    (async () => {
      const list = await loadLobbyIndex();
      setLobby(list.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)));
      setBooted(true);
    })();
  }, []);

  const lastAppliedRef = useRef(0);

  // Poll shared storage every few seconds so everyone watching the app
  // (different phones) stays in sync: lobby list while browsing, or the
  // active session's round/scores while inside one.
  useEffect(() => {
    const interval = setInterval(async () => {
      if (screen === "lobby") {
        const list = await loadLobbyIndex();
        setLobby(list.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)));
      } else if (activeId) {
        const saved = await loadSessionData(activeId);
        if (saved && (saved.updatedAt || 0) > lastAppliedRef.current) {
          lastAppliedRef.current = saved.updatedAt || Date.now();
          setEngine(saved.engine || null);
          setPlayerMap(saved.playerMap || {});
          setCurrentRound(saved.currentRound || 0);
          setScores(saved.scores || {});
          setScoreFormat(saved.scoreFormat || "points");
          setPointTarget(saved.pointTarget ?? 21);
          setTennisTarget(saved.tennisTarget ?? 4);
          setEnded(!!saved.ended);
        }
      }
    }, 4000);
    return () => clearInterval(interval);
  }, [screen, activeId]);

  const persist = useCallback(
    (partial, idOverride) => {
      const id = idOverride || activeId;
      if (!id) return;
      const updatedAt = Date.now();
      lastAppliedRef.current = updatedAt;
      const snapshot = {
        id,
        name: eventName,
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
      setLobby((prev) => {
        const existing = prev.find((e) => e.id === id);
        const entry = {
          id,
          name: snapshot.name || "Sesi Padel",
          updatedAt,
          createdAt: existing?.createdAt || updatedAt,
          playerCount: (snapshot.players || []).length,
          courts: snapshot.courts,
          roundsTotal: snapshot.engine ? snapshot.engine.roundsData.length : 0,
          currentRound: snapshot.currentRound || 0,
          ended: !!snapshot.ended,
        };
        const next = existing
          ? prev.map((e) => (e.id === id ? entry : e))
          : [entry, ...prev];
        saveLobbyIndex(next);
        return next;
      });
    },
    [activeId, eventName, players, courts, mode, totalMinutes, minutesPerRound, breakMinutes, manualRounds, startTime, scoreFormat, pointTarget, tennisTarget, ended, engine, playerMap, currentRound, scores]
  );

  const addPlayerFromInput = () => {
    const name = nameInput.trim();
    if (!name) return;
    setPlayers((p) => [...p, { id: uid(), name }]);
    setNameInput("");
  };

  const addBulk = () => {
    const names = bulkInput
      .split(/[\n,]/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (!names.length) return;
    setPlayers((p) => [...p, ...names.map((name) => ({ id: uid(), name }))]);
    setBulkInput("");
  };

  const removePlayer = (id) => setPlayers((p) => p.filter((x) => x.id !== id));

  const computedRounds =
    mode === "duration"
      ? Math.max(1, Math.floor(totalMinutes / (minutesPerRound + breakMinutes)))
      : Math.max(1, manualRounds);

  const usableCourtsPreview = Math.min(courts, Math.floor(players.length / 4));
  const canGenerate = players.length >= 4 && usableCourtsPreview >= 1;

  const handleGenerate = () => {
    const ids = players.map((p) => p.id);
    const map = {};
    players.forEach((p) => (map[p.id] = p.name));
    const result = generateSchedule(ids, courts, computedRounds);
    const id = activeId || uid();
    const finalName = eventName.trim() || "Sesi Padel";
    setEngine(result);
    setPlayerMap(map);
    setCurrentRound(0);
    setScores({});
    setActiveId(id);
    setEventName(finalName);
    setScreen("session");
    persist(
      {
        name: finalName,
        engine: result,
        playerMap: map,
        currentRound: 0,
        scores: {},
      },
      id
    );
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
    setEngine(null);
    setPlayerMap({});
    setCurrentRound(0);
    setScores({});
    setEventName("");
    setEnded(false);
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
    setEnded(!!data.ended);
    setEngine(data.engine || null);
    setPlayerMap(data.playerMap || {});
    setCurrentRound(data.currentRound || 0);
    setScores(data.scores || {});
    lastAppliedRef.current = data.updatedAt || Date.now();
    setActiveId(id);
    setScreen(data.engine ? "session" : "setup");
  };

  const handleBackToLobby = async () => {
    setScreen("lobby");
    const list = await loadLobbyIndex();
    setLobby(list.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)));
  };

  const handleDeleteSession = async (id) => {
    if (!window.confirm("Hapus acara ini beserta seluruh jadwal & skornya?")) return;
    await deleteSessionData(id);
    setLobby((prev) => {
      const next = prev.filter((e) => e.id !== id);
      saveLobbyIndex(next);
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
    setScreen("leaderboard");
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

  const leaderboard = React.useMemo(
    () => buildLeaderboard(engine, playerMap, scores),
    [engine, playerMap, scores]
  );

  const fairnessStats = React.useMemo(() => {
    if (!engine) return [];
    const ids = Object.keys(playerMap);
    return ids
      .map((id) => {
        const partners = Object.values(engine.partner[id] || {}).filter((v) => v > 0).length;
        const opps = Object.values(engine.opp[id] || {}).filter((v) => v > 0).length;
        return {
          id,
          name: playerMap[id],
          matches: engine.playCount[id] || 0,
          rests: engine.restCount[id] || 0,
          partners,
          opps,
        };
      })
      .sort((a, b) => b.matches - a.matches);
  }, [engine, playerMap]);

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

      {screen === "lobby" && (
        <LobbyScreen
          lobby={lobby}
          onCreateNew={handleCreateNew}
          onOpen={handleOpenSession}
          onDelete={handleDeleteSession}
        />
      )}

      {screen === "setup" && (
        <SetupScreen
          eventName={eventName}
          setEventName={setEventName}
          players={players}
          nameInput={nameInput}
          setNameInput={setNameInput}
          bulkInput={bulkInput}
          setBulkInput={setBulkInput}
          addPlayerFromInput={addPlayerFromInput}
          addBulk={addBulk}
          removePlayer={removePlayer}
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
          computedRounds={computedRounds}
          usableCourtsPreview={usableCourtsPreview}
          canGenerate={canGenerate}
          onGenerate={handleGenerate}
          onBackToLobby={handleBackToLobby}
        />
      )}

      {screen === "session" && engine && (
        <SessionScreen
          eventName={eventName}
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
          ended={ended}
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
          onNav={setScreen}
          onBackToLobby={handleBackToLobby}
        />
      )}

      {screen === "stats" && engine && (
        <StatsScreen
          eventName={eventName}
          stats={fairnessStats}
          totalPlayers={players.length}
          onNav={setScreen}
          onBackToLobby={handleBackToLobby}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// BOTTOM NAV
// ---------------------------------------------------------------------------

function BottomNav({ active, onNav }) {
  const items = [
    { key: "session", label: "Jadwal", icon: Clock },
    { key: "leaderboard", label: "Klasemen", icon: Trophy },
    { key: "recap", label: "Rekap", icon: ClipboardList },
    { key: "stats", label: "Statistik", icon: BarChart3 },
  ];
  return (
    <div className="fixed bottom-0 left-0 right-0 bg-slate-950/95 backdrop-blur border-t border-slate-800 flex z-20">
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

function LobbyScreen({ lobby, onCreateNew, onOpen, onDelete }) {
  return (
    <div className="pb-10">
      <div className="px-6 pt-10 pb-8 border-b border-slate-800 relative overflow-hidden">
        <div className="absolute -right-10 -top-10 w-40 h-40 rounded-full bg-lime-400/10 blur-2xl" />
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
          Buat acara padel baru, atau lanjutkan yang sudah berjalan. Semua orang dengan link ini
          melihat lobby yang sama.
        </p>
      </div>

      <div className="px-6 pt-6">
        <PrimaryButton onClick={onCreateNew} icon={Plus} className="w-full text-lg py-4">
          Buat Acara Baru
        </PrimaryButton>
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
                      </div>
                    </div>
                    <ChevronRightCircle size={20} className="text-slate-600 shrink-0 mt-0.5" />
                  </div>
                  <div className="mt-3">
                    {ev.ended ? (
                      <Chip tone="lime">
                        <Trophy size={11} /> Selesai
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
                <button
                  onClick={() => onDelete(ev.id)}
                  className="w-full flex items-center justify-center gap-1.5 py-2 text-[11px] text-red-400/70 border-t border-slate-800"
                >
                  <Trash2 size={11} /> hapus acara
                </button>
              </div>
            );
          })}
        </div>
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
    players, nameInput, setNameInput, bulkInput, setBulkInput,
    addPlayerFromInput, addBulk, removePlayer,
    courts, setCourts, mode, setMode,
    totalMinutes, setTotalMinutes, minutesPerRound, setMinutesPerRound,
    breakMinutes, setBreakMinutes, manualRounds, setManualRounds,
    startTime, setStartTime,
    scoreFormat, setScoreFormat, pointTarget, setPointTarget,
    tennisTarget, setTennisTarget,
    computedRounds, usableCourtsPreview, canGenerate, onGenerate,
    onBackToLobby,
  } = props;

  const [showBulk, setShowBulk] = useState(false);
  const restingPerRound = Math.max(0, players.length - usableCourtsPreview * 4);

  return (
    <div className="pb-10">
      {/* HERO */}
      <div className="px-6 pt-10 pb-8 border-b border-slate-800 relative overflow-hidden">
        <div className="absolute -right-10 -top-10 w-40 h-40 rounded-full bg-lime-400/10 blur-2xl" />
        <button
          onClick={onBackToLobby}
          className="flex items-center gap-1 text-xs font-semibold text-slate-400 mb-4"
        >
          <ArrowLeft size={13} /> Lobby
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


      {/* PLAYERS */}
      <Section icon={Users} title="Pemain" subtitle={`${players.length} terdaftar`}>
        <div className="flex gap-2 mb-3">
          <input
            value={nameInput}
            onChange={(e) => setNameInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && addPlayerFromInput()}
            placeholder="Nama pemain"
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

        {players.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {players.map((p) => (
              <span
                key={p.id}
                className="inline-flex items-center gap-1.5 bg-slate-900 border border-slate-700 rounded-full pl-3 pr-1.5 py-1.5 text-sm"
              >
                {p.name}
                <button
                  onClick={() => removePlayer(p.id)}
                  className="w-5 h-5 rounded-full bg-slate-800 flex items-center justify-center text-slate-400 hover:text-red-400"
                >
                  <X size={12} />
                </button>
              </span>
            ))}
          </div>
        )}
        {players.length > 0 && players.length < 4 && (
          <p className="text-amber-400 text-xs mt-3">Minimal 4 pemain untuk membentuk 1 lapangan.</p>
        )}
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
      {players.length > 0 && (
        <div className="mx-6 mt-2 mb-6 rounded-2xl border border-slate-800 bg-slate-900/60 p-4">
          <div className="grid grid-cols-3 gap-3 text-center">
            <PreviewStat label="Ronde" value={computedRounds} />
            <PreviewStat label="Court aktif" value={usableCourtsPreview || 0} />
            <PreviewStat label="Istirahat/ronde" value={restingPerRound} />
          </div>
          {usableCourtsPreview === 0 && players.length >= 4 && (
            <p className="text-amber-400 text-xs mt-3">
              Jumlah lapangan terlalu banyak untuk jumlah pemain — turunkan jumlah court.
            </p>
          )}
        </div>
      )}

      <div className="px-6">
        <PrimaryButton
          onClick={onGenerate}
          disabled={!canGenerate}
          icon={Shuffle}
          className="w-full text-lg py-4"
        >
          Buat Jadwal
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
// SESSION SCREEN (round-by-round court/scoreboard view)
// ---------------------------------------------------------------------------

function SessionScreen(props) {
  const {
    eventName, engine, playerMap, currentRound, goRound, goToRound,
    scores, setScore, setPointsPair, resetPointsScore, scoreFormat, pointTarget, tennisTarget,
    incrementTennisPoint, resetTennisMatch,
    ended, onEndEvent,
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
      <div className="px-6 pt-8 pb-5 border-b border-slate-800">
        <div className="flex items-center justify-between mb-2">
          <button
            onClick={onBackToLobby}
            className="flex items-center gap-1 text-xs font-semibold text-slate-400"
          >
            <ArrowLeft size={13} /> Lobby
          </button>
          <div className="flex items-center gap-3">
            {!ended && (
              <button onClick={onEndEvent} className="text-xs text-cyan-300 flex items-center gap-1">
                <Trophy size={12} /> selesaikan
              </button>
            )}
            <button onClick={onDelete} className="text-xs text-red-400/80 flex items-center gap-1">
              <Trash2 size={12} /> hapus acara
            </button>
          </div>
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
          const openModal = scoreFormat === "points" ? () => setScoreModal(cIdx) : undefined;
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
                  onPoint={(side) => incrementTennisPoint(cIdx, side)}
                  onReset={() => resetTennisMatch(cIdx)}
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

      <BottomNav active="session" onNav={onNav} />
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

function TennisScoreTracker({ s, target, onPoint, onReset }) {
  const gamesA = s.gamesA || 0;
  const gamesB = s.gamesB || 0;
  const pointsA = s.pointsA || 0;
  const pointsB = s.pointsB || 0;
  const finished = gamesA >= target || gamesB >= target;
  const labels = tennisPointLabels(pointsA, pointsB);

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
    </div>
  );
}

// ---------------------------------------------------------------------------
// LEADERBOARD / STANDINGS SCREEN
// ---------------------------------------------------------------------------

function LeaderboardScreen({ eventName, leaderboard, ended, onNav, onBackToLobby }) {
  const [sortBy, setSortBy] = useState("wins"); // wins | diff | points

  const sorted = React.useMemo(() => {
    const arr = [...leaderboard];
    if (sortBy === "wins") {
      arr.sort((x, y) => y.wins - x.wins || y.diff - x.diff || y.points - x.points);
    } else if (sortBy === "diff") {
      arr.sort((x, y) => y.diff - x.diff || y.wins - x.wins || y.points - x.points);
    } else {
      arr.sort((x, y) => y.points - x.points || y.wins - x.wins || y.diff - x.diff);
    }
    return arr;
  }, [leaderboard, sortBy]);

  // Column that matches the active sort criterion always renders last (rightmost)
  // and gets highlighted, so it's obvious what the table is currently ordered by.
  const baseColumns = [
    { key: "matches", sortKey: null, label: "M", render: (p) => p.matches },
    { key: "wlt", sortKey: "wins", label: "W-L-T", render: (p) => `${p.wins}-${p.losses}-${p.ties}` },
    {
      key: "diff",
      sortKey: "diff",
      label: "+/-",
      render: (p) => (p.diff > 0 ? `+${p.diff}` : `${p.diff}`),
    },
    { key: "points", sortKey: "points", label: "Poin", render: (p) => p.points },
  ];
  const activeColKey =
    sortBy === "wins" ? "wlt" : sortBy === "diff" ? "diff" : "points";
  const columns = [
    ...baseColumns.filter((c) => c.key !== activeColKey),
    ...baseColumns.filter((c) => c.key === activeColKey),
  ];

  return (
    <div className="pb-24">
      <div className="px-6 pt-10 pb-6 border-b border-slate-800">
        <button
          onClick={onBackToLobby}
          className="flex items-center gap-1 text-xs font-semibold text-slate-400 mb-4"
        >
          <ArrowLeft size={13} /> Lobby
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
        <p className="text-slate-500 text-sm mt-2">
          M = main, W-L-T = menang-kalah-seri, +/- = selisih poin. Tap salah satu untuk urutkan.
        </p>

        <div className="flex gap-2 mt-4">
          {[
            { key: "wins", label: "Game Win" },
            { key: "diff", label: "Selisih Poin" },
            { key: "points", label: "Poin" },
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
          <div className="overflow-x-auto -mx-6 px-6">
            <table className="w-full border-collapse min-w-[380px]">
              <thead>
                <tr className="text-[10px] text-slate-500 uppercase tracking-wide">
                  <th className="text-center pb-2 w-7">#</th>
                  <th className="text-left pb-2">Nama</th>
                  {columns.map((c) => (
                    <th
                      key={c.key}
                      className={`text-right pb-2 pl-3 ${
                        c.key === activeColKey ? "text-lime-300" : ""
                      }`}
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
                      className={`py-2.5 text-center font-display text-lg ${
                        i === 0 ? "text-lime-300" : i === 1 ? "text-slate-300" : "text-slate-500"
                      }`}
                    >
                      {i + 1}
                    </td>
                    <td className="py-2.5 font-semibold text-slate-100 truncate max-w-[110px]">
                      {p.name}
                    </td>
                    {columns.map((c) => (
                      <td
                        key={c.key}
                        className={`py-2.5 pl-3 text-right font-mono2 ${
                          c.key === activeColKey
                            ? "text-lime-300 font-bold text-base"
                            : "text-slate-400"
                        }`}
                      >
                        {c.render(p)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <BottomNav active="leaderboard" onNav={onNav} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// RECAP SCREEN (all scored matches, for monitoring rotation fairness)
// ---------------------------------------------------------------------------

function RecapScreen({ eventName, engine, playerMap, scores, scoreFormat, tennisTarget, onNav, onBackToLobby }) {
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
      <div className="px-6 pt-10 pb-6 border-b border-slate-800">
        <button
          onClick={onBackToLobby}
          className="flex items-center gap-1 text-xs font-semibold text-slate-400 mb-4"
        >
          <ArrowLeft size={13} /> Lobby
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

      <BottomNav active="recap" onNav={onNav} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// STATS SCREEN (fairness proof)
// ---------------------------------------------------------------------------

function StatsScreen({ eventName, stats, totalPlayers, onNav, onBackToLobby }) {
  const maxPossible = Math.max(0, totalPlayers - 1);
  return (
    <div className="pb-24">
      <div className="px-6 pt-10 pb-6 border-b border-slate-800">
        <button
          onClick={onBackToLobby}
          className="flex items-center gap-1 text-xs font-semibold text-slate-400 mb-4"
        >
          <ArrowLeft size={13} /> Lobby
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
              <span className="font-semibold text-slate-100">{p.name}</span>
              <div className="flex gap-2">
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

      <BottomNav active="stats" onNav={onNav} />
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
  const sortedLeaderboard = React.useMemo(
    () => [...leaderboard].sort((x, y) => y.wins - x.wins || y.diff - x.diff || y.points - x.points),
    [leaderboard]
  );

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

      <div className="px-6 pt-8 pb-4 border-b border-slate-800">
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
            <p className="text-slate-500 text-xs mb-4">
              Diurutkan dari game win, lalu selisih poin, lalu total poin.
            </p>
            {sortedLeaderboard.length === 0 ? (
              <p className="text-slate-500 text-sm">Belum ada skor yang diisi.</p>
            ) : (
              <div className="overflow-x-auto -mx-6 px-6">
                <table className="w-full border-collapse min-w-[380px]">
                  <thead>
                    <tr className="text-[10px] text-slate-500 uppercase tracking-wide">
                      <th className="text-center pb-2 w-7">#</th>
                      <th className="text-left pb-2">Nama</th>
                      <th className="text-right pb-2 pl-3">M</th>
                      <th className="text-right pb-2 pl-3 text-lime-300">W-L-T</th>
                      <th className="text-right pb-2 pl-3">+/-</th>
                      <th className="text-right pb-2 pl-3">Poin</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sortedLeaderboard.map((p, i) => (
                      <tr key={p.id} className={`border-t border-slate-800 ${i === 0 ? "bg-lime-400/5" : ""}`}>
                        <td className={`py-2.5 text-center font-display text-lg ${i === 0 ? "text-lime-300" : "text-slate-500"}`}>
                          {i + 1}
                        </td>
                        <td className="py-2.5 font-semibold text-slate-100 truncate max-w-[110px]">{p.name}</td>
                        <td className="py-2.5 pl-3 text-right font-mono2 text-slate-400">{p.matches}</td>
                        <td className="py-2.5 pl-3 text-right font-mono2 text-lime-300 font-bold">
                          {p.wins}-{p.losses}-{p.ties}
                        </td>
                        <td className="py-2.5 pl-3 text-right font-mono2 text-slate-400">
                          {p.diff > 0 ? `+${p.diff}` : p.diff}
                        </td>
                        <td className="py-2.5 pl-3 text-right font-mono2 text-slate-400">{p.points}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
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
      </div>

      <div className="fixed bottom-0 left-0 right-0 bg-slate-950/95 backdrop-blur border-t border-slate-800 flex z-20">
        {[
          { key: "session", label: "Jadwal", icon: Clock },
          { key: "leaderboard", label: "Klasemen", icon: Trophy },
          { key: "recap", label: "Rekap", icon: ClipboardList },
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
