// Host runtime log adapter (`~/.zcode/cli/log/zcode-YYYY-MM-DD.jsonl`).
// Provides: structured per-session activity signals (focus) and the
// "generating" state (model.request.started/completed pairs by traceId).
// Every event line carries sessionId/traceId as real JSON fields — no regex.
import fs from "node:fs";
import path from "node:path";
import { pollLines, createTail } from "./tail.mjs";

const FILE_RE = /^zcode-(\d{4}-\d{2}-\d{2})\.jsonl$/;
export const SEEN_RE = /^sess_[A-Za-z0-9._-]+$/;

export function listHostLogs(dir, k = 2) {
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const out = [];
  for (const name of entries) {
    if (!FILE_RE.test(name)) continue;
    try {
      const st = fs.statSync(path.join(dir, name));
      out.push({ file: path.join(dir, name), mtime: st.mtimeMs, size: st.size });
    } catch {}
  }
  return out.sort((a, b) => b.mtime - a.mtime).slice(0, k);
}

// → { kind: "req_start" | "req_end" | "activity", sessionId, ts, traceId } | null
export function extractEvent(line) {
  if (!line.includes('"sessionId"')) return null;
  let d;
  try {
    d = JSON.parse(line);
  } catch {
    return null;
  }
  const sessionId = d.sessionId;
  if (typeof sessionId !== "string" || !SEEN_RE.test(sessionId)) return null;
  const ts = Date.parse(d.timestamp ?? "") || Date.now();
  switch (d.event) {
    case "model.request.started":
      return { kind: "req_start", sessionId, ts, traceId: d.traceId };
    case "model.request.completed":
      return { kind: "req_end", sessionId, ts, traceId: d.traceId };
    default:
      return { kind: "activity", sessionId, ts, traceId: null };
  }
}

// Watches the latest host-log files (rolling over midnight handled by
// switching to the newest file when it appears).
export class HostLogWatcher {
  constructor(dir) {
    this.dir = dir;
    this.tails = new Map(); // file → tail
  }

  poll(handlers) {
    const files = listHostLogs(this.dir);
    let changed = false;
    for (const f of files) {
      let tail = this.tails.get(f.file);
      if (!tail) {
        // fresh attach: skip history except a small tail so an in-flight
        // request's "generating" state is recovered after daemon restart
        tail = createTail(f.file);
        tail.offset = Math.max(0, f.size - 262_144);
        this.tails.set(f.file, tail);
      }
      const lines = pollLines(f.file, tail);
      if (lines.length) changed = true;
      for (const line of lines) {
        const ev = extractEvent(line);
        if (ev) handlers(ev);
      }
    }
    const keep = new Set(files.map((f) => f.file));
    for (const file of this.tails.keys()) if (!keep.has(file)) this.tails.delete(file);
    return changed;
  }
}
