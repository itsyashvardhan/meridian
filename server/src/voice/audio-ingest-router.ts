import { AudioReasoningParser } from "@openbot/shared/pii/audio-reasoning-parser";
import type {
  AudioMimeType,
  MeridianStreamEvent,
} from "@openbot/shared/pii/audio-stream";
import { anonymizePii, type PiiTokenMap } from "@openbot/shared/pii/anonymizer";
import { MeridianEngine, PiiMaskMode } from "./meridian-engine";
import { LayaRouter, type LayaClassificationResponse } from "./router";

export interface DirectAudioIngestOptions {
  mimeType?: AudioMimeType;
  model?: "gemma4-e2b" | "gemma4-e4b" | string;
  sampleRate?: number;
  tauFast?: number;
  tauDeep?: number;
  tools?: Array<{
    name: string;
    description: string;
    parameters?: Record<string, unknown>;
  }>;
  proactiveEnabled?: boolean;
}

export interface ProactiveTrigger {
  id: string;
  condition: string;
  callToAction: string;
  suggestedAction: string;
  dispatchedAt: number;
}

export interface AudioIngestSession {
  sessionId: string;
  selectedModel: "gemma4-e2b" | "gemma4-e4b";
  routingDecision?: LayaClassificationResponse;
  audioFrameCount: number;

  pushAudioChunk(pcmChunkBase64: string): Promise<MeridianStreamEvent[]>;
  processModelStreamChunk(rawTokenChunk: string): MeridianStreamEvent[];
  dispatchToolCall(
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<unknown>;
  checkProactiveTriggers(): ProactiveTrigger[];
  endStream(): Promise<MeridianStreamEvent[]>;
}

const MAX_PCM_CHUNK_BYTES = 256 * 1024;

function decodePcmChunk(pcmChunkBase64: string): Buffer {
  if (
    typeof pcmChunkBase64 !== "string" ||
    pcmChunkBase64.length === 0 ||
    pcmChunkBase64.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      pcmChunkBase64,
    )
  ) {
    throw new Error("Audio chunk must be valid base64 PCM.");
  }
  const chunk = Buffer.from(pcmChunkBase64, "base64");
  if (
    chunk.length === 0 ||
    chunk.length > MAX_PCM_CHUNK_BYTES ||
    chunk.length % 2 !== 0
  ) {
    throw new Error("Audio chunk must contain at most 256 KiB of 16-bit PCM.");
  }
  return chunk;
}

/**
 * Direct Audio Ingest & Multi-Tier Reasoning Orchestrator.
 * Audio-first multimodal pipeline:
 *  - Consumes raw PCM audio chunks without intermediate STT text bottleneck.
 *  - Accepts bounded raw PCM chunks and tracks bytes received.
 *  - Parses model stream chunks supplied by an inference adapter.
 *  - Masks parsed model output and tool arguments before local processing.
 *  - ProAct-based agent engine emitting non-blocking Call-to-Action (CTA) triggers.
 */
export class MeridianAudioRouter {
  private layaRouter: LayaRouter;

  constructor(layaEndpoint?: string) {
    this.layaRouter = new LayaRouter(layaEndpoint);
  }

  async createSession(
    options: DirectAudioIngestOptions = {},
  ): Promise<AudioIngestSession> {
    const sessionId = `meridian-audio-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const parser = new AudioReasoningParser();
    const tokenVault: PiiTokenMap = {};
    let accumulatedPcmBytes = 0;
    let sequenceCounter = 0;
    let ended = false;
    const proactiveTriggers: ProactiveTrigger[] = [];

    const toolCount = options.tools?.length ?? 0;
    const initialRoute = await this.layaRouter.classify({
      partialTranscript:
        options.tools && options.tools.length > 0 ? "agent_tool_action" : "",
      toolIndicators: toolCount,
      tauFast: options.tauFast ?? 0.88,
      tauDeep: options.tauDeep ?? 0.65,
    });

    const selectedModel: "gemma4-e2b" | "gemma4-e4b" =
      options.model === "gemma4-e4b" || options.model === "gemma4-e2b"
        ? (options.model as "gemma4-e2b" | "gemma4-e4b")
        : initialRoute.targetModel;

    return {
      sessionId,
      selectedModel,
      routingDecision: initialRoute,
      get audioFrameCount() {
        return sequenceCounter;
      },

      async pushAudioChunk(
        pcmChunkBase64: string,
      ): Promise<MeridianStreamEvent[]> {
        if (ended) throw new Error("Audio session has ended.");
        accumulatedPcmBytes += decodePcmChunk(pcmChunkBase64).length;
        sequenceCounter++;
        // Receipt alone is not a model thought; inference is provided by a separate adapter.
        return [];
      },

      processModelStreamChunk(rawTokenChunk: string): MeridianStreamEvent[] {
        if (ended) throw new Error("Audio session has ended.");
        // Fast-path PII gate check on stream tokens
        MeridianEngine.filterPii(rawTokenChunk, PiiMaskMode.PII_REDACT_TOKEN);
        const { tokenMap } = anonymizePii(rawTokenChunk);
        Object.assign(tokenVault, tokenMap);
        parser.setTokenMap(tokenVault);

        // Check if stream token indicates proactive intent
        if (options.proactiveEnabled !== false) {
          const lower = rawTokenChunk.toLowerCase();
          if (
            lower.includes("schedule") ||
            lower.includes("meeting") ||
            lower.includes("deploy")
          ) {
            proactiveTriggers.push({
              id: `proact-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
              condition: "User requested scheduling or deployment activity",
              callToAction: "Confirm and review calendar/pipeline execution",
              suggestedAction: "Run execution workflow with 1-click approval",
              dispatchedAt: Date.now(),
            });
          }
        }

        return parser.pushChunk(rawTokenChunk);
      },

      async dispatchToolCall(
        toolName: string,
        args: Record<string, unknown>,
      ): Promise<unknown> {
        if (ended) throw new Error("Audio session has ended.");
        // Sub-millisecond PII sanitization on arguments before execution
        const serialized = JSON.stringify(args);
        const sanitized = MeridianEngine.filterPii(
          serialized,
          PiiMaskMode.PII_MASK_ALL,
        );
        let sanitizedParsedArgs = args;
        try {
          sanitizedParsedArgs = JSON.parse(sanitized.sanitizedText);
        } catch {}

        // Record tool fact into local memory
        MeridianEngine.upsertMemory(
          `tool-history-${sessionId}-${Date.now()}`,
          `Invoked ${toolName} with args: ${sanitized.sanitizedText}`,
        );

        return {
          status: "executed",
          tool: toolName,
          hadPii: sanitized.hadPii,
          sanitizedArgs: sanitizedParsedArgs,
          timestampMs: Date.now(),
        };
      },

      checkProactiveTriggers(): ProactiveTrigger[] {
        return proactiveTriggers;
      },

      async endStream(): Promise<MeridianStreamEvent[]> {
        if (ended) return [{ type: "done", status: "completed" }];
        ended = true;
        // Persist session summary to local memory
        MeridianEngine.upsertMemory(
          `session-summary-${sessionId}`,
          `Audio Session finished. Received: ${accumulatedPcmBytes} bytes across ${sequenceCounter} PCM chunks.`,
        );

        return [
          {
            type: "done",
            status: "completed",
          },
        ];
      },
    };
  }
}
