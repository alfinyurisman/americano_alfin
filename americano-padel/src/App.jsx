import React, { useState, useEffect, useRef, useCallback } from "react";
import {
  Plus, X, Users, Clock, Trophy, Shuffle, ChevronLeft, ChevronRight,
  Play, Pause, RotateCcw, Share2, BarChart3, Settings2, Check, Coffee,
  ArrowLeft, Trash2, CalendarDays, ChevronRightCircle,
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

function fmtMMSS(totalSeconds) {
  const s = Math.max(0, Math.round(totalSeconds));
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
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
  const [minutesPerRound, setMinutesPerRound] = useState(15);
  const [breakMinutes, setBreakMinutes] = useState(0);
  const [manualRounds, setManualRounds] = useState(8);
  const [startTime, setStartTime] = useState("19:00");
  const [scoreFormat, setScoreFormat] = useState("points"); // points | tennis
  const [pointTarget, setPointTarget] = useState(21);
  const [tennisTarget, setTennisTarget] = useState(4); // race to N games

  // Session state (post-generate)
  const [engine, setEngine] = useState(null);
  const [playerMap, setPlayerMap] = useState({});
  const [currentRound, setCurrentRound] = useState(0);
  const [scores, setScores] = useState({});
  const [secondsLeft, setSecondsLeft] = useState(0);
  const [timerRunning, setTimerRunning] = useState(false);
  const timerRef = useRef(null);

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
        };
        const next = existing
          ? prev.map((e) => (e.id === id ? entry : e))
          : [entry, ...prev];
        saveLobbyIndex(next);
        return next;
      });
    },
    [activeId, eventName, players, courts, mode, totalMinutes, minutesPerRound, breakMinutes, manualRounds, startTime, scoreFormat, pointTarget, tennisTarget, engine, playerMap, currentRound, scores]
  );

  useEffect(() => {
    if (timerRunning) {
      timerRef.current = setInterval(() => {
        setSecondsLeft((s) => {
          if (s <= 1) {
            setTimerRunning(false);
            if (navigator.vibrate) navigator.vibrate([200, 100, 200]);
            return 0;
          }
          return s - 1;
        });
      }, 1000);
    }
    return () => clearInterval(timerRef.current);
  }, [timerRunning]);

  const resetTimerForRound = (mins) => {
    setTimerRunning(false);
    setSecondsLeft(mins * 60);
  };

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
    resetTimerForRound(minutesPerRound);
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
    setMinutesPerRound(15);
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
    setTimerRunning(false);
    setEventName("");
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
    setMinutesPerRound(data.minutesPerRound ?? 15);
    setBreakMinutes(data.breakMinutes ?? 0);
    setManualRounds(data.manualRounds ?? 8);
    setStartTime(data.startTime || "19:00");
    setScoreFormat(data.scoreFormat || "points");
    setPointTarget(data.pointTarget ?? 21);
    setTennisTarget(data.tennisTarget ?? 4);
    setEngine(data.engine || null);
    setPlayerMap(data.playerMap || {});
    setCurrentRound(data.currentRound || 0);
    setScores(data.scores || {});
    if (data.engine) resetTimerForRound(data.minutesPerRound ?? 15);
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

  const goRound = (delta) => {
    if (!engine) return;
    const next = Math.min(Math.max(0, currentRound + delta), engine.roundsData.length - 1);
    setCurrentRound(next);
    resetTimerForRound(minutesPerRound);
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

  const leaderboard = React.useMemo(() => {
    if (!engine) return [];
    const totals = {};
    Object.keys(playerMap).forEach((id) => {
      totals[id] = {
        id,
        name: playerMap[id],
        points: 0,
        wins: 0,
        matches: engine.playCount[id] || 0,
        rests: engine.restCount[id] || 0,
      };
    });
    engine.roundsData.forEach((rd, rIdx) => {
      rd.courts.forEach((match, cIdx) => {
        const s = scores[`${rIdx}-${cIdx}`];
        const ab = matchAB(s);
        if (!ab) return;
        const { a, b } = ab;
        if (Number.isFinite(a)) match.team1.forEach((id) => (totals[id].points += a));
        if (Number.isFinite(b)) match.team2.forEach((id) => (totals[id].points += b));
        if (Number.isFinite(a) && Number.isFinite(b) && a !== b) {
          if (a > b) match.team1.forEach((id) => (totals[id].wins += 1));
          else match.team2.forEach((id) => (totals[id].wins += 1));
        }
      });
    });
    return Object.values(totals).sort((x, y) => y.points - x.points || y.wins - x.wins);
  }, [engine, playerMap, scores]);

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
          minutesPerRound={minutesPerRound}
          breakMinutes={breakMinutes}
          startTime={startTime}
          secondsLeft={secondsLeft}
          timerRunning={timerRunning}
          setTimerRunning={setTimerRunning}
          resetTimerForRound={() => resetTimerForRound(minutesPerRound)}
          scores={scores}
          setScore={setScore}
          scoreFormat={scoreFormat}
          pointTarget={pointTarget}
          tennisTarget={tennisTarget}
          incrementTennisPoint={incrementTennisPoint}
          resetTennisMatch={resetTennisMatch}
          onNav={setScreen}
          onShare={handleShare}
          onBackToLobby={handleBackToLobby}
          onDelete={() => handleDeleteSession(activeId)}
        />
      )}

      {screen === "leaderboard" && engine && (
        <LeaderboardScreen
          eventName={eventName}
          leaderboard={leaderboard}
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
                      <div className="text-[11px] text-slate-500 mt-1">
                        {ev.playerCount} pemain · {ev.courts} lapangan
                      </div>
                    </div>
                    <ChevronRightCircle size={20} className="text-slate-600 shrink-0 mt-0.5" />
                  </div>
                  <div className="mt-3">
                    {started ? (
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
        {subtitle && <span className="text-xs text-slate-500 font-mono2">{subtitle}</span>}
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
    eventName, engine, playerMap, currentRound, goRound, minutesPerRound, breakMinutes,
    startTime, secondsLeft, timerRunning, setTimerRunning, resetTimerForRound,
    scores, setScore, scoreFormat, pointTarget, tennisTarget,
    incrementTennisPoint, resetTennisMatch,
    onNav, onShare, onBackToLobby, onDelete,
  } = props;

  const totalRounds = engine.roundsData.length;
  const round = engine.roundsData[currentRound];
  const isLast = currentRound === totalRounds - 1;

  const roundClock = (() => {
    const [h, m] = startTime.split(":").map(Number);
    const mins = h * 60 + m + currentRound * (minutesPerRound + breakMinutes);
    const wrapped = ((mins % 1440) + 1440) % 1440;
    const hh = Math.floor(wrapped / 60);
    const mm = Math.round(wrapped % 60);
    return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
  })();

  const pct = totalRounds > 1 ? currentRound / (totalRounds - 1) : 1;

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
          <button onClick={onDelete} className="text-xs text-red-400/80 flex items-center gap-1">
            <Trash2 size={12} /> hapus acara
          </button>
        </div>
        {eventName && (
          <div className="text-sm font-semibold text-slate-200 mb-1 truncate">{eventName}</div>
        )}
        <div className="flex items-center justify-between mb-1">
          <span className="text-xs font-semibold tracking-[0.2em] text-cyan-300 uppercase">
            Ronde {currentRound + 1} / {totalRounds}
          </span>
        </div>
        <div className="mb-3">
          <Chip tone="amber">
            <Trophy size={11} />
            {scoreFormat === "tennis" ? `Race to ${tennisTarget} game` : `Target ${pointTarget} poin`}
          </Chip>
        </div>
        <div className="h-1.5 bg-slate-800 rounded-full overflow-hidden mb-4">
          <div
            className="h-full bg-lime-300 rounded-full transition-all"
            style={{ width: `${pct * 100}%` }}
          />
        </div>

        <div className="flex items-center justify-between">
          <div>
            <div className="font-display text-5xl text-slate-50 leading-none">{roundClock}</div>
            <div className="text-xs text-slate-500 mt-1">estimasi jam mulai ronde ini</div>
          </div>

          <div className="text-right">
            <div
              className={`font-mono2 text-4xl leading-none ${
                secondsLeft <= 10 && timerRunning ? "text-red-400 animate-pulse" : "text-lime-300"
              }`}
            >
              {fmtMMSS(secondsLeft)}
            </div>
            <div className="flex gap-2 mt-2 justify-end">
              <button
                onClick={() => setTimerRunning((r) => !r)}
                className="w-9 h-9 rounded-full bg-slate-900 border border-slate-700 flex items-center justify-center"
              >
                {timerRunning ? <Pause size={15} /> : <Play size={15} className="ml-0.5" />}
              </button>
              <button
                onClick={resetTimerForRound}
                className="w-9 h-9 rounded-full bg-slate-900 border border-slate-700 flex items-center justify-center"
              >
                <RotateCcw size={14} />
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* COURTS */}
      <div className="px-6 pt-6 space-y-5">
        {round.courts.map((match, cIdx) => {
          const key = `${currentRound}-${cIdx}`;
          const s = scores[key] || {};
          return (
            <div key={cIdx} className="rounded-2xl border border-slate-800 overflow-hidden bg-slate-900/40">
              <div className="px-4 py-2 bg-slate-900 border-b border-slate-800">
                <span className="text-xs font-bold tracking-widest text-slate-400 uppercase">
                  Lapangan {cIdx + 1}
                </span>
              </div>
              <div className="grid grid-cols-[1fr_auto_1fr] items-center">
                <TeamSide names={match.team1.map((id) => playerMap[id])} align="right" />
                <div className="flex flex-col items-center px-3">
                  <div className="w-px h-16 bg-gradient-to-b from-transparent via-lime-300/60 to-transparent" />
                  <span className="font-display text-lg text-lime-300 -mt-9 bg-slate-950 px-1">
                    VS
                  </span>
                </div>
                <TeamSide names={match.team2.map((id) => playerMap[id])} align="left" />
              </div>
              {scoreFormat === "tennis" ? (
                <TennisScoreTracker
                  s={s}
                  target={tennisTarget}
                  onPoint={(side) => incrementTennisPoint(cIdx, side)}
                  onReset={() => resetTennisMatch(cIdx)}
                />
              ) : (
                <div className="flex items-center justify-center gap-3 px-4 py-3 border-t border-slate-800">
                  <ScoreInput value={s.a} onChange={(v) => setScore(cIdx, "a", v)} />
                  <span className="text-slate-600 font-mono2">–</span>
                  <ScoreInput value={s.b} onChange={(v) => setScore(cIdx, "b", v)} />
                  <span className="text-[11px] text-slate-500 ml-1">skor (opsional)</span>
                </div>
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

      <div className="px-6 pt-3">
        <GhostButton onClick={onShare} icon={Share2} className="w-full">
          Bagikan jadwal ke WhatsApp
        </GhostButton>
      </div>

      <BottomNav active="session" onNav={onNav} />
    </div>
  );
}

function TeamSide({ names, align }) {
  return (
    <div className={`px-4 py-5 text-${align === "right" ? "right" : "left"}`}>
      {names.map((n, i) => (
        <div key={i} className="font-semibold text-slate-100 leading-tight">
          {n}
        </div>
      ))}
    </div>
  );
}

function ScoreInput({ value, onChange }) {
  return (
    <input
      type="number"
      value={value ?? ""}
      onChange={(e) => onChange(e.target.value)}
      placeholder="–"
      className="w-14 text-center bg-slate-950 border border-slate-700 rounded-lg py-1.5 font-mono2 focus:outline-none focus:ring-2 focus:ring-lime-400/50"
    />
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
      <div className="flex items-center justify-center gap-6 py-3">
        <div className="text-center">
          <div className="font-display text-4xl text-lime-300 leading-none">{gamesA}</div>
          <div className="text-[10px] text-slate-500 uppercase tracking-wide mt-0.5">game</div>
        </div>
        <div className="text-center">
          {finished ? (
            <div className="font-display text-xl text-cyan-300">SELESAI</div>
          ) : (
            <div className="font-mono2 text-lg text-slate-300">
              {labels.a} – {labels.b}
              {labels.deuce && <div className="text-[10px] text-amber-300 mt-0.5">DEUCE</div>}
            </div>
          )}
        </div>
        <div className="text-center">
          <div className="font-display text-4xl text-lime-300 leading-none">{gamesB}</div>
          <div className="text-[10px] text-slate-500 uppercase tracking-wide mt-0.5">game</div>
        </div>
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

function LeaderboardScreen({ eventName, leaderboard, onNav, onBackToLobby }) {
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
            Standing
          </span>
        </div>
        <h1 className="font-display text-5xl text-slate-50">KLASEMEN</h1>
        <p className="text-slate-500 text-sm mt-2">
          Diurutkan dari total poin (lalu jumlah menang) berdasarkan skor yang diinput per match.
        </p>
      </div>

      <div className="px-6 pt-4 space-y-2">
        {leaderboard.length === 0 && (
          <p className="text-slate-500 text-sm">Belum ada pemain.</p>
        )}
        {leaderboard.map((p, i) => (
          <div
            key={p.id}
            className={`flex items-center gap-3 rounded-xl border px-4 py-3 ${
              i === 0
                ? "border-lime-400/40 bg-lime-400/5"
                : "border-slate-800 bg-slate-900/40"
            }`}
          >
            <div
              className={`font-display text-2xl w-8 text-center ${
                i === 0 ? "text-lime-300" : i === 1 ? "text-slate-300" : "text-slate-500"
              }`}
            >
              {i + 1}
            </div>
            <div className="flex-1">
              <div className="font-semibold text-slate-100">{p.name}</div>
              <div className="text-[11px] text-slate-500">
                {p.matches} main · {p.wins} menang · {p.rests} istirahat
              </div>
            </div>
            <div className="text-right">
              <div className="font-mono2 text-lg text-lime-300">{p.points}</div>
              <div className="text-[10px] text-slate-500 uppercase">poin</div>
            </div>
          </div>
        ))}
      </div>

      <BottomNav active="leaderboard" onNav={onNav} />
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

export default AmericanoPadel;
