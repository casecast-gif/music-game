// Spotify Web API + Web Playback SDK helpers.
// Uses the Authorization Code flow with PKCE so no client secret / backend is needed.

const AUTH_URL = 'https://accounts.spotify.com/authorize';
const TOKEN_URL = 'https://accounts.spotify.com/api/token';
const API = 'https://api.spotify.com/v1';
const SDK_URL = 'https://sdk.scdn.co/spotify-player.js';
const PLAYLIST_PAGE_SIZE = 50;
const PLAYLIST_PAGE_CONCURRENCY = 2;
const DEVICE_POLL_ATTEMPTS = 6;
const PLAYBACK_POLL_ATTEMPTS = 8;
const PLAYBACK_POLL_INTERVAL_MS = 300;

function isMalformedJsonResponse(error) {
  return error?.status === 200 && error.message?.includes('invalid non-JSON response');
}

export const SCOPES = [
  'streaming',
  'user-read-email',
  'user-read-private',
  'user-read-playback-state',
  'user-modify-playback-state',
  'playlist-read-private',
  'playlist-read-collaborative',
];

const TOKEN_KEY = 'musicGame.spotifyToken';
const VERIFIER_KEY = 'musicGame.pkceVerifier';
const STATE_KEY = 'musicGame.pkceState';

/** Converts one playlist item from `/playlists/{id}/items` into a flat track. */
export function normalizePlaylistItem(entry) {
  // Dev-mode apps receive `item`; older / extended-quota responses use `track`.
  const t = entry?.item ?? entry?.track;
  if (!t || t.type !== 'track' || t.is_local || !t.id || !t.uri) return null;
  return {
    id: t.id,
    uri: t.uri,
    title: t.name,
    artists: (t.artists ?? []).map((a) => a.name).filter(Boolean),
    album: t.album?.name ?? '',
    releaseDate: t.album?.release_date ?? null,
    image: t.album?.images?.[0]?.url ?? null,
    isrc: t.external_ids?.isrc ?? null,
    durationMs: t.duration_ms ?? 0,
  };
}

export function redirectUri() {
  return `${window.location.origin}${window.location.pathname}`;
}

function base64Url(bytes) {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function randomString(length = 64) {
  return base64Url(crypto.getRandomValues(new Uint8Array(length))).slice(0, length);
}

export async function startLogin(clientId) {
  const verifier = randomString(64);
  const state = randomString(16);
  const challenge = base64Url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  sessionStorage.setItem(VERIFIER_KEY, verifier);
  sessionStorage.setItem(STATE_KEY, state);
  const params = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: redirectUri(),
    code_challenge_method: 'S256',
    code_challenge: challenge,
    scope: SCOPES.join(' '),
    state,
  });
  window.location.assign(`${AUTH_URL}?${params}`);
}

function saveToken(data, previous = {}) {
  const token = {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? previous.refreshToken,
    expiresAt: Date.now() + (data.expires_in - 60) * 1000,
  };
  localStorage.setItem(TOKEN_KEY, JSON.stringify(token));
  return token;
}

async function tokenRequest(body) {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Spotify login failed (${res.status}): ${data.error_description ?? data.error ?? 'check the Client ID and redirect URI'}`);
  return data;
}

/**
 * Completes the redirect back from Spotify, if the current URL contains an
 * authorization code. Returns true when a token was obtained.
 */
export async function handleRedirect(clientId) {
  const params = new URLSearchParams(window.location.search);
  const code = params.get('code');
  const error = params.get('error');
  if (!code && !error) return false;
  window.history.replaceState({}, '', redirectUri());
  if (error) throw new Error(`Spotify login was cancelled (${error})`);
  const expectedState = sessionStorage.getItem(STATE_KEY);
  const verifier = sessionStorage.getItem(VERIFIER_KEY);
  sessionStorage.removeItem(STATE_KEY);
  sessionStorage.removeItem(VERIFIER_KEY);
  if (!verifier || params.get('state') !== expectedState) throw new Error('Spotify login state mismatch, please try again');
  const data = await tokenRequest({
    client_id: clientId,
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri(),
    code_verifier: verifier,
  });
  saveToken(data);
  return true;
}

function loadToken() {
  try {
    return JSON.parse(localStorage.getItem(TOKEN_KEY)) ?? null;
  } catch {
    return null;
  }
}

export function isLoggedIn() {
  const token = loadToken();
  return Boolean(token?.refreshToken || token?.accessToken);
}

export function logout() {
  localStorage.removeItem(TOKEN_KEY);
}

let refreshPromise = null;

export async function getAccessToken(clientId) {
  const token = loadToken();
  if (!token) throw new Error('Not logged in to Spotify');
  if (Date.now() < token.expiresAt) return token.accessToken;
  if (!token.refreshToken) throw new Error('Spotify session expired, please log in again');
  // Share one in-flight refresh: Spotify may rotate the refresh token, so
  // concurrent refreshes with the same token could invalidate the session.
  refreshPromise ??= tokenRequest({ client_id: clientId, grant_type: 'refresh_token', refresh_token: token.refreshToken })
    .then((data) => saveToken(data, token).accessToken)
    .finally(() => {
      refreshPromise = null;
    });
  return refreshPromise;
}

export class SpotifyClient {
  constructor(clientId) {
    this.clientId = clientId;
    this.deviceId = null;
    this.player = null;
    this.playbackQueue = Promise.resolve();
  }

  async api(path, { method = 'GET', body, query } = {}) {
    const token = await getAccessToken(this.clientId);
    const url = new URL(path.startsWith('http') ? path : `${API}${path}`);
    if (query) for (const [k, v] of Object.entries(query)) if (v != null) url.searchParams.set(k, v);
    const res = await fetch(url, {
      method,
      headers: { Accept: 'application/json', Authorization: 'Bearer ' + token, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 204) return null;
    const text = await res.text();
    const makeError = (message) => {
      const error = new Error(message);
      error.status = res.status;
      const retryAfter = res.headers.get('Retry-After');
      error.retryAfter = retryAfter === null ? null : Number(retryAfter);
      return error;
    };
    let data = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        throw makeError(res.ok
          ? `Spotify returned an invalid non-JSON response (HTTP ${res.status}).`
          : `Spotify API error ${res.status}: received a non-JSON response.`);
      }
    }
    if (!res.ok) {
      throw makeError(data?.error?.message || `Spotify API error ${res.status}`);
    }
    return data;
  }

  getProfile() {
    return this.api('/me');
  }

  async getPlaylistName(playlistId) {
    try {
      const data = await this.api(`/playlists/${playlistId}`, { query: { fields: 'name' } });
      return data?.name ?? null;
    } catch {
      return null;
    }
  }

  /** Loads playlist pages in small concurrent batches to reduce startup time. */
  async getPlaylistTracks(playlistId, { onProgress = () => {} } = {}) {
    const tracks = [];
    const fetchPage = async (offset) => {
      let attempt = 0;
      while (true) {
        try {
          return await this.api(`/playlists/${playlistId}/items`, {
            query: { limit: PLAYLIST_PAGE_SIZE, offset, additional_types: 'track' },
          });
        } catch (err) {
          if (err.status !== 429 || attempt >= 3) throw err;
          const delay = Number.isFinite(err.retryAfter)
            ? Math.max(0, err.retryAfter * 1000)
            : Math.min(30000, 1000 * (2 ** attempt));
          await new Promise((resolve) => setTimeout(resolve, delay));
          attempt += 1;
        }
      }
    };
    const append = (page) => {
      for (const entry of page?.items ?? []) {
        const track = normalizePlaylistItem(entry);
        if (track) tracks.push(track);
      }
    };

    const first = await fetchPage(0);
    append(first);
    let loaded = first?.items?.length ?? 0;
    const total = first?.total;
    onProgress(loaded, Number.isFinite(total) ? total : loaded);

    if (!Number.isFinite(total)) {
      let next = first?.next ?? null;
      while (next) {
        const page = await this.api(next);
        append(page);
        loaded += page?.items?.length ?? 0;
        onProgress(loaded, loaded + (page?.next ? PLAYLIST_PAGE_SIZE : 0));
        next = page?.next ?? null;
      }
      return tracks;
    }

    const offsets = [];
    for (let offset = PLAYLIST_PAGE_SIZE; offset < total; offset += PLAYLIST_PAGE_SIZE) offsets.push(offset);
    for (let index = 0; index < offsets.length; index += PLAYLIST_PAGE_CONCURRENCY) {
      const batch = offsets.slice(index, index + PLAYLIST_PAGE_CONCURRENCY);
      const pages = await Promise.all(batch.map(fetchPage));
      pages.forEach(append);
      loaded += pages.reduce((count, page) => count + (page?.items?.length ?? 0), 0);
      onProgress(loaded, total);
    }
    return tracks;
  }

  /** Loads the Web Playback SDK so this browser tab becomes a Spotify speaker. */
  initPlayer(name = 'Music Game', onState = () => {}, onError = () => {}) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const fail = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        reject(error);
      };
      const timeout = setTimeout(() => fail(new Error('Spotify browser player did not become ready. Confirm you are logged in to a Premium account; if it still times out, this browser may not support protected audio. Choose a Spotify Connect device instead.')), 20000);
      window.onSpotifyWebPlaybackSDKReady = () => {
        try {
          const player = new window.Spotify.Player({
            name,
            getOAuthToken: (cb) => getAccessToken(this.clientId).then(cb, (cause) => {
              const error = new Error(`Could not authenticate Spotify browser playback: ${cause.message}`);
              onError(error);
              fail(error);
            }),
            volume: 0.8,
          });
          this.player = player;
          player.addListener('ready', ({ device_id }) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            this.deviceId = device_id;
            resolve(device_id);
          });
          player.addListener('not_ready', () => {
            this.deviceId = null;
          });
          player.addListener('player_state_changed', (state) => onState(state));
          for (const evt of ['initialization_error', 'authentication_error', 'account_error']) {
            player.addListener(evt, ({ message }) => {
              if (evt === 'account_error') return fail(new Error('Spotify Premium is required for playback.'));
              if (evt === 'initialization_error' && /eme|key ?system|drm|protected audio/i.test(message)) {
                return fail(new Error('This browser cannot play Spotify audio because its protected-audio support is unavailable. Try Chrome/Edge or choose a Spotify Connect device.'));
              }
              if (evt === 'initialization_error' && /failed to initialize player/i.test(message)) {
                const error = new Error('Spotify could not initialize audio in this browser. Check that protected media (Widevine/DRM) is enabled, or choose a Spotify Connect device.');
                onError(error);
                return fail(error);
              }
              const error = new Error(message || `Spotify browser player ${evt.replaceAll('_', ' ')}`);
              onError(error);
              fail(error);
            });
          }
          Promise.resolve(player.connect()).then((connected) => {
            if (!connected && !settled) {
              fail(new Error('Spotify could not connect the browser player. Try a supported browser or choose a Spotify Connect device.'));
            }
          }, fail);
        } catch (err) {
          fail(err);
        }
      };
      if (!document.querySelector(`script[src="${SDK_URL}"]`)) {
        const script = document.createElement('script');
        script.src = SDK_URL;
        script.onerror = () => fail(new Error('Could not load the Spotify Web Playback SDK.'));
        document.head.appendChild(script);
      } else if (window.Spotify) {
        window.onSpotifyWebPlaybackSDKReady();
      }
    });
  }

  /** Must be called from a user gesture so browsers allow audio playback. */
  activate() {
    this.player?.activateElement?.();
  }

  getDevices() {
    return this.api('/me/player/devices').then((d) => d?.devices ?? []);
  }

  async getPlaybackState() {
    try {
      return await this.api('/me/player');
    } catch (error) {
      if (error.status === 404) return null;
      if (!isMalformedJsonResponse(error)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 200));
      try {
        return await this.api('/me/player');
      } catch (retryError) {
        if (retryError.status === 404) return null;
        throw retryError;
      }
    }
  }

  async waitForActiveDevice(deviceId) {
    for (let attempt = 0; attempt < DEVICE_POLL_ATTEMPTS; attempt += 1) {
      const state = await this.getPlaybackState();
      if (state?.device?.id === deviceId && state.device.is_active !== false) return true;
      if (attempt < DEVICE_POLL_ATTEMPTS - 1) {
        await new Promise((resolve) => setTimeout(resolve, PLAYBACK_POLL_INTERVAL_MS));
      }
    }
    return false;
  }

  async startPlayback(uri, deviceId) {
    if (!uri) throw new Error('Choose a Spotify track before starting playback.');
    if (!deviceId) throw new Error('Choose a Spotify device before starting playback.');
    const state = await this.getPlaybackState();
    if (state?.device?.id !== deviceId || state.device.is_active === false) {
      await this.api('/me/player', {
        method: 'PUT',
        body: { device_ids: [deviceId], play: false },
      });
      if (!(await this.waitForActiveDevice(deviceId))) {
        throw new Error('Spotify accepted the device transfer, but that device did not become active. Open Spotify on it, select it as the active speaker, then retry.');
      }
    }

    await this.api('/me/player/play', {
      method: 'PUT',
      query: { device_id: deviceId },
      body: { uris: [uri] },
    });
    const browserPlayer = this.usesBrowserPlayer(deviceId) ? this.player : null;
    let lastPlayback = null;
    for (let attempt = 0; attempt < PLAYBACK_POLL_ATTEMPTS; attempt += 1) {
      lastPlayback = browserPlayer
        ? await browserPlayer.getCurrentState()
        : await this.getPlaybackState();
      const currentUri = browserPlayer
        ? lastPlayback?.track_window?.current_track?.uri
        : lastPlayback?.item?.uri;
      const isPlaying = browserPlayer
        ? Boolean(lastPlayback && !lastPlayback.paused)
        : Boolean(lastPlayback?.is_playing);
      if (
        (browserPlayer || (
          lastPlayback?.device?.id === deviceId &&
          lastPlayback.device.is_active !== false
        )) &&
        currentUri === uri &&
        isPlaying
      ) return;
      if (attempt < PLAYBACK_POLL_ATTEMPTS - 1) {
        await new Promise((resolve) => setTimeout(resolve, PLAYBACK_POLL_INTERVAL_MS));
      }
    }
    if (browserPlayer) {
      const activeTrack = lastPlayback?.track_window?.current_track?.uri ?? 'none';
      const isPlaying = lastPlayback ? (lastPlayback.paused ? 'no' : 'yes') : 'unknown';
      throw new Error(`Spotify accepted the play request, but the browser player never reported the game track as playing. Expected="${uri}". Last state: track="${activeTrack}", playing=${isPlaying}.`);
    }
    const activeDevice = lastPlayback?.device?.name ?? lastPlayback?.device?.id ?? 'none';
    const activeTrack = lastPlayback?.item?.uri ?? 'none';
    const isPlaying = lastPlayback?.is_playing ? 'yes' : 'no';
    const deviceActive = lastPlayback?.device?.is_active == null
      ? 'unknown'
      : lastPlayback.device.is_active ? 'yes' : 'no';
    throw new Error(`Spotify accepted the play request, but never reported the game track as playing. Expected="${uri}". Last state: device="${activeDevice}", active=${deviceActive}, track="${activeTrack}", playing=${isPlaying}.`);
  }

  play(uri, deviceId = this.deviceId) {
    const request = this.playbackQueue.catch(() => {}).then(() => this.startPlayback(uri, deviceId));
    this.playbackQueue = request;
    return request;
  }

  usesBrowserPlayer(deviceId) {
    return Boolean(this.player && deviceId && deviceId === this.deviceId);
  }

  async pause(deviceId = this.deviceId) {
    if (this.usesBrowserPlayer(deviceId)) return this.player.pause();
    return this.api('/me/player/pause', { method: 'PUT', query: { device_id: deviceId } });
  }

  /**
   * Toggles play/pause on the device. Returns false when nothing is loaded on
   * the device yet, so the caller can start the current song instead.
   */
  async togglePlay(deviceId = this.deviceId, expectedUri) {
    if (this.usesBrowserPlayer(deviceId)) {
      const state = await this.player.getCurrentState();
      if (!state || (expectedUri && state.track_window?.current_track?.uri !== expectedUri)) return false;
      await this.player.togglePlay();
      return true;
    }
    const state = await this.getPlaybackState();
    if (!state?.item || state.device?.id !== deviceId || (expectedUri && state.item.uri !== expectedUri)) return false;
    await this.api(state.is_playing ? '/me/player/pause' : '/me/player/play', {
      method: 'PUT',
      query: { device_id: deviceId },
    });
    return true;
  }
}
