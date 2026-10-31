#pragma once
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#if defined(_WIN32) || defined(__CYGWIN__)
  #ifdef MERIDIAN_EXPORTS
    #define MERIDIAN_API __declspec(dllexport)
  #else
    #define MERIDIAN_API __declspec(dllimport)
  #endif
#else
  #define MERIDIAN_API __attribute__((visibility("default")))
#endif

typedef enum {
  PII_MASK_ALL = 0,
  PII_REDACT_TOKEN = 1
} PiiMaskMode;

typedef struct {
  char* sanitized_text;
  size_t pii_entities_detected;
  uint8_t had_pii;
  uint64_t processing_time_ns;
} PiiGateResult;

typedef struct {
  char route[32];            /* "direct_e2b" or "deep_e4b" */
  double p_direct;
  double p_deep;
  double brier_score;
  char reason[64];
  uint64_t decision_latency_ns;
} LayaDecisionResult;

typedef struct {
  size_t total_entries;
  size_t total_tokens;
  size_t max_capacity_bytes;
  size_t current_usage_bytes;
  double hit_rate;
} KvCacheStats;

typedef struct {
  size_t facts_count;
  size_t memory_bytes;
  uint64_t last_sync_ns;
} LocalMemoryStats;

/* Multi-threaded Low-level PII Gate & Decision Engine using POSIX threads */
MERIDIAN_API int meridian_engine_init(size_t worker_threads);
MERIDIAN_API void meridian_engine_shutdown(void);

/* Process text through multi-threaded low-level PII gate */
MERIDIAN_API PiiGateResult* meridian_sanitize_pii(const char* input_text, PiiMaskMode mode);
MERIDIAN_API void meridian_free_pii_result(PiiGateResult* result);

/* Non-AR Logarithmic / Brier decision scoring */
MERIDIAN_API LayaDecisionResult* meridian_eval_laya_routing(
    const char* sanitized_transcript,
    double tau_fast,
    double tau_deep,
    int tool_indicators_count,
    double ambiguity_level
);
MERIDIAN_API void meridian_free_laya_result(LayaDecisionResult* result);

/* KV Cache & Paged Attention Native Manager */
MERIDIAN_API int meridian_kv_cache_init(size_t max_capacity_mb);
MERIDIAN_API int meridian_kv_cache_put(const char* session_id, uint64_t sequence_id, const float* key_vector, const float* val_vector, size_t dim);
MERIDIAN_API int meridian_kv_cache_get(const char* session_id, uint64_t sequence_id, float* out_key, float* out_val, size_t dim);
MERIDIAN_API int meridian_kv_cache_evict_prefix(const char* session_id, size_t count_to_keep);
MERIDIAN_API void meridian_kv_cache_get_stats(KvCacheStats* out_stats);
MERIDIAN_API void meridian_kv_cache_clear(void);

/* Local Memory & Fact Store */
MERIDIAN_API int meridian_memory_upsert(const char* key, const char* content, uint8_t is_pii_sanitized);
MERIDIAN_API const char* meridian_memory_retrieve(const char* key);
MERIDIAN_API void meridian_memory_free_string(char* ptr);
MERIDIAN_API void meridian_memory_get_stats(LocalMemoryStats* out_stats);

#ifdef __cplusplus
}
#endif
