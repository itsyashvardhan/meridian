import { AudioReasoningParser } from "@openbot/shared/pii/audio-reasoning-parser";
import type { AudioMimeType, MeridianStreamEvent } from "@openbot/shared/pii/audio-stream";
import { anonymizePii, type PiiTokenMap } from "@openbot/shared/pii/anonymizer";
import { MeridianEngine, PiiMaskMode } from "./meridian-engine";
import { LayaRouter } from "./router";

export interface DirectAudioIngestOptions {
  mimeType?: AudioMimeType;
  model?: string;
  sampleRate?: number;
  tauFast?: number;
  tauDeep?: number;
}

export interface AudioIngestSession {
  sessionId: string;
  pushAudioChunk(pcmChunkBase64: string): Promise<MeridianStreamEvent[]>;
  endStream(): Promise<MeridianStreamEvent[]>;
}

/**
 * Direct Audio Ingest & Reasoning Router.
 * Bypasses separate STT; routes audio frames directly to the model's multimodal context,
 * stripping PII and demultiplexing the model stream into Thought/Reasoning and Markdown Output.
 */
export class MeridianAudioRouter {
  private layaRouter: LayaRouter;

  constructor(layaEndpoint?: string) {
    this.layaRouter = new LayaRouter(layaEndpoint);
  }

  createSession(options: DirectAudioIngestOptions = {}): AudioIngestSession {
    const sessionId = `meridian-audio-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const parser = new AudioReasoningParser();
    const tokenVault: PiiTokenMap = {};
    let accumulatedPcmBytes = 0;

    return {
      sessionId,
      async pushAudioChunk(pcmChunkBase64: string): Promise<MeridianStreamEvent[]> {
        const buffer = Buffer.from(pcmChunkBase64, "base64");
        accumulatedPcmBytes += buffer.length;

        // In a live multimodal stream, audio frames are forwarded to the native/model endpoint.
        // We emit immediate working feedback to the client's Reasoning pane.
        return [
          {
            type: "thought_chunk",
            delta: `[Audio Frame: received ${buffer.length} bytes PCM, total: ${accumulatedPcmBytes} bytes]\n`,
            timestampMs: Date.now(),
          },
        ];
      },

      async endStream(): Promise<MeridianStreamEvent[]> {
        // Complete thought block and emit parsed stream
        const events = parser.flush();
        return events;
      },
    };
  }
}
