import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addContestant,
  createContestant,
  createGame,
  currentRound,
  deserializeGame,
  isTeam,
  nextRound,
  parsePlaylistId,
  removeContestant,
  resetScores,
  roundPoints,
  serializeGame,
  setAward,
  shuffle,
  standings,
} from '../public/js/game.js';
import { DEFAULT_PLAYLIST_URL } from '../public/js/config.js';

const ID = '551LDjYYp8i22IV6GGzjeq';

test('parsePlaylistId handles share links, URIs and bare IDs', () => {
  assert.equal(parsePlaylistId(`https://open.spotify.com/playlist/${ID}?si=203189d344634ae1`), ID);
  assert.equal(parsePlaylistId(`https://open.spotify.com/intl-de/playlist/${ID}`), ID);
  assert.equal(parsePlaylistId(`spotify:playlist:${ID}`), ID);
  assert.equal(parsePlaylistId(`  ${ID}  `), ID);
  assert.equal(parsePlaylistId('https://example.com/playlist/551LDjYYp8i22IV6GGzjeq'), null);
  assert.equal(parsePlaylistId('https://open.spotify.com/album/551LDjYYp8i22IV6GGzjeq'), null);
  assert.equal(parsePlaylistId('nope'), null);
  assert.equal(parsePlaylistId(undefined), null);
});

test('default playlist is the configured party playlist', () => {
  assert.equal(parsePlaylistId(DEFAULT_PLAYLIST_URL), ID);
});

test('shuffle keeps all items and does not mutate input', () => {
  const input = [1, 2, 3, 4, 5];
  const out = shuffle(input, () => 0);
  assert.deepEqual(input, [1, 2, 3, 4, 5]);
  assert.deepEqual([...out].sort(), input);
  assert.notDeepEqual(out, input);
});

test('contestants can be solo players or teams, names must be unique', () => {
  const game = createGame();
  const solo = createContestant('Alice');
  const team = createContestant('Rockers', 'Bob, Carol, ');
  addContestant(game, solo);
  addContestant(game, team);
  assert.equal(isTeam(solo), false);
  assert.equal(isTeam(team), true);
  assert.deepEqual(team.members, ['Bob', 'Carol']);
  assert.throws(() => addContestant(game, createContestant('alice')), /already playing/);
  assert.throws(() => createContestant('   '), /required/);
});

test('nextRound plays every song once before repeating', () => {
  const game = createGame();
  const tracks = ['a', 'b', 'c', 'd'];
  const seen = [];
  for (let i = 0; i < tracks.length; i++) seen.push(nextRound(game, tracks));
  assert.deepEqual([...seen].sort(), tracks);
  assert.equal(currentRound(game).trackId, seen.at(-1));
  assert.ok(tracks.includes(nextRound(game, tracks)), 'reshuffles when exhausted');
  assert.equal(nextRound(createGame(), []), null);
});

test('scores count artist, title and year separately', () => {
  const game = createGame();
  const alice = createContestant('Alice');
  const team = createContestant('Team B', ['Bob', 'Carl']);
  addContestant(game, alice);
  addContestant(game, team);
  nextRound(game, ['x', 'y']);
  setAward(game, 0, alice.id, 'artist');
  setAward(game, 0, alice.id, 'title');
  setAward(game, 0, alice.id, 'year');
  setAward(game, 0, team.id, 'year');
  assert.equal(roundPoints(game.rounds[0], alice.id), 3);
  nextRound(game, ['x', 'y']);
  setAward(game, 1, team.id, 'artist', true);
  setAward(game, 1, team.id, 'title');
  setAward(game, 1, team.id, 'title'); // toggled back off

  const [first, second] = standings(game);
  assert.equal(first.contestant.name, 'Alice');
  assert.deepEqual(first.byCategory, { artist: 1, title: 1, year: 1 });
  assert.equal(first.total, 3);
  assert.equal(first.maxPoints, 6);
  assert.equal(first.perfectRounds, 1);
  assert.equal(first.rank, 1);
  assert.deepEqual(second.byCategory, { artist: 1, title: 0, year: 1 });
  assert.equal(second.total, 2);
  assert.equal(second.rank, 2);

  assert.throws(() => setAward(game, 0, alice.id, 'album'), /Unknown category/);
  assert.throws(() => setAward(game, 9, alice.id, 'year'), /No round/);
  assert.throws(() => setAward(game, 0, 'ghost', 'year'), /Unknown contestant/);
});

test('ties share a rank', () => {
  const game = createGame();
  const a = createContestant('A');
  const b = createContestant('B');
  addContestant(game, a);
  addContestant(game, b);
  nextRound(game, ['x']);
  setAward(game, 0, a.id, 'year');
  setAward(game, 0, b.id, 'artist');
  assert.deepEqual(standings(game).map((r) => r.rank), [1, 1]);
});

test('removing a contestant and resetting scores', () => {
  const game = createGame();
  const a = createContestant('A');
  addContestant(game, a);
  nextRound(game, ['x']);
  setAward(game, 0, a.id, 'title');
  removeContestant(game, a.id);
  assert.equal(game.contestants.length, 0);
  assert.deepEqual(game.rounds[0].awards, {});
  resetScores(game);
  assert.deepEqual(game.rounds, []);
  assert.deepEqual(game.deck, []);
});

test('games survive serialization', () => {
  const game = createGame({ playlistId: ID });
  const a = createContestant('A', ['x']);
  addContestant(game, a);
  nextRound(game, ['t1', 't2']);
  setAward(game, 0, a.id, 'artist');
  const restored = deserializeGame(serializeGame(game));
  assert.deepEqual(restored, game);
  assert.equal(deserializeGame('not json'), null);
  assert.equal(deserializeGame('{}'), null);
});
