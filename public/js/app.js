import { DEFAULT_PLAYLIST_URL } from './config.js';
import {
  CATEGORIES,
  CATEGORY_LABELS,
  addContestant,
  createContestant,
  createGame,
  currentRound,
  deserializeGame,
  isTeam,
  nextRound,
  parsePlaylistId,
  removeContestant,
  resetScores,
  roundPoints,
  serializeGame,
  setAward,
  getAward,
  standings,
} from './game.js';
import { SpotifyClient, handleRedirect, isLoggedIn, logout, redirectUri, startLogin } from './spotify.js';
import { cleanTitle, resolveOriginalYear } from './year.js';

const KEYS = {
  clientId: 'musicGame.clientId',
  playlist: 'musicGame.playlist',
  game: 'musicGame.game',
  years: 'musicGame.years',
  yearOverrides: 'musicGame.yearOverrides',
};

const $ = (id) => document.getElementById(id);

function loadJson(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key)) ?? fallback;
  } catch {
    return fallback;
  }
}

const state = {
  clientId: localStorage.getItem(KEYS.clientId) ?? '',
  playlistInput: localStorage.getItem(KEYS.playlist) ?? DEFAULT_PLAYLIST_URL,
  playlistName: null,
  tracks: new Map(),
  game: deserializeGame(localStorage.getItem(KEYS.game)) ?? createGame(),
  revealed: false,
  years: loadJson(KEYS.years, {}),
  yearOverrides: loadJson(KEYS.yearOverrides, {}),
  pendingYears: new Set(),
  spotify: null,
  playerPromise: null,
};

function saveGame() {
  localStorage.setItem(KEYS.game, serializeGame(state.game));
}

function setStatus(message, isError = false) {
  const el = $('status');
  el.textContent = message;
  el.classList.toggle('error', isError);
}

function reportError(err) {
  console.error(err);
  setStatus(err?.message || String(err), true);
}

function spotify() {
  if (!state.spotify || state.spotify.clientId !== state.clientId) state.spotify = new SpotifyClient(state.clientId);
  return state.spotify;
}

// ---------- Setup ----------

function renderSetup() {
  const loggedIn = Boolean(state.clientId) && isLoggedIn();
  $('client-id').value = state.clientId;
  $('redirect-uri').textContent = redirectUri();
  $('login').textContent = loggedIn ? 'Connected ✓ (log in again)' : 'Log in with Spotify';
  $('logout').hidden = !loggedIn;
  $('playlist').value = state.playlistInput;

  const info = $('playlist-info');
  if (state.tracks.size) {
    info.textContent = `Loaded “${state.playlistName ?? 'playlist'}” — ${state.tracks.size} songs.`;
  } else {
    info.textContent = loggedIn ? 'Playlist not loaded yet.' : 'Log in to load the playlist.';
  }

  const list = $('contestant-list');
  list.replaceChildren(
    ...state.game.contestants.map((c) => {
      const li = document.createElement('li');
      const label = document.createElement('span');
      label.textContent = isTeam(c) ? `👥 ${c.name} (${c.members.join(', ')})` : `🙋 ${c.name}`;
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'secondary';
      remove.textContent = '✕';
      remove.title = `Remove ${c.name}`;
      remove.addEventListener('click', () => {
        if (state.game.rounds.length && !confirm(`Remove ${c.name} and their score?`)) return;
        removeContestant(state.game, c.id);
        saveGame();
        renderSetup();
      });
      li.append(label, remove);
      return li;
    }),
  );

  const ready = loggedIn && state.tracks.size > 0 && state.game.contestants.length > 0;
  $('start').disabled = !ready;
  const resumable = ready && state.game.rounds.length > 0 && state.game.playlistId === parsePlaylistId(state.playlistInput);
  $('resume').hidden = !resumable;
  $('start').textContent = resumable ? 'Start new game' : 'Start game';
}

async function loadPlaylist() {
  const playlistId = parsePlaylistId(state.playlistInput);
  if (!playlistId) throw new Error('That does not look like a Spotify playlist link');
  setStatus('Loading playlist…');
  const client = spotify();
  let name;
  let tracks;
  try {
    [name, tracks] = await Promise.all([client.getPlaylistName(playlistId), client.getPlaylistTracks(playlistId)]);
  } catch (err) {
    if (err.status === 403) {
      throw new Error('Spotify blocked this playlist (403). Log in as the playlist owner/collaborator or use a copy saved to your account.');
    }
    throw err;
  }
  if (!tracks.length) throw new Error('No playable songs found in that playlist');
  state.playlistName = name;
  state.tracks = new Map(tracks.map((t) => [t.id, t]));
  setStatus(`Playlist ready: ${tracks.length} songs`);
  renderSetup();
}

// ---------- Playback ----------

async function ensurePlayer() {
  if (!state.playerPromise) {
    state.playerPromise = spotify()
      .initPlayer('Music Game Host')
      .catch((err) => {
        setStatus(`Browser player unavailable (${err.message}). Pick another Spotify device below.`, true);
        return null;
      });
  }
  await state.playerPromise;
  await refreshDevices();
}

async function refreshDevices() {
  const select = $('device');
  const previous = select.value;
  let devices = [];
  try {
    devices = await spotify().getDevices();
  } catch (err) {
    console.warn(err);
  }
  const options = [];
  const ownId = spotify().deviceId;
  if (ownId) options.push(new Option('This browser', ownId));
  for (const d of devices) {
    if (d.id && d.id !== ownId && !d.is_restricted) options.push(new Option(`${d.name} (${d.type})`, d.id));
  }
  if (!options.length) options.push(new Option('No devices — open Spotify somewhere', ''));
  select.replaceChildren(...options);
  if (options.some((o) => o.value === previous)) select.value = previous;
}

async function playCurrent() {
  const round = currentRound(state.game);
  const track = round && state.tracks.get(round.trackId);
  if (!track) return;
  const deviceId = $('device').value || spotify().deviceId;
  if (!deviceId) throw new Error('No playback device. Open Spotify on a device and press ↻.');
  spotify().activate();
  try {
    await spotify().play(track.uri, deviceId);
    setStatus('Playing… 🎶');
  } catch (err) {
    if (err.status === 404) throw new Error('Spotify device not found. Press ↻ and pick a device.');
    if (err.status === 403) throw new Error('Spotify refused playback (Premium account required).');
    throw err;
  }
}

// ---------- Years ----------

function yearFor(trackId) {
  if (state.yearOverrides[trackId] != null) return { year: state.yearOverrides[trackId], source: 'manual' };
  return state.years[trackId] ?? null;
}

function prefetchYear(trackId) {
  const track = state.tracks.get(trackId);
  if (!track || yearFor(trackId) || state.pendingYears.has(trackId)) return;
  state.pendingYears.add(trackId);
  resolveOriginalYear(track)
    .then((result) => {
      state.years[trackId] = result;
      localStorage.setItem(KEYS.years, JSON.stringify(state.years));
    })
    .finally(() => {
      state.pendingYears.delete(trackId);
      if (currentRound(state.game)?.trackId === trackId) renderAnswer();
      renderHistory();
    });
}

// ---------- Game ----------

function displayTitle(track) {
  return cleanTitle(track.title) || track.title;
}

function trackLabel(track) {
  return track ? `${track.artists.join(', ')} — ${displayTitle(track)}` : 'Unknown song';
}

function renderAnswer() {
  const round = currentRound(state.game);
  const track = round && state.tracks.get(round.trackId);
  $('song-card').classList.toggle('hidden-answer', !state.revealed);
  $('reveal').textContent = state.revealed ? '🙈 Hide answer' : '👀 Reveal answer';
  $('cover').src = (state.revealed && track?.image) || '';
  $('cover').hidden = !(state.revealed && track?.image);
  $('answer-artist').textContent = state.revealed && track ? track.artists.join(', ') : '';
  $('answer-title').textContent = state.revealed && track ? displayTitle(track) : '';
  $('answer-album').textContent = state.revealed && track ? `Spotify: “${track.title}” on ${track.album}` : '';
  const yearInput = $('answer-year');
  const info = track ? yearFor(track.id) : null;
  if (document.activeElement !== yearInput) yearInput.value = state.revealed && info?.year ? info.year : '';
  const sources = { musicbrainz: 'original release (MusicBrainz)', spotify: 'from Spotify album', manual: 'set by host' };
  $('year-source').textContent = !state.revealed
    ? ''
    : info
      ? sources[info.source] ?? ''
      : track && state.pendingYears.has(track.id)
        ? 'looking up original year…'
        : '';
}

function renderRoundScoring() {
  const roundIndex = state.game.rounds.length - 1;
  const round = state.game.rounds[roundIndex];
  const body = $('round-scoring');
  body.replaceChildren(
    ...state.game.contestants.map((c) => {
      const tr = document.createElement('tr');
      const nameCell = document.createElement('td');
      nameCell.textContent = c.name;
      if (isTeam(c)) {
        const members = document.createElement('span');
        members.className = 'members';
        members.textContent = c.members.join(', ');
        nameCell.append(members);
      }
      tr.append(nameCell);
      for (const cat of CATEGORIES) {
        const td = document.createElement('td');
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'toggle';
        const on = getAward(round, c.id, cat);
        btn.setAttribute('aria-pressed', String(on));
        btn.setAttribute('aria-label', `${c.name} got the ${CATEGORY_LABELS[cat].toLowerCase()} right`);
        btn.textContent = on ? '✓' : '—';
        btn.disabled = !round;
        btn.addEventListener('click', () => {
          setAward(state.game, roundIndex, c.id, cat);
          saveGame();
          renderScores();
        });
        td.append(btn);
        tr.append(td);
      }
      const pts = document.createElement('td');
      pts.textContent = `${round ? roundPoints(round, c.id) : 0}/3`;
      tr.append(pts);
      return tr;
    }),
  );
}

function renderScoreboard() {
  const rows = standings(state.game);
  $('scoreboard').replaceChildren(
    ...rows.map((row) => {
      const tr = document.createElement('tr');
      if (row.rank === 1 && row.total > 0) tr.className = 'leader';
      const name = document.createElement('td');
      name.textContent = row.contestant.name;
      if (isTeam(row.contestant)) {
        const members = document.createElement('span');
        members.className = 'members';
        members.textContent = row.contestant.members.join(', ');
        name.append(members);
      }
      const cells = [row.rank, null, row.byCategory.artist, row.byCategory.title, row.byCategory.year, `${row.total}/${row.maxPoints}`];
      cells.forEach((value, i) => {
        if (i === 1) return tr.append(name);
        const td = document.createElement('td');
        td.textContent = String(value);
        tr.append(td);
      });
      return tr;
    }),
  );
}

function renderHistory() {
  const rounds = state.game.rounds;
  const visible = state.revealed ? rounds : rounds.slice(0, -1);
  $('history').replaceChildren(
    ...visible
      .map((round) => {
        const li = document.createElement('li');
        const track = state.tracks.get(round.trackId);
        const year = yearFor(round.trackId)?.year;
        li.textContent = `${trackLabel(track)}${year ? ` (${year})` : ''}`;
        return li;
      })
      .reverse(),
  );
}

function renderScores() {
  renderRoundScoring();
  renderScoreboard();
}

function renderGame() {
  const played = state.game.rounds.length;
  $('round-title').textContent = played ? `Song ${played}` : 'Ready';
  $('deck-info').textContent = `${state.game.deck.length} of ${state.tracks.size} songs left in the shuffle`;
  renderAnswer();
  renderScores();
  renderHistory();
}

function showScreen(name) {
  $('setup').hidden = name !== 'setup';
  $('game').hidden = name !== 'game';
}

async function nextSong() {
  const trackIds = [...state.tracks.keys()];
  const trackId = nextRound(state.game, trackIds);
  if (!trackId) throw new Error('The playlist is empty');
  state.revealed = false;
  saveGame();
  renderGame();
  prefetchYear(trackId);
  if (state.game.deck[0]) prefetchYear(state.game.deck[0]);
  await playCurrent();
}

async function enterGame({ fresh }) {
  const playlistId = parsePlaylistId(state.playlistInput);
  if (fresh) {
    if (state.game.rounds.length && !confirm('Start a new game? Current scores will be cleared.')) return;
    resetScores(state.game);
  }
  state.game.playlistId = playlistId;
  saveGame();
  showScreen('game');
  spotify().activate();
  setStatus('Starting Spotify player…');
  await ensurePlayer();
  // When resuming, drop songs no longer in the playlist from the remaining deck.
  state.game.deck = state.game.deck.filter((id) => state.tracks.has(id));
  if (fresh || !currentRound(state.game) || !state.tracks.has(currentRound(state.game).trackId)) {
    await nextSong();
  } else {
    state.revealed = false;
    renderGame();
    prefetchYear(currentRound(state.game).trackId);
    setStatus('Game resumed — press Play to continue the current song.');
  }
}

// ---------- Events ----------

function on(id, event, handler) {
  $(id).addEventListener(event, (e) => {
    Promise.resolve(handler(e)).catch(reportError);
  });
}

on('spotify-form', 'submit', async (e) => {
  e.preventDefault();
  const clientId = $('client-id').value.trim();
  if (!clientId) throw new Error('Enter your Spotify app Client ID first');
  state.clientId = clientId;
  localStorage.setItem(KEYS.clientId, clientId);
  await startLogin(clientId);
});

on('logout', 'click', () => {
  logout();
  state.tracks = new Map();
  state.playlistName = null;
  setStatus('Logged out');
  renderSetup();
});

on('playlist-form', 'submit', async (e) => {
  e.preventDefault();
  state.playlistInput = $('playlist').value.trim() || DEFAULT_PLAYLIST_URL;
  localStorage.setItem(KEYS.playlist, state.playlistInput);
  if (!isLoggedIn()) throw new Error('Log in with Spotify first');
  await loadPlaylist();
});

on('contestant-form', 'submit', (e) => {
  e.preventDefault();
  const contestant = createContestant($('contestant-name').value, $('contestant-members').value);
  addContestant(state.game, contestant);
  saveGame();
  $('contestant-name').value = '';
  $('contestant-members').value = '';
  $('contestant-name').focus();
  renderSetup();
});

on('start', 'click', () => enterGame({ fresh: true }));
on('resume', 'click', () => enterGame({ fresh: false }));
on('play-pause', 'click', async () => {
  spotify().activate();
  const deviceId = $('device').value || spotify().deviceId;
  if (!(await spotify().togglePlay(deviceId))) await playCurrent();
});
on('replay', 'click', () => playCurrent());
on('reveal', 'click', () => {
  state.revealed = !state.revealed;
  renderAnswer();
  renderHistory();
});
on('next', 'click', () => nextSong());
on('refresh-devices', 'click', () => refreshDevices());
on('answer-year', 'change', () => {
  const round = currentRound(state.game);
  if (!round) return;
  const year = Number.parseInt($('answer-year').value, 10);
  if (Number.isFinite(year) && year >= 1800 && year <= 2100) state.yearOverrides[round.trackId] = year;
  else delete state.yearOverrides[round.trackId];
  localStorage.setItem(KEYS.yearOverrides, JSON.stringify(state.yearOverrides));
  renderAnswer();
});
on('back-to-setup', 'click', async () => {
  await spotify().pause($('device').value || undefined).catch(() => {});
  showScreen('setup');
  renderSetup();
});
on('reset-scores', 'click', () => {
  if (!confirm('Reset all scores and start the shuffle over?')) return;
  resetScores(state.game);
  saveGame();
  return nextSong();
});

document.addEventListener('keydown', (e) => {
  if ($('game').hidden || e.target.closest('input, select, textarea, button') || e.ctrlKey || e.metaKey || e.altKey) return;
  const actions = { ' ': 'play-pause', r: 'reveal', n: 'next' };
  const id = actions[e.key.toLowerCase()];
  if (id) {
    e.preventDefault();
    $(id).click();
  }
});

// ---------- Boot ----------

(async function init() {
  showScreen('setup');
  renderSetup();
  try {
    if (state.clientId && (await handleRedirect(state.clientId))) setStatus('Connected to Spotify ✓');
    renderSetup();
    if (state.clientId && isLoggedIn()) await loadPlaylist();
  } catch (err) {
    reportError(err);
  }
})();
