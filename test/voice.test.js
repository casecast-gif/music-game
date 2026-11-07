import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VoiceGuessSession, VOICE_LISTEN_MS, VOICE_ALTERNATIVES, voiceErrorMessage } from '../public/js/voice.js';

class Recognition {
  starts = 0;
  stops = 0;
  aborts = 0;
  start() { this.starts += 1; }
  stop() { this.stops += 1; }
  abort() { this.aborts += 1; }
}

function installClock(t) {
  const previous = { now: Date.now, setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout };
  let now = 1000;
  let nextId = 0;
  const timers = new Map();
  Date.now = () => now;
  globalThis.setTimeout = (callback, delay) => {
    timers.set(++nextId, { at: now + delay, callback });
    return nextId;
  };
  globalThis.clearTimeout = (id) => timers.delete(id);
  t.after(() => {
    Date.now = previous.now;
    globalThis.setTimeout = previous.setTimeout;
    globalThis.clearTimeout = previous.clearTimeout;
  });
  return async (ms) => {
    const end = now + ms;
    for (;;) {
      const next = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      if (!next || next[1].at > end) break;
      now = next[1].at;
      timers.delete(next[0]);
      next[1].callback();
      await Promise.resolve();
    }
    now = end;
  };
}

function fixture(options = {}) {
  const events = { transcripts: [], ends: [], errors: [], volumeErrors: [], noSpeech: 0, restores: 0, volume: 0.8 };
  const session = new VoiceGuessSession(Recognition, {
    lowerVolume: async () => {
      events.volume = 0.16;
      return async () => { events.volume = 0.8; events.restores += 1; };
    },
    onTranscript: (text) => events.transcripts.push(text),
    onListeningEnd: (text) => events.ends.push(text),
    onNoSpeech: () => { events.noSpeech += 1; },
    onError: (error) => { events.errors.push(error); void session.stop(); },
    onVolumeError: (error) => events.volumeErrors.push(error),
    ...options,
  });
  return { session, events, recognition: session.recognition };
}

test('voice capture lasts up to 15 seconds and keeps music lowered until the turn ends', async (t) => {
  const tick = installClock(t);
  const { session, events, recognition } = fixture();
  assert.equal(VOICE_LISTEN_MS, 15_000);
  await session.start();
  assert.equal(recognition.continuous, true);
  assert.equal(recognition.interimResults, true);
  recognition.onresult({ results: [[{ transcript: 'Michael' }], [{ transcript: 'Jackson' }]] });
  assert.deepEqual(events.transcripts, ['Michael Jackson']);
  await tick(14_999);
  assert.equal(session.isCapturing, true);
  assert.equal(recognition.stops, 0);
  await tick(1);
  assert.equal(session.isCapturing, false);
  assert.equal(recognition.stops, 1);
  assert.deepEqual(events.ends, ['Michael Jackson']);
  assert.equal(events.volume, 0.16, 'music stays quiet while the transcript is reviewed');
  await session.stop();
  await session.stop();
  assert.equal(events.volume, 0.8);
  assert.equal(events.restores, 1);
});

test('silences that end browser recognition restart until the listening window closes', async (t) => {
  const tick = installClock(t);
  const { session, events, recognition } = fixture();
  await session.start();
  recognition.onresult({ results: [[{ transcript: 'The' }]] });
  for (let i = 0; i < 5; i++) {
    recognition.onend();
    await tick(150);
  }
  assert.equal(recognition.starts, 6, 'long thinking pauses do not cut the player off');
  recognition.onresult({ results: [[{ transcript: 'Beatles' }]] });
  assert.equal(events.transcripts.at(-1), 'The Beatles');
  assert.equal(session.isCapturing, true);
  await tick(20_000);
  recognition.onend();
  await tick(20_000);
  assert.equal(recognition.starts, 6, 'no restart after the window closes');
  assert.equal(session.isCapturing, false);
  assert.deepEqual(events.ends, ['The Beatles']);
  assert.equal(events.volume, 0.16);
  await session.stop();
});

test('a recognizer that ends instantly cannot restart forever', async (t) => {
  const tick = installClock(t);
  const { session, recognition } = fixture({ durationMs: 10 * 60_000 });
  await session.start();
  for (let i = 0; i < 100 && session.isCapturing; i++) {
    recognition.onend();
    await tick(150);
  }
  assert.equal(session.isCapturing, false);
  assert.ok(recognition.starts <= 31);
  await session.stop();
});

test('the microphone starts before the volume change finishes', async () => {
  let finishLowering;
  const { session, events, recognition } = fixture({
    lowerVolume: () => new Promise((resolve) => { finishLowering = resolve; }),
  });
  const start = session.start();
  assert.equal(recognition.starts, 1, 'first words are not lost while Spotify lowers the volume');
  recognition.onresult({ results: [[{ transcript: 'Adele' }]] });
  assert.deepEqual(events.transcripts, ['Adele']);
  finishLowering(async () => { events.restores += 1; });
  await start;
  await session.stop();
  assert.equal(events.restores, 1);
});

test('onListening fires once when the browser starts listening, not on restarts', async (t) => {
  const tick = installClock(t);
  let listening = 0;
  const { session, recognition } = fixture({ onListening: () => { listening += 1; } });
  await session.start();
  recognition.onstart();
  recognition.onend();
  await tick(150);
  recognition.onstart();
  assert.equal(listening, 1);
  await session.stop();
});

test('alternatives are offered to pickAlternative so a matching hearing wins', async () => {
  const seen = [];
  const { session, events, recognition } = fixture({
    pickAlternative: (alternatives) => { seen.push(alternatives); return alternatives.find((a) => a === 'Hozier'); },
  });
  assert.equal(recognition.maxAlternatives, VOICE_ALTERNATIVES);
  await session.start();
  recognition.onresult({ results: [[{ transcript: 'hosier ' }, { transcript: 'Hozier' }, { transcript: '' }]] });
  assert.deepEqual(seen, [['hosier', 'Hozier']]);
  assert.deepEqual(events.transcripts, ['Hozier']);
  recognition.onresult({ results: [[{ transcript: 'shade' }, { transcript: 'shady' }]] });
  assert.equal(events.transcripts.at(-1), 'shade', 'falls back to the top hearing when none match');
  await session.stop();
});

test('turn cancellation during a pending volume change aborts the microphone and restores volume', async () => {
  let finishLowering;
  let restores = 0;
  const { session, recognition } = fixture({
    lowerVolume: () => new Promise((resolve) => { finishLowering = resolve; }),
  });
  const start = session.start();
  const stop = session.stop();
  finishLowering(async () => { restores += 1; });
  await Promise.all([start, stop]);
  assert.equal(recognition.aborts, 1);
  assert.equal(restores, 1);
});

test('a no-speech result is reported while the remaining listening window stays available', async (t) => {
  const tick = installClock(t);
  const { session, events, recognition } = fixture();
  await session.start();
  recognition.onerror({ error: 'no-speech' });
  recognition.onend();
  await tick(150);
  assert.equal(events.noSpeech, 1);
  assert.deepEqual(events.errors, []);
  assert.equal(recognition.starts, 2);
  assert.equal(session.isCapturing, true);
  assert.equal(events.volume, 0.16);
  await session.stop();
});

test('microphone startup failures are surfaced without touching the volume', async () => {
  const { session, events, recognition } = fixture();
  recognition.start = () => { throw new Error('Microphone unavailable'); };
  await assert.rejects(session.start(), /Microphone unavailable/);
  await session.stop();
  assert.equal(events.restores, 0);
  assert.equal(events.volume, 0.8);
});

test('recognition errors stop capture, detach callbacks, and restore volume', async () => {
  const { session, events, recognition } = fixture();
  await session.start();
  recognition.onerror({ error: 'not-allowed' });
  await session.stop();
  assert.match(events.errors[0].message, /Microphone access is blocked/);
  assert.equal(events.restores, 1);
  assert.equal(recognition.onresult, null);
  assert.equal(recognition.onend, null);
});

test('unsupported volume control is explicitly reported without preventing voice capture', async () => {
  const { session, events, recognition } = fixture({
    lowerVolume: async () => { throw new Error('Volume control unsupported'); },
  });
  await session.start();
  assert.equal(events.volumeErrors[0].message, 'Volume control unsupported');
  assert.equal(recognition.starts, 1);
  await session.stop();
  assert.equal(events.restores, 0);
});

test('volume restoration failures are surfaced and never automatically retried', async () => {
  let restores = 0;
  const { session } = fixture({
    lowerVolume: async () => async () => { restores += 1; throw new Error('Spotify cooldown'); },
  });
  await session.start();
  const stop = session.stop();
  await assert.rejects(stop, /Spotify cooldown/);
  assert.equal(session.stop(), stop);
  assert.equal(restores, 1);
});

test('late speech results and queued restarts cannot change a different turn', async (t) => {
  const tick = installClock(t);
  const { session, recognition, events } = fixture();
  await session.start();
  const lateResult = recognition.onresult;
  recognition.onend();
  await session.stop();
  await tick(20_000);
  lateResult({ results: [[{ transcript: 'Late guess' }]] });
  assert.deepEqual(events.transcripts, []);
  assert.equal(recognition.starts, 1);
  assert.equal(events.restores, 1);
});

test('aborted and a single network blip keep listening; a second network error stops', async (t) => {
  const tick = installClock(t);
  const { session, events, recognition } = fixture();
  await session.start();
  recognition.onerror({ error: 'aborted' });
  recognition.onerror({ error: 'network' });
  recognition.onend();
  await tick(150);
  assert.deepEqual(events.errors, []);
  assert.equal(recognition.starts, 2);
  recognition.onerror({ error: 'network' });
  assert.match(events.errors[0].message, /internet connection/);
  assert.equal(events.restores, 0);
  await session.stop();
  assert.equal(events.restores, 1);
});

test('each recognition error code gets a specific, actionable message', () => {
  assert.match(voiceErrorMessage('service-not-allowed'), /Allow the microphone/);
  assert.match(voiceErrorMessage('audio-capture'), /No microphone was found/);
  assert.match(voiceErrorMessage('language-not-supported'), /English/);
  assert.match(voiceErrorMessage('bad-grammar'), /\(bad-grammar\)/);
  for (const code of ['not-allowed', 'audio-capture', 'network', 'weird']) {
    assert.match(voiceErrorMessage(code), /Type your guess instead/);
  }
});
