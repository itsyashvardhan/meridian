import { expect, test } from "bun:test";
import { withPiiMasking } from "../src/agents/pii-masking-model";

test("provider model masks every prompt turn and restores streamed text and tool input", async () => {
  const email = "user@example.com";
  let receivedPrompt: unknown;
  const model = withPiiMasking({
    specificationVersion: "v3",
    provider: "test",
    modelId: "test-model",
    supportedUrls: {},
    doGenerate: async () => {
      throw new Error("This test exercises streaming only.");
    },
    doStream: async (options) => {
      receivedPrompt = options.prompt;
      const token = JSON.stringify(options.prompt).match(
        /<PII_EMAIL_\d+>/,
      )?.[0];
      expect(token).toBeDefined();
      const parts = [
        { type: "stream-start", warnings: [] },
        { type: "text-start", id: "answer" },
        {
          type: "text-delta",
          id: "answer",
          delta: `Contact ${token?.slice(0, 9)}`,
        },
        { type: "text-delta", id: "answer", delta: `${token?.slice(9)} now.` },
        { type: "text-end", id: "answer" },
        { type: "tool-input-start", id: "tool-1", toolName: "lookup" },
        {
          type: "tool-input-delta",
          id: "tool-1",
          delta: `{"email":"${token?.slice(0, 9)}`,
        },
        {
          type: "tool-input-delta",
          id: "tool-1",
          delta: `${token?.slice(9)}"}`,
        },
        { type: "tool-input-end", id: "tool-1" },
        {
          type: "tool-call",
          toolCallId: "tool-1",
          toolName: "lookup",
          input: JSON.stringify({ email: token }),
        },
        {
          type: "finish",
          finishReason: { unified: "tool-calls", raw: undefined },
          usage: {},
        },
      ];
      return {
        stream: new ReadableStream({
          start(controller) {
            for (const part of parts) controller.enqueue(part);
            controller.close();
          },
        }),
      } as never;
    },
  } as never);

  const result = await model.doStream({
    prompt: [
      { role: "system", content: `The account belongs to ${email}.` },
      {
        role: "user",
        content: [
          { type: "text", text: `Look up ${email}.` },
          {
            type: "file",
            mediaType: "image/png",
            data: new Uint8Array([1, 2, 3]),
          },
        ],
      },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "old-call",
            toolName: "lookup",
            input: { email },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "old-call",
            toolName: "lookup",
            output: { type: "json", value: { email } },
          },
        ],
      },
    ],
  } as never);

  expect(JSON.stringify(receivedPrompt)).not.toContain(email);
  expect(JSON.stringify(receivedPrompt).match(/<PII_EMAIL_1>/g)?.length).toBe(
    4,
  );
  const maskedUser = (
    receivedPrompt as Array<{ role: string; content: unknown[] }>
  ).find((message) => message.role === "user");
  expect(maskedUser?.content[1]).toMatchObject({
    type: "file",
    data: new Uint8Array([1, 2, 3]),
  });

  const output = [];
  for await (const part of result.stream) output.push(part);
  expect(
    output
      .filter((part) => part.type === "text-delta")
      .map((part) => part.delta)
      .join(""),
  ).toBe(`Contact ${email} now.`);
  expect(
    output
      .filter((part) => part.type === "tool-input-delta")
      .map((part) => part.delta)
      .join(""),
  ).toBe(JSON.stringify({ email }));
  expect(output.find((part) => part.type === "tool-call")).toMatchObject({
    input: JSON.stringify({ email }),
  });
});
