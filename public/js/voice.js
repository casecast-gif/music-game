export const VOICE_LISTEN_MS = 15_000;
const MAX_RESTARTS = 2;

export class VoiceGuessSession {
  constructor(Recognition, { lowerVolume, onTranscript, onListeningEnd, onNoSpeech, onError, onVolumeError, durationMs = VOICE_LISTEN_MS }) {
    this.recognition = new Recognition();
    this.recognition.lang = 'en-US';
    this.recognition.continuous = true;
    this.recognition.interimResults = true;
    this.recognition.maxAlternatives = 1;
    this.lowerVolume = lowerVolume;
    this.onTranscript = onTranscript;
    this.onListeningEnd = onListeningEnd;
    this.onNoSpeech = onNoSpeech;
    this.onError = onError;
    this.onVolumeError = onVolumeError;
    this.durationMs = durationMs;
    this.closed = false;
    this.captureEnded = false;
    this.restarts = 0;
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

  start() {
    const operation = this.prepare();
    this.ready = operation.catch(() => {});
    return operation;
  }

  async prepare() {
    try {
      this.restoreVolume = await this.lowerVolume();
    } catch (error) {
      if (this.closed) return;
      this.onVolumeError(error);
    }
    if (this.closed) return;
    this.deadline = Date.now() + this.durationMs;
    const recognition = this.recognition;
    recognition.onresult = (event) => {
      if (this.closed) return;
      const text = Array.from(event.results ?? [])
        .map((result) => result[0]?.transcript?.trim())
        .filter(Boolean)
        .join(' ');
      this.transcript = [this.prefix, text].filter(Boolean).join(' ');
      if (this.transcript) this.onTranscript(this.transcript);
    };
    recognition.onerror = (event) => {
      if (this.closed) return;
      if (event.error === 'no-speech') {
        if (!this.captureEnded) this.onNoSpeech();
        return;
      }
      this.onError(new Error(`Voice recognition failed (${event.error}). Type your guess instead.`));
    };
    recognition.onend = () => {
      if (this.closed || this.captureEnded) return;
      if (Date.now() < this.deadline && this.restarts < MAX_RESTARTS) {
        this.restarts += 1;
        this.prefix = this.transcript;
        this.restartTimer = setTimeout(() => {
          this.restartTimer = null;
          if (!this.isCapturing) return;
          try {
            recognition.start();
          } catch (error) {
            this.onError(error);
          }
        }, 200);
      } else {
        this.endCapture();
      }
    };
    recognition.start();
    if (!this.closed) this.timer = setTimeout(() => this.endCapture(), this.durationMs);
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
