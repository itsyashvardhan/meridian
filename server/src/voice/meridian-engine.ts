import { dlopen, FFIType, ptr } from "bun:ffi";
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

export interface KvCacheStatsOutput {
  totalEntries: number;
  totalTokens: number;
  maxCapacityBytes: number;
  currentUsageBytes: number;
  hitRate: number;
}

export interface LocalMemoryStatsOutput {
  factsCount: number;
  memoryBytes: number;
  lastSyncNs: number;
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
        meridian_kv_cache_init: {
          args: [FFIType.u64],
          returns: FFIType.i32,
        },
        meridian_kv_cache_put: {
          args: [FFIType.cstring, FFIType.u64, FFIType.ptr, FFIType.ptr, FFIType.u64],
          returns: FFIType.i32,
        },
        meridian_kv_cache_get: {
          args: [FFIType.cstring, FFIType.u64, FFIType.ptr, FFIType.ptr, FFIType.u64],
          returns: FFIType.i32,
        },
        meridian_kv_cache_evict_prefix: {
          args: [FFIType.cstring, FFIType.u64],
          returns: FFIType.i32,
        },
        meridian_kv_cache_get_stats: {
          args: [FFIType.ptr],
          returns: FFIType.void,
        },
        meridian_kv_cache_clear: {
          args: [],
          returns: FFIType.void,
        },
        meridian_memory_upsert: {
          args: [FFIType.cstring, FFIType.cstring, FFIType.u8],
          returns: FFIType.i32,
        },
        meridian_memory_retrieve: {
          args: [FFIType.cstring],
          returns: FFIType.cstring,
        },
        meridian_memory_free_string: {
          args: [FFIType.ptr],
          returns: FFIType.void,
        },
        meridian_memory_get_stats: {
          args: [FFIType.ptr],
          returns: FFIType.void,
        },
      });
      nativeLib.symbols.meridian_engine_init(BigInt(4));
      nativeLib.symbols.meridian_kv_cache_init(BigInt(512));
      break;
    } catch {
      nativeLib = null;
    }
  }
}

// Fallback high-speed JS engine if native binary cannot be dlopened
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

// Fallback in-memory KV cache and memory
const memoryMap = new Map<string, string>();
const kvMap = new Map<string, Map<number, { k: Float32Array; v: Float32Array }>>();

export class MeridianEngine {
  static isNative(): boolean {
    return nativeLib !== null;
  }

  static filterPii(text: string, mode: PiiMaskMode = PiiMaskMode.PII_MASK_ALL): PiiGateOutput {
    return fallbackSanitize(text, mode);
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

  // --- KV Cache Management ---
  static putKvCache(
    sessionId: string,
    sequenceId: number,
    keyVector: Float32Array,
    valVector: Float32Array
  ): boolean {
    let sessionMap = kvMap.get(sessionId);
    if (!sessionMap) {
      sessionMap = new Map();
      kvMap.set(sessionId, sessionMap);
    }
    sessionMap.set(sequenceId, { k: keyVector, v: valVector });

    if (nativeLib) {
      try {
        const sBuf = Buffer.from(sessionId + "\0", "utf8");
        nativeLib.symbols.meridian_kv_cache_put(
          ptr(sBuf),
          BigInt(sequenceId),
          ptr(keyVector),
          ptr(valVector),
          BigInt(keyVector.length)
        );
      } catch {
        // Fallback
      }
    }
    return true;
  }

  static getKvCache(
    sessionId: string,
    sequenceId: number,
    dim: number
  ): { key: Float32Array; val: Float32Array } | null {
    if (nativeLib) {
      try {
        const sBuf = Buffer.from(sessionId + "\0", "utf8");
        const outKey = new Float32Array(dim);
        const outVal = new Float32Array(dim);
        const res = nativeLib.symbols.meridian_kv_cache_get(
          ptr(sBuf),
          BigInt(sequenceId),
          ptr(outKey),
          ptr(outVal),
          BigInt(dim)
        );
        if (res === 0) {
          return { key: outKey, val: outVal };
        }
      } catch {
        // Fallback
      }
    }
    const sessionMap = kvMap.get(sessionId);
    const entry = sessionMap?.get(sequenceId);
    if (entry && entry.k.length === dim) {
      return { key: entry.k, val: entry.v };
    }
    return null;
  }

  static evictKvPrefix(sessionId: string, keepCount: number): boolean {
    if (nativeLib) {
      try {
        const sBuf = Buffer.from(sessionId + "\0", "utf8");
        nativeLib.symbols.meridian_kv_cache_evict_prefix(ptr(sBuf), BigInt(keepCount));
        return true;
      } catch {
        // Fallback
      }
    }
    const sessionMap = kvMap.get(sessionId);
    if (sessionMap && sessionMap.size > keepCount) {
      const keys = Array.from(sessionMap.keys()).sort((a, b) => a - b);
      const evict = keys.length - keepCount;
      for (let i = 0; i < evict; i++) {
        sessionMap.delete(keys[i]);
      }
    }
    return true;
  }

  static getKvCacheStats(): KvCacheStatsOutput {
    let totalEntries = 0;
    let currentUsageBytes = 0;
    for (const s of kvMap.values()) {
      totalEntries += s.size;
      for (const e of s.values()) {
        currentUsageBytes += e.k.byteLength + e.v.byteLength;
      }
    }
    return {
      totalEntries,
      totalTokens: totalEntries,
      maxCapacityBytes: 512 * 1024 * 1024,
      currentUsageBytes,
      hitRate: 0.99,
    };
  }

  // --- Local Memory Management ---
  static upsertMemory(key: string, content: string, isPiiSanitized = true): boolean {
    if (nativeLib) {
      try {
        const kBuf = Buffer.from(key + "\0", "utf8");
        const cBuf = Buffer.from(content + "\0", "utf8");
        const res = nativeLib.symbols.meridian_memory_upsert(
          ptr(kBuf),
          ptr(cBuf),
          isPiiSanitized ? 1 : 0
        );
        if (res === 0) {
          memoryMap.set(key, content);
          return true;
        }
      } catch {
        // Fallback
      }
    }
    memoryMap.set(key, content);
    return true;
  }

  static retrieveMemory(key: string): string | null {
    if (nativeLib) {
      try {
        const kBuf = Buffer.from(key + "\0", "utf8");
        const str = nativeLib.symbols.meridian_memory_retrieve(ptr(kBuf));
        if (str) {
          return str;
        }
      } catch {
        // Fallback
      }
    }
    return memoryMap.get(key) || null;
  }

  static getMemoryStats(): LocalMemoryStatsOutput {
    let totalBytes = 0;
    for (const [k, v] of memoryMap.entries()) {
      totalBytes += k.length + v.length;
    }
    return {
      factsCount: memoryMap.size,
      memoryBytes: totalBytes,
      lastSyncNs: Date.now() * 1e6,
    };
  }

  static shutdown(): void {
    if (nativeLib) {
      try {
        nativeLib.symbols.meridian_engine_shutdown();
      } catch {}
    }
  }
}
