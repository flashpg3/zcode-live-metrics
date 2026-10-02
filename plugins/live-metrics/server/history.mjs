// History view (PRD §4.5): aggregate across sessions and days by re-scanning
// the rollout directory itself — no own storage, no data copies. Scanning is
// incremental (per-file byte offsets) and batched so it never crowds the
// real-time path.
import { listRolloutFiles, parseSample } from "./adapt/rollout.mjs";
import { pollLines, createTail } from "./adapt/tail.mjs";

export class HistoryIndex {
  constructor(rolloutDir, maxFiles = 512) {
    this.dir = rolloutDir;
    this.maxFiles = maxFiles;
    this.files = new Map(); // filePath → { tail, days:Map, sessions:Map }
  }

  // Process at most `batch` files per call, ≤3MB per file; files larger than
  // that stay pending and continue on later ticks. Returns true if read.
  scan(batch = 2) {
    const all = listRolloutFiles(this.dir).slice(0, this.maxFiles);
    const alive = new Set(all.map((f) => f.file));
    for (const file of this.files.keys()) if (!alive.has(file)) this.files.delete(file);
    let read = false;
    let slots = batch;
    for (const f of all) {
      if (slots <= 0) break;
      let entry = this.files.get(f.file);
      if (!entry) {
        entry = { tail: createTail(f.file), days: new Map(), sessions: new Map() };
        this.files.set(f.file, entry);
      }
      if (entry.tail.offset >= f.size) continue; // fully read and unchanged
      slots--;
      for (let chunks = 0; chunks < 3; chunks++) {
        const lines = pollLines(f.file, entry.tail, 1 << 20);
        if (!lines.length) break;
        read = true;
        for (const line of lines) {
          const s = parseSample(line);
          if (s) this.#aggregate(entry, f.sessionId, s);
        }
        if (entry.tail.offset >= f.size) break;
      }
    }
    return read;
  }

  #aggregate(entry, fallbackSession, s) {
    const day = new Date(s.t).toISOString().slice(0, 10);
    let d = entry.days.get(day);
    if (!d) entry.days.set(day, (d = { day, calls: 0, in: 0, cacheR: 0, cacheC: 0, out: 0, models: new Map() }));
    d.calls++;
    d.in += s.in;
    d.cacheR += s.cacheR;
    d.cacheC += s.cacheC;
    d.out += s.out;
    d.models.set(s.model, (d.models.get(s.model) || 0) + s.out);

    let se = entry.sessions.get(fallbackSession);
    if (!se) entry.sessions.set(fallbackSession, (se = { id: fallbackSession, first: s.t, last: s.t, calls: 0, out: 0, models: new Map() }));
    se.calls++;
    se.out += s.out;
    se.first = Math.min(se.first, s.t);
    se.last = Math.max(se.last, s.t);
    se.models.set(s.model, (se.models.get(s.model) || 0) + s.out);
  }

  // → { days: [...], sessions: [...], files: n }
  report() {
    const days = new Map();
    const sessions = new Map();
    for (const entry of this.files.values()) {
      for (const d of entry.days.values()) {
        const t = days.get(d.day);
        if (!t) days.set(d.day, { ...d, models: new Map(d.models) });
        else {
          t.calls += d.calls;
          t.in += d.in;
          t.cacheR += d.cacheR;
          t.cacheC += d.cacheC;
          t.out += d.out;
          for (const [m, v] of d.models) t.models.set(m, (t.models.get(m) || 0) + v);
        }
      }
      for (const se of entry.sessions.values()) {
        const t = sessions.get(se.id);
        if (!t) sessions.set(se.id, { ...se, models: new Map(se.models) });
        else {
          t.calls += se.calls;
          t.out += se.out;
          t.first = Math.min(t.first, se.first);
          t.last = Math.max(t.last, se.last);
          for (const [m, v] of se.models) t.models.set(m, (t.models.get(m) || 0) + v);
        }
      }
    }
    const fmt = (models) => [...models.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)
      .map(([model, out]) => ({ model, out }));
    return {
      days: [...days.values()].sort((a, b) => b.day.localeCompare(a.day)).map((d) => ({ ...d, models: undefined, topModels: fmt(d.models) })),
      sessions: [...sessions.values()].sort((a, b) => b.last - a.last).map((s) => ({ ...s, topModels: fmt(s.models), models: undefined })),
      files: this.files.size,
    };
  }
}
