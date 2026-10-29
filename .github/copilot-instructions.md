# Project Guidelines

## Spotify API safety

- Keep Spotify Web API access in `public/js/spotify.js`; other modules should use its client instead of calling Spotify endpoints directly.
- Mock mode is the default and must make no Spotify or MusicBrainz requests. Live mode must require explicit user opt-in; never fetch playlists automatically on page load.
- Treat Spotify's `429` response body and `Retry-After` header as authoritative. Preserve the error reason, stop immediately on `QUOTA_EXCEEDED`, and never retry before `Retry-After`.
- Persist a known quota cooldown so tabs in the same browser profile block further Spotify API calls. Keep playlist-page requests sequential, prevent duplicate in-flight loads, and cache successfully loaded playlists.
- For ordinary `429` responses without `Retry-After`, use bounded exponential backoff with jitter; never spin or retry indefinitely.
- Do not attempt to evade Spotify limits with extra apps, accounts, proxies, or alternate endpoints. Do not invent fixed request thresholds; follow Spotify's current official documentation.
- Keep mock fixtures deterministic and test that mock workflows make zero network requests. Live API tests should be explicit and minimize calls.

## Validation

- Run `npm test` for changes to application logic or Spotify request handling.
- Update `README.md` when API mode, playback, or setup behavior changes.
