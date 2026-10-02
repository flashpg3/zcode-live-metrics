// Metric definitions — the 口径 table from PRD §4.2, as pure functions.
// All functions take sample objects produced by adapt/rollout.parseSample.

// 单次实测速度: output tokens ÷ that call's generation seconds
export function tpsLast(sample) {
  return sample.dur > 0 ? sample.out / (sample.dur / 1000) : null;
}

// 生成吞吐: Σoutput ÷ Σduration (pure generation time — answers "how fast is the model")
export function genThroughput(samples) {
  let out = 0;
  let ms = 0;
  for (const s of samples) {
    out += s.out;
    ms += s.dur;
  }
  return ms > 0 ? out / (ms / 1000) : null;
}

// 会话强度: Σoutput within window ÷ wall-clock window seconds (includes idle —
// answers "how busy is the session right now")
export function intensity(samples, now, winMs) {
  const from = now - winMs;
  let out = 0;
  for (let i = samples.length - 1; i >= 0; i--) {
    const s = samples[i];
    if (s.t <= from) break;
    out += s.out;
  }
  return out / (winMs / 1000);
}

// 缓存命中率: cacheRead ÷ (input + cacheRead + cacheCreate); null when no input side
export function cacheHit(inp, cacheR, cacheC) {
  const denom = inp + cacheR + cacheC;
  return denom > 0 ? cacheR / denom : null;
}

// 上下文水位: input side of the last call ≈ current context occupancy
export function contextTokens(sample) {
  return sample ? sample.in + sample.cacheR + sample.cacheC : 0;
}

// Best-effort context-window sizes (tokens). Unknown models → null (UI shows
// absolute tokens only). Deliberately tiny: a wrong number is worse than none.
export const MODEL_CONTEXTS = {
  "glm-4.6": 200_000,
  "glm-4.5": 128_000,
  "glm-4.5-air": 128_000,
  "glm-4.5-flash": 128_000,
  "claude-sonnet-4-5": 200_000,
  "claude-opus-4-1": 200_000,
  "claude-haiku-4-5": 200_000,
  "deepseek-v3.1": 128_000,
  "kimi-k2": 256_000,
};

export function contextPct(tokens, model) {
  const size = MODEL_CONTEXTS[(model || "").toLowerCase()];
  return size ? tokens / size : null;
}

// Per-model usage breakdown, sorted by output tokens desc.
export function modelBreakdown(samples, limit = 8) {
  const byModel = new Map();
  for (const s of samples) {
    let m = byModel.get(s.model);
    if (!m) {
      m = { model: s.model, provider: s.provider, calls: 0, out: 0, in: 0, cacheR: 0, cacheC: 0, dur: 0, retries: 0 };
      byModel.set(s.model, m);
    }
    m.calls++;
    m.out += s.out;
    m.in += s.in;
    m.cacheR += s.cacheR;
    m.cacheC += s.cacheC;
    m.dur += s.dur;
    if (s.attempt > 1) m.retries++;
  }
  return [...byModel.values()]
    .sort((a, b) => b.out - a.out)
    .slice(0, limit)
    .map((m) => ({ ...m, tps: m.dur > 0 ? +(m.out / (m.dur / 1000)).toFixed(1) : null }));
}

const sum = (samples, pick) => samples.reduce((a, s) => a + pick(s), 0);

export function tokenTotals(samples) {
  return {
    in: sum(samples, (s) => s.in),
    cacheR: sum(samples, (s) => s.cacheR),
    cacheC: sum(samples, (s) => s.cacheC),
    out: sum(samples, (s) => s.out),
    calls: samples.length,
    retries: samples.filter((s) => s.attempt > 1).length,
  };
}

export function round1(v) {
  return v == null ? null : Math.round(v * 10) / 10;
}
