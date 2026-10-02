// In-memory session store + snapshot views.
import {
  tpsLast,
  genThroughput,
  intensity,
  cacheHit,
  contextTokens,
  contextPct,
  modelBreakdown,
  tokenTotals,
  round1,
} from "./metrics.mjs";

const compactCall = (s) => ({
  t: s.t,
  tps: round1(tpsLast(s)),
  out: s.out,
  in: s.in,
  cacheR: s.cacheR,
  cacheC: s.cacheC,
  dur: s.dur,
  model: s.model,
  attempt: s.attempt,
  src: s.querySource,
});

export class SessionStore {
  constructor(maxSamples = 20_000) {
    this.maxSamples = maxSamples;
    this.sessions = new Map(); // sessionId → state
  }

  get(id) {
    let s = this.sessions.get(id);
    if (!s) {
      s = { id, title: null, samples: [], gen: null, lastActivity: 0 };
      this.sessions.set(id, s);
    }
    return s;
  }

  ingest(sessionId, sample) {
    const s = this.get(sessionId);
    s.samples.push(sample);
    // defensive clear: if the host log's req_end was missed, a sample that
    // completed after the in-flight call started means it is over
    if (s.gen && sample.requestId && sample.t >= s.gen.since - 1000) {
      s.gen = null;
    }
    if (s.samples.length > this.maxSamples + 500) {
      s.samples.splice(0, s.samples.length - this.maxSamples); // batch-shift, not per-insert
    }
    if (sample.t > s.lastActivity) s.lastActivity = sample.t;
    return s;
  }

  setGenerating(sessionId, traceId, since) {
    const s = this.get(sessionId);
    if (!s.gen) s.gen = { traceId, since };
    s.lastActivity = Math.max(s.lastActivity, since);
  }

  // Clears generating state on model.request.completed (the rollout sample
  // usually lands milliseconds later and ingest() is the authoritative clear).
  endGenerating(traceId) {
    for (const s of this.sessions.values()) if (s.gen?.traceId === traceId) s.gen = null;
  }

  activity(sessionId, ts) {
    const s = this.sessions.get(sessionId);
    if (s && ts > s.lastActivity) s.lastActivity = ts;
  }

  activityMap() {
    const map = new Map();
    for (const s of this.sessions.values()) if (s.lastActivity) map.set(s.id, s.lastActivity);
    return map;
  }

  // Drop sessions idle beyond `keepMs` so the map cannot grow forever.
  prune(now, keepMs) {
    for (const [id, s] of this.sessions) {
      const last = Math.max(s.lastActivity, s.gen?.since ?? 0);
      if (now - last > keepMs) this.sessions.delete(id);
    }
  }
}

// Everything the UI shows for the focused session (PRD §4.2 口径).
export function sessionView(s, now) {
  const samples = s.samples;
  const last = samples[samples.length - 1] ?? null;
  const win = samples.filter((x) => x.t > now - 60_000);
  const ctx = last ? contextTokens(last) : 0;
  return {
    id: s.id,
    title: s.title,
    generating: s.gen ? { since: s.gen.since } : null,
    lastActivity: s.lastActivity,
    last: last ? compactCall(last) : null,
    genThroughput: round1(genThroughput(samples)),
    intensity: { s10: round1(intensity(samples, now, 10_000)), s60: round1(intensity(samples, now, 60_000)) },
    cache: {
      all: cacheHitAll(samples),
      s60: cacheHitAll(win),
      last: last ? cacheHit(last.in, last.cacheR, last.cacheC) : null,
    },
    tokens: tokenTotals(samples),
    context: last ? { tokens: ctx, pct: contextPct(ctx, last.model), model: last.model } : null,
    models: modelBreakdown(samples),
    recent: samples.slice(-14).reverse().map(compactCall),
  };
}

function cacheHitAll(samples) {
  let i = 0, r = 0, c = 0;
  for (const s of samples) {
    i += s.in;
    r += s.cacheR;
    c += s.cacheC;
  }
  return cacheHit(i, r, c);
}

// Compact row for the session switcher.
export function sessionSummary(s, now) {
  const out = s.samples.reduce((a, x) => a + x.out, 0);
  return {
    id: s.id,
    title: s.title,
    generating: !!s.gen,
    lastActivity: s.lastActivity,
    out,
    calls: s.samples.length,
  };
}
