// Entry point: `node server/main.mjs daemon` → engine; no args → MCP proxy.
import { startDaemon } from "./daemon.mjs";
import { startMcp } from "./mcp.mjs";

const mode = process.argv[2] === "daemon" ? "daemon" : "mcp";

try {
  if (mode === "daemon") await startDaemon();
  else await startMcp();
} catch (err) {
  console.error(`live-metrics ${mode} failed:`, err?.message || err);
  process.exit(1);
}
