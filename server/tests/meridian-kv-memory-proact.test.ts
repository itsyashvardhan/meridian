import { expect, test } from "bun:test";
import { MeridianEngine } from "../src/voice/meridian-engine";
import { MeridianAudioRouter } from "../src/voice/audio-ingest-router";

test("MeridianEngine KV Cache stores, retrieves, and evicts prefix sequences", () => {
  const sessionId = "test-session-kv-1";
  const dim = 64;
  const key = new Float32Array(dim).fill(1.23);
  const val = new Float32Array(dim).fill(4.56);

  const putOk = MeridianEngine.putKvCache(sessionId, 1, key, val);
  expect(putOk).toBe(true);

  const fetched = MeridianEngine.getKvCache(sessionId, 1, dim);
  expect(fetched).not.toBeNull();
  expect(fetched?.key[0]).toBeCloseTo(1.23, 2);
  expect(fetched?.val[0]).toBeCloseTo(4.56, 2);

  // Evict prefix
  MeridianEngine.putKvCache(sessionId, 2, key, val);
  MeridianEngine.putKvCache(sessionId, 3, key, val);
  const evictOk = MeridianEngine.evictKvPrefix(sessionId, 1);
  expect(evictOk).toBe(true);

  const stats = MeridianEngine.getKvCacheStats();
  expect(stats.totalEntries).toBeGreaterThanOrEqual(1);
  expect(stats.maxCapacityBytes).toBeGreaterThan(0);
});

test("MeridianEngine Local Memory upserts and retrieves facts", () => {
  const key = "user-preference-dark-mode";
  const fact = "User prefers dark mode and minimal telemetry";

  const ok = MeridianEngine.upsertMemory(key, fact);
  expect(ok).toBe(true);

  const retrieved = MeridianEngine.retrieveMemory(key);
  expect(retrieved).toBe(fact);

  const stats = MeridianEngine.getMemoryStats();
  expect(stats.factsCount).toBeGreaterThanOrEqual(1);
  expect(stats.memoryBytes).toBeGreaterThan(0);
});

test("MeridianAudioRouter operates direct audio ingest with reasoning output, tool calls and proactive triggers", async () => {
  const router = new MeridianAudioRouter();
  const session = await router.createSession({
    proactiveEnabled: true,
    tools: [{ name: "calendar_query", description: "Query calendar schedule" }],
  });

  expect(session.sessionId).toContain("meridian-audio-");
  expect(session.selectedModel).toBeDefined();

  // Push raw audio chunk (bypassing STT)
  const pcmChunkBase64 = Buffer.from(new Uint8Array(1024)).toString("base64");
  const audioEvents = await session.pushAudioChunk(pcmChunkBase64);
  expect(audioEvents.length).toBeGreaterThan(0);
  expect(audioEvents[0].type).toBe("thought_chunk");

  // Stream model reasoning and action
  const streamEvents = session.processModelStreamChunk(
    "<thought>Analyzing user voice frame for action</thought>Let's schedule a deployment review meeting."
  );
  expect(streamEvents.some((e) => e.type === "thought_chunk")).toBe(true);
  expect(streamEvents.some((e) => e.type === "output_chunk")).toBe(true);

  // Check ProAct Call to Action triggers
  const ctas = session.checkProactiveTriggers();
  expect(ctas.length).toBeGreaterThan(0);
  expect(ctas[0].callToAction).toContain("calendar/pipeline");

  // Execute direct tool call
  const toolResult = (await session.dispatchToolCall("calendar_query", {
    email: "test@example.com",
    window: "tomorrow",
  })) as any;
  expect(toolResult.status).toBe("executed");
  expect(toolResult.tool).toBe("calendar_query");

  // End stream
  const endEvents = await session.endStream();
  expect(endEvents[0].type).toBe("done");
});
