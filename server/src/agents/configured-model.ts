import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { requiresResponsesApi } from "@openbot/shared/model-providers";
import { withPiiMasking } from "./pii-masking-model";

export type ConfiguredModel = {
  provider: "openai" | "anthropic";
  defaultModel: string;
};

/** Build the same provider selected by deployment config, with the PII shield at its model boundary. */
export function createPiiShieldedModel(
  model: ConfiguredModel,
  apiKey: string,
  environment: Record<string, string | undefined> = process.env,
  fetchImpl?: typeof fetch,
) {
  const fetchOption = fetchImpl ? { fetch: fetchImpl } : {};
  if (model.provider === "anthropic")
    return withPiiMasking(
      createAnthropic({
        apiKey,
        ...(environment.ANTHROPIC_BASE_URL
          ? { baseURL: environment.ANTHROPIC_BASE_URL }
          : {}),
        ...fetchOption,
      })(model.defaultModel),
    );

  const provider = createOpenAI({
    apiKey,
    ...(environment.OPENAI_BASE_URL
      ? { baseURL: environment.OPENAI_BASE_URL }
      : {}),
    ...fetchOption,
  });
  const apiChoice = environment.COPILOTKIT_OPENAI_API?.trim();
  const responses =
    apiChoice === "responses" ||
    (!apiChoice && requiresResponsesApi(model.defaultModel));
  return withPiiMasking(
    responses
      ? provider.responses(model.defaultModel)
      : provider.chat(model.defaultModel),
  );
}
