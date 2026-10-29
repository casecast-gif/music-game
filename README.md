# music-game

A host/controller screen for an in-person "guess the song" party game, powered by a Spotify playlist.

The host runs this page on a laptop hooked up to speakers (or controls any Spotify device in the room). For each round it:

1. randomly picks a song from the playlist (no repeats until every song has been played) and plays it,
2. reveals the **artist**, **song title** and **year of original release** one at a time as players guess,
3. lets you tick off who got each of those three right — individual players and/or teams,
4. keeps a running scoreboard (per-category tallies and total out of 3 points per song), then
5. moves on to the next song.

By default the game is tied to this playlist:
<https://open.spotify.com/playlist/551LDjYYp8i22IV6GGzjeq> (change it in `public/js/config.js`, or paste a different link on the setup screen).

## Requirements

- Node.js 18+ (only used to serve the static files — there are no npm dependencies)
- A **Spotify Premium** account (required by Spotify for in-browser playback / playback control)
- A Spotify developer app (free)

## One-time Spotify setup

1. Go to <https://developer.spotify.com/dashboard> and create an app.
2. Tick **Web API** and **Web Playback SDK**.
3. Add the redirect URI `http://127.0.0.1:8888/` (Spotify does not accept `localhost`, use `127.0.0.1`).
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

1. Use **Settings & troubleshooting** and click **Log in with Spotify**. Each browser has separate saved settings; the configured Client ID is prefilled in each one.
2. The playlist loads automatically. It is cached in the browser so later visits can start quickly; use Settings to reload it or choose another playlist.
3. Keep **No Steve** selected (I'm Steve, Jeopardy Styleez, and Name That Tune are coming soon), choose the target score (default 15), and add players. The target is the combined Artist, Song, and Year points; it remains visible on the scoreboard, but does not stop play.
4. To make a team, enter a team name plus its members (comma separated); leave members empty for a solo player. Press **Start game** when ready.

### During the game

| Control | Shortcut | What it does |
| --- | --- | --- |
| ⏯ Play / Pause game song | `Space` | Start the current game song if another song is active; pause or resume it when it is already playing |
| ⏮ Restart song | | Play the current song from the beginning |
| Reveal artist / title / year | | Reveal each answer separately; album art appears after all three are revealed |
| Wrong — reveal all | `R` | Reveal all answers and album art |
| ⏭ Next song | `N` | Pick and play the next random song |

- **Score this song**: toggle Artist / Song / Year for each player or team (each worth 1 point). The scoreboard shows each total against the selected goal.
- **Play on**: choose a Spotify app/speaker (press **Refresh devices** to update; the active device is labeled). The game transfers playback to the selected device when needed, then confirms the track and device state. If Spotify accepts the command but keeps another track playing, use the active device or try the browser player. To use this tab as the speaker, choose **Enable playback in this browser** under Settings to prepare it, then use **Play** in the game; Spotify requires Premium and browser protected-audio support.
- **Spotify preview player**: the Embed implementation is retained for the future **Name That Tune** mode, where short previews can be useful. It is disabled for **No Steve**, which needs full-song playback.
- **Year** shows the *original* release year: Spotify often reports a remaster or compilation date, so the year is
  looked up on [MusicBrainz](https://musicbrainz.org) (earliest release of that recording) and falls back to Spotify's
  album year. 1977 is displayed as **Star Wars** and 2001 as **Towers**. If the year is still wrong you can type the
  correct year in — your correction is remembered.
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
