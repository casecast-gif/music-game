import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PlaylistLoader, PLAYLIST_BATCH_SIZE, PLAYLIST_REFILL_THRESHOLD } from '../public/js/playlist.js';
import { SpotifyClient } from '../public/js/spotify.js';
import { addContestant, createContestant, createGame, extendDeck, nextRound } from '../public/js/game.js';

function fixture(total = 1000) {
  const requests = [];
  const saved = [];
  const client = new SpotifyClient('unused');
  const source = { total, snapshotId: 'snapshot-1', failure: null };
  client.api = async (path, { query } = {}) => {
    requests.push({ path, query });
    if (!path.endsWith('/items')) return { name: 'Playlist', snapshot_id: source.snapshotId };
    if (query.fields === 'total') return { total: source.total };
    if (source.failure) throw source.failure;
    const items = Array.from({ length: Math.min(query.limit, source.total - query.offset) }, (_, index) => {
      const id = `track-${query.offset + index}`;
      return { item: { type: 'track', id, uri: `spotify:track:${id}`, name: id } };
    });
    return { total: source.total, items };
  };
  const options = { rng: () => 0.5, saveCache: (cache) => saved.push(structuredClone(cache)) };
  const loader = new PlaylistLoader(client, 'playlist-id', options);
  const pages = () => requests.filter(({ query }) => query?.offset !== undefined);
  return { client, loader, requests, saved, source, options, pages };
}

test('initial playlist load samples randomized pages and caps the batch at 150 entries', async () => {
  const { loader, pages, requests, saved } = fixture();
  const progress = [];
  const cache = await loader.load({ onProgress: (loaded, total) => progress.push([loaded, total]) });
  assert.equal(PLAYLIST_BATCH_SIZE, 150);
  assert.equal(cache.tracks.length, 150);
  assert.equal(pages().length, 3);
  assert.equal(requests.length, 5, 'one snapshot, one size-only request, three song pages');
  assert.ok(pages().some(({ query }) => query.offset >= 150), 'selection is not just the first 150 entries');
  assert.equal(cache.remainingOffsets.length, 17);
  assert.equal(saved.length, 3, 'each successful page is checkpointed');
  assert.deepEqual(progress, [[50, 150], [100, 150], [150, 150]]);
});

test('top-ups start strictly below 25 unplayed songs and reuse the saved random page order', async () => {
  const { loader, pages } = fixture();
  await loader.load();
  assert.equal(PLAYLIST_REFILL_THRESHOLD, 25);
  await loader.loadMore(25);
  assert.equal(pages().length, 3);
  const expectedOffsets = loader.cache.remainingOffsets.slice(0, 3);
  await loader.loadMore(24);
  assert.deepEqual(pages().slice(3).map(({ query }) => query.offset), expectedOffsets);
  assert.equal(loader.cache.tracks.length, 300);
  assert.equal(new Set(pages().map(({ query }) => query.offset)).size, 6);
});

test('duplicate initial loads and top-ups share one in-flight operation and pages remain sequential', async () => {
  const { client, loader, pages } = fixture();
  const api = client.api.bind(client);
  let active = 0;
  let peak = 0;
  client.api = async (...args) => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 1));
    try {
      return await api(...args);
    } finally {
      active -= 1;
    }
  };
  const first = loader.load();
  assert.equal(loader.load(), first);
  await first;
  const refill = loader.loadMore(24);
  assert.equal(loader.loadMore(0), refill);
  await refill;
  assert.equal(pages().length, 6);
  assert.equal(peak, 1);
});

test('cached playlist restoration makes no requests and unchanged explicit loads only check the snapshot', async () => {
  const { loader, client, options, requests } = fixture();
  const cache = await loader.load();
  const before = requests.length;
  const restored = new PlaylistLoader(client, 'playlist-id', { ...options, cache });
  assert.equal(requests.length, before);
  assert.deepEqual(await restored.load(), cache);
  assert.equal(requests.length, before + 1);
  await restored.loadMore(24);
  assert.equal(restored.cache.tracks.length, 300);
});

test('quota errors preserve completed pages, stop immediately, and require an explicit retry', async () => {
  const { loader, client, source, saved, options, pages } = fixture();
  const api = client.api.bind(client);
  client.api = async (path, options) => {
    if (pages().length === 1 && options?.query?.offset !== undefined) {
      source.failure = Object.assign(new Error('Quota exceeded'), { status: 429, reason: 'QUOTA_EXCEEDED' });
    }
    return api(path, options);
  };
  await assert.rejects(loader.load(), { status: 429, reason: 'QUOTA_EXCEEDED' });
  assert.equal(loader.paused, true);
  assert.equal(saved.at(-1).tracks.length, 50);
  const failedOffset = pages().at(-1).query.offset;
  assert.equal(saved.at(-1).remainingOffsets[0], failedOffset);
  await loader.loadMore(0);
  assert.equal(pages().length, 2, 'later rounds do not automatically retry the failed batch');
  source.failure = null;
  client.api = api;
  await loader.load();
  assert.equal(pages().at(-3).query.offset, failedOffset);
  assert.equal(loader.cache.tracks.length, 200);
  const restored = new PlaylistLoader(client, 'playlist-id', { ...options, cache: saved[0] });
  await restored.loadMore(24);
  assert.equal(restored.cache.tracks.length, 200);
});

test('a playlist snapshot change stops top-ups without mixing different versions', async () => {
  const { loader, source, pages } = fixture();
  await loader.load();
  source.snapshotId = 'snapshot-2';
  await assert.rejects(loader.loadMore(24), /playlist changed/i);
  assert.equal(pages().length, 3);
  assert.equal(loader.paused, true);
  await loader.load();
  assert.equal(loader.cache.snapshotId, 'snapshot-2');
  assert.equal(loader.cache.tracks.length, 150);
});

test('small playlists stop at the end and legacy complete caches do not download pages', async () => {
  const { loader, client, requests, options } = fixture(73);
  const cache = await loader.load();
  assert.equal(cache.tracks.length, 73);
  assert.equal(loader.hasMore, false);
  const before = requests.length;
  await loader.loadMore(0);
  assert.equal(requests.length, before);
  const { remainingOffsets, total, ...legacy } = cache;
  const restored = new PlaylistLoader(client, 'playlist-id', { ...options, cache: legacy });
  await restored.load();
  assert.equal(requests.length, before + 1);
  assert.equal(restored.hasMore, false);
  assert.equal(restored.cache.tracks.length, 73);
});

test('unplayable and duplicate items are skipped without fetching extra pages to fill a batch', async () => {
  const { client, loader, pages } = fixture();
  const api = client.api.bind(client);
  client.api = async (path, options) => {
    const page = await api(path, options);
    if (page.items) page.items = [
      { item: null },
      { item: { type: 'episode', id: 'episode', uri: 'spotify:episode:episode' } },
      { item: { type: 'track', id: 'same', uri: 'spotify:track:same' } },
      { track: { type: 'track', id: 'same', uri: 'spotify:track:same' } },
    ];
    return page;
  };
  await loader.load();
  assert.equal(pages().length, 3);
  assert.equal(loader.cache.tracks.length, 1);
});

test('cancelling a live load prevents further pages or cache writes', async () => {
  const { loader, client, saved, pages } = fixture();
  const api = client.api.bind(client);
  client.api = async (path, options) => {
    const response = await api(path, options);
    if (options?.query?.offset !== undefined) loader.cancelled = true;
    return response;
  };
  await assert.rejects(loader.load(), /cancelled/);
  assert.equal(pages().length, 1);
  assert.equal(saved.length, 0);
});

test('cache persistence errors pause fetching and are surfaced to the caller', async () => {
  const { loader, pages } = fixture();
  loader.saveCache = () => { throw new Error('Storage full'); };
  await assert.rejects(loader.load(), /Storage full/);
  assert.equal(pages().length, 1);
  assert.equal(loader.cache.tracks.length, 50);
  assert.equal(loader.paused, true);
});

test('invalid playlist sizes fail explicitly without requesting song pages', async () => {
  const { loader, source, pages } = fixture();
  source.total = undefined;
  await assert.rejects(loader.load(), /valid playlist size/);
  assert.equal(pages().length, 0);
});

test('newly cached songs join the shuffled deck without repeating played or queued tracks', () => {
  const game = createGame();
  addContestant(game, createContestant('A'));
  nextRound(game, ['a', 'b', 'c'], () => 0);
  const played = game.rounds[0].trackId;
  const existing = [...game.deck];
  extendDeck(game, ['a', 'b', 'c', 'd', 'd', 'e'], () => 0);
  assert.equal(game.deck.length, 4);
  assert.equal(game.deck.includes(played), false);
  assert.deepEqual([...game.deck].sort(), [...existing, 'd', 'e'].sort());
  const previous = [...game.deck];
  extendDeck(game, ['a', 'b', 'c', 'd', 'e']);
  assert.deepEqual(game.deck, previous, 'unchanged caches do not reshuffle an existing deck');
});
