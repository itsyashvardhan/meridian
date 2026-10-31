import { MeridianEngine, type LayaRoutingOutput, type PiiGateOutput } from "./meridian-engine";

export interface LayaClassificationRequest {
  partialTranscript: string;
  toolIndicators?: number;
  ambiguityLevel?: number;
  tauFast?: number;
  tauDeep?: number;
}

export interface LayaClassificationResponse {
  route: "direct_e2b" | "deep_e4b";
  targetModel: "gemma4-e2b" | "gemma4-e4b";
  confidence: number;
  brierScore: number;
  reason: string;
  latencyNs: number;
  sanitizedTranscript: string;
  hadPii: boolean;
  piiCount: number;
}

export class LayaRouter {
  private localLayaEndpoint?: string;

  constructor(localLayaEndpoint?: string) {
    this.localLayaEndpoint = localLayaEndpoint;
  }

  async classify(request: LayaClassificationRequest): Promise<LayaClassificationResponse> {
    // Stage 1: Meridian PII Gate (Low-level native fast-pass)
    const piiResult: PiiGateOutput = MeridianEngine.filterPii(request.partialTranscript);

    // If local zero-overhead REST/IPC client configured, query Laya server
    if (this.localLayaEndpoint) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 35); // 35ms budget
        const res = await fetch(`${this.localLayaEndpoint}/classify`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            transcript: piiResult.sanitizedText,
            toolIndicators: request.toolIndicators ?? 0,
            ambiguityLevel: request.ambiguityLevel ?? 0.0,
            tauFast: request.tauFast ?? 0.88,
            tauDeep: request.tauDeep ?? 0.65,
          }),
          signal: controller.signal,
        });
        clearTimeout(timeout);
        if (res.ok) {
          const data = (await res.json()) as any;
          return {
            route: data.route === "deep_e4b" ? "deep_e4b" : "direct_e2b",
            targetModel: data.route === "deep_e4b" ? "gemma4-e4b" : "gemma4-e2b",
            confidence: Number(data.confidence ?? data.p_direct ?? 0.9),
            brierScore: Number(data.brier_score ?? 0.01),
            reason: String(data.reason ?? "Laya IPC Decision"),
            latencyNs: Number(data.latency_ns ?? 30_000_000),
            sanitizedTranscript: piiResult.sanitizedText,
            hadPii: piiResult.hadPii,
            piiCount: piiResult.piiEntitiesDetected,
          };
        }
      } catch {
        // Fall back directly to embedded Meridian decision node (< 5ms)
      }
    }

    // Stage 2: Embedded Laya Non-AR scoring rule (Brier / Logarithmic)
    const decision: LayaRoutingOutput = MeridianEngine.scoreLayaRouting(piiResult.sanitizedText, {
      tauFast: request.tauFast ?? 0.88,
      tauDeep: request.tauDeep ?? 0.65,
      toolIndicators: request.toolIndicators ?? 0,
      ambiguityLevel: request.ambiguityLevel ?? 0.0,
    });

    return {
      route: decision.route,
      targetModel: decision.route === "deep_e4b" ? "gemma4-e4b" : "gemma4-e2b",
      confidence: decision.route === "direct_e2b" ? decision.pDirect : decision.pDeep,
      brierScore: decision.brierScore,
      reason: decision.reason,
      latencyNs: decision.latencyNs,
      sanitizedTranscript: piiResult.sanitizedText,
      hadPii: piiResult.hadPii,
      piiCount: piiResult.piiEntitiesDetected,
    };
  }
}
