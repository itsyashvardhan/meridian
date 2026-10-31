import { expect, test } from "bun:test";
import { voiceConfig } from "../src/voice/config";
import { createVoiceProvider, type VoiceProvider } from "../src/voice/provider";
import { LayaRouter } from "../src/voice/router";
import { MeridianEngine, PiiMaskMode } from "../src/voice/meridian-engine";

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
  expect(config?.tauDeep).toBe(0.60);
});

test("MeridianEngine PII gate sanitizes sensitive entities accurately", () => {
  const rawText = "User email is john.doe@example.com and phone is +1-555-019-2834 with secret sk-live-998877665544";
  const sanitizedResult = MeridianEngine.filterPii(rawText, PiiMaskMode.PII_MASK_ALL);

  expect(sanitizedResult.hadPii).toBe(true);
  expect(sanitizedResult.piiEntitiesDetected).toBeGreaterThanOrEqual(2);
  expect(sanitizedResult.sanitizedText).toContain("[PII_EMAIL]");
  expect(sanitizedResult.sanitizedText).not.toContain("john.doe@example.com");
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
  expect(decision.confidence).toBeGreaterThanOrEqual(0.70);
});

test("LayaRouter routes complex tool execution to Gemma 4 E4B deep path", async () => {
  const router = new LayaRouter();
  const decision = await router.classify({
    partialTranscript: "Please execute database lookup and calculate the monthly financial ledger balance via API",
    toolIndicators: 2,
    ambiguityLevel: 0.7,
    tauFast: 0.88,
    tauDeep: 0.65,
  });

  expect(decision.route).toBe("deep_e4b");
  expect(decision.targetModel).toBe("gemma4-e4b");
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
  expect((connection as any).piiFilterActive).toBe(true);

  expect(capturedHeaders["x-meridian-engine"]).toBe("laya-rlcd");
  expect(capturedBody.edge_model).toBe("gemma4-e2b");
  expect(capturedBody.deep_model).toBe("gemma4-e4b");
  expect(capturedBody.audio.turn_detection.barge_in).toBe(true);
});
