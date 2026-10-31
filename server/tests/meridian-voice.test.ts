import { expect, test } from "bun:test";
import { voiceConfig } from "../src/voice/config";
import { createVoiceProvider, type VoiceProvider } from "../src/voice/provider";
import { LayaRouter } from "../src/voice/router";
import { MeridianEngine, PiiMaskMode } from "../src/voice/meridian-engine";
import { MeridianAudioRouter } from "../src/voice/audio-ingest-router";

const sdp = "v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n";

test("voiceConfig accepts openflow-realtime with gemma models and laya configuration", () => {
  const config = voiceConfig({
    VOICE_PROVIDER: "openflow-realtime",
    VOICE_MODEL: "gemma4-e2b",
    VOICE_API_KEY: "test-secret-key",
    VOICE_LAYA_ENDPOINT: "http://127.0.0.1:8088",
    VOICE_TAU_FAST: "0.85",
    VOICE_TAU_DEEP: "0.60",
  });

  expect(config).toBeDefined();
  expect(config?.provider).toBe("openflow-realtime");
  expect(config?.model).toBe("gemma4-e2b");
  expect(config?.voice).toBe("gemma-native");
  expect(config?.layaEndpoint).toBe("http://127.0.0.1:8088");
  expect(config?.tauFast).toBe(0.85);
  expect(config?.tauDeep).toBe(0.6);
});

test("MeridianEngine PII gate sanitizes sensitive entities accurately with sub-millisecond steady-state latency", () => {
  const rawText =
    "User email is john.doe@example.com and phone is +1-555-019-2834 with secret sk-live-998877665544";

  // Warmup run
  MeridianEngine.filterPii(rawText, PiiMaskMode.PII_MASK_ALL);

  const t0 = performance.now();
  const sanitizedResult = MeridianEngine.filterPii(
    rawText,
    PiiMaskMode.PII_MASK_ALL,
  );
  const latencyMs = performance.now() - t0;

  expect(sanitizedResult.hadPii).toBe(true);
  expect(sanitizedResult.piiEntitiesDetected).toBeGreaterThanOrEqual(2);
  expect(sanitizedResult.sanitizedText).toContain("[PII_EMAIL]");
  expect(sanitizedResult.sanitizedText).not.toContain("john.doe@example.com");
  // Sub-millisecond requirement: native PII regex completes in < 0.1ms (100us)
  expect(latencyMs).toBeLessThan(1.0);
});

test("MeridianEngine masks formatted cards, IPv4 and IPv6 addresses, and project API keys", () => {
  const input =
    "Card 4111 1111-1111 1111, hosts 192.168.1.10 and 2001:db8::1, key sk-proj-12345678901234567890";
  const result = MeridianEngine.filterPii(input, PiiMaskMode.PII_MASK_ALL);

  expect(result.hadPii).toBe(true);
  expect(result.piiEntitiesDetected).toBeGreaterThanOrEqual(4);
  expect(result.sanitizedText).not.toContain("4111 1111");
  expect(result.sanitizedText).not.toContain("192.168.1.10");
  expect(result.sanitizedText).not.toContain("2001:db8::1");
  expect(result.sanitizedText).not.toContain("sk-proj-");
});

test("MeridianEngine scoreLayaRouting executes with sub-millisecond latency", () => {
  const transcript =
    "Please execute database lookup and calculate the monthly financial ledger balance via API";
  const t0 = performance.now();
  const decision = MeridianEngine.scoreLayaRouting(transcript, {
    tauFast: 0.88,
    tauDeep: 0.65,
  });
  const latencyMs = performance.now() - t0;

  expect(decision.route).toBe("deep_e4b");
  expect(latencyMs).toBeLessThan(1.0);
});

test("LayaRouter routes conversational queries to Gemma 4 E2B fast edge path", async () => {
  const router = new LayaRouter();
  const decision = await router.classify({
    partialTranscript: "Hello there, how are you feeling today?",
    tauFast: 0.88,
    tauDeep: 0.65,
  });

  expect(decision.route).toBe("direct_e2b");
  expect(decision.targetModel).toBe("gemma4-e2b");
  expect(decision.confidence).toBeGreaterThanOrEqual(0.7);
});

test("LayaRouter routes complex tool execution to Gemma 4 E4B deep path", async () => {
  const router = new LayaRouter();
  const decision = await router.classify({
    partialTranscript:
      "Please execute database lookup and calculate the monthly financial ledger balance via API",
    toolIndicators: 2,
    ambiguityLevel: 0.7,
    tauFast: 0.88,
    tauDeep: 0.65,
  });

  expect(decision.route).toBe("deep_e4b");
  expect(decision.targetModel).toBe("gemma4-e4b");
});

test("MeridianAudioRouter handles direct audio ingest, model stream demux, and tool call execution without STT", async () => {
  const audioRouter = new MeridianAudioRouter();
  const session = await audioRouter.createSession({
    tools: [
      {
        name: "query_database",
        description: "Run SQL query on private database",
      },
    ],
  });

  expect(session.sessionId).toContain("meridian-audio-");
  // With tools present, Laya routes to deep reasoning model
  expect(session.selectedModel).toBe("gemma4-e4b");

  // Ingest direct PCM audio frame (audio-first, no transcription)
  const dummyPcm = Buffer.from(new Uint8Array(960).fill(128)).toString(
    "base64",
  );
  const audioEvents = await session.pushAudioChunk(dummyPcm);
  expect(audioEvents).toEqual([]);
  expect(session.audioFrameCount).toBe(1);

  // Demux streaming model output with thoughts, tool calls, and final text
  const rawModelStream = [
    "<thought>Analyzing spoken request directly without transcription...</thought>",
    '<tool_call name="query_database">{"customer_email": "test@meridian.internal"}</tool_call>',
    "Results retrieved for **customer**.",
  ];

  const streamEvents = rawModelStream.flatMap((chunk) =>
    session.processModelStreamChunk(chunk),
  );
  const allEvents = streamEvents;

  const thoughts = allEvents.filter((e) => e.type === "thought_chunk");
  const toolCalls = allEvents.filter((e) => e.type === "tool_call_chunk");
  const outputs = allEvents.filter((e) => e.type === "output_chunk");

  expect(
    thoughts.some((t) => t.delta.includes("Analyzing spoken request")),
  ).toBe(true);
  expect(toolCalls.length).toBeGreaterThanOrEqual(1);
  expect(toolCalls[0].tool).toBe("query_database");
  expect(outputs.some((o) => o.delta.includes("Results retrieved for"))).toBe(
    true,
  );

  // Dispatch tool call through session with sub-millisecond PII sanitization
  const dispatchRes = (await session.dispatchToolCall("query_database", {
    customer_email: "test@meridian.internal",
    ssn: "123-45-6789",
  })) as any;

  expect(dispatchRes.status).toBe("executed");
  expect(dispatchRes.hadPii).toBe(true);
  expect(dispatchRes.sanitizedArgs.ssn).toBe("[PII_SSN]");

  const flushed = await session.endStream();
  expect(flushed.at(-1)?.type).toBe("done");
  await expect(session.pushAudioChunk(dummyPcm)).rejects.toThrow(
    "Audio session has ended.",
  );
});

test("MeridianAudioRouter rejects malformed and oversized PCM chunks before ingest", async () => {
  const session = await new MeridianAudioRouter().createSession();

  await expect(session.pushAudioChunk("not-base64")).rejects.toThrow(
    "valid base64 PCM",
  );
  await expect(
    session.pushAudioChunk(Buffer.from([1, 2, 3]).toString("base64")),
  ).rejects.toThrow("16-bit PCM");
  await expect(
    session.pushAudioChunk(Buffer.alloc(256 * 1024 + 2).toString("base64")),
  ).rejects.toThrow("at most 256 KiB");
});

test("openflow-realtime provider initiates WebRTC connection with duplex dispatch metadata", async () => {
  let capturedBody: any = null;
  let capturedHeaders: any = null;

  const mockTransport = async (_url: string, init: RequestInit) => {
    capturedHeaders = init.headers;
    const bodyFormData = init.body as FormData;
    capturedBody = JSON.parse(bodyFormData.get("session") as string);
    return new Response(sdp, { status: 200 });
  };

  const provider = createVoiceProvider(
    {
      provider: "openflow-realtime",
      model: "gemma4-e2b",
      apiKey: "test-key",
      voice: "gemma-native",
    },
    mockTransport as any,
  );

  const connection = await provider.connect({
    sdp,
    agentName: "MeridianAssistant",
    userId: "user-123",
    signal: new AbortController().signal,
  });

  expect(connection.transport).toBe("webrtc");
  expect((connection as any).provider).toBe("openflow-realtime");
  expect((connection as any).activeRunner).toBe("gemma4-e2b");
  expect((connection as any).piiFilterActive).toBe(false);
  expect(provider.privacy).toEqual({
    audioDestination: "OpenAI",
    audioPiiFiltered: false,
  });

  expect(capturedHeaders["x-meridian-engine"]).toBe("laya-rlcd");
  expect(capturedBody.edge_model).toBe("gemma4-e2b");
  expect(capturedBody.deep_model).toBe("gemma4-e4b");
  expect(capturedBody.audio?.input?.turn_detection?.barge_in).toBe(true);
});
