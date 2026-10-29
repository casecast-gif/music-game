import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cleanTitle,
  formatYear,
  normalize,
  resolveOriginalYear,
  yearFromDate,
  yearFromIsrcResponse,
  yearFromSearchResponse,
} from '../public/js/year.js';

test('yearFromDate handles Spotify date precisions', () => {
  assert.equal(yearFromDate('1985-06-01'), 1985);
  assert.equal(yearFromDate('1985-06'), 1985);
  assert.equal(yearFromDate('1985'), 1985);
  assert.equal(yearFromDate('0000'), null);
  assert.equal(yearFromDate(null), null);
});

test('formatYear substitutes the requested clue labels', () => {
  assert.equal(formatYear(1977), 'Star Wars');
  assert.equal(formatYear(2001), 'Towers');
  assert.equal(formatYear(1985), '1985');
});

test('cleanTitle strips remaster / version suffixes', () => {
  assert.equal(cleanTitle('Bohemian Rhapsody - Remastered 2011'), 'Bohemian Rhapsody');
  assert.equal(cleanTitle('Hey Jude (Remastered 2015)'), 'Hey Jude');
  assert.equal(cleanTitle('Song [Radio Edit]'), 'Song');
  assert.equal(cleanTitle('Lean On (feat. MØ)'), 'Lean On');
  assert.equal(cleanTitle('(I Can\'t Get No) Satisfaction'), "(I Can't Get No) Satisfaction");
  assert.equal(normalize('The Beatles'), normalize('beatles'));
  assert.equal(normalize('Simon & Garfunkel'), normalize('Simon and Garfunkel'));
});

test('ISRC response yields earliest first-release-date', () => {
  const data = { recordings: [{ 'first-release-date': '1997-03' }, { 'first-release-date': '1975-10-31' }, {}] };
  assert.equal(yearFromIsrcResponse(data), 1975);
  assert.equal(yearFromIsrcResponse({}), null);
});

test('search response only trusts confident title + artist matches', () => {
  const data = {
    recordings: [
      { score: 100, title: 'Hey Jude', 'first-release-date': '1968-08-26', 'artist-credit': [{ name: 'The Beatles' }] },
      { score: 100, title: 'Hey Jude', 'first-release-date': '1960', 'artist-credit': [{ name: 'Someone Else' }] },
      { score: 50, title: 'Hey Jude', 'first-release-date': '1950', 'artist-credit': [{ name: 'The Beatles' }] },
      { score: 100, title: 'Hey Jude (live)', 'first-release-date': '1966', 'artist-credit': [{ name: 'Beatles' }] },
    ],
  };
  assert.equal(yearFromSearchResponse(data, { title: 'Hey Jude - Remastered 2015', artist: 'The Beatles' }), 1966);
});

function fakeFetch(routes) {
  const calls = [];
  const fn = async (url) => {
    calls.push(url);
    for (const [pattern, response] of routes) {
      if (url.includes(pattern)) {
        if (response instanceof Error) throw response;
        if (response.status) return { ok: false, status: response.status, json: async () => ({}) };
        return { ok: true, status: 200, json: async () => response };
      }
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  fn.calls = calls;
  return fn;
}

const track = { title: 'Hey Jude - Remastered 2015', artists: ['The Beatles'], releaseDate: '2015-11-06', isrc: 'GBAYE0601690' };

test('resolveOriginalYear prefers the earliest MusicBrainz year', async () => {
  const fetchImpl = fakeFetch([
    ['/isrc/GBAYE0601690', { recordings: [{ 'first-release-date': '1968-08-26' }] }],
    ['/recording?', { recordings: [] }],
  ]);
  assert.deepEqual(await resolveOriginalYear(track, { fetchImpl }), { year: 1968, source: 'musicbrainz', complete: true });
  assert.ok(fetchImpl.calls.every((u) => u.startsWith('https://musicbrainz.org/ws/2/') && u.includes('fmt=json')));
});

test('resolveOriginalYear falls back to Spotify on errors', async () => {
  const fetchImpl = fakeFetch([['musicbrainz', new Error('offline')]]);
  assert.deepEqual(await resolveOriginalYear(track, { fetchImpl }), { year: 2015, source: 'spotify', complete: false });
});

test('resolveOriginalYear ignores MusicBrainz years later than Spotify', async () => {
  const fetchImpl = fakeFetch([['/isrc/', { recordings: [{ 'first-release-date': '2020' }] }]]);
  // the recording search 404s, which means "not found" rather than a failure
  assert.deepEqual(await resolveOriginalYear(track, { fetchImpl }), { year: 2015, source: 'spotify', complete: true });
});

test('resolveOriginalYear marks rate-limited lookups as incomplete', async () => {
  const fetchImpl = fakeFetch([['musicbrainz', { status: 503 }]]);
  assert.deepEqual(await resolveOriginalYear(track, { fetchImpl }), { year: 2015, source: 'spotify', complete: false });
});
