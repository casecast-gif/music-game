# music-game

A host/controller screen for an in-person "guess the song" party game, powered by a Spotify playlist.

The host runs this page on a laptop hooked up to speakers (or controls any Spotify device in the room). For each round it:

1. randomly picks a song from the playlist (no repeats until every song has been played) and plays it,
2. reveals the **artist**, **song title** and **year of original release** when you're ready,
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
4. Copy the app's **Client ID**.
5. Apps in development mode only work for users you add under **User Management**, so add the Spotify account you'll host with.

> Spotify development-mode apps can only read playlists the logged-in user owns or collaborates on. If loading the
> playlist fails with a 403, log in with the playlist owner's account, or save a copy of the playlist to your own account
> and paste that link instead.

## Running

```bash
npm start          # serves http://127.0.0.1:8888/
```

Open <http://127.0.0.1:8888/>, then:

1. Paste your Client ID and **Log in with Spotify**.
2. The playlist loads automatically (or paste another link and press **Load playlist**).
3. Add players. To make a team, enter a team name plus its members (comma separated); leave members empty for a solo player.
4. Press **Start game**.

### During the game

| Control | Shortcut | What it does |
| --- | --- | --- |
| ⏯ Play / Pause | `Space` | Pause or resume the current song |
| ⏮ Restart song | | Play the current song from the beginning |
| 👀 Reveal answer | `R` | Show artist, title, year and album art |
| ⏭ Next song | `N` | Pick and play the next random song |

- **Score this song**: toggle Artist / Title / Year for each player or team (each worth 1 point).
- **Play on**: choose where the music plays — "This browser" or any open Spotify app/speaker (press ↻ to refresh).
- **Year** shows the *original* release year: Spotify often reports a remaster or compilation date, so the year is
  looked up on [MusicBrainz](https://musicbrainz.org) (earliest release of that recording) and falls back to Spotify's
  album year. If it's still wrong you can type the correct year in — your correction is remembered.
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
