import { shuffle } from './game.js';

export const PLAYLIST_BATCH_SIZE = 150;
export const PLAYLIST_REFILL_THRESHOLD = 25;
const PAGE_SIZE = 50;

export class PlaylistLoader {
  constructor(client, playlistId, { cache = null, saveCache = () => {}, rng = Math.random } = {}) {
    this.client = client;
    this.playlistId = playlistId;
    this.cache = cache;
    this.saveCache = saveCache;
    this.rng = rng;
    this.pending = null;
    this.paused = false;
    this.cancelled = false;
  }

  get hasMore() {
    return Boolean(this.cache?.remainingOffsets?.length);
  }

  assertActive() {
    if (this.cancelled) throw new Error('Playlist loading cancelled.');
  }

  run(operation) {
    if (this.pending) return this.pending;
    this.pending = operation().catch((error) => {
      this.paused = true;
      throw error;
    }).finally(() => {
      this.pending = null;
    });
    return this.pending;
  }

  load({ onProgress = () => {} } = {}) {
    return this.run(async () => {
      this.assertActive();
      const retry = this.paused;
      this.paused = false;
      const info = await this.client.getPlaylistInfo(this.playlistId);
      this.assertActive();
      if (this.cache && info.snapshotId && this.cache.snapshotId === info.snapshotId) {
        return this.hasMore && (retry || !this.cache.tracks.length) ? this.fetchBatch(onProgress) : this.cache;
      }
      const page = await this.client.getPlaylistPage(this.playlistId, { limit: 1, fields: 'total' });
      this.assertActive();
      if (!Number.isSafeInteger(page?.total) || page.total < 0) {
        throw new Error('Spotify did not return a valid playlist size. No song pages were requested.');
      }
      const offsets = Array.from({ length: Math.ceil(page.total / PAGE_SIZE) }, (_, index) => index * PAGE_SIZE);
      this.cache = {
        playlistId: this.playlistId,
        name: info.name,
        snapshotId: info.snapshotId,
        total: page.total,
        remainingOffsets: shuffle(offsets, this.rng),
        tracks: [],
      };
      return this.fetchBatch(onProgress);
    });
  }

  loadMore(unplayedCount) {
    if (this.paused || !this.hasMore || unplayedCount >= PLAYLIST_REFILL_THRESHOLD) {
      return Promise.resolve(this.cache);
    }
    return this.run(async () => {
      this.assertActive();
      const info = await this.client.getPlaylistInfo(this.playlistId);
      this.assertActive();
      if (!info.snapshotId || info.snapshotId !== this.cache.snapshotId) {
        throw new Error('The playlist changed or its version could not be verified. Click Load playlist to refresh it.');
      }
      return this.fetchBatch();
    });
  }

  async fetchBatch(onProgress = () => {}) {
    const pages = this.cache.remainingOffsets.slice(0, PLAYLIST_BATCH_SIZE / PAGE_SIZE);
    let loaded = 0;
    for (const offset of pages) {
      this.assertActive();
      const page = await this.client.getPlaylistPage(this.playlistId, { limit: PAGE_SIZE, offset });
      this.assertActive();
      if (!Array.isArray(page?.items)) throw new Error('Spotify did not return valid playlist items.');
      if (page.total !== this.cache.total) {
        throw new Error('The playlist changed while loading. Click Load playlist to refresh it.');
      }
      const tracks = new Map(this.cache.tracks.map((track) => [track.id, track]));
      for (const track of page.tracks) tracks.set(track.id, track);
      this.cache = {
        ...this.cache,
        tracks: [...tracks.values()],
        remainingOffsets: this.cache.remainingOffsets.slice(1),
      };
      this.saveCache(this.cache);
      loaded += page.items.length;
      onProgress(loaded, Math.min(PLAYLIST_BATCH_SIZE, this.cache.total));
    }
    return this.cache;
  }
}
