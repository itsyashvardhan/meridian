/**
 * Utterance segmentation for a continuous 16 kHz mono PCM stream. Not transcription: it only decides
 * where a spoken turn starts and ends, so the audio itself can go to the model and so a person
 * starting to talk over an answer can interrupt it.
 */

export const SAMPLE_RATE = 16_000;
const WINDOW = 320; // 20 ms
const PREROLL_WINDOWS = 15; // 300 ms kept from before the onset
const ONSET_WINDOWS = 3; // 60 ms of voice to call it speech
const MIN_VOICED_WINDOWS = 12; // 240 ms of voice for a turn worth sending
const MAX_UTTERANCE_WINDOWS = (30 * SAMPLE_RATE) / WINDOW;

export type VadOptions = {
  /** Silence that closes a turn. */
  hangoverMs?: number;
  /** Absolute floor on the speech threshold, 0..1 RMS. */
  minThreshold?: number;
};

export type VadEvents = {
  onSpeechStart(): void;
  onSpeechEnd(utterance: Int16Array): void;
  onLevel?(rms: number, speaking: boolean): void;
};

export class VoiceActivityDetector {
  private pending = new Int16Array(0);
  private preroll: Int16Array[] = [];
  private utterance: Int16Array[] = [];
  private noiseFloor = 0.004;
  private onsetRun = 0;
  private silenceRun = 0;
  private voicedWindows = 0;
  private speaking = false;
  private readonly hangoverWindows: number;
  private readonly minThreshold: number;

  constructor(
    private readonly events: VadEvents,
    options: VadOptions = {},
  ) {
    this.hangoverWindows = Math.round((options.hangoverMs ?? 700) / 20);
    this.minThreshold = options.minThreshold ?? 0.01;
  }

  get isSpeaking() {
    return this.speaking;
  }

  push(samples: Int16Array) {
    const merged = new Int16Array(this.pending.length + samples.length);
    merged.set(this.pending);
    merged.set(samples, this.pending.length);
    let offset = 0;
    for (; offset + WINDOW <= merged.length; offset += WINDOW) {
      this.window(merged.slice(offset, offset + WINDOW));
    }
    this.pending = merged.slice(offset);
  }

  /** Closes the current turn now, as a push-to-talk release would. */
  flush() {
    if (this.speaking) this.finish();
  }

  reset() {
    this.speaking = false;
    this.utterance = [];
    this.preroll = [];
    this.onsetRun = 0;
    this.silenceRun = 0;
    this.voicedWindows = 0;
  }

  private window(frame: Int16Array) {
    let energy = 0;
    for (const sample of frame) energy += (sample / 32768) ** 2;
    const rms = Math.sqrt(energy / frame.length);
    const threshold = Math.max(this.minThreshold, this.noiseFloor * 3);
    const voiced = rms > threshold;
    this.events.onLevel?.(rms, this.speaking);

    if (!this.speaking) {
      if (!voiced) {
        // The floor follows the room slowly, so a fan or hum stops counting as speech.
        this.noiseFloor = this.noiseFloor * 0.98 + Math.min(rms, 0.05) * 0.02;
      }
      this.preroll.push(frame);
      if (this.preroll.length > PREROLL_WINDOWS) this.preroll.shift();
      this.onsetRun = voiced ? this.onsetRun + 1 : 0;
      if (this.onsetRun >= ONSET_WINDOWS) {
        this.speaking = true;
        this.utterance = [...this.preroll];
        this.preroll = [];
        this.voicedWindows = this.onsetRun;
        this.silenceRun = 0;
        this.events.onSpeechStart();
      }
      return;
    }

    this.utterance.push(frame);
    if (voiced) {
      this.voicedWindows++;
      this.silenceRun = 0;
    } else {
      this.silenceRun++;
    }
    if (
      this.silenceRun >= this.hangoverWindows ||
      this.utterance.length >= MAX_UTTERANCE_WINDOWS
    ) {
      this.finish();
    }
  }

  private finish() {
    const frames = this.utterance;
    const enoughVoice = this.voicedWindows >= MIN_VOICED_WINDOWS;
    this.reset();
    if (!enoughVoice) return;
    const total = frames.reduce((sum, frame) => sum + frame.length, 0);
    const out = new Int16Array(total);
    let offset = 0;
    for (const frame of frames) {
      out.set(frame, offset);
      offset += frame.length;
    }
    this.events.onSpeechEnd(out);
  }
}

/** A 16-bit mono RIFF/WAVE file around raw PCM. */
export function encodeWav(samples: Int16Array, sampleRate = SAMPLE_RATE): Uint8Array {
  const dataBytes = samples.length * 2;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);
  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, "data");
  view.setUint32(40, dataBytes, true);
  new Int16Array(buffer, 44).set(samples);
  return new Uint8Array(buffer);
}

export function durationMs(samples: Int16Array, sampleRate = SAMPLE_RATE) {
  return Math.round((samples.length / sampleRate) * 1000);
}
