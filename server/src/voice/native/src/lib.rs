use std::collections::HashMap;
use std::ffi::{CStr, CString};
use std::os::raw::{c_char, c_float, c_int, c_void};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::Instant;
use regex::Regex;
use lazy_static::lazy_static;

#[repr(C)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PiiMaskMode {
    PiiMaskAll = 0,
    PiiRedactToken = 1,
}

#[repr(C)]
pub struct PiiGateResult {
    pub sanitized_text: *mut c_char,
    pub pii_entities_detected: libc::size_t,
    pub had_pii: u8,
    pub processing_time_ns: u64,
}

#[repr(C)]
pub struct LayaDecisionResult {
    pub route: [c_char; 32],
    pub p_direct: f64,
    pub p_deep: f64,
    pub brier_score: f64,
    pub reason: [c_char; 64],
    pub decision_latency_ns: u64,
}

#[repr(C)]
pub struct KvCacheStats {
    pub total_entries: libc::size_t,
    pub total_tokens: libc::size_t,
    pub max_capacity_bytes: libc::size_t,
    pub current_usage_bytes: libc::size_t,
    pub hit_rate: f64,
}

#[repr(C)]
pub struct LocalMemoryStats {
    pub facts_count: libc::size_t,
    pub memory_bytes: libc::size_t,
    pub last_sync_ns: u64,
}

#[cfg(unix)]
type RawThreadHandle = libc::pthread_t;

#[cfg(windows)]
type RawThreadHandle = *mut c_void;

struct EnginePool {
    threads: Vec<RawThreadHandle>,
    running: Arc<AtomicBool>,
}

unsafe impl Send for EnginePool {}
unsafe impl Sync for EnginePool {}

static mut ENGINE_POOL: Option<Arc<Mutex<EnginePool>>> = None;

// --- KV Cache Implementation ---
#[derive(Clone)]
struct KvEntry {
    sequence_id: u64,
    key: Vec<f32>,
    val: Vec<f32>,
    dim: usize,
    created_at: Instant,
}

struct KvSessionCache {
    entries: HashMap<u64, KvEntry>,
}

struct GlobalKvManager {
    sessions: RwLock<HashMap<String, KvSessionCache>>,
    max_capacity_bytes: usize,
    hits: AtomicUsize,
    misses: AtomicUsize,
}

impl GlobalKvManager {
    fn new(max_capacity_mb: usize) -> Self {
        Self {
            sessions: RwLock::new(HashMap::new()),
            max_capacity_bytes: max_capacity_mb * 1024 * 1024,
            hits: AtomicUsize::new(0),
            misses: AtomicUsize::new(0),
        }
    }
}

// --- Local Memory Implementation ---
#[derive(Clone)]
struct MemoryFact {
    key: String,
    content: String,
    is_pii_sanitized: bool,
    timestamp: Instant,
}

struct GlobalMemoryStore {
    facts: RwLock<HashMap<String, MemoryFact>>,
    last_sync: AtomicU64,
}

impl GlobalMemoryStore {
    fn new() -> Self {
        Self {
            facts: RwLock::new(HashMap::new()),
            last_sync: AtomicU64::new(0),
        }
    }
}

lazy_static! {
    static ref RE_EMAIL: Regex = Regex::new(r"(?i)\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b").unwrap();
    static ref RE_PHONE: Regex = Regex::new(r"\b(?:\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b").unwrap();
    static ref RE_SSN: Regex = Regex::new(r"\b\d{3}-\d{2}-\d{4}\b").unwrap();
    static ref RE_CREDIT_CARD: Regex = Regex::new(r"\b(?:\d{4}[-\s]?){3}\d{4}\b").unwrap();
    static ref RE_API_KEY: Regex = Regex::new(r"(?i)\b(?:api[_-]?key|secret|token|bearer|password)[=:\s]+[A-Za-z0-9_\-]{8,}\b").unwrap();
    
    static ref KV_MANAGER: GlobalKvManager = GlobalKvManager::new(512); // Default 512 MB
    static ref LOCAL_MEMORY: GlobalMemoryStore = GlobalMemoryStore::new();
}

#[cfg(unix)]
extern "C" {
    fn pthread_create(
        native: *mut libc::pthread_t,
        attr: *const c_void,
        f: extern "C" fn(*mut c_void) -> *mut c_void,
        value: *mut c_void,
    ) -> c_int;
    fn pthread_join(native: libc::pthread_t, value: *mut *mut c_void) -> c_int;
}

#[cfg(windows)]
extern "system" {
    fn CreateThread(
        lpThreadAttributes: *mut c_void,
        dwStackSize: libc::size_t,
        lpStartAddress: extern "system" fn(*mut c_void) -> u32,
        lpParameter: *mut c_void,
        dwCreationFlags: u32,
        lpThreadId: *mut u32,
    ) -> *mut c_void;
    fn WaitForSingleObject(hHandle: *mut c_void, dwMilliseconds: u32) -> u32;
    fn CloseHandle(hObject: *mut c_void) -> c_int;
}

#[cfg(unix)]
extern "C" fn worker_thread_entry(arg: *mut c_void) -> *mut c_void {
    let running = unsafe { &*(arg as *const AtomicBool) };
    while running.load(Ordering::Relaxed) {
        std::thread::park_timeout(std::time::Duration::from_millis(50));
    }
    std::ptr::null_mut()
}

#[cfg(windows)]
extern "system" fn worker_thread_entry_win(arg: *mut c_void) -> u32 {
    let running = unsafe { &*(arg as *const AtomicBool) };
    while running.load(Ordering::Relaxed) {
        std::thread::park_timeout(std::time::Duration::from_millis(50));
    }
    0
}

#[no_mangle]
pub unsafe extern "C" fn meridian_engine_init(worker_threads: libc::size_t) -> c_int {
    let running = Arc::new(AtomicBool::new(true));
    let mut thread_ids = Vec::with_capacity(worker_threads);

    for _ in 0..worker_threads {
        #[cfg(unix)]
        {
            let mut tid: libc::pthread_t = std::mem::zeroed();
            let arg = Arc::as_ptr(&running) as *mut c_void;
            let res = pthread_create(&mut tid, std::ptr::null(), worker_thread_entry, arg);
            if res == 0 {
                thread_ids.push(tid);
            }
        }

        #[cfg(windows)]
        {
            let mut thread_id: u32 = 0;
            let arg = Arc::as_ptr(&running) as *mut c_void;
            let handle = CreateThread(
                std::ptr::null_mut(),
                0,
                worker_thread_entry_win,
                arg,
                0,
                &mut thread_id,
            );
            if !handle.is_null() {
                thread_ids.push(handle);
            }
        }
    }

    ENGINE_POOL = Some(Arc::new(Mutex::new(EnginePool {
        threads: thread_ids,
        running,
    })));

    0
}

#[no_mangle]
pub unsafe extern "C" fn meridian_engine_shutdown() {
    if let Some(pool_arc) = ENGINE_POOL.take() {
        if let Ok(pool) = pool_arc.lock() {
            pool.running.store(false, Ordering::SeqCst);
            for handle in &pool.threads {
                #[cfg(unix)]
                {
                    pthread_join(*handle, std::ptr::null_mut());
                }
                #[cfg(windows)]
                {
                    WaitForSingleObject(*handle, 2000);
                    CloseHandle(*handle);
                }
            }
        }
    }
}

pub fn sanitize_pii_string(input: &str, mode: PiiMaskMode) -> (String, usize) {
    let mut detected = 0usize;
    let mut text = input.to_string();

    let email_replacement = if mode == PiiMaskMode::PiiMaskAll { "[PII_EMAIL]" } else { "[EMAIL_REDACTED]" };
    let phone_replacement = if mode == PiiMaskMode::PiiMaskAll { "[PII_PHONE]" } else { "[PHONE_REDACTED]" };
    let ssn_replacement = if mode == PiiMaskMode::PiiMaskAll { "[PII_SSN]" } else { "[SSN_REDACTED]" };
    let cc_replacement = if mode == PiiMaskMode::PiiMaskAll { "[PII_CARD]" } else { "[CARD_REDACTED]" };
    let api_replacement = if mode == PiiMaskMode::PiiMaskAll { "[PII_SECRET]" } else { "[SECRET_REDACTED]" };

    let count_e = RE_EMAIL.find_iter(&text).count();
    if count_e > 0 {
        detected += count_e;
        text = RE_EMAIL.replace_all(&text, email_replacement).into_owned();
    }

    let count_p = RE_PHONE.find_iter(&text).count();
    if count_p > 0 {
        detected += count_p;
        text = RE_PHONE.replace_all(&text, phone_replacement).into_owned();
    }

    let count_s = RE_SSN.find_iter(&text).count();
    if count_s > 0 {
        detected += count_s;
        text = RE_SSN.replace_all(&text, ssn_replacement).into_owned();
    }

    let count_c = RE_CREDIT_CARD.find_iter(&text).count();
    if count_c > 0 {
        detected += count_c;
        text = RE_CREDIT_CARD.replace_all(&text, cc_replacement).into_owned();
    }

    let count_a = RE_API_KEY.find_iter(&text).count();
    if count_a > 0 {
        detected += count_a;
        text = RE_API_KEY.replace_all(&text, api_replacement).into_owned();
    }

    (text, detected)
}

#[no_mangle]
pub unsafe extern "C" fn meridian_sanitize_pii(input_text: *const c_char, mode: PiiMaskMode) -> *mut PiiGateResult {
    let start = Instant::now();
    if input_text.is_null() {
        return std::ptr::null_mut();
    }

    let c_str = CStr::from_ptr(input_text);
    let str_slice = match c_str.to_str() {
        Ok(s) => s,
        Err(_) => return std::ptr::null_mut(),
    };

    let (sanitized, count) = sanitize_pii_string(str_slice, mode);
    let elapsed = start.elapsed().as_nanos() as u64;

    let c_sanitized = match CString::new(sanitized) {
        Ok(c) => c.into_raw(),
        Err(_) => return std::ptr::null_mut(),
    };

    let res = Box::new(PiiGateResult {
        sanitized_text: c_sanitized,
        pii_entities_detected: count,
        had_pii: if count > 0 { 1 } else { 0 },
        processing_time_ns: elapsed,
    });

    Box::into_raw(res)
}

#[no_mangle]
pub unsafe extern "C" fn meridian_free_pii_result(result: *mut PiiGateResult) {
    if !result.is_null() {
        let boxed = Box::from_raw(result);
        if !boxed.sanitized_text.is_null() {
            let _ = CString::from_raw(boxed.sanitized_text);
        }
    }
}

pub fn evaluate_laya_routing_internal(
    sanitized: &str,
    tau_fast: f64,
    tau_deep: f64,
    tool_indicators: i32,
    ambiguity_level: f64,
) -> (String, f64, f64, f64, String) {
    let lower = sanitized.to_lowercase();
    let word_count = sanitized.split_whitespace().count();

    let mut direct_prior = 0.90;
    if word_count > 30 {
        direct_prior -= 0.15;
    }
    if tool_indicators > 0 {
        direct_prior -= 0.35 * (tool_indicators as f64).min(2.0);
    }
    if ambiguity_level > 0.4 {
        direct_prior -= ambiguity_level * 0.4;
    }

    let agent_keywords = [
        "check", "run", "browse", "schedule", "execute", "fetch",
        "calculate", "search", "lookup", "database", "api", "order", "book"
    ];

    let mut found_keywords = 0;
    for kw in &agent_keywords {
        if lower.contains(kw) {
            found_keywords += 1;
        }
    }

    if found_keywords > 0 {
        direct_prior -= 0.15 * (found_keywords as f64);
    }

    let p_direct = direct_prior.clamp(0.01, 0.99);
    let p_deep = (1.0 - p_direct).clamp(0.01, 0.99);

    let (route, reason) = if p_direct >= tau_fast {
        ("direct_e2b".to_string(), "High confidence conversational turn (Gemma 4 E2B)".to_string())
    } else if p_deep >= tau_deep || tool_indicators > 0 || ambiguity_level >= 0.5 {
        ("deep_e4b".to_string(), "Tool usage / reasoning required (Gemma 4 E4B)".to_string())
    } else {
        ("direct_e2b".to_string(), "Default conversational fallback (Gemma 4 E2B)".to_string())
    };

    let y = if route == "direct_e2b" { 1.0 } else { 0.0 };
    let brier_score = (p_direct - y).powi(2);

    (route, p_direct, p_deep, brier_score, reason)
}

#[no_mangle]
pub unsafe extern "C" fn meridian_eval_laya_routing(
    sanitized_transcript: *const c_char,
    tau_fast: f64,
    tau_deep: f64,
    tool_indicators_count: c_int,
    ambiguity_level: f64,
) -> *mut LayaDecisionResult {
    let start = Instant::now();
    let transcript = if sanitized_transcript.is_null() {
        ""
    } else {
        match CStr::from_ptr(sanitized_transcript).to_str() {
            Ok(s) => s,
            Err(_) => "",
        }
    };

    let (route, p_direct, p_deep, brier_score, reason) = evaluate_laya_routing_internal(
        transcript,
        tau_fast,
        tau_deep,
        tool_indicators_count,
        ambiguity_level,
    );

    let elapsed = start.elapsed().as_nanos() as u64;

    let mut route_buf = [0 as c_char; 32];
    let mut reason_buf = [0 as c_char; 64];

    let c_route = CString::new(route).unwrap_or_default();
    let c_reason = CString::new(reason).unwrap_or_default();

    let route_bytes = c_route.as_bytes_with_nul();
    let reason_bytes = c_reason.as_bytes_with_nul();

    for (i, b) in route_bytes.iter().take(31).enumerate() {
        route_buf[i] = *b as c_char;
    }
    for (i, b) in reason_bytes.iter().take(63).enumerate() {
        reason_buf[i] = *b as c_char;
    }

    let res = Box::new(LayaDecisionResult {
        route: route_buf,
        p_direct,
        p_deep,
        brier_score,
        reason: reason_buf,
        decision_latency_ns: elapsed,
    });

    Box::into_raw(res)
}

#[no_mangle]
pub unsafe extern "C" fn meridian_free_laya_result(result: *mut LayaDecisionResult) {
    if !result.is_null() {
        let _ = Box::from_raw(result);
    }
}

// --- KV Cache C ABI Exports ---
#[no_mangle]
pub unsafe extern "C" fn meridian_kv_cache_init(_max_capacity_mb: libc::size_t) -> c_int {
    // Clear existing KV cache
    if let Ok(mut sessions) = KV_MANAGER.sessions.write() {
        sessions.clear();
    }
    KV_MANAGER.hits.store(0, Ordering::SeqCst);
    KV_MANAGER.misses.store(0, Ordering::SeqCst);
    0
}

#[no_mangle]
pub unsafe extern "C" fn meridian_kv_cache_put(
    session_id: *const c_char,
    sequence_id: u64,
    key_vector: *const c_float,
    val_vector: *const c_float,
    dim: libc::size_t,
) -> c_int {
    if session_id.is_null() || key_vector.is_null() || val_vector.is_null() || dim == 0 {
        return -1;
    }
    let s_id = match CStr::from_ptr(session_id).to_str() {
        Ok(s) => s.to_string(),
        Err(_) => return -1,
    };

    let k_slice = std::slice::from_raw_parts(key_vector, dim);
    let v_slice = std::slice::from_raw_parts(val_vector, dim);

    let entry = KvEntry {
        sequence_id,
        key: k_slice.to_vec(),
        val: v_slice.to_vec(),
        dim,
        created_at: Instant::now(),
    };

    if let Ok(mut sessions) = KV_MANAGER.sessions.write() {
        let session_cache = sessions.entry(s_id).or_insert_with(|| KvSessionCache {
            entries: HashMap::new(),
        });
        session_cache.entries.insert(sequence_id, entry);
    }
    0
}

#[no_mangle]
pub unsafe extern "C" fn meridian_kv_cache_get(
    session_id: *const c_char,
    sequence_id: u64,
    out_key: *mut c_float,
    out_val: *mut c_float,
    dim: libc::size_t,
) -> c_int {
    if session_id.is_null() || out_key.is_null() || out_val.is_null() || dim == 0 {
        return -1;
    }
    let s_id = match CStr::from_ptr(session_id).to_str() {
        Ok(s) => s,
        Err(_) => return -1,
    };

    if let Ok(sessions) = KV_MANAGER.sessions.read() {
        if let Some(session_cache) = sessions.get(s_id) {
            if let Some(entry) = session_cache.entries.get(&sequence_id) {
                if entry.dim == dim {
                    let k_dst = std::slice::from_raw_parts_mut(out_key, dim);
                    let v_dst = std::slice::from_raw_parts_mut(out_val, dim);
                    k_dst.copy_from_slice(&entry.key);
                    v_dst.copy_from_slice(&entry.val);
                    KV_MANAGER.hits.fetch_add(1, Ordering::Relaxed);
                    return 0;
                }
            }
        }
    }
    KV_MANAGER.misses.fetch_add(1, Ordering::Relaxed);
    -1
}

#[no_mangle]
pub unsafe extern "C" fn meridian_kv_cache_evict_prefix(
    session_id: *const c_char,
    count_to_keep: libc::size_t,
) -> c_int {
    if session_id.is_null() {
        return -1;
    }
    let s_id = match CStr::from_ptr(session_id).to_str() {
        Ok(s) => s,
        Err(_) => return -1,
    };

    if let Ok(mut sessions) = KV_MANAGER.sessions.write() {
        if let Some(session_cache) = sessions.get_mut(s_id) {
            if session_cache.entries.len() > count_to_keep {
                let mut seq_ids: Vec<u64> = session_cache.entries.keys().cloned().collect();
                seq_ids.sort();
                let evict_count = seq_ids.len() - count_to_keep;
                for id in seq_ids.iter().take(evict_count) {
                    session_cache.entries.remove(id);
                }
            }
        }
    }
    0
}

#[no_mangle]
pub unsafe extern "C" fn meridian_kv_cache_get_stats(out_stats: *mut KvCacheStats) {
    if out_stats.is_null() {
        return;
    }
    let mut total_entries = 0;
    let mut total_bytes = 0;

    if let Ok(sessions) = KV_MANAGER.sessions.read() {
        for s in sessions.values() {
            total_entries += s.entries.len();
            for e in s.entries.values() {
                total_bytes += e.dim * std::mem::size_of::<f32>() * 2;
            }
        }
    }

    let hits = KV_MANAGER.hits.load(Ordering::Relaxed);
    let misses = KV_MANAGER.misses.load(Ordering::Relaxed);
    let total_reqs = hits + misses;
    let hit_rate = if total_reqs > 0 {
        hits as f64 / total_reqs as f64
    } else {
        1.0
    };

    unsafe {
        (*out_stats).total_entries = total_entries;
        (*out_stats).total_tokens = total_entries;
        (*out_stats).max_capacity_bytes = KV_MANAGER.max_capacity_bytes;
        (*out_stats).current_usage_bytes = total_bytes;
        (*out_stats).hit_rate = hit_rate;
    }
}

#[no_mangle]
pub unsafe extern "C" fn meridian_kv_cache_clear() {
    if let Ok(mut sessions) = KV_MANAGER.sessions.write() {
        sessions.clear();
    }
    KV_MANAGER.hits.store(0, Ordering::SeqCst);
    KV_MANAGER.misses.store(0, Ordering::SeqCst);
}

// --- Local Memory C ABI Exports ---
#[no_mangle]
pub unsafe extern "C" fn meridian_memory_upsert(
    key: *const c_char,
    content: *const c_char,
    is_pii_sanitized: u8,
) -> c_int {
    if key.is_null() || content.is_null() {
        return -1;
    }
    let k = match CStr::from_ptr(key).to_str() {
        Ok(s) => s.to_string(),
        Err(_) => return -1,
    };
    let c = match CStr::from_ptr(content).to_str() {
        Ok(s) => s.to_string(),
        Err(_) => return -1,
    };

    let fact = MemoryFact {
        key: k.clone(),
        content: c,
        is_pii_sanitized: is_pii_sanitized != 0,
        timestamp: Instant::now(),
    };

    if let Ok(mut facts) = LOCAL_MEMORY.facts.write() {
        facts.insert(k, fact);
        LOCAL_MEMORY.last_sync.store(Instant::now().elapsed().as_nanos() as u64, Ordering::SeqCst);
    }
    0
}

#[no_mangle]
pub unsafe extern "C" fn meridian_memory_retrieve(key: *const c_char) -> *const c_char {
    if key.is_null() {
        return std::ptr::null();
    }
    let k = match CStr::from_ptr(key).to_str() {
        Ok(s) => s,
        Err(_) => return std::ptr::null(),
    };

    if let Ok(facts) = LOCAL_MEMORY.facts.read() {
        if let Some(fact) = facts.get(k) {
            if let Ok(c_str) = CString::new(fact.content.clone()) {
                return c_str.into_raw();
            }
        }
    }
    std::ptr::null()
}

#[no_mangle]
pub unsafe extern "C" fn meridian_memory_free_string(ptr: *mut c_char) {
    if !ptr.is_null() {
        let _ = unsafe { CString::from_raw(ptr) };
    }
}

#[no_mangle]
pub unsafe extern "C" fn meridian_memory_get_stats(out_stats: *mut LocalMemoryStats) {
    if out_stats.is_null() {
        return;
    }
    let mut count = 0;
    let mut total_bytes = 0;

    if let Ok(facts) = LOCAL_MEMORY.facts.read() {
        count = facts.len();
        for (k, f) in facts.iter() {
            total_bytes += k.len() + f.content.len();
        }
    }

    unsafe {
        (*out_stats).facts_count = count;
        (*out_stats).memory_bytes = total_bytes;
        (*out_stats).last_sync_ns = LOCAL_MEMORY.last_sync.load(Ordering::Relaxed);
    }
}
