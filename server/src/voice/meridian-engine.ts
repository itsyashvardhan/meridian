import { CString, dlopen, FFIType, ptr, read } from "bun:ffi";
import { anonymizePii } from "@openbot/shared/pii/anonymizer";
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
  join(
    process.cwd(),
    "server/src/voice/native/target/release/meridian_core.dll",
  ),
];

let nativeLib: any = null;

for (const candidate of process.env.MERIDIAN_NATIVE_DISABLED === "1"
  ? []
  : libPathCandidates) {
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
          args: [
            FFIType.cstring,
            FFIType.u64,
            FFIType.ptr,
            FFIType.ptr,
            FFIType.u64,
          ],
          returns: FFIType.i32,
        },
        meridian_kv_cache_get: {
          args: [
            FFIType.cstring,
            FFIType.u64,
            FFIType.ptr,
            FFIType.ptr,
            FFIType.u64,
          ],
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

// Portable implementation shares entity detection with the reversible PII shield.
function fallbackSanitize(text: string, mode: PiiMaskMode): PiiGateOutput {
  const t0 = performance.now();
  const masked = anonymizePii(text);
  const count = Object.keys(masked.tokenMap).length;
  const labels: Record<string, string> = {
    EMAIL:
      mode === PiiMaskMode.PII_MASK_ALL ? "[PII_EMAIL]" : "[EMAIL_REDACTED]",
    CREDIT_CARD:
      mode === PiiMaskMode.PII_MASK_ALL ? "[PII_CARD]" : "[CARD_REDACTED]",
    SSN: mode === PiiMaskMode.PII_MASK_ALL ? "[PII_SSN]" : "[SSN_REDACTED]",
    PHONE_NUMBER:
      mode === PiiMaskMode.PII_MASK_ALL ? "[PII_PHONE]" : "[PHONE_REDACTED]",
    IP_ADDRESS:
      mode === PiiMaskMode.PII_MASK_ALL ? "[PII_IP]" : "[IP_REDACTED]",
    API_KEY:
      mode === PiiMaskMode.PII_MASK_ALL ? "[PII_SECRET]" : "[SECRET_REDACTED]",
  };
  let s = masked.anonymizedText;
  for (const token of Object.keys(masked.tokenMap)) {
    const type = token.match(/^<PII_([A-Z_]+)_\d+>$/)?.[1];
    if (type) s = s.replaceAll(token, labels[type] ?? "[PII]");
  }

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

  let directPrior = 0.9;
  if (words > 30) directPrior -= 0.15;
  if (toolIndicators > 0) directPrior -= 0.35 * Math.min(toolIndicators, 2);
  if (ambiguityLevel > 0.4) directPrior -= ambiguityLevel * 0.4;

  const agentKeywords = [
    "check",
    "run",
    "browse",
    "schedule",
    "execute",
    "fetch",
    "calculate",
    "search",
    "lookup",
    "database",
    "api",
    "order",
    "book",
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
const kvMap = new Map<
  string,
  Map<number, { k: Float32Array; v: Float32Array }>
>();
const KV_CACHE_MAX_BYTES = 512 * 1024 * 1024;
let kvCacheBytes = 0;
let kvCacheReads = 0;
let kvCacheHits = 0;

export class MeridianEngine {
  static isNative(): boolean {
    return nativeLib !== null;
  }

  static filterPii(
    text: string,
    mode: PiiMaskMode = PiiMaskMode.PII_MASK_ALL,
  ): PiiGateOutput {
    // Native strings are NUL terminated; use the JS path for inputs the ABI cannot represent.
    if (nativeLib && !text.includes("\0")) {
      let resultPtr = 0;
      try {
        resultPtr = nativeLib.symbols.meridian_sanitize_pii(text, mode);
        if (resultPtr) {
          const sanitizedPtr = read.ptr(resultPtr, 0);
          const sanitizedText = sanitizedPtr ? new CString(sanitizedPtr) : "";
          return {
            sanitizedText,
            piiEntitiesDetected: Number(read.u64(resultPtr, 8)),
            hadPii: read.u8(resultPtr, 16) !== 0,
            processingTimeNs: Number(read.u64(resultPtr, 24)),
          };
        }
      } catch {
        // The fallback keeps the service usable when the optional native library is incompatible.
      } finally {
        if (resultPtr) {
          try {
            nativeLib.symbols.meridian_free_pii_result(resultPtr);
          } catch {
            // A failing optional native library must never fail a user request.
          }
        }
      }
    }
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

    if (nativeLib && !transcript.includes("\0")) {
      let resultPtr = 0;
      try {
        resultPtr = nativeLib.symbols.meridian_eval_laya_routing(
          transcript,
          tauFast,
          tauDeep,
          toolIndicators,
          ambiguityLevel,
        );
        if (resultPtr) {
          const route = new CString(resultPtr, 0, 32).replace(/\0.*$/, "");
          const reason = new CString(resultPtr, 56, 64).replace(/\0.*$/, "");
          return {
            route: route === "deep_e4b" ? "deep_e4b" : "direct_e2b",
            pDirect: read.f64(resultPtr, 32),
            pDeep: read.f64(resultPtr, 40),
            brierScore: read.f64(resultPtr, 48),
            reason,
            latencyNs: Number(read.u64(resultPtr, 120)),
          };
        }
      } catch {
        // The deterministic JS implementation is the portable fallback.
      } finally {
        if (resultPtr) {
          try {
            nativeLib.symbols.meridian_free_laya_result(resultPtr);
          } catch {
            // Ignore teardown failures from the optional library.
          }
        }
      }
    }
    return fallbackLayaRoute(
      transcript,
      tauFast,
      tauDeep,
      toolIndicators,
      ambiguityLevel,
    );
  }

  // --- KV Cache Management ---
  static putKvCache(
    sessionId: string,
    sequenceId: number,
    keyVector: Float32Array,
    valVector: Float32Array,
  ): boolean {
    if (
      !Number.isSafeInteger(sequenceId) ||
      sequenceId < 0 ||
      keyVector.length !== valVector.length
    ) {
      return false;
    }
    const entryBytes = keyVector.byteLength + valVector.byteLength;
    if (entryBytes > KV_CACHE_MAX_BYTES) return false;
    let sessionMap = kvMap.get(sessionId);
    if (!sessionMap) {
      sessionMap = new Map();
      kvMap.set(sessionId, sessionMap);
    }
    const previous = sessionMap.get(sequenceId);
    if (previous) kvCacheBytes -= previous.k.byteLength + previous.v.byteLength;
    sessionMap.delete(sequenceId);
    sessionMap.set(sequenceId, { k: keyVector, v: valVector });
    kvCacheBytes += entryBytes;

    // Bound fallback memory too; evict the oldest cached frame until this write fits.
    while (kvCacheBytes > KV_CACHE_MAX_BYTES) {
      const oldestSession = kvMap.values().next().value as
        | Map<number, { k: Float32Array; v: Float32Array }>
        | undefined;
      if (!oldestSession) break;
      const oldestSequence = oldestSession.keys().next().value as
        | number
        | undefined;
      if (oldestSequence === undefined) break;
      const oldest = oldestSession.get(oldestSequence);
      if (oldest) kvCacheBytes -= oldest.k.byteLength + oldest.v.byteLength;
      oldestSession.delete(oldestSequence);
      if (oldestSession.size === 0) {
        const oldestSessionId = kvMap.keys().next().value as string | undefined;
        if (oldestSessionId !== undefined) kvMap.delete(oldestSessionId);
      }
    }

    if (nativeLib) {
      try {
        const sBuf = Buffer.from(sessionId + "\0", "utf8");
        nativeLib.symbols.meridian_kv_cache_put(
          ptr(sBuf),
          BigInt(sequenceId),
          ptr(keyVector),
          ptr(valVector),
          BigInt(keyVector.length),
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
    dim: number,
  ): { key: Float32Array; val: Float32Array } | null {
    kvCacheReads++;
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
          BigInt(dim),
        );
        if (res === 0) {
          kvCacheHits++;
          return { key: outKey, val: outVal };
        }
      } catch {
        // Fallback
      }
    }
    const sessionMap = kvMap.get(sessionId);
    const entry = sessionMap?.get(sequenceId);
    if (entry && entry.k.length === dim) {
      kvCacheHits++;
      return { key: entry.k, val: entry.v };
    }
    return null;
  }

  static evictKvPrefix(sessionId: string, keepCount: number): boolean {
    if (!Number.isSafeInteger(keepCount) || keepCount < 0) return false;
    if (nativeLib) {
      try {
        const sBuf = Buffer.from(sessionId + "\0", "utf8");
        nativeLib.symbols.meridian_kv_cache_evict_prefix(
          ptr(sBuf),
          BigInt(keepCount),
        );
      } catch {
        // Fallback
      }
    }
    const sessionMap = kvMap.get(sessionId);
    if (sessionMap && sessionMap.size > keepCount) {
      const keys = Array.from(sessionMap.keys()).sort((a, b) => a - b);
      const evict = keys.length - keepCount;
      for (let i = 0; i < evict; i++) {
        const entry = sessionMap.get(keys[i]);
        if (entry) kvCacheBytes -= entry.k.byteLength + entry.v.byteLength;
        sessionMap.delete(keys[i]);
      }
      if (sessionMap.size === 0) kvMap.delete(sessionId);
    }
    return true;
  }

  static getKvCacheStats(): KvCacheStatsOutput {
    if (nativeLib) {
      const stats = Buffer.alloc(40);
      try {
        nativeLib.symbols.meridian_kv_cache_get_stats(ptr(stats));
        return {
          totalEntries: Number(read.u64(ptr(stats), 0)),
          totalTokens: Number(read.u64(ptr(stats), 8)),
          maxCapacityBytes: Number(read.u64(ptr(stats), 16)),
          currentUsageBytes: Number(read.u64(ptr(stats), 24)),
          hitRate: read.f64(ptr(stats), 32),
        };
      } catch {
        // Use the portable cache counters when the optional native ABI is incompatible.
      }
    }
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
      maxCapacityBytes: KV_CACHE_MAX_BYTES,
      currentUsageBytes,
      hitRate: kvCacheReads === 0 ? 0 : kvCacheHits / kvCacheReads,
    };
  }

  // --- Local Memory Management ---
  static upsertMemory(
    key: string,
    content: string,
    isPiiSanitized = true,
  ): boolean {
    if (nativeLib) {
      try {
        const kBuf = Buffer.from(key + "\0", "utf8");
        const cBuf = Buffer.from(content + "\0", "utf8");
        const res = nativeLib.symbols.meridian_memory_upsert(
          ptr(kBuf),
          ptr(cBuf),
          isPiiSanitized ? 1 : 0,
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
