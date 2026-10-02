// Central configuration & state-file paths. Single place for environment knobs.
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const PLUGIN_ROOT = path.resolve(here, "..");

// Version single source of truth (PRD 4.6.7): everything else reads this file
// or is asserted in sync by test/contracts.test.mjs.
export const VERSION = JSON.parse(
  fs.readFileSync(path.join(PLUGIN_ROOT, ".zcode-plugin", "plugin.json"), "utf8"),
).version;

const home = os.homedir();
const envNum = (k, d) => (Number.isFinite(Number(process.env[k])) ? Number(process.env[k]) : d);

export const config = {
  version: VERSION,
  bootId: Math.random().toString(36).slice(2, 10),
  pluginRoot: PLUGIN_ROOT,
  dataDir: process.env.ZCODE_METRICS_PLUGIN_DATA || path.join(os.tmpdir(), "zcode-live-metrics"),
  rolloutDir: process.env.ZCODE_METRICS_ROLLOUT_DIR || path.join(home, ".zcode", "cli", "rollout"),
  hostLogDir: process.env.ZCODE_METRICS_HOST_LOG_DIR || path.join(home, ".zcode", "cli", "log"),
  dbPath: process.env.ZCODE_METRICS_DB || path.join(home, ".zcode", "cli", "db", "db.sqlite"),
  portBase: envNum("ZCODE_METRICS_PORT", 7735),
  portProbe: 20,
  pollMs: envNum("ZCODE_METRICS_POLL_MS", 120),
  idleExitMs: envNum("ZCODE_METRICS_IDLE_EXIT_MS", 15 * 60_000),
  activeSessionMs: 30 * 60_000, // a session is "active" if it moved within this window
  hardLifeMs: 24 * 60 * 3600_000,
  maxSamples: 20_000,
  ringPoints: 600,
  swiftPath: "/usr/bin/swift",
};

// State-file names inside dataDir (the cross-process contracts, see ADR-0001).
export const FILES = {
  daemonPid: "daemon.pid",
  dashboard: "dashboard.json",
  activeSession: "active-session.json",
  pinnedSession: "pinned-session.json",
  floatingWindowPid: "floating-window.pid",
  config: "config.json",
};

export function statePath(name) {
  return path.join(config.dataDir, name);
}

export function ensureDataDir() {
  fs.mkdirSync(config.dataDir, { recursive: true });
}

// userConfig arrives via .mcp.json templating only in the MCP process; the MCP
// proxy persists it to config.json so hook-spawned daemons see it too (fixes
// the old config blind spot). Priority: config.json > env > default.
export function floatingWindowMode() {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(statePath(FILES.config), "utf8")).floating_window;
  } catch {}
  if (raw === undefined) raw = process.env.ZCODE_METRICS_FLOATING;
  if (raw === undefined || raw === "" || raw === true || raw === "true") return "auto";
  if (raw === "browser") return "browser";
  return "off"; // false / "false" / anything else
}

export function writeStateJson(name, obj) {
  ensureDataDir();
  const p = statePath(name);
  const tmp = `${p}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj));
  fs.renameSync(tmp, p);
}

export function readStateJson(name) {
  try {
    return JSON.parse(fs.readFileSync(statePath(name), "utf8"));
  } catch {
    return null;
  }
}
