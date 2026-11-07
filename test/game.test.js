import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addContestant,
  createContestant,
  createGame,
  DEFAULT_TARGET_SCORE,
  DEFAULT_TIMINGS,
  TIMING_LIMITS,
  normalizeTimings,
  updateTimings,
  clockUrgency,
  guessTimeLimitSeconds,
  secondsLeft,
  upNextTurn,
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
  revealedAnswers,
  revealAnswer,
  revealAllAnswers,
  allAnswersRevealed,
  presentationSnapshot,
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

test('turn clock rounds up and turns amber at 10 s, red at 5 s', () => {
  assert.equal(secondsLeft(20_000, 0), 20);
  assert.equal(secondsLeft(20_000, 19_001), 1);
  assert.equal(secondsLeft(20_000, 20_000), 0);
  assert.equal(secondsLeft(20_000, 25_000), 0);
  assert.equal(clockUrgency(null), 'calm');
  assert.equal(clockUrgency(11), 'calm');
  assert.equal(clockUrgency(10), 'warn');
  assert.equal(clockUrgency(6), 'warn');
  assert.equal(clockUrgency(5), 'danger');
  assert.equal(clockUrgency(0), 'danger');
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

function rotationGame(mode, names = ['A', 'B', 'C']) {
  const game = createGame({ mode });
  const players = names.map((name) => createContestant(name));
  for (const player of players) addContestant(game, player);
  return { game, players };
}

function starters(game, count) {
  const names = [];
  for (let i = 0; i < count; i++) {
    nextRound(game, ['s1', 's2', 's3', 's4', 's5', 's6', 's7']);
    names.push(currentTurn(game).name);
  }
  return names;
}

for (const mode of ['no-steve', 'im-steve']) {
  test(`${mode}: each song starts with the next player and loops back to the first`, () => {
    const { game } = rotationGame(mode);
    assert.deepEqual(starters(game, 7), ['A', 'B', 'C', 'A', 'B', 'C', 'A']);
  });

  test(`${mode}: the starter rotation continues through resetScores and a save/restore`, () => {
    const { game } = rotationGame(mode);
    assert.deepEqual(starters(game, 2), ['A', 'B']);
    resetScores(game); // new game
    assert.deepEqual(starters(game, 1), ['C']);
    const restored = deserializeGame(serializeGame(game));
    resetScores(restored);
    assert.deepEqual(starters(restored, 2), ['A', 'B']);
  });

  test(`${mode}: within a song, first attempts go in order from the starter, then correct players cycle`, () => {
    const { game, players: [a, b, c] } = rotationGame(mode);
    starters(game, 1); // A started song 1
    nextRound(game, ['s1', 's2', 's3', 's4']); // B starts song 2
    assert.equal(currentTurn(game).id, b.id);
    resolveManualTurn(game, 1, b.id, 'artist'); // B correct: stays in
    assert.equal(currentTurn(game).id, c.id);
    resolveManualTurn(game, 1, c.id, null); // C wrong: out
    assert.equal(currentTurn(game).id, a.id);
    resolveManualTurn(game, 1, a.id, null); // A wrong: out
    assert.equal(currentTurn(game).id, b.id, 'lone correct player keeps guessing');
    resolveManualTurn(game, 1, b.id, 'title');
    assert.equal(currentTurn(game).id, b.id);
    resolveManualTurn(game, 1, b.id, 'year');
    assert.equal(currentTurn(game), null, 'song ends when all elements are guessed');
    nextRound(game, ['s1', 's2', 's3', 's4']);
    assert.equal(currentTurn(game).id, c.id);
  });
}

test('adding and removing players keeps the starter rotation sensible', () => {
  const { game, players: [, b] } = rotationGame('no-steve');
  assert.deepEqual(starters(game, 1), ['A']);
  removeContestant(game, b.id); // B was due next: whoever followed B (C) starts instead
  assert.deepEqual(starters(game, 2), ['C', 'A']);
  addContestant(game, createContestant('D')); // joins the end of the order
  assert.deepEqual(starters(game, 3), ['C', 'D', 'A']);
  const { game: last, players: [, , c] } = rotationGame('no-steve');
  starters(last, 2); // C is next
  removeContestant(last, c.id); // wraps around to A
  assert.deepEqual(starters(last, 1), ['A']);
});

test('saves from before the starter pointer continue the old rotation', () => {
  const a = createContestant('A');
  const b = createContestant('B');
  const c = createContestant('C');
  const restored = deserializeGame(JSON.stringify({
    mode: 'no-steve',
    contestants: [a, b, c],
    rounds: [{ trackId: 'one', awards: {} }, { trackId: 'two', awards: {} }],
  }));
  assert.equal(restored.nextStarterId, c.id);
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

test('No Steve keeps correct players eligible after other players miss', () => {
  const game = createGame();
  const a = createContestant('A');
  const b = createContestant('B');
  addContestant(game, a);
  addContestant(game, b);
  nextRound(game, ['x']);

  assert.deepEqual(resolveGuess(game, 0, a.id, 'artist', true), { correct: true, nextTurnId: b.id });
  assert.equal(getAward(game.rounds[0], a.id, 'artist'), true);
  assert.deepEqual(resolveGuess(game, 0, b.id, null, false), { correct: false, nextTurnId: a.id });
  assert.equal(getAward(game.rounds[0], b.id, 'title'), false);
  assert.deepEqual(game.rounds[0].out, [b.id]);
  assert.deepEqual(resolveGuess(game, 0, a.id, 'title', true), { correct: true, nextTurnId: a.id });
  assert.deepEqual(resolveGuess(game, 0, a.id, 'year', true), { correct: true, nextTurnId: null });
  assert.equal(roundPoints(game.rounds[0], a.id), 3);
  assert.throws(() => resolveGuess(game, 0, b.id, null, true), /must identify a category/);
  assert.throws(() => resolveGuess(game, 0, b.id, 'album', false), /Unknown category/);
});

test('No Steve circles back after two correct categories and credits each player separately', () => {
  const game = createGame();
  const a = createContestant('A');
  const b = createContestant('B');
  for (const contestant of [a, b]) addContestant(game, contestant);
  nextRound(game, ['x']);
  const round = currentRound(game);
  assert.equal(guessTimeLimitSeconds(round), 60);
  resolveGuess(game, 0, a.id, 'title', true);
  assert.equal(guessTimeLimitSeconds(round), 20);
  resolveGuess(game, 0, b.id, 'artist', true);
  assert.equal(currentTurn(game).id, a.id);
  assert.deepEqual(scoredCategories(round, game.contestants), ['artist', 'title']);
  assert.deepEqual(round.out, []);
  assert.equal(round.boardActive, true);
  assert.equal(guessTimeLimitSeconds(round), 20);
  assert.equal(getAward(round, a.id, 'title'), true);
  assert.equal(getAward(round, b.id, 'title'), false);
  assert.equal(getAward(round, b.id, 'artist'), true);
  assert.equal(getAward(round, a.id, 'artist'), false);
  resolveGuess(game, 0, a.id, 'year', true);
  assert.equal(currentTurn(game), null);
  assert.equal(roundPoints(round, a.id), 2);
  assert.equal(roundPoints(round, b.id), 1);
  const rows = standings(game);
  assert.deepEqual(rows[0].byCategory, { artist: 0, title: 1, year: 1 });
  assert.deepEqual(rows[1].byCategory, { artist: 1, title: 0, year: 0 });
});

test('No Steve runners rotate after a miss and stop only when everyone is out', () => {
  const game = createGame();
  const a = createContestant('A');
  const b = createContestant('B');
  for (const contestant of [a, b]) addContestant(game, contestant);
  nextRound(game, ['x']);
  resolveGuess(game, 0, a.id, 'title', true);
  resolveGuess(game, 0, b.id, 'artist', true);
  resolveGuess(game, 0, a.id, 'year', false);
  assert.equal(currentTurn(game).id, b.id);
  assert.equal(getAward(currentRound(game), a.id, 'year'), false);
  resolveGuess(game, 0, b.id, null, false);
  assert.equal(currentTurn(game), null);
  assert.deepEqual(currentRound(game).out, [a.id, b.id]);
  assert.deepEqual(scoredCategories(currentRound(game), game.contestants), ['artist', 'title']);
  assert.equal(roundPoints(currentRound(game), a.id), 1);
  assert.equal(roundPoints(currentRound(game), b.id), 1);
});

test('No Steve waits for all first attempts before returning to successful players', () => {
  const game = createGame();
  const players = ['A', 'B', 'C', 'D'].map((name) => createContestant(name));
  players.forEach((player) => addContestant(game, player));
  nextRound(game, ['x']);
  resolveGuess(game, 0, players[0].id, 'artist', true);
  resolveGuess(game, 0, players[1].id, null, false);
  assert.equal(currentTurn(game).id, players[2].id);
  resolveGuess(game, 0, players[2].id, null, false);
  assert.equal(currentTurn(game).id, players[3].id);
  resolveGuess(game, 0, players[3].id, null, false);
  assert.equal(currentTurn(game).id, players[0].id);
  resolveGuess(game, 0, players[0].id, null, false);
  assert.equal(currentTurn(game), null);
});

test('No Steve preserves runner eligibility and category awards when a game is resumed', () => {
  const game = createGame();
  const a = createContestant('A');
  const b = createContestant('B');
  for (const contestant of [a, b]) addContestant(game, contestant);
  nextRound(game, ['x']);
  resolveGuess(game, 0, a.id, 'title', true);
  resolveGuess(game, 0, b.id, 'artist', true);
  const restored = deserializeGame(serializeGame(game));
  assert.equal(currentTurn(restored).id, a.id);
  assert.equal(currentRound(restored).boardActive, true);
  assert.equal(roundPoints(currentRound(restored), a.id), 1);
  assert.equal(roundPoints(currentRound(restored), b.id), 1);
  resolveGuess(restored, 0, a.id, 'year', true);
  assert.equal(currentTurn(restored), null);
  assert.equal(roundPoints(currentRound(restored), a.id), 2);
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

test('timings default to the classic No Steve values', () => {
  assert.deepEqual(DEFAULT_TIMINGS, {
    firstGuessSeconds: 60,
    followupGuessSeconds: 20,
    revealSeconds: 6,
    voiceSeconds: 15,
    playbackWaitSeconds: 5,
  });
  assert.deepEqual(createGame().timings, DEFAULT_TIMINGS);
  assert.notEqual(createGame().timings, DEFAULT_TIMINGS, 'each game gets its own copy');
});

test('normalizeTimings clamps, rounds, accepts numeric strings and falls back on junk', () => {
  const timings = normalizeTimings({
    firstGuessSeconds: 1,
    followupGuessSeconds: 999,
    revealSeconds: '0',
    voiceSeconds: 12.6,
    playbackWaitSeconds: 'soon',
  });
  assert.equal(timings.firstGuessSeconds, TIMING_LIMITS.firstGuessSeconds.min);
  assert.equal(timings.followupGuessSeconds, TIMING_LIMITS.followupGuessSeconds.max);
  assert.equal(timings.revealSeconds, 0);
  assert.equal(timings.voiceSeconds, 13);
  assert.equal(timings.playbackWaitSeconds, 5);
  assert.deepEqual(normalizeTimings(null), DEFAULT_TIMINGS);
  assert.deepEqual(normalizeTimings({ revealSeconds: '', voiceSeconds: NaN, firstGuessSeconds: Infinity }), DEFAULT_TIMINGS);
});

test('guessTimeLimitSeconds reads the game timings', () => {
  const game = createGame({ timings: { firstGuessSeconds: 45, followupGuessSeconds: 10 } });
  const a = createContestant('A');
  const b = createContestant('B');
  addContestant(game, a);
  addContestant(game, b);
  nextRound(game, ['x']);
  const round = currentRound(game);
  assert.equal(guessTimeLimitSeconds(round, game.timings), 45);
  passTurn(game, 0, a.id);
  assert.equal(guessTimeLimitSeconds(round, game.timings), 10);
  assert.equal(guessTimeLimitSeconds(round), 20, 'no timings means defaults');
});

test('updateTimings merges partial changes mid-game and survives save/restore', () => {
  const game = createGame();
  addContestant(game, createContestant('A'));
  nextRound(game, ['x']);
  updateTimings(game, { revealSeconds: 12, followupGuessSeconds: '30' });
  assert.equal(game.timings.revealSeconds, 12);
  assert.equal(game.timings.followupGuessSeconds, 30);
  assert.equal(game.timings.firstGuessSeconds, 60);
  updateTimings(game, { voiceSeconds: 500 });
  assert.equal(game.timings.voiceSeconds, 30);
  currentRound(game).turnSeconds = 60;
  const restored = deserializeGame(serializeGame(game));
  assert.deepEqual(restored.timings, game.timings);
  assert.equal(restored.rounds[0].turnSeconds, 60);
});

test('older saves without timings restore with defaults', () => {
  const restored = deserializeGame(JSON.stringify({ contestants: [], rounds: [], mode: 'no-steve' }));
  assert.deepEqual(restored.timings, DEFAULT_TIMINGS);
  const tampered = deserializeGame(JSON.stringify({ contestants: [], rounds: [], timings: { firstGuessSeconds: -4, revealSeconds: 'x' } }));
  assert.equal(tampered.timings.firstGuessSeconds, 5);
  assert.equal(tampered.timings.revealSeconds, 6);
});

const SONG = { artist: 'Queen', title: 'Bohemian Rhapsody', year: '1975', image: 'cover.jpg', album: 'A Night at the Opera' };

function steveGame() {
  const game = createGame({ mode: 'im-steve', targetScore: 10 });
  addContestant(game, createContestant('Ann', [], 'a'));
  addContestant(game, createContestant('Bob', ['B1', 'B2'], 'b'));
  nextRound(game, ['x']);
  return game;
}

test('new rounds start with every answer hidden', () => {
  const game = steveGame();
  assert.deepEqual(currentRound(game).revealed, { artist: false, title: false, year: false });
  assert.equal(allAnswersRevealed(game), false);
});

test('revealed answers persist on the round through save/restore', () => {
  const game = steveGame();
  revealAnswer(game, 'year');
  const restored = deserializeGame(serializeGame(game));
  assert.deepEqual(restored.rounds[0].revealed, { artist: false, title: false, year: true });
  revealAllAnswers(restored);
  assert.equal(allAnswersRevealed(restored), true);
  assert.throws(() => revealAnswer(game, 'album'), /Unknown category/);
});

test('scored categories count as revealed; older saves and junk restore as hidden', () => {
  const game = steveGame();
  resolveManualTurn(game, 0, 'a', 'title');
  assert.deepEqual(revealedAnswers(game), { artist: false, title: true, year: false });
  const old = deserializeGame(JSON.stringify({ contestants: [], rounds: [{ trackId: 'x', awards: {} }] }));
  assert.deepEqual(old.rounds[0].revealed, { artist: false, title: false, year: false });
  const junk = deserializeGame(JSON.stringify({ contestants: [], rounds: [{ trackId: 'x', awards: {}, revealed: { artist: 'yes', year: true, extra: true } }] }));
  assert.deepEqual(junk.rounds[0].revealed, { artist: false, title: false, year: true });
});

test('presentationSnapshot only carries revealed answers to the TV', () => {
  const game = steveGame();
  let snap = presentationSnapshot(game, { answers: SONG, now: 1 });
  assert.deepEqual(snap.answers, { artist: null, title: null, year: null });
  assert.equal(snap.image, null);
  assert.equal(snap.album, null);
  assert.equal(JSON.stringify(snap).includes('Queen'), false);
  assert.equal(snap.turnName, 'Ann');
  assert.equal(snap.roundNumber, 1);

  revealAnswer(game, 'artist');
  snap = presentationSnapshot(game, { answers: SONG });
  assert.equal(snap.answers.artist, 'Queen');
  assert.equal(snap.answers.title, null);
  assert.equal(JSON.stringify(snap).includes('Rhapsody'), false);

  revealAllAnswers(game);
  snap = presentationSnapshot(game, { answers: SONG });
  assert.equal(snap.complete, true);
  assert.equal(snap.answers.year, '1975');
  assert.equal(snap.image, 'cover.jpg');
});

test('presentationSnapshot includes standings, live round state and the clock', () => {
  const game = steveGame();
  resolveManualTurn(game, 0, 'a', 'artist');
  currentRound(game).turnDeadlineAt = 5000;
  const snap = presentationSnapshot(game, { answers: SONG, phase: 'manual' });
  assert.equal(snap.phase, 'manual');
  assert.deepEqual(snap.standings.map((row) => [row.name, row.total, row.rank]), [['Ann', 1, 1], ['Bob', 0, 2]]);
  assert.deepEqual(snap.standings[1].members, ['B1', 'B2']);
  assert.deepEqual(snap.round.find((row) => row.name === 'Bob'), { name: 'Bob', points: 0, out: false, current: true });
  assert.equal(snap.clock, null, "I'm Steve never shows a clock");
  assert.equal(snap.upNextName, 'Ann');
  game.mode = 'no-steve';
  currentRound(game).turnSeconds = 20;
  assert.deepEqual(presentationSnapshot(game).clock, { deadlineAt: 5000, seconds: 20 });
  assert.equal(presentationSnapshot(createGame()).roundNumber, 0);
});

test('upNextTurn previews the next player without changing the round', () => {
  const game = createGame();
  for (const [name, id] of [['Ann', 'a'], ['Bob', 'b'], ['Cat', 'c']]) addContestant(game, createContestant(name, [], id));
  nextRound(game, ['x']);
  const first = currentTurn(game).id;
  const order = ['a', 'b', 'c'];
  const after = (id) => order[(order.indexOf(id) + 1) % 3];
  const before = JSON.stringify(game);
  assert.equal(upNextTurn(game).id, after(first));
  assert.equal(JSON.stringify(game), before, 'the real round is untouched');

  // First pass: the player after next misses too, so the starter's correct guess makes them the runner.
  resolveGuess(game, 0, first, 'artist', true);
  assert.equal(upNextTurn(game).id, after(after(first)));
  resolveGuess(game, 0, after(first), null, false);
  assert.equal(currentTurn(game).id, after(after(first)));
  assert.equal(upNextTurn(game).id, first, 'board runner comes back around');
  resolveGuess(game, 0, after(after(first)), null, false);
  assert.equal(currentTurn(game).id, first);
  assert.equal(upNextTurn(game), null, 'nobody is left if the runner misses');
  assert.equal(upNextTurn(createGame()), null);
});
