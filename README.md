# music-game

A self-running screen for an in-person "guess the song" party game, powered by a Spotify playlist.

**No Steve** runs on the room's big screen with a Spotify speaker; players enter guesses on the shared screen, so no host is needed. **I'm Steve** preserves the host-controlled reveal and scoring flow. For each No Steve round the game:

1. randomly picks a song from the playlist (no repeats until every song has been played) and plays it,
2. starts a timed turn immediately so each player can guess an unanswered **artist**, **song title** or **year of original release**,
3. keeps a running scoreboard (per-category tallies and total out of 3 points per song), then
4. reveals any remaining answers and automatically moves on to the next song.

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
3. After login, click **Load playlist** to fetch the selected playlist. It is cached in that browser so later visits can start quickly. Playlist loading is never automatic in Live mode.
4. Select **No Steve** for automatic play or **I'm Steve** for the host-controlled version. Choose the target score (default 15). The first No Steve guess gets 60 seconds; each later player gets 20 seconds. No Steve ends after the current song when a player or team reaches the target; I'm Steve can continue past it.
5. Add players. To make a team, enter a team name plus its members (comma separated); leave members empty for a solo player. Press **Start game** when ready.

The API mode is shared between tabs in the same browser profile. A Spotify `QUOTA_EXCEEDED` response is remembered in that profile; subsequent API calls are blocked until Spotify's `Retry-After` period expires. Mock mode remains available during that cooldown.

### During the game

| Control | Shortcut | What it does |
| --- | --- | --- |
| ⏯ Play / Pause game song | `Space` | Pause or resume playback |
| ⏮ Restart song | | Play the current song from the beginning |
| Reveal artist / title / year | | I'm Steve only: reveal each answer separately |
| Wrong — reveal all | `R` | I'm Steve only: reveal all answers and album art |
| Next song | `N` | Move on; No Steve reveals answers first |

- **No Steve timed turns**: as soon as the song starts, the active player or team enters an artist, song title, or year guess before the countdown ends; the game automatically matches it to one unanswered category. Matching ignores case, punctuation, and accents, tolerates small typos and omitted short words, and treats guesses that match multiple categories as wrong. The first player gets 60 seconds; each subsequent player gets 20 seconds. Correct guesses earn 1 point and reveal that answer; wrong guesses, passes, and timeouts do not reveal it. The next player then gets a turn. Turn order rotates between songs. The round ends when everyone has had a turn or all three categories have been claimed; remaining answers are revealed for six seconds before the next song.
- **No Steve voice input**: when supported by the browser, press **Speak guess** and review the transcript before submitting. Recognition can mishear names and may require an online service; typed guesses are always available. Voice and typed guesses use the same automatic answer matching.
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
- `public/js/year.js` — original-release-year lookup via MusicBrainz
- `public/js/app.js` — UI wiring
- `server.js` — tiny static file server

## Deployment

The production site is <https://casecast-gif.github.io/music-game/>. Pushes to `main` run tests only; deployment happens only when the workflow is manually dispatched. To enable the first deployment, open the repository's **Settings → Pages** and set **Build and deployment → Source** to **GitHub Actions**. To publish, use **Actions → Test and deploy to GitHub Pages → Run workflow**.
