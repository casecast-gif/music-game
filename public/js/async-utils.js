/**
 * Waits for `promise` for at most `ms` milliseconds and never rejects.
 * Resolves to { status: 'fulfilled', value }, { status: 'rejected', reason } or
 * { status: 'timeout' }. Used so slow or failing side effects (e.g. Spotify
 * playback) can never stall a game state transition.
 */
export function settleWithin(promise, ms) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ status: 'timeout' }), ms);
  });
  const settled = Promise.resolve(promise).then(
    (value) => ({ status: 'fulfilled', value }),
    (reason) => ({ status: 'rejected', reason }),
  );
  return Promise.race([settled, timeout]).finally(() => clearTimeout(timer));
}
