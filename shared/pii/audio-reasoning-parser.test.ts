import { expect, test } from "bun:test";
import { AudioReasoningParser } from "./audio-reasoning-parser";

test("demultiplexes thought blocks and clean markdown output in real-time stream", () => {
  const parser = new AudioReasoningParser();
  const chunks = [
    "<thought>Analyzing incoming raw audio",
    " frame for intent... User wants",
    " quarterly revenue.</thought>",
    "Here is the summary of **Q3 Revenue**:\n- Total: $4.2M",
  ];

  const thoughts: string[] = [];
  const outputs: string[] = [];

  for (const chunk of chunks) {
    const events = parser.pushChunk(chunk);
    for (const event of events) {
      if (event.type === "thought_chunk") thoughts.push(event.delta);
      if (event.type === "output_chunk") outputs.push(event.delta);
    }
  }
  const finalEvents = parser.flush();
  for (const event of finalEvents) {
    if (event.type === "output_chunk") outputs.push(event.delta);
  }

  const thoughtText = thoughts.join("");
  const outputText = outputs.join("");

  expect(thoughtText).toContain("Analyzing incoming raw audio frame for intent...");
  expect(thoughtText).not.toContain("<thought>");
  expect(thoughtText).not.toContain("</thought>");

  expect(outputText).toContain("Here is the summary of **Q3 Revenue**:");
  expect(outputText).not.toContain("<thought>");
});

test("deanonymizes masked tokens in output stream seamlessly", () => {
  const tokenMap = {
    "<PII_EMAIL_1>": "alice@meridian.internal",
  };
  const parser = new AudioReasoningParser(tokenMap);

  const events = parser.pushChunk("Notify <PII_EMAIL_1> about the report completion.");
  const outputEvent = events.find((e) => e.type === "output_chunk");

  expect(outputEvent).toBeDefined();
  expect(outputEvent?.type === "output_chunk" && outputEvent.delta).toBe(
    "Notify alice@meridian.internal about the report completion."
  );
});

test("demultiplexes inline tool calls and cleans PII in arguments", () => {
  const tokenMap = {
    "<PII_EMAIL_1>": "user@example.com",
  };
  const parser = new AudioReasoningParser(tokenMap);
  const streamChunks = [
    "<thought>User asked to query ledger for customer</thought>",
    '<tool_call name="fetch_customer_data">{"email": "<PII_EMAIL',
    '_1>", "limit": 10}</tool_call>',
    "Data has been fetched successfully.",
  ];

  const thoughts: string[] = [];
  const toolCalls: { tool: string; args: string }[] = [];
  const outputs: string[] = [];

  for (const chunk of streamChunks) {
    const events = parser.pushChunk(chunk);
    for (const ev of events) {
      if (ev.type === "thought_chunk") thoughts.push(ev.delta);
      if (ev.type === "tool_call_chunk") toolCalls.push({ tool: ev.tool, args: ev.argsDelta });
      if (ev.type === "output_chunk") outputs.push(ev.delta);
    }
  }
  const flushed = parser.flush();
  for (const ev of flushed) {
    if (ev.type === "output_chunk") outputs.push(ev.delta);
  }

  expect(thoughts.join("")).toBe("User asked to query ledger for customer");
  expect(toolCalls.length).toBeGreaterThanOrEqual(1);
  expect(toolCalls[0].tool).toBe("fetch_customer_data");
  const fullArgs = toolCalls.map((t) => t.args).join("");
  expect(fullArgs).toContain('"email": "user@example.com"');
  expect(outputs.join("")).toContain("Data has been fetched successfully.");
});
