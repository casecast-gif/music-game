// Resolves the year a song was *originally* released.
//
// Spotify's album release date is often the date of a remaster, compilation or
// "greatest hits" album rather than the original release. We therefore look the
// recording up on MusicBrainz (by ISRC first, then by artist + title) and use
// the earliest "first-release-date" found, falling back to Spotify's year.

const MB_BASE = 'https://musicbrainz.org/ws/2';
const MIN_YEAR = 1800;

export function formatYear(year) {
  if (year === 1977) return 'Star Wars';
  if (year === 2001) return 'Towers';
  return String(year);
}

export function yearFromDate(date) {
  const match = typeof date === 'string' ? date.match(/^(\d{4})/) : null;
  if (!match) return null;
  const year = Number(match[1]);
  return year >= MIN_YEAR ? year : null;
}

/** Removes remaster/version noise so titles can be compared across releases. */
export function cleanTitle(title) {
  return String(title ?? '')
    .replace(/\s+-\s+.*$/, '') // "Song - Remastered 2009", "Song - Live"
    .replace(/\s*[([][^)\]]*(remaster|version|edit|mono|stereo|mix|live|feat\.?|ft\.|with )[^)\]]*[)\]]/gi, '')
    .trim();
}

export function normalize(text) {
  return String(text ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/&/g, 'and')
    .replace(/^the\s+/, '')
    .replace(/[^a-z0-9]+/g, '');
}

export function guessMatches(guess, acceptedAnswers) {
  const normalizedGuess = normalize(guess);
  return Boolean(normalizedGuess) && acceptedAnswers.some((answer) => normalize(answer) === normalizedGuess);
}

function earliestYear(recordings) {
  const years = recordings.map((r) => yearFromDate(r['first-release-date'])).filter((y) => y !== null);
  return years.length ? Math.min(...years) : null;
}

/** Earliest year from a MusicBrainz ISRC lookup (`/isrc/{isrc}`) response. */
export function yearFromIsrcResponse(data) {
  return earliestYear(Array.isArray(data?.recordings) ? data.recordings : []);
}

/**
 * Earliest year from a MusicBrainz recording search response, considering only
 * confident matches whose title and primary artist match the track.
 */
export function yearFromSearchResponse(data, { title, artist }) {
  const wantTitle = normalize(cleanTitle(title));
  const wantArtist = normalize(artist);
  const recordings = (Array.isArray(data?.recordings) ? data.recordings : []).filter((r) => {
    if ((r.score ?? 0) < 90) return false;
    if (normalize(cleanTitle(r.title)) !== wantTitle) return false;
    const credits = Array.isArray(r['artist-credit']) ? r['artist-credit'] : [];
    return credits.some((c) => normalize(c.name ?? c.artist?.name) === wantArtist);
  });
  return earliestYear(recordings);
}

/** Lucene-escapes a value for a MusicBrainz search query. */
function luceneQuote(value) {
  return `"${String(value).replace(/["\\]/g, '\\$&')}"`;
}

// MusicBrainz allows ~1 request per second per client.
let queue = Promise.resolve();
function throttled(fn, delayMs = 1100) {
  const run = queue.then(fn);
  queue = run.catch(() => {}).then(() => new Promise((r) => setTimeout(r, delayMs)));
  return run;
}

async function mbGet(path, fetchImpl) {
  return throttled(async () => {
    const res = await fetchImpl(`${MB_BASE}${path}${path.includes('?') ? '&' : '?'}fmt=json`, {
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) throw Object.assign(new Error(`MusicBrainz ${res.status}`), { status: res.status });
    return res.json();
  });
}

/**
 * Returns { year, source, complete } where source is 'musicbrainz' or 'spotify'.
 * `complete` is false when a MusicBrainz request failed (network error, rate
 * limit, ...) so callers can retry later instead of caching the fallback.
 * Never throws: network problems fall back to the Spotify year.
 */
export async function resolveOriginalYear(track, { fetchImpl = globalThis.fetch } = {}) {
  const spotifyYear = yearFromDate(track.releaseDate);
  const candidates = [];
  let complete = true;
  const attempt = async (fn) => {
    try {
      candidates.push(await fn());
    } catch (err) {
      if (err?.status !== 404) complete = false; // 404 just means "not known to MusicBrainz"
    }
  };
  if (track.isrc) {
    await attempt(async () => yearFromIsrcResponse(await mbGet(`/isrc/${encodeURIComponent(track.isrc)}`, fetchImpl)));
  }
  const artist = track.artists?.[0];
  if (artist && track.title) {
    const query = `recording:${luceneQuote(cleanTitle(track.title))} AND artist:${luceneQuote(artist)}`;
    await attempt(async () =>
      yearFromSearchResponse(await mbGet(`/recording?limit=25&query=${encodeURIComponent(query)}`, fetchImpl), {
        title: track.title,
        artist,
      }),
    );
  }
  const mbYears = candidates.filter((y) => y !== null);
  const mbYear = mbYears.length ? Math.min(...mbYears) : null;
  if (mbYear !== null && (spotifyYear === null || mbYear <= spotifyYear)) {
    return { year: mbYear, source: 'musicbrainz', complete };
  }
  return { year: spotifyYear, source: 'spotify', complete };
}
