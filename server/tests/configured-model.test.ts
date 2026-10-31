import { expect, test } from "bun:test";
import { createPiiShieldedModel } from "../src/agents/configured-model";

test("the configured OpenAI provider receives masked chat and the user gets restored output", async () => {
  const email = "person@example.com";
  let requestBody: Record<string, unknown> | undefined;
  const model = createPiiShieldedModel(
    { provider: "openai", defaultModel: "gpt-4o-mini" },
    "test-key",
    {
      OPENAI_BASE_URL: "http://model.local/v1",
      COPILOTKIT_OPENAI_API: "chat",
    },
    async (input, init) => {
      expect(String(input)).toBe("http://model.local/v1/chat/completions");
      requestBody = JSON.parse(String(init?.body));
      expect(JSON.stringify(requestBody)).not.toContain(email);
      expect(JSON.stringify(requestBody)).toContain("<PII_EMAIL_1>");
      return Response.json({
        id: "chatcmpl-test",
        object: "chat.completion",
        created: 1,
        model: "gpt-4o-mini",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: "This is for <PII_EMAIL_1>.",
            },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      });
    },
  );

  const result = await model.doGenerate({
    prompt: [
      {
        role: "user",
        content: [{ type: "text", text: `Send a note to ${email}.` }],
      },
    ],
    maxOutputTokens: 100,
    abortSignal: new AbortController().signal,
  } as never);

  expect(requestBody).toBeDefined();
  expect(result.content).toContainEqual({
    type: "text",
    text: `This is for ${email}.`,
  });
});
