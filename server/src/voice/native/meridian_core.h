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

#ifdef __cplusplus
}
#endif
