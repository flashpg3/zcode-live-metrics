// Daemon engine (ADR-0001): singleton per machine, owns log tail-reading,
// aggregation, focus, HTTP/SSE, floating-window orchestration and history.
// Lifecycle rule (PRD §4.6): never exits while anything watches or any session
// is active; hard-capped at 24h; a killed daemon is revived by hooks/MCP.
import fs from "node:fs";
import { execFile, execFileSync } from "node:child_process";
import {
  config,
  FILES,
  ensureDataDir,
  statePath,
  writeStateJson,
  readStateJson,
} from "./config.mjs";
import { RolloutWatcher } from "./adapt/rollout.mjs";
import { HostLogWatcher } from "./adapt/hostlog.mjs";
import { fetchTitles } from "./adapt/titles.mjs";
import { SessionStore, sessionView, sessionSummary } from "./core/sessions.mjs";
import { Focus } from "./core/focus.mjs";
import { intensity } from "./core/metrics.mjs";
import { HttpService } from "./http.mjs";
import { WindowManager } from "./window.mjs";
import { HistoryIndex } from "./history.mjs";

// Synchronous sleep without spinning: startup must block until the previous
// daemon releases the singleton lock (Atomics.wait parks the thread).
function sleepSync(ms) {
  const sab = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(sab), 0, 0, ms);
}

// --- singleton: take over (SIGTERM the old), never co-exist (PRD A5) ------
function acquireSingleton() {
  ensureDataDir();
  const lockPath = statePath("daemon.lock");
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      const fd = fs.openSync(lockPath, "wx");
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, bootId: config.bootId }));
      fs.closeSync(fd);
      return true;
    } catch {
      let holder = null;
      try {
        holder = JSON.parse(fs.readFileSync(lockPath, "utf8"));
      } catch {}
      if (holder?.pid && holder.pid !== process.pid && holderIsOurDaemon(holder.pid)) {
        try {
          process.kill(holder.pid, "SIGTERM");
        } catch {}
      }
      // The holder unlinks on SIGTERM; force-release if it never shows up.
      sleepSync(100);
      try {
        fs.unlinkSync(lockPath);
      } catch {}
    }
  }
  return false;
}

function holderIsOurDaemon(pid) {
  try {
    const cmd = execFileSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8" });
    return /live-metrics|server[\\/]main\.mjs/.test(cmd);
  } catch {
    return false;
  }
}

function releaseSingleton() {
  try {
    fs.unlinkSync(statePath("daemon.lock"));
  } catch {}
}

function readHookSignal() {
  const sig = readStateJson(FILES.activeSession);
  if (!sig?.sessionId) return null;
  const ts = typeof sig.ts === "number" ? sig.ts : Date.parse(sig.ts);
  return Number.isFinite(ts) ? { sessionId: sig.sessionId, ts } : null;
}

function readPinned() {
  const p = readStateJson(FILES.pinnedSession);
  return p?.sessionId ? p.sessionId : null;
}

function openBrowser(url) {
  const cmd = process.platform === "darwin" ? "open" : "xdg-open";
  try {
    execFile(cmd, [url], { timeout: 4000 }, () => {});
  } catch {}
}

export async function startDaemon() {
  if (!acquireSingleton()) {
    console.error("live-metrics daemon: could not acquire singleton lock");
    process.exit(0);
  }
  ensureDataDir();
  fs.writeFileSync(statePath(FILES.daemonPid), String(process.pid));

  const store = new SessionStore(config.maxSamples);
  const focus = new Focus();
  const rollouts = new RolloutWatcher(config.rolloutDir);
  const hostLog = new HostLogWatcher(config.hostLogDir);
  const windows = new WindowManager();
  const history = new HistoryIndex(config.rolloutDir);
  let openInBrowserRequested = false;

  focus.pinned = readPinned();

  const http = new HttpService({
    snapshot: () => buildSnapshot(),
    history: () => history.report(),
    pin: (id) => {
      focus.pin(id);
      writeStateJson(FILES.pinnedSession, { sessionId: id, ts: Date.now() });
    },
    unpin: () => {
      focus.unpin();
      writeStateJson(FILES.pinnedSession, { sessionId: null, ts: Date.now() });
    },
    open: () => {
      openInBrowserRequested = true;
    },
  });

  function buildSnapshot() {
    const now = Date.now();
    const acts = store.activityMap();
    const hook = readHookSignal();
    if (hook) acts.set(hook.sessionId, Math.max(acts.get(hook.sessionId) ?? 0, hook.ts));
    focus.update(acts);
    const focused = focus.current ? store.get(focus.current) : null;
    return {
      v: config.version,
      bootId: config.bootId,
      now,
      pinned: focus.pinned,
      focus: focused ? sessionView(focused, now) : null,
      sessions: [...store.sessions.values()]
        .sort((a, b) => b.lastActivity - a.lastActivity)
        .slice(0, 24)
        .map((s) => sessionSummary(s, now)),
      ring: { intervalMs: 1000, points: focused?.ring ?? [] },
    };
  }

  let pushTimer = null;
  function scheduleBroadcast() {
    if (pushTimer) return;
    pushTimer = setTimeout(() => {
      pushTimer = null;
      try {
        http.broadcast(buildSnapshot());
      } catch {}
    }, 30); // coalesce bursts into one push
  }

  function onEvent(ev) {
    if (ev.kind === "req_start") store.setGenerating(ev.sessionId, ev.traceId, ev.ts);
    else if (ev.kind === "req_end") store.endGenerating(ev.traceId);
    else store.activity(ev.sessionId, ev.ts);
    scheduleBroadcast();
  }

  // Prime with whatever is already on disk, then keep the fast loop going.
  rollouts.poll((sessionId, sample) => {
    store.ingest(sessionId, sample);
    scheduleBroadcast();
  });
  hostLog.poll(onEvent);

  // Fast loop (PRD R1: ≤200ms to screen): poll 120ms, push on change.
  setInterval(() => {
    try {
      rollouts.poll((sessionId, sample) => {
        store.ingest(sessionId, sample);
        scheduleBroadcast();
      });
      hostLog.poll(onEvent);
    } catch {}
  }, config.pollMs);

  // 1s tick: honest 会话强度 ring for the focused session + housekeeping.
  setInterval(() => {
    const now = Date.now();
    const hook = readHookSignal();
    const focusedId = focus.current ?? hook?.sessionId;
    if (focusedId) {
      const s = store.get(focusedId);
      if (!s.ring) s.ring = [];
      s.ring.push({ t: now, v: +intensity(s.samples, now, 10_000).toFixed(1) });
      if (s.ring.length > config.ringPoints) s.ring.splice(0, s.ring.length - config.ringPoints);
    }
    store.prune(now, config.activeSessionMs * 4);
    scheduleBroadcast();
  }, 1000);

  // Slow loop: window liveness (≤30s reopen budget), open-request, titles.
  setInterval(() => {
    if (openInBrowserRequested) {
      openInBrowserRequested = false;
      openBrowser(http.url);
    }
    windows.ensure(http.url);
  }, 10_000);
  setInterval(async () => {
    const ids = [...store.sessions.values()]
      .filter((s) => !s.title)
      .sort((a, b) => b.lastActivity - a.lastActivity)
      .slice(0, 16)
      .map((s) => s.id);
    if (!ids.length) return;
    const titles = await fetchTitles(config.dbPath, ids);
    let touched = false;
    for (const [id, title] of Object.entries(titles)) {
      const s = store.sessions.get(id);
      if (s && !s.title) {
        s.title = title;
        touched = true;
      }
    }
    if (touched) scheduleBroadcast();
  }, 30_000);

  // History scan: batched so it never crowds the real-time path (PRD §4.5).
  setInterval(() => {
    try {
      history.scan(2);
    } catch {}
  }, 2000);

  // Lifecycle: refresh dashboard.json (the window's claim file), then decide
  // whether this daemon may retire. 24h hard cap regardless.
  const startedAt = Date.now();
  const writeDashboardClaim = () =>
    writeStateJson(FILES.dashboard, {
      url: http.url,
      port: http.port,
      pid: process.pid,
      bootId: config.bootId,
      version: config.version,
      ts: Date.now(),
    });

  setInterval(() => {
    writeDashboardClaim();
    const now = Date.now();
    if (now - startedAt > config.hardLifeMs) process.exit(0);
    const hasSse = http.sseClients.size > 0;
    const hasWindow = windows.wanted && windows.isAlive();
    const hasActive = [...store.sessions.values()].some(
      (s) => now - Math.max(s.lastActivity, s.gen?.since ?? 0) < config.activeSessionMs,
    );
    const hook = readHookSignal();
    const hookFresh = hook && now - hook.ts < config.activeSessionMs;
    if (!hasSse && !hasWindow && !hasActive && !hookFresh && now - startedAt > config.idleExitMs) {
      releaseSingleton();
      process.exit(0);
    }
  }, 30_000);

  await http.listen();
  writeDashboardClaim();
  windows.ensure(http.url);
  console.error(`live-metrics daemon ${config.version}: ${http.url}`);

  process.on("SIGTERM", () => {
    releaseSingleton();
    process.exit(0);
  });
  process.on("exit", () => releaseSingleton());

  return http;
}
