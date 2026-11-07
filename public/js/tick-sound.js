// Countdown ticks for I'm Steve's "Put the clock on em", synthesized with Web Audio (no sound files).
// Browsers only allow audio after a user gesture, so call unlockTicks() from the button's click.

let context = null;

function audio() {
  if (!context) {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return null;
    context = new AudioContextClass();
  }
  if (context.state === 'suspended') context.resume().catch(() => {});
  return context;
}

export function unlockTicks() {
  audio();
}

/** One short beep: `frequency` Hz, `duration` s, peak `volume` (0-1), `type` oscillator wave. */
function beep({ frequency, duration, volume, type = 'square' }) {
  const ctx = audio();
  if (!ctx) return;
  const start = ctx.currentTime;
  const oscillator = ctx.createOscillator();
  const gain = ctx.createGain();
  oscillator.type = type;
  oscillator.frequency.setValueAtTime(frequency, start);
  // Fast attack + exponential decay so it clicks like a clock instead of droning.
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(volume, start + 0.005);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
  oscillator.connect(gain).connect(ctx.destination);
  oscillator.start(start);
  oscillator.stop(start + duration + 0.02);
}

/** A tick for each second shown; the last three are higher and louder. */
export function playTick(secondsShown) {
  if (secondsShown <= 3) beep({ frequency: 1320, duration: 0.09, volume: 0.35 });
  else beep({ frequency: 880, duration: 0.05, volume: 0.2 });
}

/** Time's up: a low buzz. */
export function playBuzzer() {
  beep({ frequency: 180, duration: 0.7, volume: 0.4, type: 'sawtooth' });
}
