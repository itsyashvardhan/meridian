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
