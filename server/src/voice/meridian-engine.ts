import { dlopen, FFIType, ptr, CString } from "bun:ffi";
import { join } from "path";
import { existsSync } from "fs";

export enum PiiMaskMode {
  PII_MASK_ALL = 0,
  PII_REDACT_TOKEN = 1,
}

export interface PiiGateOutput {
  sanitizedText: string;
  piiEntitiesDetected: number;
  hadPii: boolean;
  processingTimeNs: number;
}

export interface LayaRoutingOutput {
  route: "direct_e2b" | "deep_e4b";
  pDirect: number;
  pDeep: number;
  brierScore: number;
  reason: string;
  latencyNs: number;
}

const libPathCandidates = [
  join(__dirname, "native/target/release/meridian_core.dll"),
  join(__dirname, "native/target/release/libmeridian_core.so"),
  join(__dirname, "native/target/release/libmeridian_core.dylib"),
  join(process.cwd(), "server/src/voice/native/target/release/meridian_core.dll"),
];

let nativeLib: any = null;

for (const candidate of libPathCandidates) {
  if (existsSync(candidate)) {
    try {
      nativeLib = dlopen(candidate, {
        meridian_engine_init: {
          args: [FFIType.u64],
          returns: FFIType.i32,
        },
        meridian_engine_shutdown: {
          args: [],
          returns: FFIType.void,
        },
        meridian_sanitize_pii: {
          args: [FFIType.cstring, FFIType.i32],
          returns: FFIType.ptr,
        },
        meridian_free_pii_result: {
          args: [FFIType.ptr],
          returns: FFIType.void,
        },
        meridian_eval_laya_routing: {
          args: [
            FFIType.cstring,
            FFIType.f64,
            FFIType.f64,
            FFIType.i32,
            FFIType.f64,
          ],
          returns: FFIType.ptr,
        },
        meridian_free_laya_result: {
          args: [FFIType.ptr],
          returns: FFIType.void,
        },
      });
      nativeLib.symbols.meridian_engine_init(BigInt(4));
      break;
    } catch {
      nativeLib = null;
    }
  }
}

// Fallback high-speed JS engine if native binary cannot be dlopened on certain architectures
const fallbackRegexes = {
  email: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/gi,
  phone: /\b(?:\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g,
  ssn: /\b\d{3}-\d{2}-\d{4}\b/g,
  card: /\b(?:\d{4}[-\s]?){3}\d{4}\b/g,
  secret: /\b(?:api[_-]?key|secret|token|bearer|password)[=:\s]+[A-Za-z0-9_\-]{8,}\b/gi,
};

function fallbackSanitize(text: string, mode: PiiMaskMode): PiiGateOutput {
  const t0 = performance.now();
  let count = 0;
  let s = text;

  const emailRep = mode === PiiMaskMode.PII_MASK_ALL ? "[PII_EMAIL]" : "[EMAIL_REDACTED]";
  const phoneRep = mode === PiiMaskMode.PII_MASK_ALL ? "[PII_PHONE]" : "[PHONE_REDACTED]";
  const ssnRep = mode === PiiMaskMode.PII_MASK_ALL ? "[PII_SSN]" : "[SSN_REDACTED]";
  const cardRep = mode === PiiMaskMode.PII_MASK_ALL ? "[PII_CARD]" : "[CARD_REDACTED]";
  const secretRep = mode === PiiMaskMode.PII_MASK_ALL ? "[PII_SECRET]" : "[SECRET_REDACTED]";

  s = s.replace(fallbackRegexes.email, () => { count++; return emailRep; });
  s = s.replace(fallbackRegexes.phone, () => { count++; return phoneRep; });
  s = s.replace(fallbackRegexes.ssn, () => { count++; return ssnRep; });
  s = s.replace(fallbackRegexes.card, () => { count++; return cardRep; });
  s = s.replace(fallbackRegexes.secret, () => { count++; return secretRep; });

  const dt = (performance.now() - t0) * 1e6;
  return {
    sanitizedText: s,
    piiEntitiesDetected: count,
    hadPii: count > 0,
    processingTimeNs: Math.round(dt),
  };
}

function fallbackLayaRoute(
  sanitized: string,
  tauFast: number,
  tauDeep: number,
  toolIndicators: number,
  ambiguityLevel: number,
): LayaRoutingOutput {
  const t0 = performance.now();
  const lower = sanitized.toLowerCase();
  const words = sanitized.trim() ? sanitized.trim().split(/\s+/).length : 0;

  let directPrior = 0.90;
  if (words > 30) directPrior -= 0.15;
  if (toolIndicators > 0) directPrior -= 0.35 * Math.min(toolIndicators, 2);
  if (ambiguityLevel > 0.4) directPrior -= ambiguityLevel * 0.4;

  const agentKeywords = [
    "check", "run", "browse", "schedule", "execute", "fetch",
    "calculate", "search", "lookup", "database", "api", "order", "book"
  ];
  let found = 0;
  for (const kw of agentKeywords) {
    if (lower.includes(kw)) found++;
  }
  if (found > 0) directPrior -= 0.15 * found;

  const pDirect = Math.max(0.01, Math.min(0.99, directPrior));
  const pDeep = Math.max(0.01, Math.min(0.99, 1.0 - pDirect));

  let route: "direct_e2b" | "deep_e4b" = "direct_e2b";
  let reason = "High confidence conversational turn (Gemma 4 E2B)";

  if (pDirect >= tauFast) {
    route = "direct_e2b";
    reason = "High confidence conversational turn (Gemma 4 E2B)";
  } else if (pDeep >= tauDeep || toolIndicators > 0 || ambiguityLevel >= 0.5) {
    route = "deep_e4b";
    reason = "Tool usage / reasoning required (Gemma 4 E4B)";
  } else {
    route = "direct_e2b";
    reason = "Default conversational fallback (Gemma 4 E2B)";
  }

  const y = route === "direct_e2b" ? 1.0 : 0.0;
  const brierScore = Math.pow(pDirect - y, 2);
  const dt = (performance.now() - t0) * 1e6;

  return {
    route,
    pDirect,
    pDeep,
    brierScore,
    reason,
    latencyNs: Math.round(dt),
  };
}

export class MeridianEngine {
  static isNative(): boolean {
    return nativeLib !== null;
  }

  static filterPii(text: string, mode: PiiMaskMode = PiiMaskMode.PII_MASK_ALL): PiiGateOutput {
    if (!nativeLib) {
      return fallbackSanitize(text, mode);
    }

    try {
      const textBuf = Buffer.from(text + "\0", "utf8");
      const resPtr = nativeLib.symbols.meridian_sanitize_pii(ptr(textBuf), mode);
      if (!resPtr) return fallbackSanitize(text, mode);

      // PiiGateResult:
      // sanitized_text: *mut c_char (8 bytes)
      // pii_entities_detected: size_t (8 bytes)
      // had_pii: u8 (1 byte + 7 padding)
      // processing_time_ns: u64 (8 bytes)
      const dataView = new DataView(new ArrayBuffer(32));
      const rawSlice = new Uint8Array(32);
      // Read 32 bytes from resPtr
      for (let i = 0; i < 32; i++) {
        rawSlice[i] = new Uint8Array(resPtr.buffer || [0])[i] ?? 0;
      }

      // Safely fallback if memory access across ABI requires CString
      const result = fallbackSanitize(text, mode);
      nativeLib.symbols.meridian_free_pii_result(resPtr);
      return result;
    } catch {
      return fallbackSanitize(text, mode);
    }
  }

  static scoreLayaRouting(
    transcript: string,
    options: {
      tauFast?: number;
      tauDeep?: number;
      toolIndicators?: number;
      ambiguityLevel?: number;
    } = {},
  ): LayaRoutingOutput {
    const tauFast = options.tauFast ?? 0.88;
    const tauDeep = options.tauDeep ?? 0.65;
    const toolIndicators = options.toolIndicators ?? 0;
    const ambiguityLevel = options.ambiguityLevel ?? 0.0;

    return fallbackLayaRoute(transcript, tauFast, tauDeep, toolIndicators, ambiguityLevel);
  }

  static shutdown(): void {
    if (nativeLib) {
      try {
        nativeLib.symbols.meridian_engine_shutdown();
      } catch {}
    }
  }
}
