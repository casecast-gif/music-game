// Pure game logic (no DOM / network) so it can be unit tested with `node --test`.

export const CATEGORIES = ['artist', 'title', 'year'];
export const CATEGORY_LABELS = { artist: 'Artist', title: 'Song', year: 'Year' };
export const DEFAULT_TARGET_SCORE = 15;

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

export function createGame({ playlistId = null, contestants = [], targetScore = DEFAULT_TARGET_SCORE } = {}) {
  return {
    playlistId,
    contestants: contestants.slice(),
    targetScore: Number.isSafeInteger(targetScore) && targetScore > 0 ? targetScore : DEFAULT_TARGET_SCORE,
    deck: [], // remaining track ids to play, in order
    rounds: [], // { trackId, awards: { [contestantId]: { artist, title, year } } }
  };
}

export function addContestant(game, contestant) {
  if (game.contestants.some((c) => c.name.toLowerCase() === contestant.name.toLowerCase())) {
    throw new Error(`"${contestant.name}" is already playing`);
  }
  game.contestants.push(contestant);
  return game;
}

export function removeContestant(game, contestantId) {
  game.contestants = game.contestants.filter((c) => c.id !== contestantId);
  for (const round of game.rounds) delete round.awards[contestantId];
  return game;
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

/**
 * Draws the next random track and starts a new round for it.
 * Returns the track id, or null when the playlist is empty.
 */
export function nextRound(game, trackIds, rng = Math.random) {
  if (game.deck.length === 0) buildDeck(game, trackIds, rng);
  const trackId = game.deck.shift();
  if (!trackId) return null;
  game.rounds.push({ trackId, awards: {} });
  return trackId;
}

export function currentRound(game) {
  return game.rounds[game.rounds.length - 1] ?? null;
}

/** Toggles (or explicitly sets) whether a contestant got a category right in a round. */
export function setAward(game, roundIndex, contestantId, category, value) {
  if (!CATEGORIES.includes(category)) throw new Error(`Unknown category: ${category}`);
  const round = game.rounds[roundIndex];
  if (!round) throw new Error(`No round ${roundIndex}`);
  if (!game.contestants.some((c) => c.id === contestantId)) {
    throw new Error(`Unknown contestant: ${contestantId}`);
  }
  const awards = (round.awards[contestantId] ??= { artist: false, title: false, year: false });
  awards[category] = value === undefined ? !awards[category] : Boolean(value);
  return awards[category];
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

/** Clears all scores and played songs but keeps contestants and playlist. */
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
    return {
      playlistId: typeof data.playlistId === 'string' ? data.playlistId : null,
      contestants: data.contestants
        .filter((c) => c && typeof c.id === 'string' && typeof c.name === 'string')
        .map((c) => ({ id: c.id, name: c.name, members: Array.isArray(c.members) ? c.members.map(String) : [] })),
      targetScore: Number.isSafeInteger(data.targetScore) && data.targetScore > 0 ? data.targetScore : DEFAULT_TARGET_SCORE,
      deck: Array.isArray(data.deck) ? data.deck.filter((id) => typeof id === 'string') : [],
      rounds: data.rounds
        .filter((r) => r && typeof r.trackId === 'string')
        .map((r) => ({ trackId: r.trackId, awards: r.awards && typeof r.awards === 'object' ? r.awards : {} })),
    };
  } catch {
    return null;
  }
}
