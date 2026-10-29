export const MOCK_DEVICE_ID = 'mock-device';
export const MOCK_PLAYLIST_NAME = 'Demo playlist (mock)';

export const MOCK_TRACKS = Array.from({ length: 12 }, (_, index) => {
  const number = String(index + 1).padStart(2, '0');
  return {
    id: `mock-track-${number}`,
    uri: `spotify:track:mock-track-${number}`,
    title: `Demo Song ${number}`,
    artists: [`Demo Artist ${number}`],
    album: 'Sample Album',
    releaseDate: `${1990 + index}-01-01`,
    image: null,
    isrc: null,
    durationMs: 180_000,
  };
});

export class MockSpotifyClient {
  constructor(clientId) {
    this.clientId = clientId;
    this.isMock = true;
    this.deviceId = null;
    this.currentUri = null;
    this.isPlaying = false;
  }

  async getPlaylistName() {
    return MOCK_PLAYLIST_NAME;
  }

  async getPlaylistTracks(_playlistId, { onProgress = () => {} } = {}) {
    onProgress(MOCK_TRACKS.length, MOCK_TRACKS.length);
    return MOCK_TRACKS.map((track) => ({ ...track, artists: [...track.artists] }));
  }

  async getDevices() {
    return [{
      id: MOCK_DEVICE_ID,
      name: 'Mock playback (silent)',
      type: 'Mock',
      is_active: true,
      is_restricted: false,
    }];
  }

  async initPlayer() {
    this.deviceId = MOCK_DEVICE_ID;
    return this.deviceId;
  }

  activate() {}

  async play(uri) {
    this.currentUri = uri;
    this.isPlaying = true;
  }

  async pause() {
    this.isPlaying = false;
  }

  async togglePlay(_deviceId, expectedUri) {
    if (!this.currentUri || (expectedUri && this.currentUri !== expectedUri)) return false;
    this.isPlaying = !this.isPlaying;
    return true;
  }
}
