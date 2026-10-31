import { wrapLanguageModel, type LanguageModelMiddleware } from "ai";
import { anonymizePii, deanonymizePii } from "@openbot/shared/pii/anonymizer";

type Model = Parameters<typeof wrapLanguageModel>[0]["model"];
type CallOptions = Parameters<Model["doStream"]>[0];
type StreamPart =
  Awaited<ReturnType<Model["doStream"]>>["stream"] extends ReadableStream<
    infer Part
  >
    ? Part
    : never;
type GenerateResult = Awaited<ReturnType<Model["doGenerate"]>>;

const STRUCTURAL_KEYS = new Set([
  "type",
  "role",
  "id",
  "toolCallId",
  "toolName",
  "mediaType",
  "mimeType",
  "providerExecuted",
  "providerOptions",
  "data",
]);

function transformStrings(
  value: unknown,
  transform: (text: string) => string,
  parentKey?: string,
): unknown {
  if (parentKey && STRUCTURAL_KEYS.has(parentKey)) return value;
  if (typeof value === "string") return transform(value);
  if (Array.isArray(value))
    return value.map((entry) => transformStrings(entry, transform));
  if (!value || typeof value !== "object") return value;
  const entries = Object.entries(value).map(([key, entry]) => [
    key,
    transformStrings(entry, transform, key),
  ]);
  return Object.fromEntries(entries);
}

function anonymizePrompt(prompt: CallOptions["prompt"]) {
  const tokenMap: Record<string, string> = {};
  const tokenForValue = new Map<string, string>();
  const nextByType = new Map<string, number>();
  const mask = (text: string) => {
    const result = anonymizePii(text);
    let masked = result.anonymizedText;
    for (const [localToken, original] of Object.entries(result.tokenMap)) {
      const type = localToken.match(/^<PII_([A-Z_]+)_\d+>$/)?.[1];
      if (!type) continue;
      const valueKey = `${type}\0${original}`;
      let token = tokenForValue.get(valueKey);
      if (!token) {
        const index = (nextByType.get(type) ?? 0) + 1;
        nextByType.set(type, index);
        token = `<PII_${type}_${index}>`;
        tokenForValue.set(valueKey, token);
        tokenMap[token] = original;
      }
      masked = masked.replaceAll(localToken, token);
    }
    return masked;
  };

  const transformed = prompt.map(
    (message) => transformStrings(message, mask) as (typeof prompt)[number],
  );
  return { prompt: transformed, tokenMap };
}

function textRestorer(tokenMap: Record<string, string>) {
  const pending = new Map<string, string>();
  return (id: string, delta: string, flush = false) => {
    const combined = (pending.get(id) ?? "") + delta;
    let held = 0;
    if (!flush) {
      for (const token of Object.keys(tokenMap)) {
        for (let size = 1; size < token.length; size++) {
          if (combined.endsWith(token.slice(0, size)))
            held = Math.max(held, size);
        }
      }
    }
    const ready = combined.slice(0, combined.length - held);
    const tail = combined.slice(combined.length - held);
    if (tail) pending.set(id, tail);
    else pending.delete(id);
    return deanonymizePii(ready, tokenMap);
  };
}

function restoreGenerateResult(
  result: GenerateResult,
  tokenMap: Record<string, string>,
): GenerateResult {
  return {
    ...result,
    content: result.content.map((part) => {
      if (part.type === "text" || part.type === "reasoning")
        return { ...part, text: deanonymizePii(part.text, tokenMap) };
      if (part.type === "tool-call")
        return { ...part, input: deanonymizePii(part.input, tokenMap) };
      return part;
    }),
  };
}

export function piiMaskingMiddleware(): LanguageModelMiddleware {
  const tokenMaps = new WeakMap<object, Record<string, string>>();
  return {
    specificationVersion: "v3",
    transformParams: async ({ params }) => {
      const { prompt, tokenMap } = anonymizePrompt(params.prompt);
      const transformed = { ...params, prompt };
      tokenMaps.set(transformed, tokenMap);
      return transformed;
    },
    wrapGenerate: async ({ doGenerate, params }) =>
      restoreGenerateResult(await doGenerate(), tokenMaps.get(params) ?? {}),
    wrapStream: async ({ doStream, params }) => {
      const tokenMap = tokenMaps.get(params) ?? {};
      const restore = textRestorer(tokenMap);
      const toolInputs = new Map<string, string>();
      const { stream, ...metadata } = await doStream();
      const transformed = stream.pipeThrough(
        new TransformStream<StreamPart, StreamPart>({
          transform(part, controller) {
            if (part.type === "text-delta" || part.type === "reasoning-delta") {
              const delta = restore(part.id, part.delta);
              if (delta) controller.enqueue({ ...part, delta });
              return;
            }
            if (part.type === "text-end" || part.type === "reasoning-end") {
              const delta = restore(part.id, "", true);
              if (delta)
                controller.enqueue({
                  type:
                    part.type === "text-end" ? "text-delta" : "reasoning-delta",
                  id: part.id,
                  delta,
                } as StreamPart);
              controller.enqueue(part);
              return;
            }
            if (part.type === "tool-input-delta") {
              toolInputs.set(
                part.id,
                (toolInputs.get(part.id) ?? "") + part.delta,
              );
              return;
            }
            if (part.type === "tool-input-end") {
              const args = deanonymizePii(
                toolInputs.get(part.id) ?? "",
                tokenMap,
              );
              toolInputs.delete(part.id);
              if (args)
                controller.enqueue({
                  type: "tool-input-delta",
                  id: part.id,
                  delta: args,
                } as StreamPart);
              controller.enqueue(part);
              return;
            }
            if (part.type === "tool-call") {
              controller.enqueue({
                ...part,
                input: deanonymizePii(part.input, tokenMap),
              });
              return;
            }
            controller.enqueue(part);
          },
        }),
      );
      return { ...metadata, stream: transformed };
    },
  };
}

export function withPiiMasking(model: Model): Model {
  return wrapLanguageModel({ model, middleware: piiMaskingMiddleware() });
}
