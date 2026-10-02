// MCP thin proxy: a per-session stdio JSON-RPC process that owns
// no state and dies with the host's connection pool. Forwards tool calls to
// the daemon over loopback HTTP; spawns the daemon when it is not running.
// Also persists userConfig to config.json so hook-spawned daemons see it.
import fs from "node:fs";
import { createInterface } from "node:readline";
import { spawn } from "node:child_process";
import { config, FILES, ensureDataDir, statePath, readStateJson } from "./config.mjs";
import { renderSummaryText } from "./summary.mjs";

const TOOLS = [
  {
    name: "metrics_snapshot",
    description:
      "获取 ZCode 实时运行指标完整快照：token 速度（单次/生成吞吐/会话强度）、缓存命中率、累计 token、模型维度拆分、上下文水位、生成中状态与最近调用明细。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "metrics_summary",
    description: "获取人读的实时指标简报（单页文本，含状态行与最近调用表）。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "open_dashboard",
    description: "在默认浏览器中打开实时指标面板（127.0.0.1 本地面板，SSE 实时刷新）。返回面板地址。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
];

function daemonBaseUrl() {
  const d = readStateJson(FILES.dashboard);
  if (!d?.port || !d?.pid) return null;
  try {
    process.kill(d.pid, 0);
  } catch {
    return null; // claimed pid is dead → daemon is gone
  }
  return `http://127.0.0.1:${d.port}`;
}

async function ensureDaemon() {
  let base = daemonBaseUrl();
  if (base) return base;
  const out = fs.openSync("/dev/null", "w");
  const child = spawn(process.execPath, [new URL("./main.mjs", import.meta.url).pathname, "daemon"], {
    detached: true,
    stdio: ["ignore", out, out],
    env: process.env,
  });
  child.unref();
  fs.closeSync(out);
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 100));
    base = daemonBaseUrl();
    if (base) return base;
  }
  return null;
}

async function callDaemon(method, path, body) {
  const base = await ensureDaemon();
  if (!base) throw new Error("live-metrics daemon 未能启动");
  const res = await fetch(base.replace(/\/$/, "") + path, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(5000),
  });
  return res.json();
}

function textResult(text) {
  return { content: [{ type: "text", text }], isError: false };
}

async function handleToolCall(name) {
  if (name === "metrics_snapshot") {
    const snap = await callDaemon("GET", "/api/snapshot");
    return textResult(JSON.stringify(snap, null, 2));
  }
  if (name === "metrics_summary") {
    const snap = await callDaemon("GET", "/api/snapshot");
    return textResult(renderSummaryText(snap));
  }
  if (name === "open_dashboard") {
    const r = await callDaemon("POST", "/api/open");
    return textResult(`面板已在浏览器打开：${r.url || "http://127.0.0.1:7735/"}`);
  }
  throw new Error(`unknown tool: ${name}`);
}

function write(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

export async function startMcp() {
  ensureDataDir();
  // Persist userConfig (fixes the old blind spot where hook-spawned daemons
  // could not see it): whichever process has it writes it down for the rest.
  const floating = process.env.ZCODE_METRICS_FLOATING;
  if (floating !== undefined) {
    try {
      fs.writeFileSync(statePath(FILES.config), JSON.stringify({ floating_window: floating }));
    } catch {}
  }

  const rl = createInterface({ input: process.stdin, terminal: false });
  for await (const line of rl) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (!msg || msg.id === undefined) continue; // notifications: ignore
    const { id, method, params } = msg;
    try {
      if (method === "initialize") {
        write({
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: "2024-11-05",
            capabilities: { tools: {} },
            serverInfo: { name: "live-metrics", version: config.version },
          },
        });
      } else if (method === "ping") {
        write({ jsonrpc: "2.0", id, result: {} });
      } else if (method === "tools/list") {
        write({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
      } else if (method === "tools/call") {
        const result = await handleToolCall(params?.name);
        write({ jsonrpc: "2.0", id, result });
      } else {
        write({ jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${method}` } });
      }
    } catch (err) {
      write({
        jsonrpc: "2.0",
        id,
        result: { content: [{ type: "text", text: `查询失败: ${err.message}` }], isError: true },
      });
    }
  }
}
