// Spotify Web API + Web Playback SDK helpers.
// Uses the Authorization Code flow with PKCE so no client secret / backend is needed.

const AUTH_URL = 'https://accounts.spotify.com/authorize';
const TOKEN_URL = 'https://accounts.spotify.com/api/token';
const API = 'https://api.spotify.com/v1';
const SDK_URL = 'https://sdk.scdn.co/spotify-player.js';

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
  if (!res.ok) throw new Error(`Spotify login failed (${res.status})`);
  return res.json();
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
  }

  async api(path, { method = 'GET', body, query } = {}) {
    const token = await getAccessToken(this.clientId);
    const url = new URL(path.startsWith('http') ? path : `${API}${path}`);
    if (query) for (const [k, v] of Object.entries(query)) if (v != null) url.searchParams.set(k, v);
    const res = await fetch(url, {
      method,
      headers: { Authorization: 'Bearer ' + token, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 204) return null;
    const text = await res.text();
    const data = text ? JSON.parse(text) : null;
    if (!res.ok) {
      const err = new Error(data?.error?.message || `Spotify API error ${res.status}`);
      err.status = res.status;
      throw err;
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

  /** Loads every playable track of a playlist (handles pagination). */
  async getPlaylistTracks(playlistId) {
    const tracks = [];
    let next = `${API}/playlists/${playlistId}/items?limit=50&additional_types=track`;
    while (next) {
      const page = await this.api(next);
      for (const entry of page?.items ?? []) {
        const track = normalizePlaylistItem(entry);
        if (track) tracks.push(track);
      }
      next = page?.next ?? null;
    }
    return tracks;
  }

  /** Loads the Web Playback SDK so this browser tab becomes a Spotify speaker. */
  initPlayer(name = 'Music Game Host', onState = () => {}) {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Spotify player did not start (Premium is required)')), 20000);
      window.onSpotifyWebPlaybackSDKReady = () => {
        const player = new window.Spotify.Player({
          name,
          getOAuthToken: (cb) => getAccessToken(this.clientId).then(cb, () => {}),
          volume: 0.8,
        });
        player.addListener('ready', ({ device_id }) => {
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
            clearTimeout(timeout);
            reject(new Error(evt === 'account_error' ? 'Spotify Premium is required for playback' : message));
          });
        }
        player.connect();
        this.player = player;
      };
      if (!document.querySelector(`script[src="${SDK_URL}"]`)) {
        const script = document.createElement('script');
        script.src = SDK_URL;
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

  play(uri, deviceId = this.deviceId) {
    return this.api('/me/player/play', { method: 'PUT', query: { device_id: deviceId }, body: { uris: [uri] } });
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
  async togglePlay(deviceId = this.deviceId) {
    if (this.usesBrowserPlayer(deviceId)) {
      if (!(await this.player.getCurrentState())) return false;
      await this.player.togglePlay();
      return true;
    }
    const state = await this.api('/me/player');
    if (!state?.item || state.device?.id !== deviceId) return false;
    await this.api(state.is_playing ? '/me/player/pause' : '/me/player/play', {
      method: 'PUT',
      query: { device_id: deviceId },
    });
    return true;
  }
}
