import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addContestant,
  createContestant,
  createGame,
  DEFAULT_TARGET_SCORE,
  MANUAL_DISPLAY_SECONDS,
  MANUAL_TURN_SECONDS,
  guessTimeLimitSeconds,
  manualClockDisplaySeconds,
  currentRound,
  currentTurn,
  deserializeGame,
  getAward,
  isTeam,
  nextRound,
  parsePlaylistId,
  passTurn,
  removeContestant,
  resolveManualTurn,
  resetScores,
  resolveGuess,
  roundPoints,
  scoredCategories,
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

test("I'm Steve clock shows ten seconds while timing out after fifteen", () => {
  const deadlineAt = MANUAL_TURN_SECONDS * 1000;
  assert.equal(MANUAL_DISPLAY_SECONDS, 10);
  assert.equal(MANUAL_TURN_SECONDS, 15);
  assert.equal(manualClockDisplaySeconds(deadlineAt, 0), 10);
  assert.equal(manualClockDisplaySeconds(deadlineAt, 5_000), 5);
  assert.equal(manualClockDisplaySeconds(deadlineAt, 10_000), 0);
  assert.equal(manualClockDisplaySeconds(deadlineAt, deadlineAt), 0);
});

test('new games default to No Steve while legacy saved games retain I’m Steve', () => {
  assert.equal(createGame().mode, 'no-steve');
  assert.equal(createGame({ mode: 'im-steve' }).mode, 'im-steve');
  const legacy = deserializeGame(JSON.stringify({
    contestants: [],
    rounds: [],
  }));
  assert.equal(legacy.mode, 'im-steve');
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

test('No Steve rotates the starting contestant and begins with guessing immediately', () => {
  const game = createGame();
  const a = createContestant('A');
  const b = createContestant('B');
  addContestant(game, a);
  addContestant(game, b);

  nextRound(game, ['x', 'y']);
  assert.equal(currentTurn(game).id, a.id);
  assert.equal(game.rounds[0].phase, 'turn');
  assert.equal(game.rounds[0].listenDeadlineAt, null);
  assert.equal(guessTimeLimitSeconds(game.rounds[0]), 60);
  game.rounds[0].turnDeadlineAt = Date.now() + 30_000;
  const saved = deserializeGame(serializeGame(game));
  assert.equal(saved.rounds[0].turnDeadlineAt, game.rounds[0].turnDeadlineAt);
  passTurn(game, 0, a.id);
  assert.equal(game.rounds[0].turnDeadlineAt, null);
  assert.equal(guessTimeLimitSeconds(game.rounds[0]), 20);

  nextRound(game, ['x', 'y']);
  assert.equal(currentTurn(game).id, b.id);
  assert.equal(guessTimeLimitSeconds(game.rounds[1]), 60);
  assert.equal(game.rounds[1].turnDeadlineAt, null);
});

test("I'm Steve rounds retain the manual scoring phase", () => {
  const game = createGame({ mode: 'im-steve' });
  addContestant(game, createContestant('A'));
  nextRound(game, ['x']);
  assert.equal(currentRound(game).phase, 'manual');
  assert.equal(currentRound(game).listenDeadlineAt, null);
});

test('saved No Steve listening phases resume as guessing turns without a listening deadline', () => {
  const game = createGame();
  addContestant(game, createContestant('A'));
  nextRound(game, ['x']);
  const round = currentRound(game);
  round.phase = 'listening';
  round.listenDeadlineAt = Date.now() + 15_000;
  const restored = deserializeGame(serializeGame(game));
  assert.equal(currentRound(restored).phase, 'turn');
  assert.equal(currentRound(restored).listenDeadlineAt, null);
  assert.equal(currentRound(restored).turnDeadlineAt, null);
  assert.equal(currentTurn(restored).id, currentTurn(game).id);
  assert.equal(guessTimeLimitSeconds(currentRound(restored)), 60);
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
  passTurn(game, 0, alice.id);
  setAward(game, 0, team.id, 'year');
  assert.deepEqual(scoredCategories(game.rounds[0], game.contestants), ['artist', 'title', 'year']);
  assert.equal(roundPoints(game.rounds[0], alice.id), 2);
  assert.equal(roundPoints(game.rounds[0], team.id), 1);
  nextRound(game, ['x', 'y']);
  setAward(game, 1, team.id, 'artist');
  passTurn(game, 1, team.id);
  setAward(game, 1, alice.id, 'year');

  const [first, second] = standings(game);
  assert.equal(first.contestant.name, 'Alice');
  assert.deepEqual(first.byCategory, { artist: 1, title: 1, year: 1 });
  assert.equal(first.total, 3);
  assert.equal(first.maxPoints, 6);
  assert.equal(first.perfectRounds, 0);
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
  passTurn(game, 0, a.id);
  setAward(game, 0, b.id, 'artist');
  assert.deepEqual(standings(game).map((r) => r.rank), [1, 1]);
});

test('a contestant keeps their turn on correct answers, but wrong/pass advances and removes them for the song', () => {
  const game = createGame();
  const a = createContestant('A');
  const b = createContestant('B');
  addContestant(game, a);
  addContestant(game, b);
  nextRound(game, ['x', 'y']);

  assert.equal(currentTurn(game).id, a.id);
  setAward(game, 0, a.id, 'artist');
  assert.equal(currentTurn(game).id, a.id);
  assert.throws(() => setAward(game, 0, b.id, 'title'), /not this contestant’s turn/);
  assert.throws(() => setAward(game, 0, a.id, 'artist'), /already been identified/);

  assert.equal(passTurn(game, 0, a.id), b.id);
  assert.throws(() => setAward(game, 0, a.id, 'title'), /not this contestant’s turn/);
  setAward(game, 0, b.id, 'title');
  assert.equal(currentTurn(game).id, b.id);
  assert.equal(passTurn(game, 0, b.id), null);
  assert.equal(currentTurn(game), null);
  assert.throws(() => passTurn(game, 0, b.id), /not this contestant’s turn/);

  nextRound(game, ['x', 'y']);
  assert.equal(currentTurn(game).id, b.id);
  assert.deepEqual(game.rounds[1].out, []);
});

test('resolveGuess awards correct answers and advances after every single guess', () => {
  const game = createGame();
  const a = createContestant('A');
  const b = createContestant('B');
  addContestant(game, a);
  addContestant(game, b);
  nextRound(game, ['x']);

  assert.deepEqual(resolveGuess(game, 0, a.id, 'artist', true), { correct: true, nextTurnId: b.id });
  assert.equal(getAward(game.rounds[0], a.id, 'artist'), true);
  assert.deepEqual(resolveGuess(game, 0, b.id, null, false), { correct: false, nextTurnId: null });
  assert.equal(getAward(game.rounds[0], b.id, 'title'), false);
  assert.deepEqual(game.rounds[0].out, [a.id, b.id]);
  assert.throws(() => resolveGuess(game, 0, b.id, null, true), /must identify a category/);
  assert.throws(() => resolveGuess(game, 0, b.id, 'album', false), /Unknown category/);
});

test("I'm Steve gives everyone a first attempt, then rotates among correct contestants", () => {
  const game = createGame({ mode: 'im-steve' });
  const a = createContestant('A');
  const b = createContestant('B');
  const c = createContestant('C');
  for (const contestant of [a, b, c]) addContestant(game, contestant);
  nextRound(game, ['x']);

  assert.deepEqual(resolveManualTurn(game, 0, a.id, 'artist'), {
    correct: true, nextTurnId: b.id, boardActive: false,
  });
  assert.deepEqual(resolveManualTurn(game, 0, b.id, 'title'), {
    correct: true, nextTurnId: c.id, boardActive: false,
  });
  assert.deepEqual(resolveManualTurn(game, 0, c.id), {
    correct: false, nextTurnId: a.id, boardActive: true,
  });

  assert.deepEqual(resolveManualTurn(game, 0, a.id), {
    correct: false, nextTurnId: b.id, boardActive: true,
  });
  assert.deepEqual(resolveManualTurn(game, 0, b.id, 'year'), {
    correct: true, nextTurnId: null, boardActive: true,
  });
  assert.deepEqual(game.rounds[0].out, [c.id, a.id]);
  assert.equal(currentTurn(game), null);
});

test("I'm Steve ends when every first attempt is wrong", () => {
  const game = createGame({ mode: 'im-steve' });
  const a = createContestant('A');
  const b = createContestant('B');
  addContestant(game, a);
  addContestant(game, b);
  nextRound(game, ['x']);

  resolveManualTurn(game, 0, a.id);
  assert.equal(currentTurn(game).id, b.id);
  assert.deepEqual(resolveManualTurn(game, 0, b.id), {
    correct: false, nextTurnId: null, boardActive: true,
  });
  assert.deepEqual(game.rounds[0].out, [a.id, b.id]);
});

test("I'm Steve lets a lone successful player keep running the board", () => {
  const game = createGame({ mode: 'im-steve' });
  const contestants = ['A', 'B', 'C', 'D'].map((name) => createContestant(name));
  contestants.forEach((contestant) => addContestant(game, contestant));
  nextRound(game, ['x']);

  resolveManualTurn(game, 0, contestants[0].id, 'artist');
  resolveManualTurn(game, 0, contestants[1].id);
  resolveManualTurn(game, 0, contestants[2].id);
  resolveManualTurn(game, 0, contestants[3].id);
  assert.equal(currentTurn(game).id, contestants[0].id);
  assert.equal(game.rounds[0].boardActive, true);

  assert.equal(resolveManualTurn(game, 0, contestants[0].id, 'title').nextTurnId, contestants[0].id);
  assert.equal(resolveManualTurn(game, 0, contestants[0].id, 'year').nextTurnId, null);
});

test('removing a contestant and resetting scores', () => {
  const game = createGame({ targetScore: 12 });
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
  assert.equal(game.targetScore, 12);
});

test('games survive serialization', () => {
  const game = createGame({ playlistId: ID, targetScore: 18 });
  const a = createContestant('A', ['x']);
  addContestant(game, a);
  nextRound(game, ['t1', 't2']);
  setAward(game, 0, a.id, 'artist');
  game.rounds[0].turnDeadlineAt = Date.now() + 30_000;
  passTurn(game, 0, a.id);
  const restored = deserializeGame(serializeGame(game));
  assert.deepEqual(restored, game);
  assert.equal(currentTurn(restored), null);
  assert.equal(restored.targetScore, 18);
  assert.equal(createGame().targetScore, DEFAULT_TARGET_SCORE);
  assert.equal(deserializeGame('{"contestants":[],"rounds":[]}').targetScore, DEFAULT_TARGET_SCORE);
  assert.equal(deserializeGame('not json'), null);
  assert.equal(deserializeGame('{}'), null);
  const oldGame = deserializeGame(JSON.stringify({
    contestants: [a],
    rounds: [{ trackId: 'legacy', awards: {} }],
  }));
  assert.equal(oldGame.rounds[0].turnDeadlineAt, null);
  assert.equal(oldGame.rounds[0].phase, null);
});
