export const VOICE_LISTEN_MS = 15_000;
export const VOICE_ALTERNATIVES = 5;
// Browsers end a continuous session after a few seconds of silence; restart until the
// listening window closes. The cap only guards against a recognizer that ends instantly.
const MAX_RESTARTS = 30;
const RESTART_DELAY_MS = 150;
const MAX_NETWORK_ERRORS = 2;

export function voiceErrorMessage(code) {
  switch (code) {
    case 'not-allowed':
    case 'service-not-allowed':
      return 'Microphone access is blocked. Allow the microphone for this site (lock icon in the address bar), then try Speak guess again. Type your guess instead for now.';
    case 'audio-capture':
      return 'No microphone was found, or another app is using it. Check the microphone, then try again. Type your guess instead for now.';
    case 'network':
      return 'Voice recognition lost its internet connection (the browser sends speech to an online service). Type your guess instead.';
    case 'language-not-supported':
      return 'This browser cannot recognize English speech. Type your guess instead.';
    default:
      return `Voice recognition failed (${code}). Type your guess instead.`;
  }
}

function alternativesOf(result) {
  return Array.from(result ?? [])
    .map((alternative) => alternative?.transcript?.trim())
    .filter(Boolean);
}

export class VoiceGuessSession {
  constructor(Recognition, {
    lowerVolume, onTranscript, onListening = () => {}, onListeningEnd, onNoSpeech, onError, onVolumeError,
    pickAlternative = (alternatives) => alternatives[0], durationMs = VOICE_LISTEN_MS,
  }) {
    this.recognition = new Recognition();
    this.recognition.lang = 'en-US';
    this.recognition.continuous = true;
    this.recognition.interimResults = true;
    this.recognition.maxAlternatives = VOICE_ALTERNATIVES;
    this.lowerVolume = lowerVolume;
    this.onTranscript = onTranscript;
    this.onListening = onListening;
    this.onListeningEnd = onListeningEnd;
    this.onNoSpeech = onNoSpeech;
    this.onError = onError;
    this.onVolumeError = onVolumeError;
    this.pickAlternative = pickAlternative;
    this.durationMs = durationMs;
    this.closed = false;
    this.captureEnded = false;
    this.listening = false;
    this.restarts = 0;
    this.networkErrors = 0;
    this.prefix = '';
    this.transcript = '';
    this.ready = Promise.resolve();
    this.restoreVolume = null;
    this.timer = null;
    this.restartTimer = null;
    this.stopping = null;
  }

  get isCapturing() {
    return !this.closed && !this.captureEnded;
  }

  // Starts the microphone immediately (so the first words are not lost while Spotify
  // lowers the volume) and returns a promise that settles once the volume change is done.
  start() {
    try {
      this.listen();
    } catch (error) {
      this.ready = Promise.resolve();
      return Promise.reject(error);
    }
    const operation = this.lower();
    this.ready = operation.catch(() => {});
    return operation;
  }

  listen() {
    this.deadline = Date.now() + this.durationMs;
    const recognition = this.recognition;
    recognition.onstart = () => {
      if (!this.isCapturing || this.listening) return;
      this.listening = true;
      this.onListening();
    };
    recognition.onresult = (event) => {
      if (this.closed) return;
      const text = Array.from(event.results ?? [])
        .map((result) => {
          const alternatives = alternativesOf(result);
          if (alternatives.length <= 1) return alternatives[0];
          return this.pickAlternative(alternatives) ?? alternatives[0];
        })
        .filter(Boolean)
        .join(' ');
      this.transcript = [this.prefix, text].filter(Boolean).join(' ');
      if (this.transcript) this.onTranscript(this.transcript);
    };
    recognition.onerror = (event) => {
      if (this.closed) return;
      const code = event.error;
      if (code === 'no-speech') {
        if (!this.captureEnded) this.onNoSpeech();
        return;
      }
      // 'aborted' follows our own restarts; one network blip is retried by the onend restart.
      if (code === 'aborted') return;
      if (code === 'network' && ++this.networkErrors < MAX_NETWORK_ERRORS) return;
      this.fail(new Error(voiceErrorMessage(code)));
    };
    recognition.onend = () => {
      if (!this.isCapturing) return;
      if (Date.now() < this.deadline && this.restarts < MAX_RESTARTS) {
        this.restarts += 1;
        this.prefix = this.transcript;
        this.restartTimer = setTimeout(() => {
          this.restartTimer = null;
          if (!this.isCapturing) return;
          try {
            recognition.start();
          } catch (error) {
            this.fail(error);
          }
        }, RESTART_DELAY_MS);
      } else {
        this.endCapture();
      }
    };
    recognition.start();
    this.timer = setTimeout(() => this.endCapture(), this.durationMs);
  }

  async lower() {
    try {
      const restore = await this.lowerVolume();
      if (restore) this.restoreVolume = restore;
    } catch (error) {
      if (this.closed) return;
      this.onVolumeError(error);
    }
  }

  fail(error) {
    if (this.closed) return;
    this.captureEnded = true;
    clearTimeout(this.timer);
    clearTimeout(this.restartTimer);
    this.timer = null;
    this.restartTimer = null;
    this.onError(error);
  }

  endCapture() {
    if (this.closed || this.captureEnded) return;
    this.captureEnded = true;
    clearTimeout(this.timer);
    clearTimeout(this.restartTimer);
    this.timer = null;
    this.restartTimer = null;
    this.recognition.stop();
    this.onListeningEnd(this.transcript);
  }

  stop() {
    if (this.stopping) return this.stopping;
    this.closed = true;
    clearTimeout(this.timer);
    clearTimeout(this.restartTimer);
    this.recognition.onstart = null;
    this.recognition.onresult = null;
    this.recognition.onerror = null;
    this.recognition.onend = null;
    this.recognition.abort();
    this.stopping = (async () => {
      await this.ready;
      if (this.restoreVolume) await this.restoreVolume();
    })();
    return this.stopping;
  }
}
