// Pure game logic (no DOM / network) so it can be unit tested with `node --test`.

export const CATEGORIES = ['artist', 'title', 'year'];
export const CATEGORY_LABELS = { artist: 'Artist', title: 'Song', year: 'Year' };
export const DEFAULT_TARGET_SCORE = 15;
export const FIRST_GUESS_SECONDS = 60;
export const FOLLOWUP_GUESS_SECONDS = 20;
// I'm Steve "Put the clock on em": shows 10 → 0, but the player is only out after 15 s (5 s grace at 0).
export const MANUAL_TURN_SECONDS = 15;
export const MANUAL_DISPLAY_SECONDS = 10;

export function manualClockDisplaySeconds(deadlineAt, now = Date.now()) {
  const elapsed = MANUAL_TURN_SECONDS * 1000 - (deadlineAt - now);
  return Math.min(MANUAL_DISPLAY_SECONDS, Math.max(0, Math.ceil((MANUAL_DISPLAY_SECONDS * 1000 - elapsed) / 1000)));
}

/**
 * What a turn clock shows right now: `left` = whole seconds on the display, `fraction` = how full
 * the bar is (1 → 0). `clock` is { deadlineAt, seconds, manual } as in presentationSnapshot.
 */
export function turnClockReading(clock, now = Date.now()) {
  if (!clock?.deadlineAt) return null;
  if (clock.manual) {
    const graceMs = (MANUAL_TURN_SECONDS - MANUAL_DISPLAY_SECONDS) * 1000;
    const fraction = (clock.deadlineAt - now - graceMs) / (MANUAL_DISPLAY_SECONDS * 1000);
    return { left: manualClockDisplaySeconds(clock.deadlineAt, now), fraction: Math.min(1, Math.max(0, fraction)) };
  }
  const fraction = clock.seconds ? (clock.deadlineAt - now) / (clock.seconds * 1000) : 0;
  return { left: secondsLeft(clock.deadlineAt, now), fraction: Math.min(1, Math.max(0, fraction)) };
}

/** Seconds left on a turn clock, rounded up so the display reaches 0 exactly at the deadline. */
export function secondsLeft(deadlineAt, now = Date.now()) {
  return Math.max(0, Math.ceil((deadlineAt - now) / 1000));
}

/** 'calm' | 'warn' (10 s or less) | 'danger' (5 s or less): drives the clock colour on both screens. */
export function clockUrgency(seconds) {
  if (seconds == null) return 'calm';
  if (seconds <= 5) return 'danger';
  if (seconds <= 10) return 'warn';
  return 'calm';
}

/**
 * No Steve timer settings, stored on the game so they survive reloads and can be
 * changed mid-game. Every value is a whole number of seconds within [min, max].
 */
export const TIMING_LIMITS = {
  firstGuessSeconds: { min: 5, max: 300, default: FIRST_GUESS_SECONDS },
  followupGuessSeconds: { min: 5, max: 300, default: FOLLOWUP_GUESS_SECONDS },
  revealSeconds: { min: 0, max: 30, default: 6 },
  voiceSeconds: { min: 5, max: 30, default: 15 },
  playbackWaitSeconds: { min: 0, max: 15, default: 5 },
};

export const DEFAULT_TIMINGS = Object.freeze(
  Object.fromEntries(Object.entries(TIMING_LIMITS).map(([key, limit]) => [key, limit.default])),
);

/** Returns a complete, valid timings object: numbers are rounded and clamped, anything else falls back to the default. */
export function normalizeTimings(input) {
  const source = input && typeof input === 'object' ? input : {};
  const result = {};
  for (const [key, { min, max, default: fallback }] of Object.entries(TIMING_LIMITS)) {
    const raw = typeof source[key] === 'string' && source[key].trim() !== '' ? Number(source[key]) : source[key];
    result[key] = typeof raw === 'number' && Number.isFinite(raw) ? Math.min(max, Math.max(min, Math.round(raw))) : fallback;
  }
  return result;
}

/** Merges a partial timings change into the game. Running timers keep their deadline; new values apply from the next turn. */
export function updateTimings(game, changes) {
  game.timings = normalizeTimings({ ...normalizeTimings(game.timings), ...changes });
  return game.timings;
}

export function guessTimeLimitSeconds(round, timings = DEFAULT_TIMINGS) {
  const { firstGuessSeconds, followupGuessSeconds } = normalizeTimings(timings);
  return round?.attempted?.length || round?.out?.length ? followupGuessSeconds : firstGuessSeconds;
}

const PLAYLIST_ID_RE = /^[A-Za-z0-9]{22}$/;

/**
 * Extracts a Spotify playlist ID from a share URL, a spotify: URI or a bare ID.
 * Returns null when no valid ID can be found.
 */
export function parsePlaylistId(input) {
  if (typeof input !== 'string') return null;
  const value = input.trim();
  if (PLAYLIST_ID_RE.test(value)) return value;
  const uriMatch = value.match(/^spotify:(?:user:[^:]+:)?playlist:([A-Za-z0-9]{22})$/);
  if (uriMatch) return uriMatch[1];
  try {
    const url = new URL(value);
    if (!/(^|\.)spotify\.com$/.test(url.hostname)) return null;
    const parts = url.pathname.split('/').filter(Boolean);
    const idx = parts.indexOf('playlist');
    if (idx !== -1 && PLAYLIST_ID_RE.test(parts[idx + 1] || '')) return parts[idx + 1];
  } catch {
    // not a URL
  }
  return null;
}

/** Fisher–Yates shuffle returning a new array. `rng` returns a float in [0, 1). */
export function shuffle(items, rng = Math.random) {
  const result = items.slice();
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

let idCounter = 0;
function makeId(prefix) {
  idCounter += 1;
  return `${prefix}-${Date.now().toString(36)}-${idCounter}`;
}

/**
 * Creates a contestant. A contestant with members is a team; without members it
 * is an individual player. Both are scored identically.
 */
export function createContestant(name, members = [], id = makeId('c')) {
  const cleanName = String(name ?? '').trim();
  if (!cleanName) throw new Error('Contestant name is required');
  const cleanMembers = (Array.isArray(members) ? members : String(members).split(','))
    .map((m) => String(m).trim())
    .filter(Boolean);
  return { id, name: cleanName, members: cleanMembers };
}

export function isTeam(contestant) {
  return contestant.members.length > 0;
}

export function createGame({ playlistId = null, contestants = [], targetScore = DEFAULT_TARGET_SCORE, mode = 'no-steve', timings = DEFAULT_TIMINGS } = {}) {
  return {
    playlistId,
    contestants: contestants.slice(),
    targetScore: Number.isSafeInteger(targetScore) && targetScore > 0 ? targetScore : DEFAULT_TARGET_SCORE,
    mode: mode === 'im-steve' ? 'im-steve' : 'no-steve',
    timings: normalizeTimings(timings),
    deck: [], // remaining track ids to play, in order
    rounds: [], // { trackId, awards: { [contestantId]: { artist, title, year } } }
    // Who guesses first on the next song. Rotates every song and survives resetScores,
    // so the start of each new game continues the rotation instead of going back to A.
    nextStarterId: contestants[0]?.id ?? null,
  };
}

/** The contestant who will guess first on the next song. */
export function nextStarter(game) {
  if (!game.contestants.length) return null;
  const saved = game.contestants.find((c) => c.id === game.nextStarterId);
  return saved ?? game.contestants[game.rounds.length % game.contestants.length];
}

export function addContestant(game, contestant) {
  if (game.contestants.some((c) => c.name.toLowerCase() === contestant.name.toLowerCase())) {
    throw new Error(`"${contestant.name}" is already playing`);
  }
  game.contestants.push(contestant);
  return game;
}

export function removeContestant(game, contestantId) {
  const removedIndex = game.contestants.findIndex((c) => c.id === contestantId);
  game.contestants = game.contestants.filter((c) => c.id !== contestantId);
  if (game.nextStarterId === contestantId) {
    // The player who would have followed the removed one starts the next song instead.
    game.nextStarterId = game.contestants.length ? game.contestants[removedIndex % game.contestants.length].id : null;
  }
  for (const round of game.rounds) {
    delete round.awards[contestantId];
    round.out = (round.out ?? []).filter((id) => id !== contestantId);
    round.attempted = (round.attempted ?? []).filter((id) => id !== contestantId);
    if (round.currentTurnId === contestantId) {
      round.currentTurnId = nextActiveContestant(game.contestants, round, removedIndex - 1)?.id ?? null;
    }
  }
  return game;
}

function nextActiveContestant(contestants, round, previousIndex) {
  if (!contestants.length) return null;
  for (let offset = 1; offset <= contestants.length; offset++) {
    const index = (previousIndex + offset + contestants.length) % contestants.length;
    const contestant = contestants[index];
    if (!round.out?.includes(contestant.id)) return contestant;
  }
  return null;
}

/**
 * (Re)builds the shuffled deck from the playlist's track ids, skipping tracks
 * that were already played this game so songs never repeat until the playlist
 * is exhausted.
 */
export function buildDeck(game, trackIds, rng = Math.random) {
  const played = new Set(game.rounds.map((r) => r.trackId));
  const unique = [...new Set(trackIds)];
  let remaining = unique.filter((id) => !played.has(id));
  if (remaining.length === 0) remaining = unique; // everything played: start over
  game.deck = shuffle(remaining, rng);
  return game;
}

export function extendDeck(game, trackIds, rng = Math.random) {
  const known = new Set([...game.deck, ...game.rounds.map((round) => round.trackId)]);
  const added = [...new Set(trackIds)].filter((id) => !known.has(id));
  if (added.length) game.deck = shuffle([...game.deck, ...added], rng);
  return game;
}

/**
 * Draws the next random track and starts a new round for it.
 * Returns the track id, or null when the playlist is empty.
 */
export function nextRound(game, trackIds, rng = Math.random) {
  if (game.deck.length === 0) buildDeck(game, trackIds, rng);
  const trackId = game.deck.shift();
  if (!trackId) return null;
  const starter = nextStarter(game);
  if (starter) {
    const starterIndex = game.contestants.indexOf(starter);
    game.nextStarterId = game.contestants[(starterIndex + 1) % game.contestants.length].id;
  }
  game.rounds.push({
    trackId,
    awards: {},
    out: [],
    attempted: [],
    boardActive: false,
    currentTurnId: starter?.id ?? null,
    turnDeadlineAt: null,
    turnSeconds: null,
    listenDeadlineAt: null,
    phase: game.mode === 'no-steve' ? 'turn' : 'manual',
    revealed: hiddenAnswers(),
  });
  return trackId;
}

function hiddenAnswers() {
  return { artist: false, title: false, year: false };
}

/**
 * The round's revealed-answer flags (what the audience / TV may see). Scored categories
 * always count as revealed. Returns the live object on the round so callers can set flags.
 */
export function revealedAnswers(game, round = currentRound(game)) {
  if (!round) return hiddenAnswers();
  round.revealed = { ...hiddenAnswers(), ...(round.revealed ?? {}) };
  for (const category of scoredCategories(round, game.contestants)) round.revealed[category] = true;
  return round.revealed;
}

export function revealAnswer(game, category, round = currentRound(game)) {
  if (!CATEGORIES.includes(category)) throw new Error(`Unknown category: ${category}`);
  if (round) revealedAnswers(game, round)[category] = true;
}

export function revealAllAnswers(game, round = currentRound(game)) {
  if (round) round.revealed = { artist: true, title: true, year: true };
}

export function allAnswersRevealed(game, round = currentRound(game)) {
  return CATEGORIES.every((category) => revealedAnswers(game, round)[category]);
}

/**
 * Builds the audience-safe snapshot for the TV / presentation view. Only answers that are
 * revealed are included, so hidden answers never leave the host screen.
 * `answers` holds the display strings for the current song: { artist, title, year, image, album }.
 */
export function presentationSnapshot(game, { answers = {}, phase = null, now = Date.now() } = {}) {
  const round = currentRound(game);
  const revealed = revealedAnswers(game, round);
  const complete = Boolean(round) && CATEGORIES.every((category) => revealed[category]);
  const turn = currentTurn(game);
  return {
    version: 1,
    sentAt: now,
    mode: game.mode,
    targetScore: game.targetScore,
    roundNumber: game.rounds.length,
    phase: phase ?? round?.phase ?? 'idle',
    turnName: turn?.name ?? null,
    upNextName: upNextTurn(game)?.name ?? null,
    // No Steve runs a clock every turn; I'm Steve only when the host taps "Put the clock on em".
    clock: round?.turnDeadlineAt
      ? game.mode === 'im-steve'
        ? { deadlineAt: round.turnDeadlineAt, seconds: MANUAL_DISPLAY_SECONDS, manual: true }
        : { deadlineAt: round.turnDeadlineAt, seconds: round.turnSeconds ?? null, manual: false }
      : null,
    answers: Object.fromEntries(CATEGORIES.map((category) => [
      category,
      round && revealed[category] && answers[category] != null ? String(answers[category]) : null,
    ])),
    revealed: { ...revealed },
    complete,
    image: complete && answers.image ? String(answers.image) : null,
    album: complete && answers.album ? String(answers.album) : null,
    round: game.contestants.map((contestant) => ({
      name: contestant.name,
      points: round ? roundPoints(round, contestant.id) : 0,
      out: Boolean(round?.out?.includes(contestant.id)),
      current: turn?.id === contestant.id,
    })),
    standings: standings(game).map((row) => ({
      rank: row.rank,
      name: row.contestant.name,
      members: row.contestant.members,
      total: row.total,
      byCategory: { ...row.byCategory },
    })),
  };
}

export function currentRound(game) {
  return game.rounds[game.rounds.length - 1] ?? null;
}

export function currentTurn(game) {
  const round = currentRound(game);
  return game.contestants.find((contestant) => contestant.id === round?.currentTurnId) ?? null;
}

/**
 * Who plays after the current contestant if they miss or pass: the turn rules run on a copy
 * of the round, so this always agrees with what really happens next. Null when nobody is left.
 */
export function upNextTurn(game) {
  const round = currentRound(game);
  const turn = currentTurn(game);
  if (!round || !turn) return null;
  const preview = { contestants: game.contestants, rounds: [structuredClone(round)] };
  resolveManualTurn(preview, 0, turn.id, null);
  return currentTurn(preview);
}

/** Awards an unsolved category to the contestant whose turn it is. */
export function setAward(game, roundIndex, contestantId, category) {
  if (!CATEGORIES.includes(category)) throw new Error(`Unknown category: ${category}`);
  const round = game.rounds[roundIndex];
  if (!round) throw new Error(`No round ${roundIndex}`);
  if (!game.contestants.some((c) => c.id === contestantId)) {
    throw new Error(`Unknown contestant: ${contestantId}`);
  }
  if (round.currentTurnId !== contestantId || round.out?.includes(contestantId)) {
    throw new Error('It is not this contestant’s turn');
  }
  if (scoredCategories(round, game.contestants).includes(category)) {
    throw new Error(`${CATEGORY_LABELS[category]} has already been identified`);
  }
  const awards = (round.awards[contestantId] ??= { artist: false, title: false, year: false });
  awards[category] = true;
  return true;
}

/** Marks the current contestant out for this song and advances to the next active contestant. */
export function passTurn(game, roundIndex, contestantId) {
  const round = game.rounds[roundIndex];
  if (!round) throw new Error(`No round ${roundIndex}`);
  const currentIndex = game.contestants.findIndex((c) => c.id === contestantId);
  if (currentIndex === -1) throw new Error(`Unknown contestant: ${contestantId}`);
  if (round.currentTurnId !== contestantId || round.out?.includes(contestantId)) {
    throw new Error('It is not this contestant’s turn');
  }
  round.out ??= [];
  round.out.push(contestantId);
  round.currentTurnId = nextActiveContestant(game.contestants, round, currentIndex)?.id ?? null;
  round.turnDeadlineAt = null;
  round.turnSeconds = null;
  return round.currentTurnId;
}

/** Everyone gets one try before successful players rotate through the remaining categories. */
export function resolveManualTurn(game, roundIndex, contestantId, category = null) {
  const round = game.rounds[roundIndex];
  if (!round) throw new Error(`No round ${roundIndex}`);
  const contestantIndex = game.contestants.findIndex((c) => c.id === contestantId);
  if (contestantIndex === -1) throw new Error(`Unknown contestant: ${contestantId}`);
  if (round.currentTurnId !== contestantId || round.out?.includes(contestantId)) {
    throw new Error('It is not this contestant’s turn');
  }
  if (category !== null) setAward(game, roundIndex, contestantId, category);

  round.attempted ??= [];
  round.out ??= [];
  round.boardActive ??= false;
  if (!round.attempted.includes(contestantId)) round.attempted.push(contestantId);
  if (category === null) round.out.push(contestantId);
  round.turnDeadlineAt = null;
  round.turnSeconds = null;

  if (scoredCategories(round, game.contestants).length === CATEGORIES.length) {
    round.currentTurnId = null;
  } else if (!round.boardActive) {
    const nextFirstAttempt = nextContestantMatching(
      game.contestants,
      contestantIndex,
      (contestant) => !round.out.includes(contestant.id) && !round.attempted.includes(contestant.id),
    );
    if (nextFirstAttempt) {
      round.currentTurnId = nextFirstAttempt.id;
    } else {
      round.boardActive = true;
      round.currentTurnId = nextManualRunner(game, round, contestantIndex)?.id ?? null;
    }
  } else {
    round.currentTurnId = nextManualRunner(game, round, contestantIndex)?.id ?? null;
  }

  return { correct: category !== null, nextTurnId: round.currentTurnId, boardActive: round.boardActive };
}

function nextContestantMatching(contestants, previousIndex, predicate) {
  for (let offset = 1; offset <= contestants.length; offset++) {
    const contestant = contestants[(previousIndex + offset) % contestants.length];
    if (predicate(contestant)) return contestant;
  }
  return null;
}

function nextManualRunner(game, round, previousIndex) {
  return nextContestantMatching(game.contestants, previousIndex, (contestant) =>
    !round.out.includes(contestant.id) && roundPoints(round, contestant.id) > 0);
}

/** Scores a guess and keeps correct contestants eligible until they miss or pass. */
export function resolveGuess(game, roundIndex, contestantId, category, correct) {
  if (category !== null && !CATEGORIES.includes(category)) throw new Error(`Unknown category: ${category}`);
  if (typeof correct !== 'boolean') throw new Error('Guess result must be true or false');
  if (correct && category === null) throw new Error('A correct guess must identify a category');
  const round = game.rounds[roundIndex];
  if (!round) throw new Error(`No round ${roundIndex}`);
  if (category !== null && scoredCategories(round, game.contestants).includes(category)) {
    throw new Error(`${CATEGORY_LABELS[category]} has already been identified`);
  }
  const { nextTurnId } = resolveManualTurn(game, roundIndex, contestantId, correct ? category : null);
  return { correct, nextTurnId };
}

export function getAward(round, contestantId, category) {
  return Boolean(round?.awards[contestantId]?.[category]);
}

export function scoredCategories(round, contestants) {
  return CATEGORIES.filter((category) => contestants.some((contestant) => getAward(round, contestant.id, category)));
}

export function roundPoints(round, contestantId) {
  return CATEGORIES.reduce((sum, cat) => sum + (getAward(round, contestantId, cat) ? 1 : 0), 0);
}

/**
 * Returns standings sorted by total (desc), then name. Each entry includes the
 * per-category tally and the maximum possible points (3 per song played).
 */
export function standings(game) {
  const maxPoints = game.rounds.length * CATEGORIES.length;
  const rows = game.contestants.map((contestant) => {
    const byCategory = { artist: 0, title: 0, year: 0 };
    let perfectRounds = 0;
    for (const round of game.rounds) {
      for (const cat of CATEGORIES) if (getAward(round, contestant.id, cat)) byCategory[cat] += 1;
      if (roundPoints(round, contestant.id) === CATEGORIES.length) perfectRounds += 1;
    }
    const total = byCategory.artist + byCategory.title + byCategory.year;
    return { contestant, byCategory, total, maxPoints, perfectRounds };
  });
  rows.sort((a, b) => b.total - a.total || a.contestant.name.localeCompare(b.contestant.name));
  let rank = 0;
  rows.forEach((row, i) => {
    if (i === 0 || row.total !== rows[i - 1].total) rank = i + 1;
    row.rank = rank;
  });
  return rows;
}

/** Clears all scores and played songs but keeps contestants, playlist and the starter rotation. */
export function resetScores(game) {
  game.rounds = [];
  game.deck = [];
  return game;
}

export function serializeGame(game) {
  return JSON.stringify(game);
}

export function deserializeGame(json) {
  try {
    const data = JSON.parse(json);
    if (!data || !Array.isArray(data.contestants) || !Array.isArray(data.rounds)) return null;
    const contestants = data.contestants
      .filter((c) => c && typeof c.id === 'string' && typeof c.name === 'string')
      .map((c) => ({ id: c.id, name: c.name, members: Array.isArray(c.members) ? c.members.map(String) : [] }));
    const roundCount = data.rounds.filter((r) => r && typeof r.trackId === 'string').length;
    const nextStarterId = contestants.some((c) => c.id === data.nextStarterId)
      ? data.nextStarterId
      // Saves from before the rotation pointer used rounds.length % contestants.length.
      : contestants.length ? contestants[roundCount % contestants.length].id : null;
    return {
      nextStarterId,
      playlistId: typeof data.playlistId === 'string' ? data.playlistId : null,
      contestants,
      targetScore: Number.isSafeInteger(data.targetScore) && data.targetScore > 0 ? data.targetScore : DEFAULT_TARGET_SCORE,
      mode: data.mode === 'no-steve' ? 'no-steve' : 'im-steve',
      timings: normalizeTimings(data.timings),
      deck: Array.isArray(data.deck) ? data.deck.filter((id) => typeof id === 'string') : [],
      rounds: data.rounds
        .filter((r) => r && typeof r.trackId === 'string')
        .map((r) => {
          const out = Array.isArray(r.out) ? r.out.filter((id) => typeof id === 'string') : [];
          const hasTurn = Object.hasOwn(r, 'currentTurnId');
          const savedTurn = typeof r.currentTurnId === 'string' ? r.currentTurnId : null;
          const currentTurnId = hasTurn
            ? gameContestantIsActive(contestants, savedTurn, out) ? savedTurn : null
            : contestants.find((contestant) => !out.includes(contestant.id))?.id ?? null;
          return {
            trackId: r.trackId,
            awards: r.awards && typeof r.awards === 'object' ? r.awards : {},
            out,
            attempted: Array.isArray(r.attempted) ? r.attempted.filter((id) => typeof id === 'string') : [],
            boardActive: r.boardActive === true,
            currentTurnId,
            turnDeadlineAt: Number.isSafeInteger(r.turnDeadlineAt) && r.turnDeadlineAt > 0 ? r.turnDeadlineAt : null,
            turnSeconds: Number.isSafeInteger(r.turnSeconds) && r.turnSeconds > 0 ? r.turnSeconds : null,
            listenDeadlineAt: data.mode === 'no-steve' ? null
              : Number.isSafeInteger(r.listenDeadlineAt) && r.listenDeadlineAt > 0 ? r.listenDeadlineAt : null,
            phase: data.mode === 'no-steve' && r.phase === 'listening' ? 'turn'
              : ['listening', 'turn', 'manual', 'reveal', 'game-over'].includes(r.phase) ? r.phase : null,
            revealed: Object.fromEntries(CATEGORIES.map((category) => [category, r.revealed?.[category] === true])),
          };
        }),
    };
  } catch {
    return null;
  }
}

function gameContestantIsActive(contestants, contestantId, out) {
  return contestantId !== null
    && contestants.some((contestant) => contestant?.id === contestantId)
    && !out.includes(contestantId);
}
