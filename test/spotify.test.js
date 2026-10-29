import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizePlaylistItem } from '../public/js/spotify.js';

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
