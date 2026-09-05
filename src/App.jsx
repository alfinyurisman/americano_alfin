import React, { useState, useEffect, useRef, useCallback } from "react";
import {
  Plus, X, Users, Clock, Trophy, Shuffle, ChevronLeft, ChevronRight,
  RotateCcw, Share2, BarChart3, Settings2, Check, Coffee,
  ArrowLeft, Trash2, CalendarDays, ChevronRightCircle, ClipboardList, Link2, Eye, ListOrdered,
  LogOut, Lock, UserCircle2, Shield, Wallet, Handshake, TrendingUp, TrendingDown,
  Pencil,
  Flame, Star, Zap, Target, Camera, MapPin, Swords, Award, UsersRound,
} from "lucide-react";
import tennisIconWhite from "./assets/tennis-icon-white.png";
import padelIconWhite from "./assets/padel-icon-white.png";
import tennisIconBlack from "./assets/tennis-icon-black.png";
import padelIconBlack from "./assets/padel-icon-black.png";

// ---------------------------------------------------------------------------
// SCHEDULING ENGINE
// ---------------------------------------------------------------------------

// A `.sort(() => Math.random() - 0.5)` comparator is a well-known JS
// anti-pattern: sort algorithms can call the comparator on the same pair
// more than once, and an inconsistent comparator (a fresh random value each
// call) doesn't guarantee anything close to a uniform shuffle — it can
// systematically favor certain pairings staying together or apart. This is
// the correct way to randomize order.
function shuffleArray(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function generateSchedule(playerIds, courtsInput, numRounds, seed, roundOffset = 0) {
  const n = playerIds.length;
  const usableCourts = Math.max(0, Math.min(courtsInput, Math.floor(n / 4)));
  const capacity = usableCourts * 4;

  const partner = seed ? JSON.parse(JSON.stringify(seed.partner)) : {};
  const opp = seed ? JSON.parse(JSON.stringify(seed.opp)) : {};
  const playCount = seed ? { ...seed.playCount } : {};
  const restCount = seed ? { ...seed.restCount } : {};
  // lastPlayed tracks the last round each person actually PLAYED (not
  // rested). Selection is driven by "who's waited longest since they last
  // played" — this directly minimizes everyone's wait between turns, which
  // matters a lot when court count is small relative to player count (e.g.
  // 1 court for 14 people): picking who rests by lowest rest-count used to
  // let a "just played" group get stuck resting round after round while
  // their rest-count stayed low relative to everyone else, badly delaying
  // their next turn. Tracking wait-to-play directly avoids that.
  const lastPlayed = seed ? { ...seed.lastPlayed } : {};
  // Tracks, per player, how many consecutive rounds in a row they've been
  // bumped out of a tied "everyone here is equally overdue" group in favor
  // of someone else for variety's sake (see the clump-swap logic below).
  // Bounded to a max of 1 — once someone's already been bumped once, they
  // become fully protected (unconditionally guaranteed) until they play,
  // so nobody ever waits more than one extra round beyond their fair turn
  // because of this mechanism.
  const skipDebt = seed && seed.skipDebt ? { ...seed.skipDebt } : {};
  // Tracks how many rounds in a row someone's played WITHOUT a rest.
  // Matters most for small player counts relative to court capacity (5
  // people on 1 court, especially) — there, every round after the first
  // has just ONE strictly-guaranteed "most overdue" rester, while the
  // other 4 are all tied on wait and freely competitive purely on variety
  // cost. With nothing else bounding that competition, the same person can
  // keep winning "who plays" round after round if it happens to be
  // cost-optimal, occasionally stringing together 6-8 consecutive rounds
  // with no break at all. Capped at 4 in a row below.
  const consecutivePlays = seed && seed.consecutivePlays ? { ...seed.consecutivePlays } : {};

  playerIds.forEach((id) => {
    if (playCount[id] === undefined) playCount[id] = 0;
    if (restCount[id] === undefined) restCount[id] = 0;
    if (lastPlayed[id] === undefined) lastPlayed[id] = -1;
    if (skipDebt[id] === undefined) skipDebt[id] = 0;
    if (consecutivePlays[id] === undefined) consecutivePlays[id] = 0;
    if (!partner[id]) partner[id] = {};
    if (!opp[id]) opp[id] = {};
    playerIds.forEach((o) => {
      if (o !== id) {
        if (partner[id][o] === undefined) partner[id][o] = 0;
        if (opp[id][o] === undefined) opp[id][o] = 0;
      }
    });
  });

  const roundsData = [];
  // Silent, UI-invisible trace of the reasoning behind each round's
  // selection — who was tied on wait, which tiers/flex pools were
  // considered, what the winning "who plays" cost was, and (for the team
  // split) the cost of every possible pairing, not just the one chosen.
  // Exists purely so a real anomaly report (e.g. "X kept facing Y") can be
  // diagnosed from the actual decision the algorithm made at the time,
  // instead of an after-the-fact reconstruction that can't see randomized
  // trial outcomes or mid-stream seed state. Flows through export only —
  // never rendered in the UI.
  const debugTrace = seed && seed.debugTrace ? [...seed.debugTrace] : [];

  for (let r = 0; r < numRounds; r++) {
    const globalR = r + roundOffset;
    const numResting = n - capacity;
    let resting = [];
    let active = [...playerIds];
    const dbg = { round: globalR, waitTimes: {} };
    playerIds.forEach((id) => (dbg.waitTimes[id] = globalR - lastPlayed[id]));

    if (numResting > 0) {
      // Pre-shuffle once, then sort by wait using a STABLE sort (guaranteed
      // by the JS spec since ES2019) — this preserves the shuffle's random
      // order for anyone tied on wait, instead of re-randomizing on every
      // comparison the way `sort(() => Math.random()-0.5)` would (which
      // can't reliably split up two candidates who are tied with each other
      // on every factor, like two players who joined at the same time).
      const shuffledIds = shuffleArray(playerIds);
      const sorted = [...shuffledIds].sort((a, b) => {
        const waitA = globalR - lastPlayed[a];
        const waitB = globalR - lastPlayed[b];
        return waitB - waitA; // longest wait plays next
      });

      // Anyone waiting strictly LONGER than the cutoff is locked in — their
      // turn is never traded away. Players EXACTLY tied at the cutoff
      // boundary are treated as flexible: among just those, try many
      // combinations and keep whichever gives the best partner/opponent
      // variety — this never costs anyone extra wait time since the tied
      // group is, by construction, always at least as large as the slots
      // needed. When that alone doesn't give much room to work with, we
      // cautiously widen the flexible pool to include people exactly 1
      // round further along too — but ONLY when doing so can't create an
      // unfair repeat: never if the cutoff tier is people who've never
      // played yet (that gap always matters, no matter the numbers), and
      // never if the round below is "just played last round" (wait 1) since
      // reusing them back-to-back is never worth it for variety's sake.
      const cutoffWait = globalR - lastPlayed[sorted[capacity - 1]];
      let guaranteed = sorted.filter((id) => globalR - lastPlayed[id] > cutoffWait);
      const tier0 = sorted.filter((id) => globalR - lastPlayed[id] === cutoffWait);
      dbg.cutoffWait = cutoffWait;
      dbg.guaranteedBeforeClump = [...guaranteed];
      dbg.tier0 = [...tier0];

      // Clump-swap: when 3+ guaranteed players are all tied at the exact
      // same (highest) wait — the classic "everyone who rested last round
      // is unconditionally guaranteed next round" situation with a small
      // court-to-player ratio — that whole group has genuinely equal claim
      // to the next slot, yet locking all of them in every single time
      // repeatedly recombines the same trio and starves partner/opponent
      // variety. So: split them into whoever's already been bumped once
      // (skipDebt >= 1 — fully protected, must play, no exceptions) and
      // whoever hasn't (skipDebt === 0 — eligible to be swapped out this
      // round). The eligible ones join the flex pool below, where the
      // existing variety-optimized trial selection decides — using the
      // same cost function as always — whether swapping one of them out
      // for a tier0 candidate actually helps. If it doesn't help, nothing
      // changes. Debt bookkeeping after `active` is finalized guarantees
      // nobody who gets bumped this way waits more than one extra round.
      let clumpEligible = [];
      if (capacity <= 4 && guaranteed.length >= 3) {
        const topWait = globalR - lastPlayed[guaranteed[0]];
        const tiedAtTop = guaranteed.filter((id) => globalR - lastPlayed[id] === topWait);
        if (tiedAtTop.length >= 3) {
          const eligible = tiedAtTop.filter((id) => (skipDebt[id] || 0) === 0);
          // Keep at least 2 of the tied group unconditionally guaranteed
          // even if all of them are debt-eligible — the swap should trade
          // ONE person's turn for better variety, never gamble with the
          // whole group at once.
          clumpEligible = eligible.slice(0, tiedAtTop.length - 2);
          if (clumpEligible.length > 0) {
            const clumpEligibleSet = new Set(clumpEligible);
            guaranteed = guaranteed.filter((id) => !clumpEligibleSet.has(id));
          }
        }
      }

      const neededFromFlex = capacity - guaranteed.length;
      dbg.clumpEligible = [...clumpEligible];
      dbg.guaranteedAfterClump = [...guaranteed];
      dbg.neededFromFlex = neededFromFlex;

      const cutoffIsNeverPlayedTier = tier0.some((id) => lastPlayed[id] === -1);
      let flexCandidates = tier0;
      if (!cutoffIsNeverPlayedTier && tier0.length < neededFromFlex + 2) {
        const tier1 = sorted.filter((id) => globalR - lastPlayed[id] === cutoffWait - 1);
        // Normally we only reach down a tier when that tier isn't "just
        // played". The exception is when tier0 offers ZERO choice (its size
        // exactly equals the slots needed): with player counts that are an
        // exact multiple of court capacity (8 on 1 court, 16 on 2, ...),
        // strict wait-order forces a perfect A/B alternation, permanently
        // locking everyone into two fixed groups who never mix — the
        // opposite of what an Americano is for. Allowing the swap there
        // costs at most one extra round of waiting but roughly doubles how
        // many different partners and opponents each person sees.
        if (cutoffWait - 1 >= 2 || tier0.length <= neededFromFlex) {
          flexCandidates = [...tier0, ...tier1];
          dbg.tier1Used = [...tier1];
        }
      }
      if (clumpEligible.length > 0) {
        flexCandidates = [...clumpEligible, ...flexCandidates];
      }
      // Hard cap: nobody plays too many rounds in a row if there's ANY
      // alternative — pull them out of the flex pool entirely (forcing a
      // rest this round) unless doing so would leave too few candidates to
      // fill the needed slots, in which case the cap has to give (this
      // should be extremely rare — it'd mean literally everyone eligible
      // has already hit the cap at once).
      //
      // Deliberately a specific threshold PER player count, not a formula
      // — a clean ratio-based rule (capacity/resting) looked appealing but
      // falls apart in practice: it would demand a max streak of just 1 for
      // 8 players, which directly contradicts the 8-player case being
      // provably excellent (perfect fairness, 100% partner variety) with
      // NO streak cap at all, via a completely different mechanism
      // (tier0/tier1 widening — every player is an equally-valid candidate
      // each round, not fixed into a rest-then-play rotation). Only 5 and 6
      // players were shown to actually need this safety net; 7+ is left
      // untouched since it was already validated fine without one.
      const streakCap = n === 5 ? 4 : n === 6 ? 3 : null;
      if (streakCap !== null && capacity <= 4) {
        const overCapIds = flexCandidates.filter((id) => (consecutivePlays[id] || 0) >= streakCap);
        if (overCapIds.length > 0) {
          const withinCap = flexCandidates.filter((id) => (consecutivePlays[id] || 0) < streakCap);
          if (withinCap.length >= neededFromFlex) {
            flexCandidates = withinCap;
            dbg.consecutiveCapApplied = overCapIds;
          }
        }
      }
      dbg.flexCandidates = [...flexCandidates];

      if (flexCandidates.length <= neededFromFlex) {
        active = [...guaranteed, ...flexCandidates];
        dbg.activeSelection = "deterministic"; // no choice to make — everyone in flexCandidates was needed
      } else {
        let bestActive = null;
        let bestActiveCost = Infinity;
        for (let st = 0; st < 60; st++) {
          const shuffledFlex = shuffleArray(flexCandidates);
          const candidateActive = [...guaranteed, ...shuffledFlex.slice(0, neededFromFlex)];
          let cost = 0;
          for (let i = 0; i < candidateActive.length; i++) {
            for (let j = i + 1; j < candidateActive.length; j++) {
              const p1 = candidateActive[i];
              const p2 = candidateActive[j];
              cost += (partner[p1][p2] || 0) * 10 + (opp[p1][p2] || 0);
            }
          }
          // Keep things fair among people who've had EQUAL opportunity so
          // far — e.g. the two-fixed-cohort lock-in case, where the
          // algorithm's own tier selection is what caused an imbalance.
          // Measured as a RATIO (matches played / rounds they've been
          // active for), not a raw count: someone who just arrived late or
          // came back from an injury has few rounds of history, and their
          // ratio defaults to neutral (1) rather than looking "underplayed"
          // — being late is their own tradeoff, not something the algorithm
          // should compensate for by rushing them into extra matches.
          const fairShare = (id) => {
            const roundsEligible = (playCount[id] || 0) + (restCount[id] || 0);
            return roundsEligible > 0 ? playCount[id] / roundsEligible : 1;
          };
          const avgFairShare =
            candidateActive.reduce((s, id) => s + fairShare(id), 0) / candidateActive.length;
          cost += avgFairShare * 150;
          if (cost < bestActiveCost) {
            bestActiveCost = cost;
            bestActive = candidateActive;
          }
        }
        active = bestActive;
        dbg.activeSelection = "trial";
        dbg.activeCost = bestActiveCost;
      }

      const activeSet = new Set(active);
      resting = playerIds.filter((id) => !activeSet.has(id));
      resting.forEach((id) => {
        restCount[id]++;
        consecutivePlays[id] = 0;
      });
      active.forEach((id) => {
        lastPlayed[id] = globalR;
        skipDebt[id] = 0; // playing this round pays off any debt from a previous bump
      });
      // Anyone who was eligible to be swapped out of the guaranteed clump
      // but genuinely didn't make it into `active` this round has now been
      // bumped once — mark them fully protected (guaranteed, no more
      // swapping) until they play, so the wait they take on here is capped
      // at exactly one extra round.
      clumpEligible.forEach((id) => {
        if (!activeSet.has(id)) skipDebt[id] = 1;
      });
    } else {
      dbg.activeSelection = "everyone-plays"; // numResting <= 0
    }
    active.forEach((id) => {
      consecutivePlays[id] = (consecutivePlays[id] || 0) + 1;
    });
    dbg.activeChosen = [...active];

    let bestSplits = null;
    let bestCost = Infinity;
    let bestSplitsDebug = null;
    const trials = active.length <= 8 ? 60 : active.length <= 16 ? 250 : 400;

    for (let t = 0; t < trials; t++) {
      const shuffled = shuffleArray(active);
      const groups = [];
      for (let g = 0; g < usableCourts; g++) {
        groups.push(shuffled.slice(g * 4, g * 4 + 4));
      }

      let cost = 0;
      const splits = [];
      const groupsDebug = [];
      for (const grp of groups) {
        const [a, b, c, d] = grp;
        const options = [
          { t1: [a, b], t2: [c, d] },
          { t1: [a, c], t2: [b, d] },
          { t1: [a, d], t2: [b, c] },
        ];
        let bestOpt = null;
        let bestOptCost = Infinity;
        const optionsDebug = [];
        for (const opt of options) {
          const [p1, p2] = opt.t1;
          const [p3, p4] = opt.t2;
          const partnerCost = partner[p1][p2] * 10 + partner[p3][p4] * 10;
          const oppCost = opp[p1][p3] + opp[p1][p4] + opp[p2][p3] + opp[p2][p4];
          const c1 = partnerCost + oppCost;
          optionsDebug.push({ t1: opt.t1, t2: opt.t2, partnerCost, oppCost, total: c1 });
          if (c1 < bestOptCost) {
            bestOptCost = c1;
            bestOpt = opt;
          }
        }
        cost += bestOptCost;
        splits.push(bestOpt);
        groupsDebug.push({ group: grp, optionsConsidered: optionsDebug, chosen: bestOpt, chosenCost: bestOptCost });
      }

      if (cost < bestCost) {
        bestCost = cost;
        bestSplits = splits;
        bestSplitsDebug = groupsDebug;
      }
    }
    dbg.teamSplit = bestSplitsDebug;

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

    debugTrace.push(dbg);
    roundsData.push({ resting, courts: courtsResult });
  }

  return { roundsData, playCount, restCount, partner, opp, usableCourts, lastPlayed, skipDebt, debugTrace, consecutivePlays };
}

// Fixed Partner mode: partners are fixed pairs decided by the host up front
// (never reshuffled), so the thing that rotates each round is which TEAM
// plays and which opposing team it faces — there's no partner-variety
// question at all since partners never change. Structurally this reuses the
// exact same wait-time-priority skeleton as generateSchedule (guaranteed /
// tier0 / tier1 widening, so a team's turn works the same way an
// individual's does in Americano mode), just with the "player" unit being a
// whole team, and the only cost to minimize being "have these two teams
// already faced each other before."
//
// fixedTeams: [{ teamId, players: [idA, idB] }, ...]
function generateFixedPartnerSchedule(fixedTeams, courtsInput, numRounds, seed, roundOffset = 0) {
  const teamIds = fixedTeams.map((t) => t.teamId);
  const teamById = {};
  fixedTeams.forEach((t) => (teamById[t.teamId] = t));

  const playCount = seed ? { ...seed.playCount } : {};
  const restCount = seed ? { ...seed.restCount } : {};
  const lastPlayed = seed ? { ...seed.lastPlayed } : {};
  const skipDebt = seed && seed.skipDebt ? { ...seed.skipDebt } : {};
  const oppHist = seed ? { ...seed.oppHist } : {};

  teamIds.forEach((id) => {
    if (playCount[id] === undefined) playCount[id] = 0;
    if (restCount[id] === undefined) restCount[id] = 0;
    if (lastPlayed[id] === undefined) lastPlayed[id] = -1;
    if (skipDebt[id] === undefined) skipDebt[id] = 0;
    oppHist[id] = { ...(oppHist[id] || {}) }; // deep-ish copy so we don't mutate the seed's nested object
  });

  const n = teamIds.length;
  const usableCourts = Math.max(1, Math.min(courtsInput, Math.floor(n / 2)));
  const capacity = usableCourts * 2; // teams, not players

  const roundsData = [];
  let active;

  for (let r = 0; r < numRounds; r++) {
    const globalR = roundOffset + r;
    const numResting = n - capacity;

    if (numResting <= 0) {
      active = [...teamIds];
    } else {
      const neverPlayed = teamIds.filter((id) => lastPlayed[id] === -1);
      const previouslyPlayed = teamIds.filter((id) => lastPlayed[id] !== -1);
      const sorted = [
        ...shuffleArray(neverPlayed),
        ...shuffleArray(previouslyPlayed).sort(
          (a, b) => globalR - lastPlayed[b] - (globalR - lastPlayed[a])
        ),
      ];

      const cutoffWait = globalR - lastPlayed[sorted[capacity - 1]];
      let guaranteed = sorted.filter((id) => globalR - lastPlayed[id] > cutoffWait);
      const tier0 = sorted.filter((id) => globalR - lastPlayed[id] === cutoffWait);

      // Same clump-swap safety valve as individual Americano mode: if 3+
      // teams are all tied at the very top wait, let one of them (never
      // more than one at a time, and never twice in a row — skipDebt caps
      // it) be swapped out for better opponent variety, bounded to at most
      // one extra round of rest.
      let clumpEligible = [];
      if (capacity <= 4 && guaranteed.length >= 3) {
        const topWait = globalR - lastPlayed[guaranteed[0]];
        const tiedAtTop = guaranteed.filter((id) => globalR - lastPlayed[id] === topWait);
        if (tiedAtTop.length >= 3) {
          const eligible = tiedAtTop.filter((id) => (skipDebt[id] || 0) === 0);
          clumpEligible = eligible.slice(0, tiedAtTop.length - 2);
          if (clumpEligible.length > 0) {
            const clumpEligibleSet = new Set(clumpEligible);
            guaranteed = guaranteed.filter((id) => !clumpEligibleSet.has(id));
          }
        }
      }

      const neededFromFlex = capacity - guaranteed.length;
      const cutoffIsNeverPlayedTier = tier0.some((id) => lastPlayed[id] === -1);
      let flexCandidates = tier0;
      if (!cutoffIsNeverPlayedTier && tier0.length < neededFromFlex + 2) {
        const tier1 = sorted.filter((id) => globalR - lastPlayed[id] === cutoffWait - 1);
        if (cutoffWait - 1 >= 2 || tier0.length <= neededFromFlex) {
          flexCandidates = [...tier0, ...tier1];
        }
      }
      if (clumpEligible.length > 0) {
        flexCandidates = [...clumpEligible, ...flexCandidates];
      }

      if (flexCandidates.length <= neededFromFlex) {
        active = [...guaranteed, ...flexCandidates];
      } else {
        let bestActive = null;
        let bestActiveCost = Infinity;
        const trials = flexCandidates.length <= 8 ? 60 : 200;
        for (let st = 0; st < trials; st++) {
          const candidateActive = [...guaranteed, ...shuffleArray(flexCandidates).slice(0, neededFromFlex)];
          let cost = 0;
          for (let i = 0; i < candidateActive.length; i++) {
            for (let j = i + 1; j < candidateActive.length; j++) {
              cost += oppHist[candidateActive[i]][candidateActive[j]] || 0;
            }
          }
          const avgFairShare =
            candidateActive.reduce((s, id) => {
              const roundsEligible = playCount[id] + restCount[id];
              return s + (roundsEligible > 0 ? playCount[id] / roundsEligible : 1);
            }, 0) / candidateActive.length;
          cost += avgFairShare * 150;
          if (cost < bestActiveCost) {
            bestActiveCost = cost;
            bestActive = candidateActive;
          }
        }
        active = bestActive;
      }

      const activeSet = new Set(active);
      teamIds.filter((id) => !activeSet.has(id)).forEach((id) => restCount[id]++);
      active.forEach((id) => {
        lastPlayed[id] = globalR;
        skipDebt[id] = 0;
      });
      clumpEligible.forEach((id) => {
        if (!activeSet.has(id)) skipDebt[id] = 1;
      });
    }

    // Pair up the active teams into courts, minimizing repeat matchups.
    let bestPairing = null;
    let bestPairCost = Infinity;
    const pairTrials = active.length <= 8 ? 60 : 200;
    for (let t = 0; t < pairTrials; t++) {
      const shuffled = shuffleArray(active);
      const groups = [];
      for (let g = 0; g < usableCourts; g++) {
        groups.push(shuffled.slice(g * 2, g * 2 + 2));
      }
      let cost = 0;
      groups.forEach(([a, b]) => {
        if (a !== undefined && b !== undefined) cost += oppHist[a][b] || 0;
      });
      if (cost < bestPairCost) {
        bestPairCost = cost;
        bestPairing = groups;
      }
    }

    if (numResting <= 0) {
      active.forEach((id) => {
        lastPlayed[id] = globalR;
        playCount[id] = (playCount[id] || 0) + 1;
      });
    } else {
      active.forEach((id) => {
        playCount[id] = (playCount[id] || 0) + 1;
      });
    }

    const courtsResult = bestPairing
      .filter(([a, b]) => a !== undefined && b !== undefined)
      .map(([a, b]) => {
        oppHist[a][b] = (oppHist[a][b] || 0) + 1;
        oppHist[b][a] = (oppHist[b][a] || 0) + 1;
        return { team1: [...teamById[a].players], team2: [...teamById[b].players], score: null };
      });

    const restingTeams = teamIds.filter((id) => !active.includes(id));
    const resting = restingTeams.flatMap((id) => teamById[id].players);

    roundsData.push({ resting, courts: courtsResult });
  }

  return { roundsData, playCount, restCount, oppHist, usableCourts, lastPlayed, skipDebt };
}

// ---------------------------------------------------------------------------
// MEXICANO — performance-based, single-round-batch matchmaking
// ---------------------------------------------------------------------------
//
// Fundamentally different from Americano/Fixed Partner: those plan the whole
// schedule upfront via simulation. Mexicano can't — round N+1's grouping
// depends on round N's ACTUAL scored results (current standings), which
// don't exist until the score is genuinely submitted. So this generates
// exactly ONE round (a "batch" of however many matches are needed to get
// everyone through at least once) at a time, called fresh right after the
// previous round's score is fully complete.
//
// Design, agreed and tested extensively via simulation:
// 1. WHO plays: identical wait-time fairness to Americano for the base
//    roster — ranking never decides who gets to play, only who partners
//    with / faces whom.
// 2. A "round" is a full batch of ceil(n/4) matches — big enough that
//    everyone gets at least one match. If n isn't a multiple of 4, some
//    players get a second ("extra") match within the SAME round to fill
//    the last slot; the ranking stays locked for the whole batch, only
//    updating once every match in it is scored.
// 3. Once a ranking snapshot exists, active players are grouped into courts
//    IN RANK ORDER (top 4 -> court 1, next 4 -> court 2, ...). Whichever
//    slice is short a player "borrows" one, chosen by (a) fewest total
//    matches so far, then (b) longest wait, then (c) nearest rank as a
//    last-resort tiebreak.
// 4. CRITICAL fairness fix found during testing: who gets an extra
//    (second) match each round batch must be decided PURELY by fewest
//    total matches so far — never by rank position. An earlier version let
//    whoever was ranked at the extreme end of the current snapshot always
//    be the one "short a player," which created a self-reinforcing bias:
//    fewer total matches meant a smaller sample for their win rate, which
//    kept them ranked at that same extreme, which kept them from ever
//    getting the extra that would let them catch up. Verified via
//    simulation to compound over time (a 5-player group's play-count gap
//    grew past 5 over 80 rounds) rather than settle down on its own.
//    Fairness decides who plays extra; ranking only decides who partners/
//    faces whom among however many show up.
// 5. Within each group of 4, the freshest (least-repeated) partner/
//    opponent split is tried first; genuine ties are broken RANDOMLY —
//    never a fixed "#1+#4 vs #2+#3" convention, since always defaulting to
//    that (rather than evaluating fresh options first) was explicitly
//    identified as wrong.
function generateMexicanoRoundBatch(playerIds, courtsInput, seed) {
  const n = playerIds.length;
  const matchesNeeded = Math.ceil(n / 4);
  const usableCourts = Math.max(1, Math.min(courtsInput, matchesNeeded));

  const lastPlayed = { ...(seed?.lastPlayed || {}) };
  const playCount = { ...(seed?.playCount || {}) };
  const restCount = { ...(seed?.restCount || {}) };
  const partner = {}, opp = {};
  playerIds.forEach((id) => {
    if (playCount[id] === undefined) playCount[id] = 0;
    if (restCount[id] === undefined) restCount[id] = 0;
    if (lastPlayed[id] === undefined) lastPlayed[id] = -1;
    partner[id] = { ...(seed?.partner?.[id] || {}) };
    opp[id] = { ...(seed?.opp?.[id] || {}) };
  });
  const rankingSnapshot = seed?.rankingSnapshot ? [...seed.rankingSnapshot] : null;
  const roundNum = seed?.roundNum ?? 0;

  // --- STEP 1: WHO gets an extra (second) match this round -- decided
  // PURELY by fairness (fewest total plays so far), completely independent
  // of ranking. This separation is critical: an earlier version let
  // ranking position decide who's "short a player" each round, which
  // created a real, compounding unfairness bug — whoever was ranked lowest
  // kept getting stuck with fewer total matches (no extra), which meant a
  // smaller sample size for their win rate, which kept them ranked lowest,
  // in a self-reinforcing loop that got WORSE over many rounds (verified:
  // 5-player groups drifted to a play-count gap of 5+ over 80 rounds before
  // this fix). Fairness must decide who plays extra; ranking only decides
  // who partners/faces whom among however many show up.
  const extraNeeded = matchesNeeded * 4 - n;
  let active2x = [];
  if (extraNeeded > 0) {
    const sortedByFairness = [...playerIds].sort((x, y) => {
      if (playCount[x] !== playCount[y]) return playCount[x] - playCount[y];
      return lastPlayed[x] - lastPlayed[y];
    });
    active2x = sortedByFairness.slice(0, extraNeeded);
  }

  // --- STEP 2: grouping for competitive balance -- ranking decides order ---
  const ordered = rankingSnapshot ? [...rankingSnapshot] : shuffleArray(playerIds);
  if (rankingSnapshot) {
    // Someone in the roster but not yet in the ranking snapshot (joined
    // mid-event, after the last lock) would otherwise silently vanish from
    // every round from here on — append them rather than drop them.
    playerIds.forEach((id) => {
      if (!ordered.includes(id)) ordered.push(id);
    });
  }

  const slots = [...ordered, ...active2x];
  let groups = [];
  for (let g = 0; g < matchesNeeded; g++) {
    groups.push(slots.slice(g * 4, g * 4 + 4));
  }

  // --- STEP 3: resolve any self-collision (someone's fairness-earned
  // extra slot landing in the SAME group as their primary slot, which can
  // happen since extras are chosen without regard to rank position) by
  // swapping with someone from another group who isn't already doubled up
  // and isn't already in the colliding group.
  for (let gi = 0; gi < groups.length; gi++) {
    const grp = groups[gi];
    const seen = new Set();
    for (let i = 0; i < grp.length; i++) {
      if (seen.has(grp[i])) {
        for (let gj = 0; gj < groups.length; gj++) {
          if (gj === gi) continue;
          let swapped = false;
          for (let j = 0; j < groups[gj].length; j++) {
            const candidate = groups[gj][j];
            if (candidate !== grp[i] && !grp.includes(candidate) && groups[gj].filter((x) => x === grp[i]).length === 0) {
              const temp = groups[gi][i];
              groups[gi][i] = candidate;
              groups[gj][j] = temp;
              swapped = true;
              break;
            }
          }
          if (swapped) break;
        }
      }
      seen.add(grp[i]);
    }
  }

  const playedThisRound = {};
  playerIds.forEach((id) => (playedThisRound[id] = 0));

  const matches = groups.map((grp) => {
    const [a, b, c, d] = grp;
    const options = [
      { t1: [a, b], t2: [c, d] },
      { t1: [a, c], t2: [b, d] },
      { t1: [a, d], t2: [b, c] },
    ];
    const costed = options.map((opt) => {
      const [p1, p2] = opt.t1, [p3, p4] = opt.t2;
      const cost =
        (partner[p1][p2] || 0) * 10 +
        (partner[p3][p4] || 0) * 10 +
        (opp[p1][p3] || 0) +
        (opp[p1][p4] || 0) +
        (opp[p2][p3] || 0) +
        (opp[p2][p4] || 0);
      return { opt, cost };
    });
    const minCost = Math.min(...costed.map((c) => c.cost));
    const tied = costed.filter((c) => c.cost === minCost);
    const chosen = tied.length === 1 ? tied[0].opt : tied[Math.floor(Math.random() * tied.length)].opt;

    const [t1a, t1b] = chosen.t1, [t2a, t2b] = chosen.t2;
    partner[t1a][t1b] = (partner[t1a][t1b] || 0) + 1;
    partner[t1b][t1a] = (partner[t1b][t1a] || 0) + 1;
    partner[t2a][t2b] = (partner[t2a][t2b] || 0) + 1;
    partner[t2b][t2a] = (partner[t2b][t2a] || 0) + 1;
    [t1a, t1b].forEach((x) =>
      [t2a, t2b].forEach((y) => {
        opp[x][y] = (opp[x][y] || 0) + 1;
        opp[y][x] = (opp[y][x] || 0) + 1;
      })
    );
    grp.forEach((id) => {
      playedThisRound[id]++;
      lastPlayed[id] = roundNum;
      playCount[id]++;
    });

    return { team1: chosen.t1, team2: chosen.t2 };
  });

  playerIds.forEach((id) => {
    if (playedThisRound[id] === 0) restCount[id]++;
  });

  return {
    matches,
    groups,
    playedThisRound,
    lastPlayed,
    playCount,
    restCount,
    partner,
    opp,
    usableCourts,
    matchesNeeded,
  };
}

// Fixed-Team counterpart: same round-batch/ranking-lock structure, but the
// "unit" being ranked, grouped, and matched is a whole (already-fixed) team
// rather than an individual — so there's no re-pairing step within a group
// of 4 people, just deciding which of the (up to) two teams in each rank
// group face each other, prioritizing opponent freshness with random
// tie-break, same as the individual version's partner+opponent logic
// simplified to opponent-only.
function generateMexicanoFixedTeamRoundBatch(teams, courtsInput, seed) {
  // teams: [{ id, players: [idA, idB] }, ...]
  const n = teams.length;
  const matchesNeeded = Math.ceil(n / 2);
  const usableCourts = Math.max(1, Math.min(courtsInput, matchesNeeded));

  const lastPlayed = { ...(seed?.lastPlayed || {}) };
  const playCount = { ...(seed?.playCount || {}) };
  const restCount = { ...(seed?.restCount || {}) };
  const opp = {};
  teams.forEach((t) => {
    if (playCount[t.id] === undefined) playCount[t.id] = 0;
    if (restCount[t.id] === undefined) restCount[t.id] = 0;
    if (lastPlayed[t.id] === undefined) lastPlayed[t.id] = -1;
    opp[t.id] = { ...(seed?.opp?.[t.id] || {}) };
  });
  const rankingSnapshot = seed?.rankingSnapshot ? [...seed.rankingSnapshot] : null;
  const roundNum = seed?.roundNum ?? 0;
  const teamIds = teams.map((t) => t.id);
  const teamById = Object.fromEntries(teams.map((t) => [t.id, t]));

  // Same fairness-first fix as the individual/rotating version: who gets
  // the extra match is decided purely by fewest total matches so far,
  // never by rank position — letting rank decide that created a
  // compounding fairness bug (whoever ranked at the extreme end never got
  // to provide the "extra", so they never caught up).
  const extraNeeded = matchesNeeded * 2 - n;
  let active2x = [];
  if (extraNeeded > 0) {
    const sortedByFairness = [...teamIds].sort((x, y) => {
      if (playCount[x] !== playCount[y]) return playCount[x] - playCount[y];
      return lastPlayed[x] - lastPlayed[y];
    });
    active2x = sortedByFairness.slice(0, extraNeeded);
  }

  const ordered = rankingSnapshot ? [...rankingSnapshot] : shuffleArray(teamIds);
  if (rankingSnapshot) {
    teamIds.forEach((id) => {
      if (!ordered.includes(id)) ordered.push(id);
    });
  }

  const slots = [...ordered, ...active2x];
  let groups = [];
  for (let g = 0; g < matchesNeeded; g++) {
    groups.push(slots.slice(g * 2, g * 2 + 2));
  }

  // Resolve any self-collision the same way as the individual version.
  for (let gi = 0; gi < groups.length; gi++) {
    const grp = groups[gi];
    const seen = new Set();
    for (let i = 0; i < grp.length; i++) {
      if (seen.has(grp[i])) {
        for (let gj = 0; gj < groups.length; gj++) {
          if (gj === gi) continue;
          let swapped = false;
          for (let j = 0; j < groups[gj].length; j++) {
            const candidate = groups[gj][j];
            if (candidate !== grp[i] && !grp.includes(candidate) && groups[gj].filter((x) => x === grp[i]).length === 0) {
              const temp = groups[gi][i];
              groups[gi][i] = candidate;
              groups[gj][j] = temp;
              swapped = true;
              break;
            }
          }
          if (swapped) break;
        }
      }
      seen.add(grp[i]);
    }
  }

  const playedThisRound = {};
  teamIds.forEach((id) => (playedThisRound[id] = 0));

  const matches = groups.map(([team1Id, team2Id]) => {
    opp[team1Id][team2Id] = (opp[team1Id][team2Id] || 0) + 1;
    opp[team2Id][team1Id] = (opp[team2Id][team1Id] || 0) + 1;
    [team1Id, team2Id].forEach((id) => {
      playedThisRound[id]++;
      lastPlayed[id] = roundNum;
      playCount[id]++;
    });
    return { team1: teamById[team1Id].players, team2: teamById[team2Id].players, team1Id, team2Id };
  });

  teamIds.forEach((id) => {
    if (playedThisRound[id] === 0) restCount[id]++;
  });

  return {
    matches,
    groups,
    playedThisRound,
    lastPlayed,
    playCount,
    restCount,
    opp,
    usableCourts,
    matchesNeeded,
  };
}

// Ranking philosophy matches the app's normal Klasemen: Win% first, then
// point differential, then total points as a final tiebreak — NOT just raw
// cumulative points. This matters specifically for players/teams added
// mid-event: someone brand new has 0 matches (win% treated as 0, diff 0),
// which can genuinely rank ABOVE an existing player who's 0% win rate with
// a NEGATIVE point differential — new blood isn't assumed worse than a
// proven loser, just unproven.
function lockNewMexicanoRanking(unitIds, matches, scores, seed) {
  const wins = { ...(seed.wins || {}) };
  const losses = { ...(seed.losses || {}) };
  const ties = { ...(seed.ties || {}) };
  const matchesPlayed = { ...(seed.matchesPlayed || {}) };
  const diff = { ...(seed.diff || {}) };
  const cumulativePoints = { ...(seed.cumulativePoints || {}) };
  unitIds.forEach((id) => {
    if (wins[id] === undefined) wins[id] = 0;
    if (losses[id] === undefined) losses[id] = 0;
    if (ties[id] === undefined) ties[id] = 0;
    if (matchesPlayed[id] === undefined) matchesPlayed[id] = 0;
    if (diff[id] === undefined) diff[id] = 0;
    if (cumulativePoints[id] === undefined) cumulativePoints[id] = 0;
  });

  matches.forEach((match, i) => {
    const ab = matchAB(scores[i]);
    if (!ab) return;
    // team1/team2 disini bisa array pemain (rotating) ATAU array pemain dari
    // 1 tim tetap (fixed) -- caller yang nentuin apakah unitIds itu id
    // pemain atau id tim; utk fixed, caller pass team1Id/team2Id lewat match.
    const team1Ids = match.team1Id ? [match.team1Id] : match.team1;
    const team2Ids = match.team2Id ? [match.team2Id] : match.team2;
    team1Ids.forEach((id) => {
      cumulativePoints[id] += ab.a;
      diff[id] += ab.a - ab.b;
      matchesPlayed[id] += 1;
    });
    team2Ids.forEach((id) => {
      cumulativePoints[id] += ab.b;
      diff[id] += ab.b - ab.a;
      matchesPlayed[id] += 1;
    });
    if (ab.a > ab.b) {
      team1Ids.forEach((id) => (wins[id] += 1));
      team2Ids.forEach((id) => (losses[id] += 1));
    } else if (ab.b > ab.a) {
      team2Ids.forEach((id) => (wins[id] += 1));
      team1Ids.forEach((id) => (losses[id] += 1));
    } else {
      team1Ids.forEach((id) => (ties[id] += 1));
      team2Ids.forEach((id) => (ties[id] += 1));
    }
  });

  const winPercentOf = (id) => (matchesPlayed[id] > 0 ? wins[id] / matchesPlayed[id] : 0);
  const rankingSnapshot = [...unitIds].sort((x, y) => {
    const wpX = winPercentOf(x), wpY = winPercentOf(y);
    if (wpX !== wpY) return wpY - wpX;
    if (diff[x] !== diff[y]) return diff[y] - diff[x];
    return cumulativePoints[y] - cumulativePoints[x];
  });

  return { wins, losses, ties, matchesPlayed, diff, cumulativePoints, rankingSnapshot };
}

// Editing a typo in an EARLIER round's score (not the current in-progress
// one) doesn't retroactively change who played whom — match compositions
// for already-played rounds stay exactly as they were, since that's what
// genuinely happened on court. What DOES need to change is every ranking
// computed from that point forward, since a corrected score shifts
// cumulative points/wins for everyone in that match, which cascades into
// win%/diff for the ranking, which is what later rounds' groupings were
// based on. This replays lockNewMexicanoRanking sequentially through every
// round that has a recorded score, rebuilding the full ranking history
// (and cumulative stats) as if the correction had been there from the
// start — WITHOUT touching any round's actual match composition.
function replayMexicanoRankingHistory(unitIds, roundsData, scores) {
  let cumulativePoints = {}, wins = {}, losses = {}, ties = {}, matchesPlayed = {}, diff = {};
  const rankingSnapshotByRound = [null]; // round 0 is always pre-ranking (random)
  let rankingSnapshot = null;

  for (let rIdx = 0; rIdx < roundsData.length; rIdx++) {
    const rd = roundsData[rIdx];
    const scoreEntries = rd.courts.map((_, cIdx) => scores[`${rIdx}-${cIdx}`]);
    const roundFullyScored = rd.courts.every((_, cIdx) => isMatchScoreComplete(scoreEntries[cIdx]));
    if (!roundFullyScored) {
      // First not-(fully-)scored round — nothing beyond this point has a
      // real result yet, so the replay stops here. Whatever ranking was
      // locked most recently is what the (regenerated) current round
      // should use.
      break;
    }
    const locked = lockNewMexicanoRanking(unitIds, rd.courts, scoreEntries, {
      cumulativePoints,
      wins,
      losses,
      ties,
      matchesPlayed,
      diff,
    });
    cumulativePoints = locked.cumulativePoints;
    wins = locked.wins;
    losses = locked.losses;
    ties = locked.ties;
    matchesPlayed = locked.matchesPlayed;
    diff = locked.diff;
    rankingSnapshot = locked.rankingSnapshot;
    rankingSnapshotByRound[rIdx + 1] = rankingSnapshot;
  }

  return { cumulativePoints, wins, losses, ties, matchesPlayed, diff, rankingSnapshot, rankingSnapshotByRound };
}

// is locked and untouched — you can't retroactively un-play a match. Only
// the not-yet-scored matches get rebuilt, using whoever's left in the
// active roster once already-committed players (from the scored matches)
// are set aside. The count of remaining matches can genuinely grow or
// shrink from what it was before, since it's simply ceil(remaining pool /
// 4) — not pinned to the original unscored count.
//
// Rejects (returns {rejected: true, reason}) rather than producing a
// broken round if either: the new total active roster drops below the
// minimum for even one court (4 players), or — a subtler case — enough of
// the remaining pool is already "used up" by players who happen to also be
// committed to an already-scored match this round (can happen when
// someone's extra-match appearance was in the scored match) that fewer
// than 4 people are left for the unscored portion.
function regenerateMexicanoCurrentRound(activePlayerIds, courtsInput, currentRoundCourts, scoresForRound, seed) {
  const scoredIdx = [], unscoredIdx = [];
  currentRoundCourts.forEach((c, i) => {
    (isMatchScoreComplete(scoresForRound[i]) ? scoredIdx : unscoredIdx).push(i);
  });
  if (unscoredIdx.length === 0) return { unchanged: true };

  if (activePlayerIds.length < 4) {
    return { rejected: true, reason: `Minimal 4 pemain aktif diperlukan. Sekarang cuma ${activePlayerIds.length}.` };
  }

  const committed = new Set();
  scoredIdx.forEach((i) => {
    const m = currentRoundCourts[i];
    [...m.team1, ...m.team2].forEach((id) => committed.add(id));
  });
  const remainingPool = activePlayerIds.filter((id) => !committed.has(id));

  if (remainingPool.length < 4) {
    return {
      rejected: true,
      reason: `Cuma tersisa ${remainingPool.length} pemain buat sisa match ronde ini (minimal 4 dibutuhkan) — sebagian pemain aktif sekarang udah "kepake" di match yang sudah diskor duluan. Tunggu ronde berikutnya buat perubahan ini berlaku.`,
    };
  }

  const n = remainingPool.length;
  const newMatchesNeeded = Math.ceil(n / 4);
  const partner = {}, opp = {};
  const playCount = { ...(seed.playCount || {}) };
  const lastPlayed = { ...(seed.lastPlayed || {}) };
  remainingPool.forEach((id) => {
    partner[id] = { ...(seed.partner?.[id] || {}) };
    opp[id] = { ...(seed.opp?.[id] || {}) };
    if (playCount[id] === undefined) playCount[id] = 0;
    if (lastPlayed[id] === undefined) lastPlayed[id] = -1;
  });

  // Same fairness-first separation as generateMexicanoRoundBatch: who gets
  // the extra slot among the remaining pool is decided by fewest total
  // matches so far, never by rank position.
  const extraNeeded = newMatchesNeeded * 4 - n;
  let active2x = [];
  if (extraNeeded > 0) {
    const sortedByFairness = [...remainingPool].sort((x, y) => {
      if (playCount[x] !== playCount[y]) return playCount[x] - playCount[y];
      return lastPlayed[x] - lastPlayed[y];
    });
    active2x = sortedByFairness.slice(0, extraNeeded);
  }

  const rankingSnapshot = seed.rankingSnapshot ? seed.rankingSnapshot.filter((id) => remainingPool.includes(id)) : null;
  if (rankingSnapshot) {
    remainingPool.forEach((id) => {
      if (!rankingSnapshot.includes(id)) rankingSnapshot.push(id);
    });
  }
  const ordered = rankingSnapshot || remainingPool;

  const slots = [...ordered, ...active2x];
  let groups = [];
  for (let g = 0; g < newMatchesNeeded; g++) {
    groups.push(slots.slice(g * 4, g * 4 + 4));
  }

  // Resolve any self-collision the same way as generateMexicanoRoundBatch.
  for (let gi = 0; gi < groups.length; gi++) {
    const grp = groups[gi];
    const seen = new Set();
    for (let i = 0; i < grp.length; i++) {
      if (seen.has(grp[i])) {
        for (let gj = 0; gj < groups.length; gj++) {
          if (gj === gi) continue;
          let swapped = false;
          for (let j = 0; j < groups[gj].length; j++) {
            const candidate = groups[gj][j];
            if (candidate !== grp[i] && !grp.includes(candidate) && groups[gj].filter((x) => x === grp[i]).length === 0) {
              const temp = groups[gi][i];
              groups[gi][i] = candidate;
              groups[gj][j] = temp;
              swapped = true;
              break;
            }
          }
          if (swapped) break;
        }
      }
      seen.add(grp[i]);
    }
  }

  const newMatches = groups.map((grp) => {
    const [a, b, c, d] = grp;
    const options = [
      { t1: [a, b], t2: [c, d] },
      { t1: [a, c], t2: [b, d] },
      { t1: [a, d], t2: [b, c] },
    ];
    const costed = options.map((opt) => {
      const [p1, p2] = opt.t1, [p3, p4] = opt.t2;
      const cost =
        (partner[p1][p2] || 0) * 10 +
        (partner[p3][p4] || 0) * 10 +
        (opp[p1][p3] || 0) +
        (opp[p1][p4] || 0) +
        (opp[p2][p3] || 0) +
        (opp[p2][p4] || 0);
      return { opt, cost };
    });
    const min = Math.min(...costed.map((c) => c.cost));
    const tied = costed.filter((c) => c.cost === min);
    const chosen = tied[Math.floor(Math.random() * tied.length)].opt;
    return { team1: chosen.t1, team2: chosen.t2 };
  });

  const rebuiltCourts = scoredIdx.map((i) => currentRoundCourts[i]).concat(newMatches);
  return { courts: rebuiltCourts, scoredCount: scoredIdx.length, newUnscoredCount: newMatches.length };
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
    return true;
  } catch (e) {
    console.error("Gagal menyimpan sesi:", e);
    return false;
  }
}

async function deleteSessionData(id) {
  try {
    await window.storage.delete(sessionKey(id), true);
  } catch (e) {
    /* no-op */
  }
}

// "Soft delete" — the session data itself is tagged deleted (rather than
// erased) so a share link can be checked against this flag directly. The
// real data stays in place until the 7-day auto-purge sweep removes it.
async function markSessionDataDeleted(id) {
  const data = await loadSessionData(id);
  if (!data) return;
  await saveSessionData(id, { ...data, deleted: true, deletedAt: Date.now() });
}

// ---------------------------------------------------------------------------
// PARTNER SYNERGY — per-player match log
// ---------------------------------------------------------------------------
// Each logged-in player has one log of their own match history (every match
// they've ever finished, across every event, tagged with who their partner
// was). Everything the Partner Synergy feature shows — pair stats, "with vs
// without" comparisons, top partners, trend — is derived from this log
// rather than a separate table per pair, since a person's matches are a
// natural, single source of truth for all of it.
//
// IMPORTANT SCOPE NOTE: this only works for players with an accountId
// (registered/logged-in users). A manually-typed guest name has no stable
// identity across different events, so there's no reliable way to link
// "Budi" in event A with "Budi" in event B — guest-only players simply don't
// get logged here.
const PLAYER_LOG_MAX = 400; // cap how many recent matches we keep per player

const playerLogKey = (accountId) => `player-match-log:${accountId}`;

async function loadPlayerMatchLog(accountId) {
  if (!accountId) return [];
  try {
    const res = await window.storage.get(playerLogKey(accountId), true);
    return res ? JSON.parse(res.value) : [];
  } catch (e) {
    return [];
  }
}

async function appendPlayerMatchRecords(accountId, records) {
  if (!accountId || !records.length) return;
  try {
    const existing = await loadPlayerMatchLog(accountId);
    // Second, independent line of defense against double-logging (beyond
    // the loggedMatchKeys guard): never add a record whose matchKey is
    // already present, no matter how it got here.
    const existingKeys = new Set(existing.map((r) => r.matchKey).filter(Boolean));
    const fresh = records.filter((r) => !r.matchKey || !existingKeys.has(r.matchKey));
    if (fresh.length === 0) return;
    const merged = [...existing, ...fresh].slice(-PLAYER_LOG_MAX);
    await window.storage.set(playerLogKey(accountId), JSON.stringify(merged), true);
  } catch (e) {
    console.error("Gagal menyimpan log pertandingan:", e);
  }
}

// Events the host has marked as "don't count toward statistics" (trial runs,
// practice sessions, testing). Kept as one shared list of event ids rather
// than deleting log entries, so the setting can be flipped back and forth at
// any time — including long after the event ended — without ever destroying
// match history. Every stats reader filters through this.
const EXCLUDED_EVENTS_KEY = "stats-excluded-events";

async function loadExcludedEvents() {
  try {
    const res = await window.storage.get(EXCLUDED_EVENTS_KEY, true);
    return new Set(res ? JSON.parse(res.value) : []);
  } catch (e) {
    return new Set();
  }
}

async function setEventExcluded(eventId, excluded) {
  if (!eventId) return;
  try {
    const current = await loadExcludedEvents();
    if (excluded) current.add(eventId);
    else current.delete(eventId);
    await window.storage.set(EXCLUDED_EVENTS_KEY, JSON.stringify([...current]), true);
  } catch (e) {
    console.error("Gagal menyimpan pengaturan statistik:", e);
  }
}

// The one function every stats screen should use: a player's match history
// with excluded events already filtered out.
async function loadCountedMatchLog(accountId) {
  const [log, excluded] = await Promise.all([
    loadPlayerMatchLog(accountId),
    loadExcludedEvents(),
  ]);
  return log.filter((r) => !excluded.has(r.eventId));
}

// One-time repair for logs written before matchKey-based dedup existed:
// collapses near-duplicate entries that are almost certainly the same match
// double-logged by the old poll race condition — identical partner/opponents
// /score within the same event, recorded within seconds of each other. Real
// distinct matches essentially never share every one of those exactly AND
// land within a few seconds of each other, so this is a safe, conservative
// cleanup rather than a guess.
function dedupeMatchLog(log) {
  const sorted = [...log].sort((a, b) => a.ts - b.ts);
  const kept = [];
  sorted.forEach((r) => {
    const isDup = kept.some(
      (k) =>
        k.eventId === r.eventId &&
        k.partnerAccountId === r.partnerAccountId &&
        k.pointsFor === r.pointsFor &&
        k.pointsAgainst === r.pointsAgainst &&
        JSON.stringify([...(k.oppAccountIds || [])].sort()) ===
          JSON.stringify([...(r.oppAccountIds || [])].sort()) &&
        Math.abs((r.ts || 0) - (k.ts || 0)) < 30000
    );
    if (!isDup) kept.push(r);
  });
  return { cleaned: kept, removedCount: sorted.length - kept.length };
}

async function repairPlayerMatchLog(accountId) {
  if (!accountId) return 0;
  const log = await loadPlayerMatchLog(accountId);
  const { cleaned, removedCount } = dedupeMatchLog(log);
  if (removedCount > 0) {
    await window.storage.set(playerLogKey(accountId), JSON.stringify(cleaned), true);
  }
  return removedCount;
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

// "Sabtu, 25 Juli 2026" — used on lobby event cards so people can tell at a
// glance which day an event was for, without opening it.
function formatEventDate(ts) {
  if (!ts) return null;
  return new Date(ts).toLocaleDateString("id-ID", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

// Prefers the host's manually-entered play date (optional, "YYYY-MM-DD")
// over the automatic "when this event was created" timestamp.
function formatEventEntryDate(ev) {
  if (ev.playDate) {
    // Parse as local date (not UTC midnight) so it doesn't shift a day
    // depending on the viewer's timezone.
    const [y, m, d] = ev.playDate.split("-").map(Number);
    return formatEventDate(new Date(y, m - 1, d).getTime());
  }
  return formatEventDate(ev.createdAt);
}

// Same "prefer manual play date" logic, but as a sortable number — used to
// order lobby/public-event lists newest-first.
function sortDateValue(ev) {
  if (ev.playDate) {
    const [y, m, d] = ev.playDate.split("-").map(Number);
    return new Date(y, m - 1, d).getTime();
  }
  return ev.createdAt || ev.updatedAt || 0;
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

// Changes only the display name shown to others — NOT the login username
// (which doubles as the account's permanent ID referenced everywhere: friend
// lists, session ownership, co-host lists, etc). Renaming that ID safely
// would need rewriting every reference across every session/account, which
// isn't practical with this simple key-value store — hence a separate,
// freely-editable display name instead.
async function updateDisplayName(usernameLower, newDisplayName) {
  const existing = await getUserAccount(usernameLower);
  if (!existing) return null;
  const updated = { ...existing, displayName: newDisplayName.trim() || existing.username };
  await window.storage.set(userKey(usernameLower), JSON.stringify(updated), true);
  return updated;
}

// Free-text "location" (e.g. "Jakarta Selatan") and an editable caption shown
// on the Lobby scorecard — both purely cosmetic, no validation needed.
async function updateProfileExtras(usernameLower, { location, caption }) {
  const existing = await getUserAccount(usernameLower);
  if (!existing) return null;
  const updated = { ...existing };
  if (location !== undefined) updated.location = location;
  if (caption !== undefined) updated.caption = caption;
  await window.storage.set(userKey(usernameLower), JSON.stringify(updated), true);
  return updated;
}

// Account-level default payment details (platform + account number, up to 2)
// so that when this person gets picked as a session's Payment Person, the
// split bill can auto-fill instead of asking them to retype it every time.
async function updateUserPaymentInfo(usernameLower, paymentInfo) {
  const existing = await getUserAccount(usernameLower);
  if (!existing) return null;
  const updated = { ...existing, paymentInfo };
  await window.storage.set(userKey(usernameLower), JSON.stringify(updated), true);
  return updated;
}

// Resizes/crops any uploaded image client-side into a square JPEG data URL
// before it's ever stored, so profile pictures stay small no matter what
// photo someone picks. 480px keeps it sharp even when shown large (like the
// Lobby scorecard's photo panel), while still staying a reasonably small
// file once JPEG-compressed.
function processImageToAvatar(file, size = 480) {
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
      return f
        ? { accountId: id, username: f.displayName || f.username, avatarUrl: f.avatarUrl || null }
        : null;
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
          username: acc.displayName || acc.username,
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
const ALL_MATCHES_KEY = "padel-all-matches-registry";
const ALL_MATCHES_MAX = 1000; // cap so the registry doesn't grow unbounded forever


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

// A single shared, admin-only registry of every event ever created by any
// user, regardless of visibility (private/public) or status — unlike the
// public-discovery list above, which only ever shows "waiting" public
// events. Kept up to date on every save, removed only when the event
// itself is deleted (never just because it ended or someone left).
async function loadAllMatchesRegistry() {
  try {
    const res = await window.storage.get(ALL_MATCHES_KEY, true);
    return res ? JSON.parse(res.value) : [];
  } catch (e) {
    return [];
  }
}

async function saveAllMatchesRegistry(list) {
  try {
    await window.storage.set(ALL_MATCHES_KEY, JSON.stringify(list.slice(0, ALL_MATCHES_MAX)), true);
  } catch (e) {
    console.error("Gagal menyimpan registry all-matches:", e);
  }
}

async function syncAllMatchesRegistryEntry(snapshot) {
  try {
    const list = await loadAllMatchesRegistry();
    const existingIdx = list.findIndex((e) => e.id === snapshot.id);
    const entry = {
      id: snapshot.id,
      name: snapshot.name || "Sesi Padel",
      ownerId: snapshot.ownerId,
      ownerUsername: snapshot.ownerUsername || "",
      playerCount: (snapshot.players || []).length,
      courts: snapshot.courts,
      status: snapshot.status,
      ended: !!snapshot.ended,
      createdAt: existingIdx !== -1 ? list[existingIdx].createdAt : snapshot.updatedAt,
      updatedAt: snapshot.updatedAt,
      playDate: snapshot.playDate || null,
    };
    if (existingIdx !== -1) list[existingIdx] = entry;
    else list.unshift(entry);
    await saveAllMatchesRegistry(list);
  } catch (e) {
    console.error("Gagal sync registry all-matches:", e);
  }
}

async function removeFromAllMatchesRegistry(id) {
  const list = await loadAllMatchesRegistry();
  const next = list.filter((e) => e.id !== id);
  if (next.length !== list.length) await saveAllMatchesRegistry(next);
}

// Deleting an event normally removes it everywhere. For the admin registry
// specifically, mark it "deleted" instead of purging the entry — the
// underlying session data (schedule, scores, activity log) is deliberately
// left in storage untouched too, so the owner can still open/download it
// for auditing even after a host deletes their event.
async function markDeletedInAllMatchesRegistry(id) {
  const list = await loadAllMatchesRegistry();
  const idx = list.findIndex((e) => e.id === id);
  if (idx === -1) return;
  list[idx] = { ...list[idx], deleted: true, deletedAt: Date.now() };
  await saveAllMatchesRegistry(list);
}

const DELETED_MATCH_RETENTION_MS = 7 * 24 * 60 * 60 * 1000; // 7 hari

// Runs whenever alfinyr opens "All Match" — anything soft-deleted more
// than 7 days ago gets permanently erased (both the real session data and
// its registry entry), so storage doesn't grow forever just from routine
// deletions. Non-deleted entries are untouched regardless of age.
async function purgeOldDeletedMatches() {
  const list = await loadAllMatchesRegistry();
  const now = Date.now();
  const toPurge = list.filter(
    (e) => e.deleted && e.deletedAt && now - e.deletedAt > DELETED_MATCH_RETENTION_MS
  );
  if (toPurge.length === 0) return list;
  await Promise.all(toPurge.map((e) => deleteSessionData(e.id)));
  const remaining = list.filter((e) => !toPurge.some((p) => p.id === e.id));
  await saveAllMatchesRegistry(remaining);
  return remaining;
}

// "Remember me" used to live ONLY in localStorage — which mobile browsers
// (especially iOS Safari's Intelligent Tracking Prevention) can silently
// clear after roughly a week of the site not being opened as a top-level
// page. For an app people open every few days rather than daily, that
// looks exactly like an unexplained "auto logout" — the person's DATA is
// fine (that lives in window.storage, which is far more durable), but the
// "who's logged in" marker vanished from the browser. So this now mirrors
// the same info into window.storage as a backup: localStorage stays the
// fast synchronous path for the callers that need one, and the boot-time
// check additionally falls back to window.storage if localStorage comes
// up empty, before concluding the person really needs to log in again.
const REMEMBER_STORAGE_KEY = "remember-login";

function rememberLogin(account) {
  const payload = { accountId: account.accountId, username: account.username };
  try {
    localStorage.setItem(REMEMBER_KEY, JSON.stringify(payload));
  } catch (e) {
    /* no-op */
  }
  // Fire-and-forget — this is a resilience backup, not on the critical path.
  window.storage?.set(REMEMBER_STORAGE_KEY, JSON.stringify(payload), false)?.catch(() => {});
}

function loadRememberedLogin() {
  try {
    const raw = localStorage.getItem(REMEMBER_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    return null;
  }
}

// Only used at boot, where an async fallback is affordable — if localStorage
// lost the marker, check the durable backup before giving up.
async function loadRememberedLoginWithFallback() {
  const fromLocal = loadRememberedLogin();
  if (fromLocal) return fromLocal;
  try {
    const res = await window.storage?.get(REMEMBER_STORAGE_KEY, false);
    if (res?.value) {
      const parsed = JSON.parse(res.value);
      // Re-seed localStorage so subsequent (synchronous) checks this
      // session don't need to fall back again.
      try {
        localStorage.setItem(REMEMBER_KEY, res.value);
      } catch (e) {
        /* no-op */
      }
      return parsed;
    }
  } catch (e) {
    /* no-op */
  }
  return null;
}

function forgetLogin() {
  try {
    localStorage.removeItem(REMEMBER_KEY);
  } catch (e) {
    /* no-op */
  }
  window.storage?.delete(REMEMBER_STORAGE_KEY, false)?.catch(() => {});
}

function uid() {
  return Math.random().toString(36).slice(2, 10);
}

// Old saved events used a single gameFormat value ("americano" | "fixed_partner")
// to mean what's now two independent choices: gameFormat ("americano" |
// "mexicano") and teamFormat ("rotating" | "fixed"). This translates
// whatever's in a loaded snapshot into the new shape so old events keep
// displaying and behaving exactly as before, without a migration step the
// person has to notice or run.
function resolveGameAndTeamFormat(saved) {
  if (!saved) return { gameFormat: "americano", teamFormat: "rotating" };
  if (saved.gameFormat === "fixed_partner") {
    return { gameFormat: "americano", teamFormat: "fixed" };
  }
  return {
    gameFormat: saved.gameFormat || "americano",
    teamFormat: saved.teamFormat || "rotating",
  };
}

function fmtClock(mins) {
  const h = Math.floor(mins / 60);
  const m = Math.round(mins % 60);
  const pad = (x) => String(x).padStart(2, "0");
  return `${pad(h)}:${pad(m)}`;
}

// Builds the "Sport Hari Waktu" template suggestion (e.g. "Padel Sabtu
// Pagi") shown as a placeholder in the event name field — used as the
// actual name if the person leaves the field blank when creating the
// event. Needs a play date and a start time to say anything meaningful;
// returns "" if either is missing so the field just shows nothing rather
// than a half-finished guess.
function generateEventNameTemplate(playDate, startTime, sportType) {
  if (!playDate || !startTime) return "";
  const [y, m, d] = playDate.split("-").map(Number);
  if (!y || !m || !d) return "";
  const date = new Date(y, m - 1, d);
  const dayNames = ["Minggu", "Senin", "Selasa", "Rabu", "Kamis", "Jumat", "Sabtu"];
  const dayName = dayNames[date.getDay()];

  const hour = parseInt(startTime.split(":")[0], 10);
  let timePeriod = "";
  if (!isNaN(hour)) {
    if (hour < 11) timePeriod = "Pagi";
    else if (hour < 15) timePeriod = "Siang";
    else if (hour < 18) timePeriod = "Sore";
    else timePeriod = "Malam";
  }

  const sportLabel = sportType === "tenis" ? "Tenis" : "Padel";
  return [sportLabel, dayName, timePeriod].filter(Boolean).join(" ");
}

// Formats a minute count into a short "X Jam" / "X Jam Y Menit" / "Y Menit"
// label for the "Durasi Sesi" hint shown once both start and end time are
// filled in.
function formatDurationMinutes(mins) {
  if (!mins || mins <= 0) return "";
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h === 0) return `${m} Menit`;
  if (m === 0) return `${h} Jam`;
  return `${h} Jam ${m} Menit`;
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
    red: "bg-red-400/10 text-red-300 border-red-400/40",
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
        <div className="flex items-center gap-2 mb-4">
          <img src="/icon-192.png" alt="APlay" className="w-8 h-8 rounded-lg shrink-0" />
          <span className="font-display text-2xl text-slate-50 tracking-wide">APlay</span>
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

// Same completeness check used elsewhere (locked-rounds detection, etc.) —
// centralized here so the Partner Synergy logging trigger and everything
// else agree on what counts as "this specific match has a real result".
function isMatchScoreComplete(s) {
  if (!s) return false;
  if (s.format === "tennis") return (s.gamesA || 0) > 0 || (s.gamesB || 0) > 0;
  return s.a !== undefined && s.a !== "" && s.b !== undefined && s.b !== "";
}

// Builds the per-player log entries (Partner Synergy feature) for one
// finished match — one entry for each player who has an accountId, from
// their own point of view (who their partner was, who they beat/lost to,
// the score). Players without an accountId (guest names) are skipped since
// there's no stable identity to attach their history to across events.
// `playersById` maps player id -> {id, name, accountId} for the CURRENT
// roster (match.team1/team2 store just the ids).
function buildPartnerLogRecords(match, score, eventId, eventName, ts, playersById, matchKey) {
  const ab = matchAB(score);
  if (!ab || !Number.isFinite(ab.a) || !Number.isFinite(ab.b)) return [];
  const { a, b } = ab;
  const teamIds = [
    { ids: match.team1, points: a, oppPoints: b },
    { ids: match.team2, points: b, oppPoints: a },
  ];
  const records = [];
  teamIds.forEach(({ ids, points, oppPoints }, tIdx) => {
    const oppIds = teamIds[1 - tIdx].ids;
    const team = ids.map((id) => playersById[id]).filter(Boolean);
    const oppTeam = oppIds.map((id) => playersById[id]).filter(Boolean);
    team.forEach((player) => {
      if (!player.accountId) return;
      const partner = team.find((p) => p.id !== player.id) || null;
      records.push({
        accountId: player.accountId,
        record: {
          ts,
          eventId,
          eventName,
          matchKey: `${eventId}:${matchKey}`,
          partnerAccountId: partner?.accountId || null,
          partnerName: partner?.name || null,
          oppNames: oppTeam.map((p) => p.name),
          oppAccountIds: oppTeam.map((p) => p.accountId).filter(Boolean),
          won: points > oppPoints,
          tied: points === oppPoints,
          pointsFor: points,
          pointsAgainst: oppPoints,
        },
      });
    });
  });
  return records;
}

// Builds the standings array (points, wins/losses/ties, diff, matches played)
// from a schedule + score map. Shared between the editable app and the
// read-only viewer link.
// Finds the earliest round that still has at least one court without a
// completed score — used so opening a session from the Lobby jumps you to
// where scoring actually needs to continue, instead of wherever the shared
// "currentRound" pointer happened to be left (which just reflects whichever
// round someone else last had open).
function findFirstUnscoredRound(engine, scores) {
  for (let rIdx = 0; rIdx < engine.roundsData.length; rIdx++) {
    const rd = engine.roundsData[rIdx];
    const allScored = rd.courts.every((_, cIdx) => {
      const s = (scores || {})[`${rIdx}-${cIdx}`];
      if (!s) return false;
      if (s.format === "tennis") return (s.gamesA || 0) > 0 || (s.gamesB || 0) > 0;
      return s.a !== undefined && s.a !== "" && s.b !== undefined && s.b !== "";
    });
    if (!allScored) return rIdx;
  }
  return Math.max(0, engine.roundsData.length - 1);
}

// Given the original staged court plan (e.g. "7 rounds @ 1 court, then 8
// rounds @ 2 courts") and a range of round-indices that still need to be
// (re)generated, returns the portion of each stage that falls inside that
// range — so regenerating just the "remaining" rounds (say, after someone's
// attendance changes) still respects the original per-stage court counts
// instead of collapsing everything to one flat court count.
function sliceStagesFrom(courtStages, fromIdx, totalRounds) {
  if (!courtStages || courtStages.length === 0) return null;
  const segments = [];
  let cursor = 0;
  for (const stage of courtStages) {
    const segStart = cursor;
    const segEnd = cursor + (stage.rounds || 0);
    cursor = segEnd;
    const start = Math.max(segStart, fromIdx);
    const end = Math.min(segEnd, totalRounds);
    if (end > start) segments.push({ rounds: end - start, courts: stage.courts });
  }
  return segments.length > 0 ? segments : null;
}

// ---------------------------------------------------------------------------
// PARTNER SYNERGY INDEX — analysis functions
// ---------------------------------------------------------------------------
// Everything here works off ONE player's match log (array of records built
// by buildPartnerLogRecords/appendPlayerMatchRecords). Filtering that same
// log different ways gives every view the feature needs: stats for one
// specific partner, "with vs without" comparisons, and the top-partners list.

function computeStreaks(recordsChrono) {
  let longest = 0;
  let current = 0;
  let running = 0;
  recordsChrono.forEach((r) => {
    if (r.won) {
      running += 1;
      longest = Math.max(longest, running);
    } else {
      running = 0;
    }
  });
  // current streak = trailing run of wins at the very end of the (chronological) log
  for (let i = recordsChrono.length - 1; i >= 0; i--) {
    if (recordsChrono[i].won) current += 1;
    else break;
  }
  return { longest, current };
}

// Synergy Index: a 0-100 blend of several factors, not just win rate.
//   Win Rate               35%
//   Avg Point Difference   20%
//   Opponent Strength      15%  (simplified proxy — see note below)
//   Consistency            10%  (lower variance in point-diff = more consistent)
//   Matches Together       10%  (more shared history = more reliable number)
//   Recent Trend           10%  (win rate over the last 5 matches together)
//
// NOTE on "Opponent Strength": a true version would need an independent
// player-rating/ELO system to know how strong the opponents actually were.
// That doesn't exist here, so this uses a proxy instead — how large a share
// of total points the opponents typically scored against this pair (i.e.
// how competitive the matches were on average). It's a reasonable stand-in,
// not a rigorous rating.
function computeSynergyIndex(records) {
  const n = records.length;
  if (n === 0) return null;

  const wins = records.filter((r) => r.won).length;
  const winRate = (wins / n) * 100;

  const pointDiffs = records.map((r) => r.pointsFor - r.pointsAgainst);
  const avgPointDiff = pointDiffs.reduce((a, b) => a + b, 0) / n;
  const avgPointDiffScore = Math.max(0, Math.min(100, ((avgPointDiff + 15) / 30) * 100));

  const oppShare =
    records.reduce((sum, r) => sum + r.pointsAgainst / Math.max(1, r.pointsFor + r.pointsAgainst), 0) / n;
  const opponentStrengthScore = Math.max(0, Math.min(100, oppShare * 100));

  const meanDiff = avgPointDiff;
  const variance = pointDiffs.reduce((s, d) => s + (d - meanDiff) ** 2, 0) / n;
  const stdDev = Math.sqrt(variance);
  const consistencyScore = Math.max(0, Math.min(100, 100 - stdDev * 5));

  const matchesScore = Math.max(0, Math.min(100, (n / 20) * 100));

  const last5 = records.slice(-5);
  const recentTrendScore = (last5.filter((r) => r.won).length / last5.length) * 100;

  const raw =
    winRate * 0.35 +
    avgPointDiffScore * 0.2 +
    opponentStrengthScore * 0.15 +
    consistencyScore * 0.1 +
    matchesScore * 0.1 +
    recentTrendScore * 0.1;

  return Math.round(Math.max(0, Math.min(100, raw)));
}

function synergyRating(score) {
  if (score >= 90) return { stars: 5, label: "Elite Duo" };
  if (score >= 80) return { stars: 4, label: "Great Pair" };
  if (score >= 70) return { stars: 3, label: "Good Pair" };
  if (score >= 60) return { stars: 2, label: "Average" };
  return { stars: 1, label: "Needs Improvement" };
}

// Full stat card for one specific partner, built from `myLog` (my own match
// history) filtered down to matches where `partnerAccountId` was my partner.
function computePartnerStats(myLog, partnerAccountId) {
  const records = myLog
    .filter((r) => r.partnerAccountId === partnerAccountId)
    .sort((a, b) => a.ts - b.ts);
  if (records.length === 0) return null;

  const wins = records.filter((r) => r.won).length;
  const losses = records.filter((r) => !r.won && !r.tied).length;
  const ties = records.filter((r) => r.tied).length;
  const totalPointsFor = records.reduce((s, r) => s + r.pointsFor, 0);
  const totalPointsAgainst = records.reduce((s, r) => s + r.pointsAgainst, 0);
  const { longest, current } = computeStreaks(records);
  const eventIds = new Set(records.map((r) => r.eventId));
  const synergy = computeSynergyIndex(records);

  // Trend: synergy index recomputed at up to 5 evenly-spaced checkpoints
  // through the shared history, so you can see it climb (or slide) over time.
  const checkpointCount = Math.min(5, records.length);
  const trend = [];
  for (let i = 1; i <= checkpointCount; i++) {
    const uptoIdx = Math.round((records.length * i) / checkpointCount);
    trend.push(computeSynergyIndex(records.slice(0, uptoIdx)));
  }
  const trendDirection =
    trend.length >= 2 ? (trend[trend.length - 1] >= trend[0] ? "up" : "down") : null;

  return {
    partnerAccountId,
    partnerName: records[records.length - 1].partnerName,
    matches: records.length,
    wins,
    losses,
    ties,
    winRate: (wins / records.length) * 100,
    totalPointsFor,
    totalPointsAgainst,
    avgPointsPerMatch: totalPointsFor / records.length,
    avgPointDiff: (totalPointsFor - totalPointsAgainst) / records.length,
    longestStreak: longest,
    currentStreak: current,
    lastPlayedAt: records[records.length - 1].ts,
    eventsCount: eventIds.size,
    synergy,
    rating: synergy !== null ? synergyRating(synergy) : null,
    trend,
    trendDirection,
  };
}

// Top-N partner list for the Lobby / profile view — every distinct partner
// in the log, ranked by Synergy Index.
function computeTopPartners(myLog, limit = 5) {
  const partnerIds = [...new Set(myLog.map((r) => r.partnerAccountId).filter(Boolean))];
  return partnerIds
    .map((id) => computePartnerStats(myLog, id))
    .filter(Boolean)
    .sort((a, b) => b.synergy - a.synergy)
    .slice(0, limit);
}

// "With X" vs "Without X" comparison — win rate for both players, with and
// without each other, computed straight from each side's own full log.
function computeWithWithoutComparison(myLog, partnerAccountId) {
  const withPartner = myLog.filter((r) => r.partnerAccountId === partnerAccountId);
  const withoutPartner = myLog.filter((r) => r.partnerAccountId !== partnerAccountId);
  const rate = (arr) => (arr.length > 0 ? (arr.filter((r) => r.won).length / arr.length) * 100 : null);
  return {
    withRate: rate(withPartner),
    withoutRate: rate(withoutPartner),
    withMatches: withPartner.length,
    withoutMatches: withoutPartner.length,
  };
}

// Overall career stats for the Lobby scorecard — every match this player has
// ever finished (any partner, any event), regardless of who they played
// with. Same underlying log as Partner Synergy, just not filtered by partner.
function computeOverallProfileStats(myLog) {
  const matches = myLog.length;
  if (matches === 0) return null;
  const sorted = [...myLog].sort((a, b) => a.ts - b.ts);
  const wins = sorted.filter((r) => r.won).length;
  const losses = sorted.filter((r) => !r.won && !r.tied).length;
  const totalPointsWon = sorted.reduce((s, r) => s + r.pointsFor, 0);
  const totalPointsLost = sorted.reduce((s, r) => s + r.pointsAgainst, 0);
  const { longest: bestStreak } = computeStreaks(sorted);
  const eventsCount = new Set(sorted.map((r) => r.eventId)).size;
  return {
    matches,
    wins,
    losses,
    winRate: (wins / matches) * 100,
    totalPointsWon,
    avgPointsPerMatch: totalPointsWon / matches,
    bestStreak,
    eventsCount,
    pointRatio: totalPointsLost > 0 ? totalPointsWon / totalPointsLost : totalPointsWon > 0 ? Infinity : 0,
    lastUpdated: sorted[sorted.length - 1].ts,
  };
}

// Standard competition ranking ("1224" style): equal players share a rank,
// and the rank after a tie skips by however many were tied. Two players are
// treated as tied only when EVERY ranking stat matches, so this never
// collapses players who differ on some tiebreaker the table isn't sorted by.
function computeTiedRanks(sortedArr) {
  const sameStanding = (a, b) =>
    a.wins === b.wins &&
    a.losses === b.losses &&
    a.ties === b.ties &&
    a.diff === b.diff &&
    Math.abs(a.winPercent - b.winPercent) < 0.0001 &&
    Math.abs(a.ppm - b.ppm) < 0.0001;

  const ranks = [];
  sortedArr.forEach((p, i) => {
    if (i > 0 && sameStanding(p, sortedArr[i - 1])) {
      ranks.push(ranks[i - 1]); // tied with the player above → same rank
    } else {
      ranks.push(i + 1); // otherwise rank is just their position (1-based)
    }
  });
  return ranks;
}

function buildLeaderboard(engine, playerMap, scores, activeIds) {
  if (!engine) return [];
  const totals = {};
  const activeSet = activeIds ? new Set(activeIds) : null;
  // Historical (locked) rounds can still reference a player who was later
  // removed from the roster via "Kelola Pemain". playerMap keeps their name
  // around (see handleAdjustSchedule), so we can still label them clearly
  // instead of losing their identity or crashing on a missing lookup.
  const ensure = (id) => {
    if (!totals[id]) {
      const isRemoved = activeSet && !activeSet.has(id);
      const rawName = playerMap[id] || id;
      totals[id] = {
        id,
        name: isRemoved ? `Pemain Dihapus (${rawName})` : rawName,
        points: 0,
        wins: 0,
        losses: 0,
        ties: 0,
        diff: 0,
        matches: 0,
        rests: engine.restCount[id] || 0,
      };
    }
    return totals[id];
  };
  Object.keys(playerMap).forEach((id) => {
    if (!activeSet || activeSet.has(id)) ensure(id);
  });
  engine.roundsData.forEach((rd, rIdx) => {
    rd.courts.forEach((match, cIdx) => {
      const s = scores[`${rIdx}-${cIdx}`];
      const ab = matchAB(s);
      if (!ab) return;
      const { a, b } = ab;
      if (!Number.isFinite(a) || !Number.isFinite(b)) return;
      match.team1.forEach((id) => {
        const t = ensure(id);
        t.points += a;
        t.diff += a - b;
        t.matches += 1;
      });
      match.team2.forEach((id) => {
        const t = ensure(id);
        t.points += b;
        t.diff += b - a;
        t.matches += 1;
      });
      if (a > b) {
        match.team1.forEach((id) => (ensure(id).wins += 1));
        match.team2.forEach((id) => (ensure(id).losses += 1));
      } else if (b > a) {
        match.team2.forEach((id) => (ensure(id).wins += 1));
        match.team1.forEach((id) => (ensure(id).losses += 1));
      } else {
        match.team1.forEach((id) => (ensure(id).ties += 1));
        match.team2.forEach((id) => (ensure(id).ties += 1));
      }
    });
  });
  return Object.values(totals)
    .filter((t) => !activeSet || activeSet.has(t.id))
    .map((t) => ({
      ...t,
      winPercent: t.matches > 0 ? (t.wins / t.matches) * 100 : 0,
      ppm: t.matches > 0 ? t.points / t.matches : 0,
    }));
}

// Fixed Partner counterpart to buildLeaderboard: aggregates by TEAM (fixed
// pair) instead of by individual player, since in this mode both partners
// always have identical stats anyway (they're never separated) — showing
// them as one combined row is both more accurate to how the format works
// and less repetitive than two identical-looking individual rows.
function buildTeamLeaderboard(engine, playerMap, scores, fixedPairs) {
  if (!engine || !fixedPairs || fixedPairs.length === 0) return [];
  const totals = {};
  const teamOfPlayer = {};
  fixedPairs.forEach(([a, b], i) => {
    const teamId = `team_${i}_${a}_${b}`;
    totals[teamId] = {
      id: teamId,
      name: `${playerMap[a] || a} & ${playerMap[b] || b}`,
      playerIds: [a, b],
      points: 0,
      wins: 0,
      losses: 0,
      ties: 0,
      diff: 0,
      matches: 0,
      rests: (engine.restCount && engine.restCount[teamId]) || 0,
    };
    teamOfPlayer[a] = teamId;
    teamOfPlayer[b] = teamId;
  });

  engine.roundsData.forEach((rd, rIdx) => {
    rd.courts.forEach((match, cIdx) => {
      const s = scores[`${rIdx}-${cIdx}`];
      const ab = matchAB(s);
      if (!ab) return;
      const { a, b } = ab;
      if (!Number.isFinite(a) || !Number.isFinite(b)) return;
      const team1Id = teamOfPlayer[match.team1[0]];
      const team2Id = teamOfPlayer[match.team2[0]];
      if (!team1Id || !team2Id || !totals[team1Id] || !totals[team2Id]) return;
      totals[team1Id].points += a;
      totals[team1Id].diff += a - b;
      totals[team1Id].matches += 1;
      totals[team2Id].points += b;
      totals[team2Id].diff += b - a;
      totals[team2Id].matches += 1;
      if (a > b) {
        totals[team1Id].wins += 1;
        totals[team2Id].losses += 1;
      } else if (b > a) {
        totals[team2Id].wins += 1;
        totals[team1Id].losses += 1;
      } else {
        totals[team1Id].ties += 1;
        totals[team2Id].ties += 1;
      }
    });
  });

  return Object.values(totals).map((t) => ({
    ...t,
    winPercent: t.matches > 0 ? (t.wins / t.matches) * 100 : 0,
    ppm: t.matches > 0 ? t.points / t.matches : 0,
  }));
}

// Given a Fixed Partner event's fixedPairs and a playerMap, returns a
// lookup from individual player id -> display team name ("Alfin & Budi").
// Used to relabel match participants as their team wherever individual
// names would otherwise be shown (Rekap, Statistik).
function buildTeamNameByPlayer(fixedPairs, playerMap) {
  const map = {};
  (fixedPairs || []).forEach(([a, b]) => {
    const teamName = `${playerMap[a] || a} & ${playerMap[b] || b}`;
    map[a] = teamName;
    map[b] = teamName;
  });
  return map;
}

// Fixed Partner counterpart to the individual fairness-stats computation
// (matches/rests/wins/losses/unique-opponents) built inline in the main
// component — same idea, aggregated by team. "Unique partners" doesn't
// apply here (a team's partner is always the same person by definition),
// so this tracks unique OPPONENT TEAMS faced instead.
function buildTeamFairnessStats(engine, playerMap, scores, fixedPairs, currentRound) {
  if (!engine || !fixedPairs || fixedPairs.length === 0) return [];
  const teams = fixedPairs.map(([a, b], i) => ({
    id: `team_${i}_${a}_${b}`,
    name: `${playerMap[a] || a} & ${playerMap[b] || b}`,
    players: [a, b],
  }));
  const teamOfPlayer = {};
  teams.forEach((t) => t.players.forEach((pid) => (teamOfPlayer[pid] = t.id)));

  const playedSoFar = {};
  const wins = {};
  const losses = {};
  const oppsOf = {}; // teamId -> { otherTeamId: { total, played } }
  teams.forEach((t) => (oppsOf[t.id] = {}));

  engine.roundsData.forEach((rd, rIdx) => {
    const isScored = rd.courts.every((_, cIdx) => isMatchScoreComplete(scores[`${rIdx}-${cIdx}`]));
    if (isScored) {
      const playingTeamIds = new Set(
        rd.courts.flatMap((c) => [teamOfPlayer[c.team1[0]], teamOfPlayer[c.team2[0]]]).filter(Boolean)
      );
      playingTeamIds.forEach((id) => (playedSoFar[id] = (playedSoFar[id] || 0) + 1));
    }
    rd.courts.forEach((match, cIdx) => {
      const team1Id = teamOfPlayer[match.team1[0]];
      const team2Id = teamOfPlayer[match.team2[0]];
      if (!team1Id || !team2Id) return;
      const matchScored = isMatchScoreComplete(scores[`${rIdx}-${cIdx}`]);
      if (!oppsOf[team1Id][team2Id]) oppsOf[team1Id][team2Id] = { total: 0, played: 0 };
      if (!oppsOf[team2Id][team1Id]) oppsOf[team2Id][team1Id] = { total: 0, played: 0 };
      oppsOf[team1Id][team2Id].total += 1;
      oppsOf[team2Id][team1Id].total += 1;
      if (matchScored) {
        oppsOf[team1Id][team2Id].played += 1;
        oppsOf[team2Id][team1Id].played += 1;
      }
      const s = scores[`${rIdx}-${cIdx}`];
      const ab = matchAB(s);
      if (!ab || !Number.isFinite(ab.a) || !Number.isFinite(ab.b) || ab.a === ab.b) return;
      const winnerId = ab.a > ab.b ? team1Id : team2Id;
      const loserId = ab.a > ab.b ? team2Id : team1Id;
      wins[winnerId] = (wins[winnerId] || 0) + 1;
      losses[loserId] = (losses[loserId] || 0) + 1;
    });
  });

  const teamNameById = {};
  teams.forEach((t) => (teamNameById[t.id] = t.name));

  return teams
    .map((t) => {
      const oppEntries = Object.entries(oppsOf[t.id] || {});
      return {
        id: t.id,
        name: t.name,
        matches: (engine.playCount && engine.playCount[t.id]) || 0,
        playedSoFar: playedSoFar[t.id] || 0,
        rests: (engine.restCount && engine.restCount[t.id]) || 0,
        wins: wins[t.id] || 0,
        losses: losses[t.id] || 0,
        opps: oppEntries.length,
        oppDetail: oppEntries
          .map(([oid, c]) => ({ name: teamNameById[oid] || oid, played: c.played, total: c.total }))
          .sort((a, b) => b.total - a.total || a.name.localeCompare(b.name)),
        role: null,
      };
    })
    .sort((a, b) => b.matches - a.matches);
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

  // Every screen switch should start scrolled to the top — otherwise, e.g.,
  // tapping "Buat Acara Baru" while scrolled down in the Lobby would open
  // Setup at that same leftover scroll position instead of from the top.
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [screen]);

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
  const [paymentPersonId, setPaymentPersonId] = useState(null); // player.id of who collects the split bill
  const [paymentInfo, setPaymentInfo] = useState([]); // [{platform, number}] max 2
  const [paidStatus, setPaidStatus] = useState({}); // { [playerId]: true } — missing/false = belum bayar
  const [loggedMatchKeys, setLoggedMatchKeys] = useState([]); // "rIdx-cIdx" keys already recorded into Partner Synergy logs, so re-syncs/multiple viewers don't double-count
  const [selectedPartner, setSelectedPartner] = useState(null); // { accountId, name } — which partner's detail screen is open
  const [selectedFriend, setSelectedFriend] = useState(null); // which friend's profile screen is open
  const [courtStages, setCourtStages] = useState([]); // [{id, rounds, courts}] — empty = simple single-court-count mode
  const [playDate, setPlayDate] = useState(""); // optional "YYYY-MM-DD" — if set, shown in Lobby instead of the auto createdAt date
  const [excludeFromStats, setExcludeFromStats] = useState(false); // trial/practice events can be kept out of everyone's stats
  const [activityLog, setActivityLog] = useState([]); // [{ts, message}] — key actions taken in this session, for export/debugging
  const [hostPlaying, setHostPlaying] = useState(false);
  const [coHostIds, setCoHostIds] = useState([]); // accountIds granted co-host (edit) access
  const [ownerId, setOwnerId] = useState(null);
  const [ownerUsername, setOwnerUsername] = useState("");
  const [publicEvents, setPublicEvents] = useState([]);
  const [pendingJoinId] = useState(() => new URLSearchParams(window.location.search).get("join"));
  const [joinConfirmPreview, setJoinConfirmPreview] = useState(null); // {id, data, me} | null — set once event data is fetched, awaiting the person's confirm/cancel
  const [hostInvitations, setHostInvitations] = useState([]); // [{id, accountId, username}] sent by host, awaiting the friend's accept

  // Setup state
  const [players, setPlayers] = useState([]); // [{id, name, accountId?}]
  // Mirrors `players` synchronously via the ref below. Handlers that read
  // `players` directly from closure can be racy if triggered again before
  // React has finished flushing the PREVIOUS update into a new render
  // (observed via an activity log: rapid attendance toggles on different
  // people, where a later toggle's `newPlayers = players.map(...)` was
  // built from a `players` snapshot that hadn't picked up the immediately
  // prior toggle yet, silently reverting it). Reading playersRef.current
  // instead guarantees the freshest value regardless of render timing.
  const playersRef = useRef([]);
  useEffect(() => {
    playersRef.current = players;
  }, [players]);
  const [nameInput, setNameInput] = useState("");
  const [bulkInput, setBulkInput] = useState("");
  const [courts, setCourts] = useState(2);
  const [mode, setMode] = useState("duration"); // duration | rounds
  const [totalMinutes, setTotalMinutes] = useState(120);
  const [minutesPerRound, setMinutesPerRound] = useState(7);
  const [breakMinutes, setBreakMinutes] = useState(0);
  const [manualRounds, setManualRounds] = useState(8);
  const [startTime, setStartTime] = useState("19:00");
  const [endTime, setEndTime] = useState("21:00"); // used to auto-compute totalMinutes and suggest an event name template

  // "Total durasi sewa" used to be a separate manual field — now derived
  // straight from the Jam Bermain range above, so the person only enters
  // the start/end time once instead of that and a duration that has to
  // stay consistent with it by hand.
  useEffect(() => {
    if (mode !== "duration") return;
    const [sh, sm] = startTime.split(":").map(Number);
    const [eh, em] = endTime.split(":").map(Number);
    if ([sh, sm, eh, em].some((n) => Number.isNaN(n))) return;
    let diff = eh * 60 + em - (sh * 60 + sm);
    if (diff <= 0) diff += 24 * 60; // end time past midnight relative to start
    setTotalMinutes(diff);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startTime, endTime, mode]);
  const [scoreFormat, setScoreFormat] = useState("points"); // points | tennis
  const [sportType, setSportType] = useState("padel"); // padel | tenis — purely informational, doesn't change scoring logic
  const [gameFormat, setGameFormat] = useState("americano"); // americano | mexicano
  const [teamFormat, setTeamFormat] = useState("rotating"); // rotating | fixed
  const [fixedPairs, setFixedPairs] = useState([]); // [[playerIdA, playerIdB], ...] — only used when teamFormat === "fixed"
  const [pointTarget, setPointTarget] = useState(21);
  const [tennisTarget, setTennisTarget] = useState(4); // race to N games
  const [ended, setEnded] = useState(false);

  // Session state (post-generate)
  const [engine, setEngine] = useState(null);
  const [playerMap, setPlayerMap] = useState({});
  const [currentRound, setCurrentRound] = useState(0);
  const [scores, setScores] = useState({});


  // Dipakai KHUSUS oleh effect auto-lanjut Mexicano di bawah -- dihitung
  // di sini (bukan pakai `canManage` yg dideklarasikan jauh lebih telat)
  // supaya hook effect ini AMAN ditaruh sebelum kondisi early-return
  // manapun di komponen ini (hooks harus selalu jalan di urutan yg sama
  // tiap render -- taruh setelah early-return bikin error React #310
  // begitu ada render yg lewatin early-return itu).
  const canManageForMexicanoEffect = sessionRole === "owner" || coHostIds.includes(currentUser?.accountId);
  // MEXICANO auto-continuation: unlike Americano/Fixed Partner (which plan
  // every round upfront), Mexicano can only decide round N+1 once round N's
  // ACTUAL results are in — there's no "next round" sitting in roundsData
  // waiting to be revealed, it doesn't exist yet. So this watches scores
  // and, the moment every match in the latest round is complete, computes
  // the new ranking from real results and generates the next round batch
  // automatically. isGeneratingNextMexicanoRound guards against firing
  // twice for the same completion (effects can re-run before state settles).
  const isGeneratingNextMexicanoRound = useRef(false);
  useEffect(() => {
    if (!engine?.mexicano || ended || !canManageForMexicanoEffect) return;
    const latestRoundIdx = engine.roundsData.length - 1;
    const latestRound = engine.roundsData[latestRoundIdx];
    if (!latestRound) return;
    const allScored = latestRound.courts.every((_, cIdx) =>
      isMatchScoreComplete(scores[`${latestRoundIdx}-${cIdx}`])
    );
    if (!allScored || isGeneratingNextMexicanoRound.current) return;

    isGeneratingNextMexicanoRound.current = true;
    const scoreEntries = latestRound.courts.map((_, cIdx) => scores[`${latestRoundIdx}-${cIdx}`]);

    if (engine.mexicanoUnit === "team") {
      const unitIds = engine.fixedTeams.map((t) => t.id);
      const locked = lockNewMexicanoRanking(unitIds, latestRound.courts, scoreEntries, {
        wins: engine.mexicanoWins,
        losses: engine.mexicanoLosses,
        ties: engine.mexicanoTies,
        matchesPlayed: engine.mexicanoMatchesPlayed,
        diff: engine.mexicanoDiff,
        cumulativePoints: engine.cumulativePoints,
      });
      const gen = generateMexicanoFixedTeamRoundBatch(engine.fixedTeams, courts, {
        ...engine,
        rankingSnapshot: locked.rankingSnapshot,
        roundNum: (engine.mexicanoRoundNum ?? 0) + 1,
      });
      const playingIds = new Set(gen.matches.flatMap((m) => [...m.team1, ...m.team2]));
      const resting = players.map((p) => p.id).filter((id) => !playingIds.has(id));
      const newEngine = {
        ...engine,
        roundsData: [...engine.roundsData, { resting, courts: gen.matches }],
        lastPlayed: gen.lastPlayed,
        playCount: gen.playCount,
        restCount: gen.restCount,
        opp: gen.opp,
        usableCourts: gen.usableCourts,
        rankingSnapshot: locked.rankingSnapshot,
        rankingSnapshotByRound: [...(engine.rankingSnapshotByRound || []), locked.rankingSnapshot],
        cumulativePoints: locked.cumulativePoints,
        mexicanoWins: locked.wins,
        mexicanoLosses: locked.losses,
        mexicanoTies: locked.ties,
        mexicanoMatchesPlayed: locked.matchesPlayed,
        mexicanoDiff: locked.diff,
        mexicanoRoundNum: (engine.mexicanoRoundNum ?? 0) + 1,
      };
      setEngine(newEngine);
      setCurrentRound(latestRoundIdx + 1);
      persist({ engine: newEngine, currentRound: latestRoundIdx + 1 });
      logActivity(`Ronde ${latestRoundIdx + 2} digenerate otomatis (Mexicano, klasemen diperbarui)`);
    } else {
      const ids = players.map((p) => p.id);
      const locked = lockNewMexicanoRanking(ids, latestRound.courts, scoreEntries, {
        wins: engine.mexicanoWins,
        losses: engine.mexicanoLosses,
        ties: engine.mexicanoTies,
        matchesPlayed: engine.mexicanoMatchesPlayed,
        diff: engine.mexicanoDiff,
        cumulativePoints: engine.cumulativePoints,
      });
      const gen = generateMexicanoRoundBatch(ids, courts, {
        ...engine,
        rankingSnapshot: locked.rankingSnapshot,
        roundNum: (engine.mexicanoRoundNum ?? 0) + 1,
      });
      const playingIds = new Set(gen.matches.flatMap((m) => [...m.team1, ...m.team2]));
      const resting = ids.filter((id) => !playingIds.has(id));
      const newEngine = {
        ...engine,
        roundsData: [...engine.roundsData, { resting, courts: gen.matches }],
        lastPlayed: gen.lastPlayed,
        playCount: gen.playCount,
        restCount: gen.restCount,
        partner: gen.partner,
        opp: gen.opp,
        usableCourts: gen.usableCourts,
        rankingSnapshot: locked.rankingSnapshot,
        rankingSnapshotByRound: [...(engine.rankingSnapshotByRound || []), locked.rankingSnapshot],
        cumulativePoints: locked.cumulativePoints,
        mexicanoWins: locked.wins,
        mexicanoLosses: locked.losses,
        mexicanoTies: locked.ties,
        mexicanoMatchesPlayed: locked.matchesPlayed,
        mexicanoDiff: locked.diff,
        mexicanoRoundNum: (engine.mexicanoRoundNum ?? 0) + 1,
      };
      setEngine(newEngine);
      setCurrentRound(latestRoundIdx + 1);
      persist({ engine: newEngine, currentRound: latestRoundIdx + 1 });
      logActivity(`Ronde ${latestRoundIdx + 2} digenerate otomatis (Mexicano, klasemen diperbarui)`);
    }
    // Allow the next completion to trigger again once this update has
    // flowed through — a short delay rather than clearing immediately
    // avoids a race against React's own state-update batching.
    setTimeout(() => {
      isGeneratingNextMexicanoRound.current = false;
    }, 500);
  }, [scores, engine, ended, canManageForMexicanoEffect, courts, players]);

  // MEXICANO retroactive correction: fixing a typo in an EARLIER round's
  // score (navigating back via Sebelumnya/Berikutnya and re-entering it)
  // doesn't just sit there — every ranking computed from that point onward
  // was based on the WRONG cumulative results, which is what later rounds'
  // groupings came from. This detects exactly that situation — editing a
  // round that ISN'T the latest one — replays the full ranking chain with
  // the correction applied, and if the current (latest) round hasn't been
  // played at all yet, regenerates its composition using the corrected
  // ranking. A round that's already partially or fully played is left
  // untouched — people already on court with a specific matchup shouldn't
  // have that retroactively rewritten, only the stats feeding into
  // whatever comes AFTER it.
  const isReplayingMexicanoHistory = useRef(false);
  useEffect(() => {
    if (!engine?.mexicano || engine.mexicanoUnit === "team" || ended || !canManageForMexicanoEffect) return;
    const latestRoundIdx = engine.roundsData.length - 1;
    if (currentRound >= latestRoundIdx || currentRound < 0) return; // only care about an EARLIER round
    if (isReplayingMexicanoHistory.current || isGeneratingNextMexicanoRound.current) return;

    const ids = players.map((p) => p.id);
    const replayed = replayMexicanoRankingHistory(ids, engine.roundsData, scores);

    // Nothing to do if the correction didn't actually change the final
    // ranking that matters (e.g. the edit was to a score's SIDE that
    // doesn't change who won, or this effect already caught up).
    const sameRanking =
      JSON.stringify(replayed.rankingSnapshot) === JSON.stringify(engine.rankingSnapshot) &&
      JSON.stringify(replayed.cumulativePoints) === JSON.stringify(engine.cumulativePoints);
    if (sameRanking) return;

    isReplayingMexicanoHistory.current = true;

    const latestRound = engine.roundsData[latestRoundIdx];
    const latestScores = latestRound.courts.map((_, cIdx) => scores[`${latestRoundIdx}-${cIdx}`]);
    const latestUntouched = latestScores.every((s) => !isMatchScoreComplete(s) && (!s || (!s.a && !s.b && !s.gamesA && !s.gamesB)));

    let newEngine = {
      ...engine,
      rankingSnapshot: replayed.rankingSnapshot,
      rankingSnapshotByRound: replayed.rankingSnapshotByRound,
      cumulativePoints: replayed.cumulativePoints,
      mexicanoWins: replayed.wins,
      mexicanoLosses: replayed.losses,
      mexicanoTies: replayed.ties,
      mexicanoMatchesPlayed: replayed.matchesPlayed,
      mexicanoDiff: replayed.diff,
    };

    if (latestUntouched) {
      // The current round hasn't been played at all yet — safe to fully
      // regenerate its composition using the corrected ranking, same as if
      // it were being generated fresh right now.
      const gen = generateMexicanoRoundBatch(ids, courts, {
        ...newEngine,
        rankingSnapshot: replayed.rankingSnapshot,
        roundNum: latestRoundIdx,
      });
      const playingIds = new Set(gen.matches.flatMap((m) => [...m.team1, ...m.team2]));
      const resting = ids.filter((id) => !playingIds.has(id));
      const newRoundsData = [...engine.roundsData];
      newRoundsData[latestRoundIdx] = { resting, courts: gen.matches };
      newEngine = {
        ...newEngine,
        roundsData: newRoundsData,
        lastPlayed: gen.lastPlayed,
        playCount: gen.playCount,
        restCount: gen.restCount,
        partner: gen.partner,
        opp: gen.opp,
        usableCourts: gen.usableCourts,
      };
    }

    setEngine(newEngine);
    persist({ engine: newEngine });
    logActivity(
      `Koreksi skor Ronde ${currentRound + 1} (Mexicano) — klasemen dihitung ulang${
        latestUntouched ? `, Ronde ${latestRoundIdx + 1} disusun ulang pakai klasemen terkoreksi` : ""
      }`
    );

    setTimeout(() => {
      isReplayingMexicanoHistory.current = false;
    }, 500);
  }, [scores, engine, ended, canManageForMexicanoEffect, courts, players, currentRound]);

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
          playDate: data.playDate || entry.playDate || null,
          sportType: data.sportType || entry.sportType || "padel",
          gameFormat: resolveGameAndTeamFormat(data.gameFormat ? data : entry).gameFormat,
          teamFormat: resolveGameAndTeamFormat(data.gameFormat ? data : entry).teamFormat,
          scoreFormat: data.scoreFormat || entry.scoreFormat || "points",
          tennisTarget: data.tennisTarget || entry.tennisTarget || 4,
        };
      })
    );
    const sorted = refreshed.sort((a, b) => sortDateValue(b) - sortDateValue(a));
    setLobby(sorted);
    saveLobbyIndex(accountId, sorted);
    return sorted;
  };

  // On mount, auto-login if this device already has a remembered account.
  // If the URL carries an invite (?join=<id>), process it right after login.
  useEffect(() => {
    (async () => {
      const remembered = await loadRememberedLoginWithFallback();
      if (remembered) {
        const fresh = await getUserAccount(remembered.accountId);
        const me = fresh
          ? {
              accountId: fresh.accountId,
              username: fresh.username,
              displayName: fresh.displayName || fresh.username,
              avatarUrl: fresh.avatarUrl || null,
              paymentInfo: fresh.paymentInfo || [],
              location: fresh.location || "",
              caption: fresh.caption || "",
              createdAt: fresh.createdAt || null,
            }
          : remembered;
        setCurrentUser(me);
        if (pendingJoinId) {
          await prepareJoinConfirmation(pendingJoinId, me);
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
    const me = {
      accountId: account.accountId,
      username: account.username,
      displayName: account.displayName || account.username,
      avatarUrl: account.avatarUrl || null,
      paymentInfo: account.paymentInfo || [],
      location: account.location || "",
      caption: account.caption || "",
      createdAt: account.createdAt || null,
    };
    setCurrentUser(me);
    if (pendingJoinId) {
      await prepareJoinConfirmation(pendingJoinId, me);
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

  const handleChangeDisplayName = async (newName) => {
    if (!currentUser) return;
    const updated = await updateDisplayName(currentUser.accountId, newName || "");
    if (!updated) return;
    const finalName = updated.displayName || updated.username;
    setCurrentUser((u) => (u ? { ...u, displayName: finalName } : u));

    // If I'm currently inside a session (waiting room or live match) and I'm
    // one of the players there, update my name there right away so it
    // reflects immediately instead of staying stuck with the old snapshot.
    if (activeId && players.some((p) => p.accountId === currentUser.accountId)) {
      const newPlayers = players.map((p) =>
        p.accountId === currentUser.accountId ? { ...p, name: finalName } : p
      );
      setPlayers(newPlayers);
      let newPlayerMap = playerMap;
      if (engine) {
        newPlayerMap = { ...playerMap };
        newPlayers.forEach((p) => {
          if (newPlayerMap[p.id] !== undefined) newPlayerMap[p.id] = p.name;
        });
        setPlayerMap(newPlayerMap);
      }
      persist({ players: newPlayers, playerMap: newPlayerMap });
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

    const saveAndVerify = async (partial, checkFn) => {
      const delays = [300, 700, 1200];
      for (let attempt = 0; attempt < delays.length; attempt++) {
        const ok = await saveSessionData(sessionId, partial);
        if (ok) {
          await new Promise((r) => setTimeout(r, delays[attempt]));
          const readBack = await loadSessionData(sessionId);
          if (readBack && checkFn(readBack)) return true;
        } else {
          await new Promise((r) => setTimeout(r, delays[attempt]));
        }
      }
      return false;
    };

    if (accept) {
      // Deliberately matches by accountId ONLY, not by name. Auto-merging
      // into a same-named guest entry felt convenient for the one case that
      // prompted it, but it's not safe as a general rule: two different
      // real people can easily share a name, and silently attaching
      // someone's real account to a guest entry that was actually a
      // DIFFERENT person would incorrectly credit them with matches they
      // never played. If this exact situation comes up, the host can
      // manually delete the redundant guest entry via Kelola Pertandingan
      // instead — a deliberate action instead of an automatic guess.
      const already = (data.players || []).some((p) => p.accountId === currentUser.accountId);
      const newPlayers = already
        ? data.players || []
        : [
            ...(data.players || []),
            { id: uid(), name: currentUser.username, accountId: currentUser.accountId },
          ];
      // Mirrors the cleanup in handleJoinViaLink: if this person ALSO opened
      // the share link around the same time (racing this accept), there
      // could be a leftover pendingRequest for them too — clear that here
      // as well, so neither path can leave a stale entry for the other to
      // stumble over later and re-add them.
      const newPending = (data.pendingRequests || []).filter(
        (p) => p.accountId !== currentUser.accountId
      );
      await saveAndVerify(
        { ...data, players: newPlayers, pendingRequests: newPending, hostInvitations: newInvitations, updatedAt: Date.now() },
        (readBack) =>
          (readBack.players || []).some((p) => p.accountId === currentUser.accountId) &&
          !(readBack.hostInvitations || []).some((i) => i.accountId === currentUser.accountId)
      );
    } else {
      await saveAndVerify(
        { ...data, hostInvitations: newInvitations, updatedAt: Date.now() },
        (readBack) => !(readBack.hostInvitations || []).some((i) => i.accountId === currentUser.accountId)
      );
    }

    const myList = await loadLobbyIndex(currentUser.accountId);
    if (accept) {
      const nextList = myList.map((e) =>
        e.id === sessionId ? { ...e, role: "participant" } : e
      );
      await saveLobbyIndex(currentUser.accountId, nextList);
      setLobby(nextList.sort((a, b) => sortDateValue(b) - sortDateValue(a)));
    } else {
      const nextList = myList.filter((e) => e.id !== sessionId);
      await saveLobbyIndex(currentUser.accountId, nextList);
      setLobby(nextList.sort((a, b) => sortDateValue(b) - sortDateValue(a)));
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
  // Fetches just enough about the event to show a confirmation step before
  // actually submitting a join request — clicking a link shouldn't
  // silently commit someone to an event's pending list without a final
  // "yes, this is the one I meant to join" check. Skipped entirely for the
  // owner or anyone already a player/pending — there's nothing to confirm
  // for someone already in it.
  const prepareJoinConfirmation = async (id, me) => {
    const data = await loadSessionData(id);
    if (!data) {
      alert("Link acara ini tidak valid atau sudah dihapus.");
      clearJoinParam();
      setScreen("lobby");
      return;
    }
    const isOwner = data.ownerId === me.accountId;
    const alreadyPlayer = (data.players || []).some((p) => p.accountId === me.accountId);
    const alreadyPending = (data.pendingRequests || []).some((p) => p.accountId === me.accountId);
    if (isOwner || alreadyPlayer || alreadyPending) {
      await handleJoinViaLink(id, me);
      clearJoinParam();
      return;
    }
    setJoinConfirmPreview({ id, data, me });
  };

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
      // If the host had sent this person an invitation but they came in via
      // the share link instead of accepting it, that invitation is now moot
      // — drop it so it doesn't sit forever under "Undangan Menunggu Respon".
      // This used to be a single unverified save; strengthened with a
      // read-back retry (same reasoning as persistAndVerify elsewhere) after
      // a real case showed someone ending up listed twice — accepting an
      // invitation directly AND opening the link close together raced two
      // separate un-verified writes against each other.
      const invitationsWithoutMe = (data.hostInvitations || []).filter(
        (i) => i.accountId !== account.accountId
      );
      const hadStaleInvitation =
        invitationsWithoutMe.length !== (data.hostInvitations || []).length;

      const saveAndVerify = async (partial) => {
        const delays = [300, 700, 1200];
        for (let attempt = 0; attempt < delays.length; attempt++) {
          const ok = await saveSessionData(id, partial);
          if (ok) {
            await new Promise((r) => setTimeout(r, delays[attempt]));
            const readBack = await loadSessionData(id);
            if (readBack) {
              const stillPlayer = (readBack.players || []).some((p) => p.accountId === account.accountId);
              const stillPending = (readBack.pendingRequests || []).some(
                (p) => p.accountId === account.accountId
              );
              const invitationCleared = !(readBack.hostInvitations || []).some(
                (i) => i.accountId === account.accountId
              );
              if ((stillPlayer || stillPending) && invitationCleared) return readBack;
            }
          } else {
            await new Promise((r) => setTimeout(r, delays[attempt]));
          }
        }
        return null;
      };

      if (!alreadyPlayer && !alreadyPending) {
        const newPending = [
          ...(data.pendingRequests || []),
          { id: uid(), name: account.displayName || account.username, accountId: account.accountId },
        ];
        current = {
          ...data,
          pendingRequests: newPending,
          hostInvitations: invitationsWithoutMe,
          updatedAt: Date.now(),
        };
        const verified = await saveAndVerify(current);
        if (verified) current = verified;
      } else if (hadStaleInvitation) {
        current = { ...data, hostInvitations: invitationsWithoutMe, updatedAt: Date.now() };
        const verified = await saveAndVerify(current);
        if (verified) current = verified;
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
          playDate: current.playDate || null,
          sportType: current.sportType || "padel",
          gameFormat: current.gameFormat || "americano",
          teamFormat: current.teamFormat || (current.gameFormat === "fixed_partner" ? "fixed" : "rotating"),
          scoreFormat: current.scoreFormat || "points",
          tennisTarget: current.tennisTarget || 4,
        };
        nextList = [entry, ...myList];
        await saveLobbyIndex(account.accountId, nextList);
      }
      setLobby(nextList.sort((a, b) => sortDateValue(b) - sortDateValue(a)));
    } else {
      const myList = await loadLobbyIndex(account.accountId);
      setLobby(myList.sort((a, b) => sortDateValue(b) - sortDateValue(a)));
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
    setEndTime(current.endTime || "21:00");
    setScoreFormat(current.scoreFormat || "points");
    setSportType(current.sportType || "padel");
    {
      const { gameFormat: gf, teamFormat: tf } = resolveGameAndTeamFormat(current);
      setGameFormat(gf);
      setTeamFormat(tf);
    }
    setFixedPairs(current.fixedPairs || []);
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
    setCourtCost(current.courtCost ?? "");
    setAdminFee(current.adminFee ?? "");
    setBallCost(current.ballCost ?? "");
    setPaymentPersonId(current.paymentPersonId ?? null);
    setPaymentInfo(current.paymentInfo || []);
    setEnded(!!current.ended);
    setEngine(current.engine || null);
    setPlayerMap(current.playerMap || {});
    setScores(current.scores || {});
    setCurrentRound(
      current.engine && !current.ended
        ? findFirstUnscoredRound(current.engine, current.scores || {})
        : current.currentRound || 0
    );
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
        setLobby(list.sort((a, b) => sortDateValue(b) - sortDateValue(a)));
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
          // Deliberately NOT syncing currentRound from shared storage here —
          // which round each person is LOOKING AT should be their own local
          // browsing position, not something that jumps around whenever
          // someone else navigates. Scores/engine still update live either
          // way. Just defensively clamp in case the round count shrank
          // (e.g. someone else reshuffled/adjusted the schedule).
          setCurrentRound((prev) => {
            const total = (saved.engine?.roundsData || []).length;
            if (total === 0) return 0;
            return Math.min(prev, total - 1);
          });
          setScores(saved.scores || {});
          setScoreFormat(saved.scoreFormat || "points");
          setSportType(saved.sportType || "padel");
          {
            const { gameFormat: gf, teamFormat: tf } = resolveGameAndTeamFormat(saved);
            setGameFormat(gf);
            setTeamFormat(tf);
          }
          setFixedPairs(saved.fixedPairs || []);
          setPointTarget(saved.pointTarget ?? 21);
          setTennisTarget(saved.tennisTarget ?? 4);
          setCourtCost(saved.courtCost ?? "");
          setAdminFee(saved.adminFee ?? "");
          setBallCost(saved.ballCost ?? "");
          setPaymentPersonId(saved.paymentPersonId ?? null);
          setPaymentInfo(saved.paymentInfo || []);
          // loggedMatchKeys is an append-only guard against re-logging a
          // match into Partner Synergy stats. If a sync happens to read a
          // slightly older copy of the session than what was just written
          // locally (a normal race with the ~4s poll interval), blindly
          // overwriting it here could un-mark an already-logged match,
          // letting the next tick log it again — which is how the same
          // match ends up double (or more) counted. Merging instead of
          // replacing means the guard only ever grows, never shrinks.
          setLoggedMatchKeys((prev) =>
            Array.from(new Set([...(prev || []), ...(saved.loggedMatchKeys || [])]))
          );
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
        paymentPersonId,
        paymentInfo,
        paidStatus,
        loggedMatchKeys,
        courtStages,
        playDate,
        excludeFromStats,
        activityLog,
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
        endTime,
        scoreFormat,
        sportType,
        gameFormat,
        teamFormat,
        fixedPairs,
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
      const savePromise = saveSessionData(id, snapshot);
      syncPublicEventEntry(snapshot);
      syncAllMatchesRegistryEntry(snapshot);
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
        playDate: snapshot.playDate || null,
        ownerUsername: snapshot.ownerUsername || "",
        sportType: snapshot.sportType || "padel",
        gameFormat: snapshot.gameFormat || "americano",
        teamFormat: snapshot.teamFormat || "rotating",
        scoreFormat: snapshot.scoreFormat || "points",
        tennisTarget: snapshot.tennisTarget || 4,
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
      return savePromise;
    },
    [activeId, currentUser, ownerId, ownerUsername, eventName, status, visibility, hostPlaying, coHostIds, courtCost, adminFee, ballCost, paymentPersonId, paymentInfo, paidStatus, loggedMatchKeys, courtStages, playDate, excludeFromStats, activityLog, maxParticipants, pendingRequests, hostInvitations, players, courts, mode, totalMinutes, minutesPerRound, breakMinutes, manualRounds, startTime, endTime, scoreFormat, sportType, gameFormat, teamFormat, fixedPairs, pointTarget, tennisTarget, ended, engine, playerMap, currentRound, scores]
  );

  // Partner Synergy Index: whenever a specific match's score newly becomes
  // complete, log it into each participating (accountId-having) player's
  // personal match history, so pair statistics keep building up match by
  // match rather than only when the whole event ends. `loggedMatchKeys`
  // (shared via the session, synced across viewers) makes sure each match
  // only gets recorded once even if several people have the session open.
  useEffect(() => {
    if (!engine || !activeId) return;
    const playersById = {};
    players.forEach((p) => (playersById[p.id] = p));
    const loggedSet = new Set(loggedMatchKeys);
    const newlyLoggedKeys = [];
    const byAccount = {};
    const matchDescriptions = [];

    engine.roundsData.forEach((rd, rIdx) => {
      rd.courts.forEach((match, cIdx) => {
        const key = `${rIdx}-${cIdx}`;
        if (loggedSet.has(key)) return;
        const s = scores[key];
        if (!isMatchScoreComplete(s)) return;
        const records = buildPartnerLogRecords(
          match,
          s,
          activeId,
          eventName,
          Date.now(),
          playersById,
          key
        );
        records.forEach(({ accountId, record }) => {
          if (!byAccount[accountId]) byAccount[accountId] = [];
          byAccount[accountId].push(record);
        });
        newlyLoggedKeys.push(key);
        const ab = matchAB(s);
        const n1 = match.team1.map((id) => playersById[id]?.name || id).join("+");
        const n2 = match.team2.map((id) => playersById[id]?.name || id).join("+");
        matchDescriptions.push(
          `Ronde ${rIdx + 1} Lap.${cIdx + 1}: ${n1} vs ${n2} = ${ab.a}-${ab.b}`
        );
      });
    });

    if (newlyLoggedKeys.length === 0) return;

    const nextLoggedKeys = [...loggedMatchKeys, ...newlyLoggedKeys];
    setLoggedMatchKeys(nextLoggedKeys);
    // Re-check against the freshest copy in storage right before writing —
    // this session may have been sitting open a while, or open in another
    // tab/device too, so the locally-held loggedMatchKeys could already be
    // stale. Merging here (rather than trusting the local snapshot alone)
    // closes most of the window where a match could get logged twice.
    (async () => {
      const latest = await loadSessionData(activeId);
      const mergedKeys = Array.from(
        new Set([...(latest?.loggedMatchKeys || []), ...nextLoggedKeys])
      );
      setLoggedMatchKeys(mergedKeys);
      persist({ loggedMatchKeys: mergedKeys });
    })();
    Object.entries(byAccount).forEach(([accountId, records]) => {
      appendPlayerMatchRecords(accountId, records);
    });
    matchDescriptions.forEach((desc) =>
      logActivity(`Skor lengkap — ${desc}`, { dedupe: true })
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scores, engine, activeId]);

  // Retries persist() a few times with short delays. Exists specifically
  // for the moment right after creating a brand-new event: activeId gets
  // set via setActiveId(), but React state updates aren't synchronous, so
  // a persist() call fired too soon after (e.g. adding the very first
  // player right after hitting create) can read a stale activeId that's
  // still null and silently no-op — the player would show up locally but
  // never actually get saved, then vanish the next time the poll pulls
  // real (player-less) data from the server. Retrying gives React a moment
  // to catch up instead of failing invisibly.
  // Verifies the save actually landed on the server (not just that persist()
  // was called) by reading back and checking the new player id is really
  // there, retrying if not. This is deliberately more thorough than just
  // checking activeId is set: a newly-added player disappearing shortly
  // after being added has been reported even on established events (not
  // just brand-new ones), so this guards against ANY cause of the write
  // not sticking — a slow connection, a stale poll landing at an unlucky
  // moment, whatever — by re-asserting the addition until it's confirmed,
  // rather than assuming a single persist() call was enough.
  const persistWithRetry = async (partial, checkPlayerId) => {
    const delays = [200, 400, 800, 1200];
    for (let attempt = 0; attempt < delays.length; attempt++) {
      if (!activeId) {
        await new Promise((r) => setTimeout(r, delays[attempt]));
        continue;
      }
      persist(partial);
      await new Promise((r) => setTimeout(r, delays[attempt]));
      if (checkPlayerId) {
        const readBack = await loadSessionData(activeId);
        if (readBack && (readBack.players || []).some((p) => p.id === checkPlayerId)) {
          return true;
        }
        // Not there yet — re-issue the same persist on the next loop
        // iteration rather than giving up after one attempt.
      } else {
        return true;
      }
    }
    return false;
  };

  const addPlayerFromInput = () => {
    const name = nameInput.trim();
    if (!name) return;
    const dup = players.some((p) => p.name.trim().toLowerCase() === name.toLowerCase());
    if (dup) {
      const confirmed = window.confirm(
        `"${name}" sudah ada di daftar. Tetap tambahkan sebagai orang yang berbeda? (Kalau maksudnya orang yang SAMA, batalkan ini — dia udah ada.)`
      );
      if (!confirmed) return;
    }
    const newId = uid();
    setPlayers((p) => {
      const next = [...p, { id: newId, name }];
      persistWithRetry({ players: next }, newId).then((ok) => {
        if (!ok) {
          alert(
            `Gagal menyimpan "${name}" — coba cek koneksi lalu tambahkan lagi.`
          );
        }
      });
      return next;
    });
    if (activeId) logActivity(`Tambah pemain: ${name}${dup ? " (nama sama dengan yang sudah ada)" : ""}`);
    setNameInput("");
  };

  const addBulk = () => {
    const names = bulkInput
      .split(/[\n,]/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (!names.length) return;
    setPlayers((p) => {
      const existingLower = new Set(p.map((x) => x.name.trim().toLowerCase()));
      const genuinelyNew = [];
      const skipped = [];
      names.forEach((name) => {
        if (existingLower.has(name.toLowerCase())) {
          skipped.push(name);
        } else {
          genuinelyNew.push(name);
          existingLower.add(name.toLowerCase()); // guard against duplicates within the pasted list itself too
        }
      });
      if (skipped.length) {
        alert(
          `${skipped.length} nama dilewati karena sudah ada di daftar: ${skipped.join(", ")}.\n\n` +
            `${genuinelyNew.length} nama baru ditambahkan.`
        );
      }
      if (genuinelyNew.length === 0) return p;
      const newEntries = genuinelyNew.map((name) => ({ id: uid(), name }));
      const next = [...p, ...newEntries];
      persistWithRetry({ players: next }, newEntries[newEntries.length - 1].id).then((ok) => {
        if (!ok) {
          alert(`Gagal menyimpan pemain baru — coba cek koneksi lalu tambahkan lagi.`);
        }
      });
      if (activeId) logActivity(`Tambah pemain (tempel banyak): ${genuinelyNew.join(", ")}`);
      return next;
    });
    setBulkInput("");
  };

  const removePlayer = (id) =>
    setPlayers((p) => {
      const next = p.filter((x) => x.id !== id);
      persist({ players: next });
      // If they were part of a fixed pair, that pair no longer makes sense
      // — break it apart so the other half shows back up as "unpaired"
      // instead of silently vanishing from the pairing UI.
      setFixedPairs((pairs) => {
        const stillValid = pairs.filter((pair) => !pair.includes(id));
        if (stillValid.length !== pairs.length) persist({ fixedPairs: stillValid });
        return stillValid;
      });
      return next;
    });

  const computedRounds =
    mode === "duration"
      ? Math.max(1, Math.floor(totalMinutes / (minutesPerRound + breakMinutes)))
      : Math.max(1, manualRounds);

  // PHASE A — create the meeting "concept" (courts, duration, score format,
  // target participant count) and move to the waiting room to gather players.
  const handleCreateConcept = async () => {
    const id = activeId || uid();
    const finalName =
      eventName.trim() || generateEventNameTemplate(playDate, startTime, sportType) || "Sesi Padel";
    setEventName(finalName);
    setStatus("waiting");
    setSessionRole("owner");
    setPendingRequests([]);
    setHostInvitations([]);
    setHostPlaying(false);
    setCoHostIds([]);
    setOwnerId(currentUser?.accountId || null);
    setOwnerUsername(currentUser?.displayName || currentUser?.username || "");
    setActiveId(id);
    // Deliberately awaited BEFORE moving to the waiting room screen: this
    // used to fire persist() and immediately switch screens in the same
    // tick, so a player could get added (its own separate persist() call)
    // before this creation write had even started. Two independent writes
    // to the same brand-new session document racing like that meant
    // whichever one finished LAST would win regardless of which was
    // semantically newer — occasionally the slower creation write (it also
    // syncs the lobby index, public listing, and all-matches registry)
    // would land after the add-player write and silently wipe it back to
    // an empty roster a few seconds later. Waiting here means nothing else
    // can touch this session until the initial document genuinely exists.
    await persist(
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
        ownerUsername: currentUser?.displayName || currentUser?.username || "",
        engine: null,
        playerMap: {},
        currentRound: 0,
        scores: {},
      },
      id
    );
    setScreen("waiting");
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
        : [...players, { id: uid(), name: currentUser.displayName || currentUser.username, accountId: currentUser.accountId }];
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
    const validStages = teamFormat === "fixed" || gameFormat === "mexicano" ? [] : courtStages.filter((s) => s.rounds > 0);
    const stagesTotal = validStages.reduce((sum, s) => sum + s.rounds, 0);
    if (gameFormat === "americano" && teamFormat !== "fixed" && validStages.length > 0 && stagesTotal !== computedRounds) {
      alert(
        `Total ronde di tahapan lapangan (${stagesTotal}) belum sama dengan total ronde acara (${computedRounds}). Sesuaikan dulu di section "Lapangan Bertahap" sebelum generate.`
      );
      return;
    }

    const arrivedPlayers = players.map((p) => ({ ...p, arrived: true }));
    const ids = arrivedPlayers.map((p) => p.id);
    const map = {};
    arrivedPlayers.forEach((p) => (map[p.id] = p.name));

    if (gameFormat === "mexicano") {
      if (teamFormat === "fixed") {
        const pairedIds = new Set(fixedPairs.flat());
        const unpaired = arrivedPlayers.filter((p) => !pairedIds.has(p.id));
        if (unpaired.length > 0) {
          alert(
            `Masih ada ${unpaired.length} orang belum berpasangan: ${unpaired.map((p) => p.name).join(", ")}. Pasangin dulu semua sebelum generate.`
          );
          return;
        }
        const fixedTeams = fixedPairs.map(([a, b], i) => ({ id: `team_${i}_${a}_${b}`, players: [a, b] }));
        const gen = generateMexicanoFixedTeamRoundBatch(fixedTeams, courts, { roundNum: 0 });
        const playingIds = new Set(gen.matches.flatMap((m) => [...m.team1, ...m.team2]));
        const resting = arrivedPlayers.map((p) => p.id).filter((id) => !playingIds.has(id));
        const result = {
          roundsData: [{ resting, courts: gen.matches }],
          mexicano: true,
          mexicanoUnit: "team",
          fixedTeams,
          lastPlayed: gen.lastPlayed,
          playCount: gen.playCount,
          restCount: gen.restCount,
            opp: gen.opp,
          usableCourts: gen.usableCourts,
          rankingSnapshot: null,
          rankingSnapshotByRound: [null],
          cumulativePoints: {},
          mexicanoRoundNum: 0,
        };
        setEngine(result);
        setPlayerMap(map);
        setPlayers(arrivedPlayers);
        setCurrentRound(0);
        setScores({});
        setStatus("active");
        setScreen("session");
        persist({
          status: "active",
          players: arrivedPlayers,
          engine: result,
          playerMap: map,
          currentRound: 0,
          scores: {},
          fixedPairs,
          hostInvitations: [],
        });
        setHostInvitations([]);
        logActivity(
          `Generate Ronde 1 — Mexicano Fixed Partner (${fixedTeams.length} pasangan tetap, ${courts} lapangan)`
        );
        return;
      }

      const gen = generateMexicanoRoundBatch(ids, courts, { roundNum: 0 });
      const playingIds = new Set(gen.matches.flatMap((m) => [...m.team1, ...m.team2]));
      const resting = ids.filter((id) => !playingIds.has(id));
      const result = {
        roundsData: [{ resting, courts: gen.matches }],
        mexicano: true,
        mexicanoUnit: "player",
        lastPlayed: gen.lastPlayed,
        playCount: gen.playCount,
        restCount: gen.restCount,
        partner: gen.partner,
        opp: gen.opp,
        usableCourts: gen.usableCourts,
        rankingSnapshot: null,
        rankingSnapshotByRound: [null],
        cumulativePoints: {},
        mexicanoRoundNum: 0,
      };
      setEngine(result);
      setPlayerMap(map);
      setPlayers(arrivedPlayers);
      setCurrentRound(0);
      setScores({});
      setStatus("active");
      setScreen("session");
      persist({
        status: "active",
        players: arrivedPlayers,
        engine: result,
        playerMap: map,
        currentRound: 0,
        scores: {},
        hostInvitations: [],
      });
      setHostInvitations([]);
      logActivity(`Generate Ronde 1 — Mexicano (${ids.length} pemain, ${courts} lapangan)`);
      return;
    }

    if (teamFormat === "fixed") {
      const pairedIds = new Set(fixedPairs.flat());
      const unpaired = arrivedPlayers.filter((p) => !pairedIds.has(p.id));
      if (unpaired.length > 0) {
        alert(
          `Masih ada ${unpaired.length} orang belum berpasangan: ${unpaired.map((p) => p.name).join(", ")}. Pasangin dulu semua sebelum generate.`
        );
        return;
      }
      const fixedTeams = fixedPairs.map(([a, b], i) => ({ teamId: `team_${i}_${a}_${b}`, players: [a, b] }));
      const result = generateFixedPartnerSchedule(fixedTeams, courts, computedRounds);
      setEngine(result);
      setPlayerMap(map);
      setPlayers(arrivedPlayers);
      setCurrentRound(0);
      setScores({});
      setStatus("active");
      setScreen("session");
      persist({
        status: "active",
        players: arrivedPlayers,
        engine: result,
        playerMap: map,
        currentRound: 0,
        scores: {},
        fixedPairs,
        hostInvitations: [],
      });
      setHostInvitations([]);
      logActivity(
        `Generate jadwal awal — Fixed Partner (${fixedTeams.length} pasangan tetap, ${courts} lapangan, ${computedRounds} ronde)`
      );
      return;
    }

    let result;
    if (validStages.length > 1) {
      // Generate stage by stage, carrying the fairness-tracking state
      // (partner/opponent/rest history) forward across stages instead of
      // resetting it — so switching from 1 court to 2 courts partway
      // through still counts as one continuous, fair rotation.
      let seed = null;
      let allRounds = [];
      let lastPart = null;
      let stageOffset = 0;
      validStages.forEach((stage) => {
        const part = generateSchedule(ids, stage.courts, stage.rounds, seed, stageOffset);
        allRounds = [...allRounds, ...part.roundsData];
        stageOffset += stage.rounds;
        seed = {
          partner: part.partner,
          opp: part.opp,
          playCount: part.playCount,
          restCount: part.restCount,
          lastPlayed: part.lastPlayed,
          skipDebt: part.skipDebt,
          consecutivePlays: part.consecutivePlays,
          debugTrace: part.debugTrace,
        };
        lastPart = part;
      });
      result = {
        roundsData: allRounds,
        playCount: lastPart.playCount,
        restCount: lastPart.restCount,
        partner: lastPart.partner,
        opp: lastPart.opp,
        usableCourts: lastPart.usableCourts,
        lastPlayed: lastPart.lastPlayed,
        skipDebt: lastPart.skipDebt,
        consecutivePlays: lastPart.consecutivePlays,
        debugTrace: lastPart.debugTrace,
      };
    } else {
      result = generateSchedule(ids, courts, computedRounds);
    }

    setEngine(result);
    setPlayerMap(map);
    setPlayers(arrivedPlayers);
    setCurrentRound(0);
    setScores({});
    setStatus("active");
    setScreen("session");
    // Once the event has actually started, a still-pending invitation
    // serves no purpose — whoever it was for either already made it into
    // the roster some other way (added manually, joined via link) or
    // simply isn't playing this time. Leaving it dangling is what let the
    // "accept a stale invitation after already being added as a guest"
    // duplicate-entry bug happen in the first place, so clear the slate
    // here rather than relying only on the accept-time guest-matching fix.
    persist({
      status: "active",
      players: arrivedPlayers,
      engine: result,
      playerMap: map,
      currentRound: 0,
      scores: {},
      hostInvitations: [],
    });
    setHostInvitations([]);
    logActivity(`Generate jadwal awal (${ids.length} pemain, ${courts} lapangan, ${computedRounds} ronde)`);
  };

  // HOST-ONLY (not co-host): re-runs the same fairness-first generator with
  // the same players/courts/round-count to produce a fresh randomized
  // pairing. Wipes existing scores since old ones no longer correspond to
  // the new pairing.
  // HOST-ONLY (not co-host): re-runs the fairness-first generator to get a
  // fresh randomized pairing for whatever hasn't been played yet. Any round
  // that's ALREADY fully scored is left completely untouched — only the
  // rounds still missing a score get thrown out and rebuilt, continuing the
  // same partner/opponent/rest history (so it's not treated as starting
  // over). This mirrors exactly how attendance-toggling/"Kelola
  // Pertandingan" already behaves, so reshuffling and toggling someone's
  // attendance can be mixed freely as two ways to reach the same result.
  const handleReshuffleMatches = async () => {
    if (!engine) return;

    if (engine?.mexicano) {
      if (engine.mexicanoUnit === "team") {
        alert("Reshuffle belum bisa dipakai buat Mexicano Fixed Partner — tim yang sudah tetap nggak berubah susunannya.");
        return;
      }
      const latestRoundIdx = engine.roundsData.length - 1;
      const latestRound = engine.roundsData[latestRoundIdx];
      const scoresForRound = latestRound.courts.map((_, cIdx) => scores[`${latestRoundIdx}-${cIdx}`]);
      const allScoredMex = latestRound.courts.every((_, cIdx) => isMatchScoreComplete(scoresForRound[cIdx]));
      if (allScoredMex) {
        alert("Ronde ini sudah lengkap diisi skor semua — tidak ada lagi yang bisa di-reshuffle. Ronde berikutnya akan otomatis digenerate.");
        return;
      }
      if (
        !window.confirm(
          "Acak ulang match yang BELUM diisi skor di ronde ini pakai roster yang sama? Match yang sudah diskor tetap disimpan apa adanya."
        )
      )
        return;
      try {
        const activeIds = playersRef.current.filter((p) => p.arrived !== false).map((p) => p.id);
        // Same regeneration engine used for roster changes, but called with
        // the CURRENT roster unchanged — its only job here is to produce a
        // fresh pairing arrangement for whatever's still unscored.
        const result = regenerateMexicanoCurrentRound(activeIds, courts, latestRound.courts, scoresForRound, engine);
        if (result.rejected) {
          alert(result.reason);
          return;
        }
        if (result.unchanged) {
          alert("Ronde ini sudah lengkap diisi skor semua — tidak ada lagi yang bisa di-reshuffle.");
          return;
        }
        const newRoundsData = [...engine.roundsData];
        newRoundsData[latestRoundIdx] = { ...latestRound, courts: result.courts };
        const newEngine = { ...engine, roundsData: newRoundsData };
        const newScores = {};
        Object.keys(scores).forEach((key) => {
          const [rStr, cStr] = key.split("-");
          const r = parseInt(rStr, 10);
          if (r !== latestRoundIdx) {
            newScores[key] = scores[key];
            return;
          }
          const cIdx = parseInt(cStr, 10);
          if (cIdx < result.scoredCount) newScores[key] = scores[key];
        });
        setEngine(newEngine);
        setScores(newScores);
        persist({ engine: newEngine, scores: newScores });
        logActivity(
          `Reshuffle Ronde ${latestRoundIdx + 1} (Mexicano) — ${result.scoredCount} match yang sudah diskor tetap, ${result.newUnscoredCount} match sisanya diacak ulang`
        );
      } catch (e) {
        console.error("handleReshuffleMatches (Mexicano) failed:", e);
        alert(
          "Gagal reshuffle: " +
            (e?.message || "terjadi kesalahan tak terduga") +
            "\n\nJadwal belum diubah, coba lagi atau kirim screenshot pesan ini."
        );
      }
      return;
    }

    const allScored = engine.roundsData.every((rd, rIdx) =>
      rd.courts.every((_, cIdx) => isMatchScoreComplete(scores[`${rIdx}-${cIdx}`]))
    );
    if (allScored) {
      alert("Semua ronde sudah lengkap diisi skor — tidak ada lagi yang bisa di-reshuffle.");
      return;
    }
    if (
      !window.confirm(
        "Acak ulang sisa jadwal? Ronde yang SUDAH lengkap diisi skor tetap disimpan apa adanya — cuma ronde yang BELUM diisi skornya yang bakal diacak ulang."
      )
    )
      return;
    try {
      // Awaited on purpose: this used to fire-and-forget, so clicking
      // Reshuffle rapidly several times in a row (easy to do when hunting
      // for a better-looking combination) could have MULTIPLE regeneration
      // calls in flight at once, each reading/writing based on a slightly
      // different snapshot — whichever finished last would silently win,
      // occasionally producing a result that looked like it ignored a
      // change (e.g. a just-deleted player) made moments before.
      const saved = await handleAdjustScheduleInner(players);
      if (saved) logActivity("Reshuffle sisa jadwal (ronde yang sudah lengkap skornya tetap disimpan)");
    } catch (e) {
      console.error("handleReshuffleMatches failed:", e);
      alert(
        "Gagal reshuffle: " +
          (e?.message || "terjadi kesalahan tak terduga") +
          "\n\nJadwal belum diubah, coba lagi atau kirim screenshot pesan ini."
      );
    }
  };

  // HOST or CO-HOST: appends one extra manually-composed match/round once
  // the normal schedule is done — useful when there's still time left.
  const handleAddManualMatch = (team1Ids, team2Ids) => {
    if (!engine) return;
    const allIds = players.map((p) => p.id);
    const playing = new Set([...team1Ids, ...team2Ids]);
    const resting = allIds.filter((id) => !playing.has(id));
    const newRound = { resting, courts: [{ team1: team1Ids, team2: team2Ids }] };
    const newRoundsData = [...engine.roundsData, newRound];
    const newRoundIdx = newRoundsData.length - 1;

    if (teamFormat === "fixed") {
      // Team-based engine shape: history is tracked per TEAM (oppHist), not
      // per player pair (partner/opp) — find which fixed team each side
      // corresponds to and update that team's play count / rest count /
      // opponent history instead.
      const teamIdOf = (playerId) => {
        const idx = (fixedPairs || []).findIndex((pair) => pair.includes(playerId));
        if (idx === -1) return null;
        const [a, b] = fixedPairs[idx];
        return `team_${idx}_${a}_${b}`;
      };
      const team1Id = teamIdOf(team1Ids[0]);
      const team2Id = teamIdOf(team2Ids[0]);
      const newOppHist = {};
      Object.keys(engine.oppHist || {}).forEach((id) => (newOppHist[id] = { ...engine.oppHist[id] }));
      const newPlayCount = { ...engine.playCount };
      const newRestCount = { ...engine.restCount };
      if (team1Id && team2Id) {
        newOppHist[team1Id] = newOppHist[team1Id] || {};
        newOppHist[team2Id] = newOppHist[team2Id] || {};
        newOppHist[team1Id][team2Id] = (newOppHist[team1Id][team2Id] || 0) + 1;
        newOppHist[team2Id][team1Id] = (newOppHist[team2Id][team1Id] || 0) + 1;
        newPlayCount[team1Id] = (newPlayCount[team1Id] || 0) + 1;
        newPlayCount[team2Id] = (newPlayCount[team2Id] || 0) + 1;
      }
      (fixedPairs || []).forEach(([a, b], i) => {
        const tid = `team_${i}_${a}_${b}`;
        if (tid !== team1Id && tid !== team2Id) newRestCount[tid] = (newRestCount[tid] || 0) + 1;
      });
      const newEngine = {
        ...engine,
        roundsData: newRoundsData,
        oppHist: newOppHist,
        playCount: newPlayCount,
        restCount: newRestCount,
      };
      setEngine(newEngine);
      setCurrentRound(newRoundIdx);
      persist({ engine: newEngine, currentRound: newRoundIdx });
      logActivity(`Tambah match manual Ronde ${newRoundIdx + 1}: ${team1Ids.join("+")} vs ${team2Ids.join("+")}`);
      return;
    }

    const newPartner = {};
    const newOpp = {};
    Object.keys(engine.partner).forEach((id) => (newPartner[id] = { ...engine.partner[id] }));
    Object.keys(engine.opp).forEach((id) => (newOpp[id] = { ...engine.opp[id] }));
    const newPlayCount = { ...engine.playCount };
    const newRestCount = { ...engine.restCount };

    const [a, b] = team1Ids;
    const [c, d] = team2Ids;
    newPartner[a][b] = (newPartner[a][b] || 0) + 1;
    newPartner[b][a] = (newPartner[b][a] || 0) + 1;
    newPartner[c][d] = (newPartner[c][d] || 0) + 1;
    newPartner[d][c] = (newPartner[d][c] || 0) + 1;
    [a, b].forEach((x) =>
      [c, d].forEach((y) => {
        newOpp[x][y] = (newOpp[x][y] || 0) + 1;
        newOpp[y][x] = (newOpp[y][x] || 0) + 1;
      })
    );
    [a, b, c, d].forEach((id) => (newPlayCount[id] = (newPlayCount[id] || 0) + 1));
    resting.forEach((id) => (newRestCount[id] = (newRestCount[id] || 0) + 1));

    const newEngine = {
      ...engine,
      roundsData: newRoundsData,
      partner: newPartner,
      opp: newOpp,
      playCount: newPlayCount,
      restCount: newRestCount,
    };
    setEngine(newEngine);
    setCurrentRound(newRoundIdx);
    persist({ engine: newEngine, currentRound: newRoundIdx });
    logActivity(`Tambah match manual Ronde ${newRoundIdx + 1}: ${team1Ids.join("+")} vs ${team2Ids.join("+")}`);
  };

  // Auto-generates N more fairness-optimized rounds (same algorithm as the
  // original schedule — picks teams automatically instead of the host
  // manually assigning them) — for when there's still time left after the
  // planned schedule is done. Continues the same partner/opponent/rest
  // history so it's treated as one continuous rotation, not a fresh start.
  const handleAddAutoRound = (count = 1) => {
    if (!engine) return;
    const activePlayers = players.filter((p) => p.arrived !== false);
    if (activePlayers.length < 4) {
      alert("Minimal 4 pemain yang hadir diperlukan supaya bisa generate ronde baru.");
      return;
    }
    const n = Math.max(1, Math.min(50, Math.floor(count) || 1));
    const ids = activePlayers.map((p) => p.id);
    const seed = {
      partner: engine.partner,
      opp: engine.opp,
      playCount: engine.playCount,
      restCount: engine.restCount,
      lastPlayed: engine.lastPlayed || {},
      skipDebt: engine.skipDebt || {},
      debugTrace: engine.debugTrace || [],
    };
    const part = generateSchedule(ids, courts, n, seed, engine.roundsData.length);
    const newRoundsData = [...engine.roundsData, ...part.roundsData];
    const newEngine = {
      roundsData: newRoundsData,
      playCount: part.playCount,
      restCount: part.restCount,
      partner: part.partner,
      opp: part.opp,
      usableCourts: part.usableCourts,
      lastPlayed: part.lastPlayed,
      skipDebt: part.skipDebt,
      consecutivePlays: part.consecutivePlays,
      debugTrace: part.debugTrace,
    };
    const newRoundIdx = newRoundsData.length - 1;
    setEngine(newEngine);
    setCurrentRound(newRoundIdx);
    persist({ engine: newEngine, currentRound: newRoundIdx });
    logActivity(`Tambah ${n} ronde otomatis (total jadi ${newRoundsData.length} ronde)`);
  };

  // Deletes one specific round entirely (host & co-host). Any scores it had
  // are lost, later rounds shift down by one, and its contribution to the
  // partner/opponent/rest fairness counters is subtracted out (rather than
  // replaying everything from scratch).
  // HOST-ONLY: removes one specific round entirely. `regenerateRest` decides
  // what happens to the rounds that come after it (same idea as manually
  // editing a match's players):
  //   - true:  everything after the deleted round is regenerated fresh,
  //            using fairness history that correctly reflects the deletion
  //   - false: the remaining rounds keep their current pairings exactly as
  //            they were — only their round NUMBERS shift down by one
  // Either way, playCount/restCount/partner/opp/lastPlayed are rebuilt by
  // replaying the actual resulting schedule from scratch, rather than
  // manually decrementing counters — the same fix applied to other actions
  // in this app after a stale/incremental-update bug caused numbers to
  // silently drift from reality over a long session.
  const handleDeleteRound = async (roundIdx, regenerateRest) => {
    if (!engine) return false;
    if (engine.roundsData.length <= 1) {
      alert("Nggak bisa hapus — minimal harus tersisa 1 ronde.");
      return false;
    }
    const activeIds = players.filter((p) => p.arrived !== false).map((p) => p.id);

    let newRoundsData;
    let newScores;
    let newEngine;

    if (!regenerateRest) {
      newRoundsData = engine.roundsData.filter((_, i) => i !== roundIdx);
      newScores = {};
      Object.keys(scores).forEach((key) => {
        const [rStr, cStr] = key.split("-");
        const r = parseInt(rStr, 10);
        if (r === roundIdx) return;
        const newR = r > roundIdx ? r - 1 : r;
        newScores[`${newR}-${cStr}`] = scores[key];
      });
      const rebuilt = replayRoundsIntoSeed(newRoundsData, activeIds);
      // No new generation happened here — every remaining round kept its
      // existing pairing — so just drop the deleted round's own debug
      // entry and keep the rest as-is (their round numbers shift down,
      // matching newRoundsData, but the reasoning recorded for each is
      // still accurate to what actually happened).
      const newDebugTrace = (engine.debugTrace || []).filter((_, i) => i !== roundIdx);
      newEngine = { ...engine, roundsData: newRoundsData, ...rebuilt, debugTrace: newDebugTrace };
    } else {
      const lockedRounds = engine.roundsData.slice(0, roundIdx);
      const seed = replayRoundsIntoSeed(lockedRounds, activeIds);
      seed.debugTrace = (engine.debugTrace || []).slice(0, roundIdx);
      const remainingCount = engine.roundsData.length - 1 - roundIdx;
      const freshPart =
        remainingCount > 0
          ? generateSchedule(activeIds, courts, remainingCount, seed, roundIdx)
          : { roundsData: [], playCount: seed.playCount, restCount: seed.restCount, partner: seed.partner, opp: seed.opp, usableCourts: 0, lastPlayed: seed.lastPlayed, skipDebt: seed.skipDebt, debugTrace: seed.debugTrace, consecutivePlays: seed.consecutivePlays };
      newRoundsData = [...lockedRounds, ...freshPart.roundsData];
      newEngine = {
        roundsData: newRoundsData,
        playCount: freshPart.playCount,
        restCount: freshPart.restCount,
        partner: freshPart.partner,
        opp: freshPart.opp,
        usableCourts: freshPart.usableCourts,
        lastPlayed: freshPart.lastPlayed,
        skipDebt: freshPart.skipDebt,
      consecutivePlays: freshPart.consecutivePlays,
        debugTrace: freshPart.debugTrace,
      };
      newScores = {};
      Object.keys(scores).forEach((key) => {
        const rIdx = parseInt(key.split("-")[0], 10);
        if (rIdx < roundIdx) newScores[key] = scores[key];
      });
    }

    const newCurrentRound = Math.max(
      0,
      Math.min(currentRound > roundIdx ? currentRound - 1 : currentRound, newRoundsData.length - 1)
    );

    setEngine(newEngine);
    setScores(newScores);
    setCurrentRound(newCurrentRound);
    const saved = await persistAndVerify(
      { engine: newEngine, scores: newScores, currentRound: newCurrentRound },
      (readBack) => (readBack?.engine?.roundsData?.length || 0) === newRoundsData.length
    );
    if (!saved) {
      alert(
        "Hapus ronde kelihatannya BELUM tersimpan ke server (koneksi mungkin bermasalah). Coba lagi, dan pastikan koneksi internet stabil sebelum pindah layar."
      );
      return false;
    }
    logActivity(
      `Hapus Ronde ${roundIdx + 1} (sisa ${newRoundsData.length} ronde)${
        regenerateRest ? " + sesuaikan ronde sisanya" : " (ronde lain tidak diubah)"
      }`
    );
    return true;
  };

  // Adds/removes players mid-match and re-generates the schedule for
  // everything that hasn't been played yet. Rounds that are already fully
  // scored are treated as locked history and left untouched — only the
  // remaining (not-yet-complete) rounds get thrown out and rebuilt for the
  // new roster, continuing the same partner/opponent/rest fairness tracking
  // accumulated so far (not starting over from zero).
  const handleAdjustSchedule = async (newPlayers, newCourts) => {
    if (!engine) return false;
    try {
      // Name exactly who was added/removed (by id, not just a count) — this
      // is the detail that was hardest to reconstruct after the fact when
      // debugging a real event's log: without it, there's no way to tell
      // whether a roster change was a same-person attendance flip or an
      // actual add/remove (which resets that person's history, since a
      // freshly-added entry always gets a brand-new id).
      const oldIds = new Set(playersRef.current.map((p) => p.id));
      const newIds = new Set(newPlayers.map((p) => p.id));
      const added = newPlayers
        .filter((p) => !oldIds.has(p.id))
        .map((p) => `${p.name}${p.accountId ? "" : " [guest]"}`);
      const removed = playersRef.current.filter((p) => !newIds.has(p.id)).map((p) => p.name);
      const saved = await handleAdjustScheduleInner(newPlayers, newCourts);
      const activeCount = newPlayers.filter((p) => p.arrived !== false).length;
      const parts = [`${activeCount} pemain aktif dari ${newPlayers.length} total`];
      if (newCourts) parts.push(`${newCourts} lapangan`);
      if (added.length) parts.push(`+ tambah: ${added.join(", ")}`);
      if (removed.length) parts.push(`- hapus: ${removed.join(", ")}`);
      logActivity(`Sesuaikan jadwal: ${parts.join(", ")}`);
      return saved;
    } catch (e) {
      console.error("handleAdjustSchedule failed:", e);
      alert(
        "Gagal menyesuaikan jadwal: " +
          (e?.message || "terjadi kesalahan tak terduga") +
          "\n\nJadwal belum diubah, coba lagi atau kirim screenshot pesan ini."
      );
      return false;
    }
  };

  const handleAdjustScheduleInner = async (newPlayers, newCourtsInput) => {
    if (engine?.mexicano) {
      const newCourts = newCourtsInput || courts;

      if (engine.mexicanoUnit === "team") {
        alert(
          "Kelola Pertandingan & Kedatangan Pemain belum bisa dipakai buat Mexicano Fixed Partner — tim yang sudah tetap nggak bisa ditambah/dikurangi orangnya di tengah acara. Hapus & buat ulang acara kalau perlu ubah susunan tim."
        );
        return;
      }

      const oldActiveIds = new Set(playersRef.current.filter((p) => p.arrived !== false).map((p) => p.id));
      const newActivePlayers = newPlayers.filter((p) => p.arrived !== false);
      const newActiveIds = new Set(newActivePlayers.map((p) => p.id));
      const removedIds = [...oldActiveIds].filter((id) => !newActiveIds.has(id));

      const latestRoundIdx = engine.roundsData.length - 1;
      const latestRound = engine.roundsData[latestRoundIdx];
      const scoresForRound = latestRound.courts.map((_, cIdx) => scores[`${latestRoundIdx}-${cIdx}`]);
      const scoredCountBefore = latestRound.courts.filter((_, cIdx) =>
        isMatchScoreComplete(scoresForRound[cIdx])
      ).length;

      const newMap = {};
      newPlayers.forEach((p) => (newMap[p.id] = p.name));

      // Whether an addition gets folded into THIS batch immediately depends
      // on whether the batch has genuinely started yet:
      //
      // - If NOTHING in the current batch has been scored, nothing is "in
      //   progress" that a new person joining could disrupt — so any change
      //   (add, remove, or both) regenerates the whole batch right now using
      //   the complete new roster.
      //
      // - Once at least one match has been scored, the batch is underway.
      //   Removal still can't wait — forcing someone who isn't there to
      //   keep playing an unscored match makes no sense — so it still
      //   regenerates immediately, but only using (old active - removed),
      //   NOT folding in anyone newly added at the same time. A pure
      //   addition at this point always waits for the next round-batch
      //   instead, rather than disrupting matches already underway.
      const batchAlreadyStarted = scoredCountBefore > 0;
      const regenIds = batchAlreadyStarted ? [...oldActiveIds].filter((id) => !removedIds.includes(id)) : [...newActiveIds];

      if (batchAlreadyStarted && removedIds.length === 0) {
        setPlayers(newPlayers);
        setPlayerMap(newMap);
        setCourts(newCourts);
        persist({ players: newPlayers, playerMap: newMap, courts: newCourts });
        logActivity(
          `Update roster (Mexicano) — ronde ${latestRoundIdx + 1} udah mulai (${scoredCountBefore} match sudah diskor), jadi perubahan ini baru berlaku mulai ronde berikutnya`
        );
        return;
      }

      const result = regenerateMexicanoCurrentRound(regenIds, newCourts, latestRound.courts, scoresForRound, engine);

      if (result.rejected) {
        alert(result.reason);
        return;
      }

      if (result.unchanged) {
        // Ronde ini udah lengkap semua skornya -- nggak ada yang perlu
        // disesuaikan lagi di ronde SEKARANG. Roster baru (termasuk yg
        // dikeluarkan) berlaku otomatis mulai ronde berikutnya.
        setPlayers(newPlayers);
        setPlayerMap(newMap);
        setCourts(newCourts);
        persist({ players: newPlayers, playerMap: newMap, courts: newCourts });
        logActivity(
          `Update roster (Mexicano) — berlaku mulai ronde berikutnya (ronde ${latestRoundIdx + 1} sudah lengkap skornya)`
        );
        return;
      }

      const newRoundsData = [...engine.roundsData];
      newRoundsData[latestRoundIdx] = { ...latestRound, courts: result.courts };
      const newEngine = { ...engine, roundsData: newRoundsData };

      // Skor yg posisinya mungkin bergeser (jumlah match sisa bisa berubah)
      // -- match yg SUDAH diskor selalu ditaruh di depan array baru
      // (lihat regenerateMexicanoCurrentRound), jadi skornya tetap valid;
      // sisanya (yg baru disusun ulang) dikosongkan.
      const newScores = {};
      Object.keys(scores).forEach((key) => {
        const [rStr, cStr] = key.split("-");
        const r = parseInt(rStr, 10);
        if (r !== latestRoundIdx) {
          newScores[key] = scores[key];
          return;
        }
        const cIdx = parseInt(cStr, 10);
        if (cIdx < result.scoredCount) newScores[key] = scores[key];
      });

      setEngine(newEngine);
      setPlayers(newPlayers);
      setPlayerMap(newMap);
      setCourts(newCourts);
      setScores(newScores);
      persist({ engine: newEngine, players: newPlayers, playerMap: newMap, courts: newCourts, scores: newScores });
      logActivity(
        batchAlreadyStarted
          ? `Sesuaikan Ronde ${latestRoundIdx + 1} (Mexicano) — ${removedIds.length} pemain dikeluarkan, ${result.scoredCount} match yang sudah diskor tetap, ${result.newUnscoredCount} match sisanya disusun ulang`
          : `Susun ulang Ronde ${latestRoundIdx + 1} (Mexicano) — belum ada match yang diskor, jadi seluruh ${result.newUnscoredCount} match disusun ulang pakai roster terbaru`
      );
      return;
    }
    const newCourts = newCourtsInput || courts;

    // Find the split point between "locked, never touch" and "safe to
    // regenerate" rounds. This is NOT simply "the first unscored round" —
    // scoring doesn't always happen strictly in order (a host can skip a
    // round and come back to it later), so an earlier round can still be
    // unscored while LATER rounds already have real results in them.
    // Basing the split on the first gap would silently wipe those later
    // rounds' scores the moment a roster change tried to regenerate
    // "everything after the gap" — confirmed via an exported event log
    // where rounds 3–7 had been scored, round 2 hadn't yet, and adjusting
    // the roster at that point discarded rounds 3–7's results entirely.
    // Using the LAST scored round instead guarantees nothing with a real
    // score ever gets regenerated — any earlier gap just stays frozen in
    // its original matchup (still editable by hand) rather than being
    // silently overwritten.
    let splitIdx = 0;
    for (let rIdx = 0; rIdx < engine.roundsData.length; rIdx++) {
      const rd = engine.roundsData[rIdx];
      const allScored = rd.courts.every((_, cIdx) => {
        const s = scores[`${rIdx}-${cIdx}`];
        if (!s) return false;
        if (s.format === "tennis") return (s.gamesA || 0) > 0 || (s.gamesB || 0) > 0;
        return s.a !== undefined && s.a !== "" && s.b !== undefined && s.b !== "";
      });
      if (allScored) splitIdx = rIdx + 1;
    }

    const lockedRounds = engine.roundsData.slice(0, splitIdx);
    const remainingRoundsCount = engine.roundsData.length - splitIdx;

    // Only players marked as arrived (default true) actually get scheduled
    // into upcoming rounds — anyone marked "belum datang" stays listed but
    // is excluded from future rounds until marked as arrived again.
    const activePlayers = newPlayers.filter((p) => p.arrived !== false);

    if (activePlayers.length < 4) {
      alert("Minimal 4 pemain yang sudah datang diperlukan supaya jadwal bisa disusun.");
      return;
    }
    if (remainingRoundsCount <= 0) {
      alert(
        "Semua ronde yang ada sudah lengkap diisi skor, jadi tidak ada yang bisa disesuaikan lagi. Pemain baru bisa ditambahkan lewat 'Tambah Match Manual' di ronde tambahan."
      );
      return;
    }

    if (teamFormat === "fixed") {
      const arrivedIds = new Set(activePlayers.map((p) => p.id));
      const fixedTeams = fixedPairs
        .map(([a, b], i) => ({ teamId: `team_${i}_${a}_${b}`, players: [a, b] }))
        .filter((t) => arrivedIds.has(t.players[0]) && arrivedIds.has(t.players[1]));
      // A fixed pair only makes sense as a whole — if one half isn't here,
      // there's no substitute partner to slot in, so the whole team sits
      // out until both are marked arrived again.
      if (fixedTeams.length < 2) {
        alert(
          "Minimal 2 pasangan tetap (4 orang) yang sudah datang diperlukan supaya jadwal bisa disusun. Kalau salah satu anggota pasangan belum hadir, seluruh pasangan itu otomatis istirahat."
        );
        return;
      }
      const teamSeed = replayFixedPartnerSeed(lockedRounds, fixedTeams);
      const freshPart = generateFixedPartnerSchedule(fixedTeams, newCourts, remainingRoundsCount, teamSeed, splitIdx);
      const newRoundsData = [...lockedRounds, ...freshPart.roundsData];
      const newEngine = {
        roundsData: newRoundsData,
        playCount: freshPart.playCount,
        restCount: freshPart.restCount,
        oppHist: freshPart.oppHist,
        usableCourts: freshPart.usableCourts,
        lastPlayed: freshPart.lastPlayed,
        skipDebt: freshPart.skipDebt,
      consecutivePlays: freshPart.consecutivePlays,
      };
      const newScores = {};
      Object.keys(scores).forEach((key) => {
        const rIdx = parseInt(key.split("-")[0], 10);
        if (rIdx < splitIdx) newScores[key] = scores[key];
      });
      setPlayers(newPlayers);
      setEngine(newEngine);
      setScores(newScores);
      const intendedIds = new Set(activePlayers.map((p) => p.id));
      const saved = await persistAndVerify(
        { players: newPlayers, engine: newEngine, scores: newScores, courts: newCourts },
        (readBack) => {
          const savedIds = new Set((readBack.players || []).map((p) => p.id));
          return newPlayers.every((p) => savedIds.has(p.id)) && intendedIds.size >= 0;
        }
      );
      if (!saved) {
        alert(
          "Perubahan jadwal (Fixed Partner) mungkin belum tersimpan karena masalah koneksi. Coba lagi — cek dulu apakah perubahan sudah benar-benar muncul sebelum melanjutkan."
        );
        return false;
      }
      return true;
    }

    // Rebuild the fairness-history seed by replaying ONLY the locked rounds
    // (not the discarded future ones) against the active roster.
    const seed = replayRoundsIntoSeed(lockedRounds, activePlayers.map((p) => p.id));
    seed.debugTrace = (engine.debugTrace || []).slice(0, splitIdx);

    // Anyone who has genuinely never played a single (locked/scored) round
    // yet starts with lastPlayed=-1 and zero partner/opponent history. That's
    // correct as-is for someone brand new, but "newcomer" here specifically
    // means "no real match history at all" (seed.playCount === 0) — NOT
    // simply "their arrived flag just flipped". This distinction matters a
    // lot for the common case of toggling someone's attendance off and back
    // on purely to force a reshuffle: if that were treated as "newcomer"
    // seeding, it would overwrite their REAL accumulated partner/opponent
    // history with a neutral average every time, causing the algorithm to
    // "forget" who they've already played with/against — leading to MORE
    // repeats for that person over repeated toggles, the opposite of what's
    // wanted. Checking playCount instead means genuine history is always
    // preserved regardless of how many times attendance gets toggled.
    const newcomers = activePlayers.filter((p) => !seed.playCount[p.id]);
    if (newcomers.length > 0) {
      const veterans = activePlayers.filter((p) => seed.playCount[p.id] > 0);

      // A brand-new/returning player has zero recorded matches with
      // literally everyone, which makes them look like a "free" variety
      // win to the partner/opponent-repeat optimizer — cheaper to slot in
      // than anyone with real history, even when their wait-time doesn't
      // call for it. Seeding their pairwise history at the group's current
      // average (instead of 0) removes that artificial appeal, so they
      // only get picked when their wait time actually earns it.
      let avgPartnerCount = 0;
      let avgOppCount = 0;
      let pairCount = 0;
      for (let i = 0; i < veterans.length; i++) {
        for (let j = i + 1; j < veterans.length; j++) {
          const idA = veterans[i].id;
          const idB = veterans[j].id;
          avgPartnerCount += seed.partner[idA]?.[idB] || 0;
          avgOppCount += seed.opp[idA]?.[idB] || 0;
          pairCount++;
        }
      }
      avgPartnerCount = pairCount > 0 ? avgPartnerCount / pairCount : 0;
      avgOppCount = pairCount > 0 ? avgOppCount / pairCount : 0;

      newcomers.forEach((p) => {
        // DISCUSSED CHANGE: someone who has genuinely never played a single
        // round yet (this is exactly what `newcomers` means here — anyone
        // who already has real match history is a "veteran" and never
        // reaches this branch) gets prioritized to play as soon as they're
        // marked arrived, instead of being slotted into the middle of the
        // rotation. Leaving lastPlayed at its sentinel (-1) does this: it
        // reads as "waited longer than anyone" in the wait-time sort. This
        // is scoped strictly to true first-timers — someone toggled off and
        // back on after already having played keeps their real lastPlayed
        // and joins the normal queue like everyone else, unaffected by this.
        seed.lastPlayed[p.id] = -1;
        veterans.forEach((existing) => {
          if (seed.partner[p.id]) seed.partner[p.id][existing.id] = avgPartnerCount;
          if (seed.partner[existing.id]) seed.partner[existing.id][p.id] = avgPartnerCount;
          if (seed.opp[p.id]) seed.opp[p.id][existing.id] = avgOppCount;
          if (seed.opp[existing.id]) seed.opp[existing.id][p.id] = avgOppCount;
        });
      });

      // Two+ newcomers joining together have never played each other, so
      // their mutual partner/opponent count is genuinely 0 — but leaving it
      // at 0 makes pairing THEM together look artificially cheaper than
      // pairing either one with a veteran (who has some real, nonzero
      // history to account for). That's exactly what was driving the
      // lock-in: the variety-cost search kept finding "both newcomers
      // together" as the cheapest combination and repeatedly choosing it,
      // round after round. Seeding their mutual relationship at the same
      // neutral average removes that false discount.
      for (let i = 0; i < newcomers.length; i++) {
        for (let j = i + 1; j < newcomers.length; j++) {
          const idA = newcomers[i].id;
          const idB = newcomers[j].id;
          if (seed.partner[idA]) seed.partner[idA][idB] = avgPartnerCount;
          if (seed.partner[idB]) seed.partner[idB][idA] = avgPartnerCount;
          if (seed.opp[idA]) seed.opp[idA][idB] = avgOppCount;
          if (seed.opp[idB]) seed.opp[idB][idA] = avgOppCount;
        }
      }
    }

    const ids = activePlayers.map((p) => p.id);
    // Merge instead of replacing outright — anyone removed/not-yet-arrived
    // still has their name preserved here for historical rounds/leaderboard,
    // it's just not part of the active `ids` used for future rounds.
    const map = { ...playerMap };
    newPlayers.forEach((p) => (map[p.id] = p.name));

    // If a "Lapangan Bertahap" plan was set up front (e.g. 1 court for the
    // first 7 rounds, then 2 courts for the rest) and this adjustment wasn't
    // an explicit court-count override from "Kelola Pertandingan", keep
    // respecting that original plan for whatever portion of it still falls
    // in the remaining (not-yet-scored) rounds — instead of collapsing
    // everything to one flat court count.
    const stageSegments = newCourtsInput
      ? null
      : sliceStagesFrom(courtStages, splitIdx, engine.roundsData.length);

    let freshPart;
    if (stageSegments) {
      let stageSeed = seed;
      let allRounds = [];
      let lastPart = null;
      let stageOffset = splitIdx;
      stageSegments.forEach((seg) => {
        const part = generateSchedule(ids, seg.courts, seg.rounds, stageSeed, stageOffset);
        allRounds = [...allRounds, ...part.roundsData];
        stageOffset += seg.rounds;
        stageSeed = {
          partner: part.partner,
          opp: part.opp,
          playCount: part.playCount,
          restCount: part.restCount,
          lastPlayed: part.lastPlayed,
          skipDebt: part.skipDebt,
          consecutivePlays: part.consecutivePlays,
          debugTrace: part.debugTrace,
        };
        lastPart = part;
      });
      freshPart = { ...lastPart, roundsData: allRounds };
    } else {
      freshPart = generateSchedule(ids, newCourts, remainingRoundsCount, seed, splitIdx);
    }

    const newRoundsData = [...lockedRounds, ...freshPart.roundsData];
    const newEngine = {
      roundsData: newRoundsData,
      playCount: freshPart.playCount,
      restCount: freshPart.restCount,
      partner: freshPart.partner,
      opp: freshPart.opp,
      usableCourts: freshPart.usableCourts,
      lastPlayed: freshPart.lastPlayed,
      skipDebt: freshPart.skipDebt,
      consecutivePlays: freshPart.consecutivePlays,
      debugTrace: freshPart.debugTrace,
    };

    // Keep scores for locked (already-complete) rounds; drop everything else
    // since those matchups no longer exist in the new schedule.
    const newScores = {};
    Object.keys(scores).forEach((key) => {
      const rIdx = parseInt(key.split("-")[0], 10);
      if (rIdx < splitIdx) newScores[key] = scores[key];
    });

    const newCurrentRound = Math.max(0, Math.min(splitIdx, newRoundsData.length - 1));
    // An explicit court override (from "Kelola Pertandingan") supersedes any
    // earlier staged plan for the rounds going forward — clear it so a later
    // attendance toggle doesn't fall back to the now-stale stage boundaries.
    const newCourtStages = newCourtsInput ? [] : courtStages;
    setPlayers(newPlayers);
    setPlayerMap(map);
    setEngine(newEngine);
    setScores(newScores);
    setCurrentRound(newCurrentRound);
    setCourts(newCourts);
    if (newCourtsInput) setCourtStages([]);
    // Verified save, same reasoning as the manual match-edit fix: this is
    // exactly the kind of change (remove/add a player, toggle attendance)
    // where a silently-failed or raced write is easy to miss until the
    // event is reopened later and the "removed" person is mysteriously
    // back — confirm it actually landed instead of assuming it did.
    //
    // IMPORTANT: this has to check more than just "same set of ids" — for
    // an attendance toggle specifically, the id set never changes (same
    // people, just one person's `arrived` flag flips), so an id-only check
    // would trivially "pass" even if the write silently failed to persist
    // the actual arrived value, giving a false sense of success and
    // exactly matching the "looked like it worked, then reverted later"
    // symptom this is meant to catch.
    const intendedById = {};
    newPlayers.forEach((p) => {
      intendedById[p.id] = p.arrived !== false;
    });
    const saved = await persistAndVerify(
      {
        players: newPlayers,
        playerMap: map,
        engine: newEngine,
        scores: newScores,
        currentRound: newCurrentRound,
        courts: newCourts,
        courtStages: newCourtStages,
      },
      (readBack) => {
        const savedPlayers = readBack.players || [];
        const savedById = {};
        savedPlayers.forEach((p) => {
          savedById[p.id] = p.arrived !== false;
        });
        const idsMatch =
          savedPlayers.length === newPlayers.length &&
          Object.keys(intendedById).every((id) => id in savedById);
        const arrivedMatches = Object.keys(intendedById).every(
          (id) => savedById[id] === intendedById[id]
        );
        return idsMatch && arrivedMatches;
      }
    );
    if (!saved) {
      alert(
        "Perubahan pemain/jadwal kelihatannya BELUM tersimpan ke server (koneksi mungkin bermasalah). Coba lakukan lagi, dan pastikan koneksi internet stabil sebelum pindah layar."
      );
    }
    return saved;
  };

  // Rebuilds the fairness-tracking seed (partner/opp/playCount/restCount/
  // lastPlayed) purely by replaying a given list of rounds — shared by the
  // manual-edit paths below so "what the numbers should be" always comes
  // from the actual round data, never from incrementally patching state.
  const replayRoundsIntoSeed = (roundsToReplay, activeIds) => {
    const seed = { partner: {}, opp: {}, playCount: {}, restCount: {}, lastPlayed: {}, skipDebt: {} };
    activeIds.forEach((id) => {
      seed.playCount[id] = 0;
      seed.restCount[id] = 0;
      seed.lastPlayed[id] = -1;
      seed.skipDebt[id] = 0;
      seed.partner[id] = {};
      seed.opp[id] = {};
    });
    roundsToReplay.forEach((rd, rIdx) => {
      // Infer skipDebt the same way generateSchedule tracks it: before this
      // round's actual outcome is known, work out who a strict wait-time
      // clump-swap would've considered "eligible to be bumped", then check
      // whether they actually ended up playing. This keeps debt state
      // consistent with real history whenever the schedule gets replayed
      // and regenerated (reshuffle, edits, roster changes), rather than
      // resetting everyone's bump eligibility to a clean slate each time.
      const capacityThisRound = rd.courts.length * 4;
      if (capacityThisRound <= 4 && activeIds.length > capacityThisRound) {
        const sorted = [...activeIds].sort(
          (x, y) => rIdx - seed.lastPlayed[x] - (rIdx - seed.lastPlayed[y])
        );
        const cutoffWait = rIdx - seed.lastPlayed[sorted[capacityThisRound - 1]];
        const guaranteed = sorted.filter((id) => rIdx - seed.lastPlayed[id] > cutoffWait);
        if (guaranteed.length >= 3) {
          const topWait = rIdx - seed.lastPlayed[guaranteed[0]];
          const tiedAtTop = guaranteed.filter((id) => rIdx - seed.lastPlayed[id] === topWait);
          if (tiedAtTop.length >= 3) {
            const eligible = tiedAtTop.filter((id) => (seed.skipDebt[id] || 0) === 0);
            const clumpEligible = eligible.slice(0, tiedAtTop.length - 2);
            const actuallyPlayed = new Set(rd.courts.flatMap((c) => [...c.team1, ...c.team2]));
            clumpEligible.forEach((id) => {
              if (!actuallyPlayed.has(id)) seed.skipDebt[id] = 1;
            });
          }
        }
      }
      rd.resting.forEach((id) => {
        if (seed.restCount[id] !== undefined) seed.restCount[id]++;
      });
      rd.courts.forEach(({ team1, team2 }) => {
        const [a, b] = team1;
        const [c, d] = team2;
        [a, b, c, d].forEach((id) => {
          if (seed.playCount[id] !== undefined) seed.playCount[id]++;
          if (seed.lastPlayed[id] !== undefined) seed.lastPlayed[id] = rIdx;
          if (seed.skipDebt[id] !== undefined) seed.skipDebt[id] = 0;
        });
        if (seed.partner[a] && seed.partner[a][b] !== undefined) {
          seed.partner[a][b]++;
          seed.partner[b][a]++;
        }
        if (seed.partner[c] && seed.partner[c][d] !== undefined) {
          seed.partner[c][d]++;
          seed.partner[d][c]++;
        }
        [a, b].forEach((x) =>
          [c, d].forEach((y) => {
            if (seed.opp[x] && seed.opp[x][y] !== undefined) {
              seed.opp[x][y]++;
              seed.opp[y][x]++;
            }
          })
        );
      });
    });
    return seed;
  };

  // Fixed Partner counterpart to replayRoundsIntoSeed: rebuilds team-level
  // history (which team has already faced which other team, how many
  // rounds each team has played/rested) by replaying the locked rounds
  // against a specific list of teams. Needed whenever a Fixed Partner
  // event's remaining rounds get regenerated (attendance toggle, roster
  // change) so the "who's faced who" memory carries forward correctly
  // instead of resetting.
  const replayFixedPartnerSeed = (roundsToReplay, fixedTeams) => {
    const seed = { oppHist: {}, playCount: {}, restCount: {}, lastPlayed: {}, skipDebt: {} };
    const teamOfPlayer = {}; // playerId -> teamId, for matching replayed rounds back to a team
    fixedTeams.forEach((t) => {
      seed.playCount[t.teamId] = 0;
      seed.restCount[t.teamId] = 0;
      seed.lastPlayed[t.teamId] = -1;
      seed.skipDebt[t.teamId] = 0;
      seed.oppHist[t.teamId] = {};
      t.players.forEach((pid) => (teamOfPlayer[pid] = t.teamId));
    });
    roundsToReplay.forEach((rd, rIdx) => {
      const playingTeamIds = new Set();
      rd.courts.forEach(({ team1, team2 }) => {
        const teamA = teamOfPlayer[team1[0]];
        const teamB = teamOfPlayer[team2[0]];
        if (!teamA || !teamB) return; // one side's team no longer exists in the current pairing — skip
        playingTeamIds.add(teamA);
        playingTeamIds.add(teamB);
        if (seed.playCount[teamA] !== undefined) seed.playCount[teamA]++;
        if (seed.playCount[teamB] !== undefined) seed.playCount[teamB]++;
        if (seed.lastPlayed[teamA] !== undefined) seed.lastPlayed[teamA] = rIdx;
        if (seed.lastPlayed[teamB] !== undefined) seed.lastPlayed[teamB] = rIdx;
        if (seed.oppHist[teamA] && seed.oppHist[teamA][teamB] !== undefined) {
          seed.oppHist[teamA][teamB]++;
          seed.oppHist[teamB][teamA]++;
        } else if (seed.oppHist[teamA]) {
          seed.oppHist[teamA][teamB] = 1;
          seed.oppHist[teamB] = seed.oppHist[teamB] || {};
          seed.oppHist[teamB][teamA] = 1;
        }
      });
      fixedTeams.forEach((t) => {
        if (!playingTeamIds.has(t.teamId) && seed.restCount[t.teamId] !== undefined) {
          seed.restCount[t.teamId]++;
        }
      });
    });
    return seed;
  };


  // match — e.g. "put X in instead of Y this round". `swaps` is a list of
  // {outId, inId} pairs, where inId must currently be resting in that same
  // round. After applying the swap, `regenerateRest` decides what happens
  // to every round AFTER this one:
  //   - true:  re-generate them fresh, using fairness history that now
  //            correctly includes this edit (keeps future rounds fair/
  //            varied relative to the new reality)
  //   - false: leave every other round exactly as it already was — only
  //            this one match changes
  // persist() writes fire against Firebase, which can occasionally fail
  // silently or lose a race with another write. For an action like manually
  // editing a match — easy to miss if it silently doesn't stick — this
  // wraps persist() with an actual read-back to CONFIRM the write landed,
  // retrying once before giving up and telling the host clearly instead of
  // pretending it worked.
  const persistAndVerify = async (partial, checkFn) => {
    const delays = [300, 700, 1200]; // progressively longer, in case of real backend lag
    for (let attempt = 0; attempt < delays.length; attempt++) {
      const ok = await persist(partial);
      if (ok) {
        // Give the backend a moment to actually settle before reading back
        // — reading back immediately after the write acknowledges can still
        // race a real backend under load or on a slow connection.
        await new Promise((r) => setTimeout(r, delays[attempt]));
        const readBack = await loadSessionData(activeId);
        if (readBack && checkFn(readBack)) return true;
      } else {
        await new Promise((r) => setTimeout(r, delays[attempt]));
      }
    }
    return false;
  };

  const handleEditMatchPlayers = async (roundIdx, courtIdx, newTeam1, newTeam2, otherCourtChanges, regenerateRest) => {
    if (!engine) return;
    const rd = engine.roundsData[roundIdx];
    const originalCourt = rd.courts[courtIdx];
    const originalFour = [...originalCourt.team1, ...originalCourt.team2];
    const newFour = [...newTeam1, ...newTeam2];
    const nothingChanged =
      originalFour.every((id, i) => id === newFour[i]) &&
      (!otherCourtChanges || otherCourtChanges.length === 0);
    if (nothingChanged) return;

    const newCourts = rd.courts.map((c, i) => {
      if (i === courtIdx) return { team1: newTeam1, team2: newTeam2 };
      const change = otherCourtChanges?.find((oc) => oc.courtIdx === i);
      return change ? { team1: change.team1, team2: change.team2 } : c;
    });
    // Whoever was involved before (playing ANY court this round, OR resting
    // this round) is the full pool that could end up resting now — anyone
    // from that pool not currently in ANY court's lineup is resting; this
    // covers resting<->playing swaps, playing<->playing swaps within one
    // court, AND pulling someone in from a different court, all at once.
    const involvedBefore = [...new Set([...rd.courts.flatMap((c) => [...c.team1, ...c.team2]), ...rd.resting])];
    const allNewPlaying = newCourts.flatMap((c) => [...c.team1, ...c.team2]);
    const newResting = involvedBefore.filter((id) => !allNewPlaying.includes(id));
    const editedRound = { ...rd, resting: newResting, courts: newCourts };
    const changedDescParts = originalFour
      .map((oldId, i) => (oldId !== newFour[i] ? `${playerMap[newFour[i]]} gantiin ${playerMap[oldId]}` : null))
      .filter(Boolean);
    if (otherCourtChanges?.length) {
      changedDescParts.push(`(+ ${otherCourtChanges.length} penyesuaian di lapangan lain)`);
    }
    const changedDesc = changedDescParts.join(", ");
    // What we'll check for in the read-back: this exact round's courts now
    // match the intended new lineup, confirming the write we intended to
    // make is genuinely the one sitting in storage.
    const verifyEdit = (saved) => {
      const savedRound = saved?.engine?.roundsData?.[roundIdx];
      if (!savedRound) return false;
      return newCourts.every((c, i) => {
        const sc = savedRound.courts?.[i];
        return sc && JSON.stringify(sc.team1) === JSON.stringify(c.team1) && JSON.stringify(sc.team2) === JSON.stringify(c.team2);
      });
    };

    if (engine?.mexicano) {
      if (engine.mexicanoUnit === "team") return; // Fixed team belum didukung
      const oldAppear = {};
      rd.courts.forEach((c) => [...c.team1, ...c.team2].forEach((id) => (oldAppear[id] = (oldAppear[id] || 0) + 1)));
      const newAppear = {};
      newCourts.forEach((c) => [...c.team1, ...c.team2].forEach((id) => (newAppear[id] = (newAppear[id] || 0) + 1)));
      const newPlayCount = { ...(engine.playCount || {}) };
      new Set([...Object.keys(oldAppear), ...Object.keys(newAppear)]).forEach((id) => {
        const delta = (newAppear[id] || 0) - (oldAppear[id] || 0);
        if (delta !== 0) newPlayCount[id] = (newPlayCount[id] || 0) + delta;
      });

      // Cuma court yg BERUBAH yg perlu disesuaikan pairing-nya -- court lain
      // pairing-nya sama persis, ga perlu diutak-atik.
      const newPartner = {};
      Object.keys(engine.partner || {}).forEach((k) => (newPartner[k] = { ...engine.partner[k] }));
      const newOpp = {};
      Object.keys(engine.opp || {}).forEach((k) => (newOpp[k] = { ...engine.opp[k] }));
      const ensure = (obj, id) => { if (!obj[id]) obj[id] = {}; };

      const changedIdx = [courtIdx, ...(otherCourtChanges?.map((oc) => oc.courtIdx) || [])];
      changedIdx.forEach((cIdx) => {
        const old = rd.courts[cIdx];
        const neu = newCourts[cIdx];
        const [oa, ob] = old.team1, [oc, od] = old.team2;
        [oa, ob, oc, od].forEach((id) => { ensure(newPartner, id); ensure(newOpp, id); });
        newPartner[oa][ob] = (newPartner[oa][ob] || 0) - 1;
        newPartner[ob][oa] = (newPartner[ob][oa] || 0) - 1;
        newPartner[oc][od] = (newPartner[oc][od] || 0) - 1;
        newPartner[od][oc] = (newPartner[od][oc] || 0) - 1;
        [oa, ob].forEach((x) => [oc, od].forEach((y) => {
          newOpp[x][y] = (newOpp[x][y] || 0) - 1;
          newOpp[y][x] = (newOpp[y][x] || 0) - 1;
        }));

        const [na, nb] = neu.team1, [nc, nd] = neu.team2;
        [na, nb, nc, nd].forEach((id) => { ensure(newPartner, id); ensure(newOpp, id); });
        newPartner[na][nb] = (newPartner[na][nb] || 0) + 1;
        newPartner[nb][na] = (newPartner[nb][na] || 0) + 1;
        newPartner[nc][nd] = (newPartner[nc][nd] || 0) + 1;
        newPartner[nd][nc] = (newPartner[nd][nc] || 0) + 1;
        [na, nb].forEach((x) => [nc, nd].forEach((y) => {
          newOpp[x][y] = (newOpp[x][y] || 0) + 1;
          newOpp[y][x] = (newOpp[y][x] || 0) + 1;
        }));
      });

      const newRoundsDataMex = engine.roundsData.map((r, i) => (i === roundIdx ? editedRound : r));
      const newEngineMex = { ...engine, roundsData: newRoundsDataMex, playCount: newPlayCount, partner: newPartner, opp: newOpp };
      setEngine(newEngineMex);
      const savedMex = await persistAndVerify({ engine: newEngineMex }, verifyEdit);
      if (!savedMex) {
        alert(
          "Perubahan pemain kelihatannya BELUM tersimpan ke server (koneksi mungkin bermasalah). Coba lakukan lagi, dan pastikan koneksi internet stabil sebelum pindah layar."
        );
        return;
      }
      logActivity(
        `Edit pemain Ronde ${roundIdx + 1} Match ${courtIdx + 1} (Mexicano): ${changedDesc} — catatan main & partner/lawan disesuaikan buat ronde berikutnya`
      );
      return;
    }

    if (!regenerateRest) {
      const newRoundsData = engine.roundsData.map((r, i) => (i === roundIdx ? editedRound : r));
      const activeIds = players.filter((p) => p.arrived !== false).map((p) => p.id);
      const rebuilt = replayRoundsIntoSeed(newRoundsData, activeIds);
      const newEngine = { ...engine, roundsData: newRoundsData, ...rebuilt };
      setEngine(newEngine);
      // Awaited AND verified on purpose: without this, closing the edit
      // modal and navigating straight back to the Lobby (a very natural
      // next action) could race the in-flight save, or the save could fail
      // silently — reopening the event moments later would then read the
      // old, un-edited data with no indication anything went wrong.
      const saved = await persistAndVerify({ engine: newEngine }, verifyEdit);
      if (!saved) {
        alert(
          "Perubahan pemain kelihatannya BELUM tersimpan ke server (koneksi mungkin bermasalah). Coba lakukan lagi, dan pastikan koneksi internet stabil sebelum pindah layar."
        );
        return;
      }
      logActivity(
        `Edit pemain Ronde ${roundIdx + 1} Lap.${courtIdx + 1}: ${changedDesc} (ronde lain tidak diubah)`
      );
    } else {
      const lockedRounds = [...engine.roundsData.slice(0, roundIdx), editedRound];
      const activePlayers = players.filter((p) => p.arrived !== false);
      const activeIds = activePlayers.map((p) => p.id);
      const seed = replayRoundsIntoSeed(lockedRounds, activeIds);
      seed.debugTrace = (engine.debugTrace || []).slice(0, roundIdx);
      const remainingCount = engine.roundsData.length - (roundIdx + 1);
      const freshPart = generateSchedule(activeIds, courts, remainingCount, seed, roundIdx + 1);
      const newRoundsData = [...lockedRounds, ...freshPart.roundsData];
      const newEngine = {
        roundsData: newRoundsData,
        playCount: freshPart.playCount,
        restCount: freshPart.restCount,
        partner: freshPart.partner,
        opp: freshPart.opp,
        usableCourts: freshPart.usableCourts,
        lastPlayed: freshPart.lastPlayed,
        skipDebt: freshPart.skipDebt,
      consecutivePlays: freshPart.consecutivePlays,
        debugTrace: freshPart.debugTrace,
      };
      const newScores = {};
      Object.keys(scores).forEach((key) => {
        const rIdx = parseInt(key.split("-")[0], 10);
        if (rIdx <= roundIdx) newScores[key] = scores[key];
      });
      setEngine(newEngine);
      setScores(newScores);
      const saved = await persistAndVerify({ engine: newEngine, scores: newScores }, verifyEdit);
      if (!saved) {
        alert(
          "Perubahan pemain kelihatannya BELUM tersimpan ke server (koneksi mungkin bermasalah). Coba lakukan lagi, dan pastikan koneksi internet stabil sebelum pindah layar."
        );
        return;
      }
      logActivity(
        `Edit pemain Ronde ${roundIdx + 1} Lap.${courtIdx + 1}: ${changedDesc} + sesuaikan ronde sisanya`
      );
    }
  };

  // Marks a player as arrived / not-yet-arrived. This does NOT remove them
  // from the roster — they stay listed and can be toggled back — it just
  // reuses the same "adjust schedule" mechanism to keep them out of (or put
  // them back into) upcoming rounds, preserving already-scored history and
  // fairness tracking either way.
  const handleToggleArrival = async (playerId) => {
    const currentPlayers = playersRef.current;
    const target = currentPlayers.find((p) => p.id === playerId);
    if (!target) return;
    const nowArrived = target.arrived === false; // toggling from not-arrived -> arrived
    const newPlayers = currentPlayers.map((p) => (p.id === playerId ? { ...p, arrived: nowArrived } : p));
    logActivity(
      `Toggle kehadiran: ${target.name} jadi ${nowArrived ? "HADIR" : "TIDAK HADIR"} (id tetap sama, histori tidak direset)`
    );
    await handleAdjustSchedule(newPlayers);
  };

  // Host-only: designates who collects the split bill payment (can be the
  // host themselves, or any other player). If that person already saved a
  // default platform/account in their own profile (see Lobby), and this
  // session doesn't have payment info yet, auto-fill it from there.
  const handleSetPaymentPerson = async (playerId) => {
    setPaymentPersonId(playerId);
    let newPaymentInfo = paymentInfo;
    if (playerId && (!paymentInfo || paymentInfo.length === 0)) {
      const player = players.find((p) => p.id === playerId);
      if (player?.accountId) {
        const acc = await getUserAccount(player.accountId);
        if (acc?.paymentInfo && acc.paymentInfo.length > 0) {
          newPaymentInfo = acc.paymentInfo;
          setPaymentInfo(newPaymentInfo);
        }
      }
    }
    persist({ paymentPersonId: playerId, paymentInfo: newPaymentInfo });
  };

  // The designated payment person can edit their own payment details; the
  // host can always edit this too, regardless of who's assigned.
  const handleSavePaymentInfo = (newInfo) => {
    setPaymentInfo(newInfo);
    persist({ paymentInfo: newInfo });
  };

  // Saves MY default platform/account info to my profile (not tied to any
  // one session) — set from the Lobby, used to auto-fill split bill whenever
  // I'm picked as Payment Person later.
  const handleSaveMyPaymentInfo = async (newInfo) => {
    if (!currentUser) return;
    await updateUserPaymentInfo(currentUser.accountId, newInfo);
    setCurrentUser((u) => (u ? { ...u, paymentInfo: newInfo } : u));
  };

  // Records a key action into this session's activity log (capped, newest
  // last) — purely for exporting later so the host can share a full trace
  // of what happened (who clicked what, how many reshuffles, final scores)
  // for debugging/analysis. `dedupe: true` skips adding the entry if the
  // exact same message is already in the log — used for match-completion
  // entries specifically, since those are tied to one real match and should
  // never legitimately appear twice, unlike e.g. "Reshuffle" which a host
  // might trigger many times in a row on purpose with an identical message.
  // This exists as a second line of defense: the primary guard
  // (loggedMatchKeys) lives inside the full session snapshot, which can
  // still end up reverted by a last-write-wins collision if the session is
  // open in more than one tab/device around the same time — this check
  // catches that case directly against the log's own content.
  const logActivity = useCallback(
    (message, options) => {
      const who = currentUser?.displayName || currentUser?.username || "?";
      setActivityLog((prev) => {
        if (options?.dedupe && prev.some((a) => a.message === message)) return prev;
        const next = [...prev, { ts: Date.now(), who, message }].slice(-300);
        // Deliberately NOT going through persist() here. persist() rebuilds
        // the ENTIRE session snapshot from this component's current React
        // closure — and logActivity is very often called after an `await`
        // (e.g. right after a verified player-delete finishes saving). If
        // enough time passed during that await for React to re-render with
        // updated state, the closure this specific logActivity call was
        // bound to is stale: calling persist() here would write back the
        // OLD players/engine/etc. alongside the new activityLog, silently
        // undoing whatever the awaited action just correctly saved. Instead,
        // read the freshest copy directly from storage, patch in just the
        // new activityLog, and write only that back — every other field is
        // left exactly as it currently is on the server.
        if (activeId) {
          (async () => {
            const latest = await loadSessionData(activeId);
            if (!latest) return;
            await saveSessionData(activeId, { ...latest, activityLog: next, updatedAt: Date.now() });
          })();
        }
        return next;
      });
    },
    [activeId, currentUser]
  );

  // Lets the host mark an event as a trial/practice run so its matches don't
  // pollute anyone's career or partner-synergy statistics. Can be flipped at
  // any time (before, during, or long after the event) — nothing is deleted,
  // the matches are just skipped when stats are calculated.
  const handleToggleExcludeFromStats = async (nextExcluded) => {
    setExcludeFromStats(nextExcluded);
    persist({ excludeFromStats: nextExcluded });
    if (activeId) await setEventExcluded(activeId, nextExcluded);
    logActivity(`Set "Hitung ke Statistik" jadi ${nextExcluded ? "TIDAK dihitung" : "dihitung"}`);
  };

  const handleSaveProfileExtras = async (extras) => {
    if (!currentUser) return;
    await updateProfileExtras(currentUser.accountId, extras);
    setCurrentUser((u) => (u ? { ...u, ...extras } : u));
  };

  // Lets host/co-host edit the split bill cost breakdown anytime — while
  // the match is still going, or even after it's already been ended.
  const handleUpdateCosts = (newCourtCost, newAdminFee, newBallCost) => {
    setCourtCost(newCourtCost);
    setAdminFee(newAdminFee);
    setBallCost(newBallCost);
    persist({ courtCost: newCourtCost, adminFee: newAdminFee, ballCost: newBallCost });
  };

  // Host/co-host-only checklist marking who's already paid their split bill
  // share — default everyone is unpaid until manually checked off.
  const handleTogglePaid = (playerId) => {
    const newPaidStatus = { ...paidStatus, [playerId]: !paidStatus[playerId] };
    setPaidStatus(newPaidStatus);
    persist({ paidStatus: newPaidStatus });
  };

  const handleApproveRequest = (reqId) => {
    const req = pendingRequests.find((r) => r.id === reqId);
    if (!req) return;
    const newPending = pendingRequests.filter((r) => r.id !== reqId);
    // Same safety check already used in handleRespondInvitation and
    // handleJoinViaLink: if this person is somehow already in the roster
    // (e.g. they accepted a direct invitation separately, or opened the
    // share link more than once before this request got cleared), don't
    // add them a second time — just clear the now-redundant request.
    const alreadyPlayer = req.accountId && players.some((p) => p.accountId === req.accountId);
    // Deliberately matches by accountId ONLY, not by name — see the same
    // reasoning in handleRespondInvitation. Auto-merging by name risks
    // attaching a real account to a DIFFERENT person's guest entry just
    // because they happen to share a name; if that's genuinely the same
    // person, the host can merge them manually via Kelola Pertandingan.
    const newPlayers = alreadyPlayer
      ? players
      : [...players, { id: req.id, name: req.name, accountId: req.accountId }];
    // They're in the roster now, so any invitation still waiting on them is
    // obsolete — clear it rather than leaving it pending forever.
    const newInvitations = req.accountId
      ? hostInvitations.filter((i) => i.accountId !== req.accountId)
      : hostInvitations;
    setPlayers(newPlayers);
    if (!alreadyPlayer) setPlayerMap((prev) => ({ ...prev, [req.id]: req.name }));
    setPendingRequests(newPending);
    setHostInvitations(newInvitations);
    persist({
      players: newPlayers,
      ...(alreadyPlayer ? {} : { playerMap: { ...playerMap, [req.id]: req.name } }),
      pendingRequests: newPending,
      hostInvitations: newInvitations,
    });
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
    setEndTime("21:00");
    setScoreFormat("points");
    setSportType("padel");
    setGameFormat("americano");
    setFixedPairs([]);
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
    setPaymentPersonId(null);
    setPaymentInfo([]);
    setPaidStatus({});
    setLoggedMatchKeys([]);
    setPlayDate("");
    setExcludeFromStats(false);
    setActivityLog([]);
    setCourtStages([]);
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
    setEndTime(data.endTime || "21:00");
    setScoreFormat(data.scoreFormat || "points");
    setSportType(data.sportType || "padel");
    {
      const { gameFormat: gf, teamFormat: tf } = resolveGameAndTeamFormat(data);
      setGameFormat(gf);
      setTeamFormat(tf);
    }
    setFixedPairs(data.fixedPairs || []);
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
    setPaymentPersonId(data.paymentPersonId ?? null);
    setPaymentInfo(data.paymentInfo || []);
    setPaidStatus(data.paidStatus || {});
    setLoggedMatchKeys(data.loggedMatchKeys || []);
    setPlayDate(data.playDate || "");
    setExcludeFromStats(!!data.excludeFromStats);
    setActivityLog(data.activityLog || []);
    setCourtStages(data.courtStages || []);
    setOwnerId(data.ownerId || null);
    setOwnerUsername(data.ownerUsername || "");
    setEnded(!!data.ended);
    setEngine(data.engine || null);
    setPlayerMap(data.playerMap || {});
    setScores(data.scores || {});
    setCurrentRound(
      data.engine && !data.ended
        ? findFirstUnscoredRound(data.engine, data.scores || {})
        : data.currentRound || 0
    );
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
    setPublicEvents(filtered.sort((a, b) => sortDateValue(b) - sortDateValue(a)));
    setScreen("discover");
  };

  const handleBackToLobby = async () => {
    setScreen("lobby");
    if (!currentUser) return;
    await refreshLobbyFor(currentUser.accountId);
  };

  const handleDeleteSession = async (id) => {
    if (!window.confirm("Hapus acara ini dari daftar kamu? (Log & data tetap tersimpan untuk keperluan audit admin)")) return;
    // Session data (schedule/scores/activity log) is intentionally NOT
    // erased here — only removed from the deleter's own lobby and from
    // public discovery, so alfinyr can still open/download it via "All
    // Match" for evaluation even after a host deletes their event.
    await removePublicEventEntry(id);
    await markSessionDataDeleted(id);
    await markDeletedInAllMatchesRegistry(id);
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
    logActivity("Acara diakhiri (Selesaikan Acara)");
    const totalCost = (Number(courtCost) || 0) + (Number(adminFee) || 0) + (Number(ballCost) || 0);
    setScreen(totalCost > 0 ? "splitbill" : "leaderboard");
  };

  const goRound = (delta) => {
    if (!engine) return;
    const next = Math.min(Math.max(0, currentRound + delta), engine.roundsData.length - 1);
    setCurrentRound(next);
  };

  const goToRound = (idx) => {
    if (!engine) return;
    const next = Math.min(Math.max(0, idx), engine.roundsData.length - 1);
    setCurrentRound(next);
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
    () =>
      teamFormat === "fixed"
        ? buildTeamLeaderboard(engine, playerMap, scores, fixedPairs)
        : buildLeaderboard(
            engine,
            playerMap,
            scores,
            players.map((p) => p.id) // genuinely-removed only, NOT filtered by arrived — an attendance toggle shouldn't relabel someone as "Pemain Dihapus"
          ),
    [engine, playerMap, scores, players, gameFormat, fixedPairs]
  );

  const fairnessStats = React.useMemo(() => {
    if (!engine) return [];
    if (teamFormat === "fixed") {
      return buildTeamFairnessStats(engine, playerMap, scores, fixedPairs, currentRound);
    }
    const idToAccountId = {};
    players.forEach((p) => {
      idToAccountId[p.id] = p.accountId || null;
    });
    const currentRosterIds = new Set(players.map((p) => p.id)); // still on the roster (arrived or not — only a genuine delete removes someone from this)
    const playedSoFar = {};
    const wins = {};
    const losses = {};
    const partnersOf = {}; // id -> { otherId: { total, played } }
    const oppsOf = {}; // id -> { otherId: { total, played } }
    currentRosterIds.forEach((id) => {
      partnersOf[id] = {};
      oppsOf[id] = {};
    });
    engine.roundsData.forEach((rd, rIdx) => {
      const isScored = rd.courts.every((_, cIdx) => isMatchScoreComplete(scores[`${rIdx}-${cIdx}`]));
      if (isScored) {
        const playingIds = new Set(rd.courts.flatMap((c) => [...c.team1, ...c.team2]));
        Object.keys(playerMap).forEach((id) => {
          if (playingIds.has(id)) playedSoFar[id] = (playedSoFar[id] || 0) + 1;
        });
      }
      rd.courts.forEach((match, cIdx) => {
        const matchScored = isMatchScoreComplete(scores[`${rIdx}-${cIdx}`]);
        [match.team1, match.team2].forEach((team, tIdx) => {
          const other = tIdx === 0 ? match.team2 : match.team1;
          team.forEach((id) => {
            if (!partnersOf[id]) return; // no longer on the roster — no card to update
            const partnerId = team.find((x) => x !== id);
            // Someone still on the roster counts regardless of whether this
            // round has been played yet (it's a real, scheduled pairing —
            // "total" reflects the whole schedule, "played" only what's
            // actually happened so far). Someone no longer on the roster
            // only counts at all if the match genuinely happened — an
            // unplayed pairing with someone who got removed before it was
            // ever played isn't a real encounter.
            if (currentRosterIds.has(partnerId) || matchScored) {
              if (!partnersOf[id][partnerId]) partnersOf[id][partnerId] = { total: 0, played: 0 };
              partnersOf[id][partnerId].total += 1;
              if (matchScored) partnersOf[id][partnerId].played += 1;
            }
            other.forEach((oppId) => {
              if (currentRosterIds.has(oppId) || matchScored) {
                if (!oppsOf[id][oppId]) oppsOf[id][oppId] = { total: 0, played: 0 };
                oppsOf[id][oppId].total += 1;
                if (matchScored) oppsOf[id][oppId].played += 1;
              }
            });
          });
        });
        const s = scores[`${rIdx}-${cIdx}`];
        const ab = matchAB(s);
        if (!ab || !Number.isFinite(ab.a) || !Number.isFinite(ab.b) || ab.a === ab.b) return;
        const winningTeam = ab.a > ab.b ? match.team1 : match.team2;
        const losingTeam = ab.a > ab.b ? match.team2 : match.team1;
        winningTeam.forEach((id) => {
          wins[id] = (wins[id] || 0) + 1;
        });
        losingTeam.forEach((id) => {
          losses[id] = (losses[id] || 0) + 1;
        });
      });
    });
    const ids = players.map((p) => p.id); // same fix as leaderboard — attendance toggle shouldn't hide someone from stats
    return ids
      .map((id) => {
        const partnerEntries = Object.entries(partnersOf[id] || {});
        const oppEntries = Object.entries(oppsOf[id] || {});
        const partners = partnerEntries.length;
        const opps = oppEntries.length;
        const accId = idToAccountId[id];
        const role = accId && accId === ownerId ? "host" : accId && coHostIds.includes(accId) ? "cohost" : null;
        return {
          id,
          name: playerMap[id],
          matches: engine.playCount[id] || 0,
          playedSoFar: playedSoFar[id] || 0,
          rests: engine.restCount[id] || 0,
          wins: wins[id] || 0,
          losses: losses[id] || 0,
          partners,
          opps,
          // Detailed name+count breakdown, sorted by most total-scheduled
          // first — shows "played/total" (e.g. "Ihsan 2/4": already
          // partnered 2 times out of 4 times scheduled across the whole
          // event, including rounds not yet played).
          partnerDetail: partnerEntries
            .map(([pid, c]) => ({ name: playerMap[pid] || pid, played: c.played, total: c.total }))
            .sort((a, b) => b.total - a.total || a.name.localeCompare(b.name)),
          oppDetail: oppEntries
            .map(([oid, c]) => ({ name: playerMap[oid] || oid, played: c.played, total: c.total }))
            .sort((a, b) => b.total - a.total || a.name.localeCompare(b.name)),
          role,
        };
      })
      .sort((a, b) => b.matches - a.matches);
  }, [engine, playerMap, scores, players, ownerId, coHostIds, currentRound, gameFormat, fixedPairs]);

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
        text += `  Lap.${cIdx + 1}: ${mt.team1.map((id) => playerMap[id]).join(" - ")} vs ${mt.team2
          .map((id) => playerMap[id])
          .join(" - ")}\n`;
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
  const allMatchesScored =
    !!engine &&
    engine.roundsData.every((rd, rIdx) =>
      rd.courts.every((_, cIdx) => {
        const s = scores[`${rIdx}-${cIdx}`];
        if (!s) return false;
        if (s.format === "tennis") return (s.gamesA || 0) > 0 || (s.gamesB || 0) > 0;
        return s.a !== undefined && s.a !== "" && s.b !== undefined && s.b !== "";
      })
    );

  return (
    <div
      className="min-h-screen bg-slate-950 text-slate-100"
      style={{ fontFamily: "'Inter', ui-sans-serif, system-ui" }}
    >
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Teko:wght@500;600;700&family=Inter:wght@400;500;600;700;800&family=Space+Mono:wght@400;700&display=swap');
        .font-display { font-family: 'Teko', sans-serif; }
        .font-mono2 { font-family: 'Space Mono', monospace; }

        /* Scrollbars hidden everywhere by default (still scrollable, just
           no visible track/thumb — the visible bar felt intrusive) —
           except the Edit Pemain replacement-player list below, which
           specifically needs a visible scrollbar since it's the one place
           people are likely to miss that there's more to scroll through. */
        * {
          scrollbar-width: none; /* Firefox */
        }
        *::-webkit-scrollbar {
          display: none; /* Chrome/Safari/Edge */
        }
        .edit-pemain-scroll {
          scrollbar-width: thin; /* Firefox */
          scrollbar-color: rgba(255, 255, 255, 0.35) transparent;
        }
        .edit-pemain-scroll::-webkit-scrollbar {
          display: block;
          width: 8px;
          height: 8px;
        }
        .edit-pemain-scroll::-webkit-scrollbar-track {
          background: transparent;
        }
        .edit-pemain-scroll::-webkit-scrollbar-thumb {
          background-color: rgba(255, 255, 255, 0.35);
          border-radius: 9999px;
        }
        .edit-pemain-scroll::-webkit-scrollbar-thumb:hover {
          background-color: rgba(255, 255, 255, 0.55);
        }
      `}</style>

      <div className="max-w-md mx-auto relative">
      {joinConfirmPreview && (
        <JoinConfirmModal
          eventData={joinConfirmPreview.data}
          onConfirm={async () => {
            const { id, me } = joinConfirmPreview;
            setJoinConfirmPreview(null);
            await handleJoinViaLink(id, me);
            clearJoinParam();
          }}
          onCancel={() => {
            setJoinConfirmPreview(null);
            clearJoinParam();
            setScreen("lobby");
          }}
        />
      )}
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
          onChangeDisplayName={handleChangeDisplayName}
          onSaveProfileExtras={handleSaveProfileExtras}
          onOpenFriends={handleOpenFriends}
          friendRequestCount={friendRequests.length}
          onRespondInvitation={handleRespondInvitation}
          onOpenMyPayment={() => setScreen("my-payment")}
          onOpenPartnerSynergy={() => setScreen("partner-synergy")}
          onOpenAllMatches={() => setScreen("all-matches")}
          currentUser={currentUser}
          onLogout={handleLogout}
        />
      )}

      {screen === "my-payment" && (
        <MyPaymentScreen
          currentUser={currentUser}
          onSave={handleSaveMyPaymentInfo}
          onBackToLobby={handleBackToLobby}
        />
      )}

      {screen === "partner-synergy" && (
        <PartnerSynergyScreen
          currentUser={currentUser}
          onOpenPartner={(partner) => {
            setSelectedPartner(partner);
            setScreen("partner-detail");
          }}
          onBackToLobby={handleBackToLobby}
        />
      )}

      {screen === "partner-detail" && selectedPartner && (
        <PartnerDetailScreen
          currentUser={currentUser}
          partner={selectedPartner}
          onBack={() => setScreen("partner-synergy")}
          onBackToLobby={handleBackToLobby}
        />
      )}

      {screen === "all-matches" && currentUser?.accountId === "alfinyr" && (
        <AllMatchesScreen onBackToLobby={handleBackToLobby} />
      )}

      {screen === "friends" && (
        <FriendsScreen
          friends={friends}
          friendRequests={friendRequests}
          onRespond={handleRespondFriendRequest}
          onBrowse={async () => {
            setScreen("browse-friends");
          }}
          onOpenFriend={(f) => {
            setSelectedFriend(f);
            setScreen("friend-profile");
          }}
          onBackToLobby={handleBackToLobby}
        />
      )}

      {screen === "friend-profile" && selectedFriend && (
        <FriendProfileScreen
          friend={selectedFriend}
          currentUser={currentUser}
          onBack={() => setScreen("friends")}
        />
      )}

      {screen === "browse-friends" && (
        <BrowseFriendsScreen
          currentUser={currentUser}
          onSendRequest={handleSendFriendRequest}
          onBack={() => setScreen("friends")}
          onOpenProfile={
            currentUser?.accountId === "alfinyr"
              ? (acc) => {
                  setSelectedFriend(acc);
                  setScreen("friend-profile");
                }
              : undefined
          }
        />
      )}

      {screen === "discover" && (
        <PublicEventsScreen
          events={publicEvents}
          onJoinRequest={(id) => prepareJoinConfirmation(id, currentUser)}
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
          endTime={endTime}
          setEndTime={setEndTime}
          scoreFormat={scoreFormat}
          setScoreFormat={setScoreFormat}
          sportType={sportType}
          setSportType={setSportType}
          gameFormat={gameFormat}
          teamFormat={teamFormat}
          setGameFormat={setGameFormat}
          setTeamFormat={setTeamFormat}
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
          playDate={playDate}
          setPlayDate={setPlayDate}
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
          courtStages={courtStages}
          setCourtStages={setCourtStages}
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
          playDate={playDate}
          setPlayDate={setPlayDate}
          onSavePlayDate={(newDate) => persist({ playDate: newDate })}
          excludeFromStats={excludeFromStats}
          onToggleExcludeFromStats={handleToggleExcludeFromStats}
          gameFormat={gameFormat}
          teamFormat={teamFormat}
          fixedPairs={fixedPairs}
          setFixedPairs={setFixedPairs}
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
          onReshuffle={handleReshuffleMatches}
          allMatchesScored={allMatchesScored}
          players={players}
          onAddManualMatch={handleAddManualMatch}
          onAddAutoRound={handleAddAutoRound}
          onDeleteRound={handleDeleteRound}
          friends={friends}
          onAdjustSchedule={handleAdjustSchedule}
          onEditMatchPlayers={handleEditMatchPlayers}
          onToggleArrival={handleToggleArrival}
          courts={courts}
          gameFormat={gameFormat}
          teamFormat={teamFormat}
          fixedPairs={fixedPairs}
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
          players={players}
          gameFormat={gameFormat}
          teamFormat={teamFormat}
          fixedPairs={fixedPairs}
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
          isOwner={sessionRole === "owner"}
          canManage={canManage}
          onUpdateCosts={handleUpdateCosts}
          paidStatus={paidStatus}
          onTogglePaid={handleTogglePaid}
          currentAccountId={currentUser?.accountId}
          paymentPersonId={paymentPersonId}
          onSetPaymentPerson={handleSetPaymentPerson}
          paymentInfo={paymentInfo}
          onSavePaymentInfo={handleSavePaymentInfo}
          onNav={setScreen}
          onBackToLobby={handleBackToLobby}
        />
      )}

      {screen === "recap" && engine && (
        <RecapScreen
          eventName={eventName}
          activeId={activeId}
          playDate={playDate}
          courts={courts}
          mode={mode}
          engine={engine}
          playerMap={playerMap}
          scores={scores}
          scoreFormat={scoreFormat}
          pointTarget={pointTarget}
          tennisTarget={tennisTarget}
          activityLog={activityLog}
          players={players}
          gameFormat={gameFormat}
          teamFormat={teamFormat}
          fixedPairs={fixedPairs}
          ended={ended}
          hasSplitBill={hasSplitBill}
          canManage={canManage}
          isOwner={sessionRole === "owner"}
          currentUser={currentUser}
          excludeFromStats={excludeFromStats}
          onToggleExcludeFromStats={handleToggleExcludeFromStats}
          onNav={setScreen}
          onBackToLobby={handleBackToLobby}
        />
      )}

      {screen === "stats" && engine && (
        <StatsScreen
          eventName={eventName}
          stats={fairnessStats}
          totalPlayers={players.length}
          gameFormat={gameFormat}
          teamFormat={teamFormat}
          hasSplitBill={hasSplitBill}
          canManage={canManage}
          isOwner={sessionRole === "owner"}
          excludeFromStats={excludeFromStats}
          onToggleExcludeFromStats={handleToggleExcludeFromStats}
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
  const activeIdx = Math.max(0, items.findIndex((i) => i.key === active));
  const pct = 100 / items.length;

  return (
    <div className="fixed bottom-0 left-0 right-0 bg-slate-950/95 backdrop-blur border-t border-slate-800 z-20 max-w-md mx-auto px-3">
      <div className="relative bg-slate-900 rounded-full p-1 flex">
        {/* Sliding highlight — animates left/width to the active tab */}
        <div
          className="absolute top-1 bottom-1 bg-lime-300 rounded-full transition-all duration-300 ease-out"
          style={{ left: `${activeIdx * pct}%`, width: `${pct}%` }}
        />
        {items.map(({ key, label, icon: Icon }) => (
          <button
            key={key}
            onClick={() => onNav(key)}
            className={`relative z-10 flex-1 py-2 flex flex-col items-center gap-1 transition-colors duration-300 ${
              active === key ? "text-slate-950" : "text-slate-500"
            }`}
          >
            <Icon size={20} strokeWidth={active === key ? 2.5 : 2} />
            <span className="text-[11px] font-semibold">{label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// LOBBY SCREEN
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// LOBBY SCORECARD — profile + career stats, replaces the old small avatar row
// ---------------------------------------------------------------------------

// Row 1 style — icon centered top, number centered, label centered bottom.
function ScoreStatCentered({ icon: Icon, iconColor, iconBg, value, label, tall }) {
  return (
    <div
      className={`rounded-xl md:rounded-2xl border border-white/[0.06] px-1 py-2 md:px-4 flex flex-col items-center text-center transition-all duration-200 hover:-translate-y-0.5 hover:shadow-lg hover:shadow-black/30 ${
        tall ? "justify-center h-full min-h-[74px] md:min-h-[104px] md:py-5" : "md:py-4"
      }`}
      style={{ backgroundColor: "#131A2B" }}
    >
      <div
        className="w-6 h-6 md:w-9 md:h-9 rounded-full flex items-center justify-center mb-1 md:mb-2"
        style={{ backgroundColor: iconBg }}
      >
        <Icon size={12} className="md:hidden" style={{ color: iconColor }} />
        <Icon size={16} className="hidden md:block" style={{ color: iconColor }} />
      </div>
      <div className="font-sans font-extrabold text-[13px] md:text-[26px] leading-none text-white truncate max-w-full">
        {value}
      </div>
      <div className="text-[6.5px] md:text-[11px] text-slate-400 mt-1 md:mt-1.5 leading-tight text-center">
        {label}
      </div>
    </div>
  );
}

function LobbyScoreCard({ currentUser, onChangeAvatar, onChangeDisplayName, onSaveProfileExtras, readOnly = false }) {
  const [uploadingAvatar, setUploadingAvatar] = useState(false);
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  const [editingLocation, setEditingLocation] = useState(false);
  const [locationDraft, setLocationDraft] = useState("");
  const [editingCaption, setEditingCaption] = useState(false);
  const [captionDraft, setCaptionDraft] = useState("");
  const [stats, setStats] = useState(null);
  const [showZoomedPhoto, setShowZoomedPhoto] = useState(false);
  const fileInputRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!currentUser?.accountId) return;
      const log = await loadCountedMatchLog(currentUser.accountId);
      if (cancelled) return;
      setStats(computeOverallProfileStats(log));
    })();
    return () => {
      cancelled = true;
    };
  }, [currentUser?.accountId]);

  const handleAvatarFile = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setUploadingAvatar(true);
    await onChangeAvatar(file);
    setUploadingAvatar(false);
  };

  const startEditingName = () => {
    setNameDraft(currentUser?.displayName || currentUser?.username || "");
    setEditingName(true);
  };
  const saveName = async () => {
    await onChangeDisplayName(nameDraft);
    setEditingName(false);
  };

  const startEditingLocation = () => {
    setLocationDraft(currentUser?.location || "");
    setEditingLocation(true);
  };
  const saveLocation = async () => {
    await onSaveProfileExtras({ location: locationDraft });
    setEditingLocation(false);
  };

  const startEditingCaption = () => {
    setCaptionDraft(currentUser?.caption || "");
    setEditingCaption(true);
  };
  const saveCaption = async () => {
    await onSaveProfileExtras({ caption: captionDraft });
    setEditingCaption(false);
  };

  const ACCENT = "#B8F34A";
  const name = currentUser.displayName || currentUser.username;
  const initial = name?.[0]?.toUpperCase() || "?";

  return (
    <div
      className="rounded-[24px] border border-white/[0.06] shadow-lg shadow-black/20 overflow-hidden flex flex-col"
      style={{ backgroundColor: "#131A2B" }}
    >
      <div className="flex flex-row">
      {/* LEFT: hero photo + profile (~35%) */}
      <div className="w-[34%] md:w-[35%] p-2.5 md:p-5 flex flex-col shrink-0">
        <div
          className="relative w-full rounded-[20px] overflow-hidden shrink-0"
          style={{ aspectRatio: "1 / 1", border: `2px solid ${ACCENT}66` }}
        >
          {currentUser.avatarUrl ? (
            <img
              src={currentUser.avatarUrl}
              alt={name}
              onClick={() => setShowZoomedPhoto(true)}
              className="absolute inset-0 w-full h-full object-cover cursor-zoom-in"
            />
          ) : (
            <div
              className="absolute inset-0 w-full h-full flex items-center justify-center"
              style={{ background: "linear-gradient(160deg, #1c2740, #0f1626)" }}
            >
              <span className="font-sans font-extrabold text-6xl text-white/20">{initial}</span>
            </div>
          )}
          {!readOnly && (
            <button
              onClick={() => fileInputRef.current?.click()}
              className="absolute bottom-2.5 right-2.5 w-8 h-8 rounded-full flex items-center justify-center shadow-lg"
              style={{ backgroundColor: ACCENT }}
            >
              {uploadingAvatar ? (
                <RotateCcw size={13} className="text-slate-950 animate-spin" />
              ) : (
                <Camera size={13} className="text-slate-950" strokeWidth={2.5} />
              )}
            </button>
          )}
        </div>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          onChange={handleAvatarFile}
          className="hidden"
        />

        <div className="mt-4">
          {editingName && !readOnly ? (
            <div className="flex items-center gap-1.5">
              <input
                autoFocus
                value={nameDraft}
                onChange={(e) => setNameDraft(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && saveName()}
                placeholder={currentUser.username}
                className="flex-1 min-w-0 bg-black/30 border border-white/10 rounded-lg px-2.5 py-1.5 text-base text-white focus:outline-none focus:ring-2 focus:ring-lime-400/50"
              />
              <button
                onClick={saveName}
                className="w-7 h-7 rounded-lg text-slate-950 flex items-center justify-center shrink-0"
                style={{ backgroundColor: ACCENT }}
              >
                <Check size={13} strokeWidth={3} />
              </button>
              <button
                onClick={() => setEditingName(false)}
                className="w-7 h-7 rounded-lg bg-white/5 border border-white/10 text-slate-400 flex items-center justify-center shrink-0"
              >
                <X size={13} />
              </button>
            </div>
          ) : (
            <button onClick={() => !readOnly && startEditingName()} className="flex items-center gap-1 min-w-0 max-w-full">
              <span className="font-sans font-bold text-[13px] md:text-[36px] leading-[1.15] text-white truncate">
                {name}
              </span>
              {!readOnly && <Pencil size={8} className="text-slate-500 shrink-0 md:hidden" />}
              {!readOnly && <Pencil size={13} className="text-slate-500 shrink-0 hidden md:block" />}
            </button>
          )}

          <div className="w-5 md:w-8 h-[2px] md:h-[3px] rounded-full mt-1.5 md:mt-2 mb-1.5 md:mb-3" style={{ backgroundColor: ACCENT }} />

          <div className="flex items-center gap-1 md:gap-2 text-[8.5px] md:text-[13px] text-slate-400 mb-1 md:mb-1.5">
            <CalendarDays size={9} className="shrink-0 md:hidden" style={{ color: ACCENT }} />
            <CalendarDays size={13} className="shrink-0 hidden md:block" style={{ color: ACCENT }} />
            <span className="truncate">
              {currentUser.createdAt
                ? new Date(currentUser.createdAt).toLocaleDateString("id-ID", {
                    day: "numeric",
                    month: "short",
                    year: "numeric",
                  })
                : "—"}
            </span>
          </div>

          {editingLocation && !readOnly ? (
            <div className="flex items-center gap-1.5 mt-1">
              <input
                autoFocus
                value={locationDraft}
                onChange={(e) => setLocationDraft(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && saveLocation()}
                placeholder="mis. Jakarta Selatan"
                className="flex-1 min-w-0 bg-black/30 border border-white/10 rounded-lg px-2.5 py-1 text-[13px] text-white focus:outline-none focus:ring-2 focus:ring-lime-400/50"
              />
              <button
                onClick={saveLocation}
                className="w-6 h-6 rounded-lg text-slate-950 flex items-center justify-center shrink-0"
                style={{ backgroundColor: ACCENT }}
              >
                <Check size={11} strokeWidth={3} />
              </button>
            </div>
          ) : (
            <button onClick={() => !readOnly && startEditingLocation()} className="flex items-center gap-1 md:gap-2 text-[8.5px] md:text-[13px] text-slate-400 min-w-0 max-w-full">
              <MapPin size={9} className="shrink-0 md:hidden" style={{ color: ACCENT }} />
              <MapPin size={13} className="shrink-0 hidden md:block" style={{ color: ACCENT }} />
              <span className="truncate">{currentUser.location || "+ lokasi"}</span>
              {!readOnly && <Pencil size={8} className="text-slate-500 shrink-0 md:hidden" />}
              {!readOnly && <Pencil size={12} className="text-slate-500 shrink-0 hidden md:block" />}
            </button>
          )}
        </div>
      </div>

      {/* RIGHT: stats (~65%) */}
      <div className="flex-1 min-w-0 p-2.5 md:p-6 border-l border-white/[0.06]">
        <div className="flex items-center justify-between gap-1.5 mb-1">
          <span className="font-sans font-bold text-[11px] md:text-[22px] text-white flex items-center gap-1 md:gap-2 min-w-0">
            <BarChart3 size={12} style={{ color: ACCENT }} className="shrink-0 md:hidden" />
            <BarChart3 size={18} style={{ color: ACCENT }} className="shrink-0 hidden md:block" />
            <span className="truncate tracking-wide">RINGKASAN STATISTIK</span>
          </span>
          {stats?.lastUpdated && (
            <span className="flex items-center gap-1 md:gap-1.5 text-[7.5px] md:text-[11px] text-slate-400 border border-white/10 rounded-full px-1.5 md:px-2.5 py-0.5 md:py-1 shrink-0 whitespace-nowrap">
              <CalendarDays size={8} className="md:hidden" />
              <CalendarDays size={11} className="hidden md:block" />
              {new Date(stats.lastUpdated).toLocaleDateString("id-ID", {
                day: "numeric",
                month: "short",
                year: "numeric",
              })}
            </span>
          )}
        </div>
        <p className="text-[13px] text-slate-500 mb-4 hidden md:block">Performa terbaik datang dari konsistensi.</p>
        <div className="md:hidden mb-2" />

        {!stats ? (
          <p className="text-slate-500 text-[13px] py-2">
            Belum ada data — otomatis keisi begitu kamu main dan skornya selesai diisi.
          </p>
        ) : (
          <>
            <div className="grid grid-cols-4 gap-1.5 md:gap-3">
              <ScoreStatCentered
                icon={Swords}
                iconColor="#8CE85C"
                iconBg="#8CE85C22"
                value={stats.matches}
                label="Match Dimainkan"
              />
              <ScoreStatCentered
                icon={TrendingUp}
                iconColor="#5EA8FF"
                iconBg="#5EA8FF22"
                value={`${Math.round(stats.winRate)}%`}
                label="Win Rate"
              />
              <ScoreStatCentered
                icon={Flame}
                iconColor="#FFB347"
                iconBg="#FFB34722"
                value={stats.totalPointsWon}
                label="Total Poin Menang"
              />
              <ScoreStatCentered
                icon={Award}
                iconColor="#E8C547"
                iconBg="#E8C54722"
                value={stats.eventsCount}
                label="Acara Diikuti"
              />
            </div>

            <div className="grid grid-cols-4 gap-1.5 md:gap-3 mt-1.5 md:mt-3">
              <ScoreStatCentered
                tall
                icon={Trophy}
                iconColor="#8CE85C"
                iconBg="#8CE85C22"
                value={stats.wins}
                label="Match Menang"
              />
              <ScoreStatCentered
                tall
                icon={X}
                iconColor="#FF6B6B"
                iconBg="#FF6B6B22"
                value={stats.losses}
                label="Match Kalah"
              />
              <ScoreStatCentered
                tall
                icon={Zap}
                iconColor="#8CE85C"
                iconBg="#8CE85C22"
                value={stats.bestStreak}
                label="Winstreak"
              />
              <ScoreStatCentered
                tall
                icon={Star}
                iconColor="#B794F6"
                iconBg="#B794F622"
                value={stats.avgPointsPerMatch.toFixed(1)}
                label="Avg Poin"
              />
            </div>
          </>
        )}
      </div>
      </div>

      {/* Caption — full width below both columns, always visible */}
      <div className="mt-1 px-3 pb-3 md:mt-0 md:px-6 md:pb-6 md:pt-0">
        <div className="pt-2.5 md:pt-3 border-t border-white/[0.06]">
          {editingCaption && !readOnly ? (
            <div className="flex items-center gap-1.5">
              <input
                autoFocus
                value={captionDraft}
                onChange={(e) => setCaptionDraft(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && saveCaption()}
                placeholder="Terus bermain, terus berkembang."
                maxLength={80}
                className="flex-1 min-w-0 bg-black/30 border border-white/10 rounded-lg px-2.5 py-1.5 text-xs italic text-slate-200 focus:outline-none focus:ring-2 focus:ring-lime-400/50"
              />
              <button
                onClick={saveCaption}
                className="w-7 h-7 rounded-lg text-slate-950 flex items-center justify-center shrink-0"
                style={{ backgroundColor: ACCENT }}
              >
                <Check size={13} strokeWidth={3} />
              </button>
            </div>
          ) : (
            <button onClick={() => !readOnly && startEditingCaption()} className="flex items-center gap-1.5 min-w-0 w-full">
              <span className="text-xs italic text-slate-400 truncate flex-1 text-left">
                "{currentUser.caption || "Terus bermain, terus berkembang."}"
              </span>
              {!readOnly && <Pencil size={10} className="text-slate-500 shrink-0" />}
            </button>
          )}
        </div>
      </div>

      {showZoomedPhoto && currentUser.avatarUrl && (
        <div
          onClick={() => setShowZoomedPhoto(false)}
          className="fixed inset-0 z-50 bg-black/90 flex items-center justify-center p-6"
        >
          <button
            onClick={() => setShowZoomedPhoto(false)}
            className="absolute top-6 right-6 w-9 h-9 rounded-full bg-white/10 flex items-center justify-center text-white"
          >
            <X size={18} />
          </button>
          <img
            src={currentUser.avatarUrl}
            alt={name}
            className="max-w-full max-h-full rounded-2xl object-contain"
            onClick={(e) => e.stopPropagation()}
          />
        </div>
      )}
    </div>
  );
}

function LobbyScreen({ lobby, onCreateNew, onOpen, onDelete, onLeave, onDiscover, onRefresh, onChangeAvatar, onChangeDisplayName, onSaveProfileExtras, onOpenFriends, friendRequestCount, onRespondInvitation, onOpenMyPayment, onOpenPartnerSynergy, onOpenAllMatches, currentUser, onLogout }) {
  const [accountCount, setAccountCount] = useState(null);
  const [refreshing, setRefreshing] = useState(false);

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

  return (
    <div className="pb-10">
      <div className="px-6 pt-14 pb-8 border-b border-slate-800 relative overflow-hidden">
        <div className="absolute -right-10 -top-10 w-40 h-40 rounded-full bg-lime-400/10 blur-2xl pointer-events-none" />
        <div className="flex items-center gap-2 mb-4">
          <img src="/icon-192.png" alt="APlay" className="w-8 h-8 rounded-lg shrink-0" />
          <span className="font-display text-2xl text-slate-50 tracking-wide">APlay</span>
        </div>
        <div className="flex items-center gap-2 mb-4">
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
        <h1 className="font-display leading-[0.95] text-slate-50 tracking-wide">
          <span style={{ fontSize: "48px" }} className="block">
            COURT LOBBY
          </span>
          <span style={{ fontSize: "26px" }} className="block text-lime-300">
            READY FOR THE MATCH
          </span>
        </h1>
      </div>

      <div className="px-6 pt-6">
        {currentUser && (
          <LobbyScoreCard
            currentUser={currentUser}
            onChangeAvatar={onChangeAvatar}
            onChangeDisplayName={onChangeDisplayName}
            onSaveProfileExtras={onSaveProfileExtras}
          />
        )}

        <p className="text-slate-400 text-sm mt-5 max-w-xs">
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

      <div className="px-6 pt-3">
        <GhostButton onClick={onOpenMyPayment} icon={Wallet} className="w-full">
          Info Pembayaran Saya
        </GhostButton>
      </div>

      <div className="px-6 pt-3">
        <GhostButton onClick={onOpenPartnerSynergy} icon={Handshake} className="w-full">
          Partner Synergy Index
        </GhostButton>
      </div>

      {currentUser?.accountId === "alfinyr" && (
        <div className="px-6 pt-3">
          <GhostButton onClick={onOpenAllMatches} icon={ListOrdered} className="w-full">
            All Match
          </GhostButton>
        </div>
      )}

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
            const hostLabel =
              ev.ownerUsername ||
              (isOwnerEntry ? currentUser?.displayName || currentUser?.username : "");
            const isInvited = ev.role === "invited";

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
                    {formatEventEntryDate(ev) && (
                      <div className="text-[11px] text-slate-500 mt-0.5">
                        {formatEventEntryDate(ev)}
                      </div>
                    )}
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
                        {hostLabel && ` · host: ${hostLabel}`}
                      </div>
                      {formatEventEntryDate(ev) && (
                        <div className="text-[11px] text-slate-500 mt-0.5">
                          {formatEventEntryDate(ev)}
                        </div>
                      )}
                    </div>
                    <div className="flex flex-col items-center gap-1.5 shrink-0 pt-0.5">
                      {ev.sportType === "tenis" ? (
                        <TennisRacketIcon size={44} className="text-lime-300" />
                      ) : (
                        <PadelRacketIcon size={44} className="text-lime-300" />
                      )}
                      <span className="text-[8.5px] text-lime-300 text-center leading-tight whitespace-nowrap">
                        {ev.scoreFormat === "tennis"
                          ? `Race to ${ev.tennisTarget || 4}`
                          : "Total Poin"}
                      </span>
                      <span className="text-[8.5px] text-cyan-300 text-center leading-tight whitespace-nowrap">
                        {ev.gameFormat === "mexicano" ? "Mexicano" : "Americano"}
                      </span>
                      <span className="text-[8.5px] text-cyan-300 text-center leading-tight whitespace-nowrap">
                        {ev.teamFormat === "fixed" ? "Fixed" : "Rotating"}
                      </span>
                    </div>
                  </div>
                  <div className="mt-3 flex flex-wrap gap-1.5">
                    <Chip tone={isOwnerEntry ? "cyan" : "slate"}>
                      {isOwnerEntry ? "Host" : "Peserta"}
                    </Chip>
                    {ev.ended ? (
                      <Chip tone="lime">
                        <Trophy size={11} /> Sudah Selesai
                      </Chip>
                    ) : started ? (
                      <Chip tone="cyan">
                        <Zap size={11} /> Berjalan · Ronde {Math.min(ev.currentRound + 1, ev.roundsTotal)}/
                        {ev.roundsTotal}
                      </Chip>
                    ) : (
                      <Chip tone="amber">
                        <Clock size={11} /> Menunggu
                      </Chip>
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
// MY PAYMENT SCREEN — save default platform/account so it auto-fills split
// bill whenever this person is picked as Payment Person later
// ---------------------------------------------------------------------------

function MyPaymentScreen({ currentUser, onSave, onBackToLobby }) {
  const [draftInfo, setDraftInfo] = useState(currentUser?.paymentInfo || []);
  const [saved, setSaved] = useState(false);

  const addEntry = () => {
    if (draftInfo.length >= 2) return;
    setDraftInfo([...draftInfo, { platform: "", number: "" }]);
    setSaved(false);
  };
  const updateEntry = (idx, field, value) => {
    setDraftInfo(draftInfo.map((e, i) => (i === idx ? { ...e, [field]: value } : e)));
    setSaved(false);
  };
  const removeEntry = (idx) => {
    setDraftInfo(draftInfo.filter((_, i) => i !== idx));
    setSaved(false);
  };
  const handleSave = async () => {
    const cleaned = draftInfo.filter((e) => e.platform.trim() || e.number.trim());
    await onSave(cleaned);
    setDraftInfo(cleaned);
    setSaved(true);
  };

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
          <Wallet size={16} className="text-lime-300" />
          <span className="text-xs font-semibold tracking-[0.2em] text-cyan-300 uppercase">
            Profil
          </span>
        </div>
        <h1 className="font-display text-5xl text-slate-50">INFO PEMBAYARAN</h1>
        <p className="text-slate-500 text-sm mt-2">
          Simpan platform &amp; nomor akun kamu di sini sekali saja. Nanti kalau kamu ditunjuk
          jadi Payment Person di acara manapun, split bill-nya otomatis keisi sendiri — nggak
          perlu ketik ulang tiap kali. Boleh dikosongkan kalau belum mau isi; masih bisa diisi
          manual nanti di menu Split Bill pas acara selesai.
        </p>
      </div>

      <div className="px-6 pt-6">
        <div className="rounded-xl border border-slate-800 bg-slate-900/50 p-4 space-y-3">
          {draftInfo.map((entry, idx) => (
            <div key={idx} className="flex items-center gap-2">
              <input
                value={entry.platform}
                onChange={(e) => updateEntry(idx, "platform", e.target.value)}
                placeholder="Platform (mis. BCA, GoPay)"
                className="flex-1 min-w-0 bg-slate-950 border border-slate-700 rounded-lg px-3 py-2.5 text-sm placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-lime-400/50"
              />
              <input
                value={entry.number}
                onChange={(e) => updateEntry(idx, "number", e.target.value)}
                placeholder="No. akun"
                className="flex-1 min-w-0 bg-slate-950 border border-slate-700 rounded-lg px-3 py-2.5 text-sm placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-lime-400/50"
              />
              <button
                onClick={() => removeEntry(idx)}
                className="w-9 h-9 rounded-lg bg-slate-800 border border-slate-700 text-slate-400 hover:text-red-400 flex items-center justify-center shrink-0"
              >
                <X size={14} />
              </button>
            </div>
          ))}

          {draftInfo.length === 0 && (
            <p className="text-slate-500 text-sm">Belum ada platform pembayaran tersimpan.</p>
          )}

          {draftInfo.length < 2 && (
            <button onClick={addEntry} className="text-xs font-semibold text-cyan-300">
              + Tambah platform ({draftInfo.length}/2)
            </button>
          )}
        </div>

        <PrimaryButton onClick={handleSave} className="w-full mt-4">
          {saved ? "Tersimpan ✓" : "Simpan"}
        </PrimaryButton>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// PARTNER SYNERGY — Top 5 partners list, accessible from the Lobby
// ---------------------------------------------------------------------------

function SynergyStars({ stars }) {
  return (
    <span className="text-amber-300 tracking-wide">
      {"★".repeat(stars)}
      <span className="text-slate-700">{"★".repeat(5 - stars)}</span>
    </span>
  );
}

// ---------------------------------------------------------------------------
// ALL MATCH — admin-only (alfinyr) list of every event ever created by
// anyone, using the same shared registry updated on every session save.
// Tapping an entry opens the existing read-only viewer link (?s=id), so no
// new permission logic is needed — it's exactly the same "look but don't
// touch" view anyone with a share link already gets.
// ---------------------------------------------------------------------------

function AllMatchesScreen({ onBackToLobby }) {
  const [loading, setLoading] = useState(true);
  const [matches, setMatches] = useState([]);
  const [downloadingId, setDownloadingId] = useState(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const list = await purgeOldDeletedMatches();
      if (cancelled) return;
      setMatches(list.sort((a, b) => sortDateValue(b) - sortDateValue(a)));
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const openMatch = (id) => {
    const url = new URL(window.location.href);
    url.searchParams.set("s", id);
    window.open(url.toString(), "_blank");
  };

  // Pulls the FULL session record (not just the summary fields kept in the
  // registry) for a given match, then triggers the same complete JSON
  // download (schedule, every score, activity log) that a host gets from
  // their own Recap screen — except here it works for ANY match in the
  // app, letting the admin evaluate matches they weren't even part of.
  const handleDownload = async (m) => {
    setDownloadingId(m.id);
    try {
      const full = await loadSessionData(m.id);
      if (!full) {
        alert("Gagal mengambil data acara ini — mungkin sudah dihapus.");
        return;
      }
      const data = buildSessionExport({
        eventName: full.name,
        activeId: full.id,
        createdAt: m.createdAt,
        playDate: full.playDate,
        courts: full.courts,
        mode: full.mode,
        scoreFormat: full.scoreFormat,
        pointTarget: full.pointTarget,
        tennisTarget: full.tennisTarget,
        players: full.players,
        playerMap: full.playerMap,
        engine: full.engine,
        scores: full.scores,
        activityLog: full.activityLog,
        ended: full.ended,
        excludeFromStats: full.excludeFromStats,
      });
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      const safeName = (full.name || "acara").replace(/[^a-zA-Z0-9-_]/g, "_");
      a.href = url;
      a.download = `americano-log-${safeName}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (e) {
      console.error("Gagal download log acara:", e);
      alert("Gagal download log acara ini.");
    } finally {
      setDownloadingId(null);
    }
  };

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
          <ListOrdered size={16} className="text-lime-300" />
          <span className="text-xs font-semibold tracking-[0.2em] text-cyan-300 uppercase">
            Admin
          </span>
        </div>
        <h1 className="font-display text-5xl text-slate-50">ALL MATCH</h1>
        <p className="text-slate-500 text-sm mt-2">
          Seluruh acara yang pernah dibuat siapa saja di aplikasi ini (yang belum dihapus),
          terlepas dari privasinya. Tap kartu buat buka tampilan pemantau (read-only), atau tap
          ikon download buat ambil log & data lengkapnya buat evaluasi.
        </p>
      </div>

      <div className="px-6 pt-6">
        {loading ? (
          <p className="text-slate-500 text-sm">Memuat...</p>
        ) : matches.length === 0 ? (
          <p className="text-slate-500 text-sm">Belum ada acara tercatat.</p>
        ) : (
          <>
            <p className="text-[11px] text-slate-600 mb-3">{matches.length} acara tercatat</p>
            <div className="space-y-2">
              {matches.map((m) => (
                <div
                  key={m.id}
                  className="w-full rounded-xl border border-slate-800 bg-slate-900/50 px-4 py-3"
                >
                  <div className="flex items-start gap-2">
                    <button
                      onClick={() => openMatch(m.id)}
                      className="flex-1 min-w-0 text-left"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-semibold text-slate-100 truncate">{m.name}</span>
                        <div className="flex items-center gap-1.5 shrink-0">
                          {m.deleted && <Chip tone="red">Dihapus</Chip>}
                          <Chip tone={m.ended ? "slate" : "lime"}>
                            {m.ended ? "Selesai" : m.status === "waiting" ? "Menunggu" : "Berjalan"}
                          </Chip>
                        </div>
                      </div>
                      <div className="text-[11px] text-slate-500 mt-1">
                        host: {m.ownerUsername || "—"} · {m.playerCount} pemain · {m.courts}{" "}
                        lapangan
                      </div>
                      <div className="text-[11px] text-slate-600 mt-0.5">
                        {formatEventEntryDate(m)}
                      </div>
                      {m.deleted && m.deletedAt && (
                        <div className="text-[11px] text-red-400/80 mt-0.5">
                          {Math.max(
                            0,
                            Math.ceil(
                              (m.deletedAt + DELETED_MATCH_RETENTION_MS - Date.now()) /
                                (24 * 60 * 60 * 1000)
                            )
                          )}{" "}
                          hari lagi sebelum dihapus permanen
                        </div>
                      )}
                    </button>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        handleDownload(m);
                      }}
                      disabled={downloadingId === m.id}
                      title="Download log & data lengkap"
                      className="shrink-0 w-9 h-9 rounded-lg border border-slate-700 flex items-center justify-center text-slate-300 active:scale-95 transition-transform"
                    >
                      {downloadingId === m.id ? (
                        <RotateCcw size={15} className="animate-spin" />
                      ) : (
                        <ClipboardList size={15} />
                      )}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function PartnerSynergyScreen({ currentUser, onOpenPartner, onBackToLobby }) {
  const [loading, setLoading] = useState(true);
  const [topPartners, setTopPartners] = useState([]);
  const [repairing, setRepairing] = useState(false);
  const [repairResult, setRepairResult] = useState(null); // number removed, or null

  const refresh = async () => {
    if (!currentUser?.accountId) {
      setLoading(false);
      return;
    }
    const log = await loadCountedMatchLog(currentUser.accountId);
    setTopPartners(computeTopPartners(log, 5));
    setLoading(false);
  };

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!currentUser?.accountId) {
        setLoading(false);
        return;
      }
      const log = await loadCountedMatchLog(currentUser.accountId);
      if (cancelled) return;
      setTopPartners(computeTopPartners(log, 5));
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [currentUser?.accountId]);

  const handleRepair = async () => {
    if (!currentUser?.accountId) return;
    setRepairing(true);
    const removed = await repairPlayerMatchLog(currentUser.accountId);
    setRepairResult(removed);
    await refresh();
    setRepairing(false);
  };

  const medal = (i) => (i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : `${i + 1}.`);

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
          <Handshake size={16} className="text-lime-300" />
          <span className="text-xs font-semibold tracking-[0.2em] text-cyan-300 uppercase">
            Statistik Pasangan
          </span>
        </div>
        <h1 className="font-display text-5xl text-slate-50">PARTNER SYNERGY</h1>
        <p className="text-slate-500 text-sm mt-2">
          Seberapa cocok kamu main bareng partner tertentu, dihitung dari semua pertandingan yang
          pernah kamu mainkan bareng dia — bukan cuma win rate, tapi gabungan beberapa faktor.
        </p>
      </div>

      <div className="px-6 pt-4">
        <button
          onClick={handleRepair}
          disabled={repairing}
          className="w-full text-xs font-semibold text-slate-400 border border-slate-800 rounded-xl py-2.5 flex items-center justify-center gap-1.5"
        >
          {repairing ? (
            <>
              <RotateCcw size={12} className="animate-spin" /> Memeriksa...
            </>
          ) : (
            "Bersihkan data ganda (kalau angka statistik terasa kebesaran)"
          )}
        </button>
        {repairResult !== null && !repairing && (
          <p className="text-[11px] text-center mt-1.5 text-slate-500">
            {repairResult > 0
              ? `${repairResult} entri ganda ditemukan & dibersihkan.`
              : "Nggak ada data ganda ditemukan — datanya sudah bersih."}
          </p>
        )}
      </div>

      <div className="px-6 pt-6">
        {loading ? (
          <p className="text-slate-500 text-sm">Memuat...</p>
        ) : !currentUser?.accountId ? (
          <p className="text-slate-500 text-sm">Login dulu buat lihat statistik pasangan kamu.</p>
        ) : topPartners.length === 0 ? (
          <p className="text-slate-500 text-sm">
            Belum ada data. Statistik ini keisi otomatis begitu kamu main bareng partner yang juga
            punya akun (bukan nama manual), dan skornya sudah selesai diisi.
          </p>
        ) : (
          <>
            <div className="text-[10px] text-slate-500 uppercase tracking-wide mb-2">
              Top {topPartners.length} Partner Kamu
            </div>
            <div className="space-y-2">
              {topPartners.map((p, i) => (
                <button
                  key={p.partnerAccountId}
                  onClick={() =>
                    onOpenPartner({ accountId: p.partnerAccountId, name: p.partnerName })
                  }
                  className="w-full flex items-center gap-3 rounded-xl border border-slate-800 bg-slate-900/50 px-4 py-3 text-left"
                >
                  <span className="text-lg w-7 text-center shrink-0">{medal(i)}</span>
                  <span className="flex-1 min-w-0">
                    <div className="font-semibold text-slate-100 truncate">{p.partnerName}</div>
                    <div className="text-[11px] text-slate-500">
                      {p.matches} match bareng · <SynergyStars stars={p.rating.stars} />
                    </div>
                  </span>
                  <span className="font-display text-3xl text-lime-300 shrink-0">{p.synergy}</span>
                </button>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// PARTNER DETAIL — full breakdown for one specific partner
// ---------------------------------------------------------------------------

function PartnerDetailScreen({ currentUser, partner, onBack, onBackToLobby }) {
  const [loading, setLoading] = useState(true);
  const [stats, setStats] = useState(null);
  const [comparison, setComparison] = useState(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!currentUser?.accountId || !partner?.accountId) {
        setLoading(false);
        return;
      }
      const [myLog, partnerLog] = await Promise.all([
        loadCountedMatchLog(currentUser.accountId),
        loadCountedMatchLog(partner.accountId),
      ]);
      if (cancelled) return;
      const myStats = computePartnerStats(myLog, partner.accountId);
      const withWithout = computeWithWithoutComparison(myLog, partner.accountId);
      const partnerWithoutMe = computeWithWithoutComparison(partnerLog, currentUser.accountId);
      setStats(myStats);
      setComparison({
        withRate: withWithout.withRate,
        meWithoutRate: withWithout.withoutRate,
        partnerWithoutRate: partnerWithoutMe.withoutRate,
      });
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [currentUser?.accountId, partner?.accountId]);

  return (
    <div className="pb-10">
      <div className="px-6 pt-14 pb-6 border-b border-slate-800">
        <button
          onClick={onBack}
          className="inline-flex items-center gap-1.5 text-sm font-semibold text-slate-200 border border-slate-700 rounded-full px-3.5 py-2 active:scale-95 transition-transform mb-4"
        >
          <ArrowLeft size={16} /> Partner Synergy
        </button>
        <h1 className="font-display text-4xl text-slate-50 flex items-center gap-2 flex-wrap">
          {currentUser?.displayName || currentUser?.username} <Handshake size={24} className="text-lime-300" />{" "}
          {partner?.name}
        </h1>
      </div>

      <div className="px-6 pt-6">
        {loading ? (
          <p className="text-slate-500 text-sm">Memuat...</p>
        ) : !stats ? (
          <p className="text-slate-500 text-sm">Belum ada histori main bareng partner ini.</p>
        ) : (
          <>
            <div className="rounded-2xl border border-lime-400/40 bg-lime-400/5 p-6 text-center mb-4">
              <div className="text-[11px] text-slate-400 uppercase tracking-wide mb-1">
                Partner Synergy
              </div>
              <div className="font-display text-6xl text-lime-300">{stats.synergy}</div>
              <div className="text-slate-400 text-xs mb-1">/100</div>
              <div className="text-sm mt-1">
                <SynergyStars stars={stats.rating.stars} />{" "}
                <span className="text-slate-300 font-semibold">{stats.rating.label}</span>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-2 mb-4">
              <StatCard label="Matches Together" value={stats.matches} />
              <StatCard label="Win Rate" value={`${Math.round(stats.winRate)}%`} />
              <StatCard label="Wins" value={stats.wins} />
              <StatCard label="Losses" value={stats.losses} />
              <StatCard label="Avg Points" value={stats.avgPointsPerMatch.toFixed(1)} />
              <StatCard
                label="Avg Point Diff"
                value={stats.avgPointDiff > 0 ? `+${stats.avgPointDiff.toFixed(1)}` : stats.avgPointDiff.toFixed(1)}
              />
              <StatCard label="Longest Streak" value={stats.longestStreak} />
              <StatCard label="Current Streak" value={stats.currentStreak} />
              <StatCard
                label="Last Match Together"
                value={new Date(stats.lastPlayedAt).toLocaleDateString("id-ID")}
              />
              <StatCard label="Events Together" value={stats.eventsCount} />
            </div>

            {stats.trend.length >= 2 && (
              <div className="rounded-xl border border-slate-800 bg-slate-900/50 p-4 mb-4">
                <div className="flex items-center justify-between mb-3">
                  <span className="text-xs font-semibold text-slate-300 uppercase tracking-wide">
                    Chemistry Trend
                  </span>
                  <span
                    className={`text-xs font-semibold flex items-center gap-1 ${
                      stats.trendDirection === "up" ? "text-lime-300" : "text-red-400"
                    }`}
                  >
                    {stats.trendDirection === "up" ? (
                      <>
                        <TrendingUp size={13} /> Improving
                      </>
                    ) : (
                      <>
                        <TrendingDown size={13} /> Declining
                      </>
                    )}
                  </span>
                </div>
                <div className="flex items-end gap-2" style={{ height: 80 }}>
                  {stats.trend.map((v, i) => (
                    <div key={i} className="flex-1 h-full flex flex-col justify-end items-center">
                      <div
                        className="w-full bg-lime-300 rounded-t"
                        style={{ height: `${Math.max(4, v)}%` }}
                      />
                    </div>
                  ))}
                </div>
                <div className="flex gap-2 mt-1.5">
                  {stats.trend.map((v, i) => (
                    <span
                      key={i}
                      className="flex-1 text-center text-[10px] text-slate-500 font-mono2"
                    >
                      {v}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {comparison && (
              <div className="rounded-xl border border-slate-800 bg-slate-900/50 p-4">
                <div className="text-xs font-semibold text-slate-300 uppercase tracking-wide mb-3">
                  Comparison — Win Rate
                </div>
                <div className="space-y-2.5">
                  <ComparisonRow
                    label="When Together"
                    value={comparison.withRate}
                    highlight
                  />
                  <ComparisonRow
                    label={`${currentUser?.displayName || currentUser?.username} Without ${partner?.name}`}
                    value={comparison.meWithoutRate}
                  />
                  <ComparisonRow
                    label={`${partner?.name} Without ${currentUser?.displayName || currentUser?.username}`}
                    value={comparison.partnerWithoutRate}
                  />
                </div>
                <p className="text-[11px] text-slate-500 mt-3">
                  Kalau win rate "When Together" jauh lebih tinggi dari dua yang lain, itu tanda
                  chemistry pasangan ini memang kuat — bukan cuma kebetulan salah satu lagi jago.
                </p>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function StatCard({ label, value }) {
  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900/50 px-3 py-2.5">
      <div className="text-[10px] text-slate-500 uppercase tracking-wide mb-0.5">{label}</div>
      <div className="font-mono2 text-lg text-slate-100">{value}</div>
    </div>
  );
}

function ComparisonRow({ label, value, highlight }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className={`text-sm ${highlight ? "text-slate-200 font-semibold" : "text-slate-400"}`}>
        {label}
      </span>
      <span className={`font-mono2 font-bold ${highlight ? "text-lime-300 text-lg" : "text-slate-300"}`}>
        {value !== null ? `${Math.round(value)}%` : "—"}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// FRIENDS SCREEN — friend list + incoming requests
// ---------------------------------------------------------------------------

function FriendsScreen({ friends, friendRequests, onRespond, onBrowse, onOpenFriend, onBackToLobby }) {
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
              <button
                key={f.accountId}
                onClick={() => onOpenFriend(f)}
                className="flex flex-col items-center gap-1.5 bg-slate-900 border border-slate-700 rounded-2xl px-1.5 pt-3 pb-2 active:scale-95 transition-transform"
              >
                <Avatar name={f.username} avatarUrl={f.avatarUrl} size={56} />
                <span className="text-[11px] font-semibold text-slate-100 text-center leading-snug break-words">
                  {f.username}
                </span>
              </button>
            ))}
          </div>
        )}
      </Section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// FRIEND PROFILE — same scorecard as the Lobby (read-only) plus their top
// partners and head-to-head history with you.
// ---------------------------------------------------------------------------

function FriendProfileScreen({ friend, currentUser, onBack }) {
  const [loading, setLoading] = useState(true);
  const [profile, setProfile] = useState(null);
  const [topPartners, setTopPartners] = useState([]);
  const [together, setTogether] = useState(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!friend?.accountId) {
        setLoading(false);
        return;
      }
      const [account, theirLog, myLog] = await Promise.all([
        getUserAccount(friend.accountId),
        loadCountedMatchLog(friend.accountId),
        currentUser?.accountId ? loadCountedMatchLog(currentUser.accountId) : Promise.resolve([]),
      ]);
      if (cancelled) return;

      setProfile({
        accountId: friend.accountId,
        username: account?.username || friend.username,
        displayName: account?.displayName || account?.username || friend.username,
        avatarUrl: account?.avatarUrl || friend.avatarUrl || null,
        location: account?.location || "",
        caption: account?.caption || "",
        createdAt: account?.createdAt || null,
      });
      setTopPartners(computeTopPartners(theirLog, 5));

      // How the two of you do as a pair, seen from my own log.
      if (currentUser?.accountId) {
        setTogether(computePartnerStats(myLog, friend.accountId));
      }
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [friend?.accountId, currentUser?.accountId]);

  const medal = (i) => (i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : `${i + 1}.`);

  return (
    <div className="pb-10">
      <div className="px-6 pt-14 pb-6 border-b border-slate-800">
        <button
          onClick={onBack}
          className="inline-flex items-center gap-1.5 text-sm font-semibold text-slate-200 border border-slate-700 rounded-full px-3.5 py-2 active:scale-95 transition-transform mb-4"
        >
          <ArrowLeft size={16} /> Teman
        </button>
        <div className="flex items-center gap-2 mb-1">
          <UserCircle2 size={16} className="text-lime-300" />
          <span className="text-xs font-semibold tracking-[0.2em] text-cyan-300 uppercase">
            Profil Pemain
          </span>
        </div>
        <h1 className="font-display text-4xl text-slate-50 truncate">
          {profile?.displayName || friend?.username}
        </h1>
        {profile && profile.displayName !== profile.username && (
          <p className="text-[11px] text-slate-600 mt-1">@{profile.username}</p>
        )}
      </div>

      <div className="px-6 pt-6">
        {loading ? (
          <p className="text-slate-500 text-sm">Memuat...</p>
        ) : (
          <>
            <LobbyScoreCard currentUser={profile} readOnly />

            {together && (
              <div className="mt-5 rounded-2xl border border-lime-400/30 bg-lime-400/5 p-4">
                <div className="text-[11px] text-slate-400 uppercase tracking-wide mb-2 flex items-center gap-1.5">
                  <Handshake size={13} className="text-lime-300" />
                  Kamu &amp; {profile.displayName}
                </div>
                <div className="flex items-end gap-3">
                  <div>
                    <div className="font-display text-4xl text-lime-300 leading-none">
                      {together.synergy}
                    </div>
                    <div className="text-[10px] text-slate-500 mt-1">Synergy /100</div>
                  </div>
                  <div className="flex-1 text-right">
                    <div className="text-sm text-slate-200 font-semibold">
                      <SynergyStars stars={together.rating.stars} /> {together.rating.label}
                    </div>
                    <div className="text-[11px] text-slate-400 mt-1">
                      {together.matches} match bareng · {together.wins}M-{together.losses}K ·{" "}
                      {Math.round(together.winRate)}% win
                    </div>
                  </div>
                </div>
              </div>
            )}

            <div className="mt-5">
              <div className="text-[10px] text-slate-500 uppercase tracking-wide mb-2">
                Top Partner {profile.displayName}
              </div>
              {topPartners.length === 0 ? (
                <p className="text-slate-500 text-sm">
                  Belum ada data pasangan buat pemain ini.
                </p>
              ) : (
                <div className="space-y-2">
                  {topPartners.map((p, i) => (
                    <div
                      key={p.partnerAccountId}
                      className="w-full flex items-center gap-3 rounded-xl border border-slate-800 bg-slate-900/50 px-4 py-3"
                    >
                      <span className="text-lg w-7 text-center shrink-0">{medal(i)}</span>
                      <span className="flex-1 min-w-0">
                        <div className="font-semibold text-slate-100 truncate">{p.partnerName}</div>
                        <div className="text-[11px] text-slate-500">
                          {p.matches} match · <SynergyStars stars={p.rating.stars} />
                        </div>
                      </span>
                      <span className="font-display text-3xl text-lime-300 shrink-0">
                        {p.synergy}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// BROWSE FRIENDS SCREEN — search all registered accounts, send requests
// ---------------------------------------------------------------------------

function BrowseFriendsScreen({ currentUser, onSendRequest, onBack, onOpenProfile }) {
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
          const rowContent = (
            <>
              <Avatar name={acc.username} avatarUrl={acc.avatarUrl} size={40} />
              <span className="font-semibold text-slate-100 flex-1 min-w-0 truncate text-left">
                {acc.username}
              </span>
            </>
          );
          return (
            <div
              key={acc.accountId}
              className="flex items-center gap-3 rounded-xl border border-slate-800 bg-slate-900/40 px-4 py-3"
            >
              {onOpenProfile ? (
                <button
                  onClick={() => onOpenProfile(acc)}
                  className="flex items-center gap-3 flex-1 min-w-0"
                >
                  {rowContent}
                </button>
              ) : (
                <div className="flex items-center gap-3 flex-1 min-w-0">{rowContent}</div>
              )}
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
    endTime, setEndTime,
    scoreFormat, setScoreFormat, pointTarget, setPointTarget,
    sportType, setSportType,
    gameFormat, setGameFormat,
    teamFormat, setTeamFormat,
    tennisTarget, setTennisTarget,
    maxParticipants, setMaxParticipants,
    visibility, setVisibility,
    courtCost, setCourtCost, adminFee, setAdminFee, ballCost, setBallCost,
    playDate, setPlayDate,
    computedRounds, onGenerate,
    onBackToLobby,
  } = props;

  const [creating, setCreating] = useState(false);

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
        <div className="flex items-center gap-2 mb-4">
          <img src="/icon-192.png" alt="APlay" className="w-8 h-8 rounded-lg shrink-0" />
          <span className="font-display text-2xl text-slate-50 tracking-wide">APlay</span>
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
        <div className="text-[11px] text-cyan-300/80 mt-3 max-w-xs">
          <p className="font-semibold text-cyan-300">🔗 Live & Shareable</p>
          <p>Semua pemain melihat skor secara real-time.</p>
          <p>Bagikan link ke grup</p>
        </div>
      </div>

      {/* EVENT NAME */}
      {/* PLAY DATE + TIME (moved to the top — the event name template below is built from these) */}
      <Section icon={CalendarDays} title="Tanggal & Jam Bermain" subtitle="opsional">
        <DateInputField value={playDate} onChange={(e) => setPlayDate(e.target.value)} />
        <p className="text-[11px] text-slate-500 mt-2 mb-2">Kosongkan untuk menggunakan tanggal hari ini.</p>
        <TimeRangeBar
          startTime={startTime}
          endTime={endTime}
          onStartChange={setStartTime}
          onEndChange={setEndTime}
          durationLabel={startTime && endTime ? formatDurationMinutes(totalMinutes) : null}
        />
      </Section>

      {/* SPORT TYPE (moved before Nama Acara — the template below needs this filled in first) */}
      <Section icon={Swords} title="Jenis Olahraga">
        <div className="flex gap-2">
          <ModeTab active={sportType === "padel"} onClick={() => setSportType("padel")}>
            <span className="inline-flex items-center gap-2">
              <PadelRacketIcon size={34} dark={sportType === "padel"} /> Padel
            </span>
          </ModeTab>
          <ModeTab
            active={sportType === "tenis"}
            onClick={() => {
              setSportType("tenis");
              setScoreFormat("tennis"); // tenis cuma masuk akal pakai format game, bukan total poin
            }}
          >
            <span className="inline-flex items-center gap-2">
              <TennisRacketIcon size={34} dark={sportType === "tenis"} /> Tenis
            </span>
          </ModeTab>
        </div>
      </Section>

      <Section icon={CalendarDays} title="Nama Acara">
        <input
          value={eventName}
          onChange={(e) => setEventName(e.target.value)}
          placeholder={generateEventNameTemplate(playDate, startTime, sportType) || "mis. Padel Malam Jumat"}
          className="w-full bg-slate-900 border border-slate-700 rounded-xl px-4 py-3 text-sm placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-lime-400/50"
        />
        {!eventName && generateEventNameTemplate(playDate, startTime, sportType) && (
          <p className="text-[11px] text-slate-500 mt-2">
            Dibiarkan kosong? Nama acara otomatis jadi "{generateEventNameTemplate(playDate, startTime, sportType)}"
            (dari tanggal, jam, & olahraga yang dipilih).
          </p>
        )}
      </Section>

      {/* GAME FORMAT */}
      <Section icon={Shuffle} title="Format Permainan">
        <div className="flex gap-2 mb-2">
          <ModeTab active={gameFormat === "americano"} onClick={() => setGameFormat("americano")}>
            Americano
          </ModeTab>
          <ModeTab active={gameFormat === "mexicano"} onClick={() => setGameFormat("mexicano")}>
            Mexicano
          </ModeTab>
        </div>
        <p className="text-[11px] text-slate-500">
          {gameFormat === "americano"
            ? "Rotasi berdasarkan waktu tunggu & variasi — semua orang gantian main sama semua orang secara merata."
            : "Rotasi berdasarkan peringkat — tim yang levelnya deket dikelompokkan biar pertandingan tetap seru. Ronde berikutnya baru muncul setelah skor ronde sekarang lengkap diisi."}
        </p>
      </Section>

      {/* TEAM FORMAT */}
      <Section icon={UsersRound} title="Format Tim">
        <div className="flex gap-2 mb-2">
          <ModeTab active={teamFormat === "rotating"} onClick={() => setTeamFormat("rotating")}>
            Rotating
          </ModeTab>
          <ModeTab active={teamFormat === "fixed"} onClick={() => setTeamFormat("fixed")}>
            Fixed Partner
          </ModeTab>
        </div>
        <p className="text-[11px] text-slate-500">
          {teamFormat === "rotating"
            ? "Partner berganti tiap ronde."
            : "Partner tetap sama sepanjang acara (kamu pasangin nanti pas semua udah join di lobby) — yang berotasi cuma lawannya."}
        </p>
      </Section>

      {/* SCORE FORMAT */}
      <Section icon={Target} title="Format Skor" subtitle="opsional">
        {sportType === "tenis" ? (
          <div className="mb-4">
            <div className="w-full py-2.5 rounded-xl text-sm font-semibold text-center bg-lime-300 text-slate-950">
              Race to {tennisTarget} Game
            </div>
            <p className="text-[11px] text-slate-500 mt-2">
              Karena jenis olahraganya Tenis, format skor otomatis pakai Race to X Game.
            </p>
          </div>
        ) : (
          <div className="flex gap-2 mb-4">
            <ModeTab active={scoreFormat === "points"} onClick={() => setScoreFormat("points")}>
              Total Poin
            </ModeTab>
            <ModeTab active={scoreFormat === "tennis"} onClick={() => setScoreFormat("tennis")}>
              Race to {tennisTarget} Game
            </ModeTab>
          </div>
        )}

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
              <label
                className={`flex items-center gap-1 px-4 py-2 rounded-xl text-sm font-semibold border cursor-text ${
                  ![16, 21, 24, 32].includes(pointTarget)
                    ? "bg-lime-300 text-slate-950 border-lime-300"
                    : "bg-slate-900 text-slate-300 border-slate-700"
                }`}
              >
                Custom:
                <input
                  type="number"
                  value={pointTarget}
                  onChange={(e) => setPointTarget(Number(e.target.value))}
                  className="w-10 bg-transparent text-center font-mono2 focus:outline-none"
                />
                Poin
              </label>
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
              <label
                className={`flex items-center gap-1 px-4 py-2 rounded-xl text-sm font-semibold border cursor-text ${
                  ![4, 6].includes(tennisTarget)
                    ? "bg-lime-300 text-slate-950 border-lime-300"
                    : "bg-slate-900 text-slate-300 border-slate-700"
                }`}
              >
                Race to
                <input
                  type="number"
                  value={tennisTarget}
                  onChange={(e) => setTennisTarget(Number(e.target.value))}
                  className="w-10 bg-transparent text-center font-mono2 focus:outline-none"
                />
                Game
              </label>
            </div>
          </div>
        )}
      </Section>

      {/* MAX PARTICIPANTS */}
      <Section icon={Users} title="Target Peserta" subtitle="bisa disesuaikan nanti">
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
            <p className="text-[11px] text-slate-500 -mt-1">
              Total durasi ({totalMinutes} menit) otomatis dihitung dari jam bermain di atas.
            </p>
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
            <CurrencyInput value={courtCost} onChange={setCourtCost} />
          </FieldRow>
          <FieldRow label="Biaya admin (Rp)">
            <CurrencyInput value={adminFee} onChange={setAdminFee} />
          </FieldRow>
          <FieldRow label="Biaya bola (Rp)">
            <CurrencyInput value={ballCost} onChange={setBallCost} />
          </FieldRow>
        </div>
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
          onClick={async () => {
            if (creating) return;
            setCreating(true);
            try {
              await onGenerate();
            } finally {
              setCreating(false);
            }
          }}
          disabled={creating}
          icon={Users}
          className="w-full text-lg py-4"
        >
          {creating ? "Membuat acara…" : "Buat Acara & Undang Peserta"}
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

// The user's own reference icons (uploaded images), used exactly as
// provided. White version for dark backgrounds (default), black version for
// when the icon sits on a bright lime background (e.g. the active state of
// the sport-type toggle) where white would wash out and become invisible.
function TennisRacketIcon({ size = 16, className = "", dark = false }) {
  return (
    <img
      src={dark ? tennisIconBlack : tennisIconWhite}
      alt="Tenis"
      style={{ width: size, height: size, objectFit: "contain" }}
      className={className}
    />
  );
}

function PadelRacketIcon({ size = 16, className = "", dark = false }) {
  return (
    <img
      src={dark ? padelIconBlack : padelIconWhite}
      alt="Padel"
      style={{ width: size, height: size, objectFit: "contain" }}
      className={className}
    />
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

// Plain <input type="number"> can't show thousand-separator dots while
// typing (browsers reject non-digit characters in a number input). This
// keeps the underlying value as a plain digit string in state — same as
// before — but DISPLAYS it with "." every three digits (Rp 500.000 style),
// stripping whatever the person typed back down to digits-only before
// calling onChange so the stored value never actually contains dots.
function CurrencyInput({ value, onChange, className }) {
  const formatted = String(value || "").replace(/\D/g, "").replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return (
    <div className="relative">
      <span className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500 text-sm pointer-events-none">
        Rp
      </span>
      <input
        type="text"
        inputMode="numeric"
        value={formatted}
        onChange={(e) => onChange(e.target.value.replace(/\D/g, ""))}
        placeholder="0"
        className={className || "w-32 bg-slate-900 border border-slate-700 rounded-lg pl-8 pr-3 py-2 text-right font-mono2"}
      />
    </div>
  );
}

// Horizontal dual-handle time range slider replacing the old dropdown
// pickers — drag either end to adjust Start/End, snapped to the half-hour
// (matching how court bookings actually work). Built with pointer events
// so the same code handles mouse AND touch without extra libraries; drag
// state lives in a ref (not React state) so dragging doesn't re-trigger
// re-renders on every pixel of movement, only committing a change once the
// snapped value actually differs from before.
function TimeRangeBar({ startTime, endTime, onStartChange, onEndChange, durationLabel }) {
  const trackRef = useRef(null);
  const draggingRef = useRef(null); // "start" | "end" | null
  const MAX_MINS = 24 * 60;

  const timeToMinutes = (t) => {
    const [h, m] = (t || "00:00").split(":").map(Number);
    return (h || 0) * 60 + (m || 0);
  };
  const minutesToTime = (mins) => {
    const clamped = Math.max(0, Math.min(MAX_MINS - 30, mins));
    const h = Math.floor(clamped / 60);
    const m = clamped % 60;
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
  };
  const snap30 = (mins) => Math.round(mins / 30) * 30;

  const startMins = timeToMinutes(startTime);
  const endMins = timeToMinutes(endTime);
  const startPct = (startMins / MAX_MINS) * 100;
  const endPct = (endMins / MAX_MINS) * 100;

  const posToMinutes = (clientX) => {
    if (!trackRef.current) return 0;
    const rect = trackRef.current.getBoundingClientRect();
    const pct = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    return snap30(pct * MAX_MINS);
  };

  useEffect(() => {
    const handleMove = (clientX) => {
      if (!draggingRef.current) return;
      const mins = posToMinutes(clientX);
      if (draggingRef.current === "start") {
        onStartChange(minutesToTime(Math.min(mins, endMins - 30)));
      } else {
        onEndChange(minutesToTime(Math.max(mins, startMins + 30)));
      }
    };
    const onPointerMove = (e) => handleMove(e.clientX);
    const onTouchMove = (e) => {
      if (draggingRef.current) e.preventDefault();
      handleMove(e.touches[0].clientX);
    };
    const stopDragging = () => {
      draggingRef.current = null;
    };
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", stopDragging);
    window.addEventListener("touchmove", onTouchMove, { passive: false });
    window.addEventListener("touchend", stopDragging);
    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", stopDragging);
      window.removeEventListener("touchmove", onTouchMove);
      window.removeEventListener("touchend", stopDragging);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startMins, endMins]);

  const Handle = ({ which, pct, label }) => (
    <div
      onPointerDown={() => (draggingRef.current = which)}
      onTouchStart={() => (draggingRef.current = which)}
      className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 touch-none cursor-grab active:cursor-grabbing"
      style={{ left: `${pct}%` }}
    >
      <span className="absolute -top-8 left-1/2 -translate-x-1/2 text-xs font-mono2 font-semibold text-slate-100 whitespace-nowrap bg-slate-800 border border-slate-700 rounded px-1.5 py-0.5">
        {label}
      </span>
      <div className="w-6 h-6 rounded-full bg-lime-300 border-2 border-slate-950 shadow-[0_0_0_4px_rgba(190,242,100,0.25)]" />
    </div>
  );

  return (
    <div className="flex items-center gap-4">
      <div className="flex-1 pt-8 pb-2">
        <div ref={trackRef} className="relative h-1.5 bg-slate-800 rounded-full">
          <div
            className="absolute h-1.5 bg-lime-400 rounded-full"
            style={{ left: `${startPct}%`, width: `${Math.max(0, endPct - startPct)}%` }}
          />
          <Handle which="start" pct={startPct} label={startTime} />
          <Handle which="end" pct={endPct} label={endTime} />
        </div>
      </div>
      {durationLabel && (
        <div className="flex items-center gap-3 shrink-0 pl-1">
          <div className="w-px h-9 bg-slate-700" />
          <span className="text-xs font-semibold text-cyan-300 leading-tight max-w-[64px]">
            Durasi Sesi — {durationLabel}
          </span>
        </div>
      )}
    </div>
  );
}

// Native <input type="date"> renders with the browser's own pill-shaped
// chrome on iOS/Android that ignores most of our styling, making it look
// wider/rounder than every other text input next to it. This wraps the real
// (invisible) date input over a normally-styled box we fully control, so it
// visually matches every other field while still opening the native picker.
// Toggle for whether an event's matches feed into everyone's career and
// partner-synergy stats. Useful for trial runs / practice sessions that
// would otherwise skew real numbers.
// Bundles everything about this session into one downloadable JSON file —
// full schedule/engine state, every score, the activity log (who clicked
// what, how many reshuffles, etc.), and basic settings — so the host can
// hand off a complete, self-contained snapshot for debugging/analysis.
function buildSessionExport({
  eventName, activeId, createdAt, playDate, courts, mode, scoreFormat,
  pointTarget, tennisTarget, players, playerMap, engine, scores,
  activityLog, ended, excludeFromStats,
}) {
  return {
    exportedAt: new Date().toISOString(),
    event: {
      id: activeId,
      name: eventName,
      createdAt: createdAt ? new Date(createdAt).toISOString() : null,
      playDate: playDate || null,
      courts,
      mode,
      scoreFormat,
      pointTarget,
      tennisTarget,
      ended: !!ended,
      excludeFromStats: !!excludeFromStats,
    },
    players,
    playersSummary: {
      total: (players || []).length,
      denganAkun: (players || []).filter((p) => p.accountId).length,
      guest: (players || []).filter((p) => !p.accountId).length,
    },
    playerMap,
    schedule: engine
      ? {
          totalRounds: engine.roundsData.length,
          rounds: engine.roundsData.map((rd, rIdx) => ({
            round: rIdx + 1,
            resting: rd.resting.map((id) => playerMap[id] || id),
            courts: rd.courts.map((c, cIdx) => ({
              lapangan: cIdx + 1,
              team1: c.team1.map((id) => playerMap[id] || id),
              team2: c.team2.map((id) => playerMap[id] || id),
              score: scores[`${rIdx}-${cIdx}`] || null,
            })),
          })),
        }
      : null,
    activityLog: (activityLog || []).map((a) => ({
      waktu: new Date(a.ts).toISOString(),
      oleh: a.who,
      aksi: a.message,
    })),
    // Silent decision trace from the scheduling algorithm itself — not
    // shown anywhere in the app UI. Exists so a real matchmaking anomaly
    // (e.g. "these two keep facing each other") can be diagnosed from what
    // the algorithm actually considered and why, instead of reconstructing
    // it after the fact from just the final schedule. Player ids are
    // translated to names here for readability.
    algorithmDebug:
      engine && engine.debugTrace
        ? engine.debugTrace.map((d) => {
            const names = (ids) => (ids || []).map((id) => playerMap[id] || id);
            const nameOf = (id) => playerMap[id] || id;
            const waitTimes = {};
            Object.entries(d.waitTimes || {}).forEach(([id, wait]) => {
              waitTimes[nameOf(id)] = wait;
            });
            return {
              ronde: d.round + 1,
              waktuTunggu: waitTimes,
              cutoffWait: d.cutoffWait,
              wajibMain: names(d.guaranteedBeforeClump),
              tier0Seri: names(d.tier0),
              clumpEligible: names(d.clumpEligible),
              wajibMainSetelahClump: names(d.guaranteedAfterClump),
              butuhDariFlex: d.neededFromFlex,
              tier1Dipakai: d.tier1Used ? names(d.tier1Used) : null,
              kandidatFlex: names(d.flexCandidates),
              caraPilihAktif: d.activeSelection,
              biayaAktifTerpilih: d.activeCost ?? null,
              yangMain: names(d.activeChosen),
              pembagianTim: (d.teamSplit || []).map((g) => ({
                grup: names(g.group),
                opsiDipertimbangkan: (g.optionsConsidered || []).map((o) => ({
                  tim1: names(o.t1),
                  tim2: names(o.t2),
                  biayaPartner: o.partnerCost,
                  biayaLawan: o.oppCost,
                  totalBiaya: o.total,
                })),
                dipilih: g.chosen ? { tim1: names(g.chosen.t1), tim2: names(g.chosen.t2) } : null,
                biayaDipilih: g.chosenCost,
              })),
            };
          })
        : [],
  };
}

function ExportSessionButton(props) {
  const [done, setDone] = useState(false);
  const handleExport = () => {
    const data = buildSessionExport(props);
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const safeName = (props.eventName || "acara").replace(/[^a-zA-Z0-9-_]/g, "_");
    a.href = url;
    a.download = `americano-log-${safeName}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    setDone(true);
    setTimeout(() => setDone(false), 2500);
  };
  return (
    <div>
      <button
        onClick={handleExport}
        className={`w-full text-xs font-semibold rounded-xl py-2.5 flex items-center justify-center gap-1.5 border ${
          done ? "bg-lime-300 text-slate-950 border-lime-300" : "text-slate-300 border-slate-700"
        }`}
      >
        {done ? "Terunduh ✓" : "Download Log & Data Lengkap (.json)"}
      </button>
      <p className="text-[11px] text-slate-500 mt-2">
        Berisi seluruh jadwal, skor tiap match, dan catatan aktivitas (reshuffle, tambah/hapus
        ronde, penyesuaian, dll). Tinggal kirim file-nya buat dianalisa.
      </p>
    </div>
  );
}

function StatsCountToggle({ excluded, onToggle }) {
  return (
    <div>
      <div className="flex gap-2">
        <button
          onClick={() => onToggle(false)}
          className={`flex-1 py-3 rounded-xl text-sm font-semibold border ${
            !excluded
              ? "bg-lime-300 text-slate-950 border-lime-300"
              : "bg-slate-900 text-slate-300 border-slate-700"
          }`}
        >
          Dihitung
        </button>
        <button
          onClick={() => onToggle(true)}
          className={`flex-1 py-3 rounded-xl text-sm font-semibold border ${
            excluded
              ? "bg-amber-400 text-slate-950 border-amber-400"
              : "bg-slate-900 text-slate-300 border-slate-700"
          }`}
        >
          Tidak Dihitung
        </button>
      </div>
      <p className="text-[11px] text-slate-500 mt-2.5">
        {excluded
          ? "Acara ini TIDAK masuk statistik siapapun — cocok buat uji coba atau latihan. Skor & klasemen di acara ini tetap tersimpan normal, cuma nggak ikut dihitung di Ringkasan Statistik dan Partner Synergy."
          : "Acara ini dihitung normal ke statistik semua pemain. Ubah ke \"Tidak Dihitung\" kalau ini cuma uji coba, biar tidak merusak data asli."}
      </p>
      <p className="text-[11px] text-slate-600 mt-1.5">
        Bisa diubah kapan saja, termasuk setelah acara selesai — data pertandingan tidak akan
        terhapus.
      </p>
    </div>
  );
}

function DateInputField({ value, onChange, placeholder = "Pilih tanggal" }) {
  const display = value
    ? (() => {
        const [y, m, d] = value.split("-").map(Number);
        return new Date(y, m - 1, d).toLocaleDateString("id-ID", {
          day: "numeric",
          month: "short",
          year: "numeric",
        });
      })()
    : null;
  return (
    <div className="relative w-full">
      <div className="w-full bg-slate-900 border border-slate-700 rounded-xl px-4 py-3 text-sm flex items-center justify-between pointer-events-none">
        <span className={display ? "text-slate-100" : "text-slate-500"}>
          {display || placeholder}
        </span>
        <CalendarDays size={16} className="text-slate-500 shrink-0" />
      </div>
      <input
        type="date"
        value={value}
        onChange={onChange}
        className="absolute inset-0 w-full h-full opacity-0"
      />
    </div>
  );
}

// Explicit save button for cost fields — relying only on onBlur to persist
// turned out unreliable on some mobile browsers (tapping straight from the
// input to another button can skip the blur event), so this gives a clear,
// guaranteed-to-fire save action with visible confirmation.
function CostSaveButton({ onSave }) {
  const [saved, setSaved] = useState(false);
  const handleClick = () => {
    onSave();
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };
  return (
    <button
      onClick={handleClick}
      className={`w-full mt-3 py-2.5 rounded-xl font-semibold text-sm transition-colors ${
        saved ? "bg-lime-300 text-slate-950" : "bg-slate-800 border border-slate-700 text-slate-200"
      }`}
    >
      {saved ? "Tersimpan ✓" : "Simpan Biaya"}
    </button>
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

// Tap-to-pair UI for Fixed Partner mode: tap a first name, then a second, to
// lock them in as a permanent team. Tap a formed pair's X to break it back
// apart. Deliberately simple (no drag-and-drop) so it works cleanly on
// mobile touch.
function FixedPairingBuilder({ players, fixedPairs, setFixedPairs }) {
  const [selected, setSelected] = useState(null); // playerId waiting for its partner, or null

  const pairedIds = new Set(fixedPairs.flat());
  const unpaired = players.filter((p) => !pairedIds.has(p.id));

  const nameOf = (id) => players.find((p) => p.id === id)?.name || "?";

  const handleTap = (playerId) => {
    if (selected === null) {
      setSelected(playerId);
    } else if (selected === playerId) {
      setSelected(null); // tapped the same one again — deselect
    } else {
      setFixedPairs([...fixedPairs, [selected, playerId]]);
      setSelected(null);
    }
  };

  const unpair = (idx) => {
    setFixedPairs(fixedPairs.filter((_, i) => i !== idx));
  };

  return (
    <div>
      {fixedPairs.length > 0 && (
        <div className="space-y-2 mb-4">
          {fixedPairs.map((pair, idx) => (
            <div
              key={idx}
              className="flex items-center justify-between gap-2 rounded-xl border border-lime-400/40 bg-lime-400/5 px-4 py-2.5"
            >
              <span className="font-semibold text-slate-100 text-sm truncate">
                {nameOf(pair[0])} &amp; {nameOf(pair[1])}
              </span>
              <button
                onClick={() => unpair(idx)}
                className="w-7 h-7 rounded-full bg-slate-800 border border-slate-700 text-slate-400 hover:text-red-400 flex items-center justify-center shrink-0"
              >
                <X size={13} />
              </button>
            </div>
          ))}
        </div>
      )}

      {unpaired.length > 0 && (
        <div>
          {selected !== null && (
            <p className="text-[11px] text-cyan-300 mb-2">
              "{nameOf(selected)}" dipilih — tap 1 nama lagi buat jadiin pasangan.
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            {unpaired.map((p) => (
              <button
                key={p.id}
                onClick={() => handleTap(p.id)}
                className={`px-3.5 py-2 rounded-full text-sm font-semibold border transition-colors ${
                  selected === p.id
                    ? "bg-cyan-400 text-slate-950 border-cyan-400"
                    : "bg-slate-900 text-slate-200 border-slate-700"
                }`}
              >
                {p.name}
              </button>
            ))}
          </div>
        </div>
      )}

      {unpaired.length === 0 && fixedPairs.length > 0 && (
        <p className="text-[11px] text-lime-400">✓ Semua orang udah berpasangan.</p>
      )}
      {players.length === 0 && (
        <p className="text-[11px] text-slate-500">Tambahin peserta dulu di atas sebelum pasangin.</p>
      )}
      {players.length > 0 && players.length % 2 !== 0 && (
        <p className="text-[11px] text-amber-400 mt-2">
          ⚠️ Jumlah peserta ganjil ({players.length} orang) — Fixed Partner butuh jumlah genap
          supaya semua orang kebagian pasangan.
        </p>
      )}
    </div>
  );
}

function WaitingRoomScreen(props) {
  const {
    eventName, activeId, isOwner, canManage, myAccountId,
    players, nameInput, setNameInput, bulkInput, setBulkInput,
    addPlayerFromInput, addBulk, removePlayer,
    maxParticipants, courts, computedRounds, courtStages, setCourtStages,
    pendingRequests, onApprove, onReject,
    hostPlaying, onToggleHostPlaying,
    coHostIds, onToggleCoHost,
    friends, onInviteFriend, onSendFriendRequest,
    hostInvitations, onCancelInvitation,
    courtCost, setCourtCost, adminFee, setAdminFee, ballCost, setBallCost, onSaveCosts,
    playDate, setPlayDate, onSavePlayDate,
    excludeFromStats, onToggleExcludeFromStats,
    gameFormat, teamFormat, fixedPairs, setFixedPairs,
    onFinalize, onBackToLobby, onDelete,
  } = props;

  const [sentFriendReq, setSentFriendReq] = useState({}); // accountId -> true (local feedback)

  // Safety net for older sessions: hide invitations for anyone who's already
  // a participant (or waiting for approval), since they clearly joined some
  // other way and the invitation no longer means anything.
  const staleFreeInvitations = hostInvitations.filter((inv) => {
    const inRoster = players.some((p) => p.accountId && p.accountId === inv.accountId);
    const inPending = pendingRequests.some((r) => r.accountId && r.accountId === inv.accountId);
    return !inRoster && !inPending;
  });

  const [showBulk, setShowBulk] = useState(false);
  const [avatarCache, setAvatarCache] = useState({}); // accountId -> avatarUrl | null
  const [nameCache, setNameCache] = useState({}); // accountId -> current displayName | null
  const usableCourtsPreview = Math.min(courts, Math.floor(players.length / 4));
  const pairedIdsPreview = new Set(fixedPairs.flat());
  const unpairedCount = players.length - pairedIdsPreview.size;
  const fixedPartnerReady =
    gameFormat !== "fixed_partner" ||
    (players.length % 2 === 0 && unpairedCount === 0 && fixedPairs.length >= 2);
  const canFinalize = players.length >= 4 && usableCourtsPreview >= 1 && fixedPartnerReady;
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
          return { id, avatarUrl: acc?.avatarUrl || null, name: acc ? acc.displayName || acc.username : null };
        })
      );
      setAvatarCache((prev) => ({
        ...prev,
        ...Object.fromEntries(entries.map((e) => [e.id, e.avatarUrl])),
      }));
      setNameCache((prev) => ({ ...prev, ...Object.fromEntries(entries.map((e) => [e.id, e.name])) }));
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

      {canManage && staleFreeInvitations.length > 0 && (
        <Section icon={Users} title="Undangan Menunggu Respon" subtitle={`${staleFreeInvitations.length}`}>
          <div className="space-y-2">
            {staleFreeInvitations.map((inv) => (
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
              const liveName = (p.accountId && nameCache[p.accountId]) || p.name;
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
                      name={liveName}
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
                    {liveName}
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
        <Section icon={CalendarDays} title="Tanggal Bermain" subtitle="opsional">
          <DateInputField
            value={playDate}
            onChange={(e) => {
              setPlayDate(e.target.value);
              onSavePlayDate(e.target.value);
            }}
          />
        </Section>
      )}

      {isOwner && (
        <Section icon={BarChart3} title="Hitung ke Statistik?" subtitle="opsional">
          <StatsCountToggle excluded={excludeFromStats} onToggle={onToggleExcludeFromStats} />
        </Section>
      )}

      {canManage && (
        <Section icon={Wallet} title="Biaya" subtitle="opsional, buat split bill">
          <p className="text-xs text-slate-500 mb-3">
            Kelewat isi biaya waktu bikin acara? Isi di sini juga masih bisa, sebelum atau sesudah
            jadwal digenerate. Boleh dikosongkan.
          </p>
          <div className="space-y-3">
            <FieldRow label="Harga lapangan (Rp)">
              <CurrencyInput value={courtCost} onChange={setCourtCost} />
            </FieldRow>
            <FieldRow label="Biaya admin (Rp)">
              <CurrencyInput value={adminFee} onChange={setAdminFee} />
            </FieldRow>
            <FieldRow label="Biaya bola (Rp)">
              <CurrencyInput value={ballCost} onChange={setBallCost} />
            </FieldRow>
          </div>
          <CostSaveButton onSave={onSaveCosts} />
        </Section>
      )}

      {canManage && gameFormat !== "fixed_partner" && (
        <Section icon={Settings2} title="Lapangan Bertahap" subtitle="opsional">
          {courtStages.length === 0 ? (
            <>
              <p className="text-xs text-slate-500 mb-3">
                Kalau jumlah lapangan berubah di tengah acara (misal jam 7-8 cuma 1 lapangan, jam
                8-9 jadi 2 lapangan), atur di sini dari awal — nggak perlu nunggu nyesuaikan manual
                pas acara sudah jalan.
              </p>
              <GhostButton
                onClick={() => {
                  const half = Math.max(1, Math.floor(computedRounds / 2));
                  setCourtStages([
                    { id: uid(), rounds: half, courts },
                    { id: uid(), rounds: computedRounds - half, courts },
                  ]);
                }}
                icon={Settings2}
                className="w-full"
              >
                Aktifkan Lapangan Bertahap
              </GhostButton>
            </>
          ) : (
            <>
              <p className="text-xs text-slate-500 mb-3">
                Total ronde acara ini: {computedRounds}. Bagi jadi beberapa tahap dengan jumlah
                lapangan berbeda-beda — jumlah ronde tiap tahap harus totalnya pas.
              </p>
              <div className="space-y-3">
                {courtStages.map((s, i) => (
                  <div key={s.id} className="rounded-xl border border-slate-800 bg-slate-900/50 p-3">
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-xs font-semibold text-slate-300">Tahap {i + 1}</span>
                      {courtStages.length > 1 && (
                        <button
                          onClick={() => setCourtStages(courtStages.filter((x) => x.id !== s.id))}
                          className="text-slate-500 hover:text-red-400"
                        >
                          <X size={14} />
                        </button>
                      )}
                    </div>
                    <div className="flex items-center gap-3">
                      <div className="flex-1">
                        <div className="text-[10px] text-slate-500 uppercase mb-1">Jumlah Ronde</div>
                        <input
                          type="number"
                          inputMode="numeric"
                          value={s.rounds}
                          onChange={(e) =>
                            setCourtStages(
                              courtStages.map((x) =>
                                x.id === s.id ? { ...x, rounds: parseInt(e.target.value, 10) || 0 } : x
                              )
                            )
                          }
                          className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-100"
                        />
                      </div>
                      <div className="flex-1">
                        <div className="text-[10px] text-slate-500 uppercase mb-1">Lapangan</div>
                        <div className="flex items-center gap-2">
                          <button
                            onClick={() =>
                              setCourtStages(
                                courtStages.map((x) =>
                                  x.id === s.id ? { ...x, courts: Math.max(1, x.courts - 1) } : x
                                )
                              )
                            }
                            className="w-8 h-8 rounded-lg bg-slate-800 border border-slate-700 text-slate-200 font-bold"
                          >
                            −
                          </button>
                          <span className="flex-1 text-center font-semibold text-slate-100">
                            {s.courts}
                          </span>
                          <button
                            onClick={() =>
                              setCourtStages(
                                courtStages.map((x) =>
                                  x.id === s.id ? { ...x, courts: x.courts + 1 } : x
                                )
                              )
                            }
                            className="w-8 h-8 rounded-lg bg-slate-800 border border-slate-700 text-slate-200 font-bold"
                          >
                            +
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
              {(() => {
                const total = courtStages.reduce((sum, x) => sum + (x.rounds || 0), 0);
                const ok = total === computedRounds;
                return (
                  <p className={`text-xs mt-3 ${ok ? "text-lime-400" : "text-amber-400"}`}>
                    Total tahapan: {total} / {computedRounds} ronde{" "}
                    {ok ? "✓ sudah pas" : "— sesuaikan supaya totalnya pas"}
                  </p>
                );
              })()}
              <div className="flex items-center gap-2 mt-3">
                <GhostButton
                  onClick={() => {
                    const used = courtStages.reduce((sum, x) => sum + (x.rounds || 0), 0);
                    const remain = Math.max(0, computedRounds - used);
                    const lastCourts = courtStages[courtStages.length - 1]?.courts || courts;
                    setCourtStages([...courtStages, { id: uid(), rounds: remain, courts: lastCourts }]);
                  }}
                  icon={Plus}
                  className="flex-1"
                >
                  Tambah Tahap
                </GhostButton>
                <GhostButton onClick={() => setCourtStages([])} className="flex-1">
                  Nonaktifkan
                </GhostButton>
              </div>
            </>
          )}
        </Section>
      )}

      {teamFormat === "fixed" && canManage && (
        <Section icon={Users} title="Pasangan Tetap" subtitle="wajib diisi sebelum generate">
          <p className="text-[11px] text-slate-500 mb-3">
            Tap 2 nama buat jadiin 1 pasangan tetap. Partner ini nggak akan berubah sepanjang
            acara — cuma lawannya yang bakal dirotasi tiap ronde.
          </p>
          <FixedPairingBuilder players={players} fixedPairs={fixedPairs} setFixedPairs={setFixedPairs} />
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
    ended, hasSplitBill, onEndEvent, onReshuffle, allMatchesScored, players, onAddManualMatch, onAddAutoRound, onDeleteRound,
    friends, onAdjustSchedule, courts, onToggleArrival, onEditMatchPlayers,
    gameFormat, teamFormat, fixedPairs,
    onNav, onShare, onCopyViewLink, onBackToLobby, onDelete,
  } = props;

  const [scoreModal, setScoreModal] = useState(null); // court index being edited, or null
  const [viewMode, setViewMode] = useState("single"); // single | all
  const [showAddMatch, setShowAddMatch] = useState(false);
  const [showManagePlayers, setShowManagePlayers] = useState(false);
  const [showAttendance, setShowAttendance] = useState(false);
  const [showAddAutoRound, setShowAddAutoRound] = useState(false);
  const [editingCourtIdx, setEditingCourtIdx] = useState(null); // court index being manually edited, or null
  const [reshuffling, setReshuffling] = useState(false);
  const [showDeleteRoundConfirm, setShowDeleteRoundConfirm] = useState(false);

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
        <div className="flex items-center justify-between gap-2 mb-2">
          <button
            onClick={onBackToLobby}
            className="inline-flex items-center gap-1.5 text-sm font-semibold text-slate-200 border border-slate-700 rounded-full px-3.5 py-2 active:scale-95 transition-transform shrink-0"
          >
            <ArrowLeft size={16} /> Lobby
          </button>
          {canManage ? (
            <div className="flex items-center flex-wrap justify-end gap-1.5">
              {!isOwner && <Chip tone="cyan">co-host</Chip>}
              {!ended && (
                <button
                  onClick={onEndEvent}
                  className="inline-flex items-center gap-1.5 text-xs font-semibold text-white bg-cyan-500 rounded-full px-2.5 py-1 shrink-0 whitespace-nowrap"
                >
                  <Trophy size={11} /> selesaikan
                </button>
              )}
              {isOwner && (
                <button
                  onClick={onDelete}
                  className="inline-flex items-center gap-1.5 text-xs font-semibold text-white bg-red-500 rounded-full px-2.5 py-1 shrink-0 whitespace-nowrap"
                >
                  <Trash2 size={11} /> hapus acara
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
          <div className="text-sm font-semibold text-lime-300 mb-1 truncate">{eventName}</div>
        )}
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <span className="font-display text-3xl text-slate-50">
            {engine?.mexicano ? `RONDE ${currentRound + 1}` : `RONDE ${currentRound + 1} / ${totalRounds}`}
          </span>
          <div className="flex flex-wrap items-center gap-2">
            <Chip tone="amber">
              <Trophy size={11} />
              {scoreFormat === "tennis" ? `Race to ${tennisTarget} game` : `${pointTarget} Poin`}
            </Chip>
            {ended && <Chip tone="lime">Acara selesai</Chip>}
          </div>
          {hasSplitBill && (
            <button
              onClick={() => onNav("splitbill")}
              className="inline-flex items-center gap-1.5 text-xs font-semibold text-slate-950 bg-lime-300 rounded-full px-2.5 py-1"
            >
              <Wallet size={11} /> Lihat Split Bill
            </button>
          )}
        </div>
        {engine?.mexicano && (() => {
          // Look up whatever ranking was ACTUALLY locked in for the round
          // being viewed right now (currentRound) — not just whatever the
          // latest one happens to be. Older events saved before this
          // per-round history existed only have the single latest
          // `rankingSnapshot` field; for those, fall back to it so past
          // exports don't just show nothing.
          const viewedRanking = engine.rankingSnapshotByRound
            ? engine.rankingSnapshotByRound[currentRound]
            : currentRound === engine.roundsData.length - 1
            ? engine.rankingSnapshot
            : undefined;
          return (
            <div className="rounded-xl border border-cyan-400/30 bg-cyan-400/5 px-3 py-2.5 mb-3">
              <div className="flex items-center gap-1.5 mb-1.5">
                <Lock size={11} className="text-cyan-300" />
                <span className="text-[10px] font-semibold tracking-wide text-cyan-300 uppercase">
                  {viewedRanking ? `Klasemen terkunci Ronde ${currentRound + 1}` : "Ronde acak — belum ada klasemen"}
                </span>
              </div>
              {viewedRanking && (
                <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-slate-300">
                  {viewedRanking.map((id, i) => (
                    <span key={id}>
                      <span className="text-slate-500">{i + 1}.</span>{" "}
                      {engine.mexicanoUnit === "team"
                        ? engine.fixedTeams.find((t) => t.id === id)?.players.map((p) => playerMap[p]).join(" & ")
                        : playerMap[id]}
                    </span>
                  ))}
                </div>
              )}
            </div>
          );
        })()}
        <div className="flex flex-wrap items-center gap-2 mb-3">
          {canManage && !engine?.mexicano && (
            <button
              onClick={() => setShowAddMatch(true)}
              className="inline-flex items-center gap-1.5 text-xs font-semibold text-slate-950 bg-cyan-300 rounded-full px-3 py-1.5"
            >
              <Plus size={12} /> Tambah Match Manual
            </button>
          )}
          {canManage && !engine?.mexicano && (
            <button
              onClick={() => setShowAddAutoRound(true)}
              className="inline-flex items-center gap-1.5 text-xs font-semibold text-slate-950 bg-teal-300 rounded-full px-3 py-1.5"
            >
              <Shuffle size={12} /> Tambah Ronde Otomatis
            </button>
          )}
          {isOwner && (!engine?.mexicano || engine?.mexicanoUnit !== "team") && (
            <button
              onClick={() => setShowManagePlayers(true)}
              className="inline-flex items-center gap-1.5 text-xs font-semibold text-slate-950 bg-lime-300 rounded-full px-3 py-1.5"
            >
              <Users size={12} /> Kelola Pertandingan
            </button>
          )}
          {isOwner && (!engine?.mexicano || engine?.mexicanoUnit !== "team") && (
            <button
              onClick={() => setShowAttendance(true)}
              className="inline-flex items-center gap-1.5 text-xs font-semibold text-slate-950 bg-amber-300 rounded-full px-3 py-1.5"
            >
              <UserCircle2 size={12} /> Kedatangan Pemain
            </button>
          )}
        </div>
        {!engine?.mexicano && (
          <div className="h-1.5 bg-slate-800 rounded-full overflow-hidden mb-3">
            <div
              className="h-full bg-lime-300 rounded-full transition-all"
              style={{ width: `${pct * 100}%` }}
            />
          </div>
        )}
        {!engine?.mexicano && (
          <button
            onClick={() => setViewMode((v) => (v === "single" ? "all" : "single"))}
            className="flex items-center gap-1.5 text-xs font-semibold text-cyan-300"
          >
            <ListOrdered size={14} />
            {viewMode === "single" ? "Lihat semua ronde" : "Kembali ke tampilan ronde"}
          </button>
        )}
      </div>

      {viewMode === "all" ? (
        <AllRoundsList
          engine={engine}
          playerMap={playerMap}
          scores={scores}
          scoreFormat={scoreFormat}
          currentRound={currentRound}
          canManage={canManage}
          onDeleteRound={onDeleteRound}
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
          const openModal = canManage ? () => setScoreModal(cIdx) : undefined;
          return (
            <div key={cIdx} className="rounded-2xl border border-slate-800 overflow-hidden bg-slate-900/40">
              <div className="px-4 py-2 bg-slate-900 border-b border-slate-800 flex items-center justify-between">
                <span className="text-xs font-bold tracking-widest text-slate-400 uppercase">
                  {engine?.mexicano ? `Match ${cIdx + 1}` : `Lapangan ${cIdx + 1}`}
                </span>
                {isOwner && cIdx === 0 && !engine?.mexicano && (
                  <button
                    onClick={() => setShowDeleteRoundConfirm(true)}
                    className="text-slate-600 hover:text-red-400"
                    title="Hapus ronde ini"
                  >
                    <Trash2 size={13} />
                  </button>
                )}
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
                />
              )}

              {canManage && !isMatchScoreComplete(s) && (!engine?.mexicano || engine?.mexicanoUnit !== "team") && (
                <button
                  onClick={() => setEditingCourtIdx(cIdx)}
                  className="w-full flex items-center justify-center gap-1.5 py-2 text-xs font-semibold text-slate-400 border-t border-slate-800"
                >
                  <Pencil size={11} /> Edit Pemain
                </button>
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
          roundLabel={`Ronde ${currentRound + 1} – ${engine?.mexicano ? "Match" : "Lapangan"} ${scoreModal + 1}`}
          team1={round.courts[scoreModal].team1.map((id) => playerMap[id])}
          team2={round.courts[scoreModal].team2.map((id) => playerMap[id])}
          s={scores[`${currentRound}-${scoreModal}`] || {}}
          target={pointTarget}
          mode="points"
          onPick={(side, n) => setPointsPair(scoreModal, side, n)}
          onReset={() => resetPointsScore(scoreModal)}
          onClose={() => setScoreModal(null)}
        />
      )}

      {scoreModal !== null && scoreFormat === "tennis" && (
        <ScoreModal
          roundLabel={`Ronde ${currentRound + 1} – ${engine?.mexicano ? "Match" : "Lapangan"} ${scoreModal + 1}`}
          team1={round.courts[scoreModal].team1.map((id) => playerMap[id])}
          team2={round.courts[scoreModal].team2.map((id) => playerMap[id])}
          s={scores[`${currentRound}-${scoreModal}`] || {}}
          target={tennisTarget}
          mode="tennis"
          onPick={(side, n) => setTennisGamesDirect(scoreModal, side, n)}
          onReset={() => resetTennisMatch(scoreModal)}
          onClose={() => setScoreModal(null)}
        />
      )}

      {showAddMatch && (
        <AddMatchModal
          players={players}
          gameFormat={gameFormat}
          teamFormat={teamFormat}
          fixedPairs={fixedPairs}
          playerMap={playerMap}
          onConfirm={(team1Ids, team2Ids) => {
            onAddManualMatch(team1Ids, team2Ids);
            setShowAddMatch(false);
          }}
          onClose={() => setShowAddMatch(false)}
        />
      )}

      {showManagePlayers && (
        <ManagePlayersModal
          players={players}
          friends={friends || []}
          engine={engine}
          scores={scores}
          courts={courts}
          gameFormat={gameFormat}
          teamFormat={teamFormat}
          onConfirm={async (newPlayers, newCourts) => {
            await onAdjustSchedule(newPlayers, newCourts);
            setShowManagePlayers(false);
          }}
          onClose={() => setShowManagePlayers(false)}
        />
      )}

      {editingCourtIdx !== null && (
        <EditMatchPlayersModal
          round={round}
          courtIdx={editingCourtIdx}
          isMexicano={!!engine?.mexicano}
          scoredCourtIdxs={round.courts
            .map((c, i) => (isMatchScoreComplete(scores[`${currentRound}-${i}`]) ? i : null))
            .filter((i) => i !== null)}
          currentRosterIds={new Set(players.map((p) => p.id))}
          playerMap={playerMap}
          roundNumber={currentRound + 1}
          courtNumber={editingCourtIdx + 1}
          onConfirm={async (newTeam1, newTeam2, otherCourtChanges, regenerateRest) => {
            await onEditMatchPlayers(currentRound, editingCourtIdx, newTeam1, newTeam2, otherCourtChanges, regenerateRest);
            setEditingCourtIdx(null);
          }}
          onClose={() => setEditingCourtIdx(null)}
        />
      )}

      {showDeleteRoundConfirm && (
        <DeleteRoundModal
          roundNumber={currentRound + 1}
          onConfirm={async (regenerateRest) => {
            const ok = await onDeleteRound(currentRound, regenerateRest);
            if (ok) setShowDeleteRoundConfirm(false);
          }}
          onClose={() => setShowDeleteRoundConfirm(false)}
        />
      )}

      {showAttendance && (
        <AttendanceModal
          players={players}
          onToggle={onToggleArrival}
          onClose={() => setShowAttendance(false)}
        />
      )}

      {showAddAutoRound && (
        <AddAutoRoundModal
          totalRounds={totalRounds}
          onConfirm={(count) => {
            onAddAutoRound(count);
            setShowAddAutoRound(false);
          }}
          onClose={() => setShowAddAutoRound(false)}
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
          {isOwner && (!engine?.mexicano || engine?.mexicanoUnit !== "team") && (
            <button
              onClick={async () => {
                if (reshuffling) return;
                setReshuffling(true);
                try {
                  await onReshuffle();
                } finally {
                  setReshuffling(false);
                }
              }}
              disabled={reshuffling}
              className="inline-flex items-center justify-center gap-2 px-5 py-3 rounded-xl font-bold tracking-wide bg-amber-500 text-white active:scale-[0.98] transition-transform w-full disabled:opacity-50"
            >
              <Shuffle size={18} strokeWidth={2.5} className={reshuffling ? "animate-spin" : ""} />
              {reshuffling ? "Menyesuaikan…" : "Reshuffle"}
            </button>
          )}
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

function AllRoundsList({ engine, playerMap, scores, scoreFormat, currentRound, canManage, onDeleteRound, onJump }) {
  return (
    <div className="px-6 pt-6 pb-4 space-y-6">
      {engine.roundsData.map((rd, rIdx) => (
        <div key={rIdx}>
          <div className="flex items-center justify-between gap-2 mb-2">
            <div className="flex items-center gap-2">
              <span className="font-display text-2xl text-slate-100 tracking-wide">
                Ronde {rIdx + 1}
              </span>
              {rIdx === currentRound && <Chip tone="lime">Sekarang</Chip>}
            </div>
            {canManage && (
              <button
                onClick={() => {
                  if (
                    window.confirm(
                      `Hapus Ronde ${rIdx + 1}? Skor yang sudah diisi di ronde ini ikut hilang, dan ronde-ronde setelahnya bakal bergeser nomornya. Ronde lain tidak diubah.`
                    )
                  ) {
                    onDeleteRound(rIdx, false);
                  }
                }}
                className="w-7 h-7 rounded-full bg-slate-900 border border-slate-700 text-slate-500 hover:text-red-400 hover:border-red-400/50 flex items-center justify-center shrink-0"
              >
                <Trash2 size={13} />
              </button>
            )}
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
                  className="w-full rounded-xl border border-slate-800 bg-slate-900/40 px-3 py-3 flex flex-col items-center gap-1.5 text-center"
                >
                  <div className="text-[10px] text-slate-500 uppercase tracking-wide">
                    Lap. {cIdx + 1}
                  </div>
                  <div className="text-sm text-slate-200 leading-snug">
                    {match.team1.map((id) => playerMap[id]).join(" - ")}{" "}
                    <span className="text-slate-600">vs</span>{" "}
                    {match.team2.map((id) => playerMap[id]).join(" - ")}
                  </div>
                  <div
                    className={`font-mono2 text-sm ${
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
            : "bg-slate-900 text-white border-slate-700"
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

function PointsScorePicker({ valueA, valueB, target, onPick, team1Label, team2Label }) {
  const a = valueA !== undefined && valueA !== "" && valueA !== null ? Number(valueA) : null;
  const b = valueB !== undefined && valueB !== "" && valueB !== null ? Number(valueB) : null;
  const t = Math.max(1, Number(target) || 21);
  const nums = Array.from({ length: t + 1 }, (_, i) => i);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-center gap-3">
        <span className="font-mono2 text-3xl text-lime-300 w-10 text-center">{a ?? "–"}</span>
        <span className="text-slate-600 font-mono2">–</span>
        <span className="font-mono2 text-3xl text-lime-300 w-10 text-center">{b ?? "–"}</span>
      </div>

      <div className="grid grid-cols-2 gap-0 relative max-h-[50vh] overflow-y-auto">
        <div className="absolute left-1/2 top-0 bottom-0 w-px bg-slate-700" />
        <div className="pr-3">
          <div className="text-xs font-semibold text-white text-center mb-2 truncate sticky top-0 bg-slate-950 py-1">
            {team1Label || "tim kiri"}
          </div>
          <div className="grid grid-cols-3 gap-1.5">
            {nums.map((n) => (
              <button
                key={n}
                onClick={() => onPick("a", n)}
                className={`h-9 rounded-lg text-sm font-bold border ${
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
        <div className="pl-3">
          <div className="text-xs font-semibold text-white text-center mb-2 truncate sticky top-0 bg-slate-950 py-1">
            {team2Label || "tim kanan"}
          </div>
          <div className="grid grid-cols-3 gap-1.5">
            {nums.map((n) => (
              <button
                key={n}
                onClick={() => onPick("b", n)}
                className={`h-9 rounded-lg text-sm font-bold border ${
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
    </div>
  );
}

function ScoreModal({ roundLabel, team1, team2, s, target, mode = "points", onPick, onReset, onClose }) {
  const valueA = mode === "tennis" ? s.gamesA || 0 : s.a;
  const valueB = mode === "tennis" ? s.gamesB || 0 : s.b;
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
          <span className="font-semibold text-white">{team1.join(" - ")}</span>
          <span className="text-slate-600">vs</span>
          <span className="font-semibold text-white">{team2.join(" - ")}</span>
        </div>
        {mode === "tennis" && (
          <p className="text-[11px] text-slate-500 -mt-2 mb-4">
            Pilih jumlah game akhir (race to {target}). Progres poin per game (0/15/30/40) ikut
            direset ke 0-0.
          </p>
        )}

        <PointsScorePicker
          valueA={valueA}
          valueB={valueB}
          target={target}
          onPick={onPick}
          team1Label={team1.join(" - ")}
          team2Label={team2.join(" - ")}
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

// Lets host/co-host manually pick who plays in an extra bonus match — 2
// players tap-assigned to "Tim Kiri", 2 to "Tim Kanan". A player can only be
// on one side at a time.
function AddMatchModal({ players, gameFormat, teamFormat, fixedPairs, playerMap, onConfirm, onClose }) {
  const [team1, setTeam1] = useState([]);
  const [team2, setTeam2] = useState([]);
  const isFixedPartner = teamFormat === "fixed";

  const teams = React.useMemo(
    () => (fixedPairs || []).map((pair, i) => ({ ids: pair, name: pair.map((id) => playerMap?.[id] || id).join(" & ") })),
    [fixedPairs, playerMap]
  );

  const pickTeam = (side, ids) => {
    const already = side === "team1" ? team1 : team2;
    const sameTeam = already.length === 2 && already[0] === ids[0] && already[1] === ids[1];
    if (side === "team1") {
      setTeam1(sameTeam ? [] : ids);
      if (!sameTeam && team2.length === 2 && (team2[0] === ids[0] || team2[1] === ids[1])) setTeam2([]);
    } else {
      setTeam2(sameTeam ? [] : ids);
      if (!sameTeam && team1.length === 2 && (team1[0] === ids[0] || team1[1] === ids[1])) setTeam1([]);
    }
  };

  const toggle = (side, playerId) => {
    const inTeam1 = team1.includes(playerId);
    const inTeam2 = team2.includes(playerId);
    if (side === "team1") {
      if (inTeam1) {
        setTeam1(team1.filter((id) => id !== playerId));
      } else if (team1.length < 2) {
        setTeam2(team2.filter((id) => id !== playerId));
        setTeam1([...team1, playerId]);
      }
    } else {
      if (inTeam2) {
        setTeam2(team2.filter((id) => id !== playerId));
      } else if (team2.length < 2) {
        setTeam1(team1.filter((id) => id !== playerId));
        setTeam2([...team2, playerId]);
      }
    }
  };

  const canConfirm = team1.length === 2 && team2.length === 2;

  return (
    <div className="fixed inset-0 bg-black/70 z-50 flex items-end sm:items-center justify-center" onClick={onClose}>
      <div
        className="bg-slate-950 border border-slate-800 rounded-t-3xl sm:rounded-3xl w-full sm:max-w-sm max-h-[85vh] overflow-y-auto p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="text-xs font-semibold tracking-[0.15em] text-cyan-300 uppercase mb-1">
          Tambah Match Manual
        </div>
        <p className="text-xs text-slate-500 mb-4">
          {isFixedPartner
            ? "Pilih 1 tim buat Kiri dan 1 tim buat Kanan. Cocok kalau masih ada waktu tersisa setelah semua jadwal selesai dimainkan."
            : "Pilih 2 pemain buat Tim Kiri dan 2 pemain buat Tim Kanan. Cocok kalau masih ada waktu tersisa setelah semua jadwal selesai dimainkan."}
        </p>

        <div className="flex items-center justify-center gap-4 mb-4 text-xs">
          <div className="text-center">
            <div className="text-[10px] text-slate-500 uppercase mb-1">Tim Kiri</div>
            <div className="text-slate-200 font-semibold min-h-[18px]">
              {team1.map((id) => players.find((p) => p.id === id)?.name).join(" - ") || "—"}
            </div>
          </div>
          <span className="text-slate-600 font-display text-lg">VS</span>
          <div className="text-center">
            <div className="text-[10px] text-slate-500 uppercase mb-1">Tim Kanan</div>
            <div className="text-slate-200 font-semibold min-h-[18px]">
              {team2.map((id) => players.find((p) => p.id === id)?.name).join(" - ") || "—"}
            </div>
          </div>
        </div>

        {isFixedPartner ? (
          <div className="space-y-2 max-h-64 overflow-y-auto">
            {teams.map((t) => {
              const inTeam1 = team1.length === 2 && team1[0] === t.ids[0] && team1[1] === t.ids[1];
              const inTeam2 = team2.length === 2 && team2[0] === t.ids[0] && team2[1] === t.ids[1];
              return (
                <div
                  key={t.ids.join("-")}
                  className="flex items-center gap-2 rounded-xl border border-slate-800 bg-slate-900/50 px-3 py-2"
                >
                  <span className="font-semibold text-slate-100 flex-1 min-w-0 truncate text-sm">
                    {t.name}
                  </span>
                  <button
                    onClick={() => pickTeam("team1", t.ids)}
                    disabled={!inTeam1 && inTeam2}
                    className={`px-2.5 py-1 rounded-lg text-[11px] font-semibold border disabled:opacity-30 ${
                      inTeam1
                        ? "bg-lime-300 text-slate-950 border-lime-300"
                        : "bg-slate-900 text-slate-400 border-slate-700"
                    }`}
                  >
                    Kiri
                  </button>
                  <button
                    onClick={() => pickTeam("team2", t.ids)}
                    disabled={!inTeam2 && inTeam1}
                    className={`px-2.5 py-1 rounded-lg text-[11px] font-semibold border disabled:opacity-30 ${
                      inTeam2
                        ? "bg-cyan-300 text-slate-950 border-cyan-300"
                        : "bg-slate-900 text-slate-400 border-slate-700"
                    }`}
                  >
                    Kanan
                  </button>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="space-y-2 max-h-64 overflow-y-auto">
            {players.map((p) => {
              const inTeam1 = team1.includes(p.id);
              const inTeam2 = team2.includes(p.id);
              return (
                <div
                  key={p.id}
                  className="flex items-center gap-2 rounded-xl border border-slate-800 bg-slate-900/50 px-3 py-2"
                >
                  <span className="font-semibold text-slate-100 flex-1 min-w-0 truncate text-sm">
                    {p.name}
                  </span>
                  <button
                    onClick={() => toggle("team1", p.id)}
                    disabled={!inTeam1 && team1.length >= 2}
                    className={`px-2.5 py-1 rounded-lg text-[11px] font-semibold border disabled:opacity-30 ${
                      inTeam1
                        ? "bg-lime-300 text-slate-950 border-lime-300"
                        : "bg-slate-900 text-slate-400 border-slate-700"
                    }`}
                  >
                    Kiri
                  </button>
                  <button
                    onClick={() => toggle("team2", p.id)}
                    disabled={!inTeam2 && team2.length >= 2}
                    className={`px-2.5 py-1 rounded-lg text-[11px] font-semibold border disabled:opacity-30 ${
                      inTeam2
                        ? "bg-cyan-300 text-slate-950 border-cyan-300"
                        : "bg-slate-900 text-slate-400 border-slate-700"
                    }`}
                  >
                    Kanan
                  </button>
                </div>
              );
            })}
          </div>
        )}

        <div className="flex items-center gap-3 mt-5">
          <GhostButton onClick={onClose} className="flex-1">
            Batal
          </GhostButton>
          <PrimaryButton
            onClick={() => canConfirm && onConfirm(team1, team2)}
            disabled={!canConfirm}
            className="flex-1"
          >
            Tambahkan
          </PrimaryButton>
        </div>
      </div>
    </div>
  );
}

// Lets host/co-host add or remove players mid-match, then re-generate the
// remaining (not-yet-scored) rounds for the new roster — already-completed
// rounds are left untouched.
function ManagePlayersModal({ players, friends, engine, scores, courts, gameFormat, teamFormat, onConfirm, onClose }) {
  const [roster, setRoster] = useState(players);
  const [nameInput, setNameInput] = useState("");
  const [courtsValue, setCourtsValue] = useState(courts);
  const [saving, setSaving] = useState(false);
  const isFixedPartner = teamFormat === "fixed";

  const lockedCount = React.useMemo(() => {
    if (!engine) return 0;
    let count = 0;
    for (let rIdx = 0; rIdx < engine.roundsData.length; rIdx++) {
      const rd = engine.roundsData[rIdx];
      const allScored = rd.courts.every((_, cIdx) => {
        const s = (scores || {})[`${rIdx}-${cIdx}`];
        if (!s) return false;
        if (s.format === "tennis") return (s.gamesA || 0) > 0 || (s.gamesB || 0) > 0;
        return s.a !== undefined && s.a !== "" && s.b !== undefined && s.b !== "";
      });
      if (!allScored) break;
      count++;
    }
    return count;
  }, [engine, scores]);

  const totalRounds = engine ? engine.roundsData.length : 0;
  const remainingCount = totalRounds - lockedCount;
  const rosterChanged = roster.length !== players.length || roster.some((p, i) => players[i]?.id !== p.id);
  const courtsChanged = courtsValue !== courts;
  const changed = rosterChanged || courtsChanged;

  const removePlayer = (id) => setRoster(roster.filter((p) => p.id !== id));

  const addManual = () => {
    const name = nameInput.trim();
    if (!name) return;
    const dup = roster.some((p) => p.name.trim().toLowerCase() === name.toLowerCase());
    if (dup) {
      const confirmed = window.confirm(
        `"${name}" sudah ada di daftar. Tetap tambahkan sebagai orang yang berbeda? (Kalau maksudnya orang yang SAMA, batalkan ini — dia udah ada, cukup toggle kehadirannya kalau perlu.)`
      );
      if (!confirmed) return;
    }
    setRoster([...roster, { id: uid(), name }]);
    setNameInput("");
  };

  const addFriend = (f) => {
    if (roster.some((p) => p.accountId === f.accountId)) return;
    setRoster([...roster, { id: uid(), name: f.username, accountId: f.accountId }]);
  };

  const availableFriends = friends.filter((f) => !roster.some((p) => p.accountId === f.accountId));
  const maxUsableCourts = Math.max(1, Math.floor(roster.length / 4)) || 1;

  return (
    <div className="fixed inset-0 bg-black/70 z-50 flex items-end sm:items-center justify-center" onClick={saving ? undefined : onClose}>
      <div
        className="bg-slate-950 border border-slate-800 rounded-t-3xl sm:rounded-3xl w-full sm:max-w-sm max-h-[85vh] overflow-y-auto p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="text-xs font-semibold tracking-[0.15em] text-lime-300 uppercase mb-1">
          {isFixedPartner ? "Sesuaikan Lapangan" : "Kelola Pertandingan"}
        </div>
        <p className="text-xs text-slate-500 mb-4">
          {isFixedPartner
            ? "Mode Fixed Partner: daftar pasangan tetap nggak bisa diubah dari sini. Cuma jumlah lapangan yang bisa disesuaikan."
            : lockedCount > 0
            ? `${lockedCount} ronde yang sudah lengkap skornya akan tetap dipertahankan. ${remainingCount} ronde sisanya akan disusun ulang.`
            : `Semua ${totalRounds} ronde belum ada yang lengkap skornya, jadi seluruh jadwal akan disusun ulang.`}
        </p>

        <div className="text-[10px] text-slate-500 uppercase tracking-wide mb-1.5">
          Jumlah Lapangan
        </div>
        <div className="flex items-center gap-4 mb-4 rounded-xl border border-slate-800 bg-slate-900/50 px-4 py-3">
          <button
            onClick={() => setCourtsValue((c) => Math.max(1, c - 1))}
            className="w-9 h-9 rounded-lg bg-slate-800 border border-slate-700 text-slate-200 flex items-center justify-center font-bold text-lg shrink-0"
          >
            −
          </button>
          <span className="flex-1 text-center font-display text-2xl text-slate-100">
            {courtsValue}
          </span>
          <button
            onClick={() => setCourtsValue((c) => c + 1)}
            className="w-9 h-9 rounded-lg bg-slate-800 border border-slate-700 text-slate-200 flex items-center justify-center font-bold text-lg shrink-0"
          >
            +
          </button>
        </div>
        {courtsValue > maxUsableCourts && (
          <p className="text-amber-400 text-[11px] -mt-2 mb-4">
            Dengan {roster.length} pemain, cuma {maxUsableCourts} lapangan yang kepakai sekaligus
            per ronde — sisanya nganggur. Tambah pemain kalau mau pakai semua {courtsValue}{" "}
            lapangan.
          </p>
        )}

        {!isFixedPartner && (
          <>
            <div className="flex gap-2 mb-3">
              <input
                value={nameInput}
                onChange={(e) => setNameInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && addManual()}
                placeholder="Nama pemain baru (manual)"
                className="flex-1 min-w-0 bg-slate-900 border border-slate-700 rounded-lg px-3 py-2.5 text-sm placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-lime-400/50"
              />
              <button
                onClick={addManual}
                className="w-10 h-10 rounded-lg bg-lime-300 text-slate-950 flex items-center justify-center shrink-0"
              >
                <Plus size={16} strokeWidth={3} />
              </button>
            </div>

            {availableFriends.length > 0 && (
              <div className="mb-4">
                <div className="text-[10px] text-slate-500 uppercase tracking-wide mb-1.5">
                  Tambah dari teman
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {availableFriends.map((f) => (
                    <button
                      key={f.accountId}
                      onClick={() => addFriend(f)}
                      className="px-2.5 py-1 rounded-full text-xs font-semibold bg-slate-900 border border-slate-700 text-slate-300"
                    >
                      + {f.username}
                    </button>
                  ))}
                </div>
              </div>
            )}

            <div className="text-[10px] text-slate-500 uppercase tracking-wide mb-1.5">
              Daftar pemain ({roster.length})
            </div>
            <div className="space-y-2 max-h-56 overflow-y-auto mb-4">
              {roster.map((p) => (
                <div
                  key={p.id}
                  className="flex items-center gap-2 rounded-xl border border-slate-800 bg-slate-900/50 px-3 py-2"
                >
                  <span className="font-semibold text-slate-100 flex-1 min-w-0 truncate text-sm">
                    {p.name}
                  </span>
                  <button
                    onClick={() => removePlayer(p.id)}
                    className="w-7 h-7 rounded-full bg-slate-800 border border-slate-700 text-slate-400 hover:text-red-400 flex items-center justify-center shrink-0"
                  >
                    <X size={13} />
                  </button>
                </div>
              ))}
            </div>

            {roster.length < 4 && (
              <p className="text-amber-400 text-xs mb-3">Minimal 4 pemain diperlukan.</p>
            )}
          </>
        )}

        <div className="flex items-center gap-3">
          <GhostButton onClick={onClose} disabled={saving} className="flex-1">
            Batal
          </GhostButton>
          <PrimaryButton
            onClick={async () => {
              setSaving(true);
              try {
                await onConfirm(roster, courtsChanged ? courtsValue : undefined);
              } finally {
                setSaving(false);
              }
            }}
            disabled={roster.length < 4 || !changed || saving}
            className="flex-1"
          >
            {saving ? "Menyimpan…" : isFixedPartner ? "Sesuaikan Lapangan" : "Sesuaikan Jadwal"}
          </PrimaryButton>
        </div>
      </div>
    </div>
  );
}

// Lets host/co-host mark who's actually shown up. Toggling someone to
// "belum datang" immediately reshuffles the not-yet-scored rounds to only
// include arrived players; toggling them back to "sudah datang" slots them
// back into the rotation fairly. Nobody is removed from the list.
// HOST/CO-HOST: lets the host manually swap someone out of an upcoming
// (not-yet-scored) match for someone currently resting that same round.
// Two-step flow: (1) pick which slot(s) to swap and with whom, (2) decide
// whether every round AFTER this one should be regenerated to reflect the
// change, or left exactly as-is.
function EditMatchPlayersModal({ round, courtIdx, isMexicano, scoredCourtIdxs, currentRosterIds, playerMap, roundNumber, courtNumber, onConfirm, onClose }) {
  // Slots are fixed positions: 0-1 = Tim Kiri (team1), 2-3 = Tim Kanan (team2).
  const originalMatch = round.courts[courtIdx];
  const originalFour = [...originalMatch.team1, ...originalMatch.team2];
  const [assignment, setAssignment] = useState(originalFour); // this court's 4 slots
  // Deep-copyable snapshot of every OTHER court this round that ISN'T
  // already scored, so pulling someone in from a different court (not just
  // from resting) works too — "all player tersedia" means literally
  // everyone active this round who's eligible, not just whoever's resting.
  // Courts that already have a recorded score are deliberately left out —
  // pulling from one of those would silently change who a real result
  // belongs to.
  const [otherCourts, setOtherCourts] = useState(() =>
    round.courts.map((c, i) =>
      i === courtIdx || scoredCourtIdxs.includes(i) ? null : { team1: [...c.team1], team2: [...c.team2] }
    )
  );
  const [pickerFor, setPickerFor] = useState(null); // slot index currently choosing a replacement, or null
  const [step, setStep] = useState("pick"); // pick | confirm
  const [saving, setSaving] = useState(false);

  const everyoneOnAnyCourt = new Set([
    ...assignment,
    ...otherCourts.flatMap((c) => (c ? [...c.team1, ...c.team2] : [])),
  ]);
  // Anyone who could go into a given slot: the OTHER 3 people currently in
  // this same match, whoever's resting this round, and whoever's playing a
  // different (not-yet-scored) court — everyone genuinely eligible, not
  // just the resting pool.
  const pickableForSlot = (slotIdx) => {
    const withinMatch = assignment.filter((_, i) => i !== slotIdx);
    const otherCourtPlayers = otherCourts.flatMap((c) => (c ? [...c.team1, ...c.team2] : []));
    const pool = [...new Set([...withinMatch, ...round.resting, ...otherCourtPlayers])];
    // Defensive filter: a round's resting/court data is baked in at
    // generation time and can go stale if someone gets deleted from the
    // roster afterward without every unscored round having a chance to
    // regenerate — don't offer someone who's no longer actually part of
    // the event.
    return currentRosterIds ? pool.filter((id) => currentRosterIds.has(id)) : pool;
  };
  const changed =
    assignment.some((id, i) => id !== originalFour[i]) ||
    otherCourts.some((c, i) => c && (c.team1[0] !== round.courts[i].team1[0] || c.team1[1] !== round.courts[i].team1[1] || c.team2[0] !== round.courts[i].team2[0] || c.team2[1] !== round.courts[i].team2[1]));
  // For Americano, nobody should ever appear twice across this round's
  // matches. For Mexicano, that's not true — someone getting a second
  // ("extra") match within the same round-batch is the normal, intentional
  // way uneven player counts get handled, not an error. So the allowed
  // occurrence count differs: exactly 1 for Americano, up to 2 for
  // Mexicano — anything beyond that is a genuine problem either way.
  const occurrenceCounts = {};
  [...assignment, ...otherCourts.flatMap((c) => (c ? [...c.team1, ...c.team2] : []))].forEach((id) => {
    occurrenceCounts[id] = (occurrenceCounts[id] || 0) + 1;
  });
  const maxAllowedOccurrences = isMexicano ? 2 : 1;
  const hasDuplicate = Object.values(occurrenceCounts).some((c) => c > maxAllowedOccurrences);

  const whichCourtHas = (id) => {
    for (let i = 0; i < otherCourts.length; i++) {
      const c = otherCourts[i];
      if (!c) continue;
      if (c.team1.includes(id)) return { i, side: "team1", pos: c.team1.indexOf(id) };
      if (c.team2.includes(id)) return { i, side: "team2", pos: c.team2.indexOf(id) };
    }
    return null;
  };

  const handlePick = (slotIdx, pickedId) => {
    const displaced = assignment[slotIdx];
    // Picked someone already in a DIFFERENT slot of THIS SAME match — swap
    // the two positions directly (e.g. trading someone from Tim Kiri to
    // Tim Kanan and vice versa).
    const withinIdx = assignment.indexOf(pickedId);
    if (withinIdx !== -1 && withinIdx !== slotIdx) {
      setAssignment((prev) => {
        const next = [...prev];
        next[withinIdx] = displaced;
        next[slotIdx] = pickedId;
        return next;
      });
      setPickerFor(null);
      return;
    }
    // Picked someone playing a DIFFERENT court — pull them in, and put
    // whoever was in this slot into the spot they're vacating, so that
    // other court still ends up with exactly 4 players too.
    const foundElsewhere = whichCourtHas(pickedId);
    if (foundElsewhere) {
      setOtherCourts((prev) => {
        const next = [...prev];
        const court = { team1: [...next[foundElsewhere.i].team1], team2: [...next[foundElsewhere.i].team2] };
        court[foundElsewhere.side][foundElsewhere.pos] = displaced;
        next[foundElsewhere.i] = court;
        return next;
      });
    }
    setAssignment((prev) => {
      const next = [...prev];
      next[slotIdx] = pickedId;
      return next;
    });
    setPickerFor(null);
  };

  const handleFinalConfirm = async (regenerateRest) => {
    setSaving(true);
    try {
      const otherCourtChanges = otherCourts
        .map((c, i) => (c ? { courtIdx: i, team1: c.team1, team2: c.team2 } : null))
        .filter(Boolean);
      // Awaited so the modal stays open (with a visible "menyimpan" state)
      // until the change is actually confirmed saved — closing immediately
      // would let the host navigate away while the write is still
      // in-flight, risking the edit getting silently reverted if they
      // reopen the event before it lands.
      await onConfirm(
        [assignment[0], assignment[1]],
        [assignment[2], assignment[3]],
        otherCourtChanges,
        regenerateRest
      );
    } finally {
      setSaving(false);
    }
  };

  const renderSlot = (slotIdx) => {
    const currentId = assignment[slotIdx];
    const isChanged = currentId !== originalFour[slotIdx];
    return (
      <div key={slotIdx}>
        <div className="flex items-center justify-between gap-2 rounded-xl border border-slate-800 bg-slate-900/50 px-4 py-3">
          <div className="min-w-0">
            {isChanged ? (
              <>
                <span className="text-[11px] text-slate-500 line-through block">
                  {playerMap[originalFour[slotIdx]]}
                </span>
                <span className="font-semibold text-lime-300 truncate block">
                  {playerMap[currentId]}
                </span>
              </>
            ) : (
              <span className="font-semibold text-slate-100 truncate block">
                {playerMap[currentId]}
              </span>
            )}
          </div>
          <button
            onClick={() => setPickerFor(pickerFor === slotIdx ? null : slotIdx)}
            className={`px-3 py-1.5 rounded-full text-xs font-semibold shrink-0 ${
              isChanged
                ? "bg-slate-800 border border-slate-700 text-slate-300"
                : "bg-lime-300 text-slate-950"
            }`}
          >
            {isChanged ? "Ganti Lagi" : "Ganti"}
          </button>
        </div>
        {pickerFor === slotIdx && (() => {
          const options = pickableForSlot(slotIdx);
          return (
            <div className="edit-pemain-scroll mt-1.5 ml-2 space-y-1.5 border-l-2 border-slate-800 pl-3 max-h-40 overflow-y-auto">
              {options.length === 0 ? (
                <p className="text-[11px] text-slate-600 py-1">Nggak ada orang lain buat ditukar.</p>
              ) : (
                options.map((id) => {
                  const elsewhere = whichCourtHas(id);
                  const isInThisMatch = assignment.includes(id);
                  return (
                    <button
                      key={id}
                      onClick={() => handlePick(slotIdx, id)}
                      className="block w-full text-left text-sm text-slate-200 py-1.5"
                    >
                      → {playerMap[id]}
                      {elsewhere && (
                        <span className="text-[10px] text-slate-500">
                          {" "}
                          (main di Lap.{elsewhere.i + 1})
                        </span>
                      )}
                      {isInThisMatch && (
                        <span className="text-[10px] text-slate-500"> (tukar posisi)</span>
                      )}
                    </button>
                  );
                })
              )}
            </div>
          );
        })()}
      </div>
    );
  };

  return (
    <div className="fixed inset-0 bg-black/70 z-50 flex items-end sm:items-center justify-center" onClick={saving ? undefined : onClose}>
      <div
        className="bg-slate-950 border border-slate-800 rounded-t-3xl sm:rounded-3xl w-full sm:max-w-sm max-h-[85vh] overflow-y-auto p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="text-xs font-semibold tracking-[0.15em] text-amber-300 uppercase mb-1">
          Edit Pemain — Ronde {roundNumber}, Lap.{courtNumber}
        </div>

        {step === "pick" && (
          <>
            <p className="text-xs text-slate-500 mb-4">
              Tap salah satu pemain buat ganti — semua orang di ronde ini tersedia, baik yang lagi
              istirahat maupun yang main di lapangan lain.
            </p>
            <div className="mb-4">
              <div className="text-[10px] font-bold tracking-widest text-cyan-300 uppercase mb-1.5 pl-1">
                Tim Kiri
              </div>
              <div className="space-y-2 rounded-2xl border border-cyan-400/20 bg-cyan-400/[0.03] p-2">
                {renderSlot(0)}
                {renderSlot(1)}
              </div>
            </div>
            <div className="mb-4">
              <div className="text-[10px] font-bold tracking-widest text-orange-300 uppercase mb-1.5 pl-1">
                Tim Kanan
              </div>
              <div className="space-y-2 rounded-2xl border border-orange-400/20 bg-orange-400/[0.03] p-2">
                {renderSlot(2)}
                {renderSlot(3)}
              </div>
            </div>
            {otherCourts.some((c) => c) && (
              <p className="text-[11px] text-slate-600 mb-3">
                Kalau kamu tarik orang dari lapangan lain, orang yang digeser otomatis ngisi
                posisinya di lapangan itu — nggak akan ada yang kelewatan.
              </p>
            )}
            {hasDuplicate && (
              <p className="text-[11px] text-red-400 mb-3">
                ⚠️ Ada nama yang kepilih dobel — nggak bisa lanjut. Coba tap "Ganti Lagi" di slot
                yang bermasalah.
              </p>
            )}
            <div className="flex gap-2">
              <button
                onClick={onClose}
                className="flex-1 py-2.5 rounded-xl text-sm font-semibold bg-slate-900 border border-slate-700 text-slate-300"
              >
                Batal
              </button>
              <button
                onClick={() => setStep("confirm")}
                disabled={!changed || hasDuplicate}
                className="flex-1 py-2.5 rounded-xl text-sm font-semibold bg-lime-300 text-slate-950 disabled:opacity-40"
              >
                Lanjut
              </button>
            </div>
          </>
        )}

        {step === "confirm" && (
          <>
            <p className="text-xs text-slate-500 mb-4">
              Ronde-ronde SETELAH ronde {roundNumber} ini mau disesuaikan juga biar tetap adil dan
              variatif berdasarkan perubahan ini, atau dibiarkan seperti semula?
            </p>
            <div className="space-y-2">
              <button
                onClick={() => handleFinalConfirm(true)}
                disabled={saving}
                className="w-full text-left rounded-xl border border-lime-400/40 bg-lime-400/5 px-4 py-3 disabled:opacity-50"
              >
                <div className="font-semibold text-lime-300 text-sm">
                  {saving ? "Menyimpan…" : "Ya, sesuaikan ronde sisanya"}
                </div>
                <div className="text-[11px] text-slate-500 mt-0.5">
                  Ronde setelah ini digenerate ulang, mempertimbangkan histori baru dari perubahan
                  tadi.
                </div>
              </button>
              <button
                onClick={() => handleFinalConfirm(false)}
                disabled={saving}
                className="w-full text-left rounded-xl border border-slate-700 bg-slate-900/50 px-4 py-3 disabled:opacity-50"
              >
                <div className="font-semibold text-slate-200 text-sm">
                  {saving ? "Menyimpan…" : "Tidak, jangan ubah ronde lainnya"}
                </div>
                <div className="text-[11px] text-slate-500 mt-0.5">
                  Cuma match ronde {roundNumber} ini yang berubah, ronde-ronde lain tetap seperti
                  semula.
                </div>
              </button>
            </div>
            <button
              onClick={() => setStep("pick")}
              disabled={saving}
              className="w-full mt-3 py-2 text-xs font-semibold text-slate-500 disabled:opacity-50"
            >
              ← Kembali
            </button>
          </>
        )}
      </div>
    </div>
  );
}

// HOST-ONLY: confirms deleting the currently-viewed round, offering the same
// "regenerate what comes after, or leave it alone" choice as manually
// editing a match's players.
function DeleteRoundModal({ roundNumber, onConfirm, onClose }) {
  const [saving, setSaving] = useState(false);
  const handle = async (regenerateRest) => {
    setSaving(true);
    try {
      await onConfirm(regenerateRest);
    } finally {
      setSaving(false);
    }
  };
  return (
    <div
      className="fixed inset-0 bg-black/70 z-50 flex items-end sm:items-center justify-center"
      onClick={saving ? undefined : onClose}
    >
      <div
        className="bg-slate-950 border border-slate-800 rounded-t-3xl sm:rounded-3xl w-full sm:max-w-sm max-h-[85vh] overflow-y-auto p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="text-xs font-semibold tracking-[0.15em] text-red-300 uppercase mb-1">
          Hapus Ronde {roundNumber}
        </div>
        <p className="text-xs text-slate-500 mb-4">
          Skor yang sudah diisi di ronde ini ikut hilang, dan ronde-ronde setelahnya bakal bergeser
          nomornya. Ronde-ronde SETELAH ronde {roundNumber} ini mau disesuaikan juga biar tetap adil
          dan variatif, atau dibiarkan seperti semula?
        </p>
        <div className="space-y-2">
          <button
            onClick={() => handle(true)}
            disabled={saving}
            className="w-full text-left rounded-xl border border-lime-400/40 bg-lime-400/5 px-4 py-3 disabled:opacity-50"
          >
            <div className="font-semibold text-lime-300 text-sm">
              {saving ? "Menghapus…" : "Ya, sesuaikan ronde sisanya"}
            </div>
            <div className="text-[11px] text-slate-500 mt-0.5">
              Ronde setelah ini digenerate ulang, mempertimbangkan histori baru dari penghapusan ini.
            </div>
          </button>
          <button
            onClick={() => handle(false)}
            disabled={saving}
            className="w-full text-left rounded-xl border border-slate-700 bg-slate-900/50 px-4 py-3 disabled:opacity-50"
          >
            <div className="font-semibold text-slate-200 text-sm">
              {saving ? "Menghapus…" : "Tidak, jangan ubah ronde lainnya"}
            </div>
            <div className="text-[11px] text-slate-500 mt-0.5">
              Ronde-ronde lain tetap seperti semula, cuma nomornya bergeser.
            </div>
          </button>
        </div>
        <button
          onClick={onClose}
          disabled={saving}
          className="w-full mt-3 py-2 text-xs font-semibold text-slate-500 disabled:opacity-50"
        >
          Batal
        </button>
      </div>
    </div>
  );
}


function JoinConfirmModal({ eventData, onConfirm, onCancel }) {
  const [submitting, setSubmitting] = useState(false);
  const gameFormatLabel = eventData.gameFormat === "mexicano" ? "Mexicano" : "Americano";
  const teamFormatLabel = eventData.teamFormat === "fixed" ? "Fixed Partner" : "Rotating";
  const scoreLabel =
    eventData.scoreFormat === "tennis"
      ? `Race to ${eventData.tennisTarget || 4} Game`
      : `Total Poin (target ${eventData.pointTarget || 21})`;
  const arrivedPlayers = (eventData.players || []).filter((p) => p.arrived !== false);
  const playerCount = arrivedPlayers.length;

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="w-full sm:max-w-sm bg-slate-900 border border-slate-700 rounded-t-3xl sm:rounded-3xl p-6 max-h-[85vh] overflow-y-auto">
        <div className="flex items-center gap-2 mb-1">
          <Link2 size={16} className="text-cyan-300" />
          <span className="text-[11px] font-semibold tracking-wide text-cyan-300 uppercase">
            Konfirmasi Gabung Acara
          </span>
        </div>
        <h2 className="font-display text-3xl text-slate-50 mb-3">{eventData.name || "Sesi Padel"}</h2>
        <div className="space-y-2 mb-4 text-sm">
          <div className="flex items-center justify-between text-slate-300">
            <span className="text-slate-500">Host</span>
            <span className="font-semibold">{eventData.ownerUsername || "-"}</span>
          </div>
          <div className="flex items-center justify-between text-slate-300">
            <span className="text-slate-500">Tanggal</span>
            <span className="font-semibold">{eventData.playDate || "-"}</span>
          </div>
          <div className="flex items-center justify-between text-slate-300">
            <span className="text-slate-500">Format</span>
            <span className="font-semibold">
              {gameFormatLabel} · {teamFormatLabel}
            </span>
          </div>
          <div className="flex items-center justify-between text-slate-300">
            <span className="text-slate-500">Skor</span>
            <span className="font-semibold">{scoreLabel}</span>
          </div>
        </div>
        <div className="mb-5">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs text-slate-500">Sudah gabung</span>
            <span className="text-sm font-bold text-lime-300">{playerCount} orang</span>
          </div>
          {playerCount > 0 ? (
            <div className="flex flex-wrap gap-1.5">
              {arrivedPlayers.map((p) => (
                <span
                  key={p.id}
                  className="text-xs font-semibold text-slate-200 bg-slate-800 border border-slate-700 rounded-full px-2.5 py-1"
                >
                  {p.name}
                </span>
              ))}
            </div>
          ) : (
            <p className="text-xs text-slate-600">Belum ada yang gabung.</p>
          )}
        </div>
        <p className="text-xs text-slate-500 mb-5">
          Kamu bakal masuk daftar permintaan gabung — host perlu approve dulu sebelum kamu resmi jadi peserta.
        </p>
        <div className="flex gap-2">
          <button
            onClick={onCancel}
            disabled={submitting}
            className="flex-1 py-3 rounded-xl font-semibold text-slate-300 border border-slate-700 disabled:opacity-50"
          >
            Batal
          </button>
          <button
            onClick={async () => {
              setSubmitting(true);
              await onConfirm();
            }}
            disabled={submitting}
            className="flex-1 py-3 rounded-xl font-bold text-slate-950 bg-lime-300 disabled:opacity-50"
          >
            {submitting ? "Memproses…" : "Ya, Gabung"}
          </button>
        </div>
      </div>
    </div>
  );
}

function AttendanceModal({ players, onToggle, onClose }) {
  const arrivedCount = players.filter((p) => p.arrived !== false).length;
  const [togglingId, setTogglingId] = useState(null); // which player's toggle is currently in-flight
  const handleToggle = async (id) => {
    if (togglingId) return; // one in flight at a time — prevents the confusing "did that register?" double-tap
    setTogglingId(id);
    try {
      await onToggle(id);
    } finally {
      setTogglingId(null);
    }
  };
  return (
    <div className="fixed inset-0 bg-black/70 z-50 flex items-end sm:items-center justify-center" onClick={togglingId ? undefined : onClose}>
      <div
        className="bg-slate-950 border border-slate-800 rounded-t-3xl sm:rounded-3xl w-full sm:max-w-sm max-h-[85vh] overflow-y-auto p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="text-xs font-semibold tracking-[0.15em] text-amber-300 uppercase mb-1">
          Kedatangan Pemain
        </div>
        <p className="text-xs text-slate-500 mb-4">
          Default-nya semua dianggap sudah datang. Tandai "Belum Datang" buat yang telat — ronde
          yang belum ada skornya otomatis disusun ulang cuma buat yang sudah hadir. Begitu mereka
          datang, tandai balik "Sudah Datang" untuk masuk rotasi lagi.
        </p>
        <p className="text-[11px] text-slate-400 mb-3">
          {arrivedCount} dari {players.length} pemain sudah datang.
        </p>

        <div className="space-y-2">
          {players.map((p) => {
            const arrived = p.arrived !== false;
            const isToggling = togglingId === p.id;
            return (
              <div
                key={p.id}
                className={`flex items-center justify-between gap-3 rounded-xl border px-4 py-3 ${
                  arrived ? "border-slate-800 bg-slate-900/50" : "border-amber-400/40 bg-amber-400/5"
                }`}
              >
                <span className="font-semibold text-slate-100 truncate">{p.name}</span>
                <button
                  onClick={() => handleToggle(p.id)}
                  disabled={!!togglingId}
                  className={`px-3 py-1.5 rounded-full text-xs font-semibold shrink-0 disabled:opacity-50 ${
                    arrived
                      ? "bg-lime-300 text-slate-950"
                      : "bg-slate-800 border border-amber-400/60 text-amber-300"
                  }`}
                >
                  {isToggling ? "Menyimpan…" : arrived ? "Sudah Datang" : "Belum Datang"}
                </button>
              </div>
            );
          })}
        </div>

        <PrimaryButton onClick={onClose} disabled={!!togglingId} className="w-full mt-5">
          Tutup
        </PrimaryButton>
      </div>
    </div>
  );
}

// Asks how many extra fairness-optimized rounds to auto-generate at once
// (default 1) — for when there's still time left after the planned
// schedule is done.
function AddAutoRoundModal({ totalRounds, onConfirm, onClose }) {
  const [count, setCount] = useState(1);
  const firstNew = totalRounds + 1;
  const lastNew = totalRounds + count;

  return (
    <div className="fixed inset-0 bg-black/70 z-50 flex items-end sm:items-center justify-center" onClick={onClose}>
      <div
        className="bg-slate-950 border border-slate-800 rounded-t-3xl sm:rounded-3xl w-full sm:max-w-sm p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="text-xs font-semibold tracking-[0.15em] text-teal-300 uppercase mb-1">
          Tambah Ronde Otomatis
        </div>
        <p className="text-xs text-slate-500 mb-4">
          Bisa dipakai kapan saja — nggak peduli masih ada ronde yang belum jalan atau semuanya
          sudah kelar. Sistem yang pilihin pasangan & lawannya, tetap adil dan nyambung dari
          histori yang sudah ada. Ronde yang ada sekarang tidak berubah sama sekali.
        </p>

        <div className="flex items-center gap-4 mb-3 rounded-xl border border-slate-800 bg-slate-900/50 px-4 py-3">
          <button
            onClick={() => setCount((c) => Math.max(1, c - 1))}
            className="w-10 h-10 rounded-lg bg-slate-800 border border-slate-700 text-slate-200 flex items-center justify-center font-bold text-lg shrink-0"
          >
            −
          </button>
          <span className="flex-1 text-center font-display text-3xl text-slate-100">{count}</span>
          <button
            onClick={() => setCount((c) => Math.min(50, c + 1))}
            className="w-10 h-10 rounded-lg bg-slate-800 border border-slate-700 text-slate-200 flex items-center justify-center font-bold text-lg shrink-0"
          >
            +
          </button>
        </div>

        <p className="text-[11px] text-teal-300 mb-5 text-center">
          Akan ditambahkan berurutan di paling akhir:{" "}
          {count > 1 ? `Ronde ${firstNew}–${lastNew}` : `Ronde ${firstNew}`}
        </p>

        <div className="flex items-center gap-3">
          <GhostButton onClick={onClose} className="flex-1">
            Batal
          </GhostButton>
          <PrimaryButton onClick={() => onConfirm(count)} className="flex-1">
            Tambahkan {count} Ronde
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

function TennisScoreTracker({ s, target, onPoint, onReset, readOnly }) {
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
      {!readOnly && (
        <p className="px-4 pb-3 text-[11px] text-slate-500">
          Tap angka skor di atas buat langsung pilih jumlah game akhir (race to {target}).
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// LEADERBOARD / STANDINGS SCREEN
// ---------------------------------------------------------------------------

function LeaderboardScreen({ eventName, leaderboard, players, gameFormat, teamFormat, fixedPairs, ended, hasSplitBill, onNav, onBackToLobby }) {
  const [sortBy, setSortBy] = useState("winPercent"); // wins | diff | winPercent | ppm
  const [showNotArrived, setShowNotArrived] = useState(true);

  const notArrivedIds = React.useMemo(() => {
    const notArrivedPlayerIds = new Set((players || []).filter((p) => p.arrived === false).map((p) => p.id));
    if (gameFormat !== "fixed_partner") return notArrivedPlayerIds;
    // A team counts as "not arrived" if either half of the pair isn't —
    // there's no substitute partner in this mode, so the whole team sits
    // out together.
    const teamIds = new Set();
    (fixedPairs || []).forEach(([a, b], i) => {
      if (notArrivedPlayerIds.has(a) || notArrivedPlayerIds.has(b)) {
        teamIds.add(`team_${i}_${a}_${b}`);
      }
    });
    return teamIds;
  }, [players, gameFormat, fixedPairs]);
  const visibleLeaderboard = React.useMemo(
    () => (showNotArrived ? leaderboard : leaderboard.filter((p) => !notArrivedIds.has(p.id))),
    [leaderboard, showNotArrived, notArrivedIds]
  );

  const sorted = React.useMemo(() => {
    const arr = [...visibleLeaderboard];
    if (sortBy === "wins") {
      arr.sort((x, y) => y.wins - x.wins || y.diff - x.diff || y.winPercent - x.winPercent || y.points - x.points);
    } else if (sortBy === "diff") {
      arr.sort((x, y) => y.diff - x.diff || y.wins - x.wins || y.winPercent - x.winPercent || y.points - x.points);
    } else if (sortBy === "winPercent") {
      arr.sort((x, y) => y.winPercent - x.winPercent || y.wins - x.wins || y.diff - x.diff);
    } else {
      arr.sort((x, y) => y.points - x.points || y.wins - x.wins || y.diff - x.diff);
    }
    return arr;
  }, [visibleLeaderboard, sortBy]);

  // Standard competition ranking ("1224"): players who are exactly equal on
  // every criterion share the same rank number, and the next distinct player
  // skips ahead — e.g. two players tied at rank 3 are both shown as 3, and
  // the one after them is 5, not 4.
  const ranks = React.useMemo(() => computeTiedRanks(sorted), [sorted]);

  // Column that matches the active sort criterion always renders last (rightmost)
  // and gets highlighted, so it's obvious what the table is currently ordered by.
  const baseColumns = [
    { key: "wlt", sortKey: "wins", label: "W-L-T", render: (p) => `${p.wins}-${p.losses}-${p.ties}` },
    { key: "diff", sortKey: "diff", label: "+/-", render: (p) => (p.diff > 0 ? `+${p.diff}` : `${p.diff}`) },
    { key: "winPercent", sortKey: "winPercent", label: "Win%", render: (p) => `${Math.round(p.winPercent)}%` },
    { key: "ppm", sortKey: "points", label: "P", render: (p) => p.points },
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
        {eventName && <div className="text-sm font-semibold text-lime-300 mb-1">{eventName}</div>}
        {ended && (
          <div className="flex items-center gap-2 mb-1">
            <Chip tone="lime">Selesai</Chip>
          </div>
        )}
        <h1 className="font-display text-5xl text-slate-50">KLASEMEN</h1>
        <p className="text-slate-500 text-sm mt-2">Tap salah satu tombol untuk urutkan.</p>

        <div className="flex flex-wrap gap-2 mt-4">
          {[
            { key: "winPercent", label: "Win%" },
            { key: "wins", label: "W-L-T" },
            { key: "diff", label: "Selisih Poin" },
            { key: "ppm", label: "Total Poin" },
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

        {notArrivedIds.size > 0 && (
          <button
            onClick={() => setShowNotArrived((v) => !v)}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold border mt-2 ${
              showNotArrived
                ? "bg-slate-900 text-slate-400 border-slate-700"
                : "bg-amber-400/10 text-amber-300 border-amber-400/40"
            }`}
          >
            {showNotArrived ? <Eye size={12} /> : <UserCircle2 size={12} />}
            {showNotArrived
              ? `Tampilkan semua (termasuk ${notArrivedIds.size} yang tidak hadir)`
              : `Sembunyikan yang tidak hadir (${notArrivedIds.size})`}
          </button>
        )}
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
              <tr className="text-[9px] text-white uppercase tracking-wide">
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
                  className={`border-t border-slate-800 ${ranks[i] === 1 ? "bg-lime-400/5" : ""}`}
                >
                  <td
                    className={`py-2.5 text-center font-display text-base ${
                      ranks[i] === 1 ? "text-lime-300" : ranks[i] === 2 ? "text-slate-300" : "text-slate-500"
                    }`}
                  >
                    {ranks[i]}
                  </td>
                  <td className="py-2.5 font-semibold text-slate-100 truncate text-[13px]">
                    {p.name}
                  </td>
                  <td className="py-2.5 text-center font-mono2 text-[11px] text-white">
                    {p.matches}
                  </td>
                  {columns.map((c) => (
                    <td
                      key={c.key}
                      className={`py-2.5 pl-1 text-right font-mono2 text-[11px] whitespace-nowrap ${
                        c.key === activeColKey ? "text-lime-300 font-bold" : "text-white"
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
          <div className="mt-4 pt-4 border-t border-slate-800 space-y-1 text-[11px] text-white">
            <div><span className="text-lime-300 font-semibold">M</span> — jumlah match dimainkan</div>
            <div><span className="text-lime-300 font-semibold">W-L-T</span> — menang-kalah-seri</div>
            <div><span className="text-lime-300 font-semibold">+/-</span> — selisih poin (poin dapat − poin lawan)</div>
            <div><span className="text-lime-300 font-semibold">Win%</span> — persentase match dimenangkan</div>
            <div><span className="text-lime-300 font-semibold">P</span> — Total Poin: jumlah semua poin yang dihasilkan sepanjang acara</div>
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

function SplitBillScreen({
  eventName, players, courtCost, adminFee, ballCost,
  isOwner, canManage, onUpdateCosts,
  currentAccountId, paymentPersonId, onSetPaymentPerson,
  paymentInfo, onSavePaymentInfo,
  paidStatus, onTogglePaid,
  onNav, onBackToLobby,
}) {
  const court = Number(courtCost) || 0;
  const admin = Number(adminFee) || 0;
  const ball = Number(ballCost) || 0;
  const total = court + admin + ball;
  const n = players.length || 1;
  const perPerson = Math.ceil(total / n);

  const [editingCosts, setEditingCosts] = useState(false);
  const [draftCourt, setDraftCourt] = useState(courtCost);
  const [draftAdmin, setDraftAdmin] = useState(adminFee);
  const [draftBall, setDraftBall] = useState(ballCost);
  const [costsSaved, setCostsSaved] = useState(false);

  const startEditingCosts = () => {
    setDraftCourt(courtCost);
    setDraftAdmin(adminFee);
    setDraftBall(ballCost);
    setCostsSaved(false);
    setEditingCosts(true);
  };
  const saveCosts = () => {
    onUpdateCosts(draftCourt, draftAdmin, draftBall);
    setEditingCosts(false);
    setCostsSaved(true);
    setTimeout(() => setCostsSaved(false), 2000);
  };

  const paymentPerson = players.find((p) => p.id === paymentPersonId) || null;
  const canEditPayment =
    isOwner || (paymentPerson?.accountId && paymentPerson.accountId === currentAccountId);

  const [draftInfo, setDraftInfo] = useState(paymentInfo && paymentInfo.length ? paymentInfo : []);
  const [editingPayment, setEditingPayment] = useState(false);

  const addEntry = () => {
    if (draftInfo.length >= 2) return;
    setDraftInfo([...draftInfo, { platform: "", number: "" }]);
  };
  const updateEntry = (idx, field, value) => {
    setDraftInfo(draftInfo.map((e, i) => (i === idx ? { ...e, [field]: value } : e)));
  };
  const removeEntry = (idx) => {
    setDraftInfo(draftInfo.filter((_, i) => i !== idx));
  };
  const saveEntries = () => {
    const cleaned = draftInfo.filter((e) => e.platform.trim() || e.number.trim());
    onSavePaymentInfo(cleaned);
    setDraftInfo(cleaned);
    setEditingPayment(false);
  };

  return (
    <div className="pb-24">
      <div className="px-6 pt-14 pb-6 border-b border-slate-800">
        <button
          onClick={onBackToLobby}
          className="inline-flex items-center gap-1.5 text-sm font-semibold text-slate-200 border border-slate-700 rounded-full px-3.5 py-2 active:scale-95 transition-transform mb-4"
        >
          <ArrowLeft size={16} /> Lobby
        </button>
        {eventName && <div className="text-sm font-semibold text-lime-300 mb-1">{eventName}</div>}
        <h1 className="font-display text-5xl text-slate-50">SPLIT BILL</h1>
      </div>

      <div className="px-6 pt-6">
        <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-4 space-y-2">
          {editingCosts ? (
            <>
              <FieldRow label="Harga lapangan (Rp)">
                <input
                  type="number"
                  inputMode="numeric"
                  value={draftCourt}
                  onChange={(e) => setDraftCourt(e.target.value)}
                  placeholder="0"
                  className="w-28 bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-right font-mono2 text-slate-100"
                />
              </FieldRow>
              <FieldRow label="Biaya admin (Rp)">
                <input
                  type="number"
                  inputMode="numeric"
                  value={draftAdmin}
                  onChange={(e) => setDraftAdmin(e.target.value)}
                  placeholder="0"
                  className="w-28 bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-right font-mono2 text-slate-100"
                />
              </FieldRow>
              <FieldRow label="Biaya bola (Rp)">
                <input
                  type="number"
                  inputMode="numeric"
                  value={draftBall}
                  onChange={(e) => setDraftBall(e.target.value)}
                  placeholder="0"
                  className="w-28 bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-right font-mono2 text-slate-100"
                />
              </FieldRow>
              <div className="flex items-center gap-2 pt-2">
                <GhostButton onClick={() => setEditingCosts(false)} className="flex-1">
                  Batal
                </GhostButton>
                <PrimaryButton onClick={saveCosts} className="flex-1">
                  Simpan
                </PrimaryButton>
              </div>
            </>
          ) : (
            <>
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
              {total === 0 && (
                <p className="text-slate-500 text-sm">Belum ada biaya yang diisi.</p>
              )}
              <div className="flex items-center justify-between text-sm pt-2 border-t border-slate-800">
                <span className="text-slate-300 font-semibold">Total</span>
                <span className="font-mono2 text-slate-100 font-bold">{formatRupiah(total)}</span>
              </div>
              <div className="flex items-center justify-between text-sm">
                <span className="text-slate-400">Jumlah pemain</span>
                <span className="font-mono2 text-slate-200">{n} orang</span>
              </div>
              {canManage && (
                <button
                  onClick={startEditingCosts}
                  className={`w-full mt-2 py-2 rounded-xl text-xs font-semibold ${
                    costsSaved ? "bg-lime-300 text-slate-950" : "bg-slate-800 border border-slate-700 text-slate-200"
                  }`}
                >
                  {costsSaved ? "Tersimpan ✓" : "Edit Biaya"}
                </button>
              )}
            </>
          )}
        </div>

        <div className="mt-4 rounded-2xl border border-lime-400/40 bg-lime-400/5 p-5 text-center">
          <div className="text-[11px] text-white uppercase tracking-wide mb-1">
            Per orang
          </div>
          <div className="font-display text-5xl text-lime-300">{formatRupiah(perPerson)}</div>
        </div>
      </div>

      <Section icon={Wallet} title="Terima Pembayaran">
        {isOwner && (
          <div className="mb-4">
            <p className="text-xs text-slate-500 mb-2">Siapa yang menerima transferan split bill?</p>
            <div className="flex gap-1.5 overflow-x-auto pb-1">
              {players.map((p) => (
                <button
                  key={p.id}
                  onClick={() => onSetPaymentPerson(paymentPersonId === p.id ? null : p.id)}
                  className={`shrink-0 px-3 py-1.5 rounded-full text-xs font-semibold border ${
                    paymentPersonId === p.id
                      ? "bg-lime-300 text-slate-950 border-lime-300"
                      : "bg-slate-900 text-slate-400 border-slate-700"
                  }`}
                >
                  {p.name}
                </button>
              ))}
            </div>
          </div>
        )}

        {!paymentPerson ? (
          <p className="text-slate-500 text-sm">Belum ada payment person ditentukan.</p>
        ) : (
          <div className="rounded-xl border border-slate-800 bg-slate-900/50 p-4">
            <div className="flex items-center justify-between mb-3">
              <span className="text-sm text-slate-300">
                Kirim ke: <span className="font-semibold text-slate-100">{paymentPerson.name}</span>
              </span>
              {canEditPayment && !editingPayment && (
                <button
                  onClick={() => {
                    setDraftInfo(paymentInfo && paymentInfo.length ? paymentInfo : []);
                    setEditingPayment(true);
                  }}
                  className="text-xs font-semibold text-cyan-300"
                >
                  Edit
                </button>
              )}
            </div>

            {editingPayment ? (
              <div className="space-y-3">
                {draftInfo.map((entry, idx) => (
                  <div key={idx} className="flex items-center gap-2">
                    <input
                      value={entry.platform}
                      onChange={(e) => updateEntry(idx, "platform", e.target.value)}
                      placeholder="Platform (mis. BCA, GoPay)"
                      className="flex-1 min-w-0 bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-xs placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-lime-400/50"
                    />
                    <input
                      value={entry.number}
                      onChange={(e) => updateEntry(idx, "number", e.target.value)}
                      placeholder="No. akun"
                      className="flex-1 min-w-0 bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-xs placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-lime-400/50"
                    />
                    <button
                      onClick={() => removeEntry(idx)}
                      className="w-8 h-8 rounded-lg bg-slate-800 border border-slate-700 text-slate-400 hover:text-red-400 flex items-center justify-center shrink-0"
                    >
                      <X size={13} />
                    </button>
                  </div>
                ))}
                {draftInfo.length < 2 && (
                  <button onClick={addEntry} className="text-xs font-semibold text-cyan-300">
                    + Tambah platform ({draftInfo.length}/2)
                  </button>
                )}
                <div className="flex items-center gap-2 pt-1">
                  <GhostButton onClick={() => setEditingPayment(false)} className="flex-1">
                    Batal
                  </GhostButton>
                  <PrimaryButton onClick={saveEntries} className="flex-1">
                    Simpan
                  </PrimaryButton>
                </div>
              </div>
            ) : (paymentInfo || []).length > 0 ? (
              <div className="space-y-1.5">
                {paymentInfo.map((entry, idx) => (
                  <div key={idx} className="flex items-center justify-between text-sm">
                    <span className="text-white font-semibold">{entry.platform || "-"}</span>
                    <span className="font-mono2 text-slate-100">{entry.number || "-"}</span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-slate-500 text-xs">Belum ada info platform/no. akun.</p>
            )}
          </div>
        )}
      </Section>

      <Section
        icon={Check}
        title="Ceklis Pembayaran"
        subtitle={`${players.filter((p) => paidStatus[p.id]).length}/${players.length} sudah bayar`}
      >
        <div className="space-y-2">
          {players.map((p) => {
            const isPaid = !!paidStatus[p.id];
            return (
              <button
                key={p.id}
                onClick={() => canManage && onTogglePaid(p.id)}
                disabled={!canManage}
                className={`w-full flex items-center justify-between gap-3 rounded-xl border px-4 py-3 ${
                  isPaid ? "border-lime-400/50 bg-lime-400/5" : "border-slate-800 bg-slate-900/50"
                }`}
              >
                <span className="flex items-center gap-2.5 min-w-0">
                  <span
                    className={`w-5 h-5 rounded-md border flex items-center justify-center shrink-0 ${
                      isPaid ? "bg-lime-300 border-lime-300" : "border-slate-600"
                    }`}
                  >
                    {isPaid && <Check size={13} strokeWidth={3} className="text-slate-950" />}
                  </span>
                  <span className="font-semibold text-slate-100 truncate">{p.name}</span>
                </span>
                <span className="flex items-center gap-2 shrink-0">
                  <span className="font-mono2 text-lime-300 font-bold">
                    {formatRupiah(perPerson)}
                  </span>
                  <Chip tone={isPaid ? "lime" : "slate"}>
                    {isPaid ? "Sudah bayar" : "Belum bayar"}
                  </Chip>
                </span>
              </button>
            );
          })}
        </div>
        {!canManage && (
          <p className="text-[11px] text-slate-500 mt-3">
            Cuma host & co-host yang bisa tandai status pembayaran.
          </p>
        )}
      </Section>

      <BottomNav active="splitbill" onNav={onNav} showSplitBill />
    </div>
  );
}

// ---------------------------------------------------------------------------
// RECAP SCREEN (all scored matches, for monitoring rotation fairness)
// ---------------------------------------------------------------------------

function RecapScreen({ eventName, activeId, createdAt, playDate, courts, mode, engine, playerMap, scores, scoreFormat, pointTarget, tennisTarget, activityLog, players, gameFormat, teamFormat, fixedPairs, ended, hasSplitBill, canManage, isOwner, currentUser, excludeFromStats, onToggleExcludeFromStats, onNav, onBackToLobby }) {
  const [filterId, setFilterId] = useState("all");

  const teamNameByPlayer = React.useMemo(
    () => (teamFormat === "fixed" ? buildTeamNameByPlayer(fixedPairs, playerMap) : null),
    [gameFormat, fixedPairs, playerMap]
  );

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
          team1: teamNameByPlayer ? [teamNameByPlayer[match.team1[0]] || playerMap[match.team1[0]]] : match.team1.map((id) => playerMap[id]),
          team2: teamNameByPlayer ? [teamNameByPlayer[match.team2[0]] || playerMap[match.team2[0]]] : match.team2.map((id) => playerMap[id]),
          a,
          b,
          winner: a === b ? null : a > b ? "team1" : "team2",
        });
      });
    });
    return list;
  }, [engine, playerMap, scores, teamNameByPlayer]);

  // Everyone who's ever appeared in this event's schedule, including
  // people since removed from the roster — kept around for things that
  // need the full history (like the export button below).
  const allKnownPlayers = React.useMemo(
    () =>
      Object.entries(playerMap)
        .map(([id, name]) => ({ id, name }))
        .sort((x, y) => x.name.localeCompare(y.name)),
    [playerMap]
  );
  // For the filter chips specifically: only people still on the CURRENT
  // roster. Someone marked not-arrived still counts (they're still on the
  // roster, just not present that day) — only a genuine delete removes
  // someone from this list, and their filter chip along with it.
  const currentRosterIds = React.useMemo(() => new Set((players || []).map((p) => p.id)), [players]);
  const filterablePlayers = React.useMemo(
    () => allKnownPlayers.filter((p) => currentRosterIds.has(p.id)),
    [allKnownPlayers, currentRosterIds]
  );
  // Fixed Partner mode: one chip per TEAM instead of per person. The
  // filterId used is simply the first player's id — since both partners
  // always appear together in team1Ids/team2Ids, filtering by either one
  // of them already correctly selects that whole team's matches.
  const filterableTeams = React.useMemo(() => {
    if (gameFormat !== "fixed_partner") return null;
    return (fixedPairs || [])
      .filter(([a, b]) => currentRosterIds.has(a) && currentRosterIds.has(b))
      .map(([a, b]) => ({ id: a, name: `${playerMap[a] || a} & ${playerMap[b] || b}` }));
  }, [gameFormat, fixedPairs, currentRosterIds, playerMap]);
  const filterChips = filterableTeams || filterablePlayers;

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
        {eventName && <div className="text-sm font-semibold text-lime-300 mb-1">{eventName}</div>}
        <h1 className="font-display text-5xl text-slate-50">REKAP MATCH</h1>

        {filterChips.length > 0 && (
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
            {filterChips.map((p) => (
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
        {currentUser?.accountId === "alfinyr" && (
          <div className="rounded-2xl border border-slate-800 bg-slate-900/40 p-4">
            <div className="flex items-center gap-2 mb-3">
              <ClipboardList size={14} className="text-lime-300" />
              <span className="text-sm font-semibold text-slate-200">Export Data &amp; Log</span>
            </div>
            <ExportSessionButton
              eventName={eventName}
              activeId={activeId}
              createdAt={createdAt}
              playDate={playDate}
              courts={courts}
              mode={mode}
              scoreFormat={scoreFormat}
              pointTarget={pointTarget}
              tennisTarget={tennisTarget}
              players={players}
              playerMap={playerMap}
              engine={engine}
              scores={scores}
              activityLog={activityLog}
              ended={ended}
              excludeFromStats={excludeFromStats}
            />
          </div>
        )}

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
                Ronde {r.round} · {engine?.mexicano ? `Match ${r.court}` : `Lapangan ${r.court}`}
              </span>
            </div>
            <div className="px-4 py-3 space-y-1.5">
              <div className="flex items-center justify-between gap-3">
                <span
                  className={`text-sm truncate ${
                    r.winner === "team1" ? "text-lime-300 font-semibold" : "text-slate-200"
                  }`}
                >
                  {r.team1.join(" - ")}
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
                  {r.team2.join(" - ")}
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

function StatsScreen({ eventName, stats, totalPlayers, gameFormat, teamFormat, hasSplitBill, canManage, isOwner, excludeFromStats, onToggleExcludeFromStats, onNav, onBackToLobby }) {
  const isTeamMode = teamFormat === "fixed";
  const maxPossible = isTeamMode
    ? Math.max(0, Math.floor(totalPlayers / 2) - 1)
    : Math.max(0, totalPlayers - 1);
  return (
    <div className="pb-24">
      <div className="px-6 pt-14 pb-6 border-b border-slate-800">
        <button
          onClick={onBackToLobby}
          className="inline-flex items-center gap-1.5 text-sm font-semibold text-slate-200 border border-slate-700 rounded-full px-3.5 py-2 active:scale-95 transition-transform mb-4"
        >
          <ArrowLeft size={16} /> Lobby
        </button>
        {eventName && <div className="text-sm font-semibold text-lime-300 mb-1">{eventName}</div>}
        <h1 className="font-display text-5xl text-slate-50">STATISTIK ROTASI</h1>
        <p className="text-slate-500 text-sm mt-2">
          Semakin merata angka "main" &amp; "istirahat", semakin adil rotasinya.
        </p>
      </div>

      {isOwner && (
        <div className="px-6 pt-4">
          <div className="rounded-2xl border border-slate-800 bg-slate-900/40 p-4">
            <div className="flex items-center gap-2 mb-3">
              <BarChart3 size={14} className="text-lime-300" />
              <span className="text-sm font-semibold text-slate-200">Hitung ke Statistik?</span>
            </div>
            <StatsCountToggle excluded={excludeFromStats} onToggle={onToggleExcludeFromStats} />
          </div>
        </div>
      )}

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
                  <Check size={11} /> {p.playedSoFar}/{p.matches} main
                </Chip>
                <Chip tone="amber">
                  <Trophy size={11} /> {p.wins}W-{p.losses}L
                </Chip>
              </div>
            </div>
            <div className={`grid ${isTeamMode ? "grid-cols-1" : "grid-cols-2"} gap-2 text-xs`}>
              {!isTeamMode && (
                <div className="bg-slate-950/60 rounded-lg px-3 py-2">
                  <div className="flex items-center justify-between mb-1.5">
                    <span className="text-slate-500">Partner</span>
                    <span className="font-mono2 text-cyan-300">{p.partners}/{maxPossible}</span>
                  </div>
                  {p.partnerDetail && p.partnerDetail.length > 0 && (
                    <div className="grid grid-cols-2 gap-x-2 gap-y-0.5">
                      {p.partnerDetail.map((d) => (
                        <div key={d.name} className="flex items-center justify-between gap-1 text-[11px]">
                          <span className="text-slate-300 truncate">{d.name}</span>
                          <span className="text-slate-500 shrink-0">{d.played}/{d.total}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
              <div className="bg-slate-950/60 rounded-lg px-3 py-2">
                <div className="flex items-center justify-between mb-1.5">
                  <span className="text-slate-500">{isTeamMode ? "Lawan tim" : "Lawan"}</span>
                  <span className="font-mono2 text-cyan-300">{p.opps}/{maxPossible}</span>
                </div>
                {p.oppDetail && p.oppDetail.length > 0 && (
                  <div className="grid grid-cols-2 gap-x-2 gap-y-0.5">
                    {p.oppDetail.map((d) => (
                      <div key={d.name} className="flex items-center justify-between gap-1 text-[11px]">
                        <span className="text-slate-300 truncate">{d.name}</span>
                        <span className="text-slate-500 shrink-0">{d.played}/{d.total}</span>
                      </div>
                    ))}
                  </div>
                )}
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
  const [avatarCache, setAvatarCache] = useState({}); // accountId -> avatarUrl | null (for the waiting-room player list)
  const [nameCache, setNameCache] = useState({}); // accountId -> current displayName | null
  const initializedRound = useRef(false);
  const lastAppliedRef = useRef(0);

  useEffect(() => {
    window.scrollTo(0, 0);
  }, [tab]);

  // Same migration as the main app: old events saved gameFormat="fixed_partner"
  // instead of the current teamFormat="fixed" — resolve it once here so every
  // check below reads correctly regardless of which shape the data is in.
  const resolvedTeamFormat = React.useMemo(() => resolveGameAndTeamFormat(data).teamFormat, [data]);

  // Only relevant while the event is still in its waiting room (no engine
  // yet) — fetches profile photos for anyone in the roster who has an
  // account, same as the host's own Waiting Room screen does.
  useEffect(() => {
    if (data?.engine) return;
    const ids = new Set(
      [...(data?.players || []), ...(data?.pendingRequests || [])]
        .map((p) => p.accountId)
        .filter((id) => id && !(id in avatarCache))
    );
    if (ids.size === 0) return;
    (async () => {
      const entries = await Promise.all(
        [...ids].map(async (id) => {
          const acc = await getUserAccount(id);
          return { id, avatarUrl: acc?.avatarUrl || null, name: acc ? acc.displayName || acc.username : null };
        })
      );
      setAvatarCache((prev) => ({
        ...prev,
        ...Object.fromEntries(entries.map((e) => [e.id, e.avatarUrl])),
      }));
      setNameCache((prev) => ({ ...prev, ...Object.fromEntries(entries.map((e) => [e.id, e.name])) }));
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data?.players, data?.pendingRequests, data?.engine]);

  useEffect(() => {
    let mounted = true;
    let attempts = 0;
    let retryTimer = null;

    async function tryLoad() {
      const d = await loadSessionData(sessionId);
      if (!mounted) return;
      if (d) {
        // A deleted event's data is deliberately kept around for admin
        // audit (see markSessionDataDeleted), but a share link to it
        // should stop working for everyone except alfinyr — otherwise
        // "deleted" wouldn't actually mean anything to a normal user who
        // still has the link.
        if (d.deleted && loadRememberedLogin()?.accountId !== "alfinyr") {
          setNotFound(true);
          return;
        }
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
      if (d?.deleted && loadRememberedLogin()?.accountId !== "alfinyr") {
        setNotFound(true);
        setData(null);
        return;
      }
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
    () =>
      data?.engine
        ? resolvedTeamFormat === "fixed"
          ? buildTeamLeaderboard(data.engine, data.playerMap, data.scores, data.fixedPairs)
          : buildLeaderboard(data.engine, data.playerMap, data.scores, (data.players || []).map((p) => p.id))
        : [],
    [data]
  );
  const [lbSortBy, setLbSortBy] = useState("winPercent"); // wins | diff | winPercent | ppm
  const [lbShowNotArrived, setLbShowNotArrived] = useState(true);
  const lbNotArrivedIds = React.useMemo(
    () => new Set((data?.players || []).filter((p) => p.arrived === false).map((p) => p.id)),
    [data]
  );
  const visibleLeaderboard = React.useMemo(
    () => (lbShowNotArrived ? leaderboard : leaderboard.filter((p) => !lbNotArrivedIds.has(p.id))),
    [leaderboard, lbShowNotArrived, lbNotArrivedIds]
  );
  const sortedLeaderboard = React.useMemo(() => {
    const arr = [...visibleLeaderboard];
    if (lbSortBy === "wins") {
      arr.sort((x, y) => y.wins - x.wins || y.diff - x.diff || y.winPercent - x.winPercent || y.points - x.points);
    } else if (lbSortBy === "diff") {
      arr.sort((x, y) => y.diff - x.diff || y.wins - x.wins || y.winPercent - x.winPercent || y.points - x.points);
    } else if (lbSortBy === "winPercent") {
      arr.sort((x, y) => y.winPercent - x.winPercent || y.wins - x.wins || y.diff - x.diff);
    } else {
      arr.sort((x, y) => y.points - x.points || y.wins - x.wins || y.diff - x.diff);
    }
    return arr;
  }, [visibleLeaderboard, lbSortBy]);
  const lbRanks = React.useMemo(() => computeTiedRanks(sortedLeaderboard), [sortedLeaderboard]);
  const lbActiveCol = lbSortBy === "wins" ? "wlt" : lbSortBy;
  const hasSplitBill =
    !!data &&
    (Number(data.courtCost) || 0) + (Number(data.adminFee) || 0) + (Number(data.ballCost) || 0) > 0;

  const recapRows = React.useMemo(() => {
    if (!data?.engine) return [];
    const teamNameByPlayer =
      resolvedTeamFormat === "fixed" ? buildTeamNameByPlayer(data.fixedPairs, data.playerMap) : null;
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
          team1: teamNameByPlayer
            ? [teamNameByPlayer[match.team1[0]] || data.playerMap[match.team1[0]]]
            : match.team1.map((id) => data.playerMap[id]),
          team2: teamNameByPlayer
            ? [teamNameByPlayer[match.team2[0]] || data.playerMap[match.team2[0]]]
            : match.team2.map((id) => data.playerMap[id]),
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
  // Fixed Partner mode: one filter chip per TEAM instead of per person —
  // same reasoning as the main app's RecapScreen.
  const filterableTeams = React.useMemo(() => {
    if (data?.gameFormat !== "fixed_partner") return null;
    return (data?.fixedPairs || []).map(([a, b]) => ({
      id: a,
      name: `${data.playerMap[a] || a} & ${data.playerMap[b] || b}`,
    }));
  }, [data]);
  const recapFilterChips = filterableTeams || players;

  const closeOrBack = () => {
    // Opened as its own tab (from the admin "All Match" list, or a shared
    // link) — there's no in-app "previous screen" to return to, so the
    // sensible action is closing this tab. window.close() only works on
    // tabs opened via script (which this one is, from window.open), but
    // just in case a browser blocks it, history.back() is a reasonable
    // fallback rather than leaving the user with no way out at all.
    window.close();
    setTimeout(() => {
      if (!window.closed) window.history.back();
    }, 100);
  };

  if (!data && notFound) {
    return (
      <div className="min-h-screen bg-slate-950 flex items-center justify-center px-6 text-center">
        <style>{FONT_STYLE}</style>
        <div className="max-w-xs">
          <button
            onClick={closeOrBack}
            className="inline-flex items-center gap-1.5 text-sm font-semibold text-slate-200 border border-slate-700 rounded-full px-3.5 py-2 active:scale-95 transition-transform mb-6"
          >
            <ArrowLeft size={16} /> Tutup
          </button>
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
    // Event hasn't generated a schedule yet — still in the waiting room.
    // Show who's already joined (read-only) instead of a dead end, laid
    // out like the host's own Waiting Room screen.
    const usableCourtsPreview = Math.min(data.courts || 1, Math.floor((data.players || []).length / 4));
    const estRounds =
      (data.players || []).length >= 4 && usableCourtsPreview >= 1
        ? Math.max(1, Math.round(((Number(data.totalMinutes) || 90) / (Number(data.minutesPerRound) || 8))))
        : 0;
    return (
      <div className="min-h-screen bg-slate-950 pb-10">
        <style>{FONT_STYLE}</style>
        <div className="px-6 pt-14 pb-6 border-b border-slate-800 relative overflow-hidden">
          <div className="absolute -right-10 -top-10 w-40 h-40 rounded-full bg-lime-400/10 blur-2xl pointer-events-none" />
          <div className="flex items-center justify-between mb-4">
            <button
              onClick={closeOrBack}
              className="inline-flex items-center gap-1.5 text-sm font-semibold text-slate-200 border border-slate-700 rounded-full px-3.5 py-2 active:scale-95 transition-transform"
            >
              <ArrowLeft size={16} /> Tutup
            </button>
            <Chip tone="cyan">
              <Eye size={11} /> view only
            </Chip>
          </div>
          {data.name && <h1 className="font-display text-4xl text-slate-50 mb-1">{data.name}</h1>}
          <Chip tone="amber">
            <Clock size={11} /> Menunggu peserta
          </Chip>
          <p className="text-slate-400 text-sm mt-3">
            {(data.players || []).length}/{data.maxParticipants || "-"} peserta target ·{" "}
            {data.courts || 1} lapangan
            {estRounds > 0 && ` · estimasi ${estRounds} ronde`}
          </p>
          {data.ownerUsername && (
            <p className="text-slate-500 text-xs mt-1">host: {data.ownerUsername}</p>
          )}
        </div>

        <div className="px-6 pt-6">
          <div className="text-[11px] text-slate-500 uppercase tracking-wide mb-2">
            {(data.players || []).length} Peserta Sudah Gabung
          </div>
          {(data.players || []).length === 0 ? (
            <p className="text-slate-600 text-sm">Belum ada yang gabung.</p>
          ) : (
            <div className="space-y-2">
              {(data.players || []).map((p) => {
                const liveName = (p.accountId && nameCache[p.accountId]) || p.name;
                return (
                <div
                  key={p.id}
                  className="flex items-center gap-2.5 rounded-xl border border-slate-800 bg-slate-900/50 px-4 py-3"
                >
                  <Avatar
                    name={liveName}
                    avatarUrl={p.accountId ? avatarCache[p.accountId] : null}
                    size={36}
                  />
                  <span className="font-semibold text-slate-100 truncate flex-1">{liveName}</span>
                  {p.accountId === data.ownerId && <Chip tone="cyan">host</Chip>}
                  {data.coHostIds?.includes(p.accountId) && <Chip tone="cyan">co-host</Chip>}
                  {p.arrived === false && <Chip tone="slate">belum hadir</Chip>}
                </div>
                );
              })}
            </div>
          )}
        </div>

        {(data.pendingRequests || []).length > 0 && (
          <div className="px-6 pt-6">
            <div className="text-[11px] text-slate-500 uppercase tracking-wide mb-2">
              {data.pendingRequests.length} Menunggu Persetujuan Host
            </div>
            <div className="space-y-2">
              {data.pendingRequests.map((r) => (
                <div
                  key={r.id}
                  className="flex items-center gap-2.5 rounded-xl border border-dashed border-slate-700 px-4 py-3"
                >
                  <Avatar
                    name={r.name}
                    avatarUrl={r.accountId ? avatarCache[r.accountId] : null}
                    size={36}
                  />
                  <span className="text-slate-300 truncate">{r.name}</span>
                </div>
              ))}
            </div>
          </div>
        )}
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
        <button
          onClick={closeOrBack}
          className="inline-flex items-center gap-1.5 text-sm font-semibold text-slate-200 border border-slate-700 rounded-full px-3.5 py-2 active:scale-95 transition-transform mb-4"
        >
          <ArrowLeft size={16} /> Tutup
        </button>
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
            <div className="text-lg font-bold tracking-[0.1em] text-lime-300 uppercase mb-4">
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
                        {data.engine?.mexicano ? `Match ${cIdx + 1}` : `Lapangan ${cIdx + 1}`}
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
                { key: "winPercent", label: "Win%" },
                { key: "wins", label: "W-L-T" },
                { key: "diff", label: "Selisih Poin" },
                { key: "ppm", label: "Total Poin" },
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
            {lbNotArrivedIds.size > 0 && (
              <button
                onClick={() => setLbShowNotArrived((v) => !v)}
                className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold border mb-4 ${
                  lbShowNotArrived
                    ? "bg-slate-900 text-slate-400 border-slate-700"
                    : "bg-amber-400/10 text-amber-300 border-amber-400/40"
                }`}
              >
                {lbShowNotArrived ? <Eye size={12} /> : <UserCircle2 size={12} />}
                {lbShowNotArrived
                  ? `Tampilkan semua (termasuk ${lbNotArrivedIds.size} yang tidak hadir)`
                  : `Sembunyikan yang tidak hadir (${lbNotArrivedIds.size})`}
              </button>
            )}
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
                  <tr className="text-[9px] text-white uppercase tracking-wide">
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
                          {k === "wlt" ? "W-L-T" : k === "diff" ? "+/-" : k === "winPercent" ? "Win%" : "P"}
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
                        : p.points;
                    return (
                      <tr key={p.id} className={`border-t border-slate-800 ${lbRanks[i] === 1 ? "bg-lime-400/5" : ""}`}>
                        <td className={`py-2.5 text-center font-display text-base ${lbRanks[i] === 1 ? "text-lime-300" : "text-slate-500"}`}>
                          {lbRanks[i]}
                        </td>
                        <td className="py-2.5 font-semibold text-slate-100 truncate text-[13px]">{p.name}</td>
                        <td className="py-2.5 text-center font-mono2 text-[11px] text-white">{p.matches}</td>
                        {["wlt", "diff", "winPercent", "ppm"]
                          .filter((k) => k !== lbActiveCol)
                          .concat([lbActiveCol])
                          .map((k) => (
                            <td
                              key={k}
                              className={`py-2.5 pl-1 text-right font-mono2 text-[11px] whitespace-nowrap ${
                                k === lbActiveCol ? "text-lime-300 font-bold" : "text-white"
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
              <div className="mt-4 pt-4 border-t border-slate-800 space-y-1 text-[11px] text-white">
                <div><span className="text-lime-300 font-semibold">M</span> — jumlah match dimainkan</div>
                <div><span className="text-lime-300 font-semibold">W-L-T</span> — menang-kalah-seri</div>
                <div><span className="text-lime-300 font-semibold">+/-</span> — selisih poin (poin dapat − poin lawan)</div>
                <div><span className="text-lime-300 font-semibold">Win%</span> — persentase match dimenangkan</div>
                <div><span className="text-lime-300 font-semibold">P</span> — Total Poin: jumlah semua poin yang dihasilkan sepanjang acara</div>
              </div>
            )}
          </div>
        )}

        {tab === "recap" && (
          <div className="px-6 pt-6">
            <h2 className="font-display text-3xl text-slate-50 mb-4">REKAP MATCH</h2>
            {recapFilterChips.length > 0 && (
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
                {recapFilterChips.map((p) => (
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
                      Ronde {r.round} · {data.engine?.mexicano ? `Match ${r.court}` : `Lapangan ${r.court}`}
                    </span>
                  </div>
                  <div className="px-4 py-3 space-y-1.5">
                    <div className="flex items-center justify-between gap-3">
                      <span className={`text-sm truncate ${r.winner === "team1" ? "text-lime-300 font-semibold" : "text-slate-200"}`}>
                        {r.team1.join(" - ")}
                      </span>
                      <span className={`font-mono2 text-lg shrink-0 ${r.winner === "team1" ? "text-lime-300" : "text-slate-400"}`}>
                        {r.a}
                      </span>
                    </div>
                    <div className="flex items-center justify-between gap-3">
                      <span className={`text-sm truncate ${r.winner === "team2" ? "text-lime-300 font-semibold" : "text-slate-200"}`}>
                        {r.team2.join(" - ")}
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
                    <div className="text-[11px] text-white uppercase tracking-wide mb-1">
                      Per orang
                    </div>
                    <div className="font-display text-5xl text-lime-300">{formatRupiah(perPerson)}</div>
                  </div>

                  {(() => {
                    const paymentPerson = (data.players || []).find((p) => p.id === data.paymentPersonId);
                    if (!paymentPerson) return null;
                    return (
                      <div className="mt-4 rounded-xl border border-slate-800 bg-slate-900/50 p-4">
                        <div className="text-sm text-slate-300 mb-2">
                          Kirim ke: <span className="font-semibold text-slate-100">{paymentPerson.name}</span>
                        </div>
                        {(data.paymentInfo || []).length > 0 ? (
                          <div className="space-y-1.5">
                            {data.paymentInfo.map((entry, idx) => (
                              <div key={idx} className="flex items-center justify-between text-sm">
                                <span className="text-white font-semibold">{entry.platform || "-"}</span>
                                <span className="font-mono2 text-slate-100">{entry.number || "-"}</span>
                              </div>
                            ))}
                          </div>
                        ) : (
                          <p className="text-slate-500 text-xs">Belum ada info platform/no. akun.</p>
                        )}
                      </div>
                    );
                  })()}

                  <div className="mt-6 space-y-2">
                    {(data.players || []).map((p) => {
                      const isPaid = !!(data.paidStatus || {})[p.id];
                      return (
                        <div
                          key={p.id}
                          className={`flex items-center justify-between gap-3 rounded-xl border px-4 py-3 ${
                            isPaid ? "border-lime-400/50 bg-lime-400/5" : "border-slate-800 bg-slate-900/50"
                          }`}
                        >
                          <span className="flex items-center gap-2.5 min-w-0">
                            <span
                              className={`w-5 h-5 rounded-md border flex items-center justify-center shrink-0 ${
                                isPaid ? "bg-lime-300 border-lime-300" : "border-slate-600"
                              }`}
                            >
                              {isPaid && <Check size={13} strokeWidth={3} className="text-slate-950" />}
                            </span>
                            <span className="font-semibold text-slate-100 truncate">{p.name}</span>
                          </span>
                          <span className="flex items-center gap-2 shrink-0">
                            <span className="font-mono2 text-lime-300 font-bold">
                              {formatRupiah(perPerson)}
                            </span>
                            <Chip tone={isPaid ? "lime" : "slate"}>
                              {isPaid ? "Sudah bayar" : "Belum bayar"}
                            </Chip>
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </>
              );
            })()}
          </div>
        )}
      </div>
      </div>

      {(() => {
        const voItems = [
          { key: "session", label: "Jadwal", icon: Clock },
          { key: "leaderboard", label: "Klasemen", icon: Trophy },
          { key: "recap", label: "Rekap", icon: ClipboardList },
          ...(hasSplitBill ? [{ key: "splitbill", label: "Split Bill", icon: Wallet }] : []),
        ];
        const voActiveIdx = Math.max(0, voItems.findIndex((i) => i.key === tab));
        const voPct = 100 / voItems.length;
        return (
          <div className="fixed bottom-0 left-0 right-0 bg-slate-950/95 backdrop-blur border-t border-slate-800 z-20 max-w-md mx-auto px-3">
            <div className="relative bg-slate-900 rounded-full p-1 flex">
              <div
                className="absolute top-1 bottom-1 bg-lime-300 rounded-full transition-all duration-300 ease-out"
                style={{ left: `${voActiveIdx * voPct}%`, width: `${voPct}%` }}
              />
              {voItems.map(({ key, label, icon: Icon }) => (
                <button
                  key={key}
                  onClick={() => setTab(key)}
                  className={`relative z-10 flex-1 py-2 flex flex-col items-center gap-1 transition-colors duration-300 ${
                    tab === key ? "text-slate-950" : "text-slate-500"
                  }`}
                >
                  <Icon size={20} strokeWidth={tab === key ? 2.5 : 2} />
                  <span className="text-[11px] font-semibold">{label}</span>
                </button>
              ))}
            </div>
          </div>
        );
      })()}
    </div>
  );
}

// ---------------------------------------------------------------------------
// ROOT — decides between the editable app and the read-only viewer link
// ---------------------------------------------------------------------------

// Catches any unexpected rendering crash so the person sees a recoverable
// screen (with the actual error text, useful for reporting bugs) instead of
// a totally blank white page.
class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error) {
    return { error };
  }
  componentDidCatch(error, info) {
    console.error("Uncaught render error:", error, info);
  }
  render() {
    if (this.state.error) {
      return (
        <div className="min-h-screen bg-slate-950 text-slate-100 flex items-center justify-center px-6">
          <div className="max-w-sm text-center">
            <div className="text-4xl mb-3">⚠️</div>
            <h1 className="font-display text-3xl text-slate-50 mb-2">Terjadi Kesalahan</h1>
            <p className="text-slate-400 text-sm mb-4">
              Ada yang salah saat menampilkan halaman ini. Coba muat ulang — kalau masih terjadi,
              screenshot pesan di bawah ini dan kirim untuk dilaporkan.
            </p>
            <div className="bg-slate-900 border border-slate-700 rounded-xl p-3 text-left text-[11px] text-red-300 font-mono2 mb-4 max-h-40 overflow-y-auto break-words">
              {String(this.state.error?.message || this.state.error)}
            </div>
            <button
              onClick={() => window.location.reload()}
              className="px-5 py-3 rounded-xl font-bold bg-lime-300 text-slate-950"
            >
              Muat Ulang
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

function AppRoot() {
  const params = new URLSearchParams(window.location.search);
  const viewSessionId = params.get("s");
  return (
    <ErrorBoundary>
      {viewSessionId ? <ViewOnlyApp sessionId={viewSessionId} /> : <AmericanoPadel />}
    </ErrorBoundary>
  );
}

export default AppRoot;
