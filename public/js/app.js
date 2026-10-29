import { DEFAULT_PLAYLIST_URL, DEFAULT_SPOTIFY_CLIENT_ID } from './config.js';
import {
  CATEGORIES,
  CATEGORY_LABELS,
  DEFAULT_TARGET_SCORE,
  MANUAL_TURN_SECONDS,
  guessTimeLimitSeconds,
  manualClockDisplaySeconds,
  addContestant,
  createContestant,
  createGame,
  currentRound,
  currentTurn,
  deserializeGame,
  isTeam,
  nextRound,
  parsePlaylistId,
  passTurn,
  removeContestant,
  resolveManualTurn,
  resolveGuess,
  resetScores,
  roundPoints,
  scoredCategories,
  serializeGame,
  getAward,
  standings,
} from './game.js';
import { SpotifyClient, handleRedirect, isLoggedIn, logout, redirectUri, startLogin } from './spotify.js';
import { MOCK_PLAYLIST_NAME, MOCK_TRACKS, MockSpotifyClient } from './mock-spotify.js';
import { cleanTitle, formatYear, guessMatchCategories, guessMatches, resolveOriginalYear, yearFromDate } from './year.js';

const KEYS = {
  clientId: 'musicGame.clientId',
  playlist: 'musicGame.playlist',
  playlistCache: 'musicGame.playlistCache',
  targetScore: 'musicGame.targetScore',
  mode: 'musicGame.mode',
  game: 'musicGame.game',
  years: 'musicGame.years',
  yearOverrides: 'musicGame.yearOverrides',
  deviceId: 'musicGame.deviceId',
  spotifyApiMode: 'musicGame.spotifyApiMode',
};

const BROWSER_DEVICE = '__browser__';
const EMBEDDED_DEVICE = '__spotify_embed__';
const EMBEDDED_CHANNEL = 'music-game-spotify-player';
const LISTEN_DURATION_MS = 15_000;
const ROUND_REVEAL_MS = 6_000;
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

function readPlaylistCache(playlistId) {
  const cache = loadJson(KEYS.playlistCache, null);
  if (
    cache?.playlistId === playlistId &&
    Array.isArray(cache.tracks) &&
    cache.tracks.every((track) => track && typeof track.id === 'string' && typeof track.uri === 'string')
  ) return cache;
  return null;
}

function loadMockPlaylist() {
  state.loadingPlaylist = false;
  state.playlistName = MOCK_PLAYLIST_NAME;
  state.tracks = new Map(MOCK_TRACKS.map((track) => [track.id, { ...track, artists: [...track.artists] }]));
  renderSetup();
  setStatus('Mock samples loaded. No external API requests were made.');
}

function setSpotifyApiMode(mode, { persist = true } = {}) {
  state.spotifyApiMode = mode === 'live' ? 'live' : 'mock';
  if (persist) localStorage.setItem(KEYS.spotifyApiMode, state.spotifyApiMode);
  state.spotify = null;
  state.playerPromise = null;
  state.selectedDeviceId = '';
  localStorage.removeItem(KEYS.deviceId);
  if (state.spotifyApiMode === 'mock') {
    loadMockPlaylist();
    return;
  }
  if (state.playlistName === MOCK_PLAYLIST_NAME) {
    state.playlistName = null;
    state.tracks = new Map();
  }
  renderSetup();
  setStatus('Live Spotify selected. No request was made; load the playlist or log in only when ready.');
}

function loadTargetScore() {
  const score = Number(localStorage.getItem(KEYS.targetScore));
  return Number.isSafeInteger(score) && score > 0 ? score : DEFAULT_TARGET_SCORE;
}

function loadSelectedMode(savedGame) {
  const savedMode = localStorage.getItem(KEYS.mode);
  if (savedMode === 'no-steve' || savedMode === 'im-steve') return savedMode;
  return savedGame.mode;
}

const initialGame = deserializeGame(localStorage.getItem(KEYS.game)) ?? createGame();

const state = {
  spotifyApiMode: localStorage.getItem(KEYS.spotifyApiMode) === 'live' ? 'live' : 'mock',
  clientId: localStorage.getItem(KEYS.clientId) ?? DEFAULT_SPOTIFY_CLIENT_ID,
  playlistInput: localStorage.getItem(KEYS.playlist) ?? DEFAULT_PLAYLIST_URL,
  playlistName: null,
  tracks: new Map(),
  game: initialGame,
  selectedMode: loadSelectedMode(initialGame),
  targetScore: loadTargetScore(),
  roundPhase: 'idle',
  turnTimerInterval: null,
  advanceTimeout: null,
  recognition: null,
  listeningDeadlineAt: null,
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
  const mock = state.spotifyApiMode === 'mock';
  if (!state.spotify || state.spotify.clientId !== state.clientId || Boolean(state.spotify.isMock) !== mock) {
    state.spotify = mock ? new MockSpotifyClient(state.clientId) : new SpotifyClient(state.clientId);
  }
  return state.spotify;
}

// ---------- Setup ----------

function renderSetup() {
  const loggedIn = Boolean(state.clientId) && isLoggedIn();
  const mock = state.spotifyApiMode === 'mock';
  const noSteve = state.selectedMode === 'no-steve';
  $('mode-no-steve').setAttribute('aria-pressed', String(noSteve));
  $('mode-im-steve').setAttribute('aria-pressed', String(!noSteve));
  $('mode-no-steve').classList.toggle('primary', noSteve);
  $('mode-im-steve').classList.toggle('primary', !noSteve);
  $('turn-duration-setting').hidden = !noSteve;
  $('mode-description').textContent = noSteve
    ? 'No host needed: the screen runs timed turns, checks submitted guesses, keeps wrong answers hidden, and advances automatically.'
    : 'Host-controlled play: a host operates the reveal and scoring controls, and decides when to move on.';
  $('target-score-hint').textContent = noSteve
    ? 'Points combine correct Artist, Song, and Year guesses. The game ends after the current song when someone reaches the target.'
    : 'Points combine correct Artist, Song, and Year guesses. The target stays visible on the scoreboard but does not stop play.';
  $('client-id').value = state.clientId;
  $('redirect-uri').textContent = redirectUri();
  $('login').textContent = loggedIn ? 'Connected ✓ (log in again)' : 'Log in with Spotify';
  $('playlist').value = state.playlistInput;
  $('target-score').value = String(state.targetScore);
  $('spotify-api-mode').value = state.spotifyApiMode;
  $('spotify-mode-help').textContent = mock
    ? 'Mock mode uses bundled sample songs and silent simulated playback. It sends no Spotify or MusicBrainz requests.'
    : 'Live mode never loads a playlist on page startup. Login, playlist, device, and playback actions may contact Spotify.';
  $('spotify-form').hidden = mock;
  $('redirect-uri-hint').hidden = mock;
  $('client-id').disabled = mock;
  $('login').disabled = mock;
  $('logout').hidden = mock || !loggedIn;
  $('enable-browser-player').disabled = mock;
  $('playlist').disabled = mock;
  $('playlist-form').querySelector('button').textContent = mock ? 'Reload mock samples' : 'Load playlist';
  $('playlist-form').querySelector('button').disabled = state.loadingPlaylist;
  $('spotify-state').textContent = mock ? 'Mock mode (offline)' : loggedIn ? 'Connected' : 'Not connected';
  $('playback-hint').textContent = mock
    ? 'Mock playback is silent and simulated. Select Live Spotify API to play real audio.'
    : 'Full-song playback uses a Spotify device or the browser player. The Spotify preview player is reserved for Name That Tune mode.';
  $('playlist-state').textContent = state.loadingPlaylist
    ? 'Loading…'
    : state.tracks.size
      ? `Ready · ${state.tracks.size.toLocaleString()} songs`
      : 'Not loaded';

  const info = $('playlist-info');
  if (state.tracks.size) {
    info.textContent = `Loaded “${state.playlistName ?? 'playlist'}” — ${state.tracks.size} songs.`;
  } else {
    info.textContent = mock
      ? 'Mock sample songs are not loaded.'
      : loggedIn
        ? 'Click Load playlist to request songs from Spotify.'
        : 'Log in with Spotify, then click Load playlist.';
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

  const ready = (mock || loggedIn) && !state.loadingPlaylist && state.tracks.size > 0 && state.game.contestants.length > 0;
  $('start').disabled = !ready;
  const resumable = ready && state.game.rounds.length > 0 && state.game.playlistId === parsePlaylistId(state.playlistInput);
  $('resume').hidden = !resumable;
  $('resume').textContent = `Resume ${state.game.mode === 'no-steve' ? 'No Steve' : 'I’m Steve'} game`;
  $('start').textContent = resumable ? `Start new ${noSteve ? 'No Steve' : 'I’m Steve'} game` : `Start ${noSteve ? 'No Steve' : 'I’m Steve'} game`;
}

function selectMode(mode) {
  state.selectedMode = mode;
  localStorage.setItem(KEYS.mode, mode);
  renderSetup();
}

async function loadPlaylist() {
  if (state.loadingPlaylist) return;
  if (state.spotifyApiMode === 'mock') {
    loadMockPlaylist();
    return;
  }
  const playlistId = parsePlaylistId(state.playlistInput);
  if (!playlistId) throw new Error('That does not look like a Spotify playlist link');
  state.loadingPlaylist = true;
  renderSetup();
  setStatus('Loading playlist…');
  const client = spotify();
  let info = null;
  let name;
  let tracks;
  try {
    try {
      info = await client.getPlaylistInfo(playlistId);
    } catch (err) {
      if (err.status === 429) throw err;
      console.warn('Could not check the playlist snapshot; loading tracks anyway.', err);
    }
    const cache = readPlaylistCache(playlistId);
    if (info?.snapshotId && cache?.snapshotId === info.snapshotId) {
      name = info.name ?? cache.name;
      tracks = cache.tracks;
    } else {
      tracks = await client.getPlaylistTracks(playlistId, {
        onProgress: (loaded, total) => {
          setStatus(`Loading playlist… ${loaded.toLocaleString()} / ${total.toLocaleString()}`);
          $('playlist-state').textContent = `Loading… ${loaded.toLocaleString()} / ${total.toLocaleString()}`;
        },
      });
      name = info?.name ?? null;
    }
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
      snapshotId: info?.snapshotId ?? null,
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
        setStatus('Browser speaker ready. Starting the game song…');
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
    setStatus(spotify().isMock
      ? 'Mock playback is silent. No Spotify API request was made.'
      : 'Playing… 🎶');
  } catch (err) {
    if (err.status === 404) throw new Error(`Spotify device not found: ${err.message}. Press ↻ and pick an active device.`);
    if (err.status === 403) throw new Error(`Spotify refused playback: ${err.message}. Premium is required for playback control.`);
    throw err;
  }
}

async function pauseCurrent() {
  const selectedDevice = $('device').value;
  if (selectedDevice === EMBEDDED_DEVICE) {
    if (!postEmbeddedMessage('pause')) {
      throw new Error('The Spotify player window is not ready to pause playback.');
    }
    return;
  }
  const deviceId = selectedDevice === BROWSER_DEVICE ? spotify().deviceId : selectedDevice;
  if (!deviceId) throw new Error('Choose an active Spotify device before the listening clip ends.');
  await spotify().pause(deviceId);
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
  if (
    state.spotifyApiMode === 'mock' ||
    !track ||
    state.yearOverrides[trackId] != null ||
    state.years[trackId] ||
    state.pendingYears.has(trackId)
  ) return;
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
      if (currentRound(state.game)?.trackId === trackId) {
        renderAnswer();
        renderGuessControls();
      }
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
    button.hidden = state.game.mode === 'no-steve';
    button.disabled = state.revealedAnswers[category];
    button.textContent = state.revealedAnswers[category]
      ? `${CATEGORY_LABELS[category]} revealed ✓`
      : `Reveal ${CATEGORY_LABELS[category].toLowerCase()}`;
  }
  $('wrong-reveal').hidden = state.game.mode === 'no-steve';
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
  yearInput.readOnly = state.game.mode === 'no-steve' && !['reveal', 'game-over'].includes(state.roundPhase);
  if (document.activeElement !== yearInput) {
    yearInput.value = state.revealedAnswers.year
      ? info?.year
        ? formatYear(info.year)
        : 'Unavailable'
      : '?';
  }
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
  const activeContestant = currentTurn(state.game);
  const solvedCategories = scoredCategories(round, state.game.contestants);
  const allCategoriesSolved = solvedCategories.length === CATEGORIES.length;
  const noSteve = state.game.mode === 'no-steve';
  const status = {
    listening: `Listen to the clip. ${activeContestant?.name ?? 'The first player'} goes first.`,
    turn: activeContestant ? `${activeContestant.name}’s turn — choose a category or let the game match your guess.` : 'This song is complete.',
    manual: activeContestant
      ? round?.boardActive
        ? `${activeContestant.name}’s turn — run the board or choose Wrong / Pass.`
        : `${activeContestant.name}’s first turn — mark one correct answer or choose Wrong / Pass.`
      : allCategoriesSolved
        ? 'All three answers identified.'
        : answersComplete()
          ? 'Answers revealed.'
          : 'No players remain. The remaining answers are revealed.',
    reveal: 'Round complete. The answers are revealed.',
    'game-over': 'Game over.',
    idle: 'The game is ready.',
  };
  $('current-turn').textContent = status[state.roundPhase]
    ?? (allCategoriesSolved ? 'All three answers identified.' : activeContestant ? `${activeContestant.name}’s turn.` : 'This song is complete.');
  $('turn-column-heading').textContent = noSteve ? 'Turn' : 'Wrong / pass';
  body.replaceChildren(
    ...state.game.contestants.map((c) => {
      const tr = document.createElement('tr');
      const isOut = Boolean(round?.out?.includes(c.id));
      const isCurrent = activeContestant?.id === c.id && !allCategoriesSolved;
      if (isOut) tr.classList.add('out');
      if (isCurrent) tr.classList.add('current-turn');
      const nameCell = document.createElement('td');
      nameCell.textContent = c.name;
      if (isTeam(c)) {
        const members = document.createElement('span');
        members.className = 'members';
        members.textContent = c.members.join(', ');
        nameCell.append(members);
      }
      if (isOut) {
        const status = document.createElement('span');
        status.className = 'members contestant-status';
        status.textContent = noSteve ? 'Turn complete' : 'Out this song';
        nameCell.append(status);
      }
      tr.append(nameCell);
      for (const cat of CATEGORIES) {
        const td = document.createElement('td');
        const on = getAward(round, c.id, cat);
        if (noSteve) {
          td.textContent = on ? '✓' : solvedCategories.includes(cat) ? '—' : '·';
        } else {
          const button = document.createElement('button');
          button.type = 'button';
          button.className = 'toggle';
          button.setAttribute('aria-pressed', String(on));
          button.setAttribute('aria-label', `${c.name} got the ${CATEGORY_LABELS[cat].toLowerCase()} right`);
          button.textContent = on ? '✓' : '—';
          button.disabled = !round || !isCurrent || isOut || solvedCategories.includes(cat);
          button.addEventListener('click', () => {
            completeManualTurn(c.id, cat);
          });
          td.append(button);
        }
        tr.append(td);
      }
      const turnCell = document.createElement('td');
      if (noSteve) {
        turnCell.textContent = isCurrent ? 'Now' : isOut ? 'Done' : 'Waiting';
      } else {
        if (isOut) {
          turnCell.textContent = 'Out';
        } else if (isCurrent) {
          const passButton = document.createElement('button');
          passButton.type = 'button';
          passButton.className = 'small secondary';
          passButton.textContent = 'Wrong / Pass';
          passButton.setAttribute('aria-label', `${c.name} guesses wrong or passes`);
          passButton.disabled = allCategoriesSolved;
          passButton.addEventListener('click', () => {
            completeManualTurn(c.id);
          });
          turnCell.append(passButton);
        } else if (round?.attempted?.includes(c.id) && roundPoints(round, c.id) > 0) {
          turnCell.textContent = round.boardActive ? 'Runner' : 'Board eligible';
        } else if (round?.attempted?.includes(c.id)) {
          turnCell.textContent = 'Done';
        } else {
          turnCell.textContent = 'Waiting';
        }
      }
      tr.append(turnCell);
      const pts = document.createElement('td');
      pts.textContent = `${round ? roundPoints(round, c.id) : 0}/3`;
      tr.append(pts);
      return tr;
    }),
  );
  renderGuessControls();
}

function renderGuessControls() {
  const round = currentRound(state.game);
  const activeContestant = currentTurn(state.game);
  const openCategories = CATEGORIES.filter((category) => !scoredCategories(round, state.game.contestants).includes(category));
  const yearReady = Boolean(round && yearFor(round.trackId)?.year);
  const categorySelect = $('guess-category');
  const options = [new Option('Auto-detect category', '')];
  for (const category of openCategories) {
    const option = new Option(CATEGORY_LABELS[category], category);
    if (category === 'year' && !yearReady) {
      option.disabled = true;
      option.textContent += round && state.pendingYears.has(round.trackId) ? ' (checking…)': ' (unavailable)';
    }
    options.push(option);
  }
  const previousCategory = categorySelect.value;
  categorySelect.replaceChildren(...options);
  if (options.some((option) => option.value === previousCategory && !option.disabled)) {
    categorySelect.value = previousCategory;
  } else {
    categorySelect.value = '';
  }

  const canAnswer = state.game.mode === 'no-steve'
    && state.roundPhase === 'turn'
    && Boolean(activeContestant)
    && openCategories.some((category) => category !== 'year' || yearReady);
  $('auto-turn').hidden = state.game.mode !== 'no-steve' || !['listening', 'turn'].includes(state.roundPhase);
  const manualClockActive = state.game.mode === 'im-steve' && Boolean(round?.turnDeadlineAt);
  $('manual-clock-controls').hidden = state.game.mode !== 'im-steve';
  $('start-manual-clock').disabled = !activeContestant
    || state.roundPhase !== 'manual'
    || manualClockActive;
  $('manual-clock-display').hidden = !manualClockActive;
  if (manualClockActive) {
    $('manual-clock-display').textContent = String(manualClockDisplaySeconds(round.turnDeadlineAt));
  }
  $('guess-form').hidden = state.roundPhase !== 'turn' || !activeContestant;
  categorySelect.disabled = !canAnswer;
  $('guess-text').disabled = !canAnswer;
  $('submit-guess').disabled = !canAnswer;
  $('speak-guess').disabled = !canAnswer || Boolean(state.recognition);
  $('speak-guess').hidden = !speechRecognitionAvailable();
  $('pass-guess').disabled = state.roundPhase !== 'turn' || !activeContestant;
  $('next').disabled = state.roundPhase === 'game-over';
  $('play-pause').disabled = state.game.mode === 'no-steve' && state.roundPhase === 'turn';
  $('replay').disabled = state.game.mode === 'no-steve' && state.roundPhase === 'turn';
  $('next').textContent = state.game.mode === 'no-steve' ? 'Skip song' : '⏭ Next song';
  if (state.roundPhase === 'listening') {
    $('turn-progress').max = LISTEN_DURATION_MS / 1000;
  } else {
    $('turn-progress').max = guessTimeLimitSeconds(currentRound(state.game));
  }
  $('turn-countdown').textContent = '';
}

function stopRoundClock() {
  if (state.turnTimerInterval) clearInterval(state.turnTimerInterval);
  state.turnTimerInterval = null;
}

function stopVoiceRecognition() {
  const recognition = state.recognition;
  if (!recognition) return;
  state.recognition = null;
  recognition.onresult = null;
  recognition.onerror = null;
  recognition.onend = null;
  recognition.abort();
}

function clearAutomationTimers() {
  stopRoundClock();
  if (state.advanceTimeout) clearTimeout(state.advanceTimeout);
  state.advanceTimeout = null;
  state.listeningDeadlineAt = null;
  stopVoiceRecognition();
}

function updateRoundClock() {
  const now = Date.now();
  if (state.roundPhase === 'manual') {
    const round = currentRound(state.game);
    if (!round?.turnDeadlineAt) return;
    $('manual-clock-display').textContent = String(manualClockDisplaySeconds(round.turnDeadlineAt, now));
    if (round.turnDeadlineAt <= now) {
      stopRoundClock();
      expireManualTurn();
    }
    return;
  }

  if (state.roundPhase === 'listening' && state.listeningDeadlineAt) {
    const remaining = Math.max(0, state.listeningDeadlineAt - now);
    $('turn-progress').max = LISTEN_DURATION_MS / 1000;
    $('turn-progress').value = Math.ceil(remaining / 1000);
    $('turn-countdown').textContent = `Listen: ${Math.ceil(remaining / 1000)}s`;
    if (remaining === 0) {
      stopRoundClock();
      beginPlayerTurn().catch(reportError);
    }
    return;
  }

  const round = currentRound(state.game);
  if (state.roundPhase !== 'turn' || !round?.turnDeadlineAt) return;
  const remaining = Math.max(0, round.turnDeadlineAt - now);
  $('turn-progress').max = guessTimeLimitSeconds(round);
  $('turn-progress').value = Math.ceil(remaining / 1000);
  $('turn-countdown').textContent = `${Math.ceil(remaining / 1000)}s`;
  if (remaining === 0) {
    stopRoundClock();
    expireTurn();
  }
}

function startRoundClock() {
  stopRoundClock();
  updateRoundClock();
  state.turnTimerInterval = setInterval(updateRoundClock, 250);
}

function startManualClock({ resume = false } = {}) {
  const round = currentRound(state.game);
  if (state.game.mode !== 'im-steve' || !round || !currentTurn(state.game)) return;
  state.roundPhase = 'manual';
  round.phase = 'manual';
  if (resume && round.turnDeadlineAt && round.turnDeadlineAt <= Date.now()) {
    expireManualTurn();
    return;
  }
  if (!resume || !round.turnDeadlineAt) round.turnDeadlineAt = Date.now() + MANUAL_TURN_SECONDS * 1000;
  saveGame();
  renderGame();
  startRoundClock();
}

function startTurnClock({ resume = false } = {}) {
  const round = currentRound(state.game);
  if (!round || !currentTurn(state.game)) return finishRound();
  stopVoiceRecognition();
  state.roundPhase = 'turn';
  state.listeningDeadlineAt = null;
  round.phase = 'turn';
  round.listenDeadlineAt = null;
  round.turnDeadlineAt = resume && round.turnDeadlineAt > Date.now()
    ? round.turnDeadlineAt
    : Date.now() + guessTimeLimitSeconds(round) * 1000;
  $('guess-text').value = '';
  saveGame();
  renderGame();
  startRoundClock();
}

function startListeningPhase(deadlineAt = Date.now() + LISTEN_DURATION_MS) {
  const round = currentRound(state.game);
  if (!round) return;
  state.roundPhase = 'listening';
  state.listeningDeadlineAt = deadlineAt;
  round.phase = 'listening';
  round.listenDeadlineAt = deadlineAt;
  round.turnDeadlineAt = null;
  saveGame();
  renderGame();
  startRoundClock();
}

async function beginPlayerTurn() {
  try {
    await pauseCurrent();
  } catch (err) {
    reportError(err);
  }
  startTurnClock();
}

function showGuessFeedback(message, correct = null) {
  const feedback = $('guess-feedback');
  feedback.textContent = message;
  feedback.classList.toggle('correct', correct === true);
  feedback.classList.toggle('incorrect', correct === false);
}

function matchingGuessCategories(trackId, round, guess) {
  const track = state.tracks.get(trackId);
  if (!track) return [];
  const identified = scoredCategories(round, state.game.contestants);
  const answers = {};
  if (!identified.includes('artist')) {
    answers.artist = [...track.artists, track.artists.join(', ')];
  }
  if (!identified.includes('title')) {
    answers.title = [track.title, displayTitle(track)];
  }
  if (!identified.includes('year')) {
    const year = yearFor(trackId)?.year;
    if (year != null) answers.year = [String(year), formatYear(year)];
  }
  return guessMatchCategories(guess, answers);
}

function guessIsCorrect(trackId, category, guess) {
  const track = state.tracks.get(trackId);
  if (!track) return false;
  if (category === 'artist') {
    return guessMatches(guess, [...track.artists, track.artists.join(', ')]);
  }
  if (category === 'title') {
    return guessMatches(guess, [track.title, displayTitle(track)]);
  }
  if (category === 'year') {
    const year = yearFor(trackId)?.year;
    return year != null && guessMatches(guess, [String(year), formatYear(year)]);
  }
  return false;
}

function finishRound() {
  stopRoundClock();
  stopVoiceRecognition();
  const round = currentRound(state.game);
  if (!round) return;
  if (state.advanceTimeout) clearTimeout(state.advanceTimeout);
  state.advanceTimeout = null;
  round.currentTurnId = null;
  round.turnDeadlineAt = null;
  round.listenDeadlineAt = null;
  round.phase = 'reveal';
  state.roundPhase = 'reveal';
  state.listeningDeadlineAt = null;
  revealAllAnswers();
  saveGame();
  renderGame();

  const rows = standings(state.game);
  const leader = rows[0];
  if (leader && leader.total >= state.game.targetScore) {
    state.roundPhase = 'game-over';
    round.phase = 'game-over';
    const winners = rows.filter((row) => row.total === leader.total).map((row) => row.contestant.name);
    saveGame();
    renderGame();
    setStatus(`${winners.length > 1 ? 'Tie' : 'Winner'}: ${winners.join(' and ')} with ${leader.total} points.`);
    return;
  }

  showGuessFeedback(`Next song in ${ROUND_REVEAL_MS / 1000} seconds.`);
  setStatus(`Round complete. The next song starts in ${ROUND_REVEAL_MS / 1000} seconds.`);
  state.advanceTimeout = setTimeout(() => {
    nextSong().catch(reportError);
  }, ROUND_REVEAL_MS);
}

function finishManualRound() {
  const round = currentRound(state.game);
  const allAnswersRevealed = answersComplete();
  if (!round || (currentTurn(state.game) && !allAnswersRevealed)) return;
  const allCategoriesSolved = scoredCategories(round, state.game.contestants).length === CATEGORIES.length;
  if (!allAnswersRevealed) revealAllAnswers();
  stopRoundClock();
  round.currentTurnId = null;
  round.turnDeadlineAt = null;
  round.phase = 'manual';
  state.roundPhase = 'manual';
  saveGame();
  renderGame();
  setStatus(allCategoriesSolved
    ? 'All answers identified. Choose Next song when ready.'
    : allAnswersRevealed
      ? 'Answers revealed. Choose Next song when ready.'
      : 'Everyone is out. Remaining answers are revealed; choose Next song when ready.');
}

function completeManualTurn(contestantId, category = null, { timedOut = false } = {}) {
  const roundIndex = state.game.rounds.length - 1;
  const round = currentRound(state.game);
  const contestant = state.game.contestants.find((c) => c.id === contestantId);
  if (!round || !contestant) return;
  if (!timedOut && round.turnDeadlineAt && round.turnDeadlineAt <= Date.now()) {
    expireManualTurn();
    return;
  }
  stopRoundClock();
  resolveManualTurn(state.game, roundIndex, contestantId, category);
  if (category !== null) state.revealedAnswers[category] = true;
  saveGame();
  renderAnswer();
  renderHistory();
  renderScores();
  if (!currentTurn(state.game)) {
    finishManualRound();
  } else if (timedOut) {
    setStatus(`${contestant.name} ran out of time and is out for this song.`);
  }
}

function expireManualTurn() {
  const contestant = currentTurn(state.game);
  if (contestant) completeManualTurn(contestant.id, null, { timedOut: true });
}

function advanceAfterTurn() {
  const round = currentRound(state.game);
  if (!round) return;
  if (scoredCategories(round, state.game.contestants).length === CATEGORIES.length || !currentTurn(state.game)) {
    finishRound();
  } else {
    startTurnClock();
  }
}

function expireTurn() {
  resolvePassTurn(`Time is up for`);
}

function resolvePassTurn(reason) {
  const roundIndex = state.game.rounds.length - 1;
  const contestant = currentTurn(state.game);
  if (!contestant) return finishRound();
  stopVoiceRecognition();
  passTurn(state.game, roundIndex, contestant.id);
  saveGame();
  renderScores();
  showGuessFeedback(`${reason} ${contestant.name}. No answer was revealed.`, false);
  advanceAfterTurn();
}

function submitGuess(event) {
  event.preventDefault();
  if (state.roundPhase !== 'turn') return;
  const roundIndex = state.game.rounds.length - 1;
  const contestant = currentTurn(state.game);
  const round = currentRound(state.game);
  const selectedCategory = $('guess-category').value;
  const guess = $('guess-text').value.trim();
  if (!contestant || !round || !guess) return;
  if (round.turnDeadlineAt && round.turnDeadlineAt <= Date.now()) {
    expireTurn();
    return;
  }
  stopVoiceRecognition();
  const matchingCategories = selectedCategory ? [] : matchingGuessCategories(round.trackId, round, guess);
  const category = selectedCategory || (matchingCategories.length === 1 ? matchingCategories[0] : null);
  const isCorrect = selectedCategory
    ? guessIsCorrect(round.trackId, selectedCategory, guess)
    : matchingCategories.length === 1;
  resolveGuess(state.game, roundIndex, contestant.id, category, isCorrect);
  if (isCorrect) {
    state.revealedAnswers[category] = true;
  }
  saveGame();
  renderAnswer();
  renderHistory();
  renderScores();
  showGuessFeedback(
    isCorrect
      ? `Correct — ${contestant.name} earns 1 point for ${CATEGORY_LABELS[category]}.`
      : matchingCategories.length > 1
        ? `That matches more than one answer, ${contestant.name}. Be more specific next time; this turn is over.`
        : `Not quite, ${contestant.name}. The answer stays hidden.`,
    isCorrect,
  );
  advanceAfterTurn();
}

function speechRecognitionAvailable() {
  return Boolean(window.SpeechRecognition || window.webkitSpeechRecognition);
}

function startVoiceGuess() {
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!Recognition) {
    throw new Error('Voice recognition is not available in this browser. Type your guess instead.');
  }
  if (state.recognition) return;
  const recognition = new Recognition();
  recognition.lang = 'en-US';
  recognition.continuous = false;
  recognition.interimResults = false;
  recognition.maxAlternatives = 1;
  state.recognition = recognition;
  $('speak-guess').disabled = true;
  setStatus('Listening for your guess…');
  recognition.onresult = (event) => {
    if (state.roundPhase !== 'turn' || !currentTurn(state.game)) return;
    const transcript = event.results?.[0]?.[0]?.transcript?.trim();
    if (transcript) {
      $('guess-text').value = transcript;
      setStatus('Voice transcript ready. Review it, then submit your guess.');
    }
  };
  recognition.onerror = (event) => {
    setStatus(`Voice recognition failed (${event.error}). Type your guess instead.`, true);
  };
  recognition.onend = () => {
    if (state.recognition === recognition) state.recognition = null;
    renderGuessControls();
  };
  try {
    recognition.start();
  } catch (err) {
    state.recognition = null;
    renderGuessControls();
    throw err;
  }
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
  clearAutomationTimers();
  state.roundPhase = 'idle';
  spotify().activate();
  const trackIds = [...state.tracks.keys()];
  const trackId = nextRound(state.game, trackIds);
  if (!trackId) throw new Error('The playlist is empty');
  state.revealedAnswers = { artist: false, title: false, year: false };
  $('guess-feedback').textContent = '';
  $('guess-feedback').className = 'guess-feedback';
  if (state.game.mode === 'im-steve') {
    const round = currentRound(state.game);
    round.phase = 'manual';
    round.listenDeadlineAt = null;
    state.roundPhase = 'manual';
    saveGame();
    renderGame();
    prefetchYear(trackId);
    if (state.game.deck[0]) prefetchYear(state.game.deck[0]);
    await playCurrent();
    setStatus(state.spotifyApiMode === 'mock'
      ? 'Mock song selected (silent). Use the scoring controls to judge each guess.'
      : 'Song playing. Use the scoring controls to judge each guess.');
    return;
  }
  saveGame();
  renderGame();
  prefetchYear(trackId);
  if (state.game.deck[0]) prefetchYear(state.game.deck[0]);
  await playCurrent();
  startListeningPhase();
  setStatus(state.spotifyApiMode === 'mock'
    ? `Mock round (silent playback). The first turn follows in ${LISTEN_DURATION_MS / 1000} seconds.`
    : `Listen to the song for ${LISTEN_DURATION_MS / 1000} seconds. The first turn follows.`);
}

async function enterGame({ fresh }) {
  clearAutomationTimers();
  const playlistId = parsePlaylistId(state.playlistInput);
  if (fresh) {
    const targetScore = Number($('target-score').value);
    if (!Number.isSafeInteger(targetScore) || targetScore < 1) throw new Error('The target score must be a positive whole number.');
    state.targetScore = targetScore;
    localStorage.setItem(KEYS.targetScore, String(targetScore));
    if (state.game.rounds.length && !confirm('Start a new game? Current scores will be cleared.')) return;
    resetScores(state.game);
    state.game.targetScore = state.targetScore;
    state.game.mode = state.selectedMode;
  } else {
    state.targetScore = state.game.targetScore;
    state.selectedMode = state.game.mode;
    localStorage.setItem(KEYS.mode, state.selectedMode);
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
    $('guess-feedback').textContent = '';
    const round = currentRound(state.game);
    prefetchYear(round.trackId);
    if (state.game.mode === 'im-steve') {
      state.roundPhase = 'manual';
      if (!currentTurn(state.game)) {
        finishManualRound();
      } else if (round.turnDeadlineAt) {
        startManualClock({ resume: true });
      } else {
        renderGame();
        setStatus('Game resumed — press Play to continue the current song.');
      }
    } else if (round.phase === 'listening') {
      const deadlineAt = round.listenDeadlineAt > Date.now() ? round.listenDeadlineAt : Date.now();
      startListeningPhase(deadlineAt);
      setStatus('Game resumed during the listening clip.');
    } else if (['reveal', 'game-over'].includes(round.phase)
      || !currentTurn(state.game)
      || scoredCategories(round, state.game.contestants).length === CATEGORIES.length) {
      finishRound();
    } else {
      startTurnClock({ resume: true });
      setStatus(`Game resumed — ${currentTurn(state.game)?.name}’s turn (${guessTimeLimitSeconds(round)}-second limit).`);
    }
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

window.addEventListener('storage', (event) => {
  if (event.key === KEYS.spotifyApiMode) {
    setSpotifyApiMode(event.newValue === 'live' ? 'live' : 'mock', { persist: false });
  }
});

on('spotify-api-mode', 'change', () => setSpotifyApiMode($('spotify-api-mode').value));

on('spotify-form', 'submit', async (e) => {
  e.preventDefault();
  if (state.spotifyApiMode !== 'live') throw new Error('Select Live Spotify API mode before logging in.');
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
  if (state.spotifyApiMode === 'mock') {
    await loadPlaylist();
    return;
  }
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
on('mode-no-steve', 'click', () => selectMode('no-steve'));
on('mode-im-steve', 'click', () => selectMode('im-steve'));
on('start-manual-clock', 'click', () => startManualClock());
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
on('guess-form', 'submit', (e) => submitGuess(e));
on('speak-guess', 'click', () => startVoiceGuess());
on('pass-guess', 'click', () => {
  const round = currentRound(state.game);
  if (state.roundPhase !== 'turn' || !round) return;
  if (round.turnDeadlineAt && round.turnDeadlineAt <= Date.now()) {
    expireTurn();
    return;
  }
  resolvePassTurn('Pass from');
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
    if (state.game.mode === 'im-steve' && answersComplete()) finishManualRound();
  });
}
on('wrong-reveal', 'click', () => {
  revealAllAnswers();
  renderAnswer();
  renderHistory();
  if (state.game.mode === 'im-steve') finishManualRound();
});
on('next', 'click', () => state.game.mode === 'no-steve' ? finishRound() : nextSong());
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
  clearAutomationTimers();
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
  const actions = { ' ': 'play-pause', n: 'next' };
  if (state.game.mode === 'im-steve') actions.r = 'wrong-reveal';
  const id = actions[e.key.toLowerCase()];
  if (id) {
    e.preventDefault();
    $(id).click();
  }
});

// ---------- Boot ----------

(async function init() {
  showScreen('setup');
  $('speak-guess').hidden = !speechRecognitionAvailable();
  $('setup-settings').open = state.spotifyApiMode === 'live' && (!state.clientId || !isLoggedIn());
  renderSetup();
  try {
    if (state.spotifyApiMode === 'mock') {
      loadMockPlaylist();
    } else {
      if (state.clientId && (await handleRedirect(state.clientId))) setStatus('Connected to Spotify ✓');
      renderSetup();
      const playlistId = parsePlaylistId(state.playlistInput);
      const cache = playlistId ? readPlaylistCache(playlistId) : null;
      if (cache) {
        state.playlistName = typeof cache.name === 'string' ? cache.name : null;
        state.tracks = new Map(cache.tracks.map((track) => [track.id, track]));
        if (state.clientId && isLoggedIn()) $('setup-settings').open = false;
        setStatus(`Playlist ready from cache: ${state.tracks.size.toLocaleString()} songs`);
        renderSetup();
      } else {
        setStatus(isLoggedIn()
          ? 'Live Spotify selected. Click Load playlist to make an API request.'
          : 'Live Spotify selected. Log in and load a playlist only when ready.');
      }
    }
  } catch (err) {
    reportError(err);
  }
})();
