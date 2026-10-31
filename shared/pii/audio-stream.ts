export type AudioMimeType =
  | "audio/pcm;rate=16000"
  | "audio/pcm;rate=24000"
  | "audio/webm"
  | "audio/wav";

export type AudioFramePacket = {
  type: "audio_frame";
  timestampMs: number;
  mimeType: AudioMimeType;
  pcmBase64: string;
};

export type AudioStreamSignal =
  | { type: "audio_start"; sampleRate: number; channels: number }
  | { type: "audio_frame"; data: string }
  | { type: "audio_end" };

export type MeridianStreamEvent =
  | { type: "thought_chunk"; delta: string; timestampMs: number }
  | { type: "output_chunk"; delta: string; timestampMs: number }
  | { type: "tool_call_chunk"; tool: string; argsDelta: string }
  | { type: "done"; status: "completed" | "interrupted" };

export interface AudioReasoningStreamListener {
  onThought?: (chunk: string) => void;
  onOutput?: (chunk: string) => void;
  onComplete?: () => void;
  onError?: (err: Error) => void;
}
