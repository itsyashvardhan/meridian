export type VoiceConfig = {
  provider: "openai-realtime" | "xai-realtime" | "openflow-realtime";
  model: string;
  apiKey: string;
  voice: string;
  layaEndpoint?: string;
  tauFast?: number;
  tauDeep?: number;
};

/** Live voice is separately opted in; chat and dictation credentials never enable it. */
export function voiceConfig(
  environment: Record<string, string | undefined>,
): VoiceConfig | undefined {
  const provider = environment.VOICE_PROVIDER?.trim();
  const model = environment.VOICE_MODEL?.trim();
  const apiKey = environment.VOICE_API_KEY?.trim();
  const voice = environment.VOICE_NAME?.trim();
  const layaEndpoint = environment.VOICE_LAYA_ENDPOINT?.trim();
  const tauFast = environment.VOICE_TAU_FAST ? Number(environment.VOICE_TAU_FAST) : undefined;
  const tauDeep = environment.VOICE_TAU_DEEP ? Number(environment.VOICE_TAU_DEEP) : undefined;

  if (!provider && !model && !apiKey && !voice) return undefined;
  if (
    provider !== "openai-realtime" &&
    provider !== "xai-realtime" &&
    provider !== "openflow-realtime"
  ) {
    throw new Error(
      "VOICE_PROVIDER must be openai-realtime, xai-realtime, or openflow-realtime.",
    );
  }
  if (provider === "openflow-realtime") {
    return {
      provider,
      model: model || "gemma4-e2b",
      apiKey: apiKey || "local-meridian",
      voice: voice || "gemma-native",
      layaEndpoint,
      tauFast,
      tauDeep,
    };
  }
  if (!model || !apiKey) {
    throw new Error("VOICE_MODEL and VOICE_API_KEY are required.");
  }
  return {
    provider,
    model,
    apiKey,
    voice:
      voice ||
      (provider === "openai-realtime"
        ? "marin"
        : provider === "openflow-realtime"
          ? "gemma-native"
          : "ara"),
    layaEndpoint,
    tauFast,
    tauDeep,
  };
}
