// Rollout log adapter — the ONLY place that knows the rollout format
// (file-name pattern, type tag, usage field paths). PRD §6: host-format
// assumptions live in the adapter layer, single point of change.
import fs from "node:fs";
import path from "node:path";
import { pollLines, createTail } from "./tail.mjs";

const FILE_RE = /^model-io-(sess_[A-Za-z0-9._-]+)\.jsonl$/;

const num = (v) => (Number.isFinite(v) ? v : undefined);

// One completed model call → sample. Returns null for anything unusable
// (unknown type, missing token counts, unparseable line).
export function parseSample(line) {
  if (!line.includes('"model_io"')) return null;
  let d;
  try {
    d = JSON.parse(line);
  } catch {
    return null;
  }
  if (d?.type !== "model_io") return null;
  const resp = d.response || {};
  const pm = resp.providerMetadata || {};
  // usage extraction: direct field first, then the provider-specific nests
  const u = [resp.usage, pm.anthropic?.usage, pm.usage].find(
    (x) => x && Number.isFinite(x.output_tokens) && Number.isFinite(x.input_tokens),
  );
  if (!u) return null;
  const t = Date.parse(d.completedAt ?? "") || Date.now();
  const started = Date.parse(d.startedAt ?? "");
  const dur = num(d.durationMs) ?? (Number.isFinite(started) ? Math.max(0, t - started) : 0);
  return {
    t,
    out: u.output_tokens,
    in: u.input_tokens,
    cacheR: num(u.cache_read_input_tokens) ?? 0,
    cacheC:
      num(u.cache_creation_input_tokens) ?? num(pm.anthropic?.cacheCreationInputTokens) ?? 0,
    dur,
    model: d.model?.modelId || resp.modelId || d.request?.body?.model || "?",
    provider: d.model?.providerId || "",
    attempt: num(d.attempt) ?? 1,
    querySource: typeof d.querySource === "string" ? d.querySource : "",
    requestId: typeof d.requestId === "string" ? d.requestId : "",
    sessionId: typeof d.sessionId === "string" ? d.sessionId : "",
  };
}

export function listRolloutFiles(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const out = [];
  for (const name of entries) {
    const m = FILE_RE.exec(name);
    if (!m) continue;
    try {
      const st = fs.statSync(path.join(dir, name));
      out.push({ file: path.join(dir, name), sessionId: m[1], mtime: st.mtimeMs, size: st.size });
    } catch {}
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

// Watches the rollout directory: incremental tail-reads of every session file.
// Files that disappear are forgotten; the tracked set is capped at `limit`.
export class RolloutWatcher {
  constructor(dir, limit = 64) {
    this.dir = dir;
    this.limit = limit;
    this.tails = new Map(); // sessionId → tail
    this.skippedLines = 0;
  }

  // Calls onSample(sessionId, sample) for each new completed call.
  // Returns true if anything new was read.
  poll(onSample) {
    const files = listRolloutFiles(this.dir).slice(0, this.limit);
    let changed = false;
    const seen = new Set();
    for (const f of files) {
      seen.add(f.sessionId);
      let tail = this.tails.get(f.sessionId);
      if (!tail) {
        // attach at end of file: history lives in the history scanner, the
        // live watcher only wants calls that complete from now on
        tail = createTail(f.file);
        tail.offset = f.size;
        this.tails.set(f.sessionId, tail);
        continue;
      }
      const lines = pollLines(f.file, tail);
      if (lines.length) changed = true;
      for (const line of lines) {
        const s = parseSample(line);
        if (s) onSample(f.sessionId, s);
      }
    }
    for (const id of this.tails.keys()) if (!seen.has(id)) this.tails.delete(id);
    return changed;
  }
}
