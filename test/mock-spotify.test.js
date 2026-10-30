import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MOCK_DEVICE_ID, MOCK_TRACKS, MockSpotifyClient } from '../public/js/mock-spotify.js';

test('mock Spotify client supports playlist and playback flows without network requests', async (t) => {
  const previousFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async () => {
    requests += 1;
    throw new Error('Mock mode must not make network requests');
  };
  t.after(() => {
    if (previousFetch === undefined) delete globalThis.fetch;
    else globalThis.fetch = previousFetch;
  });

  const client = new MockSpotifyClient('unused');
  const originalVolume = client.volume;
  const restoreVolume = await client.lowerVolumeForVoice();
  assert.equal(client.volume, originalVolume * 0.2);
  await restoreVolume();
  assert.equal(client.volume, originalVolume);
  const progress = [];
  assert.match(await client.getPlaylistName('playlist-id'), /mock/i);
  const tracks = await client.getPlaylistTracks('playlist-id', {
    onProgress: (loaded, total) => progress.push([loaded, total]),
  });
  assert.equal(tracks.length, MOCK_TRACKS.length);
  assert.deepEqual(progress, [[MOCK_TRACKS.length, MOCK_TRACKS.length]]);
  assert.equal((await client.getDevices())[0].id, MOCK_DEVICE_ID);
  assert.equal(await client.initPlayer(), MOCK_DEVICE_ID);
  await client.play(tracks[0].uri, MOCK_DEVICE_ID);
  assert.equal(client.isPlaying, true);
  assert.equal(await client.togglePlay(MOCK_DEVICE_ID, tracks[0].uri), true);
  assert.equal(client.isPlaying, false);
  assert.equal(client.currentUri, tracks[0].uri);
  assert.equal(await client.togglePlay(MOCK_DEVICE_ID, tracks[0].uri), true);
  assert.equal(client.isPlaying, true);
  await client.pause(MOCK_DEVICE_ID);
  assert.equal(requests, 0);
});
