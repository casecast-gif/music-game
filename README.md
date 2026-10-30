# music-game

A self-running screen for an in-person "guess the song" party game, powered by a Spotify playlist.

**No Steve** runs on the room's big screen with a Spotify speaker; players enter guesses on the shared screen, so no host is needed. **I'm Steve** preserves the host-controlled reveal and scoring flow. For each No Steve round the game:

1. randomly picks a song from the playlist (no repeats until every song has been played) and plays it,
2. opens guessing immediately and keeps the song playing through turns and the answer reveal,
3. gives each player a timed first chance to guess an unanswered **artist**, **song title** or **year of original release**, then circles back among correct players until everyone misses or all three categories are solved,
4. keeps a running scoreboard (per-category tallies and total out of 3 points per song), then
5. reveals any remaining answers and automatically moves on to the next song.

By default the game is tied to this playlist:
<https://open.spotify.com/playlist/551LDjYYp8i22IV6GGzjeq> (change it in `public/js/config.js`, or paste a different link on the setup screen).

## Requirements

- Node.js 18+ (only used to serve the static files — there are no npm dependencies)
- A **Spotify Premium** account and Spotify developer app (only required for Live Spotify mode)

## One-time Spotify setup

The app starts in **Mock data** mode and makes no Spotify API requests. Use the steps below only when you want to test real Spotify integration.

1. Go to <https://developer.spotify.com/dashboard> and create an app.
2. Tick **Web API** and **Web Playback SDK**.
3. Add these redirect URIs to the Spotify app:
   - Local development: `http://127.0.0.1:8888/` (Spotify does not accept `localhost`, use `127.0.0.1`).
   - Production: `https://casecast-gif.github.io/music-game/`.
4. The app's public **Client ID** is prefilled. If you use a different Spotify developer app, replace it with that app's Client ID.
5. Apps in development mode only work for users you add under **User Management**, so add the Spotify account you'll host with.
If the app is operated by an eligible organization and needs more access, use Spotify's official quota-extension request
in the Developer Dashboard; approval is not guaranteed. Do not create extra apps or accounts to work around a limit.

> Spotify development-mode apps can only read playlists the logged-in user owns or collaborates on. If loading the
> playlist fails with a 403, log in with the playlist owner's account, or save a copy of the playlist to your own account
> and paste that link instead.

## Running

```bash
npm start          # serves http://127.0.0.1:8888/
```

Open <http://127.0.0.1:8888/>, then:

1. The default **Mock data** mode loads bundled sample songs and simulates silent playback without calling Spotify or MusicBrainz. Use it for game development without consuming API quota.
2. To test Spotify, open **Settings & troubleshooting**, select **Live Spotify API**, then click **Log in with Spotify**. Each browser has separate saved settings; the configured Client ID is prefilled in each one.
3. After login, click **Load playlist** to fetch an initial batch of up to 150 playlist entries. The app randomizes 50-entry pages from across the playlist, then shuffles the playable songs for the game; this is not a uniform sample of individual songs. It checks the playlist snapshot and total size before fetching the first three pages sequentially. Every completed page and the remaining random page order are cached in that browser, so later visits can start without downloads. On an explicit reload, an unchanged playlist reuses its cache. A playlist is never fetched automatically on page startup in Live mode.
4. Select **No Steve** for automatic play or **I'm Steve** for the host-controlled version. Choose the target score (default 15). The first No Steve guess gets 60 seconds; each later guess, including returning players, gets 20 seconds. No Steve ends after the current song when a player or team reaches the target; I'm Steve can continue past it.
5. Add players. To make a team, enter a team name plus its members (comma separated); leave members empty for a solo player. Press **Start game** when ready.

The API mode is shared between tabs in the same browser profile. Spotify API requests are serialized per tab. On ordinary `429` responses, safe `GET` requests use bounded backoff and honor `Retry-After`; other requests are not repeated. The cooldown is shared across tabs in the browser profile. A `QUOTA_EXCEEDED` response blocks further requests until Spotify's `Retry-After` period expires (or until it is known to have expired when Spotify omits the header). Mock mode remains available during either cooldown.

During an active game in either mode, fewer than 25 unplayed cached songs triggers another batch of up to 150 entries, not a periodic timer. New songs join the shuffle without repeating played tracks or re-downloading completed pages. Unplayable entries and duplicate tracks can make a batch smaller than 150 songs. Existing full-playlist caches remain usable without downloading them again. If a batch fails, automatic top-ups pause while cached songs remain available; use **Load playlist** to retry explicitly. If a playlist changes, refresh it with **Load playlist** rather than mixing versions. Cached songs will not repeat while unfetched pages remain. Smaller batches reduce bursts, but 150 is an application batch size, not a guaranteed Spotify quota allowance; all cooldown safeguards still apply.

### During the game

| Control | Shortcut | What it does |
| --- | --- | --- |
| ⏯ Play / Pause game song | `Space` | Pause or resume playback in either mode, including No Steve guessing turns; guess timers keep running |
| ⏮ Restart song | | Play the current song from the beginning |
| Reveal artist / title / year | | I'm Steve only: reveal each answer separately |
| Wrong — reveal all | `R` | I'm Steve only: reveal all answers and album art |
| Next song | `N` | Move on; No Steve reveals answers first |

- **No Steve timed turns**: guessing opens as soon as the song starts, with no listening-only delay or automatic pause. The active player or team can choose an unanswered category or let the game match a guess to one unique answer. Matching ignores case, punctuation, and accents, tolerates small typos and omitted short words, and treats guesses that match multiple categories as wrong. The first guess gets 60 seconds; every later guess gets 20 seconds. Each correct category earns its guessing player 1 point and reveals that answer. Everyone gets a first attempt, then successful players circle back to guess remaining categories, just like I'm Steve. Wrong guesses, passes, and timeouts remove that player for the song without revealing another answer. A lone successful player can keep guessing. Turn order rotates between songs. The round ends only when everyone is out or all three categories have been claimed; remaining answers are revealed for six seconds before the next song. Playback continues throughout turns and the reveal until the next song starts (unless the track ends naturally or you stop playback). Resuming a saved game restores playback and skips any old listening-only phase.
- **No Steve voice input**: when supported by the browser, press **Speak guess** to listen for up to 15 seconds, including short pauses between words. The song is lowered to 20% of its current volume and stays quiet while you review the transcript, until you submit, pass, time out, leave the round, or encounter a microphone error. The normal guess timer keeps running. After listening ends, you can press **Speak guess** again to replace the transcript. The original volume is restored on the same device without resuming paused music. Browser playback uses local SDK volume controls; Spotify Connect uses one playback-state read plus volume-lower and volume-restore requests per voice session, all through the existing cooldown safeguards. If a device cannot adjust volume, voice input still works with a visible warning to lower the speaker manually. Restoration failures are reported; check the speaker volume manually rather than bypassing a cooldown. Recognition can mishear names and may require an online service; typed guesses are always available. Voice recognition is optional and is never used to decide whether an answer is right.
- **I'm Steve scoring**: every player or team gets one first attempt at an unanswered category. Correct players become board runners; after everyone has had a first attempt, those runners take turns guessing the remaining answers. A runner keeps going until they miss or pass, then the next successful player gets a turn. The host can press **Put the clock on em** to start a 15-second turn timer with a 10-second on-screen countdown; a timeout counts as Wrong / Pass. The round ends when all answers are identified or no runners remain, and any remaining answers are revealed.
- **Play on**: choose a Spotify app/speaker (press **Refresh devices** to update; the active device is labeled). The game transfers playback to the selected device when needed, then confirms the track and device state. If Spotify accepts the command but keeps another track playing, use the active device or try the browser player. To use this tab as the speaker, choose **Enable playback in this browser** under Settings to prepare it, then use **Play** in the game; Spotify requires Premium and browser protected-audio support.
- **Spotify preview player**: the Embed implementation is retained for the future **Name That Tune** mode, where short previews can be useful. It is disabled for **No Steve**, which needs full-song playback.
- **Year** shows the *original* release year: Spotify often reports a remaster or compilation date, so the year is
  looked up on [MusicBrainz](https://musicbrainz.org) (earliest release of that recording) and falls back to Spotify's
  album year. The Year category is unavailable until an answer is ready. 1977 is displayed as **Star Wars** and 2001 as **Towers**.
- Scores, players and the shuffle are saved in the browser, so a refresh doesn't lose the game (**Resume game**).

## Development

```bash
npm test           # unit tests (node --test)
```

- `public/js/game.js` — pure game logic: playlist link parsing, shuffle deck, players/teams, scoring, standings
- `public/js/spotify.js` — Spotify PKCE login, playlist loading, Web Playback SDK / Connect playback
- `public/js/playlist.js` — resumable randomized playlist batches and low-song top-ups
- `public/js/voice.js` — bounded voice capture and temporary music-volume handling
- `public/js/year.js` — original-release-year lookup via MusicBrainz
- `public/js/app.js` — UI wiring
- `server.js` — tiny static file server

## Deployment

The production site is <https://casecast-gif.github.io/music-game/>. Pushes to `main` run tests and automatically deploy the `public/` site when they pass. To enable the first deployment, open the repository's **Settings → Pages** and set **Build and deployment → Source** to **GitHub Actions**.
