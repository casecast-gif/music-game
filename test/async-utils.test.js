import { test } from 'node:test';
import assert from 'node:assert/strict';
import { settleWithin } from '../public/js/async-utils.js';

// Regression: a No Steve round must open guessing even when Spotify playback
// fails to confirm or never answers (the guess form used to vanish).

test('settleWithin reports a fulfilled promise', async () => {
  assert.deepEqual(await settleWithin(Promise.resolve(42), 1000), { status: 'fulfilled', value: 42 });
});

test('settleWithin turns a rejection into a result instead of throwing', async () => {
  const error = new Error('Spotify accepted the play request, but never reported the game track as playing.');
  const outcome = await settleWithin(Promise.reject(error), 1000);
  assert.equal(outcome.status, 'rejected');
  assert.equal(outcome.reason, error);
});

test('settleWithin gives up on a promise that never settles', async () => {
  const started = Date.now();
  const outcome = await settleWithin(new Promise(() => {}), 30);
  assert.deepEqual(outcome, { status: 'timeout' });
  assert.ok(Date.now() - started < 1000);
});

test('settleWithin accepts plain values', async () => {
  assert.deepEqual(await settleWithin(undefined, 1000), { status: 'fulfilled', value: undefined });
});
