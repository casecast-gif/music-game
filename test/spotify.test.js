import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizePlaylistItem, SpotifyClient } from '../public/js/spotify.js';

const rawTrack = {
  type: 'track',
  id: 'abc',
  uri: 'spotify:track:abc',
  name: 'Song',
  artists: [{ name: 'A' }, { name: 'B' }],
  album: { name: 'Album', release_date: '1999-01-01', images: [{ url: 'http://img' }] },
  external_ids: { isrc: 'US123' },
  duration_ms: 1000,
};

function installBrowserSdk(t, Player) {
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    localStorage: globalThis.localStorage,
  };
  t.after(() => {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete globalThis[name];
      else globalThis[name] = value;
    }
  });
  globalThis.localStorage = { getItem: () => null };
  globalThis.document = { querySelector: () => ({}) };
  globalThis.window = { Spotify: { Player } };
}

test('normalizePlaylistItem reads the new `item` and legacy `track` keys', () => {
  const expected = {
    id: 'abc',
    uri: 'spotify:track:abc',
    title: 'Song',
    artists: ['A', 'B'],
    album: 'Album',
    releaseDate: '1999-01-01',
    image: 'http://img',
    isrc: 'US123',
    durationMs: 1000,
  };
  assert.deepEqual(normalizePlaylistItem({ item: rawTrack }), expected);
  assert.deepEqual(normalizePlaylistItem({ track: rawTrack }), expected);
});

test('normalizePlaylistItem skips episodes, local files and removed tracks', () => {
  assert.equal(normalizePlaylistItem({ item: { ...rawTrack, type: 'episode' } }), null);
  assert.equal(normalizePlaylistItem({ item: { ...rawTrack, is_local: true } }), null);
  assert.equal(normalizePlaylistItem({ item: null }), null);
  assert.equal(normalizePlaylistItem(null), null);
});

test('getPlaylistTracks loads pages concurrently in order and reports progress', async () => {
  const client = new SpotifyClient('unused');
  const total = 423;
  let activeRequests = 0;
  let peakRequests = 0;
  let rateLimitRetries = 0;
  client.api = async (_path, { query } = {}) => {
    activeRequests += 1;
    peakRequests = Math.max(peakRequests, activeRequests);
    await new Promise((resolve) => setTimeout(resolve, 2));
    activeRequests -= 1;
    const offset = query?.offset ?? 0;
    if (offset === 50 && rateLimitRetries === 0) {
      rateLimitRetries += 1;
      throw Object.assign(new Error('API rate limit exceeded'), { status: 429, retryAfter: 0.001 });
    }
    const items = Array.from({ length: Math.min(50, total - offset) }, (_, index) => {
      const id = `track-${offset + index}`;
      return { item: { ...rawTrack, id, uri: `spotify:track:${id}` } };
    });
    return { total, items };
  };
  const progress = [];

  const tracks = await client.getPlaylistTracks('playlist-id', {
    onProgress: (loaded, count) => progress.push([loaded, count]),
  });

  assert.equal(tracks.length, total);
  assert.equal(tracks[0].id, 'track-0');
  assert.equal(tracks.at(-1).id, `track-${total - 1}`);
  assert.equal(peakRequests, 2);
  assert.equal(rateLimitRetries, 1);
  assert.deepEqual(progress.at(-1), [total, total]);
});

test('togglePlay starts the current song when Spotify has no active playback', async () => {
  const client = new SpotifyClient('unused');
  client.api = async () => {
    throw Object.assign(new Error('No active device'), { status: 404 });
  };
  assert.equal(await client.togglePlay('device-id'), false);
});

test('togglePlay toggles the current track on the browser player', async () => {
  const client = new SpotifyClient('unused');
  let toggled = false;
  client.deviceId = 'browser-device';
  client.player = {
    async getCurrentState() {
      return { track_window: { current_track: { uri: 'spotify:track:abc' } } };
    },
    async togglePlay() {
      toggled = true;
    },
  };

  assert.equal(await client.togglePlay('browser-device', 'spotify:track:abc'), true);
  assert.equal(toggled, true);
});

test('togglePlay retries one malformed successful playback-state response', async () => {
  const client = new SpotifyClient('unused');
  let stateReads = 0;
  const requests = [];
  client.api = async (path) => {
    requests.push(path);
    if (path === '/me/player') {
      stateReads += 1;
      if (stateReads === 1) throw Object.assign(new Error('Spotify returned an invalid non-JSON response (HTTP 200).'), { status: 200 });
      return { device: { id: 'device-id' }, item: { uri: 'spotify:track:abc' }, is_playing: true };
    }
    return null;
  };

  assert.equal(await client.togglePlay('device-id', 'spotify:track:abc'), true);
  assert.deepEqual(requests, ['/me/player', '/me/player', '/me/player/pause']);
});

test('togglePlay starts the game song instead of pausing a different track', async () => {
  const client = new SpotifyClient('unused');
  const requests = [];
  client.api = async (path) => {
    requests.push(path);
    return {
      device: { id: 'device-id' },
      item: { uri: 'spotify:track:other' },
      is_playing: true,
    };
  };

  assert.equal(await client.togglePlay('device-id', 'spotify:track:game'), false);
  assert.deepEqual(requests, ['/me/player']);
});

test('play starts on the selected active Spotify device', async () => {
  const client = new SpotifyClient('unused');
  let request;
  client.api = async (path, options) => {
    if (path === '/me/player/play') {
      request = { path, options };
      return null;
    }
    return { device: { id: 'device-id' }, item: { uri: 'spotify:track:abc' }, is_playing: true };
  };

  await client.play('spotify:track:abc', 'device-id');

  assert.equal(request.path, '/me/player/play');
  assert.equal(request.options.method, 'PUT');
  assert.deepEqual(request.options.query, { device_id: 'device-id' });
  assert.deepEqual(request.options.body, { uris: ['spotify:track:abc'] });
});

test('play verifies browser playback using the Web Playback SDK state', async () => {
  const client = new SpotifyClient('unused');
  const requests = [];
  let stateReads = 0;
  client.deviceId = 'browser-device';
  client.player = {
    async getCurrentState() {
      stateReads += 1;
      return {
        track_window: {
          current_track: {
            uri: stateReads === 1 ? 'spotify:track:previous' : 'spotify:track:game',
          },
        },
        paused: false,
      };
    },
  };
  client.api = async (path, options = {}) => {
    requests.push({ path, options });
    if (path === '/me/player') {
      return { device: { id: 'browser-device', is_active: true }, item: { uri: 'spotify:track:previous' }, is_playing: true };
    }
    return null;
  };

  await client.play('spotify:track:game', 'browser-device');

  assert.deepEqual(requests.map(({ path, options }) => [path, options.method ?? 'GET']), [
    ['/me/player', 'GET'],
    ['/me/player/play', 'PUT'],
  ]);
  assert.equal(stateReads, 2);
});

test('play transfers playback to the selected device before starting the game track', async () => {
  const client = new SpotifyClient('unused');
  const requests = [];
  let transferred = false;
  let started = false;
  client.api = async (path, options = {}) => {
    requests.push({ path, options });
    if (path === '/me/player' && options.method === 'PUT') {
      transferred = true;
      return null;
    }
    if (path === '/me/player/play') {
      started = true;
      return null;
    }
    if (!transferred) {
      return { device: { id: 'old-device' }, item: { uri: 'spotify:track:other' }, is_playing: true };
    }
    if (!started) return { device: { id: 'device-id' }, item: null, is_playing: false };
    return { device: { id: 'device-id' }, item: { uri: 'spotify:track:game' }, is_playing: true };
  };

  await client.play('spotify:track:game', 'device-id');

  assert.deepEqual(requests.map(({ path, options }) => [path, options.method ?? 'GET']), [
    ['/me/player', 'GET'],
    ['/me/player', 'PUT'],
    ['/me/player', 'GET'],
    ['/me/player/play', 'PUT'],
    ['/me/player', 'GET'],
  ]);
  assert.deepEqual(requests[1].options.body, { device_ids: ['device-id'], play: false });
  assert.deepEqual(requests[3].options.body, { uris: ['spotify:track:game'] });
});

test('play waits for the selected device to become active before starting the track', async () => {
  const client = new SpotifyClient('unused');
  let transferred = false;
  let activeReads = 0;
  let started = false;
  client.api = async (path, options = {}) => {
    if (path === '/me/player' && options.method === 'PUT') {
      transferred = true;
      return null;
    }
    if (path === '/me/player/play') {
      started = true;
      return null;
    }
    if (!transferred) {
      return { device: { id: 'device-id', is_active: false }, item: null, is_playing: false };
    }
    activeReads += 1;
    if (activeReads === 1) {
      return { device: { id: 'device-id', is_active: false }, item: null, is_playing: false };
    }
    if (!started) return { device: { id: 'device-id', is_active: true }, item: null, is_playing: false };
    return {
      device: { id: 'device-id', is_active: true },
      item: { uri: 'spotify:track:game' },
      is_playing: true,
    };
  };

  await client.play('spotify:track:game', 'device-id');

  assert.equal(activeReads, 3);
  assert.equal(started, true);
});

test('play reports when Spotify accepts a request but the device stays idle', async () => {
  const client = new SpotifyClient('unused');
  client.api = async (path) => {
    if (path === '/me/player') return { device: { id: 'device-id' }, item: null, is_playing: false };
    return null;
  };

  await assert.rejects(
    client.play('spotify:track:abc', 'device-id'),
    /Spotify accepted the play request, but never reported the game track as playing.*playing=no/,
  );
});

test('play does not issue a track request until Spotify confirms the transfer', async () => {
  const client = new SpotifyClient('unused');
  let playRequested = false;
  client.api = async (path, options = {}) => {
    if (path === '/me/player' && options.method === 'PUT') return null;
    if (path === '/me/player/play') {
      playRequested = true;
      return null;
    }
    return { device: { id: 'old-device' }, item: null, is_playing: false };
  };

  await assert.rejects(
    client.play('spotify:track:abc', 'device-id'),
    /Spotify accepted the device transfer, but that device did not become active/,
  );
  assert.equal(playRequested, false);
});

test('api preserves HTTP status when Spotify returns a non-JSON error', async (t) => {
  const previousFetch = globalThis.fetch;
  const previousLocalStorage = globalThis.localStorage;
  t.after(() => {
    globalThis.fetch = previousFetch;
    if (previousLocalStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = previousLocalStorage;
  });
  globalThis.localStorage = {
    getItem: () => JSON.stringify({ accessToken: 'test-token', expiresAt: Date.now() + 60_000 }),
  };
  globalThis.fetch = async () => new Response('opaque upstream response', {
    status: 403,
    headers: { 'Content-Type': 'text/plain' },
  });

  const client = new SpotifyClient('client-id');
  await assert.rejects(client.api('/me/player'), (error) => {
    assert.equal(error.status, 403);
    assert.match(error.message, /Spotify API error 403: received a non-JSON response/);
    return true;
  });
});

test('browser player surfaces missing Spotify login instead of timing out', async (t) => {
  class Player {
    constructor(options) {
      this.options = options;
    }

    addListener() {}

    connect() {
      this.options.getOAuthToken(() => {});
      return Promise.resolve(true);
    }
  }
  installBrowserSdk(t, Player);
  const errors = [];
  const client = new SpotifyClient('client-id');

  await assert.rejects(
    client.initPlayer('Test player', () => {}, (error) => errors.push(error.message)),
    /Could not authenticate Spotify browser playback: Not logged in to Spotify/,
  );
  assert.deepEqual(errors, ['Could not authenticate Spotify browser playback: Not logged in to Spotify']);
});

test('browser player explains generic initialization failures as possible DRM issues', async (t) => {
  class Player {
    constructor() {
      this.listeners = {};
    }

    addListener(name, callback) {
      this.listeners[name] = callback;
    }

    connect() {
      this.listeners.initialization_error({ message: 'Failed to initialize player' });
      return Promise.resolve(true);
    }
  }
  installBrowserSdk(t, Player);
  const errors = [];
  const client = new SpotifyClient('client-id');

  await assert.rejects(
    client.initPlayer('Test player', () => {}, (error) => errors.push(error.message)),
    /Spotify could not initialize audio in this browser\. Check that protected media \(Widevine\/DRM\) is enabled/,
  );
  assert.equal(errors.length, 1);
});
