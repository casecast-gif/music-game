import { DEFAULT_PLAYLIST_URL, DEFAULT_SPOTIFY_CLIENT_ID } from './config.js';
import {
  CATEGORIES,
  CATEGORY_LABELS,
  DEFAULT_TARGET_SCORE,
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
  scoredCategories,
  serializeGame,
  setAward,
  getAward,
  standings,
} from './game.js';
import { SpotifyClient, handleRedirect, isLoggedIn, logout, redirectUri, startLogin } from './spotify.js';
import { cleanTitle, formatYear, resolveOriginalYear, yearFromDate } from './year.js';

const KEYS = {
  clientId: 'musicGame.clientId',
  playlist: 'musicGame.playlist',
  playlistCache: 'musicGame.playlistCache',
  targetScore: 'musicGame.targetScore',
  game: 'musicGame.game',
  years: 'musicGame.years',
  yearOverrides: 'musicGame.yearOverrides',
  deviceId: 'musicGame.deviceId',
};

const BROWSER_DEVICE = '__browser__';
const EMBEDDED_DEVICE = '__spotify_embed__';
const EMBEDDED_CHANNEL = 'music-game-spotify-player';
const $ = (id) => document.getElementById(id);
let embeddedPlayerWindow = null;
let embeddedPlayerReady = false;
let embeddedPlayerUri = null;
let embeddedPendingTrack = null;
let embeddedIsPaused = null;

function loadJson(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key)) ?? fallback;
  } catch {
    return fallback;
  }
}

function loadTargetScore() {
  const score = Number(localStorage.getItem(KEYS.targetScore));
  return Number.isSafeInteger(score) && score > 0 ? score : DEFAULT_TARGET_SCORE;
}

const state = {
  clientId: localStorage.getItem(KEYS.clientId) ?? DEFAULT_SPOTIFY_CLIENT_ID,
  playlistInput: localStorage.getItem(KEYS.playlist) ?? DEFAULT_PLAYLIST_URL,
  playlistName: null,
  tracks: new Map(),
  game: deserializeGame(localStorage.getItem(KEYS.game)) ?? createGame(),
  targetScore: loadTargetScore(),
  revealedAnswers: { artist: false, title: false, year: false },
  years: loadJson(KEYS.years, {}),
  yearOverrides: loadJson(KEYS.yearOverrides, {}),
  fallbackYears: {},
  pendingYears: new Set(),
  spotify: null,
  playerPromise: null,
  selectedDeviceId: localStorage.getItem(KEYS.deviceId) ?? '',
  loadingPlaylist: false,
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
  $('target-score').value = String(state.targetScore);
  $('spotify-state').textContent = loggedIn ? 'Connected' : 'Not connected';
  $('playlist-state').textContent = state.loadingPlaylist
    ? 'Loading…'
    : state.tracks.size
      ? `Ready · ${state.tracks.size.toLocaleString()} songs`
      : 'Not loaded';

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

  const ready = loggedIn && !state.loadingPlaylist && state.tracks.size > 0 && state.game.contestants.length > 0;
  $('start').disabled = !ready;
  const resumable = ready && state.game.rounds.length > 0 && state.game.playlistId === parsePlaylistId(state.playlistInput);
  $('resume').hidden = !resumable;
  $('start').textContent = resumable ? 'Start new game' : 'Start game';
}

async function loadPlaylist() {
  const playlistId = parsePlaylistId(state.playlistInput);
  if (!playlistId) throw new Error('That does not look like a Spotify playlist link');
  state.loadingPlaylist = true;
  renderSetup();
  setStatus('Loading playlist…');
  const client = spotify();
  let name;
  let tracks;
  try {
    [name, tracks] = await Promise.all([
      client.getPlaylistName(playlistId),
      client.getPlaylistTracks(playlistId, {
        onProgress: (loaded, total) => {
          setStatus(`Loading playlist… ${loaded.toLocaleString()} / ${total.toLocaleString()}`);
          $('playlist-state').textContent = `Loading… ${loaded.toLocaleString()} / ${total.toLocaleString()}`;
        },
      }),
    ]);
  } catch (err) {
    if (err.status === 403) {
      throw new Error('Spotify blocked this playlist (403). Log in as the playlist owner/collaborator or use a copy saved to your account.');
    }
    throw err;
  } finally {
    state.loadingPlaylist = false;
    renderSetup();
  }
  if (!tracks.length) throw new Error('No playable songs found in that playlist');
  state.playlistName = name;
  state.tracks = new Map(tracks.map((t) => [t.id, t]));
  let cached = true;
  try {
    localStorage.setItem(KEYS.playlistCache, JSON.stringify({
      playlistId,
      name,
      tracks: [...state.tracks.values()],
    }));
    $('setup-settings').open = false;
  } catch (err) {
    cached = false;
    console.warn('Could not cache the loaded playlist', err);
  }
  setStatus(cached
    ? `Playlist ready: ${state.tracks.size.toLocaleString()} songs`
    : 'Playlist loaded, but could not be cached; it will need reloading next time.');
  renderSetup();
}

// ---------- Playback ----------

function embeddedPlayerIsOpen() {
  if (embeddedPlayerWindow && embeddedPlayerWindow.closed) {
    embeddedPlayerWindow = null;
    embeddedPlayerReady = false;
    embeddedPlayerUri = null;
    embeddedPendingTrack = null;
    embeddedIsPaused = null;
  }
  return Boolean(embeddedPlayerWindow);
}

function postEmbeddedMessage(type, data = {}) {
  if (!embeddedPlayerIsOpen() || !embeddedPlayerReady) return false;
  embeddedPlayerWindow.postMessage({ channel: EMBEDDED_CHANNEL, type, ...data }, location.origin);
  return true;
}

function flushEmbeddedTrack() {
  if (!embeddedPlayerReady || !embeddedPendingTrack) return;
  const { uri, play } = embeddedPendingTrack;
  embeddedPendingTrack = null;
  if (uri !== embeddedPlayerUri) {
    embeddedPlayerUri = uri;
    postEmbeddedMessage('load', { uri, play });
  } else if (play) {
    postEmbeddedMessage('play');
  }
}

function requestEmbeddedTrack(uri, play = false) {
  if (!embeddedPlayerIsOpen()) {
    throw new Error('Open the host Spotify player window before using it for playback.');
  }
  embeddedPendingTrack = { uri, play };
  flushEmbeddedTrack();
}

function openEmbeddedPlayer(uri, { play = false } = {}) {
  const current = currentRound(state.game);
  const track = current && state.tracks.get(current.trackId);
  const initialUri = uri ?? track?.uri ?? state.tracks.values().next().value?.uri;
  if (!initialUri) throw new Error('Load a playlist and start a game before opening the Spotify player.');

  if (embeddedPlayerIsOpen()) {
    embeddedPlayerWindow.focus();
    requestEmbeddedTrack(initialUri, play);
  } else {
    const url = new URL('./spotify-player.html', location.href);
    url.searchParams.set('uri', initialUri);
    const popup = window.open(url.toString(), 'music-game-spotify-player', 'popup,width=460,height=560,resizable=yes');
    if (!popup) throw new Error('The Spotify player window was blocked. Allow popups for this site and try again.');
    embeddedPlayerWindow = popup;
    embeddedPlayerReady = false;
    embeddedPlayerUri = initialUri;
    embeddedPendingTrack = { uri: initialUri, play };
    embeddedIsPaused = null;
  }

  state.selectedDeviceId = EMBEDDED_DEVICE;
  localStorage.setItem(KEYS.deviceId, EMBEDDED_DEVICE);
  $('device').value = EMBEDDED_DEVICE;
  setStatus('Spotify host player opened. Track details are shown only in that window.');
}

async function ensurePlayer() {
  if (spotify().deviceId) return spotify().deviceId;
  if (!state.playerPromise) {
    state.playerPromise = spotify().initPlayer('Music Game', undefined, (err) => setStatus(err.message, true)).catch((err) => {
      state.playerPromise = null;
      throw err;
    });
  }
  return state.playerPromise;
}

async function refreshDevices() {
  const select = $('device');
  const previous = select.value || state.selectedDeviceId;
  const devices = await spotify().getDevices();
  const options = [new Option('Choose a Spotify device…', '')];
  const ownId = spotify().deviceId;
  for (const d of devices) {
    if (d.id && d.id !== ownId && !d.is_restricted) {
      const activeLabel = d.is_active ? ', active' : '';
      options.push(new Option(`${d.name} (${d.type}${activeLabel})`, d.id));
    }
  }
  if (ownId) options.push(new Option('This browser', ownId));
  else options.push(new Option('This browser (enable playback)', BROWSER_DEVICE));
  select.replaceChildren(...options);
  const previousOption = previous === BROWSER_DEVICE && ownId ? ownId : previous;
  const previousDevice = devices.find((device) => device.id === previousOption);
  const previousIsBrowser = Boolean(ownId && previousOption === ownId) || (previous === BROWSER_DEVICE && !ownId);
  const preferred = previousIsBrowser || previousDevice?.is_active
    ? options.find((option) => option.value === previousOption)
    : options.find((option) => devices.find((device) => device.id === option.value)?.is_active)
      ?? options.find((option) => option.value === ownId && ownId)
      ?? options.find((option) => option.value && option.value !== BROWSER_DEVICE);
  if (preferred) select.value = preferred.value;
  state.selectedDeviceId = select.value === ownId && ownId ? BROWSER_DEVICE : select.value;
  if (state.selectedDeviceId) localStorage.setItem(KEYS.deviceId, state.selectedDeviceId);
  else localStorage.removeItem(KEYS.deviceId);
  if (!devices.length && !ownId) {
    setStatus('No Spotify devices found. Open Spotify on the intended device, or enable this browser as a player.');
  }
  return devices;
}

async function playCurrent() {
  const round = currentRound(state.game);
  const track = round && state.tracks.get(round.trackId);
  if (!track) return;
  let deviceId = $('device').value;
  if (deviceId === EMBEDDED_DEVICE) {
    requestEmbeddedTrack(track.uri, true);
    setStatus('Game song sent to the Spotify player window. Use its Play control if playback does not start.');
    return;
  }
  if (deviceId === BROWSER_DEVICE) {
    try {
      if (!spotify().deviceId) {
        deviceId = await ensurePlayer();
        await refreshDevices();
        $('device').value = deviceId;
        state.selectedDeviceId = BROWSER_DEVICE;
        localStorage.setItem(KEYS.deviceId, BROWSER_DEVICE);
        setStatus('This browser is prepared. Click Play again to start the song.');
        return;
      }
      deviceId = spotify().deviceId;
    } catch (browserError) {
      const devices = await refreshDevices();
      const connectDevices = devices.filter((device) => device.id && device.id !== spotify().deviceId && !device.is_restricted);
      const fallback = connectDevices.find((device) => device.is_active) ?? connectDevices[0];
      if (!fallback) throw browserError;
      deviceId = fallback.id;
      $('device').value = deviceId;
      state.selectedDeviceId = deviceId;
      localStorage.setItem(KEYS.deviceId, deviceId);
      setStatus(`Browser playback unavailable. Falling back to ${fallback.name}.`);
    }
  }
  if (!deviceId) throw new Error('Choose a Spotify device, or open Spotify on the intended device and refresh the device list.');
  spotify().activate();
  try {
    setStatus('Starting playback…');
    await spotify().play(track.uri, deviceId);
    setStatus('Playing… 🎶');
  } catch (err) {
    if (err.status === 404) throw new Error(`Spotify device not found: ${err.message}. Press ↻ and pick an active device.`);
    if (err.status === 403) throw new Error(`Spotify refused playback: ${err.message}. Premium is required for playback control.`);
    throw err;
  }
}

// ---------- Years ----------

function yearFor(trackId) {
  if (state.yearOverrides[trackId] != null) return { year: state.yearOverrides[trackId], source: 'manual' };
  const cached = state.years[trackId] ?? state.fallbackYears[trackId];
  if (cached) return cached;
  const spotifyYear = yearFromDate(state.tracks.get(trackId)?.releaseDate);
  return spotifyYear ? { year: spotifyYear, source: 'spotify' } : null;
}

function prefetchYear(trackId) {
  const track = state.tracks.get(trackId);
  if (!track || state.yearOverrides[trackId] != null || state.years[trackId] || state.pendingYears.has(trackId)) return;
  state.pendingYears.add(trackId);
  resolveOriginalYear(track)
    .then(({ year, source, complete }) => {
      if (complete) {
        state.years[trackId] = { year, source };
        localStorage.setItem(KEYS.years, JSON.stringify(state.years));
      } else {
        // Lookup failed part-way: show the fallback now but retry on a later visit.
        state.fallbackYears[trackId] = { year, source };
      }
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

function answersComplete() {
  return Object.values(state.revealedAnswers).every(Boolean);
}

function revealAllAnswers() {
  state.revealedAnswers = { artist: true, title: true, year: true };
}

function renderAnswer() {
  const round = currentRound(state.game);
  const track = round && state.tracks.get(round.trackId);
  for (const category of scoredCategories(round, state.game.contestants)) state.revealedAnswers[category] = true;
  const allAnswersComplete = answersComplete();
  const revealControls = {
    artist: $('reveal-artist'),
    title: $('reveal-title'),
    year: $('reveal-year'),
  };
  for (const [category, button] of Object.entries(revealControls)) {
    button.disabled = state.revealedAnswers[category];
    button.textContent = state.revealedAnswers[category]
      ? `${CATEGORY_LABELS[category]} revealed ✓`
      : `Reveal ${CATEGORY_LABELS[category].toLowerCase()}`;
  }
  $('wrong-reveal').disabled = allAnswersComplete;
  $('cover').src = (allAnswersComplete && track?.image) || '';
  $('cover').hidden = !(allAnswersComplete && track?.image);
  $('answer-artist').textContent = state.revealedAnswers.artist && track ? track.artists.join(', ') : '?';
  $('answer-artist').classList.toggle('answer-hidden', !state.revealedAnswers.artist);
  $('answer-title').textContent = state.revealedAnswers.title && track ? displayTitle(track) : '?';
  $('answer-title').classList.toggle('answer-hidden', !state.revealedAnswers.title);
  $('answer-album').textContent = allAnswersComplete && track ? `Spotify: “${track.title}” on ${track.album}` : '';
  $('answer-album').hidden = !allAnswersComplete;
  const yearInput = $('answer-year');
  const info = track ? yearFor(track.id) : null;
  yearInput.hidden = !state.revealedAnswers.year;
  $('answer-year-placeholder').hidden = state.revealedAnswers.year;
  if (document.activeElement !== yearInput) yearInput.value = state.revealedAnswers.year && info?.year ? formatYear(info.year) : '?';
  yearInput.classList.toggle('answer-hidden', !state.revealedAnswers.year);
  const sources = { musicbrainz: 'original release (MusicBrainz)', spotify: 'from Spotify album', manual: 'set by host' };
  $('year-source').textContent = !state.revealedAnswers.year
    ? ''
    : info
      ? state.pendingYears.has(track.id) && info.source === 'spotify'
        ? 'Spotify album year; checking original release…'
        : sources[info.source] ?? ''
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
          const scored = setAward(state.game, roundIndex, c.id, cat);
          if (scored) state.revealedAnswers[cat] = true;
          saveGame();
          renderAnswer();
          renderHistory();
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
  $('score-goal').textContent = `Playing to ${state.game.targetScore} points`;
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
      const cells = [row.rank, null, row.byCategory.artist, row.byCategory.title, row.byCategory.year, `${row.total}/${state.game.targetScore}`];
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
  const visible = answersComplete() ? rounds : rounds.slice(0, -1);
  $('history').replaceChildren(
    ...visible
      .map((round) => {
        const li = document.createElement('li');
        const track = state.tracks.get(round.trackId);
        const year = yearFor(round.trackId)?.year;
        li.textContent = `${trackLabel(track)}${year ? ` (${formatYear(year)})` : ''}`;
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
  $('round-title').textContent = 'Biggest hits of all time';
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
  spotify().activate();
  const trackIds = [...state.tracks.keys()];
  const trackId = nextRound(state.game, trackIds);
  if (!trackId) throw new Error('The playlist is empty');
  state.revealedAnswers = { artist: false, title: false, year: false };
  saveGame();
  renderGame();
  prefetchYear(trackId);
  if (state.game.deck[0]) prefetchYear(state.game.deck[0]);
  await playCurrent();
}

async function enterGame({ fresh }) {
  const playlistId = parsePlaylistId(state.playlistInput);
  if (fresh) {
    const targetScore = Number($('target-score').value);
    if (!Number.isSafeInteger(targetScore) || targetScore < 1) throw new Error('The target score must be a positive whole number.');
    state.targetScore = targetScore;
    localStorage.setItem(KEYS.targetScore, String(targetScore));
    if (state.game.rounds.length && !confirm('Start a new game? Current scores will be cleared.')) return;
    resetScores(state.game);
    state.game.targetScore = state.targetScore;
  } else {
    state.targetScore = state.game.targetScore;
    localStorage.setItem(KEYS.targetScore, String(state.targetScore));
  }
  state.game.playlistId = playlistId;
  saveGame();
  showScreen('game');
  spotify().activate();
  setStatus('Checking Spotify devices…');
  await refreshDevices();
  // When resuming, drop songs no longer in the playlist from the remaining deck.
  state.game.deck = state.game.deck.filter((id) => state.tracks.has(id));
  if (fresh || !currentRound(state.game) || !state.tracks.has(currentRound(state.game).trackId)) {
    await nextSong();
  } else {
    state.revealedAnswers = { artist: false, title: false, year: false };
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

window.addEventListener('message', (event) => {
  if (
    !embeddedPlayerWindow ||
    event.source !== embeddedPlayerWindow ||
    event.origin !== location.origin ||
    event.data?.channel !== EMBEDDED_CHANNEL
  ) return;

  if (event.data.type === 'ready') {
    embeddedPlayerReady = true;
    if (typeof event.data.uri === 'string') embeddedPlayerUri = event.data.uri;
    flushEmbeddedTrack();
    return;
  }
  if (event.data.type === 'playback') {
    embeddedIsPaused = Boolean(event.data.isPaused);
    setStatus(embeddedIsPaused ? 'Spotify player is paused.' : 'Playing in Spotify player.');
    return;
  }
  if (event.data.type === 'error') setStatus(`Spotify player error: ${event.data.message}`, true);
});

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

on('target-score', 'change', () => {
  const targetScore = Number($('target-score').value);
  if (!Number.isSafeInteger(targetScore) || targetScore < 1) {
    $('target-score').value = String(state.targetScore);
    throw new Error('The target score must be a positive whole number.');
  }
  state.targetScore = targetScore;
  localStorage.setItem(KEYS.targetScore, String(targetScore));
  setStatus(`Target score saved: ${targetScore} points`);
});

on('start', 'click', () => enterGame({ fresh: true }));
on('resume', 'click', () => enterGame({ fresh: false }));
on('open-spotify-player', 'click', () => openEmbeddedPlayer());
on('enable-browser-player', 'click', async () => {
  if (spotify().deviceId) {
    spotify().activate();
    setStatus('Browser audio activated. Select this browser and press Play.');
    return;
  }
  setStatus('Starting Spotify playback in this browser…');
  const deviceId = await ensurePlayer();
  state.selectedDeviceId = BROWSER_DEVICE;
  localStorage.setItem(KEYS.deviceId, BROWSER_DEVICE);
  await refreshDevices();
  $('device').value = deviceId;
  state.selectedDeviceId = BROWSER_DEVICE;
  localStorage.setItem(KEYS.deviceId, BROWSER_DEVICE);
  setStatus('This browser is prepared. Select it and press Play to start a song.');
});
on('play-pause', 'click', async () => {
  spotify().activate();
  let deviceId = $('device').value;
  const round = currentRound(state.game);
  const track = round && state.tracks.get(round.trackId);
  if (!track) return;
  if (deviceId === EMBEDDED_DEVICE) {
    if (!embeddedPlayerIsOpen()) return openEmbeddedPlayer(track.uri, { play: true });
    if (!embeddedPlayerReady || embeddedPlayerUri !== track.uri) {
      requestEmbeddedTrack(track.uri, true);
      setStatus('Preparing the game song in the Spotify player window…');
      return;
    }
    const action = embeddedIsPaused === false ? 'pause' : 'play';
    postEmbeddedMessage(action);
    setStatus(action === 'play' ? 'Starting playback in the Spotify player window…' : 'Pausing the Spotify player…');
    return;
  }
  if (deviceId === BROWSER_DEVICE) deviceId = spotify().deviceId;
  if (!deviceId) return playCurrent();
  if (!(await spotify().togglePlay(deviceId, track.uri))) await playCurrent();
});
on('replay', 'click', () => {
  spotify().activate();
  const deviceId = $('device').value;
  if (deviceId !== EMBEDDED_DEVICE) return playCurrent();
  const track = state.tracks.get(currentRound(state.game)?.trackId);
  if (!track) return;
  if (!embeddedPlayerIsOpen()) return openEmbeddedPlayer(track.uri, { play: true });
  if (!embeddedPlayerReady || embeddedPlayerUri !== track.uri) {
    requestEmbeddedTrack(track.uri, true);
    return;
  }
  postEmbeddedMessage('restart');
});
for (const category of CATEGORIES) {
  on(`reveal-${category}`, 'click', () => {
    state.revealedAnswers[category] = true;
    renderAnswer();
    renderHistory();
  });
}
on('wrong-reveal', 'click', () => {
  revealAllAnswers();
  renderAnswer();
  renderHistory();
});
on('next', 'click', () => nextSong());
on('refresh-devices', 'click', () => refreshDevices());
on('device', 'change', async () => {
  const selectedDevice = $('device').value;
  if (state.selectedDeviceId === EMBEDDED_DEVICE && selectedDevice !== EMBEDDED_DEVICE && embeddedIsPaused === false) {
    postEmbeddedMessage('pause');
  }
  state.selectedDeviceId = selectedDevice === spotify().deviceId && selectedDevice
    ? BROWSER_DEVICE
    : selectedDevice;
  if (state.selectedDeviceId) localStorage.setItem(KEYS.deviceId, state.selectedDeviceId);
  if (selectedDevice === EMBEDDED_DEVICE) {
    const track = state.tracks.get(currentRound(state.game)?.trackId);
    openEmbeddedPlayer(track?.uri);
    return;
  }
  if (selectedDevice === BROWSER_DEVICE) {
    setStatus('Starting Spotify browser player…');
    spotify().activate();
    const deviceId = await ensurePlayer();
    await refreshDevices();
    $('device').value = deviceId;
    state.selectedDeviceId = BROWSER_DEVICE;
    localStorage.setItem(KEYS.deviceId, BROWSER_DEVICE);
    setStatus('This browser is prepared. Press Play to start the current song.');
  }
});
on('answer-year', 'change', () => {
  const round = currentRound(state.game);
  if (!round) return;
  const yearText = $('answer-year').value.trim();
  const year = Number(yearText);
  if (/^\d{4}$/.test(yearText) && Number.isFinite(year) && year >= 1800 && year <= 2100) state.yearOverrides[round.trackId] = year;
  else delete state.yearOverrides[round.trackId];
  localStorage.setItem(KEYS.yearOverrides, JSON.stringify(state.yearOverrides));
  renderAnswer();
});
on('answer-year', 'blur', () => renderAnswer());
on('back-to-setup', 'click', async () => {
  const deviceId = $('device').value;
  if (deviceId === EMBEDDED_DEVICE) {
    if (embeddedPlayerIsOpen() && embeddedPlayerReady) postEmbeddedMessage('pause');
  } else {
    await spotify().pause(deviceId || undefined).catch(() => {});
  }
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
  const actions = { ' ': 'play-pause', r: 'wrong-reveal', n: 'next' };
  const id = actions[e.key.toLowerCase()];
  if (id) {
    e.preventDefault();
    $(id).click();
  }
});

// ---------- Boot ----------

(async function init() {
  showScreen('setup');
  $('setup-settings').open = !state.clientId || !isLoggedIn();
  renderSetup();
  try {
    if (state.clientId && (await handleRedirect(state.clientId))) setStatus('Connected to Spotify ✓');
    renderSetup();
    const playlistId = parsePlaylistId(state.playlistInput);
    const cache = loadJson(KEYS.playlistCache, null);
    if (
      playlistId &&
      cache?.playlistId === playlistId &&
      Array.isArray(cache.tracks) &&
      cache.tracks.every((track) => track && typeof track.id === 'string' && typeof track.uri === 'string')
    ) {
      state.playlistName = typeof cache.name === 'string' ? cache.name : null;
      state.tracks = new Map(cache.tracks.map((track) => [track.id, track]));
      if (state.clientId && isLoggedIn()) $('setup-settings').open = false;
      setStatus(`Playlist ready from cache: ${state.tracks.size.toLocaleString()} songs`);
      renderSetup();
    } else if (state.clientId && isLoggedIn()) {
      await loadPlaylist();
    }
  } catch (err) {
    reportError(err);
  }
})();
