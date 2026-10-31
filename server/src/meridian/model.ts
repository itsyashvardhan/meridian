/**
 * Streaming client for an OpenAI-compatible chat endpoint that accepts audio input parts. The same
 * request shape works against OpenAI's audio models and against a local Gemma 4 (e2b/e4b) server such
 * as llama.cpp or vLLM, so the tier only changes the base URL and model name.
 */

export type ContentPart =
  | { type: "text"; text: string }
  | { type: "input_audio"; input_audio: { data: string; format: "wav" } };

export type ChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string | ContentPart[] }
  | {
      role: "assistant";
      content: string | null;
      tool_calls?: Array<{
        id: string;
        type: "function";
        function: { name: string; arguments: string };
      }>;
    }
  | { role: "tool"; tool_call_id: string; content: string };

export type ToolSpec = {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
};

export type ModelDelta =
  | { type: "text"; delta: string }
  | { type: "tool_call"; index: number; id?: string; name?: string; argsDelta: string };

export type ChatRequest = {
  tier: "gemma4-e2b" | "gemma4-e4b";
  messages: ChatMessage[];
  tools: ToolSpec[];
  signal: AbortSignal;
};

export interface ModelClient {
  readonly configured: boolean;
  describe(tier: ChatRequest["tier"]): string;
  stream(request: ChatRequest): AsyncIterable<ModelDelta>;
}

type TierConfig = { baseUrl: string; apiKey?: string; model: string };

export function modelConfigFromEnv(env = process.env) {
  const sharedBase = env.MERIDIAN_MODEL_BASE_URL?.trim() || "https://api.openai.com/v1";
  const sharedKey = env.MERIDIAN_MODEL_API_KEY?.trim() || env.OPENAI_API_KEY?.trim();
  const tier = (prefix: "FAST" | "DEEP", fallback: string): TierConfig => ({
    baseUrl: env[`MERIDIAN_${prefix}_BASE_URL`]?.trim() || sharedBase,
    apiKey: env[`MERIDIAN_${prefix}_API_KEY`]?.trim() || sharedKey,
    model: env[`MERIDIAN_${prefix}_MODEL`]?.trim() || fallback,
  });
  return {
    "gemma4-e2b": tier("FAST", "gpt-audio-mini"),
    "gemma4-e4b": tier("DEEP", "gpt-audio"),
  } as const;
}

async function* sseLines(body: ReadableStream<Uint8Array>) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line.startsWith("data:")) yield line.slice(5).trim();
        newline = buffer.indexOf("\n");
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export class OpenAICompatibleClient implements ModelClient {
  constructor(private readonly tiers = modelConfigFromEnv()) {}

  get configured() {
    return Boolean(this.tiers["gemma4-e2b"].apiKey || this.isLocal("gemma4-e2b"));
  }

  describe(tier: ChatRequest["tier"]) {
    return this.tiers[tier].model;
  }

  private isLocal(tier: ChatRequest["tier"]) {
    return !this.tiers[tier].baseUrl.startsWith("https://api.openai.com");
  }

  async *stream({ tier, messages, tools, signal }: ChatRequest): AsyncIterable<ModelDelta> {
    const config = this.tiers[tier];
    const response = await fetch(`${config.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: config.model,
        modalities: ["text"],
        stream: true,
        messages,
        ...(tools.length > 0 ? { tools, tool_choice: "auto" } : {}),
      }),
      signal,
    });
    if (!response.ok || !response.body) {
      // Only the status reaches the person: an upstream body can echo request content.
      throw new Error(`The ${config.model} model answered ${response.status}.`);
    }
    for await (const data of sseLines(response.body)) {
      if (data === "[DONE]") return;
      let chunk: {
        choices?: Array<{
          delta?: {
            content?: string | null;
            tool_calls?: Array<{
              index: number;
              id?: string;
              function?: { name?: string; arguments?: string };
            }>;
          };
        }>;
      };
      try {
        chunk = JSON.parse(data);
      } catch {
        continue;
      }
      const delta = chunk.choices?.[0]?.delta;
      if (!delta) continue;
      if (delta.content) yield { type: "text", delta: delta.content };
      for (const call of delta.tool_calls ?? []) {
        yield {
          type: "tool_call",
          index: call.index,
          id: call.id,
          name: call.function?.name,
          argsDelta: call.function?.arguments ?? "",
        };
      }
    }
  }
}
